package harness.news.model;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import org.junit.jupiter.api.Test;
import tools.jackson.databind.json.JsonMapper;

/**
 * DB 행이 응답·로그로 새지 않는다는 형(型) 차원의 방어선.
 *
 * <p>{@link UserRow}는 {@code password}와 잠금 필드를 담은 <b>raw</b>다(도메인 로직이 그것들을 읽어야
 * 하므로 담는 것이 맞다). 위험은 이 객체가 실수로 그대로 응답 본문이 되거나 로그 문자열이 되는 것이다 —
 * {@code lockerSessionId} 유출 사례와 같은 부류의 사고다. 그래서 ① 직렬화되면 필드가 하나도 나가지 않고
 * ② {@code toString()}은 비밀번호 해시를 가린다. 응답 투영은 서비스 계층이 명시적으로 만든다.
 */
class UserRowTest {

	private static final UserRow SAMPLE = new UserRow(
			"reporter", "김기자", "$2a$10$abcdefghijklmnopqrstuv", "R", "사회부", "SOC", "Y",
			"3", "1787126400000", "1787125500000");

	@Test
	void isNotSerializableAsAResponseBody() {
		// 매퍼가 속성을 찾지 못하면 빈 객체를 내거나 예외로 거부한다 — 둘 다 "유출 아님"이므로 모두 통과다.
		// 판정하는 것은 실패 방식이 아니라 "값이 밖으로 나가지 않는다"는 사실 하나다.
		String json;
		try {
			json = JsonMapper.builder().build().writeValueAsString(SAMPLE);
		}
		catch (RuntimeException ex) {
			json = "<직렬화 거부: " + ex.getClass().getSimpleName() + ">";
		}

		assertFalse(json.contains("$2a$10$"), "비밀번호 해시가 직렬화되면 안 된다: " + json);
		assertFalse(json.contains("1787126400000"), "잠금 상태가 직렬화되면 안 된다: " + json);
		assertFalse(json.contains("reporter"), "DB 행을 그대로 응답으로 흘릴 수 없어야 한다: " + json);
	}

	@Test
	void toStringRedactsThePasswordHash() {
		String text = SAMPLE.toString();

		assertFalse(text.contains("$2a$10$"), "로그에 비밀번호 해시가 남으면 안 된다: " + text);
		assertTrue(text.contains("reporter"), "진단에 필요한 식별자는 남는다: " + text);
	}
}
