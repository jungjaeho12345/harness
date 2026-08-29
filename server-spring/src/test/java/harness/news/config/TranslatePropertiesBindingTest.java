package harness.news.config;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import harness.news.testsupport.TempNewsDb;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;

/**
 * 결선 확인 — {@code app.translate.google-api-key}가 실제로 {@link TranslateProperties}로 바인딩된다.
 *
 * <p>레코드 단위 테스트만으로는 두 가지를 못 잡는다: {@code AppConfig}의
 * {@code @EnableConfigurationProperties} 누락(그 상태면 빈이 없어 주입이 실패한다)과
 * <b>{@code application.properties}의 키 철자 오타</b>. 후자는 <b>조용한 고장</b>이다 — 키를 제대로 설정한
 * 배포에서도 값이 영원히 비어 번역이 {@code no-key}에 머무는데, 서비스 단위 테스트는 레코드를 직접
 * 생성하므로 그 사실을 영원히 관측하지 못한다({@link MediaPropertiesBindingTest} 선례).
 */
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.NONE,
		properties = "app.translate.google-api-key=bound-translate-key")
class TranslatePropertiesBindingTest {

	@DynamicPropertySource
	static void dataDir(DynamicPropertyRegistry registry) {
		registry.add("app.data-dir", () -> TempNewsDb.sharedDataDir().toAbsolutePath().toString());
	}

	private final TranslateProperties properties;

	TranslatePropertiesBindingTest(@Autowired TranslateProperties properties) {
		this.properties = properties;
	}

	@Test
	void theTranslateApiKeyIsBoundFromConfigurationProperties() {
		assertEquals("bound-translate-key", this.properties.googleApiKey());
		assertTrue(this.properties.hasKey());
	}

	/**
	 * 기본 구성(환경변수 미설정 = {@code ${GOOGLE_TRANSLATE_API_KEY:}}의 빈 값)은 <b>미설정</b>이다 —
	 * 계약 하네스가 관측하는 상태이고, 이때 외부 호출은 일어나지 않는다(ADR-014).
	 */
	@Test
	void unsetKeysCollapseToTheUnconfiguredState() {
		assertEquals("", new TranslateProperties(null).googleApiKey());
		assertEquals("", new TranslateProperties("").googleApiKey());
		assertEquals("", new TranslateProperties("   ").googleApiKey(), "공백뿐인 값도 미설정이다");
		assertFalse(new TranslateProperties(null).hasKey());
		assertFalse(new TranslateProperties("   ").hasKey());
		assertEquals(" k ", new TranslateProperties(" k ").googleApiKey(), "설정된 키 값 자체는 다듬지 않는다");
	}

}
