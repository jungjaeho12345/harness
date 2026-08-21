package harness.news.web;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import harness.news.model.ContentsProjection;
import harness.news.model.ContentsRow;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;
import org.springframework.mock.web.MockHttpServletRequest;
import org.springframework.mock.web.MockHttpServletResponse;
import tools.jackson.databind.ObjectMapper;

/**
 * <b>직렬화 안전망</b>(index.json decisions (4)① · step11 D-10(ii)) — 원본 행을 응답 본문으로 넘기면
 * <b>예외</b>다. 이 층이 있어야 투영 우회가 "조용한 200"이 아니라 500으로 드러난다.
 *
 * <h2>왜 {@link JsonHttp}를 통과시키는가</h2>
 * 이 서버의 응답 바이트는 전부 {@code JsonHttp.write} 한 지점에서 만들어진다(메시지 컨버터를 쓰지
 * 않는다 — decisions (22)). 그래서 "응답 본문이 될 수 있는가"는 그 메서드로 물어야 실제 경로와 같다.
 * 매퍼를 직접 부르는 단위 단언({@code ContentsProjectionTest})은 <b>타입의 성질</b>을 잠그고,
 * 이 테스트는 <b>응답 경로</b>가 그 성질에 실제로 걸린다는 것을 잠근다.
 *
 * <h2>동어반복 방지</h2>
 * {@code JsonHttp.write}는 컨테이너 밖(= Tomcat seam 없음)에서 <b>항상</b> 실패한다
 * ({@link RawContentType}는 폴백하지 않는다). 그래서 "예외가 났다"만 보면 어떤 본문에도 green이라
 * <b>공허하다</b>. 이 테스트는 두 본문이 <b>서로 다른 지점에서</b> 실패한다는 것을 단언한다:
 * 투영 맵은 직렬화를 통과해 seam 오류까지 가고, 원본 행은 <b>그 전에</b> 막힌다.
 */
class ResponseBodyProjectionGuardTest {

	/** 잠금 비밀 컬럼에 들어 있는 값 — 어떤 예외 메시지에도 실려서는 안 된다. */
	private static final String SECRET = "session-token-원문-9f2c";

	@Test
	void aProjectedMapGetsPastSerializationAndOnlyFailsAtTheContainerSeam() {
		MockHttpServletResponse response = new MockHttpServletResponse();

		IllegalStateException seam = assertThrows(IllegalStateException.class,
				() -> write(response, ContentsProjection.toPublic(lockedRow())));

		assertTrue(seam.getMessage().contains(RawContentType.REQUEST_ATTRIBUTE),
				"투영 맵은 직렬화를 통과해야 한다(여기서 실패하면 이 테스트의 대조군이 성립하지 않는다): "
						+ seam.getMessage());
		assertEquals(0, response.getContentAsByteArray().length, "seam이 없으면 바이트는 쓰이지 않는다");
	}

	@Test
	void aRawContentsRowIsRejectedBeforeAnythingIsWritten() {
		MockHttpServletResponse response = new MockHttpServletResponse();

		RuntimeException blocked = assertThrows(RuntimeException.class, () -> write(response, lockedRow()));

		String chain = messages(blocked);
		assertTrue(chain.contains("ContentsProjection.toPublic"),
				"실패 진단이 우회한 지점을 가리켜야 한다: " + chain);
		assertFalse(chain.contains(RawContentType.REQUEST_ATTRIBUTE),
				"원본 행은 seam에 닿기 전에 막혀야 한다 — 직렬화가 성공했다는 뜻이다: " + chain);
		assertFalse(chain.contains(SECRET), "예외 메시지에 컬럼 값이 실리면 로그가 곧 유출이다");
		assertEquals(0, response.getContentAsByteArray().length, "거부된 본문의 바이트가 나가면 안 된다");
	}

	@Test
	void aRawRowNestedInsideTheEnvelopeIsRejectedToo() {
		// 실제 우회 형태 — 봉투는 정상이고 items에 원본 행이 실린다(목록·검색이 만드는 shape).
		Map<String, Object> envelope = JsonHttp.ok();
		envelope.put("items", List.of(lockedRow()));
		MockHttpServletResponse response = new MockHttpServletResponse();

		RuntimeException blocked = assertThrows(RuntimeException.class, () -> write(response, envelope));

		String chain = messages(blocked);
		assertTrue(chain.contains("ContentsProjection.toPublic"), "중첩된 원본 행도 막혀야 한다: " + chain);
		assertFalse(chain.contains(SECRET), "예외 메시지에 컬럼 값이 실리면 로그가 곧 유출이다");
		assertEquals(0, response.getContentAsByteArray().length,
				"직렬화가 중간까지 진행돼도 바이트는 나가지 않는다(본문은 한 번에 쓴다)");
	}

	private static void write(MockHttpServletResponse response, Object body) {
		new JsonHttp(new ObjectMapper()).write(new MockHttpServletRequest(), response, 200, body);
	}

	/** 잠긴 기사 한 행 — 두 비밀 컬럼에 값이 들어 있다(단언이 공허하지 않다). */
	private static ContentsRow lockedRow() {
		Map<String, Object> columns = new LinkedHashMap<>();
		columns.put("articleId", "AKR20260101000000001");
		columns.put("title", "제목");
		columns.put("lockYN", "Y");
		columns.put("lockerUserId", "desk-1");
		columns.put("lockerSessionId", SECRET);
		columns.put("lockerClientId", "tab-1");
		return ContentsRow.of(columns);
	}

	/** 예외 사슬의 메시지 전부 — Jackson이 원인 예외를 감싸도 진단이 남아 있어야 한다. */
	private static String messages(Throwable error) {
		StringBuilder text = new StringBuilder();
		for (Throwable cursor = error; cursor != null; cursor = cursor.getCause()) {
			text.append(cursor.getClass().getName()).append(": ").append(cursor.getMessage()).append('\n');
		}
		return text.toString();
	}

}
