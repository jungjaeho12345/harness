package harness.spring_auth;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.nio.file.Files;
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

/**
 * step2 영속 계층(NewsDb) 유닛 테스트. 임시 파일 DB를 만들고 src/db/schema.js와 동일한 컬럼으로
 * User·Contents를 생성·시드한 뒤 repository 메서드를 검증한다. 스키마 생성은 하네스 소유이므로
 * 여기(테스트 픽스처)서만 DDL을 쓴다 — main 소스에는 DDL이 없다(AC 정적 grep).
 */
class NewsDbTest {

	@TempDir
	Path tmp;

	private Path dbFile;
	private final BCryptPasswordEncoder bcrypt = new BCryptPasswordEncoder();

	// src/db/schema.js User 컬럼 정본(계정잠금 3컬럼 포함).
	private static final String CREATE_USER = "CREATE TABLE User ("
			+ "userId TEXT PRIMARY KEY, name TEXT, password TEXT, role TEXT, department TEXT, "
			+ "departmentCode TEXT, active TEXT DEFAULT 'Y', failedLoginCount TEXT DEFAULT '0', "
			+ "lockedUntil TEXT, lastFailedLoginAt TEXT)";

	// Contents — 목록 투영이 lockerSessionId·lockerClientId를 제거하는지 보려면 그 두 컬럼이 실재해야 한다.
	private static final String CREATE_CONTENTS = "CREATE TABLE Contents ("
			+ "articleId VARCHAR PRIMARY KEY, title VARCHAR, content VARCHAR, status VARCHAR, "
			+ "lockerUserId VARCHAR, lockerSessionId VARCHAR, lockerClientId VARCHAR)";

	@BeforeEach
	void setUp() throws Exception {
		dbFile = tmp.resolve("news.db");
		try (Connection c = DriverManager.getConnection("jdbc:sqlite:" + dbFile);
				Statement st = c.createStatement()) {
			st.execute(CREATE_USER);
			st.execute(CREATE_CONTENTS);
			st.execute("INSERT INTO User (userId,name,password,role,department,departmentCode,active) VALUES "
					+ "('reporter','김기자','" + bcrypt.encode("reporter123") + "','R','사회부','SOC','Y')");
			st.execute("INSERT INTO User (userId,name,password,role,department,departmentCode,active) VALUES "
					+ "('admin','관리자','" + bcrypt.encode("admin123") + "','Z','운영부','ADM','Y')");
			st.execute("INSERT INTO Contents (articleId,title,status,lockerUserId,lockerSessionId,lockerClientId) "
					+ "VALUES ('AKR001','제목','DPS','admin','sess-xyz','client-1')");
		}
	}

	private NewsDb db() {
		return new NewsDb(dbFile.toString());
	}

	@Test
	void findUserReturnsSeededRow() {
		NewsDb.User u = db().findUser("reporter");
		assertNotNull(u);
		assertEquals("R", u.role());
		assertEquals("Y", u.active());
		assertNotNull(u.password());
		assertTrue(bcrypt.matches("reporter123", u.password()));
	}

	@Test
	void findUserReturnsNullForMissing() {
		assertNull(db().findUser("nobody"));
		assertNull(db().findUser(null));
	}

	@Test
	void insertUserThenFindConfirms() {
		Map<String, String> fields = new LinkedHashMap<>();
		fields.put("userId", "newbie");
		fields.put("name", "새사람");
		fields.put("password", bcrypt.encode("pw123"));
		fields.put("role", "R");
		fields.put("department", "사회부");
		fields.put("departmentCode", "SOC");
		int changes = db().insertUser(fields);
		assertEquals(1, changes);

		NewsDb.User u = db().findUser("newbie");
		assertNotNull(u);
		assertEquals("R", u.role());
		assertEquals("Y", u.active(), "active 미지정은 기본 'Y'");
		assertTrue(bcrypt.matches("pw123", u.password()));
	}

	@Test
	void updateUserWhitelistChangesRoleAndReports() {
		assertEquals(1, db().updateUser("reporter", Map.of("role", "D")));
		assertEquals("D", db().findUser("reporter").role());
	}

	@Test
	void updateUserMissingReturnsZeroChanges() {
		assertEquals(0, db().updateUser("nobody", Map.of("role", "D")));
	}

	@Test
	void updateUserRejectsNonWhitelistedColumn() {
		// 화이트리스트 밖 컬럼은 SET에 끼워지지 않는다(SQL 인젝션/의도치 않은 쓰기 표면 차단).
		assertThrows(IllegalArgumentException.class,
				() -> db().updateUser("reporter", Map.of("userId", "hacked")));
	}

	@Test
	void updateUserLockoutFields() {
		int changes = db().updateUser("reporter", Map.of("failedLoginCount", "3", "lockedUntil", "99999999999"));
		assertEquals(1, changes);
		NewsDb.User u = db().findUser("reporter");
		assertEquals("3", u.failedLoginCount());
		assertEquals("99999999999", u.lockedUntil());
	}

	@Test
	void listArticlesOmitsLockerProjectionColumns() {
		List<Map<String, Object>> items = db().listArticles();
		assertEquals(1, items.size());
		Map<String, Object> row = items.get(0);
		assertEquals("AKR001", row.get("articleId"));
		assertFalse(row.containsKey("lockerSessionId"), "lockerSessionId는 목록 투영에서 제거돼야 한다");
		assertFalse(row.containsKey("lockerClientId"), "lockerClientId는 목록 투영에서 제거돼야 한다");
		assertTrue(row.containsKey("lockerUserId"), "lockerUserId는 남는다(제거 대상 2개만)");
	}

	@Test
	void blankDbFileFailsFast() {
		assertThrows(IllegalStateException.class, () -> new NewsDb("  "));
	}
}
