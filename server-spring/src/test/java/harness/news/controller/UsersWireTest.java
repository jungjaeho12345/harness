package harness.news.controller;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import harness.news.model.UserRepository;
import harness.news.model.UserRow;
import harness.news.service.UserService;
import harness.news.testsupport.MutableClock;
import harness.news.testsupport.TempNewsDb;
import harness.news.testsupport.Wire;
import java.nio.file.Path;
import java.time.Clock;
import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.context.TestConfiguration;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Primary;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;

/**
 * 사용자 쓰기 2라우트({@code POST /api/users} · {@code PUT /api/users/:id})의 <b>와이어</b> 계약.
 *
 * <p>이 두 라우트는 {@code contract/cases/default/session-guard.contract.js}의 <b>픽스처 수단</b>이다 —
 * 그 파일이 계정을 만들고, 강등하고, 비활성화해서 세션 가드 축을 검증한다. 그래서 여기서 잠그는 것은
 * 도메인 CRUD가 아니라 <b>인가 3단</b>(미인증 401 · 비-Z 403 · Z 200)과 응답 shape이다.
 *
 * <p>동결된 응답 shape(Node 실측):
 * <pre>
 * POST 200 : {"ok":true,"user":{...정의된 SAFE_FIELDS만...}}   ← password 키는 어떤 경우에도 없다
 * PUT  200 : {"ok":true,"changes":&lt;영향 행 수&gt;}              ← 없는 id도 200 + changes:0(404 아님)
 * 거부     : {"ok":false,"reason":"unauthenticated"|"forbidden"}
 * </pre>
 *
 * <p><b>결함 후보 재현(index.json decisions (12))</b>: 중복 {@code userId} 500 · 입력 검증 부재는
 * 현행 계약을 그대로 재현한 것이며 <b>수정은 별도 판단</b>이다(아래 {@code defectCandidate*} 테스트).
 *
 * <p>DB는 이 클래스 전용 임시 사본이다 — 리포 {@code news.db}는 열지 않고, 만든 계정도 지우지 않는다.
 */
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
class UsersWireTest {

	private static final Path DATA_DIR = TempNewsDb.newDataDir("users-wire");

	private static final Pattern SESSION_ID = Pattern.compile("\"sessionId\":\"([0-9a-f]{64})\"");

	private static final String PASSWORD = "users-wire-pw-1";

	private static final String UNAUTHENTICATED = "{\"ok\":false,\"reason\":\"unauthenticated\"}";

	private static final String FORBIDDEN = "{\"ok\":false,\"reason\":\"forbidden\"}";

	/** step7의 로그인 IP 레이트리밋(15분/10회) 예산을 테스트마다 리셋하기 위한 창 길이. */
	private static final long RATE_LIMIT_WINDOW_MS = 15L * 60L * 1000L;

	private static final MutableClock CLOCK = new MutableClock(Instant.parse("2026-08-20T00:00:00Z").toEpochMilli());

	@TestConfiguration
	static class MutableClockConfig {

		@Bean
		@Primary
		Clock mutableClock() {
			return CLOCK;
		}

	}

	@DynamicPropertySource
	static void dataDir(DynamicPropertyRegistry registry) {
		registry.add("app.data-dir", () -> DATA_DIR.toAbsolutePath().toString());
	}

	@Value("${local.server.port}")
	private int port;

	/** 픽스처 계정 생성 전용(테스트 대상은 HTTP 경로다). */
	@Autowired
	private UserService users;

	/** "거부된 요청이 행을 만들지 않았다"는 <b>음성 증거</b>를 DB에서 직접 확인한다. */
	@Autowired
	private UserRepository rows;

	@BeforeEach
	void freshLoginBudget() {
		CLOCK.advance(RATE_LIMIT_WINDOW_MS + 1);
	}

	@BeforeEach
	void seedFixtures() {
		ensureUser("uw-z", "Z");
		ensureUser("uw-r", "R");
		ensureUser("uw-d", "D");
	}

	// --- 1. Z 생성 -------------------------------------------------------------------------------

	@Test
	void adminCreatesAUserAndTheResponseNeverCarriesThePassword() {
		String body = "{\"userId\":\"uw-new\",\"name\":\"새사람\",\"role\":\"R\","
				+ "\"department\":\"사회부\",\"departmentCode\":\"SOC\",\"password\":\"" + PASSWORD + "\"}";

		Wire.Response response = post(login("uw-z"), body);

		assertEquals(200, response.status());
		assertEquals("{\"ok\":true,\"user\":{\"userId\":\"uw-new\",\"name\":\"새사람\",\"role\":\"R\","
				+ "\"department\":\"사회부\",\"departmentCode\":\"SOC\",\"active\":\"Y\"}}", response.body(),
				"응답 user는 요청에 있던 SAFE_FIELDS + 기본 active='Y'다(password 키 없음)");
		assertNoSecret(response, PASSWORD);
		assertEquals("Content-Type: application/json; charset=utf-8", response.line("content-type"));
		assertNotNull(this.rows.findById("uw-new"));
	}

	// --- 2·3. 인가 3단(미인증 401 · 비-Z 403 · Z 200) -----------------------------------------------

	@Test
	void nonAdminSessionsAreForbiddenOnBothWriteRoutes() {
		for (String userId : java.util.List.of("uw-r", "uw-d")) {
			String sessionId = login(userId);

			Wire.Response created = post(sessionId, "{\"userId\":\"uw-denied-" + userId + "\"}");
			assertEquals(403, created.status(), userId + " 세션은 Z가 아니다");
			assertEquals(FORBIDDEN, created.body());

			Wire.Response updated = put(sessionId, "uw-z", "{\"name\":\"바뀌면안됨\"}");
			assertEquals(403, updated.status());
			assertEquals(FORBIDDEN, updated.body());

			assertNull(this.rows.findById("uw-denied-" + userId), "거부된 요청이 행을 만들었다");
			assertEquals("uw-z", this.rows.findById("uw-z").name(), "거부된 요청이 값을 바꿨다");
		}
	}

	@Test
	void unauthenticatedWritesAre401() {
		Wire.Response created = Wire.json(this.port, "POST", "/api/users", Map.of(),
				"{\"userId\":\"uw-anon\"}");
		Wire.Response updated = Wire.json(this.port, "PUT", "/api/users/uw-z", Map.of(),
				"{\"name\":\"바뀌면안됨\"}");
		Wire.Response dead = Wire.json(this.port, "POST", "/api/users", Map.of("x-session-id", "0".repeat(64)),
				"{\"userId\":\"uw-anon2\"}");

		assertEquals(401, created.status());
		assertEquals(UNAUTHENTICATED, created.body());
		assertEquals(401, updated.status());
		assertEquals(UNAUTHENTICATED, updated.body());
		assertEquals(401, dead.status(), "모르는 토큰은 세션이 없는 것과 같다");
		assertEquals(UNAUTHENTICATED, dead.body());
		assertNull(this.rows.findById("uw-anon"));
		assertNull(this.rows.findById("uw-anon2"));
		assertEquals("uw-z", this.rows.findById("uw-z").name());
	}

	// --- 4. 수정 --------------------------------------------------------------------------------

	@Test
	void adminUpdateAppliesAndReportsTheAffectedRowCount() {
		this.users.create(dto("uw-target", "R"));
		String sessionId = login("uw-z");

		Wire.Response response = put(sessionId, "uw-target", "{\"role\":\"D\"}");

		assertEquals(200, response.status());
		assertEquals("{\"ok\":true,\"changes\":1}", response.body(), "수정 응답은 user 객체를 돌려주지 않는다");
		assertEquals("D", this.rows.findById("uw-target").role());
	}

	@Test
	void updatingAnUnknownUserIdIsStill200WithZeroChanges() {
		Wire.Response response = put(login("uw-z"), "uw-does-not-exist", "{\"name\":\"noop\"}");

		assertEquals(200, response.status(), "존재 판정을 하지 않는다 — 404가 아니다(동결된 계약)");
		assertEquals("{\"ok\":true,\"changes\":0}", response.body());
	}

	// --- 5. 클라이언트 role 불신(ADR-004) ----------------------------------------------------------

	@Test
	void theRoleInTheRequestBodyNeverInfluencesAuthorization() {
		String sessionId = login("uw-r");

		Wire.Response created = post(sessionId, "{\"userId\":\"uw-escalated\",\"role\":\"Z\"}");
		Wire.Response updated = put(sessionId, "uw-r", "{\"role\":\"Z\"}");

		assertEquals(403, created.status(), "본문 role로 게이트가 열리면 누구나 Z가 된다");
		assertEquals(FORBIDDEN, created.body());
		assertEquals(403, updated.status());
		assertEquals(FORBIDDEN, updated.body());
		assertNull(this.rows.findById("uw-escalated"));
		assertEquals("R", this.rows.findById("uw-r").role(), "자기 자신을 Z로 올리지 못한다");
	}

	// --- 6. 강등 왕복(세션 가드 + 역할 게이트의 결선) -------------------------------------------------

	@Test
	void demotingAnAdminBlocksTheSameTokenOnTheNextRequest() {
		this.users.create(dto("uw-demote", "Z"));
		String sessionId = login("uw-demote");

		assertEquals(200, post(sessionId, "{\"userId\":\"uw-before-demote\"}").status(),
				"강등 전에는 Z 전용 라우트를 통과한다");

		Wire.Response demote = put(sessionId, "uw-demote", "{\"role\":\"R\"}");
		assertEquals(200, demote.status());
		assertEquals("{\"ok\":true,\"changes\":1}", demote.body());

		// 같은 토큰 — 재로그인하지 않는다. 가드가 없으면 여기서 200이 나온다(권한 상승).
		Wire.Response after = post(sessionId, "{\"userId\":\"uw-after-demote\"}");

		assertEquals(403, after.status(), "강등은 재로그인 없이 다음 요청부터 반영된다(ADR-004)");
		assertEquals(FORBIDDEN, after.body());
		assertNull(this.rows.findById("uw-after-demote"));
	}

	// --- 7·8. 결함 후보 재현(decisions (12) — 여기서 고치지 않는다) ---------------------------------

	/**
	 * <b>결함 후보 #1의 재현이며 수정은 별도 판단이다(decisions (12) · forward_notes (6)).</b>
	 * 중복 {@code userId}는 400·409가 아니라 제약 위반 예외 → 전역 핸들러 → 500 {@code internal-error}다.
	 * {@code users.contract.js}가 이 관측을 {@code server-error} 태그로 동결했다.
	 */
	@Test
	void defectCandidate1_duplicateUserIdIs500InternalErrorNotAConflict() {
		String sessionId = login("uw-z");
		String body = "{\"userId\":\"uw-dup\",\"password\":\"" + PASSWORD + "\"}";
		assertEquals(200, post(sessionId, body).status());

		Wire.Response duplicate = post(sessionId, body);

		assertEquals(500, duplicate.status());
		assertEquals("{\"ok\":false,\"reason\":\"internal-error\"}", duplicate.body());
		assertNoSecret(duplicate, PASSWORD);
	}

	/**
	 * <b>결함 후보 #2의 재현이며 수정은 별도 판단이다(decisions (12) · forward_notes (6)).</b>
	 * 정의 밖 {@code role} 값도, 비밀번호 없는 생성도 200이다(입력 검증이 없다).
	 * {@code active:'N'}으로 만드는 것은 로그인 가능한 빈 비밀번호 계정을 남기지 않기 위해서다
	 * ({@code users.contract.js}의 같은 케이스와 동형).
	 */
	@Test
	void defectCandidate2_undefinedRoleAndMissingPasswordAreAccepted() {
		Wire.Response response = post(login("uw-z"), "{\"userId\":\"uw-loose\",\"role\":\"X\",\"active\":\"N\"}");

		assertEquals(200, response.status());
		assertEquals("{\"ok\":true,\"user\":{\"userId\":\"uw-loose\",\"role\":\"X\",\"active\":\"N\"}}",
				response.body(), "요청에 없던 SAFE_FIELDS는 응답에 키 자체가 없다");
		UserRow stored = this.rows.findById("uw-loose");
		assertEquals("X", stored.role(), "R/D/Z 검증이 없다 — 그대로 저장된다");
		assertTrue(stored.password().startsWith("$2a$10$"), "비밀번호 미전송이면 빈 문자열이 해시된다");
	}

	// --- 9. 퍼센트 인코딩 경로로 인가를 우회할 수 없다 -----------------------------------------------

	/**
	 * Spring 디스패처는 세그먼트를 <b>디코딩해</b> 매칭하므로 {@code /api/user%73}에도 실제 핸들러가 실행된다
	 * (step7 실측: {@code /api/lo%67in}이 로그인 핸들러에 도달했다). 원문 경로만 보는 경로 정책 필터는 이
	 * 요청을 지나치지만, <b>역할 게이트가 컨트롤러 안에 있으므로</b> 인가는 그대로 성립해야 한다.
	 * 이 테스트가 그 사실을 잠근다 — 게이트를 필터로 옮기면 여기서 red가 난다.
	 */
	@Test
	void percentEncodedUsersPathCannotBypassTheGate() {
		Wire.Response anonymous = Wire.json(this.port, "POST", "/api/user%73", Map.of(),
				"{\"userId\":\"uw-encoded-anon\"}");
		Wire.Response reporter = Wire.json(this.port, "POST", "/api/user%73",
				Map.of("x-session-id", login("uw-r")), "{\"userId\":\"uw-encoded-r\",\"role\":\"Z\"}");

		assertEquals(401, anonymous.status(), "인코딩된 경로로 미인증 생성이 성립하면 인가 우회다");
		assertEquals(UNAUTHENTICATED, anonymous.body());
		assertEquals(403, reporter.status(), "인코딩된 경로로 비-Z 생성이 성립하면 권한 상승이다");
		assertEquals(FORBIDDEN, reporter.body());
		assertNull(this.rows.findById("uw-encoded-anon"));
		assertNull(this.rows.findById("uw-encoded-r"));

		// 위 401/403이 "핸들러가 없어서"가 아니라 "게이트가 막아서"임을 같은 자리에서 실증한다:
		// Z 세션은 인코딩된 경로로도 실제 생성에 성공한다(= 이 경로는 살아 있는 표면이다).
		Wire.Response admin = Wire.json(this.port, "POST", "/api/user%73",
				Map.of("x-session-id", login("uw-z")), "{\"userId\":\"uw-encoded-z\"}");
		assertEquals(200, admin.status(), "디코딩된 경로는 실제 핸들러에 도달한다");
		assertNotNull(this.rows.findById("uw-encoded-z"));
	}

	// --- 도구 ------------------------------------------------------------------------------------

	private Wire.Response post(String sessionId, String body) {
		return Wire.json(this.port, "POST", "/api/users", Map.of("x-session-id", sessionId), body);
	}

	private Wire.Response put(String sessionId, String userId, String body) {
		return Wire.json(this.port, "PUT", "/api/users/" + userId, Map.of("x-session-id", sessionId), body);
	}

	private String login(String userId) {
		Wire.Response response = Wire.json(this.port, "POST", "/api/login", Map.of(),
				"{\"userId\":\"" + userId + "\",\"password\":\"" + PASSWORD + "\"}");
		Matcher matcher = SESSION_ID.matcher(response.body());
		assertTrue(matcher.find(), "로그인 응답에 sessionId가 없다: status=" + response.status());
		return matcher.group(1);
	}

	private void ensureUser(String userId, String role) {
		try {
			this.users.create(dto(userId, role));
		}
		catch (RuntimeException ignored) {
			// 이미 있다(같은 컨텍스트의 다른 테스트가 만들었다) — 픽스처는 멱등이다(행을 지우지 않는다).
		}
	}

	private static Map<String, Object> dto(String userId, String role) {
		Map<String, Object> dto = new LinkedHashMap<>();
		dto.put("userId", userId);
		dto.put("name", userId);
		dto.put("role", role);
		dto.put("password", PASSWORD);
		return dto;
	}

	/** 응답 어디에도 평문 비밀번호·bcrypt 해시·{@code password} 키가 없어야 한다. */
	private static void assertNoSecret(Wire.Response response, String plaintext) {
		assertFalse(response.body().contains("\"password\""), "password 키가 응답에 실렸다");
		assertFalse(response.body().contains("$2a$"), "bcrypt 해시가 응답에 실렸다");
		assertFalse(response.body().contains(plaintext), "평문 비밀번호가 응답에 실렸다");
	}
}
