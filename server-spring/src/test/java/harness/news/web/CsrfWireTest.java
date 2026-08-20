package harness.news.web;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotEquals;

import harness.news.testsupport.TempNewsDb;
import harness.news.testsupport.Wire;
import java.nio.file.Path;
import java.util.LinkedHashMap;
import java.util.Map;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;

/**
 * CSRF Origin/Referer 가드(ADR-009)의 <b>와이어</b> 계약 — 비프로덕션 변형.
 *
 * <p>판정 순서(server/index.js {@code csrfOriginGuard}와 동형): 상태 변경 메서드만 본다 →
 * Origin → 없으면 Referer의 origin → <b>둘 다 없으면 통과</b>(서버-서버/cron 관용) → 자기 출처면 통과 →
 * allowlist면 통과 → 비프로덕션이면 loopback 관용 → 그 외 403 {@code {ok:false, reason:'forbidden-origin'}}.
 *
 * <p>프로브 라우트는 {@code POST /api/logout}이다 — 토큰을 주지 않으면 아무것도 무효화하지 않고 항상 200이라
 * 게이트가 뚫려 있어도 데이터가 바뀌지 않는다(계약 케이스와 같은 규율).
 *
 * <p><b>자기 출처 판정에 X-Forwarded-Host를 쓰지 않는다</b>는 축을 실기로 잠근다 — 그 헤더를 믿는 순간
 * 게이트 전체가 헤더 한 줄로 우회된다(Node 주석의 CRITICAL).
 */
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
class CsrfWireTest {

	private static final Path DATA_DIR = TempNewsDb.newDataDir("csrf-wire");

	private static final String ALLOWED_ORIGIN = "http://localhost:5173";

	private static final String FOREIGN_ORIGIN = "http://evil.example";

	private static final String FORBIDDEN_BODY = "{\"ok\":false,\"reason\":\"forbidden-origin\"}";

	@DynamicPropertySource
	static void dataDir(DynamicPropertyRegistry registry) {
		registry.add("app.data-dir", () -> DATA_DIR.toAbsolutePath().toString());
	}

	@Value("${local.server.port}")
	private int port;

	private Wire.Response logout(Map<String, String> headers) {
		return Wire.send(this.port, "POST", "/api/logout", headers, null);
	}

	@Test
	void crossOriginStateChangeIs403ForbiddenOriginJson() {
		Wire.Response response = logout(Map.of("Origin", FOREIGN_ORIGIN));

		assertEquals(403, response.status());
		assertEquals(FORBIDDEN_BODY, response.body());
		assertEquals("Content-Type: application/json; charset=utf-8", response.line("content-type"),
				"거부 응답도 Node와 바이트 동일한 JSON Content-Type이어야 한다");
	}

	@Test
	void allowlistedRefererPassesWhenOriginIsAbsent() {
		Wire.Response response = logout(Map.of("Referer", ALLOWED_ORIGIN + "/editor"));

		assertEquals(200, response.status());
		assertEquals("{\"ok\":true}", response.body());
	}

	@Test
	void unparseableRefererIs403() {
		Wire.Response response = logout(Map.of("Referer", "not-a-url"));

		assertEquals(403, response.status());
		assertEquals(FORBIDDEN_BODY, response.body());
	}

	@Test
	void foreignRefererIs403() {
		Wire.Response response = logout(Map.of("Referer", FOREIGN_ORIGIN + "/attack.html"));

		assertEquals(403, response.status());
	}

	@Test
	void absentOriginAndRefererPasses() {
		// 서버-서버/cron 관용 — 계약 스위트 전체가 이 관용 위에서 돈다(fetch는 Origin을 붙이지 않는다).
		Wire.Response response = logout(Map.of());

		assertEquals(200, response.status());
		assertEquals("{\"ok\":true}", response.body());
	}

	@Test
	void selfOriginPasses() {
		Wire.Response response = logout(Map.of("Origin", "http://127.0.0.1:" + this.port));

		assertEquals(200, response.status());
	}

	@Test
	void forgedForwardedHostDoesNotTurnAForeignOriginIntoSelfOrigin() {
		Map<String, String> headers = new LinkedHashMap<>();
		headers.put("Origin", FOREIGN_ORIGIN);
		headers.put("X-Forwarded-Host", "evil.example");
		headers.put("X-Forwarded-Proto", "http");

		Wire.Response response = logout(headers);

		assertEquals(403, response.status(), "X-Forwarded-* 를 자기 출처 판정에 쓰면 게이트가 헤더 한 줄로 뚫린다");
		assertEquals(FORBIDDEN_BODY, response.body());
	}

	@Test
	void loopbackOriginIsToleratedOutsideProduction() {
		// allowlist에 없는 포트여도 통과한다(Vite 포트가 밀리는 dev 배선 — 관용은 loopback 호스트에만 준다).
		Wire.Response response = logout(Map.of("Origin", "http://localhost:59999"));

		assertEquals(200, response.status());
	}

	@Test
	void safeMethodsAreNotGuarded() {
		Wire.Response response = Wire.send(this.port, "GET", "/api/health",
				Map.of("Origin", FOREIGN_ORIGIN), null);

		assertEquals(200, response.status(), "가드는 상태 변경 메서드만 본다");
	}

	@Test
	void crossOriginPreflightIsAnsweredByCorsBeforeTheCsrfGate() {
		Wire.Response response = Wire.send(this.port, "OPTIONS", "/api/logout",
				Map.of("Origin", FOREIGN_ORIGIN, "Access-Control-Request-Method", "POST"), null);

		assertNotEquals(403, response.status(), "preflight(OPTIONS)는 CSRF 가드에 도달하면 안 된다");
		assertEquals(204, response.status());
	}
}
