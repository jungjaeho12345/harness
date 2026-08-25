package harness.news.service;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import tools.jackson.core.SerializableString;
import tools.jackson.core.io.CharacterEscapes;
import tools.jackson.core.io.SerializedString;
import tools.jackson.core.json.JsonFactory;
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

	/**
	 * 조립 <b>전용</b> 매퍼 — 공백 없음 · 비ASCII 그대로이고, {@code \\u00XX} 16진수만
	 * {@link LowercaseHexEscapes 소문자}로 바꿔 {@code JSON.stringify}와 <b>바이트 동일</b>하게 만든다.
	 *
	 * <p><b>전역 매퍼가 아니다</b>: {@code JsonHttp}의 와이어 매퍼와 완전히 별개이며 이 이스케이프 설정은
	 * 여기서만 산다. 응답 와이어(계약 236관측)를 건드리지 않고 <b>DB 컬럼 값</b>만 Node에 맞추는 것이
	 * 이 필드가 따로 있는 이유다.
	 */
	private static final ObjectMapper MAPPER = JsonMapper
			.builder(JsonFactory.builder().characterEscapes(new LowercaseHexEscapes()).build()).build();

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

	/**
	 * {@code \\u00XX} 이스케이프의 16진수를 <b>소문자</b>로 쓴다 — Jackson 기본값만 대문자이기 때문이다
	 * ({@code JSON.stringify}는 소문자다).
	 *
	 * <h2>갈리는 자리는 9자뿐이다</h2>
	 * {@code U+000B} · {@code U+000E} · {@code U+000F} · {@code U+001A}~{@code U+001F}. 나머지 제어문자는
	 * 짧은 이스케이프({@code \b} {@code \t} {@code \n} {@code \f} {@code \r})이거나 16진수가 숫자뿐이라
	 * 표기가 하나다. 그래서 이 클래스는 <b>그 9자만</b> 가로채고 나머지는 Jackson 표준 처리에 맡긴다
	 * ({@link CharacterEscapes#standardAsciiEscapesForJSON()}을 그대로 물려받는다 — 다시 구현하면 짧은
	 * 이스케이프·따옴표·역슬래시까지 우리가 책임지게 된다).
	 *
	 * <p>{@code U+007F}(DEL)·비ASCII·대리 쌍은 <b>건드리지 않는다</b>: Node도 escape하지 않는다(실측).
	 *
	 * <p>왜 국소인가 — 이 이스케이프는 {@link CollectionMarkup#MAPPER}에만 걸린다. 전역
	 * {@code ObjectMapper}나 {@code JsonHttp}의 와이어 매퍼를 바꾸면 계약 236관측이 통째로 걸리는데,
	 * 여기서 필요한 것은 <b>DB에 영속되는 문자열</b> 하나뿐이다.
	 */
	private static final class LowercaseHexEscapes extends CharacterEscapes {

		private static final long serialVersionUID = 1L;

		/** 16진수 letter가 섞이는 제어문자들 — 이 값들만 우리가 쓴다. */
		private static final int[] LOWERCASE_HEX_CHARS = { 0x0B, 0x0E, 0x0F, 0x1A, 0x1B, 0x1C, 0x1D, 0x1E, 0x1F };

		private final int[] escapeCodes;

		private final SerializableString[] sequences = new SerializableString[0x20];

		LowercaseHexEscapes() {
			this.escapeCodes = CharacterEscapes.standardAsciiEscapesForJSON();
			for (int ch : LOWERCASE_HEX_CHARS) {
				this.escapeCodes[ch] = CharacterEscapes.ESCAPE_CUSTOM;
				this.sequences[ch] = new SerializedString(String.format("\\u%04x", ch));
			}
		}

		@Override
		public int[] getEscapeCodesForAscii() {
			// 사본을 준다 — 생성기가 이 배열을 자기 것으로 들고 가므로 원본이 밖에서 변형되면 안 된다.
			return this.escapeCodes.clone();
		}

		@Override
		public SerializableString getEscapeSequence(int ch) {
			// ESCAPE_CUSTOM으로 표시한 9자에만 불린다. 그 밖은 null이고 그때 Jackson이 실패로 알린다
			// (조용히 빈 문자열을 쓰지 않는다 — 본문 한 글자가 소리 없이 사라지는 것보다 낫다).
			return (ch >= 0 && ch < this.sequences.length) ? this.sequences[ch] : null;
		}

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
