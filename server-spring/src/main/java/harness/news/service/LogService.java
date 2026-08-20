package harness.news.service;

import java.time.Clock;
import java.time.Instant;
import java.time.ZoneOffset;
import java.time.format.DateTimeFormatter;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Deque;
import java.util.List;
import java.util.Locale;

/**
 * 로그 서비스 — <b>in-memory 링 버퍼만</b> 쓴다(ADR-007 · LOGS.md "파일 미저장").
 * 이식 원본은 리포 루트 {@code src/services/logService.js}이고, 그 구현의 무의존 log4j '스타일'
 * (레벨 서열 + {@code [YYYY-MM-DD HH:MM:SS] [LEVEL] 메시지})을 그대로 옮겼다.
 *
 * <h2>파일·DB에 쓰지 않는다</h2>
 * 파일은 LOGS.md가 금지했고, DB는 무한 증식 + DB 비파괴 규칙과 충돌한다. 보존 수단은 이 버퍼 하나이며
 * 프로세스가 죽으면 사라진다(문서화된 트레이드오프). Logback 콘솔 출력은 <b>별개 문제</b>다 —
 * 계약이 요구하는 것은 API로 나가는 레코드 5키이고, 그것을 만드는 것은 이 버퍼다.
 *
 * <h2>시각과 타임존은 주입이다</h2>
 * {@code System.currentTimeMillis()}를 부르지 않는다(decisions (14)). 타임존도 프로세스 기본값이 아니라
 * <b>고정 오프셋(분)</b>이다 — 서버 TZ 설정에 따라 24시간 창이 통째로 밀리면 "매일 06시 다이제스트"가
 * 조용히 다른 하루를 담는다.
 *
 * <h2>타이머가 없다</h2>
 * evict는 append 시점에, 창 계산은 <b>조회 시점</b>에 한다({@code @Scheduled} 0 — ADR-008).
 * "매일 06시 전달"은 앱이 아니라 운영 루틴이 {@code GET /api/logs/digest}를 pull해서 수행한다.
 *
 * <h2>구독(subscribe) API는 두지 않았다</h2>
 * Node에는 {@code subscribe}/{@code snapshot}이 있지만 그 소비자는 {@code GET /api/logs/stream}(SSE)
 * 하나뿐이고, SSE는 이 phase 범위 밖이다(index.json excluded (a)). 소비자 없는 API를 미리 만들면
 * 검증되지 않은 표면이 쌓인다 — SSE를 소유하는 phase가 그때 추가한다.
 */
public class LogService {

	/** 링 버퍼 상한(줄 수) — Node {@code createLogService}의 기본 cap과 같다. */
	public static final int DEFAULT_CAP = 10_000;

	/** KST 고정 오프셋(분). 다이제스트 창과 {@code line}의 벽시계가 이 값을 쓴다. */
	public static final int KST_OFFSET_MINUTES = 540;

	private static final long MS_PER_MINUTE = 60L * 1000L;

	private static final long MS_PER_DAY = 24L * 60L * 60L * 1000L;

	private static final long SIX_AM_MS = 6L * 60L * 60L * 1000L;

	private static final DateTimeFormatter WALL_CLOCK =
			DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm:ss", Locale.ROOT);

	private final Clock clock;

	private final int cap;

	private final int tzOffsetMinutes;

	/** 오래된→최신. 길이는 절대 {@link #cap}을 넘지 않는다(FIFO evict). */
	private final Deque<LogRecord> buffer = new ArrayDeque<>();

	/** 프로세스 수명 동안 단조 증가 — evict돼도 재사용하지 않는다. */
	private long seq;

	/**
	 * @param clock 주입 시계(epoch ms만 읽는다)
	 * @param cap 링 버퍼 상한 — 24시간에 이 값을 넘기면 오래된 항목이 evict되어 다이제스트가 그만큼
	 *     놓칠 수 있다(Node와 같은, 문서화된 트레이드오프)
	 * @param tzOffsetMinutes 표시·창 경계 타임존의 고정 오프셋(분)
	 */
	public LogService(Clock clock, int cap, int tzOffsetMinutes) {
		if (cap < 1) {
			throw new IllegalArgumentException("로그 버퍼 cap은 1 이상이어야 한다: " + cap);
		}
		this.clock = clock;
		this.cap = cap;
		this.tzOffsetMinutes = tzOffsetMinutes;
	}

	public LogRecord debug(String message) {
		return log(LogRecord.Level.DEBUG, message);
	}

	public LogRecord info(String message) {
		return log(LogRecord.Level.INFO, message);
	}

	public LogRecord warn(String message) {
		return log(LogRecord.Level.WARN, message);
	}

	public LogRecord error(String message) {
		return log(LogRecord.Level.ERROR, message);
	}

	/**
	 * 조회 시점의 다이제스트 — 시각은 주입 시계에서 읽는다.
	 *
	 * @return {@code [경계-24h, 경계)} 구간의 레코드(오래된→최신)
	 */
	public List<LogRecord> digest() {
		return digest(this.clock.millis());
	}

	/**
	 * {@code atMs} 이하이면서 로컬(주입 오프셋) 벽시계가 06:00:00.000인 <b>가장 최근 경계</b>를 잡고,
	 * {@code [경계-24h, 경계)} 반열림 구간의 레코드를 돌려준다 —
	 * LOGS.md "전날 하루부터 오전 5시 59분까지"의 확정 해석이다(ADR-007).
	 *
	 * <p>그래서 <b>갓 기동한 서버의 결과는 빈 목록이 정상</b>이다: 창은 언제나 과거 구간이라 방금 쌓인
	 * 로그는 다음 06:00이 지나야 들어온다({@code docs/api-contract/README.md}의 실측과 같은 사실).
	 */
	public synchronized List<LogRecord> digest(long atMs) {
		long shifted = atMs + this.tzOffsetMinutes * MS_PER_MINUTE;
		long sinceSixAm = Math.floorMod(shifted - SIX_AM_MS, MS_PER_DAY);
		long boundary = atMs - sinceSixAm;
		long start = boundary - MS_PER_DAY;
		List<LogRecord> window = new ArrayList<>();
		for (LogRecord record : this.buffer) {
			if (record.ts() >= start && record.ts() < boundary) {
				window.add(record);
			}
		}
		return List.copyOf(window);
	}

	private synchronized LogRecord log(LogRecord.Level level, String message) {
		long ts = this.clock.millis();
		this.seq += 1;
		String text = String.valueOf(message);
		LogRecord record = new LogRecord(this.seq, ts, level, text,
				"[" + formatTimestamp(ts) + "] [" + level.name() + "] " + text);
		this.buffer.addLast(record);
		while (this.buffer.size() > this.cap) {
			this.buffer.removeFirst();
		}
		return record;
	}

	/** epoch ms → 주입 오프셋 벽시계 {@code YYYY-MM-DD HH:MM:SS}(프로세스 TZ 미사용). */
	private String formatTimestamp(long ts) {
		return WALL_CLOCK.format(Instant.ofEpochMilli(ts)
				.atOffset(ZoneOffset.ofTotalSeconds(this.tzOffsetMinutes * 60)));
	}
}
