package harness.news.web;

import java.util.regex.Pattern;

/**
 * 문자열 → 정수 판정의 <b>Node 의미론</b> — {@code Number(raw)} + {@code Number.isInteger(...)}.
 *
 * <p>쓰이는 곳은 {@code GET /api/articles/:id/history/:historyId} 하나이고 정본은
 * {@code const historyId = Number(req.params.historyId); if (!Number.isInteger(historyId)) 404} 다.
 * Java의 파싱 관용을 그대로 쓰면 <b>같은 URL이 두 서버에서 다른 상태코드</b>가 된다:
 * <ul>
 *   <li>{@code Long.parseLong}은 {@code "1.0"}·{@code "1e0"}·{@code "0x1"}·{@code " 1"}·{@code "+1"}을
 *       거부하지만 Node는 전부 같은 정수로 읽어 <b>이력 행에 도달</b>한다(Node 200 / Spring 404).</li>
 *   <li>{@code Double.parseDouble}은 반대로 Java 전용 표기({@code "1d"}·{@code "0x1p3"})까지 받아들여
 *       Node가 404를 주는 URL에 Spring만 200을 준다.</li>
 * </ul>
 * 그래서 ECMAScript {@code StringNumericLiteral} 문법을 <b>먼저 게이트</b>로 세우고 값 계산만 Java에
 * 맡긴다. 계약은 {@code 'abc'}·{@code '1.5'}만 관측하므로(index.json forward_notes (4)⑥) 나머지 표기는
 * {@code NodeNumberTest}가 잠근다.
 *
 * <p><b>이 클래스는 값을 만들지 않는다</b> — 판정만 한다. 반올림·클램프·기본값 같은 관용을 넣지 마라
 * (그 순간 두 서버가 같은 입력에 다른 행을 돌려준다).
 */
public final class NodeNumber {

	/**
	 * ECMAScript {@code StrDecimalLiteral} — 부호 + (정수부[.소수부] | .소수부) + 지수부.
	 * {@code "1."}·{@code ".5"}는 유효하고 {@code "1d"}·{@code "1_0"}·{@code "1 2"}는 아니다.
	 */
	private static final Pattern DECIMAL = Pattern.compile("[+-]?(\\d+\\.?\\d*|\\.\\d+)([eE][+-]?\\d+)?");

	/** 진법 접두 리터럴 — <b>부호를 허용하지 않는다</b>({@code Number('-0x1')}은 NaN이다). */
	private static final Pattern HEX = Pattern.compile("0[xX][0-9a-fA-F]+");

	private static final Pattern OCTAL = Pattern.compile("0[oO][0-7]+");

	private static final Pattern BINARY = Pattern.compile("0[bB][01]+");

	private NodeNumber() {
	}

	/**
	 * Node가 이 문자열을 정수로 읽는가.
	 *
	 * @return 그 정수. 숫자가 아니거나({@code NaN}) 정수가 아니거나({@code 1.5}·{@code Infinity})
	 *     {@code long} 범위 밖이면 {@code null}. 범위 밖을 {@code null}로 접는 것은 관용이 아니다 —
	 *     Node도 그 값으로 조회해 <b>행을 찾지 못한다</b>(관측 결과가 같다).
	 */
	public static Long integerOf(String raw) {
		double value = valueOf(raw);
		if (!Double.isFinite(value) || value != Math.rint(value)) {
			return null; // NaN · ±Infinity · 소수 → Number.isInteger가 거짓이다.
		}
		if (value < Long.MIN_VALUE || value > Long.MAX_VALUE) {
			return null;
		}
		return (long) value;
	}

	/**
	 * {@code Number(raw)} — 경로 변수를 {@code double}로 숫자화한다(ECMAScript {@code ToNumber}). 비수치는
	 * {@code NaN}이다. 관리자 CRUD 라우트가 {@code Number(req.params.id)} 동형으로 경로 id를 서비스({@code double}
	 * 인자)에 넘길 때 쓴다 — receiver-config-delete의 {@code 'abc'}는 NaN→매치 0→{@code changes:0}, distribution
	 * update/deactivate의 {@code 'abc'}·없는 id는 NaN/미매치→{@code not-found}로 수렴한다(index.json decisions (7)).
	 * 값 계산만 하고 반올림·클램프·기본값 같은 관용은 넣지 않는다.
	 */
	public static double numberOf(String raw) {
		return valueOf(raw);
	}

	/** {@code Number(raw)} — 문자열 하나에 대한 ECMAScript {@code ToNumber}. */
	private static double valueOf(String raw) {
		if (raw == null) {
			return Double.NaN; // 경로 파라미터는 null이 될 수 없지만 판정이 입력에 의존하지 않게 한다.
		}
		String trimmed = trim(raw);
		if (trimmed.isEmpty()) {
			return 0.0; // Number('') === 0 이다(NaN이 아니다).
		}
		if (HEX.matcher(trimmed).matches()) {
			return unsigned(trimmed.substring(2), 16);
		}
		if (OCTAL.matcher(trimmed).matches()) {
			return unsigned(trimmed.substring(2), 8);
		}
		if (BINARY.matcher(trimmed).matches()) {
			return unsigned(trimmed.substring(2), 2);
		}
		if (!DECIMAL.matcher(trimmed).matches()) {
			return Double.NaN; // 'Infinity'도 여기서 걸린다 — 정수가 아니므로 따로 다룰 이유가 없다.
		}
		return Double.parseDouble(trimmed);
	}

	/** 진법 접두 리터럴의 값. 자릿수가 아주 많으면 {@code long}을 넘치므로 자리마다 double로 쌓는다. */
	private static double unsigned(String digits, int radix) {
		double value = 0.0;
		for (int i = 0; i < digits.length(); i++) {
			value = value * radix + Character.digit(digits.charAt(i), radix);
		}
		return value;
	}

	/**
	 * JS의 {@code WhiteSpace} + {@code LineTerminator}를 걷어낸다. {@link String#trim()}은 U+00A0·U+FEFF를
	 * 남기고 {@link String#strip()}은 U+00A0를 공백으로 보지 않아 둘 다 쓸 수 없다. 유니코드 공백 목록을
	 * <b>문자 리터럴로 늘어놓지 않는다</b> — 보이지 않는 문자를 소스에 심으면 diff가 사실을 감춘다.
	 */
	private static String trim(String raw) {
		int start = 0;
		int end = raw.length();
		while (start < end && isWhitespace(raw.charAt(start))) {
			start++;
		}
		while (end > start && isWhitespace(raw.charAt(end - 1))) {
			end--;
		}
		return raw.substring(start, end);
	}

	private static boolean isWhitespace(char c) {
		if (c == '\t' || c == '\n' || c == '\f' || c == '\r') {
			return true;
		}
		if (c == 0x000B || c == 0x2028 || c == 0x2029 || c == 0xFEFF) {
			return true; // VT · LINE/PARAGRAPH SEPARATOR · BOM(ZERO WIDTH NO-BREAK SPACE)
		}
		// <USP> = 유니코드 공백 구분자(U+0020·U+00A0·U+1680·U+2000~200A·U+202F·U+205F·U+3000).
		return Character.getType(c) == Character.SPACE_SEPARATOR;
	}

}
