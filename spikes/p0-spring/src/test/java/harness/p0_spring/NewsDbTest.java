package harness.p0_spring;

import java.nio.file.Path;
import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.SQLException;
import java.sql.Statement;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.security.crypto.bcrypt.BCryptPasswordEncoder;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/**
 * NewsDb — 사본 SQLite 읽기 전용 접근 (CONTRACT.md 계정/DB 절).
 * 프로덕션 news.db 미바인딩 — 테스트는 @TempDir에 스키마 동형 픽스처를 만든다.
 * 행 shape: Contents 전 컬럼 - lockerSessionId·lockerClientId 2개 제거.
 */
class NewsDbTest {

    private static final BCryptPasswordEncoder BCRYPT = new BCryptPasswordEncoder();

    @TempDir
    Path tmp;

    private String dbPath;

    @BeforeEach
    void seed() throws SQLException {
        dbPath = tmp.resolve("fixture.db").toString();
        try (Connection c = DriverManager.getConnection("jdbc:sqlite:" + dbPath);
             Statement s = c.createStatement()) {
            s.executeUpdate("CREATE TABLE User (userId TEXT PRIMARY KEY, name TEXT, password TEXT, role TEXT, "
                    + "department TEXT, departmentCode TEXT, active TEXT)");
            s.executeUpdate("CREATE TABLE Contents (articleId VARCHAR PRIMARY KEY, title VARCHAR, content VARCHAR, "
                    + "author VARCHAR, modifier VARCHAR, sender VARCHAR, department VARCHAR, departmentCode VARCHAR, "
                    + "createdAt VARCHAR, editedAt VARCHAR, sentAt VARCHAR, distributedAt VARCHAR, status VARCHAR, "
                    + "lockYN VARCHAR, lockerUserId VARCHAR, lockerSessionId VARCHAR, lockerClientId VARCHAR)");
            String hash = BCRYPT.encode("admin123");
            s.executeUpdate("INSERT INTO User VALUES ('admin', '관리자', '" + hash + "', 'Z', '운영부', 'ADM', 'Y')");
            s.executeUpdate("INSERT INTO Contents (articleId, title, author, department, createdAt, status, "
                    + "lockYN, lockerSessionId, lockerClientId) VALUES "
                    + "('A1', '첫 기사', '기자', '사회부', '2026-01-01T00:00:00.000Z', 'RDS', 'N', 'sess-1', 'client-1'),"
                    + "('A2', '둘째 기사', '기자', '사회부', '2026-02-01T00:00:00.000Z', 'DDH', 'N', NULL, NULL),"
                    + "('A3', '셋째 기사', '기자', '편집부', '2026-03-01T00:00:00.000Z', 'DPS', 'N', NULL, NULL)");
        }
    }

    @Test
    void findUserReturnsBcryptVerifiableRow() {
        NewsDb db = new NewsDb(dbPath);
        NewsDb.User u = db.findUser("admin");
        assertThat(u).isNotNull();
        assertThat(u.name()).isEqualTo("관리자");
        assertThat(u.role()).isEqualTo("Z");
        assertThat(u.departmentCode()).isEqualTo("ADM");
        assertThat(BCRYPT.matches("admin123", u.password())).isTrue();
        assertThat(BCRYPT.matches("wrong", u.password())).isFalse();
    }

    @Test
    void findUserUnknownIsNull() {
        assertThat(new NewsDb(dbPath).findUser("nobody")).isNull();
    }

    @Test
    void listUsersHasExactlyReducedShape() {
        List<Map<String, Object>> items = new NewsDb(dbPath).listUsers();
        assertThat(items).hasSize(1);
        assertThat(items.get(0).keySet()).containsExactlyInAnyOrder("userId", "name", "department", "departmentCode");
    }

    @Test
    void queryArticlesFiltersAndOrdersByCreatedAtDesc() {
        List<Map<String, Object>> items = new NewsDb(dbPath)
                .queryArticles(Map.of("status", new String[]{"RDS", "DDH"}));
        assertThat(items).extracting(m -> m.get("articleId")).containsExactly("A2", "A1"); // createdAt DESC
    }

    @Test
    void queryArticlesProjectsOutLockerSessionAndClient() {
        List<Map<String, Object>> items = new NewsDb(dbPath)
                .queryArticles(Map.of("status", new String[]{"RDS"}));
        assertThat(items).hasSize(1);
        Map<String, Object> row = items.get(0);
        assertThat(row).doesNotContainKeys("lockerSessionId", "lockerClientId");
        assertThat(row).containsKeys("articleId", "title", "author", "department", "createdAt", "status",
                "lockYN", "lockerUserId");
        assertThat(row.get("title")).isEqualTo("첫 기사");
    }

    @Test
    void queryArticlesExcludeStatus() {
        List<Map<String, Object>> items = new NewsDb(dbPath)
                .queryArticles(Map.of("excludeStatus", new String[]{"DPS", "DDH"}));
        assertThat(items).extracting(m -> m.get("articleId")).containsExactly("A1");
    }

    @Test
    void connectionIsReadOnly() {
        NewsDb db = new NewsDb(dbPath);
        assertThatThrownBy(() -> {
            try (Connection c = db.open(); Statement s = c.createStatement()) {
                s.executeUpdate("UPDATE Contents SET title = 'oops'");
            }
        }).isInstanceOf(SQLException.class);
    }
}
