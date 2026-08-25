package harness.news.service;

import static org.junit.jupiter.api.Assertions.assertDoesNotThrow;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import harness.news.service.DistributionFailureLog.Failure;
import java.lang.reflect.RecordComponent;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import org.junit.jupiter.api.Test;

/**
 * 배부 실패 원장 파생 — 리포 루트 {@code src/services/distributionFailureLog.js}(106행)와 1:1인
 * <b>순수 모듈</b>의 동작 계약. DB·HTTP·파일시스템·시계 의존이 0이다.
 *
 * <p>기대값의 출처는 계획서가 아니라 <b>Node 정본 실측</b>이다(2026-08-25 — 원본 모듈을 직접 import해
 * 경계 입력 40여 건의 반환을 관측했다).
 *
 * <p><b>여기서 잠그는 것 4가지.</b>
 * <ol>
 *   <li><b>그룹 키는 (articleId, targetId, action) 3원소</b>다. {@code action}을 빼면 같은 쌍의 한 kind가
 *       다른 kind의 재전송으로 "해소"되어 <b>영구 복구 불가</b>가 된다(목록에서 사라지고, 목록에 없으면
 *       재전송 게이트도 거부한다).</li>
 *   <li><b>판정은 이 파생 하나뿐</b>이다 — 목록({@code GET /api/distribution/failures})과 재전송 게이트가
 *       같은 함수를 부른다. 게이트가 규칙을 복제하면 <b>목록에 없는 실패로 재전송이 통과</b>한다(인가 우회).</li>
 *   <li><b>{@code RETRYABLE_FAILURE_REASONS}는 정확히 3개</b>다. {@code status-changed}·
 *       {@code spool-disabled}를 담으면 영원히 해소되지 않는 항목이 원장에 쌓인다.</li>
 *   <li><b>반환에 경로성 필드가 없다</b>({@code spoolDir}·{@code file}) — 이 값은 HTTP 응답으로 나간다.</li>
 * </ol>
 *
 * <p>원장은 append-only라 "해소됨"도 새 행({@code distribute-retry})으로만 표현된다 — 실패 행을 갱신하지도
 * 지우지도 않는다(ADR-008 (6)).
 */
class DistributionFailureLogTest {

	private static final String FAILED = "distribute-failed";

	private static final String RETRY = "distribute-retry";

	private static final String ARTICLE = "A1";

	private static final String AT = "2026-08-25T00:00:00.000Z";

	// --- 상수 -----------------------------------------------------------------------------------------

	@Test
	void theEventTypeVocabularyIsExactlyTheTwoLedgerEvents() {
		assertEquals(FAILED, DistributionFailureLog.DISTRIBUTE_FAILED_EVENT);
		assertEquals(RETRY, DistributionFailureLog.DISTRIBUTE_RETRY_EVENT);
	}

	/** 11번 — 목록이 커지면 재전송 대상이 조용히 넓어진다. 크기까지 단언한다. */
	@Test
	void theRetryableReasonsAreExactlyThreeTokens() {
		assertEquals(List.of("spool-write-failed", "invalid-spool-dir", "invalid-article-id"),
				DistributionFailureLog.RETRYABLE_FAILURE_REASONS,
				"spoolWriter가 실제로 돌려주는 수신처 단위 실패 3종뿐이다 — 늘리지 마라");
		assertEquals(3, DistributionFailureLog.RETRYABLE_FAILURE_REASONS.size());
	}

	@Test
	void theRetryableReasonsAreImmutable() {
		assertThrows(UnsupportedOperationException.class,
				() -> DistributionFailureLog.RETRYABLE_FAILURE_REASONS.add("status-changed"),
				"목록에 사유를 밀어 넣을 수 있으면 재전송 대상이 런타임에 넓어진다");
	}

	@Test
	void isRetryableFailureReasonAcceptsOnlyTheThreeTokens() {
		assertTrue(DistributionFailureLog.isRetryableFailureReason("spool-write-failed"));
		assertTrue(DistributionFailureLog.isRetryableFailureReason("invalid-spool-dir"));
		assertTrue(DistributionFailureLog.isRetryableFailureReason("invalid-article-id"));
		// status-changed는 기사가 배부 불가로 전이된 "안전 중단"이라 재전송 대상이 아니다.
		assertFalse(DistributionFailureLog.isRetryableFailureReason("status-changed"));
		// spool-disabled는 특정 수신처의 실패가 아니라 배부 기능 자체가 꺼진 상태다.
		assertFalse(DistributionFailureLog.isRetryableFailureReason("spool-disabled"));
		assertFalse(DistributionFailureLog.isRetryableFailureReason(null));
		assertFalse(DistributionFailureLog.isRetryableFailureReason(7));
		assertFalse(DistributionFailureLog.isRetryableFailureReason(""));
		// Node 실측: 공백·대문자 관용은 없다(정확 일치뿐).
		assertFalse(DistributionFailureLog.isRetryableFailureReason(" spool-write-failed "));
		assertFalse(DistributionFailureLog.isRetryableFailureReason("SPOOL-WRITE-FAILED"));
	}

	// --- 1~3. 그룹 접기와 해소 -------------------------------------------------------------------------

	/** 1번 — 같은 그룹의 실패 2건은 1건으로 접히고 남는 것은 <b>최신</b>(사유·시각·historyId)이다. */
	@Test
	void repeatedFailuresInOneGroupCollapseToTheLatestRow() {
		List<Failure> items = DistributionFailureLog.unresolvedFailures(List.of(
				failed(5, 3, "press", "invalid-article-id", "older"),
				failed(6, 3, "press", "spool-write-failed", "newer")));

		assertEquals(1, items.size());
		assertEquals(6L, items.get(0).historyId());
		assertEquals("spool-write-failed", items.get(0).reason());
		assertEquals("newer", items.get(0).failedAt());
	}

	/** 2번 — 그룹의 최신 행이 재전송이면 해소다(목록에서 사라진다). */
	@Test
	void aRetryRecordedAfterTheFailureResolvesIt() {
		assertEquals(List.of(), DistributionFailureLog.unresolvedFailures(List.of(
				failed(3, 3),
				retried(9, 3))));
	}

	/** 3번 — 재전송 뒤 다시 실패하면 재등장한다(append-only 원장의 최신 행이 곧 현재 상태다). */
	@Test
	void aFailureRecordedAfterTheRetryReappears() {
		List<Failure> items = DistributionFailureLog.unresolvedFailures(List.of(
				failed(1, 3, "press", "invalid-spool-dir", "t1"),
				retried(2, 3),
				failed(3, 3, "press", "spool-write-failed", "t3")));

		assertEquals(1, items.size());
		assertEquals(3L, items.get(0).historyId());
		assertEquals("spool-write-failed", items.get(0).reason());
	}

	/**
	 * 서문이 기각한 휴리스틱("실패 뒤 같은 kind의 {@code distribute} 행이 있으면 해소")을 폐색한다 —
	 * 그 규칙은 한 번의 배부 호출 안에서 kind 행이 실패 행보다 뒤에 남는 <b>id 순서 불변식</b>에 판정을
	 * 걸고, 그게 깨지면 신선한 미발송이 무음으로 사라진다. 해소는 {@code distribute-retry}로만 표현된다.
	 */
	@Test
	void aPlainDistributeRowDoesNotResolveAFailure() {
		List<Failure> items = DistributionFailureLog.unresolvedFailures(List.of(
				failed(1, 3),
				event(2, ARTICLE, "distribute", "press", 3, null, AT)));

		assertEquals(List.of(1L), historyIds(items),
				"distribute 행은 어휘 자체가 판정에 참여하지 않는다 — 해소는 distribute-retry뿐이다");
	}

	/** 입력 배열 순서는 판정에 영향이 없다 — <b>id로만</b> 최신을 고른다(호출자 정렬에 기대지 않는다). */
	@Test
	void theInputOrderDoesNotMatterOnlyTheIdDoes() {
		assertEquals(List.of(), DistributionFailureLog.unresolvedFailures(List.of(
				retried(9, 3),
				failed(3, 3))));
		assertEquals(List.of(9L), historyIds(DistributionFailureLog.unresolvedFailures(List.of(
				failed(9, 3),
				retried(3, 3)))));
	}

	// --- 4. 그룹 키 3원소 -----------------------------------------------------------------------------

	/**
	 * 4번 — 같은 {@code (articleId, targetId)}라도 kind가 다르면 <b>다른 그룹</b>이다. 이 단언이 red면
	 * 한 kind의 재전송이 다른 kind의 실패를 삼켜 그 kind는 목록에서 사라지고 <b>영구 복구 불가</b>가 된다.
	 */
	@Test
	void theGroupKeyIncludesTheKindSoTwoKindsStayUnresolvedSideBySide() {
		List<Failure> items = DistributionFailureLog.unresolvedFailures(List.of(
				failed(10, 3, "press", "spool-write-failed", AT),
				failed(11, 3, "nonpress", "spool-write-failed", AT)));

		assertEquals(List.of(11L, 10L), historyIds(items));
		assertEquals(List.of("nonpress", "press"), items.stream().map(Failure::kind).toList());
	}

	/** kind가 다르면 재전송도 그 kind에만 듣는다. */
	@Test
	void aRetryOfOneKindDoesNotResolveTheOtherKind() {
		List<Failure> items = DistributionFailureLog.unresolvedFailures(List.of(
				failed(10, 3, "press", "spool-write-failed", AT),
				failed(11, 3, "nonpress", "spool-write-failed", AT),
				event(12, ARTICLE, RETRY, "press", 3, null, AT)));

		assertEquals(List.of(11L), historyIds(items));
		assertEquals("nonpress", items.get(0).kind());
	}

	/** 기사·수신처가 다르면 당연히 다른 그룹이다(3원소 전부가 키다). */
	@Test
	void differentArticlesAndTargetsAreDifferentGroups() {
		List<Failure> items = DistributionFailureLog.unresolvedFailures(List.of(
				failed(1, 3),
				event(2, "A2", FAILED, "press", 3, "spool-write-failed", AT),
				failed(3, 4)));

		assertEquals(List.of(3L, 2L, 1L), historyIds(items));
	}

	// --- 5~6. targetId 정규화(NodeNumber 단일 출처) ---------------------------------------------------

	/**
	 * 5번 — {@code 3} · {@code "3"} · {@code 3.0} · {@code " 3 "}은 <b>같은 그룹</b>이다(JS
	 * {@code Number()} 의미론). 4행이 1건으로 접히고 남는 것은 id가 가장 큰 행이다.
	 */
	@Test
	void targetIdRepresentationsFoldIntoOneGroup() {
		List<Failure> items = DistributionFailureLog.unresolvedFailures(List.of(
				failed(20, 3),
				failed(21, "3"),
				failed(22, 3.0d),
				failed(23, " 3 ")));

		assertEquals(1, items.size());
		assertEquals(23L, items.get(0).historyId());
		assertEquals(3.0d, items.get(0).targetId());
	}

	/**
	 * {@code Integer.parseInt}·{@code Double.parseDouble}·{@code String.trim()}으로 재구현하면 red다 —
	 * Node 판독은 {@code NodeNumber.toNumber} <b>단일 출처</b>여야 한다(decisions (18), phase 70 high-1).
	 * {@code parseInt}는 {@code "3.0"}·{@code "0x3"}에서, {@code String.trim()}은 NBSP에서 갈라진다.
	 */
	@Test
	void targetIdParsingFollowsNodeNumberSemanticsNotJavaParsing() {
		// Node 실측: Number('0x3') === 3 · Number(' 3 ') === 3 · Number('3e0') === 3.
		List<Failure> items = DistributionFailureLog.unresolvedFailures(List.of(
				failed(30, 3),
				failed(31, "0x3"),
				failed(32, " 3 "),
				failed(33, "3e0"),
				failed(34, "+3")));

		assertEquals(1, items.size(), "다섯 표기는 전부 수신처 3이다");
		assertEquals(34L, items.get(0).historyId());
		assertEquals(3.0d, items.get(0).targetId());
	}

	/** Node 실측: {@code Number('3.5')}는 3.5라 수신처 3과 <b>다른</b> 그룹이다(정수로 잘라 붙이지 않는다). */
	@Test
	void aFractionalTargetIdIsItsOwnGroupNotTruncated() {
		List<Failure> items = DistributionFailureLog.unresolvedFailures(List.of(
				failed(40, 3),
				failed(41, "3.5")));

		assertEquals(List.of(41L, 40L), historyIds(items));
		assertEquals(3.5d, items.get(0).targetId());
	}

	/** 6번 — 정규화 결과가 없는 행은 <b>조용히</b> 빠진다(throw 금지). */
	@Test
	void rowsWithAnUnusableTargetIdAreIgnored() {
		List<Failure> items = DistributionFailureLog.unresolvedFailures(Arrays.asList(
				failed(50, null),
				failed(51, ""),
				failed(52, "abc"),
				failed(53, Double.POSITIVE_INFINITY),
				failed(54, Double.NaN),
				failed(55, "1e400")));

		assertEquals(List.of(), items, "수신처를 특정할 수 없는 실패는 원장 항목이 될 수 없다");
	}

	/**
	 * Node 실측: 빈 문자열 검사는 {@code value === ''}로 <b>trim 이전</b>이다 — 공백만 있는 문자열은
	 * {@code Number(' ') === 0}이라 수신처 0으로 참여한다. trim 후 빈 문자열을 걸러내면 red다.
	 */
	@Test
	void aWhitespaceOnlyTargetIdIsZeroNotMissing() {
		List<Failure> items = DistributionFailureLog.unresolvedFailures(List.of(
				failed(60, 0),
				failed(61, " ")));

		assertEquals(1, items.size(), "공백 문자열은 0이므로 수신처 0과 같은 그룹이다");
		assertEquals(61L, items.get(0).historyId());
		assertEquals(0.0d, items.get(0).targetId());
	}

	/** {@code -0}과 {@code 0}은 같은 수신처다(Node는 문자열 키라 둘 다 {@code "0"}으로 접힌다). */
	@Test
	void negativeZeroFoldsWithZero() {
		List<Failure> items = DistributionFailureLog.unresolvedFailures(List.of(
				failed(70, 0),
				failed(71, "-0")));

		assertEquals(1, items.size());
		assertEquals(71L, items.get(0).historyId());
	}

	// --- 7. 참여 자격(id·action·eventType) -------------------------------------------------------------

	/** 7번 — 판정에 참여할 수 없는 행은 전부 조용히 무시된다(원장에는 레거시·수기 행이 있을 수 있다). */
	@Test
	void rowsThatCannotParticipateAreIgnoredSilently() {
		List<Failure> items = assertDoesNotThrow(() -> DistributionFailureLog.unresolvedFailures(Arrays.asList(
				event("7", ARTICLE, FAILED, "press", 3, "spool-write-failed", AT),
				event(7.5d, ARTICLE, FAILED, "press", 3, "spool-write-failed", AT),
				event(null, ARTICLE, FAILED, "press", 3, "spool-write-failed", AT),
				event(60, ARTICLE, FAILED, null, 3, "spool-write-failed", AT),
				event(61, ARTICLE, FAILED, 7, 3, "spool-write-failed", AT),
				event(62, ARTICLE, "distribute", "press", 3, null, AT),
				event(63, ARTICLE, "status", "send", 3, null, AT),
				event(64, ARTICLE, null, "press", 3, null, AT),
				event(65, ARTICLE, " distribute-failed ", "press", 3, null, AT),
				event(66, ARTICLE, "DISTRIBUTE-FAILED", "press", 3, null, AT))));

		assertEquals(List.of(), items);
	}

	/** Node 실측: {@code Number.isInteger(7.0)}은 참이다 — 정수값 실수 id는 참여한다. */
	@Test
	void anIntegralFloatingPointIdParticipates() {
		List<Failure> items = DistributionFailureLog.unresolvedFailures(List.of(failed(7.0d, 3)));

		assertEquals(List.of(7L), historyIds(items));
	}

	/** 목록 안의 {@code null} 행도 조용히 무시한다(호출자를 깨뜨리지 않는다). */
	@Test
	void nullEntriesInsideTheRowListAreIgnored() {
		List<Failure> items = assertDoesNotThrow(() -> DistributionFailureLog.unresolvedFailures(
				Arrays.asList(null, failed(80, 3), null)));

		assertEquals(List.of(80L), historyIds(items));
	}

	// --- 8~9. 정렬과 반환 shape ------------------------------------------------------------------------

	/** 8번 — 최신 실패 우선({@code historyId} DESC). */
	@Test
	void itemsAreSortedByHistoryIdDescending() {
		List<Failure> items = DistributionFailureLog.unresolvedFailures(List.of(
				failed(1, 1),
				failed(9, 9),
				failed(5, 5)));

		assertEquals(List.of(9L, 5L, 1L), historyIds(items));
	}

	/**
	 * 9번 — 항목은 <b>정확히 6키</b>다. {@code spoolDir}·{@code file} 같은 경로성 필드를 담으면 서버
	 * 파일시스템 경로가 {@code GET /api/distribution/failures} 응답으로 그대로 새어 나간다.
	 */
	@Test
	void aFailureItemHasExactlySixFieldsAndNoPathBearingOne() {
		List<String> names = Arrays.stream(Failure.class.getRecordComponents())
				.map(RecordComponent::getName)
				.toList();

		assertEquals(List.of("historyId", "articleId", "targetId", "kind", "reason", "failedAt"), names);
		for (String name : names) {
			String lower = name.toLowerCase(Locale.ROOT);
			assertFalse(lower.contains("spool") || lower.contains("file") || lower.contains("path")
					|| lower.contains("dir"), "경로성 필드가 원장 항목에 있다: " + name);
		}
	}

	/** 값의 출처 6곳을 한 번에 못 박는다(행 id → historyId, 행 action → kind, 행 createdAt → failedAt). */
	@Test
	void everyFieldComesFromItsLedgerColumn() {
		Failure item = DistributionFailureLog.unresolvedFailures(List.of(
				event(42, "A9", FAILED, "nonpress", 7, "invalid-spool-dir", "2026-08-25T01:02:03.004Z")))
				.get(0);

		assertEquals(new Failure(42L, "A9", 7.0d, "nonpress", "invalid-spool-dir", "2026-08-25T01:02:03.004Z"),
				item);
	}

	/** 사유·시각은 <b>없을 때만</b> null이다(빈 문자열은 그대로 남는다 — Node {@code ??} 의미론). */
	@Test
	void reasonAndFailedAtAreNullOnlyWhenAbsent() {
		Map<String, Object> bare = new LinkedHashMap<>();
		bare.put("id", 71L);
		bare.put("articleId", ARTICLE);
		bare.put("eventType", FAILED);
		bare.put("action", "press");
		bare.put("targetId", 3L);
		List<Failure> items = DistributionFailureLog.unresolvedFailures(List.of(bare));
		assertNull(items.get(0).reason());
		assertNull(items.get(0).failedAt());

		Failure empty = DistributionFailureLog.unresolvedFailures(List.of(
				event(72, ARTICLE, FAILED, "press", 3, "", ""))).get(0);
		assertEquals("", empty.reason(), "빈 문자열 사유를 null로 접지 마라 — 없는 것과 다른 사실이다");
		assertEquals("", empty.failedAt());
	}

	// --- 10. 방어적 입력 -------------------------------------------------------------------------------

	/** 10번 — 빈 입력은 빈 결과다(throw 금지 — 판정 모듈이 깨지면 실패 목록 조회 하나가 500이 된다). */
	@Test
	void emptyOrMissingRowsYieldAnEmptyResult() {
		assertEquals(List.of(), assertDoesNotThrow(() -> DistributionFailureLog.unresolvedFailures(null)));
		assertEquals(List.of(), DistributionFailureLog.unresolvedFailures(List.of()));
	}

	/** 반환 목록은 불변이다 — 호출자가 원장 파생을 뒤에서 고칠 수 없다. */
	@Test
	void theReturnedListIsImmutable() {
		List<Failure> items = DistributionFailureLog.unresolvedFailures(List.of(failed(1, 3)));

		assertThrows(UnsupportedOperationException.class, () -> items.remove(0));
	}

	/** 스키마상 {@code articleId}는 NOT NULL이지만 판정이 그 사실에 기대지 않는다(무음 무시도 아니다). */
	@Test
	void aRowWithoutAnArticleIdStillParticipates() {
		List<Failure> items = assertDoesNotThrow(() -> DistributionFailureLog.unresolvedFailures(List.of(
				event(90, null, FAILED, "press", 3, "spool-write-failed", AT))));

		assertEquals(List.of(90L), historyIds(items));
		assertNull(items.get(0).articleId());
	}

	// --- 12. findUnresolvedFailure ---------------------------------------------------------------------

	/**
	 * 12번 — 같은 쌍에 kind 2종이 미해소면 <b>historyId가 큰</b>(가장 최근) 1건이다. {@code kind}는 인자가
	 * 아니다 — 클라이언트가 kind를 고르면 안 된다(배부 kind는 실패 이력에서만 도출한다, ADR-004).
	 */
	@Test
	void findReturnsTheMostRecentUnresolvedFailureOfThePair() {
		List<Map<String, Object>> rows = List.of(
				failed(10, 3, "press", "spool-write-failed", AT),
				failed(11, 3, "nonpress", "invalid-spool-dir", AT));

		Failure found = DistributionFailureLog.findUnresolvedFailure(rows, ARTICLE, 3);

		assertEquals(11L, found.historyId());
		assertEquals("nonpress", found.kind());
	}

	/** 질의 쪽 {@code targetId}도 같은 정규화를 거친다(HTTP 경계에서 문자열이 올 수 있다). */
	@Test
	void findNormalizesTheQueriedTargetId() {
		List<Map<String, Object>> rows = List.of(failed(12, 3));

		assertEquals(12L, DistributionFailureLog.findUnresolvedFailure(rows, ARTICLE, "3").historyId());
		assertEquals(12L, DistributionFailureLog.findUnresolvedFailure(rows, ARTICLE, 3.0d).historyId());
	}

	@Test
	void findReturnsNullWhenNothingMatches() {
		List<Map<String, Object>> rows = List.of(failed(13, 3));

		assertNull(DistributionFailureLog.findUnresolvedFailure(rows, "A2", 3), "다른 기사");
		assertNull(DistributionFailureLog.findUnresolvedFailure(rows, ARTICLE, 4), "다른 수신처");
		assertNull(DistributionFailureLog.findUnresolvedFailure(rows, ARTICLE, "abc"), "정규화 불가");
		assertNull(DistributionFailureLog.findUnresolvedFailure(rows, ARTICLE, null), "targetId 없음");
		assertNull(DistributionFailureLog.findUnresolvedFailure(rows, ARTICLE, ""), "빈 문자열");
		assertNull(DistributionFailureLog.findUnresolvedFailure(null, ARTICLE, 3), "rows 없음");
	}

	/**
	 * 해소된 쌍은 찾히지 않는다 — 재전송 게이트의 <b>멤버십 검사</b>가 이 한 판정에 걸려 있다(목록과 게이트가
	 * 다른 규칙을 쓰면 목록에 없는 실패로 재전송이 통과한다).
	 */
	@Test
	void findDoesNotSeeAResolvedPair() {
		assertNull(DistributionFailureLog.findUnresolvedFailure(List.of(
				failed(10, 3),
				retried(12, 3)), ARTICLE, 3));
	}

	@Test
	void findMatchesARowWithoutAnArticleId() {
		List<Map<String, Object>> rows = List.of(event(96, null, FAILED, "press", 3, "spool-write-failed", AT));

		assertEquals(96L, DistributionFailureLog.findUnresolvedFailure(rows, null, 3).historyId());
		assertNull(DistributionFailureLog.findUnresolvedFailure(rows, ARTICLE, 3));
	}

	// --- 픽스처 ---------------------------------------------------------------------------------------

	private static List<Long> historyIds(List<Failure> items) {
		List<Long> ids = new ArrayList<>();
		for (Failure item : items) {
			ids.add(item.historyId());
		}
		return ids;
	}

	private static Map<String, Object> failed(Object id, Object targetId) {
		return failed(id, targetId, "press", "spool-write-failed", AT);
	}

	private static Map<String, Object> failed(Object id, Object targetId, String kind, String reason,
			String createdAt) {
		return event(id, ARTICLE, FAILED, kind, targetId, reason, createdAt);
	}

	private static Map<String, Object> retried(Object id, Object targetId) {
		return event(id, ARTICLE, RETRY, "press", targetId, null, AT);
	}

	/** {@code ArticleHistoryRepository.queryDistributionEvents}가 돌려주는 8키 행과 같은 모양. */
	private static Map<String, Object> event(Object id, Object articleId, Object eventType, Object action,
			Object targetId, Object reason, Object createdAt) {
		Map<String, Object> row = new LinkedHashMap<>();
		row.put("id", (id instanceof Integer number) ? Long.valueOf(number.longValue()) : id);
		row.put("articleId", articleId);
		row.put("eventType", eventType);
		row.put("action", action);
		row.put("targetId", (targetId instanceof Integer number) ? Long.valueOf(number.longValue()) : targetId);
		row.put("reason", reason);
		row.put("actorUserId", "Z1");
		row.put("createdAt", createdAt);
		return row;
	}

}
