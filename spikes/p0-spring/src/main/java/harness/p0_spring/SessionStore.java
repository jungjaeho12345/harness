package harness.p0_spring;

import java.security.SecureRandom;
import java.util.HexFormat;
import java.util.concurrent.ConcurrentHashMap;
import org.springframework.stereotype.Component;

/**
 * 인메모리 세션 저장소 — ConcurrentHashMap + SecureRandom 64-hex (CONTRACT.md 쿠키 절).
 * 스파이크 범위: 만료/슬라이딩 없음(쿠키 Max-Age=3600 만 계약).
 */
@Component
public class SessionStore {

    private final ConcurrentHashMap<String, NewsDb.User> sessions = new ConcurrentHashMap<>();
    private final SecureRandom random = new SecureRandom();

    public String issue(NewsDb.User user) {
        byte[] bytes = new byte[32];
        random.nextBytes(bytes);
        String sessionId = HexFormat.of().formatHex(bytes); // 64자 소문자 hex.
        sessions.put(sessionId, user);
        return sessionId;
    }

    public NewsDb.User resolve(String sessionId) {
        return sessionId == null ? null : sessions.get(sessionId);
    }

    public void remove(String sessionId) {
        if (sessionId != null) {
            sessions.remove(sessionId);
        }
    }
}
