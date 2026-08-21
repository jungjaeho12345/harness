package harness.news.service;

/**
 * 편집 잠금 판정의 <b>값 동등성 규칙</b> — 한 곳에 모아 둔 이유가 곧 이 클래스의 존재 이유다
 * (index.json decisions (11)).
 *
 * <h2>DB NULL과 헤더 부재는 다른 값이다</h2>
 * 리포 루트 {@code src/services/articleService.js}는 JavaScript의 두 부재를 구분한다: 잠금 행의 빈 컬럼은
 * {@code null}이고, 오지 않은 {@code x-edit-client} 헤더는 {@code undefined}이며,
 * {@code null !== undefined}다. 그래서 정본 {@code assertLockHolder}의
 * {@code c.lockerClientId !== clientId}는 <b>둘 다 비어 있을 때 거부</b>로 수렴한다.
 *
 * <p>Java는 두 부재가 모두 {@code null}이라 {@code Objects.equals(null, null)}이 <b>참</b>이다. 그대로
 * 옮기면 "{@code lockerUserId}는 있고 {@code lockerClientId}는 NULL인 잠금 행"에 <b>헤더 없는 요청</b>이
 * 저장 인가를 얻는다 — 그리고 그 행은 특수한 구성이 아니라 <b>API로 도달한다</b>({@code x-edit-client}
 * 없이 잠금을 획득하면 그 행이 만들어진다). 즉 이 클래스가 없으면 포팅이 인가 구멍을 하나 만든다.
 *
 * <h2>규칙 넷(각각 {@code LockValuesTest}가 잠근다)</h2>
 * <ol>
 *   <li><b>탭 일치</b>({@link #same}) — 양쪽이 모두 present하고 같을 때만 참.</li>
 *   <li><b>해제 경로의 관용</b>({@link #releaseTabMismatch}) — 행의 탭이 비어 있을 때만 탭 검사를
 *       건너뛴다(정본 {@code releaseEditLock}의 의도된 관용이며 획득·보유자 검사와 규칙이 다르다).</li>
 *   <li><b>세션 비교</b>({@link #differs}) — 다르면 참이고 한쪽이 비어 있어도 다르다.</li>
 *   <li><b>보유 여부</b>({@link #held}) — {@code lockYN='Y'}이고 탭이 비어 있지 않을 때만 참.</li>
 * </ol>
 *
 * <p>판정은 전부 여기를 거친다. 서비스가 {@code equals}·{@code ==}로 직접 비교하기 시작하면 규칙이 두
 * 벌이 되고, 그 두 벌은 반드시 갈라진다.
 */
final class LockValues {

	/** 잠긴 상태의 플래그 값. 대소문자를 구분한다(Node {@code === 'Y'}). */
	private static final String LOCKED_FLAG = "Y";

	/**
	 * 값이 "있는가" — Node의 문자열 truthiness와 같다({@code null}도 빈 문자열도 없음이다). 공백 한 칸은
	 * 있는 값이다(정본은 trim하지 않는다). 문자열이 아닌 값은 판정 대상이 아니므로 없음으로 수렴한다
	 * (fail-closed).
	 */
	static boolean present(Object value) {
		return value instanceof String text && !text.isEmpty();
	}

	/**
	 * 두 값이 <b>같은 값</b>인가 — 양쪽이 모두 있고 문자열이 같을 때만 참이다.
	 *
	 * <p>{@code same(null, null)}이 <b>거짓</b>인 것이 이 클래스의 핵심이다: DB NULL과 헤더 부재를 같다고
	 * 보는 순간 보유자가 아닌 요청이 통과한다. 반대로 빈 문자열끼리는 참이다(Node {@code '' === ''} —
	 * 부재가 아니라 값이다).
	 */
	static boolean same(Object a, Object b) {
		return a instanceof String left && b instanceof String right && left.equals(right);
	}

	/** {@link #same}의 부정 — 재로그인 판정의 세션 비교({@code c.lockerSessionId !== sessionId})다. */
	static boolean differs(Object a, Object b) {
		return !same(a, b);
	}

	/**
	 * 잠금이 유효하게 보유되고 있는가 — 정본 {@code held = c.lockYN === 'Y' && c.lockerClientId}다.
	 * 탭이 비어 있으면 보유로 치지 않고 다음 시도자가 그대로 덮어쓴다.
	 */
	static boolean held(Object lockYN, Object lockerClientId) {
		return flagSet(lockYN) && present(lockerClientId);
	}

	/** 잠금 플래그만 본다(해제·보유자 검사는 탭 없이 플래그만 먼저 본다 — 정본 순서 그대로). */
	static boolean flagSet(Object lockYN) {
		return LOCKED_FLAG.equals(lockYN);
	}

	/**
	 * 해제 경로의 탭 거부 판정 — 정본 {@code if (c.lockerClientId && c.lockerClientId !== clientId)}다.
	 * 행의 탭이 비어 있으면(레거시·헤더 없이 획득된 잠금) 탭 검사를 건너뛰고 <b>사용자 대조로만</b>
	 * 판정한다. 이 관용이 없으면 그 잠금은 30분 stale까지 아무도 풀 수 없다.
	 */
	static boolean releaseTabMismatch(Object rowClientId, Object requestClientId) {
		return present(rowClientId) && !same(rowClientId, requestClientId);
	}

	private LockValues() {
	}
}
