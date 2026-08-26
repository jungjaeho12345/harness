package harness.news.controller;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import harness.news.service.SessionGuard;
import harness.news.service.UserService;
import harness.news.testsupport.TempNewsDb;
import harness.news.testsupport.Wire;
import java.nio.file.InvalidPathException;
import java.nio.file.Path;
import java.util.LinkedHashMap;
import java.util.Map;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;

/**
 * {@code DIST_SPOOL_DIR}에 <b>파일시스템이 파싱조차 못 하는 값</b>이 들어온 서버 — <b>배부만</b> 꺼지고
 * 나머지 라우트는 전부 산다(2026-08-26 ⑤ 코드리뷰 반려 폐색).
 *
 * <p><b>왜 이 테스트가 필요한가</b>: {@code Path.of}는 {@link InvalidPathException}(unchecked)을 던진다.
 * 그 예외가 {@code DistributionConfig.spoolWriter} {@code @Bean} 안에서 새면 <b>컨텍스트 기동 자체가
 * 실패</b>하고, 그 순간 구현된 32 라우트가 전멸한다 — {@code .env}에 따옴표 한 쌍이 들어간
 * ({@code DIST_SPOOL_DIR="C:\spool"}) 배포가 <b>로그인부터</b> 죽는다. Node는 경로를 파싱하지 않으므로
 * 같은 값에서 서버가 정상 기동하고 배부만 {@code spool-write-failed}가 된다. 여기서 잠그는 것은 그
 * 방향이다: <b>배부만 비활성({@code spool-disabled})</b>.
 *
 * <p>판정 지점은 {@code SpoolProperties.rootPath()} <b>하나</b>다 — 이 클래스는 그 판정이 실제 부팅
 * 경로에서 성립하는지만 본다(값의 목록은 {@code SpoolPropertiesTest}가 소유한다).
 *
 * <p>주입값에는 <b>NUL 문자</b>를 쓴다(이스케이프 시퀀스 {@code \0} — 소스에 raw 제어 바이트를 두지
 * 않는다). 윈도우 전용 금칙문자({@code "}·{@code ?}·{@code *})와 달리 NUL은 <b>모든 플랫폼</b>에서
 * {@code Path.of}가 거부하므로 이 게이트가 어디서도 공허해지지 않는다. 그 전제는 첫 테스트가 직접
 * 단언한다.
 */
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT,
		properties = "app.distribution.spool-dir=" + InvalidSpoolPathWireTest.UNPARSABLE_SPOOL_DIR)
class InvalidSpoolPathWireTest {

	/** 어떤 플랫폼에서도 {@code Path.of}가 거부하는 값(NUL 포함). */
	static final String UNPARSABLE_SPOOL_DIR = "C:/spool/na\0me";

	private static final Path DATA_DIR = TempNewsDb.newDataDir("invalid-spool-path-wire");

	private static final String PASSWORD = "invalid-spool-pw";

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

	// --- 0. 전제(비공허성) — 이 값은 실제로 파싱 불가다 ---------------------------------------------

	@Test
	void theInjectedValueIsReallyUnparsableOnThisPlatform() {
		assertThrows(InvalidPathException.class, () -> Path.of(UNPARSABLE_SPOOL_DIR),
				"이 값이 파싱된다면 아래 두 단언은 아무것도 검사하지 않는다");
	}

	// --- 1. 컨텍스트가 살아 있다 — health와 로그인이 그대로 된다 ------------------------------------

	@Test
	void everyOtherRouteStillAnswersSoTheContextDidNotFailToStart() {
		Wire.Response health = Wire.send(this.port, "GET", "/api/health", Map.of(), null);
		assertEquals(200, health.status(), "잘못된 스풀 경로가 컨텍스트를 죽였다: " + health.body());
		assertEquals("{\"ok\":true}", health.body());

		ensureUser("isp-z", "Z");
		Wire.Response login = Wire.json(this.port, "POST", "/api/login", Map.of(),
				"{\"userId\":\"isp-z\",\"password\":\"" + PASSWORD + "\"}");
		assertEquals(200, login.status(), "배부 설정 오타가 로그인을 죽였다: " + login.body());
		assertTrue(login.body().startsWith("{\"ok\":true,\"sessionId\":\""), login.body());
	}

	// --- 2. 배부만 비활성이다(미설정 서버와 같은 관측) ----------------------------------------------

	@Test
	void onlyDistributionIsDisabledAndTheFailureListStillAnswers200() {
		String token = zToken();

		Wire.Response ticked = Wire.send(this.port, "POST", "/api/distribution/tick",
				Map.of("x-session-id", token), null);
		assertEquals(503, ticked.status(), "파싱 불가 스풀 루트는 미설정과 같다: " + ticked.body());
		assertEquals("{\"ok\":false,\"reason\":\"spool-disabled\"}", ticked.body());

		Wire.Response retried = Wire.json(this.port, "POST", "/api/distribution/retry",
				Map.of("x-session-id", token), "{\"historyId\":999999999}");
		assertEquals(503, retried.status(), retried.body());
		assertEquals("{\"ok\":false,\"reason\":\"spool-disabled\"}", retried.body());

		Wire.Response listed = Wire.send(this.port, "GET", "/api/distribution/failures",
				Map.of("x-session-id", token), null);
		assertEquals(200, listed.status(), "조회는 스풀 설정과 무관하게 결선된다: " + listed.body());
		assertEquals("{\"ok\":true,\"items\":[]}", listed.body());
	}

	// --- 도구 ---------------------------------------------------------------------------------------

	private String zToken() {
		ensureUser("isp-z", "Z");
		return this.sessions.createSession("isp-z");
	}

	private void ensureUser(String userId, String role) {
		Map<String, Object> dto = new LinkedHashMap<>();
		dto.put("userId", userId);
		dto.put("name", userId);
		dto.put("role", role);
		dto.put("password", PASSWORD);
		try {
			this.users.create(dto);
		}
		catch (RuntimeException ignored) {
			// 이미 있다 — 픽스처는 멱등이다.
		}
	}

}
