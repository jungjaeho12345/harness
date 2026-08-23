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
 * 배부 수신처 CRUD 4라우트의 <b>와이어</b> 계약 — {@code distribution-targets.contract.js}가 잠그는 축을
 * Java에서 직접 확인한다(전 기동 RANDOM_PORT + 원시 HTTP + 전용 임시 DB · {@code PathPolicyWireTest} 패턴).
 *
 * <p>축(ADR-008): (1) 4라우트 전부 Z 전용(미인증 401 · R·D 403). (2) 검증 5종은 전부 폴백 400이고 검증
 * 순서는 name→kind→spoolDir→active. (3) list SAFE_FIELDS 7키({@code spoolDir} 포함). (4) 없는 id·비수치 id는
 * update·deactivate에서 404 not-found(500 아님). (5) soft delete 두 진입점(POST /:id/deactivate · PUT
 * {active:'N'})이 같은 전이를 만든다. (6) <b>{@code DELETE /api/distribution-targets/:id}는 라우트 미등록</b>
 * → 프레임워크 404이고 행이 생존한다(행 삭제 경로 없음).
 */
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
class DistributionTargetsWireTest {

	private static final Path DATA_DIR = TempNewsDb.newDataDir("distribution-targets-wire");

	private static final Pattern SESSION_ID = Pattern.compile("\"sessionId\":\"([0-9a-f]{64})\"");

	private static final Pattern ID = Pattern.compile("\"id\":(\\d+)");

	private static final Pattern SESSION_TOKEN = Pattern.compile("[0-9a-f]{64}");

	/** 로그인 IP 레이트리밋(15분/10회)을 넘지 않도록 역할별로 한 번만 로그인한다. */
	private static String adminToken;

	private static String reporterToken;

	private static String deskToken;

	@DynamicPropertySource
	static void dataDir(DynamicPropertyRegistry registry) {
		registry.add("app.data-dir", () -> DATA_DIR.toAbsolutePath().toString());
	}

	@Value("${local.server.port}")
	private int port;

	@Autowired
	private UserService users;

	@BeforeEach
	void seedUsers() {
		seedUser("dt-admin", "dt-admin-pw", "Z");
		seedUser("dt-reporter", "dt-reporter-pw", "R");
		seedUser("dt-desk", "dt-desk-pw", "D");
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
			// 이미 있다 — 픽스처는 멱등이다.
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
			adminToken = login("dt-admin", "dt-admin-pw");
		}
		return adminToken;
	}

	private String reporterSid() {
		if (reporterToken == null) {
			reporterToken = login("dt-reporter", "dt-reporter-pw");
		}
		return reporterToken;
	}

	private String deskSid() {
		if (deskToken == null) {
			deskToken = login("dt-desk", "dt-desk-pw");
		}
		return deskToken;
	}

	private Map<String, String> sid(String sessionId) {
		return Map.of("x-session-id", sessionId);
	}

	private long createTarget(String name, String kind, String spoolDir) {
		Wire.Response res = Wire.json(this.port, "POST", "/api/distribution-targets", sid(adminSid()),
				"{\"name\":\"" + name + "\",\"kind\":\"" + kind + "\",\"spoolDir\":\"" + spoolDir + "\"}");
		assertEquals(200, res.status(), "픽스처 생성 상태: " + res.body());
		Matcher matcher = ID.matcher(res.body());
		assertTrue(matcher.find(), "생성 응답에 id가 없다: " + res.body());
		return Long.parseLong(matcher.group(1));
	}

	private Map<String, Object> findBySpoolDir(String spoolDir) {
		Wire.Response res = Wire.send(this.port, "GET",
				"/api/distribution-targets?spoolDir=" + spoolDir, sid(adminSid()), null);
		assertEquals(200, res.status());
		return parseFirstItem(res.body());
	}

	@Test
	void adminCreatesTargetResponseIsExactlyOkAndId() {
		Wire.Response res = Wire.json(this.port, "POST", "/api/distribution-targets", sid(adminSid()),
				"{\"name\":\"wire-target-a\",\"kind\":\"press\",\"spoolDir\":\"wire-spool-a\"}");

		assertEquals(200, res.status());
		assertTrue(res.body().matches("\\{\"ok\":true,\"id\":\\d+\\}"), "생성 응답은 정확히 {ok,id}: " + res.body());
		assertFalse(SESSION_TOKEN.matcher(res.body()).find(), "세션 토큰이 응답에 실렸다");
	}

	@Test
	void createValidationRejectionsAreAll400InOrder() {
		createTarget("wire-dup-owner", "press", "wire-spool-dup");

		String[][] cases = {
			// {body, expected reason}
			{ "{\"kind\":\"press\",\"spoolDir\":\"wire-noname\"}", "invalid-name" },
			{ "{\"name\":\"wire-bk\",\"kind\":\"bogus\",\"spoolDir\":\"wire-bk\"}", "invalid-kind" },
			{ "{\"name\":\"wire-esc\",\"kind\":\"press\",\"spoolDir\":\"../escape\"}", "invalid-spool-dir" },
			{ "{\"name\":\"wire-sep\",\"kind\":\"press\",\"spoolDir\":\"a/b\"}", "invalid-spool-dir" },
			{ "{\"name\":\"wire-dup\",\"kind\":\"press\",\"spoolDir\":\"wire-spool-dup\"}", "duplicate-spool-dir" },
			{ "{\"name\":\"wire-act\",\"kind\":\"press\",\"spoolDir\":\"wire-free\",\"active\":\"x\"}", "invalid-active" },
		};
		for (String[] c : cases) {
			Wire.Response res = Wire.json(this.port, "POST", "/api/distribution-targets", sid(adminSid()), c[0]);
			assertEquals(400, res.status(), "거부 상태: " + c[0]);
			assertEquals("{\"ok\":false,\"reason\":\"" + c[1] + "\"}", res.body(), "거부 사유: " + c[0]);
		}

		// 거부는 아무 행도 만들지 않는다 — invalid-active로 쓰였던 wire-free 슬러그는 미사용이다.
		assertTrue(findBySpoolDir("wire-free").isEmpty(), "invalid-active 거부가 행을 만들었다");
	}

	@Test
	void listProjectsSevenSafeFieldsIncludingSpoolDir() {
		long id = createTarget("wire-target-list", "press", "wire-spool-list");

		Wire.Response res = Wire.send(this.port, "GET",
				"/api/distribution-targets?spoolDir=wire-spool-list", sid(adminSid()), null);

		assertEquals(200, res.status());
		String body = res.body();
		assertTrue(body.startsWith("{\"ok\":true,\"items\":["), "목록 봉투 shape: " + body);
		for (String key : new String[] { "id", "name", "kind", "spoolDir", "active", "createdAt", "updatedAt" }) {
			assertTrue(body.contains("\"" + key + "\":"), key + " 키가 목록 원소에 없다: " + body);
		}
		assertTrue(body.contains("\"spoolDir\":\"wire-spool-list\""), "spoolDir가 노출돼야 한다: " + body);
		assertTrue(body.contains("\"active\":\"Y\""), "active 미지정 기본은 Y: " + body);
		// createdAt·updatedAt은 서버가 stamp한 문자열이다(null 아님).
		assertFalse(body.contains("\"createdAt\":null"), "createdAt은 stamp돼야 한다: " + body);
		assertFalse(body.contains("\"updatedAt\":null"), "updatedAt은 stamp돼야 한다: " + body);

		// 콤마를 포함한 필터 값은 분해되지 않는다 — 리터럴은 아무 행에도 매치되지 않는다.
		Wire.Response comma = Wire.send(this.port, "GET",
				"/api/distribution-targets?spoolDir=wire-spool-list,x", sid(adminSid()), null);
		assertEquals(200, comma.status());
		assertTrue(parseFirstItem(comma.body()).isEmpty(), "콤마 값이 분해되면 안 된다(0건): " + comma.body());

		assertEquals(id, ((Number) findBySpoolDir("wire-spool-list").get("id")).longValue());
	}

	@Test
	void allFourRoutesRejectAnonymousWith401() {
		assertEquals(401, Wire.send(this.port, "GET", "/api/distribution-targets").status());
		assertEquals(401, Wire.json(this.port, "POST", "/api/distribution-targets", Map.of(),
				"{\"name\":\"x\",\"kind\":\"press\",\"spoolDir\":\"x\"}").status());
		assertEquals(401, Wire.json(this.port, "PUT", "/api/distribution-targets/1", Map.of(),
				"{\"name\":\"x\"}").status());
		assertEquals(401, Wire.send(this.port, "POST", "/api/distribution-targets/1/deactivate").status());
	}

	@Test
	void allFourRoutesRejectReporterAndDeskWith403() {
		long id = createTarget("wire-target-403", "press", "wire-spool-403");
		for (String role : new String[] { reporterSid(), deskSid() }) {
			assertEquals(403, Wire.send(this.port, "GET", "/api/distribution-targets", sid(role), null).status());
			assertEquals(403, Wire.json(this.port, "POST", "/api/distribution-targets", sid(role),
					"{\"name\":\"x\",\"kind\":\"press\",\"spoolDir\":\"x\"}").status());
			Wire.Response put = Wire.json(this.port, "PUT", "/api/distribution-targets/" + id, sid(role),
					"{\"name\":\"nope\"}");
			assertEquals(403, put.status());
			assertEquals("{\"ok\":false,\"reason\":\"forbidden\"}", put.body());
			assertEquals(403, Wire.send(this.port, "POST",
					"/api/distribution-targets/" + id + "/deactivate", sid(role), null).status());
		}
		// 거부된 write는 아무것도 바꾸지 않았다.
		Map<String, Object> mine = findBySpoolDir("wire-spool-403");
		assertEquals("wire-target-403", mine.get("name"), "거부된 PUT이 이름을 바꿨다");
		assertEquals("Y", mine.get("active"), "거부된 deactivate가 행을 내렸다");
	}

	@Test
	void adminUpdatesNamePresentOnlyAndStampsUpdatedAt() {
		long id = createTarget("wire-target-upd", "press", "wire-spool-upd");
		Map<String, Object> before = findBySpoolDir("wire-spool-upd");

		Wire.Response res = Wire.json(this.port, "PUT", "/api/distribution-targets/" + id, sid(adminSid()),
				"{\"name\":\"wire-target-upd-renamed\"}");
		assertEquals(200, res.status());
		assertEquals("{\"ok\":true,\"changes\":1}", res.body());

		Map<String, Object> after = findBySpoolDir("wire-spool-upd");
		assertEquals("wire-target-upd-renamed", after.get("name"));
		assertEquals("press", after.get("kind"), "전달하지 않은 필드는 불변(present-only)");
		assertEquals(before.get("createdAt"), after.get("createdAt"), "createdAt은 수정으로 바뀌지 않는다");
	}

	@Test
	void updateValidationRejectionsAre400() {
		long id = createTarget("wire-target-uv", "press", "wire-spool-uv");
		for (String[] c : new String[][] {
				{ "{\"active\":\"x\"}", "invalid-active" }, { "{\"kind\":\"PRESS\"}", "invalid-kind" } }) {
			Wire.Response res = Wire.json(this.port, "PUT", "/api/distribution-targets/" + id, sid(adminSid()), c[0]);
			assertEquals(400, res.status(), "거부 상태: " + c[0]);
			assertEquals("{\"ok\":false,\"reason\":\"" + c[1] + "\"}", res.body());
		}
		Map<String, Object> mine = findBySpoolDir("wire-spool-uv");
		assertEquals("Y", mine.get("active"));
		assertEquals("press", mine.get("kind"));
	}

	@Test
	void absentAndNonNumericIdAre404NotFoundOnBothWriteRoutes() {
		for (String probe : new String[] { "999999999", "abc" }) {
			Wire.Response put = Wire.json(this.port, "PUT", "/api/distribution-targets/" + probe, sid(adminSid()),
					"{\"name\":\"nowhere\"}");
			assertEquals(404, put.status(), "PUT " + probe);
			assertEquals("{\"ok\":false,\"reason\":\"not-found\"}", put.body());

			Wire.Response off = Wire.send(this.port, "POST",
					"/api/distribution-targets/" + probe + "/deactivate", sid(adminSid()), null);
			assertEquals(404, off.status(), "deactivate " + probe);
			assertEquals("{\"ok\":false,\"reason\":\"not-found\"}", off.body());
		}
	}

	@Test
	void deactivateSoftDeletesAndRowStaysListed() {
		long id = createTarget("wire-target-soft", "press", "wire-spool-soft");

		Wire.Response res = Wire.send(this.port, "POST",
				"/api/distribution-targets/" + id + "/deactivate", sid(adminSid()), null);
		assertEquals(200, res.status());
		assertEquals("{\"ok\":true,\"changes\":1}", res.body());

		Map<String, Object> mine = findBySpoolDir("wire-spool-soft");
		assertFalse(mine.isEmpty(), "비활성 행이 목록에서 사라졌다 — soft delete가 아니라 삭제다");
		assertEquals("N", mine.get("active"));
		assertEquals(id, ((Number) mine.get("id")).longValue(), "같은 행이 유지된다");
	}

	@Test
	void putActiveNIsTheSecondSoftDeleteEntryPoint() {
		long id = createTarget("wire-target-soft2", "nonpress", "wire-spool-soft2");

		Wire.Response res = Wire.json(this.port, "PUT", "/api/distribution-targets/" + id, sid(adminSid()),
				"{\"active\":\"N\"}");
		assertEquals(200, res.status());
		assertEquals("{\"ok\":true,\"changes\":1}", res.body());

		Map<String, Object> mine = findBySpoolDir("wire-spool-soft2");
		assertEquals("N", mine.get("active"));
	}

	@Test
	void deleteRouteIsUnregisteredSoFramework404AndRowSurvives() {
		long id = createTarget("wire-target-del", "press", "wire-spool-del");

		Wire.Response res = Wire.send(this.port, "DELETE",
				"/api/distribution-targets/" + id, sid(adminSid()), null);

		// 핸들러 미등록 → 프레임워크 기본 404. JSON 성공 응답이 아니다.
		assertEquals(404, res.status(), "DELETE 라우트가 등록되면 안 된다(행 삭제 경로 없음 · ADR-008)");
		assertFalse(res.body().contains("\"ok\":true"), "삭제 성공 응답이 있어서는 안 된다");

		// 405→404 등가를 못박는다: 이 응답은 정본 미정의-라우트 404와 바이트 단위로 같아야 한다. 같은 테스트에서
		// 진짜 미매핑 경로(PathPolicyWireTest가 phase 내내 미구현으로 쓰는 /api/media/search)의 404를 포착해
		// 본문·Content-Type을 대조한다 — 미등록 DELETE가 스텁도, 405도, 특수 응답도 아님을 실증한다.
		Wire.Response canonical404 = Wire.send(this.port, "GET",
				"/api/media/search", sid(adminSid()), null);
		assertEquals(404, canonical404.status(), "정본 미정의-라우트 프로브가 404가 아니다: " + canonical404.body());
		assertFalse(canonical404.body().isEmpty(), "정본 404 본문이 비어 대조 대상이 없다");
		assertEquals(canonical404.body(), res.body(),
				"미등록 DELETE의 404 본문이 정본 미정의-라우트 404 HTML과 같아야 한다");
		assertEquals(canonical404.line("content-type"), res.line("content-type"),
				"미등록 DELETE의 Content-Type이 정본 미정의-라우트 404와 같아야 한다");

		// 행은 그대로 남아 있다 — "행 삭제 경로가 없다"의 실증이다.
		Map<String, Object> mine = findBySpoolDir("wire-spool-del");
		assertFalse(mine.isEmpty(), "DELETE 요청이 수신처 행을 지웠다(ADR-008 위반)");
		assertEquals(id, ((Number) mine.get("id")).longValue());
	}

	/**
	 * {@code {"ok":true,"items":[ {..}, .. ]}}의 첫 원소를 얕게 파싱한다 — 문자열 값과 id만 본다.
	 * 원소가 없으면 빈 맵이다(정본 JSON 파서 없이 테스트 안에서 필요한 만큼만 읽는다).
	 */
	private static Map<String, Object> parseFirstItem(String body) {
		Map<String, Object> item = new LinkedHashMap<>();
		int open = body.indexOf("[{");
		if (open < 0) {
			return item; // 빈 items.
		}
		int close = body.indexOf('}', open);
		String first = body.substring(open + 1, close + 1);
		Matcher str = Pattern.compile("\"([a-zA-Z]+)\":\"([^\"]*)\"").matcher(first);
		while (str.find()) {
			item.put(str.group(1), str.group(2));
		}
		Matcher num = Pattern.compile("\"id\":(\\d+)").matcher(first);
		if (num.find()) {
			item.put("id", Long.parseLong(num.group(1)));
		}
		return item;
	}
}
