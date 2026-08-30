package harness.news.controller;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import harness.news.model.UserRepository;
import harness.news.service.ChangeBus;
import harness.news.service.FaultySessionGuard;
import harness.news.service.UserService;
import harness.news.testsupport.MutableClock;
import harness.news.testsupport.TempNewsDb;
import harness.news.testsupport.Wire;
import harness.news.testsupport.WireStream;
import harness.news.web.SseHttp;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;
import java.util.regex.Pattern;
import org.apache.catalina.connector.Connector;
import org.apache.coyote.AbstractProtocol;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.context.TestConfiguration;
import org.springframework.boot.tomcat.TomcatWebServer;
import org.springframework.boot.web.server.servlet.context.ServletWebServerApplicationContext;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Primary;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;

/**
 * {@code GET /api/stream}의 와이어 계약 — 리포 루트 {@code server/index.js} 1124~1160행과 1:1이다
 * (ADR-005 무효화 신호 · ADR-015 SSE 와이어 지점).
 *
 * <h2>이 파일이 유일 방어선인 축</h2>
 * {@code contract/cases/default/sse-stream.contract.js}(10관측)가 헤더·프레임 바이트·kind 4종·동시 2연결·
 * 봉인을 본다. 그러나 <b>계약이 구조적으로 볼 수 없는 축</b>이 넷 있고 그것이 이 클래스의 존재 이유다.
 * <ol>
 *   <li><b>push 시점 비연장 peek</b>(ADR-005·ADR-007) — 하네스는 서버 시계를 주입할 수 없다.
 *       {@code touchSession}으로 바꾸면 열린 스트림이 세션 유휴 만료를 무한 연장하는데 계약은 green이다.</li>
 *   <li><b>구독 누수 0 · 워커 점유 0</b> — 계약은 열린 스트림 몇 개로 서버가 죽는지 보지 않는다.</li>
 *   <li><b>replay-gate</b>(index.json decisions (15)) — 구독 등록 창에서 발생한 신호의 유실.
 *       Node는 단일 스레드라 그 창이 없지만 Spring은 다른 워커가 동시에 돈다.</li>
 *   <li><b>{@code open()}~{@code endPrelude} 사이 예외</b> — 봉인하지 않으면 클라이언트는 헤더만 받고
 *       영원히 기다리고({@code setTimeout(0)}이라 <b>컨테이너 타임아웃도 없다</b>) 서버는 구독과
 *       비동기 컨텍스트를 붙든다. 계약은 그저 타임아웃 red만 보고 원인을 알려주지 않는다.</li>
 * </ol>
 *
 * <h2>주입한 seam 셋</h2>
 * <ul>
 *   <li>{@link MutableClock} — 세션 만료 경계를 결정적으로 왕복한다.</li>
 *   <li>{@link FaultySessionGuard} — push 시점 DB 장애(peek 예외)를 재현한다.</li>
 *   <li>{@link HookedChangeBus}·{@link HookedSseHttp} — <b>구독 등록 창</b>과 <b>ready 쓰기 시점</b>에
 *       테스트 훅을 끼워 넣어 경합을 <b>결정적으로</b> 재현한다. 한가한 환경의 무작위 반복은 창이 좁아
 *       우연히 통과하므로(index.json decisions (15)) 반복 테스트와 훅 테스트를 <b>둘 다</b> 둔다.</li>
 * </ul>
 *
 * <p>워커 상한을 <b>5</b>로 낮춘 이유는 아래 {@link #openStreamsDoNotOccupyWorkerThreads()}에 있다 —
 * 기본 200스레드에서는 블로킹 구현도 통과해 그 단언이 공허해진다.
 *
 * <p>DB는 이 클래스 전용 임시 사본이고 리포 {@code news.db}는 열지 않는다.
 */
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT,
		properties = "server.tomcat.threads.max=" + StreamWireTest.MAX_WORKERS_TEXT)
class StreamWireTest {

	/** 애노테이션 값은 컴파일 상수여야 한다 — 아래 {@link #MAX_WORKERS}가 같은 값을 숫자로 갖는다. */
	static final String MAX_WORKERS_TEXT = "5";

	private static final int MAX_WORKERS = Integer.parseInt(MAX_WORKERS_TEXT);

	/** 워커보다 <b>많은</b> 스트림 — 이 부등식이 깨지면 워커 점유 단언이 공허해진다. */
	private static final int STREAMS_OVER_WORKERS = 8;

	/** 경합 반복 횟수(index.json decisions (15): 1회 실행은 증거가 아니다). */
	private static final int RACE_ROUNDS = 200;

	/** 끊긴 소켓 회수에 허용하는 publish 상한 — 실측은 2회다(항목 11(b) javadoc). */
	static final int RECLAIM_PUBLISH_LIMIT = 5;

	private static final String READY_FRAME = "event: ready\ndata: {\"ok\":true}\n\n";

	private static final String UNAUTHORIZED_DATA = "{\"ok\":false,\"reason\":\"unauthenticated\"}";

	private static final String UNAUTHENTICATED_JSON = "{\"ok\":false,\"reason\":\"unauthenticated\"}";

	private static final Duration WAIT = Duration.ofSeconds(5);

	private static final Duration SILENCE = Duration.ofSeconds(2);

	private static final long MINUTE_MS = 60L * 1000L;

	private static final long ONE_HOUR_MS = 60L * MINUTE_MS;

	private static final String SESSION_HEADER = "x-session-id";

	private static final String EDIT_CLIENT_HEADER = "x-edit-client";

	private static final String PASSWORD = "stream-wire-pw";

	private static final Path DATA_DIR = TempNewsDb.newDataDir("stream-wire");

	private static final MutableClock CLOCK =
			new MutableClock(Instant.parse("2026-08-30T00:00:00Z").toEpochMilli());

	private static final Path CONTROLLER_SOURCE =
			Path.of("src", "main", "java", "harness", "news", "controller", "StreamController.java");

	private static final Pattern COMMENTS = Pattern.compile("/\\*.*?\\*/|//[^\\n]*", Pattern.DOTALL);

	/** 64-hex 세션 토큰 — 응답 어디에도 나오면 안 된다. */
	private static final Pattern HEX_TOKEN = Pattern.compile("[0-9a-f]{64}");

	/** 드라이브 문자로 시작하는 절대경로(서버 파일시스템 노출). */
	private static final Pattern WINDOWS_PATH = Pattern.compile("[A-Za-z]:[\\\\/]");

	@TestConfiguration
	static class Seams {

		@Bean
		@Primary
		Clock mutableClock() {
			return CLOCK;
		}

		/**
		 * 이름은 {@code SessionConfig.sessionGuard}와 달라야 한다(빈 정의 덮어쓰기는 꺼져 있다).
		 * {@code @Primary}라 필터·컨트롤러가 전부 이 가드를 받는다.
		 */
		@Bean
		@Primary
		FaultySessionGuard faultySessionGuard(UserRepository users, Clock clock) {
			return FaultySessionGuard.wrapping(users, clock);
		}

		@Bean
		@Primary
		HookedChangeBus hookedChangeBus() {
			return new HookedChangeBus();
		}

		@Bean
		@Primary
		HookedSseHttp hookedSseHttp() {
			return new HookedSseHttp();
		}

	}

	@DynamicPropertySource
	static void dataDir(DynamicPropertyRegistry registry) {
		registry.add("app.data-dir", () -> DATA_DIR.toAbsolutePath().toString());
	}

	@Value("${local.server.port}")
	private int port;

	@Autowired
	private UserService users;

	@Autowired
	private FaultySessionGuard sessions;

	@Autowired
	private HookedChangeBus changes;

	@Autowired
	private HookedSseHttp sse;

	@Autowired
	private ServletWebServerApplicationContext webServerContext;

	@BeforeEach
	void freshBaseline() {
		this.sessions.recoverPeek();
		this.sse.clearHooks();
		this.changes.clearHooks();
		ensureUser("stream-r", "R");
		ensureUser("stream-d", "D");
		ensureUser("stream-peek", "R");
		ensureUser("stream-seal", "R");
		ensureUser("stream-fault", "R");
		awaitNoSubscribers();
	}

	// --- 와이어 형태 -------------------------------------------------------------------------------

	/** 항목 1 — 미인증은 <b>스트림을 열기 전</b> 401 JSON이다(열고 나서 오류 프레임을 보내면 위반이다). */
	@Test
	void anUnauthenticatedRequestIs401JsonAndNeverOpensTheStream() {
		Wire.Response response = Wire.send(this.port, "GET", "/api/stream", Map.of(), null);

		assertEquals(401, response.status());
		assertEquals("Content-Type: application/json; charset=utf-8", response.line("content-type"));
		assertEquals(UNAUTHENTICATED_JSON, response.body());
		assertFalse(String.join("\n", response.headerLines()).toLowerCase().contains("text/event-stream"),
				"미인증인데 SSE 헤더가 나갔다: " + response.headerLines());
	}

	/** 항목 2·5 — 헤더 3종의 <b>원문 바이트</b>와 {@code Content-Length} 부재. */
	@Test
	void aSessionHeaderOpensTheStreamWithTheExactHeaderBytes() {
		try (WireStream stream = openWith(header(sessionFor("stream-r")))) {
			assertEquals(200, stream.status());
			assertEquals("Content-Type: text/event-stream; charset=utf-8", stream.line("Content-Type"),
					"세미콜론 뒤 공백 1바이트가 계약이다(ADR-015 · RawContentType seam)");
			assertEquals("Cache-Control: no-cache", stream.line("Cache-Control"));
			assertNull(stream.line("Content-Length"),
					"본문 길이를 정하면 컨테이너가 그 바이트에서 응답을 끝내 스트림이 첫 프레임에서 닫힌다");
			// Connection은 hop-by-hop이라 컨테이너 소유이고 계약 리포트가 싣지 않는 헤더다
			// (contract/lib/record.js ALLOWED_HEADERS · index.json open_questions (1)).
			// 2026-08-30 실측: 앱이 setHeader("Connection", "keep-alive")를 하면 컨테이너 값과 겹쳐
			// 와이어에 "Connection: keep-alive, keep-alive"가 나갔다. 지정을 지우니 Tomcat 단독으로
			// Node와 같은 한 값이 나간다 — 그래서 이 단언은 "앱이 이 헤더에 손대지 않았다"의 그물이다.
			assertEquals("Connection: keep-alive", stream.line("Connection"),
					"Node 실측과 갈렸다 — 앱이 이 헤더를 지정하면 컨테이너 값과 겹친다(맞추려 컨테이너를 "
							+ "뚫지 말고 divergence로 기록하라)");
			assertNotNull(awaitReady(stream));
		}
	}

	/** 항목 3 — 본문의 <b>첫 바이트부터</b> ready 프레임 32바이트다(초기 코멘트·패딩 0). */
	@Test
	void theBodyStartsWithTheThirtyTwoByteReadyFrame() {
		try (WireStream stream = openWith(header(sessionFor("stream-r")))) {
			assertNotNull(awaitReady(stream));

			assertEquals(32, READY_FRAME.getBytes(StandardCharsets.UTF_8).length);
			assertTrue(stream.rawBody().startsWith(READY_FRAME),
					"첫 프레임 원문이 계약 바이트와 다르다: " + describe(stream.rawBody()));
			assertFalse(stream.rawBody().contains("\r"), "개행은 LF만이다");
		}
	}

	/** 항목 4 — 쿠키({@code sid})만으로도 열린다. EventSource는 커스텀 헤더를 못 보내는 실사용 경로다. */
	@Test
	void aCookieAloneOpensTheStream() {
		try (WireStream stream = openWith(Map.of("Cookie", "sid=" + sessionFor("stream-r")))) {
			assertEquals(200, stream.status());
			assertEquals("Content-Type: text/event-stream; charset=utf-8", stream.line("Content-Type"));
			assertNotNull(awaitReady(stream));
		}
	}

	// --- 신호 --------------------------------------------------------------------------------------

	/** 항목 6 — 실제 요청 4종이 각각 신호 1개를 내고 payload는 <b>{@code kind} 한 키뿐</b>이다(ADR-005). */
	@Test
	void theFourChangeKindsCarryNothingButTheKind() {
		String reporter = sessionFor("stream-r");
		String desk = sessionFor("stream-d");
		String tab = unique("stream-tab");
		try (WireStream stream = openWith(header(reporter))) {
			assertNotNull(awaitReady(stream));

			String articleId = createArticle(reporter);
			assertEquals("{\"kind\":\"create\"}", awaitChangeData(stream));

			assertEquals(200, lock(reporter, tab, articleId).status());
			assertEquals("{\"kind\":\"lock\"}", awaitChangeData(stream));

			assertEquals(200, Wire.json(this.port, "PUT", "/api/articles/" + articleId,
					Map.of(SESSION_HEADER, reporter, EDIT_CLIENT_HEADER, tab),
					"{\"title\":\"" + unique("stream-edit") + "\"}").status());
			assertEquals("{\"kind\":\"update\"}", awaitChangeData(stream));

			assertEquals(200, Wire.json(this.port, "POST", "/api/articles/" + articleId + "/action",
					Map.of(SESSION_HEADER, desk), "{\"action\":\"hold\"}").status());
			assertEquals("{\"kind\":\"status\"}", awaitChangeData(stream));
		}
	}

	/** 항목 7 — 같은 세션의 동시 연결 2개가 트리거 <b>1회</b>에 둘 다 받는다(SPA 실사용 패턴). */
	@Test
	void twoConcurrentConnectionsBothReceiveOneTrigger() {
		String reporter = sessionFor("stream-r");
		try (WireStream first = openWith(header(reporter)); WireStream second = openWith(header(reporter))) {
			assertNotNull(awaitReady(first));
			assertNotNull(awaitReady(second));

			createArticle(reporter);

			assertEquals("{\"kind\":\"create\"}", awaitChangeData(first));
			assertEquals("{\"kind\":\"create\"}", awaitChangeData(second));
		}
	}

	// --- 계약이 구조적으로 못 보는 축 ----------------------------------------------------------------

	/**
	 * 항목 8 — <b>push 재검증은 세션을 연장하지 않는다</b>(ADR-005 (b) · ADR-007).
	 *
	 * <p>{@code peekSession} → {@code touchSession} 변이(M4-2)를 잡는 <b>유일한</b> 테스트다: 계약은 시계를
	 * 주입할 수 없어 이 축에서 언제나 green이다. 연장하면 열린 스트림 하나가 1시간 유휴 만료를 영원히
	 * 밀어내 "로그아웃하지 않은 브라우저 탭 = 무한 세션"이 된다.
	 */
	@Test
	void pushRevalidationNeverExtendsTheSessionExpiry() {
		String token = sessionFor("stream-peek");
		try (WireStream stream = openWith(header(token))) {
			assertNotNull(awaitReady(stream));
			CLOCK.advance(ONE_HOUR_MS - MINUTE_MS); // 만료 1분 전.

			for (int i = 0; i < 5; i++) {
				this.changes.publish(ChangeBus.CREATE);
				assertEquals("{\"kind\":\"create\"}", awaitChangeData(stream), "push " + i + "가 도착하지 않았다");
			}

			CLOCK.advance(2 * MINUTE_MS); // 원래 만료 시각을 넘겼다.
			Wire.Response session =
					Wire.send(this.port, "GET", "/api/session", Map.of(SESSION_HEADER, token), null);

			assertEquals(401, session.status(),
					"push 재검증이 세션 만료를 밀었다 — touchSession을 쓰면 열린 스트림이 유휴 만료를 "
							+ "무한 연장한다(ADR-005·ADR-007). 계약은 이 축을 관측하지 못한다: " + session.body());
		}
	}

	/**
	 * 항목 9 — <b>fail-closed</b>: 재검증이 예외를 던지면(DB 장애) 신호를 <b>쓰지 않고</b> 봉인한다.
	 * "일단 전송"이 아니다 — 잡는 위치는 구독 콜백 안이고(정본 주석), 가드에서 잡으면 HTTP 라우트의
	 * DB 예외가 500 대신 401이 되는 광범위한 변화가 생긴다.
	 */
	@Test
	void aFailingRevalidationSealsWithoutWritingTheSignal() {
		try (WireStream stream = openWith(header(sessionFor("stream-fault")))) {
			assertNotNull(awaitReady(stream));
			this.sessions.failPeekWith(new IllegalStateException("주입된 세션 조회 장애"));

			this.changes.publish(ChangeBus.CREATE);

			WireStream.Frame frame = stream.awaitFrame((f) -> true, WAIT);
			assertNotNull(frame, "예외 뒤에도 아무 프레임이 오지 않았다(봉인되지 않았다)");
			assertEquals("unauthorized", frame.event(), "재검증 실패인데 신호를 그대로 내보냈다");
			assertEquals(UNAUTHORIZED_DATA, frame.data());
			assertTrue(stream.awaitSilence(SILENCE), "봉인 후에도 프레임이 나갔다");
			assertEquals(0, this.changes.subscriberCount(), "봉인했는데 구독이 남았다");
		}
	}

	/** 항목 10 — 세션 무효화 후 <b>{@code unauthorized} 1회 + 봉인</b>(그 뒤로는 한 줄도 나가지 않는다). */
	@Test
	void anInvalidatedSessionGetsOneUnauthorizedFrameAndThenSilence() {
		String token = sessionFor("stream-seal");
		try (WireStream stream = openWith(header(token))) {
			assertNotNull(awaitReady(stream));
			assertTrue(this.sessions.invalidate(token), "세션 무효화 자체가 실패했다");

			this.changes.publish(ChangeBus.CREATE);

			WireStream.Frame frame = stream.awaitFrame((f) -> true, WAIT);
			assertNotNull(frame, "무효화 뒤 종료 프레임이 오지 않았다");
			assertEquals("unauthorized", frame.event(), "무효화된 세션에 신호를 보냈다");
			assertEquals(UNAUTHORIZED_DATA, frame.data());

			this.changes.publish(ChangeBus.CREATE);
			assertTrue(stream.awaitSilence(SILENCE), "봉인 이후에 프레임이 더 나갔다");
			assertEquals(0, this.changes.subscriberCount(), "봉인했는데 구독이 남았다");
		}
	}

	/**
	 * 항목 11(a) — <b>정상 종료(서버 주도 봉인)는 즉시 0</b>이다.
	 *
	 * <p>스트림 5개를 열고 세션을 무효화한 뒤 트리거 1회를 쏘면, 봉인은 {@code publish}를 부른 <b>그
	 * 스레드</b>에서 동기로 끝난다 — 그래서 폴링 없이 "publish가 반환한 시점에 0"을 단언할 수 있다.
	 *
	 * <p><b>클라이언트가 소켓을 끊는 경로는 여기가 아니다</b>: 그쪽은 컨테이너가 알려주기 전까지 서버가
	 * 알 수 없어 회수가 지연되고(2026-08-30 실측), 항목 11(b)가 따로 관측한다. 둘을 한 테스트로 합치면
	 * 컨테이너 동작에 의존하는 flaky 단언이 된다(decisions (12)).
	 */
	@Test
	void aServerSideSealLeavesNoSubscriptionBehind() {
		String token = sessionFor("stream-r");
		List<WireStream> streams = new ArrayList<>();
		try {
			for (int i = 0; i < 5; i++) {
				WireStream stream = openWith(header(token));
				assertNotNull(awaitReady(stream), "스트림 " + i + "가 열리지 않았다");
				streams.add(stream);
			}
			assertEquals(5, this.changes.subscriberCount(), "열린 스트림 수와 구독 수가 다르다");
			assertTrue(this.sessions.invalidate(token), "세션 무효화 자체가 실패했다");

			this.changes.publish(ChangeBus.CREATE);

			assertEquals(0, this.changes.subscriberCount(),
					"봉인이 끝난 시점에 구독이 남아 있다 — 종료 순서 ①구독 해제가 빠졌다");
			for (int i = 0; i < streams.size(); i++) {
				WireStream.Frame frame = streams.get(i).awaitFrame((f) -> true, WAIT);
				assertNotNull(frame, "스트림 " + i + "가 종료 프레임을 받지 못했다");
				assertEquals("unauthorized", frame.event(), "스트림 " + i + "에 신호가 나갔다");
			}
		}
		finally {
			streams.forEach(WireStream::close);
		}
	}

	/**
	 * 항목 11(b)(c) — <b>강제 끊김</b>은 "끊자마자 0"이 아니라 <b>write 실패</b>에서 회수된다.
	 *
	 * <p>{@code AsyncContext.setTimeout(0)}(무한)이라 Tomcat이 {@code onError}/{@code onComplete}를 바로
	 * 내지 않고, 그러면 해제는 다음 write 실패 시점까지 지연된다 — 그 지연은 결함이 아니라 이 설계의
	 * 회수 경로다(decisions (12)). "끊자마자 0"으로 단언하면 컨테이너 동작에 의존하는 flaky 테스트가 된다.
	 *
	 * <p><b>2026-08-30 실측(단언이 아니라 관측 — forward_notes에 divergence로 남긴다)</b>:
	 * ① 소켓을 끊고 publish 없이 1초를 기다려도 구독 수가 줄지 않았다 = 이 컨테이너는 무한 타임아웃
	 * 비동기 요청의 클라 끊김에 {@code onError}를 즉시 내지 않는다. ② 회수에 필요한 publish는
	 * <b>1회가 아니라 2회</b>였다 — 끊긴 소켓에 대한 첫 write는 OS 버퍼에 들어가 성공하고, 그 뒤 도착한
	 * RST를 두 번째 write가 만난다. 그래서 계획서의 "publish 1회 뒤 0"을 그대로 단언하지 않고
	 * {@value #RECLAIM_PUBLISH_LIMIT}회 상한 안에서 회수되는지를 본다.
	 */
	@Test
	void anAbruptlyClosedSocketIsReclaimedByAFailingWrite() {
		WireStream stream = openWith(header(sessionFor("stream-r")));
		assertNotNull(awaitReady(stream));
		assertEquals(1, this.changes.subscriberCount());

		stream.close(); // 종료 프레임 없이 소켓만 끊는다.

		boolean reclaimedByContainer = awaitSubscriberCount(0, Duration.ofSeconds(1));
		int publishes = 0;
		while (this.changes.subscriberCount() > 0 && publishes < RECLAIM_PUBLISH_LIMIT) {
			this.changes.publish(ChangeBus.CREATE);
			publishes++;
			sleepQuietly();
		}

		assertEquals(0, this.changes.subscriberCount(),
				"끊긴 스트림이 publish " + publishes + "회에도 회수되지 않았다(컨테이너 자동 회수="
						+ reclaimedByContainer + ") — write 실패 → 자기 봉인 → 구독 해제 경로가 끊겼다."
						+ " 컨테이너는 대신 정리해 주지 않는다: setTimeout(0)");
	}

	/**
	 * 항목 12 — <b>워커 점유 0</b>. 스트림이 워커 수보다 많아도 다른 라우트가 정상 응답한다.
	 *
	 * <p>기본 {@code threads.max=200}에서는 블로킹 구현("컨트롤러가 루프를 돌며 이벤트를 기다린다")도
	 * 통과하므로 이 클래스는 상한을 {@value #MAX_WORKERS_TEXT}로 낮춘다. 부등식이 깨지면 단언이 공허해지므로
	 * 그 사실 자체를 테스트 안에서 단언한다.
	 */
	@Test
	void openStreamsDoNotOccupyWorkerThreads() {
		assertTrue(STREAMS_OVER_WORKERS > MAX_WORKERS,
				"스트림 수가 워커 수보다 많아야 이 테스트가 무언가를 증명한다");
		assertEquals(MAX_WORKERS, configuredMaxWorkers(),
				"워커 상한 프로퍼티가 실제 커넥터에 적용되지 않았다 — 단언이 공허해진다");

		String token = sessionFor("stream-r");
		List<WireStream> streams = new ArrayList<>();
		try {
			for (int i = 0; i < STREAMS_OVER_WORKERS; i++) {
				WireStream stream = openWith(header(token));
				assertNotNull(awaitReady(stream), "스트림 " + i + "가 열리지 않았다(워커가 잠식됐다)");
				streams.add(stream);
			}

			assertEquals(200, Wire.send(this.port, "GET", "/api/health", Map.of(), null).status(),
					"열린 스트림이 워커를 점유해 다른 라우트가 막혔다");
			assertEquals(200,
					Wire.send(this.port, "GET", "/api/session", Map.of(SESSION_HEADER, token), null).status());
		}
		finally {
			streams.forEach(WireStream::close);
		}
	}

	/**
	 * 항목 13 — 구독자 write가 실패해도 <b>트리거 요청의 응답이 뒤집히지 않는다</b>.
	 * 예외가 새면 이미 성공한 저장이 500이 되고 클라 재시도가 중복 저장을 만든다(정본 1144~1150행 주석).
	 */
	@Test
	void aFailingSubscriberWriteDoesNotFlipTheTriggerResponse() {
		String reporter = sessionFor("stream-r");
		WireStream stream = openWith(header(reporter));
		assertNotNull(awaitReady(stream));
		stream.close(); // 이제 이 구독자에 대한 write는 실패한다.

		for (int i = 0; i < 3; i++) {
			Wire.Response response = Wire.json(this.port, "POST", "/api/articles",
					Map.of(SESSION_HEADER, reporter), "{\"title\":\"" + unique("stream-title") + "\"}");
			assertEquals(200, response.status(), "구독자 write 실패가 트리거 응답을 뒤집었다: " + response.body());
			assertTrue(response.body().contains("\"ok\":true"));
		}
	}

	/** 항목 14 — 응답 위생: 세션 토큰도 서버 절대경로도 스트림 응답에 없다. */
	@Test
	void theStreamResponseLeaksNeitherTokenNorAbsolutePath() {
		String token = sessionFor("stream-r");
		try (WireStream stream = openWith(header(token))) {
			assertNotNull(awaitReady(stream));
			this.changes.publish(ChangeBus.CREATE);
			assertNotNull(awaitChangeData(stream));

			String wire = String.join("\n", stream.headerLines()) + "\n" + stream.rawBody();
			assertFalse(wire.contains(token), "세션 토큰이 응답에 실렸다");
			assertFalse(HEX_TOKEN.matcher(wire).find(), "64-hex 토큰 모양의 값이 응답에 있다: " + describe(wire));
			assertFalse(WINDOWS_PATH.matcher(wire).find(), "서버 절대경로가 응답에 있다: " + describe(wire));
		}
	}

	// --- replay-gate ------------------------------------------------------------------------------

	/**
	 * 항목 15 — <b>등록 창 유실 0</b>(결정적 재현). {@code writePrelude(READY)} 시점, 즉 "구독은 끝났고
	 * ready는 아직 나가는 중"인 <b>정확히 그 창</b>에서 신호를 발생시킨다.
	 *
	 * <p>구독 등록을 {@code endPrelude} 뒤로 옮기면(M4-11 = 초안의 "ready write 뒤 구독" 순서) 이 창의
	 * 신호가 <b>구독 부재로 유실</b>되어 여기서 red가 난다. 무작위 반복(아래 {@link #twoHundredRoundsOfOpenAndPublishLoseNothing()})은
	 * 한가한 환경에서 창이 좁아 통과할 수 있으므로 <b>둘 다</b> 둔다.
	 */
	@Test
	void signalsRaisedInsideTheReadyWindowAreNotLost() {
		AtomicInteger hookRuns = new AtomicInteger();
		this.sse.afterWritePrelude(() -> {
			hookRuns.incrementAndGet();
			this.changes.publish(ChangeBus.CREATE);
			this.changes.publish(ChangeBus.UPDATE);
		});

		try (WireStream stream = openWith(header(sessionFor("stream-r")))) {
			assertNotNull(awaitReady(stream));
			assertEquals("{\"kind\":\"create\"}", awaitChangeData(stream), "창에서 발생한 첫 신호가 유실됐다");
			assertEquals("{\"kind\":\"update\"}", awaitChangeData(stream), "창에서 발생한 둘째 신호가 유실됐다");
			// 훅은 ready 바이트가 클라이언트에 닿은 뒤에 돌 수도 있다(서버가 delegate 쓰기를 먼저 한다) —
			// 그래서 ready 수신 직후가 아니라 결과(프레임)를 다 본 뒤에 공허성을 확인한다.
			assertEquals(1, hookRuns.get(),
					"writePrelude가 불리지 않았다 — ready가 prelude 경로를 지나지 않으면 이 테스트는 공허하다");
		}
	}

	/**
	 * 항목 16 — <b>ready가 언제나 첫 프레임</b>. 구독 등록 <b>직후</b>(ready보다 먼저) 발생한 신호도
	 * ready 앞으로 끼어들지 못한다.
	 *
	 * <p>{@code writePrelude(READY)}를 {@code write(READY)}로 바꾸면(M4-12) ready가 큐 뒤에 붙어
	 * change가 먼저 나가므로 여기서 red다.
	 */
	@Test
	void readyStaysTheFirstFrameEvenWhenSignalsRaceTheSubscription() {
		AtomicInteger hookRuns = new AtomicInteger();
		this.changes.afterSubscribe(() -> {
			hookRuns.incrementAndGet();
			this.changes.publish(ChangeBus.CREATE);
		});

		try (WireStream stream = openWith(header(sessionFor("stream-r")))) {
			WireStream.Frame first = stream.awaitFrame((f) -> true, WAIT);
			assertNotNull(first, "아무 프레임도 오지 않았다");
			assertEquals("ready", first.event(), "구독 창의 신호가 ready 앞으로 끼어들었다");
			assertTrue(stream.rawBody().startsWith(READY_FRAME),
					"본문 첫 바이트가 ready 프레임이 아니다: " + describe(stream.rawBody()));
			assertEquals("{\"kind\":\"create\"}", awaitChangeData(stream), "창의 신호가 유실됐다");
			assertEquals(1, hookRuns.get(), "구독 등록 훅이 돌지 않았다 — 이 테스트가 공허해진다");
		}
	}

	/** 항목 17 — 창에서 여러 건이 발생하면 <b>발생 순서대로</b> 드레인된다(FIFO). */
	@Test
	void queuedSignalsDrainInPublishOrder() {
		List<String> published = List.of(ChangeBus.CREATE, ChangeBus.UPDATE, ChangeBus.STATUS, ChangeBus.LOCK);
		AtomicInteger hookRuns = new AtomicInteger();
		this.changes.afterSubscribe(() -> {
			hookRuns.incrementAndGet();
			published.forEach(this.changes::publish);
		});

		try (WireStream stream = openWith(header(sessionFor("stream-r")))) {
			assertNotNull(awaitReady(stream));

			List<String> received = new ArrayList<>();
			for (int i = 0; i < published.size(); i++) {
				received.add(awaitChangeData(stream));
			}

			assertEquals(published.stream().map((kind) -> "{\"kind\":\"" + kind + "\"}").toList(), received,
					"드레인 순서가 발생 순서와 다르다");
			assertEquals(1, hookRuns.get(), "구독 등록 훅이 돌지 않았다 — 이 테스트가 공허해진다");
		}
	}

	/**
	 * 항목 15의 반복 축 — 매 라운드 <b>다른 스레드</b>가 ready 수신 직후에 신호를 쏜다. {@value #RACE_ROUNDS}회
	 * 반복하며 유실 0을 단언한다(1회 실행은 아무것도 증명하지 않는다 — index.json decisions (15)).
	 *
	 * <p>"ready를 받았다 = 구독이 끝났다"는 계약 하네스({@code contract/lib/sse.js})의 전제이며 Node에서만
	 * 자동으로 참이다. 이 반복은 그 전제가 Spring에서도 유지되는지를 실제 경합으로 확인한다.
	 */
	@Test
	void twoHundredRoundsOfOpenAndPublishLoseNothing() throws Exception {
		String token = sessionFor("stream-r");
		List<Integer> lostRounds = new ArrayList<>();

		for (int round = 0; round < RACE_ROUNDS; round++) {
			try (WireStream stream = openWith(header(token))) {
				assertNotNull(awaitReady(stream), "라운드 " + round + ": ready가 오지 않았다");
				Thread publisher = new Thread(() -> this.changes.publish(ChangeBus.CREATE), "stream-publisher");
				publisher.start();
				publisher.join();
				if (stream.awaitFrame((f) -> "change".equals(f.event()), Duration.ofSeconds(2)) == null) {
					lostRounds.add(round);
				}
			}
		}

		assertEquals(List.of(), lostRounds,
				"ready 수신 이후에 발생한 신호가 유실됐다(" + RACE_ROUNDS + "라운드 중 " + lostRounds.size() + "건)");
	}

	/**
	 * 항목 19 — <b>{@code open()} 성공 뒤 {@code endPrelude} 도달 전의 예외는 봉인이다.</b>
	 *
	 * <p>봉인하지 않으면 클라이언트는 헤더만 받고 <b>영원히</b> 기다리고({@code setTimeout(0)}이라 컨테이너
	 * 타임아웃이 없다) 서버는 구독과 비동기 컨텍스트를 붙든다 = 영구 침묵 + 누수. step2의 {@code Stream}
	 * 쪽 절반(M2-15)이 보지 못하는 <b>컨트롤러 절반</b>이 이 자리이며 변이 M4-14가 그것을 실증한다.
	 */
	@Test
	void anExceptionBeforeEndPreludeSealsTheStreamInsteadOfHangingIt() {
		AtomicInteger subscribersAtFailure = new AtomicInteger(-1);
		this.sse.failAfterWritePrelude(() -> {
			subscribersAtFailure.set(this.changes.subscriberCount());
			return new IllegalStateException("주입된 접속 시퀀스 장애");
		});

		try (WireStream stream = openWith(header(sessionFor("stream-r")))) {
			assertEquals(200, stream.status());
			assertNotNull(awaitReady(stream), "ready 자체는 나갔어야 한다(예외는 그 직후에 주입했다)");

			assertTrue(stream.awaitSilence(SILENCE), "봉인되지 않고 프레임이 더 나갔다");
			// 주입은 ready 바이트가 클라이언트에 닿은 뒤에 실행될 수 있다 — 침묵을 기다린 뒤에 읽는다.
			assertEquals(1, subscribersAtFailure.get(),
					"예외 시점에 구독이 없었다 — 누수 단언이 공허해진다");
			assertEquals(READY_FRAME, stream.rawBody(),
					"봉인 경로가 ready 뒤에 다른 바이트를 흘렸다(전역 에러 핸들러가 SSE 본문에 끼어들었다): "
							+ describe(stream.rawBody()));
			assertTrue(stream.closedByServer(),
					"서버가 연결을 끝내지 않았다 — 클라이언트가 영원히 기다린다(setTimeout(0)이라 "
							+ "컨테이너가 대신 정리해 주지 않는다)");
			assertEquals(0, this.changes.subscriberCount(), "봉인하지 않아 구독이 누수됐다");
		}
	}

	// --- 정적 규율 ---------------------------------------------------------------------------------

	/**
	 * push 경로의 <b>정적 그물</b> — 세션을 연장하는 인가 경로가 컨트롤러에 <b>0건</b>이고
	 * ADR-008 금지 철자도 0건이다.
	 *
	 * <p>{@code Authorization.authorize}(136행)·{@code editDps}(166행)는 둘 다 {@code touchSession}을
	 * 쓴다 — push 경로에서 부르면 ADR-005의 비연장 peek 불변식이 조용히 깨진다(계약은 green이다).
	 * JDK 25가 정식화한 {@code StructuredTaskScope}·{@code ScopedValue}·{@code Subtask}는
	 * {@code Adr008DisciplineTest}의 패턴 목록에 0건이라(이 phase는 그 게이트를 0줄 고친다) 여기서만 막힌다.
	 */
	@Test
	void theStreamControllerNeverExtendsTheSessionAndHasNoTimerOrThread() throws IOException {
		String code = COMMENTS.matcher(Files.readString(CONTROLLER_SOURCE, StandardCharsets.UTF_8))
				.replaceAll("");

		assertTrue(code.contains("peekSession"),
				"컨트롤러가 비연장 조회를 쓰지 않는다 — 스캔이 공허해진다(양성 대조)");
		for (String forbidden : List.of("touchSession", "authorize(", "editDps(")) {
			assertFalse(code.contains(forbidden),
					"push 시점 인가는 비연장 peek다(ADR-005·ADR-007) — 세션을 연장하는 호출이 있다: " + forbidden);
		}
		for (String forbidden : List.of("@Scheduled", "@Async", "@EnableAsync", "TaskScheduler", "TaskExecutor",
				"ExecutorService", "Executors.", "ScheduledFuture", "new Timer(", "Thread.sleep(", "LockSupport",
				".await(", "CompletableFuture", "CompletionStage", ".thenApply(", ".whenComplete(",
				"CountDownLatch", "new Thread(", "startVirtualThread", "Thread.ofVirtual(", "Thread.ofPlatform(",
				"StructuredTaskScope", "ScopedValue", "Subtask")) {
			assertFalse(code.contains(forbidden),
					"ADR-008 · ADR-015: 앱은 스스로 깨어나지 않는다 — 금지 철자가 있다: " + forbidden);
		}
		for (String forbidden : List.of("SseEmitter", "ResponseBodyEmitter", "StreamingResponseBody",
				"setContentType", "setContentLength")) {
			assertFalse(code.contains(forbidden),
					"SSE 와이어 지점은 SseHttp 하나다(ADR-015) — 코드에 있다: " + forbidden);
		}
	}

	// --- 훅을 심은 협력자 ---------------------------------------------------------------------------

	/**
	 * {@link ChangeBus}에 <b>구독 등록 직후</b> 훅을 끼운다 — "구독은 끝났고 ready는 아직 안 나갔다"는
	 * 창을 결정적으로 재현하는 seam이다(실제 빈의 동작은 그대로 위임한다).
	 */
	static final class HookedChangeBus extends ChangeBus {

		private final AtomicReference<Runnable> afterSubscribe = new AtomicReference<>();

		@Override
		public AutoCloseable subscribe(Listener listener) {
			AutoCloseable handle = super.subscribe(listener);
			Runnable hook = this.afterSubscribe.getAndSet(null); // 1회용 — 다음 스트림에 새지 않는다.
			if (hook != null) {
				hook.run();
			}
			return handle;
		}

		void afterSubscribe(Runnable hook) {
			this.afterSubscribe.set(hook);
		}

		void clearHooks() {
			this.afterSubscribe.set(null);
		}

	}

	/**
	 * {@link SseHttp}가 돌려주는 스트림을 감싸 <b>{@code writePrelude} 직후</b>에 훅(또는 예외)을 끼운다 —
	 * "ready는 나갔고 {@code endPrelude}는 아직"인 창을 결정적으로 재현하는 seam이다.
	 */
	static final class HookedSseHttp extends SseHttp {

		private final AtomicReference<Runnable> afterWritePrelude = new AtomicReference<>();

		private final AtomicReference<java.util.function.Supplier<RuntimeException>> failure =
				new AtomicReference<>();

		@Override
		public Stream open(HttpServletRequest request, HttpServletResponse response) {
			Stream delegate = super.open(request, response);
			return new Stream() {

				@Override
				public boolean write(byte[] frame) {
					return delegate.write(frame);
				}

				@Override
				public boolean write(byte[] frame, long orderKey) {
					return delegate.write(frame, orderKey);
				}

				@Override
				public boolean writePrelude(byte[] frame) {
					boolean written = delegate.writePrelude(frame);
					Runnable hook = HookedSseHttp.this.afterWritePrelude.getAndSet(null);
					if (hook != null) {
						hook.run();
					}
					java.util.function.Supplier<RuntimeException> fault =
							HookedSseHttp.this.failure.getAndSet(null);
					if (fault != null) {
						throw fault.get();
					}
					return written;
				}

				@Override
				public void endPrelude(long dropOrderKeyUpTo) {
					delegate.endPrelude(dropOrderKeyUpTo);
				}

				@Override
				public boolean isOpen() {
					return delegate.isOpen();
				}

				@Override
				public void close() {
					delegate.close();
				}

				@Override
				public void onClosed(Runnable callback) {
					delegate.onClosed(callback);
				}

			};
		}

		void afterWritePrelude(Runnable hook) {
			this.afterWritePrelude.set(hook);
		}

		void failAfterWritePrelude(java.util.function.Supplier<RuntimeException> fault) {
			this.failure.set(fault);
		}

		void clearHooks() {
			this.afterWritePrelude.set(null);
			this.failure.set(null);
		}

	}

	// --- 도구 -------------------------------------------------------------------------------------

	private WireStream openWith(Map<String, String> headers) {
		return WireStream.open(this.port, "/api/stream", headers);
	}

	private static Map<String, String> header(String token) {
		return Map.of(SESSION_HEADER, token);
	}

	private static WireStream.Frame awaitReady(WireStream stream) {
		return stream.awaitFrame((frame) -> "ready".equals(frame.event()), WAIT);
	}

	/** change 프레임 1건의 {@code data} 원문 — 키가 늘면(M4-1) 이 문자열이 달라져 red다. */
	private static String awaitChangeData(WireStream stream) {
		WireStream.Frame frame = stream.awaitFrame((f) -> "change".equals(f.event()), WAIT);
		assertNotNull(frame, "change 프레임이 오지 않았다");
		return frame.data();
	}

	/** 관측용 — publish 없이 컨테이너가 스스로 회수하는지 보는 자리다(항목 11(b)(c)). */
	private boolean awaitSubscriberCount(int target, Duration timeout) {
		long deadline = System.nanoTime() + timeout.toNanos();
		while (System.nanoTime() < deadline) {
			if (this.changes.subscriberCount() == target) {
				return true;
			}
			sleepQuietly();
		}
		return this.changes.subscriberCount() == target;
	}

	/** 이전 테스트가 남긴 끊긴 구독을 회수한다(publish 1회가 회수 트리거다 — decisions (12)). */
	private void awaitNoSubscribers() {
		long deadline = System.nanoTime() + Duration.ofSeconds(10).toNanos();
		while (this.changes.subscriberCount() > 0 && System.nanoTime() < deadline) {
			this.changes.publish(ChangeBus.CREATE);
			sleepQuietly();
		}
		assertEquals(0, this.changes.subscriberCount(), "이전 테스트의 구독이 회수되지 않았다");
	}

	private static void sleepQuietly() {
		try {
			Thread.sleep(50);
		}
		catch (InterruptedException ex) {
			Thread.currentThread().interrupt();
		}
	}

	private int configuredMaxWorkers() {
		Connector connector = ((TomcatWebServer) this.webServerContext.getWebServer()).getTomcat().getConnector();
		return ((AbstractProtocol<?>) connector.getProtocolHandler()).getMaxThreads();
	}

	private String createArticle(String token) {
		Wire.Response response = Wire.json(this.port, "POST", "/api/articles", Map.of(SESSION_HEADER, token),
				"{\"title\":\"" + unique("stream-title") + "\"}");
		assertEquals(200, response.status(), response.body());
		int start = response.body().indexOf("\"articleId\":\"") + "\"articleId\":\"".length();
		return response.body().substring(start, response.body().indexOf('"', start));
	}

	private Wire.Response lock(String token, String clientId, String articleId) {
		return Wire.json(this.port, "POST", "/api/articles/" + articleId + "/lock",
				Map.of(SESSION_HEADER, token, EDIT_CLIENT_HEADER, clientId), "{}");
	}

	private String sessionFor(String userId) {
		return this.sessions.createSession(userId);
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

	private static String unique(String prefix) {
		return prefix + "-" + Long.toHexString(System.nanoTime());
	}

	/** 실패 메시지에 원문을 넣을 때 개행을 보이게 만든다(빈 줄 종결자 판정을 눈으로 읽기 위함). */
	private static String describe(String raw) {
		return raw.replace("\n", "\\n").replace("\r", "\\r");
	}
}
