package harness.spring_auth;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.put;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import java.nio.file.Path;
import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.Statement;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.security.crypto.bcrypt.BCryptPasswordEncoder;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.setup.MockMvcBuilders;

/** step5 가드 의존 지원 라우트 — users POST/PUT(Z)·logs/digest(Z)·articles(세션). Z/R 세션으로 재도출 게이트 실증. */
class SupportControllerTest {

	@TempDir
	Path tmp;

	private MockMvc mvc;
	private NewsDb db;
	private SessionGuard guard;
	private String zSid;
	private String rSid;
	private final BCryptPasswordEncoder bcrypt = new BCryptPasswordEncoder();

	@BeforeEach
	void setUp() throws Exception {
		Path dbFile = tmp.resolve("news.db");
		try (Connection c = DriverManager.getConnection("jdbc:sqlite:" + dbFile);
				Statement st = c.createStatement()) {
			st.execute("CREATE TABLE User (userId TEXT PRIMARY KEY, name TEXT, password TEXT, role TEXT, "
					+ "department TEXT, departmentCode TEXT, active TEXT DEFAULT 'Y', "
					+ "failedLoginCount TEXT DEFAULT '0', lockedUntil TEXT, lastFailedLoginAt TEXT)");
			st.execute("CREATE TABLE Contents (articleId VARCHAR PRIMARY KEY, title VARCHAR, "
					+ "lockerSessionId VARCHAR, lockerClientId VARCHAR)");
			st.execute("INSERT INTO User (userId,name,password,role,department,departmentCode,active) VALUES "
					+ "('admin','관리자','" + bcrypt.encode("admin123") + "','Z','운영부','ADM','Y')");
			st.execute("INSERT INTO User (userId,name,password,role,department,departmentCode,active) VALUES "
					+ "('reporter','김기자','" + bcrypt.encode("reporter123") + "','R','사회부','SOC','Y')");
		}
		db = new NewsDb(dbFile.toString());
		guard = new SessionGuard(new SessionStore(), db);
		UserService userService = new UserService(db);
		mvc = MockMvcBuilders.standaloneSetup(new SupportController(guard, userService, db)).build();
		zSid = guard.issue("admin");
		rSid = guard.issue("reporter");
	}

	@Test
	void createUserZThenLoginable() throws Exception {
		mvc.perform(post("/api/users").header("x-session-id", zSid).contentType("application/json")
				.content("{\"userId\":\"newbie\",\"name\":\"새사람\",\"role\":\"R\",\"department\":\"사회부\","
						+ "\"departmentCode\":\"SOC\",\"password\":\"pw123\"}"))
				.andExpect(status().isOk())
				.andExpect(jsonPath("$.ok").value(true));
		assertNotNull(db.findUser("newbie"));
		assertTrue(new AuthService(db).login("newbie", "pw123").ok(), "생성 계정은 로그인 가능해야 한다(해시 저장)");
	}

	@Test
	void createUserUnauthenticatedIs401() throws Exception {
		mvc.perform(post("/api/users").contentType("application/json").content("{\"userId\":\"x\"}"))
				.andExpect(status().isUnauthorized())
				.andExpect(jsonPath("$.reason").value("unauthenticated"));
	}

	@Test
	void createUserNonZIs403() throws Exception {
		mvc.perform(post("/api/users").header("x-session-id", rSid).contentType("application/json")
				.content("{\"userId\":\"x\",\"password\":\"p\"}"))
				.andExpect(status().isForbidden())
				.andExpect(jsonPath("$.reason").value("forbidden"));
	}

	@Test
	void updateUserZReturnsChangesOne() throws Exception {
		mvc.perform(put("/api/users/reporter").header("x-session-id", zSid).contentType("application/json")
				.content("{\"role\":\"D\"}"))
				.andExpect(status().isOk())
				.andExpect(jsonPath("$.ok").value(true))
				.andExpect(jsonPath("$.changes").value(1));
		assertEquals("D", db.findUser("reporter").role());

		mvc.perform(put("/api/users/reporter").header("x-session-id", zSid).contentType("application/json")
				.content("{\"active\":\"N\"}"))
				.andExpect(status().isOk())
				.andExpect(jsonPath("$.changes").value(1));
		assertEquals("N", db.findUser("reporter").active());
	}

	@Test
	void updateUserNonZIs403() throws Exception {
		mvc.perform(put("/api/users/admin").header("x-session-id", rSid).contentType("application/json")
				.content("{\"role\":\"R\"}"))
				.andExpect(status().isForbidden());
	}

	@Test
	void logsDigestZHasItemsAndOkKeys() throws Exception {
		mvc.perform(get("/api/logs/digest").header("x-session-id", zSid))
				.andExpect(status().isOk())
				.andExpect(jsonPath("$.ok").value(true))
				.andExpect(jsonPath("$.items").isArray());
	}

	@Test
	void logsDigestNonZIs403Forbidden() throws Exception {
		mvc.perform(get("/api/logs/digest").header("x-session-id", rSid))
				.andExpect(status().isForbidden())
				.andExpect(jsonPath("$.reason").value("forbidden"));
	}

	@Test
	void articlesDeadTokenIs401() throws Exception {
		mvc.perform(get("/api/articles").header("x-session-id", "deadtoken"))
				.andExpect(status().isUnauthorized())
				.andExpect(jsonPath("$.reason").value("unauthenticated"));
	}

	@Test
	void demotionReflectedImmediatelyOnGuardRoute() throws Exception {
		// Z 세션이 로그인 상태에서 DB role을 R로 강등하면, 재로그인 없이 다음 요청이 403(재도출 실증).
		String sid = guard.issue("admin");
		mvc.perform(get("/api/logs/digest").header("x-session-id", sid)).andExpect(status().isOk());
		db.updateUser("admin", java.util.Map.of("role", "R"));
		mvc.perform(get("/api/logs/digest").header("x-session-id", sid)).andExpect(status().isForbidden());
	}
}
