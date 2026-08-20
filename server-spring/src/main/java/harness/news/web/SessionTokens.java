package harness.news.web;

import java.io.ByteArrayOutputStream;
import java.nio.ByteBuffer;
import java.nio.charset.CharacterCodingException;
import java.nio.charset.CharsetDecoder;
import java.nio.charset.CodingErrorAction;
import java.nio.charset.StandardCharsets;

/**
 * 요청에서 세션 토큰을 판독한다 — {@code sid} 쿠키 <b>우선</b>, {@code x-session-id} 헤더 <b>폴백</b>.
 *
 * <h2>쿼리 파라미터는 입력이 아니다</h2>
 * {@code ?session=} 폴백은 URL·액세스 로그·리퍼러로 토큰이 새는 표면이라 서버·클라이언트 양쪽에서
 * 제거됐고 <b>부재가 계약</b>이다(유효한 토큰을 쿼리로 줘도 401 — 2026-08 감사의 권한 상승 3건 중 하나).
 * 그래서 이 클래스는 요청 객체를 받지 않고 <b>헤더 문자열 2개만</b> 받는다: 쿼리를 읽을 방법이 구조적으로
 * 없다("읽지 않는다"를 조건문이 아니라 시그니처로 강제한다).
 *
 * <h2>쿠키 파싱을 직접 하는 이유</h2>
 * 컨테이너의 쿠키 파서({@code request.getCookies()})는 판본마다 인용부호·잘못된 값 처리 규칙이 달라
 * 같은 입력에 다른 결과를 낸다. Node는 {@code Cookie} 헤더를 직접 자르므로(server/index.js parseCookie)
 * 여기서도 같은 규칙을 쓴다: 세미콜론으로 자르고, 첫 {@code =} 기준으로 이름/값을 나눠 양쪽을 trim하고,
 * 퍼센트 디코딩이 실패하면 <b>원본값으로 폴백</b>한다(클라 제어 입력이므로 500이 아니라 401로 수렴한다).
 */
public final class SessionTokens {

	/** 세션 쿠키 이름 — 발급(Set-Cookie)과 판독이 같은 이름을 쓴다. */
	public static final String COOKIE_NAME = "sid";

	/** 전환기 폴백 헤더(쿠키를 못 쓰는 클라이언트용). */
	public static final String HEADER_NAME = "x-session-id";

	private SessionTokens() {
	}

	/**
	 * @param cookieHeader {@code Cookie} 요청 헤더 원문(없으면 null)
	 * @param sessionIdHeader {@code x-session-id} 요청 헤더 원문(없으면 null)
	 * @return 토큰, 없으면 null. <b>쿠키가 있으면 헤더는 보지 않는다</b>(우선순위가 계약이다)
	 */
	public static String read(String cookieHeader, String sessionIdHeader) {
		String fromCookie = cookieValue(cookieHeader, COOKIE_NAME);
		if (fromCookie != null && !fromCookie.isEmpty()) {
			return fromCookie;
		}
		if (sessionIdHeader == null || sessionIdHeader.isBlank()) {
			return null;
		}
		return sessionIdHeader;
	}

	/** {@code Cookie} 헤더에서 이름이 정확히 일치하는 쿠키 값을 꺼낸다(부분 일치 금지). */
	static String cookieValue(String header, String name) {
		if (header == null || header.isEmpty()) {
			return null;
		}
		for (String part : header.split(";")) {
			int eq = part.indexOf('=');
			if (eq == -1) {
				continue;
			}
			if (!part.substring(0, eq).trim().equals(name)) {
				continue;
			}
			return decode(part.substring(eq + 1).trim());
		}
		return null;
	}

	/**
	 * {@code decodeURIComponent} 동형 퍼센트 디코딩 — {@code '+'}는 공백으로 바꾸지 않는다
	 * ({@code URLDecoder}는 바꾼다). 잘못된 이스케이프·잘못된 UTF-8이면 원본을 그대로 돌려준다.
	 */
	private static String decode(String raw) {
		if (raw.indexOf('%') == -1) {
			return raw;
		}
		ByteArrayOutputStream bytes = new ByteArrayOutputStream(raw.length());
		for (int i = 0; i < raw.length(); i++) {
			char c = raw.charAt(i);
			if (c != '%') {
				byte[] encoded = String.valueOf(c).getBytes(StandardCharsets.UTF_8);
				bytes.write(encoded, 0, encoded.length);
				continue;
			}
			if (i + 2 >= raw.length()) {
				return raw;
			}
			int high = Character.digit(raw.charAt(i + 1), 16);
			int low = Character.digit(raw.charAt(i + 2), 16);
			if (high < 0 || low < 0) {
				return raw;
			}
			bytes.write((high << 4) + low);
			i += 2;
		}
		CharsetDecoder decoder = StandardCharsets.UTF_8.newDecoder()
				.onMalformedInput(CodingErrorAction.REPORT)
				.onUnmappableCharacter(CodingErrorAction.REPORT);
		try {
			return decoder.decode(ByteBuffer.wrap(bytes.toByteArray())).toString();
		}
		catch (CharacterCodingException ex) {
			return raw;
		}
	}
}
