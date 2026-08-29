package harness.news.service;

import java.nio.charset.StandardCharsets;

/**
 * URI 조각 인코딩의 <b>Node 의미론</b> — 전역 함수 {@code encodeURIComponent}와 {@code URLSearchParams}
 * 직렬화 <b>두 가지</b>다.
 *
 * <p>두 함수는 <b>같은 것이 아니다</b>({@link #encodeFormComponent} javadoc에 실측 차이 6코드가 있다).
 * 정본이 자리마다 다른 인코더를 쓰기 때문에 둘 다 여기 있고, 한 클래스에 나란히 둔 이유는 <b>헷갈리면
 * 곧바로 보이게</b> 하기 위해서다.
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

	/** {@code application/x-www-form-urlencoded} 직렬화기가 그대로 두는 비영숫자 바이트. */
	private static final String FORM_LITERAL_MARKS = "*-._";

	/** U+FFFD REPLACEMENT CHARACTER — WebIDL {@code USVString} 변환이 고아 서러게이트를 바꾸는 값. */
	private static final int REPLACEMENT = 0xFFFD;

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

	/**
	 * JS {@code new URLSearchParams({ k: raw }).toString()}의 <b>값 직렬화</b> —
	 * {@code application/x-www-form-urlencoded} 직렬화기다.
	 *
	 * <p><b>{@link #encodeURIComponent}와 다른 함수다.</b> 정본 두 곳이 서로 다른 인코더를 쓴다:
	 * 미디어 검색({@code src/services/mediaSearch.js})은 템플릿에 {@code encodeURIComponent}를 끼워
	 * 넣고, 번역({@code src/services/translate.js} 16~22행)은 {@code URLSearchParams}로 쿼리를 만든다.
	 * 0..255 전수 실측 결과 <b>정확히 6코드</b>가 갈린다: {@code 0x20 공백}({@code %20} 대 {@code +}) ·
	 * {@code !} · {@code '} · {@code (} · {@code )} · {@code ~}. 공백은 번역 본문에 반드시 들어 있으므로
	 * 둘을 바꿔 쓰면 <b>모든 번역 요청의 URL이 정본과 달라진다</b>.
	 *
	 * <p>리터럴로 남는 바이트는 <b>66개</b>({@code A-Z a-z 0-9 * - . _})이고 나머지는 UTF-8 바이트마다
	 * {@code %XX}(대문자 hex)다. 공백만 {@code +}로 접힌다.
	 *
	 * <p><b>짝 없는 서러게이트에서도 던지지 않는다</b> — WebIDL {@code USVString} 변환이 U+FFFD로
	 * 치환하기 때문이다(실측 {@code %EF%BF%BD}). {@link #encodeURIComponent}와 정반대이고, 이 차이는
	 * 중요하다: 번역은 <b>키가 없어도 200</b>인 라우트라 여기서 던지면 본문에 고아 서러게이트가 섞인
	 * 기사 하나가 500이 된다. 표준 {@link java.net.URLEncoder}는 같은 입력을 {@code ?}(0x3F)로 바꾸므로
	 * (기본 치환 바이트) 그것으로도 갈음할 수 없다.
	 *
	 * @param raw 인코딩할 값. {@code null}이면 빈 문자열이다
	 * @return {@code +}·{@code %XX}로 인코딩된 문자열
	 */
	public static String encodeFormComponent(String raw) {
		if (raw == null || raw.isEmpty()) {
			return "";
		}
		StringBuilder out = new StringBuilder(raw.length() + 16);
		int index = 0;
		while (index < raw.length()) {
			char unit = raw.charAt(index);
			int codePoint;
			if (Character.isHighSurrogate(unit)) {
				char low = ((index + 1) < raw.length()) ? raw.charAt(index + 1) : 0;
				boolean paired = Character.isLowSurrogate(low);
				codePoint = paired ? Character.toCodePoint(unit, low) : REPLACEMENT;
				index += paired ? 2 : 1;
			}
			else if (Character.isLowSurrogate(unit)) {
				codePoint = REPLACEMENT; // 고아 서러게이트 — USVString 변환이 U+FFFD로 바꾼다
				index++;
			}
			else {
				codePoint = unit;
				index++;
			}
			appendFormEncoded(out, codePoint);
		}
		return out.toString();
	}

	/** ECMA-262 {@code uriUnescaped} = {@code uriAlpha} ∪ {@code DecimalDigit} ∪ {@code uriMark}. */
	private static boolean isUnreserved(char c) {
		return (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9')
				|| UNRESERVED_MARKS.indexOf(c) >= 0;
	}

	/**
	 * 코드포인트 하나를 {@code x-www-form-urlencoded}로 적는다 — 공백은 {@code +}, 리터럴 66자는 그대로,
	 * 나머지는 UTF-8 <b>바이트마다</b> {@code %XX}다.
	 */
	private static void appendFormEncoded(StringBuilder out, int codePoint) {
		if (codePoint == ' ') {
			out.append('+');
			return;
		}
		byte[] utf8 = new String(Character.toChars(codePoint)).getBytes(StandardCharsets.UTF_8);
		for (byte value : utf8) {
			int unsigned = value & 0xFF;
			if (isFormLiteral(unsigned)) {
				out.append((char) unsigned); // 리터럴 바이트는 전부 ASCII다
			}
			else {
				out.append('%').append(HEX[unsigned >> 4]).append(HEX[unsigned & 0x0F]);
			}
		}
	}

	/** URL 인코딩 없이 남는 바이트 집합 — 영숫자 62 + {@code * - . _} = 66. */
	private static boolean isFormLiteral(int value) {
		return (value >= 'A' && value <= 'Z') || (value >= 'a' && value <= 'z') || (value >= '0' && value <= '9')
				|| FORM_LITERAL_MARKS.indexOf(value) >= 0;
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
