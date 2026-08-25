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

	/** 1군 — 주기 실행(예외 0). ADR-008 (3): 시점 배부는 앱 내 타이머가 아니라 tick pull이다. */
	private static final Rule PERIODIC_EXECUTION = new Rule("주기 실행", List.of(
			Pattern.compile("@\\s*(?:[\\w.]+\\.)?Scheduled\\b"),
			Pattern.compile("@\\s*(?:[\\w.]+\\.)?EnableScheduling\\b"),
			Pattern.compile("\\bTaskScheduler\\b"),
			Pattern.compile("\\bScheduledExecutorService\\b"),
			Pattern.compile("\\bExecutors\\s*\\.\\s*newScheduled\\w*\\s*\\("),
			Pattern.compile("\\bnew\\s+(java\\.util\\.)?Timer\\s*\\("),
			Pattern.compile("\\bThread\\s*\\.\\s*sleep\\s*\\("),
			Pattern.compile("\\bScheduledFuture\\b")),
			List.of());

	/** 2군 — 비동기·재시도(예외 0). ADR-008 (6): 자동 재시도·백오프·재시도 큐를 두지 않는다. */
	private static final Rule ASYNC_AND_RETRY = new Rule("비동기·재시도", List.of(
			Pattern.compile("@\\s*(?:[\\w.]+\\.)?Async\\b"),
			Pattern.compile("@\\s*(?:[\\w.]+\\.)?EnableAsync\\b"),
			Pattern.compile("@\\s*(?:[\\w.]+\\.)?Retryable\\b"),
			Pattern.compile("@\\s*(?:[\\w.]+\\.)?EnableRetry\\b"),
			Pattern.compile("\\bRetryTemplate\\b"),
			Pattern.compile("\\bCompletableFuture\\s*\\.\\s*\\w*Async\\w*\\s*\\("),
			Pattern.compile("\\bExecutorService\\b"),
			Pattern.compile("@\\s*(?:[\\w.]+\\.)?Recover\\b")),
			List.of());

	/** 3군 — 네트워크 클라이언트(예외 1: 수집 pull 어댑터). */
	private static final Rule NETWORK_CLIENT = new Rule("네트워크 클라이언트", List.of(
			Pattern.compile("\\bHttpClient\\b"),
			Pattern.compile("\\bRestTemplate\\b"),
			Pattern.compile("\\bWebClient\\b"),
			Pattern.compile("\\bRestClient\\b"),
			Pattern.compile("\\bnew\\s+(java\\.net\\.)?Socket\\s*\\("),
			Pattern.compile("\\.\\s*openConnection\\s*\\("),
			Pattern.compile("\\bURLConnection\\b"),
			Pattern.compile("\\bHttpURLConnection\\b")),
			List.of("HttpApiSourceFetcher.java"));

	/** 4군 — 파일 쓰기(예외 1: 배부 스풀 라이터). */
	private static final Rule FILE_WRITE = new Rule("파일 쓰기", List.of(
			Pattern.compile("\\bFiles\\s*\\.\\s*write(String)?\\s*\\("),
			Pattern.compile("\\bFiles\\s*\\.\\s*newOutputStream\\s*\\("),
			Pattern.compile("\\bFiles\\s*\\.\\s*newBufferedWriter\\s*\\("),
			Pattern.compile("\\bFileOutputStream\\b"),
			Pattern.compile("\\bFileWriter\\b"),
			Pattern.compile("\\bFiles\\s*\\.\\s*createDirector(y|ies)\\s*\\("),
			Pattern.compile("\\bFiles\\s*\\.\\s*move\\s*\\("),
			Pattern.compile("\\bFiles\\s*\\.\\s*copy\\s*\\("),
			Pattern.compile("\\bFiles\\s*\\.\\s*delete(IfExists)?\\s*\\(")),
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
			"@Recover\nString fallback(Exception e) { return \"\"; }");

	private static final List<String> PLANTED_NETWORK = List.of(
			"private final HttpClient http = HttpClient.newHttpClient();",
			"private final java.net.http.HttpClient http = java.net.http.HttpClient.newHttpClient();",
			"private final RestTemplate restTemplate = new RestTemplate();",
			"private final WebClient webClient = WebClient.create();",
			"private final RestClient restClient = RestClient.create();",
			"Socket socket = new Socket(host, port);",
			"var conn = url.openConnection();",
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
			"Files.deleteIfExists(tmp);");

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
	 * 블록·줄 주석을 지운다({@code ClockDisciplineTest}와 동일 구현). 문자열 리터럴 안의 {@code //}까지
	 * 잘라내지만 그것은 <b>탐지를 줄이는</b> 방향이라 오탐(정상 코드 차단)을 만들지 않는다.
	 */
	private static String stripComments(String source) {
		return source.replaceAll("(?s)/\\*.*?\\*/", " ").replaceAll("//[^\\n]*", " ");
	}
}
