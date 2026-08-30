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
import java.util.Objects;
import java.util.concurrent.CopyOnWriteArrayList;

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
 * <h2>구독(subscribe) API의 소비자는 {@code GET /api/logs/stream} 하나다</h2>
 * 2026-08-30(phase 74-spring-sse step1)에 {@link #subscribe(Listener)}/{@link #snapshot()}을 추가했다.
 * 그 전까지 이 자리에는 "소비자가 없어 만들지 않았다"고 적혀 있었고, 이제 소비자는 로그 SSE 라우트다.
 * 접속 시 {@code snapshot()}의 <b>최근 2000건</b>을 replay하고 이후를 구독으로 잇는다 —
 * <b>절단(replay 상한)은 라우트가 한다</b>(Node {@code server/index.js} 1178행 {@code LOG_REPLAY_MAX}).
 * 여기서 자르면 {@link #digest(long)}와 다른 창을 갖는 두 번째 절단 지점이 생긴다.
 *
 * <h2>통지는 호출 스레드에서, 버퍼 monitor 밖에서 돈다 — 락이 둘인 이유</h2>
 * {@code log(...)}는 <b>바깥 {@code notifyLock} → 안쪽 {@code bufferLock}</b> 순서로만 잡는다.
 * <ul>
 * <li><b>{@code bufferLock} 밖에서 통지</b>하는 이유: 느린 구독자가 {@link #digest()}
 * (= {@code GET /api/logs/digest})와 {@link #snapshot()}을 막으면 안 된다(ADR-015 · index.json
 * decisions (11)). 그 둘은 {@code bufferLock}만 잡는다.</li>
 * <li><b>{@code notifyLock}으로 감싸는</b> 이유: 감싸지 않으면 두 스레드가 append를 끝낸 순서와 통지에
 * 진입하는 순서가 달라져 <b>구독자가 {@code seq}를 역전된 순서로 받는다</b>(Node는 단일 스레드라 없는
 * 현상이고, 계약 케이스는 {@code seq > seqBefore} 하한만 보므로 조용히 통과한다).</li>
 * <li>{@link #digest(long)}/{@link #snapshot()}이 {@code bufferLock} <b>하나만</b> 잡으므로 역전 쌍이
 * 성립하지 않는다 — 이 규율은 deadlock-free다. <b>순서를 뒤집지 마라.</b></li>
 * </ul>
 * <b>대가(정직한 기록)</b>: 완전히 멈춘 소비자 하나가 {@code notifyLock}을 물면 그 뒤의 모든
 * {@code log(...)}가 대기한다. {@code RequestLogFilter}가 {@code finally}에서 액세스 로그를 남기므로
 * 그 상태는 <b>서버 전체 정지</b>가 될 수 있다 — Node의 {@code res.write}는 논블로킹 버퍼링이지만
 * {@code ServletOutputStream#write}는 <b>블로킹</b>이라 생기는 비대칭이고(동시 연결 상한도 없다),
 * 정본에 없는 이 축은 <b>미검증으로 남는다</b>(ADR-015 트레이드오프). 그래도 이 구조를 택한 이유는
 * seq 역전을 막는 다른 수단이 전부 ADR-008 금지 철자({@code CountDownLatch}·대기·큐+워커)이기 때문이고,
 * 부분 정지(느린 소비자)는 write 실패 → 스트림 자기 봉인으로 회수되기 때문이다.
 *
 * <h2>구독자 콜백은 이 서비스에 다시 로그하면 안 된다</h2>
 * 통지 → 콜백이 로그 → 통지의 <b>무한 재귀</b>가 된다. 그래서 구독자 예외를 삼킬 때도
 * <b>여기에 로그하지 않는다</b>(그 자리가 정확히 재귀가 시작되는 곳이다). 예외 격리의 근거는
 * {@code RequestLogFilter.doFilter}의 {@code finally}가 통지를 부른다는 사실이다 — 예외가 새면
 * 응답이 이미 나간 뒤에 필터가 터진다(Node에서는 {@code res.on('finish')} 밖으로 새어
 * {@code uncaughtException} → 프로세스 종료였다).
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

	/**
	 * 버퍼 monitor — {@code append}·{@link #digest(long)}·{@link #snapshot()}이 공유한다.
	 * <b>통지 중에는 잡지 않는다</b>(느린 구독자가 다이제스트 조회를 막으면 안 된다).
	 */
	private final Object bufferLock = new Object();

	/**
	 * 통지 순서 monitor — <b>바깥</b> 락이다. 이것이 없으면 구독자가 {@code seq}를 역전된 순서로 받는다.
	 * 획득 순서는 언제나 {@code notifyLock} → {@link #bufferLock} 한 방향이다.
	 */
	private final Object notifyLock = new Object();

	/**
	 * 반복 중 해제가 안전한 컨테이너 — 통지가 도는 동안 구독자가 스스로 봉인해도
	 * {@code ConcurrentModificationException}이 나지 않는다(SSE 종료기가 정확히 그렇게 동작한다).
	 * 통지 순서 = 등록 순서다(결정성).
	 */
	private final List<Listener> listeners = new CopyOnWriteArrayList<>();

	/** 프로세스 수명 동안 단조 증가 — evict돼도 재사용하지 않는다. */
	private long seq;

	/**
	 * 구독자 콜백 — 서비스층 타입만 받는다({@code ChangeBus.Listener}와 같은 형태다: web 계층이 두 버스의
	 * 서로 다른 규약을 외우지 않게 한다). 응답에 프레임을 쓰는 일은 web 계층의 람다가 한다.
	 *
	 * <p><b>이 콜백 안에서 {@code LogService}에 다시 로그하지 마라</b> — 무한 재귀다.
	 */
	public interface Listener {

		void onLog(LogRecord record);

	}

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
	public List<LogRecord> digest(long atMs) {
		long shifted = atMs + this.tzOffsetMinutes * MS_PER_MINUTE;
		long sinceSixAm = Math.floorMod(shifted - SIX_AM_MS, MS_PER_DAY);
		long boundary = atMs - sinceSixAm;
		long start = boundary - MS_PER_DAY;
		List<LogRecord> window = new ArrayList<>();
		synchronized (this.bufferLock) {
			for (LogRecord record : this.buffer) {
				if (record.ts() >= start && record.ts() < boundary) {
					window.add(record);
				}
			}
		}
		return List.copyOf(window);
	}

	/**
	 * 버퍼 전체의 <b>불변 사본</b>(오래된→최신) — SSE 접속 replay의 원본이다.
	 *
	 * <p><b>절단하지 않는다.</b> replay 상한(최근 2000건)은 라우트가 적용한다 —
	 * Node {@code server/index.js} 1178행 {@code LOG_REPLAY_MAX}가 그 소유자다. 여기서 자르면
	 * {@link #digest(long)}와 다른 창을 갖는 두 번째 절단 지점이 생기고 한쪽만 고쳐도 조용히 갈린다.
	 *
	 * <p>내부 {@code Deque}의 뷰를 주지 않는 이유: replay가 도는 동안 다른 스레드의 append와 겹쳐
	 * {@code ConcurrentModificationException}이 나고, 호출자가 버퍼를 들여다보게 된다.
	 */
	public List<LogRecord> snapshot() {
		synchronized (this.bufferLock) {
			return List.copyOf(this.buffer);
		}
	}

	/**
	 * 구독한다 — 새 레코드마다 {@link Listener#onLog(LogRecord)}가 <b>기록한 스레드에서 동기로</b> 불린다.
	 *
	 * @return 해제 핸들. {@code close()}는 <b>멱등</b>이며 같은 리스너 인스턴스의 다른 구독을 건드리지 않는다
	 *     ({@code ChangeBus.subscribe}와 같은 형태다)
	 */
	public AutoCloseable subscribe(Listener listener) {
		Objects.requireNonNull(listener, "listener");
		this.listeners.add(listener);
		return new Subscription(listener);
	}

	/** 테스트·연결 회수 관측용 — 누수 0을 단언하는 수단이다(step5가 이 값을 본다). */
	public int subscriberCount() {
		return this.listeners.size();
	}

	private LogRecord log(LogRecord.Level level, String message) {
		synchronized (this.notifyLock) {
			LogRecord record;
			synchronized (this.bufferLock) {
				record = append(level, message);
			}
			notifyListeners(record); // 버퍼 monitor 밖 — digest()/snapshot()을 막지 않는다.
			return record;
		}
	}

	/** {@link #bufferLock}을 잡은 채로만 부른다 — seq 증가·record 생성·append·evict가 한 덩어리다. */
	private LogRecord append(LogRecord.Level level, String message) {
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

	/**
	 * 등록 순서대로 통지하고 <b>절대 던지지 않는다</b>. 호출 자리는 {@code RequestLogFilter}의
	 * {@code finally}이므로 예외가 새면 응답이 이미 나간 뒤에 필터가 터진다.
	 */
	private void notifyListeners(LogRecord record) {
		for (Listener listener : this.listeners) {
			try {
				listener.onLog(record);
			}
			catch (RuntimeException ex) {
				// 삼킨다. 여기서 이 서비스에 로그하면 통지 → 로그 → 통지의 무한 재귀다.
			}
		}
	}

	/** epoch ms → 주입 오프셋 벽시계 {@code YYYY-MM-DD HH:MM:SS}(프로세스 TZ 미사용). */
	private String formatTimestamp(long ts) {
		return WALL_CLOCK.format(Instant.ofEpochMilli(ts)
				.atOffset(ZoneOffset.ofTotalSeconds(this.tzOffsetMinutes * 60)));
	}

	/**
	 * 구독 1건의 해제 핸들.
	 *
	 * <p>{@code closed} 플래그가 있는 이유는 {@code ChangeBus.Subscription}과 같다: 해제가 목록 제거뿐이면
	 * <b>이중 close가 같은 리스너의 다른 구독을 지운다</b>(동치 항목 하나가 지워지므로). SSE에서는
	 * "탭 하나를 닫았더니 다른 탭의 스트림이 조용히 죽는" 형태로 나타난다.
	 */
	private final class Subscription implements AutoCloseable {

		private final Listener listener;

		private boolean closed;

		private Subscription(Listener listener) {
			this.listener = listener;
		}

		@Override
		public synchronized void close() {
			if (this.closed) {
				return;
			}
			this.closed = true;
			LogService.this.listeners.remove(this.listener);
		}

	}

}
