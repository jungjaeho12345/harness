package harness.server;

import jakarta.servlet.http.HttpServletRequest;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RestController;

/**
 * 관리 REST 표면 — GET/POST/PUT /api/users + GET /api/logs/digest(Z 게이트).
 *
 * <p>인가 판정 기준은 <b>재도출된 세션 role</b>뿐이다(ADR-004) — body/header/쿼리의 role 은 신뢰하지 않는다.
 * 그래서 강등(PUT role)이 다음 요청부터 즉시 Z 게이트에 반영된다(session-guard 계약의 실증 경로).
 */
@RestController
public class AdminController {

    private final SessionStore sessions;
    private final UserService userService;
    private final UserRepository users;

    public AdminController(SessionStore sessions, UserService userService, UserRepository users) {
        this.sessions = sessions;
        this.userService = userService;
        this.users = users;
    }

    private UserRow actor(HttpServletRequest req) {
        return sessions.resolve(Sessions.sessionId(req)); // 매 요청 재도출.
    }

    /** GET /api/users — 세션 필수. Z=SAFE_FIELDS 6키 / 비-Z=정확 4키(role·active 미노출). */
    @GetMapping("/api/users")
    public ResponseEntity<Map<String, Object>> listUsers(HttpServletRequest req) {
        UserRow me = actor(req);
        if (me == null) {
            return Responses.reject("unauthenticated");
        }
        boolean isZ = "Z".equals(me.role());
        List<Map<String, Object>> items = new ArrayList<>();
        for (Map<String, Object> r : users.listUsers()) { // 원소는 6키(userId,name,role,department,departmentCode,active)
            if (isZ) {
                items.add(r);
            } else {
                Map<String, Object> pub = new LinkedHashMap<>();
                pub.put("userId", r.get("userId"));
                pub.put("name", r.get("name"));
                pub.put("department", r.get("department"));
                pub.put("departmentCode", r.get("departmentCode"));
                items.add(pub); // role·active 미노출.
            }
        }
        return ok("items", items);
    }

    /** POST /api/users — Z 전용. 성공 200 {ok,user:sanitize}. 중복 userId 는 예외 전파(전역 500). */
    @PostMapping("/api/users")
    public ResponseEntity<Map<String, Object>> createUser(
            @RequestBody(required = false) Map<String, Object> body, HttpServletRequest req) {
        ResponseEntity<Map<String, Object>> denied = requireZ(req);
        if (denied != null) {
            return denied; // 게이트 통과 전 모델 호출 없음(거부 시 행 생성 0).
        }
        Map<String, Object> user = userService.create(body == null ? Map.of() : body);
        return ok("user", user);
    }

    /** PUT /api/users/:id — Z 전용. 성공 200 {ok,changes}. 없는 userId 는 changes:0(404 아님). */
    @PutMapping("/api/users/{userId}")
    public ResponseEntity<Map<String, Object>> updateUser(
            @PathVariable String userId, @RequestBody(required = false) Map<String, Object> body,
            HttpServletRequest req) {
        ResponseEntity<Map<String, Object>> denied = requireZ(req);
        if (denied != null) {
            return denied;
        }
        int changes = userService.update(userId, body == null ? Map.of() : body);
        return ok("changes", changes);
    }

    /**
     * GET /api/logs/digest — Z 전용. 이 phase 는 <b>Z 게이트만</b> 계약에 걸린다(session-guard 재도출 실증).
     * 24시간 링버퍼 다이제스트 본문은 후속 phase 범위 — 여기서는 최소 shape {ok:true, entries:[]} 로 둔다(스텁).
     */
    @GetMapping("/api/logs/digest")
    public ResponseEntity<Map<String, Object>> logsDigest(HttpServletRequest req) {
        ResponseEntity<Map<String, Object>> denied = requireZ(req);
        if (denied != null) {
            return denied;
        }
        return ok("entries", List.of());
    }

    /** Z 게이트 — 미인증 401, 비-Z 403. 통과면 null. 판정은 재도출 role 로만 한다. */
    private ResponseEntity<Map<String, Object>> requireZ(HttpServletRequest req) {
        UserRow me = actor(req);
        if (me == null) {
            return Responses.reject("unauthenticated");
        }
        if (!"Z".equals(me.role())) {
            return Responses.reject("forbidden");
        }
        return null;
    }

    private static ResponseEntity<Map<String, Object>> ok(String key, Object value) {
        Map<String, Object> resp = new LinkedHashMap<>();
        resp.put("ok", true);
        resp.put(key, value);
        return ResponseEntity.ok(resp);
    }
}
