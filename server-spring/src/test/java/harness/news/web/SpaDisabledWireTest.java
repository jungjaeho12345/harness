package harness.news.web;

import harness.news.testsupport.TempNewsDb;
import java.nio.file.Path;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;

/**
 * D19: {@code app.spa-dir} 미설정 = <b>서빙 비활성</b>이 기본이다.
 *
 * <p>이 기본값이 이 phase의 회귀 판정을 살려 둔다 — 계약 하네스는 {@code SPA_DIR}을 자식에게 넘기지 않으므로
 * 313관측 × 2축이 <b>정확히 이 상태</b>로 돈다. 되돌림 비용이 구조적으로 0에 가까운 이유이기도 하다.
 */
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
class SpaDisabledWireTest {

	private static final Path DATA_DIR = TempNewsDb.newDataDir("spa-disabled");

	@DynamicPropertySource
	static void dataDir(DynamicPropertyRegistry registry) {
		registry.add("app.data-dir", () -> DATA_DIR.toAbsolutePath().toString());
	}

	@Value("${local.server.port}")
	private int port;

	@Test
	void withoutASpaDirNothingIsServed() {
		SpaInactive.assertNothingIsServed(this.port);
	}
}
