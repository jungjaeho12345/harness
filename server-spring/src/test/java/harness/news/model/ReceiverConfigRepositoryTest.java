package harness.news.model;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.zaxxer.hikari.HikariDataSource;
import harness.news.db.NewsDataSource;
import harness.news.testsupport.TempNewsDb;
import java.nio.file.Path;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.jdbc.core.simple.JdbcClient;

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
		this.configs = new ReceiverConfigRepository(JdbcClient.create(this.dataSource));
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

	@Test
	void removeOfNanIdReturnsZeroChangesNotAnError() {
		// Node 동형: DELETE /api/receiver-config/abc → Number('abc')=NaN → 어떤 행에도 매치되지 않아 200 changes:0.
		// long이면 담을 수 없는 값이라 double REAL 바인딩으로 재현한다(SQLite: id = NaN은 항상 거짓).
		this.configs.insert(row("sourceId", "src-live"));
		assertEquals(0, this.configs.remove(Double.NaN), "NaN id는 매칭 0 → changes 0(500 아님)");
		assertEquals(1, this.configs.query(row("sourceId", "src-live")).size(), "NaN 삭제가 다른 행을 지우지 않는다");
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
