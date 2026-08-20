package harness.news.web;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import harness.news.config.AppProperties;
import java.util.List;
import org.junit.jupiter.api.Test;

/**
 * CORS와 CSRF가 <b>같은 목록</b>을 보게 하는 단일 출처(server/index.js {@code allowedOrigins} 동형, ADR-009).
 *
 * <p>비프로덕션은 dev 배선(Vite :5173) 기본값 2개 + 설정값, 프로덕션은 <b>설정값만</b>이다.
 * 프로덕션에서 기본값을 남기면 피해자 PC의 로컬 페이지가 운영 API를 피해자 세션으로 호출·판독할 수 있다
 * (프로덕션 쿠키는 {@code SameSite=None; Secure}라 cross-site 요청에도 붙는다).
 */
class AllowedOriginsTest {

	private static AllowedOrigins of(String env, List<String> configured) {
		return AllowedOrigins.of(new AppProperties("/tmp/data", env, configured));
	}

	@Test
	void nonProductionKeepsTheTwoDevDefaultsFirstThenConfiguredOnes() {
		AllowedOrigins origins = of("development", List.of("https://news.example"));

		assertEquals(List.of("http://localhost:5173", "http://127.0.0.1:5173", "https://news.example"),
				origins.values());
		assertTrue(origins.allows("http://localhost:5173"));
		assertTrue(origins.allows("https://news.example"));
	}

	@Test
	void productionUsesConfiguredOriginsOnly() {
		AllowedOrigins origins = of("production", List.of("https://news.example"));

		assertEquals(List.of("https://news.example"), origins.values());
		assertFalse(origins.allows("http://localhost:5173"), "프로덕션에서 dev 기본값이 남으면 안 된다");
		assertTrue(origins.production());
	}

	@Test
	void productionWithoutConfigurationHasAnEmptyAllowlist() {
		AllowedOrigins origins = of("production", List.of());

		assertEquals(List.of(), origins.values(), "남는 통과 경로는 자기 출처와 Origin 부재 관용뿐이다");
		assertFalse(origins.allows("https://news.example"));
	}

	@Test
	void unknownOriginsAndNullAreNeverAllowed() {
		AllowedOrigins origins = of("development", List.of());

		assertFalse(origins.allows("http://evil.example"));
		assertFalse(origins.allows(null));
		assertFalse(origins.allows(""));
	}

	@Test
	void comparisonIsExactStringMatch() {
		AllowedOrigins origins = of("development", List.of());

		// Node는 Origin 헤더 원문을 그대로 Set에 대조한다 — 대소문자·후행 슬래시를 정규화하지 않는다.
		assertFalse(origins.allows("http://LOCALHOST:5173"));
		assertFalse(origins.allows("http://localhost:5173/"));
	}
}
