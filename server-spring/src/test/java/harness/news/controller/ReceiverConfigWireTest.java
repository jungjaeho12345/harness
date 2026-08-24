package harness.news.controller;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import harness.news.model.ArticleAggregate;
import harness.news.model.ArticleRepository;
import harness.news.model.ReceiverConfigRepository;
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
 * 수집 수신 설정 3라우트({@code GET/POST /api/receiver-config} · {@code DELETE /api/receiver-config/:id})의
 * <b>와이어</b> 계약. {@code contract/cases/default/receiver-config.contract.js}와 같은 축을 원시 HTTP로 잠근다.
 *
 * <p>동결된 응답 shape(Node 실측):
 * <pre>
 * POST 200 : {"ok":true,"id":&lt;정수&gt;}                       ← 시크릿(password·apiKey) 반향 없음
 * GET  200 : {"ok":true,"items":[{SAFE_FIELDS 10키}, ...]}   ← password·apiKey 키 없음, createdAt null
 * DEL  200 : {"ok":true,"changes":&lt;0|1&gt;}                  ← 없는 id·재삭제·비수치 id 전부 changes:0
 * 거부     : 401 unauthenticated(경로 필터) · 403 forbidden(비-Z)
 * </pre>
 *
 * <p>세션은 {@link SessionGuard#createSession}로 직접 발급한다(로그인 레이트리밋을 태우지 않는다 — 이
 * 라우트의 계약은 인가·투영·삭제 멱등이지 로그인이 아니다). DB는 이 클래스 전용 임시 사본이다.
 */
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
class ReceiverConfigWireTest {

	private static final Path DATA_DIR = TempNewsDb.newDataDir("receiver-config-wire");

	/** JSON 객체 하나(중첩 없음) — items 배열 원소를 원문 그대로 뜯어보기 위한 패턴. */
	private static final Pattern OBJECT = Pattern.compile("\\{[^{}]*\\}");

	/** 객체 원문에서 키 이름만 등장 순서대로 뽑는다. */
	private static final Pattern KEY = Pattern.compile("\"([A-Za-z]+)\":");

	/** receiverConfigService.SAFE_FIELDS 순서(정렬본이 아니다). */
	private static final List<String> SAFE_KEYS = List.of(
			"id", "sourceId", "type", "name", "host", "port",
			"apiEndpoint", "active", "createdAt", "username");

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

	/** "거부/삭제가 행에 미친 영향"을 DB에서 직접 확인하는 음성/양성 증거. */
	@Autowired
	private ReceiverConfigRepository rows;

	/** 설정 삭제가 <b>수집된 기사</b>에 손대지 않았음을 확인하는 이웃 테이블 증거(픽스처 삽입 겸용). */
	@Autowired
	private ArticleRepository articles;

	@BeforeEach
	void seedUsers() {
		ensureUser("rc-z", "Z");
		ensureUser("rc-r", "R");
	}

	// --- 1. 생성: 200 {ok,id} · 시크릿 미반향 -------------------------------------------------------

	@Test
	void adminCreateReturnsIdOnlyAndNeverEchoesSecrets() {
		String source = unique("ct-src");
		String body = "{\"sourceId\":\"" + source + "\",\"type\":\"FTP\",\"name\":\"수신1\","
				+ "\"host\":\"127.0.0.1\",\"port\":\"21\",\"username\":\"" + unique("ct-user") + "\","
				+ "\"password\":\"ftp-secret-abc\",\"apiKey\":\"api-secret-xyz\",\"active\":\"Y\"}";

		Wire.Response response = Wire.json(this.port, "POST", "/api/receiver-config",
				Map.of("x-session-id", zToken()), body);

		assertEquals(200, response.status());
		assertEquals("Content-Type: application/json; charset=utf-8", response.line("content-type"));
		assertEquals(List.of("ok", "id"), keysOf(response.body()), "생성 응답은 {ok,id} 2키뿐이다");
		assertTrue(idOf(response.body()) > 0, "id는 양의 정수다");
		assertNoSecret(response, "ftp-secret-abc", "api-secret-xyz");
	}

	// --- 2. 목록: SAFE_FIELDS 10키 · createdAt null · 시크릿 없음 ----------------------------------

	@Test
	void adminListElementIsExactlyTheTenSafeFieldsWithCreatedAtNull() {
		String source = unique("ct-src");
		int id = createConfig("{\"sourceId\":\"" + source + "\",\"type\":\"FTP\",\"host\":\"127.0.0.1\","
				+ "\"port\":\"21\",\"username\":\"u1\",\"password\":\"ftp-secret-abc\",\"active\":\"Y\"}");

		Wire.Response response = list(zToken(), null);
		assertEquals(200, response.status());
		assertTrue(response.body().startsWith("{\"ok\":true,\"items\":["), "응답 shape은 {ok,items}다");
		for (String item : items(response.body())) {
			for (String key : keysOf(item)) {
				assertTrue(SAFE_KEYS.contains(key), "SAFE_FIELDS 밖 키가 실렸다: " + key + " in " + item);
			}
		}
		String mine = objectForSource(response.body(), source);
		assertEquals(SAFE_KEYS, keysOf(mine), "목록 원소는 정확 10키(Node 순서)다: " + mine);
		assertTrue(mine.contains("\"id\":" + id), "정수 id가 실린다: " + mine);
		assertTrue(mine.contains("\"port\":\"21\""));
		assertTrue(mine.contains("\"createdAt\":null"), "서버가 채우지 않은 createdAt은 null이고 키는 남는다");
		assertNoSecret(response, "ftp-secret-abc");
	}

	// --- 3. 목록 화이트리스트 필터 -----------------------------------------------------------------

	@Test
	void listAppliesWhitelistAndEqualityFilterAndIgnoresUnknownKeys() {
		String source = unique("ct-src");
		int id = createConfig("{\"sourceId\":\"" + source + "\",\"type\":\"FTP\"}");

		Wire.Response bySource = list(zToken(), "sourceId=" + source);
		assertEquals(1, items(bySource.body()).size());
		assertTrue(objectForSource(bySource.body(), source).contains("\"id\":" + id));

		// AND 조합 불일치 → 빈 목록(200).
		Wire.Response andMiss = list(zToken(), "sourceId=" + source + "&type=API");
		assertEquals(200, andMiss.status());
		assertEquals("{\"ok\":true,\"items\":[]}", andMiss.body());

		// 화이트리스트 밖 키는 400이 아니라 무시된다.
		Wire.Response ignored = list(zToken(), "sourceId=" + source + "&notAColumn=zzz");
		assertEquals(200, ignored.status());
		assertEquals(1, items(ignored.body()).size());
	}

	// --- 4. 인가: 미인증 401 · R 403 · 행 불변 ------------------------------------------------------

	@Test
	void unauthenticatedIs401AndNonAdminIs403OnAllThreeRoutesAndRowsSurvive() {
		String source = unique("ct-src");
		int id = createConfig("{\"sourceId\":\"" + source + "\",\"type\":\"FTP\"}");
		String deniedBody = "{\"sourceId\":\"" + unique("ct-denied") + "\",\"type\":\"FTP\"}";

		record Probe(String method, String path, String body) { }
		List<Probe> probes = List.of(
				new Probe("GET", "/api/receiver-config", null),
				new Probe("POST", "/api/receiver-config", deniedBody),
				new Probe("DELETE", "/api/receiver-config/" + id, null));

		for (Probe probe : probes) {
			Wire.Response anon = probe.body() == null
					? Wire.send(this.port, probe.method(), probe.path())
					: Wire.json(this.port, probe.method(), probe.path(), Map.of(), probe.body());
			assertEquals(401, anon.status(), probe.method() + " " + probe.path() + " 미인증");
			assertEquals("{\"ok\":false,\"reason\":\"unauthenticated\"}", anon.body());

			Wire.Response reporter = probe.body() == null
					? Wire.send(this.port, probe.method(), probe.path(), Map.of("x-session-id", rToken()), null)
					: Wire.json(this.port, probe.method(), probe.path(),
							Map.of("x-session-id", rToken()), probe.body());
			assertEquals(403, reporter.status(), probe.method() + " " + probe.path() + " R 세션");
			assertEquals("{\"ok\":false,\"reason\":\"forbidden\"}", reporter.body());
		}

		// 거부된 write는 행을 만들거나 지우지 않았다.
		assertEquals(1, this.rows.query(Map.of("id", id)).size(), "거부된 삭제가 행을 지웠다");
	}

	// --- 5. 삭제: 200 changes:1 · 멱등 · NaN id ----------------------------------------------------

	@Test
	void deleteRemovesOwnRowThenIsIdempotentAndNanIdIsChangesZero() {
		String source = unique("ct-src");
		int id = createConfig("{\"sourceId\":\"" + source + "\",\"type\":\"FTP\"}");

		Wire.Response deleted = delete("/api/receiver-config/" + id, zToken());
		assertEquals(200, deleted.status());
		assertEquals("{\"ok\":true,\"changes\":1}", deleted.body());
		assertEquals(0, this.rows.query(Map.of("id", id)).size(), "삭제한 행은 사라진다");

		Wire.Response again = delete("/api/receiver-config/" + id, zToken());
		assertEquals(200, again.status(), "재삭제는 404가 아니다");
		assertEquals("{\"ok\":true,\"changes\":0}", again.body());

		Wire.Response nan = delete("/api/receiver-config/abc", zToken());
		assertEquals(200, nan.status(), "비수치 id는 500이 아니라 200 changes:0이다");
		assertEquals("{\"ok\":true,\"changes\":0}", nan.body());
	}

	// --- 6. 예외 경계: 설정 행만 사라지고 수집된 기사는 불변 -----------------------------------------

	/**
	 * <b>유일한 행 삭제 라우트의 경계를 라우트 밖에서 확인한다</b> — 설정 행을 지운 뒤 이미 수집된
	 * {@code Article}·{@code Contents}가 그대로 있는지 DB에서 직접 본다(SCHEMA.md 76행·계약 파일 7~9행이
	 * 동결한 DB 비파괴 원칙의 예외 경계).
	 *
	 * <p>왜 와이어 층에도 두는가(2026-08-24 테스터 게이트 변이 실측): 이 확인이 없던 시점에 삭제가
	 * Article 테이블 전체를 함께 비우도록 고친 변이가 <b>Java 651 테스트·계약 default 163관측을 전부
	 * green으로 통과</b>했다. 계약 파일은 "수집 기사 불변"의 실측을 후속 collection phase로 미뤄 두었고,
	 * 리포지토리 테스트만으로는 서비스·컨트롤러 층에 심어진 같은 결함을 잡지 못한다 — 라우트를 실제로
	 * 때려서 확인하는 이 테스트가 층에 무관한 그물이다.
	 */
	@Test
	void deletingAConfigRowLeavesAlreadyCollectedArticlesUntouched() {
		String articleId = unique("rcw-keep");
		this.articles.insert(
				Map.of("articleId", articleId, "title", "수집된 기사", "content", "<p>본문</p>"),
				Map.of("articleId", articleId, "title", "수집된 기사", "status", "DES"));

		int id = createConfig("{\"sourceId\":\"" + unique("ct-src") + "\",\"type\":\"FTP\"}");
		Wire.Response deleted = delete("/api/receiver-config/" + id, zToken());
		assertEquals(200, deleted.status());
		assertEquals("{\"ok\":true,\"changes\":1}", deleted.body());
		assertEquals(0, this.rows.query(Map.of("id", id)).size(), "설정 행은 사라진다");

		ArticleAggregate survivor = this.articles.findById(articleId);
		assertNotNull(survivor, "수집된 기사가 설정 삭제와 함께 사라졌다 — 예외 경계가 번졌다");
		assertNotNull(survivor.article(), "Article 행이 사라졌다");
		assertNotNull(survivor.contents(), "Contents 행이 사라졌다");
	}

	// --- 도구 ------------------------------------------------------------------------------------

	private Wire.Response list(String token, String query) {
		String path = "/api/receiver-config" + (query == null ? "" : "?" + query);
		return Wire.send(this.port, "GET", path, Map.of("x-session-id", token), null);
	}

	private Wire.Response delete(String path, String token) {
		return Wire.send(this.port, "DELETE", path, Map.of("x-session-id", token), null);
	}

	private int createConfig(String body) {
		Wire.Response response = Wire.json(this.port, "POST", "/api/receiver-config",
				Map.of("x-session-id", zToken()), body);
		assertEquals(200, response.status(), "픽스처 생성 실패: " + response.body());
		return idOf(response.body());
	}

	private String zToken() {
		return this.sessions.createSession("rc-z");
	}

	private String rToken() {
		return this.sessions.createSession("rc-r");
	}

	private void ensureUser(String userId, String role) {
		Map<String, Object> dto = new LinkedHashMap<>();
		dto.put("userId", userId);
		dto.put("name", userId);
		dto.put("role", role);
		dto.put("password", "rc-wire-pw");
		try {
			this.users.create(dto);
		}
		catch (RuntimeException ignored) {
			// 이미 있다(같은 컨텍스트의 다른 테스트가 만들었다) — 픽스처는 멱등이다.
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

	private static String objectForSource(String body, String sourceId) {
		int marker = body.indexOf("\"sourceId\":\"" + sourceId + "\"");
		assertTrue(marker >= 0, "목록에 sourceId=" + sourceId + " 행이 없다: " + body);
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

	private static String unique(String prefix) {
		return prefix + "-" + Long.toHexString(System.nanoTime());
	}

	private static void assertNoSecret(Wire.Response response, String... plaintexts) {
		assertFalse(response.body().contains("\"password\""), "password 키가 응답에 실렸다");
		assertFalse(response.body().contains("\"apiKey\""), "apiKey 키가 응답에 실렸다");
		for (String plaintext : plaintexts) {
			assertFalse(response.body().contains(plaintext), "시크릿 원문이 응답에 실렸다");
		}
	}
}
