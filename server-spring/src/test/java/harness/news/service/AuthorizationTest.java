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

	/** 세션 유휴 만료 경계를 왕복하는 seam — 비연장 peek는 이것 없이 관측할 수 없다. */
	private MutableClock sessionClock;

	@BeforeEach
	void setUp() {
		TempNewsDb.seed(this.tempDir);
		this.dataSource = NewsDataSource.create(this.tempDir);
		this.users = new UserRepository(JdbcClient.create(this.dataSource));
		this.articles = new ArticleRepository(JdbcClient.create(this.dataSource),
				new TransactionTemplate(new JdbcTransactionManager(this.dataSource)),
				Clock.fixed(Instant.parse("2026-08-20T12:34:56.789Z"), ZoneOffset.UTC));
		this.sessionClock = new MutableClock(1_700_000_000_000L);
		this.guard = new SessionGuard(new SessionStore(this.sessionClock), this.users);
		this.authorization = new Authorization(this.guard, this.articles);
		insert("gate-z", "Z");
		insert("gate-z2", "Z");
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

	// --- 비연장 판정(authorizePeek — SSE push 전용) -------------------------------------------------

	/**
	 * <b>{@code authorize}는 세션을 연장하고 {@code authorizePeek}는 연장하지 않는다.</b>
	 *
	 * <p>실측 근거(2026-08-30): {@link Authorization#authorize}와 {@code editDps}는
	 * {@code sessions.touchSession(...)}을 쓴다 — 실제 요청 경로에서는 그것이 정상이지만
	 * <b>SSE push마다</b> 부르면 열린 스트림 하나가 1시간 유휴 만료를 무한히 밀어낸다
	 * (ADR-005·ADR-007이 닫은 자리이며 <b>계약이 관측할 수 없는 축</b>이다 — 하네스는 시계를 주입하지 못한다).
	 * 그래서 push 경로는 {@code peekSession}을 쓰는 이 메서드만 쓴다.
	 */
	@Test
	void authorizePeekDoesNotExtendTheSessionWhileAuthorizeDoes() {
		long oneHourMs = 60L * 60L * 1000L;
		String touched = this.guard.createSession("gate-z");
		String peeked = this.guard.createSession("gate-z2"); // 단일 세션 정책 — 계정을 분리한다.

		this.sessionClock.advance(oneHourMs - 60_000L); // 만료 1분 전.
		assertTrue(this.authorization.authorize(touched, Authorization.VIEW_LOGS).ok());
		assertTrue(this.authorization.authorizePeek(peeked, Authorization.VIEW_LOGS).ok());
		this.sessionClock.advance(2 * 60_000L); // 원래 만료 시각을 넘겼다.

		assertTrue(this.authorization.authorize(touched, Authorization.VIEW_LOGS).ok(),
				"authorize는 세션을 연장한다(일반 요청 경로의 슬라이딩 갱신)");
		assertEquals("unauthenticated", this.authorization.authorizePeek(peeked, Authorization.VIEW_LOGS).reason(),
				"authorizePeek이 세션을 연장했다 — 열린 SSE 스트림이 유휴 만료를 무한 연장하게 된다");
	}

	/**
	 * <b>같은 (role, capability)에 대해 두 메서드의 판정이 항상 같다</b> — 역할 표가 한 출처임의 잠금이다.
	 * 판정을 복제하면(예: 호출부에서 {@code "Z"} 문자열 비교) 한쪽만 고쳐도 조용히 갈린다.
	 */
	@Test
	void theTwoGatesAgreeOnEveryRoleAndCapability() {
		for (String userId : List.of("gate-z", "gate-r", "gate-d")) {
			for (String capability : List.of(Authorization.MANAGE_USERS, Authorization.VIEW_LOGS,
					Authorization.EDIT_DPS, Authorization.MANAGE_DISTRIBUTION_TARGET, "manageEverything")) {
				Authorization.Decision extending =
						this.authorization.authorize(this.guard.createSession(userId), capability);
				Authorization.Decision peeking =
						this.authorization.authorizePeek(this.guard.createSession(userId), capability);

				assertEquals(extending.ok(), peeking.ok(), userId + "/" + capability + " 판정이 갈렸다");
				assertEquals(extending.reason(), peeking.reason(),
						userId + "/" + capability + " 사유 토큰이 갈렸다 — 두 메서드는 같은 CAPABILITIES 표를 쓴다");
			}
		}
	}

	/** 세션 검증이 먼저라는 순서도 같다 — 미인증에는 capability 존재 여부조차 알려주지 않는다. */
	@Test
	void authorizePeekRejectsMissingAndUnknownTokensLikeAuthorize() {
		String unknown = "0".repeat(64);

		assertEquals("unauthenticated", this.authorization.authorizePeek(null, Authorization.VIEW_LOGS).reason());
		assertEquals("unauthenticated", this.authorization.authorizePeek(unknown, Authorization.VIEW_LOGS).reason());
		assertEquals("unauthenticated", this.authorization.authorizePeek(null, "manageEverything").reason());
	}

	/** 강등·비활성은 peek 경로에서도 <b>재로그인 없이</b> 즉시 반영된다(ADR-004 재도출). */
	@Test
	void authorizePeekRederivesTheRoleOnEveryCall() {
		String sessionId = this.guard.createSession("gate-z");
		assertTrue(this.authorization.authorizePeek(sessionId, Authorization.VIEW_LOGS).ok());

		this.users.update("gate-z", Map.of("role", "D")); // 재로그인 없음.

		assertEquals("forbidden", this.authorization.authorizePeek(sessionId, Authorization.VIEW_LOGS).reason(),
				"강등된 계정의 열린 스트림이 로그를 계속 받으면 ADR-007의 Z 전용 봉인이 시간축에서 깨진다");
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

	/**
	 * phase 74 step6 작업 G-4 — 이 phase가 손댄 소스에 <b>JDK 25 신규 표면</b>이 0건임을 잠근다.
	 *
	 * <p>이 파일은 이 phase가 {@code authorizePeek} 1메서드를 순수 추가한 자리이고, SSE의 push 경로가
	 * 매 프레임마다 부르는 유일한 서비스층 진입점이다. {@code Adr008DisciplineTest}가 main 소스 전역을
	 * 스캔하지만 그 5군 패턴은 <b>JDK 21 API 표면 기준</b>으로 작성돼 {@code StructuredTaskScope}·
	 * {@code ScopedValue}·{@code Subtask}가 <b>0건</b>이다(2026-08-31 실측: {@code ScopedValue} 실사용을
	 * 심어도 그 게이트는 green이었다 — 우회로다). 게이트 파일은 이 phase가 0줄 고치기로 못 박았으므로
	 * (확장은 별도 ADR·리뷰가 필요하다) 여기서 이 파일에 대해서만 막는다 —
	 * {@code SseHttpTest}·{@code StreamWireTest}·{@code LogsStreamWireTest}·{@code ChangeBusTest}·
	 * {@code LogServiceTest}가 자기 소스에 대해 같은 스캔을 이미 걸어 뒀고 이 파일만 빠져 있었다.
	 *
	 * <p>판정 전에 주석을 지운다 — 규칙을 <b>설명하는</b> 이 javadoc이 위반으로 잡히면 규칙을 문서화할 수 없다.
	 */
	@Test
	void theAuthorizationSourceUsesNoJdk25ConcurrencySurface() throws java.io.IOException {
		Path source = Path.of("src/main/java/harness/news/service/Authorization.java");
		assertTrue(java.nio.file.Files.isRegularFile(source),
				"인가 게이트 소스를 찾지 못했다 — 스캔이 공허해진다");
		String code = java.nio.file.Files.readString(source, java.nio.charset.StandardCharsets.UTF_8)
				.replaceAll("(?s)/\\*.*?\\*/", " ")
				.replaceAll("(?m)//.*$", " ");

		for (String forbidden : List.of("StructuredTaskScope", "ScopedValue", "Subtask",
				"ExecutorService", "Executors.", "new Thread(", "startVirtualThread", "CompletableFuture")) {
			assertFalse(code.contains(forbidden),
					"ADR-008 · ADR-015: 인가 판정은 호출 스레드에서 동기로 끝난다 — 금지 철자가 있다: " + forbidden);
		}
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
