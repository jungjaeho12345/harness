package harness.news.config;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotSame;

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

/**
 * 시계 주입 seam — 세션 만료·계정 잠금·로그 다이제스트 창이 전부 이 빈을 주입받는다(decisions (14)).
 * 프로덕션 빈은 시스템 시계이고, 테스트는 고정 시계로 갈아끼울 수 있어야 한다.
 */
@SpringBootTest(
		webEnvironment = SpringBootTest.WebEnvironment.NONE,
		properties = {"app.data-dir=${java.io.tmpdir}"})
class ClockBeanTest {

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
