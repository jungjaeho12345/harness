package harness.news.web;

import jakarta.servlet.AsyncContext;
import jakarta.servlet.AsyncEvent;
import jakarta.servlet.AsyncListener;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import java.io.IOException;
import java.io.OutputStream;
import java.io.UncheckedIOException;
import java.nio.charset.StandardCharsets;
import java.util.ArrayDeque;
import java.util.Deque;
import java.util.Objects;
import org.springframework.stereotype.Component;

/**
 * SSE 응답의 <b>와이어 포맷 단일 지점</b> — {@link JsonHttp}에 이은 <b>두 번째 와이어 지점</b>이다(ADR-015).
 *
 * <h2>왜 두 번째 지점을 여는가</h2>
 * Node 원문(2026-08-29 raw 소켓 실측)의 SSE 응답 헤더는 {@code text/event-stream; charset=utf-8}이고
 * <b>세미콜론 뒤 공백 1개 · 소문자 utf-8</b>이다. 그 바이트를 지키는 경로는 {@link RawContentType} 하나뿐이며
 * (서블릿 API로 지정하면 컨테이너가 {@code 타입 + ";charset=" + 인코딩명}으로 재조립해 공백이 사라진다 —
 * ADR-013 ④), {@code RawContentType}은 <b>패키지-프라이빗</b>이라 이 클래스도 {@code harness.news.web}에
 * 있어야 리플렉션 없이 같은 seam을 쓴다. 그래서 {@code SseEmitter}·{@code ResponseBodyEmitter}·
 * {@code StreamingResponseBody}·메시지 컨버터·WebFlux를 <b>쓰지 않는다</b> — 그 경로는 전부 서블릿 API로
 * Content-Type을 지정하므로 전 SSE 관측이 diff가 된다.
 * 지점이 셋을 넘지 않는다는 사실은 {@code SseHttpTest} 항목 9(정적 스캔)가 잠근다
 * (현행 집합 = {@code JsonHttp}(JSON) · {@code HtmlErrors}(HTML) · 이 파일(SSE)).
 *
 * <h2>연결 유지는 서블릿 비동기, 프레임 쓰기는 트리거 요청 스레드(ADR-008 · ADR-015)</h2>
 * {@code request.startAsync()} + {@code setTimeout(0)}(무한)으로 커넥션만 잡아 둔다 — 요청 스레드는 즉시
 * 풀로 돌아가므로 <b>스트림 수명 동안 Tomcat 워커를 점유하지 않는다</b>. 프레임은 {@code ChangeBus.publish}·
 * {@code LogService.log}를 부른 <b>그 스레드</b>가 직접 쓴다. 앱 타이머·heartbeat·워커풀·백그라운드 스레드가
 * <b>0</b>이고, 그래서 {@code Adr008DisciplineTest}의 예외 목록(4파일)을 넓히지 않는다.
 *
 * <h2>replay-gate — 구독 등록 창의 신호 유실을 막는다</h2>
 * Node는 단일 스레드라 "ready를 쓰고 → 구독한다" 사이에 다른 요청이 처리되지 않는다. <b>Spring은 다른
 * 워커가 동시에 돈다</b> — 그 창(로그 스트림의 replay는 최대 2000 write다) 동안 발생한 신호·로그가
 * 구독 부재로 <b>유실</b>된다. 그래서 {@link #open}이 돌려주는 {@link Stream}은 <b>prelude 모드</b>로 시작한다:
 * <ol>
 *   <li>컨트롤러가 <b>구독을 먼저</b> 건다. 그 사이 도착한 신호는 {@link Stream#write}가 <b>큐에 적재</b>한다.</li>
 *   <li>컨트롤러는 ready·replay를 {@link Stream#writePrelude}로 <b>직접</b> 쓴다(큐를 거치지 않으므로
 *       ready가 언제나 첫 프레임이다).</li>
 *   <li>{@link Stream#endPrelude(long)}가 write monitor 안에서 「중복 제거 → FIFO 드레인 → live 전환」을
 *       <b>원자적으로</b> 한다.</li>
 * </ol>
 * 즉 <b>"구독이 ready보다 먼저"와 "ready가 첫 프레임"이 동시에 참</b>이다. 이 축은 <b>계약이 보지 못한다</b>
 * ({@code contract/cases/default/logs.contract.js} 170~178행이 seq의 하한만 본다) — 방어선은
 * {@code SseHttpTest} 항목 10~18과 step4·step5의 경합 테스트뿐이다.
 *
 * <h2>큐 메모리 상한(실측)</h2>
 * 큐는 스트림당 {@link #PRELUDE_MAX}(4096) 프레임이고 넘치면 <b>가장 오래된 것을 버린다</b>(큐는 seq
 * 오름차순이라 가장 오래된 것이 곧 {@code endPrelude(lastReplayedSeq)}가 어차피 버릴 중복 후보와 겹친다).
 * 2026-08-30 실측 프레임 바이트: ready 32 B · change 39 B · 액세스 로그 1줄 208 B. 따라서 스트림당 최악
 * <b>약 0.81 MiB</b>(로그 스트림 · 4096 × 208 B)이고 {@code /api/stream}은 약 0.15 MiB(4096 × 39 B)다.
 * 계획 단계의 보수적 가정(프레임 1 KiB)으로는 스트림당 약 <b>4 MiB</b>다. <b>메시지 길이 상한도 동시 연결
 * 상한도 없으므로</b>({@code docs/api-contract/sse.md}가 "구독자 수 제한이 없다"로 동결 · Node
 * {@code bus.setMaxListeners(0)} 동형) <b>총량은 연결 수 × 그 수치로 무한</b>이다. 드롭 경로는 미검증이다.
 *
 * <h2>절대 던지지 않는다</h2>
 * {@link Stream#write}·{@link Stream#writePrelude}는 <b>트리거 요청 스레드</b>에서 불린다. 예외가 새면
 * 이미 성공한 저장이 전역 에러 핸들러에 걸려 500으로 뒤집히고 클라이언트 재시도가 중복 저장을 만든다
 * (Node {@code server/index.js} 1144~1150행 주석이 명시한 위험). 그래서 실패는 {@code false} + 자기 봉인이다.
 */
@Component
public class SseHttp {

	/**
	 * Node(express {@code res.setHeader} + charset 부착)가 보내는 문자열 원문. 세미콜론 뒤 공백과 소문자
	 * {@code utf-8}까지 계약이다 — 계약 리포트 diff가 이 문자열을 그대로 비교한다.
	 */
	public static final String CONTENT_TYPE = "text/event-stream; charset=utf-8";

	/**
	 * prelude 큐의 프레임 수 상한. 넘치면 가장 오래된 것을 버린다(위 「큐 메모리 상한」).
	 * 값을 키우면 스트림당 최악 메모리가 그대로 비례해 커진다.
	 */
	public static final int PRELUDE_MAX = 4096;

	/**
	 * {@link Stream#endPrelude(long)}에 넘겨 <b>아무것도 버리지 않는다</b>를 뜻하는 값
	 * ({@code /api/stream}처럼 중복 제거가 필요 없는 스트림이 쓴다).
	 */
	public static final long DROP_NOTHING = Long.MIN_VALUE;

	/**
	 * 순서키 없이 적재된 프레임의 키 — 어떤 {@code dropOrderKeyUpTo}(실제 seq)로도 버려지지 않는다.
	 * {@code endPrelude(Long.MAX_VALUE)}는 큐를 통째로 버리라는 뜻이 되므로 넘기지 마라.
	 */
	public static final long NO_ORDER_KEY = Long.MAX_VALUE;

	/** {@code AsyncContext.setTimeout(0)} = 무한. Node에 유휴 종료가 없다(index.json open_questions (2)). */
	private static final long NO_TIMEOUT = 0L;

	/** 접속 직후 1회 나가는 프레임 — 두 스트림 공통. Node 첫 청크 32바이트 그 자체다. */
	public static final byte[] READY = frame("ready", "{\"ok\":true}");

	/**
	 * 종료 신호. 이 프레임 1회 뒤 서버가 연결을 끝낸다(Node {@code server/index.js} 423행 리터럴).
	 * 로그아웃·만료·강등·비활성을 구분하지 않는다.
	 */
	public static final byte[] UNAUTHORIZED = frame("unauthorized", "{\"ok\":false,\"reason\":\"unauthenticated\"}");

	/**
	 * {@code event: <e>\ndata: <d>\n\n}의 UTF-8 바이트 — 순수 함수다.
	 *
	 * <p>개행은 <b>LF만</b>이고 종결자는 빈 줄 하나다({@code docs/api-contract/sse.md}가 CRITICAL로 표시한
	 * 자리 — 빈 줄이 빠지면 EventSource가 이벤트를 디스패치하지 않는다). 인코딩을 플랫폼 기본에 맡기지
	 * 않는다: 헤더는 utf-8인데 본문만 다른 인코딩이 되는 조용한 실패가 된다.
	 */
	public static byte[] frame(String event, String data) {
		return ("event: " + event + "\ndata: " + data + "\n\n").getBytes(StandardCharsets.UTF_8);
	}

	/**
	 * 헤더 3종을 바이트 그대로 쓰고 200을 커밋한 뒤 비동기 컨텍스트를 연다.
	 *
	 * <p>순서가 계약이다: ① Content-Type을 seam으로 기록(없으면 <b>던진다</b> — 폴백 금지)
	 * ② 200 ③ {@code Cache-Control: no-cache} ④ {@code Connection: keep-alive} 시도
	 * ⑤ {@code startAsync} + 무한 타임아웃 ⑥ 컨테이너 종료 이벤트에 정리 훅 ⑦ <b>헤더 flush</b>.
	 * 본문 길이는 정하지 않는다 — 정하면 컨테이너가 그 바이트에서 응답을 끝내 스트림이 첫 프레임에서 닫힌다.
	 *
	 * <p><b>첫 프레임은 여기서 쓰지 않는다</b> — 호출자가 정한다(로그 스트림은 ready 뒤에 replay가 붙는다).
	 * 반환되는 스트림은 <b>prelude 모드</b>이므로 호출자는 반드시 {@link Stream#endPrelude(long)}를 불러야
	 * 하고, 그 사이 예외가 나면 봉인해야 한다(위 「replay-gate」 · 클래스 주석).
	 *
	 * @throws IllegalStateException Content-Type 기록 seam이 없을 때({@link RawContentType})
	 * @throws UncheckedIOException 헤더를 내보내지 못했을 때(그 경우 비동기 컨텍스트를 정리하고 던진다)
	 */
	public Stream open(HttpServletRequest request, HttpServletResponse response) {
		RawContentType.set(request.getAttribute(RawContentType.REQUEST_ATTRIBUTE), CONTENT_TYPE);
		response.setStatus(HttpServletResponse.SC_OK);
		response.setHeader("Cache-Control", "no-cache");
		// Node 실측 헤더다. Tomcat이 hop-by-hop 헤더를 자체 관리하면 무시될 수 있고, 계약 리포트가 싣지
		// 않는 헤더이므로(contract/lib/record.js ALLOWED_HEADERS) 컨테이너를 뚫어서 맞추지 않는다.
		response.setHeader("Connection", "keep-alive");

		AsyncContext context = request.startAsync();
		context.setTimeout(NO_TIMEOUT);
		ServletStream stream;
		try {
			stream = new ServletStream(context, response.getOutputStream());
		}
		catch (IOException ex) {
			context.complete(); // 열어 둔 비동기 컨텍스트를 남기지 않는다(누수 = 영구 침묵).
			throw new UncheckedIOException(ex);
		}
		context.addListener(stream.containerEvents());
		try {
			response.flushBuffer(); // 200과 헤더를 즉시 내보낸다(계약 하네스는 헤더 수신 시점에 반환한다).
		}
		catch (IOException ex) {
			stream.close();
			throw new UncheckedIOException(ex);
		}
		return stream;
	}

	/**
	 * 열린 SSE 응답 하나 — 인스턴스 단위로 쓰기가 직렬화된다.
	 *
	 * <p>구현은 <b>prelude 모드</b>로 시작한다. {@link #endPrelude(long)}를 부르지 않으면 이 스트림은
	 * <b>영원히 아무것도 내보내지 않는다</b>(그리고 {@code setTimeout(0)}이라 컨테이너 타임아웃도 없다).
	 * 그래서 컨트롤러는 {@code open()} ~ {@code endPrelude} 구간 전체를 {@code try/catch}로 감싸 예외 시
	 * 봉인해야 한다 — 안 하면 클라이언트는 헤더만 받고 영원히 기다리고 서버는 구독과 비동기 컨텍스트를 붙든다.
	 */
	public interface Stream extends AutoCloseable {

		/**
		 * 프레임 1개를 쓰고 flush한다. prelude 구간이면 <b>쓰지 않고 큐에 적재</b>한다(그때도 {@code true}).
		 *
		 * @return 끊김·닫힘이면 {@code false}(그 경우 스스로 봉인한다). <b>절대 던지지 않는다</b>
		 */
		boolean write(byte[] frame);

		/**
		 * 위와 같되 드레인 시 중복 제거에 쓸 순서키를 함께 적재한다(로그 스트림의 {@code seq}).
		 * live 모드에서는 키를 쓰지 않는다.
		 */
		boolean write(byte[] frame, long orderKey);

		/**
		 * prelude 구간에서 <b>호출자가 직접</b> 쓴다(큐를 거치지 않는다) — ready·replay가 이 경로다.
		 * 같은 write monitor를 잡으므로 다른 스레드의 {@link #close()}와 경합해도 안전하며,
		 * 이미 닫혔으면 {@code false}를 돌려주고 던지지 않는다.
		 */
		boolean writePrelude(byte[] frame);

		/**
		 * prelude를 닫는다. write monitor를 잡은 채 ① 큐에서 {@code orderKey <= dropOrderKeyUpTo}인 항목을
		 * 버리고 ② 나머지를 <b>적재 순서대로</b> 쓰고 ③ live 모드로 전환한다. <b>멱등</b>이며, 이미 닫힌
		 * 스트림에서는 아무것도 쓰지 않는다.
		 *
		 * @param dropOrderKeyUpTo 이 값 이하의 순서키를 가진 적재 항목을 버린다. 버릴 것이 없으면
		 *     {@link SseHttp#DROP_NOTHING}
		 */
		void endPrelude(long dropOrderKeyUpTo);

		boolean isOpen();

		/**
		 * 봉인한다 — <b>멱등</b>이고 {@code AsyncContext.complete()}는 정확히 1회다.
		 * <b>종료 프레임을 쓰지 않는다</b>: {@code unauthorized}를 보낼지는 호출자가 정한다.
		 */
		@Override
		void close();

		/**
		 * 종료(클라 끊김·컨테이너 종료·봉인) 시 1회 불릴 콜백을 등록한다 — <b>구독 해제 지점</b>이다.
		 *
		 * <p>콜백은 write monitor를 잡은 채 불린다. 그러니 <b>구독 해제 외의 일을 하지 마라</b> — 특히
		 * 다른 락을 잡거나 {@code LogService}에 로그하면 통지 스레드와 락 순서가 엇갈릴 수 있다.
		 * 이미 닫힌 뒤 등록하면 <b>그 자리에서</b> 부른다(구독 누수를 만들지 않는다).
		 */
		void onClosed(Runnable callback);

	}

	/**
	 * 서블릿 비동기 위의 {@link Stream} 구현.
	 *
	 * <p><b>불변식</b>: 모드 검사 · 큐 적재 · 드레인 · 모드 전환 · {@code writePrelude} · {@code close}가
	 * 전부 {@code writeLock} 안에서 일어난다. 그래야 동시 트리거의 {@code write}가 <b>드레인 전이면 큐에
	 * 들어가고 드레인 후면 직행</b>하며, 그 둘 사이로 새는 경로가 없다.
	 */
	static final class ServletStream implements Stream {

		/** 적재 항목 — 순서키는 드레인 시 중복 제거에만 쓴다. */
		private record Pending(byte[] frame, long orderKey) {
		}

		private final AsyncContext context;

		private final OutputStream out;

		/** 이 스트림의 유일한 monitor — 프레임이 섞이지 않게 쓰기를 직렬화한다. */
		private final Object writeLock = new Object();

		private final Deque<Pending> queue = new ArrayDeque<>();

		private boolean prelude = true;

		private boolean closed;

		private int dropped;

		private Runnable onClosed;

		ServletStream(AsyncContext context, OutputStream out) {
			this.context = Objects.requireNonNull(context, "context");
			this.out = Objects.requireNonNull(out, "out");
		}

		@Override
		public boolean write(byte[] frame) {
			return write(frame, NO_ORDER_KEY);
		}

		@Override
		public boolean write(byte[] frame, long orderKey) {
			synchronized (this.writeLock) {
				if (this.closed) {
					return false;
				}
				if (this.prelude) {
					enqueue(frame, orderKey);
					return true;
				}
				return writeNow(frame);
			}
		}

		@Override
		public boolean writePrelude(byte[] frame) {
			synchronized (this.writeLock) {
				return writeNow(frame);
			}
		}

		@Override
		public void endPrelude(long dropOrderKeyUpTo) {
			synchronized (this.writeLock) {
				if (!this.prelude) {
					return; // 멱등 — 큐를 두 번 흘려보내지 않는다.
				}
				this.prelude = false;
				while (!this.queue.isEmpty()) {
					Pending pending = this.queue.pollFirst();
					if (pending.orderKey() <= dropOrderKeyUpTo) {
						continue; // replay가 이미 보낸 seq다.
					}
					if (!writeNow(pending.frame())) {
						this.queue.clear();
						return; // 끊겼다 — writeNow가 이미 봉인했다.
					}
				}
			}
		}

		@Override
		public boolean isOpen() {
			synchronized (this.writeLock) {
				return !this.closed;
			}
		}

		@Override
		public void close() {
			synchronized (this.writeLock) {
				if (this.closed) {
					return;
				}
				this.closed = true;
				this.queue.clear(); // 닫힌 응답에 쓰지 않는다.
				Runnable callback = this.onClosed;
				this.onClosed = null;
				if (callback != null) {
					runQuietly(callback); // 종료 순서는 Node createSseCloser와 같다: 구독 해제가 먼저다.
				}
				completeQuietly();
			}
		}

		@Override
		public void onClosed(Runnable callback) {
			Objects.requireNonNull(callback, "callback");
			synchronized (this.writeLock) {
				if (this.closed) {
					runQuietly(callback);
					return;
				}
				this.onClosed = callback;
			}
		}

		/** 관측용 — 상한에 걸려 버린 프레임 수(테스트가 큐의 유한성을 단언한다). */
		int droppedCount() {
			synchronized (this.writeLock) {
				return this.dropped;
			}
		}

		/** 관측용 — 아직 드레인되지 않은 적재 수. */
		int queuedCount() {
			synchronized (this.writeLock) {
				return this.queue.size();
			}
		}

		/** {@code writeLock}을 잡은 채로만 부른다. */
		private void enqueue(byte[] frame, long orderKey) {
			if (this.queue.size() >= PRELUDE_MAX) {
				this.queue.pollFirst();
				this.dropped++;
			}
			this.queue.addLast(new Pending(frame, orderKey));
		}

		/**
		 * {@code writeLock}을 잡은 채로만 부른다. 프레임마다 flush한다 — 빼면 컨테이너 버퍼에 남아
		 * 클라이언트가 이벤트를 받지 못하고 계약의 조건 대기가 통째로 타임아웃한다.
		 */
		private boolean writeNow(byte[] frame) {
			if (this.closed) {
				return false;
			}
			try {
				this.out.write(frame);
				this.out.flush();
				return true;
			}
			catch (IOException | RuntimeException ex) {
				// 클라 끊김·컨테이너 상태 오류 — 트리거 요청의 응답을 망치지 않는다(클래스 주석).
				close();
				return false;
			}
		}

		private void completeQuietly() {
			try {
				this.context.complete();
			}
			catch (RuntimeException ex) {
				// 컨테이너가 이미 끝낸 뒤일 수 있다(onComplete 경로). 종료는 이미 목적을 달성했다.
			}
		}

		private static void runQuietly(Runnable callback) {
			try {
				callback.run();
			}
			catch (RuntimeException ex) {
				// 구독 해제 실패가 나머지 정리를 막지 않는다.
			}
		}

		/**
		 * 컨테이너가 알려주는 종료 3경로 — 전부 봉인(구독 해제 + complete)으로 수렴한다.
		 * {@code close()}가 멱등이라 정상 경로와 겹쳐도 안전하다.
		 */
		AsyncListener containerEvents() {
			return new AsyncListener() {

				@Override
				public void onComplete(AsyncEvent event) {
					close();
				}

				@Override
				public void onError(AsyncEvent event) {
					close();
				}

				@Override
				public void onTimeout(AsyncEvent event) {
					close(); // setTimeout(0)이라 오지 않아야 하지만, 컨테이너 재량을 신뢰하지 않는다.
				}

				@Override
				public void onStartAsync(AsyncEvent event) {
					// 이 스트림은 다시 디스패치되지 않는다.
				}

			};
		}

	}

}
