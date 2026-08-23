package harness.news.web;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import harness.news.service.UserService;
import harness.news.testsupport.TempNewsDb;
import harness.news.testsupport.Wire;
import java.nio.file.Path;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;

/**
 * 수집 수신 설정 3라우트의 <b>와이어</b> 계약 — {@code receiver-config.contract.js}가 잠그는 축을 Java에서
 * 직접 확인한다(전 기동 RANDOM_PORT + 원시 HTTP + 전용 임시 DB · {@code PathPolicyWireTest} 패턴).
 *
 * <p>세 축: (1) 3라우트 전부 Z 전용(미인증 401 · 비-Z 403) — 게이트는 서비스가 세션 토큰으로 판정한다.
 * (2) 응답 투영은 SAFE_FIELDS 10키뿐이고 {@code password}·{@code apiKey}·시크릿 원문·세션 토큰은 어떤
 * 응답에도 없다. (3) 삭제는 이 서버 유일의 행 삭제이며 {@code changes} 멱등(재삭제·NaN id → 0)이다.
 */
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
class ReceiverConfigWireTest {

	private static final Path DATA_DIR = TempNewsDb.newDataDir("receiver-config-wire");

	private static final Pattern SESSION_ID = Pattern.compile("\"sessionId\":\"([0-9a-f]{64})\"");

	private static final Pattern ID = Pattern.compile("\"id\":(\\d+)");

	/** 64-hex 세션 토큰이 응답 본문에 새면 안 된다 — 원문 탐지 정규식. */
	private static final Pattern SESSION_TOKEN = Pattern.compile("[0-9a-f]{64}");

	@DynamicPropertySource
	static void dataDir(DynamicPropertyRegistry registry) {
		registry.add("app.data-dir", () -> DATA_DIR.toAbsolutePath().toString());
	}

	/** 로그인은 IP 레이트리밋(15분/10회) 대상이라 역할별로 <b>한 번만</b> 로그인하고 세션을 재사용한다. */
	private static String adminToken;

	private static String reporterToken;

	@Value("${local.server.port}")
	private int port;

	@Autowired
	private UserService users;

	@BeforeEach
	void seedUsers() {
		seedUser("rc-admin", "rc-admin-pw", "Z");
		seedUser("rc-reporter", "rc-reporter-pw", "R");
	}

	private void seedUser(String userId, String password, String role) {
		Map<String, Object> dto = new LinkedHashMap<>();
		dto.put("userId", userId);
		dto.put("password", password);
		dto.put("role", role);
		dto.put("name", userId);
		try {
			this.users.create(dto);
		}
		catch (RuntimeException ignored) {
			// 이미 있다 — 픽스처는 멱등이다(행을 지우지 않는다).
		}
	}

	private String login(String userId, String password) {
		Wire.Response response = Wire.json(this.port, "POST", "/api/login", Map.of(),
				"{\"userId\":\"" + userId + "\",\"password\":\"" + password + "\"}");
		Matcher matcher = SESSION_ID.matcher(response.body());
		assertTrue(matcher.find(), "로그인 응답에 sessionId가 없다: " + response.status());
		return matcher.group(1);
	}

	private String adminSid() {
		if (adminToken == null) {
			adminToken = login("rc-admin", "rc-admin-pw");
		}
		return adminToken;
	}

	private String reporterSid() {
		if (reporterToken == null) {
			reporterToken = login("rc-reporter", "rc-reporter-pw");
		}
		return reporterToken;
	}

	private Map<String, String> sid(String sessionId) {
		return Map.of("x-session-id", sessionId);
	}

	private long createConfig(String sid, String json) {
		Wire.Response res = Wire.json(this.port, "POST", "/api/receiver-config", sid(sid), json);
		assertEquals(200, res.status(), "픽스처 생성 상태: " + res.body());
		Matcher matcher = ID.matcher(res.body());
		assertTrue(matcher.find(), "생성 응답에 id가 없다: " + res.body());
		return Long.parseLong(matcher.group(1));
	}

	private static void assertNoSecret(Wire.Response res, String... plaintexts) {
		String body = res.body();
		assertFalse(body.contains("\"password\""), "password 키가 응답에 실렸다");
		assertFalse(body.contains("\"apiKey\""), "apiKey 키가 응답에 실렸다");
		assertFalse(SESSION_TOKEN.matcher(body).find(), "64-hex 세션 토큰이 응답에 실렸다");
		for (String value : plaintexts) {
			if (value != null) {
				assertFalse(body.contains(value), "시크릿 원문이 응답에 실렸다");
			}
		}
	}

	@Test
	void adminCreatesConfigResponseIsExactlyOkAndId() {
		String secret = "ftp-secret-" + Long.toHexString(System.nanoTime());
		Wire.Response res = Wire.json(this.port, "POST", "/api/receiver-config", sid(adminSid()),
				"{\"sourceId\":\"wire-src-a\",\"type\":\"FTP\",\"name\":\"wire-recv-a\","
						+ "\"host\":\"127.0.0.1\",\"port\":\"21\",\"username\":\"wire-user\","
						+ "\"password\":\"" + secret + "\",\"active\":\"Y\"}");

		assertEquals(200, res.status());
		assertTrue(res.body().matches("\\{\"ok\":true,\"id\":\\d+\\}"), "생성 응답은 정확히 {ok,id}: " + res.body());
		assertNoSecret(res, secret);
	}

	@Test
	void adminListProjectsSafeFieldsOnlyWithCreatedAtNull() {
		String secret = "ftp-secret-" + Long.toHexString(System.nanoTime());
		createConfig(adminSid(),
				"{\"sourceId\":\"wire-src-list\",\"type\":\"FTP\",\"name\":\"wire-recv-list\","
						+ "\"host\":\"127.0.0.1\",\"port\":\"21\",\"username\":\"wire-user-list\","
						+ "\"password\":\"" + secret + "\",\"active\":\"Y\"}");

		Wire.Response res = Wire.send(this.port, "GET",
				"/api/receiver-config?sourceId=wire-src-list", sid(adminSid()), null);

		assertEquals(200, res.status());
		String body = res.body();
		assertTrue(body.startsWith("{\"ok\":true,\"items\":["), "목록 봉투 shape: " + body);
		// SAFE_FIELDS 10키 전부 존재하고 password·apiKey는 없다. createdAt은 서버가 채우지 않아 null이다.
		for (String key : new String[] { "id", "sourceId", "type", "name", "host", "port", "apiEndpoint",
				"active", "createdAt", "username" }) {
			assertTrue(body.contains("\"" + key + "\":"), key + " 키가 목록 원소에 없다: " + body);
		}
		assertTrue(body.contains("\"createdAt\":null"), "createdAt은 null이어야 한다(서버 미stamp): " + body);
		assertNoSecret(res, secret);
	}

	@Test
	void listFilterIsWhitelistedAndCommaValueIsNotSplit() {
		long id = createConfig(adminSid(),
				"{\"sourceId\":\"wire-src-filter\",\"type\":\"FTP\",\"name\":\"wire-recv-filter\",\"active\":\"Y\"}");

		// id 필터 — 정확히 자기 행 1건(삭제 검증 케이스가 이 화이트리스트 키에 의존한다).
		Wire.Response byId = Wire.send(this.port, "GET", "/api/receiver-config?id=" + id, sid(adminSid()), null);
		assertEquals(200, byId.status());
		assertEquals(1, countItems(byId.body()), "id 필터는 자기 행 1건: " + byId.body());

		// 콤마를 포함한 필터 값은 분해되지 않는다 — 리터럴 "wire-src-filter,x"는 아무 행에도 매치되지 않는다.
		// 만약 Spring이 콤마를 분해해 첫 값만 쓰면 1건이 나와 이 단언이 깨진다(@RequestParam List 금지 축).
		Wire.Response comma = Wire.send(this.port, "GET",
				"/api/receiver-config?sourceId=wire-src-filter,x", sid(adminSid()), null);
		assertEquals(200, comma.status());
		assertEquals(0, countItems(comma.body()), "콤마 값이 분해되면 안 된다(0건): " + comma.body());

		// 화이트리스트 밖 키는 400이 아니라 무시된다.
		Wire.Response unknown = Wire.send(this.port, "GET",
				"/api/receiver-config?sourceId=wire-src-filter&notAColumn=zzz", sid(adminSid()), null);
		assertEquals(200, unknown.status());
		assertEquals(1, countItems(unknown.body()), "화이트리스트 밖 키는 무시된다: " + unknown.body());
	}

	@Test
	void allThreeRoutesRejectAnonymousWith401() {
		assertEquals(401, Wire.send(this.port, "GET", "/api/receiver-config").status());
		assertEquals("{\"ok\":false,\"reason\":\"unauthenticated\"}",
				Wire.send(this.port, "GET", "/api/receiver-config").body());
		assertEquals(401, Wire.json(this.port, "POST", "/api/receiver-config", Map.of(),
				"{\"sourceId\":\"nope\",\"type\":\"FTP\",\"name\":\"nope\"}").status());
		assertEquals(401, Wire.send(this.port, "DELETE", "/api/receiver-config/1").status());
	}

	@Test
	void allThreeRoutesRejectReporterWith403() {
		String r = reporterSid();
		Wire.Response list = Wire.send(this.port, "GET", "/api/receiver-config", sid(r), null);
		assertEquals(403, list.status());
		assertEquals("{\"ok\":false,\"reason\":\"forbidden\"}", list.body());

		Wire.Response create = Wire.json(this.port, "POST", "/api/receiver-config", sid(r),
				"{\"sourceId\":\"nope\",\"type\":\"FTP\",\"name\":\"nope\"}");
		assertEquals(403, create.status());

		Wire.Response del = Wire.send(this.port, "DELETE", "/api/receiver-config/1", sid(r), null);
		assertEquals(403, del.status());
	}

	@Test
	void adminDeletesOwnRowThenRepeatIsIdempotent() {
		long id = createConfig(adminSid(),
				"{\"sourceId\":\"wire-src-del\",\"type\":\"FTP\",\"name\":\"wire-recv-del\",\"active\":\"Y\"}");

		Wire.Response first = Wire.send(this.port, "DELETE", "/api/receiver-config/" + id, sid(adminSid()), null);
		assertEquals(200, first.status());
		assertEquals("{\"ok\":true,\"changes\":1}", first.body());

		// 목록에서 사라진다.
		Wire.Response after = Wire.send(this.port, "GET", "/api/receiver-config?id=" + id, sid(adminSid()), null);
		assertEquals(0, countItems(after.body()), "삭제한 행이 목록에 남아 있다");

		// 재삭제는 멱등 — 404가 아니라 200 changes:0.
		Wire.Response repeat = Wire.send(this.port, "DELETE", "/api/receiver-config/" + id, sid(adminSid()), null);
		assertEquals(200, repeat.status());
		assertEquals("{\"ok\":true,\"changes\":0}", repeat.body());
	}

	@Test
	void nonNumericIdDeleteIsNaNAndYieldsChangesZero() {
		Wire.Response res = Wire.send(this.port, "DELETE", "/api/receiver-config/abc", sid(adminSid()), null);

		// 라우트가 Number('abc')=NaN을 넘긴다 → 매치 0 → 200 changes:0(500 아님 — 작업 A 실측).
		assertEquals(200, res.status());
		assertEquals("{\"ok\":true,\"changes\":0}", res.body());
	}

	/** {@code {"ok":true,"items":[...]}}에서 원소 수 — {@code "id":} 등장 횟수로 센다(각 원소가 정확히 하나 갖는다). */
	private static int countItems(String body) {
		int count = 0;
		Matcher matcher = Pattern.compile("\"id\":\\d+").matcher(body);
		while (matcher.find()) {
			count++;
		}
		return count;
	}
}
