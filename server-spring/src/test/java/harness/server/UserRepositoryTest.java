package harness.server;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
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

/**
 * UserRepository 단위 테스트 — 임시 파일 DB(테스트 전용 셋업 DDL) 위에서 읽기·쓰기 왕복을 검증한다.
 * 프로덕션 코드는 DDL 을 실행하지 않으므로 스키마는 이 테스트가 세운다(schema.js User 컬럼과 동일).
 * 리포 news.db 는 열지 않는다.
 */
class UserRepositoryTest {

    @TempDir
    Path tempDir;

    private String dbPath;
    private UserRepository repo;

    // schema.js User 테이블과 동일한 컬럼·DEFAULT (테스트 전용 — 프로덕션 코드에는 DDL 없음).
    private static final String CREATE_USER = "CREATE TABLE User ("
            + "userId TEXT PRIMARY KEY, name TEXT, password TEXT, role TEXT, department TEXT, "
            + "departmentCode TEXT, active TEXT DEFAULT 'Y', failedLoginCount TEXT DEFAULT '0', "
            + "lockedUntil TEXT, lastFailedLoginAt TEXT)";

    @BeforeEach
    void setup() throws Exception {
        dbPath = tempDir.resolve("news.db").toString();
        try (Connection c = DriverManager.getConnection("jdbc:sqlite:" + dbPath);
                Statement st = c.createStatement()) {
            st.executeUpdate(CREATE_USER);
            st.executeUpdate("INSERT INTO User (userId, name, password, role, department, departmentCode, active) "
                    + "VALUES ('reporter', '김기자', 'HASH-R', 'R', '사회부', 'SOC', 'Y')");
        }
        repo = new UserRepository(dbPath);
    }

    private static Map<String, Object> row(Object... kv) {
        Map<String, Object> m = new LinkedHashMap<>();
        for (int i = 0; i < kv.length; i += 2) {
            m.put((String) kv[i], kv[i + 1]);
        }
        return m;
    }

    @Test
    void constructorRejectsBlankDbPath() {
        assertThrows(IllegalStateException.class, () -> new UserRepository(""));
        assertThrows(IllegalStateException.class, () -> new UserRepository(null));
    }

    @Test
    void findUserReturnsRowWithAllFieldsOrNull() {
        UserRow u = repo.findUser("reporter");
        assertEquals("reporter", u.userId());
        assertEquals("R", u.role());
        assertEquals("사회부", u.department());
        assertEquals("Y", u.active());
        assertEquals("HASH-R", u.password()); // 도메인 로직 전용 — 응답 직렬화는 상위가 막는다.
        assertNull(repo.findUser("nobody"));
        assertNull(repo.findUser(null));
    }

    @Test
    void insertUserAppliesDbDefaultsForOmittedColumns() {
        repo.insertUser(row("userId", "u1", "name", "새사용자", "role", "D"));
        UserRow u = repo.findUser("u1");
        assertEquals("D", u.role());
        assertEquals("Y", u.active()); // active 미지정 → DB DEFAULT 'Y'
        assertEquals("0", u.failedLoginCount()); // 미지정 → DEFAULT '0'
    }

    @Test
    void insertUserDuplicatePrimaryKeyThrows() {
        assertThrows(RuntimeException.class,
                () -> repo.insertUser(row("userId", "reporter", "role", "R")));
    }

    @Test
    void insertUserRejectsUnknownColumn() {
        assertThrows(IllegalArgumentException.class,
                () -> repo.insertUser(row("userId", "u2", "bogus", "x")));
    }

    @Test
    void updateUserAppliesPartialPatchAndLeavesOthers() {
        int changes = repo.updateUser("reporter", row("name", "새이름", "department", "정치부"));
        assertEquals(1, changes);
        UserRow u = repo.findUser("reporter");
        assertEquals("새이름", u.name());
        assertEquals("정치부", u.department());
        assertEquals("R", u.role()); // 수정하지 않은 필드는 불변
        assertEquals("SOC", u.departmentCode());
    }

    @Test
    void updateUserMissingUserIdReturnsZero() {
        assertEquals(0, repo.updateUser("ghost", row("name", "x")));
    }

    @Test
    void updateUserNullValueSetsSqlNull() {
        // 먼저 잠금 필드에 값을 넣고, null 패치가 SQL NULL 로 비우는지 본다(로그인 성공 시 잠금 리셋).
        repo.updateUser("reporter", row("failedLoginCount", "3", "lockedUntil", "999999", "lastFailedLoginAt", "111"));
        assertEquals("999999", repo.findUser("reporter").lockedUntil());

        Map<String, Object> reset = row("failedLoginCount", "0");
        reset.put("lockedUntil", null);
        reset.put("lastFailedLoginAt", null);
        repo.updateUser("reporter", reset);

        UserRow u = repo.findUser("reporter");
        assertEquals("0", u.failedLoginCount());
        assertNull(u.lockedUntil());
        assertNull(u.lastFailedLoginAt());
    }

    @Test
    void updateUserRejectsUnknownColumnAndPk() {
        assertThrows(IllegalArgumentException.class, () -> repo.updateUser("reporter", row("bogus", "x")));
        assertThrows(IllegalArgumentException.class, () -> repo.updateUser("reporter", row("userId", "other")));
    }

    @Test
    void updateUserActiveNKeepsRowSoftDelete() {
        assertEquals(1, repo.updateUser("reporter", row("active", "N")));
        UserRow u = repo.findUser("reporter"); // 행은 남는다(soft delete)
        assertEquals("N", u.active());
    }

    @Test
    void listUsersOmitsPasswordAndLockFields() {
        List<Map<String, Object>> items = repo.listUsers();
        assertTrue(items.stream().anyMatch(m -> "reporter".equals(m.get("userId"))));
        for (Map<String, Object> m : items) {
            assertTrue(m.keySet().containsAll(
                    List.of("userId", "name", "role", "department", "departmentCode", "active")));
            assertEquals(6, m.size(), "listUsers 는 정확히 6키(잠금/비밀번호 없음)");
            assertTrue(!m.containsKey("password") && !m.containsKey("failedLoginCount")
                    && !m.containsKey("lockedUntil") && !m.containsKey("lastFailedLoginAt"));
        }
    }
}
