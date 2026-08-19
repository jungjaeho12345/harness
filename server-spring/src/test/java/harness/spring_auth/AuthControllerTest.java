package harness.spring_auth;

import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.header;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import java.nio.file.Path;
import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.Statement;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.security.crypto.bcrypt.BCryptPasswordEncoder;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.MvcResult;
import org.springframework.test.web.servlet.setup.MockMvcBuilders;

/** step4 인증 컨트롤러 — session/login/logout HTTP 계약(MockMvc standalone + 실 컴포넌트 + 임시 시드 DB). */
class AuthControllerTest {

	@TempDir
	Path tmp;

	private MockMvc mvc;
	private final BCryptPasswordEncoder bcrypt = new BCryptPasswordEncoder();
	private static final Pattern SID = Pattern.compile("\"sessionId\":\"([0-9a-f]{64})\"");

	@BeforeEach
	void setUp() throws Exception {
		Path dbFile = tmp.resolve("news.db");
		try (Connection c = DriverManager.getConnection("jdbc:sqlite:" + dbFile);
				Statement st = c.createStatement()) {
			st.execute("CREATE TABLE User (userId TEXT PRIMARY KEY, name TEXT, password TEXT, role TEXT, "
					+ "department TEXT, departmentCode TEXT, active TEXT DEFAULT 'Y', "
					+ "failedLoginCount TEXT DEFAULT '0', lockedUntil TEXT, lastFailedLoginAt TEXT)");
			st.execute("INSERT INTO User (userId,name,password,role,department,departmentCode,active) VALUES "
					+ "('reporter','김기자','" + bcrypt.encode("reporter123") + "','R','사회부','SOC','Y')");
		}
		NewsDb db = new NewsDb(dbFile.toString());
		SessionStore store = new SessionStore();
		SessionGuard guard = new SessionGuard(store, db);
		AuthController controller = new AuthController(new AuthService(db), guard, new SessionCookieWriter(false));
		mvc = MockMvcBuilders.standaloneSetup(controller).build();
	}

	private String login(String userId, String password) throws Exception {
		MvcResult r = mvc.perform(post("/api/login").contentType("application/json")
				.content("{\"userId\":\"" + userId + "\",\"password\":\"" + password + "\"}"))
				.andExpect(status().isOk())
				.andExpect(jsonPath("$.ok").value(true))
				.andExpect(jsonPath("$.user.userId").value(userId))
				.andExpect(jsonPath("$.user.active").exists())
				.andExpect(header().exists("Set-Cookie"))
				.andReturn();
		Matcher m = SID.matcher(r.getResponse().getContentAsString());
		assertTrue(m.find(), "sessionId 64-hex가 있어야 한다");
		return m.group(1);
	}

	@Test
	void sessionWithoutCredentialsIs401Json() throws Exception {
		mvc.perform(get("/api/session"))
				.andExpect(status().isUnauthorized())
				.andExpect(jsonPath("$.ok").value(false))
				.andExpect(jsonPath("$.reason").value("unauthenticated"));
	}

	@Test
	void loginThenSessionReturnsFiveKeyUser() throws Exception {
		String sid = login("reporter", "reporter123");
		mvc.perform(get("/api/session").header("x-session-id", sid))
				.andExpect(status().isOk())
				.andExpect(jsonPath("$.ok").value(true))
				.andExpect(jsonPath("$.user.userId").value("reporter"))
				.andExpect(jsonPath("$.user.role").value("R"))
				.andExpect(jsonPath("$.user.active").doesNotExist())
				.andExpect(jsonPath("$.user.password").doesNotExist());
	}

	@Test
	void invalidCredentialsIs401() throws Exception {
		mvc.perform(post("/api/login").contentType("application/json")
				.content("{\"userId\":\"reporter\",\"password\":\"wrong\"}"))
				.andExpect(status().isUnauthorized())
				.andExpect(jsonPath("$.ok").value(false))
				.andExpect(jsonPath("$.reason").value("invalid-credentials"));
	}

	@Test
	void logoutIsIdempotentAndInvalidatesToken() throws Exception {
		String sid = login("reporter", "reporter123");
		// 세션 없이 로그아웃도 200.
		mvc.perform(post("/api/logout")).andExpect(status().isOk()).andExpect(jsonPath("$.ok").value(true));
		// 로그아웃 후 만료 쿠키.
		mvc.perform(post("/api/logout").header("x-session-id", sid))
				.andExpect(status().isOk())
				.andExpect(jsonPath("$.ok").value(true))
				.andExpect(header().string("Set-Cookie", org.hamcrest.Matchers.containsString("Max-Age=0")));
		// 무효화 실증.
		mvc.perform(get("/api/session").header("x-session-id", sid)).andExpect(status().isUnauthorized());
	}

	@Test
	void singleSessionInvalidatesPreviousToken() throws Exception {
		String first = login("reporter", "reporter123");
		String second = login("reporter", "reporter123");
		assertNotNull(second);
		mvc.perform(get("/api/session").header("x-session-id", first)).andExpect(status().isUnauthorized());
		mvc.perform(get("/api/session").header("x-session-id", second)).andExpect(status().isOk());
	}

	@Test
	void malformedTokenIs401NotError() throws Exception {
		mvc.perform(get("/api/session").header("x-session-id", "not-a-real-token"))
				.andExpect(status().isUnauthorized())
				.andExpect(jsonPath("$.reason").value("unauthenticated"));
	}
}
