package harness.news.web;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import harness.news.service.UserService;
import harness.news.testsupport.TempNewsDb;
import harness.news.testsupport.Wire;
import java.nio.file.Path;
import java.util.LinkedHashMap;
import java.util.Map;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;

/**
 * <b>Content-Type 바이트 패리티</b>의 잠금 — 이 phase에서 가장 미끄러운 축이다.
 *
 * <h2>무엇이 문제인가(실측)</h2>
 * Node(express {@code res.json})는 {@code application/json; charset=utf-8}을 보낸다.
 * Spring/Tomcat은 서블릿 API({@code setContentType}·{@code setHeader})로 무엇을 주든 content-type을
 * <b>파싱해서 재조립</b>한다({@code org.apache.coyote.Response#getContentType} = {@code type + ";charset=" + name}) —
 * 세미콜론 뒤 공백이 사라져 {@code application/json;charset=utf-8}이 되고, 아무것도 지정하지 않으면
 * charset 파라미터 자체가 없다(step0 실측: {@code application/json}). 계약 리포트 diff는 이 헤더를
 * <b>문자열로 정확 비교</b>하므로 그 1바이트가 전 관측을 red로 만든다.
 *
 * <h2>왜 이 테스트가 반드시 실 Tomcat 전 기동인가</h2>
 * MockMvc·{@code java.net.http.HttpClient} 같은 관측 도구는 헤더 문자열을 자기 규칙으로 정규화하거나
 * 애초에 컨테이너의 직렬화 경로를 타지 않는다 — 그런 도구로는 이 결함이 <b>보이지 않는다</b>(거짓 green).
 * 그래서 원시 소켓으로 응답 바이트를 읽어 헤더 <b>줄 전체</b>를 정확 비교한다.
 * 이 테스트가 깨지면 {@code --parity}가 반드시 깨진다(그 반대도 성립한다).
 */
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
class ContentTypeWireTest {

	/** Node 실측값. 여기의 공백 1개가 이 클래스의 존재 이유다. */
	private static final String EXPECTED_LINE = "Content-Type: application/json; charset=utf-8";

	private static final Path DATA_DIR = TempNewsDb.newDataDir("content-type-wire");

	@DynamicPropertySource
	static void dataDir(DynamicPropertyRegistry registry) {
		registry.add("app.data-dir", () -> DATA_DIR.toAbsolutePath().toString());
	}

	@Value("${local.server.port}")
	private int port;

	@Autowired
	private UserService users;

	private void assertExactContentType(Wire.Response response) {
		assertEquals(1, response.lines("content-type").size(),
				"Content-Type 헤더는 정확히 한 줄이어야 한다: " + response.lines("content-type"));
		assertEquals(EXPECTED_LINE, response.line("content-type"),
				"헤더 원문이 Node와 바이트 동일해야 한다(계약 리포트 diff는 이 문자열을 그대로 비교한다)");
	}

	@Test
	void healthCarriesTheExactNodeContentType() {
		Wire.Response response = Wire.send(this.port, "GET", "/api/health");

		assertEquals(200, response.status());
		assertEquals("{\"ok\":true}", response.body());
		assertExactContentType(response);
	}

	@Test
	void rejectionsAlsoCarryTheExactNodeContentType() {
		Wire.Response response = Wire.send(this.port, "GET", "/api/session");

		assertEquals(401, response.status());
		assertExactContentType(response);
	}

	@Test
	void loginSuccessAlsoCarriesTheExactNodeContentType() {
		Map<String, Object> dto = new LinkedHashMap<>();
		dto.put("userId", "ct-r");
		dto.put("password", "ct-pw-1");
		dto.put("role", "R");
		dto.put("name", "기자");
		try {
			this.users.create(dto);
		}
		catch (RuntimeException ignored) {
			// 이미 있다 — 픽스처는 멱등이다.
		}

		Wire.Response response = Wire.json(this.port, "POST", "/api/login", Map.of(),
				"{\"userId\":\"ct-r\",\"password\":\"ct-pw-1\"}");

		assertEquals(200, response.status(), response.body());
		assertExactContentType(response);
	}

	@Test
	void koreanTextSurvivesAsUtf8Bytes() {
		Wire.Response response = Wire.json(this.port, "POST", "/api/login", Map.of(),
				"{\"userId\":\"없는계정-한글\",\"password\":\"비밀번호\"}");

		assertEquals(401, response.status());
		assertExactContentType(response);
		assertTrue(response.body().startsWith("{\"ok\":false"), response.body());
	}
}
