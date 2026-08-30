package harness.news.controller;

import harness.news.service.ChangeBus;
import harness.news.service.SessionGuard;
import harness.news.web.JsonHttp;
import harness.news.web.SessionTokens;
import harness.news.web.SseHttp;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import java.util.concurrent.atomic.AtomicBoolean;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;
import tools.jackson.databind.ObjectMapper;

/**
 * 무효화 신호 스트림 — {@code GET /api/stream}. 리포 루트 {@code server/index.js} 1124~1160행과 1:1이다
 * (ADR-005 · ADR-015).
 *
 * <h2>인가는 로그인만이다</h2>
 * {@code RoutePolicy}에 {@code AuthClass.SESSION}으로 등재돼 있어 <b>미인증 401은 경로 정책 필터가
 * 스트림을 열기 전에</b> JSON으로 낸다(계약이 요구하는 형태 그대로 — 열고 나서 오류 프레임을 보내는
 * 구현은 위반이다). 여기까지 온 요청은 이미 인증됐지만, push 재검증에 쓸 토큰이 필요하므로 토큰을 다시
 * 읽어 <b>비연장 조회</b>로 신원을 확인하고 없으면 fail-closed 401이다. 역할 게이트는 없다 —
 * {@code GET /api/logs/stream}(Z 전용)과 다른 점이 그것이고, 대신 이 스트림의 payload에는 행 데이터가
 * 한 조각도 실리지 않는다(아래).
 *
 * <h2>payload는 {@code kind} 한 키뿐이다(ADR-005)</h2>
 * 신호는 "무언가 바뀌었다"이고 <b>무엇이 바뀌었는지는 담지 않는다</b>. 담는 순간 역할별 노출 규칙을
 * SSE에서 한 번 더 구현해야 하고(구독자마다 볼 수 있는 기사가 다르다) 그 이중 구현이 곧 유출이다.
 * 클라이언트는 신호를 받고 자기 권한으로 목록을 다시 읽는다.
 *
 * <h2>접속 시퀀스: 구독 → ready → 드레인</h2>
 * <ol>
 *   <li>{@link SseHttp#open}이 헤더 3종을 바이트 그대로 쓰고 200을 커밋한다. 돌아온 스트림은
 *       <b>prelude 모드</b>다({@code write}가 큐에 적재된다).</li>
 *   <li><b>구독을 먼저</b> 건다. 정본은 ready를 쓴 뒤 구독하지만 그것이 안전한 이유는 Node가 단일
 *       스레드라 그 사이에 다른 요청이 처리되지 않기 때문이다 — <b>Spring은 다른 워커가 동시에 돈다</b>.
 *       그 창에서 온 신호는 큐에 적재된다.</li>
 *   <li>{@code writePrelude(READY)} — ready는 큐를 거치지 않으므로 <b>언제나 첫 프레임</b>이다.</li>
 *   <li>{@code endPrelude(DROP_NOTHING)} — write monitor 안에서 적재분을 순서대로 흘려보내고 live로
 *       전환한다. 이 스트림은 순서키 중복 제거가 필요 없다(payload가 {@code kind} 하나뿐이다).</li>
 * </ol>
 * 그래서 <b>"구독이 ready보다 먼저"와 "ready가 첫 프레임"이 동시에 참</b>이다(index.json decisions (15)).
 *
 * <h2>2~4 구간의 예외는 봉인으로 수렴시킨다</h2>
 * {@code open()}이 성공한 뒤 {@code endPrelude}에 닿기 전에 예외가 나면 그 구간을 감싼 {@code catch}가
 * 봉인한다. 다시 던지지 않는 이유: 응답은 이미 커밋됐고 SSE 본문이 흐르는 중이라, 전역 에러 핸들러가
 * 그 위에 500 JSON을 덧쓰려 하면 프레임 스트림이 오염될 수 있다(봉인은 그 자체로 정직한 종료다).
 *
 * <p><b>[2026-08-30 실측 · 계획서 문장 정정]</b> "이 {@code catch}가 없으면 클라이언트가 영원히 기다리고
 * 구독이 누수된다"는 <b>이 컨테이너에서는 거짓</b>이다({@code StreamWireTest} 변이 M4-14): 예외가 핸들러
 * 밖으로 나가면 컨테이너가 async error dispatch로 받아 컨텍스트를 완료하고, 그 완료가
 * {@code AsyncListener} → {@code Stream.close()} → 구독 해제로 이어진다. 그래도 이 {@code catch}를 두는
 * 이유는 <b>종료 경로를 컨테이너 에러 처리에 맡기지 않고</b> 다른 두 종료(재검증 실패 · 클라 끊김)와 같은
 * 한 지점({@code Closer.seal})으로 모으기 위해서다. 와이어로 구별되지 않는 결정이므로
 * {@code StreamWireTest}의 정적 그물이 이 자리를 잠근다.
 *
 * <h2>push 시점 재검증은 비연장 peek다</h2>
 * {@code touchSession}(그리고 그것을 쓰는 {@code Authorization.authorize}·{@code editDps})을 쓰면 열린
 * 스트림 하나가 1시간 유휴 만료를 무한히 밀어낸다 — ADR-005·ADR-007이 명시적으로 닫은 자리이며
 * <b>계약이 관측할 수 없는 축</b>이다(하네스가 시계를 주입할 수 없다). 재검증 실패·예외는 fail-closed
 * 봉인이고, 예외를 잡는 위치는 <b>구독 콜백 안</b>이다: 세션 계층에서 잡으면 HTTP 라우트의 DB 예외가
 * 500 대신 401이 되는 광범위한 동작 변화가 생긴다(정본 주석이 명시한 자리).
 *
 * <h2>타이머·스레드가 0이다(ADR-008 · ADR-015)</h2>
 * 프레임은 {@code ChangeBus.publish}를 부른 <b>트리거 요청 스레드</b>가 쓰고, 연결은 서블릿 비동기
 * 컨텍스트가 유지한다. 주기 재검증도 heartbeat도 없다 — 대가는 이벤트가 없으면 종료가 다음 이벤트까지
 * 지연된다는 것이고 정본도 같다.
 */
@RestController
public class StreamController {

	private final SessionGuard sessions;

	private final ChangeBus changes;

	private final SseHttp sse;

	private final JsonHttp json;

	private final ObjectMapper mapper;

	public StreamController(SessionGuard sessions, ChangeBus changes, SseHttp sse, JsonHttp json,
			ObjectMapper mapper) {
		this.sessions = sessions;
		this.changes = changes;
		this.sse = sse;
		this.json = json;
		this.mapper = mapper;
	}

	@GetMapping("/api/stream")
	public void stream(HttpServletRequest request, HttpServletResponse response) {
		String token = SessionTokens.read(request.getHeader("cookie"), request.getHeader(SessionTokens.HEADER_NAME));
		if (token == null || this.sessions.peekSession(token) == null) {
			// 스트림을 열기 전에 끝낸다 — 200 SSE 헤더가 나간 뒤에는 오류를 상태코드로 표현할 수 없다.
			this.json.write(request, response, 401, JsonHttp.fail("unauthenticated"));
			return;
		}

		SseHttp.Stream stream = this.sse.open(request, response);
		Closer closer = new Closer(stream);
		try {
			closer.subscribed(this.changes.subscribe((kind) -> push(token, kind, stream, closer)));
			stream.onClosed(closer::unsubscribe); // 클라 끊김·컨테이너 종료 — 구독 해제만 한다.
			stream.writePrelude(SseHttp.READY);
			stream.endPrelude(SseHttp.DROP_NOTHING);
		}
		catch (RuntimeException ex) {
			closer.seal(); // 멱등 — 정상 경로와 겹쳐도 안전하다.
		}
	}

	/**
	 * 구독 콜백 — {@code ChangeBus.publish}를 부른 트리거 요청의 스레드에서 돈다.
	 *
	 * <p>여기서 예외를 내보내면 이미 성공한 저장이 500으로 뒤집힌다(버스가 삼키지만 규율은 이쪽에도 둔다).
	 * 재검증 불가는 "일단 전송"이 아니라 봉인이다.
	 */
	private void push(String token, String kind, SseHttp.Stream stream, Closer closer) {
		try {
			if (this.sessions.peekSession(token) == null) {
				closer.seal();
				return;
			}
		}
		catch (RuntimeException ex) {
			closer.seal(); // fail-closed — 재검증할 수 없으면 신호를 쓰지 않는다.
			return;
		}
		if (!stream.write(SseHttp.frame("change", signal(kind)))) {
			closer.unsubscribe(); // 클라가 끊겼다(스트림은 스스로 봉인했다) — 구독만 거둔다.
		}
	}

	/**
	 * 무효화 신호 payload — 키는 {@code kind} <b>하나</b>다. 이스케이프 규칙을 한 곳에 모으려고 문자열
	 * 이어붙이기 대신 JSON 노드로 만든다({@code kind}가 {@code null}이어도 던지지 않는다 —
	 * {@code Map.of}는 NPE다).
	 */
	private String signal(String kind) {
		return this.mapper.createObjectNode().put("kind", kind).toString();
	}

	/**
	 * 종료기 — 정본 {@code createSseCloser}(server/index.js 428~443행)와 같은 순서다:
	 * <b>① 구독 해제 → ② {@code unauthorized} 1회 → ③ 종료</b>. 해제를 먼저 하는 이유는 닫힌 응답에
	 * write가 누적되면 누수와 예외가 되기 때문이고, 봉인이 멱등인 이유는 세 경로(재검증 실패 · 구독 콜백 ·
	 * 접속 시퀀스 예외)가 같은 종료기를 부르기 때문이다.
	 *
	 * <p>플래그를 {@code synchronized}가 아니라 {@link AtomicBoolean}으로 둔 것은 <b>락 순서 때문</b>이다:
	 * 봉인은 스트림의 write monitor를 잡고, 스트림의 종료 훅({@code onClosed})은 그 monitor를 잡은 채
	 * {@link #unsubscribe()}를 부른다 — 종료기가 자기 monitor를 잡은 채 스트림을 호출하면 두 락이
	 * 반대 순서로 얽혀 데드락이 된다.
	 */
	private static final class Closer {

		private final SseHttp.Stream stream;

		private final AtomicBoolean sealed = new AtomicBoolean();

		private volatile AutoCloseable subscription;

		private Closer(SseHttp.Stream stream) {
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
				// 해제 실패가 나머지 정리를 막지 않는다(버스의 해제는 던지지 않는다).
			}
		}

	}

}
