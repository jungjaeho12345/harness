package harness.news.model;

import java.time.Clock;
import java.time.ZoneOffset;
import java.time.format.DateTimeFormatter;
import java.util.Locale;
import java.util.random.RandomGenerator;

/**
 * 기사 아이디 형식 — 리포 루트 {@code src/db/articleId.js}와 동형(decisions (7)).
 *
 * <p>규칙: {@code AKR} + <b>UTC</b> {@code YYYYMMDD} + 9자리 0채움 난수.
 *
 * <p>날짜가 UTC인 것이 계약이다. Node가 {@code toISOString().slice(0,10)}을 쓰기 때문이며, 로컬 시간대로
 * 바꾸면 KST 09시 이전 구간에서 하루가 어긋나 전환기의 두 서버가 같은 순간에 다른 접두를 발급한다.
 *
 * <p>여기는 <b>형식만</b> 소유한다 — 이미 존재하는 아이디면 다시 뽑는 유일성 확인 루프는
 * ({@code Article}·{@code Contents} 두 테이블을 보는) 리포지토리의 몫이다. 순수 생성기는 DB를 모른다.
 */
public final class ArticleIds {

	private static final DateTimeFormatter UTC_DATE =
			DateTimeFormatter.ofPattern("yyyyMMdd", Locale.ROOT).withZone(ZoneOffset.UTC);

	/** 난수부의 상한(9자리) — {@code [0, 10^9)}. */
	private static final int RANDOM_BOUND = 1_000_000_000;

	/**
	 * @param clock 주입된 시계(ADR-013). 시계에 지역이 붙어 있어도 날짜는 UTC로 읽는다.
	 * @param random 주입된 난수원 — 테스트가 경계를 결정적으로 관측할 수 있게 한다.
	 */
	public static String generate(Clock clock, RandomGenerator random) {
		String date = UTC_DATE.format(clock.instant());
		String suffix = String.format(Locale.ROOT, "%09d", random.nextInt(RANDOM_BOUND));
		return "AKR" + date + suffix;
	}

	private ArticleIds() {
	}
}
