package harness.news.controller;

import harness.news.service.Authorization;
import harness.news.service.ChangeBus;
import harness.news.service.DistributionRetryService;
import harness.news.service.DistributionTickService;
import harness.news.service.Identity;
import harness.news.service.SessionGuard;
import harness.news.web.JsonHttp;
import harness.news.web.NodeNumber;
import harness.news.web.ReasonStatus;
import harness.news.web.SessionTokens;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.StringJoiner;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * 배부 실행 3라우트 — 시점 배부 {@code POST /api/distribution/tick} · 실패 목록
 * {@code GET /api/distribution/failures} · 재전송 {@code POST /api/distribution/retry}. 리포 루트
 * {@code server/index.js} 740~787행의 같은 3라우트와 1:1이다.
 *
 * <h2>컨트롤러가 하는 일은 셋뿐이다(ADR-006 · decisions (21))</h2>
 * <ol>
 *   <li><b>토큰 판독</b> — 쿠키 우선 · {@code x-session-id} 폴백({@link SessionTokens}).</li>
 *   <li><b>게이트·서비스 호출</b> — 인가는 {@link Authorization}의 capability 2개(Z 전용)이고,
 *       스캔·시점 판정·상태 전이·투영·시계는 전부 서비스가 소유한다.</li>
 *   <li><b>shape 매핑</b> — 서비스가 만든 맵을 그대로 싣고 사유 → 상태코드를 정한다.</li>
 * </ol>
 * <b>acting role도 {@code actorUserId}도 검증된 세션에서만</b> 온다(ADR-004) — 본문의 {@code role}은
 * 판정에 닿을 방법이 구조적으로 없다.
 *
 * <h2>판정 순서: 인가 → 설정</h2>
 * 세 라우트 전부 <b>인가가 먼저</b>다. 비-Z에게 {@code spool-disabled}(503)를 주면 배부 설정 상태가 새어
 * 나간다({@code contract/cases/minimal/distribution-disabled.contract.js}의
 * {@code r-session-not-disabled}가 그 순서를 관측한다).
 *
 * <h2>{@code tick}은 body를 읽지 않는다 — 구조로 강제한다(decisions (5))</h2>
 * 그 핸들러에는 {@code @RequestBody}도 {@link JsonHttp#readBody} 호출도 <b>없다</b>. 시각·대상 목록·기사
 * 식별자를 클라이언트가 주입할 수 있으면 엠바고가 무력화되고(도래 전 기사가 나가면 회수 수단이 없다),
 * 그 무력화는 "값을 읽되 쓰지 않는다"는 규율로는 지켜지지 않는다. 부수효과 라우트라 <b>GET으로도 열지
 * 않는다</b> — 그 경로의 GET이 404인 것은 {@code GlobalErrorHandler.handleNotFound}가 이미 만드는 결과라
 * 여기에 전용 처리를 두지 않는다(겹쳐 만들면 본문·Content-Type이 다른 404가 하나 더 생긴다).
 *
 * <h2>재전송의 서버측 장애 3토큰만 라우트에서 500이다</h2>
 * {@code spool-write-failed}·{@code invalid-spool-dir}·{@code invalid-article-id}는 요청으로 고칠 수 있는
 * 오류가 아니라 서버 데이터·파일시스템 문제다. <b>전역 표에 넣지 않는 이유</b>: {@code invalid-spool-dir}는
 * 배부 대상 CRUD의 입력 검증 거부(400)와 <b>같은 토큰</b>이라 전역화하는 순간 그쪽 계약이 깨진다
 * (Node도 같은 이유로 라우트 로컬 매핑을 쓴다 — {@code server/index.js} 775~782행).
 *
 * <p>응답은 반드시 {@link JsonHttp} 한 지점으로만 쓴다(Content-Type 바이트 패리티 — decisions (22)).
 */
@RestController
public class DistributionController {

	/** 라우트 로컬 500 재매핑 대상. {@link ReasonStatus} 전역 표에 <b>넣지 않는다</b>(클래스 주석 참조). */
	private static final Set<String> SERVER_FAULT_REASONS =
			Set.of("spool-write-failed", "invalid-spool-dir", "invalid-article-id");

	private static final String OK = "ok";

	private static final String REASON = "reason";

	private final Authorization authorization;

	private final SessionGuard sessions;

	private final DistributionTickService tick;

	private final DistributionRetryService retries;

	private final JsonHttp json;

	/** 무효화 신호 버스 — 생성자 주입(ADR-013). 발행은 <b>성공 분기</b>에서만 한다(아래 두 자리). */
	private final ChangeBus changes;

	public DistributionController(Authorization authorization, SessionGuard sessions,
			DistributionTickService tick, DistributionRetryService retries, JsonHttp json,
			ChangeBus changes) {
		this.authorization = authorization;
		this.sessions = sessions;
		this.tick = tick;
		this.retries = retries;
		this.json = json;
		this.changes = changes;
	}

	/**
	 * 시점 배부 1회 실행 — Z 전용. 외부 운영 cron이 <b>Z 세션</b>으로 주기 호출하는 유일한 트리거다
	 * (앱에 타이머를 두지 않는다 — ADR-008 (3)).
	 *
	 * <p><b>파라미터가 없다</b>: 요청에서 읽는 것은 세션 토큰뿐이고 시각·대상·kind는 전부 서버가 정한다.
	 * 성공 응답은 서비스가 만든 요약 6키 그대로이며 서버 파일시스템 경로는 한 글자도 실리지 않는다
	 * (화이트리스트 투영은 서비스의 책임이고 여기서 다시 가공하지 않는다).
	 */
	@PostMapping("/api/distribution/tick")
	public void tick(HttpServletRequest request, HttpServletResponse response) {
		String token = tokenOf(request);
		Authorization.Decision gate = this.authorization.authorize(token, Authorization.RUN_DISTRIBUTION_TICK);
		if (!gate.ok()) {
			deny(request, response, gate.reason());
			return;
		}
		// 스풀 미설정 판정은 서비스가 한다(spool-disabled) — 설정을 여기서 다시 읽으면 판정 지점이 둘이 된다.
		Map<String, Object> result = this.tick.run(actorUserId(token));
		// Node 749행 — 성공이면서 **실제 배부가 있었을 때만** 신호를 낸다. 실행 결과가 0건인데 신호를
		// 내면 클라이언트가 변경 0건을 위해 목록을 다시 읽는다(재조회 낭비 + 오신호). 판정 입력
		// distributed는 서비스 반환 맵에 이미 있다 — 여기서 다시 계산하지 않는다.
		if (Boolean.TRUE.equals(result.get(OK)) && distributedAny(result)) {
			this.changes.publish(ChangeBus.STATUS);
		}
		respond(request, response, result);
	}

	/**
	 * 미해소 배부 실패 목록 — Z 전용. <b>스풀 설정과 무관하게</b> 200이다(조회는 파일시스템을 건드리지
	 * 않는다).
	 *
	 * <p>쿼리는 {@code limit} <b>하나만</b> 화이트리스트로 넘긴다(통짜 전달 금지 — 정규화·클램프·투영은
	 * 서비스 단일 출처다). 값 판독은 Node 라우트의 {@code Number(req.query.limit)} 자리와 같아서
	 * <b>어떤 값이든 400이 아니다</b>: {@code abc}·{@code -1}은 기본 창으로 접히고, 반복 키
	 * {@code ?limit=1&limit=2}는 배열 → {@code Number(['1','2'])} = NaN → 기본 창이다.
	 */
	@GetMapping("/api/distribution/failures")
	public void failures(HttpServletRequest request, HttpServletResponse response) {
		String token = tokenOf(request);
		Authorization.Decision gate =
				this.authorization.authorize(token, Authorization.MANAGE_DISTRIBUTION_FAILURE);
		if (!gate.ok()) {
			deny(request, response, gate.reason());
			return;
		}
		respond(request, response, this.retries.list(numberOf(queryValues(request, "limit"))));
	}

	/**
	 * 실패한 수신처 <b>한 곳</b>에 다시 보낸다 — Z 전용.
	 *
	 * <p>본문에서 읽는 값은 {@code historyId}(목록의 키) <b>하나뿐</b>이다. {@code articleId}·
	 * {@code targetId}·{@code kind}·{@code role}을 함께 보내도 <b>무시</b>한다 — 기사·수신처·kind는 서버가
	 * 그 실패 행에서만 도출한다(ADR-004). 호출자가 고르게 하면 임의 수신처로 임의 기사를 내보내는 경로가
	 * 열린다.
	 */
	@PostMapping("/api/distribution/retry")
	public void retry(HttpServletRequest request, HttpServletResponse response) {
		String token = tokenOf(request);
		Authorization.Decision gate =
				this.authorization.authorize(token, Authorization.MANAGE_DISTRIBUTION_FAILURE);
		if (!gate.ok()) {
			deny(request, response, gate.reason());
			return;
		}
		Map<String, Object> body = this.json.readBody(request);
		Map<String, Object> result = this.retries.retry(numberOf(body.get("historyId")), actorUserId(token));
		if (Boolean.TRUE.equals(result.get(OK))) {
			// Node 787행 — 성공 분기 **안**이다. 4xx 거부에도, 아래 500 재매핑 3토큰에도 신호는 없다.
			this.changes.publish(ChangeBus.STATUS);
			this.json.write(request, response, 200, result);
			return;
		}
		String reason = asText(result.get(REASON));
		// null 안전: Set.contains(null)은 NPE라 400이어야 할 거부가 500 internal-error로 나간다.
		int status = (reason != null && SERVER_FAULT_REASONS.contains(reason)) ? 500 : ReasonStatus.of(reason);
		this.json.write(request, response, status, result);
	}

	/**
	 * {@code Array.isArray(r.distributed) && r.distributed.length > 0} — Node 749행의 판정 그대로다.
	 *
	 * <p>키가 없거나 리스트가 아니면 <b>거짓</b>이다(Node의 {@code Array.isArray}와 같은 폭). 값의 내용은
	 * 보지 않는다 — 요약 맵의 소유자는 서비스이고 여기서 다시 해석하면 판정이 둘로 갈린다.
	 */
	private static boolean distributedAny(Map<String, Object> result) {
		return result.get("distributed") instanceof List<?> distributed && !distributed.isEmpty();
	}

	/** 서비스 결과 → 응답. 성공이면 요약 맵 그대로, 거부면 사유가 상태코드를 정한다(전역 표 + 폴백 400). */
	private void respond(HttpServletRequest request, HttpServletResponse response,
			Map<String, Object> result) {
		if (Boolean.TRUE.equals(result.get(OK))) {
			this.json.write(request, response, 200, result);
			return;
		}
		this.json.write(request, response, ReasonStatus.of(asText(result.get(REASON))), result);
	}

	private void deny(HttpServletRequest request, HttpServletResponse response, String reason) {
		this.json.write(request, response, ReasonStatus.of(reason), JsonHttp.fail(reason));
	}

	private static String tokenOf(HttpServletRequest request) {
		return SessionTokens.read(request.getHeader("cookie"), request.getHeader(SessionTokens.HEADER_NAME));
	}

	/**
	 * 행위자 — <b>검증된 세션에서 다시 도출한다</b>(ADR-004). 게이트는 신원을 돌려주지 않으므로 가드에
	 * 직접 물어본다(재조회는 멱등이고, 게이트가 신원을 흘리기 시작하면 거부 경로에서도 새어 나간다).
	 */
	private String actorUserId(String token) {
		Identity actor = (token == null) ? null : this.sessions.touchSession(token);
		return (actor == null) ? null : actor.userId();
	}

	/**
	 * 반복 쿼리 키를 <b>express(qs)와 같은 모양</b>으로 준다: 한 번 온 키는 문자열, 반복된 키는 값 리스트다.
	 *
	 * <p>{@code getParameterValues}로 읽는다 — {@code getParameter(}는 {@code ?session=} 폴백 부활을 막는
	 * 정적 스캔({@code WebWiringTest})이 금지한 API이고, <b>첫 값으로 접으면</b> 반복 키의 의미가 갈린다
	 * (아래 {@link #numberOf} 참조).
	 *
	 * @return 값이 없으면 {@code null}(= JS의 {@code undefined})
	 */
	private static Object queryValues(HttpServletRequest request, String name) {
		String[] values = request.getParameterValues(name);
		if (values == null || values.length == 0) {
			return null;
		}
		return (values.length == 1) ? values[0] : List.of(values);
	}

	/**
	 * HTTP 경계의 {@code Number(x)} — Node 라우트가 {@code Number(req.query.limit)}·
	 * {@code Number(body.historyId)}로 하는 변환과 같은 자리다. 그 뒤의 정규화(정수·범위·클램프)는
	 * <b>서비스</b>가 소유하므로 여기서 하지 않는다.
	 *
	 * <p>문자열 판독은 {@link NodeNumber#toNumber} <b>단일 출처</b>다(로컬 재구현 금지 — decisions (18)).
	 * 나머지는 JS의 값 변환 규칙 그대로다:
	 * <ul>
	 *   <li>{@code true}/{@code false} → 1/0 (본문에 {@code {"historyId":true}}를 넣어도 Node는 1로 읽는다)</li>
	 *   <li>배열 → 원소를 콤마로 이은 문자열({@code Number(['1','2'])}는 {@code Number('1,2')} = NaN) —
	 *       <b>반복 쿼리 키가 기본 창으로 수렴하는 근거</b>다. 첫 값으로 접으면 같은 요청에 Spring만 다른
	 *       크기의 목록을 싣는다.</li>
	 *   <li>그 밖(객체·값 없음) → {@code NaN}. JS는 {@code undefined}를 NaN, {@code null}을 0으로 읽지만
	 *       <b>둘 다 서비스의 "정수 &ge; 1" 게이트에서 같은 거부</b>라 관측은 갈리지 않는다.</li>
	 * </ul>
	 */
	private static Double numberOf(Object raw) {
		if (raw instanceof Boolean flag) {
			return Double.valueOf(flag.booleanValue() ? 1.0d : 0.0d);
		}
		if (raw instanceof Number number) {
			return Double.valueOf(number.doubleValue());
		}
		if (raw instanceof CharSequence text) {
			return Double.valueOf(NodeNumber.toNumber(text.toString()));
		}
		if (raw instanceof List<?> values) {
			StringJoiner joined = new StringJoiner(",");
			for (Object value : values) {
				joined.add((value == null) ? "" : String.valueOf(value));
			}
			return Double.valueOf(NodeNumber.toNumber(joined.toString()));
		}
		return Double.valueOf(Double.NaN);
	}

	private static String asText(Object value) {
		return (value instanceof String text) ? text : null;
	}

}
