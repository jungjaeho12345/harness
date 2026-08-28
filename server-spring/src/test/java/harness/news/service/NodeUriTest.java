package harness.news.service;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

/**
 * {@link NodeUri#encodeURIComponent(String)} — <b>Node 정본 실측표</b>와의 대조다.
 *
 * <p>기대값은 계획서 문구가 아니라 <b>리포 밖 스크립트로 돌린 Node {@code encodeURIComponent} 출력</b>에서
 * 옮겼다(2026-08-28 실측). 이 축은 <b>계약이 구조적으로 보지 못한다</b>: 계약 질의는 ASCII
 * {@code contract-media-q} 하나뿐이고 리포트는 데모 폴백의 {@code link} 문자열을 아예 기록하지 않는다
 * (index.json decisions (13) · (22)⑥). 그래서 이 테스트가 유일 방어선이다.
 *
 * <p>비가시 문자는 <b>전부 이스케이프</b>로 쓴다 — 소스에 raw 제어 바이트를 심으면 git이 그 파일을
 * 바이너리로 취급해 리뷰에서 diff가 보이지 않는다(phase 72 ④가 실제로 하나 제거했다).
 */
class NodeUriTest {

	/** 제어문자 NUL + UNIT SEPARATOR. */
	private static final String CONTROLS = "\u0000\u001F";

	/** NO-BREAK SPACE — JS는 공백으로 보지만 인코딩 대상이다. */
	private static final String NBSP = "\u00A0";

	/** ZERO WIDTH NO-BREAK SPACE(BOM). */
	private static final String BOM = "\uFEFF";

	/** GRINNING FACE — 서러게이트 페어 1글자(UTF-8 4바이트). */
	private static final String EMOJI = "\uD83D\uDE00";

	/** Node {@code encodeURIComponent} 실측표 — {@code 입력 -> 기대 출력}. */
	private static final Map<String, String> NODE_TABLE = new LinkedHashMap<>();

	static {
		NODE_TABLE.put("", "");
		NODE_TABLE.put("contract-media-q", "contract-media-q");
		NODE_TABLE.put("AZaz09", "AZaz09");
		NODE_TABLE.put("a b", "a%20b");
		NODE_TABLE.put("   ", "%20%20%20");
		NODE_TABLE.put("뉴스", "%EB%89%B4%EC%8A%A4");
		NODE_TABLE.put("한글 뉴스 q", "%ED%95%9C%EA%B8%80%20%EB%89%B4%EC%8A%A4%20q");
		NODE_TABLE.put("中文", "%E4%B8%AD%E6%96%87");
		NODE_TABLE.put("!'()~*", "!'()~*"); // 비예약 — 하나도 인코딩되지 않는다
		NODE_TABLE.put("-_.", "-_.");
		NODE_TABLE.put("/?&=+#%", "%2F%3F%26%3D%2B%23%25");
		NODE_TABLE.put("+", "%2B");
		NODE_TABLE.put("a,b", "a%2Cb"); // 반복 쿼리 키가 접힌 모양
		NODE_TABLE.put("@:;$,", "%40%3A%3B%24%2C");
		NODE_TABLE.put("[]{}<>|\\^`\"", "%5B%5D%7B%7D%3C%3E%7C%5C%5E%60%22");
		NODE_TABLE.put("€", "%E2%82%AC"); // EURO SIGN — UTF-8 3바이트
		NODE_TABLE.put(EMOJI, "%F0%9F%98%80");
		NODE_TABLE.put("a" + EMOJI + "b", "a%F0%9F%98%80b");
		NODE_TABLE.put(CONTROLS, "%00%1F");
		NODE_TABLE.put("\t\n", "%09%0A");
		NODE_TABLE.put(NBSP, "%C2%A0");
		NODE_TABLE.put(BOM, "%EF%BB%BF");
	}

	@Test
	@DisplayName("Node 실측표 전건이 문자 단위로 같다")
	void itReproducesTheNodeTableExactly() {
		for (Map.Entry<String, String> row : NODE_TABLE.entrySet()) {
			assertEquals(row.getValue(), NodeUri.encodeURIComponent(row.getKey()),
					"encodeURIComponent(" + escaped(row.getKey()) + ")");
		}
	}

	/**
	 * <b>대조군</b> — 표준 {@link URLEncoder}로 갈음할 수 없다는 증명이다.
	 *
	 * <p>{@code URLEncoder}는 {@code application/x-www-form-urlencoded} 인코더라 공백을 {@code +}로 바꾸고
	 * {@code !'()~}를 퍼센트 인코딩한다. 그 차이는 <b>실 API 호출의 질의를 갈라 놓는데</b> 계약은 ASCII
	 * 질의 하나만 보므로 관측하지 못한다 — 그래서 여기서 명시적으로 못 박는다.
	 */
	@Test
	@DisplayName("URLEncoder로 갈음할 수 없다 — 결과가 다른 케이스가 최소 3건이다")
	void itDiffersFromTheStandardUrlEncoder() {
		List<String> divergent = List.of("a b", "!'()~*", "   ", "한글 뉴스 q");
		assertTrue(divergent.size() >= 3, "대조 케이스는 최소 3건이다");

		for (String input : divergent) {
			String standard = URLEncoder.encode(input, StandardCharsets.UTF_8);
			assertNotEquals(standard, NodeUri.encodeURIComponent(input),
					"URLEncoder와 같아졌다 — 이식이 표준 API로 대체됐다: " + escaped(input));
		}

		// 갈라지는 지점을 값으로도 남긴다(회귀 시 무엇이 달랐는지 즉시 보이도록).
		assertEquals("a+b", URLEncoder.encode("a b", StandardCharsets.UTF_8));
		assertEquals("a%20b", NodeUri.encodeURIComponent("a b"));
		assertEquals("%21%27%28%29%7E*", URLEncoder.encode("!'()~*", StandardCharsets.UTF_8));
		assertEquals("!'()~*", NodeUri.encodeURIComponent("!'()~*"));

		// 반대로 <b>같은</b> 케이스도 있다 — "다르다"만으로는 이식이 성립하지 않는다.
		assertEquals(URLEncoder.encode("뉴스", StandardCharsets.UTF_8), NodeUri.encodeURIComponent("뉴스"));
	}

	@Test
	@DisplayName("hex는 대문자이고 퍼센트 인코딩은 UTF-8 바이트 단위다")
	void itPercentEncodesUtf8BytesInUpperCaseHex() {
		String encoded = NodeUri.encodeURIComponent("뉴");

		assertEquals("%EB%89%B4", encoded, "글자가 아니라 UTF-8 3바이트가 각각 퍼센트 인코딩된다");
		assertEquals(encoded.toUpperCase(Locale.ROOT), encoded, "hex 자릿수는 대문자다");
	}

	/**
	 * 부재({@code null})는 <b>빈 질의</b>다 — 라우트의 {@code req.query.q ?? ''}와 같은 자리다.
	 *
	 * <p>{@code NullPointerException}으로 터지면 200이어야 할 미디어 검색이 500이 된다(phase 68·69·70에서
	 * 반복된 함정의 동형 — index.json decisions (24)).
	 */
	@Test
	@DisplayName("null은 빈 문자열이다(500으로 새지 않는다)")
	void itFoldsNullToTheEmptyQuery() {
		assertEquals("", NodeUri.encodeURIComponent(null));
	}

	/**
	 * 짝 없는 서러게이트는 JS가 {@code URIError}를 던지는 자리다({@code encodeURIComponent('\\uD800')}).
	 *
	 * <p>Node 정본에서 그 예외는 라우트의 {@code catch}까지 올라가 <b>500</b>이 된다. 여기서 조용히
	 * {@code ?}(0x3F)로 치환하면({@code String#getBytes(UTF_8)}의 기본 동작이다) 두 서버가 <b>다른 URL</b>을
	 * 만든다 — 던지는 편이 정본과 같은 결과다. 와이어로는 도달할 수 없다(퍼센트 디코딩은 잘못된 UTF-8을
	 * U+FFFD로 바꾸지 짝 없는 서러게이트를 만들지 않는다).
	 */
	@Test
	@DisplayName("짝 없는 서러게이트는 URIError 동형으로 던진다(?로 치환하지 않는다)")
	void itRejectsLoneSurrogatesInsteadOfSubstituting() {
		assertThrows(IllegalArgumentException.class, () -> NodeUri.encodeURIComponent("\uD800"));
		assertThrows(IllegalArgumentException.class, () -> NodeUri.encodeURIComponent("a\uDC00b"));
		assertThrows(IllegalArgumentException.class, () -> NodeUri.encodeURIComponent("\uD83D"));
		assertEquals("%3F", NodeUri.encodeURIComponent("?"), "치환 결과와 혼동하지 않도록 진짜 '?'의 값도 남긴다");
	}

	private static String escaped(String raw) {
		StringBuilder out = new StringBuilder("\"");
		for (int i = 0; i < raw.length(); i++) {
			char c = raw.charAt(i);
			if (c < 0x20 || c > 0x7E) {
				out.append(String.format("\\u%04X", (int) c));
			}
			else {
				out.append(c);
			}
		}
		return out.append('"').toString();
	}

}
