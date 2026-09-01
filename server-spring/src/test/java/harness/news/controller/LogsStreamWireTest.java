package harness.news.controller;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.zaxxer.hikari.HikariDataSource;
import harness.news.model.UserRepository;
import harness.news.service.FaultySessionGuard;
import harness.news.service.LogRecord;
import harness.news.service.LogService;
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
import java.sql.Connection;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;
import java.util.function.Supplier;
import java.util.regex.Matcher;
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
 * {@code GET /api/logs/stream}의 와이어 계약 — 리포 루트 {@code server/index.js} 1178~1217행과 1:1이다
 * (ADR-007 Z 전용 로그 push · ADR-015 SSE 와이어 지점).
 *
 * <h2>{@code /api/stream}과 무엇이 다른가</h2>
 * 인가 등급이 다르다: 이쪽은 <b>세션 + role Z</b>다(미인증 401은 경로 정책 필터가, <b>비-Z 403은
 * 컨트롤러가</b> 낸다 — 둘 다 스트림을 열기 <b>전</b> JSON이다). 그리고 payload가 무효화 신호가 아니라
 * <b>로그 라인 실데이터</b>다 — 게이트를 빼면 R/D가 전 사용자의 요청 흔적을 본다(정본 1162~1165행 주석).
 *
 * <h2>이 파일이 유일 방어선인 축</h2>
 * {@code contract/cases/default/logs.contract.js}(logs-stream 4관측)가 인가 2단·헤더·ready·replay·live
 * push를 본다. 그러나 <b>계약이 구조적으로 볼 수 없는 축</b>이 있고 그것이 이 클래스의 존재 이유다.
 * <ol>
 *   <li><b>구독 등록 창의 유실</b>(replay-gate · index.json decisions (15)). 계약 B-4는
 *       {@code seq > seqBefore} <b>하한만</b> 보고(그 파일 170~178행 주석이 명시한다), 그 하한은
 *       <b>replay 잔여 프레임</b>과 <b>SSE 요청 자신의 액세스 로그</b>({@code RequestLogFilter}는 async
 *       가드가 없는 plain Filter라 컨트롤러 반환 직후 {@code finally}가 돈다)로 충족된다 — 즉 유실이 있어도
 *       계약은 green이다. 아래 두 창 테스트(스냅샷 직후 · ready 직후)와
 *       {@code LogsStreamReplayWireTest}의 반복 경합이 유일한 방어선이다.</li>
 *   <li><b>push 시점 비연장 peek</b>(ADR-005·ADR-007) — 하네스는 서버 시계를 주입할 수 없다.</li>
 *   <li><b>강등·비활성·로그아웃 봉인</b>(ADR-007의 "Z 전용 봉인이 시간축에서도 유지된다").</li>
 *   <li><b>구독 누수 0 · 워커 점유 0 · 재귀 없음 · {@code endPrelude} 전 예외의 봉인</b>.</li>
 * </ol>
 *
 * <h2>CRITICAL(마스킹 — LOGS.md)</h2>
 * 이 클래스의 어떤 단언·실패 메시지도 로그 <b>실값</b>(경로·메시지·line)을 출력하지 않는다. 판정은
 * <b>키 집합·정규식·seq 숫자</b>로만 한다 — 이 버퍼는 {@code GET /api/logs/digest}로 밖으로 나가므로
 * 여기 들어간 한 조각은 곧 응답이다. 그래서 {@code StreamWireTest}가 쓰는 {@code describe(rawBody())}
 * 형태의 실패 메시지가 이 파일에는 <b>없다</b>.
 *
 * <h2>주입한 seam 넷</h2>
 * <ul>
 *   <li>{@link MutableClock} — 세션 유휴 만료 경계를 결정적으로 왕복한다.</li>
 *   <li>{@link FaultySessionGuard} — push 시점 DB 장애(peek 예외)를 재현한다.</li>
 *   <li>{@link HookedLogService} — {@code snapshot()} <b>직후</b>에 훅을 끼워 "스냅샷은 떴고 구독은
 *       아직"인 창을 결정적으로 재현한다(순서가 뒤집힌 구현에서만 유실이 난다).</li>
 *   <li>{@link HookedSseHttp} — {@code writePrelude} <b>직후</b>에 훅·예외를 끼워 "ready는 나갔고
 *       {@code endPrelude}는 아직"인 창을 재현한다.</li>
 * </ul>
 * 무작위 반복은 한가한 환경에서 창이 좁아 우연히 통과한다(2026-08-30 step4 실측) — 그래서 훅으로
 * 결정적으로 재현하고, 반복 축은 {@code LogsStreamReplayWireTest}가 버퍼 2000건 이상 구성으로 따로 돈다.
 *
 * <p>DB는 이 클래스 전용 임시 사본이고 리포 {@code news.db}는 열지 않는다.
 */
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT,
		properties = "server.tomcat.threads.max=" + LogsStreamWireTest.MAX_WORKERS_TEXT)
class LogsStreamWireTest {

	/** 애노테이션 값은 컴파일 상수여야 한다 — 아래 {@link #MAX_WORKERS}가 같은 값을 숫자로 갖는다. */
	static final String MAX_WORKERS_TEXT = "5";

	private static final int MAX_WORKERS = Integer.parseInt(MAX_WORKERS_TEXT);

	/** 워커보다 <b>많은</b> 스트림 — 이 부등식이 깨지면 워커 점유 단언이 공허해진다. */
	private static final int STREAMS_OVER_WORKERS = 8;

	/** 끊긴 소켓 회수에 허용하는 로그 발생 상한(step4 실측: 첫 write는 OS 버퍼에 성공한다). */
	private static final int RECLAIM_LOG_LIMIT = 5;

	private static final String READY_FRAME = "event: ready\ndata: {\"ok\":true}\n\n";

	private static final String UNAUTHORIZED_DATA = "{\"ok\":false,\"reason\":\"unauthenticated\"}";

	private static final String UNAUTHENTICATED_JSON = "{\"ok\":false,\"reason\":\"unauthenticated\"}";

	private static final String FORBIDDEN_JSON = "{\"ok\":false,\"reason\":\"forbidden\"}";

	private static final Duration WAIT = Duration.ofSeconds(5);

	private static final Duration SILENCE = Duration.ofSeconds(2);

	/** 드레인 판정용 정적 구간 — 이 시간 동안 새 프레임이 없으면 replay가 끝난 것으로 본다. */
	private static final Duration QUIET = Duration.ofMillis(300);

	private static final Duration DRAIN_LIMIT = Duration.ofSeconds(10);

	/** 항목 22 — "무관한 요청이 멈췄다"고 판정하기까지의 시간. 정상 경로는 밀리초 단위로 끝난다. */
	private static final Duration STALL_LIMIT = Duration.ofSeconds(5);

	/** 항목 22 — 사슬을 푼 뒤 정리에 허용하는 시간(Hikari connectionTimeout 30초보다 짧게 끝나야 한다). */
	private static final Duration RECOVERY = Duration.ofSeconds(20);

	private static final long MINUTE_MS = 60L * 1000L;

	private static final long ONE_HOUR_MS = 60L * MINUTE_MS;

	private static final String SESSION_HEADER = "x-session-id";

	private static final String PASSWORD = "logs-stream-pw";

	private static final Path DATA_DIR = TempNewsDb.newDataDir("logs-stream-wire");

	private static final MutableClock CLOCK =
			new MutableClock(Instant.parse("2026-08-30T00:00:00Z").toEpochMilli());

	private static final Path CONTROLLER_SOURCE =
			Path.of("src", "main", "java", "harness", "news", "controller", "LogsController.java");

	private static final Pattern COMMENTS = Pattern.compile("/\\*.*?\\*/|//[^\\n]*", Pattern.DOTALL);

	/**
	 * log 프레임 payload의 <b>전체</b> 계약 — 키 5개·순서·타입 + {@code line} 접두 포맷을 한 정규식으로 본다.
	 * 실값은 그룹으로도 꺼내지 않는다(마스킹).
	 */
	private static final Pattern RECORD = Pattern.compile("^\\{\"seq\":\\d+,\"ts\":\\d+,"
			+ "\"level\":\"(?:DEBUG|INFO|WARN|ERROR)\",\"message\":\"(?:[^\"\\\\]|\\\\.)*\","
			+ "\"line\":\"\\[\\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2}:\\d{2}\\] "
			+ "\\[(?:DEBUG|INFO|WARN|ERROR)\\] (?:[^\"\\\\]|\\\\.)*\"\\}$");

	/** 프레임 data의 첫 키 — {@code LogRecord.asMap()}이 {@code seq}를 맨 앞에 둔다. */
	private static final Pattern FRAME_SEQ = Pattern.compile("^\\{\"seq\":(\\d+),");

	/** 본문 원문에서 log 프레임의 seq만 뽑는다(내용은 읽지 않는다). */
	private static final Pattern BODY_LOG_SEQ = Pattern.compile("event: log\ndata: \\{\"seq\":(\\d+),");

	@TestConfiguration
	static class Seams {

		@Bean
		@Primary
		Clock mutableClock() {
			return CLOCK;
		}

		/** 이름은 {@code SessionConfig.sessionGuard}와 달라야 한다(빈 정의 덮어쓰기는 꺼져 있다). */
		@Bean
		@Primary
		FaultySessionGuard faultySessionGuard(UserRepository users, Clock clock) {
			return FaultySessionGuard.wrapping(users, clock);
		}

		@Bean
		@Primary
		HookedLogService hookedLogService(Clock clock) {
			return new HookedLogService(clock);
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
	private HookedLogService logs;

	@Autowired
	private HookedSseHttp sse;

	@Autowired
	private ServletWebServerApplicationContext webServerContext;

	/** 항목 22 전용 — 상한 1의 실제 풀에서 유일 커넥션을 꺼내 사슬을 만든다(모형이 아니다). */
	@Autowired
	private HikariDataSource dataSource;

	@BeforeEach
	void freshBaseline() {
		this.sessions.recoverPeek();
		this.sse.clearHooks();
		this.logs.clearHooks();
		// 역할·활성 상태를 매번 되돌린다 — 강등·비활성 테스트가 남긴 상태가 다음 테스트로 새지 않는다
		// (행을 지우지 않는다: DB 비파괴).
		ensureUser("ls-z", "Z");
		ensureUser("ls-d", "D");
		ensureUser("ls-demote", "Z");
		ensureUser("ls-deactivate", "Z");
		ensureUser("ls-logout", "Z");
		ensureUser("ls-peek", "Z");
		ensureUser("ls-fault", "Z");
		awaitNoSubscribers();
	}

	// --- 인가 2단(계약과 겹치는 축) ------------------------------------------------------------------

	/** 항목 1 — 미인증은 경로 정책 필터가 <b>스트림을 열기 전</b> 401 JSON으로 끝낸다. */
	@Test
	void anUnauthenticatedRequestIs401JsonAndNeverOpensTheStream() {
		Wire.Response response = Wire.send(this.port, "GET", "/api/logs/stream", Map.of(), null);

		assertEquals(401, response.status());
		assertEquals("Content-Type: application/json; charset=utf-8", response.line("content-type"));
		assertEquals(UNAUTHENTICATED_JSON, response.body());
		assertFalse(String.join("\n", response.headerLines()).toLowerCase().contains("text/event-stream"),
				"미인증인데 SSE 헤더가 나갔다: " + response.headerLines());
	}

	/**
	 * 항목 2 — <b>핵심 보안 단언</b>: 비-Z(D)는 403이고 스트림 헤더가 나가지 않는다(200이 아니다).
	 * 열고 나서 거부 프레임을 보내는 구현은 위반이다 — 그 순간 R/D가 로그 스트림에 붙는다.
	 */
	@Test
	void aNonAdminSessionIs403JsonAndNeverOpensTheStream() {
		Wire.Response response = Wire.send(this.port, "GET", "/api/logs/stream",
				Map.of(SESSION_HEADER, sessionFor("ls-d")), null);

		assertEquals(403, response.status(), "로그는 전 사용자의 요청 흔적이다 — Z가 아니면 열지 않는다");
		assertEquals("Content-Type: application/json; charset=utf-8", response.line("content-type"));
		assertEquals(FORBIDDEN_JSON, response.body());
		assertFalse(String.join("\n", response.headerLines()).toLowerCase().contains("text/event-stream"),
				"비-Z인데 SSE 헤더가 나갔다: " + response.headerLines());
	}

	/** 항목 3 — Z는 200이고 헤더 3종의 <b>원문 바이트</b>와 ready 32바이트가 {@code /api/stream}과 같다. */
	@Test
	void anAdminSessionOpensTheStreamWithTheExactHeaderBytesAndReadyFrame() {
		try (WireStream stream = openStream(sessionFor("ls-z"))) {
			assertEquals(200, stream.status());
			assertEquals("Content-Type: text/event-stream; charset=utf-8", stream.line("Content-Type"),
					"세미콜론 뒤 공백 1바이트가 계약이다(ADR-015 · RawContentType seam)");
			assertEquals("Cache-Control: no-cache", stream.line("Cache-Control"));
			assertNull(stream.line("Content-Length"),
					"본문 길이를 정하면 컨테이너가 그 바이트에서 응답을 끝내 스트림이 첫 프레임에서 닫힌다");
			assertEquals("Connection: keep-alive", stream.line("Connection"),
					"hop-by-hop 헤더는 컨테이너 소유다 — 앱이 지정하면 값이 겹친다(step4 실측)");
			assertNotNull(awaitReady(stream), "ready 프레임이 오지 않았다");
			assertEquals(32, READY_FRAME.getBytes(StandardCharsets.UTF_8).length);
			assertTrue(stream.rawBody().startsWith(READY_FRAME), "본문 첫 바이트가 ready 프레임 32바이트가 아니다");
			assertFalse(stream.rawBody().contains("\r"), "개행은 LF만이다");
		}
	}

	// --- replay · live push(계약과 겹치는 축) --------------------------------------------------------

	/** 항목 4 — 접속 시점 버퍼가 {@code log} 프레임으로 replay되고 payload는 record <b>5키</b>다. */
	@Test
	void theConnectionReplaysTheBufferAsLogFramesCarryingTheFiveKeyRecord() {
		this.logs.info("ls-replay-fixture");

		try (WireStream stream = openStream(sessionFor("ls-z"))) {
			assertNotNull(awaitReady(stream));

			WireStream.Frame replayed = stream.awaitFrame((frame) -> "log".equals(frame.event()), WAIT);

			assertNotNull(replayed, "트리거 없이 도착하는 replay log 프레임이 없다");
			assertRecordShape(replayed.data());
		}
	}

	/**
	 * 항목 5 + <b>항목 7(d)</b> — 스트림을 연 채 보낸 요청 1건이 만든 <b>바로 그 로그 줄</b>이 도착한다.
	 *
	 * <p><b>계약보다 엄격하다.</b> 계약 B-4는 {@code seq > seqBefore} 하한만 보므로 (i) 늦게 도착한
	 * replay 잔여 프레임이나 (ii) SSE 요청 자신의 액세스 로그로도 충족된다 — 유실이 있어도 통과한다.
	 * 여기서는 그 둘과 <b>구별되게</b> 단언한다:
	 * <ul>
	 *   <li><b>유니크 프로브</b>: 이번 실행에만 존재하는 경로로 요청한다. replay 잔여에는 그 경로가
	 *       있을 수 없다. <b>2026-08-30 실측</b>: {@code RequestLogFilter}(44~52행)는
	 *       {@code getRequestURI()}만 담고 {@code getQueryString()}은 계층 전체에서 정적 스캔으로 금지돼
	 *       있다 — 그래서 계획서가 제시한 "쿼리 문자열 nonce"(예: {@code ?probe=...})는 {@code line}에
	 *       <b>남지 않아 쓸 수 없다</b>. 유니크성은 <b>경로 세그먼트</b>로 만든다.</li>
	 *   <li><b>정확한 seq</b>: 프로브가 만든 레코드의 seq를 버퍼에서 읽어 그 seq의 프레임을 기다린다.
	 *       그리고 그 seq가 <b>replay 마지막 seq보다 크다</b>는 것을 함께 단언한다.</li>
	 * </ul>
	 */
	@Test
	void aRequestMadeWhileTheStreamIsOpenArrivesAsItsOwnNewLogLine() {
		String probePath = "/api/" + unique("ls-probe");

		try (WireStream stream = openStream(sessionFor("ls-z"))) {
			assertNotNull(awaitReady(stream));
			List<Long> replayed = drainReplay(stream);
			long lastReplayedSeq = replayed.isEmpty() ? -1 : replayed.get(replayed.size() - 1);

			assertEquals(404, Wire.send(this.port, "GET", probePath, Map.of(), null).status(),
					"프로브는 인벤토리 밖 경로다(액세스 로그에는 남는다)");
			long probeSeq = bufferedSeqOfPath(probePath);

			assertTrue(probeSeq > lastReplayedSeq,
					"프로브 레코드가 replay 구간 안에 있다 — replay 잔여와 구별되지 않는다"
							+ "(probeSeq=" + probeSeq + " lastReplayedSeq=" + lastReplayedSeq + ")");
			assertNotNull(stream.awaitFrame((frame) -> seqOf(frame) == probeSeq, WAIT),
					"프로브 요청이 만든 바로 그 로그 줄(seq=" + probeSeq + ")이 도착하지 않았다");
		}
	}

	// --- replay-gate(계약이 구조적으로 못 보는 축) ---------------------------------------------------

	/** 항목 7(a)(c) — {@code ready}가 첫 프레임이고 replay는 <b>오래된→최신</b>이며 같은 seq가 두 번 오지 않는다. */
	@Test
	void readyIsTheFirstFrameAndTheReplayIsStrictlyAscending() {
		this.logs.info("ls-order-fixture-1");
		this.logs.info("ls-order-fixture-2");

		try (WireStream stream = openStream(sessionFor("ls-z"))) {
			assertNotNull(awaitReady(stream));
			List<Long> seqs = drainReplay(stream);

			assertTrue(stream.rawBody().startsWith(READY_FRAME), "ready가 첫 프레임이 아니다");
			assertTrue(seqs.size() >= 2, "replay가 비어 있어 순서 단언이 공허하다(수신 log 프레임=" + seqs.size() + ")");
			assertStrictlyAscending(seqs);
		}
	}

	/**
	 * 항목 7(b) — <b>스냅샷 직후 창</b>의 유실 0(결정적 재현).
	 *
	 * <p>{@code snapshot()}이 반환된 <b>바로 그 순간</b>에 로그를 발생시킨다. 올바른 순서
	 * (구독 → 스냅샷)에서는 그 줄이 이미 등록된 구독으로 큐에 적재되지만, 스냅샷을 구독보다
	 * <b>앞</b>에 두면(M5-5e) 스냅샷에도 없고 구독도 없어 <b>영원히 유실</b>된다.
	 * 그 유실을 계약은 보지 못한다(클래스 주석).
	 */
	@Test
	void logLinesRaisedRightAfterTheSnapshotAreNotLost() {
		List<Long> raised = Collections.synchronizedList(new ArrayList<>());
		AtomicInteger hookRuns = new AtomicInteger();
		this.logs.afterSnapshot(() -> {
			raised.add(this.logs.info("ls-snapshot-window-1").seq());
			raised.add(this.logs.info("ls-snapshot-window-2").seq());
			hookRuns.incrementAndGet(); // 마지막에 올린다 — 이 값을 본 스레드는 위 목록도 본다.
		});

		try (WireStream stream = openStream(sessionFor("ls-z"))) {
			assertNotNull(awaitReady(stream));
			assertTrue(awaitHookRun(hookRuns), "스냅샷 훅이 돌지 않았다 — 이 테스트가 공허해진다");
			for (long seq : List.copyOf(raised)) {
				assertNotNull(stream.awaitFrame((frame) -> seqOf(frame) == seq, WAIT),
						"스냅샷~구독 창에서 발생한 로그(seq=" + seq + ")가 유실됐다");
			}
		}
	}

	/**
	 * 항목 7(c) — <b>스냅샷과 큐가 겹치는 구간의 중복 0</b>(결정적 재현).
	 *
	 * <p>「구독은 끝났고 스냅샷은 아직」인 창에서 발생한 줄은 <b>스냅샷(→ replay)과 prelude 큐에 둘 다</b>
	 * 들어간다. {@code endPrelude(lastReplayedSeq)}가 그 순서키 이하를 버리지 않으면(M5-5c) 같은 seq가
	 * <b>두 번</b> 나가고, 클라이언트는 로그 줄이 겹쳐 보인다.
	 *
	 * <p><b>이 테스트는 2026-08-30 변이 M5-5c가 드러낸 공백을 메운다</b>: 그때까지 이 클래스의 훅은
	 * {@code afterSnapshot}(=유실 창)뿐이라 중복 제거를 지우는 변이가 전부 green으로 통과했다.
	 * 반복 경합({@code LogsStreamReplayWireTest})도 이 창이 마이크로초라 잡지 못한다 — 훅이 유일 방어선이다.
	 */
	@Test
	void aLogLineRaisedBetweenTheSubscriptionAndTheSnapshotArrivesExactlyOnce() {
		List<Long> raised = Collections.synchronizedList(new ArrayList<>());
		AtomicInteger hookRuns = new AtomicInteger();
		this.logs.beforeSnapshot(() -> {
			raised.add(this.logs.info("ls-dedupe-window-1").seq());
			raised.add(this.logs.info("ls-dedupe-window-2").seq());
			hookRuns.incrementAndGet();
		});

		try (WireStream stream = openStream(sessionFor("ls-z"))) {
			assertNotNull(awaitReady(stream));
			assertTrue(awaitHookRun(hookRuns), "스냅샷 직전 훅이 돌지 않았다 — 이 테스트가 공허해진다");
			List<Long> received = drainReplay(stream);

			for (long seq : List.copyOf(raised)) {
				assertEquals(1, Collections.frequency(received, seq),
						"같은 seq가 두 번 나갔다 — 스냅샷과 prelude 큐가 겹치는 구간의 중복 제거가 없다"
								+ "(seq=" + seq + ")");
			}
			assertStrictlyAscending(received);
		}
	}

	/**
	 * 항목 7(b) — <b>ready 창</b>의 유실 0(결정적 재현). "구독은 끝났고 ready는 나가는 중"인 창이다.
	 *
	 * <p>구독 등록을 {@code endPrelude} 뒤로 옮기면(M5-5 = 초안의 "ready → replay → subscribe" 순서)
	 * 이 창의 로그가 구독 부재로 유실되어 여기서 red가 난다 — <b>계약은 그때도 green이다</b>.
	 */
	@Test
	void logLinesRaisedInsideTheReadyWindowAreNotLost() {
		List<Long> raised = Collections.synchronizedList(new ArrayList<>());
		AtomicInteger hookRuns = new AtomicInteger();
		this.sse.afterWritePrelude(() -> {
			raised.add(this.logs.info("ls-ready-window-1").seq());
			raised.add(this.logs.info("ls-ready-window-2").seq());
			hookRuns.incrementAndGet(); // 마지막에 올린다 — 이 값을 본 스레드는 위 목록도 본다.
		});

		try (WireStream stream = openStream(sessionFor("ls-z"))) {
			assertNotNull(awaitReady(stream));
			// 훅은 ready 바이트가 클라이언트에 닿은 뒤에 돌 수도 있다(서버가 delegate 쓰기를 먼저 한다) —
			// 그래서 ready 수신 직후가 아니라 훅 완료를 기다린 뒤에 기대 집합을 확정한다.
			assertTrue(awaitHookRun(hookRuns), "writePrelude가 불리지 않았다 — 이 테스트가 공허해진다");
			for (long seq : List.copyOf(raised)) {
				assertNotNull(stream.awaitFrame((frame) -> seqOf(frame) == seq, WAIT),
						"ready 창에서 발생한 로그(seq=" + seq + ")가 유실됐다");
			}
			assertStrictlyAscending(logSeqs(stream.rawBody()));
		}
	}

	// --- 봉인(ADR-007 — 시간축의 Z 전용) --------------------------------------------------------------

	/**
	 * 항목 8 — <b>강등(Z→D) 봉인</b>. 강등 후 발생한 로그 라인은 <b>한 줄도</b> 나가지 않고
	 * {@code unauthorized} 1회 뒤 침묵이다. ADR-007이 "Z 전용 봉인이 시간축에서도 유지된다"로 못 박은 축이며
	 * 계약은 이것을 보지 못한다(하네스가 강등 후 새 로그를 만들어 스트림을 다시 읽지 않는다).
	 */
	@Test
	void aDemotedAdminGetsNoFurtherLogLine() {
		try (WireStream stream = openStream(sessionFor("ls-demote"))) {
			assertNotNull(awaitReady(stream));
			int replayCount = drainReplay(stream).size();

			this.users.update("ls-demote", Map.of("role", "D")); // 재로그인 없음.
			long afterSeq = this.logs.info("ls-after-demotion").seq();

			assertSealedWithout(stream, afterSeq, replayCount, "강등된 세션에 로그 라인이 나갔다");
		}
	}

	/** 항목 9 — <b>비활성화 봉인</b>(가드가 세션 자체를 무효화한다 — 역할 문제가 아니다). */
	@Test
	void aDeactivatedAdminGetsNoFurtherLogLine() {
		try (WireStream stream = openStream(sessionFor("ls-deactivate"))) {
			assertNotNull(awaitReady(stream));
			int replayCount = drainReplay(stream).size();

			this.users.update("ls-deactivate", Map.of("active", "N")); // 행은 남는다(DB 비파괴).
			long afterSeq = this.logs.info("ls-after-deactivation").seq();

			assertSealedWithout(stream, afterSeq, replayCount, "비활성화된 세션에 로그 라인이 나갔다");
		}
	}

	/** 항목 10 — <b>로그아웃 봉인</b>. */
	@Test
	void aLoggedOutAdminGetsNoFurtherLogLine() {
		String token = sessionFor("ls-logout");
		try (WireStream stream = openStream(token)) {
			assertNotNull(awaitReady(stream));
			int replayCount = drainReplay(stream).size();

			assertTrue(this.sessions.invalidate(token), "세션 무효화 자체가 실패했다");
			long afterSeq = this.logs.info("ls-after-logout").seq();

			assertSealedWithout(stream, afterSeq, replayCount, "무효화된 세션에 로그 라인이 나갔다");
		}
	}

	/**
	 * 항목 11 — <b>push 재검증은 세션을 연장하지 않는다</b>(ADR-005 (b) · ADR-007).
	 *
	 * <p>{@code authorizePeek} → {@code authorize} 변이(M5-6)를 잡는 <b>행동</b> 방어선이다:
	 * {@code Authorization.authorize}(136행)는 {@code touchSession}을 쓰므로 push마다 부르면 열린
	 * 스트림 하나가 1시간 유휴 만료를 영원히 밀어낸다. 계약은 시계를 주입할 수 없어 언제나 green이다.
	 * (철자 축의 독립 방어선은 아래 정적 스캔이다 — 둘은 서로를 대체하지 않는다.)
	 */
	@Test
	void pushRevalidationNeverExtendsTheSessionExpiry() {
		String token = sessionFor("ls-peek");
		try (WireStream stream = openStream(token)) {
			assertNotNull(awaitReady(stream));
			drainReplay(stream);
			CLOCK.advance(ONE_HOUR_MS - MINUTE_MS); // 만료 1분 전.

			for (int i = 0; i < 5; i++) {
				long seq = this.logs.info("ls-peek-push-" + i).seq();
				assertNotNull(stream.awaitFrame((frame) -> seqOf(frame) == seq, WAIT),
						"push " + i + "(seq=" + seq + ")가 도착하지 않았다");
			}

			CLOCK.advance(2 * MINUTE_MS); // 원래 만료 시각을 넘겼다.
			Wire.Response session =
					Wire.send(this.port, "GET", "/api/session", Map.of(SESSION_HEADER, token), null);

			assertEquals(401, session.status(),
					"push 재검증이 세션 만료를 밀었다 — touchSession 경로(authorize/editDps)를 쓰면 열린 "
							+ "스트림이 유휴 만료를 무한 연장한다(ADR-005·ADR-007). 계약은 이 축을 보지 못한다");
		}
	}

	/**
	 * 항목 12 — <b>fail-closed</b>: 재검증이 예외를 던지면(DB 장애) 그 로그 라인을 <b>쓰지 않고</b> 봉인한다.
	 * 잡는 위치는 구독 콜백 안이다 — 가드에서 잡으면 HTTP 라우트의 DB 예외가 500 대신 401이 된다.
	 */
	@Test
	void aFailingRevalidationSealsWithoutWritingTheLogLine() {
		try (WireStream stream = openStream(sessionFor("ls-fault"))) {
			assertNotNull(awaitReady(stream));
			int replayCount = drainReplay(stream).size();
			this.sessions.failPeekWith(new IllegalStateException("주입된 세션 조회 장애"));

			long afterSeq = this.logs.info("ls-after-fault").seq();

			assertSealedWithout(stream, afterSeq, replayCount, "재검증 실패인데 로그 라인을 그대로 내보냈다");
		}
	}

	// --- 누수 0 · 워커 점유 0 · 재귀 0 ---------------------------------------------------------------

	/**
	 * 항목 13(a) — <b>서버 주도 봉인은 즉시 0</b>이다. 봉인은 {@code logs.info}를 부른 그 스레드에서
	 * 동기로 끝나므로 폴링 없이 단언할 수 있다(클라 끊김 경로는 항목 13(b)가 따로 본다 — 합치면 flaky다).
	 */
	@Test
	void aServerSideSealLeavesNoSubscriptionBehind() {
		String token = sessionFor("ls-logout");
		List<WireStream> streams = new ArrayList<>();
		try {
			for (int i = 0; i < 5; i++) {
				WireStream stream = openStream(token);
				assertNotNull(awaitReady(stream), "스트림 " + i + "가 열리지 않았다");
				drainReplay(stream);
				streams.add(stream);
			}
			assertEquals(5, this.logs.subscriberCount(), "열린 스트림 수와 구독 수가 다르다");
			// 스트림을 여는 요청 하나하나가 액세스 로그 1줄을 만들고 그 줄은 먼저 열린 스트림으로 push된다 —
			// 커서를 다시 끝으로 밀지 않으면 아래 종료 프레임 단언이 그 log 프레임을 먼저 집는다.
			streams.forEach(LogsStreamWireTest::drainReplay);
			assertTrue(this.sessions.invalidate(token), "세션 무효화 자체가 실패했다");

			this.logs.info("ls-seal-trigger");

			assertEquals(0, this.logs.subscriberCount(),
					"봉인이 끝난 시점에 구독이 남아 있다 — 종료 순서 ①구독 해제가 빠졌다");
			for (int i = 0; i < streams.size(); i++) {
				WireStream.Frame frame = streams.get(i).awaitFrame((f) -> true, WAIT);
				assertNotNull(frame, "스트림 " + i + "가 종료 프레임을 받지 못했다");
				assertEquals("unauthorized", frame.event(), "스트림 " + i + "에 로그 라인이 나갔다");
			}
		}
		finally {
			streams.forEach(WireStream::close);
		}
	}

	/**
	 * 항목 13 — <b>컨테이너 주도 종료도 구독을 거둔다</b>({@code stream.onClosed(...)} 배선).
	 * 이 테스트가 없으면 그 배선을 지워도 전부 green이다(step4 변이 M4-6 실측) — 클라 끊김은 write 실패
	 * 경로가, 세션 종료는 봉인이 각각 <b>따로</b> 구독을 거두기 때문이다.
	 */
	@Test
	void aContainerDrivenCloseAlsoDropsTheSubscription() {
		try (WireStream stream = openStream(sessionFor("ls-z"))) {
			assertNotNull(awaitReady(stream));
			assertEquals(1, this.logs.subscriberCount());
			SseHttp.Stream open = this.sse.lastStream();
			assertNotNull(open, "열린 스트림을 관측하지 못했다 — 이 테스트가 공허해진다");

			open.close(); // 컨테이너의 onComplete/onError/onTimeout이 부르는 바로 그 경로다.

			assertEquals(0, this.logs.subscriberCount(),
					"컨테이너 주도 종료에서 구독이 남았다 — onClosed 배선이 없다");
		}
	}

	/**
	 * 항목 13(b)(c) — <b>강제 끊김</b>은 "끊자마자 0"이 아니라 <b>write 실패</b>에서 회수된다
	 * ({@code setTimeout(0)}이라 컨테이너가 {@code onError}를 바로 내지 않는다 — decisions (12)).
	 *
	 * <p>(c) 관측(단언 아님): 끊은 뒤 로그 없이 1초를 기다렸을 때 회수되는지를 재서
	 * {@code reclaimedByContainer}로 남긴다 — step4의 {@code /api/stream} 실측과 같은 형태다.
	 */
	@Test
	void anAbruptlyClosedSocketIsReclaimedByAFailingWrite() {
		WireStream stream = openStream(sessionFor("ls-z"));
		assertNotNull(awaitReady(stream));
		drainReplay(stream);
		assertEquals(1, this.logs.subscriberCount());

		stream.close(); // 종료 프레임 없이 소켓만 끊는다.

		boolean reclaimedByContainer = awaitSubscriberCount(0, Duration.ofSeconds(1));
		int writes = 0;
		while (this.logs.subscriberCount() > 0 && writes < RECLAIM_LOG_LIMIT) {
			this.logs.info("ls-reclaim-" + writes);
			writes++;
			sleepQuietly();
		}

		assertEquals(0, this.logs.subscriberCount(),
				"끊긴 스트림이 로그 " + writes + "건에도 회수되지 않았다(컨테이너 자동 회수="
						+ reclaimedByContainer + ") — write 실패 → 자기 봉인 → 구독 해제 경로가 끊겼다");
	}

	/**
	 * 항목 15 — <b>워커 점유 0</b>. 열린 스트림이 워커 수보다 많아도 다른 라우트가 정상 응답한다.
	 * 기본 {@code threads.max=200}에서는 블로킹 구현도 통과하므로 상한을 {@value #MAX_WORKERS_TEXT}로 낮추고,
	 * 부등식 자체를 테스트 안에서 단언한다(공허화 방지).
	 */
	@Test
	void openStreamsDoNotOccupyWorkerThreads() {
		assertTrue(STREAMS_OVER_WORKERS > MAX_WORKERS,
				"스트림 수가 워커 수보다 많아야 이 테스트가 무언가를 증명한다");
		assertEquals(MAX_WORKERS, configuredMaxWorkers(),
				"워커 상한 프로퍼티가 실제 커넥터에 적용되지 않았다 — 단언이 공허해진다");

		String token = sessionFor("ls-z");
		List<WireStream> streams = new ArrayList<>();
		try {
			for (int i = 0; i < STREAMS_OVER_WORKERS; i++) {
				WireStream stream = openStream(token);
				assertNotNull(awaitReady(stream), "스트림 " + i + "가 열리지 않았다(워커가 잠식됐다)");
				drainReplay(stream);
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
	 * 항목 14 — <b>재귀 없음</b>. push가 다시 로그하면 통지 → 로그 → 통지의 무한 재귀가 되어
	 * 요청 1건이 버퍼를 폭주시킨다(step1 변이 M1-7이 {@code StackOverflowError}로 실증한 축).
	 */
	@Test
	void pushingALogLineDoesNotFeedTheBufferBackIntoItself() {
		try (WireStream stream = openStream(sessionFor("ls-z"))) {
			assertNotNull(awaitReady(stream));
			drainReplay(stream);
			int before = this.logs.snapshot().size();

			assertEquals(200, Wire.send(this.port, "GET", "/api/health", Map.of(), null).status());
			drainReplay(stream);

			int grew = this.logs.snapshot().size() - before;
			assertTrue(grew <= 3, "요청 1건에 버퍼가 " + grew + "줄 늘었다 — push가 자기 자신을 먹인다");
		}
	}

	/**
	 * 항목 21 — <b>{@code open()} 성공 뒤 {@code endPrelude} 도달 전의 예외는 봉인이다.</b>
	 * 이 라우트는 최대 2000 write를 도는 replay가 있어 그 구간이 가장 위험하다.
	 *
	 * <p><b>[step4 변이 M4-14 실측 — 계획서 문장 정정]</b> "{@code setTimeout(0)}이라 컨테이너가 대신
	 * 정리해 주지 않는다"는 이 컨테이너에서 <b>거짓</b>이다: 예외가 핸들러 밖으로 나가면 컨테이너가 async
	 * error dispatch로 받아 컨텍스트를 완료하고 그 완료가 {@code AsyncListener} → {@code Stream.close()}
	 * → 구독 해제로 이어진다. 그래도 앱이 스스로 봉인하는 결정은 유지한다(종료를 한 지점으로 모은다) —
	 * 와이어로 구별되지 않는 그 결정은 아래 정적 그물이 잠근다.
	 *
	 * <p>봉인이 {@code unauthorized}를 <b>내보내지 않는</b> 것도 계약이다: prelude 구간의 {@code write}는
	 * 큐에 적재되고 {@code close()}가 큐를 폐기한다(step2 불변식 3). 클라이언트는 연결 종료로 안다.
	 */
	@Test
	void anExceptionBeforeEndPreludeSealsTheStreamInsteadOfHangingIt() {
		AtomicInteger subscribersAtFailure = new AtomicInteger(-1);
		this.logs.info("ls-seal-replay-fixture");
		this.sse.failAfterWritePrelude(2, () -> {
			subscribersAtFailure.set(this.logs.subscriberCount());
			return new IllegalStateException("주입된 replay 직렬화 장애");
		});

		try (WireStream stream = openStream(sessionFor("ls-z"))) {
			assertEquals(200, stream.status());
			assertNotNull(awaitReady(stream), "ready 자체는 나갔어야 한다(예외는 replay 도중에 주입했다)");
			// 예외 직전까지 나간 replay 프레임을 흘려보낸 뒤에 "그 뒤로 침묵"을 본다.
			drainReplay(stream);

			assertTrue(stream.awaitSilence(SILENCE), "봉인되지 않고 프레임이 더 나갔다");
			assertEquals(1, subscribersAtFailure.get(), "예외 시점에 구독이 없었다 — 누수 단언이 공허해진다");
			assertTrue(stream.closedByServer(), "서버가 연결을 끝내지 않았다 — 클라이언트가 영원히 기다린다");
			assertEquals(0, this.logs.subscriberCount(), "봉인하지 않아 구독이 누수됐다");
		}
	}

	/**
	 * 항목 22 — <b>유일 커넥션을 기다리는 push가 다른 모든 요청을 세우지 않는다</b>
	 * (2026-09-01 ⑤ 코드리뷰 high 폐색 · ADR-015 트레이드오프 정정).
	 *
	 * <h2>재현하는 사슬(전부 실물이다)</h2>
	 * <ol>
	 *   <li>스트림 1개가 붙어 있다 → 구독 콜백은 {@code authorizePeek} → {@code SessionGuard.peekSession}
	 *       → {@code users.findById}로 <b>DB를 읽는다</b>.</li>
	 *   <li>테스트가 실제 {@link HikariDataSource}에서 <b>유일 커넥션</b>을 꺼내 쥔다
	 *       ({@code NewsDataSource.MAX_POOL_SIZE = 1}) — {@code ArticleEmbargoService}의
	 *       {@code transactions.executeWithoutResult} 안에 있는 스레드와 같은 상태다.</li>
	 *   <li>요청 하나가 끝나면 {@code RequestLogFilter}의 {@code finally}가 로그를 남기고, 그 통지의
	 *       구독 콜백이 <b>커넥션 대기 큐</b>에 들어간다(Hikari {@code connectionTimeout} 30초).</li>
	 *   <li>그동안 <b>다른 요청</b>을 보낸다. 통지가 전역 락 안에서 돌면 이 요청도 자기 {@code finally}에서
	 *       그 락을 기다리며 멈춘다 — 스트림 하나 때문에 <b>서버 전체가 정지</b>한다.</li>
	 * </ol>
	 * {@code /api/health}를 쓰는 이유: 인증 0회·DB 0회라 <b>막히는 자리가 {@code finally} 하나뿐</b>이다
	 * (다른 라우트로 재면 DB 대기와 락 대기가 섞여 무엇이 막았는지 구별되지 않는다).
	 *
	 * <p>계약은 이 축을 보지 못한다 — 하네스는 커넥션을 고갈시키지도, 소비자를 멈춰 세우지도 않는다.
	 * <b>이 항목과 {@code LogServiceTest} 항목 5c·5d가 유일 방어선이다.</b>
	 */
	@Test
	void aPushWaitingForTheOnlyDbConnectionDoesNotStallEveryOtherRequest() throws Exception {
		try (WireStream stream = openStream(sessionFor("ls-z"))) {
			assertNotNull(awaitReady(stream));
			drainReplay(stream);

			Connection held = this.dataSource.getConnection(); // 트랜잭션이 유일 커넥션을 쥔 상태.
			Thread stalled = new Thread(() -> Wire.send(this.port, "GET", "/api/health", Map.of(), null));
			AtomicInteger secondStatus = new AtomicInteger(-1);
			Thread second = new Thread(() -> secondStatus
					.set(Wire.send(this.port, "GET", "/api/health", Map.of(), null).status()));
			boolean everythingStalled;
			try {
				stalled.start();
				awaitConnectionWaiter(); // push가 커넥션 대기 큐에 들어갔다 — 여기부터가 사슬이다.

				second.start();
				second.join(STALL_LIMIT.toMillis());
				everythingStalled = second.isAlive();
			}
			finally {
				held.close(); // 트랜잭션이 커밋하고 커넥션을 돌려준다 — 사슬을 푼다.
				second.join(RECOVERY.toMillis());
				stalled.join(RECOVERY.toMillis());
			}

			assertFalse(everythingStalled, "로그 스트림 1개 + 커넥션 경합만으로 무관한 요청이 "
					+ STALL_LIMIT.toMillis() + "ms 넘게 멈췄다 — 통지가 전역 락 안에서 DB를 기다린다");
			assertEquals(200, secondStatus.get(), "막히지는 않았지만 응답이 정상이 아니다");
		}
	}

	// --- 정적 규율 ----------------------------------------------------------------------------------

	/**
	 * 항목 17(a)(b) + 항목 14의 정적 절반 — <b>push 경로의 그물</b>.
	 *
	 * <h2>판정 근거(왜 "파일 전체 {@code authorize(} 1회"가 아닌가)</h2>
	 * 이 컨트롤러에는 <b>접속 게이트가 둘</b>이다({@code GET /api/logs/digest}와
	 * {@code GET /api/logs/stream}) — 그 자리의 {@code authorize(}는 <b>연장이 정상인 실제 요청</b>이라
	 * 허용이다. 그래서 파일 전체 호출 수는 <b>2</b>이고, 금지 판정은 <b>push 콜백의 소스 범위</b>를 잘라서 한다.
	 *
	 * <p>행동 단언(항목 11)이 있는데도 철자 스캔을 따로 두는 이유: 누군가 {@code authorize}를 되돌려 놓고
	 * 시계 주입 테스트를 약화시키면 행동 축은 조용히 통과한다. <b>두 방어선은 서로를 대체하지 않는다</b>
	 * (M5-6c가 그 사실을 실증한다).
	 *
	 * <p>JDK 25가 정식화한 {@code StructuredTaskScope}·{@code ScopedValue}·{@code Subtask}는
	 * {@code Adr008DisciplineTest}의 5군 패턴에 <b>0건</b>이라(이 phase는 그 게이트를 0줄 고친다)
	 * 여기서만 막힌다 — <b>게이트 통과는 허가가 아니다</b>.
	 */
	@Test
	void theLogsControllerUsesNonExtendingPeekOnThePushPathAndHasNoTimerOrThread() throws IOException {
		String code = COMMENTS.matcher(Files.readString(CONTROLLER_SOURCE, StandardCharsets.UTF_8))
				.replaceAll("");

		assertEquals(2, countOf(code, "authorize("),
				"접속 게이트는 digest·stream 둘뿐이다 — authorize(가 늘었다면 push 경로에 샜을 수 있다");
		String push = methodBody(code, "private void push(");
		assertTrue(push.contains("authorizePeek("),
				"push 경로가 비연장 판정을 쓰지 않는다 — 스캔이 공허해진다(양성 대조)");
		for (String forbidden : List.of("touchSession", "authorize(", "editDps(")) {
			assertFalse(push.contains(forbidden),
					"push 시점 인가는 비연장 peek다(ADR-005·ADR-007) — 세션을 연장하는 호출이 있다: " + forbidden);
		}
		for (String forbidden : List.of("logs.info(", "logs.warn(", "logs.error(", "logs.debug(")) {
			assertFalse(push.contains(forbidden),
					"구독 콜백이 로그를 남기면 통지 → 로그 → 통지의 무한 재귀다: " + forbidden);
		}

		String handler = methodBody(code, "public void stream(");
		assertTrue(handler.contains("catch (RuntimeException"),
				"open()~endPrelude 구간의 봉인 catch가 사라졌다 — 종료는 컨테이너 에러 처리가 아니라 "
						+ "앱의 한 지점(SseCloser.seal)으로 수렴해야 한다(step4 M4-14 실측: 이 축은 "
						+ "와이어로 구별되지 않는다)");
		assertTrue(handler.contains("endPrelude("), "endPrelude를 부르지 않으면 스트림이 영원히 침묵한다");

		// "@Scheduled"가 아니라 "Scheduled"를 막는 이유(2026-08-30 변이 M5-9 실측): 완전 수식
		// 애노테이션(@org.springframework.scheduling.annotation.Scheduled)은 "@Scheduled"를 포함하지 않아
		// 이 스캔을 그대로 통과했다(그때 red를 낸 것은 Adr008DisciplineTest뿐이었다).
		for (String forbidden : List.of("Scheduled", "@Async", "@EnableAsync", "TaskScheduler", "TaskExecutor",
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
		assertFalse(code.contains("\"Z\""),
				"역할 문자열을 컨트롤러에 복제하지 마라 — 판정은 Authorization의 CAPABILITIES 표 하나다");
	}

	// --- 훅을 심은 협력자 ----------------------------------------------------------------------------

	/**
	 * {@link LogService}에 <b>{@code snapshot()} 직후</b> 훅을 끼운다 — "스냅샷은 떴고 구독은 아직"인 창을
	 * 결정적으로 재현하는 seam이다(실제 버퍼 동작은 그대로 위임한다).
	 */
	static final class HookedLogService extends LogService {

		private final AtomicReference<Runnable> beforeSnapshot = new AtomicReference<>();

		private final AtomicReference<Runnable> afterSnapshot = new AtomicReference<>();

		HookedLogService(Clock clock) {
			super(clock, LogService.DEFAULT_CAP, LogService.KST_OFFSET_MINUTES);
		}

		@Override
		public List<LogRecord> snapshot() {
			// 두 훅은 서로 다른 창이다: before = 「구독은 끝났고 스냅샷은 아직」(그 줄은 스냅샷과 큐에
			// 둘 다 들어간다 → 중복 제거 대상) · after = 「스냅샷은 떴고 그 뒤」(큐에만 들어간다 → 유실 대상).
			runOnce(this.beforeSnapshot);
			List<LogRecord> snapshot = super.snapshot();
			runOnce(this.afterSnapshot);
			return snapshot;
		}

		void beforeSnapshot(Runnable hook) {
			this.beforeSnapshot.set(hook);
		}

		void afterSnapshot(Runnable hook) {
			this.afterSnapshot.set(hook);
		}

		void clearHooks() {
			this.beforeSnapshot.set(null);
			this.afterSnapshot.set(null);
		}

		/** 1회용 — 다음 스트림에 새지 않는다. */
		private static void runOnce(AtomicReference<Runnable> slot) {
			Runnable hook = slot.getAndSet(null);
			if (hook != null) {
				hook.run();
			}
		}

	}

	/**
	 * {@link SseHttp}가 돌려주는 스트림을 감싸 <b>{@code writePrelude} 직후</b>에 훅(또는 예외)을 끼운다 —
	 * "ready·replay는 나갔고 {@code endPrelude}는 아직"인 창을 결정적으로 재현하는 seam이다.
	 */
	static final class HookedSseHttp extends SseHttp {

		private final AtomicReference<Runnable> afterWritePrelude = new AtomicReference<>();

		private final AtomicReference<Supplier<RuntimeException>> failure = new AtomicReference<>();

		private final AtomicInteger failAfter = new AtomicInteger(-1);

		/** 마지막으로 연 스트림 — 컨테이너 주도 종료 경로를 직접 태우는 관측 지점이다. */
		private final AtomicReference<Stream> lastStream = new AtomicReference<>();

		@Override
		public Stream open(HttpServletRequest request, HttpServletResponse response) {
			Stream delegate = super.open(request, response);
			Stream wrapper = new Stream() {

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
					if (HookedSseHttp.this.failAfter.get() > 0
							&& HookedSseHttp.this.failAfter.decrementAndGet() == 0) {
						Supplier<RuntimeException> fault = HookedSseHttp.this.failure.getAndSet(null);
						if (fault != null) {
							throw fault.get();
						}
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
			this.lastStream.set(wrapper);
			return wrapper;
		}

		void afterWritePrelude(Runnable hook) {
			this.afterWritePrelude.set(hook);
		}

		/** {@code writes}번째 {@code writePrelude} 호출 직후에 예외를 던진다(1 = ready 직후). */
		void failAfterWritePrelude(int writes, Supplier<RuntimeException> fault) {
			this.failure.set(fault);
			this.failAfter.set(writes);
		}

		Stream lastStream() {
			return this.lastStream.get();
		}

		void clearHooks() {
			this.afterWritePrelude.set(null);
			this.failure.set(null);
			this.failAfter.set(-1);
			this.lastStream.set(null);
		}

	}

	// --- 도구 ---------------------------------------------------------------------------------------

	private WireStream openStream(String token) {
		return WireStream.open(this.port, "/api/logs/stream", Map.of(SESSION_HEADER, token));
	}

	private static WireStream.Frame awaitReady(WireStream stream) {
		return stream.awaitFrame((frame) -> "ready".equals(frame.event()), WAIT);
	}

	/**
	 * replay가 멈출 때까지 읽고 <b>커서를 끝으로 민다</b>(다음 {@code awaitFrame}이 replay 잔여를 보지
	 * 않게 한다 — 봉인 단언이 log 프레임을 종료 프레임으로 착각하면 그 테스트는 공허하다).
	 *
	 * @return 지금까지 받은 log 프레임의 seq(오래된→최신)
	 */
	private static List<Long> drainReplay(WireStream stream) {
		long deadline = System.nanoTime() + DRAIN_LIMIT.toNanos();
		while (System.nanoTime() < deadline && !stream.awaitSilence(QUIET)) {
			// 아직 흘러오는 중이다.
		}
		stream.awaitFrame((frame) -> false, Duration.ZERO);
		return logSeqs(stream.rawBody());
	}

	/**
	 * 봉인 단언 — ① 다음 프레임이 {@code unauthorized}이고 ② 그 뒤 침묵이며 ③ 봉인 계기가 된 로그 라인이
	 * <b>한 줄도</b> 실리지 않았고 ④ 구독이 남지 않았다.
	 */
	private void assertSealedWithout(WireStream stream, long forbiddenSeq, int replayCount, String message) {
		WireStream.Frame frame = stream.awaitFrame((f) -> true, WAIT);

		assertNotNull(frame, "종료 프레임이 오지 않았다");
		assertEquals("unauthorized", frame.event(), message);
		assertEquals(UNAUTHORIZED_DATA, frame.data());
		assertTrue(stream.awaitSilence(SILENCE), "봉인 이후에 프레임이 더 나갔다");
		List<Long> seqs = logSeqs(stream.rawBody());
		assertEquals(replayCount, seqs.size(), message + "(log 프레임 수가 늘었다)");
		assertFalse(seqs.contains(forbiddenSeq), message + "(seq=" + forbiddenSeq + ")");
		assertEquals(0, this.logs.subscriberCount(), "봉인했는데 구독이 남았다");
	}

	private static void assertRecordShape(String data) {
		assertNotNull(data, "log 프레임에 data가 없다");
		assertTrue(RECORD.matcher(data).matches(),
				"log 프레임 payload가 record 5키(seq·ts·level·message·line)와 line 접두 포맷을 지키지 않는다"
						+ "(마스킹: 실값 미출력)");
	}

	private static void assertStrictlyAscending(List<Long> seqs) {
		for (int i = 1; i < seqs.size(); i++) {
			assertTrue(seqs.get(i) > seqs.get(i - 1),
					"seq가 엄격 증가가 아니다(중복 또는 역전) — 위치 " + i + ": " + seqs.get(i - 1) + " → " + seqs.get(i));
		}
	}

	private static long seqOf(WireStream.Frame frame) {
		if (frame == null || !"log".equals(frame.event()) || frame.data() == null) {
			return -1;
		}
		Matcher matcher = FRAME_SEQ.matcher(frame.data());
		return matcher.find() ? Long.parseLong(matcher.group(1)) : -1;
	}

	private static List<Long> logSeqs(String rawBody) {
		List<Long> seqs = new ArrayList<>();
		Matcher matcher = BODY_LOG_SEQ.matcher(rawBody);
		while (matcher.find()) {
			seqs.add(Long.parseLong(matcher.group(1)));
		}
		return seqs;
	}

	/** 버퍼에서 그 경로의 액세스 로그 레코드를 찾아 <b>seq만</b> 돌려준다(내용은 밖으로 내보내지 않는다). */
	private long bufferedSeqOfPath(String path) {
		long found = -1;
		for (LogRecord record : this.logs.snapshot()) {
			if (record.message().contains(path)) {
				found = record.seq();
			}
		}
		assertTrue(found > 0, "프로브 요청의 액세스 로그가 버퍼에 없다 — 이 테스트가 공허해진다");
		return found;
	}

	private static int countOf(String text, String needle) {
		int count = 0;
		int from = 0;
		while ((from = text.indexOf(needle, from)) >= 0) {
			count++;
			from += needle.length();
		}
		return count;
	}

	/** 주석을 지운 소스에서 메서드 하나의 본문을 잘라낸다(선언 → 첫 최상위 닫는 중괄호). */
	private static String methodBody(String code, String declaration) {
		int start = code.indexOf(declaration);
		assertTrue(start >= 0, "소스에서 " + declaration + "를 찾지 못했다 — 스캔이 공허해진다");
		String tail = code.substring(start);
		int end = tail.indexOf("\n\t}");
		assertTrue(end > 0, "메서드 끝을 찾지 못했다 — 스캔이 공허해진다");
		return tail.substring(0, end);
	}

	/** 훅은 서버 스레드에서 돈다 — 값이 1이 되는 것을 데드라인 안에서 기다린다(단언은 호출자가 한다). */
	private static boolean awaitHookRun(AtomicInteger hookRuns) {
		long deadline = System.nanoTime() + WAIT.toNanos();
		while (System.nanoTime() < deadline) {
			if (hookRuns.get() == 1) {
				return true;
			}
			sleepQuietly();
		}
		return hookRuns.get() == 1;
	}

	private boolean awaitSubscriberCount(int target, Duration timeout) {
		long deadline = System.nanoTime() + timeout.toNanos();
		while (System.nanoTime() < deadline) {
			if (this.logs.subscriberCount() == target) {
				return true;
			}
			sleepQuietly();
		}
		return this.logs.subscriberCount() == target;
	}

	/**
	 * push 콜백이 <b>실제로</b> 커넥션 대기 큐에 들어갈 때까지 기다린다(항목 22).
	 * 이 확인이 없으면 사슬이 성립하기 전에 두 번째 요청을 보내 테스트가 공허해진다.
	 */
	private void awaitConnectionWaiter() {
		long deadline = System.nanoTime() + RECOVERY.toNanos();
		while (this.dataSource.getHikariPoolMXBean().getThreadsAwaitingConnection() < 1
				&& System.nanoTime() < deadline) {
			sleepQuietly();
		}
		assertTrue(this.dataSource.getHikariPoolMXBean().getThreadsAwaitingConnection() >= 1,
				"구독 콜백이 커넥션을 기다리지 않는다 — 사슬이 성립하지 않아 이 테스트가 공허해진다");
	}

	/** 이전 테스트가 남긴 끊긴 구독을 회수한다(로그 1건이 회수 트리거다 — decisions (12)). */
	private void awaitNoSubscribers() {
		long deadline = System.nanoTime() + Duration.ofSeconds(10).toNanos();
		while (this.logs.subscriberCount() > 0 && System.nanoTime() < deadline) {
			this.logs.info("ls-baseline-reclaim");
			sleepQuietly();
		}
		assertEquals(0, this.logs.subscriberCount(), "이전 테스트의 구독이 회수되지 않았다");
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

	private String sessionFor(String userId) {
		return this.sessions.createSession(userId);
	}

	/** 픽스처는 멱등이고 <b>상태를 되돌린다</b> — 행을 지우지 않는다(DB 비파괴). */
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
			// 이미 있다 — 아래에서 역할·활성 상태만 되돌린다.
		}
		Map<String, Object> restore = new LinkedHashMap<>();
		restore.put("role", role);
		restore.put("active", "Y");
		this.users.update(userId, restore);
	}

	private static String unique(String prefix) {
		return prefix + "-" + Long.toHexString(System.nanoTime());
	}
}
