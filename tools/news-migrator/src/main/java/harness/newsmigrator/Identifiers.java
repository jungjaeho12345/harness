package harness.newsmigrator;

import java.util.regex.Pattern;

/**
 * 테이블·컬럼 이름을 SQL 에 넣는 <b>유일한</b> 통로.
 *
 * <h2>왜 바인딩이 아니라 이어 붙이는가</h2>
 * 식별자는 바인딩 파라미터가 될 수 없다(값 자리가 아니다). 그래서 이어 붙이되, 붙이기 <b>전에</b>
 * 형태를 검사한다 — 따옴표·공백·세미콜론·백틱이 애초에 들어올 수 없으므로 이 통로로는 문장을 덧붙일 수
 * 없다. 이름의 출처가 기반선과 카탈로그뿐이라 실제 위험은 낮지만, 검사를 한 곳에 두면 그 사실이
 * 코드에서 보인다({@code EphemeralDatabase} 가 DB 이름에 같은 규율을 쓴다).
 */
final class Identifiers {

	/** 이 스키마가 쓰는 이름의 형태 — 라틴 문자로 시작하고 그 뒤는 문자·숫자·밑줄뿐이다. */
	private static final Pattern SAFE = Pattern.compile("^[A-Za-z_][A-Za-z0-9_]*$");

	private Identifiers() {
	}

	/** MySQL 표기(백틱). */
	static String quote(String identifier) {
		return "`" + require(identifier) + "`";
	}

	/** SQLite·표준 표기(큰따옴표). */
	static String quoteAnsi(String identifier) {
		return "\"" + require(identifier) + "\"";
	}

	static String require(String identifier) {
		if (identifier == null || !SAFE.matcher(identifier).matches()) {
			throw new IllegalArgumentException("식별자 규약(" + SAFE.pattern() + ")을 벗어난 이름이다: " + identifier);
		}
		return identifier;
	}

}
