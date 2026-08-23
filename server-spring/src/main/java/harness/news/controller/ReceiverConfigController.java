package harness.news.controller;

import harness.news.service.ReceiverConfigService;
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
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * 수집 수신 설정 3라우트 — 목록 {@code GET /api/receiver-config} · 생성 {@code POST /api/receiver-config} ·
 * 삭제 {@code DELETE /api/receiver-config/:id}. 리포 루트 {@code server/index.js}의 3라우트와 1:1이다.
 *
 * <h2>계층 배치(ADR-006)</h2>
 * 컨트롤러는 (a) 세션에서 토큰 읽기(쿠키 우선 · {@code x-session-id} 폴백) (b) 쿼리/경로/본문 → shape
 * 매핑만 한다. <b>게이트(Z 전용)·검증·투영·삭제 위임은 {@link ReceiverConfigService}가 소유</b>한다 —
 * 그래서 여기엔 role 판정이 없다(서비스가 세션 토큰으로 판정하고, 미인증 {@code unauthenticated}·비-Z
 * {@code forbidden}을 결과 맵의 {@code reason}으로 돌려준다). 응답은 {@link JsonHttp} 한 지점으로만 쓰고
 * ({@code RawContentType}), 거부는 {@link ReasonStatus#of(String)} 상태코드 + {@code {ok:false,reason}}이다.
 *
 * <h2>쿼리는 원문 그대로 넘긴다(콤마 분해 금지)</h2>
 * {@code @RequestParam List<String>}은 Spring MVC가 콤마를 기본 분해하므로 <b>쓰지 않는다</b>
 * ({@code ?sourceId=a,b}가 계약과 갈린다 · index.json decisions (8)). Node {@code req.query} 동형으로
 * 파라미터를 <b>단일 문자열</b>로 읽어 서비스에 그대로 넘긴다 — 화이트리스트 필터링은 모델이 하고
 * (화이트리스트 밖 키는 조용히 무시), {@code id}를 포함한 요구 스키마 컬럼이 필터 대상이다.
 *
 * <h2>순서: 게이트 → 본문</h2>
 * 서비스가 게이트를 먼저 통과시킨 뒤에만 모델을 호출한다. 생성 본문은 통과 후에만 읽는다(거부될 요청의
 * 페이로드를 파싱하지 않는다 · {@code UsersController} 동형).
 */
@RestController
public class ReceiverConfigController {

	private final ReceiverConfigService configs;

	private final SessionGuard sessions;

	private final JsonHttp json;

	public ReceiverConfigController(ReceiverConfigService configs, SessionGuard sessions, JsonHttp json) {
		this.configs = configs;
		this.sessions = sessions;
		this.json = json;
	}

	/** 목록 — Z면 SAFE_FIELDS 10키 투영 {@code items}. 필터는 원문 단일 문자열로 서비스에 넘긴다. */
	@GetMapping("/api/receiver-config")
	public void list(HttpServletRequest request, HttpServletResponse response) {
		write(request, response, this.configs.query(tokenOf(request), queryFilters(request)));
	}

	/** 생성 — Z면 {@code {ok:true, id}}. 본문은 게이트 판정을 서비스가 끝낸 뒤 읽는 것이 아니라, 서비스가
	 * 게이트를 먼저 보고 통과할 때만 저장한다(입력 검증 없음 · 시크릿 미반향). */
	@PostMapping("/api/receiver-config")
	public void create(HttpServletRequest request, HttpServletResponse response) {
		write(request, response, this.configs.create(tokenOf(request), this.json.readBody(request)));
	}

	/**
	 * 삭제 — Z면 {@code {ok:true, changes}}. 경로 변수는 Node {@code Number(req.params.id)} 동형으로 숫자화한다
	 * ({@code 'abc'} → NaN → 매치 0 → {@code changes:0}). 이 서버 유일의 행 삭제 라우트다.
	 */
	@DeleteMapping("/api/receiver-config/{id}")
	public void remove(@PathVariable String id, HttpServletRequest request, HttpServletResponse response) {
		write(request, response, this.configs.remove(tokenOf(request), NodeNumber.numberOf(id)));
	}

	/**
	 * 결과 맵을 와이어에 쓴다 — {@code ok:true}면 200, 아니면 {@code reason} 토큰의 상태코드다. 봉투는
	 * 서비스가 이미 조립했으므로({@code {ok,items}} / {@code {ok,id}} / {@code {ok,changes}} /
	 * {@code {ok:false,reason}}) 그대로 쓴다 — 라우트마다 다시 조립하면 새 라우트에서 shape이 어긋난다.
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
	 * Node {@code req.query} 동형 — 파라미터를 <b>단일 문자열</b> 값으로 읽는다(콤마 분해 없음). 반복 키는
	 * 첫 값만 취한다(계약은 반복 키를 관측하지 않는다). 화이트리스트는 모델이 강제하므로 여기서 좁히지 않는다
	 * ({@code password}·{@code apiKey}까지 넘어가는 것은 Node 동형 · 결함 후보 #3 재현 · index.json excluded (d)).
	 *
	 * <p>값은 {@code getParameterValues}(원문 배열)로만 읽는다 — {@code getParameterMap}/{@code getQueryString}은
	 * {@code ?session=} 폴백 부활 스캔({@code WebWiringTest})이 금지한다. {@code @RequestParam List}는 콤마를
	 * 분해하므로 쓰지 않는다.
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

	/** 세션 토큰 원문 — 쿠키 우선 · {@code x-session-id} 폴백. 읽는 자리가 하나여야 우회 표면이 안 생긴다. */
	private static String tokenOf(HttpServletRequest request) {
		return SessionTokens.read(request.getHeader("cookie"), request.getHeader(SessionTokens.HEADER_NAME));
	}
}
