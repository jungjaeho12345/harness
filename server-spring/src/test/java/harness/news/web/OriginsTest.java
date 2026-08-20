package harness.news.web;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import org.junit.jupiter.api.Test;

/**
 * Referer → origin 파싱과 loopback 판정 — Node의 {@code new URL(referer).origin} ·
 * {@code isLoopbackOrigin} 동형.
 *
 * <p>파싱 불가는 <b>통과가 아니라 거부</b>다({@code null}을 돌려주고 호출부가 403을 낸다) — "이상하면 통과"는
 * 게이트를 우회하는 가장 흔한 경로다.
 */
class OriginsTest {

	@Test
	void refererOriginDropsPathQueryAndFragment() {
		assertEquals("http://localhost:5173", Origins.fromReferer("http://localhost:5173/editor?tab=1#x"));
	}

	@Test
	void defaultPortsAreNormalizedAwayLikeWhatwgUrl() {
		assertEquals("http://example.com", Origins.fromReferer("http://example.com:80/x"));
		assertEquals("https://example.com", Origins.fromReferer("https://example.com:443/x"));
		assertEquals("https://example.com:8443", Origins.fromReferer("https://example.com:8443/x"));
	}

	@Test
	void schemeAndHostAreLowercased() {
		assertEquals("http://example.com", Origins.fromReferer("HTTP://Example.COM/x"));
	}

	@Test
	void unparseableRefererIsNull() {
		assertNull(Origins.fromReferer("not-a-url"));
		assertNull(Origins.fromReferer(""));
		assertNull(Origins.fromReferer("   "));
		assertNull(Origins.fromReferer("http://"));
		assertNull(Origins.fromReferer("/relative/path"));
		assertNull(Origins.fromReferer(null));
	}

	@Test
	void nonHttpSchemesAreNotOrigins() {
		assertNull(Origins.fromReferer("file:///etc/passwd"));
		assertNull(Origins.fromReferer("javascript:alert(1)"));
		assertNull(Origins.fromReferer("ftp://example.com/x"));
	}

	@Test
	void loopbackHostsAreRecognizedRegardlessOfPort() {
		assertTrue(Origins.isLoopback("http://localhost:5173"));
		assertTrue(Origins.isLoopback("http://localhost"));
		assertTrue(Origins.isLoopback("http://127.0.0.1:59999"));
		assertTrue(Origins.isLoopback("https://[::1]:3000"));
	}

	@Test
	void nonLoopbackOriginsAreRejected() {
		assertFalse(Origins.isLoopback("http://evil.example"));
		assertFalse(Origins.isLoopback("null"), "샌드박스 iframe의 Origin 문자열 'null'은 loopback이 아니다");
		assertFalse(Origins.isLoopback("ftp://localhost"));
		assertFalse(Origins.isLoopback("http://localhost.evil.example"));
		assertFalse(Origins.isLoopback(null));
	}
}
