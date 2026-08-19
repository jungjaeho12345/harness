package harness.server;

import java.util.LinkedHashMap;
import java.util.Map;

/**
 * 응답 투영 단일 지점(DTO seam) — {@link UserRow}(password·잠금 필드 포함)를 절대 직접 직렬화하지 않고
 * 여기서만 안전 shape 을 만든다. userService.js SAFE_FIELDS / sessionService IDENTITY 투영과 동형.
 *
 * <p>null 필드는 키 자체를 뺀다(Node sanitize 의 "undefined 필드 제외"와 동형) — 느슨하게 생성된
 * 계정(name/부서 누락)의 응답 키 집합이 Node 와 일치한다.
 */
public final class Projections {

    private Projections() {
    }

    /** 로그인/사용자 관리 응답 shape — SAFE_FIELDS 6키(active 포함). password·잠금 필드는 없다. */
    public static Map<String, Object> safe(UserRow u) {
        Map<String, Object> m = new LinkedHashMap<>();
        put(m, "userId", u.userId());
        put(m, "name", u.name());
        put(m, "role", u.role());
        put(m, "department", u.department());
        put(m, "departmentCode", u.departmentCode());
        put(m, "active", u.active());
        return m;
    }

    /** GET /api/session 신원 shape — IDENTITY 5키(active 없음). */
    public static Map<String, Object> identity(UserRow u) {
        Map<String, Object> m = new LinkedHashMap<>();
        put(m, "userId", u.userId());
        put(m, "name", u.name());
        put(m, "role", u.role());
        put(m, "department", u.department());
        put(m, "departmentCode", u.departmentCode());
        return m;
    }

    private static void put(Map<String, Object> m, String k, Object v) {
        if (v != null) {
            m.put(k, v);
        }
    }
}
