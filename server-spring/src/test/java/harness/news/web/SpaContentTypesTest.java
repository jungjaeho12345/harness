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
}
