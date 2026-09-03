package harness.newsmigrator;

import java.nio.charset.StandardCharsets;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.util.Arrays;

/**
 * 한 칸의 값 — <b>읽기·비교·요약이 전부 여기 한 곳에서만</b> 일어난다.
 *
 * <h2>왜 한 곳인가</h2>
 * 값을 문자열로 만드는 자리가 두 벌이 되면 표현이 갈린다("2.0" 과 2.0, 빈 문자열과 NULL). 그리고 그
 * 갈림은 이관에서 <b>대조를 통과한 채</b> 데이터를 바꾼다. 소스(SQLite)와 대상(MySQL)이 <b>같은 규칙</b>으로
 * 읽고, 비교도 같은 규칙으로 한다.
 *
 * <h2>값의 종류는 셋뿐이다</h2>
 * {@code null} · {@link Long} · {@link String}. 소스 실측(2026-09-01)에서 {@code typeof()} 는
 * text/null/integer 3종뿐이었고(real·blob 0), 정수는 매핑 규칙이 정수로 선언한 컬럼(기반선의
 * {@code BIGINT})에만 있었다. 그 전제를 벗어난 값을 만나면 <b>조용히 문자열로 만들지 않고 던진다</b> —
 * 조용한 변환은 "대조는 통과했는데 값이 달라진" 결과를 낳는다.
 *
 * <h2>비교는 바이트로 한다</h2>
 * DB 의 {@code =} 로 비교하면 <b>그 컬럼의 collation</b> 이 판정한다. 대상 스키마가 서버 기본
 * ({@code utf8mb4_0900_ai_ci}) 으로 만들어졌다면 대소문자만 다른 두 값이 "같다"고 보고된다 — 대조기가
 * 스스로 눈을 감는 셈이다. 그래서 UTF-8 바이트로 Java 쪽에서 비교한다.
 */
public final class CellValues {

	private CellValues() {
	}

	/**
	 * 결과 집합의 한 칸을 읽는다.
	 *
	 * @param resultSet 읽을 결과 집합
	 * @param index 1부터 시작하는 컬럼 위치
	 * @param column 기반선이 선언한 컬럼(정수 여부의 정본)
	 * @param where 진단에 붙일 자리 표시(테이블.컬럼 — <b>값은 넣지 않는다</b>)
	 * @return {@code null} · {@link Long} · {@link String} 중 하나
	 * @throws IllegalStateException 매핑 규칙이 다루지 않는 값을 만났을 때
	 */
	public static Object read(ResultSet resultSet, int index, BaselineSchema.Column column, String where)
			throws SQLException {
		Object raw = resultSet.getObject(index);
		if (raw == null || resultSet.wasNull()) {
			return null;
		}
		if (column.integer()) {
			if (raw instanceof Number number) {
				return number.longValue();
			}
			throw new IllegalStateException(where + ": 정수 컬럼에 정수가 아닌 값이 있다(" + raw.getClass().getSimpleName()
					+ ") — 매핑 규칙이 다루지 않으므로 조용히 바꾸지 않는다");
		}
		if (raw instanceof String) {
			return resultSet.getString(index);
		}
		throw new IllegalStateException(where + ": 텍스트 컬럼에 문자열이 아닌 값이 있다(" + raw.getClass().getSimpleName()
				+ ") — 문자열로 바꾸면 이관이 값을 바꾼다");
	}

	/** 두 값이 <b>바이트로</b> 같은가(collation 에 기대지 않는다). */
	public static boolean sameBytes(Object left, Object right) {
		if (left == null || right == null) {
			return left == right;
		}
		if (left instanceof Long leftNumber && right instanceof Long rightNumber) {
			return leftNumber.longValue() == rightNumber.longValue();
		}
		if (left instanceof String leftText && right instanceof String rightText) {
			return Arrays.equals(utf8(leftText), utf8(rightText));
		}
		return false;
	}

	/**
	 * 로그·리포트에 실어도 되는 요약.
	 *
	 * <p>문자열은 <b>길이만</b> 싣는다 — 본문·bcrypt 해시·수집 비밀이 리포트로 새지 않게. 정수는 값을
	 * 싣는다(전부 id 이고, 어느 행인지 모르면 진단이 되지 않는다).
	 */
	public static String describe(Object value) {
		if (value == null) {
			return "NULL";
		}
		if (value instanceof Long number) {
			return "정수 " + number;
		}
		if (value instanceof String text) {
			return "문자열 " + utf8(text).length + "B";
		}
		return value.getClass().getSimpleName();
	}

	private static byte[] utf8(String text) {
		return text.getBytes(StandardCharsets.UTF_8);
	}

}
