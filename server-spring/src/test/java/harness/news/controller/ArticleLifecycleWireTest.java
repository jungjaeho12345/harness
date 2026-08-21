package harness.news.controller;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
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
 * 생애주기 2라우트의 <b>와이어</b> 계약 — {@code POST /api/articles/:id/action} ·
 * {@code POST /api/articles/:id/derive}.
 *
 * <pre>
 * action 200 {"ok":true,"status":"DPS"}                  ← 정확히 2키(저장된 최종 상태)
 *        400 unknown-action(어휘) · 400 no-end-marker(마커) · 409 forbidden-transition(표 밖 칸)
 *        403 forbidden(R/D/Z 밖) · 404 not-found · 401 unauthenticated
 * derive 200 {"ok":true,"articleId":"AKR<8자리><9자리>"}   ← 정확히 2키(새로 발급된 id)
 *        400 unknown-mode · 403 forbidden · 404 not-found · 401 unauthenticated
 * </pre>
 *
 * <h2>이 클래스가 덮는 두 축</h2>
 * <ol>
 *   <li><b>action</b>은 같은 step에서 계약({@code contract/cases/default/articles-write.contract.js})이
 *       green이 되므로 여기 단언은 계약과 겹친다 — 겹치는 것이 목적이다: 계약은 {@code send} 픽스처로만
 *       그 라우트를 부르고 <b>실패 격자·게이트 순서·stamp를 관측하지 않는다</b>.</li>
 *   <li><b>derive</b>는 이 phase에서 <b>유일하게 "구현했는데 같은 step의 계약 관측이 따라오지 않는"
 *       라우트</b>다(index.json decisions (15)): 그 계약 파일({@code contract/cases/minimal/transitions.contract.js})은
 *       이력 라우트까지 있어야 green이라 <b>계약 편입은 step11</b>이다. 그 한 칸을 이 클래스가 덮는다 —
 *       아래 derive 테스트는 그 계약 케이스의 단언을 <b>선반영</b>한 것이다.</li>
 * </ol>
 *
 * <h2>게이트 순서와 폴백이 주제다(index.json decisions (12)(19))</h2>
 * 세션 → <b>역할 집합(R/D/Z)</b> → <b>어휘 검증(400)</b> → 서비스 호출 순서이며, action의 실패 폴백은
 * <b>409</b>다(정본 {@code fail(res, r, 409)} — 전역 폴백 400이 아니다). 어휘 검증이 서비스보다 앞이라
 * 없는 기사에 정의 밖 action을 보내면 404가 아니라 400이고, 역할 게이트가 앞에 있어 R/D/Z 밖의 요청은
 * 서비스의 {@code unknown-role}(표에 없는 토큰)이 아니라 403 {@code forbidden}으로 끝난다.
 *
 * <p>DB는 이 클래스 전용 임시 사본이며 리포 {@code news.db}는 열지 않는다. 상태 픽스처는 전부 <b>HTTP
 * 경로</b>로 만든다(리포지토리로 상태를 직접 놓지 않는다 — 이 step의 관측 대상이 그 경로다).
 */
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
class ArticleLifecycleWireTest {

	private static final Path DATA_DIR = TempNewsDb.newDataDir("article-lifecycle-wire");

	private static final Pattern SESSION_ID = Pattern.compile("\"sessionId\":\"([0-9a-f]{64})\"");

	private static final Pattern CREATED = Pattern.compile("^\\{\"ok\":true,\"articleId\":\"(AKR\\d{8}\\d{9})\"\\}$");

	/** 파생 성공 응답의 <b>원문</b> — 생성과 같은 2키 shape이고 id는 새로 발급된 값이다. */
	private static final Pattern DERIVED = CREATED;

	/** 밀리초 3자리 고정 ISO-8601 UTC(Iso8601 포매터의 출력 형태). */
	private static final Pattern INSTANT = Pattern.compile("^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$");

	private static final String PASSWORD = "article-lifecycle-pw-1";

	private static final String JSON_CONTENT_TYPE = "Content-Type: application/json; charset=utf-8";

	private static final String UNKNOWN_ACTION = "{\"ok\":false,\"reason\":\"unknown-action\"}";

	private static final String UNKNOWN_MODE = "{\"ok\":false,\"reason\":\"unknown-mode\"}";

	private static final String FORBIDDEN_TRANSITION = "{\"ok\":false,\"reason\":\"forbidden-transition\"}";

	private static final String NO_END_MARKER = "{\"ok\":false,\"reason\":\"no-end-marker\"}";

	private static final String NOT_FOUND = "{\"ok\":false,\"reason\":\"not-found\"}";

	private static final String FORBIDDEN = "{\"ok\":false,\"reason\":\"forbidden\"}";

	private static final String UNAUTHENTICATED = "{\"ok\":false,\"reason\":\"unauthenticated\"}";

	private static final String NO_SUCH_ARTICLE = "AKR19700101000000000";

	/** 엠바고 시각 — 값이 <b>있다</b>는 사실만 판정에 쓰인다(도래 여부는 비교하지 않는다). */
	private static final String FUTURE_EMBARGO = "2027-01-01T00:00:00.000Z";

	/** 픽스처 계정의 표시 이름 — derive가 stamp하는 값의 기대치다({@link #seedFixtures()}와 1:1). */
	private static final Map<String, String> DISPLAY_NAMES = Map.of(
			"al-r", "기자하나",
			"al-d", "데스크하나",
			"al-z", "관리자하나");

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

	/** 저장된 행의 되읽기 전용 — 상태 픽스처는 HTTP로만 만든다. */
	@Autowired
	private ArticleRepository articles;

	@BeforeEach
	void freshLoginBudget() {
		CLOCK.advance(RATE_LIMIT_WINDOW_MS + 1);
	}

	@BeforeEach
	void seedFixtures() {
		ensureUser("al-r", "R", "기자하나", "사회부", "SOC");
		ensureUser("al-d", "D", "데스크하나", "정치부", "POL");
		ensureUser("al-z", "Z", "관리자하나", "편집국", "EDT");
		ensureUser("al-alien", "X", "정의밖역할", "국제부", "INT"); // R/D/Z 밖 — 두 라우트 모두 403이다.
		ensureUser("al-noname", "R", null, "문화부", "CUL"); // name이 SQL NULL인 계정.
		ensureUser("al-emptyname", "R", "", "문화부", "CUL"); // name이 빈 문자열인 계정(?? 와 || 가 갈린다).
	}

	// --- 1. action 성공(2키 · 저장된 상태 일치) ----------------------------------------------------

	@Test
	void actionAnswersWithExactlyTwoKeysAndTheStoredStatusAgrees() {
		String desk = login("al-d");
		String reporter = login("al-r");

		String deskArticle = createArticle(desk);
		Wire.Response sent = action(desk, deskArticle, "send");
		assertEquals(200, sent.status());
		assertEquals("{\"ok\":true,\"status\":\"DPS\"}", sent.body(), "성공 응답은 ok·status 2키뿐이다");
		assertEquals(JSON_CONTENT_TYPE, sent.line("content-type"));
		assertEquals("DPS", storedStatus(deskArticle), "응답 status는 저장된 최종 상태다");
		assertTrue(get(desk, deskArticle).body().contains("\"status\":\"DPS\""), "되읽기도 같은 상태다");

		String reporterArticle = createArticle(reporter);
		Wire.Response reporterSend = action(reporter, reporterArticle, "send");
		assertEquals(200, reporterSend.status());
		assertEquals("{\"ok\":true,\"status\":\"RDS\"}", reporterSend.body(),
				"기자의 송고는 데스크 대기(RDS)에 머문다 — 같은 action이 role에 따라 다른 칸이다");
		assertEquals("RDS", storedStatus(reporterArticle));

		Wire.Response approved = action(desk, deskArticle, "approveDelete");
		assertEquals(200, approved.status());
		assertEquals("{\"ok\":true,\"status\":\"DPD\"}", approved.body());
		assertEquals("DPD", storedStatus(deskArticle));
		ArticleAggregate survived = this.articles.findById(deskArticle);
		assertNotNull(survived, "삭제 승인은 상태 전이다 — Contents 행은 남는다");
		assertNotNull(survived.article(), "Article 행도 남는다(행 삭제 0)");
	}

	// --- 2. 표 밖 칸 = 409 forbidden-transition(상태 그대로) ---------------------------------------

	@Test
	void aCellOutsideTheTableIs409AndLeavesTheStatusUntouched() {
		String desk = login("al-d");
		String articleId = createArticle(desk);
		assertEquals(200, action(desk, articleId, "hold").status());
		assertEquals("DDH", storedStatus(articleId));

		Wire.Response again = action(desk, articleId, "hold");

		assertEquals(409, again.status(), "표 밖 칸의 폴백은 400이 아니라 409다(정본 fail(res, r, 409))");
		assertEquals(FORBIDDEN_TRANSITION, again.body());
		assertEquals(JSON_CONTENT_TYPE, again.line("content-type"));
		assertEquals("DDH", storedStatus(articleId), "거부는 상태를 건드리지 않는다");

		Wire.Response reporterApproves = action(login("al-r"), articleId, "approveDelete");
		assertEquals(409, reporterApproves.status(), "기자에게는 삭제 승인 칸이 없다");
		assertEquals(FORBIDDEN_TRANSITION, reporterApproves.body());
		assertEquals("DDH", storedStatus(articleId));
	}

	// --- 3. 어휘 검증 400 unknown-action(누락·정의 밖·비문자열) -----------------------------------

	@Test
	void aMissingUnknownOrNonStringActionIs400AndChangesNothing() {
		String desk = login("al-d");
		String articleId = createArticle(desk);

		List<String> bodies = List.of(
				"{}",
				"{\"action\":\"bogus\"}",
				"{\"action\":null}",
				"{\"action\":123}",
				"{\"action\":[\"send\"]}",
				"{\"action\":{\"action\":\"send\"}}",
				"{\"action\":true}");

		for (String body : bodies) {
			Wire.Response response = actionWithBody(desk, articleId, body);
			assertEquals(400, response.status(), body + ": 어휘 밖 action은 400이다");
			assertEquals(UNKNOWN_ACTION, response.body(), body + ": 사유는 unknown-action이다");
			assertEquals(JSON_CONTENT_TYPE, response.line("content-type"));
			assertEquals("RDS", storedStatus(articleId), body + ": 검증 거부가 상태를 바꿨다");
		}
	}

	@Test
	void theVocabularyIsCheckedBeforeTheArticleIsLookedUp() {
		Wire.Response response = actionWithBody(login("al-d"), NO_SUCH_ARTICLE, "{\"action\":\"bogus\"}");

		assertEquals(400, response.status(), "어휘 검증이 서비스 호출보다 앞이라 404가 아니라 400이다");
		assertEquals(UNKNOWN_ACTION, response.body());
	}

	// --- 4. 404 · 미인증 401 ----------------------------------------------------------------------

	@Test
	void actionOnAnUnknownArticleIs404AndAnUnauthenticatedActionIs401() {
		Wire.Response missing = action(login("al-d"), NO_SUCH_ARTICLE, "send");
		assertEquals(404, missing.status());
		assertEquals(NOT_FOUND, missing.body());
		assertEquals(JSON_CONTENT_TYPE, missing.line("content-type"));

		String desk = login("al-d");
		String articleId = createArticle(desk);
		String path = "/api/articles/" + articleId + "/action";
		Wire.Response noSession = Wire.json(this.port, "POST", path, Map.of(), "{\"action\":\"send\"}");
		Wire.Response deadToken = Wire.json(this.port, "POST", path,
				Map.of("x-session-id", "0".repeat(64)), "{\"action\":\"send\"}");

		for (Wire.Response denied : List.of(noSession, deadToken)) {
			assertEquals(401, denied.status(), "미인증 요청이 핸들러에 도달했다");
			assertEquals(UNAUTHENTICATED, denied.body());
			assertEquals(JSON_CONTENT_TYPE, denied.line("content-type"));
		}
		assertEquals("RDS", storedStatus(articleId), "미인증 요청은 전이를 일으키지 않는다");
	}

	@Test
	void bothRoutesRefuseARoleOutsideTheWriteSetWithForbidden() {
		String alien = login("al-alien");
		String articleId = createArticle(login("al-d"));

		Wire.Response deniedAction = action(alien, articleId, "send");
		assertEquals(403, deniedAction.status(),
				"역할 게이트를 빼면 서비스의 unknown-role이 폴백 409로 새어 나간다(표에 없는 토큰이다)");
		assertEquals(FORBIDDEN, deniedAction.body());
		assertEquals("RDS", storedStatus(articleId));

		Wire.Response deniedDerive = derive(alien, articleId, "followUp");
		assertEquals(403, deniedDerive.status(), "파생도 R/D/Z 집합만 통과한다");
		assertEquals(FORBIDDEN, deniedDerive.body());

		Wire.Response bogusVocabulary = actionWithBody(alien, articleId, "{\"action\":\"bogus\"}");
		assertEquals(403, bogusVocabulary.status(), "역할 게이트가 어휘 검증보다 앞이다(400이 아니다)");
		assertEquals(FORBIDDEN, bogusVocabulary.body());
	}

	// --- 5. 마커 게이트와 그 순서(전이 판정이 먼저다) ---------------------------------------------

	@Test
	void sendWithoutTheEndMarkerIs400ButTheTransitionTableIsJudgedFirst() {
		String desk = login("al-d");
		String articleId = createArticleWithoutMarker(desk);

		Wire.Response noMarker = action(desk, articleId, "send");
		assertEquals(400, noMarker.status(), "마커 없는 송고는 400이다");
		assertEquals(NO_END_MARKER, noMarker.body());
		assertEquals("RDS", storedStatus(articleId), "마커 거부도 상태를 건드리지 않는다");

		assertEquals(200, action(desk, articleId, "kill").status(), "KILL은 마커를 요구하지 않는다");
		assertEquals("DDK", storedStatus(articleId));

		Wire.Response killedThenSend = action(desk, articleId, "send");
		assertEquals(409, killedThenSend.status(),
				"마커도 없고 전이도 불가하면 400이 아니라 409다 — 전이 판정이 마커 검사보다 앞이다");
		assertEquals(FORBIDDEN_TRANSITION, killedThenSend.body());
		assertEquals("DDK", storedStatus(articleId));
	}

	// --- 6. 송고 stamp(sender·sentAt) · distributedAt은 그대로 null ------------------------------

	@Test
	void sendStampsTheSenderAndSentAtAndNeverTouchesDistributedAt() {
		String desk = login("al-d");
		String articleId = createArticle(desk);
		ContentsRow before = contentsOf(articleId);
		assertNull(before.column("sender"), "픽스처 전제: 송고 전에는 sender가 비어 있다");
		assertNull(before.column("sentAt"));

		assertEquals(200, action(desk, articleId, "send").status());

		ContentsRow after = contentsOf(articleId);
		assertEquals("al-d", after.column("sender"), "sender는 세션 사용자다(클라 값이 아니다)");
		String sentAt = String.valueOf(after.column("sentAt"));
		assertTrue(INSTANT.matcher(sentAt).matches(), "sentAt이 밀리초 3자리 ISO-8601 UTC가 아니다: " + sentAt);
		assertNull(after.column("distributedAt"),
				"이 서버에는 배부 훅이 없다 — 송고는 distributedAt을 만들지 않는다(excluded (c))");

		String read = get(desk, articleId).body();
		assertTrue(read.contains("\"distributedAt\":null"), "되읽기에도 배부 흔적이 없다: " + read);
		assertTrue(read.contains("\"sender\":\"al-d\""));
	}

	// --- 7. 엠바고 송고 = DES(D) / RDS(R) ---------------------------------------------------------

	@Test
	void anEmbargoArticleEntersDesForTheDeskAndStaysRdsForTheReporter() {
		String desk = login("al-d");
		String deskArticle = createArticleWithBody(desk,
				"{\"title\":\"" + unique("emb-title") + "\",\"markupVersion\":\"" + escaped(markupText("본문.\n(끝)"))
						+ "\",\"embargoAt\":\"" + FUTURE_EMBARGO + "\"}");

		Wire.Response deskSend = action(desk, deskArticle, "send");
		assertEquals(200, deskSend.status());
		assertEquals("{\"ok\":true,\"status\":\"DES\"}", deskSend.body(), "엠바고 기사는 DPS가 아니라 DES다");
		assertEquals("DES", storedStatus(deskArticle));

		String reporter = login("al-r");
		String reporterArticle = createArticleWithBody(reporter,
				"{\"title\":\"" + unique("emb-title") + "\",\"markupVersion\":\"" + escaped(markupText("본문.\n(끝)"))
						+ "\",\"secondEmbargoAt\":\"" + FUTURE_EMBARGO + "\"}");

		Wire.Response reporterSend = action(reporter, reporterArticle, "send");
		assertEquals(200, reporterSend.status());
		assertEquals("{\"ok\":true,\"status\":\"RDS\"}", reporterSend.body(),
				"기자의 송고는 전이 결과가 DPS가 아니라 엠바고 분기에 들어오지 않는다");
		assertEquals("RDS", storedStatus(reporterArticle));
	}

	// --- 8. derive 성공(2키 · 새 id · RDS · 세션 작성자 · 원본 무변 · R/D/Z · DPS 원본) -----------

	@Test
	void deriveCreatesANewRdsArticleForEveryWriteRoleAndLeavesTheSourceUntouched() {
		String desk = login("al-d");
		String sourceId = createArticleWithBody(desk,
				"{\"title\":\"" + unique("src-title") + "\",\"markupVersion\":\"" + escaped(markupText("원본 본문."))
						+ "\",\"embargoAt\":\"" + FUTURE_EMBARGO + "\",\"category\":\"정치\"}");
		String sourceBefore = get(desk, sourceId).body();

		Map<String, String> sessions = new LinkedHashMap<>();
		sessions.put("al-r", login("al-r"));
		sessions.put("al-d", desk);
		sessions.put("al-z", login("al-z"));

		for (Map.Entry<String, String> entry : sessions.entrySet()) {
			String mode = "al-d".equals(entry.getKey()) ? "continue" : "followUp";
			Wire.Response response = derive(entry.getValue(), sourceId, mode);

			assertEquals(200, response.status(), entry.getKey() + ": 파생은 R·D·Z 모두 가능하다");
			assertEquals(JSON_CONTENT_TYPE, response.line("content-type"));
			String newId = derivedIdOf(response);
			assertNotEquals(sourceId, newId, "파생은 새 articleId를 발급한다");

			ContentsRow derived = contentsOf(newId);
			assertEquals("RDS", derived.column("status"), "파생 기사는 언제나 최초 작성 상태다");
			assertEquals(nameOf(entry.getKey()), derived.column("author"), "작성자는 파생을 실행한 세션 사용자다");
			assertEquals("정치", derived.column("category"), "공통정보는 원본에서 복사된다");
			assertEquals("", derived.column("embargoAt"), "엠바고는 새 기사에서 새로 설정한다");
			assertNull(derived.column("sender"), "송고 stamp는 복사되지 않는다");
			assertNull(derived.column("department"), "부서는 복사되지 않는다(신규 저장도 채우지 않는다)");
		}

		assertEquals(sourceBefore, get(desk, sourceId).body(), "원본은 한 글자도 바뀌지 않는다");
	}

	@Test
	void deriveWorksFromASentArticleToo() {
		String desk = login("al-d");
		String sourceId = createArticle(desk);
		assertEquals(200, action(desk, sourceId, "send").status());
		assertEquals("DPS", storedStatus(sourceId));

		Wire.Response response = derive(login("al-r"), sourceId, "continue");

		assertEquals(200, response.status(), "원본이 DPS여도 파생된다(라우트는 역할 집합만 본다)");
		String newId = derivedIdOf(response);
		assertEquals("RDS", storedStatus(newId));
		assertEquals("DPS", storedStatus(sourceId), "파생은 원본 상태를 바꾸지 않는다");
	}

	/**
	 * 작성자 stamp의 <b>null 병합</b> 의미론 — derive는 {@code me.name ?? me.userId}이고 create는
	 * {@code me.name || me.userId}다. 이름이 <b>빈 문자열</b>인 계정에서 두 라우트가 갈린다:
	 * derive는 빈 문자열을 그대로 쓰고 create는 userId로 떨어진다. 계약 스위트의 시드 계정은 전부 이름이
	 * 채워져 있어 <b>계약이 영원히 관측하지 못하는 축</b>이며, 이 테스트가 그 축의 유일한 방어선이다.
	 */
	@Test
	void deriveStampsTheAuthorWithNullCoalescingWhileCreateFallsBackOnEmptyNames() {
		String sourceId = createArticle(login("al-d"));

		String emptyName = login("al-emptyname");
		String derivedByEmptyName = derivedIdOf(derive(emptyName, sourceId, "followUp"));
		assertEquals("", contentsOf(derivedByEmptyName).column("author"),
				"derive는 ?? 라서 빈 이름을 그대로 stamp한다(|| 로 옮기면 userId가 되어 두 서버가 갈린다)");

		String createdByEmptyName = createArticle(emptyName);
		assertEquals("al-emptyname", contentsOf(createdByEmptyName).column("author"),
				"신규 저장은 || 라서 빈 이름을 userId로 대체한다 — 두 라우트의 연산자가 다르다");

		String noName = login("al-noname");
		String derivedByNoName = derivedIdOf(derive(noName, sourceId, "followUp"));
		assertEquals("al-noname", contentsOf(derivedByNoName).column("author"),
				"이름이 NULL이면 ?? 도 userId로 떨어진다");
	}

	// --- 9. derive 검증(어휘 400 · 없는 원본 404 · 미인증 401) ------------------------------------

	@Test
	void aMissingOrUnknownModeIs400AndAnUnknownSourceIs404() {
		String desk = login("al-d");
		String sourceId = createArticle(desk);
		String sourceBefore = get(desk, sourceId).body();

		for (String body : List.of("{}", "{\"mode\":\"bogus\"}", "{\"mode\":null}", "{\"mode\":42}",
				"{\"mode\":[\"followUp\"]}")) {
			Wire.Response response = deriveWithBody(desk, sourceId, body);
			assertEquals(400, response.status(), body + ": 어휘 밖 mode는 400이다");
			assertEquals(UNKNOWN_MODE, response.body());
			assertEquals(JSON_CONTENT_TYPE, response.line("content-type"));
		}
		assertEquals(sourceBefore, get(desk, sourceId).body(), "거부된 파생은 원본을 건드리지 않는다");

		Wire.Response missing = derive(desk, NO_SUCH_ARTICLE, "followUp");
		assertEquals(404, missing.status(), "정의된 mode + 없는 원본은 404다");
		assertEquals(NOT_FOUND, missing.body());

		Wire.Response missingAndBogus = deriveWithBody(desk, NO_SUCH_ARTICLE, "{\"mode\":\"bogus\"}");
		assertEquals(400, missingAndBogus.status(), "어휘 검증이 존재 검사보다 앞이다");
		assertEquals(UNKNOWN_MODE, missingAndBogus.body());
	}

	@Test
	void anUnauthenticatedDeriveIs401AndCreatesNothing() {
		String desk = login("al-d");
		String sourceId = createArticle(desk);
		String sourceBefore = get(desk, sourceId).body();
		String path = "/api/articles/" + sourceId + "/derive";

		Wire.Response noSession = Wire.json(this.port, "POST", path, Map.of(), "{\"mode\":\"followUp\"}");
		Wire.Response deadToken = Wire.json(this.port, "POST", path,
				Map.of("x-session-id", "0".repeat(64)), "{\"mode\":\"followUp\"}");

		for (Wire.Response denied : List.of(noSession, deadToken)) {
			assertEquals(401, denied.status());
			assertEquals(UNAUTHENTICATED, denied.body());
			assertEquals(JSON_CONTENT_TYPE, denied.line("content-type"));
			assertFalse(denied.body().contains("articleId"), "거부 응답에 새 기사 id가 실릴 자리가 없다");
		}
		assertEquals(sourceBefore, get(desk, sourceId).body());
	}

	// --- 10. Content-Type 원문(세미콜론 뒤 공백 1바이트 포함) --------------------------------------

	@Test
	void everyLifecycleResponseCarriesTheExactContentTypeString() {
		String desk = login("al-d");
		String articleId = createArticle(desk);

		List<Wire.Response> responses = List.of(
				actionWithBody(desk, articleId, "{\"action\":\"bogus\"}"),
				action(desk, NO_SUCH_ARTICLE, "send"),
				action(desk, articleId, "send"),
				action(desk, articleId, "send"),
				derive(desk, articleId, "followUp"),
				deriveWithBody(desk, articleId, "{}"),
				derive(desk, NO_SUCH_ARTICLE, "followUp"),
				Wire.json(this.port, "POST", "/api/articles/" + articleId + "/action", Map.of(), "{}"));

		for (Wire.Response response : responses) {
			assertEquals(JSON_CONTENT_TYPE, response.line("content-type"),
					"MVC 메시지 컨버터로 반환하면 세미콜론 뒤 공백이 사라져 전 관측이 diff가 된다");
			assertEquals(1, response.lines("content-type").size(), "Content-Type이 두 번 실렸다");
		}
	}

	// --- 도구 ------------------------------------------------------------------------------------

	private Wire.Response action(String sessionId, String articleId, String action) {
		return actionWithBody(sessionId, articleId, "{\"action\":\"" + action + "\"}");
	}

	private Wire.Response actionWithBody(String sessionId, String articleId, String body) {
		return Wire.json(this.port, "POST", "/api/articles/" + articleId + "/action",
				Map.of("x-session-id", sessionId), body);
	}

	private Wire.Response derive(String sessionId, String articleId, String mode) {
		return deriveWithBody(sessionId, articleId, "{\"mode\":\"" + mode + "\"}");
	}

	private Wire.Response deriveWithBody(String sessionId, String articleId, String body) {
		return Wire.json(this.port, "POST", "/api/articles/" + articleId + "/derive",
				Map.of("x-session-id", sessionId), body);
	}

	private Wire.Response get(String sessionId, String articleId) {
		return Wire.send(this.port, "GET", "/api/articles/" + articleId,
				Map.of("x-session-id", sessionId), null);
	}

	private String storedStatus(String articleId) {
		return String.valueOf(contentsOf(articleId).column("status"));
	}

	private ContentsRow contentsOf(String articleId) {
		ArticleAggregate found = this.articles.findById(articleId);
		assertNotNull(found, "기사를 찾지 못했다: " + articleId);
		return found.contents();
	}

	/** 픽스처 기사 1건 — "(끝)" 마커가 있는 본문(송고 가드를 통과한다). */
	private String createArticle(String sessionId) {
		return createArticleWithBody(sessionId,
				"{\"title\":\"" + unique("lc-title") + "\",\"markupVersion\":\""
						+ escaped(markupText("픽스처 본문.\n(끝)")) + "\"}");
	}

	/** 마커 없는 본문 — 송고 가드(400 no-end-marker)의 관측 대상이다. */
	private String createArticleWithoutMarker(String sessionId) {
		return createArticleWithBody(sessionId,
				"{\"title\":\"" + unique("lc-title") + "\",\"markupVersion\":\""
						+ escaped(markupText("마커 없는 본문.")) + "\"}");
	}

	private String createArticleWithBody(String sessionId, String body) {
		Wire.Response response = Wire.json(this.port, "POST", "/api/articles",
				Map.of("x-session-id", sessionId), body);
		Matcher matcher = CREATED.matcher(response.body());
		assertTrue(matcher.matches(), "픽스처 생성 실패: " + response.status() + " " + response.body());
		return matcher.group(1);
	}

	private static String derivedIdOf(Wire.Response response) {
		Matcher matcher = DERIVED.matcher(response.body());
		assertTrue(matcher.matches(),
				"파생 응답은 {ok:true, articleId} 2키이고 articleId는 AKR + 8자리 날짜 + 9자리 난수다: "
						+ response.status() + " " + response.body());
		return matcher.group(1);
	}

	/** 픽스처 계정의 표시 이름(= derive가 stamp하는 값). {@link #seedFixtures()}와 같은 값이다. */
	private static String nameOf(String userId) {
		String name = DISPLAY_NAMES.get(userId);
		assertNotNull(name, "픽스처에 없는 계정이다: " + userId);
		return name;
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
		if (name != null) {
			dto.put("name", name);
		}
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

	/** 저장될 본문 마크업 원문(JSON 문서) — 줄바꿈은 블록 하나 안에 그대로 담는다. */
	private static String markupText(String text) {
		return "{\"blocks\":[{\"type\":\"text\",\"text\":\"" + text.replace("\n", "\\n") + "\"}]}";
	}

	/** JSON <b>문자열 값</b>으로 실을 수 있게 이스케이프한 형태. */
	private static String escaped(String raw) {
		return raw.replace("\\", "\\\\").replace("\"", "\\\"");
	}

}
