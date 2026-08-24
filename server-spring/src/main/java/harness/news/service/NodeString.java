package harness.news.service;

/**
 * 문자열 다듬기의 <b>Node 의미론</b> — {@code String.prototype.trim}.
 *
 * <p>이 판정에는 Java 표준 두 개가 다 쓸 수 없다:
 * <ul>
 *   <li>{@link String#trim()}은 {@code U+0020} 이하만 걷어내 <b>U+00A0(NBSP)·U+FEFF(BOM)·U+2007·
 *       U+202F</b>를 남긴다. JS는 그 넷을 전부 공백으로 본다.</li>
 *   <li>{@link String#strip()}은 {@link Character#isWhitespace(char)}를 쓰는데, 그 술어는
 *       <b>U+00A0·U+2007·U+202F를 공백으로 보지 않고</b>(줄바꿈 없는 공백은 제외한다) 반대로
 *       <b>U+001C~U+001F</b>(Java 전용 구분자)를 공백으로 본다. JS는 정확히 그 반대다.</li>
 * </ul>
 * 그래서 ECMAScript {@code WhiteSpace} + {@code LineTerminator}를 직접 세운다.
 *
 * <p><b>정책은 한 벌이다.</b> 이 술어를 쓰는 자리가 둘 있고(경로 파라미터의 정수 판정
 * {@code harness.news.web.NodeNumber}, 이력 표시 제목 파생 {@link HistoryMeta}) 각자 표준 메서드를
 * 골라 쓰면 <b>한쪽만 맞는 상태</b>가 된다 — 실제로 그런 적이 있고 그것이 이 클래스가 있는 이유다.
 * 제목 파생 결과는 {@code ArticleHistory.snapshotTitle}로 <b>영속</b>되므로 두 서버가 갈리면 같은
 * 편집에 서로 다른 값이 남는다.
 *
 * <p>유니코드 공백을 <b>문자 리터럴로 늘어놓지 않는다</b> — 보이지 않는 문자를 소스에 심으면 diff가
 * 사실을 감춘다.
 */
public final class NodeString {

	private NodeString() {
	}

	/**
	 * JS {@code raw.trim()} — 앞뒤의 {@code WhiteSpace}·{@code LineTerminator}만 걷어낸다.
	 *
	 * @param raw 원문. {@code null}이면 {@code null}을 그대로 돌려준다(호출자가 부재를 판정한다).
	 */
	public static String trim(String raw) {
		if (raw == null) {
			return null;
		}
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

	/** ECMAScript {@code WhiteSpace} ∪ {@code LineTerminator}. */
	static boolean isWhitespace(char c) {
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
