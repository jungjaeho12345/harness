package harness.news.model;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.zaxxer.hikari.HikariDataSource;
import harness.news.db.NewsDataSource;
import harness.news.db.RequiredSchema;
import harness.news.testsupport.TempNewsDb;
import java.lang.reflect.Method;
import java.lang.reflect.Modifier;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.jdbc.core.simple.JdbcClient;

/**
 * 사진DB 리포지토리 — 리포 루트 {@code src/models/photoModel.js}의 2연산(insert·searchByCaption)과
 * 1:1인 동작 계약.
 *
 * <p>이 테이블은 <b>append-only</b>다(등록과 검색뿐 — 수정·삭제 API가 아예 없다). 그래서 여기서
 * 잠그는 것은 "무엇을 할 수 있는가"만이 아니라 <b>무엇을 할 수 없는가</b>이기도 하다.
 *
 * <p>계약 스위트가 관측하지 못하는 축이 여기 모여 있다.
 * <ol>
 *   <li><b>{@code insert}가 돌려주는 id는 자기가 넣은 행의 id다</b> — 동시 삽입에서도. 이 id는
 *       {@code {ok,id}} 응답으로 나가 클라이언트가 행을 지목하는 식별자라 오배정은 곧 오식별이다.</li>
 *   <li><b>{@code LIKE}에 {@code ESCAPE}가 없다</b> — Node가 {@code %q%}를 그대로 바인딩하므로
 *       {@code q='%'}는 전체 매칭이다. 이스케이프를 추가하면 같은 질의에 두 서버가 다른 행 집합을 준다.</li>
 *   <li><b>present-only INSERT</b> — 주지 않은 컬럼은 문장에 없으므로 SQL NULL로 남는다.</li>
 *   <li><b>반환 행은 스키마 순서의 정확히 6키</b>다(id·src·caption·sourceArticleId·registeredBy·createdAt).</li>
 * </ol>
 *
 * <p>임시 파일 DB(@TempDir)만 쓴다 — 리포 {@code news.db}는 열지 않는다.
 */
class PhotoRepositoryTest {

	/** 스키마 순서 그대로의 반환 키 6개. 순서까지 단언한다(응답 원소 키 순서가 곧 이것이다). */
	private static final List<String> ROW_KEYS =
			List.of("id", "src", "caption", "sourceArticleId", "registeredBy", "createdAt");

	@TempDir
	Path tempDir;

	private HikariDataSource dataSource;

	private PhotoRepository photos;

	@BeforeEach
	void setUp() {
		TempNewsDb.seed(this.tempDir);
		this.dataSource = NewsDataSource.create(this.tempDir);
		this.photos = new PhotoRepository(JdbcClient.create(this.dataSource));
	}

	@AfterEach
	void tearDown() {
		if (this.dataSource != null) {
			this.dataSource.close();
		}
	}

	private static Map<String, Object> row(Object... keyValues) {
		Map<String, Object> map = new LinkedHashMap<>();
		for (int i = 0; i < keyValues.length; i += 2) {
			map.put((String) keyValues[i], keyValues[i + 1]);
		}
		return map;
	}

	private long insertPhoto(String src, String caption) {
		return this.photos.insert(row("src", src, "caption", caption,
				"sourceArticleId", "", "registeredBy", "reporter1", "createdAt", "2026-08-28T00:00:00.000Z"));
	}

	// --- 1. 삽입 → 검색 왕복 ---------------------------------------------------------------------

	@Test
	void insertThenSearchRoundTripsEveryColumn() {
		long id = this.photos.insert(row(
				"src", "/uploads/aabbccddeeff00112233445566778899.png",
				"caption", "현장 사진",
				"sourceArticleId", "A1",
				"registeredBy", "reporter1",
				"createdAt", "2026-08-28T01:02:03.004Z"));

		assertTrue(id > 0, "새 행의 id를 돌려줘야 한다");
		List<Map<String, Object>> found = this.photos.searchByCaption("현장");
		assertEquals(1, found.size());
		Map<String, Object> photo = found.get(0);
		assertEquals(Long.valueOf(id), photo.get("id"), "id는 정수로 읽는다");
		assertEquals("/uploads/aabbccddeeff00112233445566778899.png", photo.get("src"));
		assertEquals("현장 사진", photo.get("caption"));
		assertEquals("A1", photo.get("sourceArticleId"));
		assertEquals("reporter1", photo.get("registeredBy"));
		assertEquals("2026-08-28T01:02:03.004Z", photo.get("createdAt"));
	}

	@Test
	void returnedRowsCarryExactlySixKeysInSchemaOrder() {
		insertPhoto("/uploads/a.png", "키 순서");

		Map<String, Object> photo = this.photos.searchByCaption("키").get(0);

		assertEquals(ROW_KEYS, new ArrayList<>(photo.keySet()),
				"반환 키는 스키마 순서의 6종이다(SELECT * 로 넓어지면 이 단언이 먼저 깨진다)");
		assertEquals(RequiredSchema.PHOTO_COLUMNS, new ArrayList<>(photo.keySet()),
				"요구 목록이 곧 SELECT 나열의 단일 출처다");
	}

	// --- 2. present-only INSERT ------------------------------------------------------------------

	@Test
	void presentOnlyInsertLeavesUnsuppliedColumnsNull() {
		this.photos.insert(row("src", "/uploads/b.png", "caption", "부분 입력"));

		Map<String, Object> photo = this.photos.searchByCaption("부분").get(0);

		assertEquals("/uploads/b.png", photo.get("src"));
		assertNull(photo.get("sourceArticleId"), "주지 않은 컬럼은 SQL NULL로 남는다");
		assertNull(photo.get("registeredBy"));
		assertNull(photo.get("createdAt"));
		assertTrue(photo.containsKey("registeredBy"), "값이 NULL이어도 키는 남긴다");
	}

	@Test
	void insertIgnoresIdAndRejectsEmptyWhitelist() {
		long id = this.photos.insert(row("id", 999, "src", "/uploads/c.png", "caption", "id 무시",
				"notAColumn", "무시"));

		assertEquals(Long.valueOf(id), this.photos.searchByCaption("id 무시").get(0).get("id"),
				"id는 호출자 값이 아니라 자동 증가값이다");
		assertFalse(id == 999L, "호출자가 준 id가 그대로 들어가면 원장의 순서를 호출자가 정하게 된다");

		assertThrows(IllegalArgumentException.class, () -> this.photos.insert(row("notAColumn", "x")));
		assertThrows(IllegalArgumentException.class, () -> this.photos.insert(row()));
		assertThrows(IllegalArgumentException.class, () -> this.photos.insert(null));
	}

	@Test
	void insertRejectsNonScalarBindingValues() {
		// 값 바인딩 정책은 ColumnValues 단일 출처다 — 불리언·객체는 조용히 문자열이 되지 않고 예외다.
		assertThrows(IllegalArgumentException.class, () -> this.photos.insert(row("caption", Boolean.TRUE)));
	}

	// --- 3. id 오배정(동시 삽입) -----------------------------------------------------------------

	/**
	 * <b>{@code insert}가 돌려주는 id는 자기가 넣은 행의 id다</b> — 동시 삽입에서도.
	 *
	 * <p>왜 필요한가(phase 70 실측): {@code INSERT}와 {@code SELECT last_insert_rowid()}가 별도 호출이면
	 * 두 문장 사이에서 커넥션이 반납된다. 풀 상한이 1이라 모든 스레드가 <b>같은 물리 커넥션</b>을 쓰고
	 * {@code last_insert_rowid()}는 그 커넥션 단위 상태다 — A의 INSERT → B의 INSERT → A의 SELECT면
	 * A가 <b>B의 id</b>를 받는다. 사진 등록 응답 {@code {ok,id}}가 남의 사진 id를 실으면 그 뒤의 참조가
	 * 통째로 다른 사진을 가리킨다. Node는 단일 스레드라 없는 결함이라 계약이 관측하지 않는다.
	 */
	@Test
	void concurrentInsertsEachReturnTheIdOfTheirOwnRow() throws Exception {
		Map<String, Long> byMarker = new ConcurrentHashMap<>();
		int workers = 6;
		int perWorker = 12;
		CountDownLatch start = new CountDownLatch(1);
		ExecutorService pool = Executors.newFixedThreadPool(workers);
		List<Future<?>> running = new ArrayList<>();
		try {
			for (int worker = 0; worker < workers; worker++) {
				int index = worker;
				running.add(pool.submit(() -> {
					start.await();
					for (int i = 0; i < perWorker; i++) {
						String marker = "ph-" + index + "-" + i;
						byMarker.put(marker, insertPhoto("/uploads/" + marker + ".png", marker));
					}
					return null;
				}));
			}
			start.countDown();
			for (Future<?> task : running) {
				task.get(120, TimeUnit.SECONDS);
			}
		}
		finally {
			pool.shutdownNow();
		}

		assertEquals(workers * perWorker, byMarker.size(), "모든 삽입이 끝나야 판정이 성립한다");
		Map<Long, String> captionById = new LinkedHashMap<>();
		for (Map<String, Object> photo : this.photos.searchByCaption("ph-")) {
			captionById.put((Long) photo.get("id"), (String) photo.get("caption"));
		}
		for (Map.Entry<String, Long> inserted : byMarker.entrySet()) {
			assertEquals(inserted.getKey(), captionById.get(inserted.getValue()),
					"삽입이 남의 행 id를 돌려줬다 — INSERT와 last_insert_rowid() 사이에 커넥션이 반납된다");
		}
	}

	// --- 4. 캡션 검색(LIKE · id DESC) -------------------------------------------------------------

	@Test
	void emptyQueryReturnsEverythingNewestFirst() {
		long first = insertPhoto("/uploads/1.png", "하나");
		long second = insertPhoto("/uploads/2.png", "둘");
		long third = insertPhoto("/uploads/3.png", "셋");

		List<Map<String, Object>> all = this.photos.searchByCaption("");

		assertEquals(List.of(third, second, first),
				all.stream().map((photo) -> (Long) photo.get("id")).toList(),
				"빈 질의는 LIKE '%%'라 전체를 최신 등록 우선(id DESC)으로 돌려준다");
	}

	/**
	 * <b>{@code %}는 이스케이프되지 않는다</b> — 이 단언이 {@code ESCAPE} 추가를 막는 잠금이다.
	 *
	 * <p>Node는 {@code `%${q}%`}를 그대로 바인딩하므로 {@code q='%'}는 {@code LIKE '%%%'} = 전체 매칭이다.
	 * 이스케이프를 붙이면 리터럴 {@code %}를 담은 캡션만 나와 같은 질의에 두 서버가 다른 행 집합을 준다.
	 * 계약이 관측하지 않는 축이라 이 테스트가 유일 방어선이다.
	 */
	@Test
	void wildcardQueryMatchesEverythingBecauseThereIsNoEscapeClause() {
		insertPhoto("/uploads/x.png", "퍼센트 없는 캡션");
		insertPhoto("/uploads/y.png", "다른 캡션");

		assertEquals(2, this.photos.searchByCaption("%").size(),
				"LIKE에 ESCAPE를 붙이면 이 단언이 깨진다 — Node는 이스케이프하지 않는다");
		assertEquals(2, this.photos.searchByCaption("_").size(),
				"밑줄도 이스케이프하지 않는다(한 글자 와일드카드)");
	}

	@Test
	void searchMatchesCaptionOnlyAndIsAPartialMatch() {
		insertPhoto("/uploads/only-src-matches.png", "무관한 캡션");
		long target = insertPhoto("/uploads/z.png", "서울 도심 전경");

		assertEquals(List.of(target),
				this.photos.searchByCaption("도심").stream().map((photo) -> (Long) photo.get("id")).toList(),
				"부분일치이고 대상은 caption 컬럼뿐이다(src는 보지 않는다)");
		assertTrue(this.photos.searchByCaption("only-src-matches").isEmpty(), "src는 검색 대상이 아니다");
	}

	@Test
	void nullQueryFoldsToEmptyInsteadOfThrowing() {
		// 서비스가 String(...) 의미론으로 정규화하지만, null이 흘러와도 500이 되어서는 안 된다
		// (index.json decisions (24) — 불변 집합·문자열 연결에 null이 닿는 지점의 규율).
		insertPhoto("/uploads/n.png", "널 질의");

		assertEquals(1, this.photos.searchByCaption(null).size(), "null 질의는 빈 질의와 같다");
	}

	// --- 5. append-only: 갱신·삭제 표면이 없다 ---------------------------------------------------

	@Test
	void theRepositoryExposesInsertAndSearchOnly() {
		List<String> operations = new ArrayList<>();
		for (Method method : PhotoRepository.class.getDeclaredMethods()) {
			if (Modifier.isPublic(method.getModifiers()) && !method.isSynthetic()) {
				operations.add(method.getName());
			}
		}
		operations.sort(String::compareTo);

		assertEquals(List.of("insert", "searchByCaption"), operations,
				"append-only 테이블이다 — 갱신·삭제 연산을 추가하면 이 단언이 먼저 깨진다");
	}

	@Test
	void everyInsertAddsOneRowAndNothingEverRemovesOne() {
		List<Long> ids = new ArrayList<>();
		for (int i = 0; i < 5; i++) {
			ids.add(insertPhoto("/uploads/keep-" + i + ".png", "보존 " + i));
			assertEquals(i + 1, this.photos.searchByCaption("보존").size(), "삽입마다 정확히 한 행이 는다");
		}

		// 행 수만이 아니라 컬럼 단위로 확인한다 — 삭제 1 + 삽입 1은 행 수를 바꾸지 않는다(72 ④).
		List<Long> stored = this.photos.searchByCaption("보존").stream()
				.map((photo) -> (Long) photo.get("id")).sorted().toList();
		assertEquals(ids, stored, "먼저 넣은 행이 그대로 남아 있어야 한다");
	}
}
