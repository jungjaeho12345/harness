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

	/**
	 * 제어문자 escape 중 <b>Node와 같은</b> 부분 — 짧은 이스케이프 다섯과 16진수가 숫자뿐인 코드포인트.
	 */
	@Test
	void theShortEscapesAndAllDigitHexEscapesMatchJsonStringify() {
		assertEquals(doc(block("x\\u0000y")), CollectionMarkup.toMarkup("x" + ch(0x0000) + "y", ""),
				"NUL도 \\u0000으로 쓴다(문자열이 끊기지 않는다)");
		assertEquals(doc(block("x\\u0019y")), CollectionMarkup.toMarkup("x" + ch(0x0019) + "y", ""),
				"16진수가 숫자뿐이면 표기가 하나뿐이라 갈릴 수 없다");
		assertEquals(doc(block("a\\bb\\fc\\rd")), CollectionMarkup.toMarkup(
				"a" + ch(0x0008) + "b" + ch(0x000C) + "c" + ch(0x000D) + "d", ""),
				"백스페이스·폼피드·CR은 짧은 이스케이프다(\\u00XX가 아니다)");
	}

	/**
	 * <b>발견된 divergence(2026-08-25 ④ 테스트 게이트)</b>: {@code \\u00XX}의 16진수 <b>letter 자리가
	 * 대문자</b>다. Node {@code JSON.stringify}는 {@code x\\u001by}를, Jackson은 {@code x\\u001By}를 쓴다.
	 *
	 * <h2>왜 이 축이 지금까지 보이지 않았는가</h2>
	 * 기존 케이스는 {@code U+0001} 하나뿐이었다 — {@code 0001}은 <b>숫자만이라 대소문자 표기가 같은
	 * 문자열</b>이다. 하위 니블이 {@code a~f}인 코드포인트라야 갈린다: {@code U+000B}·{@code U+000E}·
	 * {@code U+000F}·{@code U+001A}~{@code U+001F}의 <b>9자</b>({@code U+000A}·{@code U+000C}·{@code U+000D}는
	 * 짧은 이스케이프라 해당 없음). 계약 3파일은 제어문자를 보내지 않으므로 <b>구조적으로 관측 불가</b>다.
	 *
	 * <h2>왜 중요한가</h2>
	 * 이 문자열은 {@code Contents.markupVersion}으로 <b>영속</b>되고 단건 조회 응답에 <b>그 문자열 값
	 * 그대로</b> 실린다. 즉 저장 바이트뿐 아니라 <b>API 응답의 값</b>도 갈린다(응답을 파싱하면
	 * {@code ...\\u001B...}와 {@code ...\\u001b...}라는 서로 다른 문자열이 나온다 — 그 문자열을 한 번 더
	 * {@code JSON.parse}해야 비로소 같은 본문이 된다). 계약 3파일이 제어문자를 보내지 않아 관측되지 않을
	 * 뿐, 값 층위의 divergence다. 이력 비교·백필·재수집 중복 판정처럼 저장 문자열을 그대로 비교하는
	 * 축에서 실체 없는 차이를 만든다.
	 *
	 * <p>원인은 이 클래스가 아니라 <b>Jackson 전역</b>이다({@code JsonHttp}도 같은 매퍼로 응답을 쓴다) —
	 * 이 phase가 만든 결함이 아니라 포팅 전반에 걸린 항목이다.
	 *
	 * <p><b>이 테스트는 통과가 아니라 고정이다</b>: 현재 동작을 정확히 못 박아 두어 (a) 사실이 눈에 보이고
	 * (b) 누군가 고치면 여기서 red가 나 결정이 diff에 남는다. 고치는 방법은 {@code toMarkup}에
	 * {@code CharacterEscapes}를 다는 것이며 그 판단은 이 게이트의 권한 밖이다(⑤/후속).
	 */
	@Test
	void theHexLettersOfControlEscapesAreUppercaseUnlikeJsonStringify() {
		assertEquals(doc(block("x\\u001By")), CollectionMarkup.toMarkup("x" + ch(0x001B) + "y", ""),
				"Node는 x\\u001by다 — 계약이 관측하지 않는 divergence(저장 바이트가 갈린다)");
		assertEquals(doc(block("x\\u000By")), CollectionMarkup.toMarkup("x" + ch(0x000B) + "y", ""),
				"Node는 x\\u000by다");
		assertEquals(doc(block("x\\u000Ey")), CollectionMarkup.toMarkup("x" + ch(0x000E) + "y", ""),
				"Node는 x\\u000ey다");
		assertEquals(doc(block("x\\u001Fy")), CollectionMarkup.toMarkup("x" + ch(0x001F) + "y", ""),
				"Node는 x\\u001fy다");
	}

	/**
	 * 비-ASCII는 <b>그대로</b> 쓴다({@code \\uXXXX}로 escape하지 않는다) — 한글·이모지·U+2028까지.
	 *
	 * <p>Jackson에 {@code ESCAPE_NON_ASCII}가 켜지면 저장 바이트가 통째로 달라진다(Node는 켜지지 않는다).
	 * 이모지는 대리 쌍이라 <b>escape 여부에 더해 쌍이 깨지는지</b>도 함께 본다.
	 */
	@Test
	void nonAsciiIncludingSurrogatePairsIsWrittenVerbatim() {
		String emoji = ch(0x1F600);

		assertEquals(doc(block("한글 " + emoji), block("本文 " + ch(0x2028))),
				CollectionMarkup.toMarkup("한글 " + emoji, "本文 " + ch(0x2028)),
				"비ASCII를 escape하면 저장 바이트가 Node와 갈린다");
		assertEquals(2, emoji.length(), "이 코드포인트는 대리 쌍이다(테스트 전제)");
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
