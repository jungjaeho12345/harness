package harness.news.service;

import java.nio.charset.StandardCharsets;

/**
 * URI 조각 인코딩의 <b>Node 의미론</b> — 전역 함수 {@code encodeURIComponent}.
 *
 * <p>{@link NodeString}(공백)·{@code NodeBase64}(디코드)와 같은 지위의 <b>단일 출처</b>다. 분산 재구현을
 * 금지하는 이유는 phase 70의 실측이다: {@code Number()}를 {@code Double.parseDouble}로 로컬 재구현한
 * 자리에서 두 서버의 판정이 갈렸고, 그 갈림이 <b>Node는 지우지 않는 행을 실제로 지웠다</b>.
 *
 * <h2>표준 API로 갈음할 수 없다</h2>
 * <ul>
 * <li>{@link java.net.URLEncoder}는 {@code application/x-www-form-urlencoded} 인코더다 — 공백을
 * {@code +}로 바꾸고 {@code !}·{@code '}·{@code (}·{@code )}·{@code ~}를 퍼센트 인코딩한다. 질의
 * {@code a b}가 {@code a+b}가 되어 외부 API에 <b>다른 검색어</b>가 나간다.</li>
 * <li>{@link java.net.URI}·{@code UriComponentsBuilder}는 RFC 3986 예약 문자를 스킴별 문맥에 따라
 * 남긴다 — {@code &}·{@code =}를 그대로 두면 사용자 질의가 <b>다음 파라미터로 파싱</b>된다(질의
 * 문자열에 값을 주입할 수 있다는 뜻이다).</li>
 * </ul>
 *
 * <h2>규칙(ECMA-262 {@code encodeURIComponent})</h2>
 * 비예약 집합 {@code A-Z a-z 0-9 - _ . ! ~ * ' ( )}은 그대로 두고, 나머지는 <b>문자가 아니라 UTF-8
 * 바이트</b>를 {@code %XX}(대문자 hex)로 적는다. 그래서 {@code 뉴}는 {@code %EB%89%B4} 3바이트이고
 * 이모지는 4바이트다.
 *
 * <p>이 축은 <b>계약이 구조적으로 보지 못한다</b> — 계약 질의는 ASCII {@code contract-media-q} 하나이고
 * 리포트는 링크 문자열을 기록하지 않는다(index.json decisions (13)). {@code NodeUriTest}의 Node 실측표가
 * 유일 방어선이다.
 */
public final class NodeUri {

	/** 비예약 집합 중 영숫자가 아닌 것들 — ECMA-262 {@code uriUnescaped}의 {@code uriMark}. */
	private static final String UNRESERVED_MARKS = "-_.!~*'()";

	private static final char[] HEX = "0123456789ABCDEF".toCharArray();

	private NodeUri() {
	}

	/**
	 * JS {@code encodeURIComponent(raw)}.
	 *
	 * @param raw 인코딩할 질의 조각. {@code null}이면 <b>빈 문자열</b>이다 — 라우트의
	 * {@code req.query.q ?? ''}와 같은 자리이고, 여기서 {@code NullPointerException}이 나면 200이어야 할
	 * 미디어 검색이 500이 된다(decisions (24))
	 * @return 퍼센트 인코딩된 문자열
	 * @throws IllegalArgumentException 짝 없는 서러게이트일 때. JS는 그 입력에 {@code URIError}를 던지고
	 * 정본에서는 그것이 500이 된다 — 조용히 {@code ?}로 치환하면({@link String#getBytes(java.nio.charset.Charset)}의
	 * 기본 동작이다) 두 서버가 다른 URL을 만든다. 와이어로는 도달할 수 없다(퍼센트 디코딩은 잘못된
	 * UTF-8을 U+FFFD로 바꾼다)
	 */
	public static String encodeURIComponent(String raw) {
		if (raw == null || raw.isEmpty()) {
			return "";
		}
		StringBuilder out = new StringBuilder(raw.length() + 16);
		int index = 0;
		while (index < raw.length()) {
			char unit = raw.charAt(index);
			if (isUnreserved(unit)) {
				out.append(unit);
				index++;
				continue;
			}
			int codePoint;
			if (Character.isHighSurrogate(unit)) {
				char low = ((index + 1) < raw.length()) ? raw.charAt(index + 1) : 0;
				if (!Character.isLowSurrogate(low)) {
					throw new IllegalArgumentException("URI malformed"); // JS URIError 동형(입력은 담지 않는다)
				}
				codePoint = Character.toCodePoint(unit, low);
				index += 2;
			}
			else if (Character.isLowSurrogate(unit)) {
				throw new IllegalArgumentException("URI malformed");
			}
			else {
				codePoint = unit;
				index++;
			}
			appendPercentEncoded(out, codePoint);
		}
		return out.toString();
	}

	/** ECMA-262 {@code uriUnescaped} = {@code uriAlpha} ∪ {@code DecimalDigit} ∪ {@code uriMark}. */
	private static boolean isUnreserved(char c) {
		return (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9')
				|| UNRESERVED_MARKS.indexOf(c) >= 0;
	}

	/** 코드포인트 하나를 UTF-8 바이트로 펼쳐 {@code %XX}(대문자 hex)로 적는다. */
	private static void appendPercentEncoded(StringBuilder out, int codePoint) {
		byte[] utf8 = new String(Character.toChars(codePoint)).getBytes(StandardCharsets.UTF_8);
		for (byte value : utf8) {
			int unsigned = value & 0xFF;
			out.append('%').append(HEX[unsigned >> 4]).append(HEX[unsigned & 0x0F]);
		}
	}

}
