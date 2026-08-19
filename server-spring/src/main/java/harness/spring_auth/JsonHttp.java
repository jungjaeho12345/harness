package harness.spring_auth;

import jakarta.servlet.http.HttpServletResponse;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.Map;

/**
 * JSON 응답 writer — content-type을 **Node(express res.json)와 바이트 동일**하게 강제한다:
 *   application/json; charset=utf-8  (세미콜론 뒤 공백·소문자 utf-8 — 계약 리포트가 이 헤더를 값으로 비교한다).
 * Spring/Tomcat의 setContentType 정규화(공백 제거·대문자 UTF-8)를 우회하려 raw 바이트를 직접 쓰고
 * Content-Type 헤더를 setHeader로 지정한다.
 *
 * 직렬화는 손수 한다(Boot 4.1은 Jackson 3(tools.jackson) 기반이라 응답만 위해 별도 의존성을 끌지 않는다).
 * 응답 본문(JSON) 자체는 계약이 파싱해 키/값만 비교하므로 공백·키 순서는 무관하다 — content-type 헤더만 정확하면 된다.
 * 지원 타입: null·Boolean·Number·String·Map·List(이 슬라이스 응답 shape 전부를 덮는다).
 */
final class JsonHttp {

	static final String CONTENT_TYPE = "application/json; charset=utf-8";

	private JsonHttp() {
	}

	static void write(HttpServletResponse res, int status, Object body) throws IOException {
		StringBuilder sb = new StringBuilder();
		encode(body, sb);
		byte[] payload = sb.toString().getBytes(StandardCharsets.UTF_8);
		res.setStatus(status);
		// content-type은 ResponseContentType로만 지정한다(setContentType/setCharacterEncoding 호출 금지 —
		// 그러면 컨테이너가 커밋 시 헤더를 재조립해 공백이 사라진다). 본문은 UTF-8 바이트로 직접 쓴다.
		ResponseContentType.set(res, CONTENT_TYPE);
		res.getOutputStream().write(payload);
	}

	private static void encode(Object v, StringBuilder sb) {
		if (v == null) {
			sb.append("null");
		} else if (v instanceof String s) {
			encodeString(s, sb);
		} else if (v instanceof Boolean || v instanceof Number) {
			sb.append(v);
		} else if (v instanceof Map<?, ?> m) {
			encodeMap(m, sb);
		} else if (v instanceof List<?> list) {
			encodeList(list, sb);
		} else {
			// 예상 밖 타입은 문자열로 안전 처리(이 슬라이스에서는 도달하지 않는다).
			encodeString(String.valueOf(v), sb);
		}
	}

	private static void encodeMap(Map<?, ?> m, StringBuilder sb) {
		sb.append('{');
		boolean first = true;
		for (Map.Entry<?, ?> e : m.entrySet()) {
			if (!first) {
				sb.append(',');
			}
			first = false;
			encodeString(String.valueOf(e.getKey()), sb);
			sb.append(':');
			encode(e.getValue(), sb);
		}
		sb.append('}');
	}

	private static void encodeList(List<?> list, StringBuilder sb) {
		sb.append('[');
		boolean first = true;
		for (Object item : list) {
			if (!first) {
				sb.append(',');
			}
			first = false;
			encode(item, sb);
		}
		sb.append(']');
	}

	private static void encodeString(String s, StringBuilder sb) {
		sb.append('"');
		for (int i = 0; i < s.length(); i++) {
			char c = s.charAt(i);
			switch (c) {
				case '"' -> sb.append("\\\"");
				case '\\' -> sb.append("\\\\");
				case '\n' -> sb.append("\\n");
				case '\r' -> sb.append("\\r");
				case '\t' -> sb.append("\\t");
				case '\b' -> sb.append("\\b");
				case '\f' -> sb.append("\\f");
				default -> {
					if (c < 0x20) {
						sb.append(String.format("\\u%04x", (int) c));
					} else {
						sb.append(c); // 비ASCII(한글 등)는 UTF-8로 그대로 — 유효 JSON.
					}
				}
			}
		}
		sb.append('"');
	}
}
