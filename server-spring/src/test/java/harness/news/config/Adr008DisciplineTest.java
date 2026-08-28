package harness.news.config;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.regex.Pattern;
import java.util.stream.Stream;
import org.junit.jupiter.api.Test;

/**
 * 정적 잠금: main 소스는 <b>앱 내 타이머·비동기/재시도·네트워크 클라이언트·파일 쓰기</b>를 두지 않는다
 * (ADR-008 (1)(3)(6) · ADR-007 "앱에 타이머/외부 egress 없음").
 *
 * <p>왜 정적 스캔인가(phase 70 testing_gate 변이 ⑧의 교훈): 규칙이 문서·주석에만 있고 기계가 지키지
 * 않으면, 그 규칙을 어긴 코드는 <b>결과가 같은 한</b> 어떤 테스트도 red를 내지 않는다. 이 phase와 후속
 * 배부 phase는 그 유혹이 가장 큰 자리다 — 시점 배부에 {@code @Scheduled}, 배부 실패에 {@code @Retryable},
 * 송고 훅에 {@code @Async}, 수집 pull에 {@code RestTemplate}을 쓰고 싶어진다. 전부 ADR-008과 정면 충돌이다.
 *
 * <p><b>정당한 예외는 정확히 4개</b>이고 <b>경로 단위 명시 목록</b>이다({@code ClockDisciplineTest}의
 * {@code CLOCK_FACTORY_FILES}와 같은 이유 — 예외가 늘어나면 그 사실이 diff에 보인다).
 * <ul>
 * <li><b>네트워크 클라이언트 ①</b> — {@code harness/news/service/HttpApiSourceFetcher.java}. ADR-008의
 * egress 금지는 <b>배부</b> 축이고, 수집 pull은 {@code rcv.md}가 정의한 능동 수집이라 아웃바운드 호출이
 * 기능 그 자체다.</li>
 * <li><b>네트워크 클라이언트 ②</b> — {@code harness/news/service/HttpExternalProxyClient.java}.
 * <b>{@code ADR-014}가 결정한 서버 보유 키 프록시</b>다: 미디어 검색(CSE·YouTube)과 번역(Translate v2)은
 * <b>사용자 트리거 동기 1회</b> 조회이며(앱이 시점을 정하지 않는다), 키를 클라이언트에 내리지 않기 위해
 * 서버가 대신 나가는 것이 <b>기능 그 자체</b>다. 근거는 {@code ADR-014} 하나다 — {@code ADR-005}를
 * 인용하지 마라(그 ADR은 SSE 단방향 무효화 스트림 결정이고, Node 주석의 'ADR-005 서버 프록시'는
 * {@code ADR-014} 트레이드오프가 기록한 <b>오인용</b>이다).</li>
 * <li><b>파일 쓰기 ①</b> — {@code harness/news/service/SpoolWriter.java}. 배부는 파일 스풀 outbound가
 * 전송 수단이다.</li>
 * <li><b>파일 쓰기 ②</b> — {@code harness/news/service/UploadStore.java}. {@code POST /api/upload}는
 * <b>파일 저장이 라우트의 정의</b>다(파일 쓰기 금지의 취지는 "앱이 몰래 어딘가에 쓰지 않는다"이다).</li>
 * </ul>
 * 예외 항목은 {@code src/main/java} 기준 <b>상대 경로</b>다(2026-08-25 ⑤ 코드리뷰 반려 폐색 — 파일
 * <b>이름</b>으로 성립하면 같은 이름을 다른 패키지에 두는 것만으로 예외가 새로 생긴다).
 * {@code HttpExternalProxyClient.java}는 <b>아직 없고</b> 그 경로는 <b>예약된 자리</b>다
 * ({@code phases/73-spring-media-upload} step5가 만든다 — 71a가 {@code SpoolWriter.java}에 대해 한 것과
 * 같다). 그 step이 다른 패키지를 고른다면 이 목록의 경로를 고쳐야 하고, 그때 <b>결정이 diff에 남는다</b>
 * (그것이 이 규율의 목적이다). 스캔은 파일이 없으면 아무 일도 하지 않으므로 자리를 미리 잡아 두는 것은
 * 무해하다 — 대신 예외 분기가 한 번도 실행되지 않으므로
 * {@link #theExemptionAppliesOnlyToItsOwnFileAndItsOwnGroup}이 판정 함수를 <b>직접</b> 부른다.
 * <b>주기 실행·비동기·재시도는 예외 0</b>이다.
 *
 * <p><b>이 확대가 방어를 얼마나 약화시키는가(정직한 평가 · 2026-08-28 phase 73 step2)</b>: 예외 파일이
 * 2 → 4가 되면 "그 파일 안에서는 그 군의 어떤 API나 가능"한 <b>면적도 2배</b>가 된다. 특히
 * {@code UploadStore}는 <b>경로를 인자로 받는 파일 쓰기</b>를 갖게 되므로, 그 안에서 경로 합성이 틀리면
 * 이 정적 스캔은 아무것도 잡지 못한다(스캔은 "무엇을 부르는가"만 보고 "어디에 쓰는가"는 보지 못한다).
 * 그래서 완화책 셋을 함께 건다.
 * <ol>
 * <li>신설 2파일은 <b>1·2군(주기 실행·비동기/재시도)에는 예외가 아니다</b> — 군 교차 누출 금지를 신설
 * 2파일에 대해서도 단언한다({@link #theExemptionAppliesOnlyToItsOwnFileAndItsOwnGroup}).</li>
 * <li>{@code UploadStore}는 <b>경로를 밖에서 받지 않는다</b> — {@code AppProperties}에서 스스로 도출한
 * uploads 루트 아래에만 쓰고, 파일명은 자기가 발급한 {@code <32hex>.<검증된 ext>}뿐이며 호출자가 준
 * 문자열을 경로에 이어 붙이는 API를 노출하지 않는다({@code UploadStoreTest}가 그 경계를 단언한다).</li>
 * <li>step2와 step10이 <b>우회를 심어 비공허성을 실증</b>한다(71a ④ 12종 · 72 ④ 11종의 절차 승계).</li>
 * </ol>
 *
 * <p><b>덮는 벡터</b>: 리터럴로 쓴 애노테이션·타입·메서드 호출.
 * <b>덮지 못하는 벡터</b>: 문자열을 끊어 쓰거나 리플렉션·{@code String.format}으로 만든 호출, 라이브러리가
 * 내부에서 도는 타이머, 그리고 "규칙은 지켰는데 의미가 틀린" 코드. <b>실질 그물은 각 step의 행동 단언</b>
 * (스풀 파일 개수·이력 행 수·응답 키 집합·{@code --dual-run} diff 0)이다 — 스캔을 넓혀 오탐을 늘리지
 * 않는다(정규식이 넓어질수록 정상 코드를 막는 비용이 커지고, 그 벡터의 실질 방어선은 행동 단언이다 —
 * phase 70 remaining_gaps ⑤).
 *
 * <p>판정 전에 주석을 지운다. 규칙을 <b>설명하는</b> 문장({@code LogService}·{@code LoginRateLimit}의
 * javadoc은 실제로 {@code @Scheduled}를 언급한다)이 위반으로 잡히면 규칙을 문서화할 수 없기 때문이다.
 */
class Adr008DisciplineTest {

	private static final Path MAIN_SOURCES = Path.of("src", "main", "java");

	/** 3군 예외 ①의 <b>자리</b> — {@code src/main/java} 기준 상대 경로다(이 파일은 이미 존재한다). */
	private static final String NETWORK_CLIENT_FILE = "harness/news/service/HttpApiSourceFetcher.java";

	/**
	 * 3군 예외 ②의 <b>예약된 자리</b> — 아직 없는 파일이다({@code phases/73-spring-media-upload} step5).
	 * 근거는 {@code ADR-014}(서버 보유 키 프록시 — 미디어 검색·번역의 사용자 트리거 동기 1회 조회)다.
	 * 그 step이 다른 패키지를 고르면 <b>이 상수를 고쳐야</b> 하고 그때 결정이 diff에 남는다.
	 */
	private static final String EXTERNAL_PROXY_FILE = "harness/news/service/HttpExternalProxyClient.java";

	/** 4군 예외 ①의 <b>자리</b> — 배부 스풀 게시({@code phases/72-spring-distribution} step3이 만들었다). */
	private static final String SPOOL_WRITER_FILE = "harness/news/service/SpoolWriter.java";

	/**
	 * 4군 예외 ②의 <b>자리</b> — 업로드 저장({@code phases/73-spring-media-upload} step2가 만든다).
	 * {@code POST /api/upload}는 파일 저장이 라우트의 정의라 파일 쓰기가 기능 그 자체다.
	 */
	private static final String UPLOAD_STORE_FILE = "harness/news/service/UploadStore.java";

	/**
	 * 금지 규칙 한 묶음 — 이름 · 패턴 목록 · <b>경로 단위 예외</b>.
	 *
	 * <p>예외를 규칙 안에 묶어 두는 이유: 예외가 <b>자기 군에만</b> 적용된다는 사실이 구조로 보장된다
	 * (수집 어댑터가 타이머를 돌리거나 스풀 라이터가 네트워크를 여는 것은 여전히 red다).
	 *
	 * @param exemptPaths {@code src/main/java} 기준 상대 경로({@code /} 구분자). <b>이름이 아니라 경로</b>다
	 * — 이름 매칭이면 같은 이름을 다른 패키지에 둔 파일이 예외를 가져간다.
	 */
	private record Rule(String name, List<Pattern> patterns, List<String> exemptPaths) {
	}

	/**
	 * 1군 — 주기 실행(예외 0). ADR-008 (3): 시점 배부는 앱 내 타이머가 아니라 tick pull이다.
	 *
	 * <p><b>2026-08-25 ④ 테스트 게이트 변이 실측</b>: {@code ScheduledThreadPoolExecutor}(인터페이스가
	 * 아니라 구현 클래스로 선언)와 {@code TimeUnit.SECONDS.sleep(...)}은 <b>둘 다 통과했다</b>. 문자열
	 * 조립도 리플렉션도 아닌 <b>가장 평범한 JDK 표기</b>이며 실제로 손이 먼저 가는 형태다 —
	 * "덮지 못하는 벡터(끊어 쓴 문자열·리플렉션)"와 성질이 다르므로 여기서 닫는다.
	 */
	private static final Rule PERIODIC_EXECUTION = new Rule("주기 실행", List.of(
			Pattern.compile("@\\s*(?:[\\w.]+\\.)?Scheduled\\b"),
			Pattern.compile("@\\s*(?:[\\w.]+\\.)?EnableScheduling\\b"),
			Pattern.compile("\\bTaskScheduler\\b"),
			Pattern.compile("\\bScheduledExecutorService\\b"),
			Pattern.compile("\\bScheduledThreadPoolExecutor\\b"),
			Pattern.compile("\\bExecutors\\s*\\.\\s*newScheduled\\w*\\s*\\("),
			Pattern.compile("\\bnew\\s+(java\\.util\\.)?Timer\\s*\\("),
			Pattern.compile("\\bThread\\s*\\.\\s*sleep\\s*\\("),
			// TimeUnit.SECONDS.sleep(...)·MILLISECONDS.sleep(...) — Thread.sleep의 다른 철자다.
			Pattern.compile("\\bTimeUnit\\s*\\.\\s*\\w+\\s*\\.\\s*sleep\\s*\\("),
			Pattern.compile("\\.\\s*schedule(AtFixedRate|WithFixedDelay)?\\s*\\("),
			Pattern.compile("\\bScheduledFuture\\b"),
			// 2026-08-26 ④ 게이트 변이 실측에서 통과했던 '다른 철자의 sleep' — 요청 스레드를 재우는 것은
			// 표기가 무엇이든 앱 내 타이밍이다(백오프가 손대는 첫 자리다 · ADR-008 (6)).
			Pattern.compile("\\bLockSupport\\b"),
			Pattern.compile("\\.\\s*park(Nanos|Until)?\\s*\\("),
			Pattern.compile("\\.\\s*await\\s*\\(")),
			List.of());

	/**
	 * 2군 — 비동기·재시도(예외 0). ADR-008 (6): 자동 재시도·백오프·재시도 큐를 두지 않는다.
	 *
	 * <p><b>변이 실측</b>: {@code new Thread(...).start()} · {@code ForkJoinPool.commonPool().execute(...)}
	 * · {@code ThreadPoolExecutor}는 전부 통과했다. 요청 스레드 밖에서 도는 코드는 그 자체가 이 축의
	 * 위반이다(응답이 끝난 뒤에 무슨 일이 벌어지는지 계약이 관측할 방법이 없다).
	 */
	private static final Rule ASYNC_AND_RETRY = new Rule("비동기·재시도", List.of(
			Pattern.compile("@\\s*(?:[\\w.]+\\.)?Async\\b"),
			Pattern.compile("@\\s*(?:[\\w.]+\\.)?EnableAsync\\b"),
			Pattern.compile("@\\s*(?:[\\w.]+\\.)?Retryable\\b"),
			Pattern.compile("@\\s*(?:[\\w.]+\\.)?EnableRetry\\b"),
			Pattern.compile("\\bRetryTemplate\\b"),
			Pattern.compile("\\bCompletableFuture\\s*\\.\\s*\\w*Async\\w*\\s*\\("),
			Pattern.compile("\\bExecutorService\\b"),
			Pattern.compile("\\bThreadPoolExecutor\\b"),
			Pattern.compile("\\bForkJoinPool\\b"),
			Pattern.compile("\\b(?:Task|Async(?:Task)?)Executor\\b"),
			Pattern.compile("\\bExecutors\\s*\\.\\s*new\\w+\\s*\\("),
			Pattern.compile("\\bnew\\s+(java\\.lang\\.)?Thread\\s*\\("),
			Pattern.compile("@\\s*(?:[\\w.]+\\.)?Recover\\b"),
			// 2026-08-26 ④ 게이트 변이 실측에서 통과했던 JDK21 표기 — new Thread(도 Executors.도 거치지
			// 않고 요청 스레드 밖에서 코드를 돌리는 가장 짧은 철자다(가장 손이 먼저 가는 형태이기도 하다).
			Pattern.compile("\\bThread\\s*\\.\\s*startVirtualThread\\s*\\("),
			Pattern.compile("\\bThread\\s*\\.\\s*of(Virtual|Platform)\\s*\\("),
			Pattern.compile("\\bCountDownLatch\\b")),
			List.of());

	/**
	 * 3군 — 네트워크 클라이언트(예외 2: 수집 pull 어댑터 · {@code ADR-014} 서버 보유 키 프록시).
	 *
	 * <p><b>변이 실측</b>: {@code url.openStream()}은 통과했다 — {@code openConnection()}의 한 줄 축약형이고
	 * 바깥으로 나가는 것은 똑같다.
	 */
	private static final Rule NETWORK_CLIENT = new Rule("네트워크 클라이언트", List.of(
			Pattern.compile("\\bHttpClient\\b"),
			Pattern.compile("\\bRestTemplate\\b"),
			Pattern.compile("\\bWebClient\\b"),
			Pattern.compile("\\bRestClient\\b"),
			Pattern.compile("\\bnew\\s+(java\\.net\\.)?Socket\\s*\\("),
			Pattern.compile("\\.\\s*openConnection\\s*\\("),
			Pattern.compile("\\.\\s*openStream\\s*\\("),
			Pattern.compile("\\bSocketChannel\\b"),
			Pattern.compile("\\bDatagramSocket\\b"),
			Pattern.compile("\\bURLConnection\\b"),
			Pattern.compile("\\bHttpURLConnection\\b"),
			// 2026-08-26 ④ 게이트 변이 실측에서 통과했던 형태들. AsynchronousSocketChannel은 \bSocketChannel\b이
			// 낱말 경계 때문에 잡지 못하고(앞 글자가 단어 문자다), URL.getContent()는 openStream()을 감춘
			// 한 줄 축약형이다 — 둘 다 밖으로 나간다.
			Pattern.compile("\\bAsynchronous(Server)?SocketChannel\\b"),
			Pattern.compile("\\.\\s*getContent\\s*\\(")),
			List.of(NETWORK_CLIENT_FILE, EXTERNAL_PROXY_FILE));

	/**
	 * 4군 — 파일 쓰기(예외 2: 배부 스풀 라이터 · 업로드 저장소).
	 *
	 * <p><b>변이 실측</b>: {@code java.io}의 옛 표기가 통째로 비어 있었다 — {@code RandomAccessFile} ·
	 * {@code PrintWriter} · {@code FileChannel.open(..., WRITE)} · {@code File.mkdirs()} ·
	 * {@code createNewFile()} · {@code renameTo()}가 전부 통과했다. 배부 스풀이 바로 이 API들을 쓰고 싶어지는
	 * 자리이므로({@code phases/72-spring-distribution}) 그 phase가 시작되기 전에 닫아 둔다.
	 */
	private static final Rule FILE_WRITE = new Rule("파일 쓰기", List.of(
			Pattern.compile("\\bFiles\\s*\\.\\s*write(String)?\\s*\\("),
			Pattern.compile("\\bFiles\\s*\\.\\s*newOutputStream\\s*\\("),
			Pattern.compile("\\bFiles\\s*\\.\\s*newBufferedWriter\\s*\\("),
			Pattern.compile("\\bFiles\\s*\\.\\s*newByteChannel\\s*\\("),
			Pattern.compile("\\bFileOutputStream\\b"),
			Pattern.compile("\\bFileWriter\\b"),
			Pattern.compile("\\bPrintWriter\\b"),
			Pattern.compile("\\bRandomAccessFile\\b"),
			Pattern.compile("\\bFileChannel\\b"),
			Pattern.compile("\\bFiles\\s*\\.\\s*createDirector(y|ies)\\s*\\("),
			Pattern.compile("\\bFiles\\s*\\.\\s*create(File|Temp\\w*)\\s*\\("),
			Pattern.compile("\\bFiles\\s*\\.\\s*move\\s*\\("),
			Pattern.compile("\\bFiles\\s*\\.\\s*copy\\s*\\("),
			Pattern.compile("\\bFiles\\s*\\.\\s*delete(IfExists)?\\s*\\("),
			Pattern.compile("\\.\\s*mkdirs?\\s*\\("),
			Pattern.compile("\\.\\s*createNewFile\\s*\\("),
			Pattern.compile("\\.\\s*renameTo\\s*\\("),
			// 2026-08-26 ④ 게이트 변이 실측에서 통과했던 형태들.
			// AsynchronousFileChannel: \bFileChannel\b이 낱말 경계 때문에 잡지 못한다(앞 글자가 단어 문자다).
			// File.delete()/deleteOnExit(): Files.delete만 막고 있어 java.io 표기의 **파일 삭제**가 어느
			// main 소스에서든 통과했다 — 쓰기보다 위험한 파괴 연산이 4군의 구멍이었다(DB 비파괴와 같은 축).
			Pattern.compile("\\bAsynchronousFileChannel\\b"),
			Pattern.compile("\\.\\s*delete(OnExit)?\\s*\\(\\s*\\)")),
			List.of(SPOOL_WRITER_FILE, UPLOAD_STORE_FILE));

	private static final List<Rule> RULES =
			List.of(PERIODIC_EXECUTION, ASYNC_AND_RETRY, NETWORK_CLIENT, FILE_WRITE);

	/**
	 * 각 군의 <b>심어 둔 위반</b> — 패턴마다 최소 하나씩 둔다. 아래 자기 검사가 "모든 패턴이 적어도 하나를
	 * 잡는다"를 단언하므로, 정규식이 오타·과도한 이스케이프로 죽으면 그 자리에서 red가 난다.
	 *
	 * <p><b>완전 한정 이름 형태를 함께 심는 이유(2026-08-25 변이 실측)</b>: {@code HealthController}에
	 * {@code @org.springframework.scheduling.annotation.Scheduled(fixedDelay = 60000)} 메서드를 심었을 때
	 * 첫 판(패턴 {@code @\s*Scheduled\b})은 <b>green이었다</b> — 애노테이션을 import 없이 한정 이름으로
	 * 쓰면 게이트가 통째로 뚫린다(자바에서 완전히 합법인 형태이고 문자열 조립 같은 우회도 아니다).
	 * 타입·메서드 호출은 {@code \b}가 점 뒤에서도 성립해 원래 잡혔지만({@code java.net.http.HttpClient}·
	 * {@code java.nio.file.Files.write}), 애노테이션만 {@code @} 바로 뒤를 요구해 구멍이 났다. 네 군 모두
	 * 한정 이름 표본을 상주시켜 그 구멍이 다시 열리면 red가 나게 한다.
	 */
	private static final List<String> PLANTED_PERIODIC = List.of(
			"@Scheduled(fixedDelay = 60000)\nvoid tick() { }",
			"@org.springframework.scheduling.annotation.Scheduled(fixedDelay = 60000)\nvoid tick() { }",
			"@EnableScheduling\nclass Wrong { }",
			"@org.springframework.scheduling.annotation.EnableScheduling\nclass Wrong { }",
			"private final TaskScheduler scheduler;",
			"private final ScheduledExecutorService pool;",
			"var pool = Executors.newScheduledThreadPool(1);",
			"Timer timer = new Timer(true);",
			"Thread.sleep(500);",
			// 2026-08-25 ④ 게이트 변이 실측에서 통과했던 형태들 — 이제 red다.
			"private final ScheduledThreadPoolExecutor pool = new ScheduledThreadPoolExecutor(1);",
			"TimeUnit.SECONDS.sleep(3);",
			"pool.scheduleAtFixedRate(this::tick, 0, 60, TimeUnit.SECONDS);",
			"pool.scheduleWithFixedDelay(this::tick, 0, 60, TimeUnit.SECONDS);",
			"ScheduledFuture<?> handle = pool.schedule(task, 1, TimeUnit.SECONDS);",
			// 2026-08-26 ④ 게이트 변이 실측에서 통과했던 형태들 — 이제 red다.
			"LockSupport.parkNanos(1_000_000_000L);",
			"java.util.concurrent.locks.LockSupport.parkUntil(deadline);",
			"latch.await(3, TimeUnit.SECONDS);");

	private static final List<String> PLANTED_ASYNC = List.of(
			"@Async\nvoid publish() { }",
			"@org.springframework.scheduling.annotation.Async\nvoid publish() { }",
			"@EnableAsync\nclass Wrong { }",
			"@org.springframework.scheduling.annotation.EnableAsync\nclass Wrong { }",
			"@Retryable(maxAttempts = 3)\nvoid send() { }",
			"@org.springframework.retry.annotation.Retryable(maxAttempts = 3)\nvoid send() { }",
			"@EnableRetry\nclass Wrong { }",
			"@org.springframework.retry.annotation.Recover\nString fallback(Exception e) { return \"\"; }",
			"private final RetryTemplate retryTemplate;",
			"CompletableFuture.supplyAsync(() -> fetch(url));",
			"CompletableFuture.runAsync(() -> spool(article));",
			"private final ExecutorService workers;",
			// 변이 실측에서 통과했던 형태들 — 요청 스레드 밖에서 도는 코드는 전부 이 축의 위반이다.
			"private final ThreadPoolExecutor workers = null;",
			"ForkJoinPool.commonPool().execute(task);",
			"private final TaskExecutor taskExecutor;",
			"private final AsyncTaskExecutor asyncTaskExecutor;",
			"var workers = Executors.newFixedThreadPool(4);",
			"new Thread(() -> spool(article)).start();",
			"new java.lang.Thread(this::flush).start();",
			"@Recover\nString fallback(Exception e) { return \"\"; }",
			// 2026-08-26 ④ 게이트 변이 실측에서 통과했던 JDK21 표기 — 이제 red다.
			"Thread.startVirtualThread(() -> spool(article));",
			"Thread.ofVirtual().start(task);",
			"Thread.ofPlatform().start(task);",
			"private final CountDownLatch done = new CountDownLatch(1);");

	private static final List<String> PLANTED_NETWORK = List.of(
			"private final HttpClient http = HttpClient.newHttpClient();",
			"private final java.net.http.HttpClient http = java.net.http.HttpClient.newHttpClient();",
			"private final RestTemplate restTemplate = new RestTemplate();",
			"private final WebClient webClient = WebClient.create();",
			"private final RestClient restClient = RestClient.create();",
			"Socket socket = new Socket(host, port);",
			"var conn = url.openConnection();",
			// 변이 실측에서 통과했던 형태 — openConnection의 한 줄 축약형이다.
			"try (var in = url.openStream()) { return in.readAllBytes(); }",
			"SocketChannel channel = null;",
			"DatagramSocket socket = null;",
			"URLConnection conn = null;",
			"HttpURLConnection conn = null;",
			// 2026-08-26 ④ 게이트 변이 실측에서 통과했던 형태들 — 이제 red다.
			"AsynchronousSocketChannel channel = AsynchronousSocketChannel.open();",
			"AsynchronousServerSocketChannel listener = null;",
			"return URI.create(endpoint).toURL().getContent();");

	private static final List<String> PLANTED_FILE_WRITE = List.of(
			"Files.write(target, bytes);",
			"java.nio.file.Files.write(target, bytes);",
			"Files.writeString(target, json, StandardCharsets.UTF_8);",
			"try (var out = Files.newOutputStream(target)) { out.write(bytes); }",
			"try (var w = Files.newBufferedWriter(target)) { w.write(json); }",
			"var out = new FileOutputStream(target.toFile());",
			"var w = new FileWriter(target.toFile());",
			"Files.createDirectories(spoolRoot);",
			"Files.createDirectory(spoolRoot);",
			"Files.move(tmp, target);",
			"Files.copy(tmp, target);",
			"Files.delete(tmp);",
			"Files.deleteIfExists(tmp);",
			// 변이 실측에서 통과했던 java.io 옛 표기 — 배부 스풀이 바로 여기로 손이 간다.
			"try (var ch = Files.newByteChannel(target, StandardOpenOption.WRITE)) { ch.write(buf); }",
			"try (var w = new PrintWriter(target.toFile())) { w.print(json); }",
			"try (var raf = new RandomAccessFile(target.toFile(), \"rw\")) { raf.write(bytes); }",
			"try (var ch = FileChannel.open(target, StandardOpenOption.WRITE)) { ch.write(buf); }",
			"Files.createFile(target);",
			"Files.createTempFile(spoolRoot, \"spool\", \".tmp\");",
			"spoolRoot.toFile().mkdirs();",
			"spoolRoot.toFile().mkdir();",
			"target.toFile().createNewFile();",
			"tmp.toFile().renameTo(target.toFile());",
			// 2026-08-26 ④ 게이트 변이 실측에서 통과했던 형태들 — 이제 red다.
			"try (var ch = AsynchronousFileChannel.open(target, StandardOpenOption.WRITE)) { ch.write(buf, 0L); }",
			"target.toFile().delete();",
			"stale.deleteOnExit();");

	private static List<List<String>> plantedByRule() {
		return List.of(PLANTED_PERIODIC, PLANTED_ASYNC, PLANTED_NETWORK, PLANTED_FILE_WRITE);
	}

	/**
	 * 이 phase(수집)와 다음 phase(배부)가 <b>실제로 쓸</b> 정상 API — 하나라도 여기서 걸리면 스캔이 너무
	 * 넓어 이후 step들을 막는다. 오탐 경계를 적극적으로 단언해 둔다.
	 */
	private static final List<String> ALLOWED_NORMAL_CODE = List.of(
			"private final AtomicBoolean running = new AtomicBoolean(false);",
			"if (!running.compareAndSet(false, true)) { return busy(); }",
			"private final Set<String> inFlight = ConcurrentHashMap.newKeySet();",
			"private final Set<String> guarded = Collections.synchronizedSet(new HashSet<>());",
			"String text = Files.readString(file, StandardCharsets.UTF_8);",
			"if (Files.exists(root) && Files.isDirectory(root)) { return root; }",
			"Path target = Path.of(root.toString(), dir, name);",
			"@TempDir\nPath tempDir;",
			"Instant at = Instant.parse(value);",
			"OffsetDateTime at = OffsetDateTime.parse(value);",
			"Instant now = Instant.now(this.clock); long ms = this.clock.millis();",
			"return this.transactionTemplate.execute((status) -> repository.insert(row));",
			"private final TransactionTemplate transactionTemplate;",
			"void handle(HttpServletRequest request, HttpServletResponse response) { }",
			"private final ConcurrentHashMap<String, Session> sessions = new ConcurrentHashMap<>();");

	/** 1·2군: 앱은 스스로 깨어나지 않고, 스스로 다시 시도하지 않는다. */
	@Test
	void mainSourcesRunNoTimersOrRetries() throws IOException {
		assertTrue(Files.isDirectory(MAIN_SOURCES),
				"스캔 대상이 없다 — 테스트 작업 디렉토리가 모듈 루트가 아니다: " + MAIN_SOURCES.toAbsolutePath());

		List<String> hits = new ArrayList<>();
		hits.addAll(scan(PERIODIC_EXECUTION));
		hits.addAll(scan(ASYNC_AND_RETRY));

		assertTrue(hits.isEmpty(),
				"main 소스에 앱 내 타이머·비동기/재시도가 있다(ADR-008 (3)(6) — 예외 0): " + hits);
	}

	/** 3군: 아웃바운드 호출은 등재된 두 어댑터(수집 pull · {@code ADR-014} 프록시)에서만 일어난다. */
	@Test
	void onlyTheDeclaredOutboundAdaptersTalkToTheNetwork() throws IOException {
		assertTrue(Files.isDirectory(MAIN_SOURCES),
				"스캔 대상이 없다 — 테스트 작업 디렉토리가 모듈 루트가 아니다: " + MAIN_SOURCES.toAbsolutePath());

		List<String> hits = scan(NETWORK_CLIENT);

		assertTrue(hits.isEmpty(),
				"등재된 아웃바운드 어댑터(" + NETWORK_CLIENT.exemptPaths() + ") 밖에서 네트워크 클라이언트를 쓴다"
						+ "(ADR-008 (1) — 배부 축은 egress 0 · ADR-014는 그 두 자리만 연다): " + hits);
	}

	/** 4군: 파일 쓰기는 등재된 두 파일(배부 스풀 라이터 · 업로드 저장소)에서만 일어난다. */
	@Test
	void onlyTheDeclaredWritersWriteFiles() throws IOException {
		assertTrue(Files.isDirectory(MAIN_SOURCES),
				"스캔 대상이 없다 — 테스트 작업 디렉토리가 모듈 루트가 아니다: " + MAIN_SOURCES.toAbsolutePath());

		List<String> hits = scan(FILE_WRITE);

		assertTrue(hits.isEmpty(),
				"등재된 파일 쓰기 지점(" + FILE_WRITE.exemptPaths() + ") 밖에서 파일을 쓴다"
						+ "(ADR-008 (1) — 스풀 쓰기와 업로드 저장은 각각 한 지점): " + hits);
	}

	/**
	 * 예외 목록의 <b>크기와 구성</b>을 못 박는다 — 예외가 늘어나면 그 사실이 반드시 diff와 red로 드러난다
	 * (phase 70 review_gate low의 {@code theDerivedMainJavaListDropsExactlyTheDeleteFromPattern}과 같은 계열).
	 *
	 * <p>{@code phases/72-spring-distribution}은 이 목록을 <b>넓히지 않고</b> {@code SpoolWriter.java}로
	 * 예약된 자리를 채웠다. 목록을 넓히려는 시도는 그 자체가 아키텍처 결정이며 별도 근거가 필요하다 —
	 * {@code phases/73-spring-media-upload} step2가 2 → 4로 넓혔고 근거는 <b>{@code ADR-014}</b>(네트워크 ②)와
	 * <b>업로드 라우트의 정의</b>(파일 쓰기 ②)다. 목록의 <b>순서도 계약</b>이다: 군 순서(네트워크 → 파일 쓰기)를
	 * 유지하고 군 안에서는 도입 순서다(알파벳 정렬로 바꾸면 군 경계가 목록에서 사라진다).
	 * 이 수치는 <b>이름·메시지·단언 세 곳이 함께</b> 움직여야 한다 — 한 곳만 고치면 이 테스트가 주장하는
	 * 문장이 거짓이 된다.
	 */
	@Test
	void theExceptionListIsExactlyFourFiles() {
		List<String> allExemptions = RULES.stream().flatMap((rule) -> rule.exemptPaths().stream()).toList();

		assertEquals(List.of("harness/news/service/HttpApiSourceFetcher.java",
				"harness/news/service/HttpExternalProxyClient.java",
				"harness/news/service/SpoolWriter.java",
				"harness/news/service/UploadStore.java"), allExemptions,
				"ADR-008 예외는 정확히 4파일이고 그 자리(경로)와 순서까지 고정이다"
						+ "(수집 pull 어댑터 · ADR-014 서버 보유 키 프록시 · 배부 스풀 라이터 · 업로드 저장소)");
		assertEquals(4, allExemptions.size(), "예외 목록 크기");
		assertEquals(List.of(), PERIODIC_EXECUTION.exemptPaths(), "주기 실행은 예외 0이다");
		assertEquals(List.of(), ASYNC_AND_RETRY.exemptPaths(), "비동기·재시도는 예외 0이다");
		assertEquals(List.of(NETWORK_CLIENT_FILE, EXTERNAL_PROXY_FILE), NETWORK_CLIENT.exemptPaths(),
				"네트워크 예외는 수집 pull 어댑터와 ADR-014 프록시 둘뿐이다");
		assertEquals(List.of(SPOOL_WRITER_FILE, UPLOAD_STORE_FILE), FILE_WRITE.exemptPaths(),
				"파일 쓰기 예외는 배부 스풀 라이터와 업로드 저장소 둘뿐이다");
		for (String exempt : allExemptions) {
			assertTrue(exempt.contains("/"),
					"예외 항목이 경로가 아니라 이름이다 — 이름 매칭이면 다른 패키지의 동명 파일이 예외를 가져간다: " + exempt);
		}
	}

	/**
	 * 예외는 <b>그 파일에서, 그 군에만</b> 적용된다.
	 *
	 * <p>예외 파일 넷 중 {@code HttpExternalProxyClient}는 이 시점에 <b>아직 없다</b>(step5가 만든다).
	 * 그래서 그 예외 분기는 실제 스캔에서 한 번도 실행되지 않는다 — 그 사이에 분기가 망가지면(예: 파일명이
	 * 아니라 전체 경로로 비교하게 되어 예외가 영영 성립하지 않거나, 반대로 예외가 전 군에 새어 나가거나)
	 * 아무도 모른다. 그래서 판정 함수를 직접 불러 경계를 못 박는다.
	 *
	 * <p>2026-08-28 step2가 <b>신설 2파일의 4경계</b>를 더했다(예외 면적이 2배가 된 데 대한 완화책 ①):
	 * (i) {@code UploadStore}의 파일 쓰기는 허용 (ii) 비-예외 파일의 같은 코드는 위반
	 * (iii) {@code UploadStore}의 {@code HttpClient}는 <b>네트워크 군 위반</b>(파일 쓰기 예외가 새지 않는다)
	 * (iv) {@code HttpExternalProxyClient}의 {@code Files.write}는 <b>파일 쓰기 군 위반</b>이고
	 * {@code @Scheduled}는 <b>주기 실행 군 위반</b>(네트워크 예외가 새지 않는다).
	 */
	@Test
	void theExemptionAppliesOnlyToItsOwnFileAndItsOwnGroup() {
		assertTrue(violations(FILE_WRITE, SPOOL_WRITER_FILE, "Files.write(target, bytes);", "planted").isEmpty(),
				"배부 스풀 라이터의 파일 쓰기는 허용이다(예외가 성립하지 않으면 그 phase가 시작부터 red다)");
		assertFalse(violations(FILE_WRITE, "harness/news/service/ArticleWriteService.java",
				"Files.write(target, bytes);", "planted").isEmpty(), "예외 파일이 아닌 곳의 파일 쓰기까지 허용하고 있다");
		assertTrue(violations(NETWORK_CLIENT, NETWORK_CLIENT_FILE,
				"HttpClient http = HttpClient.newHttpClient();", "planted").isEmpty(),
				"수집 pull 어댑터의 아웃바운드 호출은 허용이다(기능 그 자체다 — rcv.md 능동 수집)");
		assertFalse(violations(NETWORK_CLIENT, SPOOL_WRITER_FILE,
				"HttpClient http = HttpClient.newHttpClient();", "planted").isEmpty(),
				"파일 쓰기 예외가 네트워크 군까지 새어 나간다");
		assertFalse(violations(PERIODIC_EXECUTION, SPOOL_WRITER_FILE,
				"@Scheduled(fixedDelay = 1000)\nvoid flush() { }", "planted").isEmpty(),
				"예외 파일이라도 앱 내 타이머는 금지다(1군 예외 0)");
		assertFalse(violations(ASYNC_AND_RETRY, NETWORK_CLIENT_FILE,
				"@Retryable(maxAttempts = 3)\nString fetch() { return \"\"; }", "planted").isEmpty(),
				"예외 파일이라도 재시도는 금지다(2군 예외 0 — ADR-008 (6))");

		// (i)(ii) 업로드 저장소는 파일 쓰기 예외다 — 비-예외 파일의 같은 코드는 여전히 위반이다.
		assertTrue(violations(FILE_WRITE, UPLOAD_STORE_FILE,
				"Files.write(target, bytes, StandardOpenOption.CREATE_NEW);", "planted").isEmpty(),
				"업로드 저장소의 파일 쓰기는 허용이다(POST /api/upload는 파일 저장이 라우트의 정의다)");
		assertFalse(violations(FILE_WRITE, "harness/news/service/ArticleWriteService.java",
				"Files.write(target, bytes, StandardOpenOption.CREATE_NEW);", "planted").isEmpty(),
				"예외 파일이 아닌 곳의 CREATE_NEW 쓰기까지 허용하고 있다");

		// (iii) 파일 쓰기 예외가 네트워크 군으로 새지 않는다.
		assertFalse(violations(NETWORK_CLIENT, UPLOAD_STORE_FILE,
				"HttpClient http = HttpClient.newHttpClient();", "planted").isEmpty(),
				"업로드 저장소의 파일 쓰기 예외가 네트워크 군까지 새어 나간다");
		assertFalse(violations(PERIODIC_EXECUTION, UPLOAD_STORE_FILE,
				"@Scheduled(fixedDelay = 1000)\nvoid flush() { }", "planted").isEmpty(),
				"업로드 저장소라도 앱 내 타이머는 금지다(1군 예외 0)");
		assertFalse(violations(ASYNC_AND_RETRY, UPLOAD_STORE_FILE,
				"@Retryable(maxAttempts = 3)\nvoid save() { }", "planted").isEmpty(),
				"업로드 저장소라도 재시도는 금지다(2군 예외 0 — 충돌 시 재시도는 ADR-008 위반이자 divergence다)");

		// (iv) 네트워크 예외(ADR-014 프록시)가 파일 쓰기·주기 실행 군으로 새지 않는다.
		assertTrue(violations(NETWORK_CLIENT, EXTERNAL_PROXY_FILE,
				"HttpClient http = HttpClient.newHttpClient();", "planted").isEmpty(),
				"ADR-014 프록시의 아웃바운드 호출은 허용이다(예약 자리가 성립하지 않으면 step5가 시작부터 red다)");
		assertFalse(violations(FILE_WRITE, EXTERNAL_PROXY_FILE, "Files.write(target, bytes);", "planted").isEmpty(),
				"네트워크 예외가 파일 쓰기 군까지 새어 나간다");
		assertFalse(violations(PERIODIC_EXECUTION, EXTERNAL_PROXY_FILE,
				"@Scheduled(fixedDelay = 1000)\nvoid flush() { }", "planted").isEmpty(),
				"ADR-014 프록시라도 앱 내 타이머는 금지다(1군 예외 0 — 외부 호출은 1회 시도뿐이다)");
		assertFalse(violations(ASYNC_AND_RETRY, EXTERNAL_PROXY_FILE,
				"CompletableFuture.supplyAsync(() -> fetch(url));", "planted").isEmpty(),
				"ADR-014 프록시라도 비동기·재시도는 금지다(2군 예외 0 — sendAsync 금지의 정적 대응물이다)");
	}

	/**
	 * <b>오배치한 동명 파일은 예외를 가져가지 못한다</b>(2026-08-25 ⑤ 코드리뷰 반려 폐색).
	 *
	 * <p>④ 게이트의 변이 실측이 남긴 잔여 구멍이다: {@code harness.news.zzprobe.SpoolWriter}에
	 * {@code Files.write}를 심었을 때 게이트가 <b>green</b>이었다(예외가 파일 <b>이름</b>으로 성립했다).
	 * 이제 예외는 경로로 성립하므로 같은 이름을 다른 패키지에 두어도 스캔이 그것을 위반으로 본다 —
	 * {@code phases/72-spring-distribution}이 스풀 라이터를 엉뚱한 패키지에 두면 <b>조용히 통과하지 않고</b>
	 * red가 난다.
	 *
	 * <p>판정 함수를 직접 부른다: 예외 파일 둘 중 하나(SpoolWriter)는 아직 <b>존재하지 않아</b> 실제
	 * 스캔으로는 이 분기가 한 번도 실행되지 않기 때문이다.
	 */
	@Test
	void aMisplacedFileWithAnExemptNameIsNotExempt() {
		assertFalse(violations(FILE_WRITE, "harness/news/zzprobe/SpoolWriter.java", "Files.write(target, bytes);",
				"planted").isEmpty(), "다른 패키지의 SpoolWriter.java가 파일 쓰기 예외를 가져간다");
		assertFalse(violations(NETWORK_CLIENT, "harness/news/zzprobe/HttpApiSourceFetcher.java",
				"HttpClient http = HttpClient.newHttpClient();", "planted").isEmpty(),
				"다른 패키지의 HttpApiSourceFetcher.java가 네트워크 예외를 가져간다");
		assertFalse(violations(NETWORK_CLIENT, "HttpApiSourceFetcher.java",
				"HttpClient http = HttpClient.newHttpClient();", "planted").isEmpty(),
				"패키지 없이 소스 루트에 둔 동명 파일이 예외를 가져간다(이름 매칭의 잔재)");

		// 2026-08-28 step2가 신설한 예외 2개도 같은 규율 아래 있다(예외가 늘어난 만큼 이 축의 표면도 늘었다).
		assertFalse(violations(FILE_WRITE, "harness/news/zzprobe/UploadStore.java", "Files.write(target, bytes);",
				"planted").isEmpty(), "다른 패키지의 UploadStore.java가 파일 쓰기 예외를 가져간다");
		assertFalse(violations(NETWORK_CLIENT, "harness/news/zzprobe/HttpExternalProxyClient.java",
				"HttpClient http = HttpClient.newHttpClient();", "planted").isEmpty(),
				"다른 패키지의 HttpExternalProxyClient.java가 네트워크 예외를 가져간다");
		assertFalse(violations(FILE_WRITE, "UploadStore.java", "Files.write(target, bytes);", "planted").isEmpty(),
				"패키지 없이 소스 루트에 둔 동명 UploadStore.java가 예외를 가져간다");
		assertFalse(violations(NETWORK_CLIENT, "harness/news/controller/HttpExternalProxyClient.java",
				"HttpClient http = HttpClient.newHttpClient();", "planted").isEmpty(),
				"컨트롤러 패키지에 둔 동명 HttpExternalProxyClient.java가 네트워크 예외를 가져간다");
	}

	/**
	 * 자기 검사 ① — 스캐너가 <b>공허하지 않다</b>는 증거. 각 군에 실제 변이와 같은 형태를 심어 잡히는지
	 * 확인하고, 동시에 <b>모든 패턴이 적어도 하나를 잡는지</b>도 단언한다(죽은 정규식이 남지 않는다).
	 */
	@Test
	void theScannerDetectsAPlantedViolationInEveryGroup() {
		for (int i = 0; i < RULES.size(); i++) {
			Rule rule = RULES.get(i);
			List<String> planted = plantedByRule().get(i);

			for (String snippet : planted) {
				assertTrue(matches(rule, snippet),
						"심어 둔 " + rule.name() + " 위반을 잡지 못한다 — 스캐너가 공허하다: " + snippet);
			}
			for (Pattern pattern : rule.patterns()) {
				assertTrue(planted.stream().anyMatch((snippet) -> pattern.matcher(stripComments(snippet)).find()),
						rule.name() + " 패턴이 어떤 심은 위반도 잡지 못한다(죽은 정규식): " + pattern.pattern());
			}
			assertFalse(rule.patterns().isEmpty(), rule.name() + " 패턴 목록이 비었다 — 그 군은 아무것도 막지 못한다");
		}
	}

	/**
	 * 자기 검사 ② — 이 phase가 실제로 쓸 정상 API를 <b>막지 않는다</b>. 여기서 red가 나면 스캔이 너무 넓어
	 * 이후 step들을 막는다는 뜻이다.
	 */
	@Test
	void theScannerAllowsTheNormalApisThisPhaseActuallyUses() {
		for (String allowed : ALLOWED_NORMAL_CODE) {
			for (Rule rule : RULES) {
				assertFalse(matches(rule, allowed),
						rule.name() + " 스캔이 정상 코드까지 막고 있다: " + allowed);
			}
		}
	}

	/**
	 * 자기 검사 ③ — 주석 제거가 실제로 동작하는가. main 소스의 {@code LogService}·{@code LoginRateLimit}는
	 * javadoc에서 {@code @Scheduled}를 <b>금지 사실을 설명하려고</b> 언급한다. 그것이 위반으로 잡히면
	 * 규칙을 문서화할 수 없다.
	 */
	@Test
	void ruleDocumentationInCommentsIsNotAViolation() {
		String documented = stripComments("""
				/**
				 * evict는 append 시점에, 창 계산은 조회 시점에 한다({@code @Scheduled} 0 — ADR-008).
				 * {@code RestTemplate}·{@code Files.write}도 마찬가지로 금지다.
				 */
				// @Async·@Retryable·new Timer( 도 두지 않는다.
				long ms = clock.millis();
				""");

		assertFalse(documented.contains("Scheduled"), "블록 주석이 제거되지 않았다: " + documented);
		assertFalse(documented.contains("Retryable"), "줄 주석이 제거되지 않았다: " + documented);
		for (Rule rule : RULES) {
			assertFalse(matches(rule, documented),
					"주석 속 규칙 설명이 " + rule.name() + " 위반으로 잡힌다 — 그러면 규칙을 문서화할 수 없다: " + documented);
		}
	}

	/**
	 * 자기 검사 ④ — <b>문자열 리터럴 뒤에 숨은 위반</b>도 잡는다.
	 *
	 * <p>2026-08-25 ④ 게이트 변이 실측: {@code String u = "http://example.test"; new java.util.Timer(true);}를
	 * main 소스에 심었을 때 게이트가 <b>green이었다</b>(줄 주석 정규식이 리터럴 속 {@code //}를 주석 시작으로
	 * 읽고 그 줄의 나머지를 지웠다). 이 도메인의 코드에는 {@code http://}가 실제로 들어 있으므로 우연이
	 * 아니라 손 닿는 곳의 우회다. 리터럴 <b>내용</b>은 여전히 코드가 아니라는 것도 함께 못 박는다.
	 */
	@Test
	void aViolationHidingBehindAUrlLiteralIsStillCaught() {
		String hidden = "String endpoint = \"http://example.test/a\"; new java.util.Timer(true).cancel();";

		assertTrue(matches(PERIODIC_EXECUTION, hidden),
				"문자열 속 //를 줄 주석으로 읽어 그 줄의 위반을 통째로 놓친다: " + stripComments(hidden));
		assertTrue(matches(FILE_WRITE, "String url = \"https://a//b\"; Files.write(target, bytes);"),
				"URL 리터럴 뒤의 파일 쓰기를 놓친다");
		assertTrue(matches(NETWORK_CLIENT, "log(\"skip // \" + name); var c = url.openConnection();"),
				"문자열 속 //가 뒤따르는 네트워크 호출을 가린다");

		// 반대 방향 — 리터럴 '내용'은 실행되는 토큰이 아니다(오탐을 만들면 규칙을 코드에 적을 수 없다).
		assertFalse(matches(PERIODIC_EXECUTION, "String note = \"@Scheduled is forbidden\";"),
				"문자열 상수 안의 규칙 이름이 위반으로 잡힌다");
		assertFalse(matches(FILE_WRITE, "throw new IllegalStateException(\"Files.write is forbidden\");"),
				"예외 메시지 안의 규칙 이름이 위반으로 잡힌다");
	}

	/**
	 * 예외로 등재된 <b>이름</b>을 가진 파일은 리포에 <b>정확히 하나</b>이고, 그 하나는 <b>등재된 자리</b>에
	 * 있다(아직 만들지 않은 파일은 <b>0개</b>여야 한다 — 어디에도 있으면 안 된다).
	 *
	 * <p>2026-08-25 ⑤ 코드리뷰 반려 폐색. 예외 판정은 이제 경로로 하지만({@link #violations}), 그것만으로는
	 * "예외 이름을 가진 파일이 <b>여럿</b>"인 상태를 막지 못한다 — 오배치본은 위반으로 잡히더라도, 그 상태
	 * 자체가 사람을 속인다(어느 것이 진짜 예외인지 이름만 보고는 모른다). 그래서 개수와 자리를 함께 못 박는다.
	 *
	 * <p>이 단언이 {@code HttpExternalProxyClient}에 대해서는 "0개"를 요구하므로(아직 만들지 않은 예약 자리다),
	 * {@code phases/73-spring-media-upload} step5는 그 파일을 만들 때 <b>등재된 경로에</b> 두거나
	 * {@link #EXTERNAL_PROXY_FILE}을 함께 고쳐야 한다. 나머지 셋은 이미 존재하므로 "등재된 자리에 정확히
	 * 하나"를 요구한다.
	 */
	@Test
	void everyExemptNameResolvesToExactlyOneFileAtItsDeclaredPath() throws IOException {
		for (Rule rule : RULES) {
			for (String exempt : rule.exemptPaths()) {
				String fileName = exempt.substring(exempt.lastIndexOf('/') + 1);
				List<String> found = locate(fileName);
				boolean declaredExists = Files.isRegularFile(MAIN_SOURCES.resolve(exempt));

				assertEquals(declaredExists ? List.of(exempt) : List.of(), found,
						"ADR-008 예외 이름이 붙은 파일은 등재된 자리에 정확히 하나여야 한다(0 또는 여럿·오배치는 red): "
								+ exempt + " " + found);
			}
		}
	}

	/** main 소스에서 그 이름을 가진 파일의 상대 경로 전부. */
	private static List<String> locate(String fileName) throws IOException {
		try (Stream<Path> files = Files.walk(MAIN_SOURCES)) {
			return files.filter(Files::isRegularFile)
					.filter((file) -> file.getFileName().toString().equals(fileName))
					.map(Adr008DisciplineTest::relativePath)
					.sorted()
					.toList();
		}
	}

	/** 한 규칙으로 main 소스 전체를 훑는다(예외 파일은 그 규칙에서만 건너뛴다). */
	private static List<String> scan(Rule rule) throws IOException {
		List<String> hits = new ArrayList<>();
		try (Stream<Path> files = Files.walk(MAIN_SOURCES)) {
			for (Path file : files.filter(Files::isRegularFile).toList()) {
				hits.addAll(violations(rule, relativePath(file), Files.readString(file, StandardCharsets.UTF_8),
						file.toString()));
			}
		}
		return hits;
	}

	/**
	 * {@code src/main/java} 기준 상대 경로를 {@code /} 구분자로 만든다 — 예외 판정의 키다(OS마다 구분자가
	 * 달라 {@code Path.toString()}을 그대로 쓰면 리눅스와 윈도우에서 예외가 갈린다).
	 */
	private static String relativePath(Path file) {
		return MAIN_SOURCES.relativize(file).toString().replace('\\', '/');
	}

	/**
	 * 파일 하나에 규칙 하나를 적용한다 — 예외 판정도 여기 있다(아래 자기 검사가 그 분기를 직접 부른다).
	 *
	 * @param path {@code src/main/java} 기준 상대 경로. <b>이름이 아니다</b> — 이름으로 비교하면
	 * {@code harness/news/zzprobe/HttpApiSourceFetcher.java}가 네트워크 예외를 가져간다(2026-08-25 ⑤ 반려).
	 */
	private static List<String> violations(Rule rule, String path, String source, String label) {
		if (rule.exemptPaths().contains(path)) {
			return List.of();
		}
		List<String> hits = new ArrayList<>();
		String code = stripComments(source);
		for (Pattern pattern : rule.patterns()) {
			if (pattern.matcher(code).find()) {
				hits.add(label + " ~ " + pattern.pattern());
			}
		}
		return hits;
	}

	private static boolean matches(Rule rule, String snippet) {
		String code = stripComments(snippet);
		return rule.patterns().stream().anyMatch((pattern) -> pattern.matcher(code).find());
	}

	/**
	 * 주석과 리터럴을 지운다 — 남는 것은 <b>실행되는 토큰</b>뿐이다.
	 *
	 * <h2>왜 정규식 두 방을 쓰지 않는가(2026-08-25 ④ 게이트 변이 실측)</h2>
	 * 첫 판은 {@code replaceAll("//[^\n]*", " ")}였다. 그러면 <b>문자열 리터럴 안의 {@code //}</b>가
	 * 줄 주석의 시작으로 오인돼 <b>그 줄의 나머지가 통째로 사라진다</b>. 실제로
	 * {@code String u = "http://example.test"; new java.util.Timer(true).cancel();} 한 줄을 main 소스에
	 * 심었을 때 게이트는 <b>green이었다</b> — 이 도메인의 코드에는 {@code http://}가 실제로 들어 있어
	 * (수집 endpoint · 배부 스풀 주소) 우연히 성립하는 것이 아니라 <b>손 닿는 곳에 있는</b> 우회다.
	 * "탐지를 줄이는 방향이라 안전하다"는 판단은 그래서 틀렸다: 탐지를 줄이는 것이 곧 이 게이트의 실패다.
	 *
	 * <p>그래서 좌에서 우로 한 번 훑으며 주석·문자열·문자 리터럴·텍스트 블록을 <b>공백 하나</b>로
	 * 바꾼다. 리터럴 <b>내용</b>도 함께 사라지는데 그것은 의도다 — 리터럴은 실행되는 토큰이 아니고
	 * ({@code "@Scheduled"}라는 문자열은 타이머를 돌리지 않는다), 규칙을 설명하는 javadoc이 위반으로
	 * 잡히면 안 되는 것과 같은 이유다.
	 *
	 * <p>여전히 <b>덮지 못하는 벡터</b>: 끊어 쓴 문자열·리플렉션으로 만든 호출(클래스 머리말 참조).
	 * 그 축의 실질 방어선은 각 step의 행동 단언이다({@code CollectionPreservationTest}의 행 수 생존 등).
	 */
	private static String stripComments(String source) {
		StringBuilder code = new StringBuilder(source.length());
		int i = 0;
		int end = source.length();
		while (i < end) {
			char c = source.charAt(i);
			if (c == '/' && i + 1 < end && source.charAt(i + 1) == '*') {
				int close = source.indexOf("*/", i + 2);
				i = (close < 0) ? end : close + 2;
				code.append(' ');
			}
			else if (c == '/' && i + 1 < end && source.charAt(i + 1) == '/') {
				while (i < end && source.charAt(i) != '\n') {
					i++;
				}
				code.append(' ');
			}
			else if (c == '"' && source.startsWith("\"\"\"", i)) {
				int close = source.indexOf("\"\"\"", i + 3);
				i = (close < 0) ? end : close + 3;
				code.append(' ');
			}
			else if (c == '"' || c == '\'') {
				i = skipLiteral(source, i, c);
				code.append(' ');
			}
			else {
				code.append(c);
				i++;
			}
		}
		return code.toString();
	}

	/**
	 * 여는 따옴표 위치에서 시작해 <b>닫는 따옴표 다음</b> 인덱스를 돌려준다.
	 *
	 * <p>{@code \\}는 다음 한 글자를 건너뛴다({@code "\\\""}가 리터럴을 끝내지 않게). 줄바꿈을 만나면
	 * 거기서 끝낸다 — 소스가 깨져 있어도 스캐너가 파일 끝까지 삼켜 <b>뒤의 위반을 통째로 감추는</b>
	 * 일이 없어야 한다(닫히는 쪽으로 틀린다).
	 */
	private static int skipLiteral(String source, int open, char quote) {
		int i = open + 1;
		int end = source.length();
		while (i < end) {
			char c = source.charAt(i);
			if (c == '\\') {
				i += 2;
				continue;
			}
			if (c == quote) {
				return i + 1;
			}
			if (c == '\n') {
				return i;
			}
			i++;
		}
		return end;
	}
}
