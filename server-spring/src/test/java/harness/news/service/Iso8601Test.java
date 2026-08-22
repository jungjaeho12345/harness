package harness.news.service;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import harness.news.testsupport.MutableClock;
import java.time.Instant;
import java.time.ZoneId;
import org.junit.jupiter.api.Test;

/**
 * 시각 문자열 포매터 — Node {@code new Date().toISOString()}과 바이트 동형(decisions (6)).
 *
 * <p><b>이 클래스가 지키는 한 문장:</b> 소수 3자리는 값이 아니라 <b>정렬 키의 형식</b>이다.
 * 시각 문자열은 {@code ORDER BY createdAt DESC}의 정렬 키이자 {@code createdAt >= ?} 범위 필터의
 * 입력이고, SQLite는 그것을 사전식으로 비교한다. {@link Instant#toString()}은 나노초가 0이면 소수부를
 * 통째로 빼는데({@code ...56Z}), 사전식으로 {@code '.'}(0x2E) &lt; {@code 'Z'}(0x5A)이므로
 * {@code ...56.789Z} &lt; {@code ...56Z}가 되어 <b>같은 초 안에서 정렬과 범위 판정이 뒤집힌다</b>.
 */
class Iso8601Test {

	/** 2026-08-20T12:34:56.000Z — 나노초가 정확히 0인 시각. */
	private static final long WHOLE_SECOND_MS = 1_787_229_296_000L;

	@Test
	void theFractionIsAlwaysWrittenEvenWhenItIsZero() {
		String iso = Iso8601.now(new MutableClock(WHOLE_SECOND_MS));

		assertEquals("2026-08-20T12:34:56.000Z", iso);
		assertTrue(iso.endsWith(".000Z"), "나노초가 0이어도 소수부를 싣는다 — 이 한 줄이 정렬 계약이다");
	}

	@Test
	void itDivergesFromInstantToStringExactlyAtThatPoint() {
		Instant whole = Instant.ofEpochMilli(WHOLE_SECOND_MS);

		assertEquals("2026-08-20T12:34:56Z", whole.toString(), "표준 toString은 소수부를 뺀다(이것이 함정이다)");
		assertNotEquals(whole.toString(), Iso8601.format(whole));
	}

	@Test
	void millisecondsAreWrittenAsExactlyThreeDigits() {
		assertEquals("2026-08-20T12:34:56.789Z", Iso8601.now(new MutableClock(WHOLE_SECOND_MS + 789)));
		assertEquals("2026-08-20T12:34:56.007Z", Iso8601.now(new MutableClock(WHOLE_SECOND_MS + 7)));
		assertEquals("2026-08-20T12:34:56.070Z", Iso8601.now(new MutableClock(WHOLE_SECOND_MS + 70)));
	}

	@Test
	void subMillisecondPrecisionIsTruncatedNotExpanded() {
		Instant nanos = Instant.ofEpochMilli(WHOLE_SECOND_MS).plusNanos(123_456_789L);

		assertEquals("2026-08-20T12:34:56.123Z", Iso8601.format(nanos),
				"나노 정밀도 시계에서도 9자리를 싣지 않는다(Node는 언제나 3자리다)");
	}

	@Test
	void everyStringSortsLexicographicallyInTimeOrder() {
		String earlier = Iso8601.now(new MutableClock(WHOLE_SECOND_MS));
		String later = Iso8601.now(new MutableClock(WHOLE_SECOND_MS + 1));
		String nextSecond = Iso8601.now(new MutableClock(WHOLE_SECOND_MS + 1_000));

		assertTrue(earlier.compareTo(later) < 0, "같은 초 안에서도 사전식 정렬이 시간 순서와 같아야 한다");
		assertTrue(later.compareTo(nextSecond) < 0);
		assertEquals(24, earlier.length(), "길이가 고정이라 사전식 비교가 곧 시간 비교다");
	}

	@Test
	void theOutputIsUtcRegardlessOfTheClockZone() {
		// 시계에 지역이 붙어 있어도(KST) 표기는 UTC다 — 저장 표현이 지역에 따라 갈리면 정렬이 무너진다.
		java.time.Clock seoul = java.time.Clock.fixed(Instant.ofEpochMilli(WHOLE_SECOND_MS), ZoneId.of("Asia/Seoul"));

		assertEquals("2026-08-20T12:34:56.000Z", Iso8601.now(seoul));
	}
}
