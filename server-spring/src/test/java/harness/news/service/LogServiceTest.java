package harness.news.service;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import harness.news.testsupport.MutableClock;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
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

	// --- 도구 -------------------------------------------------------------------------------------

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
