package harness.news.controller;

import harness.news.service.Authorization;
import harness.news.service.LogRecord;
import harness.news.service.LogService;
import harness.news.web.JsonHttp;
import harness.news.web.ReasonStatus;
import harness.news.web.SessionTokens;
import harness.news.web.SseHttp;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;
import tools.jackson.databind.ObjectMapper;

/**
 * 로그 노출 2라우트 — {@code GET /api/logs/digest}(pull)와 {@code GET /api/logs/stream}(SSE push).
 * 둘 다 <b>Z 전용</b>이다(ADR-007).
 *
 * <p>이 라우트가 이 phase에 있는 이유는 로그 도메인이 아니라 <b>세션 가드 축</b>이다:
 * {@code contract/cases/default/session-guard.contract.js}가 "Z 전용 라우트"로 이 경로를 써서
 * 강등 전 200 → 강등 후 403(재로그인 없이)을 검증한다. 그래서 여기서 중요한 것은 로그 도메인이 아니라
 * <b>role을 검증된 세션에서만 도출한다</b>는 사실이다(ADR-004).
 *
 * <h2>인가 2단</h2>
 * 미인증 401은 경로 정책 필터가 컨트롤러 앞에서 끊고({@code endpoints.json}의 {@code auth: admin} 행),
 * 인증된 요청의 비-Z 403은 여기 역할 게이트가 낸다. 두 층이 각자 자기 사유 토큰을 낸다 —
 * {@code /api/stream}(로그인만 요구)과 달리 이 라우트에는 role 게이트가 있다.
 * <b>두 라우트가 같은 방식으로 게이트한다</b>({@code authorization.authorize(token, VIEW_LOGS)}) —
 * 판정이 두 곳으로 갈리면 한쪽만 고쳐도 조용히 뚫린다.
 *
 * <h2>읽기 전용 · 스텁 아님</h2>
 * {@link LogService}의 in-memory 링 버퍼에 위임만 한다(파일·DB를 만들거나 건드리지 않는다).
 * 응답의 {@code items}가 비어 있는 것은 <b>정상</b>이다: 창이 {@code [전날 06:00, 당일 06:00)}이라
 * 갓 기동한 서버에는 창 안의 레코드가 없다. 그러나 <b>빈 배열을 하드코딩하지 않는다</b> —
 * 창 안에 레코드가 있으면 그대로 나온다는 사실은 {@code LogsWireTest}가 시계를 주입해 잠근다
 * (index.json decisions (18)(b): 스텁 핸들러 금지).
 */
@RestController
public class LogsController {

	/**
	 * 접속 직후 replay하는 최대 줄 수 — 정본 {@code server/index.js} 1178행 {@code LOG_REPLAY_MAX}와
	 * 정렬한다(버퍼 cap은 10000이고 그중 최근 2000건만 replay한다 — 전체 replay는 첫 렌더·대역폭 낭비다).
	 *
	 * <p><b>절단은 이 라우트가 한다.</b> {@link LogService#snapshot()}은 자르지 않는다 — 거기서 자르면
	 * {@code digest()}와 다른 창을 갖는 두 번째 절단 지점이 생기고 한쪽만 고쳐도 조용히 갈린다.
	 */
	private static final int LOG_REPLAY_MAX = 2000;

	private final Authorization authorization;

	private final LogService logs;

	private final JsonHttp json;

	private final SseHttp sse;

	private final ObjectMapper mapper;

	public LogsController(Authorization authorization, LogService logs, JsonHttp json, SseHttp sse,
			ObjectMapper mapper) {
		this.authorization = authorization;
		this.logs = logs;
		this.json = json;
		this.sse = sse;
		this.mapper = mapper;
	}

	@GetMapping("/api/logs/digest")
	public void digest(HttpServletRequest request, HttpServletResponse response) {
		String token = SessionTokens.read(request.getHeader("cookie"),
				request.getHeader(SessionTokens.HEADER_NAME));
		Authorization.Decision gate = this.authorization.authorize(token, Authorization.VIEW_LOGS);
		if (!gate.ok()) {
			this.json.write(request, response, ReasonStatus.of(gate.reason()), JsonHttp.fail(gate.reason()));
			return;
		}

		List<Map<String, Object>> items = new ArrayList<>();
		for (LogRecord record : this.logs.digest()) {
			items.add(record.asMap());
		}
		Map<String, Object> payload = new LinkedHashMap<>();
		payload.put("ok", true);
		payload.put("items", items);
		this.json.write(request, response, 200, payload);
	}

	/**
	 * 실시간 로그 SSE — 접속 시점 버퍼 최근 {@value #LOG_REPLAY_MAX}건을 replay한 뒤 실시간 push를 잇는다
	 * (정본 {@code server/index.js} 1178~1217행과 1:1 · ADR-007 · ADR-015).
	 *
	 * <h2>접속 시퀀스: 구독 → 스냅샷 → ready → replay → 드레인</h2>
	 * <ol>
	 *   <li>인가 게이트를 <b>스트림을 열기 전에</b> 통과시킨다(미인증 401 · 비-Z 403 JSON). 200 SSE 헤더가
	 *       나간 뒤에는 거부를 상태코드로 표현할 수 없다.</li>
	 *   <li>{@link SseHttp#open}이 헤더 3종을 바이트 그대로 쓰고 200을 커밋한다. 돌아온 스트림은
	 *       <b>prelude 모드</b>다({@code write}가 큐에 적재된다).</li>
	 *   <li><b>구독을 가장 먼저</b> 건다 — 이 시점부터 유실 창이 0이다. 정본은 ready·replay를 쓴 뒤
	 *       구독하지만 그것이 안전한 이유는 Node가 <b>단일 스레드</b>라 그 사이에 다른 요청이 처리되지 않기
	 *       때문이다. <b>Spring은 다른 워커가 동시에 돈다</b> — replay가 최대 2000 write를 도는 수십~수백
	 *       ms 동안 발생한 로그가 구독 부재로 사라진다.</li>
	 *   <li>스냅샷을 <b>구독 뒤에</b> 뜬다(반대면 스냅샷과 구독 사이에 창이 생긴다).</li>
	 *   <li>{@code writePrelude(READY)} — ready는 큐를 거치지 않으므로 <b>언제나 첫 프레임</b>이다.</li>
	 *   <li>replay를 {@code writePrelude}로 직접 쓰고 마지막 seq를 기억한다.</li>
	 *   <li>{@code endPrelude(lastReplayedSeq)} — write monitor 안에서 「{@code seq <= lastReplayedSeq}
	 *       버리기 → FIFO 드레인 → live 전환」을 원자적으로 한다. 3~6 사이에 들어온 줄이 스냅샷에도 있고
	 *       큐에도 있을 수 있어 <b>중복 제거</b>가 필요하다.</li>
	 * </ol>
	 * 결과 순서는 <b>ready → replay(오래된→최신) → 창에서 온 신규 → live</b>이고 유실 0 · 중복 0 · 역전 0이다.
	 * <b>이 축은 계약이 보지 못한다</b>({@code contract/cases/default/logs.contract.js} 170~178행이
	 * {@code seq > seqBefore} 하한만 보고, 그 하한은 replay 잔여와 <b>이 요청 자신의 액세스 로그</b>로
	 * 충족된다) — 방어선은 {@code LogsStreamWireTest}·{@code LogsStreamReplayWireTest}의 경합 테스트뿐이다.
	 *
	 * <h2>3~7 구간의 예외는 봉인으로 수렴시킨다</h2>
	 * {@code endPrelude}에 닿기 전에 예외가 나면 스트림은 <b>영원히 침묵</b>한다(prelude 모드 그대로다).
	 * 최대 2000 write를 도는 이 라우트가 가장 위험하므로 그 구간을 {@code catch}로 감싸 봉인한다.
	 * ({@code setTimeout(0)}이라도 이 컨테이너는 async error dispatch로 컨텍스트를 정리한다 —
	 * 2026-08-30 step4 M4-14 실측. 그래도 종료를 컨테이너 에러 처리에 맡기지 않고 앱의 한 지점으로 모은다.)
	 *
	 * <h2>replay는 재검증하지 않고, live push는 매번 재검증한다</h2>
	 * replay는 접속 시점 인증으로 충분하다(같은 tick — 정본 동형). live push는 매번 <b>비연장</b>
	 * {@code authorizePeek}로 세션과 <b>role Z</b>를 다시 본다: 강등·비활성·로그아웃이면 그 로그 라인을
	 * <b>한 줄도 쓰지 않고</b> 봉인한다(ADR-007 — Z 전용 봉인이 시간축에서도 유지된다).
	 * {@code touchSession}을 쓰는 {@code authorize}/{@code editDps}를 push에 쓰면 열린 스트림이 세션
	 * 유휴 만료를 무한 연장한다.
	 */
	@GetMapping("/api/logs/stream")
	public void stream(HttpServletRequest request, HttpServletResponse response) {
		String token = SessionTokens.read(request.getHeader("cookie"),
				request.getHeader(SessionTokens.HEADER_NAME));
		Authorization.Decision gate = this.authorization.authorize(token, Authorization.VIEW_LOGS);
		if (!gate.ok()) {
			// 스트림을 열기 전에 끝낸다 — 열고 나서 거부 프레임을 보내는 구현은 계약 위반이다.
			this.json.write(request, response, ReasonStatus.of(gate.reason()), JsonHttp.fail(gate.reason()));
			return;
		}

		SseHttp.Stream stream = this.sse.open(request, response);
		SseCloser closer = new SseCloser(stream);
		try {
			closer.subscribed(this.logs.subscribe((record) -> push(token, record, stream, closer)));
			stream.onClosed(closer::unsubscribe); // 클라 끊김·컨테이너 종료 — 구독 해제만 한다.
			List<LogRecord> buffered = this.logs.snapshot();
			stream.writePrelude(SseHttp.READY);

			long lastReplayedSeq = SseHttp.DROP_NOTHING;
			for (LogRecord record : buffered.subList(Math.max(0, buffered.size() - LOG_REPLAY_MAX),
					buffered.size())) {
				if (!stream.writePrelude(logFrame(record))) {
					break; // 클라가 끊겼다(스트림은 스스로 봉인했다) — 남은 replay는 의미가 없다.
				}
				lastReplayedSeq = record.seq();
			}
			stream.endPrelude(lastReplayedSeq);
		}
		catch (RuntimeException ex) {
			closer.seal(); // 멱등 — 정상 경로와 겹쳐도 안전하다.
		}
	}

	/**
	 * 구독 콜백 — {@code LogService.log}를 부른 <b>그 스레드</b>(액세스 로그는 요청 로거의 {@code finally})에서
	 * 돈다. 그래서 예외를 내보내지 않고, <b>이 안에서 다시 로그하지 않는다</b>(통지 → 로그 → 통지의 무한 재귀).
	 *
	 * <p>재검증 불가는 "일단 전송"이 아니라 봉인이다 — 잡는 위치가 여기인 것도 계약이다(세션 계층에서 잡으면
	 * HTTP 라우트의 DB 예외가 500 대신 401이 되는 광범위한 동작 변화가 생긴다 — 정본 주석이 명시한 자리).
	 */
	private void push(String token, LogRecord record, SseHttp.Stream stream, SseCloser closer) {
		Authorization.Decision live;
		try {
			live = this.authorization.authorizePeek(token, Authorization.VIEW_LOGS);
		}
		catch (RuntimeException ex) {
			closer.seal(); // fail-closed — 재검증할 수 없으면 그 로그 라인을 쓰지 않는다.
			return;
		}
		if (!live.ok()) {
			closer.seal(); // 로그아웃·만료·비활성·강등 — 한 줄도 쓰지 않고 끝낸다.
			return;
		}
		if (!stream.write(logFrame(record), record.seq())) {
			closer.unsubscribe(); // 클라가 끊겼다(스트림은 스스로 봉인했다) — 구독만 거둔다.
		}
	}

	/**
	 * {@code event: log} 프레임 1개 — payload는 record <b>5키</b>({@code seq·ts·level·message·line})다.
	 * 직렬화는 {@link LogRecord#asMap()}을 거친다(그 타입을 Jackson에 그대로 넘기지 않는다 — 키 이름·순서·
	 * null 처리가 코드에 보여야 한다).
	 */
	private byte[] logFrame(LogRecord record) {
		return SseHttp.frame("log", this.mapper.writeValueAsString(record.asMap()));
	}
}
