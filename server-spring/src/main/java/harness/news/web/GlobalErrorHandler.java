package harness.news.web;

import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.web.ErrorResponse;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.RestControllerAdvice;

/**
 * 전역 예외 → {@code 500 {ok:false, reason:'internal-error'}} 고정 shape.
 *
 * <h2>응답에 담지 않는 것</h2>
 * 예외 메시지·스택·클래스 이름은 <b>한 조각도</b> 응답에 실리지 않는다(ADR 보안 경계). 원인은 서버 로그에만
 * 남기고, 로그에도 메서드와 <b>경로만</b> 적는다 — 쿼리스트링·헤더·쿠키·본문은 세션 토큰과 비밀번호가
 * 들어 있을 수 있는 자리다(LOGS.md 마스킹 규율).
 *
 * <h2>프레임워크가 정한 상태코드는 삼키지 않는다</h2>
 * 모든 {@code Exception}을 잡아 500으로 바꾸면 미정의 경로 404·메서드 불일치 405·미지원 미디어타입 415가
 * 전부 500이 된다(흡수 검토한 클라우드 구현의 실제 결함 — index.json decisions (18)(a)). Spring MVC가
 * 상태코드를 이미 정한 예외({@link ErrorResponse} 구현체)는 <b>다시 던져</b> 기본 처리로 흘려보낸다:
 * {@code ExceptionHandlerExceptionResolver}는 핸들러가 같은 예외를 다시 던지면 "해결하지 못함"으로 보고
 * 다음 리졸버에 넘긴다.
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
		response.reset();
		this.json.write(request, response, 500, JsonHttp.fail("internal-error"));
	}
}
