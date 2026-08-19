package harness.server;

import jakarta.servlet.http.HttpServletRequest;
import java.time.Duration;
import java.util.LinkedHashMap;
import java.util.Map;
import org.springframework.http.HttpHeaders;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseCookie;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RestController;

/**
 * 인증 REST 표면 — POST /api/login · POST /api/logout · GET /api/session.
 *
 * <p>acting 신원은 오직 세션에서 도출한다(req.body.role/헤더 role 불신 — ADR-004). 비밀번호는 검증에만
 * 쓰고 응답/로그에 싣지 않는다. 모든 거부는 {@code {ok:false,reason}} JSON(레이트리밋 429 만 text/html 예외).
 */
@RestController
public class AuthController {

    private static final long COOKIE_MAX_AGE_SECONDS = 3600;

    private final UserService userService;
    private final SessionStore sessions;
    private final LoginRateLimiter rateLimiter;
    private final AppConfig config;

    public AuthController(UserService userService, SessionStore sessions,
            LoginRateLimiter rateLimiter, AppConfig config) {
        this.userService = userService;
        this.sessions = sessions;
        this.rateLimiter = rateLimiter;
        this.config = config;
    }

    @PostMapping("/api/login")
    public ResponseEntity<?> login(@RequestBody(required = false) Map<String, Object> body,
            HttpServletRequest req) {
        // IP 레이트리밋 — 창 한도 초과 시 429(text/html, RateLimit-Limit 헤더). 유일한 비-JSON 거부(계약).
        if (!rateLimiter.allow(req.getRemoteAddr())) {
            return ResponseEntity.status(429)
                    .header("RateLimit-Limit", String.valueOf(rateLimiter.limit()))
                    .contentType(MediaType.TEXT_HTML)
                    .body("<!doctype html><html><body>Too many requests, please try again later.</body></html>");
        }

        UserService.LoginResult r = userService.login(str(body, "userId"), str(body, "password"));
        if (!r.ok()) {
            if ("locked".equals(r.reason())) {
                return Responses.reject(423, "locked"); // 라우트 로컬 423(전역 locked 401 을 덮어씀).
            }
            return Responses.reject(r.reason()); // inactive→403 · invalid-credentials→401.
        }

        String sid = sessions.issue(r.row().userId());
        ResponseCookie cookie = sessionCookie(sid, COOKIE_MAX_AGE_SECONDS);
        Map<String, Object> resp = new LinkedHashMap<>();
        resp.put("ok", true);
        resp.put("sessionId", sid);
        resp.put("user", Projections.safe(r.row())); // SAFE_FIELDS 6키(active 포함). password 없음.
        return ResponseEntity.ok().header(HttpHeaders.SET_COOKIE, cookie.toString()).body(resp);
    }

    @PostMapping("/api/logout")
    public ResponseEntity<Map<String, Object>> logout(HttpServletRequest req) {
        sessions.remove(Sessions.sessionId(req)); // 세션 없어도 성공(멱등).
        ResponseCookie expired = sessionCookie("", 0);
        Map<String, Object> ok = Map.of("ok", true);
        return ResponseEntity.ok().header(HttpHeaders.SET_COOKIE, expired.toString()).body(ok);
    }

    @GetMapping("/api/session")
    public ResponseEntity<Map<String, Object>> session(HttpServletRequest req) {
        UserRow u = sessions.resolve(Sessions.sessionId(req)); // 매 요청 재도출(ADR-004).
        if (u == null) {
            return Responses.reject("unauthenticated");
        }
        Map<String, Object> resp = new LinkedHashMap<>();
        resp.put("ok", true);
        resp.put("user", Projections.identity(u)); // IDENTITY 5키(active 없음).
        return ResponseEntity.ok(resp);
    }

    /** 세션 쿠키 — app.prod-cookie=true 면 Secure+SameSite=None, false 면 SameSite=Lax(Secure 없음). */
    private ResponseCookie sessionCookie(String value, long maxAgeSeconds) {
        boolean prod = config.isProdCookie();
        return ResponseCookie.from(Sessions.COOKIE_NAME, value)
                .path("/")
                .maxAge(Duration.ofSeconds(maxAgeSeconds))
                .httpOnly(true)
                .sameSite(prod ? "None" : "Lax")
                .secure(prod)
                .build();
    }

    private static String str(Map<String, Object> body, String key) {
        if (body == null) {
            return null;
        }
        Object v = body.get(key);
        return v == null ? null : String.valueOf(v);
    }
}
