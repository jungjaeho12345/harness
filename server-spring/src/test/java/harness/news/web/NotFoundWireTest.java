package harness.news.web;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import harness.news.testsupport.TempNewsDb;
import harness.news.testsupport.Wire;
import java.nio.file.Path;
import java.util.Map;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;

/**
 * 미정의 경로의 에러 shape — <b>404이고 본문이 JSON이 아니다</b>.
 *
 * <p>Node 실측(2026-08-20): {@code 404} · {@code Content-Type: text/html; charset=utf-8} · express 기본 HTML.
 * "모든 거부는 {@code {ok:false, reason}} JSON"이라는 규칙의 <b>예외 2건 중 하나이며 그 예외 자체가 계약</b>이다
 * (다른 하나는 로그인 레이트리밋 429 — step7). 리포트 diff는 상태 정수와 Content-Type 문자열을 정확 비교하므로
 * Boot 기본 {@code /error}(JSON)로 흘려보내면 패리티가 깨진다.
 *
 * <p><b>본문 문자열은 계약이 아니다</b>(리포트는 bodyKeys만 본다). 그래서 express의 HTML을 그대로 베끼지 않고
 * 요청 경로를 반향하지 않는 고정 HTML을 낸다 — 사용자 입력을 응답 본문에 되돌려주지 않는다는 원칙이 먼저다.
 */
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
class NotFoundWireTest {

	private static final Path DATA_DIR = TempNewsDb.newDataDir("not-found-wire");

	@DynamicPropertySource
	static void dataDir(DynamicPropertyRegistry registry) {
		registry.add("app.data-dir", () -> DATA_DIR.toAbsolutePath().toString());
	}

	@Value("${local.server.port}")
	private int port;

	@Test
	void undefinedApiPathIs404WithHtmlContentType() {
		Wire.Response response = Wire.send(this.port, "GET", "/api/does-not-exist");

		assertEquals(404, response.status());
		assertEquals("Content-Type: text/html; charset=utf-8", response.line("content-type"),
				"Node 실측과 바이트 동일해야 한다(리포트 diff는 이 문자열을 정확 비교한다)");
	}

	@Test
	void undefinedApiPathBodyIsNotJson() {
		Wire.Response response = Wire.send(this.port, "GET", "/api/does-not-exist");

		String body = response.body().trim();
		assertFalse(body.startsWith("{"), "본문이 JSON이면 동결된 에러 shape 계약이 깨진다: " + body);
		assertFalse(body.contains("\"status\""), "Boot 기본 /error JSON이 새어 나왔다: " + body);
		assertTrue(body.contains("<html"), "비-JSON 본문은 express와 같은 HTML이다: " + body);
	}

	@Test
	void undefinedPathDoesNotEchoTheRequestPath() {
		Wire.Response response = Wire.send(this.port, "GET", "/api/no-such-route-marker-9137");

		assertEquals(404, response.status());
		assertFalse(response.body().contains("marker-9137"), "요청 경로를 본문에 되돌려주지 않는다");
	}

	@Test
	void undefinedPathIsNotTurnedInto401ByThePathPolicyFilter() {
		Wire.Response response = Wire.send(this.port, "GET", "/api/does-not-exist",
				Map.of("Origin", "http://localhost:5173"), null);

		assertEquals(404, response.status(),
				"경로 정책을 /api/** 와일드카드로 걸면 미정의 경로가 401이 되어 이 계약이 깨진다");
	}
}
