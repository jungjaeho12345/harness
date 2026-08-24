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

	// --- 7. 경로 id는 Node의 Number() 의미론으로만 읽는다 ------------------------------------------

	/**
	 * <b>Java 전용 표기는 어떤 행에도 닿지 않는다</b>({@code 5d}·{@code 5D}·{@code 5f}·{@code 0x5p0}).
	 * {@code Double.parseDouble}을 그대로 쓰면 Node가 404를 주는 URL로 Spring만 <b>남의 행을 고치거나
	 * 비활성으로 내린다</b>(2026-08-24 리뷰 high-1 — receiver-config 삭제와 같은 결함의 다른 라우트).
	 */
	@Test
	void javaOnlyNumberSpellingsNeverReachARow() {
		String spool = unique("sp");
		String name = unique("t");
		int id = createTarget(name, "press", spool);

		for (String spelling : List.of(id + "d", id + "D", id + "f", "0x" + Integer.toHexString(id) + "p0")) {
			Wire.Response put = update(spelling, "{\"name\":\"hijacked\"}");
			assertEquals(404, put.status(), spelling + " PUT은 Node에서 not-found다");
			assertEquals("{\"ok\":false,\"reason\":\"not-found\"}", put.body());

			Wire.Response off = deactivate(spelling);
			assertEquals(404, off.status(), spelling + " deactivate는 Node에서 not-found다");
			assertEquals("{\"ok\":false,\"reason\":\"not-found\"}", off.body());
		}

		Map<String, Object> row = this.rows.findById(id).orElseThrow();
		assertEquals(name, row.get("name"), "Node가 닿지 않는 표기가 행을 고쳤다");
		assertEquals("Y", row.get("active"), "Node가 닿지 않는 표기가 행을 비활성으로 내렸다");
	}

	/**
	 * 반대 방향 — Node가 <b>값으로 읽는</b> 표기(진법 접두 · JS 공백 선행)는 같은 행에 닿아야 한다.
	 * {@code Double.parseDouble}은 {@code 0x10}을 거부하고 {@code String.trim()}은 NBSP를 못 걷어낸다 —
	 * 둘 다 Node가 200 changes:1을 주는 URL에 Spring만 404를 준다.
	 */
	@Test
	void theSpellingsNodeReadsAsThatIdReachTheSameRow() {
		int hex = createTarget(unique("t"), "press", unique("sp"));
		int padded = createTarget(unique("t"), "press", unique("sp"));

		Wire.Response byHex = update("0x" + Integer.toHexString(hex), "{\"name\":\"hex-renamed\"}");
		assertEquals(200, byHex.status(), "0x 접두는 Node에서 같은 id다");
		assertEquals("{\"ok\":true,\"changes\":1}", byHex.body());
		assertEquals("hex-renamed", this.rows.findById(hex).orElseThrow().get("name"));

		Wire.Response byPadded = deactivate("%C2%A0" + padded);
		assertEquals(200, byPadded.status(), "NBSP는 JS 공백이라 Number()가 걷어낸다");
		assertEquals("{\"ok\":true,\"changes\":1}", byPadded.body());
		assertEquals("N", this.rows.findById(padded).orElseThrow().get("active"));
	}

	// --- 8. 누락·null 필드는 400 사유 토큰이다(500이 아니다) ---------------------------------------

	/**
	 * {@code Set.of(...).contains(null)}은 <b>NPE</b>다 — kind를 빼고 보낸 생성 요청이 전역 핸들러를 타고
	 * 500 {@code internal-error}가 되면 Node(400 {@code invalid-kind})와 갈린다(2026-08-24 리뷰 high-2).
	 * 검증기는 {@code checkName}처럼 <b>타입 게이트를 먼저</b> 세워야 한다.
	 */
	@Test
	void missingOrNullKindAndActiveAre400ReasonTokensNot500() {
		record Case(String body, String reason) { }
		List<Case> cases = List.of(
				new Case("{\"name\":\"" + unique("t") + "\",\"spoolDir\":\"" + unique("sp") + "\"}", "invalid-kind"),
				new Case("{\"name\":\"" + unique("t") + "\",\"kind\":null,\"spoolDir\":\"" + unique("sp") + "\"}",
						"invalid-kind"),
				new Case("{\"name\":\"" + unique("t") + "\",\"kind\":\"press\",\"spoolDir\":\"" + unique("sp")
						+ "\",\"active\":null}", "invalid-active"));

		for (Case c : cases) {
			Wire.Response res = create(c.body());
			assertEquals(400, res.status(), "누락·null 필드는 500이 아니라 400이다: " + c.body());
			assertEquals("{\"ok\":false,\"reason\":\"" + c.reason() + "\"}", res.body());
		}

		int id = createTarget(unique("t"), "press", unique("sp"));
		for (Case c : List.of(new Case("{\"kind\":null}", "invalid-kind"),
				new Case("{\"active\":null}", "invalid-active"))) {
			Wire.Response res = update(String.valueOf(id), c.body());
			assertEquals(400, res.status(), "PUT의 null 필드도 500이 아니다: " + c.body());
			assertEquals("{\"ok\":false,\"reason\":\"" + c.reason() + "\"}", res.body());
		}
		assertEquals("Y", this.rows.findById(id).orElseThrow().get("active"), "거부된 PUT은 아무것도 바꾸지 않는다");
	}

	// --- 9. 반복 쿼리 키는 값 리스트 그대로 넘어간다(첫 값으로 접지 않는다) --------------------------

	/**
	 * express(qs)는 {@code ?kind=press&kind=nonpress}를 <b>배열</b>로 준다. Node 서비스의
	 * {@code pickFilters}는 문자열·숫자가 아닌 값을 버리므로 그 요청은 <b>필터 없는 전체 목록</b>이다.
	 * 첫 값으로 접으면 Spring만 좁힌 목록을 준다(같은 200에 본문이 다르다).
	 */
	@Test
	void aRepeatedFilterKeyIsDroppedSoTheListStaysUnfiltered() {
		String pressSpool = unique("sp");
		String nonpressSpool = unique("sp");
		createTarget(unique("t"), "press", pressSpool);
		createTarget(unique("t"), "nonpress", nonpressSpool);

		Wire.Response repeated = list(zToken(), "kind=press&kind=nonpress");

		assertEquals(200, repeated.status());
		assertTrue(repeated.body().contains("\"spoolDir\":\"" + pressSpool + "\""), "press 행이 없다");
		assertTrue(repeated.body().contains("\"spoolDir\":\"" + nonpressSpool + "\""),
				"첫 값으로 접으면 nonpress 행이 사라진다 — Node는 필터를 통째로 버린다");
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
