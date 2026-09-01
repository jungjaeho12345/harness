package harness.news.service;

import static org.junit.jupiter.api.Assertions.assertDoesNotThrow;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertSame;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import org.junit.jupiter.api.Test;

/**
 * 무효화 신호 버스 — 이식 원본은 리포 루트 {@code server/index.js} 591~595행의
 * {@code const bus = new EventEmitter()} · {@code bus.setMaxListeners(0)} ·
 * {@code app.notifyChange = (kind) => bus.emit('change', { kind })}이다(ADR-005 · ADR-015).
 *
 * <p><b>계약 스위트는 이 클래스를 보지 못한다</b>: 이 step이 끝나도 구독자가 0이라 관측 가능한 동작
 * 변화가 없고(무회귀가 곧 AC다), SSE가 붙은 뒤에도 계약이 보는 것은 기사 4종의 {@code change} 프레임뿐이다
 * (tick·retry·수집 발행은 영원히 Java 테스트만 본다 — index.json decisions (7)(10)). 그래서 아래 항목들이
 * 이 축의 <b>유일한 방어선</b>이다.
 *
 * <h2>여기서 잠그는 불변식</h2>
 * <ol>
 * <li><b>fanout</b> — 구독자 전원이 한 번의 {@code publish}에 받는다(계약 A-5의 서비스층 대응물).</li>
 * <li><b>절대 던지지 않는다</b> — 한 구독자가 던져도 나머지가 받고 호출자는 정상 반환을 받는다.
 * 이유는 Node {@code server/index.js} 1144~1150행 주석이 명시한 위험이다: 예외가 라우트로 새면
 * <b>성공한 저장이 전역 에러 핸들러에 걸려 500으로 뒤집히고</b> 클라이언트 재시도가 중복 저장을 만든다.</li>
 * <li><b>호출 스레드에서 동기로 돈다</b> — 큐·실행자·스레드로 넘기면 ADR-008 (6)과 ADR-015 위반이고,
 * 응답이 끝난 뒤 무슨 일이 벌어지는지 아무도 관측하지 못한다.</li>
 * <li><b>해제는 멱등</b> · {@code subscriberCount()}가 누수 0의 관측 수단이다(SSE 연결 회수를 step4·step5가
 * 이 값으로 단언한다).</li>
 * <li><b>kind를 검증하지 않는다</b> — Node가 검증하지 않는다. 검증 예외가 라우트로 새면 (2)와 같은 사고다.</li>
 * </ol>
 */
class ChangeBusTest {

	private final ChangeBus bus = new ChangeBus();

	/** 항목 1 — 구독자 1개가 받고, kind 문자열이 손대지 않은 채 그대로 전달된다. */
	@Test
	void aSubscriberReceivesTheKindStringUnchanged() throws Exception {
		List<String> received = new ArrayList<>();
		try (AutoCloseable ignored = this.bus.subscribe(received::add)) {
			this.bus.publish(ChangeBus.CREATE);
			this.bus.publish(ChangeBus.UPDATE);
			this.bus.publish(ChangeBus.STATUS);
			this.bus.publish(ChangeBus.LOCK);
		}

		assertEquals(List.of("create", "update", "status", "lock"), received,
				"신호 어휘 4종이 그대로 전달되어야 한다(sse.md kind 표)");
	}

	/** 항목 2 — 구독자 2개가 publish 1회에 <b>둘 다</b> 받는다(계약 A-5 fanout의 서비스층 대응). */
	@Test
	void twoSubscribersBothReceiveOnePublish() throws Exception {
		List<String> first = new ArrayList<>();
		List<String> second = new ArrayList<>();
		try (AutoCloseable a = this.bus.subscribe(first::add); AutoCloseable b = this.bus.subscribe(second::add)) {
			this.bus.publish(ChangeBus.UPDATE);
		}

		assertEquals(List.of("update"), first, "첫 구독자가 받지 못했다");
		assertEquals(List.of("update"), second, "두 번째 구독자가 받지 못했다 — fanout이 깨졌다");
	}

	/**
	 * 항목 3 — {@code close()} 후에는 받지 않고, <b>이중 close가 안전</b>하다(예외 0 · 다른 구독 영향 0).
	 *
	 * <p><b>같은 리스너 인스턴스</b>를 두 번 구독시키는 이유: 해제가 "목록에서 이 리스너를 지운다"로
	 * 구현되면 이중 close가 <b>남의 구독</b>을 지운다(제거는 동치 항목 하나를 지우므로 두 번 부르면 둘 다
	 * 사라진다). 그 결함은 SSE에서 "탭을 닫았더니 다른 탭의 스트림이 조용히 죽는다"로 나타난다.
	 */
	@Test
	void closingASubscriptionStopsDeliveryAndIsIdempotent() throws Exception {
		List<String> received = new ArrayList<>();
		ChangeBus.Listener listener = received::add;
		AutoCloseable first = this.bus.subscribe(listener);
		AutoCloseable second = this.bus.subscribe(listener);
		assertEquals(2, this.bus.subscriberCount(), "같은 리스너의 두 구독은 각각 등록된다");

		first.close();
		assertDoesNotThrow(first::close, "이중 close는 무해해야 한다");
		assertDoesNotThrow(first::close, "세 번째 close도 무해해야 한다");

		assertEquals(1, this.bus.subscriberCount(), "이중 close가 남의 구독까지 지웠다");
		this.bus.publish(ChangeBus.LOCK);
		assertEquals(List.of("lock"), received, "살아 있는 구독 1개가 정확히 1회 받아야 한다");

		second.close();
		assertEquals(0, this.bus.subscriberCount(), "해제 후 구독자가 남았다 — 누수다");
		this.bus.publish(ChangeBus.LOCK);
		assertEquals(List.of("lock"), received, "해제된 구독자에게 신호가 갔다");
	}

	/**
	 * 항목 4 — 구독자가 던져도 (a) 나머지 구독자가 받고 (b) {@code publish}가 던지지 않는다.
	 *
	 * <p>던지는 구독자를 <b>가운데</b>에 둔다: 예외가 루프를 끊으면 뒤 구독자만 조용히 굶는다.
	 */
	@Test
	void aThrowingSubscriberNeitherStopsTheOthersNorTheCaller() throws Exception {
		List<String> before = new ArrayList<>();
		List<String> after = new ArrayList<>();
		try (AutoCloseable a = this.bus.subscribe(before::add);
				AutoCloseable b = this.bus.subscribe(kind -> {
					throw new IllegalStateException("구독자 폭발");
				});
				AutoCloseable c = this.bus.subscribe(after::add)) {

			assertDoesNotThrow(() -> this.bus.publish(ChangeBus.STATUS),
					"publish가 던지면 성공한 저장이 500으로 뒤집힌다(Node 1144~1150행 주석)");

			assertEquals(List.of("status"), before, "던지는 구독자 앞의 구독자가 받지 못했다");
			assertEquals(List.of("status"), after, "던지는 구독자 뒤의 구독자가 굶었다 — 루프가 끊겼다");

			assertDoesNotThrow(() -> this.bus.publish(ChangeBus.STATUS), "두 번째 publish도 정상이어야 한다");
			assertEquals(2, after.size(), "던진 구독자가 자동 해제되지도, 다음 신호를 막지도 않아야 한다");
		}
	}

	/**
	 * 항목 5 — {@code publish}는 <b>호출 스레드</b>에서 동기로 돈다(ADR-015 · Node {@code bus.emit}이 라우트
	 * 핸들러 스택에서 도는 것과 동형). 반환 시점에 이미 전달이 끝나 있어야 한다.
	 */
	@Test
	void publishRunsOnTheCallingThread() throws Exception {
		List<Thread> threads = new ArrayList<>();
		try (AutoCloseable ignored = this.bus.subscribe(kind -> threads.add(Thread.currentThread()))) {
			this.bus.publish(ChangeBus.CREATE);

			assertEquals(1, threads.size(), "publish 반환 시점에 전달이 끝나 있지 않다 — 비동기로 넘겼다");
			assertSame(Thread.currentThread(), threads.get(0), "구독자 콜백이 다른 스레드에서 돌았다(ADR-008 2군)");
		}
	}

	/** 항목 6 — 구독자 0명일 때 {@code publish}는 무해하다(SSE 연결이 하나도 없는 평시 상태다). */
	@Test
	void publishWithNoSubscribersIsHarmless() {
		assertEquals(0, this.bus.subscriberCount());
		assertDoesNotThrow(() -> this.bus.publish(ChangeBus.CREATE));
	}

	/** 항목 7 — {@code subscriberCount()}가 구독·해제에 따라 정확히 오르내린다(누수 0의 관측 수단). */
	@Test
	void subscriberCountTracksSubscribeAndClose() throws Exception {
		assertEquals(0, this.bus.subscriberCount());
		AutoCloseable a = this.bus.subscribe(kind -> {
		});
		assertEquals(1, this.bus.subscriberCount());
		AutoCloseable b = this.bus.subscribe(kind -> {
		});
		assertEquals(2, this.bus.subscriberCount());
		a.close();
		assertEquals(1, this.bus.subscriberCount());
		b.close();
		assertEquals(0, this.bus.subscriberCount());
	}

	/**
	 * kind는 <b>검증하지 않는다</b> — Node {@code bus.emit('change', { kind })}에 검증이 없다. 어휘 밖 문자열도
	 * {@code null}도 그대로 전달되며 예외가 되지 않는다(검증 예외가 라우트로 새면 항목 4와 같은 사고다).
	 */
	@Test
	void publishDoesNotValidateTheKind() throws Exception {
		List<String> received = new ArrayList<>();
		try (AutoCloseable ignored = this.bus.subscribe(received::add)) {
			assertDoesNotThrow(() -> this.bus.publish("어휘에-없는-값"));
			assertDoesNotThrow(() -> this.bus.publish(null));
		}

		assertEquals(2, received.size(), "검증하지 않는다 = 전부 그대로 전달한다");
		assertEquals("어휘에-없는-값", received.get(0));
		assertNull(received.get(1), "null kind도 그대로 전달된다");
	}

	/**
	 * 항목 8 — <b>소스 정적 스캔</b>: 이 버스는 타이머·스레드·실행자·네트워크를 만들지 않고
	 * (ADR-008 · ADR-015) 서비스층이므로 서블릿 타입을 알지 못한다(ADR-006 · ADR-013).
	 *
	 * <p>{@code Adr008DisciplineTest}가 main 소스 전역을 이미 스캔하지만 그 게이트는 <b>이 phase가 0줄
	 * 고치는 파일</b>이라, 이 파일에만 걸리는 두 축(서블릿 import 0 · 와이어 포맷 0)은 여기서 잠근다.
	 * JDK 25가 정식화한 표면({@code StructuredTaskScope}·{@code ScopedValue}·{@code Subtask})은 그 게이트의
	 * 패턴 목록에 <b>0건</b>이라(2026-08-30 계획 단계 실측) 게이트가 잡지 못한다 — 이 파일에 대해서만
	 * 여기서 막는다(게이트 확장은 별도 ADR·리뷰가 필요하고 step6 작업 G가 조사·기록을 소유한다).
	 *
	 * <p>판정 전에 주석을 지운다 — 규칙을 <b>설명하는</b> 문장이 위반으로 잡히면 규칙을 문서화할 수 없다
	 * ({@code Adr008DisciplineTest}와 같은 규율).
	 */
	@Test
	void theBusSourceHasNoTimerNoThreadNoServletTypeAndNoWireFormat() throws IOException {
		Path declared = Path.of("src", "main", "java", "harness", "news", "service", "ChangeBus.java");
		assertTrue(Files.isRegularFile(declared), "ChangeBus가 서비스층에 없다: " + declared);

		String code = Files.readString(declared, StandardCharsets.UTF_8)
				.replaceAll("(?s)/\\*.*?\\*/", " ") // 블록 주석 제거(javadoc은 코드가 아니다)
				.replaceAll("(?m)^\\s*//[^\n]*", " "); // 줄 첫머리 주석만 — 리터럴 속 //를 지우지 않는다.

		for (String forbidden : List.of("@Scheduled", "@EnableScheduling", "@Async", "@EnableAsync", "@Retryable",
				"@Recover", "RetryTemplate", "TaskScheduler", "TaskExecutor", "ScheduledExecutorService",
				"ScheduledThreadPoolExecutor", "ScheduledFuture", "ExecutorService", "ThreadPoolExecutor",
				"ForkJoinPool", "Executors.", "new Timer(", "Thread.sleep(", "TimeUnit.", "LockSupport", ".await(",
				"CompletableFuture", "CompletionStage", ".thenApply(", ".thenAccept(", ".thenRun(", ".whenComplete(",
				"CountDownLatch", "new Thread(", "startVirtualThread", "Thread.ofVirtual(", "Thread.ofPlatform(",
				".sendAsync(", "HttpClient", "RestTemplate", "WebClient", "RestClient", ".openConnection(",
				".openStream(", "StructuredTaskScope", "ScopedValue", "Subtask")) {
			assertFalse(code.contains(forbidden),
					"ADR-008·ADR-015: 이 버스는 스스로 깨어나지도 다시 시도하지도 않는다 — 금지 철자가 코드에 있다: "
							+ forbidden);
		}

		for (String servletType : List.of("jakarta", "AsyncContext", "HttpServlet", "ServletOutputStream")) {
			assertFalse(code.contains(servletType),
					"서비스층은 서블릿 타입을 알지 못한다(ADR-006 · ADR-013) — 코드에 있다: " + servletType);
		}

		for (String wireFormat : List.of("event:", "data:", "\\\"kind\\\"", "text/event-stream")) {
			assertFalse(code.contains(wireFormat),
					"직렬화는 web층 소유다 — 서비스층에 와이어 포맷이 새면 지점이 갈린다(ADR-015): " + wireFormat);
		}
	}
}
