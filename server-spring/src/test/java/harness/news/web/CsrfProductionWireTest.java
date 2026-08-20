package harness.news.web;

import static org.junit.jupiter.api.Assertions.assertEquals;

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
 * 프로덕션 변형({@code app.env=production})의 CSRF 가드 — 계약 프로파일 {@code prod-cookie}의 조건과 같다.
 *
 * <p>프로덕션에서는 두 가지가 동시에 꺼진다(server/index.js {@code allowedOrigins}·{@code csrfOriginGuard}):
 * <ul>
 *   <li>비프로덕션 기본 allowlist 2개({@code http://localhost:5173}·{@code http://127.0.0.1:5173})가 <b>빠진다</b>
 *       — 프로덕션 쿠키는 {@code SameSite=None; Secure}라 cross-site 요청에도 붙기 때문에, 피해자 PC에서 열린
 *       임의의 로컬 페이지가 운영 API를 피해자 세션으로 호출·판독할 수 있다(Origin 위조가 필요 없다).</li>
 *   <li>loopback 관용이 <b>꺼진다</b>.</li>
 * </ul>
 * 남는 통과 경로는 자기 출처(리버스 프록시 동일 출처 배포)와 {@code ALLOWED_ORIGINS} 명시 등록,
 * 그리고 Origin·Referer 부재 관용뿐이다 — 마지막 항목이 {@code prod-cookie} 계약 케이스가 그대로 통과하는 이유다.
 */
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT,
		properties = "app.env=production")
class CsrfProductionWireTest {

	private static final Path DATA_DIR = TempNewsDb.newDataDir("csrf-prod-wire");

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
	void nonProductionDefaultOriginIsRejectedInProduction() {
		Wire.Response response = logout(Map.of("Origin", "http://localhost:5173"));

		assertEquals(403, response.status(), "프로덕션 allowlist는 ALLOWED_ORIGINS 뿐이다(dev 기본값 없음)");
		assertEquals("{\"ok\":false,\"reason\":\"forbidden-origin\"}", response.body());
	}

	@Test
	void loopbackToleranceIsOffInProduction() {
		Wire.Response response = logout(Map.of("Origin", "http://127.0.0.1:59999"));

		assertEquals(403, response.status());
	}

	@Test
	void selfOriginStillPassesInProduction() {
		Wire.Response response = logout(Map.of("Origin", "http://127.0.0.1:" + this.port));

		assertEquals(200, response.status(), "동일 출처 배포(리버스 프록시)는 정상 구성이다");
	}

	@Test
	void absentOriginStillPassesInProduction() {
		Wire.Response response = logout(Map.of());

		assertEquals(200, response.status(), "prod-cookie 계약 케이스가 그대로 통과하는 근거");
	}
}
