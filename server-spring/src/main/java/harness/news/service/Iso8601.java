package harness.news.service;

import java.time.Clock;
import java.time.DateTimeException;
import java.time.Instant;
import java.time.format.DateTimeFormatter;
import java.time.format.DateTimeFormatterBuilder;

/**
 * 시각 문자열의 <b>단일 포매터</b> — Node {@code new Date().toISOString()}과 바이트 동형(decisions (6)).
 *
 * <p>소수 3자리는 값이 아니라 <b>정렬 키의 형식</b>이다. 저장된 시각 문자열이 곧
 * {@code ORDER BY createdAt DESC}의 정렬 키이자 {@code createdAt >= ?} 범위 필터의 입력이고, SQLite는
 * 그것을 사전식으로 비교한다. {@link Instant#toString()}은 나노초가 0이면 소수부를 통째로 빼는데
 * ({@code ...56Z}) 사전식으로 {@code '.'}(0x2E) &lt; {@code 'Z'}(0x5A)이므로 {@code ...56.789Z}가
 * {@code ...56Z}보다 <b>앞선다</b> — 같은 초 안에서 정렬과 범위 판정이 조용히 뒤집힌다. 그래서 나노초가
 * 0이어도 소수부를 반드시 싣는다.
 *
 * <p>시각의 출처는 <b>주입된 {@link Clock} 빈</b>뿐이다({@code System.currentTimeMillis()}·인자 없는
 * {@code Instant.now()} 금지 — ADR-013). 그래야 잠금 TTL 같은 시간축이 테스트에서 결정적이다.
 */
public final class Iso8601 {

	/** {@code yyyy-MM-ddTHH:mm:ss.SSSZ} — 소수 3자리 고정, 항상 UTC({@code Z}). */
	private static final DateTimeFormatter ISO_MILLIS = new DateTimeFormatterBuilder()
			.appendInstant(3)
			.toFormatter();

	/** 주입된 시계의 현재 시각. */
	public static String now(Clock clock) {
		return format(clock.instant());
	}

	/** 나노 정밀도 입력은 밀리초로 <b>절단</b>한다(반올림하지 않는다 — Node는 언제나 3자리다). */
	public static String format(Instant instant) {
		return ISO_MILLIS.format(instant);
	}

	/**
	 * 저장된 시각 문자열 → epoch ms. 값이 없거나 파싱할 수 없으면 {@code null}이며, 호출자가 그 의미를
	 * 정한다(잠금 stale 판정은 "모르면 stale" 쪽으로 수렴한다 — {@link EditLockTtl}).
	 *
	 * <p>Node {@code Date.parse}보다 엄격하다: 오프셋 없는 표기({@code ...T12:34:56})나 날짜만 있는
	 * 표기는 여기서 파싱 불가다. 이 서버가 쓰는 시각 컬럼은 전부 {@link #format(Instant)}(또는 Node의
	 * {@code toISOString})이 만든 완전한 ISO-8601 UTC 문자열이라 그 차이가 관측되는 자리는 없다.
	 */
	public static Long parseMillis(Object value) {
		if (!(value instanceof String text) || text.isEmpty()) {
			return null;
		}
		try {
			return Instant.parse(text).toEpochMilli();
		}
		catch (DateTimeException | ArithmeticException ex) {
			return null;
		}
	}

	private Iso8601() {
	}
}
