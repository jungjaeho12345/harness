package harness.news.service;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.zaxxer.hikari.HikariDataSource;
import harness.news.db.NewsDataSource;
import harness.news.model.UserRepository;
import harness.news.testsupport.MutableClock;
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
 * 인가(capability) 게이트 — 리포 루트 {@code src/services/authorization.js}와 동형.
 *
 * <p><b>이 클래스가 지키는 한 문장:</b> acting role은 <b>검증된 세션</b>에서만 나온다(ADR-004).
 * 게이트는 role을 파라미터로 받지 않으므로 요청 본문·헤더의 {@code role}이 판정에 닿을 방법이
 * 구조적으로 없다 — "누구나 Z가 되는" 권한 상승의 원천 차단이다.
 *
 * <p>그리고 role은 <b>매 판정마다 재도출</b>된 신원에서 읽는다(가드 경유) — 그래서 강등된 계정의
 * 기존 세션이 재로그인 없이 즉시 거부된다({@code session-guard.contract.js}의 축).
 */
class AuthorizationTest {

	@TempDir
	Path tempDir;

	private HikariDataSource dataSource;

	private UserRepository users;

	private SessionGuard guard;

	private Authorization authorization;

	@BeforeEach
	void setUp() {
		TempNewsDb.seed(this.tempDir);
		this.dataSource = NewsDataSource.create(this.tempDir);
		this.users = new UserRepository(JdbcClient.create(this.dataSource));
		this.guard = new SessionGuard(new SessionStore(new MutableClock(1_700_000_000_000L)), this.users);
		this.authorization = new Authorization(this.guard);
		insert("gate-z", "Z");
		insert("gate-r", "R");
		insert("gate-d", "D");
	}

	@AfterEach
	void tearDown() {
		if (this.dataSource != null) {
			this.dataSource.close();
		}
	}

	// --- capability 표 ---------------------------------------------------------------------------

	@Test
	void theCapabilityTableIsShapedLikeNode() {
		// 이 phase가 쓰는 행은 하나지만 표 구조는 Node와 동형이다(후속 phase는 행만 추가한다).
		assertEquals(List.of("Z"), Authorization.CAPABILITIES.get(Authorization.MANAGE_USERS),
				"사용자 관리는 Z 전용이다(src/services/authorization.js CAPABILITIES)");
	}

	@Test
	void undefinedCapabilitiesAreRejectedEvenForAnAdminSession() {
		String sessionId = this.guard.createSession("gate-z");

		Authorization.Decision decision = this.authorization.authorize(sessionId, "manageEverything");

		assertFalse(decision.ok());
		assertEquals("unknown-capability", decision.reason(),
				"표에 없는 capability는 통과가 아니라 거부다(기본값이 허용이면 오타 한 번이 게이트를 연다)");
	}

	// --- 세션에서만 도출되는 role ------------------------------------------------------------------

	@Test
	void adminSessionPassesTheManageUsersGate() {
		Authorization.Decision decision =
				this.authorization.authorize(this.guard.createSession("gate-z"), Authorization.MANAGE_USERS);

		assertTrue(decision.ok());
		assertNull(decision.reason());
	}

	@Test
	void nonAdminSessionsAreForbidden() {
		for (String userId : List.of("gate-r", "gate-d")) {
			Authorization.Decision decision =
					this.authorization.authorize(this.guard.createSession(userId), Authorization.MANAGE_USERS);

			assertFalse(decision.ok(), userId + "는 Z가 아니다");
			assertEquals("forbidden", decision.reason());
		}
	}

	@Test
	void missingOrUnknownTokensAreUnauthenticated() {
		String unknown = "0".repeat(64);

		assertEquals("unauthenticated",
				this.authorization.authorize(null, Authorization.MANAGE_USERS).reason());
		assertEquals("unauthenticated",
				this.authorization.authorize(unknown, Authorization.MANAGE_USERS).reason());
	}

	@Test
	void unknownCapabilityDoesNotLeakAheadOfTheSessionCheck() {
		// Node manageUsers는 세션 검증이 먼저다 — 미인증에는 capability 존재 여부를 알려주지 않는다.
		assertEquals("unauthenticated", this.authorization.authorize(null, "manageEverything").reason());
	}

	// --- 재도출(ADR-004) -------------------------------------------------------------------------

	@Test
	void roleDemotionIsAppliedToAnExistingTokenWithoutReLogin() {
		String sessionId = this.guard.createSession("gate-z");
		assertTrue(this.authorization.authorize(sessionId, Authorization.MANAGE_USERS).ok());

		this.users.update("gate-z", Map.of("role", "R")); // 재로그인 없음 — 같은 토큰을 계속 쓴다.

		Authorization.Decision after = this.authorization.authorize(sessionId, Authorization.MANAGE_USERS);
		assertFalse(after.ok(), "강등된 계정의 기존 세션이 통과하면 권한 상승이다");
		assertEquals("forbidden", after.reason());
	}

	@Test
	void deactivationMakesTheSessionUnauthenticatedNotForbidden() {
		String sessionId = this.guard.createSession("gate-z");

		this.users.update("gate-z", Map.of("active", "N")); // 행은 남는다(DB 비파괴).

		Authorization.Decision after = this.authorization.authorize(sessionId, Authorization.MANAGE_USERS);
		assertEquals("unauthenticated", after.reason(),
				"비활성화는 세션 자체를 무효화한다(역할 문제가 아니다)");
	}

	private void insert(String userId, String role) {
		Map<String, Object> row = new LinkedHashMap<>();
		row.put("userId", userId);
		row.put("name", userId);
		row.put("password", "$2a$10$hashhashhashhashhashha");
		row.put("role", role);
		row.put("active", "Y");
		this.users.insert(row);
	}
}
