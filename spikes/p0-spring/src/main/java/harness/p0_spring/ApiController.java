package harness.p0_spring;

import jakarta.servlet.http.HttpServletRequest;
import java.time.Duration;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.springframework.http.HttpHeaders;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseCookie;
import org.springframework.http.ResponseEntity;
import org.springframework.security.crypto.bcrypt.BCryptPasswordEncoder;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RestController;

/**
 * REST 표면 (CONTRACT.md 엔드포인트 표) — session/login/logout/articles/users/health.
 * 모든 응답은 JSON 바디 필수(httpModel 은 상태코드를 해석하지 않고 본문만 읽는다).
 * 구현 금지 준수: CORS·CSRF Origin 가드·CSP·HTTPS 강제·레이트리밋 없음.
 */
@RestController
public class ApiController {

    private final NewsDb db;
    private final SessionStore sessions;
    private final BCryptPasswordEncoder bcrypt = new BCryptPasswordEncoder();

    public ApiController(NewsDb db, SessionStore sessions) {
        this.db = db;
        this.sessions = sessions;
    }

    private static Map<String, Object> unauth() {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("ok", false);
        body.put("reason", "unauthenticated");
        return body;
    }

    private static ResponseEntity<Map<String, Object>> unauthorized() {
        return ResponseEntity.status(401).contentType(MediaType.APPLICATION_JSON).body(unauth());
    }

    /** 세션 user shape — 정확 5키 (CONTRACT.md /api/session). */
    private static Map<String, Object> sessionUser(NewsDb.User u) {
        Map<String, Object> user = new LinkedHashMap<>();
        user.put("userId", u.userId());
        user.put("name", u.name());
        user.put("role", u.role());
        user.put("department", u.department());
        user.put("departmentCode", u.departmentCode());
        return user;
    }

    @GetMapping("/api/session")
    public ResponseEntity<Map<String, Object>> session(HttpServletRequest req) {
        NewsDb.User u = sessions.resolve(Sessions.sessionId(req));
        if (u == null) {
            return unauthorized();
        }
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("ok", true);
        body.put("user", sessionUser(u));
        return ResponseEntity.ok(body);
    }

    @PostMapping("/api/login")
    public ResponseEntity<Map<String, Object>> login(@RequestBody(required = false) Map<String, Object> reqBody) {
        String userId = reqBody == null ? null : String.valueOf(reqBody.getOrDefault("userId", ""));
        String password = reqBody == null ? null : String.valueOf(reqBody.getOrDefault("password", ""));
        NewsDb.User u = (userId == null || userId.isEmpty()) ? null : db.findUser(userId);
        // 비밀번호는 bcrypt 검증에만 사용 — 응답에 절대 싣지 않는다.
        if (u == null || password == null || u.password() == null || !bcrypt.matches(password, u.password())) {
            Map<String, Object> body = new LinkedHashMap<>();
            body.put("ok", false);
            body.put("reason", "invalid-credentials");
            return ResponseEntity.status(401).contentType(MediaType.APPLICATION_JSON).body(body);
        }
        String sessionId = sessions.issue(u);
        ResponseCookie cookie = ResponseCookie.from(Sessions.COOKIE_NAME, sessionId)
                .path("/").maxAge(Duration.ofSeconds(3600)).httpOnly(true).sameSite("Lax").build();
        Map<String, Object> user = sessionUser(u);
        user.put("active", u.active()); // login user shape 는 active 포함 6키 (CONTRACT.md /api/login).
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("ok", true);
        body.put("sessionId", sessionId);
        body.put("user", user);
        return ResponseEntity.ok().header(HttpHeaders.SET_COOKIE, cookie.toString()).body(body);
    }

    @PostMapping("/api/logout")
    public ResponseEntity<Map<String, Object>> logout(HttpServletRequest req) {
        sessions.remove(Sessions.sessionId(req)); // 항상 200 — 세션이 없어도 성공.
        ResponseCookie expired = ResponseCookie.from(Sessions.COOKIE_NAME, "")
                .path("/").maxAge(0).httpOnly(true).sameSite("Lax").build();
        return ResponseEntity.ok().header(HttpHeaders.SET_COOKIE, expired.toString()).body(Map.of("ok", true));
    }

    @GetMapping("/api/articles")
    public ResponseEntity<Map<String, Object>> articles(HttpServletRequest req) {
        if (sessions.resolve(Sessions.sessionId(req)) == null) {
            return unauthorized();
        }
        List<Map<String, Object>> items = db.queryArticles(req.getParameterMap());
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("ok", true);
        body.put("items", items);
        return ResponseEntity.ok(body);
    }

    @GetMapping("/api/users")
    public ResponseEntity<Map<String, Object>> users(HttpServletRequest req) {
        if (sessions.resolve(Sessions.sessionId(req)) == null) {
            return unauthorized();
        }
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("ok", true);
        body.put("items", db.listUsers());
        return ResponseEntity.ok(body);
    }

    @GetMapping("/api/health")
    public Map<String, Object> health() {
        return Map.of("ok", true);
    }
}
