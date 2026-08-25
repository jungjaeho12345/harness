package harness.news.service;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
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
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
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

	private HttpServer server;

	private String base;

	private final Map<String, AtomicInteger> hits = new ConcurrentHashMap<>();

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

		this.server.start();
		this.base = "http://127.0.0.1:" + this.server.getAddress().getPort();
		this.fetcher = new HttpApiSourceFetcher();
	}

	@AfterEach
	void stopServer() {
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
