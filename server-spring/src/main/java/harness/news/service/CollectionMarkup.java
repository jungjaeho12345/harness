package harness.news.service;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import tools.jackson.databind.ObjectMapper;
import tools.jackson.databind.json.JsonMapper;

/**
 * 수집 본문 조립 — 분석된 제목·본문을 에디터 블록 문서 JSON으로 만든다. 리포 루트
 * {@code src/services/collectionService.js}의 {@code toMarkup}과 1:1인 <b>순수 모듈</b>이다.
 *
 * <p>본문은 {@code markupVersion}에만 저장한다(PRD: 평문 {@code content} 컬럼 미사용)고 첫 줄이 제목이다
 * (에디터 규칙) — 그래서 제목이 본문 블록의 첫 줄로 <b>한 번 더</b> 들어간다.
 *
 * <p><b>{@link MarkupJson}을 쓰지 않는 이유</b>: 그 클래스는 저장된 본문의 <b>판독</b>({@code JSON.parse}의
 * 자리)이고 실패를 {@code null}로 접는 폴백이 계약이다. 여기는 반대 방향(조립)이라 폴백이 없고 키 순서가
 * 계약이다 — 두 방향을 한 클래스에 합치면 판독 폴백이 조립 경로까지 덮는다.
 *
 * <p>이 문자열은 HTTP 응답이 아니라 <b>DB 컬럼 값</b>이다({@code JsonHttp}의 와이어 포맷 단일 지점 규율과
 * 다른 축이다). 계약은 단건 조회에서 이 문자열을 {@code JSON.parse}한 뒤 {@code format}·{@code version}·
 * 블록 텍스트를 단언한다.
 */
public final class CollectionMarkup {

	/** 조립 전용 매퍼 — 기본 설정 그대로다({@code JSON.stringify}와 같은 이스케이프·공백 없음). */
	private static final ObjectMapper MAPPER = JsonMapper.builder().build();

	private static final String FORMAT = "yh-editor";

	private static final int VERSION = 1;

	private CollectionMarkup() {
	}

	/**
	 * {@code [title, content]}에서 빈 값을 <b>버린 뒤</b> 개행으로 잇고, 그 문자열을 개행마다 잘라 블록을
	 * 만든다.
	 *
	 * <p>둘 다 비어도 블록은 <b>1개</b>다({@code ''.split('\n') === ['']}) — 계약 {@code receive-missing-payload}·
	 * {@code pull-self-health-source}가 그 수를 단언한다. 본문 안의 빈 줄·끝 개행이 만드는 빈 조각도
	 * 그대로 블록이 된다.
	 *
	 * @param title 제목({@code null} 허용 — JS {@code undefined}와 같이 버려진다)
	 * @param content 본문({@code null} 허용)
	 * @return {@code {"format":"yh-editor","version":1,"blocks":[{"type":"text","text":…}]}}
	 */
	public static String toMarkup(String title, String content) {
		String body = join(title, content);
		List<Map<String, Object>> blocks = new ArrayList<>();
		// limit -1 — 기본값은 끝의 빈 조각을 버려서 'C\n'의 블록이 2개가 아니라 1개가 된다(Node와 갈린다).
		for (String line : body.split("\n", -1)) {
			Map<String, Object> block = new LinkedHashMap<>();
			block.put("type", "text");
			block.put("text", line);
			blocks.add(block);
		}
		Map<String, Object> doc = new LinkedHashMap<>();
		doc.put("format", FORMAT);
		doc.put("version", VERSION);
		doc.put("blocks", blocks);
		return MAPPER.writeValueAsString(doc);
	}

	/** {@code [title, content].filter(s => s !== undefined && s !== null && s !== '').join('\n')}. */
	private static String join(String title, String content) {
		StringBuilder body = new StringBuilder();
		boolean first = true;
		for (String part : new String[] { title, content }) {
			// filter: undefined·null·'' 셋 다 버린다. '남은 조각이 있는가'로 대신하면 필터를 지워도
			// 빈 제목·빈 본문이 우연히 같은 값을 내서 이 규칙이 테스트에 걸리지 않는다.
			if (part == null || part.isEmpty()) {
				continue;
			}
			if (!first) {
				body.append('\n');
			}
			body.append(part);
			first = false;
		}
		return body.toString();
	}

}
