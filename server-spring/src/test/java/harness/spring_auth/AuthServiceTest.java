package harness.spring_auth;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.nio.file.Path;
import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.Statement;
import java.util.concurrent.atomic.AtomicLong;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.security.crypto.bcrypt.BCryptPasswordEncoder;

/** step4 로그인 정책 — 자격 검증·계정잠금(5회/15분)·열거 방지. 임시 시드 DB + 주입 시계로 결정적 검증. */
class AuthServiceTest {

	@TempDir
	Path tmp;

	private Path dbFile;
	private final AtomicLong now = new AtomicLong(1_000_000_000L);
	private final BCryptPasswordEncoder bcrypt = new BCryptPasswordEncoder();

	@BeforeEach
	void setUp() throws Exception {
		dbFile = tmp.resolve("news.db");
		try (Connection c = DriverManager.getConnection("jdbc:sqlite:" + dbFile);
				Statement st = c.createStatement()) {
			st.execute("CREATE TABLE User (userId TEXT PRIMARY KEY, name TEXT, password TEXT, role TEXT, "
					+ "department TEXT, departmentCode TEXT, active TEXT DEFAULT 'Y', "
					+ "failedLoginCount TEXT DEFAULT '0', lockedUntil TEXT, lastFailedLoginAt TEXT)");
			st.execute("INSERT INTO User (userId,name,password,role,department,departmentCode,active) VALUES "
					+ "('reporter','김기자','" + bcrypt.encode("reporter123") + "','R','사회부','SOC','Y')");
			st.execute("INSERT INTO User (userId,name,password,role,department,departmentCode,active) VALUES "
					+ "('gone','간유저','" + bcrypt.encode("pw") + "','R','부서','X','N')");
		}
	}

	private AuthService svc() {
		return new AuthService(new NewsDb(dbFile.toString()), now::get);
	}

	@Test
	void successReturnsSixKeyUserWithoutPassword() {
		AuthService.Result r = svc().login("reporter", "reporter123");
		assertTrue(r.ok());
		assertEquals(java.util.Set.of("userId", "name", "role", "department", "departmentCode", "active"),
				r.user().keySet());
		assertFalse(r.user().containsKey("password"));
		assertEquals("R", r.user().get("role"));
	}

	@Test
	void wrongPasswordAndUnknownUserAreIndistinguishable() {
		AuthService.Result wrong = svc().login("reporter", "nope");
		AuthService.Result unknown = svc().login("ghost-user", "nope");
		assertFalse(wrong.ok());
		assertFalse(unknown.ok());
		assertEquals("invalid-credentials", wrong.reason());
		assertEquals("invalid-credentials", unknown.reason());
		assertNull(wrong.user());
		assertNull(unknown.user());
	}

	@Test
	void lockoutAfterFiveFailuresThenLockedEvenWithCorrectPassword() {
		AuthService svc = svc();
		for (int i = 1; i <= 5; i++) {
			AuthService.Result r = svc.login("reporter", "wrong" + i);
			assertEquals("invalid-credentials", r.reason(), i + "번째 실패는 invalid-credentials(잠금은 그 시도에서 설정)");
		}
		// 잠긴 계정은 올바른 비밀번호로도 423(locked).
		AuthService.Result locked = svc.login("reporter", "reporter123");
		assertEquals("locked", locked.reason());
	}

	@Test
	void successBeforeThresholdResetsFailureCount() {
		AuthService svc = svc();
		svc.login("reporter", "wrong1");
		svc.login("reporter", "wrong2");
		assertTrue(svc.login("reporter", "reporter123").ok()); // 성공이 카운트 리셋
		// 리셋 후 다시 4회 실패해도 아직 안 잠긴다(카운트가 0에서 다시 시작).
		for (int i = 0; i < 4; i++) {
			assertEquals("invalid-credentials", svc.login("reporter", "x").reason());
		}
		assertTrue(svc.login("reporter", "reporter123").ok());
	}

	@Test
	void lockExpiresAfterWindow() {
		AuthService svc = svc();
		for (int i = 0; i < 5; i++) {
			svc.login("reporter", "wrong");
		}
		assertEquals("locked", svc.login("reporter", "reporter123").reason());
		// 15분 창 경과 후 잠금 해제.
		now.addAndGet(AuthService.LOCKOUT_DURATION_MS + 1);
		assertTrue(svc.login("reporter", "reporter123").ok());
	}

	@Test
	void inactiveAccountRejectedAsInactive() {
		assertEquals("inactive", svc().login("gone", "pw").reason());
	}

	@Test
	void blankOrNullUserIsInvalidCredentials() {
		assertEquals("invalid-credentials", svc().login(null, "x").reason());
		assertEquals("invalid-credentials", svc().login("", "x").reason());
	}
}
