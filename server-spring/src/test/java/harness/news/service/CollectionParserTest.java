package harness.news.service;

import static org.junit.jupiter.api.Assertions.assertEquals;

import java.util.Arrays;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;

/**
 * 수집 파서({@link CollectionParser#parse})가 리포 루트 {@code src/parsers/defaultParser.js}와 <b>같은 값</b>을
 * 돌려주는가.
 *
 * <p>기대값은 전부 <b>Node 실측</b>이다 — 원본 파서를 리포 밖에서 직접 호출해 뽑은 표를 그대로 옮겼다
 * (계획서 문구가 아니라 실행 결과가 기준이다). 이 표가 곧 계약이다: 수집 라우트는 입력 검증이 없어서
 * <b>어떤 payload도 200 + 기사 1건</b>이 되고, 그때 저장되는 제목·본문이 여기서 정해진다.
 *
 * <p>다듬기는 {@link NodeString#trim(String)}이다 — {@link String#trim()}으로 되돌리면 NBSP 케이스가 red다.
 */
class CollectionParserTest {

	// --- 문자열 payload(FTP 파일·평문 API 응답) ---------------------------------------------------

	@Test
	void firstLineOfTextPayloadBecomesTitleAndTheRestIsContent() {
		assertParsed("", "", "", "빈 문자열");
		assertParsed("제목", "", "제목", "개행이 없으면 전부 제목이고 본문은 빈 문자열이다");
		assertParsed("제목", "", "제목\n", "끝 개행 하나는 본문 없음이다(빈 조각)");
		assertParsed("제목", "본문", "제목\n본문", "첫 줄이 제목");
		assertParsed("제목", "본문\n둘", "제목\n본문\n둘", "둘째 개행부터는 본문 그대로다");
	}

	@Test
	void carriageReturnsAreNormalizedOnlyAsPartOfCrlf() {
		assertParsed("제목", "본문\n둘", "제목\r\n본문\r\n둘", "CRLF는 LF로 정규화된다");
		// 홀로 선 CR은 개행이 아니다 — 정규식이 \r\n만 본다(제목 안에 그대로 남는다).
		assertParsed("제목\r본문", "", "제목\r본문", "단독 CR은 줄을 나누지 않는다");
	}

	@Test
	void leadingNewlinesAreDroppedBeforeTheFirstLineIsTaken() {
		assertParsed("제목", "본문", "\n\n제목\n본문", "선행 빈 줄은 무시한다");
		assertParsed("제목", "본문", "\r\n\r\n제목\r\n본문", "CRLF 정규화 후에 선행 개행을 지운다");
		assertParsed("", "", "\n\n\n", "개행뿐이면 제목·본문 모두 빈 문자열이다");
		assertParsed("제목", "\n본문", "제목\n\n본문", "본문 안의 빈 줄은 살아 있다");
	}

	// --- 다듬기: 제목만 trim, 본문은 원문 ---------------------------------------------------------

	@Test
	void onlyTheTitleIsTrimmedAndTheContentKeepsItsWhitespace() {
		assertParsed("제목", "  본문  ", "  제목  \n  본문  ", "본문은 앞뒤 공백을 그대로 보존한다");
		assertParsed("T", ch(0x00A0) + "C", "T\n" + ch(0x00A0) + "C", "본문의 NBSP도 보존한다");
	}

	@Test
	void theTitleTrimUsesTheJavaScriptWhitespaceSet() {
		// NBSP(U+00A0)·BOM(U+FEFF)·이데오그래픽 스페이스(U+3000)는 JS가 공백으로 보고 String.trim()은 놓친다.
		for (int codePoint : new int[] { 0x00A0, 0xFEFF, 0x3000, 0x2007, 0x202F }) {
			String pad = ch(codePoint);
			assertParsed("T", "C", pad + "T" + pad + "\nC", "U+" + Integer.toHexString(codePoint) + " 제목 패딩");
			assertParsed("T", "", pad + "T" + pad, "U+" + Integer.toHexString(codePoint) + " 개행 없는 제목");
		}
	}

	// --- 스칼라 payload: 강제변환은 빼지도 더하지도 않는다 ----------------------------------------

	@Test
	void nullAndScalarPayloadsGoThroughStringCoercion() {
		assertParsed("", "", null, "null·undefined는 빈 문자열이다('null'이 아니다)");
		assertParsed("123", "", 123, "숫자는 문자열화된다");
		assertParsed("true", "", Boolean.TRUE, "불리언도 문자열화된다");
		assertParsed("false", "", Boolean.FALSE, "false도 'false'다(빈 문자열이 아니다)");
		assertParsed("007", "", "007", "숫자꼴 문자열은 원문 그대로다");
	}

	// --- 객체 payload(JSON API 응답) -------------------------------------------------------------

	@Test
	void objectPayloadTakesTitleAndContentFromItsFields() {
		assertParsed("", "", obj(), "빈 객체");
		assertParsed("T", "", obj("title", "  T  "), "객체의 title은 trim된다");
		assertParsed("T", "C", obj("title", "T", "content", "C"), "필드에서 직접 취한다");
		assertParsed("T", "C1\nC2", obj("title", "T", "content", "C1\nC2"),
				"title이 있으면 본문 첫 줄을 제목으로 올리지 않는다");
	}

	@Test
	void anEmptyTitleIsPromotedFromTheFirstLineOfTheContent() {
		assertParsed("C1", "C2", obj("content", "C1\nC2"), "title 부재 → 본문 첫 줄 승격");
		assertParsed("C", "", obj("content", "C"), "한 줄짜리 본문은 통째로 제목이 된다");
		assertParsed("첫", "둘", obj("title", "", "content", "첫\n둘"), "빈 title도 승격 대상이다");
		assertParsed("첫", "둘", obj("title", "", "content", "\n\n첫\n둘"), "승격 경로도 선행 개행을 지운다");
		assertParsed("B1", "B2", obj("title", "", "body", "B1\nB2"), "body로 폴백한 값도 승격된다");
	}

	@Test
	void contentFallsBackToBodyOnlyWhenItIsNullish() {
		assertParsed("B", "", obj("body", "B"), "content 키가 없으면 body를 본다");
		assertParsed("B", "", obj("content", null, "body", "B"), "content가 null이면 body를 본다");
		// 널 병합(??)이다 — 빈 문자열은 nullish가 아니므로 body를 보지 않는다.
		assertParsed("", "", obj("content", "", "body", "B"), "content가 빈 문자열이면 빈 문자열이 이긴다");
		assertParsed("C", "", obj("content", "C", "body", "B"), "둘 다 있으면 content가 이긴다");
	}

	@Test
	void arraysAreObjectsTooSoTheyHaveNoTitleOrContent() {
		// JS typeof []는 'object'다 — 배열은 splitFirstLine으로 가지 않는다(그러면 '1,2'가 제목이 된다).
		assertParsed("", "", arr(), "빈 배열");
		assertParsed("", "", arr(obj("title", "x")), "배열 자체에는 title 필드가 없다");
		assertParsed("", "", arr("첫 줄\n둘째 줄"), "배열은 문자열로 강제변환되지 않는다");
	}

	@Test
	void nestedObjectAndArrayFieldValuesUseJavaScriptStringCoercion() {
		// String(객체) === '[object Object]' · String(배열) === 원소를 ','로 이은 것(null 원소는 빈 문자열).
		assertParsed("[object Object]", "", obj("title", obj("ko", "x")), "중첩 객체 title");
		assertParsed("[object Object]", "", obj("title", obj()), "빈 중첩 객체도 같다");
		assertParsed("1,2", "", obj("title", arr(1, 2)), "배열 title");
		assertParsed("", "", obj("title", arr()), "빈 배열은 빈 문자열이다");
		assertParsed(",1", "", obj("title", arr(null, 1)), "null 원소는 빈 조각이 된다");
		assertParsed("1,2,3", "", obj("title", arr(arr(1, 2), 3)), "중첩 배열은 평탄하게 이어진다");
		assertParsed("[object Object]", "", obj("title", arr(obj("a", 1))), "객체 원소는 [object Object]다");
		assertParsed("", "", obj("title", arr((Object) null)), "원소가 null 하나면 빈 문자열이다");
		assertParsed("a,b", "", obj("content", arr("a", "b")), "content의 강제변환 결과가 승격된다");
		assertParsed("[object Object]", "", obj("content", obj("a", 1)), "중첩 객체 content");
	}

	/**
	 * 강제변환에서 <b>Node와 갈리는 유일한 축</b>: 정수값 실수의 표기. JSON {@code 2.0}을 Jackson은
	 * {@code Double}로 주고 Java는 {@code "2.0"}으로 쓰지만 Node는 {@code "2"}로 쓴다.
	 *
	 * <p>고치지 않는 이유: 계약 3파일 어디도 수치 payload를 보내지 않고, JS {@code Number::toString}
	 * 전체 규칙(1e21 임계·{@code 1e+21} 지수 표기·최단 왕복 자릿수)을 여기 재구현하면 <b>부분 충실</b>이
	 * 되어 지금보다 위험하다. 이 테스트가 그 사실을 눈에 보이게 붙잡아 둔다(forward_notes 인계 항목).
	 */
	@Test
	void theOneKnownDivergenceIsTheJavaSpellingOfIntegralFloats() {
		assertParsed("1.5", "", obj("title", 1.5), "정수가 아닌 실수는 Node와 같다");
		assertParsed("2", "", obj("title", 2), "정수는 Node와 같다");
		assertParsed("2.0", "", obj("title", 2.0d), "Node는 '2'다 — 계약이 관측하지 않는 divergence");
	}

	// --- 헬퍼 -----------------------------------------------------------------------------------

	private static void assertParsed(String title, String content, Object payload, String label) {
		CollectionParser.Parsed parsed = CollectionParser.parse(payload);
		assertEquals(title, parsed.title(), label + " — title");
		assertEquals(content, parsed.content(), label + " — content");
	}

	/** 값에 {@code null}을 담을 수 있는 객체 리터럴 — {@code Map.of}는 null 값을 거부한다. */
	private static Map<String, Object> obj(Object... keyValues) {
		Map<String, Object> map = new LinkedHashMap<>();
		for (int i = 0; i < keyValues.length; i += 2) {
			map.put((String) keyValues[i], keyValues[i + 1]);
		}
		return map;
	}

	/** {@code null} 원소를 담을 수 있는 배열 리터럴 — {@code List.of}는 거부한다. */
	private static List<Object> arr(Object... values) {
		return Arrays.asList(values);
	}

	/** 보이지 않는 문자는 소스에 심지 않는다 — 코드포인트로 만든다. */
	private static String ch(int codePoint) {
		return new String(Character.toChars(codePoint));
	}

}
