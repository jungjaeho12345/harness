package harness.news.web;

import static org.junit.jupiter.api.Assertions.assertEquals;

import org.junit.jupiter.api.Test;

/**
 * Set-Cookie 문자열 조립 — Node(express {@code res.cookie}) 직렬화와 <b>바이트 동일</b>해야 한다.
 *
 * <p>기준값은 Node 리포트 실측이다(2026-08-20). 계약 케이스는 속성을 파싱해서 보므로 순서가 달라도
 * 통과하지만, 계약 리포트 diff는 문자열을 그대로 비교한다 — 그래서 여기서는 순서·대소문자·구분자까지
 * 문자열 전체를 고정한다. {@code ResponseCookie.toString()}(Spring)은 이 순서와 다르다.
 *
 * <p>{@code Expires}는 싣지 않는다: Node는 함께 보내지만 계약 리포트는 절대 시각이라 <b>떨궈서</b>
 * 비교하고({@code contract/lib/record.js} normalizeSetCookie), 만료의 진실은 서버 세션 스토어다
 * ({@code Max-Age}가 같은 계약을 결정적으로 표현한다).
 */
class SessionCookiesTest {

	private final SessionCookies dev = new SessionCookies(false);

	private final SessionCookies prod = new SessionCookies(true);

	@Test
	void developmentIssueCookieMatchesNodeByteForByte() {
		assertEquals("sid=abc123; Max-Age=3600; Path=/; HttpOnly; SameSite=Lax", this.dev.issue("abc123"));
	}

	@Test
	void developmentClearCookieMatchesNodeByteForByte() {
		assertEquals("sid=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax", this.dev.clear());
	}

	@Test
	void productionIssueCookieAddsSecureAndSameSiteNone() {
		assertEquals("sid=abc123; Max-Age=3600; Path=/; HttpOnly; Secure; SameSite=None", this.prod.issue("abc123"));
	}

	@Test
	void productionClearCookieKeepsTheSameAttributes() {
		assertEquals("sid=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=None", this.prod.clear());
	}

	@Test
	void theOnlyDifferenceBetweenTheTwoVariantsIsSecureAndSameSite() {
		assertEquals(this.dev.issue("t").replace("; SameSite=Lax", "; Secure; SameSite=None"),
				this.prod.issue("t"), "두 변형의 차이는 Secure 유무와 SameSite 값뿐이다");
	}
}
