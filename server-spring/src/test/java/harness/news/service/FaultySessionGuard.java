package harness.news.service;

import harness.news.model.UserRepository;
import java.time.Clock;

/**
 * 테스트 전용 세션 가드 — 실제 가드에 전부 위임하되, 지시하면 {@link #peekSession(String)}<b>만</b>
 * 던진다(fail-closed 관측용).
 *
 * <h2>왜 이 파일이 {@code harness.news.service} 패키지에 있는가</h2>
 * {@link SessionGuard}의 생성자와 {@code SessionStore}가 <b>패키지-프라이빗</b>이다(합성 루트
 * {@link SessionConfig}만 스토어를 만들 수 있게 해 ADR-004 재도출 우회로를 막는 규율). 그래서 위임 대상을
 * 만들 수 있는 곳은 이 패키지뿐이다 — 가시성을 넓히는 대신 <b>테스트 소스만</b> 이 패키지에 둔다.
 *
 * <h2>왜 필요한가</h2>
 * SSE push 시점 재검증은 DB를 읽는다({@code SessionGuard.rederive} → {@code UserRepository.findById}).
 * 그 읽기가 실패했을 때 "일단 전송"이 아니라 <b>봉인</b>이라는 것이 정본의 계약이고(리포 루트
 * {@code server/index.js} 1141~1150행: 잡는 위치는 구독 콜백 안), 그 축은 <b>계약 스위트가 관측하지
 * 못한다</b>(하네스가 DB 장애를 주입할 수 없다). 실패를 결정적으로 재현하는 유일한 방법이 이 seam이다.
 *
 * <p>실패는 {@code peekSession}에만 심는다 — {@code touchSession}까지 던지면 경로 정책 필터가 먼저
 * 500을 내서 push 경로에 도달하지 못한다.
 */
public final class FaultySessionGuard extends SessionGuard {

	private final SessionGuard delegate;

	/** {@code null}이면 정상 위임. 값이 있으면 {@code peekSession}이 그 예외를 던진다. */
	private volatile RuntimeException peekFailure;

	private FaultySessionGuard(SessionGuard delegate) {
		super(null, null); // 모든 연산을 위임하므로 상위 필드는 한 번도 읽히지 않는다.
		this.delegate = delegate;
	}

	/** 실제 스토어·재도출을 그대로 쓰는 위임 가드를 만든다(합성 루트와 같은 조립). */
	public static FaultySessionGuard wrapping(UserRepository users, Clock clock) {
		return new FaultySessionGuard(new SessionGuard(new SessionStore(clock), users));
	}

	/** 이 시점 이후의 비연장 조회를 전부 실패시킨다. */
	public void failPeekWith(RuntimeException failure) {
		this.peekFailure = failure;
	}

	/** 정상 위임으로 되돌린다(테스트 간 격리). */
	public void recoverPeek() {
		this.peekFailure = null;
	}

	@Override
	public String createSession(String userId) {
		return this.delegate.createSession(userId);
	}

	@Override
	public Identity touchSession(String sessionId) {
		return this.delegate.touchSession(sessionId);
	}

	@Override
	public Identity peekSession(String sessionId) {
		RuntimeException failure = this.peekFailure;
		if (failure != null) {
			throw failure;
		}
		return this.delegate.peekSession(sessionId);
	}

	@Override
	public boolean invalidate(String sessionId) {
		return this.delegate.invalidate(sessionId);
	}
}
