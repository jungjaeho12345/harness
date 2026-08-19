package harness.spring_auth;

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
 * 영속 계층 — 하네스가 시드한 임시 news.db(APS_DB_FILE)에 접근한다. 스키마는 하네스가 소유하므로
 * 이 클래스는 스키마 정의문·행 제거문을 전혀 만들지 않는다(DB 비파괴 최상위 규칙 — 정적 grep으로 잠근다).
 * 로그인 실패 카운트·계정잠금·사용자 생성/수정 UPDATE/INSERT만 수행한다.
 *
 * 원본 news.db 무접촉: 연결 URL은 오직 생성자로 받은 APS_DB_FILE 경로다(하드코딩 폴백 없음).
 * 환경변수 미설정(빈 경로)이면 생성 시점에 즉시 실패한다.
 */
public class NewsDb {

	/** 기사 목록 응답 투영에서 제거하는 2개 컬럼(ADR-005 — locker 내부 상태는 노출하지 않는다). */
	private static final Set<String> REMOVED_COLUMNS = Set.of("lockerSessionId", "lockerClientId");

	/** updateUser가 SET을 허용하는 컬럼 화이트리스트 — 컬럼명은 케이스가 아니라 이 상수에서만 온다(주입 표면 차단). */
	private static final Set<String> UPDATABLE_COLUMNS = Set.of(
			"role", "active", "failedLoginCount", "lockedUntil", "lastFailedLoginAt",
			"name", "department", "departmentCode");

	/** insertUser가 허용하는 컬럼 화이트리스트(사용자 생성 — password는 호출자가 이미 해시). */
	private static final Set<String> INSERTABLE_COLUMNS = Set.of(
			"userId", "name", "password", "role", "department", "departmentCode", "active",
			"failedLoginCount", "lockedUntil", "lastFailedLoginAt");

	/** 세션/로그인용 사용자 행 — password는 bcrypt 검증에만, 잠금 3컬럼은 로그인 핸들러 내부 전용(응답 금지). */
	public record User(String userId, String name, String role, String department,
			String departmentCode, String active, String password,
			String failedLoginCount, String lockedUntil, String lastFailedLoginAt) {
	}

	private final SQLiteDataSource dataSource;

	public NewsDb(String dbFile) {
		if (dbFile == null || dbFile.isBlank()) {
			throw new IllegalStateException(
					"APS_DB_FILE이 설정되지 않았다 — Spring auth 슬라이스는 하네스가 시드한 임시 DB 경로가 필수다(하드코딩 폴백 없음).");
		}
		SQLiteConfig config = new SQLiteConfig();
		// SQLITE_BUSY 완화(순차 요청이지만 로그인 실패 UPDATE와 조회가 겹칠 여지) — DDL 아님.
		config.setBusyTimeout(5000);
		this.dataSource = new SQLiteDataSource(config);
		this.dataSource.setUrl("jdbc:sqlite:" + dbFile);
	}

	private Connection open() throws SQLException {
		return dataSource.getConnection();
	}

	/** userId로 사용자 1행 조회 — 없거나 userId가 null이면 null. */
	public User findUser(String userId) {
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
				return new User(rs.getString("userId"), rs.getString("name"), rs.getString("role"),
						rs.getString("department"), rs.getString("departmentCode"), rs.getString("active"),
						rs.getString("password"), rs.getString("failedLoginCount"),
						rs.getString("lockedUntil"), rs.getString("lastFailedLoginAt"));
			}
		} catch (SQLException e) {
			throw new IllegalStateException("User 조회 실패: " + e.getMessage(), e);
		}
	}

	/**
	 * 사용자 생성 — 화이트리스트 컬럼만 INSERT. password는 호출자가 이미 bcrypt 해시한 값이어야 한다.
	 * active/failedLoginCount 미지정 시 기본값('Y'/'0')을 채운다. 삽입 행수(1)를 반환한다.
	 */
	public int insertUser(Map<String, String> fields) {
		Map<String, String> row = new LinkedHashMap<>();
		for (Map.Entry<String, String> e : fields.entrySet()) {
			if (!INSERTABLE_COLUMNS.contains(e.getKey())) {
				throw new IllegalArgumentException("허용되지 않은 사용자 컬럼: " + e.getKey());
			}
			row.put(e.getKey(), e.getValue());
		}
		row.putIfAbsent("active", "Y");
		row.putIfAbsent("failedLoginCount", "0");

		List<String> cols = new ArrayList<>(row.keySet());
		String colList = String.join(", ", cols);
		String placeholders = String.join(", ", cols.stream().map(x -> "?").toList());
		String sql = "INSERT INTO User (" + colList + ") VALUES (" + placeholders + ")";
		try (Connection c = open(); PreparedStatement ps = c.prepareStatement(sql)) {
			int i = 1;
			for (String col : cols) {
				ps.setString(i++, row.get(col));
			}
			return ps.executeUpdate();
		} catch (SQLException e) {
			throw new IllegalStateException("User 생성 실패: " + e.getMessage(), e);
		}
	}

	/**
	 * 사용자 수정 — 화이트리스트 컬럼만 SET. 컬럼명은 UPDATABLE_COLUMNS에서만 온다(케이스가 컬럼명을 정하지 못한다).
	 * null 값은 SQL NULL로 저장한다(잠금 리셋에서 lockedUntil=null로 비운다). 변경 행수를 반환한다(미존재 userId → 0).
	 */
	public int updateUser(String userId, Map<String, String> fields) {
		if (fields.isEmpty()) {
			return 0;
		}
		List<String> cols = new ArrayList<>();
		for (String col : fields.keySet()) {
			if (!UPDATABLE_COLUMNS.contains(col)) {
				throw new IllegalArgumentException("허용되지 않은 수정 컬럼: " + col);
			}
			cols.add(col);
		}
		String setClause = String.join(", ", cols.stream().map(col -> col + " = ?").toList());
		String sql = "UPDATE User SET " + setClause + " WHERE userId = ?";
		try (Connection c = open(); PreparedStatement ps = c.prepareStatement(sql)) {
			int i = 1;
			for (String col : cols) {
				ps.setString(i++, fields.get(col));
			}
			ps.setString(i, userId);
			return ps.executeUpdate();
		} catch (SQLException e) {
			throw new IllegalStateException("User 수정 실패: " + e.getMessage(), e);
		}
	}

	/**
	 * 기사 목록 — Contents 전 컬럼에서 lockerSessionId·lockerClientId만 제거해 돌려준다(응답 투영 단일 지점).
	 * auth 슬라이스라 최소 SELECT다(13키 필터 빌더는 후속 phase). 값은 전부 문자열(VARCHAR)로 읽는다.
	 */
	public List<Map<String, Object>> listArticles() {
		String sql = "SELECT * FROM Contents";
		try (Connection c = open(); PreparedStatement ps = c.prepareStatement(sql);
				ResultSet rs = ps.executeQuery()) {
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
					row.put(label, rs.getString(i));
				}
				items.add(row);
			}
			return items;
		} catch (SQLException e) {
			throw new IllegalStateException("Contents 조회 실패: " + e.getMessage(), e);
		}
	}
}
