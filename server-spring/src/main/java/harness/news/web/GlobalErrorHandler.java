package harness.news.web;

import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import java.util.Map;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.web.ErrorResponse;
import org.springframework.web.HttpRequestMethodNotSupportedException;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.RestControllerAdvice;
import org.springframework.web.servlet.NoHandlerFoundException;
import org.springframework.web.servlet.resource.NoResourceFoundException;

/**
 * 전역 예외 → {@code 500 {ok:false, reason:'internal-error'}} 고정 shape.
 *
 * <h2>응답에 담지 않는 것</h2>
 * 예외 메시지·스택·클래스 이름은 <b>한 조각도</b> 응답에 실리지 않는다(ADR 보안 경계). 원인은 서버 로그에만
 * 남기고, 로그에도 메서드와 <b>경로만</b> 적는다 — 쿼리스트링·헤더·쿠키·본문은 세션 토큰과 비밀번호가
 * 들어 있을 수 있는 자리다(LOGS.md 마스킹 규율).
 *
 * <h2>프레임워크가 정한 상태코드는 삼키지 않는다(단 메서드 불일치는 Node 동형으로 404다)</h2>
 * 모든 {@code Exception}을 잡아 500으로 바꾸면 미정의 경로 404·미지원 미디어타입 415가 전부 500이 된다
 * (흡수 검토한 클라우드 구현의 실제 결함 — index.json decisions (18)(a)). Spring MVC가 상태코드를 이미 정한
 * 예외({@link ErrorResponse} 구현체)는 대부분 <b>다시 던져</b> 기본 처리로 흘려보낸다:
 * {@code ExceptionHandlerExceptionResolver}는 핸들러가 같은 예외를 다시 던지면 "해결하지 못함"으로 보고
 * 다음 리졸버에 넘긴다.
 *
 * <p><b>예외 하나는 다르다 — 메서드 불일치({@link HttpRequestMethodNotSupportedException}, Spring 405)는
 * 404로 접는다.</b> 이유는 정본(express)의 라우팅이 (메서드, 경로) 쌍이라 <b>매핑된 경로라도 그 메서드에
 * 핸들러가 없으면 405가 아니라 404 fall-through</b>이기 때문이다(Express는 405를 자동 생성하지 않는다).
 * 그래서 {@code DELETE /api/distribution-targets/:id}(PUT·deactivate만 매핑됨)는 Node에서 404 HTML이고
 * ({@code distribution-targets.contract.js}의 {@code x-distribution-targets-delete} 케이스가 동결한다),
 * Spring이 405를 내면 그 계약이 red가 된다. 미정의 경로 404와 <b>같은 표면</b>({@link HtmlErrors#notFound})으로
 * 수렴시켜 두 서버가 method-mismatch에 같은 관측을 낸다. 415는 계약이 관측하지 않으므로 그대로 둔다
 * (현재 어떤 계약·와이어 테스트도 405/415를 요구하지 않는다 — 넓히는 대상을 405로 한정한다).
 *
 * <h2>응답을 갈아엎되 엣지 필터의 판정은 지우지 않는다</h2>
 * 이 핸들러는 {@code response.reset()}으로 응답을 통째로 비우고 다시 쓴다(반쯤 쓰인 본문에 JSON을 덧붙이면
 * 그 자체가 깨진 응답이다). 그런데 reset은 {@link CorsFilter}가 <b>체인 진입 시</b> 심어 둔
 * {@code Vary}·{@code Access-Control-Allow-Credentials}·{@code Access-Control-Allow-Origin}까지 지운다 —
 * 그러면 cross-origin SPA는 이 500의 본문을 <b>읽지 못하고</b> CORS 오류로 본다
 * ({@code web/src/model/httpModel.js}는 상태코드가 아니라 본문의 {@code ok}/{@code reason}을 읽는다).
 * 그래서 지우기 전에 값을 뜨고({@link CorsFilter#capture}) 다시 심는다({@link CorsFilter#restore}).
 * 계약 리포트가 500 관측에 CORS 헤더를 싣지 않아 <b>어느 게이트에도 보이지 않던 차이</b>이므로
 * {@code CorsWireTest}·{@code ErrorShapeWireTest}가 와이어로 잠근다.
 *
 * <h2>이것이 결함 후보 #1의 재현 경로다</h2>
 * 중복 {@code userId}로 인한 제약 위반이 4xx가 아니라 500 {@code internal-error}가 되는 현행 계약은
 * 이 핸들러가 만든다(decisions (12) — 이 phase는 재현만 하고 고치지 않는다).
 */
@RestControllerAdvice
public class GlobalErrorHandler {

	private static final Logger logger = LoggerFactory.getLogger(GlobalErrorHandler.class);

	private final JsonHttp json;

	public GlobalErrorHandler(JsonHttp json) {
		this.json = json;
	}

	/**
	 * 미정의 경로·<b>메서드 불일치</b> → <b>404 + 비-JSON</b>(계약). Boot 기본 {@code /error} 처리에 맡기면
	 * JSON 본문이 나가 동결된 에러 shape이 깨진다 — 그래서 이 예외들만 골라 {@link HtmlErrors}로 직접 응답한다.
	 *
	 * <p>{@link HttpRequestMethodNotSupportedException}(405)을 포함하는 근거는 클래스 주석 참조:
	 * express는 method-mismatch를 404로 fall-through하므로 이 셋은 Node에서 모두 같은 404 HTML이다.
	 * 415 등 나머지 프레임워크 예외는 여전히 아래 {@link #handle}이 <b>다시 던져</b> 기본 처리로 보낸다 —
	 * 여기서 잡는 대상을 405 밖으로 넓히면 계약이 관측하지 않는 상태코드들이 조용히 404로 뭉개진다.
	 */
	@ExceptionHandler({ NoResourceFoundException.class, NoHandlerFoundException.class,
			HttpRequestMethodNotSupportedException.class })
	public void handleNotFound(HttpServletRequest request, HttpServletResponse response) {
		HtmlErrors.notFound(request, response);
	}

	@ExceptionHandler(Throwable.class)
	public void handle(Throwable error, HttpServletRequest request, HttpServletResponse response) throws Throwable {
		if (error instanceof ErrorResponse) {
			throw error;
		}
		logger.error("{} {} {}", request.getMethod(), request.getRequestURI(), error.toString());
		if (response.isCommitted()) {
			// 헤더가 이미 나간 뒤라 응답을 다시 쓸 수 없다 — 컨테이너가 연결을 끊게 둔다.
			throw error;
		}
		// reset()은 상태·헤더·버퍼를 통째로 지운다 — 엣지 필터가 체인 진입 시 심은 CORS 헤더까지 지운다.
		// 그대로 두면 cross-origin SPA는 이 500의 본문을 **읽지 못하고** CORS 오류로 본다
		// (web/src/model/httpModel.js는 상태코드가 아니라 본문의 ok/reason을 읽는다 → 사유가 사라진다).
		// 그래서 지우기 전에 값을 떠 두고 다시 심는다. 정책을 다시 계산하지 않는 이유는 CorsFilter.capture 참조.
		// 2026-08-20 실측: 되살리기 전에는 이 응답의 CORS 헤더가 0건이었다(Node는 유지한다).
		Map<String, String> cors = CorsFilter.capture(response);
		response.reset();
		CorsFilter.restore(response, cors);
		this.json.write(request, response, 500, JsonHttp.fail("internal-error"));
	}
}
