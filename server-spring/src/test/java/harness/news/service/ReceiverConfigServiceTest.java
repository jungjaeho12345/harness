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
 * 수신 설정 서비스 — 리포 루트 {@code src/services/receiverConfigService.js}와 1:1(게이트 위임·SAFE_FIELDS
 * 투영). HTTP 비의존(ADR-006).
 *
 * <p>이 phase가 동결하는 축: (1) <b>모든 op가 Z 전용</b> — acting role은 검증된 세션에서만 도출한다
 * (미인증 401 · 비-Z 403). (2) 조회 응답은 <b>SAFE_FIELDS 10키 allowlist</b> 투영이라 {@code password}·
 * {@code apiKey}가 어떤 원소에도 없다. (3) create는 <b>입력 검증이 없고</b> {@code createdAt}을 stamp하지
 * 않는다(저장 후 null). (4) 필터 화이트리스트가 {@code password}·{@code apiKey}를 포함한다(결함 후보 #3 —
 * Node 동형 재현, 여기서 고치지 않는다).
 */
class ReceiverConfigServiceTest {

	/** Node SAFE_FIELDS 순서(10키) — username이 마지막이고 password·apiKey는 없다. */
	private static final List<String> SAFE_FIELDS = List.of(
			"id", "sourceId", "type", "name", "host", "port", "apiEndpoint", "active", "createdAt", "username");

	@TempDir
	Path tempDir;

	private HikariDataSource dataSource;

	private ReceiverConfigRepository configs;

	private SessionGuard guard;

	private ReceiverConfigService service;

	@BeforeEach
	void setUp() {
		TempNewsDb.seed(tempDir);
		dataSource = NewsDataSource.create(tempDir);
		JdbcClient jdbc = JdbcClient.create(dataSource);
		UserRepository users = new UserRepository(jdbc);
		ArticleRepository articles = new ArticleRepository(jdbc,
				new TransactionTemplate(new JdbcTransactionManager(dataSource)),
				Clock.fixed(Instant.parse("2026-08-22T00:00:00.000Z"), ZoneOffset.UTC));
		this.guard = new SessionGuard(new SessionStore(new MutableClock(1_700_000_000_000L)), users);
		Authorization authorization = new Authorization(this.guard, articles);
		this.configs = new ReceiverConfigRepository(jdbc);
		this.service = new ReceiverConfigService(this.configs, authorization);
		insertUser(users, "rc-z", "Z");
		insertUser(users, "rc-r", "R");
		insertUser(users, "rc-d", "D");
	}

	@AfterEach
	void tearDown() {
		if (dataSource != null) {
			dataSource.close();
		}
	}

	// --- 인가(모든 op) -------------------------------------------------------------------------

	@Test
	void everyOperationRequiresAnAdminSession() {
		// 미인증(null 토큰) → unauthenticated.
		for (Map<String, Object> denied : List.of(
				this.service.query(null, Map.of()),
				this.service.create(null, Map.of("sourceId", "S")),
				this.service.remove(null, 1))) {
			assertFalse((Boolean) denied.get("ok"));
			assertEquals("unauthenticated", denied.get("reason"));
		}

		// 비-Z(R·D) → forbidden.
		for (String userId : List.of("rc-r", "rc-d")) {
			String token = this.guard.createSession(userId);
			assertEquals("forbidden", this.service.query(token, Map.of()).get("reason"), userId);
			assertEquals("forbidden", this.service.create(token, Map.of("sourceId", "S")).get("reason"), userId);
			assertEquals("forbidden", this.service.remove(token, 1).get("reason"), userId);
		}
	}

	// --- query: SAFE_FIELDS 투영 + 시크릿 미노출 ------------------------------------------------

	@Test
	@SuppressWarnings("unchecked")
	void queryProjectsSafeFieldsOnlyAndNeverLeaksSecrets() {
		this.configs.insert(row("sourceId", "S1", "type", "ftp", "name", "한글", "host", "h",
				"port", "21", "username", "u", "password", "SECRET-PW", "apiEndpoint", "e",
				"apiKey", "SECRET-KEY", "active", "Y"));

		Map<String, Object> result = this.service.query(this.guard.createSession("rc-z"), Map.of());
		assertTrue((Boolean) result.get("ok"));
		List<Map<String, Object>> items = (List<Map<String, Object>>) result.get("items");
		assertEquals(1, items.size());

		Map<String, Object> only = items.get(0);
		assertEquals(SAFE_FIELDS, List.copyOf(only.keySet()), "정확 10키를 SAFE_FIELDS 순서로 담는다");
		assertFalse(only.containsKey("password"), "password는 어떤 응답에도 없다");
		assertFalse(only.containsKey("apiKey"), "apiKey는 어떤 응답에도 없다");
		assertEquals("한글", only.get("name"));
		assertEquals("u", only.get("username"), "username은 노출 유지(시크릿 아님)");
		assertNull(only.get("createdAt"), "receiver-config는 createdAt을 stamp하지 않아 null이다");
	}

	@Test
	@SuppressWarnings("unchecked")
	void queryKeepsSafeFieldKeysEvenWhenValuesAreNull() {
		this.configs.insert(row("sourceId", "S1", "name", "minimal"));

		Map<String, Object> result = this.service.query(this.guard.createSession("rc-z"), Map.of());
		Map<String, Object> only = ((List<Map<String, Object>>) result.get("items")).get(0);
		assertEquals(SAFE_FIELDS, List.copyOf(only.keySet()), "값이 null이어도 키는 남는다(키 없음과 null은 다르다)");
		assertNull(only.get("host"));
	}

	@Test
	@SuppressWarnings("unchecked")
	void filterWhitelistIncludesSecretsDefectCandidate3() {
		// 결함 후보 #3: FILTERABLE이 password·apiKey를 포함해 그 키의 필터가 적용된다(무시가 아니다).
		// 여기서 고치지 않는다(Node 동형). 서비스가 필터를 모델로 그대로 넘기는지 관측한다.
		this.configs.insert(row("sourceId", "S1", "name", "a", "password", "pw-1"));
		this.configs.insert(row("sourceId", "S2", "name", "b", "password", "pw-2"));

		String token = this.guard.createSession("rc-z");
		List<Map<String, Object>> hit = (List<Map<String, Object>>)
				this.service.query(token, Map.of("password", "pw-1")).get("items");
		assertEquals(1, hit.size(), "password 필터가 적용된다 — 결함 후보 #3(값 확인 오라클)");
		assertEquals("S1", hit.get(0).get("sourceId"));
	}

	// --- create: 검증 없음 · createdAt 미stamp · 시크릿 미반향 -----------------------------------

	@Test
	void createSucceedsForAdminWithoutInputValidationAndReturnsOnlyOkAndId() {
		// type/sourceId 미검증 — 게이트 통과 시 항상 성공(현행 계약 재현).
		Map<String, Object> result = this.service.create(this.guard.createSession("rc-z"),
				row("sourceId", "S1", "password", "SECRET", "apiKey", "KEY"));

		assertEquals(List.of("ok", "id"), List.copyOf(result.keySet()), "create 응답은 정확 {ok,id} 2키다");
		assertTrue((Boolean) result.get("ok"));
		assertEquals(1L, result.get("id"));
		assertFalse(result.containsKey("password"), "시크릿은 반향되지 않는다");
	}

	@Test
	@SuppressWarnings("unchecked")
	void createDoesNotStampCreatedAt() {
		this.service.create(this.guard.createSession("rc-z"), row("sourceId", "S1", "name", "a"));

		// 저장 후 되읽어도 createdAt은 null이다(Node는 요청 body를 그대로 넣고 createdAt을 채우지 않는다).
		Map<String, Object> stored = ((List<Map<String, Object>>)
				this.service.query(this.guard.createSession("rc-z"), Map.of()).get("items")).get(0);
		assertNull(stored.get("createdAt"), "createdAt 미stamp — 계약 createdAtNull:true");
	}

	// --- remove: 위임 · 없는 id·NaN → changes:0 -----------------------------------------------

	@Test
	void removeDelegatesToRepositoryAndReturnsChanges() {
		this.configs.insert(row("sourceId", "S1", "name", "a"));
		String token = this.guard.createSession("rc-z");

		Map<String, Object> ok = this.service.remove(token, 1);
		assertEquals(List.of("ok", "changes"), List.copyOf(ok.keySet()), "remove 응답은 정확 {ok,changes} 2키다");
		assertEquals(1, ok.get("changes"));

		assertEquals(0, this.service.remove(token, 1).get("changes"), "재삭제 멱등");
		assertEquals(0, this.service.remove(token, 999).get("changes"), "없는 id");
		assertEquals(0, this.service.remove(token, Double.NaN).get("changes"), "NaN id → changes:0");
	}

	// --- 헬퍼 ---------------------------------------------------------------------------------

	private static void insertUser(UserRepository users, String userId, String role) {
		Map<String, Object> row = new LinkedHashMap<>();
		row.put("userId", userId);
		row.put("name", userId);
		row.put("password", "$2a$10$hashhashhashhashhashha");
		row.put("role", role);
		row.put("active", "Y");
		users.insert(row);
	}

	private static Map<String, Object> row(Object... keyValues) {
		Map<String, Object> map = new LinkedHashMap<>();
		for (int i = 0; i < keyValues.length; i += 2) {
			map.put((String) keyValues[i], keyValues[i + 1]);
		}
		return map;
	}
}
