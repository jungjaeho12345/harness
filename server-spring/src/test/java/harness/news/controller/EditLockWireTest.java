package harness.news.controller;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import harness.news.model.ArticleAggregate;
import harness.news.model.ArticleRepository;
import harness.news.model.ContentsRow;
import harness.news.service.UserService;
import harness.news.testsupport.MutableClock;
import harness.news.testsupport.TempNewsDb;
import harness.news.testsupport.Wire;
import java.nio.file.Path;
import java.time.Clock;
import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.context.TestConfiguration;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Primary;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;

/**
 * 편집 잠금 3라우트의 <b>와이어</b> 계약 — {@code POST /api/articles/:id/lock} ·
 * {@code .../unlock} · {@code .../force-unlock}.
 *
 * <p>계약 케이스({@code contract/cases/default/articles-write.contract.js} 190~310행 ·
 * 420~536행)의 단언을 <b>선반영</b>한다: 그 파일은 송고({@code POST .../action})까지 있어야 green이
 * 되므로(index.json order (a)) 이 step의 판정은 여기 있다. Node 대조 리포트 실측과 1:1이다.
 *
 * <pre>
 * lock         200 {"ok":true}                       ← 정확히 1키(보유자 정보 없음)
 *              401 {"ok":false,"reason":"locked"}     ← 423도 409도 아니다
 *              403 forbidden(DPS + 비-D) · 404 not-found
 * unlock       200 {"ok":true} (이미 해제됐어도 200 — 멱등) · 403 not-holder · 404 not-found
 * force-unlock 200 {"ok":true} · 403 forbidden(R) · 404 not-found(<b>역할 게이트 통과 후</b>)
 * </pre>
 *
 * <h2>게이트 순서가 이 클래스의 주제다(index.json decisions (12))</h2>
 * <ul>
 *   <li>lock — 존재(404) → DPS면 역할(403) → 잠금 충돌(401). DPS 기사가 이미 잠겨 있어도 비-D에게는
 *       401이 아니라 <b>403</b>이다(역할 판정이 먼저다).</li>
 *   <li>unlock — 존재(404) → 보유자(403) → 멱등 200.</li>
 *   <li>force-unlock — <b>역할(403) → 존재(404)</b>. 순서가 반대라 R은 없는 기사에도 403이다.</li>
 * </ul>
 *
 * <h2>거부는 아무것도 바꾸지 않는다</h2>
 * 거부된 잠금·해제·강제 해제 뒤에 잠금 5컬럼을 되읽어 상태가 그대로임을 단언한다(DB 비파괴 축).
 * 응답 투영이 지우는 {@code lockerSessionId}·{@code lockerClientId}는 리포지토리로 직접 읽는다 —
 * HTTP로는 볼 수 없는 컬럼이라 "해제가 5컬럼을 전부 비웠다"는 사실의 유일한 관측 지점이다.
 *
 * <p>DPS 픽스처는 리포지토리로 상태를 세팅한다({@code POST .../action}은 step10이다). DB는 이 클래스
 * 전용 임시 사본이며 리포 {@code news.db}는 열지 않는다.
 */
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
class EditLockWireTest {

	private static final Path DATA_DIR = TempNewsDb.newDataDir("edit-lock-wire");

	private static final Pattern SESSION_ID = Pattern.compile("\"sessionId\":\"([0-9a-f]{64})\"");

	private static final Pattern CREATED = Pattern.compile("^\\{\"ok\":true,\"articleId\":\"(AKR\\d{8}\\d{9})\"\\}$");

	private static final String PASSWORD = "edit-lock-pw-1";

	private static final String JSON_CONTENT_TYPE = "Content-Type: application/json; charset=utf-8";

	/** 잠금·해제 성공 응답의 <b>전부</b> — 보유자 정보가 들어갈 자리가 없다. */
	private static final String OK_ONLY = "{\"ok\":true}";

	private static final String LOCKED = "{\"ok\":false,\"reason\":\"locked\"}";

	private static final String NOT_HOLDER = "{\"ok\":false,\"reason\":\"not-holder\"}";

	private static final String NOT_FOUND = "{\"ok\":false,\"reason\":\"not-found\"}";

	private static final String FORBIDDEN = "{\"ok\":false,\"reason\":\"forbidden\"}";

	private static final String UNAUTHENTICATED = "{\"ok\":false,\"reason\":\"unauthenticated\"}";

	private static final String NO_SUCH_ARTICLE = "AKR19700101000000000";

	/** 해제가 비워야 하는 잠금 컬럼 5개(그중 둘은 응답 투영에 없어 리포지토리로만 보인다). */
	private static final List<String> LOCK_COLUMNS =
			List.of("lockYN", "lockerUserId", "lockerSessionId", "lockerClientId", "lockedAt");

	/** 로그인 IP 레이트리밋(15분/10회) 예산을 테스트마다 리셋하기 위한 창 길이. */
	private static final long RATE_LIMIT_WINDOW_MS = 15L * 60L * 1000L;

	private static final MutableClock CLOCK = new MutableClock(Instant.parse("2026-08-20T00:00:00Z").toEpochMilli());

	@TestConfiguration
	static class MutableClockConfig {

		@Bean
		@Primary
		Clock mutableClock() {
			return CLOCK;
		}

	}

	@DynamicPropertySource
	static void dataDir(DynamicPropertyRegistry registry) {
		registry.add("app.data-dir", () -> DATA_DIR.toAbsolutePath().toString());
	}

	@Value("${local.server.port}")
	private int port;

	/** 픽스처 계정 생성 전용(테스트 대상은 HTTP 경로다). */
	@Autowired
	private UserService users;

	/** 잠금 컬럼 되읽기 + DPS 상태 픽스처 전용 — 송고 라우트는 step10이다. */
	@Autowired
	private ArticleRepository articles;

	@BeforeEach
	void freshLoginBudget() {
		CLOCK.advance(RATE_LIMIT_WINDOW_MS + 1);
	}

	@BeforeEach
	void seedFixtures() {
		ensureUser("el-r", "R", "기자하나", "사회부", "SOC");
		ensureUser("el-r2", "R", "기자둘", "사회부", "SOC");
		ensureUser("el-d", "D", "데스크하나", "정치부", "POL");
		ensureUser("el-z", "Z", "관리자하나", "편집국", "EDT");
	}

	// --- 1. lock 성공(응답 1키 · 보유자 표시는 되읽기에만) -----------------------------------------

	@Test
	void lockSucceedsAndTheResponseCarriesNothingButOkTrue() {
		String sessionId = login("el-r");
		String articleId = createArticle(sessionId);
		String tab = unique("tab");

		Wire.Response response = lock(sessionId, tab, articleId);

		assertEquals(200, response.status());
		assertEquals(OK_ONLY, response.body(), "잠금 성공 응답은 {ok:true} 뿐이다(보유자 정보 미노출)");
		assertEquals(JSON_CONTENT_TYPE, response.line("content-type"));
		assertFalse(response.body().contains(tab), "탭 식별자가 응답에 실렸다");
		assertFalse(response.body().contains(sessionId), "세션 토큰이 응답에 실렸다");

		String read = get(sessionId, articleId).body();
		assertTrue(read.contains("\"lockYN\":\"Y\""), "되읽기로 잠금이 확인된다: " + read);
		assertTrue(read.contains("\"lockerUserId\":\"el-r\""), "보유자 표시(UI 계약)는 유지된다");
		assertFalse(read.contains("\"lockedAt\":null"), "lockedAt이 stamp됐다");
		assertFalse(read.contains("lockerSessionId"), "세션 토큰 컬럼은 어떤 응답에도 없다");
		assertFalse(read.contains("lockerClientId"), "탭 식별자 컬럼은 어떤 응답에도 없다");

		ContentsRow row = contentsOf(articleId);
		assertEquals(tab, row.column("lockerClientId"), "보유 탭은 행에만 기록된다");
		assertEquals(sessionId, row.column("lockerSessionId"), "재로그인 takeover 판정의 재료다");
	}

	// --- 2. 재획득 200 · 다른 탭·다른 사용자는 401 locked -----------------------------------------

	@Test
	void sameTabReacquiresButAnotherTabOrUserGets401Locked() {
		String sessionId = login("el-r");
		String articleId = createArticle(sessionId);
		String tabA = unique("tab");
		String tabB = unique("tab");
		assertEquals(200, lock(sessionId, tabA, articleId).status());

		Wire.Response again = lock(sessionId, tabA, articleId);
		assertEquals(200, again.status(), "같은 탭 재획득(F5)은 200이다");
		assertEquals(OK_ONLY, again.body());

		Wire.Response otherTab = lock(sessionId, tabB, articleId);
		assertEquals(401, otherTab.status(), "잠금 충돌은 401이다(423도 409도 아니다)");
		assertEquals(LOCKED, otherTab.body(), "응답 키는 ok·reason 2개뿐이고 보유자를 밝히지 않는다");
		assertEquals(JSON_CONTENT_TYPE, otherTab.line("content-type"));

		Wire.Response otherUser = lock(login("el-d"), tabB, articleId);
		assertEquals(401, otherUser.status(), "다른 사용자도 같은 401 locked다");
		assertEquals(LOCKED, otherUser.body());

		ContentsRow row = contentsOf(articleId);
		assertEquals("Y", row.column("lockYN"), "거부된 잠금 시도는 기존 잠금을 건드리지 않는다");
		assertEquals("el-r", row.column("lockerUserId"));
		assertEquals(tabA, row.column("lockerClientId"), "보유 탭이 바뀌지 않았다");
	}

	// --- 3. lock 404 ------------------------------------------------------------------------------

	@Test
	void lockOfAnUnknownArticleIs404() {
		Wire.Response response = lock(login("el-r"), unique("tab"), NO_SUCH_ARTICLE);

		assertEquals(404, response.status());
		assertEquals(NOT_FOUND, response.body());
		assertEquals(JSON_CONTENT_TYPE, response.line("content-type"));
	}

	// --- 4. DPS 편집 진입 게이트(D 전용 — Z도 403) ------------------------------------------------

	@Test
	void enteringADpsArticleIsForDeskOnlyAndDoesNotChangeItsStatus() {
		String reporter = login("el-r");
		String articleId = createArticle(reporter);
		markSent(articleId);

		Wire.Response denied = lock(reporter, unique("tab"), articleId);
		assertEquals(403, denied.status(), "DPS 기사에 대한 R의 편집 진입은 403이다");
		assertEquals(FORBIDDEN, denied.body());
		assertEquals("N", contentsOf(articleId).column("lockYN"), "거부된 잠금 시도는 잠금을 만들지 않는다");

		Wire.Response admin = lock(login("el-z"), unique("tab"), articleId);
		assertEquals(403, admin.status(), "capability는 D 전용이다 — Z도 편집 진입은 못 한다");
		assertEquals(FORBIDDEN, admin.body());
		assertEquals("N", contentsOf(articleId).column("lockYN"));

		String desk = login("el-d");
		String tabD = unique("tab");
		Wire.Response revise = lock(desk, tabD, articleId);
		assertEquals(200, revise.status(), "D의 고침(revise) 진입");
		assertEquals(OK_ONLY, revise.body());
		assertEquals("DPS", contentsOf(articleId).column("status"), "잠금 획득은 상태 전이를 일으키지 않는다");

		Wire.Response portal = lockWithBody(desk, tabD, articleId, "{\"action\":\"portalRevise\"}");
		assertEquals(200, portal.status(), "포털고침 분기도 같은 게이트를 통과한다");
		assertEquals(OK_ONLY, portal.body());

		Wire.Response strange = lockWithBody(desk, tabD, articleId, "{\"action\":\"이런-액션은-없다\"}");
		assertEquals(200, strange.status(), "정의 밖 action은 400이 아니라 revise로 취급된다");
		assertEquals(OK_ONLY, strange.body());
	}

	@Test
	void theRoleGateOnADpsArticleComesBeforeTheLockConflict() {
		String reporter = login("el-r");
		String articleId = createArticle(reporter);
		markSent(articleId);
		assertEquals(200, lock(login("el-d"), unique("tab"), articleId).status());

		Wire.Response response = lock(reporter, unique("tab"), articleId);

		assertEquals(403, response.status(), "이미 잠긴 DPS 기사여도 비-D에게는 401이 아니라 403이다");
		assertEquals(FORBIDDEN, response.body());
	}

	// --- 5. unlock 200 + 5컬럼 비움 + 멱등 --------------------------------------------------------

	@Test
	void unlockClearsAllFiveLockColumnsAndRepeatingItIsStill200() {
		String sessionId = login("el-r");
		String articleId = createArticle(sessionId);
		String tab = unique("tab");
		assertEquals(200, lock(sessionId, tab, articleId).status());

		Wire.Response response = unlock(sessionId, tab, articleId);

		assertEquals(200, response.status());
		assertEquals(OK_ONLY, response.body());
		assertEquals(JSON_CONTENT_TYPE, response.line("content-type"));
		assertUnlocked(articleId);

		String read = get(sessionId, articleId).body();
		assertTrue(read.contains("\"lockYN\":\"N\""), "되읽기로 해제가 확인된다: " + read);
		assertTrue(read.contains("\"lockerUserId\":null"), "해제는 보유자 표시도 지운다");
		assertTrue(read.contains("\"lockedAt\":null"));

		Wire.Response again = unlock(sessionId, tab, articleId);
		assertEquals(200, again.status(), "탭 닫기·pagehide의 중복 호출은 멱등이다(거부가 아니다)");
		assertEquals(OK_ONLY, again.body());
	}

	// --- 6. unlock 403(탭 사칭·다른 탭) — 잠금은 유지된다 -----------------------------------------

	@Test
	void unlockIsDeniedForAStolenTabAndForAnotherTabOfTheSameUser() {
		String sessionId = login("el-r");
		String articleId = createArticle(sessionId);
		String tabA = unique("tab");
		String tabB = unique("tab");
		assertEquals(200, lock(sessionId, tabA, articleId).status());

		Wire.Response stolen = unlock(login("el-d"), tabA, articleId);
		assertEquals(403, stolen.status(), "남의 탭 문자열을 그대로 흉내내도 세션 신원이 다르면 거부된다");
		assertEquals(NOT_HOLDER, stolen.body());

		Wire.Response otherTab = unlock(sessionId, tabB, articleId);
		assertEquals(403, otherTab.status(), "같은 사용자여도 보유 탭이 아니면 해제할 수 없다");
		assertEquals(NOT_HOLDER, otherTab.body());

		Wire.Response noHeader = Wire.json(this.port, "POST", "/api/articles/" + articleId + "/unlock",
				Map.of("x-session-id", sessionId), "{}");
		assertEquals(403, noHeader.status(), "탭 헤더 부재를 빈 문자열로 정규화하면 인가 구멍이 열린다");
		assertEquals(NOT_HOLDER, noHeader.body());

		ContentsRow row = contentsOf(articleId);
		assertEquals("Y", row.column("lockYN"), "거부된 해제는 잠금을 풀지 않는다");
		assertEquals("el-r", row.column("lockerUserId"));
		assertEquals(tabA, row.column("lockerClientId"));
	}

	// --- 7. unlock 404 ----------------------------------------------------------------------------

	@Test
	void unlockOfAnUnknownArticleIs404() {
		Wire.Response response = unlock(login("el-r"), unique("tab"), NO_SUCH_ARTICLE);

		assertEquals(404, response.status());
		assertEquals(NOT_FOUND, response.body());
	}

	// --- 8. force-unlock(R 403 · D 200 · 잠기지 않아도 200 · 404는 역할 게이트 뒤) -----------------

	@Test
	void forceUnlockIsDeskOnlyAndReleasesAnotherUsersLock() {
		String sessionId = login("el-r");
		String articleId = createArticle(sessionId);
		String tab = unique("tab");
		assertEquals(200, lock(sessionId, tab, articleId).status());

		Wire.Response denied = forceUnlock(sessionId, articleId);
		assertEquals(403, denied.status(), "강제 해제는 D/Z 전용이다");
		assertEquals(FORBIDDEN, denied.body());
		assertEquals("Y", contentsOf(articleId).column("lockYN"), "거부된 강제 해제는 잠금을 유지한다");
		assertEquals(tab, contentsOf(articleId).column("lockerClientId"));

		Wire.Response forced = forceUnlock(login("el-d"), articleId);
		assertEquals(200, forced.status());
		assertEquals(OK_ONLY, forced.body());
		assertEquals(JSON_CONTENT_TYPE, forced.line("content-type"));
		assertUnlocked(articleId);

		Wire.Response again = forceUnlock(login("el-z"), articleId);
		assertEquals(200, again.status(), "잠겨 있지 않은 기사도 200이다(존재만 확인한다)");
		assertEquals(OK_ONLY, again.body());
	}

	@Test
	void forceUnlockChecksTheRoleBeforeItChecksExistence() {
		Wire.Response desk = forceUnlock(login("el-d"), NO_SUCH_ARTICLE);
		assertEquals(404, desk.status(), "권한 게이트를 통과한 뒤에 존재 검사다");
		assertEquals(NOT_FOUND, desk.body());

		Wire.Response reporter = forceUnlock(login("el-r"), NO_SUCH_ARTICLE);
		assertEquals(403, reporter.status(), "R은 없는 기사에도 403이다(역할 판정이 먼저다)");
		assertEquals(FORBIDDEN, reporter.body());
	}

	// --- 9. 미인증 3라우트 401(탭 헤더는 인증 수단이 아니다) ---------------------------------------

	@Test
	void allThreeRoutesAre401WithoutASessionAndTheTabHeaderIsNotACredential() {
		String sessionId = login("el-r");
		String articleId = createArticle(sessionId);
		String tab = unique("tab");

		for (String suffix : List.of("/lock", "/unlock", "/force-unlock")) {
			String path = "/api/articles/" + articleId + suffix;
			Wire.Response plain = Wire.json(this.port, "POST", path, Map.of(), "{}");
			Wire.Response tabOnly = Wire.json(this.port, "POST", path, Map.of("x-edit-client", tab), "{}");
			Wire.Response deadToken = Wire.json(this.port, "POST", path,
					Map.of("x-session-id", "0".repeat(64), "x-edit-client", tab), "{}");

			for (Wire.Response denied : List.of(plain, tabOnly, deadToken)) {
				assertEquals(401, denied.status(), suffix + ": 미인증 요청이 핸들러에 도달했다");
				assertEquals(UNAUTHENTICATED, denied.body());
				assertEquals(JSON_CONTENT_TYPE, denied.line("content-type"));
			}
		}

		assertEquals("N", contentsOf(articleId).column("lockYN"), "거부된 잠금 요청은 잠금을 만들지 않는다");
	}

	// --- 10. 인코딩·경로 파라미터 변형에서도 미인증 401 -------------------------------------------

	@Test
	void encodedAndParameterizedPathsStay401ForUnauthenticatedRequests() {
		String sessionId = login("el-r");
		String articleId = createArticle(sessionId);

		List<String> variants = List.of(
				"/api/artic%6Ces/" + articleId + "/lock",
				"/api/articles/" + articleId + "/lock;v=2",
				"/api/articles/" + articleId + ";v=2/lock",
				"/api/artic%6Ces/" + articleId + "/unlock",
				"/api/articles/" + articleId + "/unlock;v=2",
				"/api/artic%6Ces/" + articleId + "/force-unlock",
				"/api/articles/" + articleId + "/force-unlock;v=2");

		for (String path : variants) {
			Wire.Response response = Wire.json(this.port, "POST", path, Map.of(), "{}");
			assertEquals(401, response.status(), path + ": 경로 변형으로 게이트를 우회할 수 없다");
			assertEquals(UNAUTHENTICATED, response.body());
		}

		assertEquals("N", contentsOf(articleId).column("lockYN"));
	}

	// --- 도구 ------------------------------------------------------------------------------------

	private Wire.Response lock(String sessionId, String clientId, String articleId) {
		return lockWithBody(sessionId, clientId, articleId, "{}");
	}

	private Wire.Response lockWithBody(String sessionId, String clientId, String articleId, String body) {
		return Wire.json(this.port, "POST", "/api/articles/" + articleId + "/lock",
				Map.of("x-session-id", sessionId, "x-edit-client", clientId), body);
	}

	private Wire.Response unlock(String sessionId, String clientId, String articleId) {
		return Wire.json(this.port, "POST", "/api/articles/" + articleId + "/unlock",
				Map.of("x-session-id", sessionId, "x-edit-client", clientId), "{}");
	}

	/** 강제 해제는 탭 헤더를 보내지 않는다(보유자와 무관한 연산이다 — 계약 픽스처와 같다). */
	private Wire.Response forceUnlock(String sessionId, String articleId) {
		return Wire.json(this.port, "POST", "/api/articles/" + articleId + "/force-unlock",
				Map.of("x-session-id", sessionId), "{}");
	}

	private Wire.Response get(String sessionId, String articleId) {
		return Wire.send(this.port, "GET", "/api/articles/" + articleId,
				Map.of("x-session-id", sessionId), null);
	}

	/** 잠금 5컬럼이 전부 비었는가 — 둘은 응답 투영에 없어 여기서만 관측된다. */
	private void assertUnlocked(String articleId) {
		ContentsRow row = contentsOf(articleId);
		assertEquals("N", row.column("lockYN"));
		for (String column : LOCK_COLUMNS) {
			if (!"lockYN".equals(column)) {
				assertNull(row.column(column), column + "이(가) 해제 후에도 남아 있다");
			}
		}
	}

	private ContentsRow contentsOf(String articleId) {
		ArticleAggregate found = this.articles.findById(articleId);
		assertNotNull(found, "픽스처 기사를 찾지 못했다: " + articleId);
		return found.contents();
	}

	/**
	 * 송고된(DPS) 기사 픽스처 — {@code POST /api/articles/:id/action}은 step10이라 상태를 직접 세팅한다.
	 * 갱신문이며 행을 지우지 않는다(DB 비파괴).
	 */
	private void markSent(String articleId) {
		assertEquals(1, this.articles.update(articleId, Map.of(), Map.of("status", "DPS")),
				"DPS 픽스처 갱신이 한 행에 적용되지 않았다");
	}

	private String createArticle(String sessionId) {
		Wire.Response response = Wire.json(this.port, "POST", "/api/articles",
				Map.of("x-session-id", sessionId),
				"{\"title\":\"" + unique("lock-title") + "\"}");
		Matcher matcher = CREATED.matcher(response.body());
		assertTrue(matcher.matches(), "픽스처 생성 실패: " + response.status() + " " + response.body());
		return matcher.group(1);
	}

	private String login(String userId) {
		Wire.Response response = Wire.json(this.port, "POST", "/api/login", Map.of(),
				"{\"userId\":\"" + userId + "\",\"password\":\"" + PASSWORD + "\"}");
		Matcher matcher = SESSION_ID.matcher(response.body());
		assertTrue(matcher.find(), "로그인 응답에 sessionId가 없다: status=" + response.status());
		return matcher.group(1);
	}

	private void ensureUser(String userId, String role, String name, String department, String departmentCode) {
		Map<String, Object> dto = new LinkedHashMap<>();
		dto.put("userId", userId);
		dto.put("name", name);
		dto.put("role", role);
		dto.put("department", department);
		dto.put("departmentCode", departmentCode);
		dto.put("password", PASSWORD);
		try {
			this.users.create(dto);
		}
		catch (RuntimeException ignored) {
			// 이미 있다 — 픽스처는 멱등이다(행을 지우지 않는다).
		}
	}

	private static String unique(String prefix) {
		return prefix + "-" + Long.toString(System.nanoTime(), 36);
	}
}
