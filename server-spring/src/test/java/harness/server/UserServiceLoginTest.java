package harness.server;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.nio.file.Path;
import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.Statement;
import java.util.function.LongSupplier;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/**
 * UserService 로그인 도메인 테스트 — 임시 DB + 주입 시계. bcryptjs 로 만든 실제 해시 호환·잠금·리셋·열거방지.
 */
class UserServiceLoginTest {

    @TempDir
    Path tempDir;

    // bcryptjs(cost 10)로 'reporter123' 을 해시한 실제 값 — spring-security-crypto BCryptPasswordEncoder 호환 실증.
    private static final String REPORTER_HASH = "$2a$10$pVxJZytncqROLS2hh6hIYuYgEuSpe.Coh8dPlk0ecTZFtpbqeL9Dy";
    private static final String REPORTER_PW = "reporter123";

    private static final String CREATE_USER = "CREATE TABLE User ("
            + "userId TEXT PRIMARY KEY, name TEXT, password TEXT, role TEXT, department TEXT, "
            + "departmentCode TEXT, active TEXT DEFAULT 'Y', failedLoginCount TEXT DEFAULT '0', "
            + "lockedUntil TEXT, lastFailedLoginAt TEXT)";

    private UserRepository repo;
    private UserService svc;
    private final long[] now = { 1_000_000L };

    @BeforeEach
    void setup() throws Exception {
        String dbPath = tempDir.resolve("news.db").toString();
        try (Connection c = DriverManager.getConnection("jdbc:sqlite:" + dbPath);
                Statement st = c.createStatement()) {
            st.executeUpdate(CREATE_USER);
            st.executeUpdate("INSERT INTO User (userId, name, password, role, department, departmentCode, active) "
                    + "VALUES ('reporter', '김기자', '" + REPORTER_HASH + "', 'R', '사회부', 'SOC', 'Y')");
            st.executeUpdate("INSERT INTO User (userId, name, password, role, active) "
                    + "VALUES ('dormant', '휴면', '" + REPORTER_HASH + "', 'R', 'N')");
        }
        repo = new UserRepository(dbPath);
        LongSupplier clock = () -> now[0];
        svc = new UserService(repo, clock); // 기본 임계 5 / 15분
    }

    @Test
    void loginSuccessVerifiesBcryptjsHash() {
        UserService.LoginResult r = svc.login("reporter", REPORTER_PW);
        assertTrue(r.ok(), "bcryptjs $2a$ 해시가 BCryptPasswordEncoder.matches 로 검증돼야 한다");
        assertEquals("reporter", r.row().userId());
        assertEquals("R", r.row().role());
    }

    @Test
    void wrongPasswordInvalidCredentialsAndCountsUp() {
        UserService.LoginResult r = svc.login("reporter", "wrong-pw");
        assertFalse(r.ok());
        assertEquals("invalid-credentials", r.reason());
        assertEquals("1", repo.findUser("reporter").failedLoginCount());
    }

    @Test
    void unknownUserSameResultAsWrongPasswordNoException() {
        UserService.LoginResult r = svc.login("nobody", "whatever");
        assertFalse(r.ok());
        assertEquals("invalid-credentials", r.reason(), "미존재 계정도 존재 계정 오답과 같은 토큰(열거 방지)");
    }

    @Test
    void inactiveTakesPriorityAndRejects403Reason() {
        UserService.LoginResult r = svc.login("dormant", REPORTER_PW); // 올바른 비번이어도
        assertFalse(r.ok());
        assertEquals("inactive", r.reason());
        assertEquals("0", repo.findUser("dormant").failedLoginCount(), "비활성 계정에는 실패 카운트를 올리지 않는다");
    }

    @Test
    void lockoutAfterThresholdThenLockedEvenWithCorrectPassword() {
        for (int i = 1; i <= 5; i++) {
            UserService.LoginResult r = svc.login("reporter", "wrong-pw");
            assertEquals("invalid-credentials", r.reason(), i + "번째 실패는 아직 invalid-credentials");
        }
        // 잠긴 계정은 올바른 비밀번호로도 locked
        UserService.LoginResult locked = svc.login("reporter", REPORTER_PW);
        assertEquals("locked", locked.reason());
        assertTrue(Long.parseLong(repo.findUser("reporter").lockedUntil()) > now[0]);
    }

    @Test
    void lockExpiryAllowsLoginAfterWindowAndResets() {
        for (int i = 1; i <= 5; i++) {
            svc.login("reporter", "wrong-pw");
        }
        assertEquals("locked", svc.login("reporter", REPORTER_PW).reason());

        now[0] += 16L * 60L * 1000L; // 잠금 창(15분) 경과
        UserService.LoginResult r = svc.login("reporter", REPORTER_PW);
        assertTrue(r.ok(), "잠금 만료 후 올바른 비밀번호는 성공해야 한다");
        assertEquals("0", repo.findUser("reporter").failedLoginCount(), "성공 시 카운트 리셋");
        assertNull(repo.findUser("reporter").lockedUntil(), "성공 시 lockedUntil 은 NULL");
    }

    @Test
    void successResetsPartialFailureCount() {
        svc.login("reporter", "wrong-pw");
        svc.login("reporter", "wrong-pw");
        assertEquals("2", repo.findUser("reporter").failedLoginCount());
        assertTrue(svc.login("reporter", REPORTER_PW).ok());
        assertEquals("0", repo.findUser("reporter").failedLoginCount());
    }
}
