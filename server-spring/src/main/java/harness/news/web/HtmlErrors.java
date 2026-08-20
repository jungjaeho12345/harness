package harness.news.web;

import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import java.io.IOException;
import java.io.UncheckedIOException;
import java.nio.charset.StandardCharsets;

/**
 * 비-JSON 에러 응답 <b>2종</b> — 미정의 경로 404와 로그인 레이트리밋 429.
 *
 * <h2>왜 JSON이 아닌가(계약이다)</h2>
 * "모든 거부는 {@code {ok:false, reason}} JSON"이라는 규칙의 <b>예외는 이 둘뿐이며 그 예외 자체가 계약</b>이다.
 * 둘 다 라우트가 아니라 그 앞단(express 기본 404 핸들러 · express-rate-limit)이 만들기 때문에 생긴 모양이고,
 * 계약 케이스는 {@code res.json === undefined}와 {@code text/html}을 단언한다. Node 실측 헤더는 둘 다
 * {@code text/html; charset=utf-8}이다(2026-08-20 원시 소켓 프로브). 리포트 diff는 상태 정수와 이 문자열을
 * 정확 비교하므로 Boot 기본 {@code /error}(JSON)로 흘려보내면 패리티가 깨진다. 고치고 싶다면 그것은 계약
 * 변경이고 별도 판단이다(Node·명세·케이스를 함께 바꿔야 한다).
 *
 * <h2>본문은 계약이 아니다(그래서 규칙이 다르다)</h2>
 * 계약 리포트는 {@code bodyKeys}만 보고 케이스는 "JSON이 아니다"만 단언한다.
 * <ul>
 *   <li><b>404</b>: express의 HTML을 그대로 베끼지 않았다 — express는 요청 경로를 본문에 반향하지만
 *       (이스케이프해서), 여기서는 <b>사용자 입력을 응답 본문에 되돌려주지 않는다</b>는 원칙을 택했다.</li>
 *   <li><b>429</b>: express-rate-limit의 기본 메시지를 <b>바이트 그대로</b> 쓴다. 사용자 입력이 섞이지 않는
 *       고정 문자열이라 위 원칙과 충돌하지 않고, 그럴 때는 Node와 같은 바이트가 언제나 더 낫다.
 *       (그 본문은 HTML이 아니라 평문이지만 Content-Type은 {@code text/html}이다 — express {@code res.send}가
 *       문자열에 붙이는 기본값이고, <b>그 불일치가 실측이자 계약</b>이다.)</li>
 * </ul>
 *
 * <p>Content-Type 바이트는 {@link RawContentType} 한 곳으로만 나간다 — 서블릿 API로 지정하면 컨테이너가
 * 헤더를 재조립해 Node와 어긋난다.
 */
final class HtmlErrors {

	/** Node 실측 문자열 원문(세미콜론 뒤 공백 포함). */
	static final String CONTENT_TYPE = "text/html; charset=utf-8";

	private static final byte[] NOT_FOUND_BODY = ("""
			<!DOCTYPE html>
			<html lang="en">
			<head>
			<meta charset="utf-8">
			<title>Error</title>
			</head>
			<body>
			<pre>Not Found</pre>
			</body>
			</html>
			""").getBytes(StandardCharsets.UTF_8);

	/**
	 * express-rate-limit 기본 메시지 원문(Node 실측: {@code Content-Length: 42}, 끝에 개행 없음).
	 * 서블릿 API에는 429 상수가 없어 상태코드도 숫자로 적는다.
	 */
	private static final byte[] TOO_MANY_REQUESTS_BODY =
			"Too many requests, please try again later.".getBytes(StandardCharsets.UTF_8);

	private static final int TOO_MANY_REQUESTS_STATUS = 429;

	private HtmlErrors() {
	}

	/** 미정의 경로 응답: 404 + HTML. */
	static void notFound(HttpServletRequest request, HttpServletResponse response) {
		write(request, response, HttpServletResponse.SC_NOT_FOUND, NOT_FOUND_BODY);
	}

	/**
	 * 로그인 IP 한도 초과 응답: 429 + 비-JSON 본문.
	 *
	 * <p>{@code RateLimit-*} 헤더는 정책 선언이라 <b>여기서 붙이지 않는다</b> — 한도를 아는 쪽
	 * ({@link LoginRateLimitFilter})이 붙이고, 이 클래스는 비-JSON 와이어 포맷만 소유한다.
	 */
	static void tooManyRequests(HttpServletRequest request, HttpServletResponse response) {
		write(request, response, TOO_MANY_REQUESTS_STATUS, TOO_MANY_REQUESTS_BODY);
	}

	private static void write(HttpServletRequest request, HttpServletResponse response, int status, byte[] body) {
		response.setStatus(status);
		RawContentType.set(request.getAttribute(RawContentType.REQUEST_ATTRIBUTE), CONTENT_TYPE);
		response.setContentLength(body.length);
		try {
			response.getOutputStream().write(body);
		}
		catch (IOException ex) {
			throw new UncheckedIOException(ex);
		}
	}
}
