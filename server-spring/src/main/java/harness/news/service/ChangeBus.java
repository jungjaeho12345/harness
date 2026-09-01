package harness.news.service;

import java.util.List;
import java.util.Objects;
import java.util.concurrent.CopyOnWriteArrayList;
import org.springframework.stereotype.Service;

/**
 * 무효화 신호 버스 — 리포 루트 {@code server/index.js} 591~595행의 in-process {@code EventEmitter}
 * 하나와 1:1 이식이다(ADR-005 · ADR-015).
 *
 * <pre>
 * const bus = new EventEmitter();
 * bus.setMaxListeners(0);                                    // 구독자 수 제한 없음
 * app.notifyChange = (kind) =&gt; bus.emit('change', { kind }); // 트리거 요청 스택에서 동기로
 * </pre>
 *
 * <h2>호출 스레드에서 동기로 돈다</h2>
 * {@link #publish(String)}는 자기를 부른 <b>트리거 요청 스레드</b>에서 전 구독자를 부르고 돌아온다.
 * 큐·실행자·스레드·타이머가 <b>하나도 없다</b> — 그것이 ADR-008 (3)(6)의 취지("앱은 스스로 깨어나지 않고
 * 스스로 다시 시도하지 않는다")를 넓히지 않고 지키는 방법이고, ADR-015가 SSE 전체에 대해 정한 모델이다.
 * 그래서 {@code Adr008DisciplineTest}의 예외 목록은 4파일 그대로이며 이 파일은 그 목록에 없다.
 *
 * <h2>절대 예외를 밖으로 내보내지 않는다</h2>
 * 구독자 하나가 {@link RuntimeException}을 던져도 나머지 구독자에게 통지가 계속되고 호출자는 정상 반환을
 * 받는다. 근거는 Node {@code server/index.js} 1144~1150행 주석이 명시한 위험이다 — 예외가 라우트로 새면
 * <b>이미 성공한 저장이 전역 에러 핸들러에 걸려 500으로 뒤집히고</b> 클라이언트 재시도가 중복 저장을 만든다.
 * {@link Error}는 삼키지 않는다: JVM 수준 고장을 조용히 감추면 신호 유실이 아니라 원인 불명의 정지가 된다
 * (구독자 콜백은 검사 예외를 던질 수 없으므로 {@code Exception} 축은 {@code RuntimeException}이 전부다).
 *
 * <h2>서비스층이라 서블릿도 와이어 포맷도 알지 못한다</h2>
 * 구독자는 {@link Listener} 콜백일 뿐이고, 응답에 프레임을 쓰는 일은 web 계층의 몫이다(ADR-006 · ADR-013).
 * payload {@code {"kind":"..."}} 직렬화도 여기서 하지 않는다 — 서비스층에 와이어 포맷이 새면 바이트를
 * 만드는 지점이 갈라진다(ADR-015가 지점을 {@code JsonHttp}·{@code SseHttp} 둘로 못 박은 이유와 같다).
 *
 * <h2>kind를 검증하지 않는다</h2>
 * Node의 {@code bus.emit}에 검증이 없다. 상수 4종은 <b>어휘를 한 곳에 모아 두는 용도</b>일 뿐이며
 * 검증 예외를 만들면 그것이 위의 "500으로 뒤집힌다"와 같은 사고가 된다.
 *
 * <h2>구독자 수 제한이 없다</h2>
 * {@code bus.setMaxListeners(0)} 동형이다({@code docs/api-contract/sse.md}가 "서버는 구독자 수 제한이
 * 없다"로 동결). 대가는 느린 구독자가 트리거 요청을 지연시킨다는 것이고(Node 동형) 그 사실은 ADR-015의
 * 트레이드오프에 기록돼 있다.
 */
@Service
public class ChangeBus {

	/** 무효화 신호 어휘 4종({@code docs/api-contract/sse.md}) — 값은 검증하지 않고 상수로만 제공한다. */
	public static final String CREATE = "create";

	public static final String UPDATE = "update";

	public static final String STATUS = "status";

	public static final String LOCK = "lock";

	/**
	 * 반복 중 해제가 안전한 컨테이너 — {@link #publish(String)}가 도는 동안 구독자가 스스로 봉인해도
	 * {@code ConcurrentModificationException}이 나지 않는다(SSE 종료기가 정확히 그렇게 동작한다).
	 */
	private final List<Listener> listeners = new CopyOnWriteArrayList<>();

	/** 구독자 콜백 — 서비스층 타입만 받는다(응답 쓰기는 web 계층의 람다가 한다). */
	public interface Listener {

		void onChange(String kind);

	}

	/**
	 * 구독한다.
	 *
	 * @return 해제 핸들. {@code close()}는 <b>멱등</b>이며 같은 리스너 인스턴스의 다른 구독을 건드리지 않는다
	 *     (Node {@code bus.off(...)} 동형)
	 */
	public AutoCloseable subscribe(Listener listener) {
		Objects.requireNonNull(listener, "listener");
		this.listeners.add(listener);
		return new Subscription(listener);
	}

	/**
	 * 호출 스레드에서 동기로 전 구독자에게 통지한다. <b>절대 던지지 않는다.</b>
	 *
	 * @param kind 신호 어휘(검증하지 않는다 — {@code null}도 그대로 전달한다)
	 */
	public void publish(String kind) {
		for (Listener listener : this.listeners) {
			try {
				listener.onChange(kind);
			}
			catch (RuntimeException ex) {
				// 삼킨다. 한 구독자의 고장이 다른 구독자의 신호나 트리거 요청의 응답을 망치지 않는다.
			}
		}
	}

	/** 테스트·연결 회수 관측용 — 누수 0을 단언하는 수단이다(step4·step5가 이 값을 본다). */
	public int subscriberCount() {
		return this.listeners.size();
	}

	/**
	 * 구독 1건의 해제 핸들.
	 *
	 * <p>{@code closed} 플래그가 있는 이유: 해제가 목록 제거뿐이면 <b>이중 close가 같은 리스너의 다른
	 * 구독을 지운다</b>(동치 항목 하나가 지워지므로). SSE에서는 "탭 하나를 닫았더니 다른 탭의 스트림이
	 * 조용히 죽는" 형태로 나타난다.
	 */
	private final class Subscription implements AutoCloseable {

		private final Listener listener;

		private boolean closed;

		private Subscription(Listener listener) {
			this.listener = listener;
		}

		@Override
		public synchronized void close() {
			if (this.closed) {
				return;
			}
			this.closed = true;
			ChangeBus.this.listeners.remove(this.listener);
		}

	}

}
