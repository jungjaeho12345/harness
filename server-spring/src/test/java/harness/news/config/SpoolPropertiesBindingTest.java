package harness.news.config;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import harness.news.testsupport.TempNewsDb;
import java.nio.file.Path;
import java.util.Optional;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;

/**
 * 결선 확인 — {@code app.distribution.spool-dir}이 실제로 {@link SpoolProperties}로 바인딩된다.
 *
 * <p>레코드 단위 테스트만으로는 {@code AppConfig}의 {@code @EnableConfigurationProperties} 항목이 빠진 것을
 * 잡지 못한다(그 상태에서는 빈이 아예 없어 주입이 실패한다).
 */
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.NONE,
		properties = "app.distribution.spool-dir=D:/spool/bound-by-property")
class SpoolPropertiesBindingTest {

	@DynamicPropertySource
	static void dataDir(DynamicPropertyRegistry registry) {
		registry.add("app.data-dir", () -> TempNewsDb.sharedDataDir().toAbsolutePath().toString());
	}

	private final SpoolProperties properties;

	SpoolPropertiesBindingTest(@Autowired SpoolProperties properties) {
		this.properties = properties;
	}

	@Test
	void theSpoolRootIsBoundFromTheConfigurationProperty() {
		assertEquals("D:/spool/bound-by-property", this.properties.spoolDir());
		assertEquals(Optional.of(Path.of("D:/spool/bound-by-property")), this.properties.rootPath());
		assertTrue(this.properties.enabled());
	}

}
