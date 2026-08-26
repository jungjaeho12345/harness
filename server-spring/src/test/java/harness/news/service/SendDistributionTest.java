package harness.news.service;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.function.Function;
import org.junit.jupiter.api.Test;

/**
 * 송고 즉시 배부의 <b>순수 판정</b> — 리포 루트 {@code src/services/articleService.js} 86~94행
 * ({@code distributionKindsForSend})의 동작 계약이다.
 *
 * <p>기대값의 출처는 계획서 문구가 아니라 <b>Node 실측</b>이다(2026-08-26 · {@code node -e}로 원본을
 * 직접 불러 상태 4종 × 엠바고 조합 × {@code already} 변형 27건을 표로 떴다).
 *
 * <p>여기서 잠그는 것은 넷이다.
 * <ol>
 *   <li><b>판정표 4행</b> — {@code DPS}+미설정 전량 · {@code DPS}+설정은 이미 배부된 kind에만(정정본) ·
 *       {@code DES}+2차만 설정은 {@code press} · 그 밖은 없음.</li>
 *   <li><b>순서는 언제나 {@code press} → {@code nonpress}</b>다(호출자가 준 순서가 아니다).</li>
 *   <li><b>시각 비교가 없다</b> — "지금이 엠바고 시각인가"는 tick의 질문이다. 과거 시각이든 미래 시각이든
 *       판정이 같아야 한다.</li>
 *   <li><b>{@code already}는 kind 2종만 본다</b> — {@code null}·미지 값·{@code null} 원소에 던지지 않는다.</li>
 * </ol>
 */
class SendDistributionTest {

	private static final String FUTURE = "2999-01-01T00:00:00.000Z";

	private static final String PAST = "1999-01-01T00:00:00.000Z";

	private static final List<String> BOTH = List.of("press", "nonpress");

	private static final List<String> PRESS_ONLY = List.of("press");

	private static final List<String> NONE = List.of();

	/** Contents 시간 컬럼이 실제로 가질 수 있는 4형태 — D-11 그리드와 <b>같은 형태 목록</b>이다. */
	private static final Map<String, Object> FORMS = forms();

	private static Map<String, Object> forms() {
		Map<String, Object> forms = new LinkedHashMap<>();
		forms.put("설정", FUTURE);
		forms.put("빈문자열", "");
		forms.put("NULL", null);
		forms.put("공백만", "   ");
		return forms;
	}

	/** 공백 문자열은 <b>설정</b>이다(Node falsy 의미론 — trim하지 않는다). */
	private static boolean set(Object form) {
		return form != null && !"".equals(form);
	}

	// --- 1. 판정표 전건(Node 실측 표) ---------------------------------------------------------------

	@Test
	void theTableMatchesTheNodeMeasurementRowForRow() {
		assertEquals(BOTH, kinds("DPS", contents(), List.of()), "DPS + 엠바고 미설정 → 전량");
		assertEquals(BOTH, kinds("DPS", contents(), PRESS_ONLY), "DPS + 미설정은 already를 보지 않는다");
		assertEquals(NONE, kinds("DPS", contents("embargoAt", FUTURE), List.of()),
				"DPS + 엠바고 설정 + 배부 이력 없음 → 없음(안전 기본값)");
		assertEquals(PRESS_ONLY, kinds("DPS", contents("embargoAt", FUTURE), PRESS_ONLY),
				"DPS + 엠바고 설정 → 이미 배부된 kind에만(정정본)");
		assertEquals(List.of("nonpress"), kinds("DPS", contents("secondEmbargoAt", FUTURE), List.of("nonpress")),
				"정정본은 나갔던 kind만 따라간다");
		assertEquals(BOTH, kinds("DPS", contents("embargoAt", FUTURE, "secondEmbargoAt", FUTURE), BOTH),
				"둘 다 나갔으면 둘 다 정정본");
		assertEquals(PRESS_ONLY, kinds("DES", contents("secondEmbargoAt", FUTURE), List.of()),
				"DES + 2차만 설정 → 송고 즉시 언론사");
		assertEquals(NONE, kinds("DES", contents("embargoAt", FUTURE, "secondEmbargoAt", FUTURE), List.of()),
				"1+2차는 즉시 배부 없음(1차 시각에 언론사 — tick의 몫)");
		assertEquals(NONE, kinds("DES", contents("embargoAt", FUTURE), List.of()), "1차만 설정도 즉시 배부 없음");
		assertEquals(NONE, kinds("DES", contents(), List.of()), "엠바고 없는 DES는 도달 불가지만 판정은 없음이다");
		assertEquals(NONE, kinds("RDS", contents(), List.of()), "R의 송고(RDS 유지)는 배부가 없다");
		assertEquals(NONE, kinds("EPS", contents("secondEmbargoAt", FUTURE), List.of()),
				"EPS는 이 표에 없다(승격은 배부가 실행된 뒤 syncEmbargoStatus가 만든다)");
		assertEquals(NONE, kinds("DDH", contents(), List.of()), "표 밖 상태는 전부 없음");
		assertEquals(NONE, kinds(null, contents(), List.of()), "status가 null이어도 던지지 않는다");
	}

	// --- 2. DPS 행: 엠바고 설정 판정은 requiredKinds와 같은 것을 본다 -------------------------------

	@Test
	void theDpsRowSwitchesExactlyWhereRequiredKindsBecomesNonEmpty() {
		int fullCells = 0;
		int correctionCells = 0;
		for (Map.Entry<String, Object> first : FORMS.entrySet()) {
			for (Map.Entry<String, Object> second : FORMS.entrySet()) {
				String label = "embargoAt=" + first.getKey() + " secondEmbargoAt=" + second.getKey();
				Function<String, Object> contents = contents("embargoAt", first.getValue(),
						"secondEmbargoAt", second.getValue());
				boolean embargoRequired = !EmbargoPolicy.requiredKinds(contents).isEmpty();
				assertEquals(set(first.getValue()) || set(second.getValue()), embargoRequired,
						label + ": 설정 판정의 단일 출처는 requiredKinds다");

				// already에 press만 담아 두 분기를 구분한다: 미설정이면 전량, 설정이면 정정본(press)이다.
				List<String> result = kinds("DPS", contents, PRESS_ONLY);
				assertEquals(embargoRequired ? PRESS_ONLY : BOTH, result, label + ": DPS 행의 결과");
				if (embargoRequired) {
					correctionCells++;
				}
				else {
					fullCells++;
				}
			}
		}
		assertEquals(16, fullCells + correctionCells, "4형태 × 2컬럼 = 16칸을 전수로 본다");
		assertEquals(4, fullCells, "미설정 조합은 빈 문자열·NULL의 4칸뿐이다");
		assertEquals(12, correctionCells, "공백만도 '설정'이다");
	}

	// --- 3. DES 행: 1차 미설정 && 2차 설정일 때만 press --------------------------------------------

	@Test
	void theDesRowNeedsTheFirstColumnUnsetAndTheSecondSet() {
		int pressCells = 0;
		for (Map.Entry<String, Object> first : FORMS.entrySet()) {
			for (Map.Entry<String, Object> second : FORMS.entrySet()) {
				String label = "embargoAt=" + first.getKey() + " secondEmbargoAt=" + second.getKey();
				boolean secondOnly = !set(first.getValue()) && set(second.getValue());
				List<String> result = kinds("DES",
						contents("embargoAt", first.getValue(), "secondEmbargoAt", second.getValue()), List.of());

				assertEquals(secondOnly ? PRESS_ONLY : NONE, result, label + ": DES 행의 결과");
				if (secondOnly) {
					pressCells++;
				}
			}
		}
		assertEquals(4, pressCells, "2차만 설정 = (빈문자열|NULL) × (설정|공백만) = 4칸이다");
	}

	@Test
	void theDesRowIgnoresAlreadyDistributedKinds() {
		Function<String, Object> contents = contents("secondEmbargoAt", FUTURE);

		// 이미 press로 나갔든 아니든 판정은 같다 — DES 행은 already를 입력으로 쓰지 않는다.
		assertEquals(PRESS_ONLY, kinds("DES", contents, List.of()));
		assertEquals(PRESS_ONLY, kinds("DES", contents, PRESS_ONLY));
		assertEquals(PRESS_ONLY, kinds("DES", contents, BOTH));
	}

	// --- 4. 시각 비교가 없다 ------------------------------------------------------------------------

	@Test
	void noTimeComparisonHappensAnywhereInThisDecision() {
		// 도래한 시각(과거)과 도래하지 않은 시각(미래)의 판정이 같다. 갈리면 시점 판정이 새어 들어온 것이다.
		assertEquals(kinds("DES", contents("secondEmbargoAt", PAST), List.of()),
				kinds("DES", contents("secondEmbargoAt", FUTURE), List.of()));
		assertEquals(kinds("DPS", contents("embargoAt", PAST), PRESS_ONLY),
				kinds("DPS", contents("embargoAt", FUTURE), PRESS_ONLY));
		// 파싱조차 되지 않는 값도 '설정'이다(그 값의 표면화는 tick의 invalid 목록이 한다).
		assertEquals(NONE, kinds("DPS", contents("embargoAt", "내일 아침"), List.of()));
		assertEquals(PRESS_ONLY, kinds("DES", contents("secondEmbargoAt", "내일 아침"), List.of()));
	}

	// --- 5. already의 이상값 -----------------------------------------------------------------------

	@Test
	void alreadyDistributedIsReadAsKindsOnlyAndNeverThrows() {
		Function<String, Object> contents = contents("embargoAt", FUTURE);

		assertEquals(NONE, kinds("DPS", contents, null), "null은 '아는 배부 이력 없음'이다");
		assertEquals(NONE, kinds("DPS", contents, List.of("weird")), "미지 값은 버린다");
		assertEquals(NONE, kinds("DPS", contents, Arrays.asList((String) null)), "null 원소에 던지지 않는다");
		assertEquals(BOTH, kinds("DPS", contents, Arrays.asList("nonpress", null, "weird", "press")),
				"섞여 있어도 kind 2종만 골라 상수 순서로 돌려준다");
	}

	@Test
	void theReturnedOrderIsAlwaysPressThenNonpress() {
		Function<String, Object> contents = contents("embargoAt", FUTURE, "secondEmbargoAt", FUTURE);

		assertEquals(BOTH, kinds("DPS", contents, List.of("nonpress", "press")), "호출자가 준 순서가 아니다");
		assertEquals(BOTH, kinds("DPS", contents, List.of("press", "nonpress")));
		assertEquals(BOTH, kinds("DPS", contents(), List.of("nonpress", "press")), "미설정 전량도 상수 순서다");
	}

	// --- 6. 방어적 입력 -----------------------------------------------------------------------------

	@Test
	void aMissingContentsAccessorIsAnUnsetEmbargo() {
		assertEquals(BOTH, kinds("DPS", null, List.of()), "접근자가 없으면 모든 컬럼이 비어 있는 것으로 본다");
		assertEquals(NONE, kinds("DES", null, List.of()));
	}

	@Test
	void theResultIsImmutable() {
		List<String> result = kinds("DPS", contents(), List.of());

		assertThrows(UnsupportedOperationException.class, () -> result.add("press"));
	}

	// --- 헬퍼 -----------------------------------------------------------------------------------------

	private static List<String> kinds(String status, Function<String, Object> contents, List<String> already) {
		return SendDistribution.kindsForSend(status, contents, already);
	}

	/** 값이 {@code null}인 컬럼도 담아야 하므로 {@code Map.of}를 쓰지 않는다. */
	private static Function<String, Object> contents(Object... pairs) {
		Map<String, Object> row = new LinkedHashMap<>();
		for (int i = 0; i < pairs.length; i += 2) {
			row.put(String.valueOf(pairs[i]), pairs[i + 1]);
		}
		return row::get;
	}

	/** 미사용 경고를 피하기 위한 접점 — 목록 상수의 불변성을 한 번 더 못 박는다. */
	@Test
	void theKindConstantsAreNotShared() {
		List<String> collected = new ArrayList<>(kinds("DPS", contents(), List.of()));
		collected.clear();

		assertEquals(BOTH, kinds("DPS", contents(), List.of()), "반환 목록을 밖에서 비워도 다음 호출은 그대로다");
	}

}
