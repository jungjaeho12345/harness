package harness.news.controller;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import harness.news.service.LogRecord;
import harness.news.service.LogService;
import harness.news.service.SessionGuard;
import harness.news.service.UserService;
import harness.news.testsupport.TempNewsDb;
import harness.news.testsupport.WireStream;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.time.Duration;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.locks.LockSupport;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.MethodOrderer;
import org.junit.jupiter.api.Order;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.TestMethodOrder;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;

/**
 * {@code GET /api/logs/stream}의 <b>부하 축</b> — 버퍼가 replay 상한(2000)을 넘긴 상태에서만 성립하는
 * 세 가지를 본다: ① replay 상한과 절단 방향 ② 반복 경합의 유실·중복·역전 0 ③ <b>블로킹 소비자 관측</b>.
 *
 * <h2>왜 {@link LogsStreamWireTest}와 파일이 다른가(격리 근거)</h2>
 * 여기서는 링 버퍼에 <b>2500건 이상</b>을 쌓는다. 그러면 접속마다 replay가 약 400 KB를 쓰는데,
 * <b>프레임을 읽지 않는 클라이언트</b>가 하나라도 있으면 {@code ServletOutputStream#write}가 소켓 버퍼에서
 * 블로킹되고 그 스레드는 스트림의 write monitor를 쥔 채 멈춘다 — 같은 컨텍스트의 다른 테스트가 그 상태에
 * 걸리면 전부 타임아웃한다. 그래서 <b>{@code app.data-dir}가 다른 별도 컨텍스트</b>로 격리하고
 * (스프링 테스트 컨텍스트 캐시 키가 갈린다) 위험한 관측을 {@link Order}로 <b>맨 뒤</b>에 둔다.
 * 두 파일 모두 리포 {@code news.db}는 열지 않는다(전용 임시 사본).
 *
 * <h2>CRITICAL(마스킹 — LOGS.md)</h2>
 * 판정은 <b>seq 숫자와 개수</b>로만 한다. 로그 실값은 단언에도 실패 메시지에도 싣지 않는다.
 */
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
@TestMethodOrder(MethodOrderer.OrderAnnotation.class)
class LogsStreamReplayWireTest {

	/** 정본 {@code server/index.js} 1178행 {@code LOG_REPLAY_MAX}와 같은 값이다. */
	private static final int REPLAY_MAX = 2000;

	/** 상한보다 <b>많이</b> 쌓아야 절단 방향(최근 우선)을 볼 수 있다. */
	private static final int PREFILL = 2500;

	/** 경합 반복 횟수 — 1회 실행은 증거가 아니다(index.json decisions (15)). */
	private static final int RACE_ROUNDS = 50;

	/** 라운드마다 접속 창에 흘려 넣는 로그 줄 수. */
	private static final int MARKERS_PER_ROUND = 40;

	/** 마커 간격(ns) — {@code Thread.sleep(1)}은 Windows에서 15 ms로 튀어 라운드가 통째로 느려진다. */
	private static final long MARKER_GAP_NANOS = 500_000L;

	/** 블로킹 관측에서 읽지 않는 소비자에게 밀어 넣는 로그 줄 수(약 200 B/줄 — 소켓 버퍼를 채우는 양). */
	private static final int FLOOD_LINES = 30_000;

	/** 그 발생이 멈췄는지 판정하는 관측 한도 — 넘으면 "정지 미관측"으로 기록한다. */
	private static final Duration FLOOD_STALL_LIMIT = Duration.ofSeconds(10);

	private static final String SESSION_HEADER = "x-session-id";

	private static final String ADMIN = "lsr-z";

	private static final String PASSWORD = "logs-stream-replay-pw";

	private static final Duration WAIT = Duration.ofSeconds(10);

	private static final Duration QUIET = Duration.ofMillis(300);

	private static final Duration DRAIN_LIMIT = Duration.ofSeconds(30);

	private static final Duration RECOVERY = Duration.ofSeconds(30);

	private static final Path DATA_DIR = TempNewsDb.newDataDir("logs-stream-replay");

	private static final Pattern BODY_LOG_SEQ = Pattern.compile("event: log\ndata: \\{\"seq\":(\\d+),");

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

	@Autowired
	private LogService logs;

	@BeforeEach
	void seedBufferAndFixtures() {
		ensureUser(ADMIN, "Z");
		while (this.logs.snapshot().size() < PREFILL) {
			this.logs.info("lsr-prefill");
		}
		awaitNoSubscribers();
	}

	/**
	 * 항목 6 — <b>replay 상한은 2000이고 잘리는 쪽은 오래된 줄</b>이다(정본 {@code slice(-LOG_REPLAY_MAX)}).
	 *
	 * <p>계약은 이 축을 보지 못한다: {@code logs.contract.js} B-3은 "log 프레임이 하나라도 오면" 통과한다.
	 * 상한을 지우면 갓 접속한 클라이언트가 버퍼 cap(10000) 전체를 받아 첫 렌더와 대역폭이 5배가 된다.
	 *
	 * <p>판정 경계는 <b>접속 직전의 최신 seq</b>다 — 그보다 큰 seq는 live push(이 요청 자신의 액세스 로그
	 * 포함)라 replay 개수에 넣으면 안 된다.
	 */
	@Test
	@Order(1)
	void theReplayIsCappedAtTwoThousandAndKeepsTheNewest() {
		List<LogRecord> buffered = this.logs.snapshot();
		assertTrue(buffered.size() > REPLAY_MAX,
				"버퍼가 상한보다 커야 절단을 관측할 수 있다(현재 " + buffered.size() + "건)");
		long newest = buffered.get(buffered.size() - 1).seq();
		long oldest = buffered.get(0).seq();

		try (WireStream stream = openStream(sessionFor())) {
			assertNotNull(awaitReady(stream), "ready 프레임이 오지 않았다");
			List<Long> replayed = drain(stream).stream().filter((seq) -> seq <= newest).toList();

			assertEquals(REPLAY_MAX, replayed.size(),
					"접속 replay는 정확히 최근 " + REPLAY_MAX + "건이다(버퍼=" + buffered.size() + "건)");
			assertEquals(newest, replayed.get(replayed.size() - 1).longValue(), "가장 최신 줄이 빠졌다");
			assertEquals(newest - REPLAY_MAX + 1, replayed.get(0).longValue(),
					"잘리는 쪽이 반대다 — 최근 " + REPLAY_MAX + "건이어야 한다");
			assertTrue(replayed.get(0) > oldest, "가장 오래된 줄이 replay에 실렸다");
		}
	}

	/**
	 * 항목 7(b)(c) — <b>접속 창의 유실 0 · 중복 0 · 역전 0</b>을 {@value #RACE_ROUNDS}회 반복으로 본다.
	 *
	 * <p>버퍼가 2000건을 넘으므로 replay는 매 라운드 2000 write를 돌고, 그동안 <b>다른 스레드</b>가
	 * {@value #MARKERS_PER_ROUND}줄을 계속 발생시킨다. 구독을 {@code endPrelude} 뒤로 옮기거나(M5-5)
	 * 스냅샷을 구독 앞에 두면(M5-5e) 그 창의 줄이 사라진다.
	 *
	 * <p><b>계약은 이 유실을 보지 못한다</b> — B-4는 {@code seq > seqBefore} 하한만 보고 그 하한은 replay
	 * 잔여와 SSE 요청 자신의 액세스 로그로 충족된다. 여기서는 발생한 <b>바로 그 seq 집합</b>을 전수 대조한다.
	 */
	@Test
	@Order(2)
	void fiftyRoundsOfConnectingWhileLoggingLoseNothing() throws InterruptedException {
		String token = sessionFor();
		List<String> failures = new ArrayList<>();
		int lost = 0;
		int duplicated = 0;

		for (int round = 0; round < RACE_ROUNDS; round++) {
			List<Long> raised = Collections.synchronizedList(new ArrayList<>());
			Thread logger = new Thread(() -> {
				for (int i = 0; i < MARKERS_PER_ROUND; i++) {
					raised.add(this.logs.info("lsr-race-marker").seq());
					LockSupport.parkNanos(MARKER_GAP_NANOS);
				}
			}, "logs-stream-race");
			logger.start();

			try (WireStream stream = openStream(token)) {
				assertNotNull(awaitReady(stream), "라운드 " + round + ": ready가 오지 않았다");
				logger.join(); // 기대 집합을 확정한 뒤에 판정한다.
				List<Long> expected = List.copyOf(raised);
				List<Long> received = readUntilAllArrived(stream, expected);

				Set<Long> arrived = new HashSet<>(received);
				int missingHere = 0;
				int duplicatedHere = 0;
				for (long seq : expected) {
					if (!arrived.contains(seq)) {
						missingHere++;
					}
					if (Collections.frequency(received, seq) > 1) {
						duplicatedHere++;
					}
				}
				lost += missingHere;
				duplicated += duplicatedHere;
				if (missingHere > 0 || duplicatedHere > 0) {
					failures.add("라운드 " + round + "(유실 " + missingHere + " · 중복 " + duplicatedHere + ")");
				}
				assertAscending(received, round);
			}
			finally {
				logger.join();
			}
		}

		assertEquals(List.of(), failures,
				"접속 창에서 발생한 로그가 유실/중복됐다 — 총 유실 " + lost + " · 총 중복 " + duplicated
						+ "(" + RACE_ROUNDS + "라운드 × " + MARKERS_PER_ROUND + "줄)");
	}

	/**
	 * 항목 20 — <b>블로킹 소비자 1개가 서버 전체에 미치는 영향은 단언이 아니라 관측이다.</b>
	 *
	 * <p>Node {@code res.write}는 논블로킹 버퍼링이지만 {@code ServletOutputStream#write}는 <b>블로킹</b>이다.
	 * 프레임을 한 바이트도 읽지 않는 소비자가 붙으면 replay 도중 write가 소켓 버퍼에서 멈추고, 그 스레드는
	 * 스트림의 write monitor를 쥔다. 그 상태에서 다른 요청이 끝나면 {@code RequestLogFilter}의
	 * {@code finally} → {@code LogService.log} → {@code notifyLock} → 구독 콜백 write가 그 monitor를
	 * 기다리므로 <b>모든 요청의 액세스 로그가 대기</b>할 수 있다(= 서버 전체 정지).
	 *
	 * <p><b>2026-08-30 실측(Windows · 이 컨테이너)</b>: 읽지 않는 소비자 하나가 약 <b>15,000줄(≈3 MB)</b>을
	 * 소켓 버퍼로 흡수한 뒤에야 push가 1초 이상 멈췄고(그전까지는 정지가 관측되지 않는다), 그 상태에서도
	 * {@code GET /api/health}는 <b>수 ms 안에 응답</b>했으며 다른 요청의 액세스 로그도 계속 쌓였다
	 * (아래 출력의 "정지 중 액세스 로그 진행" 줄). 즉 <b>서버 전체 정지는 재현되지 않았고</b> 관측된 것은
	 * push 처리량의 급락이다 — 응답이 액세스 로그보다 <b>먼저</b> 커밋되기 때문에 클라이언트가 보는 지연도
	 * 없었다. 이 수치는 {@code forward_notes}로 인계한다(측정값이지 계약이 아니다 — 단언하지 않는다).
	 *
	 * <p><b>정지가 관측되어도 결함으로 보고하지 않는다</b> — 해법(비블로킹 write · write 타임아웃 ·
	 * 동시 연결 상한)은 전부 이 phase의 금지 철자(ADR-008)이거나 {@code excluded (d)}가 배제한 축이다.
	 * 여기서 <b>단언</b>하는 것은 두 가지뿐이다:
	 * ① 관측 전제(버퍼가 상한을 넘고 구독이 실제로 등록됐다) ② <b>소비자를 끊으면 서버가 회복된다</b>
	 * (write 실패 → 자기 봉인 → 구독 해제 → 락 해제). 모든 대기에는 데드라인이 있다.
	 */
	@Test
	@Order(3)
	void aBlockedConsumerIsObservedWithADeadlineNotAsserted() throws Exception {
		assertTrue(this.logs.snapshot().size() > REPLAY_MAX,
				"replay가 커야 소켓 버퍼를 채우기 쉽다 — 관측 전제가 깨졌다");
		String token = sessionFor();
		AtomicInteger flooded = new AtomicInteger();
		AtomicBoolean stop = new AtomicBoolean();
		boolean answered;
		boolean floodStalled;
		long elapsedMs;
		long seqBefore;
		long seqAfter;

		Socket blocked = new Socket();
		Thread flooder = new Thread(() -> {
			for (int i = 0; i < FLOOD_LINES && !stop.get(); i++) {
				this.logs.info("lsr-flood");
				flooded.incrementAndGet();
			}
		}, "logs-stream-flood");
		try {
			blocked.connect(new InetSocketAddress("127.0.0.1", this.port), 5000);
			OutputStream out = blocked.getOutputStream();
			out.write(("GET /api/logs/stream HTTP/1.1\r\nHost: 127.0.0.1:" + this.port + "\r\n"
					+ "Connection: keep-alive\r\n" + SESSION_HEADER + ": " + token + "\r\n\r\n")
					.getBytes(StandardCharsets.ISO_8859_1));
			out.flush();
			assertTrue(awaitSubscriberCount(1, WAIT), "블로킹 소비자가 구독되지 않았다 — 관측이 공허해진다");

			// 소켓을 한 바이트도 읽지 않는 소비자에게 live push를 계속 밀어 넣는다. 소켓 버퍼가 차면
			// 그 write가 notifyLock을 쥔 채 멈추고, 그때부터 모든 요청의 액세스 로그가 대기한다.
			flooder.start();
			floodStalled = awaitFloodStall(flooded);

			seqBefore = lastSeq(); // snapshot()은 bufferLock만 잡는다 — 멈춘 소비자에 막히지 않는다(step1 규율).
			long startedAt = System.nanoTime();
			answered = probeHealth(); // 데드라인 안에 응답이 오는가.
			elapsedMs = (System.nanoTime() - startedAt) / 1_000_000L;
			probeHealth();
			seqAfter = lastSeq(); // 요청은 응답했는데 그 액세스 로그가 버퍼에 들어왔는가.
		}
		finally {
			stop.set(true);
			blocked.close(); // 끊으면 write가 실패하고 그 실패가 락을 푼다.
			flooder.join(RECOVERY.toMillis());
		}

		System.out.println("[phase 74 step5 관측] 블로킹 소비자 1개 · push 정지=" + floodStalled
				+ " · 정지 전 발생 로그=" + flooded.get() + "줄 · GET /api/health 응답=" + answered
				+ " · 소요=" + elapsedMs + "ms · 정지 중 액세스 로그 진행=" + (seqAfter - seqBefore) + "줄"
				+ " · 버퍼=" + this.logs.snapshot().size() + "건");

		assertTrue(awaitHealthy(RECOVERY),
				"블로킹 소비자를 끊었는데도 서버가 회복되지 않았다 — write 실패 → 봉인 경로가 끊겼다");
		assertTrue(awaitSubscriberCount(0, RECOVERY), "끊긴 소비자의 구독이 회수되지 않았다");
	}

	/**
	 * 로그 발생이 <b>멈췄는지</b> 관측한다 — 멈췄다면 그 스레드가 {@code notifyLock}을 쥔 채 소켓 write에서
	 * 블로킹된 것이다. 진행이 계속되면(=버퍼가 다 소화됐다) {@code false}이고 그것도 정상 관측이다.
	 */
	private static boolean awaitFloodStall(AtomicInteger flooded) {
		long deadline = System.nanoTime() + FLOOD_STALL_LIMIT.toNanos();
		int last = -1;
		int stableRounds = 0;
		while (System.nanoTime() < deadline) {
			int now = flooded.get();
			if (now >= FLOOD_LINES) {
				return false; // 전부 흘려보냈다 — 정지가 관측되지 않았다.
			}
			stableRounds = (now == last) ? stableRounds + 1 : 0;
			if (now > 0 && stableRounds >= 10) {
				return true; // 약 1초 동안 한 줄도 나아가지 못했다.
			}
			last = now;
			LockSupport.parkNanos(100_000_000L);
		}
		return flooded.get() < FLOOD_LINES;
	}

	// --- 도구 ---------------------------------------------------------------------------------------

	private WireStream openStream(String token) {
		return WireStream.open(this.port, "/api/logs/stream", Map.of(SESSION_HEADER, token));
	}

	private static WireStream.Frame awaitReady(WireStream stream) {
		return stream.awaitFrame((frame) -> "ready".equals(frame.event()), WAIT);
	}

	/** 새 프레임이 {@link #QUIET} 동안 오지 않을 때까지 읽고 log 프레임의 seq를 돌려준다. */
	private static List<Long> drain(WireStream stream) {
		long deadline = System.nanoTime() + DRAIN_LIMIT.toNanos();
		while (System.nanoTime() < deadline && !stream.awaitSilence(QUIET)) {
			// 아직 흘러오는 중이다.
		}
		return logSeqs(stream.rawBody());
	}

	/** 기대 seq가 전부 도착할 때까지(또는 데드라인까지) 읽는다 — 유실은 개수로만 보고한다. */
	private static List<Long> readUntilAllArrived(WireStream stream, List<Long> expected) {
		long deadline = System.nanoTime() + DRAIN_LIMIT.toNanos();
		List<Long> received = logSeqs(stream.rawBody());
		while (System.nanoTime() < deadline && !new HashSet<>(received).containsAll(expected)) {
			stream.awaitSilence(QUIET);
			received = logSeqs(stream.rawBody());
		}
		return received;
	}

	private static void assertAscending(List<Long> seqs, int round) {
		for (int i = 1; i < seqs.size(); i++) {
			assertTrue(seqs.get(i) > seqs.get(i - 1), "라운드 " + round + ": seq가 엄격 증가가 아니다(중복·역전) "
					+ "위치 " + i + ": " + seqs.get(i - 1) + " → " + seqs.get(i));
		}
	}

	/** 버퍼 마지막 줄의 seq — {@code snapshot()}은 {@code bufferLock}만 잡으므로 정지 중에도 응답한다. */
	private long lastSeq() {
		List<LogRecord> buffered = this.logs.snapshot();
		return buffered.isEmpty() ? -1 : buffered.get(buffered.size() - 1).seq();
	}

	private static List<Long> logSeqs(String rawBody) {
		List<Long> seqs = new ArrayList<>();
		Matcher matcher = BODY_LOG_SEQ.matcher(rawBody);
		while (matcher.find()) {
			seqs.add(Long.parseLong(matcher.group(1)));
		}
		return seqs;
	}

	/**
	 * 데드라인이 있는 헬스 프로브 — 응답 헤더가 {@code WireStream}의 15초 한도 안에 오면 {@code true}다.
	 * 타임아웃은 예외가 아니라 {@code false}로 표현한다(관측이 테스트를 영구 정지시키면 안 된다).
	 */
	private boolean probeHealth() {
		try (WireStream probe = WireStream.open(this.port, "/api/health", Map.of())) {
			return probe.status() == 200;
		}
		catch (RuntimeException ex) {
			return false;
		}
	}

	private boolean awaitHealthy(Duration timeout) {
		long deadline = System.nanoTime() + timeout.toNanos();
		while (System.nanoTime() < deadline) {
			if (probeHealth()) {
				return true;
			}
		}
		return probeHealth();
	}

	private boolean awaitSubscriberCount(int target, Duration timeout) {
		long deadline = System.nanoTime() + timeout.toNanos();
		while (System.nanoTime() < deadline) {
			if (this.logs.subscriberCount() == target) {
				return true;
			}
			LockSupport.parkNanos(20_000_000L);
		}
		return this.logs.subscriberCount() == target;
	}

	/** 이전 테스트가 남긴 끊긴 구독을 회수한다(로그 1건이 회수 트리거다 — decisions (12)). */
	private void awaitNoSubscribers() {
		long deadline = System.nanoTime() + Duration.ofSeconds(30).toNanos();
		while (this.logs.subscriberCount() > 0 && System.nanoTime() < deadline) {
			this.logs.info("lsr-baseline-reclaim");
			LockSupport.parkNanos(20_000_000L);
		}
		assertEquals(0, this.logs.subscriberCount(), "이전 테스트의 구독이 회수되지 않았다");
	}

	private String sessionFor() {
		return this.sessions.createSession(ADMIN);
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
			// 이미 있다 — 픽스처는 멱등이다(행을 지우지 않는다).
		}
	}
}
