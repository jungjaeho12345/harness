package harness.news.web;

import static org.junit.jupiter.api.Assertions.assertArrayEquals;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import harness.news.testsupport.TempNewsDb;
import harness.news.testsupport.Wire;
import java.io.IOException;
import java.io.UncheckedIOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Base64;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;

/**
 * SPA 동일 출처 서빙의 <b>와이어</b> 계약 — Node {@code test/spa-serving.test.js} 25항 중 B·C·E군의 동형이다.
 *
 * <p>정본은 Node {@code server/index.js} 1219~1238행({@code express.static} + 폴백)이고, 규칙은
 * {@link SpaFallbackRules}가 소유한다. 이 클래스는 <b>규칙이 실제 와이어에서 그대로 관측되는지</b>만 본다.
 *
 * <h2>이 파일이 유일 방어선인 축</h2>
 * <b>미정의 {@code /api} 경로가 SPA 200으로 뒤집히는 결함</b>을 계약 하네스는 구조적으로 볼 수 없다
 * ({@code scripts/spring-contract.mjs}의 {@code javaChildEnv()}가 {@code SPA_DIR}을 자식에게 넘기지 않아
 * 313관측이 언제나 <b>비활성</b> 상태로 돈다). 같은 이유로 CSP 헤더도 계약 밖이다
 * ({@code contract/lib/record.js}의 허용 헤더 목록에 보안 헤더가 없다). 그래서 여기서 잠근다.
 *
 * <h2>404 규약 무변이 이 step의 가장 위험한 지점이다</h2>
 * 미정의 경로의 404는 {@code GlobalErrorHandler.handleNotFound} → {@code HtmlErrors.notFound}가 만든다.
 * SPA 폴백을 잘못 붙이면 그 요청이 200 HTML로 뒤집히므로, 여기서는 상태코드뿐 아니라 <b>본문 바이트가
 * 기존 404와 동일한지</b>까지 본다(대조군은 SPA와 무관한 {@code /api/does-not-exist}다).
 *
 * <h2>데이터 안전</h2>
 * 데이터 디렉토리는 OS 임시 디렉토리이고 SPA 루트도 임시 디렉토리다 — 리포 {@code news.db}·{@code uploads/}·
 * {@code web/dist}는 이 클래스가 열지 않는다(실제 빌드 산출물 스모크는 {@link SpaRealDistWireTest}가 한다).
 */
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
class SpaServingWireTest {

	private static final Path DATA_DIR = TempNewsDb.newDataDir("spa-serving");

	/** SPA 루트의 <b>부모</b> — 형제 파일 비노출(위치 문자열의 끝 슬래시) 프로브가 여기에 비밀을 놓는다. */
	private static final Path SPA_PARENT = createSpaFixture();

	private static final Path SPA_ROOT = SPA_PARENT.resolve("dist");

	/** 가짜 dist 픽스처 — Node 테스트의 표식 문자열을 그대로 쓴다. */
	private static final String FIXTURE_INDEX = "<!doctype html><html lang=\"ko\"><head><title>spa</title></head>"
			+ "<body><div id=\"root\">SPA-FIXTURE-INDEX</div></body></html>";

	private static final String FIXTURE_ASSET = "console.log(\"SPA-FIXTURE-ASSET\");";

	private static final String SIBLING_SECRET = "SPA-SIBLING-SECRET-MUST-NOT-BE-SERVED";

	private static final String DOTFILE_SECRET = "SPA-DOTFILE-SECRET-MUST-NOT-BE-SERVED";

	/** SQLite 파일의 매직 헤더 — 응답 본문에 있으면 DB가 새어 나간 것이다. */
	private static final String SQLITE_MAGIC = "SQLite format 3";

	/** 서버가 발급하는 형태의 업로드 저장명(32자 소문자 hex). */
	private static final String HEX = "0123456789abcdef0123456789abcdef";

	private static final byte[] PNG = Base64.getDecoder().decode(
			"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==");

	private static final String HTML_ACCEPT = "text/html,application/xhtml+xml,*/*;q=0.8";

	/**
	 * Node helmet이 실제로 내보내는 CSP 원문 — <b>바이트 그대로</b>다(2026-09-05 원시 소켓 실측).
	 *
	 * <p><b>지시자는 7종이 아니라 14종이다.</b> {@code server/index.js} 494~506행이 명시한 7종 뒤에 helmet의
	 * 기본 지시자 6종({@code base-uri}·{@code font-src}·{@code form-action}·{@code object-src}·
	 * {@code script-src-attr}·{@code upgrade-insecure-requests})이 그대로 따라 붙고, 구분자는 공백 없는
	 * {@code ;}다. 소스만 읽고 7종을 조립하면 <b>Node와 바이트가 갈린다</b> — 그래서 값은 실측에서만 온다.
	 */
	private static final String NODE_CSP = "default-src 'self';script-src 'self';img-src 'self' data: https:;"
			+ "connect-src 'self';frame-src 'self' https://www.youtube.com https://www.youtube-nocookie.com;"
			+ "frame-ancestors 'self';style-src 'self' 'unsafe-inline';base-uri 'self';font-src 'self' https: data:;"
			+ "form-action 'self';object-src 'none';script-src-attr 'none';upgrade-insecure-requests";

	@DynamicPropertySource
	static void properties(DynamicPropertyRegistry registry) {
		registry.add("app.data-dir", () -> DATA_DIR.toAbsolutePath().toString());
		registry.add("app.spa-dir", () -> SPA_ROOT.toAbsolutePath().toString());
	}

	@Value("${local.server.port}")
	private int port;

	private static Path createSpaFixture() {
		try {
			Path parent = Files.createTempDirectory("news-spring-spa-fixture-");
			Path dist = Files.createDirectory(parent.resolve("dist"));
			Files.writeString(dist.resolve("index.html"), FIXTURE_INDEX, StandardCharsets.UTF_8);
			Files.createDirectory(dist.resolve("assets"));
			Files.writeString(dist.resolve("assets").resolve("app-abc123.js"), FIXTURE_ASSET, StandardCharsets.UTF_8);
			Path hidden = Files.createDirectory(dist.resolve(".hidden"));
			Files.writeString(hidden.resolve("secret.txt"), DOTFILE_SECRET, StandardCharsets.UTF_8);
			Files.writeString(dist.resolve(".env"), DOTFILE_SECRET, StandardCharsets.UTF_8);
			// SPA 루트의 형제 — 위치 문자열의 끝 슬래시가 빠지면 이것이 서빙된다.
			Files.writeString(parent.resolve("sibling-secret.txt"), SIBLING_SECRET, StandardCharsets.UTF_8);
			return parent;
		}
		catch (IOException ex) {
			throw new UncheckedIOException(ex);
		}
	}

	/** 업로드 파일 배치 — SPA가 켜진 상태에서도 {@code /uploads} 정적 서빙이 그대로인지 보는 프로브다. */
	@BeforeAll
	static void placeUpload() throws IOException {
		Path uploads = DATA_DIR.resolve("uploads");
		Files.createDirectories(uploads);
		Files.write(uploads.resolve(HEX + ".png"), PNG);
	}

	private Wire.RawResponse get(String path) {
		return Wire.raw(this.port, "GET", path, Map.of(), null);
	}

	private Wire.RawResponse getAsBrowser(String path) {
		return Wire.raw(this.port, "GET", path, Map.of("Accept", HTML_ACCEPT), null);
	}

	private static String body(Wire.RawResponse response) {
		return new String(response.body(), StandardCharsets.UTF_8);
	}

	// --- B. 서빙 활성 ---

	/** B5: {@code GET /} → 200 index.html. {@code Accept} 무관이다(express.static의 index 옵션과 같은 자리). */
	@Test
	void theRootIsServedAsTheIndexDocument() {
		Wire.RawResponse response = get("/");

		assertEquals(200, response.status(), "GET / 이 200이 아니면 Electron 클라가 화면을 못 받는다(appUrl = ${origin}/)");
		assertEquals(FIXTURE_INDEX, body(response));
		assertTrue(response.line("content-type").toLowerCase(java.util.Locale.ROOT).contains("text/html"),
				"index 문서의 content-type: " + response.line("content-type"));
	}

	/** B6: 실재하는 자산은 {@code Accept: *&#47;*}로도 서빙된다(폴백의 Accept 게이트는 자산에 걸리지 않는다). */
	@Test
	void anExistingAssetIsServedRegardlessOfAccept() {
		Wire.RawResponse response = get("/assets/app-abc123.js");

		assertEquals(200, response.status());
		assertEquals(FIXTURE_ASSET, body(response));
		assertTrue(response.line("content-type").toLowerCase(java.util.Locale.ROOT).contains("javascript"),
				"자산의 content-type: " + response.line("content-type"));
	}

	/** B7: {@code .do} 7경로 전부가 index.html로 폴백된다({@code web/src/app/routing.js} 7행의 ROUTES). */
	@Test
	void everyDotDoRouteFallsBackToTheIndexDocument() {
		for (String route : List.of("/login.do", "/writer.do", "/list.do", "/rcvMgmt.do", "/userMgmt.do",
				"/logs.do", "/distMgmt.do")) {
			Wire.RawResponse response = getAsBrowser(route);

			assertEquals(200, response.status(), route);
			assertEquals(FIXTURE_INDEX, body(response), route);
		}
	}

	/** B8: 쿼리스트링은 판정에 관여하지 않는다. */
	@Test
	void aQueryStringDoesNotChangeTheFallback() {
		Wire.RawResponse response = getAsBrowser("/writer.do?articleId=A1");

		assertEquals(200, response.status());
		assertEquals(FIXTURE_INDEX, body(response));
	}

	/** B9: HEAD는 200이되 본문이 없다. */
	@Test
	void headIsServedWithoutABody() {
		Wire.RawResponse response = Wire.raw(this.port, "HEAD", "/list.do", Map.of("Accept", HTML_ACCEPT), null);

		assertEquals(200, response.status());
		assertEquals(0, response.body().length, "HEAD 응답에 본문이 실렸다");
	}

	// --- C. 경계 — 폴백이 절대 먹으면 안 되는 곳 ---

	/** C10~C12: API 라우트는 SPA가 켜져도 그대로다(200 JSON · 미인증 401 JSON). */
	@Test
	void apiRoutesAreNotShadowedByTheSpa() {
		Wire.RawResponse health = getAsBrowser("/api/health");
		assertEquals(200, health.status());
		assertEquals("{\"ok\":true}", body(health));

		for (String path : List.of("/api/articles", "/api/stream")) {
			Wire.RawResponse response = getAsBrowser(path);
			assertEquals(401, response.status(), path);
			assertEquals("{\"ok\":false,\"reason\":\"unauthenticated\"}", body(response), path);
		}
	}

	/**
	 * C13: 미정의 {@code /api} 경로는 <b>404 + 기존 바이트 그대로</b>다.
	 *
	 * <p>세 프로브 전부를 본다: 새 경로 하나와 <b>기존 계약 테스트가 쓰는 두 경로</b>
	 * ({@code PathPolicyWireTest}의 {@code /api/undefined-path-probe} · {@code NotFoundWireTest}의
	 * {@code /api/does-not-exist})다. 대조군은 그 자신이 아니라 <b>본문 바이트 비교</b>다.
	 */
	@Test
	void undefinedApiPathsKeepTheir404BytesExactly() {
		byte[] expected = getAsBrowser("/api/does-not-exist").body();

		for (String path : List.of("/api/unknown-path", "/api/undefined-path-probe", "/api/does-not-exist")) {
			Wire.RawResponse response = getAsBrowser(path);

			assertEquals(404, response.status(), path + " 이 200으로 뒤집혔다 — 예약 접두사 게이트를 확인하라");
			assertEquals("Content-Type: text/html; charset=utf-8", response.line("content-type"), path);
			assertArrayEquals(expected, response.body(), path + " 의 404 본문 바이트가 갈렸다");
			assertFalse(body(response).contains("SPA-FIXTURE-INDEX"), path + " 이 index.html을 받았다");
		}
	}

	/** C14: {@code /uploads} 미존재 파일은 404이며 index.html이 아니다. */
	@Test
	void aMissingUploadIsNotTheIndexDocument() {
		Wire.RawResponse response = getAsBrowser("/uploads/missing.png");

		assertEquals(404, response.status());
		assertFalse(body(response).contains("SPA-FIXTURE-INDEX"), "/uploads 요청이 index.html을 받았다");
	}

	/** {@code /uploads} 정적 서빙은 SPA가 켜져도 그대로다(더 구체적인 패턴이 먼저 잡힌다). */
	@Test
	void theUploadsStaticServingSurvivesTheSpaHandler() {
		Wire.RawResponse response = get("/uploads/" + HEX + ".png");

		assertEquals(200, response.status(), "SPA 핸들러가 /uploads 서빙을 가렸다 — 발행 HTML의 이미지가 전부 깨진다");
		assertArrayEquals(PNG, response.body());
		assertEquals("Content-Type: image/png", response.line("content-type"));
	}

	/** C15: 비-GET은 폴백 대상이 아니다 — 404이며 그 바이트도 기존 404와 같다. */
	@Test
	void aPostIsNeverFallenBack() {
		byte[] expected = getAsBrowser("/api/does-not-exist").body();
		Wire.RawResponse response = Wire.raw(this.port, "POST", "/list.do", Map.of("Accept", HTML_ACCEPT), null);

		assertEquals(404, response.status());
		assertArrayEquals(expected, response.body(), "비-GET 404의 본문 바이트가 갈렸다");
	}

	/** C16: {@code Accept}에 {@code text/html}이 없으면 없는 자산은 404다(200 HTML 함정 차단). */
	@Test
	void aMissingAssetWithoutHtmlAcceptIs404() {
		Wire.RawResponse response = get("/assets/does-not-exist.js");

		assertEquals(404, response.status(),
				"해시가 어긋난 자산이 200 HTML을 받으면 화면이 조용히 깨진다 — Accept 게이트를 확인하라");
		assertFalse(body(response).contains("SPA-FIXTURE-INDEX"));
	}

	/** 예약 접두사는 <b>단어 경계</b>에서만 끊긴다 — {@code /apidocs}는 SPA 경로다(A3의 와이어 확인). */
	@Test
	void aPathThatMerelyStartsWithAReservedWordIsStillSpa() {
		for (String path : List.of("/apidocs", "/uploadsomething")) {
			assertEquals(200, getAsBrowser(path).status(), path);
		}
	}

	/** 대문자 예약 접두사도 API 네임스페이스다 — SPA로 뒤집히지 않는다(소문자화 잠금). */
	@Test
	void anUppercaseReservedPrefixIsStillReserved() {
		for (String path : List.of("/API/unknown", "/Api/health", "/UPLOADS/x.png")) {
			Wire.RawResponse response = getAsBrowser(path);

			assertNotEquals(200, response.status(), path + " 이 200을 받았다 — 예약 접두사 비교의 소문자화를 확인하라");
			assertFalse(body(response).contains("SPA-FIXTURE-INDEX"), path);
		}
	}

	/**
	 * C17: 경로 탈출 — SPA 루트 밖 파일 내용이 응답에 실리지 않는다.
	 *
	 * <p>{@link Wire}로 <b>요청줄 원문</b>을 보낸다({@code UploadsStaticWireTest}의 변형 목록을 본떴다).
	 * 상태코드는 단언하지 않는다 — Node도 폴백이 index.html을 주므로(정본 C17 주석) 계약은 "루트 밖 내용
	 * 미노출"뿐이다.
	 */
	@Test
	void pathTraversalNeverLeaksContentOutsideTheSpaRoot() {
		List<String> escapes = List.of(
				"/../sibling-secret.txt",
				"/..%2fsibling-secret.txt",
				"/%2e%2e/sibling-secret.txt",
				"/....//sibling-secret.txt",
				"/..%5csibling-secret.txt",
				"/%252e%252e/sibling-secret.txt",
				"/../../news.db",
				"/%2e%2e/news.db");

		for (String escape : escapes) {
			Wire.RawResponse response = Wire.raw(this.port, "GET", escape, Map.of("Accept", HTML_ACCEPT), null);

			assertFalse(response.bodyAsLatin1().contains(SIBLING_SECRET), "루트 밖 파일 내용이 실렸다: " + escape);
			assertFalse(response.bodyAsLatin1().contains(SQLITE_MAGIC), "news.db 바이트가 실렸다: " + escape);
		}
	}

	/** SPA 루트의 <b>형제</b> 파일은 서빙되지 않는다(위치 문자열의 끝 슬래시 — {@code /uploads} 선례와 동형). */
	@Test
	void theSiblingOfTheSpaRootIsNotServed() {
		Wire.RawResponse response = get("/sibling-secret.txt");

		assertNotEquals(200, response.status(), "SPA 루트의 형제 파일이 서빙됐다 — 위치 문자열의 끝 슬래시를 확인하라");
		assertFalse(response.bodyAsLatin1().contains(SIBLING_SECRET), "형제 파일 내용이 응답에 실렸다");
	}

	/** dotfile은 서빙되지 않는다(Node {@code dotfiles:'ignore'} 동형 — 점 디렉토리 <b>하위</b>까지). */
	@Test
	void dotfilesAreNeverServed() {
		for (String path : List.of("/.hidden/secret.txt", "/.env")) {
			for (String accept : List.of(HTML_ACCEPT, "*/*")) {
				Wire.RawResponse response = Wire.raw(this.port, "GET", path, Map.of("Accept", accept), null);

				assertFalse(response.bodyAsLatin1().contains(DOTFILE_SECRET),
						"dotfile 내용이 응답에 실렸다: " + path + " (Accept: " + accept + ")");
			}
		}
	}

	/** C18: CSRF 가드는 SPA가 켜져도 그대로다(악성 Origin의 POST는 403 forbidden-origin). */
	@Test
	void theCsrfGuardIsUnaffectedByTheSpa() {
		Wire.RawResponse response = Wire.raw(this.port, "POST", "/api/logout",
				Map.of("Origin", "https://evil.example", "Accept", HTML_ACCEPT), null);

		assertEquals(403, response.status());
		assertEquals("{\"ok\":false,\"reason\":\"forbidden-origin\"}", body(response));
	}

	// --- CSP (ADR-017 결정 1 · excluded (d) 분할 재판정) ---

	/** SPA 문서·자산 응답은 Node와 <b>바이트 동일한</b> CSP를 싣는다. */
	@Test
	void spaResponsesCarryTheNodeContentSecurityPolicyByteForByte() {
		for (String path : List.of("/login.do", "/", "/assets/app-abc123.js")) {
			Wire.RawResponse response = getAsBrowser(path);

			assertEquals(200, response.status(), path);
			assertEquals("Content-Security-Policy: " + NODE_CSP, response.line("content-security-policy"),
					path + " 의 CSP가 Node 원문과 갈렸다");
		}
		assertEquals(344, NODE_CSP.getBytes(StandardCharsets.UTF_8).length,
				"Node 실측 원문의 바이트 수가 바뀌었다 — 값을 다시 재라(추정으로 고치지 마라)");
	}

	/**
	 * <b>경계</b>: {@code /api}·{@code /uploads} 응답에는 CSP를 싣지 않는다.
	 *
	 * <p>나머지 보안 헤더 10종과 함께 이월된 축이다(index.json {@code excluded} (d) ②). 경계를 여기서
	 * 못 박지 않으면 다음 사람이 '반쯤 붙은 상태'를 완성된 것으로 오해한다.
	 */
	@Test
	void apiAndUploadResponsesCarryNoContentSecurityPolicy() {
		for (String path : List.of("/api/health", "/api/articles", "/api/does-not-exist",
				"/uploads/" + HEX + ".png", "/uploads/missing.png")) {
			Wire.RawResponse response = getAsBrowser(path);

			assertNull(response.line("content-security-policy"),
					path + " 에 CSP가 실렸다 — 이 phase가 붙이는 범위는 SPA 응답 1종뿐이다");
		}
	}

	/** HSTS는 붙이지 않는다 — Node도 {@code forceHttps}일 때만 켠다(평문 LAN 배치에서 접속이 깨진다). */
	@Test
	void noResponseCarriesStrictTransportSecurity() {
		for (String path : List.of("/login.do", "/assets/app-abc123.js", "/api/health")) {
			assertNull(getAsBrowser(path).line("strict-transport-security"),
					path + " 에 HSTS가 실렸다 — 평문 HTTP 배치에서 이후 접속이 깨진다");
		}
	}
}
