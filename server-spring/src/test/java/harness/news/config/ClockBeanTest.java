package harness.news.config;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotSame;

import harness.news.testsupport.TempNewsDb;
import java.time.Clock;
import java.time.Instant;
import java.time.ZoneOffset;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.context.TestConfiguration;
import org.springframework.context.ApplicationContext;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Primary;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;

/**
 * 시계 주입 seam — 세션 만료·계정 잠금·로그 다이제스트 창이 전부 이 빈을 주입받는다(decisions (14)).
 * 프로덕션 빈은 시스템 시계이고, 테스트는 고정 시계로 갈아끼울 수 있어야 한다.
 */
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.NONE)
class ClockBeanTest {

	// step2부터 기동에 실제 DB가 필요하다(스키마 검증이 부팅 게이트다) — 임시 시드 DB를 물린다.
	@DynamicPropertySource
	static void dataDir(DynamicPropertyRegistry registry) {
		registry.add("app.data-dir", () -> TempNewsDb.sharedDataDir().toAbsolutePath().toString());
	}

	private static final Instant FIXED = Instant.parse("2026-08-19T00:00:00Z");

	@TestConfiguration
	static class FixedClockConfig {
		@Bean
		@Primary
		Clock fixedClock() {
			return Clock.fixed(FIXED, ZoneOffset.UTC);
		}
	}

	private final ApplicationContext context;
	private final Clock injectedClock;

	ClockBeanTest(@Autowired ApplicationContext context, @Autowired Clock injectedClock) {
		this.context = context;
		this.injectedClock = injectedClock;
	}

	@Test
	void testsCanOverrideTheClock() {
		assertEquals(FIXED, injectedClock.instant());
	}

	@Test
	void productionClockIsSystemUtc() {
		Clock production = context.getBean("clock", Clock.class);
		assertEquals(Clock.systemUTC(), production);
		assertNotSame(injectedClock, production);
	}
}
