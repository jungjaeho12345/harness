package harness.news.service;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import harness.news.service.ApiSourceFetcher.FetchResult;
import java.io.IOException;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/**
 * 수집 pull의 아웃바운드 어댑터 — 이 서버에서 <b>네트워크 호출이 허용된 유일한 파일</b>의 동작 계약
 * (ADR-008 정적 게이트의 예외 2개 중 하나).
 *
 * <p>외부 의존 0: JDK 내장 {@code com.sun.net.httpserver}를 127.0.0.1의 임의 포트에 띄워 실제 왕복을
 * 관측한다(새 Maven 의존성 없음 · egress 0 — 나가는 주소는 loopback뿐이다. 계약 케이스
 * {@code collection.contract.js}의 {@code assertNoEgress}와 같은 규율이다).
 *
 * <p><b>기대값은 Node {@code fetch} 실측이다</b>(2026-08-25, 리포 밖 스크래치패드에서 같은 형태의 로컬
 * 서버에 global fetch를 걸어 측정). 측정 결과와 이 테스트의 대응:
 * <ul>
 * <li>{@code Content-Type: text/plain; charset=ISO-8859-1}로 <b>잘못 선언된</b> UTF-8 본문 →
 * Node {@code res.text()}는 <b>선언을 무시하고 UTF-8로 판독</b>했다(한글 원문 일치). 그래서 Java도
 * {@code ofString(UTF_8)}이어야 한다. <b>계획서의 "charset 없는 Content-Type이면 {@code ofString()}이
 * red"는 실측과 다르다</b> — JDK {@code ofString()}은 charset이 <b>없을 때만</b> UTF-8로 접고, 선언이
 * 있으면 그것을 따른다. charset 없는 응답으로는 두 판이 같은 값을 내 변이가 잡히지 않는다. 그래서
 * <b>잘못 선언된</b> 응답을 쓴다({@link #aMislabeledCharsetIsIgnoredBecauseTheBodyIsAlwaysReadAsUtf8}).</li>
 * <li>302 → Node fetch는 <b>따라가서</b> 200 {@code "followed"}를 받았다. Java는 {@code Redirect.NEVER}라
 * {@code ok=false}다 — <b>의도된 divergence</b>(등록된 endpoint 밖으로 요청이 새지 않는 안전 방향).
 * 계약은 리다이렉트 소스를 등록하지 않아 이 축을 관측하지 않는다.</li>
 * <li>404 → {@code ok=false}인데 본문({@code "nope-body"})은 읽혔다. Java도 본문을 담아 돌려준다.</li>
 * <li>{@code "not a url"}·{@code ""}·{@code file:///…}·연결 거부 → Node는 전부 {@code TypeError}를
 * 던졌고 서비스의 {@code catch}가 {@code fetch-failed}로 접었다. Java 어댑터는 <b>던지지 않고</b>
 * {@code ok=false}로 접는다 — 서비스가 보는 결과는 같다.</li>
 * </ul>
 *
 * <p>정적 게이트가 보지 못하는 축은 여기서 <b>행동으로</b> 잠근다: 재시도 0(서버가 요청 횟수를 센다) ·
 * 리다이렉트 미추종(대상 핸들러 히트 0) · {@code file:} 스킴 차단(파일 내용이 본문에 새지 않는다).
 */
class HttpApiSourceFetcherTest {

	/** 한글 + 가나 — ISO-8859-1로 판독하면 반드시 깨진다(변이 감지용). */
	private static final String KOREAN = "한글 본문 テスト";

	/** 아무도 듣지 않는 loopback 포트 — 계약 케이스의 {@code DEAD_ENDPOINT}와 같은 값이다. */
	private static final String DEAD_ENDPOINT = "http://127.0.0.1:1/";

	/** 상한 경계 테스트가 쓰는 작은 본문 상한 — 프로덕션 값(16 MiB)을 기다리지 않으려고 주입한다. */
	private static final long TEST_CAP = 1024;

	private HttpServer server;

	private String base;

	private final Map<String, AtomicInteger> hits = new ConcurrentHashMap<>();

	/** {@code /silent} 핸들러를 붙잡아 두는 빗장 — 테스트가 끝나면 풀어 준다(핸들러가 잠들지 않는다). */
	private final CountDownLatch release = new CountDownLatch(1);

	private HttpApiSourceFetcher fetcher;

	@BeforeEach
	void startServer() throws IOException {
		this.server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
		this.server.setExecutor(null); // 디스패처 스레드에서 직접 처리 — 스레드풀을 만들지 않는다.

		handle("/ok", (exchange) -> respond(exchange, 200, "application/json", "{\"title\":\"수집\"}"));
		handle("/mislabeled", (exchange) -> respond(exchange, 200, "text/plain; charset=ISO-8859-1", KOREAN));
		handle("/nocharset", (exchange) -> respond(exchange, 200, "application/json", KOREAN));
		handle("/notfound", (exchange) -> respond(exchange, 404, "text/plain", "nope-body"));
		handle("/error", (exchange) -> respond(exchange, 500, "text/plain", "boom"));
		handle("/redirect", (exchange) -> {
			exchange.getResponseHeaders().set("Location", this.base + "/target");
			respond(exchange, 302, "text/plain", "go");
		});
		handle("/target", (exchange) -> respond(exchange, 200, "text/plain", "followed"));
		handle("/auth", (exchange) -> {
			List<String> seen = exchange.getRequestHeaders().get("Authorization");
			respond(exchange, 200, "text/plain", (seen == null) ? "none" : String.join("|", seen));
		});
		// 응답을 주지 않는 endpoint — 요청은 받아 두고 헤더를 보내지 않는다(빗장이 풀릴 때까지).
		handle("/silent", (exchange) -> {
			try {
				this.release.await(30, TimeUnit.SECONDS);
			}
			catch (InterruptedException ex) {
				Thread.currentThread().interrupt();
				return;
			}
			respond(exchange, 200, "text/plain", "late");
		});
		handle("/cap-exact", (exchange) -> respond(exchange, 200, "text/plain", "A".repeat((int) TEST_CAP)));
		handle("/cap-over", (exchange) -> respond(exchange, 200, "text/plain", "A".repeat((int) TEST_CAP + 1)));
		handle("/cap-over-404", (exchange) -> respond(exchange, 404, "text/plain", "A".repeat((int) TEST_CAP + 1)));

		this.server.start();
		this.base = "http://127.0.0.1:" + this.server.getAddress().getPort();
		this.fetcher = new HttpApiSourceFetcher();
	}

	@AfterEach
	void stopServer() {
		this.release.countDown(); // 붙잡아 둔 핸들러를 먼저 풀어 준다 — 잔존 스레드 0.
		if (this.server != null) {
			this.server.stop(0); // 잔존 포트·스레드 0.
		}
	}

	// --- 성공 경로 ---

	@Test
	void aTwoHundredResponseComesBackVerbatim() {
		FetchResult result = this.fetcher.fetch(this.base + "/ok", null);

		assertTrue(result.ok(), "2xx는 ok=true다");
		assertEquals("{\"title\":\"수집\"}", result.body(), "본문은 손대지 않고 문자열 그대로 넘긴다(JSON 판독은 서비스 몫)");
		assertEquals(1, hitCount("/ok"), "성공 경로도 요청은 정확히 1회다");
	}

	/**
	 * 인코딩 잠금 — {@code ofString()}(charset 추종)으로 바꾸면 이 테스트가 red다.
	 *
	 * <p>수집 소스가 charset을 <b>틀리게</b> 선언하는 것은 흔한 일이고, Node는 그 선언을 아예 보지 않는다
	 * (실측: 같은 응답에서 한글 원문 일치). 여기서 갈리면 같은 소스가 Node에서는 멀쩡한 제목으로,
	 * Spring에서는 깨진 제목으로 등록된다 — 응답 shape은 같아 계약 diff로도 안 잡히는 종류의 오차다.
	 */
	@Test
	void aMislabeledCharsetIsIgnoredBecauseTheBodyIsAlwaysReadAsUtf8() {
		FetchResult result = this.fetcher.fetch(this.base + "/mislabeled", null);

		assertTrue(result.ok());
		assertEquals(KOREAN, result.body(), "선언된 charset(ISO-8859-1)이 아니라 UTF-8로 읽어야 한다(Node 실측 동형)");
	}

	@Test
	void aResponseWithoutACharsetIsAlsoReadAsUtf8() {
		FetchResult result = this.fetcher.fetch(this.base + "/nocharset", null);

		assertTrue(result.ok());
		assertEquals(KOREAN, result.body());
	}

	@Test
	void anUppercaseSchemeIsStillHttp() {
		FetchResult result = this.fetcher.fetch(this.base.replace("http://", "HTTP://") + "/ok", null);

		assertTrue(result.ok(), "URI 스킴은 대소문자를 가리지 않는다 — 스킴 게이트가 원문 비교면 정상 소스를 막는다");
		assertEquals(1, hitCount("/ok"));
	}

	// --- 실패는 예외가 아니라 ok=false ---

	@Test
	void nonSuccessStatusesAreNotOkButStillCarryTheBody() {
		FetchResult notFound = this.fetcher.fetch(this.base + "/notfound", null);
		FetchResult serverError = this.fetcher.fetch(this.base + "/error", null);

		assertFalse(notFound.ok(), "404는 ok=false다(res.ok는 2xx뿐)");
		assertEquals("nope-body", notFound.body(), "본문은 담아 돌려준다(호출자가 쓰지 않아도 진단 여지를 남긴다)");
		assertFalse(serverError.ok(), "500은 ok=false다");
		assertEquals("boom", serverError.body());
	}

	@Test
	void aRefusedConnectionIsOkFalseNotAnException() {
		FetchResult result = this.fetcher.fetch(DEAD_ENDPOINT, null);

		assertNotNull(result, "어댑터는 결과를 돌려준다 — 던지면 계약의 400이 500이 된다");
		assertFalse(result.ok(), "연결 거부는 fetch-failed의 재료다");
	}

	@Test
	void malformedEndpointsAreOkFalseNotAnException() {
		for (String endpoint : List.of("not a url", "", "//127.0.0.1/x", "http://", "ftp://127.0.0.1/x")) {
			FetchResult result = this.fetcher.fetch(endpoint, null);

			assertNotNull(result, "잘못된 endpoint에도 결과를 돌려준다: " + endpoint);
			assertFalse(result.ok(), "http/https가 아닌 endpoint는 ok=false다: " + endpoint);
		}

		FetchResult nullEndpoint = this.fetcher.fetch(null, null);

		assertNotNull(nullEndpoint, "endpoint가 null이어도 던지지 않는다");
		assertFalse(nullEndpoint.ok());
	}

	/**
	 * {@code file:}·{@code jar:} 스킴은 <b>보내지 않는다</b>. Node {@code fetch}도 그 스킴을 지원하지 않아
	 * {@code TypeError}로 끝난다(실측) — 방어 추가가 아니라 Node 동형이다. 만약 통과시키면 수신 설정에
	 * 로컬 경로를 등록하는 것만으로 <b>서버 파일이 기사 본문으로 등록</b>된다.
	 *
	 * <p><b>이 테스트가 잠그는 것은 계층이 아니라 결과다(2026-08-25 변이 실측).</b> 어댑터의 스킴 게이트를
	 * 통째로 지워도 이 테스트는 green이었다 — {@code HttpRequest.newBuilder(uri)}가 http/https가 아닌 스킴을
	 * {@code IllegalArgumentException}으로 거부하고 어댑터의 {@code catch}가 그것을 {@code ok=false}로
	 * 접기 때문이다. 즉 스킴 게이트는 <b>JDK 빌더와 겹치는 이중 방어</b>이며(우리 게이트가 허용하는 집합이
	 * 빌더가 허용하는 집합보다 넓다), 단독으로는 관측 가능한 축이 아니다. 게이트를 남겨 두는 이유는 의도를
	 * 코드에 적어 두는 것과, 거부가 JDK 구현 세부에만 의존하지 않게 하는 것이다. <b>실제로 변이가 잡히는
	 * 스킴 축은 {@link #anUppercaseSchemeIsStillHttp}</b>(대소문자 정규화를 지우면 red)뿐이다.
	 */
	@Test
	void theFileSchemeCannotBeUsedToReadLocalFiles(@TempDir Path tempDir) throws IOException {
		Path secret = tempDir.resolve("secret.txt");
		Files.writeString(secret, "SECRET-FILE-BODY", StandardCharsets.UTF_8);

		FetchResult result = this.fetcher.fetch(secret.toUri().toString(), null);

		assertFalse(result.ok(), "file: 스킴은 ok=false다");
		assertFalse(String.valueOf(result.body()).contains("SECRET-FILE-BODY"), "로컬 파일 내용이 본문으로 새면 안 된다");
	}

	// --- 헤더 ---

	@Test
	void theApiKeyBecomesExactlyOneBearerHeader() {
		FetchResult result = this.fetcher.fetch(this.base + "/auth", "k-123");

		assertTrue(result.ok());
		assertEquals("Bearer k-123", result.body(), "Authorization 헤더는 정확히 하나이고 값은 Bearer <apiKey>다");
	}

	@Test
	void noApiKeyMeansNoAuthorizationHeaderAtAll() {
		assertEquals("none", this.fetcher.fetch(this.base + "/auth", null).body(), "키가 없으면 헤더도 없다");
		assertEquals("none", this.fetcher.fetch(this.base + "/auth", "").body(),
				"빈 문자열 키는 값이 없는 것과 같다(JS truthy — 서비스가 이미 걸러도 어댑터가 다시 접는다)");
	}

	@Test
	void anApiKeyWithIllegalHeaderCharactersIsRejectedWithoutSendingAnything() {
		FetchResult result = this.fetcher.fetch(this.base + "/auth", "bad\nkey: injected");

		assertFalse(result.ok(), "헤더 값으로 쓸 수 없는 키는 ok=false다(예외가 새면 400이 500이 된다)");
		assertEquals(0, hitCount("/auth"), "요청 자체가 나가지 않는다 — 헤더 주입 시도는 왕복 없이 끝난다");
	}

	// --- ADR-008 행동 단언(정적 스캔이 못 보는 축) ---

	/**
	 * 재시도 0(ADR-008 (6)) — 실패해도 <b>한 번</b>만 간다. 계약은 {@code pull-fetch-failed}의 사유만
	 * 관측하므로, 몰래 두 번 시도해도 응답 shape은 같다. 그래서 서버가 직접 센다.
	 */
	@Test
	void aFailedFetchIsTriedExactlyOnce() {
		FetchResult result = this.fetcher.fetch(this.base + "/error", null);

		assertFalse(result.ok());
		assertEquals(1, hitCount("/error"), "실패해도 재시도·백오프는 없다(ADR-008 (6))");
	}

	/**
	 * 리다이렉트 미추종 — 이 테스트가 곧 divergence의 기록이다(Node fetch는 기본 follow라 200을 받는다).
	 * 따라가게 만들면 등록된 endpoint 밖으로 요청이 새는 표면이 열린다.
	 */
	@Test
	void redirectsAreNotFollowed() {
		FetchResult result = this.fetcher.fetch(this.base + "/redirect", null);

		assertFalse(result.ok(), "302는 2xx가 아니므로 ok=false다");
		assertEquals(1, hitCount("/redirect"));
		assertEquals(0, hitCount("/target"), "리다이렉트 대상으로 요청이 새면 안 된다(Redirect.NEVER)");
	}

	// --- 요청 단계 상한 · 본문 바이트 상한(2026-08-25 ⑤ 코드리뷰 반려 폐색) ---

	/**
	 * <b>응답을 주지 않는 endpoint</b>는 요청 단계 타임아웃으로 접힌다 — 이것이 <b>의도된 divergence</b>다
	 * (Node {@code fetch}에는 요청 타임아웃이 없어 영원히 기다린다).
	 *
	 * <p>왜 갈라야 하는가: Spring은 요청 하나가 Tomcat 워커 <b>하나</b>를 점유한다(기본 200). 응답을 주지
	 * 않는 소스 하나 + 반복 pull이면 워커가 고갈돼 <b>29 라우트 전체</b>가 응답하지 못한다. Node는 단일
	 * 이벤트 루프라 같은 상황에서도 다른 요청을 계속 처리한다 — 같은 코드가 다른 결과를 내는 자리다.
	 *
	 * <p>접히는 모양은 <b>기존 실패 경로와 같다</b>({@code ok=false} · 본문 없음). 서비스는 이것을
	 * {@code fetch-failed}로 옮긴다 — 새 사유 토큰을 만들지 않는다(전역 사유 표를 넓히면 phase 70이
	 * 동결한 400 계약이 깨진다).
	 */
	@Test
	void anEndpointThatNeverAnswersIsFoldedIntoOkFalseInsteadOfHoldingTheWorker() {
		HttpApiSourceFetcher impatient = new HttpApiSourceFetcher(Duration.ofMillis(300), TEST_CAP);
		long startedAt = System.nanoTime();

		FetchResult result = impatient.fetch(this.base + "/silent", null);

		long elapsedMs = (System.nanoTime() - startedAt) / 1_000_000;
		assertFalse(result.ok(), "응답 없는 endpoint는 ok=false다(예외가 새면 계약의 400이 500이 된다)");
		assertNull(result.body(), "실패 shape은 연결 거부와 같다 — 본문 없음");
		assertTrue(elapsedMs < 10_000, "요청 단계 상한이 없으면 빗장이 풀릴 때까지 붙잡힌다: " + elapsedMs + "ms");
		assertEquals(1, hitCount("/silent"), "타임아웃 뒤에도 다시 시도하지 않는다(ADR-008 (6) — 재시도 0)");
	}

	/**
	 * 상한을 넘는 본문은 <b>같은 shape</b>으로 접힌다 — 새 사유도, 잘린 본문도 아니다.
	 *
	 * <p>상한이 없으면 거대 응답이 힙을 통째로 먹어 {@code OutOfMemoryError}가 난다. 그것은
	 * {@code IOException}도 {@code RuntimeException}도 아니라 어댑터의 {@code catch}가 <b>잡지 못하고</b>
	 * JVM 전체가 죽는다(Node는 V8 문자열 상한 {@code RangeError}가 {@code fetch-failed}로 우아하게 접힌다 —
	 * 이 상한은 그 동작을 되돌려 놓는 것이다).
	 *
	 * <p>잘라서 돌려주지 <b>않는</b> 이유: 잘린 JSON은 파서에서 다른 제목·본문이 되어 <b>조용히 틀린 기사</b>가
	 * 등록된다. 실패가 낫다.
	 */
	@Test
	void aBodyOverTheCapIsFoldedIntoTheSameFailureShape() {
		HttpApiSourceFetcher capped = new HttpApiSourceFetcher(Duration.ofSeconds(30), TEST_CAP);

		FetchResult over = capped.fetch(this.base + "/cap-over", null);
		FetchResult overOnAnErrorStatus = capped.fetch(this.base + "/cap-over-404", null);

		assertFalse(over.ok(), "상한 초과 본문은 ok=false다");
		assertNull(over.body(), "잘린 본문을 돌려주면 파서가 조용히 다른 기사를 만든다");
		assertFalse(overOnAnErrorStatus.ok(), "실패 상태코드의 거대 본문도 같은 자리에서 접힌다");
		assertNull(overOnAnErrorStatus.body());
		assertEquals(1, hitCount("/cap-over"), "상한 초과에도 재시도는 없다");
	}

	/** 상한 <b>이하</b>는 영향이 없다 — 경계값(정확히 상한)까지 그대로 읽힌다. */
	@Test
	void aBodyExactlyAtTheCapIsStillReadInFull() {
		HttpApiSourceFetcher capped = new HttpApiSourceFetcher(Duration.ofSeconds(30), TEST_CAP);

		FetchResult exact = capped.fetch(this.base + "/cap-exact", null);

		assertTrue(exact.ok(), "상한과 같은 크기는 초과가 아니다");
		assertEquals(TEST_CAP, exact.body().length(), "본문이 한 글자도 잘리지 않는다");
	}

	/**
	 * <b>프로덕션 기본값은 정상 응답을 죽이지 않는다</b> — 기본 생성자로 만든 어댑터가 테스트 상한을
	 * 훌쩍 넘는 본문(1 KiB 초과)과 한글 본문을 그대로 읽는다. 상한을 너무 낮게 잡는 변이가 여기서 red다.
	 */
	@Test
	void theProductionDefaultsDoNotAffectNormalResponses() {
		assertTrue(this.fetcher.fetch(this.base + "/cap-over", null).ok(),
				"프로덕션 상한(16 MiB)은 1 KiB짜리 본문을 막지 않는다");
		assertEquals(TEST_CAP + 1, this.fetcher.fetch(this.base + "/cap-over", null).body().length(),
				"테스트 상한을 넘는 본문도 프로덕션에서는 한 글자도 잘리지 않는다");
		assertEquals(KOREAN, this.fetcher.fetch(this.base + "/mislabeled", null).body(),
				"멀티바이트 본문도 상한 도입 뒤에 그대로다(바이트 수와 글자 수를 혼동하면 여기서 갈린다)");
	}

	/** 같은 인스턴스를 반복해 써도 동작이 변하지 않는다(HttpClient는 필드 하나로 재사용한다). */
	@Test
	void theAdapterIsReusableAcrossCalls() {
		for (int i = 0; i < 3; i++) {
			assertTrue(this.fetcher.fetch(this.base + "/ok", null).ok(), "반복 호출 " + i);
		}

		assertEquals(3, hitCount("/ok"));
	}

	// --- 테스트 서버 유틸 ---

	private void handle(String path, ExchangeHandler handler) {
		this.hits.put(path, new AtomicInteger());
		this.server.createContext(path, (exchange) -> {
			this.hits.get(path).incrementAndGet();
			try (exchange) {
				handler.handle(exchange);
			}
		});
	}

	private static void respond(HttpExchange exchange, int status, String contentType, String body)
			throws IOException {
		byte[] bytes = body.getBytes(StandardCharsets.UTF_8); // 선언된 charset과 무관하게 언제나 UTF-8 바이트다.
		exchange.getResponseHeaders().set("Content-Type", contentType);
		exchange.sendResponseHeaders(status, bytes.length);
		try (OutputStream out = exchange.getResponseBody()) {
			out.write(bytes);
		}
	}

	private int hitCount(String path) {
		AtomicInteger counter = this.hits.get(path);
		return (counter == null) ? 0 : counter.get();
	}

	@FunctionalInterface
	private interface ExchangeHandler {

		void handle(HttpExchange exchange) throws IOException;

	}

}
