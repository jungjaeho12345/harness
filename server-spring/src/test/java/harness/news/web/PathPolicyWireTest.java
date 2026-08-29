package harness.news.web;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import harness.news.service.UserService;
import harness.news.testsupport.TempNewsDb;
import harness.news.testsupport.Wire;
import java.nio.file.Path;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;

/**
 * 경로 정책 필터의 <b>와이어</b> 계약 — 선언된 보호 경로는 미인증이면 401 JSON이다.
 *
 * <p>보호 경로의 401은 <b>핸들러가 있든 없든</b> 이 필터가 만든다(phase 69는 39 라우트 중 11개만
 * 구현했고 {@code GET /api/articles}에도 아직 핸들러가 없다). 그리고
 * {@code session-guard.contract.js}의 마지막 케이스는 죽은 토큰으로 {@code GET /api/articles}를 호출해
 * <b>401 {@code {ok:false, reason:'unauthenticated'}}</b>를 요구한다 — 그 401을 만드는 것이 이 필터다
 * (스텁 핸들러가 아니라 경계 정책이며, Node가 라우트 내부 세션 검사로 만드는 결과와 동형이다).
 *
 * <p>동시에 <b>넓히면 안 된다</b>: 표에 없는 경로는 그대로 통과시켜 컨테이너 404(비-JSON)로 흘려보내고,
 * {@code auth: "token"} 라우트(수집 2건)는 세션 요구 대상이 아니다.
 */
// app.collection.token을 명시로 비운다 — 개발 머신의 COLLECTION_TOKEN 환경변수가 설정돼 있으면
// 수집 프로브가 401(토큰 불일치)이 되어 "세션 게이트가 붙었다"로 오독된다(판정 입력을 환경에 맡기지 않는다).
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT,
		properties = "app.collection.token=")
class PathPolicyWireTest {

	private static final Path DATA_DIR = TempNewsDb.newDataDir("path-policy-wire");

	private static final Pattern SESSION_ID = Pattern.compile("\"sessionId\":\"([0-9a-f]{64})\"");

	private static final String USER_ID = "policy-r";

	private static final String PASSWORD = "policy-pw-1";

	private static final String UNAUTHENTICATED = "{\"ok\":false,\"reason\":\"unauthenticated\"}";

	@DynamicPropertySource
	static void dataDir(DynamicPropertyRegistry registry) {
		registry.add("app.data-dir", () -> DATA_DIR.toAbsolutePath().toString());
	}

	@Value("${local.server.port}")
	private int port;

	@Autowired
	private UserService users;

	@BeforeEach
	void seedFixture() {
		Map<String, Object> dto = new LinkedHashMap<>();
		dto.put("userId", USER_ID);
		dto.put("password", PASSWORD);
		dto.put("role", "R");
		dto.put("name", "정책");
		try {
			this.users.create(dto);
		}
		catch (RuntimeException ignored) {
			// 이미 있다 — 픽스처는 멱등이다(행을 지우지 않는다).
		}
	}

	private String login() {
		Wire.Response response = Wire.json(this.port, "POST", "/api/login", Map.of(),
				"{\"userId\":\"" + USER_ID + "\",\"password\":\"" + PASSWORD + "\"}");
		Matcher matcher = SESSION_ID.matcher(response.body());
		assertTrue(matcher.find(), "로그인 응답에 sessionId가 없다: " + response.status());
		return matcher.group(1);
	}

	@Test
	void protectedRouteWithoutSessionIs401JsonEvenWithoutAHandler() {
		Wire.Response response = Wire.send(this.port, "GET", "/api/articles");

		assertEquals(401, response.status());
		assertEquals(UNAUTHENTICATED, response.body());
		assertEquals("Content-Type: application/json; charset=utf-8", response.line("content-type"),
				"401에도 바디가 반드시 있다(바디 없는 401은 SPA를 세션 복원 중에 정지시킨다)");
	}

	@Test
	void deadTokenOnAProtectedRouteIs401() {
		String sessionId = login();
		Wire.send(this.port, "POST", "/api/logout", Map.of("x-session-id", sessionId), null);

		Wire.Response response = Wire.send(this.port, "GET", "/api/articles",
				Map.of("x-session-id", sessionId), null);

		assertEquals(401, response.status());
		assertEquals(UNAUTHENTICATED, response.body());
	}

	/**
	 * <b>스텁 금지의 와이어 게이트</b> — 구현하지 않은 라우트는 {@code ok:true} 스텁이 아니라 정직한 404다.
	 *
	 * <p>프로브 경로는 <b>구현 중인 도메인 밖</b>이어야 한다. phase 69 step7이 {@code POST /api/articles}를
	 * 붙이는 순간 이 프로브가 쓰던 {@code GET /api/articles}는 <b>405</b>가 됐다(경로에 매핑은 있고 메서드가
	 * 없다 → Boot {@code /error} JSON. 2026-08-21 실측: {@code expected: <404> but was: <405>}), 그리고
	 * step11에서 목록이 구현되면 200이 된다. 그래서 <b>phase 69 내내 미구현으로 남는</b>
	 * {@code GET /api/media/search}(미디어 도메인 phase 소유 — index.json excluded (b))로 재조준했다.
	 *
	 * <p>이 단언을 지우거나 405를 허용으로 넓히지 마라: 그러면 스텁 0을 지키는 와이어 게이트가 사라진다.
	 * 미디어 라우트를 구현하는 phase는 <b>같은 규율로</b> 다시 미구현 라우트를 골라 재조준하면 된다.
	 *
	 * <p><b>재조준 이력 2회차(phase 73 step9)</b>: 그 phase가 {@code GET /api/media/search}를 구현하면서
	 * 프로브를 <b>{@code GET /api/stream}</b>으로 옮겼다. 조건은 phase 69 때와 같다 — {@code RoutePolicy}에
	 * {@code AuthClass.SESSION}으로 등재돼 있어 <b>인증된</b> 요청이 필터를 통과하고, 핸들러가 없어
	 * 컨테이너 404 {@code text/html}이 된다(경로에 다른 메서드 핸들러가 없으므로 405도 아니다).
	 *
	 * <p><b>다음에 옮길 사람을 위한 규칙</b>(index.json decisions (9)): SSE phase가 {@code stream}을
	 * 구현하면 인벤토리 39 라우트 안에 남는 후보는 {@code GET /api/logs/stream} <b>하나</b>이고, 그마저
	 * 구현되면 <b>인벤토리 안에는 후보가 없다</b>. 그때는 인벤토리 밖 경로({@code /api/undefined-route}
	 * 계열)로 옮기되, 그 순간 이 프로브의 의미가 "스텁 금지"에서 "미정의 경로 404 shape"으로 <b>바뀐다</b>는
	 * 것을 명시하고 옮겨라(그 판단은 마지막 phase의 소유다).
	 */
	@Test
	void authenticatedRequestToAnUnimplementedRouteIs404NotAStub() {
		Wire.Response response = Wire.send(this.port, "GET", "/api/stream",
				Map.of("x-session-id", login()), null);

		assertEquals(404, response.status(), "구현하지 않은 라우트는 정직하게 404다(스텁 금지)");
		assertEquals("Content-Type: text/html; charset=utf-8", response.line("content-type"));
	}

	@Test
	void sessionCookieIsAcceptedByTheFilterToo() {
		Wire.Response response = Wire.send(this.port, "GET", "/api/session",
				Map.of("Cookie", "sid=" + login()), null);

		assertEquals(200, response.status(), "필터는 인증된 요청을 통과시킨다");
	}

	@Test
	void trailingSlashDoesNotBypassTheGuard() {
		Wire.Response response = Wire.send(this.port, "GET", "/api/articles/");

		assertEquals(401, response.status(), "후행 슬래시로 보호 경로를 우회할 수 있으면 안 된다");
	}

	@Test
	void headOnAProtectedRouteIsGuardedLikeGet() {
		// express는 HEAD를 GET 핸들러로 라우팅한다 — Node 실측도 401이다.
		Wire.Response response = Wire.send(this.port, "HEAD", "/api/articles");

		assertEquals(401, response.status());
	}

	@Test
	void publicRoutesAreNotGuarded() {
		Wire.Response response = Wire.json(this.port, "POST", "/api/login", Map.of(),
				"{\"userId\":\"nobody\",\"password\":\"nope\"}");

		assertEquals(401, response.status());
		assertEquals("{\"ok\":false,\"reason\":\"invalid-credentials\"}", response.body(),
				"public 라우트가 필터에 가로채이면 사유 토큰이 unauthenticated로 바뀐다");
	}

	@Test
	void tokenClassRoutesAreNotSessionGuarded() {
		// auth: "token"(수집 2건)은 x-collection-token + loopback으로 인증한다 — 세션이 없는 것이 정상이다.
		// 뭉뚱그려 세션을 요구하면 유효 토큰에도 401이 나고 수집 계약 3파일이 전부 red가 된다.
		// phase 71 step5 전까지는 핸들러가 없어 404였다. 지금은 요청이 서비스까지 가서
		// 403 unregistered가 된다 — 그 사실 자체가 "필터가 세션을 요구하지 않았다"는 증거다.
		// (이 컨텍스트는 loopback 바인딩 + 토큰 미설정이라 수집 게이트가 열려 있다.)
		Wire.Response receive = Wire.json(this.port, "POST", "/api/collection/receive", Map.of(), "{}");
		Wire.Response pull = Wire.json(this.port, "POST", "/api/collection/pull", Map.of(), "{}");

		assertNotEquals(401, receive.status(), "collection-receive는 세션 요구 대상이 아니다");
		assertNotEquals(401, pull.status(), "collection-pull은 세션 요구 대상이 아니다");
		assertEquals(403, receive.status(), "핸들러까지 도달해 서비스 판정(미등록 403)이 나온다");
		assertEquals(403, pull.status());
	}

	@Test
	void percentEncodedProtectedPathDoesNotBypassTheGuard() {
		// Spring 디스패처는 세그먼트를 디코딩해 핸들러를 찾는다(express는 원문 매칭이라 404다).
		// 필터가 원문만 보면 인코딩 한 글자로 미인증 요청이 필터를 통과하고,
		// phase 69+가 실제 핸들러를 붙이는 순간 그 요청이 핸들러에 도달한다(step7·step8 실측 노출).
		Wire.Response response = Wire.send(this.port, "GET", "/api/artic%6Ces");

		assertEquals(401, response.status(), "인코딩된 보호 경로가 401이 아니면 경로 정책 게이트가 뚫린 것이다");
		assertEquals(UNAUTHENTICATED, response.body());
		assertEquals("Content-Type: application/json; charset=utf-8", response.line("content-type"));
	}

	@Test
	void percentEncodedProtectedPathWithATrailingSlashDoesNotBypassTheGuardEither() {
		Wire.Response response = Wire.send(this.port, "GET", "/api/artic%6Ces/");

		assertEquals(401, response.status());
		assertEquals(UNAUTHENTICATED, response.body());
	}

	@Test
	void percentEncodedProtectedPathStillWorksForAuthenticatedRequests() {
		// 게이트를 넓혔어도 인증된 요청은 그대로 통과한다 — 디스패처가 디코딩해 라우팅하므로 핸들러가 실제로 돈다.
		Wire.Response response = Wire.send(this.port, "GET", "/api/sessio%6E",
				Map.of("x-session-id", login()), null);

		assertEquals(200, response.status(), "인코딩 방어가 인증된 요청까지 막으면 과잉 차단이다");
	}

	@Test
	void percentEncodedUnlistedPathsAreStill404() {
		// 디코딩 판정이 표 밖 경로까지 401로 넓히면 "미정의 경로 = 404 비-JSON" 계약이 깨진다.
		Wire.Response response = Wire.send(this.port, "GET", "/api/does-not-exi%73t");

		assertEquals(404, response.status());
		assertEquals("Content-Type: text/html; charset=utf-8", response.line("content-type"));
	}

	@Test
	void pathParametersDoNotBypassTheGuard() {
		// Spring의 PathContainer는 세그먼트에서 `;name=value`를 떼어내고 매칭한다 → 디스패처는 이 요청을
		// 기사 핸들러로 보낸다. 필터가 원문만 보면 세미콜론 한 글자로 미인증 요청이 필터를 통과하고,
		// phase 69+가 핸들러를 붙이는 순간 그 요청이 핸들러에 도달한다(2026-08-20 실측: 이 요청은 404 HTML이었다).
		Wire.Response response = Wire.send(this.port, "GET", "/api/articles;a=b");

		assertEquals(401, response.status(), "경로 파라미터가 붙은 보호 경로가 401이 아니면 게이트가 뚫린 것이다");
		assertEquals(UNAUTHENTICATED, response.body());
		assertEquals("Content-Type: application/json; charset=utf-8", response.line("content-type"));
	}

	@Test
	void pathParametersCombinedWithEncodingDoNotBypassTheGuardEither() {
		Wire.Response encoded = Wire.send(this.port, "GET", "/api/artic%6Ces;a=b");
		Wire.Response withSlash = Wire.send(this.port, "GET", "/api/articles;a=b/");

		assertEquals(401, encoded.status(), "인코딩 + 경로 파라미터를 겹쳐도 게이트는 그대로다");
		assertEquals(UNAUTHENTICATED, encoded.body());
		assertEquals(401, withSlash.status(), "경로 파라미터 + 후행 슬래시도 마찬가지다");
	}

	@Test
	void pathParametersOnAParameterSegmentAreStillGuarded() {
		Wire.Response response = Wire.send(this.port, "GET", "/api/articles/AKR20260101001;v=2");

		assertEquals(401, response.status());
		assertEquals(UNAUTHENTICATED, response.body());
	}

	@Test
	void pathParametersDoNotBlockAuthenticatedRequests() {
		// 게이트를 넓혔어도 인증된 요청은 그대로 통과한다 — 디스패처가 파라미터를 떼어내고 라우팅하므로 핸들러가 돈다.
		Wire.Response response = Wire.send(this.port, "GET", "/api/session;a=b",
				Map.of("x-session-id", login()), null);

		assertEquals(200, response.status(), "파라미터 방어가 인증된 요청까지 막으면 과잉 차단이다");
	}

	@Test
	void unlistedPathsWithPathParametersAreStill404() {
		// 파라미터 제거가 표를 넓혀 미정의 경로까지 401로 만들면 "미정의 경로 = 404 비-JSON" 계약이 깨진다.
		Wire.Response response = Wire.send(this.port, "GET", "/api/nope;a=b");

		assertEquals(404, response.status());
		assertEquals("Content-Type: text/html; charset=utf-8", response.line("content-type"));
	}

	@Test
	void parameterizedProtectedRoutesAreGuarded() {
		Wire.Response get = Wire.send(this.port, "GET", "/api/articles/AKR20260101001");
		Wire.Response history = Wire.send(this.port, "GET", "/api/articles/AKR20260101001/history");
		Wire.Response update = Wire.json(this.port, "PUT", "/api/users/someone", Map.of(), "{}");

		assertEquals(401, get.status());
		assertEquals(401, history.status());
		assertEquals(401, update.status(), "admin 라우트도 미인증이면 401이다(역할 판정은 라우트가 한다)");
	}
}
