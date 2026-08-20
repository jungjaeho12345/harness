package harness.news.web;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;

import harness.news.testsupport.TempNewsDb;
import harness.news.testsupport.Wire;
import java.nio.file.Path;
import java.util.Arrays;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;

/**
 * CORS allowlist·preflight의 <b>와이어</b> 계약.
 *
 * <p>기준값은 Node 실측이다(2026-08-20, {@code contract-run.mjs --profile default --files crosscutting} 리포트 +
 * 같은 프로파일 서버에 대한 원시 프로브):
 * <pre>
 * 허용 출처 preflight : 204
 *   Access-Control-Allow-Origin: http://localhost:5173      (요청 Origin 반향)
 *   Access-Control-Allow-Credentials: true
 *   Access-Control-Allow-Methods: GET,POST,PUT,DELETE,OPTIONS
 *   Access-Control-Allow-Headers: Content-Type,x-session-id,x-collection-token,x-edit-client
 *   Vary: Origin
 * 비허용 출처 preflight : 204 (ACAO <b>부재</b>, ACAC·ACAM·ACAH는 그대로 실린다)
 * </pre>
 *
 * <p><b>상태코드 204는 계약이다.</b> 계약 케이스는 {@code status < 300}으로만 보지만 리포트 diff
 * ({@code scripts/contract-diff.mjs})는 {@code status}를 정확 비교한다 — 200을 내면 기능 green·패리티 red다.
 *
 * <p><b>preflight는 핸들러 존재와 무관하다.</b> 계약 케이스가 preflight를 검증하는 경로
 * ({@code OPTIONS /api/articles})는 이 phase에 핸들러가 없다. MVC 기본 preflight 처리에 맡기면 404가 나므로
 * 서블릿 필터가 직접 응답을 끝낸다.
 */
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
class CorsWireTest {

	private static final Path DATA_DIR = TempNewsDb.newDataDir("cors-wire");

	/** 비프로덕션 기본 allowlist(server/index.js DEFAULT_ALLOWED_ORIGINS). */
	private static final String ALLOWED_ORIGIN = "http://localhost:5173";

	private static final String ALLOWED_ORIGIN_2 = "http://127.0.0.1:5173";

	private static final String FOREIGN_ORIGIN = "http://evil.example";

	/** 허용 요청 헤더 4종 — 소문자 정렬 비교(계약 케이스와 같은 규칙). */
	private static final List<String> ALLOWED_REQUEST_HEADERS =
			List.of("content-type", "x-collection-token", "x-edit-client", "x-session-id");

	@DynamicPropertySource
	static void dataDir(DynamicPropertyRegistry registry) {
		registry.add("app.data-dir", () -> DATA_DIR.toAbsolutePath().toString());
	}

	@Value("${local.server.port}")
	private int port;

	private Wire.Response preflight(String path, String origin) {
		return Wire.send(this.port, "OPTIONS", path,
				Map.of("Origin", origin, "Access-Control-Request-Method", "GET"), null);
	}

	private static List<String> headerSet(String value) {
		return Arrays.stream(String.valueOf(value).split(","))
				.map(part -> part.trim().toLowerCase(Locale.ROOT))
				.filter(part -> !part.isEmpty())
				.sorted()
				.toList();
	}

	@Test
	void allowlistedPreflightIs204WithEchoedOriginCredentialsAndExactlyFourAllowedHeaders() {
		Wire.Response response = preflight("/api/articles", ALLOWED_ORIGIN);

		assertEquals(204, response.status(), "Node 실측 preflight 상태는 204다(2xx 아무 값이나가 아니다)");
		assertEquals(ALLOWED_ORIGIN, response.value("access-control-allow-origin"),
				"허용 출처에는 요청 Origin을 그대로 반향한다");
		assertEquals("true", response.value("access-control-allow-credentials"));
		assertEquals(ALLOWED_REQUEST_HEADERS, headerSet(response.value("access-control-allow-headers")),
				"허용 헤더 집합은 정확히 4종이다");
		assertEquals("GET,POST,PUT,DELETE,OPTIONS", response.value("access-control-allow-methods"));
		assertEquals("Origin", response.value("vary"));
		assertEquals("", response.body(), "preflight 응답에는 본문이 없다");
	}

	@Test
	void theSecondNonProductionDefaultOriginIsAlsoAllowlisted() {
		Wire.Response response = preflight("/api/articles", ALLOWED_ORIGIN_2);

		assertEquals(204, response.status());
		assertEquals(ALLOWED_ORIGIN_2, response.value("access-control-allow-origin"));
	}

	@Test
	void foreignPreflightIs204WithoutAllowOriginButKeepsCredentials() {
		Wire.Response response = preflight("/api/articles", FOREIGN_ORIGIN);

		assertEquals(204, response.status(), "비허용 출처 preflight는 403이 아니라 2xx다(판독 차단은 브라우저가 한다)");
		assertNull(response.value("access-control-allow-origin"), "ACAO 부재가 판독 차단의 수단이다");
		assertEquals("true", response.value("access-control-allow-credentials"),
				"ACAC는 비허용 출처에도 실린다(Node 실측의 비대칭)");
		assertEquals(ALLOWED_REQUEST_HEADERS, headerSet(response.value("access-control-allow-headers")));
	}

	@Test
	void preflightIsAnsweredOnPathsThatHaveNoHandler() {
		Wire.Response response = preflight("/api/does-not-exist", ALLOWED_ORIGIN);

		assertEquals(204, response.status(), "preflight를 핸들러 매핑에 의존시키면 미구현 경로에서 404가 난다");
		assertEquals(ALLOWED_ORIGIN, response.value("access-control-allow-origin"));
	}

	@Test
	void actualRequestFromAnAllowlistedOriginCarriesAllowOrigin() {
		Wire.Response response = Wire.send(this.port, "GET", "/api/health",
				Map.of("Origin", ALLOWED_ORIGIN), null);

		assertEquals(200, response.status());
		assertEquals(ALLOWED_ORIGIN, response.value("access-control-allow-origin"));
		assertEquals("true", response.value("access-control-allow-credentials"));
	}

	@Test
	void actualRequestFromAForeignOriginGetsNoAllowOrigin() {
		Wire.Response response = Wire.send(this.port, "GET", "/api/health",
				Map.of("Origin", FOREIGN_ORIGIN), null);

		assertEquals(200, response.status(), "CORS는 요청 실행을 막지 않는다 — 응답 판독만 막는다");
		assertNull(response.value("access-control-allow-origin"));
	}
}
