package harness.news.model;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.zaxxer.hikari.HikariDataSource;
import harness.news.db.NewsDataSource;
import harness.news.testsupport.TempNewsDb;
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
import org.springframework.jdbc.support.JdbcTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

/**
 * ReceiverConfig 리포지토리 — 리포 루트 {@code src/models/receiverConfigModel.js}와 1:1 대응하는 3연산의
 * 동작 계약(query·insert·remove).
 *
 * <p>가장 중요한 두 축: (1) {@code remove}는 <b>이 서버 유일의 행 삭제</b>이고 존재 판정을 하지 않아
 * 없는 id·NaN id·재삭제가 전부 changes 0으로 수렴한다(멱등, 500 아님). (2) 반환은 시크릿
 * ({@code password}·{@code apiKey})을 포함한 원본이다 — 투영은 서비스 계층 책임이다.
 *
 * <p>임시 파일 DB(@TempDir)만 쓴다 — 리포 {@code news.db}는 열지 않는다.
 */
class ReceiverConfigRepositoryTest {

	@TempDir
	Path tempDir;

	private HikariDataSource dataSource;

	private ReceiverConfigRepository configs;

	@BeforeEach
	void setUp() {
		TempNewsDb.seed(this.tempDir);
		this.dataSource = NewsDataSource.create(this.tempDir);
		this.configs = new ReceiverConfigRepository(JdbcClient.create(this.dataSource),
				new TransactionTemplate(new JdbcTransactionManager(this.dataSource)));
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

	// --- insert + query round trip --------------------------------------------------------------

	@Test
	void insertReturnsPositiveIntegerIdAndQueryRoundTripsEveryColumnIncludingSecrets() {
		int id = this.configs.insert(row(
				"sourceId", "src-1", "type", "FTP", "name", "수신1",
				"host", "127.0.0.1", "port", "21", "username", "u1",
				"password", "ftp-secret", "active", "Y"));

		assertTrue(id > 0, "새 행 id는 양의 정수다");

		List<Map<String, Object>> found = this.configs.query(row("id", id));
		assertEquals(1, found.size());
		Map<String, Object> config = found.get(0);
		assertEquals(Long.valueOf(id), config.get("id"), "id는 정수로 읽힌다");
		assertEquals("src-1", config.get("sourceId"));
		assertEquals("FTP", config.get("type"));
		assertEquals("127.0.0.1", config.get("host"));
		assertEquals("21", config.get("port"), "port는 VARCHAR라 문자열이다");
		assertEquals("ftp-secret", config.get("password"), "리포지토리는 시크릿을 걸러내지 않는다(원본 반환)");
		assertEquals("Y", config.get("active"));
		assertNull(config.get("createdAt"), "미지정 컬럼은 SQL NULL이고 키는 남는다");
		assertTrue(config.containsKey("apiKey"), "SELECT는 화이트리스트 전 컬럼을 싣는다(값 null)");
	}

	@Test
	void insertRejectsWhenNoWhitelistedColumnRemains() {
		assertThrows(IllegalArgumentException.class, () -> this.configs.insert(row("notAColumn", "x")));
		assertThrows(IllegalArgumentException.class, () -> this.configs.insert(row()));
	}

	@Test
	void insertIgnoresIdAndColumnsOutsideTheWhitelist() {
		// id는 삽입 대상이 아니고(자동 증가), 화이트리스트 밖 키는 조용히 무시된다.
		int id = this.configs.insert(row("id", 999, "sourceId", "src-2", "notAColumn", "무시"));

		Map<String, Object> config = this.configs.query(row("id", id)).get(0);
		assertEquals(Long.valueOf(id), config.get("id"), "id는 호출자 값이 아니라 자동 증가값이다");
		assertEquals("src-2", config.get("sourceId"));
	}

	// --- query 화이트리스트 -----------------------------------------------------------------------

	@Test
	void queryFiltersByWhitelistedColumnsWithAndAndIgnoresUnknownKeys() {
		int ftp = this.configs.insert(row("sourceId", "src-ftp", "type", "FTP"));
		this.configs.insert(row("sourceId", "src-api", "type", "API"));

		// sourceId로 좁히면 그 행만.
		List<Map<String, Object>> bySource = this.configs.query(row("sourceId", "src-ftp"));
		assertEquals(1, bySource.size());
		assertEquals(Long.valueOf(ftp), bySource.get(0).get("id"));

		// AND 조합 불일치 → 빈 목록.
		assertEquals(0, this.configs.query(row("sourceId", "src-ftp", "type", "API")).size());

		// 화이트리스트 밖 키는 무시(필터가 안 걸린 것과 같다) — 주입 문자열도 컬럼이 아니라 무시.
		assertEquals(1, this.configs.query(row("sourceId", "src-ftp", "notAColumn", "zzz")).size());
		assertEquals(1, this.configs.query(row("sourceId", "src-ftp", "id = 1 OR '1'='1", "주입")).size());
		assertEquals(2, this.configs.query(row()).size(), "필터가 없으면 전건이다");
		assertEquals(2, this.configs.query(row("type", null)).size(), "null 값은 필터 없음이다");
	}

	@Test
	void queryOrdersById() {
		int a = this.configs.insert(row("sourceId", "s-a"));
		int b = this.configs.insert(row("sourceId", "s-b"));

		List<Map<String, Object>> all = this.configs.query(row());
		assertEquals(Long.valueOf(a), all.get(0).get("id"));
		assertEquals(Long.valueOf(b), all.get(1).get("id"));
	}

	// --- remove(유일한 행 삭제 · 멱등 · NaN 수렴) ---------------------------------------------------

	@Test
	void removeDeletesOwnRowAndIsIdempotent() {
		int id = this.configs.insert(row("sourceId", "src-del"));

		assertEquals(1, this.configs.remove(id), "자기 행 삭제 → changes 1");
		assertEquals(0, this.configs.query(row("id", id)).size(), "삭제한 행은 사라진다");

		// 같은 id 재삭제 → 존재 판정을 하지 않으므로 예외가 아니라 changes 0(멱등).
		assertEquals(0, this.configs.remove(id));
	}

	@Test
	void removeOfAbsentIdReturnsZeroChanges() {
		assertEquals(0, this.configs.remove(999_999));
	}

	/**
	 * <b>예외 경계는 자기 행 하나에서 끝난다</b> — 다른 테이블로도, 같은 테이블의 다른 행으로도 번지지 않는다.
	 *
	 * <p>왜 이 테스트가 필요한가(2026-08-24 테스터 게이트 변이 실측): {@code remove}가 설정 행을 지우면서
	 * <b>Article 테이블 전체를 함께 비우도록</b> 고친 변이에서 Java 651 테스트·계약 default 163관측이
	 * <b>전부 green</b>이었다. 정적 삭제 스캔은 {@code "delete from" + " Article ..."}처럼 문자열을 끊어
	 * 쓰면 원문 정규식({@code \bdelete\s+from\s+})에 걸리지 않았고, "수집된 기사는 불변"을 <b>행 수로</b>
	 * 확인하는 테스트는 어디에도 없었다(계약 파일 8~9행이 그 확인을 후속 collection phase로 미룬다).
	 * 즉 이 서버 유일의 행 삭제 예외가 다른 테이블로 번져도 아무 게이트가 울리지 않는 상태였다.
	 *
	 * <p>여기서 잠그는 것: 설정 행 1개를 지운 뒤 ① 남은 ReceiverConfig 행 ② 수집된 Article·Contents
	 * ③ 이력 원장 ④ 배부 대상 ⑤ 사용자 행이 전부 그대로다. 정적 스캔과 덮는 벡터가 다르다 —
	 * 여기는 "행이 실제로 남는다"를, 스캔은 "그런 SQL이 소스에 있다"를 본다.
	 */
	@Test
	void removeTouchesOnlyItsOwnRowAndLeavesEveryOtherTableIntact() {
		JdbcClient sql = JdbcClient.create(this.dataSource);
		sql.sql("INSERT INTO Article (articleId, title) VALUES ('rc-keep-1', '수집 기사')").update();
		sql.sql("INSERT INTO Contents (articleId, title, status) VALUES ('rc-keep-1', '수집 기사', 'DES')").update();
		sql.sql("INSERT INTO ArticleHistory (articleId, eventType) VALUES ('rc-keep-1', 'edit')").update();
		sql.sql("INSERT INTO DistributionTarget (name, kind, spoolDir) VALUES ('t', 'press', 'sp-keep')").update();
		sql.sql("INSERT INTO User (userId, role) VALUES ('rc-keep-u', 'Z')").update();

		int keep = this.configs.insert(row("sourceId", "src-keep"));
		int drop = this.configs.insert(row("sourceId", "src-drop"));

		assertEquals(1, this.configs.remove(drop), "자기 행 하나만 지운다");

		assertEquals(1, this.configs.query(row("id", keep)).size(), "다른 설정 행은 남는다(WHERE 없는 삭제 금지)");
		for (String table : List.of("Article", "Contents", "ArticleHistory", "DistributionTarget", "User")) {
			assertEquals(1, count(sql, table),
					table + " 행이 사라졌다 — 유일한 행 삭제 예외가 다른 테이블로 번졌다");
		}
	}

	private static int count(JdbcClient sql, String table) {
		Integer rows = sql.sql("SELECT COUNT(*) FROM " + table).query(Integer.class).single();
		return rows == null ? -1 : rows;
	}

	@Test
	void removeOfNanIdReturnsZeroChangesNotAnError() {
		// Node 동형: DELETE /api/receiver-config/abc → Number('abc')=NaN → 어떤 행에도 매치되지 않아 200 changes:0.
		// long이면 담을 수 없는 값이라 double REAL 바인딩으로 재현한다(SQLite: id = NaN은 항상 거짓).
		this.configs.insert(row("sourceId", "src-live"));
		assertEquals(0, this.configs.remove(Double.NaN), "NaN id는 매칭 0 → changes 0(500 아님)");
		assertEquals(1, this.configs.query(row("sourceId", "src-live")).size(), "NaN 삭제가 다른 행을 지우지 않는다");
	}

	// --- 동시 삽입: 돌려주는 id는 자기 행의 id다 ---------------------------------------------------

	/**
	 * <b>{@code insert}가 돌려주는 id는 자기가 넣은 행의 id다</b> — 동시 삽입에서도.
	 *
	 * <p>왜 필요한가(2026-08-24 리뷰 med-4): {@code INSERT} 다음의 {@code SELECT last_insert_rowid()}가
	 * 별도 호출이면 두 문장 사이에서 커넥션이 풀에 반납된다. 풀 상한이 1이라 모든 스레드가 <b>같은 물리
	 * 커넥션</b>을 쓰고 {@code last_insert_rowid()}는 그 커넥션 단위 상태다 — A의 INSERT → B의 INSERT →
	 * A의 SELECT면 A가 <b>B의 id</b>를 받는다. 그 id로 이 라우트가 삭제를 하면 <b>남의 설정 행</b>이
	 * 사라진다(행 삭제가 허용된 유일한 테이블이다). Node는 단일 스레드라 없는 결함이라 계약이 관측하지
	 * 않는다 — 두 문장을 한 트랜잭션에 묶는 것이 유일한 방어선이다.
	 */
	@Test
	void concurrentInsertsEachReturnTheIdOfTheirOwnRow() throws Exception {
		Map<String, Integer> byMarker = new ConcurrentHashMap<>();
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
						String marker = "src-" + index + "-" + i;
						byMarker.put(marker, this.configs.insert(row("sourceId", marker)));
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
		for (Map.Entry<String, Integer> inserted : byMarker.entrySet()) {
			List<Map<String, Object>> found = this.configs.query(row("id", inserted.getValue()));
			assertEquals(1, found.size(), "돌려준 id의 행이 없다: " + inserted);
			assertEquals(inserted.getKey(), found.get(0).get("sourceId"),
					"삽입이 남의 행 id를 돌려줬다 — INSERT와 last_insert_rowid() 사이에 커넥션이 반납된다");
		}
	}

	// --- 값 바인딩 정책(decisions (13) — ColumnValues 승계) -----------------------------------------

	@Test
	void insertRejectsNonScalarBindingValues() {
		assertThrows(IllegalArgumentException.class,
				() -> this.configs.insert(row("sourceId", Boolean.TRUE)), "불리언은 바인딩 예외다");
		assertThrows(IllegalArgumentException.class,
				() -> this.configs.insert(row("sourceId", List.of("x"))), "배열/객체는 바인딩 예외다");
	}
}
