package harness.news.web;

import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import java.io.IOException;
import java.io.UncheckedIOException;
import java.nio.charset.StandardCharsets;

/**
 * 비-JSON 에러 응답 — 지금은 <b>미정의 경로 404</b> 하나뿐이다.
 *
 * <h2>왜 JSON이 아닌가(계약이다)</h2>
 * "모든 거부는 {@code {ok:false, reason}} JSON"이라는 규칙의 예외 2건 중 하나이며 <b>그 예외 자체가 계약</b>이다
 * (다른 하나는 로그인 레이트리밋 429). Node 실측은 express 기본 404 핸들러의 HTML이고 헤더는
 * {@code text/html; charset=utf-8}이다(2026-08-20). 리포트 diff는 상태 정수와 이 문자열을 정확 비교하므로
 * Boot 기본 {@code /error}(JSON)로 흘려보내면 패리티가 깨진다. 고치고 싶다면 그것은 계약 변경이고
 * 별도 판단이다(Node·명세·케이스를 함께 바꿔야 한다).
 *
 * <h2>본문은 계약이 아니다</h2>
 * 계약 리포트는 {@code bodyKeys}만 보고 케이스는 "JSON이 아니다"만 단언한다. 그래서 express의 HTML을
 * 그대로 베끼지 않았다 — express는 요청 경로를 본문에 반향하지만(이스케이프해서), 여기서는 <b>사용자 입력을
 * 응답 본문에 되돌려주지 않는다</b>는 원칙을 택했다.
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

	private HtmlErrors() {
	}

	/** 미정의 경로 응답: 404 + HTML. */
	static void notFound(HttpServletRequest request, HttpServletResponse response) {
		response.setStatus(HttpServletResponse.SC_NOT_FOUND);
		RawContentType.set(request.getAttribute(RawContentType.REQUEST_ATTRIBUTE), CONTENT_TYPE);
		response.setContentLength(NOT_FOUND_BODY.length);
		try {
			response.getOutputStream().write(NOT_FOUND_BODY);
		}
		catch (IOException ex) {
			throw new UncheckedIOException(ex);
		}
	}
}
