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

	/**
	 * {@code U+0000}~{@code U+001F}를 {@code JSON.stringify}가 쓰는 <b>그대로</b>의 표 — 2026-08-25 리포 밖
	 * 스크래치패드에서 {@code node}로 뽑아 옮겼다(규칙 재구현이 아니라 <b>출력 전사</b>다).
	 *
	 * <p>{@code U+000A}는 이스케이프가 아니라 블록 경계라 자리를 {@code null}로 비워 둔다. 소스에 raw
	 * 제어 바이트를 넣지 않으려고 원문 문자는 {@link #ch(int)}로만 만든다.
	 */
	private static final String[] NODE_ESCAPES = { "\\u0000", "\\u0001", "\\u0002", "\\u0003", "\\u0004", "\\u0005",
			"\\u0006", "\\u0007", "\\b", "\\t", null, "\\u000b", "\\f", "\\r", "\\u000e", "\\u000f", "\\u0010",
			"\\u0011", "\\u0012", "\\u0013", "\\u0014", "\\u0015", "\\u0016", "\\u0017", "\\u0018", "\\u0019",
			"\\u001a", "\\u001b", "\\u001c", "\\u001d", "\\u001e", "\\u001f" };

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
	 * {@code U+0000}~{@code U+001F} <b>전부</b>가 {@code JSON.stringify}와 <b>같은 문자열</b>이 된다.
	 *
	 * <h2>이 테스트가 뒤집힌 경위(2026-08-25 ⑤ 코드리뷰 반려 폐색)</h2>
	 * ④ 게이트가 발견한 divergence는 {@code \\u00XX}의 16진수 <b>letter 자리 대소문자</b>였다: Node는
	 * {@code x\\u001by}, Jackson 기본값은 {@code x\\u001By}. 갈리는 것은 하위 니블이 {@code a~f}인
	 * <b>9자</b>({@code U+000B}·{@code U+000E}·{@code U+000F}·{@code U+001A}~{@code U+001F})뿐이다 —
	 * {@code U+000A}·{@code U+000C}·{@code U+000D}는 짧은 이스케이프이고 나머지는 16진수가 숫자뿐이라
	 * 표기가 하나다. ④는 원인을 "Jackson 전역"으로 보아 고정만 했으나, {@link CollectionMarkup}은 전역
	 * 매퍼가 아니라 <b>자기 전용 매퍼</b>를 쓴다 — {@code JsonHttp}의 와이어를 건드리지 않고 국소로
	 * 고칠 수 있다는 뜻이다(⑤ 판정). 그래서 <b>Node 쪽으로 고쳤고</b> 이 테스트는 그 실측을 잠근다.
	 *
	 * <h2>왜 중요한가</h2>
	 * 이 문자열은 {@code Contents.markupVersion}으로 <b>영속</b>되고 단건 조회 응답에 그 문자열 값 그대로
	 * 실린다. 계약 3파일이 제어문자를 보내지 않아 <b>구조적으로 관측 불가</b>일 뿐, 저장 바이트와 응답
	 * 값이 함께 갈리는 축이다(이력 비교·백필·재수집 중복 판정처럼 저장 문자열을 그대로 비교하는 곳).
	 *
	 * <p>기대값은 {@link #NODE_ESCAPES}이며 <b>Node {@code JSON.stringify} 출력을 그대로 옮긴 표</b>다
	 * (규칙을 다시 구현하지 않는다 — 재구현하면 같은 버그를 양쪽에 쓰게 된다).
	 */
	@Test
	void everyControlCharacterIsEscapedExactlyLikeJsonStringify() {
		for (int cp = 0x00; cp <= 0x1F; cp++) {
			if (cp == 0x0A) {
				continue; // 개행은 이스케이프가 아니라 블록 경계다 — 아래에서 따로 본다.
			}
			assertEquals(doc(block("x" + NODE_ESCAPES[cp] + "y")), CollectionMarkup.toMarkup("x" + ch(cp) + "y", ""),
					"U+" + String.format("%04X", cp) + "의 이스케이프가 Node JSON.stringify와 갈린다");
		}

		assertEquals(0x20, NODE_ESCAPES.length, "표가 제어문자 32자를 전부 덮는다(케이스가 조용히 줄지 않게)");

		assertEquals(doc(block("x"), block("y")), CollectionMarkup.toMarkup("x" + ch(0x0A) + "y", ""),
				"U+000A는 블록 경계다");
	}

	/**
	 * 제어문자 32자를 <b>한 문자열에</b> 담은 Node 실측 출력과 바이트 단위로 같은가 — 위 루프가 코드포인트
	 * 하나씩 보는 것과 달리 여기서는 <b>전체 출력 한 줄</b>을 통째로 대조한다(구분자·순서까지 함께 잠긴다).
	 */
	@Test
	void theWholeControlRangeMatchesTheMeasuredNodeOutputVerbatim() {
		StringBuilder all = new StringBuilder();
		for (int cp = 0x00; cp <= 0x1F; cp++) {
			all.append(ch(cp));
		}

		// Node 실측(2026-08-25): JSON.stringify가 U+000A에서 블록을 가르고 나머지를 위 표대로 쓴다.
		assertEquals("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":["
				+ "{\"type\":\"text\",\"text\":\"\\u0000\\u0001\\u0002\\u0003\\u0004\\u0005\\u0006\\u0007\\b\\t\"},"
				+ "{\"type\":\"text\",\"text\":\"\\u000b\\f\\r\\u000e\\u000f\\u0010\\u0011\\u0012\\u0013\\u0014"
				+ "\\u0015\\u0016\\u0017\\u0018\\u0019\\u001a\\u001b\\u001c\\u001d\\u001e\\u001f\"}]}",
				CollectionMarkup.toMarkup(all.toString(), ""));
	}

	/**
	 * {@code U+007F}(DEL)는 <b>이스케이프하지 않는다</b> — Node 실측이다(제어문자지만 JSON 문자열에서
	 * 유효하다). 여기를 escape하는 설정({@code ESCAPE_NON_ASCII} 등)이 켜지면 저장 바이트가 갈린다.
	 */
	@Test
	void theDeleteCharacterIsWrittenVerbatimJustLikeJsonStringify() {
		assertEquals(doc(block("x" + ch(0x007F) + "y")), CollectionMarkup.toMarkup("x" + ch(0x007F) + "y", ""));
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
