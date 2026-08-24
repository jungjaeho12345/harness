package harness.news.web;

import harness.news.service.NodeString;
import java.util.regex.Pattern;

/**
 * 문자열 → 수 변환의 <b>Node 의미론</b> — {@code Number(raw)}({@link #toNumber})와 그 위의 정수 판정
 * {@code Number.isInteger(...)}({@link #integerOf}).
 *
 * <p>Java의 파싱 관용을 그대로 쓰면 <b>같은 URL이 두 서버에서 다른 행에 닿는다</b>:
 * <ul>
 *   <li>{@code Long.parseLong}은 {@code "1.0"}·{@code "1e0"}·{@code "0x1"}·{@code " 1"}·{@code "+1"}을
 *       거부하지만 Node는 전부 같은 정수로 읽어 <b>그 행에 도달</b>한다(Node 200 / Spring 404).</li>
 *   <li>{@code Double.parseDouble}은 반대로 Java 전용 표기({@code "1d"}·{@code "0x1p3"})까지 받아들여
 *       Node가 NaN을 주는 URL에 Spring만 행을 물린다. {@code DELETE /api/receiver-config/5d}가 실측
 *       사례다 — <b>행 삭제가 허용된 유일한 테이블</b>에서 Node가 안 지우는 행을 Spring만 지웠다
 *       (2026-08-24 리뷰 high-1).</li>
 *   <li>{@code String.trim()}은 NBSP({@code U+00A0})를 걷어내지 못한다 — Node는 걷어낸다.</li>
 * </ul>
 * 그래서 ECMAScript {@code StringNumericLiteral} 문법을 <b>먼저 게이트</b>로 세우고 값 계산만 Java에
 * 맡긴다. 계약이 관측하는 비수치 id는 {@code 'abc'}·{@code '1.5'}뿐이라(index.json forward_notes (4)⑥)
 * 나머지 표기는 {@code NodeNumberTest}가 잠근다.
 *
 * <p><b>이 정책의 사본을 만들지 마라.</b> 경로 파라미터를 수로 읽는 자리는 전부 이 클래스를 부른다
 * ({@code /api/articles/:id/history/:historyId} · {@code DELETE /api/receiver-config/:id} ·
 * {@code PUT /api/distribution-targets/:id}와 그 {@code /deactivate}). 로컬 헬퍼로 재구현하면
 * 한쪽만 고쳐지고, 그 어긋남은 계약이 관측하지 않는 축이라 조용히 산다(실제로 그랬다).
 *
 * <p>반올림·클램프·기본값 같은 관용은 넣지 마라(그 순간 두 서버가 같은 입력에 다른 행을 돌려준다).
 *
 * <p>선행·후행 공백 제거는 {@link NodeString}이 소유한다 — {@code ToNumber}가 걷어내는 집합은
 * {@code String.prototype.trim}과 같은 집합이며, 그 술어를 여기 따로 두면 정책이 두 벌이 되어
 * 한쪽만 고쳐진다(실제로 그랬다 — {@code HistoryMeta}가 {@code strip()}을 쓰고 있었다).
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
		double value = toNumber(raw);
		if (!Double.isFinite(value) || value != Math.rint(value)) {
			return null; // NaN · ±Infinity · 소수 → Number.isInteger가 거짓이다.
		}
		if (value < Long.MIN_VALUE || value > Long.MAX_VALUE) {
			return null;
		}
		return (long) value;
	}

	/**
	 * {@code Number(raw)} — 문자열 하나에 대한 ECMAScript {@code ToNumber}.
	 *
	 * <p>행 매칭 키를 만드는 자리(수신설정 삭제 · 배부 대상 수정/비활성)가 이것을 그대로 쓴다:
	 * Node 라우트가 {@code Number(req.params.id)}로 만든 값을 바인딩하고, 숫자가 아니면 {@code NaN}이
	 * 되어 <b>어떤 행에도 매치되지 않는다</b>(404/changes:0으로 수렴, 500 아님).
	 *
	 * <p>단 하나의 의도된 차이: <b>{@code 'Infinity'} 키워드</b>({@code '-Infinity'}·{@code '+Infinity'}
	 * 포함)를 {@code NaN}으로 접는다 — 문법 게이트가 그 낱말을 숫자로 보지 않기 때문이다(Node는
	 * ±Infinity). {@code NaN}도 ±Infinity도 정수가 아니고 어떤 정수 id와도 같지 않아 <b>관측 결과가
	 * 같다</b>(행 없음). 십진 표기의 오버플로({@code '1e400'})는 게이트를 통과하므로 Node와 <b>같이</b>
	 * ±Infinity다.
	 *
	 * @return 그 수. 숫자로 읽히지 않으면 {@code NaN}, 빈 문자열·공백만이면 {@code 0}이다
	 *     ({@code Number('') === 0} — NaN이 아니다).
	 */
	public static double toNumber(String raw) {
		if (raw == null) {
			return Double.NaN; // 경로 파라미터는 null이 될 수 없지만 판정이 입력에 의존하지 않게 한다.
		}
		String trimmed = NodeString.trim(raw);
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

}
