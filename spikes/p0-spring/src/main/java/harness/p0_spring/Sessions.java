package harness.p0_spring;

import jakarta.servlet.http.Cookie;
import jakarta.servlet.http.HttpServletRequest;

/**
 * 세션 판독 — Cookie `sid` 우선, `x-session-id` 헤더 폴백 (CONTRACT.md 쿠키 절).
 * acting role 은 서버가 세션에서만 도출한다 — 요청 바디의 role 은 절대 신뢰하지 않는다.
 */
final class Sessions {

    static final String COOKIE_NAME = "sid";

    private Sessions() {
    }

    static String sessionId(HttpServletRequest req) {
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
