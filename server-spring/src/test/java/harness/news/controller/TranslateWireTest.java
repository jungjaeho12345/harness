package harness.news.controller;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;

import harness.news.model.ArticleRepository;
import harness.news.service.SessionGuard;
import harness.news.service.UserService;
import harness.news.testsupport.TempNewsDb;
import harness.news.testsupport.Wire;
import java.nio.file.Path;
import java.util.LinkedHashMap;
import java.util.Map;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;

/**
 * 번역({@code POST /api/articles/{id}/translate})의 <b>와이어</b> 계약 — 정본은 Node
 * {@code server/index.js} 912~923행이다.
 *
 * <h2>상태코드로 성공을 판정할 수 없다</h2>
 * 키가 없는 서버(= 계약 하네스가 측정하는 서버이자 이 테스트의 서버)에서도 <b>200</b>이고 본문만
 * {@code ok:false}다. 4xx/5xx로 감싸면 상태코드를 해석하지 않는 클라이언트({@code httpModel})가 조용히
 * 깨진다(reason-tokens.md 표 3 #13).
 *
 * <pre>
 * 200 : {"ok":false,"reason":"no-key","translatedText":"&lt;원문&gt;"}   ← 키 없음(graceful degrade)
 * 200 : {"ok":true,"translatedText":""}                            ← 본문이 아예 빈 기사(2키 · 계약 밖)
 * 404 : {"ok":false,"reason":"not-found"}                          ← 없는 기사
 * 401 : {"ok":false,"reason":"unauthenticated"}                    ← 세션 게이트가 존재 판정보다 먼저다
 * </pre>
 *
 * <h2>번역 대상은 서버 DB에서만 온다(ADR-004)</h2>
 * 요청 본문의 {@code text}는 읽지 않는다 — 읽으면 클라이언트가 서버 보유 키로 임의 문자열을 번역시키는
 * 무료 프록시가 된다. 그 축은 계약이 관측하지 않으므로 여기가 방어선이다.
 */
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
class TranslateWireTest {

	private static final Path DATA_DIR = TempNewsDb.newDataDir("translate-wire");

	private static final String JSON_CONTENT_TYPE = "Content-Type: application/json; charset=utf-8";

	/** 기사 본문(블록 문서) — 도출된 텍스트는 {@code "첫 문단\n(끝)"}이다. */
	private static final String MARKUP = "{\"blocks\":[{\"text\":\"첫 문단\"},{\"text\":\"(끝)\"}]}";

	private static final String EXPECTED_TEXT = "첫 문단\\n(끝)";

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
	private ArticleRepository articles;

	@BeforeEach
	void seedUser() {
		ensureUser("translate-r", "R");
	}

	// --- 1. 키 없는 서버는 200 + ok:false + 원문 폴백 ------------------------------------------------

	@Test
	void withoutAKeyItIs200WithNoKeyAndTheOriginalText() {
		String articleId = createArticle(MARKUP);

		Wire.Response response = translate(articleId, "{}");

		assertEquals(200, response.status(), "키 누락을 4xx/5xx로 감싸면 클라이언트가 조용히 깨진다");
		assertEquals(JSON_CONTENT_TYPE, response.line("content-type"));
		assertEquals("{\"ok\":false,\"reason\":\"no-key\",\"translatedText\":\"" + EXPECTED_TEXT + "\"}",
				response.body(), "3키·이 순서·원문 폴백");
	}

	@Test
	void anExplicitTargetLangGivesTheSameResultOnAKeylessServer() {
		String articleId = createArticle(MARKUP);

		Wire.Response withLang = translate(articleId, "{\"targetLang\":\"en\"}");

		assertEquals(200, withLang.status());
		assertEquals("{\"ok\":false,\"reason\":\"no-key\",\"translatedText\":\"" + EXPECTED_TEXT + "\"}",
				withLang.body(), "외부 호출이 없으므로 targetLang은 관측되지 않는다");
	}

	/** 본문의 {@code text}는 <b>읽지 않는다</b> — 번역 대상은 서버 DB에서만 온다(ADR-004). */
	@Test
	void theTextInTheRequestBodyIsNeverUsed() {
		String articleId = createArticle(MARKUP);

		Wire.Response response = translate(articleId,
				"{\"text\":\"CLIENT-SUPPLIED-MUST-NOT-BE-TRANSLATED\"}");

		assertEquals(200, response.status());
		assertFalse(response.body().contains("CLIENT-SUPPLIED"),
				"요청 body의 text가 번역 대상이 됐다 — 서버 보유 키의 무료 프록시가 열린다: " + response.body());
		assertEquals("{\"ok\":false,\"reason\":\"no-key\",\"translatedText\":\"" + EXPECTED_TEXT + "\"}",
				response.body());
	}

	/**
	 * 본문·제목이 모두 빈 기사는 <b>키 판정보다 먼저</b> 2키로 끝난다({@code reason}이 없다). 계약
	 * 픽스처는 본문이 있어 이 분기에 도달하지 못한다 — 와이어에서 잠그는 것은 여기뿐이다.
	 */
	@Test
	void anArticleWithNoTextAtAllTakesTheTwoKeyBranch() {
		String articleId = createArticle(null);

		Wire.Response response = translate(articleId, "{}");

		assertEquals(200, response.status());
		assertEquals("{\"ok\":true,\"translatedText\":\"\"}", response.body(),
				"빈 본문은 reason 없는 2키다(키 판정보다 앞선 분기)");
	}

	// --- 2. 없는 기사만 404 -------------------------------------------------------------------------

	@Test
	void anUnknownArticleIs404NotFound() {
		Wire.Response response = translate("no-such-article-" + Long.toHexString(System.nanoTime()), "{}");

		assertEquals(404, response.status());
		assertEquals("{\"ok\":false,\"reason\":\"not-found\"}", response.body());
		assertEquals(JSON_CONTENT_TYPE, response.line("content-type"));
	}

	// --- 3. 세션 게이트가 존재 판정보다 먼저다 ------------------------------------------------------

	@Test
	void withoutASessionItIs401EvenForAnUnknownArticle() {
		Wire.Response unknown = Wire.json(this.port, "POST",
				"/api/articles/no-such-article/translate", Map.of(), "{}");
		assertEquals(401, unknown.status(), "없는 기사에도 404가 아니라 401이다");
		assertEquals("{\"ok\":false,\"reason\":\"unauthenticated\"}", unknown.body());

		String articleId = createArticle(MARKUP);
		Wire.Response existing = Wire.json(this.port, "POST",
				"/api/articles/" + articleId + "/translate", Map.of(), "{}");
		assertEquals(401, existing.status());
		assertEquals("{\"ok\":false,\"reason\":\"unauthenticated\"}", existing.body());
	}

	// --- 도구 --------------------------------------------------------------------------------------

	private Wire.Response translate(String articleId, String body) {
		return Wire.json(this.port, "POST", "/api/articles/" + articleId + "/translate",
				Map.of("x-session-id", token()), body);
	}

	private String token() {
		return this.sessions.createSession("translate-r");
	}

	private String createArticle(String markup) {
		String articleId = "tw-" + Long.toHexString(System.nanoTime());
		Map<String, Object> article = new LinkedHashMap<>();
		article.put("articleId", articleId);
		article.put("title", (markup == null) ? "" : "번역 픽스처");
		if (markup != null) {
			article.put("markupVersion", markup);
		}
		Map<String, Object> contents = new LinkedHashMap<>();
		contents.put("articleId", articleId);
		contents.put("title", (markup == null) ? "" : "번역 픽스처");
		contents.put("status", "DES");
		this.articles.insert(article, contents);
		return articleId;
	}

	private void ensureUser(String userId, String role) {
		Map<String, Object> dto = new LinkedHashMap<>();
		dto.put("userId", userId);
		dto.put("name", userId);
		dto.put("role", role);
		dto.put("password", "translate-wire-pw");
		try {
			this.users.create(dto);
		}
		catch (RuntimeException ignored) {
			// 이미 있다 — 픽스처는 멱등이다.
		}
	}

}
