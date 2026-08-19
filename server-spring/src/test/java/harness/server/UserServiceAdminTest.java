package harness.server;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.nio.file.Path;
import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.Statement;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.security.crypto.bcrypt.BCryptPasswordEncoder;

/** UserService.create/update 도메인 — 안전 투영·기본 active·중복 예외·비밀번호 해시·soft delete. */
class UserServiceAdminTest {

    @TempDir
    Path tempDir;

    private static final String CREATE_USER = "CREATE TABLE User ("
            + "userId TEXT PRIMARY KEY, name TEXT, password TEXT, role TEXT, department TEXT, "
            + "departmentCode TEXT, active TEXT DEFAULT 'Y', failedLoginCount TEXT DEFAULT '0', "
            + "lockedUntil TEXT, lastFailedLoginAt TEXT)";

    private UserRepository repo;
    private UserService svc;

    @BeforeEach
    void setup() throws Exception {
        String dbPath = tempDir.resolve("news.db").toString();
        try (Connection c = DriverManager.getConnection("jdbc:sqlite:" + dbPath);
                Statement st = c.createStatement()) {
            st.executeUpdate(CREATE_USER);
        }
        repo = new UserRepository(dbPath);
        svc = new UserService(repo, () -> 1000L);
    }

    private static Map<String, Object> map(Object... kv) {
        Map<String, Object> m = new LinkedHashMap<>();
        for (int i = 0; i < kv.length; i += 2) {
            m.put((String) kv[i], kv[i + 1]);
        }
        return m;
    }

    @Test
    void createFullReturnsSixKeySafeWithDefaultActiveNoPassword() {
        Map<String, Object> user = svc.create(map(
                "userId", "u1", "name", "홍", "role", "R", "department", "사회부",
                "departmentCode", "SOC", "password", "secret"));
        assertEquals(List.of("active", "department", "departmentCode", "name", "role", "userId"),
                user.keySet().stream().sorted().toList());
        assertEquals("Y", user.get("active")); // 미지정 → DB DEFAULT
        assertFalse(user.containsKey("password"));
        assertFalse(user.toString().contains("$2")); // bcrypt 해시 접두사도 없음
    }

    @Test
    void createLooseReturnsOnlyProvidedKeys() {
        Map<String, Object> user = svc.create(map("userId", "loose", "role", "X", "active", "N"));
        assertEquals(List.of("active", "role", "userId"), user.keySet().stream().sorted().toList());
        assertEquals("X", user.get("role"));
        assertEquals("N", user.get("active"));
    }

    @Test
    void createDuplicateUserIdThrows() {
        svc.create(map("userId", "dup", "role", "R"));
        assertThrows(RuntimeException.class, () -> svc.create(map("userId", "dup", "role", "R")));
    }

    @Test
    void updateChangesAndRereads() {
        svc.create(map("userId", "u2", "name", "old", "role", "R"));
        assertEquals(1, svc.update("u2", map("name", "new", "department", "정치부")));
        UserRow u = repo.findUser("u2");
        assertEquals("new", u.name());
        assertEquals("정치부", u.department());
        assertEquals("R", u.role()); // 수정하지 않은 필드 불변
    }

    @Test
    void updatePasswordStoresBcryptHashNotPlaintext() {
        svc.create(map("userId", "u3", "role", "R", "password", "orig"));
        svc.update("u3", map("password", "brandnew"));
        String stored = repo.findUser("u3").password();
        assertTrue(stored.startsWith("$2"), "비밀번호는 bcrypt 해시로 저장");
        assertTrue(new BCryptPasswordEncoder().matches("brandnew", stored));
    }

    @Test
    void updateMissingUserIdReturnsZero() {
        assertEquals(0, svc.update("ghost", map("name", "x")));
    }

    @Test
    void updateActiveNKeepsRow() {
        svc.create(map("userId", "u4", "role", "R"));
        assertEquals(1, svc.update("u4", map("active", "N")));
        assertEquals("N", repo.findUser("u4").active()); // 행 삭제 없음(soft delete)
    }
}
