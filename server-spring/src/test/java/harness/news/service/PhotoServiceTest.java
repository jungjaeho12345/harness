package harness.news.service;

import static org.junit.jupiter.api.Assertions.assertArrayEquals;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.zaxxer.hikari.HikariDataSource;
import harness.news.db.NewsDataSource;
import harness.news.model.PhotoRepository;
import harness.news.testsupport.MutableClock;
import harness.news.testsupport.TempNewsDb;
import java.lang.reflect.Method;
import java.lang.reflect.Modifier;
import java.nio.file.Path;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.jdbc.core.simple.JdbcClient;

/**
 * 사진DB 서비스의 도메인 계약 — Node {@code src/services/photoService.js}와 1:1이다.
 *
 * <p>등록은 <b>append-only</b>다(등록과 검색뿐이고 그 행을 고치거나 지우는 경로가 없다). 여기서 잠그는
 * 것은 넷이다.
 * <ol>
 *   <li><b>신원은 인자 {@code userId}로만 들어온다</b>(ADR-004). 요청 본문이 서비스까지 오는 통로 자체가
 *       없어야 한다 — 그래서 동작뿐 아니라 <b>메서드 표면</b>도 리플렉션으로 단언한다. 계약은 이 사실을
 *       되읽기(검색 응답의 {@code registeredBy})로만 관측하므로, 서비스가 dto를 받는 형태로 바뀌면
 *       계약이 red를 내기 전에 여기가 먼저 울려야 한다.</li>
 *   <li><b>{@code src} 검증은 {@link FileRef}뿐</b>이다 — 첨부·자료 파일과 규칙의 단일 출처다. 계약은
 *       4종(javascript:·data:·http:·traversal)만 보고, 프로토콜 상대·백슬래시·제어문자/공백·빈 문자열
 *       4종은 여기가 유일 방어선이다.</li>
 *   <li><b>거부는 행을 만들지 않는다</b> — 계약이 되읽기로 {@code items: []}를 본다.</li>
 *   <li><b>계약 밖의 두 축</b>: {@code ?? ''}가 <b>null 병합</b>이라는 것(빈 문자열·{@code 0}은 그대로
 *       간다 — {@code ||}가 아니다)과 <b>반복 쿼리 키</b>({@code ?q=a&q=b} → {@code LIKE '%a,b%'})다.
 *       decisions (14)·(22)⑧.</li>
 * </ol>
 *
 * <p>임시 파일 DB({@code @TempDir}) + 고정 시계만 쓴다 — 리포 {@code news.db}는 열지 않는다.
 */
class PhotoServiceTest {

	/** 고정 시계의 기준 시각 — 저장된 {@code createdAt}과 <b>바이트 동형</b>이어야 하는 값이다. */
	private static final String NOW = "2026-08-28T01:02:03.004Z";

	private static final String UPLOADED = "/uploads/aabbccddeeff00112233445566778899.png";

	private static final String HTTPS = "https://example.test/photo.png";

	private static final String ACTOR = "reporter1";

	@TempDir
	Path tempDir;

	private HikariDataSource dataSource;

	private PhotoRepository photos;

	private MutableClock clock;

	private PhotoService service;

	@BeforeEach
	void setUp() {
		TempNewsDb.seed(this.tempDir);
		this.dataSource = NewsDataSource.create(this.tempDir);
		this.photos = new PhotoRepository(JdbcClient.create(this.dataSource));
		this.clock = new MutableClock(Instant.parse(NOW).toEpochMilli());
		this.service = new PhotoService(this.photos, this.clock);
	}

	@AfterEach
	void tearDown() {
		if (this.dataSource != null) {
			this.dataSource.close();
		}
	}

	/** 저장된 행 그대로 — 서비스가 아니라 리포지토리로 되읽어 서비스의 주장과 저장 사실을 분리한다. */
	private Map<String, Object> storedRow(Object registerResult) {
		Object id = ((Map<?, ?>) registerResult).get("id");
		return this.photos.searchByCaption("").stream()
				.filter((row) -> row.get("id").equals(id))
				.findFirst()
				.orElseThrow(() -> new AssertionError("등록했다는 행이 저장돼 있지 않다: id=" + id));
	}

	private int rowCount() {
		return this.photos.searchByCaption("").size();
	}

	private static List<String> keysOf(Map<String, Object> result) {
		return new ArrayList<>(result.keySet());
	}

	// --- 1. 허용되는 src -------------------------------------------------------------------------

	@Test
	void uploadsRelativeAndHttpsSourcesAreRegistered() {
		Map<String, Object> fromUpload = this.service.register(UPLOADED, "현장 사진", null, ACTOR);
		Map<String, Object> fromHttps = this.service.register(HTTPS, "외부 사진", null, ACTOR);

		assertEquals(List.of("ok", "id"), keysOf(fromUpload), "성공 응답은 {ok,id} 2키다(순서까지)");
		assertEquals(Boolean.TRUE, fromUpload.get("ok"));
		assertTrue(fromUpload.get("id") instanceof Number, "id는 수다 — 클라이언트가 행을 지목하는 식별자다");
		assertNotEquals(fromUpload.get("id"), fromHttps.get("id"), "등록마다 새 행이다");

		assertEquals(UPLOADED, storedRow(fromUpload).get("src"), "업로드 상대경로는 원문 그대로 저장된다");
		assertEquals(HTTPS, storedRow(fromHttps).get("src"), "https:// src는 원문 그대로 저장된다");
	}

	// --- 2. 거부되는 src (계약 4종 + 계약 밖 4종) -------------------------------------------------

	@Test
	void rejectedSourcesAreInvalidSrcAndLeaveNoRow() {
		List<Object> rejected = new ArrayList<>(List.of(
				"javascript:alert(1)", // 계약 관측 4종
				"data:image/png;base64,AAA",
				"http://example.test/photo.png",
				"/uploads/../secret.png",
				"//host/p.png", // 계약 밖 — 프로토콜 상대
				"/uploads/dir\\p.png", // 계약 밖 — 백슬래시(브라우저가 '/'로 정규화한다)
				"/uploads/a b.png", // 계약 밖 — 공백
				"/uploads/a\u0001b.png", // 계약 밖 — 제어문자
				"")); // 계약 밖 — 빈 문자열
		rejected.add(null); // 값 자체가 없는 경우 — 500이 아니라 400이어야 한다

		int before = rowCount();
		for (Object src : rejected) {
			Map<String, Object> result = this.service.register(src, "거부 캡션", null, ACTOR);

			assertEquals(List.of("ok", "reason"), keysOf(result), "거부 응답은 {ok,reason} 2키다: " + src);
			assertEquals(Boolean.FALSE, result.get("ok"), "거부인데 ok가 참이다: " + src);
			assertEquals("invalid-src", result.get("reason"), "사유는 invalid-src다: " + src);
		}

		assertEquals(before, rowCount(), "거부된 등록은 append-only 원장에 행을 남기지 않는다");
	}

	// --- 3. 기본값은 빈 문자열이고 ?? 는 null 병합이다 --------------------------------------------

	@Test
	void captionAndSourceArticleIdDefaultToEmptyStringNotNull() {
		Map<String, Object> result = this.service.register(HTTPS, null, null, ACTOR);

		Map<String, Object> row = storedRow(result);
		assertEquals("", row.get("caption"), "caption 생략은 빈 문자열이다");
		assertEquals("", row.get("sourceArticleId"), "sourceArticleId 생략은 빈 문자열이다(null 아님)");
	}

	/**
	 * {@code ?? ''}는 <b>null 병합</b>이다 — {@code ||}로 바꾸면 falsy 값이 함께 접힌다.
	 *
	 * <p>빈 문자열은 두 연산자의 결과가 같아 red가 나지 않는다. 그래서 <b>{@code 0}</b>을 나란히 둔다:
	 * 정본은 {@code 0}을 그대로 넘겨 {@code node:sqlite}가 REAL로 내리고 TEXT affinity가
	 * {@code "0.0"}으로 저장한다. {@code ||}면 그 자리가 빈 문자열이 되어 두 서버의 저장값이 갈린다.
	 */
	@Test
	void nullishCoalescingKeepsFalsyValues() {
		Map<String, Object> withZero = this.service.register(HTTPS, "숫자 0", 0, ACTOR);
		Map<String, Object> withNothing = this.service.register(HTTPS, "생략", null, ACTOR);

		String zero = (String) storedRow(withZero).get("sourceArticleId");
		assertNotEquals("", zero, "0은 falsy지만 null이 아니다 — 기본값으로 접히면 안 된다");
		assertEquals("0.0", zero, "수는 REAL로 바인딩되고 TEXT affinity가 표현을 정한다(Node 동형)");
		assertEquals("", storedRow(withNothing).get("sourceArticleId"), "값이 없을 때만 빈 문자열이다");
	}

	/**
	 * 불리언은 조용히 문자열이 되지 않는다 — {@code node:sqlite}가 TypeError를 던져 500이 되는 자리다.
	 * ({@code ||}로 접으면 {@code false}가 빈 문자열이 되어 200으로 갈린다.)
	 */
	@Test
	void booleanValuesAreNotCoercedAndLeaveNoRow() {
		int before = rowCount();

		assertThrows(IllegalArgumentException.class,
				() -> this.service.register(HTTPS, Boolean.FALSE, null, ACTOR),
				"불리언 캡션은 바인딩 예외다(전역 핸들러가 500으로 만든다)");

		assertEquals(before, rowCount(), "바인딩 예외는 행을 만들지 않는다");
	}

	// --- 4. 신원은 인자로만 온다(ADR-004) ---------------------------------------------------------

	@Test
	void registeredByComesFromTheUserIdArgumentOnly() {
		Map<String, Object> stamped = this.service.register(HTTPS, "someone-else 라는 캡션", "someone-else", ACTOR);

		assertEquals(ACTOR, storedRow(stamped).get("registeredBy"),
				"registeredBy는 검증된 세션에서 온 userId뿐이다 — 다른 필드의 값이 새어 들어오면 안 된다");
	}

	@Test
	void registeredByIsNullWhenTheCallerHasNoUserId() {
		Map<String, Object> anonymous = this.service.register(HTTPS, "익명", null, null);

		assertNull(storedRow(anonymous).get("registeredBy"), "userId가 없으면 SQL NULL이다(userId ?? null)");
	}

	/**
	 * 표면 단언 — 요청 본문(dto)이 이 서비스에 도달하는 통로가 <b>구조적으로</b> 없어야 한다. 맵을 통째로
	 * 받는 순간 {@code registeredBy} 위조 경로가 생기고, 그 사실은 동작 테스트로는 잡히지 않는다
	 * (위조 키를 넣는 호출부가 아직 없기 때문이다).
	 */
	@Test
	void noPublicEntryPointAcceptsARequestBodyMap() {
		List<Method> registers = Arrays.stream(PhotoService.class.getMethods())
				.filter((method) -> method.getName().equals("register"))
				.toList();

		assertEquals(1, registers.size(), "register는 오버로드 없이 하나여야 한다: " + registers);
		assertArrayEquals(new Class<?>[] { Object.class, Object.class, Object.class, String.class },
				registers.get(0).getParameterTypes(),
				"신원은 마지막 인자(String userId)로만 들어온다");

		for (Method method : PhotoService.class.getDeclaredMethods()) {
			if (!Modifier.isPublic(method.getModifiers())) {
				continue;
			}
			for (Class<?> parameter : method.getParameterTypes()) {
				assertFalse(Map.class.isAssignableFrom(parameter),
						"요청 본문 맵을 받는 공개 메서드가 있다(ADR-004 위조 경로): " + method);
			}
		}
	}

	// --- 5. 시각은 주입된 시계에서만 온다 ---------------------------------------------------------

	@Test
	void createdAtIsByteIdenticalToTheInjectedClock() {
		Map<String, Object> first = this.service.register(HTTPS, "시계 A", null, ACTOR);
		assertEquals(NOW, storedRow(first).get("createdAt"), "주입된 시계 값과 바이트 동형이다");

		this.clock.setMillis(Instant.parse("2026-01-02T03:04:05Z").toEpochMilli());
		Map<String, Object> second = this.service.register(HTTPS, "시계 B", null, ACTOR);

		assertEquals("2026-01-02T03:04:05.000Z", storedRow(second).get("createdAt"),
				"나노초가 0이어도 소수 3자리를 싣는다(정렬 키의 형식이다)");
	}

	// --- 6. 검색 ---------------------------------------------------------------------------------

	@Test
	void searchReturnsNewestFirst() {
		Object first = this.service.register(HTTPS, "정렬 1", null, ACTOR).get("id");
		Object second = this.service.register(HTTPS, "정렬 2", null, ACTOR).get("id");
		Object third = this.service.register(HTTPS, "정렬 3", null, ACTOR).get("id");

		List<Object> ids = this.service.search("정렬").stream().map((row) -> row.get("id")).toList();

		assertEquals(List.of(third, second, first), ids, "최신 등록이 위다(id DESC)");
	}

	@Test
	void emptyAndOmittedQueriesMatchEverything() {
		this.service.register(HTTPS, "전체 1", null, ACTOR);
		this.service.register(HTTPS, "전체 2", null, ACTOR);

		List<Map<String, Object>> empty = this.service.search("");
		List<Map<String, Object>> omitted = this.service.search(null);
		List<Map<String, Object>> percent = this.service.search("%");

		assertEquals(2, empty.size(), "빈 질의는 필터하지 않는다(LIKE '%%')");
		assertEquals(empty, omitted, "q 생략(null)은 빈 문자열과 같다 — 라우트의 ?? '' 동형");
		assertEquals(empty, percent, "LIKE에 ESCAPE가 없으므로 '%'는 전체 매칭이다");
	}

	@Test
	void searchRowsCarryTheSixSchemaColumns() {
		this.service.register(HTTPS, "여섯 컬럼", null, ACTOR);

		Map<String, Object> row = this.service.search("여섯").get(0);

		assertEquals(List.of("id", "src", "caption", "sourceArticleId", "registeredBy", "createdAt"),
				new ArrayList<>(row.keySet()), "행은 스키마 순서의 6컬럼 그대로 나간다(투영하지 않는다)");
	}

	/**
	 * 반복 쿼리 키({@code ?q=a&q=b})는 express에서 배열이 되고, 그 배열이 {@code `%${q}%`} 템플릿에 들어가면
	 * <b>콤마로 결합</b>된다. 첫 값만 취하면({@code getParameter}의 기본 동작) 같은 질의에 두 서버가 다른
	 * 행 집합을 준다 — 계약 밖이라 여기가 유일 방어선이다.
	 */
	@Test
	void repeatedQueryKeysAreJoinedWithCommas() {
		Object joined = this.service.register(HTTPS, "반복 a,b 결합", null, ACTOR).get("id");
		this.service.register(HTTPS, "반복 a 단독", null, ACTOR);

		List<Object> ids = this.service.search(List.of("a", "b")).stream().map((row) -> row.get("id")).toList();

		assertEquals(List.of(joined), ids, "'a,b'로 결합해야 한다 — 첫 값만 쓰면 'a 단독'까지 매칭된다");
		assertEquals(List.of(), this.service.search(List.of("b", "a")), "결합 순서는 값의 순서 그대로다");
	}

	@Test
	void nullQueryDoesNotBecomeAServerError() {
		this.service.register(HTTPS, "널 질의", null, ACTOR);

		assertEquals(1, this.service.search(null).size(), "null 질의는 예외가 아니라 전체 조회다");
	}

}
