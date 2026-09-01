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
 * <h2>통지는 호출 스레드에서 돌되, 어떤 전역 락도 잡지 않는다 — 락이 셋인 이유</h2>
 * {@code log(...)}는 <b>바깥 {@code notifyLock} → 안쪽 {@code bufferLock}</b> 순서로만 잡고,
 * 그 <b>두 락을 모두 놓은 뒤에</b> 구독자에게 전달한다.
 * <ul>
 * <li><b>{@code bufferLock} 밖에서 통지</b>하는 이유: 느린 구독자가 {@link #digest()}
 * (= {@code GET /api/logs/digest})와 {@link #snapshot()}을 막으면 안 된다(ADR-015 · index.json
 * decisions (11)). 그 둘은 {@code bufferLock}만 잡는다.</li>
 * <li><b>{@code notifyLock}이 남아 있는</b> 이유: 없으면 두 스레드가 append를 끝낸 순서와 구독자
 * 우편함에 적재하는 순서가 달라져 <b>구독자가 {@code seq}를 역전된 순서로 받는다</b>(Node는 단일
 * 스레드라 없는 현상이고, 계약 케이스는 {@code seq > seqBefore} 하한만 보므로 조용히 통과한다 —
 * 변이 M1-8이 8스레드×200회에서 역전 48건으로 실증했다).</li>
 * <li><b>{@code notifyLock} 안에서 하는 일은 「append + 구독자별 우편함에 O(1) 적재」뿐이다.</b>
 * DB도 소켓도 만지지 않는다. 실제 전달(구독자 콜백)은 락을 놓은 뒤 <b>구독자별</b> 드레인 자리에서 돈다.</li>
 * <li>{@link #digest(long)}/{@link #snapshot()}이 {@code bufferLock} <b>하나만</b> 잡고 우편함
 * monitor는 <b>아무 락도 잡지 않는 O(1) 구간</b>이라 대기 사이클이 없다 — 이 규율은 deadlock-free다.
 * <b>순서를 뒤집지 마라.</b></li>
 * </ul>
 * <b>2026-09-01(phase 74 ⑤ 코드리뷰 high) 정정 — 이 문단이 있던 자리에는 정반대의 기록이 있었다.</b>
 * 그전 구조는 구독자 콜백을 {@code notifyLock} <b>안</b>에서 돌렸고, 그 콜백은 (a) {@code authorizePeek}
 * → {@code users.findById} = <b>DB 조회</b>와 (b) {@code ServletOutputStream#write} =
 * <b>블로킹 쓰기</b>를 한다. {@code RequestLogFilter}가 <b>모든 요청</b>의 {@code finally}에서
 * {@code logs.info}를 부르므로 그 구조는 두 가지 사고를 낳는다.
 * <ol>
 * <li><b>순환 대기(deadlock)</b>: {@code ArticleEmbargoService}가 트랜잭션 <b>안</b>에서
 * {@code recorder.record} → {@code HistoryErrorLogger.logs.warn}을 부를 때 그 스레드는
 * <b>유일 커넥션</b>({@code NewsDataSource.MAX_POOL_SIZE = 1})을 쥔 채 {@code notifyLock}을 기다리고,
 * {@code notifyLock}을 쥔 스레드는 그 커넥션을 기다린다. Hikari {@code connectionTimeout} 30초로만 풀린다.
 * ADR-013이 전제한 Node/Spring 동일 {@code news.db} 공존({@code SQLITE_BUSY} → 이력 insert 예외)이면
 * <b>로그 스트림 1개로 성립한다</b>.</li>
 * <li><b>전면 정지</b>: 멈춘 소비자 하나가 {@code notifyLock}을 물면 그 뒤의 모든 요청이 자기
 * {@code finally}에서 줄을 선다.</li>
 * </ol>
 * 두 사고 모두 <b>재현 테스트로 red를 확인한 뒤</b> 이 구조로 바꿔 green이 됐다
 * ({@code LogServiceTest} 항목 5c·5d · {@code LogsStreamWireTest} 항목 22).
 * ADR-008 금지 철자(스레드·타이머·워커풀·{@code CountDownLatch}·대기)는 하나도 쓰지 않았다 —
 * 상태 플래그와 {@code synchronized}뿐이고, <b>드레인은 언제나 트리거 스레드가 한다</b>.
 *
 * <b>남은 대가(정직한 기록)</b>: ① 멈춘 소비자의 우편함은 <b>무한히 자란다</b>. 상한을 두면 로그 줄이
 * 조용히 사라지므로(이 스트림의 계약은 유실 0이다) Node의 {@code res.write}(논블로킹 · 무한 버퍼링)와
 * 같은 선택을 했다 — 회수는 write 실패 → 스트림 자기 봉인 → 구독 해제가 한다. ② 멈춘 구독자의 드레인
 * 자리를 차지한 스레드 <b>하나</b>는 그대로 멈춘다(트리거 스레드 직접 쓰기 모델의 대가다. Tomcat의
 * 블로킹 write는 커넥터 {@code connectionTimeout}에 걸려 결국 예외로 끝난다). ③ 동시 연결 상한이 없어
 * 구독자 N에 전달이 N회 직렬로 돈다 — Node 동형이고 {@code docs/api-contract/sse.md}가 동결한 축이다.
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
	 * 통지 <b>순서</b> monitor — <b>바깥</b> 락이다. 이것이 없으면 구독자가 {@code seq}를 역전된 순서로 받는다.
	 * 획득 순서는 언제나 {@code notifyLock} → {@link #bufferLock} 한 방향이다.
	 *
	 * <p><b>이 락 안에서는 DB도 소켓도 만지지 않는다</b> — append와 우편함 적재(O(1))뿐이다.
	 * 여기에 구독자 콜백을 넣으면 「유일 커넥션 ↔ 이 락」 순환 대기가 되살아난다(클래스 주석의 2026-09-01 정정).
	 */
	private final Object notifyLock = new Object();

	/**
	 * 반복 중 해제가 안전한 컨테이너 — 전달이 도는 동안 구독자가 스스로 봉인해도
	 * {@code ConcurrentModificationException}이 나지 않는다(SSE 종료기가 정확히 그렇게 동작한다).
	 * 적재·전달 순서 = 등록 순서다(결정성).
	 */
	private final List<Subscription> subscriptions = new CopyOnWriteArrayList<>();

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
	 * 구독한다 — 새 레코드마다 {@link Listener#onLog(LogRecord)}가 <b>기록한(트리거) 스레드에서 동기로</b>
	 * 불린다. 앱 스레드·타이머·워커풀은 없다(ADR-008).
	 *
	 * <p><b>다만 「그 레코드를 append한 바로 그 스레드」라고 단정하지 마라.</b> 이미 다른 트리거 스레드가
	 * 이 구독자를 드레인 중이면 전달은 그 스레드가 이어서 한다(그래야 멈춘 소비자가 모두를 세우지 않는다).
	 * <b>전달 순서는 언제나 {@code seq} 오름차순</b>이고, 그 사실은 {@code LogServiceTest} 항목 5b가 잠근다.
	 *
	 * @return 해제 핸들. {@code close()}는 <b>멱등</b>이며 같은 리스너 인스턴스의 다른 구독을 건드리지 않는다
	 *     ({@code ChangeBus.subscribe}와 같은 형태다)
	 */
	public AutoCloseable subscribe(Listener listener) {
		Objects.requireNonNull(listener, "listener");
		Subscription subscription = new Subscription(listener);
		this.subscriptions.add(subscription);
		return subscription;
	}

	/** 테스트·연결 회수 관측용 — 누수 0을 단언하는 수단이다(step5가 이 값을 본다). */
	public int subscriberCount() {
		return this.subscriptions.size();
	}

	/**
	 * 순서 확정과 전달을 <b>두 구간</b>으로 나눈다.
	 *
	 * <ol>
	 *   <li><b>{@code notifyLock} 안</b>: append + 구독자별 우편함에 O(1) 적재. DB·소켓 접근 0.
	 *       이 구간이 전달 순서를 확정한다(우편함은 FIFO이고 드레인은 한 번에 한 스레드다).</li>
	 *   <li><b>락 밖</b>: 구독자별로 FIFO 드레인. 이미 다른 스레드가 그 구독자를 드레인 중이면
	 *       <b>즉시 돌아온다</b> — 그 스레드가 방금 적재한 것까지 가져간다(우편함 monitor 안에서
	 *       「비었음 확인 + 드레인 자리 반납」을 함께 하므로 신호를 흘리지 않는다).</li>
	 * </ol>
	 * 그래서 멈춘 소비자는 <b>자기 드레인 자리 하나</b>만 붙들고 전역 락도, DB 커넥션 대기도 만들지 않는다.
	 */
	private LogRecord log(LogRecord.Level level, String message) {
		LogRecord record;
		synchronized (this.notifyLock) {
			synchronized (this.bufferLock) {
				record = append(level, message);
			}
			// 버퍼 monitor 밖 — digest()/snapshot()을 막지 않는다. 여기서 하는 일은 적재뿐이다.
			for (Subscription subscription : this.subscriptions) {
				subscription.enqueue(record);
			}
		}
		// notifyLock 밖 — 구독자 콜백(DB 재검증 + 블로킹 write)은 어떤 전역 락도 잡지 않는다.
		for (Subscription subscription : this.subscriptions) {
			subscription.drain();
		}
		return record;
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

	/** epoch ms → 주입 오프셋 벽시계 {@code YYYY-MM-DD HH:MM:SS}(프로세스 TZ 미사용). */
	private String formatTimestamp(long ts) {
		return WALL_CLOCK.format(Instant.ofEpochMilli(ts)
				.atOffset(ZoneOffset.ofTotalSeconds(this.tzOffsetMinutes * 60)));
	}

	/**
	 * 구독 1건 — 해제 핸들이자 <b>그 구독자의 우편함</b>이다.
	 *
	 * <h2>우편함이 있는 이유</h2>
	 * 순서는 {@link #enqueue(LogRecord)}가 {@code notifyLock} 안에서 확정하고(FIFO), <b>전달은 락 밖에서</b>
	 * {@link #drain()}이 한다. 그래서 DB 조회와 블로킹 write가 전역 락 밖으로 나가고, 멈춘 소비자는
	 * 자기 우편함만 붙든다(클래스 주석의 2026-09-01 정정).
	 *
	 * <h2>드레인은 한 번에 한 스레드다</h2>
	 * {@code draining} 플래그가 그 자리를 지킨다. 자리를 잡지 못한 스레드는 <b>기다리지 않고</b> 돌아간다 —
	 * 기다리면 멈춘 소비자가 다시 모두를 세운다. 자리를 잡은 스레드가 우편함이 빌 때까지 돌고,
	 * 「비었음 확인 + 자리 반납」을 <b>같은 monitor 안에서</b> 하므로 그 사이에 적재된 레코드를 흘리지 않는다
	 * (적재는 언제나 {@code drain()} 시도보다 먼저다 — {@link LogService#log}의 두 루프 순서가 그 계약이다).
	 *
	 * <h2>{@code closed} 플래그가 있는 이유</h2>
	 * {@code ChangeBus.Subscription}과 같다: 해제가 목록 제거뿐이면 <b>이중 close가 같은 리스너의 다른
	 * 구독을 지운다</b>. SSE에서는 "탭 하나를 닫았더니 다른 탭의 스트림이 조용히 죽는" 형태로 나타난다.
	 * 해제된 구독은 목록에서 빠지므로 우편함에 남은 레코드는 그대로 버려진다(닫힌 응답에 쓰지 않는다).
	 *
	 * <h2>재귀 금지 규율은 그대로다 — 다만 증상이 바뀐다</h2>
	 * 콜백이 이 서비스에 다시 로그하면 그 레코드는 <b>자기 우편함</b>에 쌓이고 지금 도는 드레인 루프가
	 * 곧바로 다시 집는다 — 즉 {@code StackOverflowError}(변이 M1-7의 옛 증상)가 아니라 <b>끝나지 않는
	 * 드레인 루프</b>가 된다. 금지의 이유가 약해진 것이 아니라 <b>더 조용해졌다</b>.
	 */
	private final class Subscription implements AutoCloseable {

		private final Listener listener;

		/** 적재 순서 = 전달 순서. {@link #mailboxLock} 안에서만 만진다. */
		private final Deque<LogRecord> mailbox = new ArrayDeque<>();

		/**
		 * 우편함 monitor — 이 안에서 하는 일은 <b>전부 O(1)</b>이고 다른 락을 잡지 않는다.
		 * 그래서 어떤 대기 사이클에도 끼지 않는다.
		 */
		private final Object mailboxLock = new Object();

		private boolean draining;

		private boolean closed;

		private Subscription(Listener listener) {
			this.listener = listener;
		}

		/** {@code notifyLock}을 잡은 채로만 부른다 — 이 호출 순서가 곧 전달 순서다. */
		private void enqueue(LogRecord record) {
			synchronized (this.mailboxLock) {
				this.mailbox.addLast(record);
			}
		}

		/** 어떤 락도 잡지 않은 채로 부른다 — 구독자 콜백이 DB를 읽고 소켓에 블로킹 write를 한다. */
		private void drain() {
			synchronized (this.mailboxLock) {
				if (this.draining) {
					return; // 다른 트리거 스레드가 이미 돌고 있다. 그 스레드가 방금 적재한 것도 가져간다.
				}
				this.draining = true;
			}
			try {
				while (true) {
					LogRecord next;
					synchronized (this.mailboxLock) {
						next = this.mailbox.pollFirst();
						if (next == null) {
							this.draining = false; // 비었음 확인과 자리 반납은 한 덩어리다.
							return;
						}
					}
					deliver(next);
				}
			}
			catch (RuntimeException | Error ex) {
				// 자리를 반납하지 않으면 이 구독자는 영원히 침묵한다. 예외는 그대로 올려 보낸다
				// (deliver가 RuntimeException을 삼키므로 여기 오는 것은 사실상 Error뿐이다).
				synchronized (this.mailboxLock) {
					this.draining = false;
				}
				throw ex;
			}
		}

		/** <b>절대 던지지 않는다</b> — 호출 자리는 {@code RequestLogFilter}의 {@code finally}다. */
		private void deliver(LogRecord record) {
			try {
				this.listener.onLog(record);
			}
			catch (RuntimeException ex) {
				// 삼킨다. 여기서 이 서비스에 로그하면 통지 → 로그 → 통지의 무한 재귀다.
			}
		}

		@Override
		public synchronized void close() {
			if (this.closed) {
				return;
			}
			this.closed = true;
			LogService.this.subscriptions.remove(this);
		}

	}

}
