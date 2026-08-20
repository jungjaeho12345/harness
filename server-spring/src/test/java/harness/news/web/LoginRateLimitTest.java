package harness.news.web;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import harness.news.testsupport.MutableClock;
import java.time.Instant;
import org.junit.jupiter.api.Test;

/**
 * IP 고정 창 카운터 — HTTP를 모르는 순수 계산부(필터는 이 판정을 와이어에 옮기기만 한다).
 *
 * <p>여기가 <b>계약값을 리터럴로 못 박는 유일한 테스트</b>다: 다른 테스트가 상수를 참조해도 한도를 바꾸는
 * 변이가 여기서 반드시 걸린다.
 */
class LoginRateLimitTest {

	private static final long T0 = Instant.parse("2026-08-20T00:00:00Z").toEpochMilli();

	private static final String IP = "127.0.0.1";

	private MutableClock clock() {
		return new MutableClock(T0);
	}

	@Test
	void theLimitAndWindowAreTheNodeContractValues() {
		// 근거: server/index.js 609~614행 loginLimiter { windowMs: FIFTEEN_MIN_MS, limit: 10 }.
		assertEquals(10, LoginRateLimit.LIMIT);
		assertEquals(15L * 60L * 1000L, LoginRateLimit.WINDOW_MS);
	}

	@Test
	void theLimitthRequestPassesAndTheNextOneIsRejected() {
		LoginRateLimit limiter = new LoginRateLimit(clock());

		for (int i = 1; i <= LoginRateLimit.LIMIT; i++) {
			assertFalse(limiter.exceeded(IP), i + "번째 요청은 창 안 예산이다");
		}

		assertTrue(limiter.exceeded(IP), "한도 + 1번째 요청이 거부다");
	}

	@Test
	void rejectedRequestsStayRejectedInsideTheWindow() {
		LoginRateLimit limiter = new LoginRateLimit(clock());
		for (int i = 1; i <= LoginRateLimit.LIMIT + 1; i++) {
			limiter.exceeded(IP);
		}

		assertTrue(limiter.exceeded(IP), "창이 지나기 전에는 계속 거부다");
	}

	@Test
	void eachClientHasItsOwnBudget() {
		LoginRateLimit limiter = new LoginRateLimit(clock());
		for (int i = 1; i <= LoginRateLimit.LIMIT + 1; i++) {
			limiter.exceeded("10.0.0.1");
		}

		assertFalse(limiter.exceeded("10.0.0.2"), "다른 IP의 예산은 독립이다");
	}

	@Test
	void theBudgetIsRestoredWhenTheWindowElapses() {
		MutableClock clock = clock();
		LoginRateLimit limiter = new LoginRateLimit(clock);
		for (int i = 1; i <= LoginRateLimit.LIMIT + 1; i++) {
			limiter.exceeded(IP);
		}

		clock.advance(LoginRateLimit.WINDOW_MS - 1);
		assertTrue(limiter.exceeded(IP), "창 경계 직전은 아직 같은 창이다");

		clock.advance(1);
		assertFalse(limiter.exceeded(IP), "창이 지나면 카운터가 리셋된다");
	}

	@Test
	void expiredEntriesAreEvictedOnLookupWithoutATimer() {
		MutableClock clock = clock();
		LoginRateLimit limiter = new LoginRateLimit(clock);
		for (int i = 0; i <= LoginRateLimit.SWEEP_THRESHOLD; i++) {
			limiter.exceeded("10.1." + (i / 256) + "." + (i % 256));
		}
		int crowded = limiter.size();

		clock.advance(LoginRateLimit.WINDOW_MS);
		limiter.exceeded(IP); // 조회 시점 정리 — @Scheduled 타이머 없이 여기서만 줄어든다.

		assertTrue(crowded > LoginRateLimit.SWEEP_THRESHOLD, "선행 조건: 정리 임계를 넘겨야 한다(" + crowded + ")");
		assertEquals(1, limiter.size(), "창이 지난 항목은 전부 사라지고 방금 만든 항목만 남는다");
	}

	@Test
	void freshEntriesSurviveTheSweep() {
		MutableClock clock = clock();
		LoginRateLimit limiter = new LoginRateLimit(clock);
		limiter.exceeded("10.0.0.7");

		clock.advance(LoginRateLimit.WINDOW_MS - 1);
		for (int i = 0; i <= LoginRateLimit.SWEEP_THRESHOLD; i++) {
			limiter.exceeded("10.2." + (i / 256) + "." + (i % 256));
		}

		for (int i = 2; i <= LoginRateLimit.LIMIT; i++) {
			assertFalse(limiter.exceeded("10.0.0.7"), "정리가 창 안 항목까지 지우면 예산이 되살아난다");
		}
		assertTrue(limiter.exceeded("10.0.0.7"), "10.0.0.7은 첫 요청부터 세어 한도 + 1번째가 거부여야 한다");
	}

	@Test
	void anUnknownClientKeyIsTreatedAsOneBucket() {
		LoginRateLimit limiter = new LoginRateLimit(clock());

		for (int i = 1; i <= LoginRateLimit.LIMIT; i++) {
			assertFalse(limiter.exceeded(null), i + "번째 익명 요청은 창 안 예산이다");
		}

		assertTrue(limiter.exceeded(null), "식별자가 없다고 무제한이 되면 안 된다");
	}

}
