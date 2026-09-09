package harness.news.web;

import static org.junit.jupiter.api.Assertions.assertEquals;

import org.junit.jupiter.api.Test;

/**
 * {@link SpaContentTypes} — SPA 정적 서빙의 {@code Content-Type} 원문은 <b>Node({@code send} + {@code mime@1.6.0})의
 * 규칙</b>에서 온다. 컨테이너(Tomcat)의 확장자 표가 아니다.
 *
 * <p>phase 76 step3 대조기가 잡은 divergence다(2026-09-07 원시 소켓 실측): Node는 {@code text/html; charset=UTF-8}·
 * {@code text/css; charset=UTF-8}·{@code application/javascript; charset=UTF-8}을 보내는데 이 서버는
 * {@code text/html}·{@code text/css}·{@code text/javascript}를 보냈다 — charset 파라미터가 없고 {@code .js}는
 * <b>기저 타입까지</b> 다르다. 대조기는 content-type 원문을 <b>실패 diff</b>로 비교한다(허용 목록에 넣으면
 * 대조가 공허해진다 — 변이 N4). 그래서 값을 Node 규칙대로 만든다.
 */
class SpaContentTypesTest {

	@Test
	void textTypesCarryTheUpperCaseUtf8Charset() {
		// send는 mime.charsets.lookup으로 text/* 와 application/(javascript|json)에 'UTF-8'(대문자)을 붙인다.
		assertEquals("text/html; charset=UTF-8", SpaContentTypes.nodeOriginal("index.html"));
		assertEquals("text/html; charset=UTF-8", SpaContentTypes.nodeOriginal("page.htm"));
		assertEquals("text/css; charset=UTF-8", SpaContentTypes.nodeOriginal("index-CXiUPvTY.css"));
		assertEquals("text/plain; charset=UTF-8", SpaContentTypes.nodeOriginal("robots.txt"));
	}

	@Test
	void javascriptIsApplicationJavascriptNotTextJavascript() {
		// Tomcat의 표는 js/mjs → text/javascript 지만 mime@1.6.0 은 application/javascript 다(2026-09-07 실측).
		assertEquals("application/javascript; charset=UTF-8", SpaContentTypes.nodeOriginal("index-COYNfnZU.js"));
		assertEquals("application/javascript; charset=UTF-8", SpaContentTypes.nodeOriginal("worker.mjs"));
	}

	@Test
	void jsonAndSourceMapsAreApplicationJsonWithCharset() {
		assertEquals("application/json; charset=UTF-8", SpaContentTypes.nodeOriginal("manifest.json"));
		assertEquals("application/json; charset=UTF-8", SpaContentTypes.nodeOriginal("index-COYNfnZU.js.map"));
	}

	@Test
	void binaryTypesCarryNoCharset() {
		assertEquals("image/png", SpaContentTypes.nodeOriginal("pic.png"));
		assertEquals("image/svg+xml", SpaContentTypes.nodeOriginal("logo.svg"));
		assertEquals("image/x-icon", SpaContentTypes.nodeOriginal("favicon.ico"));
		assertEquals("font/woff2", SpaContentTypes.nodeOriginal("font.woff2"));
		assertEquals("application/manifest+json", SpaContentTypes.nodeOriginal("site.webmanifest"));
	}

	@Test
	void theExtensionIsCaseInsensitive() {
		assertEquals("image/png", SpaContentTypes.nodeOriginal("PIC.PNG"));
		assertEquals("application/javascript; charset=UTF-8", SpaContentTypes.nodeOriginal("APP.JS"));
	}

	@Test
	void unknownOrMissingExtensionsFallBackToOctetStreamLikeSend() {
		// send: mime.lookup 이 모르는 확장자는 application/octet-stream 이다(avif 도 mime@1.6.0 에는 없다).
		assertEquals("application/octet-stream", SpaContentTypes.nodeOriginal("blob.zzz"));
		assertEquals("application/octet-stream", SpaContentTypes.nodeOriginal("README"));
		assertEquals("application/octet-stream", SpaContentTypes.nodeOriginal("photo.avif"));
		assertEquals("application/octet-stream", SpaContentTypes.nodeOriginal(null));
		assertEquals("application/octet-stream", SpaContentTypes.nodeOriginal(""));
	}

	/**
	 * 표의 <b>전건</b>을 잠근다 (④ 테스트 게이트 · 2026-09-09).
	 *
	 * <p>기존 6항은 27개 항목 중 13개만 짚고 있었다 — {@code xml}·{@code gif}·{@code webp}·{@code jpg}·
	 * {@code jpeg}·{@code woff}·{@code ttf}·{@code otf}·{@code eot}·{@code wasm}·{@code mp4}·{@code webm}·
	 * {@code mp3}·{@code pdf} 14개는 값을 바꿔도 red 가 되지 않았다. 이 표는 대조기의 <b>실패 diff</b> 축이라
	 * (허용 목록에 없다) 한 줄만 틀려도 그 확장자의 자산이 배포되는 날 대조가 깨진다. 아래 기대값은 전부
	 * 2026-09-09에 리포의 {@code node_modules/mime@1.6.0}에 직접 물어 옮긴 값이다
	 * ({@code mime.lookup('x.<ext>')} + {@code charsets.lookup} 규칙).
	 */
	@Test
	void everyMeasuredExtensionKeepsItsNodeValue() {
		assertEquals("text/html; charset=UTF-8", SpaContentTypes.nodeOriginal("a.html"));
		assertEquals("text/html; charset=UTF-8", SpaContentTypes.nodeOriginal("a.htm"));
		assertEquals("text/css; charset=UTF-8", SpaContentTypes.nodeOriginal("a.css"));
		assertEquals("application/javascript; charset=UTF-8", SpaContentTypes.nodeOriginal("a.js"));
		assertEquals("application/javascript; charset=UTF-8", SpaContentTypes.nodeOriginal("a.mjs"));
		assertEquals("application/json; charset=UTF-8", SpaContentTypes.nodeOriginal("a.json"));
		assertEquals("application/json; charset=UTF-8", SpaContentTypes.nodeOriginal("a.map"));
		assertEquals("text/plain; charset=UTF-8", SpaContentTypes.nodeOriginal("a.txt"));
		assertEquals("application/xml", SpaContentTypes.nodeOriginal("a.xml"));
		assertEquals("image/svg+xml", SpaContentTypes.nodeOriginal("a.svg"));
		assertEquals("image/png", SpaContentTypes.nodeOriginal("a.png"));
		assertEquals("image/jpeg", SpaContentTypes.nodeOriginal("a.jpg"));
		assertEquals("image/jpeg", SpaContentTypes.nodeOriginal("a.jpeg"));
		assertEquals("image/gif", SpaContentTypes.nodeOriginal("a.gif"));
		assertEquals("image/webp", SpaContentTypes.nodeOriginal("a.webp"));
		assertEquals("image/x-icon", SpaContentTypes.nodeOriginal("a.ico"));
		assertEquals("font/woff", SpaContentTypes.nodeOriginal("a.woff"));
		assertEquals("font/woff2", SpaContentTypes.nodeOriginal("a.woff2"));
		assertEquals("font/ttf", SpaContentTypes.nodeOriginal("a.ttf"));
		assertEquals("font/otf", SpaContentTypes.nodeOriginal("a.otf"));
		assertEquals("application/vnd.ms-fontobject", SpaContentTypes.nodeOriginal("a.eot"));
		assertEquals("application/manifest+json", SpaContentTypes.nodeOriginal("a.webmanifest"));
		assertEquals("application/wasm", SpaContentTypes.nodeOriginal("a.wasm"));
		assertEquals("video/mp4", SpaContentTypes.nodeOriginal("a.mp4"));
		assertEquals("video/webm", SpaContentTypes.nodeOriginal("a.webm"));
		assertEquals("audio/mpeg", SpaContentTypes.nodeOriginal("a.mp3"));
		assertEquals("application/pdf", SpaContentTypes.nodeOriginal("a.pdf"));
	}

	/**
	 * charset 파라미터가 붙는 자리는 {@code mime.charsets.lookup} 의 정규식
	 * {@code /^text\/|^application\/(javascript|json)/} 그대로다 — <b>접두</b> 판정이라
	 * {@code application/manifest+json}·{@code application/ld+json} 처럼 {@code json} 으로 <b>끝나는</b> 타입에는
	 * 붙지 않고, {@code image/svg+xml}·{@code application/xml} 에도 붙지 않는다. 이 규칙을 {@code contains}로
	 * 느슨하게 바꾸면 SPA 200 응답의 content-type 원문이 조용히 갈린다(대조기 실패 diff 축).
	 */
	@Test
	void theCharsetParameterFollowsTheMimeCharsetsRegexNotASubstringMatch() {
		assertEquals("application/manifest+json", SpaContentTypes.nodeOriginal("a.webmanifest"));
		assertEquals("application/xml", SpaContentTypes.nodeOriginal("a.xml"));
		assertEquals("image/svg+xml", SpaContentTypes.nodeOriginal("a.svg"));
		assertEquals("application/wasm", SpaContentTypes.nodeOriginal("a.wasm"));
		// 반대 방향 — text/* 와 application/(javascript|json) 은 반드시 붙는다(세미콜론 뒤 공백 1개 · 대문자).
		assertEquals("text/plain; charset=UTF-8", SpaContentTypes.nodeOriginal("a.txt"));
		assertEquals("application/json; charset=UTF-8", SpaContentTypes.nodeOriginal("a.json"));
	}

	/**
	 * 확장자 추출은 {@code mime.lookup} 과 같다: {@code path.replace(/^.*[\.\/\\]/, '')} — 마지막
	 * {@code .}·{@code /}·{@code \} <b>뒤 전부</b>다. javadoc 이 "경로가 섞여 있어도 된다"고 약속하는데
	 * 그 축을 짚는 단언이 없었다. 2026-09-09 {@code mime@1.6.0} 실측과 같은 값이다.
	 */
	@Test
	void theExtensionComesFromTheLastSeparatorLikeMimeLookup() {
		assertEquals("application/javascript; charset=UTF-8", SpaContentTypes.nodeOriginal("assets/index-COYNfnZU.js"));
		assertEquals("image/png", SpaContentTypes.nodeOriginal("a\\b\\pic.png"));
		// 마지막 구분자가 '/' 라 그 뒤(확장자 없는 이름)를 본다 — 디렉토리 이름의 '.css' 를 확장자로 읽지 않는다.
		assertEquals("application/octet-stream", SpaContentTypes.nodeOriginal("dir.css/README"));
		assertEquals("text/css; charset=UTF-8", SpaContentTypes.nodeOriginal("dir.png/theme.css"));
		// 점으로 끝나거나 점으로 시작하는 이름 — 뒤가 비었거나 확장자가 아니다.
		assertEquals("application/octet-stream", SpaContentTypes.nodeOriginal("x."));
		assertEquals("application/octet-stream", SpaContentTypes.nodeOriginal(".hidden"));
		// 다중 확장자는 마지막 것만 본다.
		assertEquals("application/json; charset=UTF-8", SpaContentTypes.nodeOriginal("index-COYNfnZU.js.map"));
	}
}
