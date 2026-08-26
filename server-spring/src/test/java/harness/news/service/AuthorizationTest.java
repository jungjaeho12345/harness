package harness.news.service;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.zaxxer.hikari.HikariDataSource;
import harness.news.db.NewsDataSource;
import harness.news.model.ArticleRepository;
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

	private ArticleRepository articles;

	private SessionGuard guard;

	private Authorization authorization;

	@BeforeEach
	void setUp() {
		TempNewsDb.seed(this.tempDir);
		this.dataSource = NewsDataSource.create(this.tempDir);
		this.users = new UserRepository(JdbcClient.create(this.dataSource));
		this.articles = new ArticleRepository(JdbcClient.create(this.dataSource),
				new TransactionTemplate(new JdbcTransactionManager(this.dataSource)),
				Clock.fixed(Instant.parse("2026-08-20T12:34:56.789Z"), ZoneOffset.UTC));
		this.guard = new SessionGuard(new SessionStore(new MutableClock(1_700_000_000_000L)), this.users);
		this.authorization = new Authorization(this.guard, this.articles);
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
		// 이 phase가 쓰는 행은 둘이고 표 구조는 Node와 동형이다(후속 phase는 행만 추가한다).
		assertEquals(List.of("Z"), Authorization.CAPABILITIES.get(Authorization.MANAGE_USERS),
				"사용자 관리는 Z 전용이다(src/services/authorization.js CAPABILITIES)");
		// Node는 이 판정을 라우트 안에서 me.role !== 'Z'로 직접 한다(server/index.js 1168~1175).
		// 관측(미인증 401 · 비-Z 403)은 같고, 판정 자리를 표로 모아 감사 가능하게 만든 것이 차이다.
		assertEquals(List.of("Z"), Authorization.CAPABILITIES.get(Authorization.VIEW_LOGS),
				"로그 열람은 Z 전용이다 — 로그는 전 사용자의 요청 흔적이다(ADR-007)");
		// phase 69 step8이 추가한 행 — DPS 기사의 고침/포털고침 진입은 D <b>하나</b>다.
		// Z를 넣으면 권한 모델이 갈라진다(news.md 권한 규칙 · src/services/authorization.js).
		assertEquals(List.of("D"), Authorization.CAPABILITIES.get(Authorization.EDIT_DPS),
				"DPS 편집 진입은 D 전용이다(Z도 포함하지 않는다)");
		// phase 72 step9가 추가한 두 행 — 배부 실행 3라우트의 게이트다(ADR-008).
		// 외부 운영 cron도 **Z 세션**으로 호출한다(API 키·공유 시크릿 없음).
		assertEquals(List.of("Z"), Authorization.CAPABILITIES.get(Authorization.RUN_DISTRIBUTION_TICK),
				"시점 배부 실행은 Z 전용이다(src/services/authorization.js runDistributionTick)");
		assertEquals(List.of("Z"), Authorization.CAPABILITIES.get(Authorization.MANAGE_DISTRIBUTION_FAILURE),
				"배부 실패 조회·재전송은 Z 전용이다 — 재전송은 외부로 파일을 내보내는 행위다");
	}

	// --- DPS 편집 진입 게이트(editDps) -------------------------------------------------------------

	@Test
	void editingADpsArticleIsAllowedForTheDeskOnly() {
		seedArticle("gate-dps", "DPS");

		assertTrue(this.authorization.editDps(this.guard.createSession("gate-d"), "gate-dps", "revise").ok(),
				"D는 DPS 기사의 고침 진입을 얻는다");
		assertTrue(this.authorization.editDps(this.guard.createSession("gate-d"), "gate-dps", "portalRevise").ok(),
				"포털고침도 같은 capability다");
		for (String userId : List.of("gate-r", "gate-z")) {
			Authorization.Decision decision =
					this.authorization.editDps(this.guard.createSession(userId), "gate-dps", "revise");

			assertFalse(decision.ok(), userId + "는 D가 아니다");
			assertEquals("forbidden", decision.reason(), "Z에게도 DPS 편집 진입을 열지 않는다");
		}
	}

	@Test
	void aNonDpsArticleAnswersNotDpsWhichTheLockRouteTreatsAsAPass() {
		seedArticle("gate-rds", "RDS");

		Authorization.Decision decision =
				this.authorization.editDps(this.guard.createSession("gate-r"), "gate-rds", "revise");

		assertFalse(decision.ok(), "게이트 자체는 통과가 아니다");
		assertEquals("not-dps", decision.reason(),
				"not-dps는 '이 게이트의 대상이 아니다'라는 신호다 — 라우트가 통과로 해석한다");
	}

	@Test
	void theGateOrderIsSessionThenActionThenExistenceThenStatusThenRole() {
		seedArticle("gate-dps", "DPS");
		String reporter = this.guard.createSession("gate-r");

		// (1) 세션이 먼저다 — 미인증에는 기사 존재 여부조차 알려주지 않는다.
		assertEquals("unauthenticated", this.authorization.editDps(null, "gate-dps", "revise").reason());
		// (2) 액션 어휘가 존재 검사보다 앞이다(정본 순서 그대로).
		assertEquals("unknown-action", this.authorization.editDps(reporter, "없는-기사", "send").reason());
		// (3) 존재가 상태·역할보다 앞이다 — 없는 기사는 403이 아니라 404로 수렴한다.
		assertEquals("not-found", this.authorization.editDps(reporter, "없는-기사", "revise").reason());
		// (4) 상태가 역할보다 앞이다 — 비-DPS면 R에게도 forbidden이 아니라 not-dps다.
		seedArticle("gate-rds", "RDS");
		assertEquals("not-dps", this.authorization.editDps(reporter, "gate-rds", "revise").reason());
		// (5) 마지막이 역할이다.
		assertEquals("forbidden", this.authorization.editDps(reporter, "gate-dps", "revise").reason());
	}

	@Test
	void anArticleRowWithoutContentsIsNotFound() {
		// Article 행만 있고 Contents 행이 없는 기사는 '없는 기사'다(정본 !row || !row.contents).
		// 리포지토리는 두 행을 함께 만들므로 이 상태는 임시 DB에 직접 넣는다(테스트 픽스처 전용 INSERT).
		TempNewsDb.exec(TempNewsDb.dbFile(this.tempDir),
				"INSERT INTO Article (articleId, title) VALUES ('gate-orphan', '제목만 있는 행')");

		assertEquals("not-found",
				this.authorization.editDps(this.guard.createSession("gate-d"), "gate-orphan", "revise").reason());
	}

	@Test
	void editDpsRoleComesFromTheSessionSoADemotionAppliesImmediately() {
		seedArticle("gate-dps", "DPS");
		String sessionId = this.guard.createSession("gate-d");
		assertTrue(this.authorization.editDps(sessionId, "gate-dps", "revise").ok());

		this.users.update("gate-d", Map.of("role", "R")); // 재로그인 없음.

		assertEquals("forbidden", this.authorization.editDps(sessionId, "gate-dps", "revise").reason(),
				"강등된 계정의 기존 세션이 DPS 편집 진입을 유지하면 권한 상승이다");
	}

	private void seedArticle(String articleId, String status) {
		this.articles.insert(Map.of("articleId", articleId, "title", "게이트 픽스처"),
				Map.of("articleId", articleId, "title", "게이트 픽스처", "status", status));
	}

	@Test
	void nonAdminSessionsCannotViewLogs() {
		for (String userId : List.of("gate-r", "gate-d")) {
			Authorization.Decision decision =
					this.authorization.authorize(this.guard.createSession(userId), Authorization.VIEW_LOGS);

			assertFalse(decision.ok(), userId + "는 Z가 아니다");
			assertEquals("forbidden", decision.reason());
		}
		assertTrue(this.authorization.authorize(this.guard.createSession("gate-z"), Authorization.VIEW_LOGS).ok());
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
