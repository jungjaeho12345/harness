package harness.news.controller;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import harness.news.model.DistributionTargetRepository;
import harness.news.service.SessionGuard;
import harness.news.service.UserService;
import harness.news.testsupport.TempNewsDb;
import harness.news.testsupport.Wire;
import java.nio.file.Path;
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
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;

/**
 * 배부 대상 4라우트({@code GET/POST /api/distribution-targets} · {@code PUT .../:id} ·
 * {@code POST .../:id/deactivate})의 <b>와이어</b> 계약. {@code distribution-targets.contract.js}와 같은
 * 축을 원시 HTTP로 잠근다.
 *
 * <pre>
 * POST 200 : {"ok":true,"id":&lt;정수&gt;}                     검증 거부 5종 400 {ok:false,reason}
 * GET  200 : {"ok":true,"items":[{SAFE_FIELDS 7키}, ...]}  spoolDir 실림, 한글 name 왕복
 * PUT  200 : {"ok":true,"changes":1}                       없는/비수치 id 404 not-found(500 아님)
 * DEACT200 : {"ok":true,"changes":1}                       active='N'이고 행은 목록에 남는다
 * DELETE   : 404(핸들러 미등록 — 행 삭제 경로 없음)
 * 거부     : 401 unauthenticated · 403 forbidden(R·D)
 * </pre>
 */
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
class DistributionTargetsWireTest {

	private static final Path DATA_DIR = TempNewsDb.newDataDir("distribution-targets-wire");

	private static final Pattern OBJECT = Pattern.compile("\\{[^{}]*\\}");

	private static final Pattern KEY = Pattern.compile("\"([A-Za-z]+)\":");

	/** distributionTargetService.SAFE_FIELDS 순서. */
	private static final List<String> SAFE_KEYS =
			List.of("id", "name", "kind", "spoolDir", "active", "createdAt", "updatedAt");

	@DynamicPropertySource
	static void dataDir(DynamicPropertyRegistry registry) {
		registry.add("app.data-dir", () -> DATA_DIR.toAbsolutePath().toString());
	}

	@Value("${local.server.port}")
	private int port;

	@Autowired
	private UserService users;

	@Autowired
	private SessionGuard sessions;

	@Autowired
	private DistributionTargetRepository rows;

	@BeforeEach
	void seedUsers() {
		ensureUser("dt-z", "Z");
		ensureUser("dt-r", "R");
		ensureUser("dt-d", "D");
	}

	// --- 1. 생성 + 검증 거부 5종 -------------------------------------------------------------------

	@Test
	void adminCreatesTargetAndValidationRejectionsAreAll400() {
		Wire.Response ok = create("{\"name\":\"" + unique("t") + "\",\"kind\":\"press\",\"spoolDir\":\""
				+ unique("sp") + "\"}");
		assertEquals(200, ok.status());
		assertEquals(List.of("ok", "id"), keysOf(ok.body()), "생성 응답은 {ok,id} 2키뿐이다");
		assertTrue(idOf(ok.body()) > 0);

		String dupSpool = unique("sp-dup");
		create("{\"name\":\"" + unique("t") + "\",\"kind\":\"press\",\"spoolDir\":\"" + dupSpool + "\"}");

		record Case(String body, String reason) { }
		List<Case> cases = List.of(
				new Case("{\"kind\":\"press\",\"spoolDir\":\"" + unique("sp") + "\"}", "invalid-name"),
				new Case("{\"name\":\"" + unique("t") + "\",\"kind\":\"bogus\",\"spoolDir\":\"" + unique("sp") + "\"}", "invalid-kind"),
				new Case("{\"name\":\"" + unique("t") + "\",\"kind\":\"press\",\"spoolDir\":\"../escape\"}", "invalid-spool-dir"),
				new Case("{\"name\":\"" + unique("t") + "\",\"kind\":\"press\",\"spoolDir\":\"a/b\"}", "invalid-spool-dir"),
				new Case("{\"name\":\"" + unique("t") + "\",\"kind\":\"press\",\"spoolDir\":\"" + dupSpool + "\"}", "duplicate-spool-dir"),
				new Case("{\"name\":\"" + unique("t") + "\",\"kind\":\"press\",\"spoolDir\":\"" + unique("sp") + "\",\"active\":\"x\"}", "invalid-active"));

		for (Case c : cases) {
			Wire.Response res = create(c.body());
			assertEquals(400, res.status(), "검증 거부는 400: " + c.reason());
			assertEquals("{\"ok\":false,\"reason\":\"" + c.reason() + "\"}", res.body());
		}
	}

	// --- 2. 목록: SAFE_FIELDS 7키 · spoolDir · 한글 name 왕복 ---------------------------------------

	@Test
	void listElementIsExactlySevenKeysWithSpoolDirAndKoreanNameRoundTrips() {
		String spool = unique("sp");
		String name = "한글수신처-" + unique("k");
		int id = createTarget(name, "nonpress", spool);

		Wire.Response response = list(zToken(), null);
		assertEquals(200, response.status());
		for (String item : items(response.body())) {
			for (String key : keysOf(item)) {
				assertTrue(SAFE_KEYS.contains(key), "SAFE_FIELDS 밖 키가 실렸다: " + key);
			}
		}
		String mine = objectForSpool(response.body(), spool);
		assertEquals(SAFE_KEYS, keysOf(mine), "목록 원소는 정확 7키(Node 순서)다");
		assertTrue(mine.contains("\"id\":" + id));
		assertTrue(mine.contains("\"kind\":\"nonpress\""));
		assertTrue(mine.contains("\"spoolDir\":\"" + spool + "\""), "spoolDir가 실린다(슬러그)");
		assertTrue(mine.contains("\"active\":\"Y\""), "active 미지정 기본값 Y");
		assertTrue(mine.contains("\"name\":\"" + name + "\""), "한글 name 왕복");

		// 필터: 자기 슬러그로 좁히면 1건.
		assertEquals(1, items(list(zToken(), "spoolDir=" + spool).body()).size());
	}

	// --- 3. 수정: 200 changes:1 · 없는/비수치 id 404 ----------------------------------------------

	@Test
	void updateRenamesAndAbsentOrNonNumericIdAre404NotFound() {
		String spool = unique("sp");
		int id = createTarget(unique("t"), "press", spool);

		Wire.Response renamed = update(String.valueOf(id), "{\"name\":\"renamed-" + unique("r") + "\"}");
		assertEquals(200, renamed.status());
		assertEquals("{\"ok\":true,\"changes\":1}", renamed.body());
		String mine = objectForSpool(list(zToken(), null).body(), spool);
		assertTrue(mine.contains("\"kind\":\"press\""), "전달하지 않은 kind는 불변(present-only)");
		assertTrue(keyValue(mine, "updatedAt").length() > 0, "updatedAt이 stamp된다");

		Wire.Response absent = update("999999999", "{\"name\":\"nowhere\"}");
		assertEquals(404, absent.status());
		assertEquals("{\"ok\":false,\"reason\":\"not-found\"}", absent.body());

		Wire.Response nan = update("abc", "{\"name\":\"nowhere\"}");
		assertEquals(404, nan.status(), "비수치 id는 500이 아니라 404다");
		assertEquals("{\"ok\":false,\"reason\":\"not-found\"}", nan.body());

		Wire.Response deactivateAbsent = deactivate("abc");
		assertEquals(404, deactivateAbsent.status());
		assertEquals("{\"ok\":false,\"reason\":\"not-found\"}", deactivateAbsent.body());
	}

	// --- 4. soft delete: deactivate와 PUT {active:N} 수렴 · 행은 남는다 ------------------------------

	@Test
	void deactivateAndPutActiveNBothLeaveTheRowListedWithActiveN() {
		String spoolA = unique("sp");
		String spoolB = unique("sp");
		int viaDeactivate = createTarget(unique("t"), "press", spoolA);
		int viaPut = createTarget(unique("t"), "press", spoolB);

		Wire.Response deact = deactivate(String.valueOf(viaDeactivate));
		assertEquals(200, deact.status());
		assertEquals("{\"ok\":true,\"changes\":1}", deact.body());

		Wire.Response put = update(String.valueOf(viaPut), "{\"active\":\"N\"}");
		assertEquals(200, put.status());
		assertEquals("{\"ok\":true,\"changes\":1}", put.body());

		String a = objectForSpool(list(zToken(), null).body(), spoolA);
		String b = objectForSpool(list(zToken(), null).body(), spoolB);
		assertTrue(a.contains("\"active\":\"N\""), "deactivate 후 active N이고 목록에 남는다");
		assertTrue(b.contains("\"active\":\"N\""), "PUT {active:N}도 같은 결과");
		assertTrue(this.rows.findById(viaDeactivate).isPresent(), "soft delete는 행을 지우지 않는다");
	}

	// --- 5. 인가: 미인증 401 · R/D 403(4 라우트) --------------------------------------------------

	@Test
	void unauthenticatedIs401AndNonAdminIs403OnAllFourRoutes() {
		int id = createTarget(unique("t"), "press", unique("sp"));
		String createBody = "{\"name\":\"" + unique("d") + "\",\"kind\":\"press\",\"spoolDir\":\"" + unique("sp") + "\"}";

		record Probe(String method, String path, String body) { }
		List<Probe> probes = List.of(
				new Probe("GET", "/api/distribution-targets", null),
				new Probe("POST", "/api/distribution-targets", createBody),
				new Probe("PUT", "/api/distribution-targets/" + id, "{\"name\":\"x\"}"),
				new Probe("POST", "/api/distribution-targets/" + id + "/deactivate", null));

		for (Probe probe : probes) {
			Wire.Response anon = probe.body() == null
					? Wire.send(this.port, probe.method(), probe.path())
					: Wire.json(this.port, probe.method(), probe.path(), Map.of(), probe.body());
			assertEquals(401, anon.status(), probe.method() + " " + probe.path() + " 미인증");
			assertEquals("{\"ok\":false,\"reason\":\"unauthenticated\"}", anon.body());

			for (String role : new String[] {"dt-r", "dt-d"}) {
				String token = this.sessions.createSession(role);
				Wire.Response denied = probe.body() == null
						? Wire.send(this.port, probe.method(), probe.path(), Map.of("x-session-id", token), null)
						: Wire.json(this.port, probe.method(), probe.path(), Map.of("x-session-id", token), probe.body());
				assertEquals(403, denied.status(), probe.method() + " " + probe.path() + " " + role);
				assertEquals("{\"ok\":false,\"reason\":\"forbidden\"}", denied.body());
			}
		}
		// 거부는 아무것도 바꾸지 않았다(행 여전히 활성).
		assertEquals("Y", this.rows.findById(id).get().get("active"));
	}

	// --- 6. DELETE 라우트 미등록(행 삭제 경로 없음) ------------------------------------------------

	@Test
	void deleteRouteIsNotRegisteredAndTheRowSurvives() {
		String spool = unique("sp");
		int id = createTarget(unique("t"), "press", spool);

		Wire.Response res = Wire.send(this.port, "DELETE", "/api/distribution-targets/" + id,
				Map.of("x-session-id", zToken()), null);

		assertEquals(404, res.status(), "핸들러 미등록 → 프레임워크 기본 404");
		assertFalse(res.body().contains("\"ok\":true"), "삭제 성공 응답이 있어서는 안 된다");
		assertTrue(this.rows.findById(id).isPresent(), "DELETE 요청이 행을 지웠다(ADR-008 위반)");
	}

	// --- 도구 ------------------------------------------------------------------------------------

	private Wire.Response create(String body) {
		return Wire.json(this.port, "POST", "/api/distribution-targets", Map.of("x-session-id", zToken()), body);
	}

	private int createTarget(String name, String kind, String spoolDir) {
		Wire.Response res = create("{\"name\":\"" + name + "\",\"kind\":\"" + kind + "\",\"spoolDir\":\""
				+ spoolDir + "\"}");
		assertEquals(200, res.status(), "픽스처 생성 실패: " + res.body());
		return idOf(res.body());
	}

	private Wire.Response list(String token, String query) {
		String path = "/api/distribution-targets" + (query == null ? "" : "?" + query);
		return Wire.send(this.port, "GET", path, Map.of("x-session-id", token), null);
	}

	private Wire.Response update(String id, String body) {
		return Wire.json(this.port, "PUT", "/api/distribution-targets/" + id, Map.of("x-session-id", zToken()), body);
	}

	private Wire.Response deactivate(String id) {
		return Wire.send(this.port, "POST", "/api/distribution-targets/" + id + "/deactivate",
				Map.of("x-session-id", zToken()), null);
	}

	private String zToken() {
		return this.sessions.createSession("dt-z");
	}

	private void ensureUser(String userId, String role) {
		Map<String, Object> dto = new LinkedHashMap<>();
		dto.put("userId", userId);
		dto.put("name", userId);
		dto.put("role", role);
		dto.put("password", "dt-wire-pw");
		try {
			this.users.create(dto);
		}
		catch (RuntimeException ignored) {
			// 이미 있다 — 픽스처는 멱등이다.
		}
	}

	private static int idOf(String body) {
		Matcher matcher = Pattern.compile("\"id\":(\\d+)").matcher(body);
		assertTrue(matcher.find(), "응답에 정수 id가 없다: " + body);
		return Integer.parseInt(matcher.group(1));
	}

	private static List<String> items(String body) {
		List<String> found = new ArrayList<>();
		Matcher matcher = OBJECT.matcher(body);
		while (matcher.find()) {
			found.add(matcher.group());
		}
		return found;
	}

	private static String objectForSpool(String body, String spoolDir) {
		int marker = body.indexOf("\"spoolDir\":\"" + spoolDir + "\"");
		assertTrue(marker >= 0, "목록에 spoolDir=" + spoolDir + " 행이 없다: " + body);
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

	private static String keyValue(String object, String key) {
		Matcher matcher = Pattern.compile("\"" + key + "\":\"([^\"]*)\"").matcher(object);
		return matcher.find() ? matcher.group(1) : "";
	}

	private static String unique(String prefix) {
		return prefix + Long.toHexString(System.nanoTime());
	}
}
