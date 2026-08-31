package harness.news.controller;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.io.IOException;
import java.io.UncheckedIOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.regex.Pattern;
import java.util.stream.Stream;
import org.junit.jupiter.api.Test;

/**
 * SSE 소유 파일 <b>전체</b>에 대한 ADR-008 · ADR-015 정적 그물 — <b>④ 테스터 게이트가 심은 우회 2종이
 * 전 게이트를 통과한 뒤에 추가했다</b>(2026-08-31).
 *
 * <h2>왜 파일별 스캔이 이미 있는데 이 파일이 또 필요한가</h2>
 * 이 phase는 금지 철자 스캔을 <b>파일마다 자기 테스트 안에</b> 두었다({@code SseHttpTest} 항목 8 ·
 * {@code StreamWireTest}·{@code LogsStreamWireTest}의 정적 규율 · {@code LogServiceTest}·
 * {@code ChangeBusTest}). 그 구조에는 두 개의 구멍이 있었고 <b>둘 다 실제로 우회에 성공했다</b>:
 * <ol>
 *   <li><b>{@code SseCloser.java}에는 스캔이 없다.</b> 이 파일은 두 스트림의 종료기(구독 해제 ·
 *       {@code unauthorized} 1회 · 종료)이고 SSE 경로의 일부인데, 어떤 테스트도 그 소스를 읽지 않았다.
 *       ④ 테스터가 {@code seal()}을 {@code ScopedValue.where(...).run(...)}으로 감싸 보았더니
 *       {@code Adr008DisciplineTest}(75패턴)·{@code SseHttpTest}·{@code StreamWireTest}·
 *       {@code LogsStreamWireTest}·{@code ChangeBusTest}·{@code LogServiceTest}·
 *       {@code HandlerInventoryTest} <b>104건이 전부 green</b>이었다.</li>
 *   <li><b>파일별 금지 목록에 {@code SubmissionPublisher}가 없다.</b> {@code SseHttp}의 프레임 write에
 *       {@code SubmissionPublisher.submit(...)}을 끼우면 프레임 전달이 <b>{@code ForkJoinPool.commonPool}의
 *       백그라운드 스레드</b>로 넘어간다 — "쓰기는 트리거 요청 스레드"(ADR-015)가 깨지는데도 위 104건이
 *       전부 green이었다({@code Adr008DisciplineTest}의 5군 패턴에도 그 철자가 없다).</li>
 * </ol>
 *
 * <h2>이 테스트가 잠그는 것</h2>
 * ① SSE 파일 <b>집합</b>을 못 박는다 — 새 SSE 파일이 생기면 이 테스트가 red라서 그 파일도 스캔에 들어온다
 * (스캔 없는 파일이 조용히 늘어나는 것이 위 (1)의 원인이다). ② 그 집합 전체에 금지 철자를 건다 —
 * <b>JDK 25가 정식화한 표면</b>({@code ScopedValue}·{@code StructuredTaskScope}·{@code Subtask})과
 * <b>공용 풀로 일을 넘기는 표면</b>({@code SubmissionPublisher}·{@code Flow.}·{@code ForkJoinPool}·
 * {@code parallelStream()})을 포함한다. ③ 세션을 연장하는 호출({@code touchSession}·{@code editDps(})이
 * SSE 파일 어디에도 없다(ADR-005 비연장 peek — 지금까지 두 컨트롤러에만 걸려 있었다).
 *
 * <p><b>{@code Adr008DisciplineTest}(게이트 정본)는 이 phase의 무접촉 파일이라 0줄 고치지 않았다.</b>
 * 그 게이트의 패턴 목록을 JDK 25 표면으로 넓히는 일은 그 자체가 아키텍처 결정이며 별도 ADR·리뷰가 필요하다
 * (phase 74 forward_notes (3)(9)). 여기서 막는 것은 <b>이 phase가 소유한 6파일뿐</b>이고, 나머지
 * {@code src/main/java} 전체는 여전히 무방비다 — 그 사실은 ④ 테스터의 finding으로 인계한다.
 */
class SseAdr008SurfaceTest {

	private static final Path MAIN = Path.of("src", "main", "java");

	private static final Pattern COMMENTS = Pattern.compile("/\\*.*?\\*/|//[^\\n]*", Pattern.DOTALL);

	/**
	 * SSE 와이어를 직접 다루는 파일 집합. {@code SseHttp}를 언급하는 {@code src/main/java} 파일이
	 * 정확히 이 넷이어야 한다 — 다섯째가 생기면 아래 항목 1이 red다.
	 */
	private static final List<String> SSE_FILES =
			List.of("LogsController.java", "SseCloser.java", "SseHttp.java", "StreamController.java");

	/** 위 넷 + 신호·로그 버스 2파일 = 이 phase가 소유한 SSE 축 전부. */
	private static final List<Path> SCANNED = List.of(
			MAIN.resolve("harness/news/web/SseHttp.java"),
			MAIN.resolve("harness/news/controller/SseCloser.java"),
			MAIN.resolve("harness/news/controller/StreamController.java"),
			MAIN.resolve("harness/news/controller/LogsController.java"),
			MAIN.resolve("harness/news/service/ChangeBus.java"),
			MAIN.resolve("harness/news/service/LogService.java"));

	/**
	 * 금지 철자 — 앞부분은 기존 파일별 스캔과 같은 4군이고, <b>뒷부분 5개가 이 테스트가 새로 막는 것</b>이다
	 * (공용 풀·비동기 배달 표면). {@code Scheduled}는 {@code @} 없이 막는다: 완전 수식 애노테이션
	 * ({@code @org.springframework.scheduling.annotation.Scheduled})이 {@code "@Scheduled"} 검사를
	 * 그대로 통과한 전례가 있다(step5 변이 M5-9).
	 */
	private static final List<String> FORBIDDEN = List.of("Scheduled", "@Async", "@EnableAsync", "@Retryable",
			"@Recover", "RetryTemplate", "TaskScheduler", "TaskExecutor", "ExecutorService", "Executors.",
			"ScheduledFuture", "new Timer(", "Thread.sleep(", "TimeUnit.", "LockSupport", ".await(",
			"CompletableFuture", "CompletionStage", ".thenApply(", ".thenAccept(", ".thenRun(", ".whenComplete(",
			"CountDownLatch", "new Thread(", "startVirtualThread", "Thread.ofVirtual(", "Thread.ofPlatform(",
			".sendAsync(", "StructuredTaskScope", "ScopedValue", "Subtask",
			// 여기부터가 ④ 테스터가 우회에 성공해 추가한 철자다(어느 게이트에도 없었다).
			"SubmissionPublisher", "Flow.Publisher", "Flow.Subscriber", "ForkJoinPool", "parallelStream(");

	/** push 시점에 세션 유휴 만료를 연장하는 호출(ADR-005 · ADR-007). */
	private static final List<String> EXTENDING_CALLS = List.of("touchSession", "editDps(");

	/**
	 * 항목 1 — <b>집합 잠금</b>. {@code SseHttp}를 언급하는 main 소스가 정확히 넷이다.
	 * 다섯째 SSE 파일이 생기면 여기가 red이고, 그때 {@link #SCANNED}에 함께 올려야 한다.
	 */
	@Test
	void theSetOfSseFilesIsLockedSoANewOneCannotSkipThisScan() throws IOException {
		List<String> found = new ArrayList<>();
		try (Stream<Path> files = Files.walk(MAIN)) {
			for (Path file : files.filter(Files::isRegularFile)
					.filter((path) -> path.getFileName().toString().endsWith(".java")).toList()) {
				if (stripped(file).contains("SseHttp")) {
					found.add(file.getFileName().toString());
				}
			}
		}
		found.sort(String::compareTo);

		assertEquals(SSE_FILES, found,
				"SSE 파일 집합이 달라졌다 — 새 파일은 이 테스트의 SCANNED 목록에도 올려야 한다"
						+ "(스캔 없는 SSE 파일이 ADR-008 우회로다: SseCloser.java가 실제로 그랬다)");
	}

	/**
	 * 항목 2 — SSE 6파일 어디에도 타이머·스레드·공용 풀 배달이 없다.
	 * 연결 유지는 컨테이너의 {@code AsyncContext}, 프레임 쓰기는 <b>트리거 요청 스레드</b>다(ADR-015).
	 */
	@Test
	void noSseOwnedFileSpawnsWorkersOrUsesTheJdk25ConcurrencySurface() throws IOException {
		for (Path file : SCANNED) {
			String code = stripped(file);
			assertTrue(code.length() > 500, file + ": 소스를 못 읽었다 — 스캔이 공허해진다(양성 대조)");
			for (String forbidden : FORBIDDEN) {
				assertTrue(!code.contains(forbidden),
						file + ": ADR-008 · ADR-015 금지 철자가 있다 — " + forbidden
								+ "(앱은 스스로 깨어나지 않고, 프레임은 트리거 요청 스레드가 쓴다)");
			}
		}
	}

	/**
	 * 항목 3 — 세션 연장 호출이 SSE 파일 전체에 0건이다(ADR-005 비연장 peek · ADR-007 시간축 봉인).
	 * 지금까지 이 단언은 두 컨트롤러 파일에만 있었다 — 종료기·와이어·버스에는 없었다.
	 */
	@Test
	void noSseOwnedFileExtendsTheSessionIdleExpiry() throws IOException {
		for (Path file : SCANNED) {
			String code = stripped(file);
			for (String forbidden : EXTENDING_CALLS) {
				assertTrue(!code.contains(forbidden),
						file + ": 열린 스트림이 세션 유휴 만료를 연장한다 — " + forbidden);
			}
		}
	}

	/**
	 * 항목 4 — <b>비공허성</b>. 위 스캔은 "찾지 못했다"를 단언하므로, 매처가 실제로 동작하는지
	 * 금지 철자를 전부 담은 표본으로 확인한다(오탈자 하나가 조용히 게이트를 꺼 버리는 것을 막는다).
	 */
	@Test
	void theScannerActuallyDetectsEveryForbiddenSpelling() {
		String sample = String.join("\n", FORBIDDEN) + "\n" + String.join("\n", EXTENDING_CALLS);

		List<String> detected = new ArrayList<>();
		for (String forbidden : FORBIDDEN) {
			if (sample.contains(forbidden)) {
				detected.add(forbidden);
			}
		}
		for (String forbidden : EXTENDING_CALLS) {
			if (sample.contains(forbidden)) {
				detected.add(forbidden);
			}
		}

		assertEquals(FORBIDDEN.size() + EXTENDING_CALLS.size(), detected.size(),
				"금지 목록의 철자를 매처가 못 찾는다 — 게이트가 공허하다");
		assertEquals("", COMMENTS.matcher("/* ScopedValue */\n// SubmissionPublisher").replaceAll("").trim(),
				"주석 제거가 동작하지 않는다 — 주석 속 철자가 red를 내면 아무도 이 게이트를 믿지 않는다");
	}

	private static String stripped(Path file) {
		try {
			return COMMENTS.matcher(Files.readString(file, StandardCharsets.UTF_8)).replaceAll("");
		}
		catch (IOException ex) {
			throw new UncheckedIOException(ex);
		}
	}

}
