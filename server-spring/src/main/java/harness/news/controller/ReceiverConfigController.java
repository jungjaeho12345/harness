package harness.news.controller;

import harness.news.service.ReceiverConfigService;
import harness.news.web.JsonHttp;
import harness.news.web.ReasonStatus;
import harness.news.web.SessionTokens;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.Map;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * 수집 수신 설정 3라우트 — 목록 {@code GET /api/receiver-config} · 생성 {@code POST /api/receiver-config} ·
 * 삭제 {@code DELETE /api/receiver-config/:id}. 리포 루트 {@code server/index.js}의 같은 3라우트와 1:1이다.
 *
 * <h2>컨트롤러가 하는 일은 셋뿐이다(ADR-006 · decisions (14))</h2>
 * <ol>
 *   <li><b>토큰 판독</b> — 쿠키 우선 · {@code x-session-id} 폴백({@link SessionTokens}). 쿼리 폴백은 없다.</li>
 *   <li><b>서비스 호출</b> — 인가 게이트·검증·투영은 {@link ReceiverConfigService}가 소유한다(세션에서
 *       role을 재도출해 판정하므로 컨트롤러는 role을 만지지 않는다).</li>
 *   <li><b>shape 매핑</b> — {@code {ok:true, …}} 봉투 조립과 사유→상태 매핑({@link ReasonStatus}).</li>
 * </ol>
 *
 * <h2>동결된 응답 shape</h2>
 * <ul>
 *   <li>목록 200 {@code {ok:true, items:[…]}} — 원소는 SAFE_FIELDS 10키(password·apiKey 없음).</li>
 *   <li>생성 200 {@code {ok:true, id:<정수>}} — user 객체를 되돌려주지 않는다(시크릿 반향 원천 차단).</li>
 *   <li>삭제 200 {@code {ok:true, changes:<int>}} — <b>없는 id·재삭제·비수치 id 전부 200 changes:0</b>
 *       (존재 판정을 하지 않는다 — 404가 아니다).</li>
 *   <li>거부 {@code {ok:false, reason}} — 미인증 401(경로 정책 필터가 앞에서 끊는다) · 비-Z 403.</li>
 * </ul>
 * 응답은 반드시 {@link JsonHttp}로만 쓴다(Content-Type 바이트 패리티 — MVC 메시지 컨버터 금지).
 */
@RestController
public class ReceiverConfigController {

	private final ReceiverConfigService configs;

	private final JsonHttp json;

	public ReceiverConfigController(ReceiverConfigService configs, JsonHttp json) {
		this.configs = configs;
		this.json = json;
	}

	/** 목록 — Z 전용. 쿼리 파라미터를 그대로 서비스 필터로 넘긴다(화이트리스트 밖 키는 리포지토리가 무시). */
	@GetMapping("/api/receiver-config")
	public void list(HttpServletRequest request, HttpServletResponse response) {
		ReceiverConfigService.Result result = this.configs.query(tokenOf(request), queryFilters(request));
		if (!result.ok()) {
			deny(request, response, result.reason());
			return;
		}
		Map<String, Object> payload = JsonHttp.ok();
		payload.put("items", result.items());
		this.json.write(request, response, 200, payload);
	}

	/** 생성 — Z 전용. 본문은 인가를 통과한 뒤에만(서비스 안에서) 저장된다 — 응답은 {@code {ok,id}}뿐. */
	@PostMapping("/api/receiver-config")
	public void create(HttpServletRequest request, HttpServletResponse response) {
		ReceiverConfigService.Result result = this.configs.create(tokenOf(request), this.json.readBody(request));
		if (!result.ok()) {
			deny(request, response, result.reason());
			return;
		}
		Map<String, Object> payload = JsonHttp.ok();
		payload.put("id", result.id());
		this.json.write(request, response, 200, payload);
	}

	/**
	 * 삭제 — Z 전용. 경로 변수 id를 {@code Number()} 동형으로 double로 만들어 서비스에 넘긴다
	 * (비수치 {@code /abc}는 NaN이 되어 어떤 행에도 매치되지 않는다 → 200 changes:0, 500 아님).
	 */
	@DeleteMapping("/api/receiver-config/{id}")
	public void remove(@PathVariable String id, HttpServletRequest request, HttpServletResponse response) {
		ReceiverConfigService.Result result = this.configs.remove(tokenOf(request), numberOf(id));
		if (!result.ok()) {
			deny(request, response, result.reason());
			return;
		}
		Map<String, Object> payload = JsonHttp.ok();
		payload.put("changes", result.changes());
		this.json.write(request, response, 200, payload);
	}

	/**
	 * 쿼리 파라미터 → 필터 맵(파라미터당 첫 값). Node 라우트가 {@code req.query}를 그대로 넘기는 것과 동형이다.
	 *
	 * <p>{@code getParameterValues}로 읽는다 — {@code getParameter(}는 {@code ?session=} 폴백 부활을 막는
	 * 정적 스캔({@code WebWiringTest})이 금지한 API다(화이트리스트 밖 키·시크릿은 리포지토리가 무시하므로
	 * 첫 값만 넘겨도 계약이 성립한다).
	 */
	private static Map<String, Object> queryFilters(HttpServletRequest request) {
		Map<String, Object> filters = new LinkedHashMap<>();
		for (String name : Collections.list(request.getParameterNames())) {
			String[] values = request.getParameterValues(name);
			if (values != null && values.length > 0) {
				filters.put(name, values[0]);
			}
		}
		return filters;
	}

	/**
	 * JS {@code Number()} 동형 — 삭제 라우트의 id 정규화. 정수·소수 문자열은 그 값, 공백은 0, 그 밖은 NaN이다.
	 * 계약이 관측하는 경로는 정수 id(매치 후 삭제)와 {@code 'abc'}(NaN → 매치 0)뿐이다.
	 */
	private static double numberOf(String raw) {
		if (raw == null) {
			return Double.NaN;
		}
		String trimmed = raw.trim();
		if (trimmed.isEmpty()) {
			return 0.0; // JS Number('')===0
		}
		try {
			return Double.parseDouble(trimmed);
		}
		catch (NumberFormatException ex) {
			return Double.NaN; // JS Number('abc')===NaN
		}
	}

	private static String tokenOf(HttpServletRequest request) {
		return SessionTokens.read(request.getHeader("cookie"), request.getHeader(SessionTokens.HEADER_NAME));
	}

	/** 거부 응답 — 사유 토큰이 상태코드를 정한다({@link ReasonStatus}, 폴백 전역 400). */
	private void deny(HttpServletRequest request, HttpServletResponse response, String reason) {
		this.json.write(request, response, ReasonStatus.of(reason), JsonHttp.fail(reason));
	}
}
