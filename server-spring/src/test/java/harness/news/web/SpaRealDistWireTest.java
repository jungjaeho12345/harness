package harness.news.web;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import harness.news.testsupport.TempNewsDb;
import harness.news.testsupport.Wire;
import java.io.IOException;
import java.io.UncheckedIOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;

/**
 * E22: <b>실제 빌드 산출물</b>({@code web/dist}) 스모크 + CSP 호환 잠금 —
 * {@code test/spa-serving.test.js} 274~299행의 동형이다.
 *
 * <p>정본은 네 가지를 <b>함께</b> 단언한다: ① {@code index.html} 본문이 파일과 동일 ② {@code <script src>}를
 * 추출해 그대로 요청하면 200 + {@code javascript} 타입 ③ 응답 헤더 CSP가 {@code script-src 'self'}를 포함
 * ④ 내용 있는 인라인 {@code <script>} 0건 · 모든 {@code src}/{@code href}가 동일 출처 절대 경로.
 *
 * <p>④가 있어서 ③을 붙여도 화면이 깨지지 않는다 — <b>{@code web/dist}가 이미 CSP 호환으로 빌드돼 있다</b>는
 * 사실의 잠금이다. 이 단언이 red면 CSP 완화가 아니라 <b>빌드 설정</b>을 의심하라(정본 289행의 주석).
 *
 * <h2>skip 하지 않는다</h2>
 * 정본은 {@code web/dist} 부재 시 skip이지만 여기서는 <b>fail</b>이다: 이 리포의 게이트는
 * {@code Skipped 0}을 요구하고, 조용한 skip은 "실제 산출물을 한 번도 서빙해 보지 않은 green"을 만든다.
 * {@code web/dist}는 {@code .gitignore} 대상이므로 이 테스트가 red면 <b>{@code npm run build}를 먼저 돌려라</b>
 * (server-spring/README.md 「SPA 동일 출처 서빙」 절).
 *
 * <p>리포 파일은 <b>읽기만</b> 한다. 데이터 디렉토리는 여전히 임시 디렉토리다.
 */
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
class SpaRealDistWireTest {

	private static final Path DATA_DIR = TempNewsDb.newDataDir("spa-real-dist");

	/** 모듈 루트({@code server-spring})가 작업 디렉토리다 — 리포 루트는 그 부모다. */
	private static final Path REAL_DIST = Path.of("").toAbsolutePath().getParent().resolve("web").resolve("dist");

	private static final String HTML_ACCEPT = "text/html,application/xhtml+xml,*/*;q=0.8";

	private static final Pattern SCRIPT_SRC = Pattern.compile("<script[^>]*\\ssrc=\"([^\"]+)\"");

	private static final Pattern SCRIPT_BLOCK = Pattern.compile("<script\\b[^>]*>([\\s\\S]*?)</script>",
			Pattern.CASE_INSENSITIVE);

	private static final Pattern SRC_OR_HREF = Pattern.compile("(?:src|href)=\"([^\"]+)\"");

	@DynamicPropertySource
	static void properties(DynamicPropertyRegistry registry) {
		registry.add("app.data-dir", () -> DATA_DIR.toAbsolutePath().toString());
		registry.add("app.spa-dir", () -> REAL_DIST.toString());
	}

	@Value("${local.server.port}")
	private int port;

	private String indexHtmlOnDisk() {
		Path index = REAL_DIST.resolve("index.html");
		assertTrue(Files.isRegularFile(index),
				"실제 빌드 산출물이 없다 — 'npm run build'를 먼저 실행하라(web/dist는 .gitignore 대상이다): " + index);
		try {
			return Files.readString(index, StandardCharsets.UTF_8);
		}
		catch (IOException ex) {
			throw new UncheckedIOException(ex);
		}
	}

	/** ① 문서 본문이 파일과 같고 ③ CSP가 실린다. */
	@Test
	void theRealIndexDocumentIsServedWithACsp() {
		Wire.RawResponse response = Wire.raw(this.port, "GET", "/login.do", Map.of("Accept", HTML_ACCEPT), null);

		assertEquals(200, response.status());
		assertEquals(indexHtmlOnDisk(), new String(response.body(), StandardCharsets.UTF_8),
				"서빙된 index.html이 디스크의 파일과 다르다");
		assertTrue(response.line("content-security-policy").contains("script-src 'self'"),
				"CSP 헤더에 script-src 'self'가 없다: " + response.line("content-security-policy"));
	}

	/** ② 해시를 하드코딩하지 않는다 — index.html에서 {@code <script src>}를 추출해 그대로 요청한다. */
	@Test
	void theHashedScriptAssetIsServed() {
		String html = indexHtmlOnDisk();
		Matcher script = SCRIPT_SRC.matcher(html);
		assertTrue(script.find(), "index.html에 <script src>가 있어야 한다");

		Wire.RawResponse asset = Wire.raw(this.port, "GET", script.group(1), Map.of("Accept", "*/*"), null);

		assertEquals(200, asset.status(), script.group(1));
		assertTrue(asset.line("content-type").toLowerCase(Locale.ROOT).contains("javascript"),
				"자산의 content-type: " + asset.line("content-type"));
		assertTrue(asset.line("content-security-policy").contains("script-src 'self'"),
				"자산 응답에도 CSP가 실려야 한다: " + asset.line("content-security-policy"));
	}

	/** ④ 내용 있는 인라인 {@code <script>}가 0건이다(그래서 {@code script-src 'self'}로도 화면이 산다). */
	@Test
	void theBuildOutputHasNoInlineScripts() {
		List<String> inline = new ArrayList<>();
		Matcher blocks = SCRIPT_BLOCK.matcher(indexHtmlOnDisk());
		while (blocks.find()) {
			if (!blocks.group(1).isBlank()) {
				inline.add(blocks.group(1));
			}
		}

		assertEquals(List.of(), inline,
				"내용이 있는 인라인 <script>가 있다 — red면 CSP 완화가 아니라 빌드 설정을 의심하라");
	}

	/** ④ 모든 {@code src}/{@code href}가 동일 출처 절대 경로다(외부 출처면 CSP가 그것을 막는다). */
	@Test
	void everyAssetReferenceIsASameOriginAbsolutePath() {
		List<String> foreign = new ArrayList<>();
		Matcher references = SRC_OR_HREF.matcher(indexHtmlOnDisk());
		while (references.find()) {
			if (!references.group(1).startsWith("/")) {
				foreign.add(references.group(1));
			}
		}

		assertEquals(List.of(), foreign, "동일 출처 절대 경로가 아닌 참조가 있다");
	}
}
