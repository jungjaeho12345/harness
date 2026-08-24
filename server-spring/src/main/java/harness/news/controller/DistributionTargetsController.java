package harness.news.controller;

import harness.news.service.DistributionTargetService;
import harness.news.web.JsonHttp;
import harness.news.web.NodeNumber;
import harness.news.web.ReasonStatus;
import harness.news.web.SessionTokens;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * 배부 대상(수신처) 4라우트 — 목록 {@code GET /api/distribution-targets} · 생성
 * {@code POST /api/distribution-targets} · 수정 {@code PUT /api/distribution-targets/:id} · 비활성
 * {@code POST /api/distribution-targets/:id/deactivate}. 리포 루트 {@code server/index.js}의 같은 4라우트와 1:1.
 *
 * <h2>컨트롤러가 하는 일은 셋뿐이다(ADR-006 · decisions (14))</h2>
 * <ol>
 *   <li><b>토큰 판독</b> — 쿠키 우선 · {@code x-session-id} 폴백({@link SessionTokens}).</li>
 *   <li><b>서비스 호출</b> — 인가 게이트·검증·투영·시각 stamp는 {@link DistributionTargetService}가 소유한다.
 *       id·createdAt·updatedAt·active 기본값은 서비스가 정한다 — 컨트롤러는 클라 role/id/타임스탬프를
 *       신뢰하지 않는다(ADR-004).</li>
 *   <li><b>shape 매핑</b> — {@code {ok:true, …}} 봉투 조립과 사유→상태 매핑({@link ReasonStatus}).</li>
 * </ol>
 *
 * <h2>동결된 응답 shape</h2>
 * <ul>
 *   <li>목록 200 {@code {ok:true, items:[…]}} — 원소는 SAFE_FIELDS 7키(spoolDir 실림).</li>
 *   <li>생성 200 {@code {ok:true, id:<정수>}} · 검증 거부 5종 400(서비스가 낸 사유 → 폴백 400).</li>
 *   <li>수정·비활성 200 {@code {ok:true, changes:<int>}} — 없는 id·비수치 id는 <b>404 not-found</b>(500 아님).
 *       deactivate 후 행은 목록에 남는다(active='N').</li>
 *   <li>거부 {@code {ok:false, reason}} — 미인증 401 · 비-Z 403.</li>
 * </ul>
 * <b>{@code DELETE /api/distribution-targets/:id}는 만들지 않는다</b> — 핸들러 미등록으로 404가 나는 것이
 * 계약이다(제거는 deactivate뿐). 응답은 반드시 {@link JsonHttp}로만 쓴다(Content-Type 바이트 패리티).
 */
@RestController
public class DistributionTargetsController {

	private final DistributionTargetService targets;

	private final JsonHttp json;

	public DistributionTargetsController(DistributionTargetService targets, JsonHttp json) {
		this.targets = targets;
		this.json = json;
	}

	/** 목록 — Z 전용. 쿼리 파라미터를 서비스 필터로 넘긴다(화이트리스트 밖 키는 서비스가 무시). */
	@GetMapping("/api/distribution-targets")
	public void list(HttpServletRequest request, HttpServletResponse response) {
		DistributionTargetService.Result result = this.targets.query(tokenOf(request), queryFilters(request));
		if (!result.ok()) {
			deny(request, response, result.reason());
			return;
		}
		Map<String, Object> payload = JsonHttp.ok();
		payload.put("items", result.items());
		this.json.write(request, response, 200, payload);
	}

	/** 생성 — Z 전용. 검증(name→kind→spoolDir→active)은 서비스가 하고 거부 사유는 폴백 400으로 나간다. */
	@PostMapping("/api/distribution-targets")
	public void create(HttpServletRequest request, HttpServletResponse response) {
		DistributionTargetService.Result result = this.targets.create(tokenOf(request), this.json.readBody(request));
		if (!result.ok()) {
			deny(request, response, result.reason());
			return;
		}
		Map<String, Object> payload = JsonHttp.ok();
		payload.put("id", result.id());
		this.json.write(request, response, 200, payload);
	}

	/**
	 * 수정 — Z 전용. present-only. 경로 변수 id는 {@link NodeNumber#toNumber} <b>단일 출처</b>로 수로
	 * 만든다(Node 라우트의 {@code Number(req.params.id)} 자리와 같다) — 없는/비수치 id는 NaN이 되어 어떤
	 * 행에도 매치되지 않아 404 not-found로 수렴한다(500 아님).
	 *
	 * <p>{@code Double.parseDouble}로 재구현하면 {@code /5d}·{@code /0x1p3}이 값이 되어 <b>Node가 404를
	 * 주는 URL로 Spring만 남의 행을 고친다</b>(2026-08-24 리뷰 high-1 실측).
	 */
	@PutMapping("/api/distribution-targets/{id}")
	public void update(@PathVariable String id, HttpServletRequest request, HttpServletResponse response) {
		DistributionTargetService.Result result =
				this.targets.update(tokenOf(request), NodeNumber.toNumber(id), this.json.readBody(request));
		if (!result.ok()) {
			deny(request, response, result.reason());
			return;
		}
		respondChanges(request, response, result);
	}

	/**
	 * 비활성(soft delete) — Z 전용. 본문 없음. 행을 지우지 않고 active='N'으로 내린다. id 판독은 수정과
	 * 같은 {@link NodeNumber#toNumber}다(두 진입점이 다른 행을 고르면 감사 기록이 갈린다).
	 */
	@PostMapping("/api/distribution-targets/{id}/deactivate")
	public void deactivate(@PathVariable String id, HttpServletRequest request, HttpServletResponse response) {
		DistributionTargetService.Result result = this.targets.deactivate(tokenOf(request), NodeNumber.toNumber(id));
		if (!result.ok()) {
			deny(request, response, result.reason());
			return;
		}
		respondChanges(request, response, result);
	}

	private void respondChanges(HttpServletRequest request, HttpServletResponse response,
			DistributionTargetService.Result result) {
		Map<String, Object> payload = JsonHttp.ok();
		payload.put("changes", result.changes());
		this.json.write(request, response, 200, payload);
	}

	/**
	 * 쿼리 파라미터 → 필터 맵. Node 라우트가 {@code req.query}를 그대로 넘기는 것과 동형이라
	 * <b>express(qs)가 만드는 값의 모양</b>을 그대로 재현한다: 한 번 온 키는 문자열, <b>반복된 키는 값
	 * 리스트</b>다.
	 *
	 * <p>첫 값으로 접지 마라(2026-08-24 리뷰 med): {@code ?kind=press&kind=nonpress}에서 Node의
	 * {@code pickFilters}는 문자열·숫자가 아닌 값을 <b>버려</b> 필터 없는 전체 목록을 준다. 첫 값만
	 * 취하면 같은 200에 Spring만 좁힌 목록을 싣는다. 리스트는 서비스의 {@code pickFilters}가 저절로
	 * 버리므로 여기서 따로 다루지 않는다.
	 *
	 * <p>{@code getParameterValues}로 읽는다 — {@code getParameter(}는 {@code ?session=} 폴백 부활을 막는
	 * 정적 스캔({@code WebWiringTest})이 금지한 API다.
	 */
	private static Map<String, Object> queryFilters(HttpServletRequest request) {
		Map<String, Object> filters = new LinkedHashMap<>();
		for (String name : Collections.list(request.getParameterNames())) {
			String[] values = request.getParameterValues(name);
			if (values != null && values.length > 0) {
				filters.put(name, (values.length == 1) ? values[0] : List.of(values));
			}
		}
		return filters;
	}

	private static String tokenOf(HttpServletRequest request) {
		return SessionTokens.read(request.getHeader("cookie"), request.getHeader(SessionTokens.HEADER_NAME));
	}

	/** 거부 응답 — 사유 토큰이 상태코드를 정한다({@link ReasonStatus}). 검증 5토큰은 표에 없어 폴백 400. */
	private void deny(HttpServletRequest request, HttpServletResponse response, String reason) {
		this.json.write(request, response, ReasonStatus.of(reason), JsonHttp.fail(reason));
	}
}
