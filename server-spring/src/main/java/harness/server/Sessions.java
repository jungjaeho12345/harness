package harness.server;

import jakarta.servlet.http.Cookie;
import jakarta.servlet.http.HttpServletRequest;

/**
 * 세션 토큰 운반 수단 추출 — 쿠키 {@code sid} 우선, 없으면 {@code x-session-id} 헤더 폴백.
 *
 * <p><b>쿼리스트링 {@code ?session=} 은 읽지 않는다</b>(평문 토큰 URL/로그 누출 표면 금지 — ADR-005/007 규율).
 * 빈 쿠키 값(로그아웃이 Max-Age=0 으로 비운 뒤)은 무시하고 헤더로 폴백한다.
 */
public final class Sessions {

    public static final String COOKIE_NAME = "sid";
    public static final String HEADER_NAME = "x-session-id";

    private Sessions() {
    }

    public static String sessionId(HttpServletRequest req) {
        if (req == null) {
            return null;
        }
        Cookie[] cookies = req.getCookies();
        if (cookies != null) {
            for (Cookie c : cookies) {
                if (COOKIE_NAME.equals(c.getName())) {
                    String v = c.getValue();
                    if (v != null && !v.isEmpty()) {
                        return v;
                    }
                }
            }
        }
        String h = req.getHeader(HEADER_NAME);
        if (h != null && !h.isEmpty()) {
            return h;
        }
        return null; // 쿼리스트링 폴백 없음.
    }
}
