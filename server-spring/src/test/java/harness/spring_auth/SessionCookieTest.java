package harness.spring_auth;

import static org.junit.jupiter.api.Assertions.assertEquals;

import org.junit.jupiter.api.Test;

/**
 * step3 세션 쿠키 writer — 비프로덕션/프로덕션 발급·만료 속성. Node(express) Set-Cookie와 바이트 동일
 * (속성 순서 포함) — 계약 리포트가 정규화 후 비교하는 대상이다.
 */
class SessionCookieTest {

	@Test
	void nonProdIssueAttributes() {
		String cookie = new SessionCookieWriter(false).issue("abc123");
		assertEquals("sid=abc123; Max-Age=3600; Path=/; HttpOnly; SameSite=Lax", cookie);
	}

	@Test
	void nonProdExpireAttributes() {
		String cookie = new SessionCookieWriter(false).expire();
		assertEquals("sid=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax", cookie);
	}

	@Test
	void prodIssueHasSecureAndSameSiteNone() {
		String cookie = new SessionCookieWriter(true).issue("abc123");
		assertEquals("sid=abc123; Max-Age=3600; Path=/; HttpOnly; Secure; SameSite=None", cookie);
	}

	@Test
	void prodExpireHasSecureAndSameSiteNone() {
		String cookie = new SessionCookieWriter(true).expire();
		assertEquals("sid=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=None", cookie);
	}
}
