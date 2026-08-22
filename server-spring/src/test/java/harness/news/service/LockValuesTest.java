package harness.news.service;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import org.junit.jupiter.api.Test;

/**
 * 잠금 판정의 <b>값 동등성 규칙</b> — 이 phase의 최대 포팅 함정을 한 곳에 모아 잠근다(index.json
 * decisions (11)).
 *
 * <h2>왜 별도의 규칙이 필요한가</h2>
 * Node는 <b>DB NULL({@code null})과 헤더 부재({@code undefined})를 다른 값</b>으로 본다. 정본
 * {@code assertLockHolder}의 {@code c.lockerClientId !== clientId}는 둘 다 비어 있을 때
 * {@code null !== undefined}라 <b>거부</b>로 수렴한다. Java는 두 부재가 모두 {@code null}이라
 * {@code Objects.equals(null, null)}이 <b>참</b>이 되고, 그 한 줄이 곧 인가 우회다 —
 * "{@code lockerUserId}는 있는데 {@code lockerClientId}가 NULL인 잠금 행"은 실제로 만들어진다
 * ({@code x-edit-client} 헤더 없이 잠금을 획득하면 그 행이 된다). 그 조합에 헤더 없는 요청이 오면
 * 순진한 Java 포팅은 <b>남의 잠금 아래에서 저장 인가를 내준다</b>.
 *
 * <p>그래서 규칙을 네 개로 못 박고 각각을 여기서 잠근다(실측 출처는 Node 정본을 임시 DB에 물려 돌린
 * 판정 격자다 — 2026-08-21).
 * <ol>
 *   <li><b>탭 일치</b>({@link LockValues#same}): 양쪽이 <b>모두 present</b>하고 같을 때만 참.</li>
 *   <li><b>해제 경로의 관용</b>({@link LockValues#releaseTabMismatch}): 행의 탭이 비어 있을 때만 탭
 *       검사를 건너뛴다(정본 {@code releaseEditLock}의 의도된 관용).</li>
 *   <li><b>세션 비교</b>({@link LockValues#differs}): 다르면 참이고, 한쪽이 비어 있어도 다르다.</li>
 *   <li><b>보유 여부</b>({@link LockValues#held}): {@code lockYN='Y'}이고 탭이 <b>비어 있지 않을</b> 때만
 *       참(빈 값이면 미보유로 보고 덮어쓴다).</li>
 * </ol>
 */
class LockValuesTest {

	/** Node의 문자열 truthiness — 빈 문자열은 "없음"이다. 비문자열은 애초에 판정에 들어오지 않는다. */
	@Test
	void presenceFollowsNodeStringTruthiness() {
		assertTrue(LockValues.present("tabA"));
		assertTrue(LockValues.present(" "), "공백 한 칸은 Node에서 truthy다(trim하지 않는다)");
		assertFalse(LockValues.present(null), "DB NULL도 헤더 부재도 없음이다");
		assertFalse(LockValues.present(""), "빈 문자열은 Node에서 falsy다");
		assertFalse(LockValues.present(42), "문자열이 아닌 값은 판정 대상이 아니다(fail-closed)");
	}

	/**
	 * <b>이 step의 핵심 함정.</b> {@code same(null, null)}이 참이 되는 순간 보유자가 아닌 요청이 저장
	 * 인가를 얻는다 — Java 기본 의미론({@code Objects.equals})이 정확히 그 값을 준다.
	 */
	@Test
	void aTabMatchesOnlyWhenBothSidesArePresentAndEqual() {
		assertTrue(LockValues.same("tabA", "tabA"));
		assertFalse(LockValues.same("tabA", "tabB"));
		assertFalse(LockValues.same(null, null),
				"DB NULL과 헤더 부재는 같은 값이 아니다(Node: null !== undefined) — 여기가 인가 구멍의 자리다");
		assertFalse(LockValues.same("tabA", null), "보유 탭이 있는데 헤더가 없으면 보유자가 아니다");
		assertFalse(LockValues.same(null, "tabA"), "행에 탭이 없으면 어떤 헤더도 그 자리를 차지하지 못한다");
		assertFalse(LockValues.same("", "tabA"));
		assertTrue(LockValues.same("", ""),
				"빈 문자열끼리는 Node에서 '' === ''로 같다 — 부재(null)와 달리 '값이 있는' 쪽이다");
	}

	/**
	 * 해제 경로만의 관용 — 정본 {@code if (c.lockerClientId && c.lockerClientId !== clientId)}의 직역이다.
	 * 행의 탭이 비어 있으면(레거시·헤더 없이 획득된 잠금) 탭 검사를 건너뛰고 <b>사용자 대조로만</b>
	 * 판정한다. 획득·보유자 검사의 규칙과 다르다는 사실 자체가 계약이다.
	 */
	@Test
	void theReleasePathSkipsTheTabCheckOnlyWhenTheRowsTabIsEmpty() {
		assertFalse(LockValues.releaseTabMismatch(null, "tabA"), "행의 탭이 NULL이면 탭 검사를 건너뛴다");
		assertFalse(LockValues.releaseTabMismatch(null, null), "헤더가 없어도 마찬가지다(사용자 대조가 남는다)");
		assertFalse(LockValues.releaseTabMismatch("", "tabA"), "행의 탭이 빈 문자열이어도 건너뛴다");
		assertFalse(LockValues.releaseTabMismatch("tabA", "tabA"));
		assertTrue(LockValues.releaseTabMismatch("tabA", "tabB"), "행에 탭이 있으면 다른 탭은 거부다");
		assertTrue(LockValues.releaseTabMismatch("tabA", null), "행에 탭이 있는데 헤더가 없으면 거부다");
	}

	/** 재로그인 판정의 세션 비교 — 부재는 "같다"가 아니라 "다르다"로 수렴한다(Node {@code !==}). */
	@Test
	void aSessionDiffersWhenEitherSideIsMissing() {
		assertFalse(LockValues.differs("s1", "s1"));
		assertTrue(LockValues.differs("s1", "s2"));
		assertTrue(LockValues.differs("s1", null));
		assertTrue(LockValues.differs(null, "s1"));
		assertTrue(LockValues.differs(null, null), "둘 다 모르면 같은 세션이라고 보지 않는다");
	}

	/** 보유 판정 — 탭이 비어 있으면 잠금으로 치지 않는다(다음 시도자가 그대로 덮어쓴다). */
	@Test
	void aLockIsHeldOnlyWhenTheFlagIsYAndTheTabIsNotEmpty() {
		assertTrue(LockValues.held("Y", "tabA"));
		assertFalse(LockValues.held("Y", null), "탭이 NULL이면 보유가 아니다(Node: held = 'Y' && lockerClientId)");
		assertFalse(LockValues.held("Y", ""), "빈 탭도 보유가 아니다");
		assertFalse(LockValues.held("N", "tabA"), "잔존 탭 값이 있어도 플래그가 N이면 보유가 아니다");
		assertFalse(LockValues.held(null, "tabA"));
		assertFalse(LockValues.held("y", "tabA"), "플래그 비교는 대소문자를 구분한다(Node === 'Y')");
	}
}
