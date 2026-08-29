package harness.news.web;

import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
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

	/** 상한 없음 — 라우트가 값을 명시하지 않았을 때의 의미론이다. */
	private static final long NO_LIMIT = -1L;

	/** 상한 판독의 읽기 단위. 상한을 넘긴 조각은 버퍼에 넣지 않는다(초과분은 힙에 남지 않는다). */
	private static final int READ_CHUNK_BYTES = 8192;

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
	 *
	 * <p><b>상한이 없다</b> — Node의 전역 파서({@code express.json()}, 기본 ~100kb)에 해당하는 상한을 여기에
	 * 두지 않는다. 그것을 전역으로 켜면 30여 라우트 전부의 거부 경계가 한 번에 움직이고, 그 경계는 어떤 계약도
	 * 관측하지 않아 조용히 갈린다. 상한이 필요한 라우트는 {@link #readBody(HttpServletRequest, long)}로
	 * <b>자기 값</b>을 명시한다(정본도 라우트별 파서로 그렇게 한다).
	 */
	public Map<String, Object> readBody(HttpServletRequest request) {
		return readBody(request, NO_LIMIT);
	}

	/**
	 * 상한이 있는 본문 판독 — Node의 <b>라우트 전용 파서</b>({@code express.json({limit:'10mb'})}) 동형이다.
	 *
	 * <p>상한을 넘기면 <b>스트림을 끝까지 읽지 않고</b> 그 자리에서 예외다. 끝까지 읽고 나서 판정하면 상한이
	 * 있으나 마나다 — 세션 하나로 수백 MB JSON을 밀어 넣으면 raw 바이트 + 문자열 + 디코드 결과가 겹쳐 힙을
	 * 태울 수 있다. 예외는 전역 핸들러가 <b>500 {@code internal-error}</b>로 만들며, 그것이 정본과 같은
	 * 상태코드·본문이다(2026-08-28 실측: 정본의 {@code raw-body}가 던지는 413 오류를 {@code server/index.js}
	 * 1244행 전역 에러 핸들러가 {@code err.status}를 보지 않고 500으로 접는다).
	 *
	 * <p>경계값 자신은 <b>통과</b>다({@code length > limit}일 때만 거부 — {@code raw-body}와 같은 부등호).
	 *
	 * @param maxBytes 허용 최대 바이트. 음수면 상한 없음
	 */
	@SuppressWarnings("unchecked")
	public Map<String, Object> readBody(HttpServletRequest request, long maxBytes) {
		String contentType = request.getContentType();
		if (contentType == null || !contentType.toLowerCase(Locale.ROOT).startsWith(JSON_PREFIX)) {
			// 본문을 읽지 않는다 — 상한 판정도 하지 않는다(정본도 content-type이 맞을 때만 파서를 태운다).
			return Map.of();
		}
		byte[] raw;
		try {
			raw = readAtMost(request.getInputStream(), maxBytes);
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

	/**
	 * 상한까지만 읽는다 — 넘기는 순간 <b>남은 바이트를 읽지 않고</b> 던진다.
	 *
	 * <p>초과를 만든 조각은 버퍼에 쓰지 않는다. 그래서 이 메서드가 잡는 최대치는 {@code maxBytes} 언저리이고,
	 * 클라이언트가 선언한 {@code Content-Length}가 얼마든 그 이상은 힙에 들어오지 않는다.
	 */
	private static byte[] readAtMost(InputStream in, long maxBytes) throws IOException {
		if (maxBytes < 0) {
			return in.readAllBytes();
		}
		ByteArrayOutputStream buffer = new ByteArrayOutputStream();
		byte[] chunk = new byte[READ_CHUNK_BYTES];
		long total = 0;
		int read;
		while ((read = in.read(chunk)) != -1) {
			total += read;
			if (total > maxBytes) {
				throw new IllegalStateException("요청 본문이 상한(" + maxBytes + " 바이트)을 넘었다");
			}
			buffer.write(chunk, 0, read);
		}
		return buffer.toByteArray();
	}

	/** 본문 맵에서 문자열 필드만 꺼낸다(숫자·객체가 오면 없는 것으로 본다). */
	public static String text(Map<String, Object> body, String key) {
		Object value = body.get(key);
		return (value instanceof String s) ? s : null;
	}
}
