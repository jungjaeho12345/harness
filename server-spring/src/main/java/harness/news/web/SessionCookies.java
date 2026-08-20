package harness.news.web;

/**
 * 세션 쿠키(Set-Cookie) 문자열을 조립하는 유일한 지점.
 *
 * <h2>왜 문자열을 손으로 만드는가</h2>
 * {@code ResponseCookie.toString()}(Spring)이나 {@code Cookie} 객체의 컨테이너 직렬화는 속성 순서·표기가
 * express {@code res.cookie}와 다르다. 계약 케이스는 속성을 <b>파싱해서</b> 보므로 순서가 달라도 통과하지만,
 * 계약 리포트 diff는 헤더 문자열을 그대로 비교하므로 순서가 다르면 패리티가 깨진다(기능 green · 바이트 red).
 * Node 실측(2026-08-20)이 기준이다:
 * <pre>
 * sid=&lt;토큰&gt;; Max-Age=3600; Path=/; HttpOnly; SameSite=Lax             (비프로덕션 발급)
 * sid=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax                        (비프로덕션 만료)
 * sid=&lt;토큰&gt;; Max-Age=3600; Path=/; HttpOnly; Secure; SameSite=None    (프로덕션 발급)
 * sid=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=None               (프로덕션 만료)
 * </pre>
 *
 * <h2>Expires를 싣지 않는 이유</h2>
 * Node는 {@code Expires}(절대 시각)도 함께 보내지만 계약 리포트는 그것을 <b>떨궈서</b> 비교한다
 * (contract/lib/record.js normalizeSetCookie — 휘발값이라 이중 실행 diff가 무의미해진다). 같은 계약을
 * 결정적으로 표현하는 것은 {@code Max-Age}이고 계약 케이스도 {@code Max-Age}만 단언한다. 만료의 진실은
 * 어차피 서버 세션 스토어이며 쿠키 수명은 보조 신호다.
 *
 * <h2>프로덕션 분기</h2>
 * {@code SameSite=None}은 {@code Secure}가 있어야 브라우저가 받아들이고, {@code Secure}는 http로 뜨는
 * 로컬/테스트에서 쿠키를 무력화한다. 그래서 두 변형이 존재하며, 판정은 설정 바인딩 한 곳
 * ({@code AppProperties#production()})에서만 하고 컨트롤러는 어느 환경인지 모른다.
 */
public class SessionCookies {

	private static final String NAME = SessionTokens.COOKIE_NAME;

	/** 1시간 — 세션 슬라이딩 만료와 같은 값이다(server/index.js SESSION_COOKIE_MAX_AGE_MS). */
	private static final long MAX_AGE_SECONDS = 3600;

	private final boolean production;

	public SessionCookies(boolean production) {
		this.production = production;
	}

	/** 발급 쿠키 — 값은 세션 토큰이다. */
	public String issue(String token) {
		return build(token, MAX_AGE_SECONDS);
	}

	/** 만료 쿠키 — 빈 값 + {@code Max-Age=0}(삭제 지시). 속성은 발급 쿠키와 같아야 브라우저가 지운다. */
	public String clear() {
		return build("", 0);
	}

	private String build(String value, long maxAgeSeconds) {
		StringBuilder cookie = new StringBuilder();
		cookie.append(NAME).append('=').append(value);
		cookie.append("; Max-Age=").append(maxAgeSeconds);
		cookie.append("; Path=/");
		cookie.append("; HttpOnly");
		if (this.production) {
			cookie.append("; Secure");
		}
		cookie.append("; SameSite=").append(this.production ? "None" : "Lax");
		return cookie.toString();
	}
}
