package harness.news.controller;

import harness.news.web.SseHttp;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * SSE 스트림 종료기 — 정본 {@code createSseCloser}(리포 루트 {@code server/index.js} 428~443행)와 같은
 * 순서다: <b>① 구독 해제 → ② {@code unauthorized} 1회 → ③ 종료</b>.
 *
 * <h2>왜 두 라우트가 이것을 공유하는가</h2>
 * 정본도 {@code /api/stream}과 {@code /api/logs/stream}이 <b>같은 종료기 함수</b>를 쓴다. 종료 순서와
 * 멱등성은 보안 규율이라({@code unauthorized}가 두 번 나가거나 구독이 남으면 그대로 누수·오신호다)
 * 라우트마다 복제하면 한쪽만 고쳐도 조용히 갈린다. phase 74 step5가 로그 스트림을 붙이면서 step4의
 * {@code StreamController} 중첩 클래스를 이 파일로 끌어올렸다(동작 변경 0).
 *
 * <h2>해제를 먼저 하는 이유 · 멱등인 이유</h2>
 * 닫힌 응답에 write가 누적되면 누수와 예외가 된다. 그리고 봉인은 <b>세 경로</b>(push 재검증 실패 ·
 * 구독 콜백의 write 실패 · 접속 시퀀스 예외)가 같은 종료기를 부르므로 멱등이어야 한다.
 *
 * <p>플래그를 {@code synchronized}가 아니라 {@link AtomicBoolean}으로 둔 것은 <b>락 순서 때문</b>이다:
 * 봉인은 스트림의 write monitor를 잡고, 스트림의 종료 훅({@code onClosed})은 그 monitor를 잡은 채
 * {@link #unsubscribe()}를 부른다 — 종료기가 자기 monitor를 잡은 채 스트림을 호출하면 두 락이 반대
 * 순서로 얽혀 데드락이 된다.
 *
 * <p><b>prelude 구간의 봉인은 {@code unauthorized}를 내보내지 않는다</b>: 그 구간의 {@code write}는 큐에
 * 적재되고 {@link SseHttp.Stream#close()}가 큐를 폐기한다(step2 불변식 3). 클라이언트는 연결 종료로 안다.
 */
final class SseCloser {

	private final SseHttp.Stream stream;

	private final AtomicBoolean sealed = new AtomicBoolean();

	private volatile AutoCloseable subscription;

	SseCloser(SseHttp.Stream stream) {
		this.stream = stream;
	}

	/**
	 * 구독 핸들을 넘겨받는다. 등록과 이 호출 사이에 이미 봉인이 지나갔으면(동시 트리거가 죽은 세션을
	 * 발견한 경우) 그 자리에서 해제한다 — 그 창을 열어 두면 구독이 영원히 남는다.
	 */
	void subscribed(AutoCloseable subscription) {
		this.subscription = subscription;
		if (this.sealed.get()) {
			unsubscribe();
		}
	}

	void seal() {
		if (!this.sealed.compareAndSet(false, true)) {
			return;
		}
		unsubscribe();
		this.stream.write(SseHttp.UNAUTHORIZED);
		this.stream.close();
	}

	/** 멱등 — 스트림의 종료 훅과 봉인이 같은 해제를 부른다. */
	void unsubscribe() {
		AutoCloseable handle = this.subscription;
		if (handle == null) {
			return;
		}
		try {
			handle.close();
		}
		catch (Exception ex) {
			// 해제 실패가 나머지 정리를 막지 않는다(두 버스의 해제는 던지지 않는다).
		}
	}

}
