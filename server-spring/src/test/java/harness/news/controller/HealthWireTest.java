package harness.news.controller;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import harness.news.testsupport.TempNewsDb;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;

/**
 * GET /api/health 와이어 계약 테스트.
 *
 * <p>MockMvc를 쓰지 않는다 — 이 phase의 합격 기준은 실제 HTTP 바이트(상태코드·헤더 문자열·본문 직렬화)이고
 * MockMvc는 서블릿 컨테이너의 직렬화 경로를 그대로 재현하지 않는다. 전 기동(RANDOM_PORT) + 원시 HTTP만 쓴다.
 *
 * <p>JSON 파서를 쓰지 않고 본문 문자열을 정확 비교한다: 계약이 요구하는 것은 "키 집합이 정확히 {ok} ·
 * ok == true"이고, 와이어 바이트 정확 비교는 그보다 강한 판정이다(계약 리포트 diff도 바이트 수준이다).
 */
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
class HealthWireTest {

	// step2부터 기동에 실제 DB가 필요하다(스키마 검증이 부팅 게이트다) — 임시 시드 DB를 물린다.
	// 리포 news.db는 열지 않는다.
	@DynamicPropertySource
	static void dataDir(DynamicPropertyRegistry registry) {
		registry.add("app.data-dir", () -> TempNewsDb.sharedDataDir().toAbsolutePath().toString());
	}

	@Value("${local.server.port}")
	private int port;

	@Test
	void healthReturns200WithExactlyOkTrue() throws Exception {
		HttpClient client = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(5)).build();
		HttpRequest request = HttpRequest.newBuilder(URI.create("http://127.0.0.1:" + port + "/api/health"))
				.timeout(Duration.ofSeconds(10))
				.GET()
				.build();

		HttpResponse<String> response = client.send(request, HttpResponse.BodyHandlers.ofString(StandardCharsets.UTF_8));

		assertEquals(200, response.statusCode(), "GET /api/health 는 200이어야 한다");
		assertEquals("{\"ok\":true}", response.body(), "본문은 정확히 {ok:true} 한 키여야 한다");

		String contentType = response.headers().firstValue("content-type").orElse("");
		// Content-Type 문자열 원문은 step5 decisions (9)(와이어 포맷 정규화)의 입력이다 — 여기서 고치지 않고 관측만 남긴다.
		System.out.println("[wire] GET /api/health content-type=" + contentType);
		assertTrue(contentType.startsWith("application/json"), "JSON Content-Type이어야 한다: " + contentType);
	}
}
