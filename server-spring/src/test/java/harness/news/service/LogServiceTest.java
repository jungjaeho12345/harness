package harness.news.service;

import static org.junit.jupiter.api.Assertions.assertDoesNotThrow;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertSame;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import harness.news.testsupport.MutableClock;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Instant;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Queue;
import java.util.concurrent.ConcurrentLinkedQueue;
import java.util.concurrent.Semaphore;
import java.util.concurrent.atomic.AtomicBoolean;
import org.junit.jupiter.api.Test;

/**
 * 로그 링 버퍼와 다이제스트 창 — 이식 원본은 리포 루트 {@code src/services/logService.js}(86행)다.
 *
 * <p>계약 스위트는 이 축을 <b>동결하지 못한다</b>: 서버 시계를 주입할 수 없어 갓 기동한 서버의
 * {@code items}는 항상 빈 배열이고({@code docs/api-contract/openapi.yaml} logs-digest 설명), 그래서
 * 계약이 잠그는 것은 shape과 인가뿐이다. <b>창 경계·FIFO evict·{@code seq} 단조성·{@code line} 포맷은
 * 이 클래스가 소유한다</b>(index.json forward_notes (8)과 같은 성격 — 시간축은 Java 테스트의 몫이다).
 *
 * <p>시각은 전부 주입 시계에서 온다(decisions (14)). 타임존도 <b>주입된 고정 오프셋</b>이라
 * 이 테스트는 어떤 TZ의 머신에서도 같은 결과를 낸다 — 프로세스 기본 타임존에 의존하면 24시간 창이
 * 통째로 밀린다.
 */
class LogServiceTest {

	/** KST 고정 오프셋(분) — Node {@code createLogService} 기본값과 같다. */
	private static final int KST = 540;

	private static final long DAY_MS = 24L * 60L * 60L * 1000L;

	/** 2026-08-21 06:00:00.000 KST — 다이제스트 창의 닫는 경계(반열림). */
	private static final long BOUNDARY = Instant.parse("2026-08-20T21:00:00Z").toEpochMilli();

	/** 창이 열리는 경계 = 2026-08-20 06:00:00.000 KST. */
	private static final long WINDOW_OPEN = BOUNDARY - DAY_MS;

	/** 2026-08-21 07:00:00 KST — 창이 닫힌 뒤의 조회 시각(운영 루틴이 pull하는 시점). */
	private static final long AFTER_BOUNDARY = BOUNDARY + 60L * 60L * 1000L;

	/** "막혔다"고 판정하기까지 기다리는 시간(항목 5c·5d). 정상 경로는 밀리초 단위로 끝난다. */
	private static final long BLOCK_LIMIT_MS = 3000L;

	/** 정리용 join 상한 — 붙잡아 둔 스레드를 풀어 준 뒤에 쓴다. */
	private static final long JOIN_LIMIT_MS = 15_000L;

	/** 세마포어를 풀 때 한 번에 주는 퍼밋 수(테스트가 붙잡아 둔 스레드보다 넉넉하다). */
	private static final int RELEASE_ALL = 1024;

	private final MutableClock clock = new MutableClock(WINDOW_OPEN);

	// --- 창 경계 ----------------------------------------------------------------------------------

	@Test
	void theWindowIsTheHalfOpenTwentyFourHoursThatClosedAtSixAm() {
		LogService logs = seedBoundaryProbes(new LogService(this.clock, 10, KST));

		this.clock.setMillis(AFTER_BOUNDARY);

		assertEquals(List.of("window-open", "window-last"), messages(logs.digest()),
				"창은 [전날 06:00, 당일 06:00) — 06:00:00.000은 다음 창이고 05:59:59.999는 이번 창이다");
	}

	@Test
	void justBeforeSixAmTheWindowIsStillTheOneThatClosedTheDayBefore() {
		LogService logs = seedBoundaryProbes(new LogService(this.clock, 10, KST));

		this.clock.setMillis(BOUNDARY - 1); // 2026-08-21 05:59:59.999 KST

		assertEquals(List.of("before-window"), messages(logs.digest()),
				"06:00 직전의 조회는 아직 전날 06:00에 닫힌 창을 본다(하루 밀리지 않는다)");
	}

	@Test
	void digestWithoutAnInstantReadsTheInjectedClock() {
		LogService logs = seedBoundaryProbes(new LogService(this.clock, 10, KST));

		this.clock.setMillis(AFTER_BOUNDARY);

		assertEquals(messages(logs.digest(AFTER_BOUNDARY)), messages(logs.digest()),
				"인자 없는 digest()는 System.currentTimeMillis가 아니라 주입 시계를 읽는다");
	}

	@Test
	void theTimezoneOffsetIsInjectedNotTheProcessDefault() {
		// 같은 시각·같은 레코드라도 오프셋이 0이면 창 경계가 9시간 밀린다.
		LogService utc = new LogService(this.clock, 10, 0);
		log(utc, BOUNDARY - 1, "kst-last"); // UTC로는 2026-08-20 20:59:59.999 → 06:00 경계 이후
		log(utc, BOUNDARY - DAY_MS, "kst-open"); // UTC로는 2026-08-19 21:00 → 이번 창 안

		this.clock.setMillis(Instant.parse("2026-08-20T07:00:00Z").toEpochMilli());

		assertEquals(List.of("kst-open"), messages(utc.digest()),
				"창 경계는 주입된 오프셋으로 계산한다(서버 TZ 설정이 창을 옮기면 안 된다)");
	}

	// --- 링 버퍼 ----------------------------------------------------------------------------------

	@Test
	void theRingBufferEvictsTheOldestBeyondTheCap() {
		LogService logs = new LogService(this.clock, 3, KST);
		for (int i = 1; i <= 5; i++) {
			log(logs, WINDOW_OPEN + i, "line-" + i);
		}

		this.clock.setMillis(AFTER_BOUNDARY);

		assertEquals(List.of("line-3", "line-4", "line-5"), messages(logs.digest()),
				"cap을 넘으면 가장 오래된 것부터 evict된다(FIFO, 오래된→최신 순서 유지)");
	}

	@Test
	void seqIsMonotonicAndIsNeverReusedAfterEviction() {
		LogService logs = new LogService(this.clock, 2, KST);
		for (int i = 1; i <= 4; i++) {
			log(logs, WINDOW_OPEN + i, "line-" + i);
		}

		this.clock.setMillis(AFTER_BOUNDARY);

		assertEquals(List.of(3L, 4L), logs.digest().stream().map(LogRecord::seq).toList(),
				"seq는 프로세스 수명 동안 단조 증가한다 — evict된 번호를 다시 쓰지 않는다");
	}

	// --- 레코드 ------------------------------------------------------------------------------------

	@Test
	void theLineIsTheWallClockFormatOfTheInjectedTimezone() {
		LogService logs = new LogService(this.clock, 10, KST);
		log(logs, Instant.parse("2026-08-20T01:00:00Z").toEpochMilli(), "안녕");

		this.clock.setMillis(AFTER_BOUNDARY);

		assertEquals("[2026-08-20 10:00:00] [INFO] 안녕", logs.digest().get(0).line(),
				"[YYYY-MM-DD HH:MM:SS] [LEVEL] 메시지 — LOGS.md의 형식이자 LogRecord.line 계약이다");
	}

	@Test
	void theFourLevelsAreTheLog4jStyleLadder() {
		LogService logs = new LogService(this.clock, 10, KST);
		this.clock.setMillis(WINDOW_OPEN + 1);
		logs.debug("d");
		logs.info("i");
		logs.warn("w");
		logs.error("e");

		this.clock.setMillis(AFTER_BOUNDARY);

		assertEquals(List.of("DEBUG", "INFO", "WARN", "ERROR"),
				logs.digest().stream().map((entry) -> entry.level().name()).toList());
	}

	@Test
	void aRecordProjectsToExactlyTheFiveContractKeysInOrder() {
		LogService logs = new LogService(this.clock, 10, KST);
		log(logs, WINDOW_OPEN + 1, "hello");
		this.clock.setMillis(AFTER_BOUNDARY);

		LogRecord entry = logs.digest().get(0);

		assertEquals(List.of("seq", "ts", "level", "message", "line"),
				List.copyOf(entry.asMap().keySet()),
				"openapi.yaml LogRecord required 5키 — 순서까지 Node record와 같다");
		assertEquals(1L, entry.asMap().get("seq"));
		assertEquals(WINDOW_OPEN + 1, entry.asMap().get("ts"));
		assertEquals("INFO", entry.asMap().get("level"), "level은 enum 이름 문자열로 나간다");
		assertEquals("hello", entry.asMap().get("message"));
		assertTrue(entry.asMap().get("line").toString().endsWith("] [INFO] hello"));
	}

	// --- 구독(SSE 소스) ---------------------------------------------------------------------------

	/**
	 * 항목 1 — 구독자가 1건을 받고, 전달된 record가 {@code log(...)}가 반환한 <b>동일 객체</b>다
	 * (= 동일 5키). 프레임 payload가 그 record이므로 여기서 복사·재조립이 끼면 계약 키가 갈린다.
	 */
	@Test
	void aSubscriberReceivesTheSameRecordInstanceThatLogReturned() throws Exception {
		LogService logs = new LogService(this.clock, 10, KST);
		List<LogRecord> received = new ArrayList<>();

		LogRecord returned;
		try (AutoCloseable ignored = logs.subscribe(received::add)) {
			returned = logs.info("probe");
		}

		assertEquals(1, received.size(), "구독자가 정확히 1건을 받아야 한다");
		assertSame(returned, received.get(0), "push되는 record는 log()가 반환한 그 record다");
		assertEquals(List.of("seq", "ts", "level", "message", "line"),
				List.copyOf(received.get(0).asMap().keySet()),
				"프레임 payload가 될 5키가 그대로여야 한다(openapi LogRecord)");
	}

	/** 항목 2 — 구독자 2개가 1건에 둘 다, <b>등록 순서대로</b> 받는다(결정성). */
	@Test
	void twoSubscribersBothReceiveInRegistrationOrder() throws Exception {
		LogService logs = new LogService(this.clock, 10, KST);
		List<String> order = new ArrayList<>();

		try (AutoCloseable a = logs.subscribe((record) -> order.add("first"));
				AutoCloseable b = logs.subscribe((record) -> order.add("second"))) {
			logs.info("probe");
		}

		assertEquals(List.of("first", "second"), order,
				"통지는 등록 순서다 — fanout이 깨졌거나 순서가 뒤집혔다");
	}

	/**
	 * 항목 3 — {@code close()} 후에는 받지 않고 <b>이중 close가 안전</b>하며
	 * {@code subscriberCount()}가 정확히 오르내린다(step5가 이 값으로 누수 0을 단언한다).
	 *
	 * <p><b>같은 리스너 인스턴스</b>를 두 번 구독시키는 이유는 {@code ChangeBusTest}와 같다: 해제가
	 * "목록에서 이 리스너를 지운다"뿐이면 이중 close가 <b>남의 구독</b>을 지운다.
	 */
	@Test
	void closingASubscriptionStopsDeliveryAndIsIdempotent() throws Exception {
		LogService logs = new LogService(this.clock, 10, KST);
		List<LogRecord> received = new ArrayList<>();
		LogService.Listener listener = received::add;
		AutoCloseable first = logs.subscribe(listener);
		AutoCloseable second = logs.subscribe(listener);
		assertEquals(2, logs.subscriberCount(), "같은 리스너의 두 구독은 각각 등록된다");

		first.close();
		assertDoesNotThrow(first::close, "이중 close는 무해해야 한다");
		assertDoesNotThrow(first::close, "세 번째 close도 무해해야 한다");
		assertEquals(1, logs.subscriberCount(), "이중 close가 남의 구독까지 지웠다");

		logs.info("probe");
		assertEquals(1, received.size(), "살아 있는 구독 1개가 정확히 1회 받아야 한다");

		second.close();
		assertEquals(0, logs.subscriberCount(), "해제 후 구독자가 남았다 — 누수다");
		logs.info("probe");
		assertEquals(1, received.size(), "해제된 구독자에게 통지가 갔다");
	}

	/**
	 * 항목 4 — 구독자가 던져도 (a) 다른 구독자가 받고 (b) {@code info(...)}가 던지지 않고
	 * (c) 반환 record와 버퍼가 정상이다.
	 *
	 * <p>근거: 통지를 부르는 자리는 {@code RequestLogFilter.doFilter}의 {@code finally}다 — 예외가 새면
	 * <b>응답이 이미 나간 뒤에 필터가 터진다</b>(Node에서는 {@code res.on('finish')} 밖으로 새어
	 * {@code uncaughtException} → 프로세스 종료였다). 던지는 구독자를 <b>가운데</b>에 둔다: 예외가 루프를
	 * 끊으면 뒤 구독자만 조용히 굶는다.
	 */
	@Test
	void aThrowingSubscriberNeitherStopsTheOthersNorTheCaller() throws Exception {
		LogService logs = new LogService(this.clock, 10, KST);
		List<LogRecord> before = new ArrayList<>();
		List<LogRecord> after = new ArrayList<>();

		try (AutoCloseable a = logs.subscribe(before::add);
				AutoCloseable b = logs.subscribe((record) -> {
					throw new IllegalStateException("구독자 폭발");
				});
				AutoCloseable c = logs.subscribe(after::add)) {

			LogRecord returned = assertDoesNotThrow(() -> logs.info("probe"),
					"구독자 예외가 새면 응답이 끝난 뒤에 RequestLogFilter의 finally가 터진다");

			assertEquals(1, before.size(), "던지는 구독자 앞의 구독자가 받지 못했다");
			assertEquals(1, after.size(), "던지는 구독자 뒤의 구독자가 굶었다 — 루프가 끊겼다");
			assertEquals(1L, returned.seq(), "예외 격리가 반환 record를 망가뜨렸다");
			assertEquals(1, logs.snapshot().size(), "구독자 예외가 버퍼 append에 영향을 줬다");

			assertDoesNotThrow(() -> logs.info("probe"), "두 번째 기록도 정상이어야 한다");
			assertEquals(2, after.size(), "던진 구독자가 자동 해제되지도, 다음 통지를 막지도 않아야 한다");
		}
	}

	/**
	 * 항목 5 — 통지는 <b>버퍼 monitor 밖</b>에서 돈다.
	 *
	 * <p>콜백 안에서 <b>별도 스레드</b>로 {@code digest()}를 부르고 2초 안에 반환되는지 본다. 통지가
	 * {@code bufferLock}을 잡은 채 돌면 느린 구독자 하나가 {@code GET /api/logs/digest}를 막는다
	 * (index.json decisions (11)). 테스트 소스는 {@code Adr008DisciplineTest}의 스캔 대상이 아니다 —
	 * 스캔 루트는 {@code src/main/java}이므로 여기서 스레드·타임아웃을 쓰는 것은 허용된다.
	 */
	@Test
	void notificationDoesNotHoldTheBufferMonitor() throws Exception {
		LogService logs = new LogService(this.clock, 10, KST);
		AtomicBoolean digestReturned = new AtomicBoolean(false);

		try (AutoCloseable ignored = logs.subscribe((record) -> {
			Thread probe = new Thread(() -> {
				logs.digest();
				digestReturned.set(true);
			});
			probe.start();
			try {
				probe.join(2000);
			}
			catch (InterruptedException ex) {
				Thread.currentThread().interrupt();
			}
		})) {
			logs.info("probe");
		}

		assertTrue(digestReturned.get(),
				"통지 중 다른 스레드의 digest()가 2초 안에 반환되지 않았다 — 통지가 버퍼 monitor를 잡고 있다");
	}

	/**
	 * 항목 5b — <b>seq 역전 0(교차 스레드)</b>. 스레드 8개가 각각 200회 기록하는 동안 구독자 1개가 받은
	 * {@code seq}가 엄격 증가여야 한다(총 1600건 · 유실 0 · 중복 0).
	 *
	 * <p><b>이 항목이 이 축의 유일한 방어선이다</b>: 계약 케이스는 {@code seq > seqBefore}(하한)만 보므로
	 * 역전을 조용히 통과시킨다({@code contract/cases/default/logs.contract.js} 170~178행 주석이 명시한다).
	 * 그래서 {@code notifyLock}을 없애면(= append monitor 밖에서 락 없이 통지) 계약은 green인 채
	 * 구독자만 순서가 뒤섞인다 — 변이 M1-8이 그것을 실증한다.
	 */
	@Test
	void seqNeverArrivesOutOfOrderAcrossThreads() throws Exception {
		int workerCount = 8;
		int perWorker = 200;
		int total = workerCount * perWorker;
		LogService logs = new LogService(this.clock, total + 100, KST);
		Queue<Long> delivered = new ConcurrentLinkedQueue<>();

		try (AutoCloseable ignored = logs.subscribe((record) -> delivered.add(record.seq()))) {
			List<Thread> workers = new ArrayList<>();
			for (int t = 0; t < workerCount; t++) {
				Thread worker = new Thread(() -> {
					for (int i = 0; i < perWorker; i++) {
						logs.info("probe");
					}
				});
				workers.add(worker);
				worker.start();
			}
			for (Thread worker : workers) {
				worker.join();
			}
		}

		List<Long> seqs = new ArrayList<>(delivered);
		assertEquals(total, seqs.size(), "통지 건수가 다르다 — 유실 또는 중복이다");
		assertEquals(total, new HashSet<>(seqs).size(), "같은 seq가 두 번 통지됐다");
		long highest = 0L;
		int inversions = 0;
		for (long seq : seqs) {
			if (seq <= highest) {
				inversions++;
			}
			highest = Math.max(highest, seq);
		}
		assertEquals(0, inversions,
				"구독자가 seq를 역전된 순서로 받았다 — 계약은 이 축을 보지 못한다(하한만 본다)");
	}

	/**
	 * 항목 5c — <b>콜백 안에서 멈춘 구독자 하나가 다른 스레드의 {@code log(...)}를 막지 않는다.</b>
	 *
	 * <p>구독 콜백이 하는 일은 (a) {@code authorizePeek} → {@code users.findById} = <b>DB 조회</b>와
	 * (b) {@code ServletOutputStream#write} = <b>블로킹 쓰기</b>다. 그 콜백을 전역 통지 락 안에서 돌면
	 * <b>모든 요청</b>이 {@code RequestLogFilter}의 {@code finally}에서 그 락을 기다리며 줄을 선다
	 * (그 필터는 요청 100%에 걸린다) — 즉 소비자 하나가 서버 전체를 세운다.
	 *
	 * <p>여기서는 세마포어로 "영원히 안 끝나는 write"를 대신 세운다. 전역 락이 콜백을 감싸면
	 * 두 번째 스레드의 {@code info(...)}가 {@link #BLOCK_LIMIT_MS} 안에 돌아오지 못한다.
	 * <b>순서 보장은 항목 5b가 따로 지킨다</b> — 이 두 항목은 함께 성립해야 한다(락을 걷어내면서
	 * 순서 방어선까지 걷어내면 안 된다).
	 */
	@Test
	void aSubscriberStuckInsideItsCallbackDoesNotBlockOtherThreadsFromLogging() throws Exception {
		LogService logs = new LogService(this.clock, 100, KST);
		Semaphore blockingWrite = new Semaphore(0);
		AtomicBoolean insideCallback = new AtomicBoolean(false);

		try (AutoCloseable ignored = logs.subscribe((record) -> {
			insideCallback.set(true);
			blockingWrite.acquireUninterruptibly(); // 소비자가 읽지 않는 소켓에 쓰는 상태의 대역.
		})) {
			Thread stalled = new Thread(() -> logs.info("probe"));
			stalled.start();
			awaitTrue(insideCallback, "구독자 콜백에 진입하지 못했다 — 이 테스트가 공허해진다");

			Thread other = new Thread(() -> logs.info("probe"));
			other.start();
			other.join(BLOCK_LIMIT_MS);
			boolean blocked = other.isAlive();

			blockingWrite.release(RELEASE_ALL); // 정리 — 붙잡아 둔 스레드를 전부 풀어 준다.
			other.join(JOIN_LIMIT_MS);
			stalled.join(JOIN_LIMIT_MS);

			assertFalse(blocked, "멈춘 구독자 하나가 다른 스레드의 log()를 " + BLOCK_LIMIT_MS
					+ "ms 넘게 막았다 — 그 자리는 모든 요청의 액세스 로그(RequestLogFilter의 finally)다");
		}
	}

	/**
	 * 항목 5d — <b>「유일 커넥션 ↔ 통지 락」 순환 대기가 성립하지 않는다.</b>
	 *
	 * <h2>막으려는 코드 경로(가정이 아니다)</h2>
	 * <ol>
	 *   <li>{@code ArticleEmbargoService}가 {@code transactions.executeWithoutResult} <b>안</b>에서
	 *       {@code recorder.record}를 부르고, 이력 insert가 실패하면 {@code HistoryErrorLogger}가
	 *       {@code logs.warn(...)}을 부른다 — 이 스레드는 <b>유일 커넥션</b>을 쥔 채다
	 *       ({@code NewsDataSource.MAX_POOL_SIZE = 1}).</li>
	 *   <li>동시에 다른 요청의 {@code RequestLogFilter} {@code finally}가 {@code logs.info(...)}를 불러
	 *       구독 콜백이 {@code authorizePeek} → {@code users.findById}로 <b>커넥션을 기다린다</b>.</li>
	 * </ol>
	 * 통지가 전역 락 안에서 돌면 ②가 락을 쥔 채 커넥션을 기다리고 ①이 커넥션을 쥔 채 락을 기다린다 —
	 * <b>순환 대기</b>이고 Hikari {@code connectionTimeout}(30초)으로만 풀린다. 트리거 현실성은 ADR-013이
	 * 전제한 Node/Spring 동일 {@code news.db} 공존이다({@code SQLITE_BUSY} → 이력 insert 예외).
	 *
	 * <p>1퍼밋 세마포어는 <b>풀의 모형이 아니라 풀 그 자체의 형태</b>다(상한 1의 커넥션 풀은 퍼밋 하나다).
	 * 같은 사슬을 실제 {@code HikariDataSource}·실제 필터·실제 구독 콜백으로 재현하는 자리는
	 * {@code LogsStreamWireTest}의 「유일 커넥션」 항목이다 — 두 층 모두에서 red를 확인했다.
	 */
	@Test
	void theSingleConnectionDeadlockChainDoesNotForm() throws Exception {
		LogService logs = new LogService(this.clock, 100, KST);
		Semaphore pool = new Semaphore(1); // 상한 1의 커넥션 풀.
		AtomicBoolean waitingForConnection = new AtomicBoolean(false);

		try (AutoCloseable ignored = logs.subscribe((record) -> {
			waitingForConnection.set(true);
			pool.acquireUninterruptibly(); // authorizePeek → SessionGuard.peekSession → users.findById
			pool.release();
		})) {
			pool.acquireUninterruptibly(); // 트랜잭션이 유일 커넥션을 쥐었다.

			Thread accessLog = new Thread(() -> logs.info("probe")); // RequestLogFilter의 finally
			accessLog.start();
			awaitTrue(waitingForConnection, "구독자가 커넥션 대기에 들어가지 못했다 — 이 테스트가 공허해진다");
			awaitQueued(pool);

			Thread transaction = new Thread(() -> logs.warn("probe")); // HistoryErrorLogger
			transaction.start();
			transaction.join(BLOCK_LIMIT_MS);
			boolean deadlocked = transaction.isAlive();

			pool.release(); // 트랜잭션이 커밋하고 커넥션을 돌려준다.
			transaction.join(JOIN_LIMIT_MS);
			accessLog.join(JOIN_LIMIT_MS);

			assertFalse(deadlocked, "커넥션을 쥔 스레드의 warn()이 " + BLOCK_LIMIT_MS
					+ "ms 안에 돌아오지 못했다 — 통지 락과 유일 커넥션이 순환 대기를 이룬다");
		}
	}

	/** 항목 6 — 통지는 <b>호출 스레드</b>에서 돈다(ADR-015 · 트리거 스레드 직접 쓰기). */
	@Test
	void notificationRunsOnTheCallingThread() throws Exception {
		LogService logs = new LogService(this.clock, 10, KST);
		List<Thread> seen = new ArrayList<>();

		try (AutoCloseable ignored = logs.subscribe((record) -> seen.add(Thread.currentThread()))) {
			logs.info("probe");

			assertEquals(1, seen.size(), "info 반환 시점에 통지가 끝나 있지 않다 — 비동기로 넘겼다");
			assertSame(Thread.currentThread(), seen.get(0),
					"구독자 콜백이 다른 스레드에서 돌았다(ADR-008 2군)");
		}
	}

	/**
	 * 항목 7 — {@code snapshot()}은 <b>방어 복사</b>다: 반환 리스트는 불변이고, 이후 append가 이전
	 * 스냅샷에 보이지 않는다(내부 버퍼의 뷰를 주면 replay 도중 {@code ConcurrentModificationException}이
	 * 나고 호출자가 버퍼를 들여다본다).
	 */
	@Test
	void snapshotIsADefensiveCopy() {
		LogService logs = new LogService(this.clock, 10, KST);
		log(logs, WINDOW_OPEN + 1, "one");

		List<LogRecord> taken = logs.snapshot();
		assertThrows(UnsupportedOperationException.class, () -> taken.remove(0),
				"스냅샷이 수정 가능하다 — 호출자가 버퍼를 들여다보거나 고칠 수 있다");

		log(logs, WINDOW_OPEN + 2, "two");
		assertEquals(1, taken.size(), "이전 스냅샷에 이후 append가 보인다 — 내부 버퍼의 뷰다");
		assertEquals(2, logs.snapshot().size(), "새 스냅샷은 최신 상태를 담아야 한다");
	}

	/** 항목 8 — {@code snapshot()}은 오래된→최신이고, cap을 넘으면 <b>가장 오래된 것</b>이 빠진다. */
	@Test
	void snapshotIsOldestToNewestAndEvictsTheOldestBeyondTheCap() {
		LogService logs = new LogService(this.clock, 3, KST);
		for (int i = 1; i <= 5; i++) {
			log(logs, WINDOW_OPEN + i, "line-" + i);
		}

		assertEquals(3, logs.snapshot().size(), "cap을 넘겼는데 길이가 cap이 아니다");
		assertEquals(List.of("line-3", "line-4", "line-5"), messages(logs.snapshot()),
				"snapshot은 오래된→최신 순서이고 FIFO evict가 가장 오래된 것을 뺀다");
	}

	/**
	 * 항목 9 — {@code snapshot()}은 <b>절단하지 않는다</b>. replay 상한 2000은 라우트 소유다
	 * (Node {@code server/index.js} 1178행 {@code LOG_REPLAY_MAX}). 여기서 자르면 {@code digest()}와
	 * 다른 창을 갖는 <b>두 번째 절단 지점</b>이 생기고 한쪽만 고쳐도 조용히 갈린다.
	 */
	@Test
	void snapshotDoesNotTruncateToTheReplayLimit() {
		LogService logs = new LogService(this.clock, 5000, KST);
		this.clock.setMillis(WINDOW_OPEN + 1);
		for (int i = 0; i < 3000; i++) {
			logs.info("probe");
		}

		assertEquals(3000, logs.snapshot().size(),
				"snapshot이 잘렸다 — replay 절단은 라우트(step5)의 몫이다");
	}

	/**
	 * 항목 11 — <b>소스 정적 스캔</b>: 통지는 타이머·실행자·스레드로 넘어가지 않고(ADR-008 · ADR-015)
	 * 서비스층이라 서블릿 타입을 알지 못한다(ADR-006 · ADR-013).
	 *
	 * <p>{@code Adr008DisciplineTest}가 main 소스 전역을 스캔하지만 그 게이트는 이 phase가 <b>0줄 고치는
	 * 파일</b>이고, JDK 25가 정식화한 표면({@code StructuredTaskScope}·{@code ScopedValue}·{@code Subtask})은
	 * 그 패턴 목록에 0건이다(2026-08-30 계획 단계 실측) — 이 파일에 대해서만 여기서 막는다
	 * ({@code ChangeBusTest} 항목 8과 같은 규율).
	 *
	 * <p>판정 전에 주석을 지운다 — 이 클래스의 javadoc은 {@code @Scheduled}를 실제로 <b>언급</b>한다.
	 */
	@Test
	void theLogServiceSourceHasNoTimerNoThreadAndNoServletType() throws IOException {
		Path declared = Path.of("src", "main", "java", "harness", "news", "service", "LogService.java");
		assertTrue(Files.isRegularFile(declared), "LogService가 서비스층에 없다: " + declared);

		String code = Files.readString(declared, StandardCharsets.UTF_8)
				.replaceAll("(?s)/\\*.*?\\*/", " ") // 블록 주석 제거(javadoc은 코드가 아니다)
				.replaceAll("(?m)^\\s*//[^\n]*", " "); // 줄 첫머리 주석만 — 리터럴 속 //를 지우지 않는다.

		for (String forbidden : List.of("@Scheduled", "@EnableScheduling", "@Async", "@EnableAsync", "@Retryable",
				"@Recover", "RetryTemplate", "TaskScheduler", "TaskExecutor", "ScheduledExecutorService",
				"ScheduledThreadPoolExecutor", "ScheduledFuture", "ExecutorService", "ThreadPoolExecutor",
				"ForkJoinPool", "Executors.", "new Timer(", "Thread.sleep(", "TimeUnit.", "LockSupport", ".await(",
				"CompletableFuture", "CompletionStage", ".thenApply(", ".thenAccept(", ".thenRun(", ".whenComplete(",
				"CountDownLatch", "new Thread(", "startVirtualThread", "Thread.ofVirtual(", "Thread.ofPlatform(",
				".sendAsync(", "StructuredTaskScope", "ScopedValue", "Subtask")) {
			assertFalse(code.contains(forbidden),
					"ADR-008·ADR-015: 통지는 호출 스레드에서 동기로 돈다 — 금지 철자가 코드에 있다: " + forbidden);
		}

		for (String servletType : List.of("jakarta", "AsyncContext", "HttpServlet", "ServletOutputStream")) {
			assertFalse(code.contains(servletType),
					"서비스층은 서블릿 타입을 알지 못한다(ADR-006 · ADR-013) — 코드에 있다: " + servletType);
		}
	}

	// --- 도구 -------------------------------------------------------------------------------------

	/** 플래그가 설 때까지 짧게 기다린다(항목 5c·5d의 창을 결정적으로 만든다). */
	private static void awaitTrue(AtomicBoolean flag, String message) {
		long deadline = System.nanoTime() + JOIN_LIMIT_MS * 1_000_000L;
		while (!flag.get() && System.nanoTime() < deadline) {
			pause();
		}
		assertTrue(flag.get(), message);
	}

	/** 커넥션 대기 큐에 실제로 스레드가 들어갈 때까지 기다린다(항목 5d). */
	private static void awaitQueued(Semaphore pool) {
		long deadline = System.nanoTime() + JOIN_LIMIT_MS * 1_000_000L;
		while (!pool.hasQueuedThreads() && System.nanoTime() < deadline) {
			pause();
		}
		assertTrue(pool.hasQueuedThreads(), "구독자가 커넥션 대기 큐에 들어가지 않았다 — 사슬이 성립하지 않는다");
	}

	private static void pause() {
		try {
			Thread.sleep(5);
		}
		catch (InterruptedException ex) {
			Thread.currentThread().interrupt();
		}
	}

	/** 창 경계 앞뒤 5지점에 레코드를 하나씩 남긴다(경계 판정의 전수 프로브). */
	private LogService seedBoundaryProbes(LogService logs) {
		log(logs, WINDOW_OPEN - 1, "before-window"); // 2026-08-20 05:59:59.999 KST
		log(logs, WINDOW_OPEN, "window-open"); // 2026-08-20 06:00:00.000 KST
		log(logs, BOUNDARY - 1, "window-last"); // 2026-08-21 05:59:59.999 KST
		log(logs, BOUNDARY, "window-closed"); // 2026-08-21 06:00:00.000 KST
		log(logs, AFTER_BOUNDARY, "now"); // 2026-08-21 07:00:00 KST
		return logs;
	}

	private void log(LogService logs, long ts, String message) {
		this.clock.setMillis(ts);
		logs.info(message);
	}

	private static List<String> messages(List<LogRecord> records) {
		List<String> out = new ArrayList<>();
		for (LogRecord record : records) {
			out.add(record.message());
		}
		return out;
	}
}
