package harness.news.service;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import harness.news.testsupport.MutableClock;
import java.time.Duration;
import org.junit.jupiter.api.Test;

/**
 * 편집 잠금 stale 판정(30분 TTL) — 리포 루트 {@code src/services/articleService.js} 57~62행과 동형.
 *
 * <p>시각은 <b>주입된 시계</b>에서만 읽는다(ADR-013 · decisions (6)). 실서버 시간축은 계약이 관측할 수
 * 없으므로(계약 스위트는 시계를 주입하지 못한다) 이 단위 테스트가 TTL 경계의 유일한 게이트다.
 */
class EditLockTtlTest {

	/** 2026-08-20T12:34:56.000Z. */
	private static final long NOW_MS = 1_787_229_296_000L;

	private final MutableClock clock = new MutableClock(NOW_MS);

	@Test
	void theTtlIsThirtyMinutes() {
		assertEquals(Duration.ofMinutes(30).toMillis(), EditLockTtl.TTL_MS);
	}

	@Test
	void aLockTouchedWithinTheTtlIsNotStale() {
		assertFalse(EditLockTtl.isStale(Iso8601.format(java.time.Instant.ofEpochMilli(NOW_MS - 29 * 60_000 - 59_000)),
				this.clock), "29분 59초는 아직 유효하다");
	}

	@Test
	void exactlyThirtyMinutesIsStillNotStale() {
		// Node는 `>`(초과)로 비교한다 — 정각은 아직 stale이 아니다.
		assertFalse(EditLockTtl.isStale(Iso8601.format(java.time.Instant.ofEpochMilli(NOW_MS - 30 * 60_000)),
				this.clock));
	}

	@Test
	void oneMillisecondPastTheTtlIsStale() {
		assertTrue(EditLockTtl.isStale(Iso8601.format(java.time.Instant.ofEpochMilli(NOW_MS - 30 * 60_000 - 1)),
				this.clock));
	}

	@Test
	void thirtyMinutesAndOneSecondIsStale() {
		assertTrue(EditLockTtl.isStale(Iso8601.format(java.time.Instant.ofEpochMilli(NOW_MS - 30 * 60_000 - 1_000)),
				this.clock));
	}

	@Test
	void anUnparsableOrMissingTimestampIsStale() {
		assertTrue(EditLockTtl.isStale(null, this.clock), "잠금 시각이 없으면 stale이다(다음 시도자가 가져간다)");
		assertTrue(EditLockTtl.isStale("", this.clock));
		assertTrue(EditLockTtl.isStale("not-a-date", this.clock));
		assertTrue(EditLockTtl.isStale("2026-13-45T99:99:99Z", this.clock));
	}

	@Test
	void aFutureTimestampIsNotStale() {
		// 시계 역행·클럭 스큐로 미래 시각이 들어와도 stale로 뒤집히지 않는다(경과 시간이 음수).
		assertFalse(EditLockTtl.isStale(Iso8601.format(java.time.Instant.ofEpochMilli(NOW_MS + 60_000)), this.clock));
	}

	@Test
	void theSameLockGoesStaleWhenTheInjectedClockAdvances() {
		String lockedAt = Iso8601.now(this.clock);
		assertFalse(EditLockTtl.isStale(lockedAt, this.clock));

		this.clock.advance(EditLockTtl.TTL_MS + 1);

		assertTrue(EditLockTtl.isStale(lockedAt, this.clock), "시간이 흐른 뒤에만 stale이 된다");
	}
}
