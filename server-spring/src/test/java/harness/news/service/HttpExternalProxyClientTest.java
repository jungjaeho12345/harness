package harness.news.service;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import harness.news.service.ExternalProxyClient.Result;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.io.PrintStream;
import java.lang.reflect.Constructor;
import java.lang.reflect.Field;
import java.lang.reflect.Method;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/**
 * {@code ADR-014} 서버 보유 키 프록시의 아웃바운드 어댑터 — 이 서버에서 <b>네트워크 호출이 허용된 두
 * 파일 중 두 번째</b>({@code Adr008DisciplineTest} 3군 예외 ②, 첫 번째는 수집 pull의
 * {@code HttpApiSourceFetcher})의 동작 계약이다.
 *
 * <p><b>이 테스트가 유일 방어선이다.</b> 계약 하네스는 API 키 4종을 java 자식 env에서 지우고(자식 env는
 * 허용 목록이라 애초에 키가 도달하지 않는다) 키가 없으면 미디어는 데모 폴백, 번역은 {@code no-key}로
 * 접힌다 — 즉 <b>계약 31관측은 이 파일의 코드를 한 줄도 실행하지 않는다</b>. 여기서 축약하면 그 축은
 * 아무도 보지 않는다(index.json decisions (22)⑩).
 *
 * <p>외부 의존 0: JDK 내장 {@code com.sun.net.httpserver}를 127.0.0.1의 임의 포트에 띄워 실제 왕복을
 * 관측한다(새 Maven 의존성 없음 · egress 0 — 나가는 주소는 loopback뿐이다. 실 Google/YouTube API를
 * 때리는 테스트는 만들지 않는다 — index.json excluded (b)).
 *
 * <h2>기대값은 Node {@code fetch} 실측이다</h2>
 * 2026-08-28, 리포 밖 스크래치패드에서 같은 형태의 로컬 서버에 Node v24.16.0 global fetch를 걸어 측정했다.
 * <ul>
 * <li>{@code fetch(url, {method:'POST'})} → 와이어에 <b>{@code POST} · {@code content-length: 0} ·
 * 본문 0바이트 · {@code content-type} 없음</b>. 그래서 Java도 {@code BodyPublishers.noBody()}다
 * ({@link #aPostGoesOutAsPostWithAnEmptyBodyAndNoHeaders}).</li>
 * <li>{@code Content-Type: text/plain; charset=euc-kr}로 <b>잘못 선언된</b> UTF-8 본문 →
 * {@code res.text()}는 선언을 <b>무시하고</b> UTF-8로 판독했다(한글 원문 일치). 71a가 남긴 사실이 여기서도
 * 그대로다: JDK {@code ofString()}은 charset이 <b>없을 때만</b> UTF-8로 접으므로 charset 없는 응답으로는
 * 두 판이 같은 값을 내 변이가 잡히지 않는다 — <b>잘못 선언된</b> 응답이라야 갈린다.</li>
 * <li>302 → Node fetch는 <b>따라가서</b> 200을 받았다. Java는 {@code Redirect.NEVER}라 {@code ok=false}다 —
 * 71a가 문서화한 것과 같은 <b>의도된 divergence</b>(키가 실린 URL이 리다이렉트 대상으로 새지 않는
 * 안전 방향이며, 여기서는 그 이유가 더 무겁다 — 이 URL에는 <b>서버 보유 키</b>가 들어 있다).</li>
 * <li>{@code file:///…} → {@code TypeError}. Java 어댑터는 던지지 않고 {@code ok=false}로 접는다.</li>
 * </ul>
 *
 * <h2>정적 게이트가 보지 못해 여기서 행동으로 잠그는 축</h2>
 * 재시도 0(서버가 요청 횟수를 센다) · 리다이렉트 미추종 · 요청 단계 상한 · 본문 상한 · UTF-8 고정 판독 ·
 * 예외 미전파 · <b>키 문자열 비유출</b>(반환값 직렬화 전문 · 로그 링 버퍼 전 줄 · 예외 메시지와 원인 체인) ·
 * <b>{@code sendAsync} 부재</b>(2026-08-28 변이 F 실측 — {@code Adr008DisciplineTest}의 비동기 군 패턴에는
 * {@code sendAsync}가 없어 정적 게이트가 그것을 잡지 못한다. {@link #theAdapterSourceHasNoAsyncSendAndNoLogSink}
 * 참조).
 */
class HttpExternalProxyClientTest {

	/** 한글 + 가나 — ISO-8859-1/EUC-KR로 판독하면 반드시 깨진다(변이 감지용). */
	private static final String KOREAN = "미디어 검색 본문 テスト";

	/**
	 * 비유출 단언의 센티넬 — 실제 배선에서 키가 실리는 자리(URL 쿼리)에 그대로 넣는다.
	 * 흔한 문자열이면 우연히 없는 것과 구분되지 않으므로 이 리포 어디에도 없는 형태로 만든다.
	 */
	private static final String SENTINEL_KEY = "SENTINEL-Kv9x7Qb3ZmT0-DO-NOT-LEAK";

	/** 아무도 듣지 않는 loopback 포트 — 71a 테스트의 {@code DEAD_ENDPOINT}와 같은 값이다. */
	private static final String DEAD_ENDPOINT = "http://127.0.0.1:1/";

	/** 상한 경계 테스트가 쓰는 작은 본문 상한 — 프로덕션 값(16 MiB)을 기다리지 않으려고 주입한다. */
	private static final long TEST_CAP = 1024;

	/** 로그 링 버퍼 단언이 쓰는 고정 시각 — 창 경계 계산을 결정적으로 만든다. */
	private static final Instant FIXED_INSTANT = Instant.parse("2026-08-28T12:00:00Z");

	private static final long ONE_DAY_MS = 24L * 60 * 60 * 1000;

	private HttpServer server;

	private String base;

	private final Map<String, AtomicInteger> hits = new ConcurrentHashMap<>();

	/** {@code /echo}가 관측한 요청들 — 메서드·Content-Length·Content-Type·Authorization·본문 바이트 수. */
	private final List<String> echoed = new CopyOnWriteArrayList<>();

	/** {@code /silent} 핸들러를 붙잡아 두는 빗장 — 테스트가 끝나면 풀어 준다(핸들러가 잠들지 않는다). */
	private final CountDownLatch release = new CountDownLatch(1);

	private HttpExternalProxyClient client;

	@BeforeEach
	void startServer() throws IOException {
		this.server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
		this.server.setExecutor(null); // 디스패처 스레드에서 직접 처리 — 스레드풀을 만들지 않는다.

		handle("/ok", (exchange) -> respond(exchange, 200, "application/json", "{\"items\":[]}"));
		handle("/mislabeled", (exchange) -> respond(exchange, 200, "text/plain; charset=euc-kr", KOREAN));
		handle("/nocharset", (exchange) -> respond(exchange, 200, "application/json", KOREAN));
		handle("/notfound", (exchange) -> respond(exchange, 404, "text/plain", "nope-body"));
		handle("/error", (exchange) -> respond(exchange, 500, "text/plain", "boom"));
		handle("/redirect", (exchange) -> {
			exchange.getResponseHeaders().set("Location", this.base + "/target");
			respond(exchange, 302, "text/plain", "go");
		});
		handle("/target", (exchange) -> respond(exchange, 200, "text/plain", "followed"));
		handle("/echo", (exchange) -> {
			this.echoed.add(describe(exchange));
			respond(exchange, 200, "application/json", "{\"data\":{}}");
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

		this.server.start();
		this.base = "http://127.0.0.1:" + this.server.getAddress().getPort();
		this.client = new HttpExternalProxyClient();
	}

	@AfterEach
	void stopServer() {
		this.release.countDown(); // 붙잡아 둔 핸들러를 먼저 풀어 준다 — 잔존 스레드 0.
		if (this.server != null) {
			this.server.stop(0); // 잔존 포트·스레드 0.
		}
	}

	// --- GET 성공 경로 ---

	@Test
	void aTwoHundredGetComesBackVerbatim() {
		Result result = this.client.get(this.base + "/ok?key=" + SENTINEL_KEY);

		assertTrue(result.ok(), "2xx는 ok=true다(Node가 쓰는 것은 res.ok와 본문 둘뿐이다)");
		assertEquals("{\"items\":[]}", result.body(), "본문은 손대지 않고 문자열 그대로 넘긴다(JSON 판독은 서비스 몫)");
		assertEquals(1, hitCount("/ok"), "성공 경로도 요청은 정확히 1회다");
	}

	@Test
	void anUppercaseSchemeIsStillHttp() {
		Result result = this.client.get(this.base.replace("http://", "HTTP://") + "/ok");

		assertTrue(result.ok(), "URI 스킴은 대소문자를 가리지 않는다 — 원문 비교면 정상 URL을 막는다");
		assertEquals(1, hitCount("/ok"));
	}

	// --- POST(번역) 경로 — Node 실측 동형 ---

	/**
	 * 번역은 <b>POST · 본문 없음</b>이다(Node {@code fetchFn(req.url, {method:'POST'})} — 본문 자리가
	 * 아예 없고 파라미터는 전부 URL 쿼리에 있다). 와이어 실측(Node v24.16.0): {@code content-length: 0} ·
	 * 본문 0바이트 · {@code content-type} 헤더 없음.
	 *
	 * <p>GET으로 바꾸면 Google Translate v2가 다른 응답을 준다 — 그리고 그 사실을 계약은 볼 수 없다.
	 */
	@Test
	void aPostGoesOutAsPostWithAnEmptyBodyAndNoHeaders() {
		Result result = this.client.post(this.base + "/echo?key=" + SENTINEL_KEY);

		assertTrue(result.ok());
		assertEquals(1, this.echoed.size(), "요청은 정확히 1회다");
		assertEquals("method=POST body=0 content-length=0 content-type=<none> authorization=<none>",
				this.echoed.get(0), "POST · 본문 없음 · 헤더를 붙이지 않는다(키는 URL에 있다 — Node 실측 동형)");
	}

	@Test
	void aGetGoesOutAsGetWithNoHeaders() {
		Result result = this.client.get(this.base + "/echo?q=x");

		assertTrue(result.ok());
		assertEquals(List.of("method=GET body=0 content-length=<none> content-type=<none> authorization=<none>"),
				this.echoed, "미디어 검색은 헤더 없는 GET이다(Bearer 헤더는 수집 pull 어댑터의 것이고 여기 없다)");
	}

	// --- 실패는 예외가 아니라 ok=false ---

	@Test
	void nonSuccessStatusesAreNotOkButStillCarryTheBody() {
		Result notFound = this.client.get(this.base + "/notfound");
		Result serverError = this.client.post(this.base + "/error");

		assertFalse(notFound.ok(), "404는 ok=false다(res.ok는 2xx뿐)");
		assertEquals("nope-body", notFound.body(), "본문은 담아 돌려준다(호출자가 쓰지 않아도 진단 여지를 남긴다)");
		assertFalse(serverError.ok(), "500은 ok=false다 — 서비스가 그것을 데모 폴백/원문 폴백으로 옮긴다");
		assertEquals("boom", serverError.body());
	}

	@Test
	void aRefusedConnectionIsOkFalseNotAnException() {
		Result get = this.client.get(DEAD_ENDPOINT);
		Result post = this.client.post(DEAD_ENDPOINT);

		assertNotNull(get, "어댑터는 결과를 돌려준다 — 던지면 미디어 200이 500이 된다");
		assertFalse(get.ok());
		assertNull(get.body(), "실패 shape은 본문 없음이다");
		assertFalse(post.ok(), "POST도 같은 자리에서 접힌다");
	}

	@Test
	void malformedUrlsAndNonHttpSchemesAreOkFalseNotAnException() {
		for (String url : List.of("not a url", "", "//127.0.0.1/x", "http://", "ftp://127.0.0.1/x",
				"mailto:a@b.test")) {
			Result get = this.client.get(url);
			Result post = this.client.post(url);

			assertNotNull(get, "잘못된 URL에도 결과를 돌려준다: " + url);
			assertFalse(get.ok(), "http/https가 아닌 URL은 ok=false다: " + url);
			assertFalse(post.ok(), "POST도 같다: " + url);
		}

		assertFalse(this.client.get(null).ok(), "url이 null이어도 던지지 않는다");
		assertFalse(this.client.post(null).ok());
	}

	/**
	 * {@code file:} 스킴은 <b>보내지 않는다</b>(Node {@code fetch}도 {@code TypeError}로 끝난다 — 실측).
	 * 방어 추가가 아니라 Node 동형이다. 71a가 남긴 실측 그대로, 이 거부는 {@code HttpRequest} 빌더와
	 * 겹치는 이중 방어라 <b>단독으로는 관측되지 않는다</b> — 잠그는 것은 계층이 아니라 결과다.
	 */
	@Test
	void theFileSchemeCannotBeUsedToReadLocalFiles(@TempDir Path tempDir) throws IOException {
		Path secret = tempDir.resolve("secret.txt");
		Files.writeString(secret, "SECRET-FILE-BODY", StandardCharsets.UTF_8);

		Result result = this.client.get(secret.toUri().toString());

		assertFalse(result.ok(), "file: 스킴은 ok=false다");
		assertFalse(String.valueOf(result.body()).contains("SECRET-FILE-BODY"), "로컬 파일 내용이 본문으로 새면 안 된다");
	}

	// --- ADR-008 행동 단언(정적 스캔이 못 보는 축) ---

	/**
	 * 재시도 0(ADR-008 (6) · index.json decisions (20)) — 실패해도 <b>한 번</b>만 간다.
	 *
	 * <p>서비스는 실패를 값으로 접으므로(미디어 {@code {items:[],error:true}} · 번역 {@code reason:'error'})
	 * 몰래 두 번 시도해도 응답 shape은 같다. 정적 게이트도 이것을 못 잡는다 — {@code for} 루프 하나에는
	 * {@code @Retryable}도 {@code RetryTemplate}도 없기 때문이다. 그래서 <b>서버가 직접 센다</b>.
	 */
	@Test
	void aFailedFetchIsTriedExactlyOnce() {
		Result get = this.client.get(this.base + "/error");
		Result post = this.client.post(this.base + "/error");

		assertFalse(get.ok());
		assertFalse(post.ok());
		assertEquals(2, hitCount("/error"), "GET 1회 + POST 1회 = 2 — 재시도·백오프가 있으면 이 수가 늘어난다");
	}

	/**
	 * 리다이렉트 미추종 — 이 테스트가 곧 divergence의 기록이다(Node fetch는 기본 follow라 200을 받는다).
	 * 여기서 따라가면 <b>서버 보유 키가 실린 URL</b>이 리다이렉트 대상으로 새어 나간다.
	 */
	@Test
	void redirectsAreNotFollowed() {
		Result result = this.client.get(this.base + "/redirect?key=" + SENTINEL_KEY);

		assertFalse(result.ok(), "302는 2xx가 아니므로 ok=false다");
		assertEquals(1, hitCount("/redirect"));
		assertEquals(0, hitCount("/target"), "리다이렉트 대상으로 요청이 새면 안 된다(Redirect.NEVER)");
	}

	// --- 인코딩 ---

	/**
	 * 인코딩 잠금 — {@code ofString()}(charset 추종)으로 바꾸면 이 테스트가 red다.
	 *
	 * <p>번역 API가 charset을 틀리게 선언하면 두 서버의 <b>번역문 자체</b>가 갈린다. 응답 shape은 같아
	 * 계약 diff로도 안 잡히는 종류의 오차다(그리고 이 축은 계약이 애초에 실행하지 않는다).
	 */
	@Test
	void aMislabeledCharsetIsIgnoredBecauseTheBodyIsAlwaysReadAsUtf8() {
		Result result = this.client.get(this.base + "/mislabeled");

		assertTrue(result.ok());
		assertEquals(KOREAN, result.body(), "선언된 charset(euc-kr)이 아니라 UTF-8로 읽어야 한다(Node 실측 동형)");
	}

	@Test
	void aResponseWithoutACharsetIsAlsoReadAsUtf8() {
		assertEquals(KOREAN, this.client.get(this.base + "/nocharset").body());
	}

	// --- 요청 단계 상한 · 본문 바이트 상한(71a 안전 파라미터 명문 승계) ---

	/**
	 * <b>응답을 주지 않는 endpoint</b>는 요청 단계 타임아웃으로 접힌다 — 71a가 ⑤ 코드리뷰 반려로 폐색한
	 * 결함의 재발 방지다.
	 *
	 * <p>Node {@code fetch}에는 요청 타임아웃이 <b>없다</b>. 완전 동형은 '무한 대기'인데 두 서버에서 그
	 * 대가가 다르다: Node는 단일 이벤트 루프라 기다리는 동안에도 다른 요청을 처리하지만, Spring은 요청
	 * 하나가 <b>Tomcat 워커 하나</b>를 점유한다(기본 200). 응답하지 않는 Google endpoint 하나 + 사용자
	 * 재시도면 워커가 고갈돼 <b>전 라우트</b>가 죽는다. 그래서 가용성 쪽으로 갈렸다.
	 *
	 * <p><b>잔여 위험은 71a와 동일하게 남는다</b>: {@code HttpRequest.timeout}은 응답 <b>헤더</b>까지만
	 * 덮으므로 본문을 천천히 흘리는 상대는 워커를 계속 점유한다(막으려면 타이머나 별도 스레드가 필요하고
	 * 그것이 ADR-008 (3)(6) 위반이다).
	 */
	@Test
	void anEndpointThatNeverAnswersIsFoldedIntoOkFalseInsteadOfHoldingTheWorker() {
		HttpExternalProxyClient impatient = new HttpExternalProxyClient(Duration.ofMillis(300), TEST_CAP);
		long startedAt = System.nanoTime();

		Result result = impatient.get(this.base + "/silent");

		long elapsedMs = (System.nanoTime() - startedAt) / 1_000_000;
		assertFalse(result.ok(), "응답 없는 endpoint는 ok=false다(예외가 새면 200이 500이 된다)");
		assertNull(result.body(), "실패 shape은 연결 거부와 같다 — 본문 없음");
		assertTrue(elapsedMs < 10_000, "요청 단계 상한이 없으면 빗장이 풀릴 때까지 붙잡힌다: " + elapsedMs + "ms");
		assertEquals(1, hitCount("/silent"), "타임아웃 뒤에도 다시 시도하지 않는다(ADR-008 (6))");
	}

	/**
	 * 상한을 넘는 본문은 <b>같은 shape</b>으로 접힌다 — 새 사유도, 잘린 본문도 아니다.
	 *
	 * <p>상한이 없으면 거대 응답이 {@code OutOfMemoryError}를 내는데 그것은 {@code catch}가 <b>잡지
	 * 못해</b> JVM 전체가 죽는다. 잘라서 돌려주지 않는 이유는 잘린 JSON이 파서에서 <b>다른 검색 결과·다른
	 * 번역문</b>이 되기 때문이다 — 실패가 낫다.
	 */
	@Test
	void aBodyOverTheCapIsFoldedIntoTheSameFailureShape() {
		HttpExternalProxyClient capped = new HttpExternalProxyClient(Duration.ofSeconds(30), TEST_CAP);

		Result over = capped.get(this.base + "/cap-over");

		assertFalse(over.ok(), "상한 초과 본문은 ok=false다");
		assertNull(over.body(), "잘린 본문을 돌려주면 서비스가 조용히 다른 결과를 만든다");
		assertEquals(1, hitCount("/cap-over"), "상한 초과에도 재시도는 없다");
	}

	@Test
	void aBodyExactlyAtTheCapIsStillReadInFull() {
		HttpExternalProxyClient capped = new HttpExternalProxyClient(Duration.ofSeconds(30), TEST_CAP);

		Result exact = capped.get(this.base + "/cap-exact");

		assertTrue(exact.ok(), "상한과 같은 크기는 초과가 아니다");
		assertEquals(TEST_CAP, exact.body().length(), "본문이 한 글자도 잘리지 않는다");
	}

	/** 프로덕션 기본값(16 MiB)은 정상 응답을 죽이지 않는다 — 상한을 너무 낮게 잡는 변이가 여기서 red다. */
	@Test
	void theProductionDefaultsDoNotAffectNormalResponses() {
		assertTrue(this.client.get(this.base + "/cap-over").ok(), "프로덕션 상한은 1 KiB짜리 본문을 막지 않는다");
		assertEquals(TEST_CAP + 1, this.client.get(this.base + "/cap-over").body().length(),
				"테스트 상한을 넘는 본문도 프로덕션에서는 한 글자도 잘리지 않는다");
		assertEquals(KOREAN, this.client.get(this.base + "/mislabeled").body(),
				"멀티바이트 본문도 상한 도입 뒤에 그대로다(바이트 수와 글자 수를 혼동하면 여기서 갈린다)");
	}

	/** 같은 인스턴스를 반복해 써도 동작이 변하지 않는다({@code HttpClient}는 필드 하나로 재사용한다). */
	@Test
	void theClientIsReusableAcrossCalls() {
		for (int i = 0; i < 3; i++) {
			assertTrue(this.client.get(this.base + "/ok").ok(), "반복 GET " + i);
			assertTrue(this.client.post(this.base + "/echo").ok(), "반복 POST " + i);
		}

		assertEquals(3, hitCount("/ok"));
		assertEquals(3, this.echoed.size());
	}

	// --- 키 문자열 비유출(계약이 구조적으로 보지 못하는 축) ---

	/**
	 * (a) <b>반환값 직렬화 전문</b>에 키가 0건이다.
	 *
	 * <p>{@code Result}는 record라 {@code toString()}이 모든 컴포넌트를 찍는다 — 어댑터가 진단 편의로
	 * URL을 결과에 담기 시작하면 그 값은 서비스를 거쳐 <b>응답 본문</b>이나 로그로 흘러 나간다. 서버 보유
	 * 키가 한 번 밖으로 나가면 회수할 방법이 없다(그것이 이 프록시가 존재하는 이유 그 자체다 — 키를
	 * 클라이언트에 내리지 않으려고 서버가 대신 나간다, {@code ADR-014}).
	 */
	@Test
	void theApiKeyNeverAppearsInTheReturnedValue() {
		for (String serialized : exerciseEveryPathWithTheKey()) {
			assertFalse(serialized.contains(SENTINEL_KEY), "반환값 직렬화 전문에 키가 실렸다: " + serialized);
			assertFalse(serialized.contains("SENTINEL"), "키의 조각도 실리면 안 된다: " + serialized);
		}
	}

	/**
	 * (b) <b>로그 링 버퍼 전 줄</b>에 키가 0건이고, (b') 이 클래스에는 애초에 로그 싱크가 없다.
	 *
	 * <p>링 버퍼는 {@code GET /api/logs/digest}로 <b>밖으로 나간다</b>(ADR-007) — 거기 들어간 한 조각은
	 * 곧 응답이다. 그래서 프로세스 표준 출력·표준 에러(부주의한 {@code printStackTrace}가 가는 곳)와
	 * {@link LogService} 버퍼를 함께 훑는다.
	 *
	 * <p><b>정직한 평가</b>: 지금 이 어댑터는 {@code LogService}를 주입받지 않으므로 링 버퍼 단언은
	 * <b>구조적 트립와이어</b>다(누군가 로거를 넣는 날 살아난다). 그래서 두 가지를 함께 못 박는다 —
	 * ① 훑는 절차 자체가 공허하지 않다는 자기 검사(센티넬을 일부러 넣은 버퍼에서는 <b>잡힌다</b>)
	 * ② 리플렉션으로 이 클래스의 필드·생성자·메서드 시그니처에 로그 타입이 없다는 사실.
	 */
	@Test
	void neitherTheLogRingBufferNorProcessOutputEverSeesTheApiKey() throws Exception {
		Clock fixed = Clock.fixed(FIXED_INSTANT, ZoneOffset.UTC);
		LogService probe = new LogService(fixed, LogService.DEFAULT_CAP, LogService.KST_OFFSET_MINUTES);
		probe.info("probe " + SENTINEL_KEY);
		assertTrue(scanForKey(probe), "훑는 절차가 공허하다 — 일부러 넣은 센티넬조차 못 찾는다");

		LogService ring = new LogService(fixed, LogService.DEFAULT_CAP, LogService.KST_OFFSET_MINUTES);
		ByteArrayOutputStream out = new ByteArrayOutputStream();
		ByteArrayOutputStream err = new ByteArrayOutputStream();
		PrintStream originalOut = System.out;
		PrintStream originalErr = System.err;
		try {
			System.setOut(new PrintStream(out, true, StandardCharsets.UTF_8));
			System.setErr(new PrintStream(err, true, StandardCharsets.UTF_8));
			exerciseEveryPathWithTheKey();
		}
		finally {
			System.setOut(originalOut);
			System.setErr(originalErr);
		}

		assertFalse(scanForKey(ring), "로그 링 버퍼에 키가 실렸다(GET /api/logs/digest로 그대로 나간다)");
		assertEquals(0, ring.digest(FIXED_INSTANT.toEpochMilli() + ONE_DAY_MS).size(),
				"이 어댑터는 아무것도 남기지 않는다 — 줄이 생겼다면 로그 싱크가 생겼다는 뜻이다");
		assertFalse(out.toString(StandardCharsets.UTF_8).contains("SENTINEL"), "표준 출력에 키가 실렸다");
		assertFalse(err.toString(StandardCharsets.UTF_8).contains("SENTINEL"), "표준 에러에 키가 실렸다");

		for (Field field : HttpExternalProxyClient.class.getDeclaredFields()) {
			assertFalse(field.getType().getSimpleName().contains("Log"), "로그 타입 필드가 생겼다: " + field);
		}
		for (Constructor<?> constructor : HttpExternalProxyClient.class.getDeclaredConstructors()) {
			for (Class<?> parameter : constructor.getParameterTypes()) {
				assertFalse(parameter.getSimpleName().contains("Log"), "생성자가 로그 싱크를 받는다: " + constructor);
			}
		}
		for (Method method : HttpExternalProxyClient.class.getDeclaredMethods()) {
			assertFalse(method.toGenericString().contains("Log"), "메서드 시그니처에 로그 타입이 있다: " + method);
		}
	}

	/**
	 * (c) <b>예외 메시지와 원인 체인</b>에 키가 0건이다 — 그리고 애초에 예외가 밖으로 나가지 않는다.
	 *
	 * <p>여기서 강제하는 실패들은 <b>키가 실린 URL을 메시지에 담는 예외</b>를 실제로 만든다:
	 * {@code URI.create("… a b …")}의 {@code IllegalArgumentException}은 URI 전문을 메시지에 넣고,
	 * {@code ConnectException}은 대상을 담는다. 그래서 {@code catch}를 지우면(변이 D) 이 테스트는
	 * <b>예외 자체</b>로도, <b>메시지 검사</b>로도 red다.
	 */
	@Test
	void theApiKeyNeverReachesAnExceptionMessageOrItsCauseChain() {
		HttpExternalProxyClient capped = new HttpExternalProxyClient(Duration.ofSeconds(30), TEST_CAP);

		for (String url : keyedUrls()) {
			for (boolean post : List.of(false, true)) {
				Throwable thrown = capture(capped, url, post);

				// 체인 검사가 먼저다 — assertNull이 앞서면 키 유출 단언이 실행되지 않는다(변이 D 실측).
				for (Throwable cause = thrown; cause != null; cause = cause.getCause()) {
					assertFalse(String.valueOf(cause.getMessage()).contains("SENTINEL"),
							"예외 원인 체인의 메시지에 키가 실렸다: " + cause);
				}
				assertNull(thrown, "어댑터가 예외를 밖으로 던졌다(" + (post ? "POST " : "GET ") + "): " + thrown);
			}
		}
	}

	/**
	 * 이 파일이 <b>ADR-008 예외 목록에 등재된 바로 그 자리</b>에 있고, 그 예외가 열어 주지 <b>않은</b>
	 * 것들을 쓰지 않는다는 정적 확인.
	 *
	 * <p><b>2026-08-28 변이 F 실측 — 이 단언이 존재하는 이유다.</b> {@code send}를 {@code sendAsync(...)
	 * .join()}으로 바꿔도 {@code Adr008DisciplineTest}의 비동기 군은 <b>green</b>이었다: 그 군의 패턴은
	 * {@code CompletableFuture.\w*Async(} · {@code ExecutorService} · {@code new Thread(} 등이라
	 * {@code this.http.sendAsync(...)} 철자를 하나도 건드리지 않는다. 게이트 파일은 step2 소유라 이
	 * step이 0줄 고치므로(step5.md 금지사항), 그 구멍은 <b>여기서</b> 막는다. 비동기 호출은 요청 스레드
	 * 밖에서 도는 코드를 만들고 그것이 ADR-008 2군의 금지 대상이다 — 예외는 3군(네트워크)에만 열려 있다.
	 *
	 * <p>로그 싱크 부재도 소스 수준에서 함께 못 박는다(위 리플렉션 단언의 정적 대응물이다).
	 */
	@Test
	void theAdapterSourceHasNoAsyncSendAndNoLogSink() throws IOException {
		Path declared = Path.of("src", "main", "java", "harness", "news", "service", "HttpExternalProxyClient.java");

		assertTrue(Files.isRegularFile(declared),
				"ADR-008 예외 목록이 등재한 자리에 파일이 없다(다른 패키지에 두면 예외가 성립하지 않는다): " + declared);

		String source = Files.readString(declared, StandardCharsets.UTF_8);
		String code = source.replaceAll("(?s)/\\*.*?\\*/", " ") // 블록 주석 제거(규율을 설명하는 javadoc은 코드가 아니다)
				.replaceAll("(?m)^\\s*//[^\n]*", " "); // 줄 첫머리 주석만 — 리터럴 속 //를 지우지 않는다.
		for (String forbidden : List.of("sendAsync", "CompletableFuture", "printStackTrace", "System.out",
				"System.err", "LogService", "Logger")) {
			assertFalse(code.contains(forbidden),
					"ADR-008 예외는 3군(네트워크)에만 열려 있고 로그 싱크도 없다 — 금지 철자가 코드에 있다: " + forbidden);
		}

		String contract = Files.readString(
				Path.of("src", "main", "java", "harness", "news", "service", "ExternalProxyClient.java"),
				StandardCharsets.UTF_8);
		assertFalse(contract.contains("import java.net"), "인터페이스가 네트워크 타입을 import한다 — 계층이 새고 있다(ADR-006)");
	}

	// --- 유틸 ---

	/** 키가 실린 URL 전부 — 성공·비2xx·리다이렉트·연결 거부·상한 초과·잘못된 URI·비-http 스킴. */
	private List<String> keyedUrls() {
		return List.of(this.base + "/ok?key=" + SENTINEL_KEY, this.base + "/notfound?key=" + SENTINEL_KEY,
				this.base + "/redirect?key=" + SENTINEL_KEY, DEAD_ENDPOINT + "?key=" + SENTINEL_KEY,
				this.base + "/cap-over?key=" + SENTINEL_KEY, "http://127.0.0.1:1/a b?key=" + SENTINEL_KEY,
				"ftp://127.0.0.1/x?key=" + SENTINEL_KEY, "not a url " + SENTINEL_KEY);
	}

	/** 키가 실린 URL로 GET·POST를 전부 돌리고 <b>반환값 직렬화 전문</b>을 모은다. */
	private List<String> exerciseEveryPathWithTheKey() {
		HttpExternalProxyClient capped = new HttpExternalProxyClient(Duration.ofSeconds(30), TEST_CAP);
		List<String> serialized = new ArrayList<>();
		for (String url : keyedUrls()) {
			serialized.add(String.valueOf(capped.get(url)));
			serialized.add(String.valueOf(capped.post(url)));
		}
		return serialized;
	}

	/** 호출에서 나온 {@link Throwable}(정상이면 {@code null}) — 어댑터는 던지지 않는 것이 계약이다. */
	private static Throwable capture(HttpExternalProxyClient client, String url, boolean post) {
		try {
			if (post) {
				client.post(url);
			}
			else {
				client.get(url);
			}
			return null;
		}
		catch (Throwable ex) {
			return ex;
		}
	}

	/** 링 버퍼 전 줄에서 센티넬을 찾는다(창은 고정 시각 기준으로 레코드를 포함하도록 잡는다). */
	private static boolean scanForKey(LogService log) {
		return log.digest(FIXED_INSTANT.toEpochMilli() + ONE_DAY_MS).stream()
				.anyMatch((record) -> String.valueOf(record).contains("SENTINEL"));
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

	/** 요청을 한 줄로 기록한다 — 메서드·본문 바이트 수·헤더 3종(붙지 않아야 하는 것들). */
	private static String describe(HttpExchange exchange) throws IOException {
		int bytes = 0;
		byte[] chunk = new byte[512];
		try (InputStream body = exchange.getRequestBody()) {
			int read;
			while ((read = body.read(chunk)) >= 0) {
				bytes += read;
			}
		}
		return "method=" + exchange.getRequestMethod() + " body=" + bytes + " content-length="
				+ header(exchange, "Content-Length") + " content-type=" + header(exchange, "Content-Type")
				+ " authorization=" + header(exchange, "Authorization");
	}

	private static String header(HttpExchange exchange, String name) {
		List<String> values = exchange.getRequestHeaders().get(name);
		return (values == null || values.isEmpty()) ? "<none>" : String.join("|", values);
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
