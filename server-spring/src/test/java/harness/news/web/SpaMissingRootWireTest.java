package harness.news.web;

import harness.news.testsupport.TempNewsDb;
import java.nio.file.Path;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;

/**
 * D21: {@code app.spa-dir}가 <b>존재하지 않는 경로</b>여도 기동은 성공하고 응답은 404다.
 *
 * <p>컨텍스트가 기동하는 것 자체가 단언이다 — 경로 판정이 예외를 던지면 이 클래스는 기동에서 죽고, 그것은
 * 오구성된 배포에서 <b>39 라우트가 전멸</b>한다는 뜻이다(로그인부터 죽는다). {@code SpoolProperties}가
 * 2026-08-26 코드리뷰 반려로 배운 규율과 같다.
 */
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
class SpaMissingRootWireTest {

	private static final Path DATA_DIR = TempNewsDb.newDataDir("spa-missing-root");

	@DynamicPropertySource
	static void properties(DynamicPropertyRegistry registry) {
		registry.add("app.data-dir", () -> DATA_DIR.toAbsolutePath().toString());
		registry.add("app.spa-dir", () -> DATA_DIR.resolve("no-such-web-dist").toAbsolutePath().toString());
	}

	@Value("${local.server.port}")
	private int port;

	@Test
	void aMissingRootStartsAndServesNothing() {
		SpaInactive.assertNothingIsServed(this.port);
	}
}
