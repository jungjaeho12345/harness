package harness.news.web;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import harness.news.testsupport.MutableClock;
import harness.news.testsupport.TempNewsDb;
import harness.news.testsupport.Wire;
import java.nio.file.Path;
import java.time.Clock;
import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.Map;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.context.TestConfiguration;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Primary;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;

/**
 * 로그인 IP 레이트리밋의 <b>와이어</b> 계약 — 15분 / 10회, 11번째 요청이 429.
 *
 * <h2>기준값은 Node 실측이다(2026-08-20, 원시 소켓 프로브)</h2>
 * <pre>
 * HTTP/1.1 429 Too Many Requests
 * RateLimit-Policy: 10;w=900
 * RateLimit-Limit: 10
 * Content-Type: text/html; charset=utf-8
 * Content-Length: 42
 *
 * Too many requests, please try again later.
 * </pre>
 * 401은 10번째 요청까지 나오고 <b>11번째</b>가 429다. 본문은 JSON이 <b>아니다</b> — "모든 거부는
 * {@code {ok:false, reason}}"의 예외 2건 중 하나이며(다른 하나는 미정의 경로 404) 그 예외 자체가 계약이다.
 *
 * <h2>왜 시계를 갈아끼우는가</h2>
 * 카운터는 프로세스 로컬 in-memory이고 이 클래스의 테스트들은 <b>같은 컨텍스트·같은 포트·같은 클라이언트
 * IP</b>를 공유한다 → 테스트마다 예산이 이어지면 실행 순서가 판정을 바꾼다. {@code @BeforeEach}가 창을
 * 통째로 넘겨 예산을 리셋하므로 각 테스트가 독립적이고, 그 리셋 자체가 "창이 지나면 다시 통과한다"는
 * 계약의 실증이기도 하다(decisions (14) — 프로덕션 코드는 주입된 {@link Clock}만 읽는다).
 *
 * <p>한도·창 크기는 <b>여기서 리터럴로</b> 적는다(프로덕션 상수를 참조하지 않는다) — 상수를 참조하면
 * 한도를 바꾸는 변이가 테스트를 함께 따라와서 아무것도 잡지 못한다.
 */
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
class LoginRateLimitWireTest {

	/** 계약값 — 근거: {@code server/index.js} 609~614행 {@code loginLimiter { windowMs: 15분, limit: 10 }}. */
	private static final int LIMIT = 10;

	private static final long WINDOW_MS = 15L * 60L * 1000L;

	/** 관측 상한 — 429가 없어도 무한 반복하지 않는다(계약 케이스의 RATE_LIMIT_PROBE_CAP과 같은 규율). */
	private static final int PROBE_CAP = 20;

	private static final Path DATA_DIR = TempNewsDb.newDataDir("login-rate-limit-wire");

	private static final MutableClock CLOCK = new MutableClock(Instant.parse("2026-08-20T00:00:00Z").toEpochMilli());

	@TestConfiguration
	static class MutableClockConfig {

		@Bean
		@Primary
		Clock mutableClock() {
			return CLOCK;
		}

	}

	@DynamicPropertySource
	static void dataDir(DynamicPropertyRegistry registry) {
		registry.add("app.data-dir", () -> DATA_DIR.toAbsolutePath().toString());
	}

	@Value("${local.server.port}")
	private int port;

	/** 창을 통째로 넘겨 예산을 리셋한다 — 테스트 간 독립성의 전제다. */
	@BeforeEach
	void freshWindow() {
		CLOCK.advance(WINDOW_MS + 1);
	}

	/** 존재하지 않는 계정으로만 친다 — 계정 잠금 카운터(423 축)를 건드리지 않는다(DB 쓰기 0). */
	private Wire.Response login() {
		return login(Map.of());
	}

	private Wire.Response login(Map<String, String> headers) {
		return Wire.json(this.port, "POST", "/api/login", headers,
				"{\"userId\":\"no-such-user-rate-limit\",\"password\":\"nope\"}");
	}

	@Test
	void requestsInsideTheWindowAreHandledByTheRoute() {
		for (int i = 1; i <= LIMIT; i++) {
			Wire.Response response = login();

			assertEquals(401, response.status(), i + "번째 요청은 한도 안이라 라우트가 처리해야 한다");
			assertTrue(response.body().contains("\"reason\":\"invalid-credentials\""),
					i + "번째 응답 본문: " + response.body());
		}
	}

	@Test
	void theRequestOverTheLimitIs429WithANonJsonHtmlBody() {
		for (int i = 1; i <= LIMIT; i++) {
			login();
		}

		Wire.Response limited = login();

		assertEquals(429, limited.status());
		assertEquals("Content-Type: text/html; charset=utf-8", limited.line("content-type"),
				"Node 실측과 바이트 동일해야 한다(리포트 diff는 이 문자열을 정확 비교한다)");
		assertEquals("10", limited.value("ratelimit-limit"), "계약 케이스가 이 값을 '10'으로 단언한다");
		assertFalse(limited.body().trim().startsWith("{"),
				"429 본문이 JSON이면 계약 케이스의 res.json === undefined 단언이 깨진다: " + limited.body());
		assertFalse(limited.body().contains("\"reason\""), "429에는 사유 토큰이 없다: " + limited.body());
	}

	@Test
	void the429ArrivesExactlyOnRequestLimitPlusOne() {
		int rejectedAt = 0;
		for (int attempt = 1; attempt <= PROBE_CAP && rejectedAt == 0; attempt++) {
			if (login().status() == 429) {
				rejectedAt = attempt;
			}
		}

		assertEquals(LIMIT + 1, rejectedAt, "창 안에서 " + LIMIT + "회까지는 라우트가 처리하고 그 다음이 거부다");
	}

	@Test
	void theBudgetIsRestoredAfterTheWindowElapses() {
		for (int i = 1; i <= LIMIT; i++) {
			login();
		}
		assertEquals(429, login().status(), "선행 조건: 한도를 넘긴 상태여야 한다");

		CLOCK.advance(WINDOW_MS);

		assertEquals(401, login().status(), "창이 지나면 예산이 복구돼 라우트가 다시 처리한다");
	}

	@Test
	void forwardedHeadersCannotBuyAFreshBudget() {
		for (int i = 1; i <= LIMIT; i++) {
			Map<String, String> spoofed = new LinkedHashMap<>();
			spoofed.put("X-Forwarded-For", "10.9.8." + i);
			spoofed.put("X-Real-IP", "10.9.8." + i);

			assertNotEquals(429, login(spoofed).status(), i + "번째 요청은 아직 한도 안이다");
		}

		Map<String, String> spoofed = new LinkedHashMap<>();
		spoofed.put("X-Forwarded-For", "10.9.8.99");
		spoofed.put("X-Real-IP", "10.9.8.99");

		assertEquals(429, login(spoofed).status(),
				"클라이언트 식별에 X-Forwarded-For/X-Real-IP를 쓰면 헤더 한 줄로 한도가 무한 우회된다");
	}

	@Test
	void aTrailingSlashDoesNotBuyAFreshBudget() {
		for (int i = 1; i <= LIMIT; i++) {
			login();
		}

		Wire.Response viaTrailingSlash = Wire.json(this.port, "POST", "/api/login/", Map.of(),
				"{\"userId\":\"no-such-user-rate-limit\",\"password\":\"nope\"}");

		assertEquals(429, viaTrailingSlash.status(),
				"경로 정규화를 빠뜨리면 슬래시 한 개로 예산이 새로 생긴다(express는 두 경로를 같은 라우트로 본다)");
	}

	/**
	 * 퍼센트 인코딩 우회 — {@code /api/lo%67in}은 <b>Spring 디스패처가 로그인 핸들러로 라우팅한다</b>
	 * (PathPatternParser가 세그먼트를 디코딩해 매칭한다. express는 원문으로 매칭해 404다 — 이 차이가
	 * 이식 과정에서 생긴 새 표면이다). 필터가 원문만 보면 인코딩 한 글자로 한도가 무한 우회된다.
	 */
	@Test
	void percentEncodedPathsCannotBuyAFreshBudget() {
		for (int i = 1; i <= LIMIT; i++) {
			login();
		}

		Wire.Response viaEncoding = Wire.json(this.port, "POST", "/api/lo%67in", Map.of(),
				"{\"userId\":\"no-such-user-rate-limit\",\"password\":\"nope\"}");

		assertEquals(429, viaEncoding.status(),
				"컨테이너가 디코딩해 라우팅하는 경로는 레이트리밋도 같은 라우트로 봐야 한다");
	}

	/**
	 * 경로 파라미터 우회 — {@code /api/login;x=1}은 <b>Spring 디스패처가 로그인 핸들러로 라우팅한다</b>
	 * ({@code PathContainer}가 세그먼트에서 {@code ;name=value}를 떼어내고 매칭한다. express는 원문 매칭이라
	 * 404다). 필터가 원문만 보면 세미콜론 한 글자로 한도가 무한 우회된다 —
	 * 2026-08-20 실측: {@code ;x=1}로 12회를 쳐도 전건 401이었고 429가 오지 않았다.
	 */
	@Test
	void pathParametersCannotBuyAFreshBudget() {
		for (int i = 1; i <= LIMIT; i++) {
			login();
		}

		Wire.Response viaPathParameter = Wire.json(this.port, "POST", "/api/login;x=1", Map.of(),
				"{\"userId\":\"no-such-user-rate-limit\",\"password\":\"nope\"}");

		assertEquals(429, viaPathParameter.status(),
				"컨테이너가 파라미터를 떼어내고 라우팅하는 경로는 레이트리밋도 같은 라우트로 봐야 한다");
	}

	@Test
	void requestsWithPathParametersConsumeTheSameIpBudget() {
		// 반대 방향 — 우회 경로로 친 요청이 예산을 <b>소모</b>해야 한다. 소모하지 않으면 그 표면으로
		// 계정 열거·미존재 계정 탐침을 무한히 할 수 있다(계정 잠금 5회는 존재하는 계정에만 걸린다).
		for (int i = 1; i <= LIMIT; i++) {
			Wire.Response response = Wire.json(this.port, "POST", "/api/login;x=1", Map.of(),
					"{\"userId\":\"no-such-user-rate-limit\",\"password\":\"nope\"}");

			assertNotEquals(429, response.status(), i + "번째 요청은 아직 한도 안이다");
		}

		assertEquals(429, login().status(), "경로 파라미터로 친 요청이 IP 예산을 소모하지 않으면 한도가 무의미하다");
	}

	@Test
	void otherRoutesAreNotRateLimited() {
		for (int i = 1; i <= PROBE_CAP; i++) {
			Wire.Response response = Wire.send(this.port, "GET", "/api/session");

			assertEquals(401, response.status(),
					i + "번째 /api/session이 429다 — 레이트리밋을 전역에 걸면 계약 스위트가 픽스처 생성 중 무너진다");
		}
	}

	@Test
	void loginRateLimitDoesNotConsumeTheBudgetOfOtherRoutes() {
		for (int i = 1; i <= PROBE_CAP; i++) {
			Wire.send(this.port, "GET", "/api/session");
		}

		assertEquals(401, login().status(), "다른 라우트 호출은 로그인 예산을 쓰지 않는다");
	}

}
