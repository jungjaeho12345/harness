package harness.news.controller;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import harness.news.service.UserService;
import harness.news.testsupport.MutableClock;
import harness.news.testsupport.TempNewsDb;
import harness.news.testsupport.Wire;
import java.nio.file.Path;
import java.time.Clock;
import java.time.Instant;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
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
 * 사용자 목록 {@code GET /api/users}의 <b>와이어</b> 계약 — 역할별 응답 투영.
 *
 * <p>이 라우트의 인증 클래스는 {@code session}이다(<b>Z 전용이 아니다</b>): R·D도 200을 받고 투영만 좁아진다.
 * 그래서 여기서 잠그는 것은 인가 3단이 아니라 <b>두 투영의 키 집합</b>과 그 판정 근거다.
 *
 * <pre>
 * Z    : {"ok":true,"items":[{userId,name,role,department,departmentCode,active}, ...]}  ← SAFE_FIELDS 6키
 * 비-Z : {"ok":true,"items":[{userId,name,department,departmentCode}, ...]}              ← 정확 4키
 * 미인증: 401 {"ok":false,"reason":"unauthenticated"}
 * </pre>
 *
 * <p><b>판정 기준은 요청자의 세션 role이다</b>(ADR-004) — 본문·헤더·쿼리의 {@code role}은 닿지 않는다.
 * {@link #demotionIsReflectedOnTheVeryNextRequestWithoutRelogin()}이 그 사실을 재로그인 없는 강등으로 실증한다.
 *
 * <p><b>키는 값이 없어도 남는다</b>(index.json decisions (5)·(20)): 부서가 비어 있는 계정도
 * {@code "department":null}이며 키를 빼면 "정확 6키/4키"가 값에 따라 무너진다.
 *
 * <p>DB는 이 클래스 전용 임시 사본이다 — 리포 {@code news.db}는 열지 않고, 만든 계정도 지우지 않는다.
 */
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
class UsersListWireTest {

	private static final Path DATA_DIR = TempNewsDb.newDataDir("users-list-wire");

	private static final Pattern SESSION_ID = Pattern.compile("\"sessionId\":\"([0-9a-f]{64})\"");

	/** JSON 객체 하나(중첩 없음) — items 배열의 원소를 원문 그대로 뜯어보기 위한 패턴. */
	private static final Pattern OBJECT = Pattern.compile("\\{[^{}]*\\}");

	/** 객체 원문에서 키 이름만 <b>등장 순서대로</b> 뽑는다(순서까지 계약이다). */
	private static final Pattern KEY = Pattern.compile("\"([A-Za-z]+)\":");

	private static final String PASSWORD = "users-list-pw-1";

	private static final String UNAUTHENTICATED = "{\"ok\":false,\"reason\":\"unauthenticated\"}";

	/** Z 투영 — {@code UserService.SAFE_FIELDS} 순서. */
	private static final List<String> SAFE_KEYS =
			List.of("userId", "name", "role", "department", "departmentCode", "active");

	/** 비-Z 투영 — 정확 4키(role·active 미노출). */
	private static final List<String> PUBLIC_KEYS = List.of("userId", "name", "department", "departmentCode");

	/** 로그인 IP 레이트리밋(15분/10회) 예산을 테스트마다 리셋하기 위한 창 길이. */
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

	@BeforeEach
	void freshLoginBudget() {
		CLOCK.advance(RATE_LIMIT_WINDOW_MS + 1);
	}

	@BeforeEach
	void seedFixtures() {
		ensureUser("ul-z", "Z", "관리자", "편집국", "EDT");
		ensureUser("ul-r", "R", "기자", "사회부", "SOC");
		ensureUser("ul-d", "D", "데스크", "정치부", "POL");
		ensureUser("ul-full", "R", "여섯키", "문화부", "CUL");
		ensureUser("ul-nodept", "R", "부서없음", null, null); // 부서 2컬럼이 SQL NULL인 계정.
		ensureUser("ul-demote", "Z", "강등대상", "국제부", "INT");
	}

	// --- 1. Z 투영 = SAFE_FIELDS 6키 -----------------------------------------------------------

	@Test
	void adminSeesTheSafeFieldsProjectionAndNeverAPassword() {
		Wire.Response response = list(login("ul-z"));

		assertEquals(200, response.status());
		assertEquals("Content-Type: application/json; charset=utf-8", response.line("content-type"));
		assertTrue(response.body().startsWith("{\"ok\":true,\"items\":["), "응답 shape은 {ok,items}다");
		assertEquals("{\"userId\":\"ul-full\",\"name\":\"여섯키\",\"role\":\"R\","
				+ "\"department\":\"문화부\",\"departmentCode\":\"CUL\",\"active\":\"Y\"}",
				objectFor(response.body(), "ul-full"), "Z 명단 원소는 SAFE_FIELDS 6키 그대로다");
		for (String item : items(response.body())) {
			assertEquals(SAFE_KEYS, keysOf(item), "Z 명단 원소의 키 집합·순서가 SAFE_FIELDS와 다르다: " + item);
		}
		assertNoSecret(response);
	}

	// --- 2. 비-Z(R) 투영 = 정확 4키 --------------------------------------------------------------

	@Test
	void reporterSeesExactlyFourFieldsWithoutRoleOrActive() {
		Wire.Response response = list(login("ul-r"));

		assertEquals(200, response.status(), "이 라우트는 Z 전용이 아니다 — 비-Z도 200이다");
		assertEquals("{\"userId\":\"ul-full\",\"name\":\"여섯키\","
				+ "\"department\":\"문화부\",\"departmentCode\":\"CUL\"}",
				objectFor(response.body(), "ul-full"), "비-Z 명단 원소는 정확 4키다");
		for (String item : items(response.body())) {
			assertEquals(PUBLIC_KEYS, keysOf(item), "비-Z 투영에 4필드 밖 키가 있다: " + item);
		}
		assertFalse(response.body().contains("\"role\""), "기자에게 role이 새면 계약 위반이다");
		assertFalse(response.body().contains("\"active\""), "기자에게 active가 새면 계약 위반이다");
		assertNoSecret(response);
	}

	// --- 3. D도 비-Z다(분기 기준은 역할 목록이 아니라 'Z가 아님'이다) -----------------------------

	@Test
	void deskGetsTheSameFourFieldProjectionAsAReporter() {
		Wire.Response desk = list(login("ul-d"));
		Wire.Response reporter = list(login("ul-r"));

		assertEquals(200, desk.status());
		assertEquals(objectFor(reporter.body(), "ul-full"), objectFor(desk.body(), "ul-full"),
				"비-Z 분기는 역할 목록이 아니라 'Z가 아님'으로 갈린다");
		for (String item : items(desk.body())) {
			assertEquals(PUBLIC_KEYS, keysOf(item), "D 투영에 4필드 밖 키가 있다: " + item);
		}
		assertNoSecret(desk);
	}

	// --- 4. 미인증 401 ---------------------------------------------------------------------------

	@Test
	void unauthenticatedListIs401Json() {
		Wire.Response anonymous = Wire.send(this.port, "GET", "/api/users");
		Wire.Response dead = Wire.send(this.port, "GET", "/api/users",
				Map.of("x-session-id", "0".repeat(64)), null);

		assertEquals(401, anonymous.status());
		assertEquals(UNAUTHENTICATED, anonymous.body());
		assertEquals("Content-Type: application/json; charset=utf-8", anonymous.line("content-type"));
		assertEquals(401, dead.status(), "모르는 토큰은 세션이 없는 것과 같다");
		assertEquals(UNAUTHENTICATED, dead.body());
	}

	// --- 5. 강등 반영(신원 재도출 + 역할 분기의 결선) ----------------------------------------------

	@Test
	void demotionIsReflectedOnTheVeryNextRequestWithoutRelogin() {
		this.users.update("ul-demote", Map.of("role", "Z")); // 실행 순서와 무관하게 Z에서 시작한다.
		String sessionId = login("ul-demote");

		Wire.Response asAdmin = list(sessionId);
		assertEquals(200, asAdmin.status());
		assertEquals(SAFE_KEYS, keysOf(objectFor(asAdmin.body(), "ul-full")), "강등 전에는 6키를 받는다");

		this.users.update("ul-demote", Map.of("role", "R")); // DB만 바꾼다 — 재로그인하지 않는다.

		Wire.Response afterDemotion = list(sessionId); // 같은 토큰.
		assertEquals(200, afterDemotion.status());
		assertEquals(PUBLIC_KEYS, keysOf(objectFor(afterDemotion.body(), "ul-full")),
				"role은 매 요청 세션에서 재도출한다(ADR-004) — 로그인 시점 스냅샷이 아니다");
		assertFalse(afterDemotion.body().contains("\"role\""), "강등된 세션에 role이 남으면 권한 상승이다");
		assertNotEquals(asAdmin.body(), afterDemotion.body(), "같은 토큰인데 투영이 바뀌지 않았다");
	}

	// --- 6. 값이 없어도 키는 남는다(decisions (5)·(20)) ------------------------------------------

	@Test
	void missingDepartmentKeepsTheKeyWithANullValue() {
		Wire.Response admin = list(login("ul-z"));
		Wire.Response reporter = list(login("ul-r"));

		assertEquals("{\"userId\":\"ul-nodept\",\"name\":\"부서없음\",\"role\":\"R\","
				+ "\"department\":null,\"departmentCode\":null,\"active\":\"Y\"}",
				objectFor(admin.body(), "ul-nodept"), "Z 투영에서 NULL 컬럼의 키가 사라졌다");
		assertEquals("{\"userId\":\"ul-nodept\",\"name\":\"부서없음\","
				+ "\"department\":null,\"departmentCode\":null}",
				objectFor(reporter.body(), "ul-nodept"), "비-Z 투영에서 NULL 컬럼의 키가 사라졌다");
		assertEquals(SAFE_KEYS, keysOf(objectFor(admin.body(), "ul-nodept")));
		assertEquals(PUBLIC_KEYS, keysOf(objectFor(reporter.body(), "ul-nodept")));
	}

	// --- 도구 ------------------------------------------------------------------------------------

	private Wire.Response list(String sessionId) {
		return Wire.send(this.port, "GET", "/api/users", Map.of("x-session-id", sessionId), null);
	}

	private String login(String userId) {
		Wire.Response response = Wire.json(this.port, "POST", "/api/login", Map.of(),
				"{\"userId\":\"" + userId + "\",\"password\":\"" + PASSWORD + "\"}");
		Matcher matcher = SESSION_ID.matcher(response.body());
		assertTrue(matcher.find(), "로그인 응답에 sessionId가 없다: status=" + response.status());
		return matcher.group(1);
	}

	private void ensureUser(String userId, String role, String name, String department, String departmentCode) {
		Map<String, Object> dto = new LinkedHashMap<>();
		dto.put("userId", userId);
		dto.put("name", name);
		dto.put("role", role);
		if (department != null) {
			dto.put("department", department);
			dto.put("departmentCode", departmentCode);
		}
		dto.put("password", PASSWORD);
		try {
			this.users.create(dto);
		}
		catch (RuntimeException ignored) {
			// 이미 있다(같은 컨텍스트의 다른 테스트가 만들었다) — 픽스처는 멱등이다(행을 지우지 않는다).
		}
	}

	/** items 배열의 원소 객체 원문 전부(중첩 없는 평면 객체라 정규식으로 충분하다). */
	private static List<String> items(String body) {
		List<String> found = new ArrayList<>();
		Matcher matcher = OBJECT.matcher(body);
		while (matcher.find()) {
			found.add(matcher.group());
		}
		assertFalse(found.isEmpty(), "명단이 비어 있다 — 투영을 판정할 원소가 없다");
		return found;
	}

	/** 주어진 {@code userId} 행의 객체 원문. */
	private static String objectFor(String body, String userId) {
		int marker = body.indexOf("\"userId\":\"" + userId + "\"");
		assertTrue(marker >= 0, "명단에 " + userId + " 행이 없다");
		int start = body.lastIndexOf('{', marker);
		int end = body.indexOf('}', marker);
		return body.substring(start, end + 1);
	}

	private static List<String> keysOf(String object) {
		List<String> keys = new ArrayList<>();
		Matcher matcher = KEY.matcher(object);
		while (matcher.find()) {
			keys.add(matcher.group(1));
		}
		return keys;
	}

	/** 어떤 응답에도 {@code password} 키·bcrypt 해시·평문 비밀번호가 없다. */
	private static void assertNoSecret(Wire.Response response) {
		assertFalse(response.body().contains("\"password\""), "password 키가 응답에 실렸다");
		assertFalse(response.body().contains("$2a$"), "bcrypt 해시가 응답에 실렸다");
		assertFalse(response.body().contains(PASSWORD), "평문 비밀번호가 응답에 실렸다");
		assertFalse(response.body().contains("failedLoginCount"), "잠금 메타는 계정 열거 단서다");
		assertFalse(response.body().contains("lockedUntil"), "잠금 메타는 계정 열거 단서다");
		assertFalse(response.body().contains("lastFailedLoginAt"), "잠금 메타는 계정 열거 단서다");
	}
}
