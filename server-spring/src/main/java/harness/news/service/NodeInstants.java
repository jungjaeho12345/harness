package harness.news.service;

import java.time.DateTimeException;
import java.time.LocalDate;
import java.time.OffsetDateTime;
import java.time.ZoneOffset;
import java.util.regex.Pattern;

/**
 * Node {@code Date.parse}의 <b>부분 이식</b> — 엠바고 시각처럼 <b>사용자가 입력한</b> 시각 문자열을
 * epoch ms로 읽는 단일 출처다(phase 72 decisions (7)).
 *
 * <p>{@link Iso8601#parseMillis(Object)}와의 역할 분담: 저 쪽은 <b>서버가 stamp한</b> 시각 컬럼
 * ({@code createdAt}·{@code sentAt}…)을 읽는다 — 전부 {@code Iso8601.format}이 만든 {@code Z} 표기라
 * 그보다 넓을 필요가 없다. 이 쪽은 엠바고 두 컬럼처럼 자유 입력이 섞일 수 있는 자리를 읽는다.
 * {@code Z} 표기는 저 구현을 그대로 재사용한다(의미론을 로컬 재구현하지 않는다).
 *
 * <h2>덮는 범위는 셋뿐이고, 그 경계가 계약이다</h2>
 * <ol>
 *   <li>{@code Z} 표기 — {@code 2026-01-01T00:00:00Z} · 소수부 유무 무관(밀리초 미만은 <b>절단</b>).</li>
 *   <li>오프셋 표기 — {@code 2026-01-01T09:00:00+09:00}.</li>
 *   <li>{@code YYYY-MM-DD} 날짜만 — <b>UTC 자정</b>(JS {@code Date.parse}도 날짜만 표기는 UTC다).</li>
 * </ol>
 *
 * <h2>그 밖은 전부 {@code null}이다 — 의도된 divergence</h2>
 * <b>오프셋 없는 날짜-시각</b>({@code 2026-01-01T09:00})과 레거시 문자열({@code Jan 1, 2026})을 JS는
 * <b>로컬 시간</b>으로 읽는다(2026-08-25 실측, 호스트 TZ = UTC+09:00에서
 * {@code Date.parse('2026-01-01T09:00') === Date.parse('2026-01-01T00:00:00Z')}). 그것을 이식하면
 * <b>서버 시간대가 배부 도래 판정에 들어온다</b> — 배포 환경마다 결과가 갈리고, 시간대 설정 하나로
 * 엠바고가 앞당겨 나갈 수 있다(외부로 나간 기사는 회수 수단이 없다). 그래서
 * {@code ZoneId.systemDefault()}를 <b>읽지 않는다</b>.
 *
 * <p><b>틀리는 방향은 안전측이다</b>: {@code null}은 "미도래"로 수렴하므로 배부되지 않고, 그 사실은
 * {@link EmbargoPolicy#unparsableEmbargoFields}가 표면화한다(tick 응답의 {@code invalid} 배열) —
 * 무음 삼킴이 아니다.
 */
public final class NodeInstants {

	/** 날짜만 표기는 <b>정확히</b> 이 모양이다. {@code LocalDate.parse}에 맡기면 확장 연도 표기가 새어 든다. */
	private static final Pattern DATE_ONLY = Pattern.compile("\\d{4}-\\d{2}-\\d{2}");

	/**
	 * ISO-8601 시각 문자열 → epoch ms. 문자열이 아니거나 위 3범위 밖이면 {@code null}이며
	 * <b>예외를 던지지 않는다</b>(판정 모듈이 호출자를 깨뜨리지 않는다).
	 */
	public static Long parseIsoMillis(Object value) {
		if (!(value instanceof String text) || text.isEmpty()) {
			return null;
		}

		Long zNotation = Iso8601.parseMillis(text);
		if (zNotation != null) {
			return zNotation;
		}

		try {
			if (DATE_ONLY.matcher(text).matches()) {
				return LocalDate.parse(text).atStartOfDay(ZoneOffset.UTC).toInstant().toEpochMilli();
			}
			return OffsetDateTime.parse(text).toInstant().toEpochMilli();
		}
		catch (DateTimeException | ArithmeticException ex) {
			return null;
		}
	}

	private NodeInstants() {
	}
}
