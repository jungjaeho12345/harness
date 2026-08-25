package harness.news.service;

import java.util.List;
import java.util.Map;

/**
 * 수집(자동기사) 기본 파서 — 리포 루트 {@code src/parsers/defaultParser.js}의 이식.
 *
 * <p><b>순수 모듈</b>이다: DB·HTTP·파일시스템·시계·난수에 의존하지 않고 입력은 이미 판독된 payload뿐이다
 * (FTP 파일 문자열이든 API 응답 JSON이든 여기서는 같은 값 도메인이다).
 *
 * <p><b>검증하지 않는다</b>는 것이 계약이다. 수집 라우트는 payload가 없어도 거부하지 않고 200 + 빈 기사를
 * 만든다({@code receive-missing-payload}) — 여기에 거부·정규화(HTML 이스케이프·공백 압축·개행 축약)를
 * 하나라도 더하면 그 자리에서 계약이 red다. 결과 두 값은 <b>절대 null이 아니다</b>.
 *
 * <p>다듬기는 {@link NodeString#trim(String)}이다({@link String#trim()}·{@link String#strip()} 금지 —
 * 셋의 공백 집합이 서로 다르고, 여기서 갈리면 붙여넣기 본문의 NBSP 하나로 두 서버가 다른 제목을
 * <b>영속</b>한다).
 */
public final class CollectionParser {

	/** JS {@code String({})} — JSON 값 도메인의 객체는 자기 {@code toString}을 갖지 않는다. */
	private static final String OBJECT_TAG = "[object Object]";

	private CollectionParser() {
	}

	/**
	 * 결과 계약 — 두 값 모두 non-null 문자열이다(Node {@code {title, content}} 동형).
	 */
	public record Parsed(String title, String content) {
	}

	/**
	 * payload → 제목·본문.
	 *
	 * <ul>
	 *   <li><b>객체</b>({@code Map})는 {@code title}·{@code content ?? body}를 필드에서 직접 취하고,
	 *       제목이 비어 있고 본문이 비어 있지 않을 때만 본문 첫 줄을 제목으로 승격한다.</li>
	 *   <li><b>배열</b>({@code List})도 JS {@code typeof}가 {@code 'object'}라 같은 가지로 간다 —
	 *       필드가 없으므로 결과는 빈 제목·빈 본문이다. 문자열로 강제변환하면 {@code '1,2'} 같은 값이
	 *       제목이 되어 Node와 갈린다.</li>
	 *   <li>그 밖(문자열·숫자·불리언·{@code null})은 첫 줄이 제목이다.</li>
	 * </ul>
	 *
	 * @param payload Jackson이 만든 값({@code String}·{@code Number}·{@code Boolean}·{@code Map}·
	 *     {@code List}·{@code null})
	 */
	public static Parsed parse(Object payload) {
		if (payload instanceof Map<?, ?> || payload instanceof List<?>) {
			Map<?, ?> fields = (payload instanceof Map<?, ?> map) ? map : Map.of();
			String title = NodeString.trim(str(fields.get("title")));
			Object body = fields.get("content");
			if (body == null) {
				// 널 병합(??)이다 — 키가 없거나 값이 null일 때만 body를 본다.
				// 빈 문자열은 nullish가 아니므로 '' 쪽이 이긴다(여기서 isEmpty를 보면 계약이 갈린다).
				body = fields.get("body");
			}
			String content = str(body);
			if (title.isEmpty() && !content.isEmpty()) {
				return splitFirstLine(content);
			}
			return new Parsed(title, content);
		}
		return splitFirstLine(payload);
	}

	/**
	 * 텍스트의 첫 줄이 제목, 나머지가 본문. CRLF는 LF로 정규화하고 선행 빈 줄은 버린다.
	 *
	 * <p><b>제목만 다듬는다</b> — 본문은 앞뒤 공백까지 원문 그대로다(계약이 원문 왕복을 단언한다).
	 */
	private static Parsed splitFirstLine(Object text) {
		String normalized = stripLeadingNewlines(str(text).replace("\r\n", "\n"));
		int newline = normalized.indexOf('\n');
		if (newline < 0) {
			return new Parsed(NodeString.trim(normalized), "");
		}
		return new Parsed(NodeString.trim(normalized.substring(0, newline)), normalized.substring(newline + 1));
	}

	/** {@code replace(/^\n+/, '')} — CRLF 정규화 <b>뒤</b>에 도는 규칙이라 LF만 본다(단독 CR은 남는다). */
	private static String stripLeadingNewlines(String text) {
		int start = 0;
		while (start < text.length() && text.charAt(start) == '\n') {
			start++;
		}
		return text.substring(start);
	}

	/**
	 * JS {@code v == null ? '' : String(v)} — 강제변환을 <b>빼지도 더하지도 않는다</b>.
	 *
	 * <p>{@code null}(=JS {@code null}·{@code undefined})만 빈 문자열이고 숫자·불리언은 문자열이 된다.
	 * {@link String#valueOf}를 그대로 쓰면 {@code null}이 {@code "null"}이 되고 중첩 객체·배열이 Java
	 * 표기({@code {a=1}}·{@code [1, 2]})로 나가므로, 그 두 가지는 JS 규칙으로 직접 쓴다.
	 *
	 * <p><b>남은 divergence 하나</b>: 정수값 실수의 표기다(JSON {@code 2.0} → Jackson {@code Double} →
	 * Java {@code "2.0"} / Node {@code "2"}). 계약 3파일 어디도 수치 payload를 보내지 않고, JS
	 * {@code Number::toString} 전체 규칙(1e21 임계·{@code 1e+21} 지수 표기)을 여기 재구현하면 <b>부분
	 * 충실</b>이 되어 지금보다 위험하다 — {@code CollectionParserTest}가 그 사실을 붙잡아 둔다.
	 */
	private static String str(Object value) {
		if (value == null) {
			return "";
		}
		if (value instanceof Map<?, ?>) {
			return OBJECT_TAG;
		}
		if (value instanceof List<?> list) {
			// Array.prototype.toString = join(',') — null·undefined 원소는 빈 조각이고 중첩은 평탄해진다.
			StringBuilder joined = new StringBuilder();
			for (int i = 0; i < list.size(); i++) {
				if (i > 0) {
					joined.append(',');
				}
				joined.append(str(list.get(i)));
			}
			return joined.toString();
		}
		return String.valueOf(value);
	}

}
