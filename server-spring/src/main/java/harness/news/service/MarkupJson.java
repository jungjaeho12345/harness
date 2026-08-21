package harness.news.service;

import tools.jackson.databind.ObjectMapper;
import tools.jackson.databind.json.JsonMapper;

/**
 * 본문 마크업 문자열의 JSON 판독 — Node {@code JSON.parse}의 자리.
 *
 * <p>본문({@code markupVersion})은 에디터 블록 문서({@code {"blocks":[{"text":...}]}})지만 평문 레거시와
 * 깨진 JSON이 섞여 있다. 그래서 <b>파싱 실패는 예외가 아니라 "문서가 아니다"</b>이며, 호출자는 원문
 * 문자열을 그대로 쓰는 폴백을 갖는다(Node의 try/catch 동형).
 *
 * <p>블록 필터는 여기 두지 않는다. 마커 판정({@link EndMarker})은 모든 블록의 {@code text}를 보고
 * 제목 파생({@link HistoryMeta})은 {@code type === 'text'}인 블록만 본다 — 두 규칙이 다르다는 것이
 * 실측이며 합치면 계약이 깨진다. 공유하는 것은 <b>판독</b>뿐이다.
 */
final class MarkupJson {

	private static final ObjectMapper MAPPER = JsonMapper.builder().build();

	/**
	 * @return 파싱된 값(맵·리스트·스칼라) 또는 파싱 불가·{@code null} 리터럴이면 {@code null}
	 */
	static Object parseOrNull(String raw) {
		try {
			return MAPPER.readValue(raw, Object.class);
		}
		catch (RuntimeException ex) {
			return null; // 평문 레거시·깨진 JSON — 호출자가 원문 문자열로 폴백한다.
		}
	}

	private MarkupJson() {
	}
}
