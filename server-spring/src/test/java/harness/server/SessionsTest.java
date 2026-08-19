package harness.server;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;

import jakarta.servlet.http.Cookie;
import org.junit.jupiter.api.Test;
import org.springframework.mock.web.MockHttpServletRequest;

/** Sessions.sessionId 추출 규칙 — 쿠키 sid 우선 · x-session-id 폴백 · 쿼리 미독. */
class SessionsTest {

    @Test
    void cookieSidPreferredOverHeader() {
        MockHttpServletRequest req = new MockHttpServletRequest();
        req.setCookies(new Cookie("sid", "cookie-token"));
        req.addHeader("x-session-id", "header-token");
        assertEquals("cookie-token", Sessions.sessionId(req));
    }

    @Test
    void headerFallbackWhenNoCookie() {
        MockHttpServletRequest req = new MockHttpServletRequest();
        req.addHeader("x-session-id", "header-token");
        assertEquals("header-token", Sessions.sessionId(req));
    }

    @Test
    void emptyCookieFallsThroughToHeader() {
        MockHttpServletRequest req = new MockHttpServletRequest();
        req.setCookies(new Cookie("sid", "")); // 로그아웃이 비운 쿠키
        req.addHeader("x-session-id", "header-token");
        assertEquals("header-token", Sessions.sessionId(req));
    }

    @Test
    void queryStringIsNotRead() {
        MockHttpServletRequest req = new MockHttpServletRequest();
        req.addParameter("session", "query-token"); // ?session= 폴백 없음
        assertNull(Sessions.sessionId(req));
    }

    @Test
    void nullWhenNoCarrier() {
        assertNull(Sessions.sessionId(new MockHttpServletRequest()));
        assertNull(Sessions.sessionId(null));
    }
}
