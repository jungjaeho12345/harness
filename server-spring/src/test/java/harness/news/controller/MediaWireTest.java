package harness.news.controller;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import harness.news.service.SessionGuard;
import harness.news.service.UserService;
import harness.news.testsupport.TempNewsDb;
import harness.news.testsupport.Wire;
import java.nio.file.Path;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;

/**
 * 미디어 검색 프록시({@code GET /api/media/search})의 <b>와이어</b> 계약.
 * {@code contract/cases/default/media-upload.contract.js}가 관측하는 6건과 같은 축을 원시 HTTP로 잠근다.
 *
 * <p>측정 조건은 <b>키 없는 서버</b>다(계약 하네스가 자식 env에서 키 4종을 지운다 · 여기서는
 * {@code app.media.*}를 설정하지 않는다) — 그래서 외부 네트워크를 한 번도 때리지 않고 결정적 데모
 * 폴백만 관측한다.
 *
 * <p>동결된 shape(Node {@code server/index.js} 993~1002행):
 * <pre>
 * 200 : {"ok":true,"items":[...],"error":false}   ← 키 3종·<b>이 순서</b>. 서비스의 demo 플래그는 없다.
 * 401 : {"ok":false,"reason":"unauthenticated"}   ← 경로 정책 필터가 만든다
 * </pre>
 *
 * <h2>계약이 못 보는 축을 여기서 본다</h2>
 * 계약 리포트에 실리는 것은 {@code bodyKeys}·{@code error}·{@code itemKeys}·{@code itemCount}뿐이라
 * <b>제목 문자열·링크 URL·videoId 값·원소 키 순서</b>는 두 서버가 갈려도 관측되지 않는다(index.json
 * decisions (13)). 그래서 이 테스트는 <b>응답 본문 전문</b>을 문자 단위로 단언한다 — 스텁
 * ({@code items:[]})은 계약이 잡지만 "값이 다른 데모"는 여기서만 잡힌다.
 */
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
class MediaWireTest {

	private static final Path DATA_DIR = TempNewsDb.newDataDir("media-wire");

	private static final String JSON_CONTENT_TYPE = "Content-Type: application/json; charset=utf-8";

	/** 계약과 같은 ASCII 고정 질의 — 퍼센트 인코딩 결과가 시드와 같아 기대값이 눈으로 읽힌다. */
	private static final String QUERY = "contract-media-q";

	/** 정본 {@code DEMO_VIDEO_IDS} — 값도 순서도 계약이다. */
	private static final List<String> VIDEO_IDS =
			List.of("aqz-KE-bpKQ", "jNQXAC9IVRw", "ScMzIvxBSi4", "YE7VzlLtp-4");

	@DynamicPropertySource
	static void dataDir(DynamicPropertyRegistry registry) {
		registry.add("app.data-dir", () -> DATA_DIR.toAbsolutePath().toString());
	}

	@Value("${local.server.port}")
	private int port;

	@Autowired
	private UserService users;

	@Autowired
	private SessionGuard sessions;

	@BeforeEach
	void seedUser() {
		ensureUser("media-r", "R");
	}

	// --- 1. 이미지: 6건 · 본문 전문 -----------------------------------------------------------------

	@Test
	void imageSearchReturnsSixDemoItemsAndTheExactWireBody() {
		Wire.Response response = search("q=" + QUERY + "&type=image");

		assertEquals(200, response.status());
		assertEquals(JSON_CONTENT_TYPE, response.line("content-type"));
		assertEquals(expectedImageBody(), response.body(),
				"이미지 데모 폴백의 본문이 정본과 문자 단위로 같아야 한다(계약은 값을 보지 않는다)");
	}

	// --- 2. 영상: 4건 · type 정규화 3변형이 같은 본문 -----------------------------------------------

	@Test
	void videoIsTheFallbackForVideoOmittedAndUnknownTypeAlike() {
		String expected = expectedVideoBody();

		Wire.Response video = search("q=" + QUERY + "&type=video");
		Wire.Response omitted = search("q=" + QUERY);
		Wire.Response unknown = search("q=" + QUERY + "&type=audio");

		for (Wire.Response response : List.of(video, omitted, unknown)) {
			assertEquals(200, response.status());
			assertEquals(JSON_CONTENT_TYPE, response.line("content-type"));
			assertEquals(expected, response.body(),
					"type 누락·이상값은 video와 같은 결과다(정본은 type === 'image' 엄격 비교다)");
		}
	}

	// --- 3. 결정성: 같은 질의 2회는 완전히 동일 -----------------------------------------------------

	@Test
	void theSameQueryTwiceGivesAByteIdenticalBody() {
		Wire.Response first = search("q=" + QUERY + "&type=image");
		Wire.Response second = search("q=" + QUERY + "&type=image");

		assertEquals(first.body(), second.body(), "외부 호출이 없으므로 결과는 질의만의 함수다");
	}

	// --- 4. 응답 키는 정확히 3종이고 demo 플래그가 없다 ---------------------------------------------

	@Test
	void theEnvelopeHasExactlyThreeKeysInNodeOrderAndNoDemoFlag() {
		Wire.Response response = search("q=" + QUERY + "&type=image");

		assertTrue(response.body().startsWith("{\"ok\":true,\"items\":["),
				"봉투는 ok → items 순서다: " + response.body());
		assertTrue(response.body().endsWith("],\"error\":false}"), "마지막 키는 error다");
		assertFalse(response.body().contains("\"demo\""),
				"서비스의 demo 플래그가 응답에 실렸다 — 라우트가 3키만 재조립해야 한다");
	}

	// --- 5. 반복 쿼리 키는 값 리스트 그대로 넘어간다 ------------------------------------------------

	/**
	 * express(qs)는 반복 키를 <b>배열</b>로 준다. {@code type}은 정본이 {@code === 'image'} 엄격 비교라
	 * 배열이면 <b>원소가 image 하나여도 video</b>이고, {@code q}는 콤마 결합 문자열이 시드가 된다.
	 * 첫 값으로 접으면({@code getParameter}의 기본 동작) 같은 URL에 두 서버가 다른 본문을 준다 —
	 * 계약이 반복 키를 보내지 않으므로 이 축의 방어선은 여기와 {@code MediaSearchServiceTest}뿐이다.
	 */
	@Test
	void repeatedQueryKeysKeepTheirListSemantics() {
		Wire.Response repeatedType = search("q=" + QUERY + "&type=image&type=video");
		assertEquals(expectedVideoBody(), repeatedType.body(),
				"?type=image&type=video는 배열이라 image가 아니다(첫 값으로 접으면 이미지가 나온다)");

		Wire.Response repeatedQuery = search("q=a&q=b&type=image");
		assertTrue(repeatedQuery.body().contains("\"a,b 이미지 1 (데모)\""),
				"?q=a&q=b의 시드는 콤마 결합 문자열이다: " + repeatedQuery.body());
	}

	// --- 6. 미인증 401 ------------------------------------------------------------------------------

	@Test
	void withoutASessionItIs401() {
		Wire.Response response = Wire.send(this.port, "GET", "/api/media/search?q=" + QUERY + "&type=image");

		assertEquals(401, response.status());
		assertEquals("{\"ok\":false,\"reason\":\"unauthenticated\"}", response.body());
		assertEquals(JSON_CONTENT_TYPE, response.line("content-type"));
	}

	/** 쿼리 토큰은 인증 수단이 아니다 — {@code ?session=} 폴백이 부활하면 여기서 200이 된다. */
	@Test
	void aTokenInTheQueryStringIsNotASession() {
		Wire.Response response = Wire.send(this.port, "GET",
				"/api/media/search?q=" + QUERY + "&session=" + token());

		assertEquals(401, response.status(), "쿼리의 토큰으로 인증되면 안 된다");
	}

	// --- 도구 --------------------------------------------------------------------------------------

	private Wire.Response search(String query) {
		return Wire.send(this.port, "GET", "/api/media/search?" + query,
				Map.of("x-session-id", token()), null);
	}

	private String token() {
		return this.sessions.createSession("media-r");
	}

	private static String expectedImageBody() {
		StringBuilder body = new StringBuilder("{\"ok\":true,\"items\":[");
		for (int i = 0; i < 6; i++) {
			if (i > 0) {
				body.append(',');
			}
			body.append("{\"title\":\"").append(QUERY).append(" 이미지 ").append(i + 1).append(" (데모)\",")
					.append("\"link\":\"https://picsum.photos/seed/").append(QUERY).append('-').append(i)
					.append("/320/200\"}");
		}
		return body.append("],\"error\":false}").toString();
	}

	private static String expectedVideoBody() {
		StringBuilder body = new StringBuilder("{\"ok\":true,\"items\":[");
		for (int i = 0; i < VIDEO_IDS.size(); i++) {
			if (i > 0) {
				body.append(',');
			}
			String id = VIDEO_IDS.get(i);
			body.append("{\"title\":\"").append(QUERY).append(" 관련 영상 ").append(i + 1).append(" (데모)\",")
					.append("\"videoId\":\"").append(id).append("\",")
					.append("\"url\":\"https://www.youtube.com/watch?v=").append(id).append("\"}");
		}
		return body.append("],\"error\":false}").toString();
	}

	private void ensureUser(String userId, String role) {
		Map<String, Object> dto = new LinkedHashMap<>();
		dto.put("userId", userId);
		dto.put("name", userId);
		dto.put("role", role);
		dto.put("password", "media-wire-pw");
		try {
			this.users.create(dto);
		}
		catch (RuntimeException ignored) {
			// 이미 있다 — 픽스처는 멱등이다.
		}
	}

}
