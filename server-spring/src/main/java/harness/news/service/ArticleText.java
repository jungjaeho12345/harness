package harness.news.service;

import java.util.List;
import java.util.Map;

/**
 * 번역 대상 <b>본문 도출</b> — 정본 {@code server/index.js} 396~416행 {@code articleToText}의 이식이다.
 *
 * <p>입력은 {@code ArticleReadService.getById}가 돌려주는 {@code {article, contents}} 맵이고, 출력은
 * 번역기에 넘길 문자열 하나다. <b>본문은 서버 DB에서만 온다</b>(ADR-004) — 요청 body의 {@code text}는
 * 쓰지 않는다.
 *
 * <h2>이 규칙은 이웃 두 규칙과 다르다 — 합치지 마라</h2>
 * <ul>
 * <li>{@link EndMarker}(송고 마커): <b>모든 블록</b>의 {@code text}를 잇는다. 오늘 이 클래스와 같은
 * 방식이지만 <b>정본에서도 두 함수가 따로</b> 있고({@code articleService.js} 대 {@code server/index.js})
 * 폴백이 다르다 — 여기는 제목 폴백이 있고 거기는 없다.</li>
 * <li>{@link HistoryMeta#snapshotTitle}(이력 표시 제목): {@code type === 'text'}인 블록<b>만</b> 세고
 * 빈 줄도 남기지 않으며 첫 줄만 쓴다. 그 값은 {@code ArticleHistory.snapshotTitle}로 <b>영속</b>되므로
 * 합치면 이력이 함께 깨진다.</li>
 * </ul>
 * 공유하는 것은 <b>판독</b>({@link MarkupJson#parseOrNull})뿐이다.
 *
 * <h2>{@code JSON.parse}가 던지는 자리와 던지지 않는 자리</h2>
 * 정본의 {@code catch}는 <b>파싱 실패</b>에서만 돌고 그때만 원문 문자열을 본문으로 쓴다. 파싱은 됐는데
 * 블록 문서가 아니면(예: {@code {}} · {@code [..]} · {@code 12} · {@code "문자열"}) 원문이 아니라
 * <b>제목 폴백</b>이다. {@link MarkupJson#parseOrNull}은 두 경우를 모두 {@code null}로 돌려주므로
 * <b>JSON {@code null} 리터럴</b>만 따로 가른다 — 그러지 않으면 {@code markupVersion="null"}인 기사의
 * 본문이 문자열 {@code "null"}이 된다(Node 실측은 제목 폴백이다).
 */
final class ArticleText {

	private static final String ARTICLE = "article";

	private static final String CONTENTS = "contents";

	private static final String TITLE = "title";

	private static final String MARKUP = "markupVersion";

	private static final String BLOCKS = "blocks";

	private static final String TEXT = "text";

	/** JSON {@code null} 리터럴 — 파싱 성공과 파싱 실패를 가르는 유일한 모호점이다. */
	private static final String JSON_NULL = "null";

	/** RFC 8259 {@code ws} — {@code JSON.parse}가 값 앞뒤에 허용하는 문자 넷. */
	private static final String JSON_WHITESPACE = " \t\n\r";

	private ArticleText() {
	}

	/**
	 * 기사 두 행에서 번역 대상 텍스트를 만든다.
	 *
	 * @param found {@code ArticleReadService.getById}의 결과({@code null} 가능 — 라우트가 404로 걸러내지만
	 * 여기서 던지면 200이어야 할 응답이 500이 된다)
	 * @return 블록 본문 → 원문(평문 레거시) → {@code contents.title} → {@code article.title} → 빈 문자열
	 * 순의 첫 번째 비지 않은 값. <b>{@code null}을 돌려주지 않는다</b>
	 */
	static String of(Map<String, Object> found) {
		Map<?, ?> article = mapAt(found, ARTICLE);
		Object rawValue = (article == null) ? null : article.get(MARKUP);
		// 정본의 if (raw) — 부재·빈 문자열만 걸러낸다(EndMarker.present와 같은 형태의 판정이다).
		String raw = (rawValue == null) ? "" : String.valueOf(rawValue);
		if (!raw.isEmpty()) {
			String body = bodyOf(raw);
			if (!body.isEmpty()) {
				return body;
			}
		}
		return titleOf(found, article);
	}

	/** 블록 문서면 블록 텍스트, 파싱 실패면 원문, 그 밖(파싱은 됐지만 블록 문서가 아님)이면 빈 문자열. */
	private static String bodyOf(String raw) {
		Object doc = MarkupJson.parseOrNull(raw);
		if (doc instanceof Map<?, ?> map && map.get(BLOCKS) instanceof List<?> blocks) {
			return NodeString.trim(joinBlocks(blocks));
		}
		if (doc == null && !isJsonNullLiteral(raw)) {
			return NodeString.trim(raw); // JSON.parse가 던진 자리 — 평문 레거시 본문이다
		}
		return ""; // 파싱은 됐지만 블록 문서가 아니다 → 호출자가 제목 폴백으로 간다
	}

	/**
	 * 블록 {@code text}를 개행으로 잇는다 — <b>모든 블록</b>이 한 줄을 차지하고, 문자열 {@code text}가
	 * 없는 블록은 <b>빈 줄</b>로 남는다(정본 {@code map(...).join('\n')}의 원소 수가 보존된다).
	 */
	private static String joinBlocks(List<?> blocks) {
		StringBuilder joined = new StringBuilder();
		for (int i = 0; i < blocks.size(); i++) {
			if (i > 0) {
				joined.append('\n');
			}
			if (blocks.get(i) instanceof Map<?, ?> block && block.get(TEXT) instanceof String text) {
				joined.append(text);
			}
		}
		return joined.toString();
	}

	/**
	 * 정본 {@code found.contents?.title ?? article.title ?? ''} — <b>{@code ??}(null 병합)</b>이다.
	 * 빈 문자열 제목은 <b>다음 후보로 넘어가지 않는다</b>({@code ||}로 바꾸면 갈린다).
	 */
	private static String titleOf(Map<String, Object> found, Map<?, ?> article) {
		Map<?, ?> contents = mapAt(found, CONTENTS);
		if (contents != null && contents.get(TITLE) != null) {
			return String.valueOf(contents.get(TITLE));
		}
		if (article != null && article.get(TITLE) != null) {
			return String.valueOf(article.get(TITLE));
		}
		return "";
	}

	/**
	 * {@code JSON.parse}가 <b>성공해서 {@code null}을 낸</b> 입력인가.
	 *
	 * <p>{@link MarkupJson#parseOrNull}의 반환값만으로는 "파싱 실패"와 구별할 수 없어 여기서 가른다.
	 * 값 앞뒤의 JSON 공백 넷만 허용한다 — {@code "nulll"}·{@code "null,"}은 실제로 파싱 실패이고,
	 * BOM이 붙은 {@code "﻿null"}도 {@code JSON.parse}가 던진다(JS 공백 집합이 아니다).
	 */
	private static boolean isJsonNullLiteral(String raw) {
		int start = 0;
		int end = raw.length();
		while (start < end && JSON_WHITESPACE.indexOf(raw.charAt(start)) >= 0) {
			start++;
		}
		while (end > start && JSON_WHITESPACE.indexOf(raw.charAt(end - 1)) >= 0) {
			end--;
		}
		return JSON_NULL.equals(raw.substring(start, end));
	}

	private static Map<?, ?> mapAt(Map<String, Object> found, String key) {
		return (found != null && found.get(key) instanceof Map<?, ?> row) ? row : null;
	}

}
