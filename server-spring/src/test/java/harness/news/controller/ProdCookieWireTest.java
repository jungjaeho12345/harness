package harness.news.controller;

import static org.junit.jupiter.api.Assertions.assertEquals;
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
 * 프로덕션 쿠키 변형({@code app.env=production}) 와이어 테스트 — 계약 프로파일 {@code prod-cookie}의 축.
 *
 * <p>Node 실측 기준값(2026-08-20, {@code contract-run.mjs --profile prod-cookie}):
 * <pre>
 * set-cookie : sid=&lt;값&gt;; Max-Age=3600; Path=/; HttpOnly; Secure; SameSite=None  (발급)
 *              sid=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=None            (만료)
 * </pre>
 * 비프로덕션과의 차이는 <b>Secure 유무와 SameSite 값</b> 두 가지뿐이며 그 차이가 계약이다.
 * 분기 판정은 설정 바인딩 한 곳에서 하고 컨트롤러는 어떤 환경인지 모른다.
 */
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT,
		properties = "app.env=production")
class ProdCookieWireTest {

	private static final Path DATA_DIR = TempNewsDb.newDataDir("prod-cookie-wire");

	private static final Pattern SESSION_ID = Pattern.compile("\"sessionId\":\"([0-9a-f]{64})\"");

	private static final String PASSWORD = "prod-pw-1";

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
		dto.put("userId", "prod-r");
		dto.put("password", PASSWORD);
		dto.put("role", "R");
		dto.put("name", "기자");
		try {
			this.users.create(dto);
		}
		catch (RuntimeException ignored) {
			// 이미 있다 — 픽스처는 멱등이다.
		}
	}

	private Wire.Response login() {
		Wire.Response response = Wire.json(this.port, "POST", "/api/login", Map.of(),
				"{\"userId\":\"prod-r\",\"password\":\"" + PASSWORD + "\"}");
		assertEquals(200, response.status(), response.body());
		return response;
	}

	private static String sessionIdOf(Wire.Response response) {
		Matcher matcher = SESSION_ID.matcher(response.body());
		assertTrue(matcher.find(), "응답에 64-hex sessionId가 없다: " + response.body());
		return matcher.group(1);
	}

	@Test
	void productionLoginCookieCarriesSecureAndSameSiteNone() {
		Wire.Response response = login();

		assertEquals("sid=" + sessionIdOf(response) + "; Max-Age=3600; Path=/; HttpOnly; Secure; SameSite=None",
				response.value("set-cookie"));
	}

	@Test
	void headerFallbackSurvivesInProduction() {
		String sessionId = sessionIdOf(login());

		Wire.Response response = Wire.send(this.port, "GET", "/api/session",
				Map.of("x-session-id", sessionId), null);

		assertEquals(200, response.status());
		assertTrue(response.body().contains("\"role\":\"R\""), response.body());
	}

	@Test
	void productionLogoutCookieCarriesTheSameAttributes() {
		String sessionId = sessionIdOf(login());

		Wire.Response logout = Wire.send(this.port, "POST", "/api/logout",
				Map.of("x-session-id", sessionId), null);

		assertEquals(200, logout.status());
		assertEquals("{\"ok\":true}", logout.body());
		assertEquals("sid=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=None", logout.value("set-cookie"));
	}
}
