package harness.server;

import java.util.LinkedHashMap;
import java.util.Map;
import org.springframework.http.ResponseEntity;

/**
 * 거부 응답 매핑 단일 지점 — 사유 토큰 → HTTP 상태(reason-tokens.md 표1 부분집합, auth/session 범위).
 * 모든 거부 본문은 {@code {ok:false, reason:'<토큰>'}} 고정(JSON)이며, 레이트리밋 429 만 예외다(컨트롤러 직접).
 *
 * <p>주의: 로그인 라우트의 {@code locked} 는 <b>라우트 로컬 423</b>(전역 매핑을 거치지 않는다) — 컨트롤러가 직접 처리한다.
 */
public final class Responses {

    private static final Map<String, Integer> STATUS_BY_REASON = Map.of(
            "unauthenticated", 401,
            "invalid-credentials", 401,
            "inactive", 403,
            "forbidden", 403,
            "not-found", 404,
            "internal-error", 500);

    /** 매핑에 없는 토큰의 fallback(방어) — 이 범위에서 도달하지 않아야 정상이다. */
    private static final int FALLBACK = 400;

    private Responses() {
    }

    public static Map<String, Object> body(String reason) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("ok", false);
        m.put("reason", reason);
        return m;
    }

    public static int statusFor(String reason) {
        return STATUS_BY_REASON.getOrDefault(reason, FALLBACK);
    }

    // Content-Type 은 명시 지정하지 않는다 — Jackson 협상 + force-response(charset) 로 application/json;
    // charset=utf-8 을 실어 Express 와 미디어타입을 맞춘다(명시 지정하면 charset 이 빠져 불일치).
    public static ResponseEntity<Map<String, Object>> reject(String reason) {
        return ResponseEntity.status(statusFor(reason)).body(body(reason));
    }

    public static ResponseEntity<Map<String, Object>> reject(int status, String reason) {
        return ResponseEntity.status(status).body(body(reason));
    }
}
