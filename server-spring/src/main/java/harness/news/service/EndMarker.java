package harness.news.service;

import java.util.List;
import java.util.Map;

/**
 * 송고 가드의 "(끝)" 마커 판정 — 리포 루트 {@code src/services/articleService.js} 38~55행의 이식.
 *
 * <p>본문은 {@code Article.markupVersion}에 블록 JSON으로 저장된다. 블록 문서면 <b>모든 블록</b>의
 * 문자열 {@code text}를 개행으로 이어 붙여 마커를 찾고, 파싱 불가·평문 레거시면 원문 문자열을 그대로
 * 검사한다.
 *
 * <p><b>블록의 {@code type}을 보지 않는다.</b> 제목 파생({@link HistoryMeta#snapshotTitle})은
 * {@code type === 'text'}인 블록만 세므로 두 규칙은 다르다 — 합치면 계약 픽스처({@code type} 키가 없는
 * 블록)에서 모든 송고가 400 {@code no-end-marker}로 뒤집힌다.
 */
public final class EndMarker {

	/** 완결 마커. 이 문자열이 본문 텍스트에 <b>포함</b>되면 송고할 수 있다(위치는 보지 않는다). */
	private static final String MARKER = "(끝)";

	private static final String BLOCKS = "blocks";

	private static final String TEXT = "text";

	/** 본문에 "(끝)" 마커가 있는가. 빈 값·{@code null}은 거짓이다. */
	public static boolean present(Object markupVersion) {
		if (markupVersion == null) {
			return false;
		}
		String raw = String.valueOf(markupVersion);
		if (raw.isEmpty()) {
			return false;
		}

		return blockText(raw).contains(MARKER);
	}

	/**
	 * 블록 문서면 블록 텍스트를, 아니면 원문을 돌려준다.
	 *
	 * <p>최상위 배열은 블록 문서가 아니다 — Node는 {@code doc.blocks}만 보므로 그 경우 원문 문자열이
	 * 검사 대상이 된다(제목 파생과 또 하나 다른 점이다).
	 */
	private static String blockText(String raw) {
		Object doc = MarkupJson.parseOrNull(raw);
		if (!(doc instanceof Map<?, ?> map) || !(map.get(BLOCKS) instanceof List<?> blocks)) {
			return raw;
		}

		StringBuilder joined = new StringBuilder();
		for (int i = 0; i < blocks.size(); i++) {
			if (i > 0) {
				joined.append('\n');
			}
			// 비문자열 text는 빈 문자열로 대체한다 — 줄 자체는 남는다(Node의 map 결과와 원소 수가 같다).
			if (blocks.get(i) instanceof Map<?, ?> block && block.get(TEXT) instanceof String text) {
				joined.append(text);
			}
		}
		return joined.toString();
	}

	private EndMarker() {
	}
}
