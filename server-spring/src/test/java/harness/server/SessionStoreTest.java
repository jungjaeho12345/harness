package harness.server;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;

import java.nio.file.Path;
import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.Statement;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.function.LongSupplier;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/**
 * SessionStore 단위 테스트 — 임시 파일 DB(테스트 전용 셋업 DDL) + 주입 시계로 ADR-004 재도출 불변식을
 * 결정적으로 검증한다. 스냅샷 구현(로그인 시점 role/active 캐시)이면 재도출/즉시무효 케이스가 통과하지 못한다.
 */
class SessionStoreTest {

    @TempDir
    Path tempDir;

    private UserRepository repo;
    private SessionStore store;
    private final long[] now = { 1_000_000L };

    private static final String CREATE_USER = "CREATE TABLE User ("
            + "userId TEXT PRIMARY KEY, name TEXT, password TEXT, role TEXT, department TEXT, "
            + "departmentCode TEXT, active TEXT DEFAULT 'Y', failedLoginCount TEXT DEFAULT '0', "
            + "lockedUntil TEXT, lastFailedLoginAt TEXT)";

    @BeforeEach
    void setup() throws Exception {
        String dbPath = tempDir.resolve("news.db").toString();
        try (Connection c = DriverManager.getConnection("jdbc:sqlite:" + dbPath);
                Statement st = c.createStatement()) {
            st.executeUpdate(CREATE_USER);
            st.executeUpdate("INSERT INTO User (userId, name, role, department, departmentCode, active) "
                    + "VALUES ('reporter', '김기자', 'R', '사회부', 'SOC', 'Y')");
        }
        repo = new UserRepository(dbPath);
        LongSupplier clock = () -> now[0];
        store = new SessionStore(repo, clock);
    }

    private static Map<String, Object> patch(Object... kv) {
        Map<String, Object> m = new LinkedHashMap<>();
        for (int i = 0; i < kv.length; i += 2) {
            m.put((String) kv[i], kv[i + 1]);
        }
        return m;
    }

    @Test
    void issueResolveRoundtripAnd64Hex() {
        String sid = store.issue("reporter");
        assertEquals(64, sid.length());
        assertNotNull(sid.matches("[0-9a-f]{64}") ? sid : null, "sid 는 64자 소문자 hex");
        assertEquals("reporter", store.resolve(sid).userId());
        assertNull(store.resolve(null));
        assertNull(store.resolve("not-a-real-token"));
    }

    @Test
    void singleSessionEvictsPreviousToken() {
        String sid1 = store.issue("reporter");
        String sid2 = store.issue("reporter");
        assertNull(store.resolve(sid1), "새 발급이 같은 userId 의 기존 세션을 무효화해야 한다");
        assertNotNull(store.resolve(sid2));
    }

    @Test
    void resolveReDerivesLatestRoleNotLoginSnapshot() {
        String sid = store.issue("reporter");
        assertEquals("R", store.resolve(sid).role());

        repo.updateUser("reporter", patch("role", "Z")); // DB 에서 강등/승격
        assertEquals("Z", store.resolve(sid).role(),
                "resolve 는 로그인 스냅샷이 아니라 DB 최신 role 을 반영해야 한다(재도출)");
    }

    @Test
    void deactivateInvalidatesImmediatelyAndPermanently() {
        String sid = store.issue("reporter");
        assertNotNull(store.resolve(sid));

        repo.updateUser("reporter", patch("active", "N"));
        assertNull(store.resolve(sid), "active='N' 은 즉시 무효화(다음 요청부터)");

        // 영구성: 엔트리가 제거됐으므로 active 를 되돌려도 같은 토큰은 되살아나지 않는다.
        repo.updateUser("reporter", patch("active", "Y"));
        assertNull(store.resolve(sid), "무효화는 영구적이어야 한다(엔트리 제거)");
    }

    @Test
    void missingUserRowInvalidatesSession() {
        String sid = store.issue("ghost"); // DB 에 없는 userId
        assertNull(store.resolve(sid), "행 없음은 세션을 무효화해야 한다");
        assertNull(store.resolve(sid), "무효화 영구성");
    }

    @Test
    void slidingIdleExpiryBoundary() {
        long t0 = now[0];
        String sid = store.issue("reporter");

        now[0] = t0 + SessionStore.IDLE_MS; // 경계(정확히 한도) — 아직 유효
        assertNotNull(store.resolve(sid), "idle 한도 경계는 유효해야 한다");

        // 방금 resolve 가 lastAccess 를 t0+IDLE_MS 로 연장했다 → 거기서 한도+1 넘기면 만료.
        now[0] = t0 + SessionStore.IDLE_MS + SessionStore.IDLE_MS + 1;
        assertNull(store.resolve(sid), "idle 한도 초과는 만료(null)여야 한다");
    }

    @Test
    void freshSessionExpiresPastIdleWithoutAccess() {
        long t0 = now[0];
        String sid = store.issue("reporter");
        now[0] = t0 + SessionStore.IDLE_MS + 1;
        assertNull(store.resolve(sid));
    }

    @Test
    void removeIsIdempotent() {
        String sid = store.issue("reporter");
        store.remove(sid);
        assertNull(store.resolve(sid));
        store.remove(sid); // 두 번째도 예외 없이
        store.remove(null);
    }
}
