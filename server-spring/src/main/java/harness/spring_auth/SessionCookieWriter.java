package harness.spring_auth;

/**
 * 세션 쿠키 writer — 프로덕션(APS_PROD_COOKIE=true)/비프로덕션 속성 분기. 헤더 문자열을 **수동 조립**해
 * Node(express res.cookie)의 Set-Cookie 속성 순서와 바이트 동일하게 맞춘다(패리티 diff 0 조건):
 *   비프로덕션 발급: sid=<v>; Max-Age=3600; Path=/; HttpOnly; SameSite=Lax        (Secure 없음)
 *   프로덕션   발급: sid=<v>; Max-Age=3600; Path=/; HttpOnly; Secure; SameSite=None
 *   만료(로그아웃): 값 빈 문자열 + Max-Age=0, 나머지 속성 동일.
 * Expires 속성은 싣지 않는다 — 계약 리포트가 Expires(휘발 시각)를 떨구므로 없어도 정규화 결과가 같다.
 */
public class SessionCookieWriter {

	static final String COOKIE_NAME = "sid";

	private final boolean prod;

	public SessionCookieWriter(boolean prod) {
		this.prod = prod;
	}

	/** 발급 쿠키(Max-Age=3600). */
	public String issue(String sessionId) {
		return build(sessionId, 3600);
	}

	/** 만료 쿠키(빈 값 + Max-Age=0). */
	public String expire() {
		return build("", 0);
	}

	private String build(String value, int maxAgeSeconds) {
		StringBuilder sb = new StringBuilder();
		sb.append(COOKIE_NAME).append('=').append(value);
		sb.append("; Max-Age=").append(maxAgeSeconds);
		sb.append("; Path=/");
		sb.append("; HttpOnly");
		if (prod) {
			sb.append("; Secure");
		}
		sb.append("; SameSite=").append(prod ? "None" : "Lax");
		return sb.toString();
	}
}
