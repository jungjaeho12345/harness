package harness.news.model;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import harness.news.testsupport.MutableClock;
import java.time.Clock;
import java.time.Instant;
import java.time.ZoneId;
import java.util.LinkedHashSet;
import java.util.Random;
import java.util.Set;
import java.util.random.RandomGenerator;
import java.util.regex.Pattern;
import org.junit.jupiter.api.Test;

/**
 * 기사 아이디 형식 — 리포 루트 {@code src/db/articleId.js}와 동형(decisions (7)).
 *
 * <p>여기는 <b>형식만</b> 소유한다. 유일성 확인 루프(Article·Contents 두 테이블 조회)는 리포지토리의
 * 몫이다 — 순수 생성기는 DB를 모른다.
 *
 * <p>날짜는 <b>UTC</b>다. Node가 {@code toISOString().slice(0,10)}을 쓰기 때문이며, 로컬 시간대로 바꾸면
 * KST 09시 이전 구간에서 하루가 어긋나 두 서버가 같은 날 다른 접두를 발급한다.
 */
class ArticleIdsTest {

	/** 2026-08-20T15:30:00Z = KST 2026-08-21T00:30 — 로컬 날짜와 UTC 날짜가 갈리는 시각. */
	private static final long KST_NEXT_DAY_MS = 1_787_239_800_000L;

	private static final Pattern FORMAT = Pattern.compile("^AKR[0-9]{8}[0-9]{9}$");

	@Test
	void theIdIsAkrPlusEightDateDigitsPlusNineRandomDigits() {
		String id = ArticleIds.generate(new MutableClock(1_787_229_296_000L), new Random(42));

		assertTrue(FORMAT.matcher(id).matches(), "형식이 계약과 다르다: " + id);
		assertEquals(20, id.length(), "AKR(3) + 날짜(8) + 난수(9) = 20자");
		assertEquals("AKR20260820", id.substring(0, 11));
	}

	@Test
	void theDateIsUtcNotLocal() {
		Clock seoul = Clock.fixed(Instant.ofEpochMilli(KST_NEXT_DAY_MS), ZoneId.of("Asia/Seoul"));

		String id = ArticleIds.generate(seoul, new Random(1));

		assertEquals("AKR20260820", id.substring(0, 11),
				"로컬(KST)로는 08-21이지만 발급 접두는 UTC 날짜 08-20이다");
	}

	@Test
	void theRandomPartIsZeroPaddedToNineDigits() {
		String id = ArticleIds.generate(new MutableClock(1_787_229_296_000L), fixedRandom(7));

		assertEquals("AKR20260820000000007", id);
		assertTrue(FORMAT.matcher(id).matches());
	}

	@Test
	void theRandomPartCoversTheWholeNineDigitRange() {
		String id = ArticleIds.generate(new MutableClock(1_787_229_296_000L), fixedRandom(999_999_999));

		assertEquals("AKR20260820999999999", id);
	}

	@Test
	void consecutiveIdsDifferInTheRandomPartOnly() {
		Clock clock = new MutableClock(1_787_229_296_000L);
		RandomGenerator random = new Random(7);

		Set<String> ids = new LinkedHashSet<>();
		for (int i = 0; i < 50; i++) {
			String id = ArticleIds.generate(clock, random);
			assertEquals("AKR20260820", id.substring(0, 11));
			ids.add(id);
		}

		assertEquals(50, ids.size(), "난수부가 매번 다시 뽑힌다(유일성 확인은 리포지토리 몫이지만 씨앗은 여기다)");
		assertNotEquals(ids.iterator().next(), ids.stream().skip(1).findFirst().orElseThrow());
	}

	/** 난수부의 경계를 결정적으로 관측하기 위한 고정 발생기. */
	private static RandomGenerator fixedRandom(int value) {
		return new RandomGenerator() {

			@Override
			public int nextInt(int bound) {
				assertEquals(1_000_000_000, bound, "난수 범위는 0 이상 10^9 미만이다");
				return value;
			}

			@Override
			public long nextLong() {
				throw new UnsupportedOperationException("nextInt(bound)만 쓴다");
			}
		};
	}
}
