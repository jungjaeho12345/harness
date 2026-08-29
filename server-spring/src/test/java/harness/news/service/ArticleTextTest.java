package harness.news.service;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotEquals;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

/**
 * {@link ArticleText} — 정본 {@code server/index.js} 396~416행 {@code articleToText}의 이식 대조표다.
 *
 * <p>기대값은 계획서가 아니라 <b>정본 함수를 그대로 복사해 돌린 Node 실행 결과</b>에서 옮겼다(2026-08-28
 * 리포 밖 스크래치패드, Node v24.16.0 — 21행 전건).
 *
 * <h2>계약이 보는 것은 한 조각뿐이다</h2>
 * 계약({@code media-upload.contract.js} 150~172행)이 관측하는 것은 자기 픽스처의 본문이 원문 그대로
 * 돌아온다는 것({@code translatedText.includes('(끝)')}) 하나이고, 그 픽스처는 <b>정상 블록 문서</b>다.
 * 폴백 순서·{@code ??} 병합·평문 레거시·빈 블록 문서는 <b>계약 밖</b>이라 이 테스트가 유일 방어선이다.
 * 갈리면 키가 설정된 배포에서 <b>다른 문장이 번역되어 나간다</b>(그리고 아무도 모른다).
 */
class ArticleTextTest {

	/** NO-BREAK SPACE — JS {@code trim}은 지우고 {@link String#trim()}은 남긴다. */
	private static final String NBSP = "\u00A0";

	/** ZERO WIDTH NO-BREAK SPACE(BOM) — 같은 축. */
	private static final String BOM = "\uFEFF";

	/**
	 * 반대 방향 대조 — {@link String#strip()}은 지우지만 <b>JS는 공백으로 보지 않는다</b>.
	 * 두 방향을 한 테스트가 동시에 잠가야 {@code trim}/{@code strip} 어느 쪽으로 바꿔도 red가 난다.
	 */
	private static final String FILE_SEPARATOR = "\u001C";

	// --- 블록 문서 ------------------------------------------------------------------------

	/**
	 * 정본은 <b>모든 블록</b>의 {@code text}를 개행으로 잇고 문자열이 아닌 자리는 빈 문자열로 남긴다 —
	 * 줄 자체는 사라지지 않으므로 이미지 블록 하나가 <b>빈 줄</b>이 된다(Node 실측 {@code "a\n\nb"}).
	 *
	 * <p>{@link HistoryMeta}는 {@code type === 'text'}인 블록만 세는 <b>다른 규칙</b>이다. 그 규칙으로
	 * 합치면 여기서 빈 줄이 사라진다.
	 */
	@Test
	@DisplayName("블록 text를 개행으로 잇고 비문자열 블록은 빈 줄로 남긴다")
	void itJoinsEveryBlockTextWithNewlines() {
		String markup = "{\"blocks\":[{\"text\":\"a\"},{\"type\":\"image\"},{\"text\":\"b\"}]}";

		assertEquals("a\n\nb", ArticleText.of(found(markup, "AT", "CT")));
		assertEquals("a\n\nb", ArticleText.of(found("{\"blocks\":[{\"text\":\"a\"},{\"text\":\"\"},{\"text\":\"b\"}]}",
				null, null)), "빈 문자열 블록도 줄을 차지한다");
		assertEquals("a", ArticleText.of(found("{\"blocks\":[null,{\"text\":\"a\"}]}", null, null)),
				"원소가 null이어도 던지지 않는다");
		assertEquals("a", ArticleText.of(found("{\"blocks\":[{\"text\":1},{\"text\":\"a\"}]}", null, null)),
				"text가 문자열이 아니면 빈 줄이다");
	}

	/**
	 * 이어 붙인 결과를 <b>JS {@code trim}</b>으로 다듬는다 — {@link NodeString#trim} 단일 출처다.
	 *
	 * <p>{@link String#trim()}이면 NBSP·BOM이 남아 <b>번역 대상 문자열 자체가 달라지고</b>,
	 * {@link String#strip()}이면 U+001C를 지워 정본이 남기는 문자를 잃는다.
	 */
	@Test
	@DisplayName("앞뒤 다듬기는 JS 공백 집합이다(NBSP·BOM은 지우고 U+001C는 남긴다)")
	void itTrimsWithNodeWhitespace() {
		String padded = "{\"blocks\":[{\"text\":\" " + NBSP + "x" + BOM + " \"}]}";

		assertEquals("x", ArticleText.of(found(padded, null, null)));

		// JSON 문자열 안의 제어문자는 <b>이스케이프 시퀀스</b>여야 한다(raw 0x1C는 JSON.parse도 Jackson도
		// 거부한다 — Node 실측: 그 입력은 파싱 실패로 원문 전체가 본문이 된다).
		String separators = "{\"blocks\":[{\"text\":\"\\u001Cx\\u001C\"}]}";
		assertEquals(FILE_SEPARATOR + "x" + FILE_SEPARATOR, ArticleText.of(found(separators, null, null)),
				"JS는 U+001C를 공백으로 보지 않는다 — String.strip()이면 red다");

		String onlyNodeWhitespace = "{\"blocks\":[{\"text\":\"" + NBSP + BOM + "\"}]}";
		assertEquals("CT", ArticleText.of(found(onlyNodeWhitespace, "AT", "CT")),
				"JS 공백만 남은 본문은 빈 본문이라 폴백으로 넘어간다");
	}

	/** 블록 문서지만 결과가 빈 문자열이면 <b>폴백으로 넘어간다</b>(빈 본문을 그대로 쓰지 않는다). */
	@Test
	@DisplayName("블록 텍스트가 전부 비면 제목 폴백으로 넘어간다")
	void anEmptyBlockDocumentFallsThroughToTheTitle() {
		assertEquals("CT", ArticleText.of(found("{\"blocks\":[{\"text\":\"  \"},{\"text\":\"\"}]}", "AT", "CT")));
		assertEquals("CT", ArticleText.of(found("{\"blocks\":[]}", "AT", "CT")));
	}

	// --- 문서가 아닌 본문 -------------------------------------------------------------------

	/**
	 * {@code JSON.parse}가 <b>던지는</b> 자리(평문 레거시)에서만 원문 문자열을 쓴다 — 정본의
	 * {@code catch} 분기다. 파싱은 됐는데 모양이 다른 경우는 여기 오지 않는다(바로 아래 테스트).
	 */
	@Test
	@DisplayName("깨진 JSON(평문 레거시)은 원문을 다듬어 쓴다")
	void brokenJsonUsesTheRawStringTrimmed() {
		assertEquals("평문 본문", ArticleText.of(found("  평문 본문  ", "AT", "CT")));
		assertEquals("CT", ArticleText.of(found("   ", "AT", "CT")), "공백뿐인 원문은 빈 본문이라 폴백이다");
		assertEquals("x", ArticleText.of(found(NBSP + "x" + BOM, null, null)), "여기서도 다듬기는 JS 공백이다");

		// JSON 문자열 안의 <b>이스케이프되지 않은</b> 제어문자는 JSON.parse도 Jackson도 거부한다 —
		// 그래서 이 입력의 본문은 블록 텍스트가 아니라 <b>원문 전체</b>다(Node 실측).
		String rawControl = "{\"blocks\":[{\"text\":\"" + FILE_SEPARATOR + "x\"}]}";
		assertEquals(rawControl, ArticleText.of(found(rawControl, "AT", "CT")));
	}

	/**
	 * 판독기가 {@code JSON.parse}만큼 <b>엄격</b>해야 한다 — 관대한 파서를 쓰면 정본이 "평문 레거시"로
	 * 보는 본문을 Java만 블록 문서로 읽어 <b>서로 다른 문장을 번역</b>한다.
	 *
	 * <p>여기 있는 11행은 {@code JSON.parse}가 전부 던지는 입력이다(Node 실측). 후행 토큰이 특히
	 * 중요하다 — 많은 JSON 라이브러리가 기본값으로 허용한다.
	 */
	@Test
	@DisplayName("판독은 JSON.parse만큼 엄격하다(후행 토큰·홑따옴표·NaN 전부 평문 취급)")
	void theParserIsAsStrictAsJsonParse() {
		List<String> rejectedByJsonParse = List.of(
				"{\"blocks\":[{\"text\":\"a\"}]}xyz",
				"{\"blocks\":[{\"text\":\"a\"}]} {\"blocks\":[]}",
				"{'blocks':[{'text':'a'}]}",
				"{blocks:[{text:\"a\"}]}",
				"{\"blocks\":[{\"text\":\"a\"}],}",
				"{\"blocks\":[{\"text\":\"a\"}]}//c",
				"NaN",
				"Infinity",
				"{\"blocks\":[{\"text\":\"a\"}], \"n\": 01}",
				"undefined");

		for (String raw : rejectedByJsonParse) {
			assertEquals(raw, ArticleText.of(found(raw, "AT", "CT")), "평문 레거시로 취급해야 한다: " + raw);
		}

		// 반대로 후행 <b>공백</b>은 JSON.parse도 허용한다 — 그때는 블록 본문이다.
		assertEquals("a", ArticleText.of(found("{\"blocks\":[{\"text\":\"a\"}]}\n", "AT", "CT")));
	}

	/**
	 * <b>파싱은 성공했는데 블록 문서가 아닌</b> 값들은 원문이 아니라 <b>제목 폴백</b>이다 — 정본의
	 * {@code try} 블록을 빠져나가 마지막 {@code return}으로 간다.
	 *
	 * <p>{@code "null"}이 이 표에서 가장 중요한 행이다: {@link MarkupJson#parseOrNull}은 <b>파싱 실패</b>와
	 * <b>JSON {@code null} 리터럴</b>을 똑같이 {@code null}로 돌려주므로, 그 둘을 가르지 않으면 이 입력이
	 * "평문 레거시"로 오분류되어 본문이 문자열 {@code "null"}이 된다(Node 실측은 {@code "CT"}다).
	 */
	@Test
	@DisplayName("JSON이지만 블록 문서가 아니면 원문이 아니라 제목 폴백이다(null 리터럴 포함)")
	void parsedButNotABlockDocumentFallsBackToTheTitle() {
		Map<String, String> table = new LinkedHashMap<>();
		table.put("{\"blocks\":\"x\"}", "CT"); // blocks가 배열이 아니다
		table.put("{\"blocks\":{\"0\":{\"text\":\"a\"}}}", "CT");
		table.put("{}", "CT");
		table.put("[{\"text\":\"a\"}]", "CT"); // 최상위 배열은 블록 문서가 아니다
		table.put("null", "CT");
		table.put("  null  ", "CT");
		table.put("false", "CT");
		table.put("12", "CT");
		table.put("\"본문\"", "CT"); // JSON 문자열 리터럴

		for (Map.Entry<String, String> row : table.entrySet()) {
			assertEquals(row.getValue(), ArticleText.of(found(row.getKey(), "AT", "CT")),
					"markupVersion=" + row.getKey());
		}
	}

	/** 본문이 없는 것({@code null}·빈 문자열)은 폴백이다 — 정본의 {@code if (raw)} 게이트. */
	@Test
	@DisplayName("markupVersion이 null이거나 빈 문자열이면 폴백이다")
	void anAbsentBodyFallsBackToTheTitle() {
		assertEquals("CT", ArticleText.of(found(null, "AT", "CT")));
		assertEquals("CT", ArticleText.of(found("", "AT", "CT")));
	}

	// --- 폴백 순서(?? 병합) -----------------------------------------------------------------

	/**
	 * 폴백은 {@code found.contents?.title ?? article.title ?? ''}다 — <b>{@code ??}(null 병합)이지
	 * {@code ||}가 아니다</b>. 그래서 <b>빈 문자열 제목은 다음 후보로 넘어가지 않는다</b>.
	 *
	 * <p>{@code ||}로 바꾸면 제목이 빈 기사에서 <b>다른 기사의 제목처럼 보이는 값</b>(article.title)이
	 * 번역되어 나간다. 계약은 본문이 있는 픽스처만 보므로 이 축을 관측하지 않는다.
	 */
	@Test
	@DisplayName("폴백은 ?? 병합이다 — 빈 문자열 제목은 그대로 빈 문자열이다")
	void theTitleFallbackUsesNullishCoalescing() {
		assertEquals("", ArticleText.of(found(null, "AT", "")), "contents.title이 빈 문자열이면 거기서 끝난다");
		assertEquals("AT", ArticleText.of(found(null, "AT", null)), "contents.title이 null이면 article.title이다");
		assertEquals("AT", ArticleText.of(withoutContents(null, "AT")), "contents 행 자체가 없으면 article.title");
		assertEquals("", ArticleText.of(found(null, null, null)), "둘 다 null이면 빈 문자열");
		assertEquals("", ArticleText.of(Map.of()), "두 행이 다 없어도 빈 문자열이다(던지지 않는다)");
		assertEquals("", ArticleText.of(null), "null 입력도 빈 문자열이다");
		assertEquals("", ArticleText.of(withoutContents(null, null)));
	}

	/**
	 * {@code contents}의 {@code title} <b>키가 아예 없는</b> 경우도 {@code undefined}라 다음 후보로 간다
	 * (투영 맵은 오늘 언제나 키를 갖지만, 키 없음과 값 null을 가르는 것이 이 프로젝트의 계약이다).
	 */
	@Test
	@DisplayName("contents에 title 키가 없으면 article.title로 넘어간다")
	void aMissingTitleKeyBehavesLikeUndefined() {
		Map<String, Object> found = new LinkedHashMap<>();
		found.put("article", Map.of("title", "AT"));
		found.put("contents", Map.of("author", "kim"));

		assertEquals("AT", ArticleText.of(found));
	}

	// --- 규칙 분리(합치면 안 되는 것) -------------------------------------------------------

	/**
	 * 세 규칙이 실제로 다르다는 증거 — {@link HistoryMeta}(제목 파생)는 {@code type === 'text'}인 블록만
	 * 보고, {@link ArticleText}·{@link EndMarker}는 <b>모든 블록</b>을 본다.
	 *
	 * <p>합치면 이력 표시 제목({@code ArticleHistory.snapshotTitle}으로 <b>영속</b>되는 값)이 함께 깨진다.
	 * 그래서 오늘 결과가 다르다는 사실 자체를 못 박는다.
	 */
	@Test
	@DisplayName("HistoryMeta의 블록 필터와 결과가 다르다(합치면 안 된다)")
	void itIsNotTheSameRuleAsTheHistoryTitleDerivation() {
		String markup = "{\"blocks\":[{\"type\":\"image\",\"text\":\"캡션\"},{\"type\":\"text\",\"text\":\"본문\"}]}";

		assertEquals("캡션\n본문", ArticleText.of(found(markup, "AT", null)));
		assertNotEquals(ArticleText.of(found(markup, "AT", null)), HistoryMeta.snapshotTitle(markup),
				"두 규칙이 같아졌다 — 이력 제목 파생이 본문 도출과 합쳐졌다는 뜻이다");
	}

	// --- 유틸 --------------------------------------------------------------------------------

	/**
	 * {@code ArticleReadService.getById}가 돌려주는 모양 — {@code {article, contents}}이고 없는 쪽은
	 * <b>키가 아예 없다</b>. 여기서 {@code contents}는 이미 투영된 맵이다(원본 행 타입은 이 계층까지
	 * 올라오지 않는다).
	 */
	private static Map<String, Object> found(String markupVersion, String articleTitle, String contentsTitle) {
		Map<String, Object> found = new LinkedHashMap<>(withoutContents(markupVersion, articleTitle));
		Map<String, Object> contents = new LinkedHashMap<>();
		contents.put("articleId", "A-1");
		contents.put("title", contentsTitle);
		found.put("contents", contents);
		return found;
	}

	private static Map<String, Object> withoutContents(String markupVersion, String articleTitle) {
		Map<String, Object> article = new LinkedHashMap<>();
		article.put("articleId", "A-1");
		article.put("title", articleTitle);
		article.put("markupVersion", markupVersion);
		Map<String, Object> found = new LinkedHashMap<>();
		found.put("article", article);
		return found;
	}

}
