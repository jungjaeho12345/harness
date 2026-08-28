package harness.news.web;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import harness.news.model.ArticleRepository;
import harness.news.service.ExternalProxyClient;
import harness.news.service.LogService;
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
import java.util.stream.Collectors;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.context.TestConfiguration;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Import;
import org.springframework.context.annotation.Primary;
import org.springframework.core.env.Environment;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;

/**
 * 서버 보유 키(ADR-014)의 <b>네 번째 유출면</b> — 와이어와 {@code GET /api/logs/digest}.
 *
 * <h2>왜 이 파일이 필요한가</h2>
 * 계약은 이 축을 <b>구조적으로 볼 수 없다</b>: 계약 하네스가 자식 프로세스 env에서 키 4종을 지우기 때문에
 * 계약이 관측하는 것은 언제나 <b>키가 없는</b> 서버의 데모/`no-key` 경로다. 그래서 "키가 설정된 서버"의
 * 응답은 계약 리포트에 한 줄도 실리지 않는다.
 *
 * <p>그리고 기존 센티넬 테스트 셋({@code MediaSearchServiceTest} · {@code TranslationServiceTest} ·
 * {@code HttpExternalProxyClientTest})은 전부 <b>서비스·어댑터 단위</b>다. 그것들이 보는 면은 (a) 반환값
 * (b) {@code LogService} 링 버퍼 (c) 예외 원인 체인 (d) 프로세스 표준 출력 넷이고, <b>요청이 실제로 컨트롤러 ·
 * 필터 · 전역 예외 핸들러 · 액세스 로그를 거쳐 소켓으로 나가는 경로</b>는 아무도 끝까지 따라가지 않는다.
 * 2026-08-28 ④ 게이트가 실제로 확인한 공백이다.
 *
 * <p>여기서 닫는 면:
 * <ol>
 * <li><b>응답 전문(헤더 + 본문)</b> — 미디어·번역 두 라우트가 <b>키가 설정된</b> 서버에서 내는 실제 바이트.</li>
 * <li><b>{@code GET /api/logs/digest}</b> — 링 버퍼는 요청마다 {@code RequestLogFilter}가 채우고 Z 세션이
 * 그대로 가져간다. 여기 한 조각이 들어가면 그것이 곧 응답이다(ADR-007 · LOGS.md).</li>
 * <li><b>전역 예외 핸들러의 500 본문</b> — {@code GlobalErrorHandler}는 {@code error.toString()}을 <b>로거로</b>
 * 보낸다. 그 값이 응답 본문으로도 새면 키가 그대로 나간다.</li>
 * <li><b>Spring 에러 응답 설정</b> — {@code server.error.include-message}/{@code include-stacktrace}가 켜지면
 * 예외 메시지(=URL=키)와 스택트레이스가 {@code /error} 본문에 실린다. 부팅된 환경에서 직접 확인한다.</li>
 * </ol>
 *
 * <h2>측정 조건 — 키를 실제로 설정하고, 어댑터는 던지게 만든다</h2>
 * 키 4종을 센티넬로 설정하므로 두 서비스는 <b>키가 있는 분기</b>로 간다(데모/`no-key` 폴백이 아니다).
 * 외부로 실제로 나가지 않게 {@link ExternalProxyClient}를 {@link ThrowingProxy}로 갈아끼우고, 그 fake는
 * <b>받은 URL을 그대로 예외 메시지에 담아 던진다</b> — 즉 "어댑터가 키를 흘리는 최악의 경우"를 상정하고도
 * 서버 밖으로는 한 조각도 나가지 않아야 한다. 동시에 fake가 <b>실제로 센티넬이 박힌 URL을 받았는지</b>를
 * 단언해 이 테스트가 공허하지 않음을 증명한다(키 분기를 타지 못했다면 전부 자동 green이 된다).
 */
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
@Import(ExternalKeyLeakWireTest.ThrowingProxyConfig.class)
class ExternalKeyLeakWireTest {

	private static final Path DATA_DIR = TempNewsDb.newDataDir("key-leak-wire");

	/** 부분 문자열 {@code SENTINEL} 하나로 전건을 훑는다 — 조각도 유출이다. */
	private static final String SENTINEL_API_KEY = "SENTINEL-Kv9x7Qb3ZmT0-DO-NOT-LEAK";

	private static final String SENTINEL_CSE_ID = "SENTINEL-cx-8d41ba";

	private static final String SENTINEL_YOUTUBE_KEY = "SENTINEL-yt-51ffc2";

	private static final String SENTINEL_TRANSLATE_KEY = "SENTINEL-tr-2b7e90";

	/** 센티넬 조각을 한 번에 보는 그물 — 키 4종이 어떤 인코딩으로 접혀도 접두는 남는다. */
	private static final String SENTINEL = "SENTINEL";

	private static final String MARKUP = "{\"blocks\":[{\"text\":\"본문\"}]}";

	private static final Pattern SESSION_ID = Pattern.compile("\"sessionId\":\"([0-9a-f]{64})\"");

	private static final String PASSWORD = "key-leak-wire-pw";

	private static final long ONE_DAY_MS = 24L * 60 * 60 * 1000;

	@DynamicPropertySource
	static void properties(DynamicPropertyRegistry registry) {
		registry.add("app.data-dir", () -> DATA_DIR.toAbsolutePath().toString());
		// 키가 **있는** 서버다 — 계약 하네스가 절대 만들지 않는 조건이며 그래서 계약이 못 보는 축이다.
		registry.add("app.media.google-api-key", () -> SENTINEL_API_KEY);
		registry.add("app.media.google-cse-id", () -> SENTINEL_CSE_ID);
		registry.add("app.media.youtube-api-key", () -> SENTINEL_YOUTUBE_KEY);
		registry.add("app.translate.google-api-key", () -> SENTINEL_TRANSLATE_KEY);
	}

	@Value("${local.server.port}")
	private int port;

	@Autowired
	private UserService users;

	@Autowired
	private SessionGuard sessions;

	@Autowired
	private ArticleRepository articles;

	@Autowired
	private ThrowingProxy proxy;

	@Autowired
	private Environment environment;

	@Autowired
	private LogService logs;

	@BeforeEach
	void seedFixtures() {
		ensureUser("kl-r", "R");
		ensureUser("kl-z", "Z");
		this.proxy.seen.clear();
	}

	// --- 0. 비공허성: 키 분기를 실제로 탔다 ---------------------------------------------------------

	/**
	 * 이 클래스의 모든 단언은 "키가 URL에 실제로 박혔다"를 전제로 한다. 그 전제가 무너지면(예: 키 바인딩이
	 * 깨져 데모 폴백으로 새면) 아래 단언들이 <b>전부 자동으로 green</b>이 된다 — 그러니 먼저 증명한다.
	 */
	@Test
	void theAdapterActuallyReceivedUrlsCarryingEverySentinelKey() {
		search("q=probe&type=image");
		search("q=probe&type=video");
		translate(createArticle());

		String urls = String.join("\n", this.proxy.seen);
		assertEquals(3, this.proxy.seen.size(), "세 라우트가 전부 외부 호출 분기를 타야 한다: " + urls);
		assertTrue(urls.contains(SENTINEL_API_KEY), "이미지 검색 URL에 CSE 키가 없다: " + urls);
		assertTrue(urls.contains(SENTINEL_CSE_ID), "이미지 검색 URL에 엔진 id가 없다: " + urls);
		assertTrue(urls.contains(SENTINEL_YOUTUBE_KEY), "영상 검색 URL에 YouTube 키가 없다: " + urls);
		assertTrue(urls.contains(SENTINEL_TRANSLATE_KEY), "번역 URL에 Translate 키가 없다: " + urls);
	}

	// --- 1. 응답 전문 ------------------------------------------------------------------------------

	/**
	 * 미디어 검색 — 어댑터가 키를 담아 던져도 응답은 200 {@code error:true}이고 <b>헤더·본문 어디에도</b>
	 * 센티넬이 없다. 라우트가 진단을 돕겠다며 사유를 실어 주는 순간 그것이 곧 키 유출이다.
	 */
	@Test
	void theMediaResponseNeverCarriesTheKeyEvenWhenTheAdapterThrowsItBack() {
		for (String query : List.of("q=leak&type=image", "q=leak&type=video", "q=leak")) {
			Wire.Response response = search(query);

			assertEquals(200, response.status(), query);
			assertEquals("{\"ok\":true,\"items\":[],\"error\":true}", response.body(),
					"외부 실패는 200 + error:true 고정 shape이다: " + query);
			assertNoSentinel(response, query);
		}
	}

	/** 번역 — 같은 축. 실패는 200 {@code reason:'error'} + 원문 폴백이고 사유에 URL이 섞이지 않는다. */
	@Test
	void theTranslateResponseNeverCarriesTheKeyEvenWhenTheAdapterThrowsItBack() {
		Wire.Response response = translate(createArticle());

		assertEquals(200, response.status());
		assertEquals("{\"ok\":false,\"reason\":\"error\",\"translatedText\":\"본문\"}", response.body(),
				"외부 실패는 200 + reason:error + 원문 폴백이다");
		assertNoSentinel(response, "translate");
	}

	// --- 2. 로그 다이제스트(링 버퍼가 밖으로 나가는 지점) --------------------------------------------

	/**
	 * 세 라우트를 태운 <b>뒤</b> 링 버퍼를 통째로 훑고, 같은 버퍼를 밖으로 내는 라우트도 훑는다.
	 *
	 * <p>서비스 단위 테스트의 링 버퍼 단언은 서비스가 {@code LogService}를 주입받지 않기 때문에 구조적
	 * 트립와이어에 가깝다. 여기서는 <b>실제 요청 경로</b>가 채운 버퍼를 본다 — 액세스 로그 필터 · 전역 예외
	 * 핸들러 · 컨트롤러가 남긴 것 전부가 여기 들어 있다.
	 *
	 * <p>{@code GET /api/logs/digest}의 창은 <b>지난 06:00 → 06:00</b> 반열림 구간이라 방금 쌓인 줄은
	 * 아직 나오지 않는다(정상 · {@code LogService#digest} javadoc). 그래서 비공허성은 <b>버퍼를 직접</b>
	 * 미래 시각으로 열어 증명하고, 라우트 응답은 별도로 훑는다 — 두 면 다 본다.
	 */
	@Test
	void neitherTheLogRingBufferNorTheDigestRouteCarriesTheKey() {
		search("q=leak&type=image");
		search("q=leak&type=video");
		translate(createArticle());

		// 창을 하루 앞으로 밀어 방금 쌓인 줄까지 포함시킨다(라우트로는 도달할 수 없는 관측이다).
		String buffered = this.logs.digest(System.currentTimeMillis() + ONE_DAY_MS).stream()
				.map(String::valueOf).collect(Collectors.joining("\n"));

		assertTrue(buffered.contains("/api/media/search"),
				"훑는 절차가 공허하다 — 방금 태운 요청이 링 버퍼에 없다: " + buffered);
		assertFalse(buffered.contains(SENTINEL),
				"로그 링 버퍼에 서버 보유 키가 실렸다(GET /api/logs/digest로 그대로 나간다): " + buffered);

		Wire.Response digest = Wire.send(this.port, "GET", "/api/logs/digest",
				Map.of("x-session-id", login("kl-z")), null);

		assertEquals(200, digest.status());
		assertNoSentinel(digest, "logs-digest");
	}

	// --- 3. 500 경로와 Spring 에러 응답 설정 --------------------------------------------------------

	/**
	 * 전역 예외 핸들러가 만드는 500 본문은 <b>고정 shape</b>이고 예외 메시지를 담지 않는다.
	 *
	 * <p>{@code POST /api/upload}는 저장 실패를 사유로 접지 않고 그대로 올려 500을 만드는 유일한 자리다.
	 * 여기서는 그보다 확실한 자리를 쓴다 — 존재하지 않는 라우트가 아니라, 본문이 JSON이 아닌 요청으로
	 * 파서 예외를 만들고 그 응답에 센티넬 대신 <b>어떤 예외 메시지도</b> 없음을 본다.
	 */
	@Test
	void theErrorResponseCarriesNoExceptionDetail() {
		Wire.Response broken = Wire.json(this.port, "POST", "/api/photos",
				Map.of("x-session-id", this.sessions.createSession("kl-r")), "{\"src\": ");

		assertTrue(broken.status() >= 400, "깨진 JSON이 성공했다: " + broken.status() + " " + broken.body());
		assertTrue(broken.body().startsWith("{\"ok\":false,\"reason\":\""),
				"에러 응답이 고정 사유 shape이 아니다: " + broken.body());
		for (String detail : List.of("Exception", "com.fasterxml", "tools.jackson", "harness.news",
				"Unexpected end-of-input", "\"trace\"", "\"message\"", "\"path\"")) {
			assertFalse(broken.body().contains(detail),
					"에러 응답에 예외 상세가 실렸다(" + detail + "): " + broken.body());
		}
	}

	/**
	 * Spring Boot의 에러 속성 노출은 <b>꺼져 있어야</b> 한다.
	 *
	 * <p>{@code server.error.include-message=always} 한 줄이면 {@code /error} 본문에 예외 메시지가 실리고,
	 * 프록시 예외의 메시지에는 <b>키가 박힌 URL</b>이 들어 있다. 이 값들은 어느 라우트에도 나타나지 않아
	 * 계약도 와이어 테스트도 못 보는 <b>설정 한 줄</b>짜리 유출면이라 값 자체를 못 박는다.
	 */
	@Test
	void springErrorAttributeExposureStaysOff() {
		for (String key : List.of("server.error.include-message", "server.error.include-stacktrace",
				"server.error.include-exception", "server.error.include-binding-errors")) {
			String value = this.environment.getProperty(key);

			assertTrue(value == null || "never".equals(value) || "false".equals(value),
					key + " 가 켜져 있다 — 예외 메시지·스택트레이스가 에러 응답으로 나간다: " + value);
		}
		assertNull(this.environment.getProperty("server.error.include-stacktrace"),
				"스택트레이스 노출 설정이 명시적으로 등장했다 — 기본값(never)에서 벗어난 순간을 diff로 보게 한다");
	}

	// --- 도구 --------------------------------------------------------------------------------------

	/** 헤더 줄 전부 + 본문을 한 문자열로 이어 훑는다(헤더에 실리는 유출도 유출이다). */
	private static void assertNoSentinel(Wire.Response response, String label) {
		String wire = String.join("\n", response.headerLines()) + "\n" + response.body();

		assertFalse(wire.contains(SENTINEL), "응답 전문에 서버 보유 키가 실렸다(" + label + "): " + wire);
	}

	private Wire.Response search(String query) {
		return Wire.send(this.port, "GET", "/api/media/search?" + query,
				Map.of("x-session-id", this.sessions.createSession("kl-r")), null);
	}

	private Wire.Response translate(String articleId) {
		return Wire.json(this.port, "POST", "/api/articles/" + articleId + "/translate",
				Map.of("x-session-id", this.sessions.createSession("kl-r")), "{}");
	}

	private String login(String userId) {
		Wire.Response response = Wire.json(this.port, "POST", "/api/login", Map.of(),
				"{\"userId\":\"" + userId + "\",\"password\":\"" + PASSWORD + "\"}");
		Matcher matcher = SESSION_ID.matcher(response.body());
		assertTrue(matcher.find(), "로그인 응답에서 세션을 찾지 못했다: " + response.body());
		return matcher.group(1);
	}

	private String createArticle() {
		String articleId = "kl-" + Long.toHexString(System.nanoTime());
		Map<String, Object> article = new LinkedHashMap<>();
		article.put("articleId", articleId);
		article.put("title", "키 유출 픽스처");
		article.put("markupVersion", MARKUP);
		Map<String, Object> contents = new LinkedHashMap<>();
		contents.put("articleId", articleId);
		contents.put("title", "키 유출 픽스처");
		contents.put("status", "DES");
		this.articles.insert(article, contents);
		return articleId;
	}

	private void ensureUser(String userId, String role) {
		Map<String, Object> dto = new LinkedHashMap<>();
		dto.put("userId", userId);
		dto.put("name", userId);
		dto.put("role", role);
		dto.put("password", PASSWORD);
		try {
			this.users.create(dto);
		}
		catch (RuntimeException ignored) {
			// 이미 있다 — 픽스처는 멱등이다.
		}
	}

	/**
	 * 프로덕션 어댑터를 대신하는 fake — <b>받은 URL을 그대로 예외에 담아 던진다</b>.
	 *
	 * <p>실제 소켓을 열지 않는 것이 첫 목적이고(테스트가 googleapis.com을 때리면 안 된다), 두 번째 목적은
	 * <b>최악의 경우 상정</b>이다: 어댑터가 규율을 어기고 URL을 밖으로 흘리더라도 서비스·컨트롤러·전역
	 * 핸들러가 그것을 응답과 로그에서 잘라내야 한다.
	 */
	static final class ThrowingProxy implements ExternalProxyClient {

		private final List<String> seen = new ArrayList<>();

		@Override
		public Result get(String url) {
			this.seen.add(url);
			throw new IllegalStateException("upstream failed for " + url);
		}

		@Override
		public Result post(String url) {
			this.seen.add(url);
			throw new IllegalStateException("upstream failed for " + url);
		}

	}

	@TestConfiguration(proxyBeanMethods = false)
	static class ThrowingProxyConfig {

		@Bean
		@Primary
		ThrowingProxy throwingProxy() {
			return new ThrowingProxy();
		}

	}

}
