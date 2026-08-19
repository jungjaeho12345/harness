package harness.server;

import java.security.SecureRandom;
import java.util.HexFormat;
import java.util.concurrent.ConcurrentHashMap;
import java.util.function.LongSupplier;

/**
 * 세션 저장소 — 신뢰 경계=서버(ADR-004)의 핵심. <b>세션에는 로그인 시점 User 스냅샷을 저장하지 않고
 * {@code userId} 만 저장</b>하며, 조회마다 {@link UserRepository#findUser} 로 <b>최신 행을 재도출</b>한다.
 *
 * <p>이 재도출이 이 phase 의 핵심 불변식이다(phase 67 게이트가 "재도출을 제거해도 계약이 green"인
 * 공백을 발견 → 정면 차단). 결과:
 * <ul>
 *   <li>role 강등은 재로그인 없이 <b>다음 resolve 부터</b> 반영된다(캐시/TTL 없음).</li>
 *   <li>{@code active='N'} 또는 <b>행 없음</b>은 그 세션을 <b>즉시·영구</b> 제거한다(폴백·grace 없음) —
 *       같은 토큰이 다른 라우트에서 되살아나지 않는다.</li>
 *   <li>단일 세션: 새 발급이 같은 {@code userId} 의 기존 세션을 전부 무효화한다.</li>
 *   <li>1시간 슬라이딩 idle 만료(성공 resolve 마다 연장).</li>
 * </ul>
 *
 * <p>시계는 주입(테스트 결정성). 토큰은 SecureRandom 32바이트 → 64자 소문자 hex.
 */
public class SessionStore {

    /** 슬라이딩 idle 만료 한도(ms). */
    static final long IDLE_MS = 60L * 60L * 1000L;

    private static final class Entry {
        final String userId;
        volatile long lastAccessMs;

        Entry(String userId, long now) {
            this.userId = userId;
            this.lastAccessMs = now;
        }
    }

    private final UserRepository users;
    private final LongSupplier clock;
    private final ConcurrentHashMap<String, Entry> sessions = new ConcurrentHashMap<>();
    private final SecureRandom random = new SecureRandom();

    public SessionStore(UserRepository users, LongSupplier clock) {
        this.users = users;
        this.clock = clock;
    }

    /** 세션 발급 — 단일 세션 정책으로 같은 userId 의 기존 세션을 먼저 전부 제거한다. 64-hex 토큰 반환. */
    public synchronized String issue(String userId) {
        long now = clock.getAsLong();
        sessions.values().removeIf(e -> e.userId.equals(userId)); // 단일 세션: 기존 무효화.
        byte[] bytes = new byte[32];
        random.nextBytes(bytes);
        String sessionId = HexFormat.of().formatHex(bytes);
        sessions.put(sessionId, new Entry(userId, now));
        return sessionId;
    }

    /**
     * 세션 신원 재도출 — 없음/만료/무효면 null. 유효하면 <b>DB 최신 User</b> 반환(스냅샷 아님).
     * 무효화(만료·비활성·행 없음)는 엔트리를 <b>제거</b>한다(영구 — 다른 라우트에서 되살아나지 않는다).
     */
    public UserRow resolve(String sessionId) {
        if (sessionId == null) {
            return null;
        }
        Entry e = sessions.get(sessionId);
        if (e == null) {
            return null;
        }
        long now = clock.getAsLong();
        if (now - e.lastAccessMs > IDLE_MS) { // 슬라이딩 idle 만료.
            sessions.remove(sessionId);
            return null;
        }
        UserRow row = users.findUser(e.userId); // 매 요청 재조회 — 캐시/TTL 없음.
        if (row == null || "N".equals(row.active())) { // 행 없음/비활성 = 즉시·영구 무효화.
            sessions.remove(sessionId);
            return null;
        }
        e.lastAccessMs = now; // 슬라이딩 연장.
        return row;
    }

    /** 멱등 제거(로그아웃). */
    public void remove(String sessionId) {
        if (sessionId != null) {
            sessions.remove(sessionId);
        }
    }
}
