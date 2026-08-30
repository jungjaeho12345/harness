package harness.news.web;

import static org.junit.jupiter.api.Assertions.assertArrayEquals;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import jakarta.servlet.AsyncContext;
import jakarta.servlet.AsyncListener;
import jakarta.servlet.ServletContext;
import jakarta.servlet.ServletRequest;
import jakarta.servlet.ServletResponse;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Queue;
import java.util.concurrent.ConcurrentLinkedQueue;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.regex.Pattern;
import org.junit.jupiter.api.Test;
import org.springframework.mock.web.MockHttpServletRequest;
import org.springframework.mock.web.MockHttpServletResponse;

/**
 * SSE 와이어 지점({@link SseHttp})의 <b>바이트 계약</b>과 <b>replay-gate 동시성 규율</b>.
 *
 * <p>이 클래스는 두 축을 잠근다.
 * <ul>
 *   <li><b>바이트</b>(항목 1~9): 프레임 원문·Content-Type 문자열·seam 없음 시 시끄러운 실패·와이어 지점
 *       집합. 계약 케이스는 {@code raw.startsWith(READY_FRAME)}로 <b>첫 바이트부터</b> 대조하므로
 *       앞에 무엇이 붙어도 즉시 red다({@code contract/cases/default/sse-stream.contract.js} 39·146행).</li>
 *   <li><b>replay-gate</b>(항목 10~18): 구독 등록 창의 신호 유실을 막는 prelude 큐. <b>계약이 보지 못하는
 *       축</b>이며(index.json decisions (15) 재검토 정정: {@code logs.contract.js} 170~178행이 seq의
 *       <b>하한만</b> 본다) 여기와 step4·step5의 Java 경합 테스트가 유일 방어선이다.</li>
 * </ul>
 *
 * <p>와이어(실제 소켓) 관측은 라우트가 생기는 step4·step5가 한다 — 이 파일은 서블릿 컨테이너 없이
 * 가짜 {@link AsyncContext}·{@link OutputStream}으로 스트림 프리미티브만 단위 테스트한다.
 */
class SseHttpTest {

	/** Node 원문 실측(2026-08-29 raw 소켓 프로브) — 첫 청크 32바이트가 이 프레임 전체다. */
	private static final String READY_FRAME = "event: ready\ndata: {\"ok\":true}\n\n";

	private static final String UNAUTHORIZED_FRAME =
			"event: unauthorized\ndata: {\"ok\":false,\"reason\":\"unauthenticated\"}\n\n";

	// --- 바이트 계약 -------------------------------------------------------------------------------

	/**
	 * 항목 1 — ready 프레임의 <b>골든 바이트</b>. {@code event: ready\n}(13) +
	 * {@code data: {"ok":true}\n}(18) + {@code \n}(1) = <b>32</b>.
	 */
	@Test
	void theReadyFrameIsTheThirtyTwoByteGoldenVector() {
		byte[] frame = SseHttp.frame("ready", "{\"ok\":true}");

		assertArrayEquals(READY_FRAME.getBytes(StandardCharsets.UTF_8), frame,
				"ready 프레임 바이트가 Node 원문과 다르다: " + new String(frame, StandardCharsets.UTF_8));
		assertEquals(32, frame.length, "Node 첫 청크는 0x20 = 32바이트다");
	}

	/** 항목 2 — 상수 2종이 골든 벡터와 byte-identical이다(두 스트림이 이 상수만 쓴다). */
	@Test
	void theReadyAndUnauthorizedConstantsAreTheGoldenBytes() {
		assertArrayEquals(READY_FRAME.getBytes(StandardCharsets.UTF_8), SseHttp.READY);
		assertArrayEquals(UNAUTHORIZED_FRAME.getBytes(StandardCharsets.UTF_8), SseHttp.UNAUTHORIZED,
				"종료 프레임은 server/index.js 423행 리터럴과 같아야 한다");
	}

	/**
	 * 항목 3 — 개행은 LF만이고 종결자는 정확히 빈 줄 하나다.
	 *
	 * <p>{@code docs/api-contract/sse.md}가 CRITICAL로 표시한 자리: 끝의 빈 줄이 빠지면 EventSource가
	 * 이벤트를 디스패치하지 않아 서버·클라 테스트가 둘 다 green인 채 실환경만 조용히 실패한다.
	 */
	@Test
	void framesUseLfOnlyAndEndWithExactlyOneBlankLine() {
		for (byte[] frame : List.of(SseHttp.READY, SseHttp.UNAUTHORIZED,
				SseHttp.frame("change", "{\"kind\":\"update\"}"))) {
			String text = new String(frame, StandardCharsets.UTF_8);

			assertFalse(text.contains("\r"), "SSE 프레임에 CR이 있다: " + text);
			assertTrue(text.endsWith("\n\n"), "프레임 종결자(빈 줄)가 없다: " + text);
			assertFalse(text.endsWith("\n\n\n"), "종결자가 둘 이상이다: " + text);
		}
	}

	/** 항목 4 — 이벤트 어휘 4종 골든 벡터({@code docs/api-contract/sse.md} 「이벤트 어휘 4종」). */
	@Test
	void theFourEventVocabularyGoldenVectors() {
		Map<String, byte[]> expected = new LinkedHashMap<>();
		expected.put(READY_FRAME, SseHttp.frame("ready", "{\"ok\":true}"));
		expected.put("event: change\ndata: {\"kind\":\"create\"}\n\n", SseHttp.frame("change", "{\"kind\":\"create\"}"));
		expected.put("event: log\ndata: {\"seq\":42}\n\n", SseHttp.frame("log", "{\"seq\":42}"));
		expected.put(UNAUTHORIZED_FRAME, SseHttp.frame("unauthorized", "{\"ok\":false,\"reason\":\"unauthenticated\"}"));

		for (Map.Entry<String, byte[]> entry : expected.entrySet()) {
			assertArrayEquals(entry.getKey().getBytes(StandardCharsets.UTF_8), entry.getValue(),
					"어휘 골든 벡터가 어긋났다: " + entry.getKey());
		}
	}

	/**
	 * 항목 5 — 비-ASCII payload가 <b>UTF-8</b>로 나간다(플랫폼 기본 charset을 쓰지 않는다).
	 * Windows 기본 charset은 UTF-8이 아닐 수 있고, 그러면 헤더는 utf-8인데 본문만 다른 인코딩이 된다.
	 */
	@Test
	void nonAsciiPayloadIsEncodedAsUtf8() {
		byte[] frame = SseHttp.frame("log", "{\"message\":\"한글\"}");

		assertArrayEquals("event: log\ndata: {\"message\":\"한글\"}\n\n".getBytes(StandardCharsets.UTF_8), frame);
		assertEquals("event: log\ndata: {\"message\":\"한글\"}\n\n",
				new String(frame, StandardCharsets.UTF_8), "UTF-8로 왕복되지 않는다");
	}

	/**
	 * 항목 6 — Content-Type 문자열 원문: 세미콜론 뒤 <b>공백 1개</b> · 소문자 {@code utf-8}.
	 * 계약 리포트 diff가 이 문자열을 정확 비교한다(ADR-013 ④ · ADR-015).
	 */
	@Test
	void theContentTypeKeepsTheSpaceAfterTheSemicolon() {
		assertEquals("text/event-stream; charset=utf-8", SseHttp.CONTENT_TYPE);
		assertTrue(SseHttp.CONTENT_TYPE.contains("; charset"),
				"세미콜론 뒤 공백이 사라졌다 — 컨테이너 재조립 형태다: " + SseHttp.CONTENT_TYPE);
	}

	/**
	 * 항목 7 — Content-Type 기록 seam이 없으면 {@code open()}이 <b>던진다</b>(폴백 금지).
	 * {@code RawContentTypeTest}와 같은 규율이다: 조용한 폴백은 전 SSE 관측의 패리티를 깨면서
	 * 기능 테스트는 전부 green으로 통과시킨다.
	 */
	@Test
	void openWithoutTheContentTypeSeamFailsLoudly() {
		SseHttp sse = new SseHttp();
		MockHttpServletRequest noSeam = new MockHttpServletRequest();

		IllegalStateException error = assertThrows(IllegalStateException.class,
				() -> sse.open(noSeam, new MockHttpServletResponse()));
		assertTrue(error.getMessage().contains(RawContentType.REQUEST_ATTRIBUTE),
				"진단에 seam 이름이 있어야 원인을 찾는다: " + error.getMessage());

		MockHttpServletRequest foreignSeam = new MockHttpServletRequest();
		foreignSeam.setAttribute(RawContentType.REQUEST_ATTRIBUTE, "Tomcat이 아닌 무언가");
		assertThrows(IllegalStateException.class, () -> sse.open(foreignSeam, new MockHttpServletResponse()));
	}

	/**
	 * 항목 8 — <b>소스 정적 스캔</b>: 이 파일은 서블릿 비동기를 쓰는 유일한 main 코드라 ADR-008 2군 패턴
	 * 바로 옆을 지나간다. 타이머·실행자·스레드·재시도가 0이고, Content-Type을 서블릿 API로 지정하지 않으며,
	 * {@code SseEmitter} 계열을 쓰지 않는다.
	 *
	 * <p><b>JDK 25 신규 표면 3종({@code StructuredTaskScope}·{@code ScopedValue}·{@code Subtask})은 이
	 * 스캔이 유일 방어선이다</b> — {@code Adr008DisciplineTest}(908행) 패턴 목록에 그 철자가 0건이고
	 * (2026-08-30 계획 단계 실측) 이 phase는 그 게이트 파일을 <b>0줄</b> 고친다. 게이트 통과는 허가가 아니다.
	 *
	 * <p>판정 전에 주석을 지운다 — 이 파일의 javadoc은 금지 철자를 실제로 <b>언급</b>한다.
	 */
	@Test
	void theSseHttpSourceHasNoTimerNoThreadAndNoServletContentType() throws IOException {
		String code = sourceWithoutComments(mainSource("harness/news/web/SseHttp.java"));

		for (String forbidden : List.of("@Scheduled", "@EnableScheduling", "@Async", "@EnableAsync", "@Retryable",
				"@Recover", "RetryTemplate", "TaskScheduler", "TaskExecutor", "ScheduledExecutorService",
				"ScheduledThreadPoolExecutor", "ScheduledFuture", "ExecutorService", "ThreadPoolExecutor",
				"ForkJoinPool", "Executors.", "new Timer(", "Thread.sleep(", "TimeUnit.", "LockSupport", ".await(",
				"CompletableFuture", "CompletionStage", ".thenApply(", ".thenAccept(", ".thenRun(", ".whenComplete(",
				"CountDownLatch", "new Thread(", "startVirtualThread", "Thread.ofVirtual(", "Thread.ofPlatform(",
				".sendAsync(",
				// JDK 25가 정식화한 표면 — Adr008DisciplineTest의 패턴 목록에 0건이라 여기서만 막힌다.
				"StructuredTaskScope", "ScopedValue", "Subtask")) {
			assertFalse(code.contains(forbidden),
					"ADR-008 · ADR-015: 프레임 쓰기는 트리거 요청 스레드가 하고 앱은 스스로 깨어나지 않는다 — "
							+ "금지 철자가 코드에 있다: " + forbidden);
		}

		for (String forbidden : List.of("SseEmitter", "ResponseBodyEmitter", "StreamingResponseBody",
				"setContentType", "setContentLength")) {
			assertFalse(code.contains(forbidden),
					"ADR-015: Content-Type 바이트는 RawContentType 한 경로로만 쓰고 스트림은 서블릿 출력으로만 "
							+ "내보낸다(컨테이너 재조립 = 전 SSE 관측 diff) — 코드에 있다: " + forbidden);
		}

		// 인코딩을 플랫폼 기본 charset에 맡기지 않는다. 2026-08-30 실측: JDK 25는 file.encoding이 UTF-8
		// (JEP 400)이라 항목 5의 왕복 단언이 이 실수를 잡지 못한다 — 그러나 native.encoding은 MS949이고
		// -Dfile.encoding이나 구 런타임에서는 헤더만 utf-8인 채 본문이 조용히 갈린다. 여기서 막는다.
		assertFalse(Pattern.compile("\\.getBytes\\s*\\(\\s*\\)").matcher(code).find(),
				"charset 없는 getBytes()가 있다 — 프레임 바이트는 언제나 UTF-8로 못 박는다");
	}

	/**
	 * 항목 9 — <b>와이어 지점 집합 잠금</b>(ADR-015). Content-Type 바이트를 쓰는 파일이 늘어나면
	 * 그 사실이 이 단언의 diff로 보인다.
	 *
	 * <p><b>[2026-08-30 실측 정정]</b> index.json decisions (3)은 "{@code RawContentType.set(} 호출자가
	 * 정확히 2개({@code JsonHttp}·{@code SseHttp})"라고 적었으나 <b>거짓</b>이다: 이 phase 착수 시점의
	 * 실제 호출자는 {@code JsonHttp}(JSON)와 {@code HtmlErrors}(404 {@code text/html} · 429)
	 * <b>2개</b>이고, {@code SseHttp}를 더하면 <b>3개</b>다(step0 summary가 인계한 정정). 잠그는 것은
	 * 개수가 아니라 <b>집합</b>이다.
	 */
	@Test
	void exactlyThreeFilesWriteTheContentTypeBytes() throws IOException {
		List<String> callers = new ArrayList<>();
		Path root = Path.of("src", "main", "java");
		try (var files = Files.walk(root)) {
			for (Path file : files.filter(Files::isRegularFile)
					.filter((path) -> path.getFileName().toString().endsWith(".java")).toList()) {
				if (sourceWithoutComments(file).contains("RawContentType.set(")) {
					callers.add(file.getFileName().toString());
				}
			}
		}
		callers.sort(String::compareTo);

		assertEquals(List.of("HtmlErrors.java", "JsonHttp.java", "SseHttp.java"), callers,
				"와이어 지점 집합이 달라졌다 — ADR-015는 지점을 JsonHttp(JSON)·HtmlErrors(HTML)·SseHttp(SSE) "
						+ "셋으로 못 박았다. 넷째가 생기면 헤더 바이트를 만드는 곳이 갈린다");
	}

	// --- replay-gate -----------------------------------------------------------------------------

	/**
	 * 항목 10 — prelude 구간의 {@code write}는 <b>쓰지 않고 큐에 적재</b>되고, {@code endPrelude}가
	 * 적재 순서대로 흘려보낸다. 그리고 <b>프레임마다 flush</b>한다(빼면 계약 {@code waitFor}가 10초
	 * 타임아웃으로 전 change 케이스 red다 — 여기서는 flush 횟수로 관측한다).
	 */
	@Test
	void preludeWritesAreQueuedUntilEndPrelude() {
		RecordingOutput out = new RecordingOutput();
		SseHttp.ServletStream stream = new SseHttp.ServletStream(new RecordingAsyncContext(), out);

		assertTrue(stream.write(SseHttp.frame("change", "{\"kind\":\"create\"}")));
		assertTrue(stream.write(SseHttp.frame("change", "{\"kind\":\"update\"}")));
		assertEquals(List.of(), out.frames(), "prelude 구간에서 프레임이 새어 나갔다");

		stream.endPrelude(SseHttp.DROP_NOTHING);

		assertEquals(List.of("event: change\ndata: {\"kind\":\"create\"}\n\n",
				"event: change\ndata: {\"kind\":\"update\"}\n\n"), out.frames(), "드레인이 FIFO가 아니다");
		assertEquals(2, out.flushes(), "프레임마다 flush해야 한다 — 버퍼에 남으면 클라이언트가 못 받는다");
	}

	/**
	 * 항목 11 — {@code writePrelude}는 큐를 거치지 않고 <b>즉시</b> 나가고, 그래서 <b>ready가 첫 프레임</b>이다.
	 *
	 * <p>구독을 ready보다 먼저 하면서도 ready가 첫 프레임이려면 이 두 경로가 갈라져 있어야 한다.
	 * prelude 중 도착한 신호가 직행하면(= replay-gate 제거) ready 앞에 프레임이 붙어 계약의
	 * {@code raw.startsWith(READY_FRAME)}가 깨진다 — 변이 M2-10의 단위 재현이다.
	 */
	@Test
	void writePreludeGoesOutImmediatelyAndReadyStaysTheFirstFrame() {
		RecordingOutput out = new RecordingOutput();
		SseHttp.ServletStream stream = new SseHttp.ServletStream(new RecordingAsyncContext(), out);

		assertTrue(stream.write(SseHttp.frame("change", "{\"kind\":\"lock\"}")), "구독 콜백이 먼저 도착했다");
		assertTrue(stream.writePrelude(SseHttp.READY));

		assertEquals(List.of(READY_FRAME), out.frames(), "writePrelude가 큐를 거쳤다");

		stream.endPrelude(SseHttp.DROP_NOTHING);

		assertEquals(List.of(READY_FRAME, "event: change\ndata: {\"kind\":\"lock\"}\n\n"), out.frames(),
				"ready가 첫 프레임이 아니다 — 계약 sse-stream A-3이 첫 바이트부터 대조한다");
	}

	/**
	 * 항목 12 — 드레인 시 {@code orderKey <= dropUpTo}인 항목을 버린다(replay와 큐의 중복 제거).
	 * 로그 스트림은 {@code endPrelude(lastReplayedSeq)}로 replay가 이미 보낸 seq를 지운다.
	 */
	@Test
	void endPreludeDropsQueuedFramesUpToTheOrderKey() {
		RecordingOutput deduped = new RecordingOutput();
		SseHttp.ServletStream first = new SseHttp.ServletStream(new RecordingAsyncContext(), deduped);
		first.write(SseHttp.frame("log", "{\"seq\":10}"), 10L);
		first.write(SseHttp.frame("log", "{\"seq\":11}"), 11L);

		first.endPrelude(10L);

		assertEquals(List.of("event: log\ndata: {\"seq\":11}\n\n"), deduped.frames(),
				"replay가 이미 보낸 seq가 중복으로 나갔거나, 새 seq가 유실됐다");

		RecordingOutput kept = new RecordingOutput();
		SseHttp.ServletStream second = new SseHttp.ServletStream(new RecordingAsyncContext(), kept);
		second.write(SseHttp.frame("log", "{\"seq\":10}"), 10L);
		second.write(SseHttp.frame("log", "{\"seq\":11}"), 11L);

		second.endPrelude(SseHttp.DROP_NOTHING);

		assertEquals(2, kept.frames().size(), "아무것도 버리지 않는 값인데 버렸다");
	}

	/**
	 * 항목 13 — <b>원자성(교차 스레드)</b>. 여러 스레드가 계속 {@code write}하는 동안 {@code endPrelude}가
	 * 돌아도 ① 유실 0 ② 스레드별 순서 역전 0 ③ 프레임 바이트가 섞이지 않는다.
	 *
	 * <p><b>이것이 이 phase에서 GREEN A·B를 지키는 단언이다.</b> 모드 검사·적재·드레인·전환이 같은 monitor
	 * 안에 있지 않으면 "드레인 전이면 큐, 드레인 후면 직행" 사이로 새는 경로가 생긴다(변이 M2-11·M2-12).
	 * 한가한 환경의 1회 실행은 아무것도 증명하지 않으므로 라운드를 반복한다.
	 */
	@Test
	void concurrentWritesAcrossEndPreludeLoseNothingAndKeepOrder() throws Exception {
		int rounds = 20;
		int workerCount = 4;
		int perWorker = 250;

		for (int round = 0; round < rounds; round++) {
			RecordingOutput out = new RecordingOutput();
			SseHttp.ServletStream stream = new SseHttp.ServletStream(new RecordingAsyncContext(), out);
			AtomicInteger started = new AtomicInteger();
			List<Thread> workers = new ArrayList<>();
			for (int w = 0; w < workerCount; w++) {
				int worker = w;
				Thread thread = new Thread(() -> {
					started.incrementAndGet();
					for (int i = 0; i < perWorker; i++) {
						stream.write(SseHttp.frame("change", "{\"w\":" + worker + ",\"i\":" + i + "}"));
					}
				});
				workers.add(thread);
				thread.start();
			}
			while (started.get() < workerCount) {
				Thread.onSpinWait(); // 워커가 전부 달리는 중에 게이트를 닫는다(대기 프리미티브를 쓰지 않는다).
			}
			stream.endPrelude(SseHttp.DROP_NOTHING);
			for (Thread thread : workers) {
				thread.join();
			}

			List<String> frames = out.frames();
			assertEquals(workerCount * perWorker, frames.size(),
					"프레임이 유실되거나 중복됐다(라운드 " + round + ")");
			assertEquals(0, stream.droppedCount(), "상한에 걸리지 않아야 하는 규모다");
			int[] highest = new int[workerCount];
			for (int w = 0; w < workerCount; w++) {
				highest[w] = -1;
			}
			for (String frame : frames) {
				assertTrue(frame.startsWith("event: change\ndata: {\"w\":") && frame.endsWith("}\n\n"),
						"프레임 바이트가 섞였다: " + frame);
				String payload = frame.substring(frame.indexOf("{\"w\":"), frame.length() - 2);
				int worker = Integer.parseInt(payload.substring(5, payload.indexOf(',')));
				int index = Integer.parseInt(payload.substring(payload.indexOf("\"i\":") + 4, payload.length() - 1));
				assertEquals(highest[worker] + 1, index,
						"스레드 " + worker + "의 프레임 순서가 역전됐다(라운드 " + round + ")");
				highest[worker] = index;
			}
		}
	}

	/** 항목 14 — {@code endPrelude}는 <b>멱등</b>이고, prelude 중 닫힌 뒤에는 아무것도 쓰지 않는다. */
	@Test
	void endPreludeIsIdempotentAndSilentAfterClose() {
		RecordingOutput out = new RecordingOutput();
		SseHttp.ServletStream stream = new SseHttp.ServletStream(new RecordingAsyncContext(), out);
		stream.write(SseHttp.frame("change", "{\"kind\":\"create\"}"));
		stream.endPrelude(SseHttp.DROP_NOTHING);
		stream.write(SseHttp.frame("change", "{\"kind\":\"update\"}"));

		stream.endPrelude(SseHttp.DROP_NOTHING);

		assertEquals(List.of("event: change\ndata: {\"kind\":\"create\"}\n\n",
				"event: change\ndata: {\"kind\":\"update\"}\n\n"), out.frames(),
				"두 번째 endPrelude가 큐를 다시 흘려보냈다");

		RecordingOutput closedOut = new RecordingOutput();
		SseHttp.ServletStream closedStream = new SseHttp.ServletStream(new RecordingAsyncContext(), closedOut);
		closedStream.write(SseHttp.frame("change", "{\"kind\":\"lock\"}"));
		closedStream.close();

		closedStream.endPrelude(SseHttp.DROP_NOTHING);

		assertEquals(List.of(), closedOut.frames(), "닫힌 응답에 큐가 흘러 들어갔다");
	}

	/**
	 * 항목 15 — 큐는 <b>유한</b>하다. 상한을 넘기면 가장 오래된 것을 버리고 드롭 수를 센다.
	 *
	 * <p>drop-oldest가 맞는 방향인 이유: 큐는 seq 오름차순이라 가장 오래된 것이 곧
	 * {@code endPrelude(lastReplayedSeq)}가 어차피 버릴 중복 후보와 겹친다.
	 */
	@Test
	void thePreludeQueueIsBoundedAndDropsTheOldest() {
		int overflow = 7;
		RecordingOutput out = new RecordingOutput();
		SseHttp.ServletStream stream = new SseHttp.ServletStream(new RecordingAsyncContext(), out);
		for (int i = 0; i < SseHttp.PRELUDE_MAX + overflow; i++) {
			assertTrue(stream.write(SseHttp.frame("log", "{\"seq\":" + i + "}"), i));
		}

		assertEquals(SseHttp.PRELUDE_MAX, stream.queuedCount(), "큐가 무한히 자랐다");
		assertEquals(overflow, stream.droppedCount(), "드롭 카운터가 실제 드롭 수와 다르다");

		stream.endPrelude(SseHttp.DROP_NOTHING);

		List<String> frames = out.frames();
		assertEquals(SseHttp.PRELUDE_MAX, frames.size());
		assertEquals("event: log\ndata: {\"seq\":" + overflow + "}\n\n", frames.get(0),
				"가장 오래된 것이 아니라 다른 것을 버렸다");
	}

	/**
	 * 항목 16 — prelude 중 {@code close()}: {@code isOpen()}이 false · {@code complete()}가 정확히 1회 ·
	 * 큐 폐기 · <b>멱등</b>이며 종료 콜백도 1회다.
	 *
	 * <p>불변식 6의 나머지 절반(컨트롤러가 {@code open()}~{@code endPrelude} 구간을 {@code try/catch}로
	 * 감싸 봉인한다)은 컨트롤러가 생기는 step4·step5가 소유한다 — 여기서 컨트롤러를 흉내 내지 않는다.
	 */
	@Test
	void closingDuringThePreludeCompletesOnceAndDiscardsTheQueue() {
		RecordingAsyncContext context = new RecordingAsyncContext();
		RecordingOutput out = new RecordingOutput();
		SseHttp.ServletStream stream = new SseHttp.ServletStream(context, out);
		AtomicInteger unsubscribed = new AtomicInteger();
		stream.onClosed(unsubscribed::incrementAndGet);
		stream.write(SseHttp.frame("change", "{\"kind\":\"status\"}"));

		stream.close();
		stream.close();

		assertFalse(stream.isOpen(), "닫힌 스트림이 열려 있다고 답한다");
		assertEquals(1, context.completions(), "AsyncContext.complete()는 정확히 1회다");
		assertEquals(1, unsubscribed.get(), "종료 콜백(구독 해제)이 1회가 아니다");
		assertEquals(0, stream.queuedCount(), "닫으면서 큐를 폐기하지 않았다");
		assertEquals(List.of(), out.frames(), "닫힌 응답에 프레임을 썼다");
	}

	/**
	 * 항목 17 — {@code writePrelude}도 <b>닫힘에 안전</b>하다: {@code false}를 돌려주고 던지지 않는다.
	 * 이 메서드도 결국 요청 스레드에서 불리므로 예외가 새면 응답이 500으로 뒤집힌다(불변식 1).
	 */
	@Test
	void writePreludeAfterCloseReturnsFalseWithoutThrowing() {
		RecordingOutput out = new RecordingOutput();
		SseHttp.ServletStream stream = new SseHttp.ServletStream(new RecordingAsyncContext(), out);
		stream.close();

		assertFalse(stream.writePrelude(SseHttp.READY), "닫힌 뒤의 writePrelude가 true를 돌려줬다");
		assertFalse(stream.write(SseHttp.READY), "닫힌 뒤의 write가 true를 돌려줬다");
		assertEquals(List.of(), out.frames());
	}

	/**
	 * 항목 18 — 클라이언트 끊김({@code IOException})은 <b>false + 자기 봉인</b>이지 예외가 아니다.
	 *
	 * <p>이 메서드는 트리거 요청 스레드에서 불린다 — 예외가 새면 이미 성공한 저장이 전역 에러 핸들러에
	 * 걸려 500으로 뒤집히고 클라이언트 재시도가 중복 저장을 만든다(Node {@code server/index.js}
	 * 1144~1150행 주석이 명시한 위험).
	 */
	@Test
	void aBrokenPipeSealsTheStreamInsteadOfThrowing() {
		RecordingAsyncContext context = new RecordingAsyncContext();
		RecordingOutput out = new RecordingOutput();
		SseHttp.ServletStream stream = new SseHttp.ServletStream(context, out);
		AtomicInteger unsubscribed = new AtomicInteger();
		stream.onClosed(unsubscribed::incrementAndGet);
		stream.endPrelude(SseHttp.DROP_NOTHING);
		out.failFromNowOn();

		assertFalse(stream.write(SseHttp.frame("change", "{\"kind\":\"create\"}")), "끊긴 연결에 true를 돌려줬다");

		assertFalse(stream.isOpen(), "쓰기 실패 후 스스로 봉인하지 않았다");
		assertEquals(1, context.completions());
		assertEquals(1, unsubscribed.get(), "봉인이 구독을 해제하지 않았다 — 구독 누수다");
	}

	// --- 도구 -------------------------------------------------------------------------------------

	private static Path mainSource(String relative) {
		Path file = Path.of("src", "main", "java");
		for (String segment : relative.split("/")) {
			file = file.resolve(segment);
		}
		assertTrue(Files.isRegularFile(file), "main 소스가 없다: " + file);
		return file;
	}

	/** 블록 주석과 줄 첫머리 주석을 지운다 — javadoc은 코드가 아니다(금지 철자를 설명하기 때문에 필요하다). */
	private static String sourceWithoutComments(Path file) throws IOException {
		return Files.readString(file, StandardCharsets.UTF_8)
				.replaceAll("(?s)/\\*.*?\\*/", " ")
				.replaceAll("(?m)^\\s*//[^\n]*", " ");
	}

	/** 프레임 단위 출력 기록기 — {@code write(byte[])} 호출 하나가 항목 하나다(바이트 섞임 관측용). */
	private static final class RecordingOutput extends OutputStream {

		private final Queue<String> frames = new ConcurrentLinkedQueue<>();

		private final ByteArrayOutputStream all = new ByteArrayOutputStream();

		private final AtomicBoolean failing = new AtomicBoolean();

		private final AtomicInteger flushes = new AtomicInteger();

		@Override
		public void write(int b) {
			throw new UnsupportedOperationException("SSE는 프레임 단위로만 쓴다");
		}

		@Override
		public void write(byte[] buffer) throws IOException {
			write(buffer, 0, buffer.length);
		}

		@Override
		public void write(byte[] buffer, int offset, int length) throws IOException {
			if (this.failing.get()) {
				throw new IOException("클라이언트가 연결을 끊었다");
			}
			this.frames.add(new String(buffer, offset, length, StandardCharsets.UTF_8));
			synchronized (this.all) {
				this.all.write(buffer, offset, length);
			}
		}

		@Override
		public void flush() {
			this.flushes.incrementAndGet();
		}

		List<String> frames() {
			return List.copyOf(this.frames);
		}

		int flushes() {
			return this.flushes.get();
		}

		void failFromNowOn() {
			this.failing.set(true);
		}

	}

	/** {@code complete()} 횟수를 세는 최소 {@link AsyncContext} 스텁 — 컨테이너 없이 종료 규율을 본다. */
	private static final class RecordingAsyncContext implements AsyncContext {

		private final AtomicInteger completions = new AtomicInteger();

		private final List<AsyncListener> listeners = new ArrayList<>();

		private long timeout = -1L;

		int completions() {
			return this.completions.get();
		}

		@Override
		public void complete() {
			this.completions.incrementAndGet();
		}

		@Override
		public void addListener(AsyncListener listener) {
			this.listeners.add(listener);
		}

		@Override
		public void addListener(AsyncListener listener, ServletRequest request, ServletResponse response) {
			this.listeners.add(listener);
		}

		@Override
		public void setTimeout(long timeout) {
			this.timeout = timeout;
		}

		@Override
		public long getTimeout() {
			return this.timeout;
		}

		@Override
		public ServletRequest getRequest() {
			return null;
		}

		@Override
		public ServletResponse getResponse() {
			return null;
		}

		@Override
		public boolean hasOriginalRequestAndResponse() {
			return true;
		}

		@Override
		public void dispatch() {
			throw new UnsupportedOperationException("SSE는 디스패치하지 않는다");
		}

		@Override
		public void dispatch(String path) {
			throw new UnsupportedOperationException("SSE는 디스패치하지 않는다");
		}

		@Override
		public void dispatch(ServletContext context, String path) {
			throw new UnsupportedOperationException("SSE는 디스패치하지 않는다");
		}

		@Override
		public void start(Runnable run) {
			throw new UnsupportedOperationException("컨테이너 스레드를 빌리지 않는다(ADR-008)");
		}

		@Override
		public <T extends AsyncListener> T createListener(Class<T> clazz) {
			throw new UnsupportedOperationException("리스너는 직접 만든다");
		}

	}

}
