package harness.spring_auth;

import jakarta.servlet.http.Cookie;
import jakarta.servlet.http.HttpServletRequest;

/**
 * 세션 토큰 판독 — 쿠키 `sid` 우선, `x-session-id` 헤더 폴백. **?session= 쿼리 폴백은 없다**(URL 누출 표면).
 * acting role은 이 토큰이 가리키는 검증 세션에서만 도출한다 — 요청 body의 role은 절대 신뢰하지 않는다(ADR-004).
 */
final class SessionTokens {

	static final String COOKIE_NAME = "sid";

	private SessionTokens() {
	}

	static String read(HttpServletRequest req) {
		Cookie[] cookies = req.getCookies();
		if (cookies != null) {
			for (Cookie c : cookies) {
				if (COOKIE_NAME.equals(c.getName()) && c.getValue() != null && !c.getValue().isEmpty()) {
					return c.getValue();
				}
			}
		}
		String header = req.getHeader("x-session-id");
		return (header == null || header.isBlank()) ? null : header;
	}
}
