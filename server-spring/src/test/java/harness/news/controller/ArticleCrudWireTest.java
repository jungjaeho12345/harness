package harness.news.controller;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.junit.jupiter.api.Assertions.fail;

import harness.news.service.EditLockService;
import harness.news.service.UserService;
import harness.news.testsupport.MutableClock;
import harness.news.testsupport.TempNewsDb;
import harness.news.testsupport.Wire;
import java.nio.file.Path;
import java.time.Clock;
import java.time.Instant;
import java.util.ArrayList;
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
 * 기사 단건 3라우트의 <b>와이어</b> 계약 — {@code POST /api/articles} · {@code GET /api/articles/:id} ·
 * {@code PUT /api/articles/:id}.
 *
 * <p>계약 케이스({@code contract/cases/default/articles-write.contract.js} 생성·수정 ·
 * {@code articles-read.contract.js} 단건 조회)의 단언을 <b>선반영</b>한다: 그 계약 파일들은 잠금 3라우트와
 * {@code action}까지 있어야 green이 되므로(index.json order (a)) 이 step의 판정은 여기 있다.
 *
 * <pre>
 * 생성 200 {"ok":true,"articleId":"AKR<8자리><9자리>"}            ← 정확히 2키
 * 조회 200 {"ok":true,"article":{5키},"contents":{27키}}          ← 정확히 3키
 * 수정 200 {"ok":true,"changes":2}                               ← 두 갱신문의 합(Node 실측값)
 * 거부   401 unauthenticated · 403 forbidden/not-holder · 404 not-found
 * </pre>
 *
 * <p><b>신뢰 경계가 이 클래스의 주제다</b>(ADR-004): acting role·부서·작성자·{@code modifier}는 검증된
 * 세션에서만 온다. 클라가 보낸 {@code role}·{@code status}·{@code articleId}·{@code sender}·
 * {@code distributedAt}·{@code modifier}는 저장에 닿지 못하고, 편집 탭 헤더({@code x-edit-client})는
 * <b>인증 수단이 아니다</b> — 잠금 보유 판정의 재료일 뿐이다.
 *
 * <p>잠금 픽스처는 {@link EditLockService}를 직접 부른다({@code POST /api/articles/:id/lock}은 step8이다).
 * DB는 이 클래스 전용 임시 사본이며 리포 {@code news.db}는 열지 않는다.
 */
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
class ArticleCrudWireTest {

	private static final Path DATA_DIR = TempNewsDb.newDataDir("article-crud-wire");

	private static final Pattern SESSION_ID = Pattern.compile("\"sessionId\":\"([0-9a-f]{64})\"");

	/** 생성 성공 응답의 <b>원문</b> — 키 순서·키 수·{@code articleId} 형식을 한 번에 잠근다. */
	private static final Pattern CREATED = Pattern.compile("^\\{\"ok\":true,\"articleId\":\"(AKR\\d{8}\\d{9})\"\\}$");

	private static final String PASSWORD = "article-crud-pw-1";

	private static final String JSON_CONTENT_TYPE = "Content-Type: application/json; charset=utf-8";

	private static final String UNAUTHENTICATED = "{\"ok\":false,\"reason\":\"unauthenticated\"}";

	private static final String NOT_HOLDER = "{\"ok\":false,\"reason\":\"not-holder\"}";

	private static final String NOT_FOUND = "{\"ok\":false,\"reason\":\"not-found\"}";

	private static final String FORBIDDEN = "{\"ok\":false,\"reason\":\"forbidden\"}";

	/** 존재할 수 없는 기사 id(계약 케이스의 {@code NO_SUCH_ARTICLE}과 같은 역할). */
	private static final String NO_SUCH_ARTICLE = "AKR19700101000000000";

	/** {@code Article} 응답 5키 — 계약이 동결한 집합(순서는 스키마 순서다). */
	private static final List<String> ARTICLE_KEYS =
			List.of("articleId", "title", "content", "markupVersion", "modifier");

	/**
	 * {@code Contents} 응답 27키 — 스키마 29컬럼에서 {@code lockerSessionId}·{@code lockerClientId}를 뺀
	 * 투영 결과다. 값이 SQL NULL이어도 <b>키는 남는다</b>(decisions (5)(20)).
	 */
	private static final List<String> CONTENTS_KEYS = List.of(
			"articleId", "title", "content", "author", "modifier", "sender",
			"department", "departmentCode", "createdAt", "editedAt", "sentAt",
			"distributedAt", "embargoAt", "secondEmbargoAt", "status",
			"lockYN", "lockerUserId", "lockedAt",
			"coAuthor", "category", "region", "attribute", "keyword",
			"internalComment", "externalComment", "attachmentFile", "referenceFile");

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

	/** 잠금 픽스처 전용 — 잠금 HTTP 라우트는 step8이 만든다. */
	@Autowired
	private EditLockService locks;

	@BeforeEach
	void freshLoginBudget() {
		CLOCK.advance(RATE_LIMIT_WINDOW_MS + 1);
	}

	@BeforeEach
	void seedFixtures() {
		ensureUser("ac-r", "R", "기자하나", "사회부", "SOC");
		ensureUser("ac-d", "D", "데스크하나", "정치부", "POL");
		ensureUser("ac-z", "Z", "관리자하나", "편집국", "EDT");
		ensureUser("ac-noname", "R", null, "문화부", "CUL"); // name이 SQL NULL인 계정.
		ensureUser("ac-alien", "X", "정의밖역할", "국제부", "INT"); // R/D/Z 밖 — 생성 게이트가 막는다.
	}

	// --- 1. 생성 stamp(초기 status · 세션 부서 · 세션 작성자) --------------------------------------

	@Test
	void createStampsTheInitialStatusDepartmentAndAuthorFromTheSession() {
		String sessionId = login("ac-r");
		String title = unique("crud-title");
		String body = markupText("계약 선반영 생성 본문.");

		Wire.Response response = Wire.json(this.port, "POST", "/api/articles",
				Map.of("x-session-id", sessionId),
				"{\"title\":\"" + title + "\",\"markupVersion\":\"" + escaped(body) + "\"}");

		assertEquals(200, response.status());
		assertEquals(JSON_CONTENT_TYPE, response.line("content-type"));
		String articleId = articleIdOf(response);

		String read = get(sessionId, articleId).body();
		String contents = objectAt(read, "\"contents\":");
		String article = objectAt(read, "\"article\":");
		assertTrue(contents.contains("\"status\":\"RDS\""), "초기 status는 서버 계산값 RDS다: " + contents);
		assertTrue(contents.contains("\"author\":\"기자하나\""), "작성자 미전송이면 세션 사용자 이름으로 stamp된다");
		assertTrue(contents.contains("\"department\":\"사회부\""), "부서 미전송이면 세션 부서로 stamp된다");
		assertTrue(contents.contains("\"departmentCode\":\"SOC\""));
		assertTrue(contents.contains("\"lockYN\":\"N\""), "신규 기사는 잠겨 있지 않다");
		assertTrue(contents.contains("\"lockerUserId\":null"));
		assertTrue(article.contains("\"markupVersion\":\"" + escaped(body) + "\""), "본문이 그대로 저장됐다");
		assertTrue(article.contains("\"title\":\"" + title + "\""));
	}

	@Test
	void createFallsBackToTheUserIdWhenTheSessionUserHasNoName() {
		String sessionId = login("ac-noname");

		Wire.Response response = Wire.json(this.port, "POST", "/api/articles",
				Map.of("x-session-id", sessionId),
				"{\"title\":\"" + unique("crud-title") + "\"}");

		assertEquals(200, response.status());
		String contents = objectAt(get(sessionId, articleIdOf(response)).body(), "\"contents\":");
		assertTrue(contents.contains("\"author\":\"ac-noname\""),
				"이름이 없으면 userId로 stamp된다(Node: me.name || me.userId): " + contents);
	}

	// --- 2. 생성 신뢰 경계(클라 값은 반영되지 않고 명시 author만 보존된다) --------------------------

	@Test
	void createIgnoresClientOwnedFieldsButPreservesAnExplicitAuthor() {
		String sessionId = login("ac-r");
		String claimedAuthor = unique("crud-author");

		Wire.Response response = Wire.json(this.port, "POST", "/api/articles",
				Map.of("x-session-id", sessionId),
				"{\"title\":\"" + unique("crud-title") + "\","
						+ "\"role\":\"Z\",\"status\":\"DPS\",\"articleId\":\"client-supplied-id\","
						+ "\"sender\":\"client-sender\",\"distributedAt\":\"2020-01-01T00:00:00.000Z\","
						+ "\"author\":\"" + claimedAuthor + "\"}");

		assertEquals(200, response.status());
		String articleId = articleIdOf(response);
		assertNotEquals("client-supplied-id", articleId, "articleId는 서버가 발급한다");

		String contents = objectAt(get(sessionId, articleId).body(), "\"contents\":");
		assertTrue(contents.contains("\"status\":\"RDS\""), "클라가 보낸 status는 반영되지 않는다: " + contents);
		assertTrue(contents.contains("\"articleId\":\"" + articleId + "\""), "저장된 articleId는 서버 발급 값이다");
		assertTrue(contents.contains("\"sender\":null"), "sender는 송고가 정한다");
		assertTrue(contents.contains("\"distributedAt\":null"), "distributedAt은 배부가 정한다");
		assertTrue(contents.contains("\"author\":\"" + claimedAuthor + "\""),
				"명시된 author는 대필 입력이라 보존된다(무시하면 계약 위반이다)");
		assertFalse(contents.contains("client-sender"), "클라 sender 문자열이 어디에도 저장되지 않았다");
	}

	// --- 3. 생성 + action:hold(초기 status는 세션 role이 정한다) ----------------------------------

	@Test
	void createWithHoldIntentDerivesTheInitialStatusFromTheSessionRole() {
		for (Map.Entry<String, String> expected : Map.of("ac-d", "DDH", "ac-r", "RRH").entrySet()) {
			String sessionId = login(expected.getKey());

			Wire.Response response = Wire.json(this.port, "POST", "/api/articles",
					Map.of("x-session-id", sessionId),
					"{\"title\":\"" + unique("crud-title") + "\",\"action\":\"hold\"}");

			assertEquals(200, response.status());
			String contents = objectAt(get(sessionId, articleIdOf(response)).body(), "\"contents\":");
			assertTrue(contents.contains("\"status\":\"" + expected.getValue() + "\""),
					expected.getKey() + " + action:hold의 초기 status는 " + expected.getValue() + "다: " + contents);
		}
	}

	@Test
	void createIsForbiddenForARoleOutsideTheWriteSet() {
		Wire.Response response = Wire.json(this.port, "POST", "/api/articles",
				Map.of("x-session-id", login("ac-alien")),
				"{\"title\":\"" + unique("crud-title") + "\"}");

		assertEquals(403, response.status(), "생성은 R/D/Z 집합만 통과한다");
		assertEquals(FORBIDDEN, response.body());
		assertEquals(JSON_CONTENT_TYPE, response.line("content-type"));
	}

	// --- 4. 단건 조회(봉투 3키 · article 5키 · contents 27키 · 잠금 비밀 부재 · 없는 id 404) -------

	@Test
	void getByIdIsAThreeKeyEnvelopeAndTheLockedRowStillHidesTheLockerSecrets() {
		String sessionId = login("ac-r");
		String articleId = createArticle(sessionId, unique("crud-title"));
		String tab = unique("tab");
		assertTrue(this.locks.acquire(articleId, new EditLockService.Requester("ac-r", sessionId, tab)).ok(),
				"잠금 픽스처를 만들지 못하면 이 관측은 무의미하다");

		Wire.Response response = get(sessionId, articleId);

		assertEquals(200, response.status());
		assertEquals(JSON_CONTENT_TYPE, response.line("content-type"));
		assertEquals(List.of("ok", "article", "contents"), topLevelKeys(response.body()), "봉투는 정확히 3키다");
		assertEquals(ARTICLE_KEYS, topLevelKeys(objectAt(response.body(), "\"article\":")));
		String contents = objectAt(response.body(), "\"contents\":");
		assertEquals(CONTENTS_KEYS, topLevelKeys(contents), "contents는 투영 27키다");
		assertTrue(contents.contains("\"lockYN\":\"Y\""), "잠금 보유 상태에서 관측했다: " + contents);
		assertTrue(contents.contains("\"lockerUserId\":\"ac-r\""), "잠금 표시 3컬럼은 남는다(UI 계약)");
		assertFalse(contents.contains("\"lockedAt\":null"), "lockedAt이 stamp됐다");
		assertFalse(response.body().contains("lockerSessionId"), "세션 토큰 컬럼이 응답에 실렸다");
		assertFalse(response.body().contains("lockerClientId"), "탭 식별자 컬럼이 응답에 실렸다");
		assertFalse(response.body().contains(sessionId), "세션 토큰 원문이 응답에 실렸다");
		assertFalse(response.body().contains(tab), "탭 식별자 원문이 응답에 실렸다");
	}

	@Test
	void getByIdOfAnUnknownArticleIs404WithAFixedBody() {
		Wire.Response response = get(login("ac-r"), NO_SUCH_ARTICLE);

		assertEquals(404, response.status());
		assertEquals(NOT_FOUND, response.body());
		assertEquals(JSON_CONTENT_TYPE, response.line("content-type"));
	}

	// --- 5. 수정 보유자 인가(잠금 없음 403 · 보유 탭 200 · 같은 세션 다른 탭 403) ------------------

	@Test
	void updateNeedsTheHoldingTabAndStampsTheSessionUserAsModifier() {
		String sessionId = login("ac-r");
		String articleId = createArticle(sessionId, unique("crud-title"));
		String tabA = unique("tab");
		String tabB = unique("tab");
		String heldTitle = unique("crud-title");

		Wire.Response noLock = put(sessionId, tabA, articleId, "{\"title\":\"" + unique("crud-title") + "\"}");
		assertEquals(403, noLock.status(), "세션만으로는 저장할 수 없다");
		assertEquals(NOT_HOLDER, noLock.body());

		assertTrue(this.locks.acquire(articleId, new EditLockService.Requester("ac-r", sessionId, tabA)).ok());

		Wire.Response held = put(sessionId, tabA, articleId,
				"{\"title\":\"" + heldTitle + "\",\"markupVersion\":\"" + escaped(markupText("수정 본문.")) + "\"}");
		assertEquals(200, held.status());
		assertEquals("{\"ok\":true,\"changes\":2}", held.body(),
				"changes는 두 갱신문의 영향 행 수 합이다(Node 실측 2 — 1/0으로 정규화하면 패리티가 깨진다)");
		assertEquals(JSON_CONTENT_TYPE, held.line("content-type"));

		String contents = objectAt(get(sessionId, articleId).body(), "\"contents\":");
		assertTrue(contents.contains("\"title\":\"" + heldTitle + "\""));
		assertTrue(contents.contains("\"modifier\":\"ac-r\""), "modifier는 세션 사용자로 stamp된다: " + contents);
		assertFalse(contents.contains("\"editedAt\":null"), "editedAt이 stamp됐다");

		Wire.Response otherTab = put(sessionId, tabB, articleId, "{\"title\":\"" + unique("crud-title") + "\"}");
		assertEquals(403, otherTab.status(), "같은 세션의 다른 탭도 보유자가 아니다");
		assertEquals(NOT_HOLDER, otherTab.body());
		assertTrue(objectAt(get(sessionId, articleId).body(), "\"contents\":")
				.contains("\"title\":\"" + heldTitle + "\""), "거부된 저장은 제목을 바꾸지 않았다");
	}

	@Test
	void savingWithoutTheTabHeaderIsDeniedEvenForTheLockingUser() {
		String sessionId = login("ac-r");
		String articleId = createArticle(sessionId, unique("crud-title"));
		// 탭 헤더 없이 잠근 행 = lockerClientId가 SQL NULL이다. 헤더 부재를 빈 문자열로 정규화하면
		// "둘 다 비어 있으니 같다"가 되어 보유자가 아닌 요청이 저장 인가를 얻는다(step6 decisions (11)).
		assertTrue(this.locks.acquire(articleId, new EditLockService.Requester("ac-r", sessionId, null)).ok());

		Wire.Response response = Wire.json(this.port, "PUT", "/api/articles/" + articleId,
				Map.of("x-session-id", sessionId), "{\"title\":\"" + unique("crud-title") + "\"}");

		assertEquals(403, response.status(), "헤더 부재를 값으로 바꾸면 인가 구멍이 열린다");
		assertEquals(NOT_HOLDER, response.body());
	}

	// --- 6. 수정 404가 403보다 먼저다 -------------------------------------------------------------

	@Test
	void updateOfAnUnknownArticleIs404BeforeItIs403() {
		Wire.Response response = put(login("ac-r"), unique("tab"), NO_SUCH_ARTICLE,
				"{\"title\":\"" + unique("crud-title") + "\"}");

		assertEquals(404, response.status(), "존재 판정이 잠금 판정보다 앞선다");
		assertEquals(NOT_FOUND, response.body());
	}

	// --- 7. 수정 화이트리스트 + 빈 부서 보정 ------------------------------------------------------

	@Test
	void updateIgnoresClientOwnedFieldsAndBackfillsAnEmptyDepartment() {
		String sessionId = login("ac-r");
		String articleId = createArticle(sessionId, unique("crud-title"));
		String tab = unique("tab");
		String newTitle = unique("crud-title");
		assertTrue(this.locks.acquire(articleId, new EditLockService.Requester("ac-r", sessionId, tab)).ok());

		Wire.Response response = put(sessionId, tab, articleId,
				"{\"title\":\"" + newTitle + "\",\"status\":\"DPS\",\"sender\":\"client-sender\","
						+ "\"articleId\":\"client-supplied-id\",\"role\":\"Z\","
						+ "\"modifier\":\"client-modifier\",\"department\":\"\"}");

		assertEquals(200, response.status());
		assertTrue(response.body().startsWith("{\"ok\":true,\"changes\":"), "성공 응답은 {ok,changes}다");

		String contents = objectAt(get(sessionId, articleId).body(), "\"contents\":");
		assertTrue(contents.contains("\"title\":\"" + newTitle + "\""), "화이트리스트 안 필드는 반영된다");
		assertTrue(contents.contains("\"status\":\"RDS\""), "status는 전이 라우트만 바꾼다: " + contents);
		assertTrue(contents.contains("\"sender\":null"), "sender는 클라 입력으로 채워지지 않는다");
		assertTrue(contents.contains("\"articleId\":\"" + articleId + "\""), "articleId는 바뀌지 않는다");
		assertTrue(contents.contains("\"modifier\":\"ac-r\""), "modifier는 클라 값이 아니라 세션 사용자다");
		assertFalse(contents.contains("client-modifier"), "클라 modifier가 저장되면 감사 위조가 성립한다");
		assertTrue(contents.contains("\"department\":\"사회부\""), "빈 부서는 세션 부서로 보정된다");
		assertTrue(contents.contains("\"departmentCode\":\"SOC\""));
	}

	// --- 8. 미인증 3라우트 401(탭 헤더는 인증 수단이 아니다) ---------------------------------------

	@Test
	void allThreeRoutesAre401JsonWithoutASessionAndTheTabHeaderIsNotACredential() {
		String sessionId = login("ac-r");
		String articleId = createArticle(sessionId, unique("crud-title"));

		Wire.Response create = Wire.json(this.port, "POST", "/api/articles", Map.of(), "{\"title\":\"x\"}");
		Wire.Response read = Wire.send(this.port, "GET", "/api/articles/" + articleId);
		Wire.Response write = Wire.json(this.port, "PUT", "/api/articles/" + articleId, Map.of(), "{\"title\":\"x\"}");
		Wire.Response tabOnly = Wire.json(this.port, "PUT", "/api/articles/" + articleId,
				Map.of("x-edit-client", unique("tab")), "{\"title\":\"x\"}");
		Wire.Response deadToken = Wire.send(this.port, "GET", "/api/articles/" + articleId,
				Map.of("x-session-id", "0".repeat(64)), null);

		for (Wire.Response denied : List.of(create, read, write, tabOnly, deadToken)) {
			assertEquals(401, denied.status(), "미인증 요청이 핸들러에 도달했다");
			assertEquals(UNAUTHENTICATED, denied.body());
			assertEquals(JSON_CONTENT_TYPE, denied.line("content-type"));
		}
	}

	// --- 9. 인코딩·경로 파라미터(미인증이면 401 · 인증되면 정상 동작) ------------------------------

	@Test
	void encodedAndParameterizedPathsAreGuardedButStillWorkForAuthenticatedRequests() {
		String sessionId = login("ac-r");
		String articleId = createArticle(sessionId, unique("crud-title"));
		String encoded = "/api/artic%6Ces/" + articleId;
		String parameterized = "/api/articles/" + articleId + ";v=2";

		assertEquals(401, Wire.send(this.port, "GET", encoded).status(), "인코딩 경로로 게이트를 우회할 수 없다");
		assertEquals(UNAUTHENTICATED, Wire.send(this.port, "GET", encoded).body());
		assertEquals(401, Wire.send(this.port, "GET", parameterized).status(),
				"경로 파라미터로 게이트를 우회할 수 없다");
		assertEquals(401, Wire.json(this.port, "POST", "/api/artic%6Ces", Map.of(), "{}").status());
		assertEquals(401, Wire.json(this.port, "PUT", encoded, Map.of(), "{}").status());

		Wire.Response encodedRead = Wire.send(this.port, "GET", encoded,
				Map.of("x-session-id", sessionId), null);
		Wire.Response parameterizedRead = Wire.send(this.port, "GET", parameterized,
				Map.of("x-session-id", sessionId), null);

		// 인증된 요청까지 막으면 과잉 차단이다. Spring 디스패처는 세그먼트를 디코딩하고 `;k=v`를 떼어내고
		// 라우팅하므로 두 요청 모두 핸들러에 도달한다(Node는 원문 매칭이라 404다 — 계약이 관측하지 않는
		// divergence이며 step12 forward_notes로 인계한다. 여기서는 관측만 잠근다).
		assertEquals(200, encodedRead.status(), "인코딩 방어가 인증된 요청까지 막으면 과잉 차단이다");
		assertTrue(objectAt(encodedRead.body(), "\"contents\":").contains("\"articleId\":\"" + articleId + "\""));
		assertEquals(200, parameterizedRead.status());
		assertTrue(objectAt(parameterizedRead.body(), "\"contents\":").contains("\"articleId\":\"" + articleId + "\""),
				"경로 파라미터는 id에 섞이지 않는다");
	}

	// --- 10. Content-Type 원문(세미콜론 뒤 공백 1바이트 포함) --------------------------------------

	@Test
	void everyResponseCarriesTheExactContentTypeString() {
		String sessionId = login("ac-r");
		String articleId = createArticle(sessionId, unique("crud-title"));

		List<Wire.Response> responses = List.of(
				Wire.json(this.port, "POST", "/api/articles", Map.of("x-session-id", sessionId),
						"{\"title\":\"" + unique("crud-title") + "\"}"),
				get(sessionId, articleId),
				get(sessionId, NO_SUCH_ARTICLE),
				put(sessionId, unique("tab"), articleId, "{\"title\":\"x\"}"));

		for (Wire.Response response : responses) {
			assertEquals(JSON_CONTENT_TYPE, response.line("content-type"),
					"MVC 메시지 컨버터로 반환하면 세미콜론 뒤 공백이 사라져 전 관측이 diff가 된다");
			assertEquals(1, response.lines("content-type").size(), "Content-Type이 두 번 실렸다");
		}
	}

	// --- 도구 ------------------------------------------------------------------------------------

	private Wire.Response get(String sessionId, String articleId) {
		return Wire.send(this.port, "GET", "/api/articles/" + articleId,
				Map.of("x-session-id", sessionId), null);
	}

	private Wire.Response put(String sessionId, String clientId, String articleId, String body) {
		return Wire.json(this.port, "PUT", "/api/articles/" + articleId,
				Map.of("x-session-id", sessionId, "x-edit-client", clientId), body);
	}

	/** 픽스처 기사 1건 — 생성 라우트로 만든다(이 step이 만드는 표면을 픽스처로도 쓴다). */
	private String createArticle(String sessionId, String title) {
		Wire.Response response = Wire.json(this.port, "POST", "/api/articles",
				Map.of("x-session-id", sessionId),
				"{\"title\":\"" + title + "\",\"markupVersion\":\"" + escaped(markupText("픽스처 본문.")) + "\"}");
		return articleIdOf(response);
	}

	private static String articleIdOf(Wire.Response response) {
		Matcher matcher = CREATED.matcher(response.body());
		assertTrue(matcher.matches(),
				"생성 응답은 {ok:true, articleId} 2키이고 articleId는 AKR + 8자리 날짜 + 9자리 난수다: "
						+ response.status() + " " + response.body());
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

	/** 저장될 본문 마크업 원문(JSON 문서). */
	private static String markupText(String text) {
		return "{\"blocks\":[{\"type\":\"text\",\"text\":\"" + text + "\"}]}";
	}

	/** JSON <b>문자열 값</b>으로 실을 수 있게 이스케이프한 형태(요청·응답 양쪽에서 같은 문자열이다). */
	private static String escaped(String raw) {
		return raw.replace("\\", "\\\\").replace("\"", "\\\"");
	}

	/**
	 * {@code marker} 뒤에 오는 JSON 객체 원문. 문자열 리터럴 안의 중괄호를 세지 않는다
	 * ({@code markupVersion} 값이 이스케이프된 JSON 문서라 순진한 괄호 세기는 어긋난다).
	 */
	private static String objectAt(String body, String marker) {
		int at = body.indexOf(marker);
		assertTrue(at >= 0, marker + " 키가 응답에 없다: " + body);
		int start = body.indexOf('{', at + marker.length() - 1);
		int depth = 0;
		boolean inString = false;
		boolean escape = false;
		for (int i = start; i < body.length(); i++) {
			char c = body.charAt(i);
			if (escape) {
				escape = false;
			}
			else if (c == '\\') {
				escape = true;
			}
			else if (c == '"') {
				inString = !inString;
			}
			else if (!inString && c == '{') {
				depth++;
			}
			else if (!inString && c == '}') {
				depth--;
				if (depth == 0) {
					return body.substring(start, i + 1);
				}
			}
		}
		fail("닫히지 않은 JSON 객체: " + body);
		return null;
	}

	/** 객체 <b>최상위</b> 키를 등장 순서대로 뽑는다(중첩 객체·이스케이프된 문서 안의 키는 세지 않는다). */
	private static List<String> topLevelKeys(String object) {
		List<String> keys = new ArrayList<>();
		int depth = 0;
		boolean escape = false;
		for (int i = 0; i < object.length(); i++) {
			char c = object.charAt(i);
			if (escape) {
				escape = false;
			}
			else if (c == '\\') {
				escape = true;
			}
			else if (c == '"') {
				int end = i + 1;
				boolean skip = false;
				while (end < object.length()) {
					char inner = object.charAt(end);
					if (skip) {
						skip = false;
					}
					else if (inner == '\\') {
						skip = true;
					}
					else if (inner == '"') {
						break;
					}
					end++;
				}
				if (depth == 1 && end + 1 < object.length() && object.charAt(end + 1) == ':') {
					keys.add(object.substring(i + 1, end));
				}
				i = end;
			}
			else if (c == '{' || c == '[') {
				depth++;
			}
			else if (c == '}' || c == ']') {
				depth--;
			}
		}
		return keys;
	}
}
