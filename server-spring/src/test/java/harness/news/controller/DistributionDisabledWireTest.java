package harness.news.controller;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import harness.news.service.SessionGuard;
import harness.news.service.UserService;
import harness.news.testsupport.TempNewsDb;
import harness.news.testsupport.Wire;
import java.nio.file.Path;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;

/**
 * 배부 <b>비활성</b>(스풀 루트 미설정) 서버의 와이어 계약 — {@code minimal} 프로파일의
 * {@code distribution-disabled.contract.js}와 같은 축을 원시 HTTP로 잠근다.
 *
 * <pre>
 * tick     : 미인증 401 · R/D 403 · Z 503 spool-disabled
 * retry    : 미인증 401 · R/D 403 · Z 503(no-failure 404보다 <b>먼저</b> — DB 무접촉)
 * failures : 미인증 401 · R/D 403 · Z <b>200</b>(조회는 스풀 설정과 무관하다)
 * </pre>
 *
 * <p><b>판정 순서가 계약이다</b>: 인가가 스풀 설정보다 먼저다. 비-Z에게 503을 주면 배부 설정 상태가
 * 새어 나간다(계약 케이스 {@code r-session-not-disabled}가 그 순서를 관측한다).
 *
 * <p>스풀 루트는 <b>명시적으로 빈 값</b>으로 고정한다 — 개발 머신에 {@code DIST_SPOOL_DIR}이 설정돼
 * 있으면 이 클래스의 전제가 조용히 무너진다.
 */
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT,
		properties = "app.distribution.spool-dir=")
class DistributionDisabledWireTest {

	private static final Path DATA_DIR = TempNewsDb.newDataDir("distribution-disabled-wire");

	private static final String UNAUTHENTICATED = "{\"ok\":false,\"reason\":\"unauthenticated\"}";

	private static final String FORBIDDEN = "{\"ok\":false,\"reason\":\"forbidden\"}";

	private static final String SPOOL_DISABLED = "{\"ok\":false,\"reason\":\"spool-disabled\"}";

	/** 어떤 서버에서도 미해소 실패로 매치되지 않는 값(계약 케이스와 같은 상수). */
	private static final String ABSENT_HISTORY_ID = "999999999";

	@DynamicPropertySource
	static void dataDir(DynamicPropertyRegistry registry) {
		registry.add("app.data-dir", () -> DATA_DIR.toAbsolutePath().toString());
	}

	@Value("${local.server.port}")
	private int port;

	@Autowired
	private UserService users;

	@Autowired
	private SessionGuard sessions;

	@BeforeEach
	void seedUsers() {
		ensureUser("dd-z", "Z");
		ensureUser("dd-r", "R");
		ensureUser("dd-d", "D");
	}

	// --- 1. 세 라우트 전부 미인증 401 · R 403 · D 403 -----------------------------------------------

	@Test
	void allThreeRoutesAreAdminOnlyAndBodyRoleSpoofingDoesNotHelp() {
		for (String role : List.of("R", "D")) {
			String token = tokenFor(role);
			assertDenied(FORBIDDEN, 403, tick(token, "{\"role\":\"Z\"}"), "tick " + role);
			assertDenied(FORBIDDEN, 403, failures(token, null), "failures " + role);
			assertDenied(FORBIDDEN, 403,
					retry(token, "{\"historyId\":" + ABSENT_HISTORY_ID + ",\"role\":\"Z\"}"), "retry " + role);
		}

		assertDenied(UNAUTHENTICATED, 401, tick(null, null), "tick 미인증");
		assertDenied(UNAUTHENTICATED, 401, failures(null, null), "failures 미인증");
		assertDenied(UNAUTHENTICATED, 401, retry(null, "{\"historyId\":" + ABSENT_HISTORY_ID + "}"),
				"retry 미인증");
	}

	// --- 2. Z: 실행 계열 503 · 조회는 200 -----------------------------------------------------------

	@Test
	void adminGets503ForExecutionRoutesButTheFailureListStillAnswers200() {
		String token = tokenFor("Z");

		Wire.Response ticked = tick(token, null);
		assertEquals(503, ticked.status(), "스풀 미설정 서버의 tick은 503이다");
		assertEquals(SPOOL_DISABLED, ticked.body());

		// 미해소 실패가 없는 historyId지만 404가 아니다 — 설정 판정이 DB 조회보다 먼저다.
		Wire.Response retried = retry(token, "{\"historyId\":" + ABSENT_HISTORY_ID + "}");
		assertEquals(503, retried.status(), "retry는 no-failure(404)보다 먼저 503이다");
		assertEquals(SPOOL_DISABLED, retried.body());

		Wire.Response listed = failures(token, null);
		assertEquals(200, listed.status(), "조회는 스풀 설정과 무관하게 결선된다");
		assertEquals("{\"ok\":true,\"items\":[]}", listed.body());
	}

	// --- 3. 인가가 설정 판정보다 먼저다(403이지 503이 아니다) ---------------------------------------

	@Test
	void authorizationIsDecidedBeforeTheSpoolSettingSoNonAdminsNeverSee503() {
		String token = tokenFor("R");

		Wire.Response ticked = tick(token, "{\"role\":\"Z\"}");
		Wire.Response retried = retry(token, "{\"historyId\":" + ABSENT_HISTORY_ID + ",\"role\":\"Z\"}");

		assertEquals(403, ticked.status(), "비-Z에게 배부 설정 상태(503)를 알려주면 안 된다");
		assertEquals(FORBIDDEN, ticked.body());
		assertEquals(403, retried.status(), "비-Z에게 배부 설정 상태(503)를 알려주면 안 된다");
		assertEquals(FORBIDDEN, retried.body());
	}

	// --- 도구 -------------------------------------------------------------------------------------

	private static void assertDenied(String expectedBody, int expectedStatus, Wire.Response response, String what) {
		assertEquals(expectedStatus, response.status(), what);
		assertEquals(expectedBody, response.body(), what);
		assertTrue(response.line("Content-Type").endsWith("application/json; charset=utf-8"),
				what + " — 거부도 와이어 포맷 단일 지점이다: " + response.line("Content-Type"));
	}

	private Wire.Response tick(String token, String body) {
		return (body == null) ? Wire.send(this.port, "POST", "/api/distribution/tick", headers(token), null)
				: Wire.json(this.port, "POST", "/api/distribution/tick", headers(token), body);
	}

	private Wire.Response failures(String token, String query) {
		String path = "/api/distribution/failures" + ((query == null) ? "" : "?" + query);
		return Wire.send(this.port, "GET", path, headers(token), null);
	}

	private Wire.Response retry(String token, String body) {
		return Wire.json(this.port, "POST", "/api/distribution/retry", headers(token), body);
	}

	private static Map<String, String> headers(String token) {
		return (token == null) ? Map.of() : Map.of("x-session-id", token);
	}

	private String tokenFor(String role) {
		return this.sessions.createSession("dd-" + role.toLowerCase(java.util.Locale.ROOT));
	}

	private void ensureUser(String userId, String role) {
		Map<String, Object> dto = new LinkedHashMap<>();
		dto.put("userId", userId);
		dto.put("name", userId);
		dto.put("role", role);
		dto.put("password", "dd-wire-pw");
		try {
			this.users.create(dto);
		}
		catch (RuntimeException ignored) {
			// 이미 있다 — 픽스처는 멱등이다.
		}
	}

}
