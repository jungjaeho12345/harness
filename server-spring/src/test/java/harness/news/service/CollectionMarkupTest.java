package harness.news.service;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import org.junit.jupiter.api.Test;

/**
 * 수집 본문 조립({@link CollectionMarkup#toMarkup})이 리포 루트 {@code src/services/collectionService.js}의
 * {@code toMarkup}과 <b>같은 문자열</b>을 만드는가.
 *
 * <p>기대값은 전부 <b>Node 실측</b>이다(원본 규칙을 리포 밖에서 실행해 뽑은 문자열을 그대로 옮겼다).
 * 이 값은 {@code Contents.markupVersion}으로 <b>영속</b>되고 계약이 단건 조회에서
 * {@code JSON.parse(...)} 후 {@code format}·{@code version}·블록 텍스트 배열을 단언한다.
 *
 * <p>특히 <b>블록 1개(빈 텍스트)</b> 경계가 계약이다: payload가 없어도 200 + 기사 1건이고 그 본문은
 * 빈 블록 하나다({@code receive-missing-payload}·{@code pull-self-health-source}).
 */
class CollectionMarkupTest {

	private static final String HEAD = "{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[";

	@Test
	void bothEmptyStillProducesExactlyOneEmptyBlock() {
		// split('\n')의 결과가 ['']이라 블록이 0개가 아니라 1개다 — 계약이 이 수를 단언한다.
		assertEquals(doc(block("")), CollectionMarkup.toMarkup("", ""));
	}

	@Test
	void nullIsDroppedJustLikeUndefined() {
		assertEquals(doc(block("C")), CollectionMarkup.toMarkup(null, "C"), "제목이 없으면 본문만 남는다");
		assertEquals(doc(block("T")), CollectionMarkup.toMarkup("T", null), "본문이 없으면 제목만 남는다");
		assertEquals(doc(block("")), CollectionMarkup.toMarkup(null, null), "둘 다 없으면 빈 블록 1개다");
		assertEquals(doc(block("C")), CollectionMarkup.toMarkup("", "C"), "빈 문자열도 버려진다");
	}

	@Test
	void titleAndContentBecomeOneBlockPerLine() {
		assertEquals(doc(block("제목")), CollectionMarkup.toMarkup("제목", ""), "제목만이면 블록 1개");
		assertEquals(doc(block("제목"), block("본문")), CollectionMarkup.toMarkup("제목", "본문"));
		assertEquals(doc(block("제목"), block("본문"), block("둘")),
				CollectionMarkup.toMarkup("제목", "본문\n둘"), "본문 줄마다 블록 1개");
	}

	@Test
	void blankLinesInsideTheContentSurviveAsEmptyBlocks() {
		assertEquals(doc(block("제목"), block(""), block("본문")), CollectionMarkup.toMarkup("제목", "\n본문"),
				"본문 첫 글자가 개행이면 빈 블록이 생긴다");
		// 끝 개행도 빈 조각을 남긴다 — Java의 String.split은 기본값에서 이 조각을 버린다(limit -1 필요).
		assertEquals(doc(block("T"), block("C"), block("")), CollectionMarkup.toMarkup("T", "C\n"),
				"끝 개행이 만드는 빈 블록은 버려지지 않는다");
		assertEquals(doc(block("T"), block(""), block(""), block("C")), CollectionMarkup.toMarkup("T", "\n\nC"));
	}

	@Test
	void theEnvelopeKeyOrderIsFrozenAndTheVersionIsAnInteger() {
		String markup = CollectionMarkup.toMarkup("제목", "본문");
		assertTrue(markup.startsWith(HEAD), "format → version → blocks 순서가 계약이다: " + markup);
		assertTrue(markup.contains("\"version\":1,"), "version은 정수 1이다('1'·1.0이 아니다): " + markup);
		assertTrue(markup.endsWith("]}"), markup);
	}

	@Test
	void jsonEscapingMatchesJsonStringify() {
		assertEquals("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"a\\\"b\\\\c\"},"
				+ "{\"type\":\"text\",\"text\":\"d\\te\"}]}",
				CollectionMarkup.toMarkup("a\"b\\c", "d\te"), "따옴표·역슬래시·탭 이스케이프");
		assertEquals(doc(block("x\\u0001y")), CollectionMarkup.toMarkup("x" + ch(0x0001) + "y", ""),
				"제어문자는 \\u00XX로 쓴다");
		assertEquals(doc(block("제목"), block("본문")), CollectionMarkup.toMarkup("제목", "본문"),
				"비ASCII는 이스케이프하지 않는다");
		String lineSeparator = ch(0x2028);
		assertEquals(doc(block("a" + lineSeparator + "b")), CollectionMarkup.toMarkup("a" + lineSeparator + "b", ""),
				"U+2028은 JSON 문자열에서 유효하므로 그대로 쓴다");
	}

	// --- 헬퍼: 기대 문자열을 Node의 JSON.stringify와 같은 모양으로 조립한다 -------------------------

	private static String doc(String... blocks) {
		return HEAD + String.join(",", blocks) + "]}";
	}

	/** @param escapedText 이미 JSON 이스케이프된 텍스트(호출자가 원문을 그대로 넘긴다) */
	private static String block(String escapedText) {
		return "{\"type\":\"text\",\"text\":\"" + escapedText + "\"}";
	}

	private static String ch(int codePoint) {
		return new String(Character.toChars(codePoint));
	}

}
