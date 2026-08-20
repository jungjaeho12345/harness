package harness.news.controller;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import harness.news.service.UserService;
import harness.news.testsupport.MutableClock;
import harness.news.testsupport.TempNewsDb;
import harness.news.testsupport.Wire;
import java.nio.file.Path;
import java.time.Clock;
import java.time.Instant;
import java.util.LinkedHashMap;
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
 * 인증 3라우트(POST /api/login · POST /api/logout · GET /api/session)의 <b>와이어</b> 계약 테스트
 * — 비프로덕션(dev) 쿠키 변형.
 *
 * <p>판정 대상은 동작이 아니라 바이트다: 상태코드 · 본문 문자열 · Set-Cookie 속성 <b>순서와 표기</b>.
 * 기준값은 Node 리포트 실측이다(2026-08-20, {@code scripts/contract-run.mjs --profile default}):
 * <pre>
 * content-type : application/json; charset=utf-8
 * set-cookie   : sid=&lt;값&gt;; Max-Age=3600; Path=/; HttpOnly; SameSite=Lax   (발급)
 *                sid=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax            (만료)
 * </pre>
 * 계약 케이스는 Set-Cookie를 속성 단위로 <b>파싱해서</b> 보므로 순서가 뒤바뀌어도 통과한다 —
 * 그러나 계약 리포트 diff는 문자열을 그대로 비교하므로 순서가 다르면 패리티가 깨진다. 그래서
 * 여기서는 문자열 전체를 정확 비교한다(기능 green과 바이트 green은 다른 사건이다).
 *
 * <p>DB는 이 클래스 전용 임시 사본이다 — 리포 {@code news.db}는 열지 않고, 픽스처 계정도 지우지 않는다.
 */
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
class AuthWireTest {

	private static final Path DATA_DIR = TempNewsDb.newDataDir("auth-wire");

	private static final Pattern SESSION_ID = Pattern.compile("\"sessionId\":\"([0-9a-f]{64})\"");

	private static final String PASSWORD = "wire-pw-1";

	/**
	 * 이 클래스는 로그인을 10회 넘게 한다 — step7의 IP 레이트리밋(15분/10회, 프로세스 로컬)에 그대로 걸린다.
	 * 한도·창은 계약값이라 프로퍼티로 끌 수 없으므로(그렇게 만들면 어느 배포에서 계약이 성립하는지가 설정에
	 * 달린다), 테스트마다 <b>창을 넘겨</b> 예산을 리셋한다. 시각을 주입 시계로만 읽는다는 규율(decisions (14))이
	 * 있어서 가능한 방법이다.
	 */
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

	@Autowired
	private UserService users;

	/** 로그인 예산 리셋 — 위 상수의 주석 참조. 계정 잠금(423)도 함께 풀려 테스트 간 독립성이 커진다. */
	@BeforeEach
	void freshLoginBudget() {
		CLOCK.advance(RATE_LIMIT_WINDOW_MS + 1);
	}

	@BeforeEach
	void seedFixtures() {
		ensureUser("wire-r", Map.of("role", "R", "name", "기자", "department", "취재부", "departmentCode", "D1"));
		ensureUser("wire-null", Map.of("role", "D", "name", "부서없음"));
		ensureUser("wire-inactive", Map.of("role", "R", "name", "비활성"));
		ensureUser("wire-lock", Map.of("role", "R", "name", "잠금대상"));
		ensureUser("wire-relogin", Map.of("role", "R", "name", "재로그인"));
		ensureUser("wire-logout", Map.of("role", "R", "name", "로그아웃"));
		ensureUser("wire-logout-body", Map.of("role", "R", "name", "본문로그아웃"));
		ensureUser("wire-cookie", Map.of("role", "R", "name", "쿠키우선"));
	}

	private void ensureUser(String userId, Map<String, Object> fields) {
		Map<String, Object> dto = new LinkedHashMap<>(fields);
		dto.put("userId", userId);
		dto.put("password", PASSWORD);
		try {
			this.users.create(dto);
		}
		catch (RuntimeException ignored) {
			// 이미 있다(같은 컨텍스트의 다른 테스트가 만들었다) — 픽스처는 멱등이다.
		}
	}

	private Wire.Response login(String userId, String password) {
		return Wire.json(this.port, "POST", "/api/login", Map.of(),
				"{\"userId\":\"" + userId + "\",\"password\":\"" + password + "\"}");
	}

	private String sessionIdOf(Wire.Response response) {
		Matcher matcher = SESSION_ID.matcher(response.body());
		assertTrue(matcher.find(), "응답에 64-hex sessionId가 없다: " + response.body());
		return matcher.group(1);
	}

	@Test
	void loginSuccessReturns200WithSessionIdAndSixKeyUser() {
		Wire.Response response = login("wire-r", PASSWORD);

		assertEquals(200, response.status());
		String sessionId = sessionIdOf(response);
		assertEquals("{\"ok\":true,\"sessionId\":\"" + sessionId + "\","
				+ "\"user\":{\"userId\":\"wire-r\",\"name\":\"기자\",\"role\":\"R\","
				+ "\"department\":\"취재부\",\"departmentCode\":\"D1\",\"active\":\"Y\"}}",
				response.body(), "로그인 응답 user는 SAFE_FIELDS 6키(active 포함)다");
	}

	@Test
	void loginIssuesSessionCookieWithTheExactNodeAttributeString() {
		Wire.Response response = login("wire-r", PASSWORD);
		String sessionId = sessionIdOf(response);

		assertEquals(1, response.lines("set-cookie").size(), "세션 쿠키는 한 줄이다");
		assertEquals("sid=" + sessionId + "; Max-Age=3600; Path=/; HttpOnly; SameSite=Lax",
				response.value("set-cookie"),
				"발급 쿠키 문자열이 Node 실측과 바이트 동일해야 한다(속성 순서 포함)");
	}

	@Test
	void sessionAcceptsHeaderFallbackAndReturnsExactlyFiveKeyUser() {
		String sessionId = sessionIdOf(login("wire-r", PASSWORD));

		Wire.Response response = Wire.send(this.port, "GET", "/api/session",
				Map.of("x-session-id", sessionId), null);

		assertEquals(200, response.status());
		assertEquals("{\"ok\":true,\"user\":{\"userId\":\"wire-r\",\"role\":\"R\","
				+ "\"department\":\"취재부\",\"departmentCode\":\"D1\",\"name\":\"기자\"}}",
				response.body(), "세션 응답 user는 정확히 5키다(active 없음)");
	}

	@Test
	void nullColumnsStayAsJsonNullInBothShapes() {
		Wire.Response loginResponse = login("wire-null", PASSWORD);
		String sessionId = sessionIdOf(loginResponse);

		assertTrue(loginResponse.body().contains("\"department\":null,\"departmentCode\":null,\"active\":\"Y\""),
				"부서가 비어 있어도 키는 남고 값만 null이다(6키 유지): " + loginResponse.body());

		Wire.Response session = Wire.send(this.port, "GET", "/api/session",
				Map.of("x-session-id", sessionId), null);
		assertEquals("{\"ok\":true,\"user\":{\"userId\":\"wire-null\",\"role\":\"D\","
				+ "\"department\":null,\"departmentCode\":null,\"name\":\"부서없음\"}}",
				session.body(), "NULL 부서 계정도 정확히 5키여야 한다(키 제거 금지)");
	}

	@Test
	void sessionAcceptsCookieTransport() {
		String sessionId = sessionIdOf(login("wire-cookie", PASSWORD));

		Wire.Response response = Wire.send(this.port, "GET", "/api/session",
				Map.of("Cookie", "other=1; sid=" + sessionId + "; another=2"), null);

		assertEquals(200, response.status());
		assertTrue(response.body().contains("\"userId\":\"wire-cookie\""), response.body());
	}

	@Test
	void cookieWinsOverHeaderInBothDirections() {
		String sessionId = sessionIdOf(login("wire-cookie", PASSWORD));

		Map<String, String> cookieValidHeaderGarbage = new LinkedHashMap<>();
		cookieValidHeaderGarbage.put("Cookie", "sid=" + sessionId);
		cookieValidHeaderGarbage.put("x-session-id", "not-a-real-token");
		assertEquals(200, Wire.send(this.port, "GET", "/api/session", cookieValidHeaderGarbage, null).status(),
				"쿠키가 우선이므로 헤더가 쓰레기여도 통과한다");

		Map<String, String> cookieGarbageHeaderValid = new LinkedHashMap<>();
		cookieGarbageHeaderValid.put("Cookie", "sid=not-a-real-token");
		cookieGarbageHeaderValid.put("x-session-id", sessionId);
		assertEquals(401, Wire.send(this.port, "GET", "/api/session", cookieGarbageHeaderValid, null).status(),
				"쿠키가 있으면 헤더는 보지 않는다(우선순위가 계약이다)");
	}

	@Test
	void queryParameterFallbackIsAbsent() {
		String sessionId = sessionIdOf(login("wire-r", PASSWORD));

		Wire.Response response = Wire.send(this.port, "GET", "/api/session?session=" + sessionId);

		assertEquals(401, response.status(), "?session= 쿼리 폴백은 부재가 계약이다(URL·로그 누출 표면)");
		assertEquals("{\"ok\":false,\"reason\":\"unauthenticated\"}", response.body());
	}

	@Test
	void sessionWithoutCredentialsIs401WithJsonBody() {
		Wire.Response response = Wire.send(this.port, "GET", "/api/session");

		assertEquals(401, response.status());
		assertEquals("{\"ok\":false,\"reason\":\"unauthenticated\"}", response.body(),
				"바디 없는 401은 계약 위반이다 — 클라이언트는 상태코드가 아니라 본문 ok/reason을 읽는다");
	}

	@Test
	void malformedTokenIs401NotServerError() {
		Wire.Response response = Wire.send(this.port, "GET", "/api/session",
				Map.of("x-session-id", "not-a-real-token"), null);

		assertEquals(401, response.status());
		assertEquals("{\"ok\":false,\"reason\":\"unauthenticated\"}", response.body());
	}

	@Test
	void malformedCookieEncodingFallsBackToTheRawValueAndStillFails401() {
		Wire.Response response = Wire.send(this.port, "GET", "/api/session",
				Map.of("Cookie", "sid=%zz-broken"), null);

		assertEquals(401, response.status(), "퍼센트 인코딩이 망가져도 500이 아니라 401로 수렴한다");
		assertEquals("{\"ok\":false,\"reason\":\"unauthenticated\"}", response.body());
	}

	@Test
	void logoutWithoutAnySessionIs200AndIdempotent() {
		Wire.Response response = Wire.send(this.port, "POST", "/api/logout");

		assertEquals(200, response.status(), "로그아웃은 세션이 없어도 성공한다(멱등)");
		assertEquals("{\"ok\":true}", response.body());
		assertEquals("sid=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax", response.value("set-cookie"),
				"만료 쿠키 문자열도 Node 실측과 바이트 동일해야 한다");
	}

	@Test
	void logoutInvalidatesTheTokenAndClearsTheCookie() {
		String sessionId = sessionIdOf(login("wire-logout", PASSWORD));

		Wire.Response logout = Wire.send(this.port, "POST", "/api/logout",
				Map.of("x-session-id", sessionId), null);
		assertEquals(200, logout.status());
		assertEquals("{\"ok\":true}", logout.body());
		assertEquals("sid=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax", logout.value("set-cookie"));

		assertEquals(401, Wire.send(this.port, "GET", "/api/session",
				Map.of("x-session-id", sessionId), null).status(), "로그아웃한 토큰은 헤더로도 통과하지 못한다");
		assertEquals(401, Wire.send(this.port, "GET", "/api/session",
				Map.of("Cookie", "sid=" + sessionId), null).status(), "쿠키로도 통과하지 못한다");
	}

	@Test
	void logoutReadsSessionIdFromTheBodyWhenNoCookieOrHeader() {
		String sessionId = sessionIdOf(login("wire-logout-body", PASSWORD));

		Wire.Response logout = Wire.json(this.port, "POST", "/api/logout", Map.of(),
				"{\"sessionId\":\"" + sessionId + "\"}");

		assertEquals(200, logout.status());
		assertEquals("{\"ok\":true}", logout.body());
		assertEquals(401, Wire.send(this.port, "GET", "/api/session",
				Map.of("x-session-id", sessionId), null).status(), "body.sessionId 폴백으로도 무효화된다");
	}

	@Test
	void reloginInvalidatesEveryPreviousSessionOfTheSameUser() {
		String first = sessionIdOf(login("wire-relogin", PASSWORD));
		String second = sessionIdOf(login("wire-relogin", PASSWORD));

		assertNotEquals(first, second);
		assertEquals(401, Wire.send(this.port, "GET", "/api/session",
				Map.of("x-session-id", first), null).status(), "단일 세션 정책 — 이전 토큰은 죽는다");
		assertEquals(200, Wire.send(this.port, "GET", "/api/session",
				Map.of("x-session-id", second), null).status());
	}

	@Test
	void unknownAccountAndWrongPasswordShareTheSame401Body() {
		Wire.Response unknown = login("존재하지-않는-계정", PASSWORD);
		Wire.Response wrong = login("wire-r", "틀린비밀번호");

		assertEquals(401, unknown.status());
		assertEquals(401, wrong.status());
		assertEquals("{\"ok\":false,\"reason\":\"invalid-credentials\"}", unknown.body());
		assertEquals(unknown.body(), wrong.body(), "계정 존재 여부가 응답으로 새면 안 된다");
	}

	@Test
	void loginWithoutBodyIs401InvalidCredentials() {
		Wire.Response response = Wire.send(this.port, "POST", "/api/login");

		assertEquals(401, response.status(), "본문 없는 로그인은 400/415가 아니라 자격 실패다(Node 동형)");
		assertEquals("{\"ok\":false,\"reason\":\"invalid-credentials\"}", response.body());
	}

	@Test
	void inactiveAccountIs403WithJsonBody() {
		this.users.update("wire-inactive", Map.of("active", "N"));

		Wire.Response response = login("wire-inactive", PASSWORD);

		assertEquals(403, response.status(), "inactive는 401이 아니라 403이다");
		assertEquals("{\"ok\":false,\"reason\":\"inactive\"}", response.body());
	}

	@Test
	void lockedAccountIs423AfterFiveFailures() {
		for (int attempt = 1; attempt <= 5; attempt++) {
			Wire.Response failure = login("wire-lock", "틀린비밀번호");
			assertEquals(401, failure.status(), "한도 이전 실패는 401이다(시도 " + attempt + ")");
		}

		Wire.Response locked = login("wire-lock", PASSWORD);

		assertEquals(423, locked.status(), "계정 잠금은 로그인 라우트 로컬 매핑으로 423이다(전역 401을 덮어쓴다)");
		assertEquals("{\"ok\":false,\"reason\":\"locked\"}", locked.body());
	}
}
