package harness.p0_spring;

import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.ResultSetMetaData;
import java.sql.SQLException;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import org.sqlite.SQLiteConfig;
import org.sqlite.SQLiteDataSource;

/**
 * 사본 news.db 읽기 전용 접근 (CONTRACT.md 계정/DB 절). 원본 무접촉 — 스파이크는
 * spikes/p0-spring/data/news.db 사본만 SQLiteConfig readOnly 로 연다.
 * 연결은 요청마다 열고 닫는다(SQLite 파일 DB — 스파이크 부하에서 충분).
 */
public class NewsDb {

    /** 행 객체에서 제거하는 2개 컬럼 (CONTRACT.md /api/articles 절). */
    private static final Set<String> REMOVED_COLUMNS = Set.of("lockerSessionId", "lockerClientId");

    /** 세션/로그인용 사용자 행 — password 는 BCrypt 검증에만 쓰고 절대 응답에 싣지 않는다. */
    public record User(String userId, String name, String role, String department,
                       String departmentCode, String active, String password) {
    }

    private final SQLiteDataSource dataSource;

    public NewsDb(String dbPath) {
        SQLiteConfig config = new SQLiteConfig();
        config.setReadOnly(true); // 읽기 전용 — 스파이크가 데이터를 쓸 경로 자체를 없앤다.
        this.dataSource = new SQLiteDataSource(config);
        this.dataSource.setUrl("jdbc:sqlite:" + dbPath);
    }

    /** 읽기 전용 연결 — 테스트가 readOnly 를 실증할 수 있게 공개한다. */
    public Connection open() throws SQLException {
        return dataSource.getConnection();
    }

    public User findUser(String userId) {
        if (userId == null) {
            return null;
        }
        String sql = "SELECT userId, name, password, role, department, departmentCode, active FROM User WHERE userId = ?";
        try (Connection c = open(); PreparedStatement ps = c.prepareStatement(sql)) {
            ps.setString(1, userId);
            try (ResultSet rs = ps.executeQuery()) {
                if (!rs.next()) {
                    return null;
                }
                return new User(rs.getString("userId"), rs.getString("name"), rs.getString("role"),
                        rs.getString("department"), rs.getString("departmentCode"),
                        rs.getString("active"), rs.getString("password"));
            }
        } catch (SQLException e) {
            throw new IllegalStateException("User 조회 실패: " + e.getMessage(), e);
        }
    }

    /** /api/users 축소 shape — {userId,name,department,departmentCode} (CONTRACT.md 표). */
    public List<Map<String, Object>> listUsers() {
        String sql = "SELECT userId, name, department, departmentCode FROM User";
        try (Connection c = open(); PreparedStatement ps = c.prepareStatement(sql);
             ResultSet rs = ps.executeQuery()) {
            List<Map<String, Object>> items = new ArrayList<>();
            while (rs.next()) {
                Map<String, Object> row = new LinkedHashMap<>();
                row.put("userId", rs.getString("userId"));
                row.put("name", rs.getString("name"));
                row.put("department", rs.getString("department"));
                row.put("departmentCode", rs.getString("departmentCode"));
                items.add(row);
            }
            return items;
        } catch (SQLException e) {
            throw new IllegalStateException("User 목록 조회 실패: " + e.getMessage(), e);
        }
    }

    /** Contents 조회 — 전 컬럼에서 lockerSessionId·lockerClientId 만 제거해 돌려준다. */
    public List<Map<String, Object>> queryArticles(Map<String, String[]> query) {
        ArticleQuery.Built built = ArticleQuery.build(query);
        try (Connection c = open(); PreparedStatement ps = c.prepareStatement(built.sql())) {
            List<String> params = built.params();
            for (int i = 0; i < params.size(); i++) {
                ps.setString(i + 1, params.get(i));
            }
            try (ResultSet rs = ps.executeQuery()) {
                ResultSetMetaData meta = rs.getMetaData();
                int cols = meta.getColumnCount();
                List<Map<String, Object>> items = new ArrayList<>();
                while (rs.next()) {
                    Map<String, Object> row = new LinkedHashMap<>();
                    for (int i = 1; i <= cols; i++) {
                        String label = meta.getColumnLabel(i);
                        if (REMOVED_COLUMNS.contains(label)) {
                            continue;
                        }
                        row.put(label, rs.getString(i)); // 전 컬럼 VARCHAR — ISO-8601 문자열 그대로.
                    }
                    items.add(row);
                }
                return items;
            }
        } catch (SQLException e) {
            throw new IllegalStateException("Contents 조회 실패: " + e.getMessage(), e);
        }
    }
}
