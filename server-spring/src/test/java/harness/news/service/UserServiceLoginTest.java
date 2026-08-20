package harness.news.service;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.zaxxer.hikari.HikariDataSource;
import harness.news.db.NewsDataSource;
import harness.news.model.UserRepository;
import harness.news.model.UserRow;
import harness.news.testsupport.MutableClock;
import harness.news.testsupport.TempNewsDb;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.security.crypto.bcrypt.BCryptPasswordEncoder;

/**
 * 로그인 판정과 계정 잠금 정책 — 리포 루트 {@code src/services/userService.js}와 동형.
 *
 * <p><b>판정 순서가 계약이다</b>: 비활성({@code active='N'}) → 잠금 → 자격. 순서를 바꾸면
 * (1) 비활성 계정에 실패 카운트가 쌓이고 (2) 잠긴 계정이 올바른 비밀번호로 통과한다 —
 * 후자는 {@code contract/cases/auth-negative/login-negative.contract.js} C-2가 직접 단언하는 축이다.
 *
 * <p><b>사용자 열거 방지</b>: 미존재 계정과 비밀번호 불일치의 결과가 완전히 같아야 한다(같은 사유 토큰).
 * 다만 <b>소요 시간</b> 차이는 이 테스트가 잡지 못한다 — 그 사실은 step 요약에 기록돼 있고, 계약 스위트도
 * 타이밍 축을 동결하지 않는다. 더미 해시 비교는 "테스트가 강제하는 것"이 아니라 "이식이 지키는 규율"이다.
 *
 * <p>DB는 임시 파일({@code @TempDir})이고 리포 {@code news.db}는 열지 않는다. 잠금/해제는 전부 UPDATE이며
 * 행을 지우는 경로는 없다(DB 비파괴) — 그래서 만료 후에도 같은 행이 그대로 남아 있음을 단언한다.
 *
 * <p>bcrypt 해시는 <b>테스트가 그 자리에서 만든다</b>(하드코딩 금지 — 비밀 표기 규율). bcryptjs가 만든
 * 해시와의 호환은 Java 테스트가 아니라 step5의 계약 실행(Node {@code seedUsers}로 시드한 DB에 로그인)이 실증한다.
 */
class UserServiceLoginTest {

	private static final String USER_ID = "reporter";

	/** 테스트 픽스처 비밀번호(운영 값 아님). 틀린 비밀번호는 여기에 접미사를 붙여 만든다. */
	private static final String PASSWORD = "fixture-pw-only";

	private static final String WRONG_PASSWORD = PASSWORD + "-wrong";

	private static final long START_MS = 1_700_000_000_000L;

	/** 계약값 — {@code userService.js} {@code LOCKOUT_THRESHOLD}/{@code LOCKOUT_DURATION_MS}. */
	private static final int THRESHOLD = 5;

	private static final long LOCKOUT_MS = 15L * 60L * 1000L;

	/** Node {@code SAFE_FIELDS} — 로그인 응답 user의 키 집합·순서. */
	private static final List<String> SAFE_FIELDS =
			List.of("userId", "name", "role", "department", "departmentCode", "active");

	@TempDir
	Path tempDir;

	private HikariDataSource dataSource;

	private JdbcClient jdbc;

	private UserRepository users;

	private MutableClock clock;

	private UserService service;

	@BeforeEach
	void setUp() {
		TempNewsDb.seed(this.tempDir);
		this.dataSource = NewsDataSource.create(this.tempDir);
		this.jdbc = JdbcClient.create(this.dataSource);
		this.users = new UserRepository(this.jdbc);
		this.clock = new MutableClock(START_MS);
		this.service = new UserService(this.users, this.clock);
		this.users.insert(row(
				"userId", USER_ID, "name", "김기자",
				"password", new BCryptPasswordEncoder().encode(PASSWORD),
				"role", "R", "department", "사회부", "departmentCode", "SOC", "active", "Y"));
	}

	@AfterEach
	void tearDown() {
		if (this.dataSource != null) {
			this.dataSource.close();
		}
	}

	// --- 1. 성공 투영 ---------------------------------------------------------------------------

	@Test
	void successfulLoginProjectsExactlyTheSixSafeFields() {
		UserService.LoginResult result = this.service.login(USER_ID, PASSWORD);

		assertTrue(result.ok());
		assertNull(result.reason());
		assertEquals(SAFE_FIELDS, new ArrayList<>(result.user().keySet()),
				"로그인 응답 user는 SAFE_FIELDS 6키다(GET /api/session의 5키와 다른 shape)");
		assertEquals(USER_ID, result.user().get("userId"));
		assertEquals("김기자", result.user().get("name"));
		assertEquals("R", result.user().get("role"));
		assertEquals("사회부", result.user().get("department"));
		assertEquals("SOC", result.user().get("departmentCode"));
		assertEquals("Y", result.user().get("active"));
	}

	@Test
	void successfulLoginNeverExposesThePasswordOrTheLockMetadata() {
		Map<String, Object> user = this.service.login(USER_ID, PASSWORD).user();

		for (String forbidden : List.of("password", "failedLoginCount", "lockedUntil",
				"lastFailedLoginAt")) {
			assertFalse(user.containsKey(forbidden),
					"응답 투영에 " + forbidden + "이 실리면 자격/계정 열거 단서가 새어 나간다");
		}
	}

	@Test
	void safeFieldsKeepNullColumnsAsNullInsteadOfDroppingTheKey() {
		this.users.update(USER_ID, row("department", null, "departmentCode", null));

		Map<String, Object> user = this.service.login(USER_ID, PASSWORD).user();

		assertEquals(SAFE_FIELDS, new ArrayList<>(user.keySet()),
				"DB NULL은 키를 빼는 것이 아니라 null 값으로 남는다(정확 6키 계약)");
		assertNull(user.get("department"));
		assertNull(user.get("departmentCode"));
	}

	// --- 2. 비활성 우선 -------------------------------------------------------------------------

	@Test
	void inactiveIsDecidedBeforeLockAndBeforeCredentials() {
		// 잠기고 실패가 쌓인 계정을 비활성화한다 — 세 판정이 동시에 성립하는 상황.
		this.users.update(USER_ID, row("active", "N", "failedLoginCount", "4",
				"lockedUntil", String.valueOf(START_MS + LOCKOUT_MS)));

		assertEquals("inactive", this.service.login(USER_ID, PASSWORD).reason(),
				"올바른 비밀번호여도, 잠겨 있어도 비활성이 먼저다");
		assertEquals("inactive", this.service.login(USER_ID, WRONG_PASSWORD).reason());
		assertFalse(this.service.login(USER_ID, PASSWORD).ok());
	}

	@Test
	void inactiveAccountDoesNotAccumulateFailures() {
		this.users.update(USER_ID, row("active", "N"));

		this.service.login(USER_ID, WRONG_PASSWORD);
		this.service.login(USER_ID, WRONG_PASSWORD);

		assertEquals("0", this.users.findById(USER_ID).failedLoginCount(),
				"비활성 계정은 실패 카운트를 올리지 않는다(카운트가 오르면 재활성화 직후 잠긴다)");
		assertNull(this.users.findById(USER_ID).lastFailedLoginAt());
	}

	// --- 3. 임계값 미만 누적 ---------------------------------------------------------------------

	@Test
	void failuresBelowTheThresholdReturnInvalidCredentialsAndAccumulateExactly() {
		for (int attempt = 1; attempt < THRESHOLD; attempt += 1) {
			this.clock.setMillis(START_MS + attempt);

			UserService.LoginResult result = this.service.login(USER_ID, WRONG_PASSWORD);

			assertEquals("invalid-credentials", result.reason(), attempt + "번째 실패의 사유 토큰");
			UserRow row = this.users.findById(USER_ID);
			assertEquals(String.valueOf(attempt), row.failedLoginCount(),
					attempt + "번째 실패 후 카운터");
			assertEquals(String.valueOf(START_MS + attempt), row.lastFailedLoginAt(),
					"마지막 실패 시각은 주입 시계의 epoch ms 문자열이다");
			assertNull(row.lockedUntil(), "임계값 미만에서는 잠기지 않는다");
		}
	}

	// --- 4. 임계값 도달 잠금 ---------------------------------------------------------------------

	@Test
	void theThresholdFailureLocksTheAccountAndTheCorrectPasswordIsThenRejected() {
		for (int attempt = 1; attempt <= THRESHOLD; attempt += 1) {
			assertEquals("invalid-credentials", this.service.login(USER_ID, WRONG_PASSWORD).reason(),
					"임계값째 시도까지는 아직 invalid-credentials다(잠금은 그 시도에서 설정된다)");
		}

		UserRow locked = this.users.findById(USER_ID);
		assertEquals(String.valueOf(THRESHOLD), locked.failedLoginCount());
		assertEquals(String.valueOf(START_MS + LOCKOUT_MS), locked.lockedUntil(),
				"잠금 해제 시각 = now + 15분(epoch ms 문자열)");

		UserService.LoginResult afterLock = this.service.login(USER_ID, PASSWORD);

		assertFalse(afterLock.ok());
		assertEquals("locked", afterLock.reason(),
				"잠긴 계정은 올바른 비밀번호로도 거부된다 — 자격 판정보다 잠금 판정이 우선이다");
		assertNull(afterLock.user());
	}

	/**
	 * 잠금 판정이 자격 판정보다 <b>먼저</b>라는 사실은 틀린 비밀번호에서만 관측된다 — 올바른 비밀번호는
	 * 자격 검사를 통과해 어느 순서로도 {@code locked}에 닿기 때문이다. 계약이 이 축을 직접 쓴다:
	 * {@code login-negative.contract.js} C-3은 이미 잠긴 계정에 <b>틀린 비밀번호</b>를 반복하며
	 * "한도 이전 응답은 423이어야 한다"고 단언한다(순서가 뒤집히면 401 invalid-credentials가 나온다).
	 */
	@Test
	void aLockedAccountAlsoReportsLockedForAWrongPasswordAndStopsCountingUp() {
		lockTheAccount();
		UserRow atLock = this.users.findById(USER_ID);

		assertEquals("locked", this.service.login(USER_ID, WRONG_PASSWORD).reason(),
				"잠금 판정이 자격 판정보다 먼저다 — 뒤집히면 잠긴 계정이 401 invalid-credentials를 낸다");

		UserRow afterProbe = this.users.findById(USER_ID);
		assertEquals(atLock.failedLoginCount(), afterProbe.failedLoginCount(),
				"잠금 중에는 실패를 더 누적하지 않는다");
		assertEquals(atLock.lockedUntil(), afterProbe.lockedUntil(),
				"잠금 창이 시도마다 연장되지 않는다(무한 잠금이 되면 15분 계약이 무의미해진다)");
	}

	@Test
	void lockRemainsUntilTheExactExpiryInstant() {
		lockTheAccount();

		this.clock.setMillis(START_MS + LOCKOUT_MS - 1);
		assertEquals("locked", this.service.login(USER_ID, PASSWORD).reason(),
				"만료 1ms 전은 아직 잠금이다");

		this.clock.setMillis(START_MS + LOCKOUT_MS);
		assertTrue(this.service.login(USER_ID, PASSWORD).ok(),
				"lockedUntil 정각에는 풀린다(Node: until > now — 경계가 1ms 어긋나면 안 된다)");
	}

	// --- 5. 만료 후 성공 + 리셋 -------------------------------------------------------------------

	@Test
	void afterTheLockExpiresLoginSucceedsAndTheCountersAreResetToZeroAndNull() {
		lockTheAccount();
		this.clock.advance(LOCKOUT_MS);

		assertTrue(this.service.login(USER_ID, PASSWORD).ok());

		UserRow row = this.users.findById(USER_ID);
		assertNotNull(row, "리셋은 UPDATE다 — 행을 지우지 않는다(DB 비파괴)");
		assertEquals("0", row.failedLoginCount(), "성공 시 카운터는 문자열 '0'으로 리셋된다");
		assertNull(row.lockedUntil(), "잠금 시각은 SQL NULL로 비운다");
		assertNull(row.lastFailedLoginAt(), "마지막 실패 시각도 SQL NULL로 비운다");
		assertEquals(1, rowCount(), "행 수는 변하지 않는다");
	}

	// --- 6. 사용자 열거 방지 ---------------------------------------------------------------------

	@Test
	void anUnknownAccountAndAWrongPasswordAreIndistinguishable() {
		UserService.LoginResult wrongPassword = this.service.login(USER_ID, WRONG_PASSWORD);
		UserService.LoginResult unknownAccount = this.service.login("ct-nouser-does-not-exist",
				WRONG_PASSWORD);

		assertEquals("invalid-credentials", wrongPassword.reason());
		assertEquals(wrongPassword, unknownAccount,
				"두 결과가 다르면 응답만으로 계정 존재를 알 수 있다(사용자 열거)");
		assertEquals(1, rowCount(), "미존재 계정 로그인은 행을 만들지 않는다");
	}

	@Test
	void aNullPasswordIsComparedAsAnEmptyStringInsteadOfThrowing() {
		assertEquals("invalid-credentials", this.service.login(USER_ID, null).reason());
		assertEquals("invalid-credentials", this.service.login(null, PASSWORD).reason());
	}

	// --- 잠금 컬럼의 저장 표현(decisions (11)) ------------------------------------------------------

	@Test
	void lockColumnsAreStoredAsNodeCompatibleTextValues() {
		lockTheAccount();

		assertEquals("text", sqliteTypeOf("failedLoginCount"));
		assertEquals("text", sqliteTypeOf("lockedUntil"));
		assertEquals("text", sqliteTypeOf("lastFailedLoginAt"));
		assertTrue(rawValueOf("lockedUntil").matches("^\\d{13}$"),
				"lockedUntil은 epoch ms 문자열이다(스키마 주석의 ISO-8601은 드리프트 — 코드가 정본)");
		assertTrue(rawValueOf("lastFailedLoginAt").matches("^\\d{13}$"));
		assertTrue(rawValueOf("failedLoginCount").matches("^\\d+$"));

		this.clock.advance(LOCKOUT_MS);
		this.service.login(USER_ID, PASSWORD);

		assertEquals("text", sqliteTypeOf("failedLoginCount"));
		assertEquals("0", rawValueOf("failedLoginCount"));
		assertEquals("null", sqliteTypeOf("lockedUntil"), "리셋은 빈 문자열이 아니라 SQL NULL이다");
		assertEquals("null", sqliteTypeOf("lastFailedLoginAt"));
	}

	// --- 도우미 ---------------------------------------------------------------------------------

	private void lockTheAccount() {
		for (int attempt = 1; attempt <= THRESHOLD; attempt += 1) {
			this.service.login(USER_ID, WRONG_PASSWORD);
		}
	}

	private String sqliteTypeOf(String column) {
		return this.jdbc.sql("SELECT typeof(" + column + ") FROM User WHERE userId = ?")
				.param(USER_ID).query(String.class).single();
	}

	private String rawValueOf(String column) {
		return this.jdbc.sql("SELECT " + column + " FROM User WHERE userId = ?")
				.param(USER_ID).query(String.class).single();
	}

	private int rowCount() {
		return this.jdbc.sql("SELECT COUNT(*) FROM User").query(Integer.class).single();
	}

	private static Map<String, Object> row(Object... keyValues) {
		Map<String, Object> map = new LinkedHashMap<>();
		for (int i = 0; i < keyValues.length; i += 2) {
			map.put((String) keyValues[i], keyValues[i + 1]);
		}
		return map;
	}
}
