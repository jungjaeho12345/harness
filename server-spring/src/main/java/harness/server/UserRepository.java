package harness.server;

import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import org.sqlite.SQLiteConfig;
import org.sqlite.SQLiteDataSource;

/**
 * User 테이블 접근 계층 — SQLite JDBC 직접 SQL(ADR-002/006 동형). <b>읽기·쓰기</b>지만
 * <b>DB 비파괴</b>다: 프로덕션 경로는 DDL(CREATE/ALTER/DROP)·DELETE 를 한 줄도 실행하지 않는다.
 * 비활성화는 {@code active='N'} UPDATE(soft delete)뿐이다.
 *
 * <p>스키마는 계약 하네스가 Node {@code src/db/schema.js} 로 만든 임시 시드 DB 가 소유한다 —
 * 이 클래스는 그 DB 를 열어 DML 만 한다. 리포 원본 {@code news.db} 는 절대 열지 않는다(경로 주입).
 *
 * <p>모든 SQL 은 PreparedStatement(문자열 concat 금지 — 인젝션·따옴표 파손 차단). 식별자는 리터럴만.
 * 연결은 연산마다 열고 닫는다(계약 스위트의 직렬 부하에 충분). {@code busy_timeout=5000}.
 */
public class UserRepository {

    /** 부분 수정에서 허용하는 컬럼 화이트리스트 — userId(PK)는 수정 불가, 그 밖의 키는 거부. */
    private static final Set<String> UPDATABLE_COLUMNS = Set.of(
            "name", "role", "department", "departmentCode", "active",
            "password", "failedLoginCount", "lockedUntil", "lastFailedLoginAt");

    /** 신규 생성에서 설정 가능한 컬럼(userId 포함). 그 밖의 키는 거부. */
    private static final Set<String> INSERTABLE_COLUMNS = Set.of(
            "userId", "name", "role", "department", "departmentCode", "active",
            "password", "failedLoginCount", "lockedUntil", "lastFailedLoginAt");

    private final SQLiteDataSource dataSource;

    public UserRepository(String dbPath) {
        if (dbPath == null || dbPath.isBlank()) {
            // 미주입이면 부팅을 실패시킨다 — 리포 news.db 로 조용히 떨어지는 기본값을 두지 않는다(DB 비파괴).
            throw new IllegalStateException("app.db-path 가 주입되지 않았다 — SQLite DB 경로가 필요하다(기본값 없음).");
        }
        SQLiteConfig config = new SQLiteConfig();
        config.setBusyTimeout(5000); // 동시 쓰기 대비.
        // readOnly 아님(기본) — 사용자 생성/수정·로그인 잠금 카운터 영속이 필요하다.
        this.dataSource = new SQLiteDataSource(config);
        this.dataSource.setUrl("jdbc:sqlite:" + dbPath);
    }

    private Connection open() throws SQLException {
        return dataSource.getConnection();
    }

    /** userId(PK)로 1행. 없으면 null. 반환 레코드는 password·잠금 필드를 포함한다(도메인 로직 전용). */
    public UserRow findUser(String userId) {
        if (userId == null) {
            return null;
        }
        String sql = "SELECT userId, name, role, department, departmentCode, active, password, "
                + "failedLoginCount, lockedUntil, lastFailedLoginAt FROM User WHERE userId = ?";
        try (Connection c = open(); PreparedStatement ps = c.prepareStatement(sql)) {
            ps.setString(1, userId);
            try (ResultSet rs = ps.executeQuery()) {
                if (!rs.next()) {
                    return null;
                }
                return new UserRow(
                        rs.getString("userId"), rs.getString("name"), rs.getString("role"),
                        rs.getString("department"), rs.getString("departmentCode"), rs.getString("active"),
                        rs.getString("password"), rs.getString("failedLoginCount"),
                        rs.getString("lockedUntil"), rs.getString("lastFailedLoginAt"));
            }
        } catch (SQLException e) {
            throw new IllegalStateException("User 조회 실패: " + e.getMessage(), e);
        }
    }

    /**
     * 전 사용자 명단(SAFE_FIELDS 6키: userId,name,role,department,departmentCode,active).
     * password·잠금 필드는 <b>절대</b> 싣지 않는다. 역할별 투영(Z=6키/비-Z=4키)은 상위(컨트롤러)가 한다.
     */
    public List<Map<String, Object>> listUsers() {
        String sql = "SELECT userId, name, role, department, departmentCode, active FROM User";
        try (Connection c = open(); PreparedStatement ps = c.prepareStatement(sql);
                ResultSet rs = ps.executeQuery()) {
            List<Map<String, Object>> items = new ArrayList<>();
            while (rs.next()) {
                Map<String, Object> row = new LinkedHashMap<>();
                row.put("userId", rs.getString("userId"));
                row.put("name", rs.getString("name"));
                row.put("role", rs.getString("role"));
                row.put("department", rs.getString("department"));
                row.put("departmentCode", rs.getString("departmentCode"));
                row.put("active", rs.getString("active"));
                items.add(row);
            }
            return items;
        } catch (SQLException e) {
            throw new IllegalStateException("User 목록 조회 실패: " + e.getMessage(), e);
        }
    }

    /**
     * 신규 사용자 INSERT. 제공된 컬럼만 넣고 나머지는 DB DEFAULT(active='Y'·failedLoginCount='0')에 맡긴다.
     * userId(PK) 중복이면 JDBC 예외를 <b>던진다</b>(상위가 500 internal-error 로 매핑) — 여기서 삼키지 않는다.
     * password 는 이미 해시된 값을 받는다(해싱은 서비스 계층 책임).
     */
    public void insertUser(Map<String, Object> row) {
        if (row == null || row.get("userId") == null) {
            throw new IllegalArgumentException("insertUser: userId 는 필수다.");
        }
        List<String> cols = new ArrayList<>();
        List<Object> vals = new ArrayList<>();
        for (Map.Entry<String, Object> e : row.entrySet()) {
            if (!INSERTABLE_COLUMNS.contains(e.getKey())) {
                throw new IllegalArgumentException("insertUser: 허용되지 않은 컬럼: " + e.getKey());
            }
            cols.add(e.getKey());
            vals.add(e.getValue());
        }
        String placeholders = String.join(", ", java.util.Collections.nCopies(cols.size(), "?"));
        String sql = "INSERT INTO User (" + String.join(", ", cols) + ") VALUES (" + placeholders + ")";
        try (Connection c = open(); PreparedStatement ps = c.prepareStatement(sql)) {
            bind(ps, vals);
            ps.executeUpdate();
        } catch (SQLException e) {
            // 중복 PK 등 제약 위반은 그대로 전파한다(상위 전역 핸들러가 500 으로 매핑).
            throw new RuntimeException(e);
        }
    }

    /**
     * 부분 수정 — patch 의 (화이트리스트) 컬럼만 SET, 변경 행 수 반환. 없는 userId 면 0(존재 판정 안 함).
     * 값이 {@code null} 이면 SQL NULL 로 SET 한다(로그인 성공 시 잠금 리셋이 lockedUntil/lastFailedLoginAt 을 비운다).
     * DELETE 하지 않는다 — 비활성화는 {@code active='N'} 이 온 UPDATE 다.
     */
    public int updateUser(String userId, Map<String, Object> patch) {
        if (userId == null) {
            return 0;
        }
        if (patch == null || patch.isEmpty()) {
            return 0;
        }
        List<String> assignments = new ArrayList<>();
        List<Object> vals = new ArrayList<>();
        for (Map.Entry<String, Object> e : patch.entrySet()) {
            if (!UPDATABLE_COLUMNS.contains(e.getKey())) {
                throw new IllegalArgumentException("updateUser: 허용되지 않은 컬럼: " + e.getKey());
            }
            assignments.add(e.getKey() + " = ?");
            vals.add(e.getValue());
        }
        String sql = "UPDATE User SET " + String.join(", ", assignments) + " WHERE userId = ?";
        try (Connection c = open(); PreparedStatement ps = c.prepareStatement(sql)) {
            bind(ps, vals);
            ps.setString(vals.size() + 1, userId);
            return ps.executeUpdate();
        } catch (SQLException e) {
            throw new IllegalStateException("User 수정 실패: " + e.getMessage(), e);
        }
    }

    /** 값 바인딩 — 전 컬럼 TEXT 이므로 문자열로 바인딩하되 null 은 SQL NULL 로 둔다. */
    private static void bind(PreparedStatement ps, List<Object> vals) throws SQLException {
        for (int i = 0; i < vals.size(); i++) {
            Object v = vals.get(i);
            ps.setString(i + 1, v == null ? null : String.valueOf(v));
        }
    }
}
