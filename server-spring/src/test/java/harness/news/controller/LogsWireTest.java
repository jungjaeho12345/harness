package harness.news.controller;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

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
 * {@code GET /api/logs/digest}(Z 전용)의 <b>와이어</b> 계약.
 *
 * <p>이 라우트가 이 phase에 있는 이유는 로그 도메인이 아니라 <b>세션 가드 축</b>이다:
 * {@code contract/cases/default/session-guard.contract.js}가 "갓 로그인한 Z는 200 → 그 계정을 R로
 * 강등하면 <b>재로그인 없이</b> 같은 토큰이 403"을 검증하는 데 이 엔드포인트를 쓴다.
 *
 * <p>동결된 것(계약): 미인증 401 · 비-Z 403 · Z 200 {@code {ok:true, items:[…]}} · 원소는
 * {@code seq·ts·level·message·line} 5키. <b>동결되지 않은 것</b>: 창 경계와 {@code items} 개수 —
 * 계약 스위트는 서버 시계를 주입할 수 없어 갓 기동한 서버에서 항상 빈 배열을 본다. 그래서
 * <b>여기서는 시계를 주입해</b> "창 안에 실제 레코드가 있으면 그것이 나온다"까지 잠근다
 * (하드코딩 {@code items:[]} 스텁으로 계약만 통과시키는 경로를 이 클래스가 막는다).
 *
 * <p>개수는 어디서도 단언하지 않는다 — 버퍼에는 이 클래스의 다른 테스트가 남긴 요청 로그도 섞이므로
 * 판정은 언제나 <b>고유 마커의 존재/부재</b>로 한다.
 */
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
class LogsWireTest {

	private static final Path DATA_DIR = TempNewsDb.newDataDir("logs-wire");

	private static final Pattern SESSION_ID = Pattern.compile("\"sessionId\":\"([0-9a-f]{64})\"");

	/** 응답 {@code items} 원소의 5키 — 키와 순서가 모두 계약이다(openapi.yaml LogRecord). */
	private static final Pattern ITEM = Pattern.compile(
			"\\{\"seq\":\\d+,\"ts\":\\d+,\"level\":\"(?:DEBUG|INFO|WARN|ERROR)\","
					+ "\"message\":\"(?:[^\"\\\\]|\\\\.)*\",\"line\":\"(?:[^\"\\\\]|\\\\.)*\"\\}");

	private static final String PASSWORD = "logs-wire-pw-1";

	private static final String UNAUTHENTICATED = "{\"ok\":false,\"reason\":\"unauthenticated\"}";

	private static final String FORBIDDEN = "{\"ok\":false,\"reason\":\"forbidden\"}";

	private static final long HOUR_MS = 60L * 60L * 1000L;

	private static final long DAY_MS = 24L * HOUR_MS;

	/** step7의 로그인 IP 레이트리밋(15분/10회) 예산을 테스트마다 리셋하기 위한 창 길이. */
	private static final long RATE_LIMIT_WINDOW_MS = 15L * 60L * 1000L;

	private static final MutableClock CLOCK = new MutableClock(Instant.parse("2026-08-20T01:00:00Z").toEpochMilli());

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

	@BeforeEach
	void freshLoginBudget() {
		CLOCK.advance(RATE_LIMIT_WINDOW_MS + 1);
	}

	@BeforeEach
	void seedFixtures() {
		ensureUser("lw-z", "Z");
		ensureUser("lw-r", "R");
		ensureUser("lw-d", "D");
	}

	// --- 인가 3단 --------------------------------------------------------------------------------

	@Test
	void unauthenticatedDigestIs401Json() {
		Wire.Response anonymous = Wire.send(this.port, "GET", "/api/logs/digest");
		Wire.Response dead = Wire.send(this.port, "GET", "/api/logs/digest",
				Map.of("x-session-id", "0".repeat(64)), null);

		assertEquals(401, anonymous.status());
		assertEquals(UNAUTHENTICATED, anonymous.body());
		assertEquals("Content-Type: application/json; charset=utf-8", anonymous.line("content-type"));
		assertEquals(401, dead.status(), "모르는 토큰은 세션이 없는 것과 같다");
		assertEquals(UNAUTHENTICATED, dead.body());
	}

	@Test
	void nonAdminSessionsAreForbidden() {
		for (String userId : List.of("lw-r", "lw-d")) {
			Wire.Response response = digest(login(userId));

			assertEquals(403, response.status(), userId + " 세션은 Z가 아니다 — 로그는 전 사용자 요청 흔적이다");
			assertEquals(FORBIDDEN, response.body());
			assertEquals("Content-Type: application/json; charset=utf-8", response.line("content-type"));
		}
	}

	@Test
	void adminGetsTheFrozenTwoKeyShape() {
		Wire.Response response = digest(login("lw-z"));

		assertEquals(200, response.status());
		assertEquals("Content-Type: application/json; charset=utf-8", response.line("content-type"));
		assertTrue(response.body().startsWith("{\"ok\":true,\"items\":[")
				&& response.body().endsWith("]}"), "본문 키는 정확히 {ok, items}다: " + response.body());
		assertEquals(itemCount(response.body()), countOf(response.body(), "{\"seq\":"),
				"items 원소는 전부 5키 계약을 지켜야 한다");
	}

	// --- 창 안의 실제 레코드(스텁 금지의 잠금) ---------------------------------------------------

	@Test
	void recordsInsideTheWindowAreReturnedNotAHardcodedEmptyList() {
		// 1) 창 안(전날 10:00 KST)에서 요청 2건을 남긴다 — 응답 완료 시점에 요청 로그가 쌓인다.
		CLOCK.setMillis(nextKstHour(10));
		Wire.send(this.port, "GET", "/api/health");
		Wire.send(this.port, "GET", "/api/lw-marker-in-window");

		// 2) 그 창이 닫힌 뒤(다음 06:00 경계 + 1시간)로 시계를 옮기고 조회한다.
		CLOCK.setMillis(nextKstHour(7));
		Wire.Response response = digest(login("lw-z"));

		assertEquals(200, response.status());
		assertTrue(itemCount(response.body()) > 0, "창 안에 레코드가 있는데 빈 배열이면 버퍼를 읽지 않은 것이다");
		assertTrue(response.body().contains("GET /api/health 200 "),
				"요청 로그는 '메서드 경로 상태 소요시간'이다: " + response.body());
		assertTrue(response.body().contains("GET /api/lw-marker-in-window 404 "),
				"거부·미정의 응답도 액세스 로그에 남는다");
		assertTrue(response.body().contains("\"level\":\"INFO\""), "요청 로그는 INFO다");
	}

	@Test
	void requestsMadeAfterTheWindowClosedAreNotInTheDigest() {
		CLOCK.setMillis(nextKstHour(10));
		Wire.send(this.port, "GET", "/api/lw-marker-after-window");

		Wire.Response response = digest(login("lw-z"));

		assertEquals(200, response.status());
		assertFalse(response.body().contains("lw-marker-after-window"),
				"창은 항상 과거 구간이다 — 방금 쌓인 로그는 다음 06:00 이후에야 나온다(갓 기동한 서버가 빈 배열인 이유)");
	}

	// --- 마스킹(LOGS.md) -------------------------------------------------------------------------

	@Test
	void theRequestLogCarriesThePathOnlyNeverTheQueryStringOrHeaders() {
		String token = "a".repeat(64);
		CLOCK.setMillis(nextKstHour(10));
		Wire.send(this.port, "GET", "/api/lw-masked?sid=" + token + "&password=lw-secret-value",
				Map.of("x-session-id", token, "Cookie", "sid=" + token), null);

		CLOCK.setMillis(nextKstHour(7));
		Wire.Response response = digest(login("lw-z"));

		assertTrue(response.body().contains("GET /api/lw-masked 404 "), "경로는 남는다: " + response.body());
		assertFalse(response.body().contains("?"), "쿼리스트링이 버퍼에 들어가면 Z 전용 API로 그대로 나간다");
		assertFalse(response.body().contains("sid="), "세션 토큰 파라미터가 로그에 남았다");
		assertFalse(response.body().contains("lw-secret-value"), "비밀번호 파라미터가 로그에 남았다");
		assertFalse(response.body().contains(token), "세션 토큰이 로그에 남았다");
	}

	@Test
	void theLoginBodyNeverReachesTheLogBuffer() {
		CLOCK.setMillis(nextKstHour(10));
		login("lw-z"); // 본문에 평문 비밀번호가 있는 요청

		CLOCK.setMillis(nextKstHour(7));
		Wire.Response response = digest(login("lw-z"));

		assertTrue(response.body().contains("POST /api/login 200 "), "로그인 요청도 액세스 로그에는 남는다");
		assertFalse(response.body().contains(PASSWORD), "요청 본문은 로그에 담지 않는다");
		assertFalse(response.body().contains("$2a$"), "해시도 로그에 담지 않는다");
	}

	// --- 도구 ------------------------------------------------------------------------------------

	private Wire.Response digest(String sessionId) {
		return Wire.send(this.port, "GET", "/api/logs/digest", Map.of("x-session-id", sessionId), null);
	}

	private String login(String userId) {
		Wire.Response response = Wire.json(this.port, "POST", "/api/login", Map.of(),
				"{\"userId\":\"" + userId + "\",\"password\":\"" + PASSWORD + "\"}");
		Matcher matcher = SESSION_ID.matcher(response.body());
		assertTrue(matcher.find(), "로그인 응답에 sessionId가 없다: status=" + response.status());
		return matcher.group(1);
	}

	/**
	 * 현재 시계 <b>이후</b>로 가장 가까운 KST 정각(hour:00:00.000)의 epoch ms.
	 * 테스트마다 시계가 앞으로만 흐르게 해서 레이트리밋 창·세션 만료가 서로 얽히지 않게 한다.
	 */
	private static long nextKstHour(int hourKst) {
		long kstOffset = 540L * 60L * 1000L;
		long shifted = CLOCK.millis() + kstOffset;
		long midnight = Math.floorDiv(shifted, DAY_MS) * DAY_MS;
		long target = midnight + hourKst * HOUR_MS;
		if (target <= shifted) {
			target += DAY_MS;
		}
		return target - kstOffset;
	}

	private static int itemCount(String body) {
		Matcher matcher = ITEM.matcher(body);
		int count = 0;
		while (matcher.find()) {
			count++;
		}
		return count;
	}

	private static int countOf(String body, String needle) {
		int count = 0;
		int from = 0;
		while ((from = body.indexOf(needle, from)) >= 0) {
			count++;
			from += needle.length();
		}
		return count;
	}

	private void ensureUser(String userId, String role) {
		try {
			Map<String, Object> dto = new LinkedHashMap<>();
			dto.put("userId", userId);
			dto.put("name", userId);
			dto.put("role", role);
			dto.put("password", PASSWORD);
			this.users.create(dto);
		}
		catch (RuntimeException ignored) {
			// 이미 있다(같은 컨텍스트의 다른 테스트가 만들었다) — 픽스처는 멱등이다(행을 지우지 않는다).
		}
	}
}
