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
 * <p><b>정당한 예외는 정확히 2개</b>이고 <b>파일 단위 명시 목록</b>이다({@code ClockDisciplineTest}의
 * {@code CLOCK_FACTORY_FILES}와 같은 이유 — 예외가 늘어나면 그 사실이 diff에 보인다).
 * <ul>
 * <li><b>네트워크 클라이언트</b> — {@code HttpApiSourceFetcher.java}. ADR-008의 egress 금지는 <b>배부</b>
 * 축이고, 수집 pull은 {@code rcv.md}가 정의한 능동 수집이라 아웃바운드 호출이 기능 그 자체다.</li>
 * <li><b>파일 쓰기</b> — {@code SpoolWriter.java}. 배부는 파일 스풀 outbound가 전송 수단이다.</li>
 * </ul>
 * 두 파일은 <b>아직 없을 수 있다</b>(각각 이 phase step4 · {@code phases/72-spring-distribution} step3이
 * 만든다). 스캔은 파일이 없으면 아무 일도 하지 않으므로 이름을 미리 등재해도 무해하며, 그래야 그 파일을
 * 만드는 step의 diff가 "예외를 새로 늘렸다"가 아니라 "예약된 자리를 채웠다"가 된다.
 * <b>주기 실행·비동기·재시도는 예외 0</b>이다.
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

	/**
	 * 금지 규칙 한 묶음 — 이름 · 패턴 목록 · <b>파일 단위 예외</b>.
	 *
	 * <p>예외를 규칙 안에 묶어 두는 이유: 예외가 <b>자기 군에만</b> 적용된다는 사실이 구조로 보장된다
	 * (수집 어댑터가 타이머를 돌리거나 스풀 라이터가 네트워크를 여는 것은 여전히 red다).
	 */
	private record Rule(String name, List<Pattern> patterns, List<String> exemptFiles) {
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
			Pattern.compile("\\bScheduledFuture\\b")),
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
			Pattern.compile("@\\s*(?:[\\w.]+\\.)?Recover\\b")),
			List.of());

	/**
	 * 3군 — 네트워크 클라이언트(예외 1: 수집 pull 어댑터).
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
			Pattern.compile("\\bHttpURLConnection\\b")),
			List.of("HttpApiSourceFetcher.java"));

	/**
	 * 4군 — 파일 쓰기(예외 1: 배부 스풀 라이터).
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
			Pattern.compile("\\.\\s*renameTo\\s*\\(")),
			List.of("SpoolWriter.java"));

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
			"ScheduledFuture<?> handle = pool.schedule(task, 1, TimeUnit.SECONDS);");

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
			"@Recover\nString fallback(Exception e) { return \"\"; }");

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
			"HttpURLConnection conn = null;");

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
			"tmp.toFile().renameTo(target.toFile());");

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

	/** 3군: 아웃바운드 호출은 수집 pull 어댑터 한 파일에서만 일어난다. */
	@Test
	void onlyTheCollectionPullAdapterTalksToTheNetwork() throws IOException {
		assertTrue(Files.isDirectory(MAIN_SOURCES),
				"스캔 대상이 없다 — 테스트 작업 디렉토리가 모듈 루트가 아니다: " + MAIN_SOURCES.toAbsolutePath());

		List<String> hits = scan(NETWORK_CLIENT);

		assertTrue(hits.isEmpty(),
				"수집 pull 어댑터(" + NETWORK_CLIENT.exemptFiles() + ") 밖에서 네트워크 클라이언트를 쓴다"
						+ "(ADR-008 (1) — 배부 축은 egress 0): " + hits);
	}

	/** 4군: 파일 쓰기는 배부 스풀 라이터 한 파일에서만 일어난다. */
	@Test
	void onlyTheSpoolWriterWritesFiles() throws IOException {
		assertTrue(Files.isDirectory(MAIN_SOURCES),
				"스캔 대상이 없다 — 테스트 작업 디렉토리가 모듈 루트가 아니다: " + MAIN_SOURCES.toAbsolutePath());

		List<String> hits = scan(FILE_WRITE);

		assertTrue(hits.isEmpty(),
				"배부 스풀 라이터(" + FILE_WRITE.exemptFiles() + ") 밖에서 파일을 쓴다"
						+ "(ADR-008 (1) — 스풀 쓰기는 한 지점): " + hits);
	}

	/**
	 * 예외 목록의 <b>크기와 구성</b>을 못 박는다 — 예외가 늘어나면 그 사실이 반드시 diff와 red로 드러난다
	 * (phase 70 review_gate low의 {@code theDerivedMainJavaListDropsExactlyTheDeleteFromPattern}과 같은 계열).
	 *
	 * <p>{@code phases/72-spring-distribution}은 이 목록을 <b>넓히지 않고</b> {@code SpoolWriter.java}로
	 * 예약된 자리를 채울 뿐이다. 목록을 넓히려는 시도는 그 자체가 아키텍처 결정이며 별도 근거가 필요하다.
	 */
	@Test
	void theExceptionListIsExactlyTwoFiles() {
		List<String> allExemptions = RULES.stream().flatMap((rule) -> rule.exemptFiles().stream()).toList();

		assertEquals(List.of("HttpApiSourceFetcher.java", "SpoolWriter.java"), allExemptions,
				"ADR-008 예외는 정확히 2파일이다(수집 pull 어댑터 · 배부 스풀 라이터)");
		assertEquals(2, allExemptions.size(), "예외 목록 크기");
		assertEquals(List.of(), PERIODIC_EXECUTION.exemptFiles(), "주기 실행은 예외 0이다");
		assertEquals(List.of(), ASYNC_AND_RETRY.exemptFiles(), "비동기·재시도는 예외 0이다");
		assertEquals(List.of("HttpApiSourceFetcher.java"), NETWORK_CLIENT.exemptFiles(),
				"네트워크 예외는 수집 pull 어댑터 하나뿐이다");
		assertEquals(List.of("SpoolWriter.java"), FILE_WRITE.exemptFiles(),
				"파일 쓰기 예외는 배부 스풀 라이터 하나뿐이다");
	}

	/**
	 * 예외는 <b>그 파일에서, 그 군에만</b> 적용된다.
	 *
	 * <p>두 예외 파일은 이 시점에 <b>아직 없다</b>(각각 step4 · 배부 phase step3이 만든다). 그래서 예외
	 * 분기는 실제 스캔에서 한 번도 실행되지 않는다 — 그 사이에 분기가 망가지면(예: 파일명이 아니라 전체
	 * 경로로 비교하게 되어 예외가 영영 성립하지 않거나, 반대로 예외가 전 군에 새어 나가거나) 아무도
	 * 모른다. 그래서 판정 함수를 직접 불러 네 가지 경계를 못 박는다.
	 */
	@Test
	void theExemptionAppliesOnlyToItsOwnFileAndItsOwnGroup() {
		assertTrue(violations(FILE_WRITE, "SpoolWriter.java", "Files.write(target, bytes);", "planted").isEmpty(),
				"배부 스풀 라이터의 파일 쓰기는 허용이다(예외가 성립하지 않으면 그 phase가 시작부터 red다)");
		assertFalse(
				violations(FILE_WRITE, "ArticleWriteService.java", "Files.write(target, bytes);", "planted").isEmpty(),
				"예외 파일이 아닌 곳의 파일 쓰기까지 허용하고 있다");
		assertTrue(violations(NETWORK_CLIENT, "HttpApiSourceFetcher.java",
				"HttpClient http = HttpClient.newHttpClient();", "planted").isEmpty(),
				"수집 pull 어댑터의 아웃바운드 호출은 허용이다(기능 그 자체다 — rcv.md 능동 수집)");
		assertFalse(violations(NETWORK_CLIENT, "SpoolWriter.java",
				"HttpClient http = HttpClient.newHttpClient();", "planted").isEmpty(),
				"파일 쓰기 예외가 네트워크 군까지 새어 나간다");
		assertFalse(violations(PERIODIC_EXECUTION, "SpoolWriter.java",
				"@Scheduled(fixedDelay = 1000)\nvoid flush() { }", "planted").isEmpty(),
				"예외 파일이라도 앱 내 타이머는 금지다(1군 예외 0)");
		assertFalse(violations(ASYNC_AND_RETRY, "HttpApiSourceFetcher.java",
				"@Retryable(maxAttempts = 3)\nString fetch() { return \"\"; }", "planted").isEmpty(),
				"예외 파일이라도 재시도는 금지다(2군 예외 0 — ADR-008 (6))");
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
	 * 예외는 <b>파일 이름</b>으로 성립한다 — 그러면 같은 이름의 파일을 <b>다른 패키지에</b> 하나 더 두는
	 * 것만으로 예외가 복제된다.
	 *
	 * <p>2026-08-25 ④ 게이트 변이 실측: {@code harness.news.zzprobe.SpoolWriter}에 {@code Files.write}를
	 * 심었더니 게이트가 green이었다. 경로 비교로 바꾸면 아직 존재하지 않는 파일(배부 phase의
	 * {@code SpoolWriter})의 패키지를 지금 확정해야 하므로, 대신 <b>같은 이름이 둘 이상 존재할 수 없다</b>는
	 * 불변식을 건다 — 복제하는 순간 red이고, 정당한 한 개는 어디에 있든 통과한다.
	 */
	@Test
	void anExemptFileNameNeverResolvesToMoreThanOneFile() throws IOException {
		for (Rule rule : RULES) {
			for (String exempt : rule.exemptFiles()) {
				List<String> found = new ArrayList<>();
				try (Stream<Path> files = Files.walk(MAIN_SOURCES)) {
					for (Path file : files.filter(Files::isRegularFile).toList()) {
						if (file.getFileName().toString().equals(exempt)) {
							found.add(file.toString());
						}
					}
				}
				assertTrue(found.size() <= 1,
						"ADR-008 예외 이름이 여러 파일에 붙어 있다 — 다른 패키지에 같은 이름을 두면 예외가 복제된다: "
								+ exempt + " " + found);
			}
		}
	}

	/**
	 * 이미 존재하는 예외 파일은 <b>제자리에 있어야 한다</b>. 이름만으로 예외가 성립하므로, 같은 이름을
	 * 엉뚱한 패키지에 두면 그 파일이 예외를 가져간다(위 불변식은 <b>복제</b>만 막는다).
	 *
	 * <p>{@code SpoolWriter.java}는 <b>아직 없어서</b> 여기서 경로를 못 박지 않는다 — 그 파일의 패키지는
	 * {@code phases/72-spring-distribution}의 결정이고, 지금 고정하면 아직 하지 않은 설계를 이 테스트가
	 * 대신 정하는 셈이 된다. <b>그 phase는 여기에 자기 경로를 추가해야 한다</b>(예외의 자리가 diff에
	 * 보인다는 규율의 연장).
	 */
	@Test
	void theExemptFilesThatAlreadyExistSitWhereTheyBelong() throws IOException {
		assertEquals(List.of(Path.of("src", "main", "java", "harness", "news", "service",
				"HttpApiSourceFetcher.java").toString()), locate("HttpApiSourceFetcher.java"),
				"수집 pull 어댑터가 service 패키지 밖에 있다 — 이름만 같은 파일이 네트워크 예외를 가져간다");
		assertEquals(List.of(), locate("SpoolWriter.java"),
				"배부 스풀 라이터가 생겼다면 이 테스트에 그 경로를 못 박아라(예외의 자리는 diff에 보여야 한다)");
	}

	/** main 소스에서 그 이름을 가진 파일의 경로 전부. */
	private static List<String> locate(String fileName) throws IOException {
		try (Stream<Path> files = Files.walk(MAIN_SOURCES)) {
			return files.filter(Files::isRegularFile)
					.filter((file) -> file.getFileName().toString().equals(fileName))
					.map(Path::toString)
					.sorted()
					.toList();
		}
	}

	/** 한 규칙으로 main 소스 전체를 훑는다(예외 파일은 그 규칙에서만 건너뛴다). */
	private static List<String> scan(Rule rule) throws IOException {
		List<String> hits = new ArrayList<>();
		try (Stream<Path> files = Files.walk(MAIN_SOURCES)) {
			for (Path file : files.filter(Files::isRegularFile).toList()) {
				hits.addAll(violations(rule, file.getFileName().toString(),
						Files.readString(file, StandardCharsets.UTF_8), file.toString()));
			}
		}
		return hits;
	}

	/** 파일 하나에 규칙 하나를 적용한다 — 예외 판정도 여기 있다(아래 자기 검사가 그 분기를 직접 부른다). */
	private static List<String> violations(Rule rule, String fileName, String source, String label) {
		if (rule.exemptFiles().contains(fileName)) {
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
