package harness.news.web;

import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import java.io.IOException;
import java.io.UncheckedIOException;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import org.springframework.stereotype.Component;
import tools.jackson.databind.ObjectMapper;

/**
 * JSON 요청·응답의 <b>와이어 포맷 단일 지점</b>.
 *
 * <p>응답은 Spring MVC의 메시지 컨버터를 쓰지 않고 직접 바이트로 쓴다. 컨버터 경로는 응답 헤더를
 * 서블릿 API로 지정하므로 Content-Type이 컨테이너에 의해 재조립되기 때문이다({@link RawContentType} 참조).
 * 그래서 컨트롤러는 값을 {@code return}하지 않고 이 클래스로 <b>쓴다</b>.
 *
 * <p>요청 본문 판독은 Node의 {@code express.json()} 동형이다:
 * <ul>
 *   <li>content-type이 {@code application/json}이 아니면 <b>본문을 읽지 않고</b> 빈 맵이다
 *       (Node에서 {@code req.body}가 {@code {}}가 되는 경로 — 로그인은 자격 실패 401로 수렴한다).</li>
 *   <li>본문이 비어 있으면 빈 맵이다.</li>
 *   <li>JSON이 깨졌거나 최상위가 객체/배열이 아니면 <b>예외</b>다 — Node의 body parser 오류가 전역 에러
 *       핸들러로 흘러 {@code 500 internal-error}가 되는 현행 계약을 그대로 재현한다
 *       (docs/api-contract/reason-tokens.md 표 2 #15).</li>
 * </ul>
 */
@Component
public class JsonHttp {

	/**
	 * Node(express {@code res.json})가 보내는 문자열 원문. 세미콜론 뒤 공백과 소문자 {@code utf-8}까지
	 * 계약이다 — 계약 리포트 diff가 이 문자열을 그대로 비교한다.
	 */
	public static final String CONTENT_TYPE = "application/json; charset=utf-8";

	private static final String JSON_PREFIX = "application/json";

	private final ObjectMapper mapper;

	public JsonHttp(ObjectMapper mapper) {
		this.mapper = mapper;
	}

	/** {@code {ok:true}} — 성공 응답의 최소 shape. */
	public static Map<String, Object> ok() {
		Map<String, Object> body = new LinkedHashMap<>();
		body.put("ok", true);
		return body;
	}

	/** {@code {ok:false, reason:<토큰>}} — 모든 거부 응답의 고정 shape(401에도 반드시 바디가 있다). */
	public static Map<String, Object> fail(String reason) {
		Map<String, Object> body = new LinkedHashMap<>();
		body.put("ok", false);
		body.put("reason", reason);
		return body;
	}

	/**
	 * 상태코드와 본문을 와이어에 쓴다. 키 순서는 넘긴 맵의 순서 그대로다(응답 조립 지점이 shape을 정한다).
	 *
	 * @param request Content-Type 기록 seam({@link CoyoteResponseValve})을 꺼내는 데 쓴다
	 */
	public void write(HttpServletRequest request, HttpServletResponse response, int status, Object body) {
		byte[] payload = this.mapper.writeValueAsBytes(body);
		response.setStatus(status);
		RawContentType.set(request.getAttribute(RawContentType.REQUEST_ATTRIBUTE), CONTENT_TYPE);
		response.setContentLength(payload.length);
		try {
			response.getOutputStream().write(payload);
		}
		catch (IOException ex) {
			throw new UncheckedIOException(ex);
		}
	}

	/**
	 * 요청 본문 → 맵. 위 클래스 주석의 규칙을 따르며 <b>절대 null을 돌려주지 않는다</b>.
	 */
	@SuppressWarnings("unchecked")
	public Map<String, Object> readBody(HttpServletRequest request) {
		String contentType = request.getContentType();
		if (contentType == null || !contentType.toLowerCase(Locale.ROOT).startsWith(JSON_PREFIX)) {
			return Map.of();
		}
		byte[] raw;
		try {
			raw = request.getInputStream().readAllBytes();
		}
		catch (IOException ex) {
			throw new UncheckedIOException(ex);
		}
		if (raw.length == 0) {
			return Map.of();
		}
		Object parsed = this.mapper.readValue(raw, Object.class);
		if (parsed instanceof Map<?, ?> map) {
			return (Map<String, Object>) map;
		}
		if (parsed instanceof List<?>) {
			return Map.of(); // 배열 본문은 유효하지만 필드가 없다(Node: 구조분해가 전부 undefined).
		}
		// express.json의 strict 모드 동형 — 최상위 스칼라는 파싱 오류다(전역 핸들러가 500으로 만든다).
		throw new IllegalArgumentException("JSON 본문의 최상위가 객체/배열이 아니다");
	}

	/** 본문 맵에서 문자열 필드만 꺼낸다(숫자·객체가 오면 없는 것으로 본다). */
	public static String text(Map<String, Object> body, String key) {
		Object value = body.get(key);
		return (value instanceof String s) ? s : null;
	}
}
