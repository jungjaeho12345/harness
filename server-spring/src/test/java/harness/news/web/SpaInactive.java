package harness.news.web;

import static org.junit.jupiter.api.Assertions.assertArrayEquals;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;

import harness.news.testsupport.Wire;
import java.util.List;
import java.util.Map;

/**
 * <b>SPA 비활성</b>의 공통 단언 — {@code test/spa-serving.test.js}의 {@code assertInactive} 동형이다.
 *
 * <p>비활성이 <b>기본값</b>이고, 그 기본값 위에서 계약 하네스 313관측 × 2축이 돈다. 그래서 이 단언은
 * "SPA를 붙였는데 아무것도 안 바뀌었다"를 세 가지 오구성(미설정 · 빈 디렉토리 · 없는 경로)에서 확인한다 —
 * 특히 <b>404가 500으로 뒤집히지 않는지</b>가 핵심이다(Node {@code resolveSpaRoot}의 CRITICAL 주석).
 */
final class SpaInactive {

	private static final String HTML_ACCEPT = "text/html,application/xhtml+xml,*/*;q=0.8";

	private SpaInactive() {
	}

	/** 미정의 경로가 전부 404이고, 그 바이트가 기존 404({@code /api/does-not-exist})와 같다. */
	static void assertNothingIsServed(int port) {
		byte[] expected = Wire.raw(port, "GET", "/api/does-not-exist", Map.of("Accept", HTML_ACCEPT), null).body();

		for (List<String> probe : List.of(
				List.of("/list.do", HTML_ACCEPT),
				List.of("/", HTML_ACCEPT),
				List.of("/login.do", HTML_ACCEPT),
				List.of("/assets/app-abc123.js", "*/*"))) {
			String path = probe.get(0);
			Wire.RawResponse response = Wire.raw(port, "GET", path, Map.of("Accept", probe.get(1)), null);

			assertEquals(404, response.status(), path + " 이 404가 아니다(500 금지 · 200 금지)");
			assertEquals("Content-Type: text/html; charset=utf-8", response.line("content-type"), path);
			assertArrayEquals(expected, response.body(), path + " 의 404 본문 바이트가 기존과 갈렸다");
			assertNull(response.line("content-security-policy"), path + " 에 CSP가 실렸다(비활성인데 표면이 생겼다)");
		}
	}
}
