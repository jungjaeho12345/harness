package harness.news.web;

import harness.news.testsupport.TempNewsDb;
import java.io.IOException;
import java.io.UncheckedIOException;
import java.nio.file.Files;
import java.nio.file.Path;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;

/**
 * D20: {@code app.spa-dir}가 <b>{@code index.html}이 없는 디렉토리</b>면 404이며 <b>500이 아니다</b>.
 *
 * <p>판정 기준을 "디렉토리 존재"로 바꾸면 여기서 red가 난다 — 폴백이 켜진 채 index.html이 없으면 미정의
 * GET마다 리소스 부재가 전역 에러 핸들러로 흘러 <b>404가 500으로 뒤집히기</b> 때문이다(Node
 * {@code resolveSpaRoot}의 CRITICAL 주석이 그 사고를 적어 뒀다).
 */
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
class SpaEmptyRootWireTest {

	private static final Path DATA_DIR = TempNewsDb.newDataDir("spa-empty-root");

	private static final Path EMPTY_ROOT = createEmptyRoot();

	@DynamicPropertySource
	static void properties(DynamicPropertyRegistry registry) {
		registry.add("app.data-dir", () -> DATA_DIR.toAbsolutePath().toString());
		registry.add("app.spa-dir", () -> EMPTY_ROOT.toAbsolutePath().toString());
	}

	@Value("${local.server.port}")
	private int port;

	private static Path createEmptyRoot() {
		try {
			return Files.createTempDirectory("news-spring-spa-empty-");
		}
		catch (IOException ex) {
			throw new UncheckedIOException(ex);
		}
	}

	@Test
	void anEmptyRootIs404AndNever500() {
		SpaInactive.assertNothingIsServed(this.port);
	}
}
