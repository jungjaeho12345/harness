package harness.server;

import java.util.ArrayDeque;
import java.util.Deque;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.function.LongSupplier;

/**
 * {@code /api/login} 전용 IP 레이트리밋 — express-rate-limit(15분/10회, IP 단위) 동형.
 * 프로세스 로컬 인메모리(외부 의존 0). 창 안에서 {@code limit} 회까지 허용하고 <b>그 다음(11번째) 요청부터 거부</b>한다.
 *
 * <p>이 레이트리밋은 로그인에만 건다(다른 라우트 무영향). 카운트는 <b>모든</b> 로그인 요청을 센다
 * (성공/실패/잠금 결과와 무관) — auth-negative 계약의 "10회 처리 후 11회째 429"가 이 수식이다.
 */
public class LoginRateLimiter {

    public static final int DEFAULT_LIMIT = 10;
    public static final long DEFAULT_WINDOW_MS = 15L * 60L * 1000L;

    private final int limit;
    private final long windowMs;
    private final LongSupplier now;
    private final Map<String, Deque<Long>> hits = new ConcurrentHashMap<>();

    public LoginRateLimiter(LongSupplier now) {
        this(now, DEFAULT_LIMIT, DEFAULT_WINDOW_MS);
    }

    public LoginRateLimiter(LongSupplier now, int limit, long windowMs) {
        this.now = now;
        this.limit = limit;
        this.windowMs = windowMs;
    }

    public int limit() {
        return limit;
    }

    /**
     * 이 요청을 허용하면 true(카운트에 기록), 창 한도를 채웠으면 false(거부, 기록하지 않음).
     * 창 밖(오래된) 히트는 제거한다(슬라이딩).
     */
    public synchronized boolean allow(String ip) {
        long t = now.getAsLong();
        Deque<Long> dq = hits.computeIfAbsent(ip == null ? "" : ip, k -> new ArrayDeque<>());
        while (!dq.isEmpty() && t - dq.peekFirst() >= windowMs) {
            dq.pollFirst();
        }
        if (dq.size() >= limit) {
            return false; // 이미 한도만큼 처리됨 → 이번 요청 거부.
        }
        dq.addLast(t);
        return true;
    }
}
