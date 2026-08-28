package harness.news.controller;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import harness.news.model.PhotoRepository;
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
 * 사진DB 2라우트({@code POST /api/photos} · {@code GET /api/photos/search})의 <b>와이어</b> 계약.
 * 정본은 Node {@code server/index.js} 1048~1065행이다.
 *
 * <p>동결된 shape:
 * <pre>
 * POST 200 : {"ok":true,"id":&lt;정수&gt;}
 * POST 400 : {"ok":false,"reason":"invalid-src"}                 ← 라우트 직접 400(ReasonStatus 무접촉)
 * GET  200 : {"ok":true,"items":[{id,src,caption,sourceArticleId,registeredBy,createdAt}, ...]}
 * 401      : {"ok":false,"reason":"unauthenticated"}
 * </pre>
 *
 * <h2>신뢰 경계(ADR-004)가 이 파일의 중심이다</h2>
 * {@code registeredBy}는 <b>검증된 세션에서 재도출한 userId</b>로만 stamp된다 — 본문에 실어 보낸 값은
 * 컨트롤러가 서비스에 <b>넘기지도 않는다</b>. 등록 응답이 {@code {ok,id}}뿐이라 이 축은 <b>되읽기로만</b>
 * 관측된다(계약 파일도 같은 방법을 쓴다).
 *
 * <p>이 테이블은 <b>append-only</b>다: 거부된 등록은 행을 만들지 않고, 어떤 라우트도 행을 지우거나
 * 고치지 않는다.
 */
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
class PhotosWireTest {

	private static final Path DATA_DIR = TempNewsDb.newDataDir("photos-wire");

	private static final String JSON_CONTENT_TYPE = "Content-Type: application/json; charset=utf-8";

	/** {@code src}가 유효한 업로드 상대경로 — 계약이 업로드 라우트로 얻는 형태와 같다. */
	private static final String UPLOADED = "/uploads/0123456789abcdef0123456789abcdef.png";

	/** Photo 행의 스키마 순서 6컬럼 — 응답 원소의 키 순서가 이것과 같아야 한다. */
	private static final List<String> PHOTO_KEYS =
			List.of("id", "src", "caption", "sourceArticleId", "registeredBy", "createdAt");

	private static final Pattern OBJECT = Pattern.compile("\\{[^{}]*\\}");

	private static final Pattern KEY = Pattern.compile("\"([A-Za-z]+)\":");

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

	/** 거부가 행을 만들지 않았음을 라우트 밖에서 확인하는 음성 증거. */
	@Autowired
	private PhotoRepository photos;

	@BeforeEach
	void seedUser() {
		ensureUser("photo-r", "R");
	}

	// --- 1. 등록: {ok,id} 2키 --------------------------------------------------------------------

	@Test
	void registeringAnUploadedPathAndAnHttpsUrlBothReturnOkAndAnIntegerId() {
		String token = unique("ctphoto");

		Wire.Response fromUpload = register("{\"src\":\"" + UPLOADED + "\",\"caption\":\"" + token + " upload\"}");
		assertEquals(200, fromUpload.status());
		assertEquals(JSON_CONTENT_TYPE, fromUpload.line("content-type"));
		assertEquals("{\"ok\":true,\"id\":" + idOf(fromUpload.body()) + "}", fromUpload.body(),
				"등록 응답은 {ok,id} 2키뿐이다");

		Wire.Response fromHttps = register(
				"{\"src\":\"https://example.test/photo.png\",\"caption\":\"" + token + " https\"}");
		assertEquals(200, fromHttps.status());
		assertTrue(idOf(fromHttps.body()) > idOf(fromUpload.body()), "id는 증가한다");
	}

	// --- 2. 검색: 6키 · id DESC · src 원문 보존 · 빈 sourceArticleId --------------------------------

	@Test
	void searchReturnsTheSixSchemaColumnsNewestFirst() {
		String token = unique("ctphoto");
		int first = idOf(register("{\"src\":\"" + UPLOADED + "\",\"caption\":\"" + token + " upload\"}").body());
		int second = idOf(register(
				"{\"src\":\"https://example.test/photo.png\",\"caption\":\"" + token + " https\"}").body());

		Wire.Response found = search("q=" + token);

		assertEquals(200, found.status());
		assertEquals(JSON_CONTENT_TYPE, found.line("content-type"));
		assertTrue(found.body().startsWith("{\"ok\":true,\"items\":["), "봉투는 {ok,items}다");
		List<String> items = items(found.body());
		assertEquals(2, items.size(), "자기 픽스처 2건: " + found.body());
		assertEquals(PHOTO_KEYS, keysOf(items.get(0)), "원소는 Photo 스키마 순서 6키다");
		assertEquals(List.of(second, first), List.of(idOf(items.get(0)), idOf(items.get(1))),
				"최신 등록 우선(id DESC)");
		assertTrue(items.get(1).contains("\"src\":\"" + UPLOADED + "\""), "업로드 상대경로가 그대로 보존된다");
		assertTrue(items.get(0).contains("\"sourceArticleId\":\"\""),
				"sourceArticleId 생략은 빈 문자열이다(null 아님): " + items.get(0));
	}

	@Test
	void anEmptyQueryDoesNotFilterAndIsTheSameAsOmittingIt() {
		String token = unique("ctphoto-all");
		int id = idOf(register("{\"src\":\"https://example.test/all.png\",\"caption\":\"" + token + " all\"}")
				.body());

		Wire.Response empty = search("q=");
		Wire.Response omitted = Wire.send(this.port, "GET", "/api/photos/search",
				Map.of("x-session-id", token()), null);

		assertEquals(200, empty.status());
		assertEquals(200, omitted.status());
		assertTrue(empty.body().contains("\"id\":" + id + ","), "빈 q는 필터하지 않는다");
		assertEquals(empty.body(), omitted.body(), "q 생략은 빈 q와 같다(req.query.q ?? '')");
	}

	// --- 3. 거부: 400 invalid-src · 행 미생성 -------------------------------------------------------

	@Test
	void disallowedSourcesAre400AndNeverCreateARow() {
		String token = unique("ctphoto-bad");
		List<String> sources = List.of("javascript:alert(1)", "data:image/png;base64,AAA",
				"http://example.test/photo.png", "/uploads/../secret.png");

		for (String src : sources) {
			Wire.Response response = register(
					"{\"src\":\"" + src + "\",\"caption\":\"" + token + " bad\"}");

			assertEquals(400, response.status(), src + " → 400");
			assertEquals("{\"ok\":false,\"reason\":\"invalid-src\"}", response.body(), src);
			assertEquals(JSON_CONTENT_TYPE, response.line("content-type"), src);
		}

		assertEquals("{\"ok\":true,\"items\":[]}", search("q=" + token).body(),
				"거부된 등록이 행을 남겼다");
		assertEquals(List.of(), this.photos.searchByCaption(token), "리포지토리에도 행이 없다");
	}

	// --- 4. 신뢰 경계: body의 registeredBy는 무시된다(ADR-004) --------------------------------------

	@Test
	void theRegisteredByInTheBodyIsIgnoredAndTheSessionUserIsStamped() {
		String token = unique("ctphoto-stamp");

		Wire.Response registered = register("{\"src\":\"https://example.test/forged.png\",\"caption\":\""
				+ token + " forged\",\"registeredBy\":\"someone-else\"}");
		assertEquals(200, registered.status());

		Wire.Response found = search("q=" + token);
		List<String> items = items(found.body());
		assertEquals(1, items.size());
		assertTrue(items.get(0).contains("\"registeredBy\":\"photo-r\""),
				"세션에서 도출한 userId로만 stamp한다: " + items.get(0));
		assertFalse(found.body().contains("someone-else"),
				"클라이언트가 보낸 registeredBy가 저장됐다 — 신뢰 경계가 깨졌다");
	}

	// --- 5. 미인증 401 (두 라우트) ------------------------------------------------------------------

	@Test
	void bothRoutesAre401WithoutASession() {
		Wire.Response create = Wire.json(this.port, "POST", "/api/photos", Map.of(),
				"{\"src\":\"" + UPLOADED + "\",\"caption\":\"x\"}");
		assertEquals(401, create.status());
		assertEquals("{\"ok\":false,\"reason\":\"unauthenticated\"}", create.body());

		Wire.Response query = Wire.send(this.port, "GET", "/api/photos/search?q=x");
		assertEquals(401, query.status());
		assertEquals("{\"ok\":false,\"reason\":\"unauthenticated\"}", query.body());
	}

	// --- 6. 반복 쿼리 키는 콤마 결합 문자열이다 ----------------------------------------------------

	/**
	 * express(qs)의 {@code ?q=a&q=b}는 배열이고 정본은 그것을 {@code `%${q}%`} 템플릿에 넣는다 →
	 * {@code LIKE '%a,b%'}. 첫 값으로 접으면 같은 URL에 두 서버가 다른 행 집합을 준다(계약 밖 축).
	 */
	@Test
	void aRepeatedQueryKeyIsJoinedWithACommaBeforeTheLike() {
		String token = unique("ctphoto-rep");
		register("{\"src\":\"https://example.test/rep.png\",\"caption\":\"" + token + ",second\"}");

		Wire.Response joined = search("q=" + token + "&q=second");
		Wire.Response firstOnly = search("q=" + token);

		assertEquals(1, items(joined.body()).size(), "반복 키는 'token,second'로 결합돼 매칭된다");
		assertEquals(1, items(firstOnly.body()).size());
		assertEquals(0, items(search("q=" + token + "&q=third").body()).size(),
				"결합 문자열이 다르면 매칭되지 않는다(첫 값만 쓰면 여기서 1건이 나온다)");
	}

	// --- 도구 --------------------------------------------------------------------------------------

	private Wire.Response register(String body) {
		return Wire.json(this.port, "POST", "/api/photos", Map.of("x-session-id", token()), body);
	}

	private Wire.Response search(String query) {
		return Wire.send(this.port, "GET", "/api/photos/search?" + query,
				Map.of("x-session-id", token()), null);
	}

	private String token() {
		return this.sessions.createSession("photo-r");
	}

	private static int idOf(String json) {
		Matcher matcher = Pattern.compile("\"id\":(\\d+)").matcher(json);
		assertTrue(matcher.find(), "정수 id가 없다: " + json);
		return Integer.parseInt(matcher.group(1));
	}

	/**
	 * {@code items} 배열의 원소 객체만 뽑는다 — <b>봉투를 먼저 벗긴다</b>. 본문 전체에 객체 패턴을
	 * 걸면 빈 목록 {@code {"ok":true,"items":[]}}이 중첩 없는 객체라 <b>봉투 자신이 원소 1건으로
	 * 세어진다</b>(2026-08-28 실측: 이 함정이 실제로 red를 냈다).
	 */
	private static List<String> items(String body) {
		int start = body.indexOf("\"items\":[");
		assertTrue(start >= 0, "items 배열이 없다: " + body);
		String array = body.substring(start + "\"items\":[".length(), body.lastIndexOf(']'));
		List<String> found = new ArrayList<>();
		Matcher matcher = OBJECT.matcher(array);
		while (matcher.find()) {
			found.add(matcher.group());
		}
		return found;
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

	private void ensureUser(String userId, String role) {
		Map<String, Object> dto = new LinkedHashMap<>();
		dto.put("userId", userId);
		dto.put("name", userId);
		dto.put("role", role);
		dto.put("password", "photo-wire-pw");
		try {
			this.users.create(dto);
		}
		catch (RuntimeException ignored) {
			// 이미 있다 — 픽스처는 멱등이다.
		}
	}

}
