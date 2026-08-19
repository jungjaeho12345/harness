package harness.server;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.function.LongSupplier;
import org.junit.jupiter.api.Test;

/** LoginRateLimiter — 창 한도(10)까지 허용, 11번째 거부, IP 격리, 창 경과 후 재허용. */
class LoginRateLimiterTest {

    @Test
    void allowsUpToLimitThenBlocksEleventh() {
        long[] now = { 0L };
        LoginRateLimiter rl = new LoginRateLimiter(() -> now[0], 10, 15L * 60 * 1000);
        for (int i = 1; i <= 10; i++) {
            assertTrue(rl.allow("127.0.0.1"), i + "번째 로그인은 허용");
        }
        assertFalse(rl.allow("127.0.0.1"), "11번째는 429(거부)");
        assertEquals10Limit(rl);
    }

    private void assertEquals10Limit(LoginRateLimiter rl) {
        assertTrue(rl.limit() == 10);
    }

    @Test
    void perIpIsolation() {
        long[] now = { 0L };
        LoginRateLimiter rl = new LoginRateLimiter(() -> now[0], 10, 15L * 60 * 1000);
        for (int i = 0; i < 10; i++) {
            rl.allow("10.0.0.1");
        }
        assertFalse(rl.allow("10.0.0.1"), "소진된 IP 는 거부");
        assertTrue(rl.allow("10.0.0.2"), "다른 IP 는 독립적으로 허용");
    }

    @Test
    void slidingWindowPurgeAllowsAgain() {
        long[] now = { 0L };
        long windowMs = 15L * 60 * 1000;
        LoginRateLimiter rl = new LoginRateLimiter(() -> now[0], 10, windowMs);
        for (int i = 0; i < 10; i++) {
            rl.allow("127.0.0.1");
        }
        assertFalse(rl.allow("127.0.0.1"));
        now[0] += windowMs; // 창 경과 → 오래된 히트 제거
        assertTrue(rl.allow("127.0.0.1"), "창 경과 후 다시 허용");
    }
}
