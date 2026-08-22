package harness.news.service;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.zaxxer.hikari.HikariDataSource;
import harness.news.db.NewsDataSource;
import harness.news.model.ArticleRepository;
import harness.news.model.ReceiverConfigRepository;
import harness.news.model.UserRepository;
import harness.news.testsupport.MutableClock;
import harness.news.testsupport.TempNewsDb;
import java.nio.file.Path;
import java.time.Clock;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.jdbc.support.JdbcTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

/**
 * 수집 수신 설정 서비스 — 리포 루트 {@code src/services/receiverConfigService.js}와 동형.
 *
 * <p>잠그는 축: (1) 3 op 전부 Z 게이트(미인증 unauthenticated · 비-Z forbidden) · 거부 시 리포지토리
 * 미호출(행 불변). (2) 조회 투영은 SAFE_FIELDS 10키 allowlist — 시크릿(password·apiKey)은 어떤 경로로도
 * 나가지 않고 NULL 컬럼도 키는 남는다. (3) 생성은 id만, 삭제는 changes만 돌려준다(멱등).
 *
 * <p>실제 세션·인가를 태운다(@TempDir DB) — role은 세션에서만 도출된다는 불변식을 서비스 경계에서 확인한다.
 */
class ReceiverConfigServiceTest {

	@TempDir
	Path tempDir;

	private HikariDataSource dataSource;

	private ReceiverConfigRepository configs;

	private SessionGuard guard;

	private ReceiverConfigService service;

	@BeforeEach
	void setUp() {
		TempNewsDb.seed(this.tempDir);
		this.dataSource = NewsDataSource.create(this.tempDir);
		UserRepository users = new UserRepository(JdbcClient.create(this.dataSource));
		ArticleRepository articles = new ArticleRepository(JdbcClient.create(this.dataSource),
				new TransactionTemplate(new JdbcTransactionManager(this.dataSource)),
				Clock.fixed(Instant.parse("2026-08-20T12:34:56.789Z"), ZoneOffset.UTC));
		this.guard = new SessionGuard(new SessionStore(new MutableClock(1_700_000_000_000L)), users);
		Authorization authorization = new Authorization(this.guard, articles);
		this.configs = new ReceiverConfigRepository(JdbcClient.create(this.dataSource));
		this.service = new ReceiverConfigService(this.configs, authorization);
		insertUser("rc-z", "Z");
		insertUser("rc-r", "R");
	}

	@AfterEach
	void tearDown() {
		if (this.dataSource != null) {
			this.dataSource.close();
		}
	}

	private String zToken() {
		return this.guard.createSession("rc-z");
	}

	// --- create / query (Z) ---------------------------------------------------------------------

	@Test
	void adminCreateReturnsPositiveIdAndNeverEchoesSecrets() {
		ReceiverConfigService.Result result = this.service.create(zToken(), entry(
				"sourceId", "src-1", "type", "FTP", "name", "수신1",
				"password", "ftp-secret", "apiKey", "api-secret", "active", "Y"));

		assertTrue(result.ok());
		assertTrue(result.id() != null && result.id() > 0);
		// 반환 객체는 id만 — user 객체를 되돌려주지 않으므로 시크릿 반향 원천이 없다.
		assertNull(result.items());
		assertNull(result.changes());
	}

	@Test
	void adminQueryProjectsExactlyTheTenSafeFieldsWithNullKeysPreserved() {
		int id = this.service.create(zToken(), entry(
				"sourceId", "src-list", "type", "FTP", "host", "127.0.0.1",
				"password", "ftp-secret", "apiKey", "api-secret")).id();

		ReceiverConfigService.Result result = this.service.query(zToken(), Map.of("id", id));
		assertTrue(result.ok());
		assertEquals(1, result.items().size());
		Map<String, Object> item = result.items().get(0);

		assertEquals(
				List.of("id", "sourceId", "type", "name", "host", "port",
						"apiEndpoint", "active", "createdAt", "username"),
				List.copyOf(item.keySet()),
				"정확 10키(Node SAFE_FIELDS 순서)");
		assertFalse(item.containsKey("password"), "FTP 비밀번호는 투영 밖이다");
		assertFalse(item.containsKey("apiKey"), "API 키는 투영 밖이다");
		assertEquals(Long.valueOf(id), item.get("id"));
		assertEquals("src-list", item.get("sourceId"));
		assertNull(item.get("createdAt"), "서버가 채우지 않은 컬럼은 null이고 키는 남는다");
		assertNull(item.get("name"), "미지정 컬럼도 null 키로 실린다");
	}

	// --- 인가 게이트 -----------------------------------------------------------------------------

	@Test
	void nonAdminSessionsAreForbiddenOnAllThreeOpsAndTouchNoRow() {
		String reporter = this.guard.createSession("rc-r");
		int existing = this.service.create(zToken(), entry("sourceId", "src-guard")).id();

		ReceiverConfigService.Result created = this.service.create(reporter, entry("sourceId", "src-denied"));
		ReceiverConfigService.Result listed = this.service.query(reporter, Map.of());
		ReceiverConfigService.Result removed = this.service.remove(reporter, existing);

		for (ReceiverConfigService.Result r : List.of(created, listed, removed)) {
			assertFalse(r.ok());
			assertEquals("forbidden", r.reason());
		}
		// 거부는 아무 행도 만들거나 지우지 않았다 — 게이트가 리포지토리를 막았다.
		assertEquals(0, this.configs.query(Map.of("sourceId", "src-denied")).size());
		assertEquals(1, this.configs.query(Map.of("id", existing)).size());
	}

	@Test
	void missingOrUnknownTokensAreUnauthenticated() {
		String dead = "0".repeat(64);
		for (String token : new String[] {null, dead}) {
			assertEquals("unauthenticated", this.service.query(token, Map.of()).reason());
			assertEquals("unauthenticated", this.service.create(token, entry("sourceId", "x")).reason());
			assertEquals("unauthenticated", this.service.remove(token, 1).reason());
		}
	}

	// --- remove 멱등 ------------------------------------------------------------------------------

	@Test
	void removeReturnsChangesAndIsIdempotent() {
		int id = this.service.create(zToken(), entry("sourceId", "src-del")).id();

		assertEquals(1, this.service.remove(zToken(), id).changes());
		assertEquals(0, this.service.remove(zToken(), id).changes(), "재삭제는 changes 0(멱등)");
	}

	// --- 투영 allowlist 실증 -----------------------------------------------------------------------

	@Test
	void projectionDropsSecretsEvenWhenTheRepositoryRowCarriesThem() {
		// 리포지토리가 password·apiKey를 담은 행을 돌려줘도 sanitize 후 그 키가 없다.
		this.configs.insert(entry("sourceId", "src-secret", "password", "ftp-secret", "apiKey", "api-secret"));

		Map<String, Object> item = this.service.query(zToken(), Map.of("sourceId", "src-secret"))
				.items().get(0);

		assertFalse(item.containsKey("password"));
		assertFalse(item.containsKey("apiKey"));
		assertFalse(item.values().contains("ftp-secret"), "시크릿 원문이 값으로도 새지 않는다");
		assertFalse(item.values().contains("api-secret"));
	}

	// --- 도우미 ---------------------------------------------------------------------------------

	private static Map<String, Object> entry(Object... keyValues) {
		Map<String, Object> map = new LinkedHashMap<>();
		for (int i = 0; i < keyValues.length; i += 2) {
			map.put((String) keyValues[i], keyValues[i + 1]);
		}
		return map;
	}

	private void insertUser(String userId, String role) {
		Map<String, Object> row = new LinkedHashMap<>();
		row.put("userId", userId);
		row.put("name", userId);
		row.put("password", "$2a$10$hashhashhashhashhashha");
		row.put("role", role);
		row.put("active", "Y");
		new UserRepository(JdbcClient.create(this.dataSource)).insert(row);
	}
}
