package harness.news.web;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertNull;

import harness.news.testsupport.TempNewsDb;
import harness.news.testsupport.Wire;
import java.nio.file.Path;
import java.util.Locale;
import java.util.Map;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.context.TestConfiguration;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * 전역 예외 → {@code 500 {ok:false, reason:'internal-error'}} 고정 shape.
 *
 * <p>두 가지를 동시에 잠근다.
 * <ol>
 *   <li><b>내부 정보 무노출</b> — 예외 메시지·스택·클래스 이름이 응답에 한 조각도 실리지 않는다(ADR 보안 경계).
 *       이 shape은 결함 후보 #1(중복 userId 500)의 재현 경로이기도 하다(decisions (12)).</li>
 *   <li><b>프레임워크 상태코드를 삼키지 않는다</b> — 미정의 경로는 404여야 한다. 모든 {@code Exception}을
 *       잡아 500으로 바꾸는 핸들러는 404/405/415를 전부 500으로 뭉갠다(흡수 대상 클라우드 구현의 실제
 *       결함 — decisions (18)(a)). 404 <b>본문</b>의 계약(비-JSON)은 step6 소관이라 여기서는 상태만 본다.</li>
 * </ol>
 * 예외를 던지는 라우트는 <b>테스트 전용</b>이다 — 이런 라우트를 main 소스에 두면 그 자체가 계약 위반이다.
 */
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
class ErrorShapeWireTest {

	private static final Path DATA_DIR = TempNewsDb.newDataDir("error-shape-wire");

	private static final String SECRET_MESSAGE = "터지는-내부-메시지-42";

	@DynamicPropertySource
	static void dataDir(DynamicPropertyRegistry registry) {
		registry.add("app.data-dir", () -> DATA_DIR.toAbsolutePath().toString());
	}

	@Value("${local.server.port}")
	private int port;

	@TestConfiguration
	static class BoomConfig {

		/** 중첩 @RestController는 설정 클래스의 멤버로 자동 등록된다(@Bean 메서드를 겹쳐 두면 중복 매핑). */
		@RestController
		static class BoomController {

			@GetMapping("/api/test-only-boom")
			void boom() {
				throw new IllegalStateException(SECRET_MESSAGE);
			}
		}
	}

	@Test
	void unhandledExceptionBecomesTheFixed500ShapeWithoutLeakingInternals() {
		Wire.Response response = Wire.send(this.port, "GET", "/api/test-only-boom");

		assertEquals(500, response.status());
		assertEquals("{\"ok\":false,\"reason\":\"internal-error\"}", response.body());
		assertEquals("Content-Type: application/json; charset=utf-8", response.line("content-type"));
		assertFalse(response.body().contains(SECRET_MESSAGE), "예외 메시지가 응답에 실렸다");
		assertFalse(response.body().toLowerCase(Locale.ROOT).contains("exception"), "예외 타입이 응답에 실렸다");
	}

	@Test
	void theFixed500ShapeDoesNotDropTheCorsHeadersOfTheEdgeFilter() {
		// 전역 핸들러는 응답을 reset()하고 다시 쓴다 — 그 reset이 CorsFilter가 체인 진입 시 심은 헤더를
		// 지우면 cross-origin SPA가 이 본문을 <b>읽지 못하고</b> CORS 오류로 본다(2026-08-20 실측: 0건이었다).
		Wire.Response allowed = Wire.send(this.port, "GET", "/api/test-only-boom",
				Map.of("Origin", "http://localhost:5173"), null);

		assertEquals(500, allowed.status());
		assertEquals("http://localhost:5173", allowed.value("access-control-allow-origin"));
		assertEquals("true", allowed.value("access-control-allow-credentials"));
		assertEquals("Origin", allowed.value("vary"));
	}

	@Test
	void theFixed500ShapeKeepsTheAllowlistAsymmetryForForeignOrigins() {
		// 되살리는 것은 "CorsFilter가 정한 것"이지 CORS 정책의 사본이 아니다 — 비허용 출처에는 ACAO가 없다.
		Wire.Response foreign = Wire.send(this.port, "GET", "/api/test-only-boom",
				Map.of("Origin", "http://evil.example"), null);

		assertEquals(500, foreign.status());
		assertNull(foreign.value("access-control-allow-origin"));
		assertEquals("true", foreign.value("access-control-allow-credentials"));
		assertEquals("Origin", foreign.value("vary"));
	}

	@Test
	void undefinedPathKeepsIts404AndIsNotSwallowedInto500() {
		Wire.Response response = Wire.send(this.port, "GET", "/api/does-not-exist");

		assertNotEquals(500, response.status(), "전역 핸들러가 프레임워크 404를 500으로 바꿨다");
		assertEquals(404, response.status());
	}
}
