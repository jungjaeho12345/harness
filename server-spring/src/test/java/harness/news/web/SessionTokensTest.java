package harness.news.web;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;

import org.junit.jupiter.api.Test;

/**
 * 세션 토큰 판독 규칙 — {@code sid} 쿠키 <b>우선</b>, {@code x-session-id} 헤더 <b>폴백</b>.
 *
 * <p>쿼리 파라미터는 이 함수의 입력에 <b>없다</b>: 부재가 계약이라(2026-08 감사의 권한 상승 3건 중 하나)
 * "읽지 않는다"를 조건문이 아니라 시그니처로 강제한다. 요청 객체를 받지 않으므로 쿼리를 읽을 방법이 없다.
 */
class SessionTokensTest {

	@Test
	void cookieWinsOverHeader() {
		assertEquals("aaa", SessionTokens.read("sid=aaa", "bbb"));
	}

	@Test
	void headerIsUsedOnlyWhenTheCookieIsAbsentOrEmpty() {
		assertEquals("bbb", SessionTokens.read(null, "bbb"));
		assertEquals("bbb", SessionTokens.read("other=1", "bbb"));
		assertEquals("bbb", SessionTokens.read("sid=", "bbb"), "빈 쿠키 값은 없는 것과 같다(Node의 || 동형)");
	}

	@Test
	void noTokenAtAllIsNull() {
		assertNull(SessionTokens.read(null, null));
		assertNull(SessionTokens.read("", ""));
		assertNull(SessionTokens.read("other=1; another=2", null));
	}

	@Test
	void cookieIsPickedOutOfAListRegardlessOfPosition() {
		assertEquals("t1", SessionTokens.read("a=1; sid=t1; b=2", null));
		assertEquals("t2", SessionTokens.read("sid=t2", null));
		assertEquals("t3", SessionTokens.read("a=1;sid=t3", null), "공백 없는 구분자도 허용한다");
	}

	@Test
	void similarCookieNamesDoNotMatch() {
		assertNull(SessionTokens.read("sidekick=t1; xsid=t2", null),
				"부분 문자열 일치로 엉뚱한 쿠키를 읽으면 안 된다");
	}

	@Test
	void percentEncodingIsDecodedAndMalformedInputFallsBackToTheRawValue() {
		assertEquals("a b", SessionTokens.read("sid=a%20b", null));
		assertEquals("%zz-broken", SessionTokens.read("sid=%zz-broken", null),
				"클라 제어 입력이다 — 500이 아니라 원본값 폴백(인증 실패 401로 수렴)");
		assertEquals("a+b", SessionTokens.read("sid=a+b", null),
				"decodeURIComponent 동형 — '+'는 공백이 아니다");
	}

	@Test
	void emptyHeaderIsTreatedAsAbsent() {
		assertNull(SessionTokens.read(null, ""));
		assertNull(SessionTokens.read(null, "   "), "공백만 있는 헤더도 토큰이 아니다");
	}
}
