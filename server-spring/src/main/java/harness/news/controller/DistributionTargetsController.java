package harness.news.controller;

import harness.news.service.DistributionTargetService;
import harness.news.service.SessionGuard;
import harness.news.web.JsonHttp;
import harness.news.web.NodeNumber;
import harness.news.web.ReasonStatus;
import harness.news.web.SessionTokens;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import java.util.Enumeration;
import java.util.LinkedHashMap;
import java.util.Map;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * 배부 수신처 CRUD 4라우트 — 목록 {@code GET /api/distribution-targets} · 생성
 * {@code POST /api/distribution-targets} · 수정 {@code PUT /api/distribution-targets/:id} · 비활성
 * {@code POST /api/distribution-targets/:id/deactivate}. 리포 루트 {@code server/index.js}의 4라우트와 1:1이다.
 *
 * <h2>행 삭제 라우트가 없다(ADR-008 · index.json decisions (1))</h2>
 * <b>{@code DELETE /api/distribution-targets/:id} 매핑을 만들지 않는다</b> — 라우트 미등록(프레임워크 404)이
 * 계약이다({@code distribution-targets.contract.js}의 {@code x-distribution-targets-delete} 케이스가 부재를
 * 실증한다). 대상 제거는 {@code active='N'} soft delete뿐이고 행을 지우지 않는다.
 *
 * <h2>계층 배치·게이트·와이어 포맷은 {@link ReceiverConfigController}와 동형(ADR-006)</h2>
 * 컨트롤러는 토큰 판독(쿠키 우선 · {@code x-session-id} 폴백)과 쿼리/경로/본문 → shape 매핑만 한다. 게이트(Z
 * 전용)·검증(순서 name→kind→spoolDir→active)·투영·stamp·soft delete는 {@link DistributionTargetService}가
 * 소유한다. 검증 거부 5종은 {@link ReasonStatus#of(String)} 폴백 400, {@code not-found}는 404다(서비스가
 * 결과 맵의 {@code reason}으로 돌려준다). 경로 id는 Node {@code Number(req.params.id)} 동형으로 숫자화하며
 * ({@link NodeNumber#numberOf(String)}) 비수치·없는 id는 서비스에서 {@code not-found} 404로 수렴한다(500 아님).
 *
 * <h2>쿼리는 원문 단일 문자열 passthrough(콤마 분해 금지)</h2>
 * {@code @RequestParam List<String>}은 콤마를 분해하므로 쓰지 않고({@code getParameterMap}/
 * {@code getQueryString}도 {@code ?session=} 폴백 스캔이 금지), 파라미터를 {@code getParameterValues}로 읽어
 * 단일 문자열로 서비스에 넘긴다 — 스칼라 필터 화이트리스트(id·name·kind·spoolDir·active)는 서비스가 강제한다.
 */
@RestController
public class DistributionTargetsController {

	private final DistributionTargetService targets;

	private final SessionGuard sessions;

	private final JsonHttp json;

	public DistributionTargetsController(DistributionTargetService targets, SessionGuard sessions, JsonHttp json) {
		this.targets = targets;
		this.sessions = sessions;
		this.json = json;
	}

	/** 목록 — Z면 SAFE_FIELDS 7키({@code spoolDir} 포함) 투영 {@code items}. */
	@GetMapping("/api/distribution-targets")
	public void list(HttpServletRequest request, HttpServletResponse response) {
		write(request, response, this.targets.query(tokenOf(request), queryFilters(request)));
	}

	/** 생성 — Z면 {@code {ok:true, id}}(두 타임스탬프 stamp) / 검증 거부 → 폴백 400. */
	@PostMapping("/api/distribution-targets")
	public void create(HttpServletRequest request, HttpServletResponse response) {
		write(request, response, this.targets.create(tokenOf(request), this.json.readBody(request)));
	}

	/** 수정 — present-only. 성공 {@code {ok:true, changes}} / 없는 id 404 / 검증 400. */
	@PutMapping("/api/distribution-targets/{id}")
	public void update(@PathVariable String id, HttpServletRequest request, HttpServletResponse response) {
		write(request, response,
				this.targets.update(tokenOf(request), NodeNumber.numberOf(id), this.json.readBody(request)));
	}

	/** 비활성(soft delete) — 성공 {@code {ok:true, changes}} / 없는 id 404. 행을 지우지 않는다. */
	@PostMapping("/api/distribution-targets/{id}/deactivate")
	public void deactivate(@PathVariable String id, HttpServletRequest request, HttpServletResponse response) {
		write(request, response, this.targets.deactivate(tokenOf(request), NodeNumber.numberOf(id)));
	}

	/**
	 * 결과 맵을 와이어에 쓴다 — {@code ok:true}면 200, 아니면 {@code reason} 토큰의 상태코드다(검증 5종은
	 * 폴백 400 · {@code not-found} 404 · 인가 거부 401/403). 봉투는 서비스가 조립했으므로 그대로 쓴다.
	 */
	private void write(HttpServletRequest request, HttpServletResponse response, Map<String, Object> result) {
		if (Boolean.TRUE.equals(result.get("ok"))) {
			this.json.write(request, response, 200, result);
			return;
		}
		String reason = (String) result.get("reason");
		this.json.write(request, response, ReasonStatus.of(reason), result);
	}

	/**
	 * Node {@code req.query} 동형 — 파라미터를 단일 문자열 값으로 읽는다(콤마 분해 없음, 반복 키는 첫 값).
	 * 값은 {@code getParameterValues}(원문 배열)로만 읽는다({@code getParameterMap}/{@code getQueryString}은
	 * {@code WebWiringTest}가 금지). 스칼라 필터 화이트리스트는 서비스({@code pickFilters})가 강제한다.
	 */
	private static Map<String, Object> queryFilters(HttpServletRequest request) {
		Map<String, Object> filters = new LinkedHashMap<>();
		Enumeration<String> names = request.getParameterNames();
		while (names.hasMoreElements()) {
			String key = names.nextElement();
			String[] values = request.getParameterValues(key);
			if (values != null && values.length > 0) {
				filters.put(key, values[0]);
			}
		}
		return filters;
	}

	/** 세션 토큰 원문 — 쿠키 우선 · {@code x-session-id} 폴백. */
	private static String tokenOf(HttpServletRequest request) {
		return SessionTokens.read(request.getHeader("cookie"), request.getHeader(SessionTokens.HEADER_NAME));
	}
}
