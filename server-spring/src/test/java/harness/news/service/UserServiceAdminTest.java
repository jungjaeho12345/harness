package harness.news.service;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
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
import org.springframework.dao.DataAccessException;
import org.springframework.jdbc.core.simple.JdbcClient;

/**
 * 사용자 생성·수정 — 리포 루트 {@code src/services/userService.js}의 {@code create}/{@code update}와 동형.
 *
 * <p><b>이 클래스는 "고쳐야 할 것으로 알려진 동작"을 의도적으로 고정한다.</b>
 * {@code docs/api-contract/README.md}의 결함 후보 #1·#2가 그것이고, index.json decisions (12)가
 * <b>실측 그대로 재현</b>을 택했다. 지금 Spring에서만 고치면 phase 69가 실행할
 * {@code contract/cases/default/users.contract.js}(정의 밖 role 200 · password 생략 200 · 중복 userId 500을
 * 동결)가 red가 되고, 그러면 "이식 결함"과 "의도된 계약 변경"이 구분되지 않는다.
 * <b>고치는 시점은 Node·Spring·명세·계약 케이스를 한 번에 바꾸는 별도 판단이다(forward_notes (6)).</b>
 *
 * <p>응답 투영 규칙도 Node와 1:1이다: {@code create}는 SAFE_FIELDS 중 <b>요청에 있던 키만</b> 싣는다
 * (Node {@code sanitize}가 {@code undefined}인 필드를 건너뛴다). 반대로 로그인 응답은 DB 행에서
 * 투영하므로 6키가 항상 있고 NULL은 {@code null}로 남는다 — 두 shape을 한 규칙으로 뭉개면 계약이 깨진다.
 */
class UserServiceAdminTest {

	private static final String PASSWORD = "fixture-pw-only";

	/** Node {@code SAFE_FIELDS} 순서. */
	private static final List<String> SAFE_FIELDS =
			List.of("userId", "name", "role", "department", "departmentCode", "active");

	@TempDir
	Path tempDir;

	private HikariDataSource dataSource;

	private UserRepository users;

	private UserService service;

	@BeforeEach
	void setUp() {
		TempNewsDb.seed(this.tempDir);
		this.dataSource = NewsDataSource.create(this.tempDir);
		this.users = new UserRepository(JdbcClient.create(this.dataSource));
		this.service = new UserService(this.users, new MutableClock(1_700_000_000_000L));
	}

	@AfterEach
	void tearDown() {
		if (this.dataSource != null) {
			this.dataSource.close();
		}
	}

	// --- create: 정상 경로 -----------------------------------------------------------------------

	@Test
	void createStoresABcryptHashAndTheAccountCanLogIn() {
		Map<String, Object> user = this.service.create(dto(
				"userId", "ct-new", "name", "새기자", "role", "R",
				"department", "사회부", "departmentCode", "SOC", "password", PASSWORD));

		assertEquals(SAFE_FIELDS, new ArrayList<>(user.keySet()));
		assertEquals("Y", user.get("active"), "active 미지정이면 'Y'다");
		UserRow stored = this.users.findById("ct-new");
		assertNotNull(stored);
		assertNotEquals(PASSWORD, stored.password(), "평문이 저장되면 안 된다");
		assertTrue(stored.password().startsWith("$2a$10$"), "bcrypt cost 10 해시로 저장한다");
		assertTrue(this.service.login("ct-new", PASSWORD).ok());
	}

	@Test
	void createNeverReturnsThePasswordOrTheLockMetadata() {
		Map<String, Object> user = this.service.create(dto(
				"userId", "ct-safe", "name", "이름", "role", "D", "password", PASSWORD));

		for (String forbidden : List.of("password", "failedLoginCount", "lockedUntil",
				"lastFailedLoginAt")) {
			assertFalse(user.containsKey(forbidden), forbidden + "은 응답 투영 밖이다");
		}
	}

	@Test
	void createOmitsSafeFieldsThatWereNotInTheRequest() {
		Map<String, Object> user = this.service.create(dto("userId", "ct-minimal"));

		assertEquals(List.of("userId", "active"), new ArrayList<>(user.keySet()),
				"Node sanitize는 요청에 없던 필드를 응답에 담지 않는다(DB 기본값을 되읽지 않는다)");
	}

	@Test
	void createKeepsAnExplicitActiveValueAndIgnoresUnknownKeys() {
		Map<String, Object> user = this.service.create(dto(
				"userId", "ct-inactive", "name", "휴직", "role", "R", "active", "N",
				"nickname", "화이트리스트 밖 키", "password", PASSWORD));

		assertEquals("N", user.get("active"));
		assertFalse(user.containsKey("nickname"), "응답 투영은 SAFE_FIELDS로 한정된다");
		assertEquals("N", this.users.findById("ct-inactive").active(),
				"화이트리스트 밖 키는 조용히 무시되고 나머지는 그대로 저장된다");
	}

	// --- create: 결함 후보 재현(decisions (12)) ------------------------------------------------------

	/**
	 * 결함 후보 #2 재현 — <b>현행 계약의 재현이며 수정은 별도 판단(decisions (12))</b>이다.
	 * 비밀번호를 생략해도 생성이 성공하고, 그 계정은 <b>빈 비밀번호로 로그인에 성공</b>한다.
	 * (Node: {@code bcrypt.hashSync(String(password ?? ''), 10)} — 입력 검증이 없다.)
	 */
	@Test
	void defectCandidate2_createWithoutAPasswordSucceedsAndTheEmptyPasswordLogsIn() {
		Map<String, Object> user = this.service.create(dto("userId", "ct-nopw", "role", "R"));

		assertEquals("ct-nopw", user.get("userId"));
		assertTrue(this.service.login("ct-nopw", "").ok(),
				"빈 비밀번호가 유효 자격증명이 된다 — 재현 대상이며 여기서 고치지 않는다");
		assertTrue(this.service.login("ct-nopw", null).ok(),
				"비밀번호 미전송도 빈 문자열과 같게 취급된다(Node String(password ?? ''))");
		assertFalse(this.service.login("ct-nopw", "anything-else").ok());
	}

	/**
	 * 결함 후보 #2 재현(role 축) — <b>현행 계약의 재현이며 수정은 별도 판단(decisions (12))</b>이다.
	 * 정의(R/D/Z) 밖 role도 검증 없이 저장되고 응답에 그대로 실린다.
	 */
	@Test
	void defectCandidate2_createDoesNotValidateTheRoleValue() {
		Map<String, Object> user = this.service.create(dto(
				"userId", "ct-role-x", "role", "X", "password", PASSWORD));

		assertEquals("X", user.get("role"));
		assertEquals("X", this.users.findById("ct-role-x").role());
	}

	/**
	 * 결함 후보 #1 재현 — 중복 {@code userId}는 PK 제약 위반 예외 그대로다.
	 * <b>서비스가 삼켜서 4xx 결과로 바꾸지 않는다</b>: 현행 계약은 전역 에러 핸들러가 만드는
	 * {@code 500 {ok:false, reason:'internal-error'}}이고, 그 HTTP shape은 step5가 소유한다.
	 */
	@Test
	void defectCandidate1_createWithADuplicateUserIdPropagatesTheConstraintViolation() {
		this.service.create(dto("userId", "ct-dup", "role", "R", "password", PASSWORD));

		assertThrows(DataAccessException.class,
				() -> this.service.create(dto("userId", "ct-dup", "role", "D", "password", PASSWORD)),
				"여기서 예외를 삼키면 500 internal-error 계약이 깨진다(패리티 측정 불가)");
	}

	// --- update ---------------------------------------------------------------------------------

	@Test
	void updateOfAnUnknownUserIdReportsZeroChanges() {
		assertEquals(0, this.service.update("ct-does-not-exist", dto("role", "Z")),
				"존재 판정을 하지 않는다 — 영향 행 수를 그대로 돌려준다(계약: {ok:true, changes:0})");
	}

	@Test
	void updatePatchesTheGivenFieldsAndReportsTheAffectedRowCount() {
		this.service.create(dto("userId", "ct-patch", "role", "Z", "password", PASSWORD));

		assertEquals(1, this.service.update("ct-patch", dto("role", "R")));
		assertEquals("R", this.users.findById("ct-patch").role());
	}

	@Test
	void updatingThePasswordStoresANewHashAndNeverThePlaintext() {
		this.service.create(dto("userId", "ct-rotate", "role", "R", "password", PASSWORD));
		String before = this.users.findById("ct-rotate").password();
		String next = PASSWORD + "-rotated";

		assertEquals(1, this.service.update("ct-rotate", dto("password", next)));

		String after = this.users.findById("ct-rotate").password();
		assertNotEquals(next, after, "평문이 저장되면 안 된다");
		assertNotEquals(before, after, "해시가 실제로 바뀌어야 한다");
		assertTrue(after.startsWith("$2a$10$"));
		assertTrue(this.service.login("ct-rotate", next).ok());
		assertFalse(this.service.login("ct-rotate", PASSWORD).ok(), "이전 비밀번호는 더 이상 통하지 않는다");
	}

	@Test
	void updateWithoutAPasswordKeyLeavesTheStoredHashUntouched() {
		this.service.create(dto("userId", "ct-keep", "role", "R", "password", PASSWORD));
		String before = this.users.findById("ct-keep").password();

		this.service.update("ct-keep", dto("name", "새 이름"));

		assertEquals(before, this.users.findById("ct-keep").password());
		assertTrue(this.service.login("ct-keep", PASSWORD).ok());
	}

	// --- 도우미 ---------------------------------------------------------------------------------

	private static Map<String, Object> dto(Object... keyValues) {
		Map<String, Object> map = new LinkedHashMap<>();
		for (int i = 0; i < keyValues.length; i += 2) {
			map.put((String) keyValues[i], keyValues[i + 1]);
		}
		return map;
	}
}
