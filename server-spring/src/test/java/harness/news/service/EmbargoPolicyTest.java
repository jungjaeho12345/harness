package harness.news.service;

import static org.junit.jupiter.api.Assertions.assertDoesNotThrow;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;

import java.util.Arrays;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.function.Function;
import org.junit.jupiter.api.Test;

/**
 * 엠바고 배부 판정 — 리포 루트 {@code src/services/embargoPolicy.js}(207행)와 1:1인 <b>순수 모듈</b>의
 * 동작 계약. DB·HTTP·파일시스템·<b>시계</b> 의존이 0이다({@code now}는 항상 인자다 — decisions (6)).
 *
 * <p>기대값의 출처는 계획서가 아니라 <b>Node 정본 실측</b>이다(2026-08-25 — 원본 모듈을 직접 import해
 * 경계 입력 60여 건의 반환을 관측했다).
 *
 * <p><b>여기서 잠그는 것은 안전 기본값의 "방향"이다.</b> 반대 방향은 전부 회수 불가능한 조기 배부로
 * 끝난다:
 * <ul>
 *   <li>{@code now}를 못 읽으면 <b>아무것도 배부하지 않는다</b>(전부 도래로 폴백하면 엠바고 전량 누수).</li>
 *   <li>사이클 경계를 확정 못 하면 <b>전체 이력을 센다</b>(넓게 — "이미 배부됨"을 좁히면 중복·조기 배부).</li>
 *   <li>{@code id}를 알 수 없는 {@code distribute} 행은 이번 사이클에 <b>포함해서</b> 센다.</li>
 *   <li>{@code EPS → DES} 역행은 하지 않는다.</li>
 * </ul>
 *
 * <p>계약 하네스가 <b>영원히 관측하지 못하는</b> 축도 여기 있다(phase 69 forward_notes (4)⑨): 계약
 * 픽스처의 엠바고 시각은 전부 미래라 <b>과거 시각·동시각·파싱 불가</b> 3변형은 Java가 유일한 방어선이다.
 */
class EmbargoPolicyTest {

	private static final String PRESS_AT = "2026-01-01T00:00:00.000Z";

	private static final String NONPRESS_AT = "2026-01-02T00:00:00.000Z";

	/** 두 엠바고가 모두 지난 시각. */
	private static final String AFTER_BOTH = "2026-01-03T00:00:00.000Z";

	private static final Function<String, Object> BOTH_SET =
			contents("embargoAt", PRESS_AT, "secondEmbargoAt", NONPRESS_AT);

	// --- 상수 -----------------------------------------------------------------------------------------

	@Test
	void theDistributableStatusGateIsExactlyThreeStatuses() {
		assertEquals(List.of("DES", "EPS", "DPS"), EmbargoPolicy.EMBARGO_DISTRIBUTABLE_STATUSES,
				"송고 훅·tick·쓰기 직전 TOCTOU 가드·재전송이 공유하는 단일 출처다 — 복제도 확장도 금지");
	}

	@Test
	void theCycleScopedStatusesAreExactlyTwoAndDpsIsNotOneOfThem() {
		assertEquals(List.of("DES", "EPS"), EmbargoPolicy.CYCLE_SCOPED_STATUSES,
				"DPS를 넣으면 tick이 이미 배부된 수신처로 중복 배부한다(회수 불가)");
	}

	@Test
	void theConstantsAreImmutable() {
		assertThrows(UnsupportedOperationException.class,
				() -> EmbargoPolicy.EMBARGO_DISTRIBUTABLE_STATUSES.add("RDS"),
				"게이트 목록에 상태를 밀어 넣을 수 있으면 KILL 기사가 나간다");
		assertThrows(UnsupportedOperationException.class,
				() -> EmbargoPolicy.CYCLE_SCOPED_STATUSES.add("DPS"));
	}

	// --- requiredKinds ---------------------------------------------------------------------------------

	@Test
	void requiredKindsFollowsTheFieldOrderAndJsFalsySemantics() {
		assertEquals(List.of("press"), EmbargoPolicy.requiredKinds(contents("embargoAt", PRESS_AT)));
		assertEquals(List.of("nonpress"), EmbargoPolicy.requiredKinds(contents("secondEmbargoAt", NONPRESS_AT)));
		// 수집 순서가 아니라 상수 순서(press → nonpress)다 — 2차를 먼저 담아도 순서가 고정된다.
		assertEquals(List.of("press", "nonpress"),
				EmbargoPolicy.requiredKinds(contents("secondEmbargoAt", NONPRESS_AT, "embargoAt", PRESS_AT)));
		assertEquals(List.of(), EmbargoPolicy.requiredKinds(contents("embargoAt", "", "secondEmbargoAt", "")),
				"빈 문자열은 미설정이다(Node falsy 의미론)");
		assertEquals(List.of(), EmbargoPolicy.requiredKinds(contents("embargoAt", null)));
		assertEquals(List.of(), EmbargoPolicy.requiredKinds(contents()));
	}

	@Test
	void requiredKindsTreatsWhitespaceAsSetBecauseJsBooleanDoes() {
		// Node 실측: requiredKinds({embargoAt:'   '}) => ['press']. trim하지 않는다 —
		// ArticleLifecycleService의 DES 진입 판정과 같은 방향이어야 등가성이 성립한다.
		assertEquals(List.of("press"), EmbargoPolicy.requiredKinds(contents("embargoAt", "   ")));
		// 파싱은 불가하므로 "설정됐지만 도래하지 않는다" — 그 사실은 unparsableEmbargoFields가 표면화한다.
		assertEquals(List.of("embargoAt"),
				EmbargoPolicy.unparsableEmbargoFields(contents("embargoAt", "   ")));
	}

	@Test
	void requiredKindsIsFalseForZeroAndFalseJustLikeJsBoolean() {
		assertEquals(List.of(), EmbargoPolicy.requiredKinds(contents("embargoAt", 0)));
		assertEquals(List.of(), EmbargoPolicy.requiredKinds(contents("embargoAt", Boolean.FALSE)));
		assertEquals(List.of("press"), EmbargoPolicy.requiredKinds(contents("embargoAt", 1)));
		assertEquals(List.of("press"), EmbargoPolicy.requiredKinds(contents("embargoAt", Boolean.TRUE)));
	}

	// --- distributedKinds ("역사상 어디로 나갔나") ------------------------------------------------------

	@Test
	void distributedKindsCollectsOnlyDistributeRowsInConstantOrder() {
		assertEquals(List.of("press", "nonpress"), EmbargoPolicy.distributedKinds(rows(
				row("id", 2, "eventType", "distribute", "action", "nonpress"),
				row("id", 1, "eventType", "distribute", "action", "press"))),
				"이력은 id DESC로 오지만 반환은 상수 순서다(단언 안정성)");
		assertEquals(List.of(), EmbargoPolicy.distributedKinds(rows(
				row("eventType", "distribute", "action", "bogus"),
				row("eventType", "status", "action", "press"),
				row("eventType", "distribute-failed", "action", "press"))),
				"distribute 이외의 eventType과 KINDS 밖의 action은 근거가 아니다");
	}

	@Test
	void distributedKindsSurvivesNullRowsAndNullInput() {
		assertEquals(List.of("press"), EmbargoPolicy.distributedKinds(
				Arrays.asList(null, row("eventType", "distribute", "action", "press"))));
		assertEquals(List.of(), EmbargoPolicy.distributedKinds(null));
		assertEquals(List.of(), EmbargoPolicy.distributedKinds(List.of()));
	}

	// --- latestSendId (사이클 경계) ---------------------------------------------------------------------

	@Test
	void latestSendIdPicksTheMaximumIntegerIdOfSendRowsWithoutRelyingOnOrder() {
		// Node 실측 => 7. 문자열 '11'과 12.5는 정수가 아니라 후보에서 빠지고, hold(9)는 send가 아니다.
		assertEquals(7L, EmbargoPolicy.latestSendId(rows(
				row("id", 3, "eventType", "status", "action", "send"),
				row("id", 9, "eventType", "status", "action", "hold"),
				row("id", 7, "eventType", "status", "action", "send"),
				row("id", "11", "eventType", "status", "action", "send"),
				row("id", 12.5, "eventType", "status", "action", "send"),
				row("eventType", "status", "action", "send"))));
	}

	@Test
	void latestSendIdIsNullWhenTheBoundaryCannotBeDetermined() {
		assertNull(EmbargoPolicy.latestSendId(rows()));
		assertNull(EmbargoPolicy.latestSendId(null));
		assertNull(EmbargoPolicy.latestSendId(rows(row("id", 5, "eventType", "distribute", "action", "press"))));
		assertNull(EmbargoPolicy.latestSendId(rows(row("id", "10", "eventType", "status", "action", "send"))),
				"id가 정수가 아닌 송고 행은 경계가 되지 못한다");
	}

	@Test
	void latestSendIdNeverUsesCreatedAt() {
		// 같은 밀리초 충돌·백필 데이터로 시각은 신뢰도가 낮다 — 단조 증가하는 id만이 결정적이다.
		assertEquals(2L, EmbargoPolicy.latestSendId(rows(
				row("id", 2, "eventType", "status", "action", "send", "createdAt", "2020-01-01T00:00:00.000Z"),
				row("id", 1, "eventType", "status", "action", "send", "createdAt", "2030-01-01T00:00:00.000Z"))));
	}

	// --- cycleDistributedKinds ("이번 사이클에 이미 보냈나") ---------------------------------------------

	@Test
	void theCycleBoundaryDropsDistributionsFromEarlierCycles() {
		List<Map<String, Object>> history = rows(
				row("id", 10, "eventType", "status", "action", "send"),
				row("id", 5, "eventType", "distribute", "action", "press"),
				row("id", 20, "eventType", "distribute", "action", "nonpress"));

		assertEquals(List.of("nonpress"), EmbargoPolicy.cycleDistributedKinds("DES", history));
		assertEquals(List.of("nonpress"), EmbargoPolicy.cycleDistributedKinds("EPS", history));
	}

	@Test
	void statusesOutsideTheCycleScopeCountTheWholeHistory() {
		List<Map<String, Object>> history = rows(
				row("id", 10, "eventType", "status", "action", "send"),
				row("id", 5, "eventType", "distribute", "action", "press"),
				row("id", 20, "eventType", "distribute", "action", "nonpress"));

		assertEquals(List.of("press", "nonpress"), EmbargoPolicy.cycleDistributedKinds("DPS", history),
				"DPS(완결·레거시)는 재송고 정정본 계약상 전체 이력을 본다");
		assertEquals(List.of("press", "nonpress"), EmbargoPolicy.cycleDistributedKinds("RDS", history));
		assertEquals(List.of("press", "nonpress"), EmbargoPolicy.cycleDistributedKinds(null, history),
				"status가 null이어도 NPE 없이 전체 이력이다");
	}

	@Test
	void anUndeterminableBoundaryFallsBackToTheWholeHistoryNotToNothing() {
		// 폴백 방향이 계약이다: "배부 이력 없음"으로 떨어지면 엠바고 시각 전 배부로 이어진다.
		assertEquals(List.of("press"), EmbargoPolicy.cycleDistributedKinds("DES",
				rows(row("id", 5, "eventType", "distribute", "action", "press"))),
				"송고 이력이 없으면 전체 이력을 센다");
		assertEquals(List.of("press"), EmbargoPolicy.cycleDistributedKinds("DES", rows(
				row("id", "10", "eventType", "status", "action", "send"),
				row("id", 5, "eventType", "distribute", "action", "press"))),
				"경계 id가 정수가 아니어도 전체 이력을 센다");
	}

	/**
	 * <b>안전측 방향</b>: 순서를 모르는 행은 "센다" 쪽이다. 순진한 {@code id > boundary}는
	 * {@code undefined > n === false}라 그 행을 빼는데, 그러면 "이미 배부됨"이 좁아져 조기 배부가 된다.
	 */
	@Test
	void aDistributeRowWithNoIdCountsAsPartOfTheCurrentCycle() {
		assertEquals(List.of("press"), EmbargoPolicy.cycleDistributedKinds("DES", rows(
				row("id", 10, "eventType", "status", "action", "send"),
				row("eventType", "distribute", "action", "press"))));
		assertEquals(List.of("press"), EmbargoPolicy.cycleDistributedKinds("DES", rows(
				row("id", 10, "eventType", "status", "action", "send"),
				row("id", "abc", "eventType", "distribute", "action", "press"))),
				"id가 정수가 아닌 distribute 행도 포함해서 센다");
	}

	@Test
	void theBoundaryComparisonIsStrictlyGreaterThan() {
		// 송고 이력은 배부 훅보다 먼저 insert되므로 같은 id일 수 없다 — 경계 행 자체는 이번 사이클이 아니다.
		assertEquals(List.of(), EmbargoPolicy.cycleDistributedKinds("DES", rows(
				row("id", 10, "eventType", "status", "action", "send"),
				row("id", 10, "eventType", "distribute", "action", "press"))));
	}

	@Test
	void cycleDistributedKindsSurvivesEmptyAndNullInput() {
		assertEquals(List.of(), EmbargoPolicy.cycleDistributedKinds("DES", null));
		assertEquals(List.of(), EmbargoPolicy.cycleDistributedKinds(null, null));
	}

	// --- unparsableEmbargoFields ------------------------------------------------------------------------

	@Test
	void unparsableFieldsAreSurfacedInConstantOrderAndUnsetFieldsAreNotCandidates() {
		assertEquals(List.of("embargoAt"), EmbargoPolicy.unparsableEmbargoFields(contents("embargoAt", "오타")));
		assertEquals(List.of(), EmbargoPolicy.unparsableEmbargoFields(contents("embargoAt", "")),
				"빈 문자열은 미설정이라 대상이 아니다(무음 삼킴이 아니라 애초에 후보가 아니다)");
		assertEquals(List.of("embargoAt", "secondEmbargoAt"), EmbargoPolicy.unparsableEmbargoFields(
				contents("secondEmbargoAt", "언젠가", "embargoAt", "not-a-date")),
				"두 필드 모두 오타여도 순서는 상수 순서다");
		assertEquals(List.of("secondEmbargoAt"), EmbargoPolicy.unparsableEmbargoFields(
				contents("embargoAt", PRESS_AT, "secondEmbargoAt", "언젠가")));
		assertEquals(List.of(), EmbargoPolicy.unparsableEmbargoFields(BOTH_SET));
	}

	/**
	 * 오프셋 없는 날짜-시각은 Node에서는 파싱되지만(로컬 시간) 여기서는 파싱 불가다 — <b>의도된
	 * divergence</b>(decisions (7))이고, 조용히 삼키지 않고 {@code invalid}로 표면화된다.
	 */
	@Test
	void anOffsetLessDateTimeIsSurfacedAsUnparsableRatherThanGuessedWithTheServerTimeZone() {
		assertEquals(List.of("embargoAt"),
				EmbargoPolicy.unparsableEmbargoFields(contents("embargoAt", "2026-01-01T09:00")));
		assertEquals(List.of(), EmbargoPolicy.dueKinds("DES", contents("embargoAt", "2026-01-01T09:00"),
				null, AFTER_BOTH), "파싱 불가한 필드는 도래하지 않는다(안전측)");
	}

	// --- dueKinds: 시계 ---------------------------------------------------------------------------------

	/**
	 * <b>이 테스트가 없으면 "전 기사가 조용히 미배부"도 통과하고, 반대 변이(전부 도래)는 엠바고 전량
	 * 누수다.</b> {@code now}는 언제나 ISO-8601 UTC <b>문자열</b>이다 — 숫자 epoch ms를 넘기면 Node도
	 * {@code Date.parse(숫자)=NaN}이라 미배부로 떨어진다.
	 */
	@Test
	void anUnreadableNowDistributesNothing() {
		for (Object now : Arrays.asList(null, "", "not-a-date", 1767225600000L, 1767225600000.0, 42,
				"2026-01-03T09:00")) {
			assertEquals(List.of(), EmbargoPolicy.dueKinds("DES", BOTH_SET, null, now),
					String.valueOf(now) + ": 잘못된 시계로 조기 배부하지 않는다");
		}
	}

	/** 경계 시각 3종. {@code <=}가 계약이다 — {@code <}로 좁히면 정각에 배부되지 않는다. */
	@Test
	void theDueComparisonIncludesTheExactInstant() {
		assertEquals(List.of(), EmbargoPolicy.dueKinds("DES", BOTH_SET, null, "2025-12-31T23:59:59.999Z"),
				"1ms 전: 미도래");
		assertEquals(List.of("press"), EmbargoPolicy.dueKinds("DES", BOTH_SET, null, PRESS_AT),
				"정확히 같은 시각: 도래한다(<=)");
		assertEquals(List.of("press"), EmbargoPolicy.dueKinds("DES", BOTH_SET, null, "2026-01-01T00:00:00.001Z"),
				"1ms 후: 도래한다");
		assertEquals(List.of("press", "nonpress"), EmbargoPolicy.dueKinds("DES", BOTH_SET, null, AFTER_BOTH),
				"둘 다 지났으면 둘 다 도래한다(상수 순서)");
	}

	/** 계약 픽스처는 전부 미래 시각이라 이 축(과거 시각)은 Java가 유일한 방어선이다. */
	@Test
	void aLongPastEmbargoIsDueImmediately() {
		assertEquals(List.of("press"), EmbargoPolicy.dueKinds("DES",
				contents("embargoAt", "2000-01-01T00:00:00.000Z"), null, AFTER_BOTH));
	}

	// --- dueKinds: 게이트·멱등 --------------------------------------------------------------------------

	@Test
	void onlyTheThreeDistributableStatusesCanBeDue() {
		for (String status : List.of("DES", "EPS", "DPS")) {
			assertEquals(List.of("press", "nonpress"), EmbargoPolicy.dueKinds(status, BOTH_SET, null, AFTER_BOTH),
					status + ": 배부 가능 상태다");
		}
		for (String status : List.of("RDS", "RRH", "RRK", "DDH", "DDK", "EEK", "EEH", "DPD", "")) {
			assertEquals(List.of(), EmbargoPolicy.dueKinds(status, BOTH_SET, null, AFTER_BOTH),
					status + ": 이 게이트가 유일한 방어선이다 — 한 번 나간 기사는 회수 수단이 없다");
		}
		assertEquals(List.of(), EmbargoPolicy.dueKinds(null, BOTH_SET, null, AFTER_BOTH),
				"status가 null이어도 NPE가 아니라 미배부다(Set.of(...).contains(null)은 NPE다)");
	}

	@Test
	void alreadyDistributedKindsAreNotDistributedAgain() {
		assertEquals(List.of("nonpress"), EmbargoPolicy.dueKinds("DES", BOTH_SET, List.of("press"), AFTER_BOTH),
				"멱등 — tick 중복 호출에도 재배부하지 않는다");
		assertEquals(List.of(), EmbargoPolicy.dueKinds("DES", BOTH_SET, List.of("press", "nonpress"), AFTER_BOTH));
		assertEquals(List.of("press"), EmbargoPolicy.dueKinds("DES", BOTH_SET,
				Arrays.asList("bogus", null, "nonpress"), AFTER_BOTH),
				"KINDS 밖의 값과 null은 버린다");
		assertEquals(List.of("press", "nonpress"), EmbargoPolicy.dueKinds("DES", BOTH_SET, null, AFTER_BOTH));
	}

	@Test
	void anUnsetOrUnparsableFieldIsNeverDue() {
		assertEquals(List.of("nonpress"), EmbargoPolicy.dueKinds("DES",
				contents("embargoAt", "오타", "secondEmbargoAt", NONPRESS_AT), null, AFTER_BOTH));
		assertEquals(List.of(), EmbargoPolicy.dueKinds("DES", contents("embargoAt", ""), null, AFTER_BOTH));
		assertEquals(List.of(), EmbargoPolicy.dueKinds("DES", contents(), null, AFTER_BOTH));
	}

	@Test
	void aDateOnlyEmbargoIsDueFromUtcMidnight() {
		assertEquals(List.of("press"), EmbargoPolicy.dueKinds("DES", contents("embargoAt", "2026-01-01"),
				null, PRESS_AT));
		assertEquals(List.of(), EmbargoPolicy.dueKinds("DES", contents("embargoAt", "2026-01-01"),
				null, "2025-12-31T23:59:59.999Z"));
	}

	// --- embargoStatusFor -------------------------------------------------------------------------------

	@Test
	void completionMovesToDpsAndPartialDistributionMovesToEps() {
		assertEquals("DPS", EmbargoPolicy.embargoStatusFor("DES", contents("embargoAt", PRESS_AT),
				List.of("press")), "1차만 설정된 기사는 첫 배부가 곧 완결이다");
		assertEquals("EPS", EmbargoPolicy.embargoStatusFor("DES", BOTH_SET, List.of("press")));
		assertEquals("DPS", EmbargoPolicy.embargoStatusFor("EPS", BOTH_SET, List.of("press", "nonpress")));
		assertEquals("DPS", EmbargoPolicy.embargoStatusFor("DES", contents("secondEmbargoAt", NONPRESS_AT),
				List.of("nonpress")));
		assertEquals("EPS", EmbargoPolicy.embargoStatusFor("DES", contents("secondEmbargoAt", NONPRESS_AT),
				List.of("press")), "2차만 설정된 기사의 송고 즉시 press 배부는 완결 요건이 아니다");
	}

	/** <b>역행 금지</b> — 이력 유실·부분 실패로 뒤로 가지 않는다. */
	@Test
	void anEpsArticleNeverFallsBackToDes() {
		assertNull(EmbargoPolicy.embargoStatusFor("EPS", BOTH_SET, null),
				"EPS인데 배부 근거가 안 보인다고 DES로 되돌리지 않는다");
		assertNull(EmbargoPolicy.embargoStatusFor("EPS", BOTH_SET, List.of()));
		assertNull(EmbargoPolicy.embargoStatusFor("EPS", contents("embargoAt", PRESS_AT), List.of()));
	}

	@Test
	void statusesOutsideTheMutableSetAreNeverTouched() {
		for (String status : List.of("DPS", "EEK", "EEH", "DPD", "RDS", "DDH", "DDK", "RRH", "RRK")) {
			assertNull(EmbargoPolicy.embargoStatusFor(status, BOTH_SET, List.of("press", "nonpress")),
					status + ": 상태 역행·부활 금지 — 이 모듈이 건드리는 것은 DES·EPS뿐이다");
		}
		assertNull(EmbargoPolicy.embargoStatusFor(null, BOTH_SET, List.of("press")));
	}

	@Test
	void anArticleWithoutAnEmbargoIsNotThisModulesBusiness() {
		assertNull(EmbargoPolicy.embargoStatusFor("DES", contents(), List.of("press")));
		assertNull(EmbargoPolicy.embargoStatusFor("DES", contents("embargoAt", "", "secondEmbargoAt", ""),
				List.of("press")));
	}

	@Test
	void noWriteIsProposedWhenTheStatusIsAlreadyCorrect() {
		assertNull(EmbargoPolicy.embargoStatusFor("DES", BOTH_SET, null), "무의미한 쓰기 금지");
		assertNull(EmbargoPolicy.embargoStatusFor("EPS", BOTH_SET, List.of("press")));
	}

	// --- 호출자를 깨뜨리지 않는다 -----------------------------------------------------------------------

	@Test
	void nonObjectInputsDoNotThrow() {
		assertDoesNotThrow(() -> {
			assertEquals(List.of(), EmbargoPolicy.requiredKinds(null));
			assertEquals(List.of(), EmbargoPolicy.unparsableEmbargoFields(null));
			assertEquals(List.of(), EmbargoPolicy.dueKinds("DES", null, null, AFTER_BOTH));
			assertNull(EmbargoPolicy.embargoStatusFor("DES", null, null));
			assertEquals(List.of(), EmbargoPolicy.distributedKinds(null));
			assertEquals(List.of(), EmbargoPolicy.cycleDistributedKinds(null, null));
			assertNull(EmbargoPolicy.latestSendId(null));
		});
	}

	/** 반환 배열은 호출자가 고칠 수 없다 — 판정 결과가 흘러다니며 변조되면 추적이 불가능하다. */
	@Test
	void theReturnedListsAreImmutable() {
		assertThrows(UnsupportedOperationException.class,
				() -> EmbargoPolicy.dueKinds("DES", BOTH_SET, null, AFTER_BOTH).add("press"));
		assertThrows(UnsupportedOperationException.class,
				() -> EmbargoPolicy.requiredKinds(BOTH_SET).add("press"));
	}

	// --- 헬퍼 -------------------------------------------------------------------------------------------

	/** {@code ContentsRow.column}과 같은 모양의 접근자 — 모듈이 model 타입에 묶이지 않는다는 증거다. */
	private static Function<String, Object> contents(Object... keyValues) {
		return row(keyValues)::get;
	}

	private static Map<String, Object> row(Object... keyValues) {
		Map<String, Object> row = new LinkedHashMap<>();
		for (int i = 0; i < keyValues.length; i += 2) {
			row.put(String.valueOf(keyValues[i]), keyValues[i + 1]);
		}
		return row;
	}

	@SafeVarargs
	private static List<Map<String, Object>> rows(Map<String, Object>... items) {
		return Arrays.asList(items);
	}
}
