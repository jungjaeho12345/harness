package harness.news.controller;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import harness.news.service.ChangeBus;
import harness.news.service.SessionGuard;
import harness.news.service.UserService;
import harness.news.testsupport.TempNewsDb;
import harness.news.testsupport.Wire;
import harness.news.testsupport.WireStream;
import java.nio.file.Path;
import java.time.Duration;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.apache.catalina.connector.Connector;
import org.apache.coyote.AbstractProtocol;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.tomcat.TomcatWebServer;
import org.springframework.boot.web.server.servlet.context.ServletWebServerApplicationContext;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;

/**
 * {@code GET /api/stream}의 <b>규모 축</b> — 동시 연결 {@value #STREAMS}개에서 무슨 일이 생기는가.
 * <b>④ 테스터가 phase 74의 "미검증(정직한 공백)" 목록 중 하나를 실측으로 닫으려고 추가했다</b>(2026-08-31).
 *
 * <h2>왜 필요한가</h2>
 * 이 설계에는 <b>동시 연결 상한이 없다</b>(Node {@code bus.setMaxListeners(0)} 동형 ·
 * {@code docs/api-contract/sse.md}가 "구독자 수 제한이 없다"로 동결). 그리고 프레임은 <b>트리거 요청
 * 스레드</b>가 구독자 수만큼 <b>직렬로</b> 쓴다 — 즉 구독자가 늘수록 <b>기사 저장 같은 평범한 쓰기 요청의
 * 지연</b>이 함께 늘고, 어딘가에서 무너진다면 그것은 SSE가 아니라 <b>전 라우트의 응답</b>이다.
 * 기존 테스트는 스트림 <b>8개</b>까지만 본다({@code StreamWireTest.openStreamsDoNotOccupyWorkerThreads} ·
 * 워커 5개보다 많다는 것만 확인). phase 74 {@code forward_notes} (6) ③은 "수백 개 동시 연결"을
 * <b>미검증</b>으로 인계했다 — 여기서 그 자리를 200연결로 채운다.
 *
 * <h2>단언하는 것 / 관측만 하는 것</h2>
 * <b>단언</b>: ① 200개가 전부 열리고 ready를 받는다(워커 5개인데 스트림이 200개다 — 블로킹 구현이면
 * 여기서 이미 죽는다) ② 구독자 수가 정확히 200이다(조용히 흘리는 상한이 없다) ③ 200연결 상태에서
 * <b>다른 라우트</b>({@code GET /api/health})가 응답한다 ④ 트리거 요청({@code POST /api/articles})이
 * <b>200 OK</b>이고 그 한 번의 신호가 <b>200개 전부</b>에 유실 없이 도달한다 ⑤ 소켓을 전부 닫으면 구독이
 * <b>0으로 회수</b>된다(publish 1회가 회수 트리거다 — index.json decisions (12)).
 * <b>관측(단언 아님)</b>: 트리거 요청의 왕복 시간과 health 응답 시간을 출력한다 — 환경마다 다르므로
 * 임계값을 단언하면 flaky가 되고, 이 phase는 그 임계값을 계약으로 갖고 있지 않다.
 *
 * <p>DB는 이 클래스 전용 임시 사본이고 리포 {@code news.db}는 열지 않는다.
 */
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT,
		properties = "server.tomcat.threads.max=" + StreamScaleWireTest.MAX_WORKERS_TEXT)
class StreamScaleWireTest {

	/** 애노테이션 값은 컴파일 상수여야 한다 — {@link #MAX_WORKERS}가 같은 값을 숫자로 갖는다. */
	static final String MAX_WORKERS_TEXT = "5";

	private static final int MAX_WORKERS = Integer.parseInt(MAX_WORKERS_TEXT);

	/** 워커 5개 대비 <b>40배</b> — "스트림은 워커를 점유하지 않는다"가 규모에서도 참인지 본다. */
	private static final int STREAMS = 200;

	private static final Duration WAIT = Duration.ofSeconds(30);

	private static final Duration RECLAIM = Duration.ofSeconds(30);

	private static final String SESSION_HEADER = "x-session-id";

	private static final String PASSWORD = "stream-scale-pw";

	private static final Path DATA_DIR = TempNewsDb.newDataDir("stream-scale");

	@DynamicPropertySource
	static void dataDir(DynamicPropertyRegistry registry) {
		registry.add("app.data-dir", () -> DATA_DIR.toAbsolutePath().toString());
	}

	@Value("${local.server.port}")
	private int port;

	@Autowired
	private UserService users;

	@Autowired
	private SessionGuard sessions;

	@Autowired
	private ChangeBus changes;

	@Autowired
	private ServletWebServerApplicationContext webServerContext;

	@Test
	void twoHundredConcurrentStreamsAllReceiveOneTriggerAndAreReclaimed() {
		assertTrue(STREAMS > MAX_WORKERS * 10, "연결 수가 워커 수를 크게 넘어야 이 테스트가 무언가를 증명한다");
		assertEquals(MAX_WORKERS, configuredMaxWorkers(),
				"워커 상한 프로퍼티가 실제 커넥터에 적용되지 않았다 — 단언이 공허해진다");
		ensureUser("scale-r", "R");
		String token = this.sessions.createSession("scale-r");
		int before = this.changes.subscriberCount();

		List<WireStream> streams = new ArrayList<>();
		long triggerMs;
		long healthMs;
		try {
			for (int i = 0; i < STREAMS; i++) {
				WireStream stream = WireStream.open(this.port, "/api/stream", Map.of(SESSION_HEADER, token));
				streams.add(stream);
				assertEquals(200, stream.status(), "연결 " + i + "이 열리지 않았다(워커가 잠식됐다)");
				assertNotNull(stream.awaitFrame((frame) -> "ready".equals(frame.event()), WAIT),
						"연결 " + i + "에 ready가 오지 않았다 — 워커 " + MAX_WORKERS + "개가 스트림에 잠식됐다");
			}
			assertEquals(before + STREAMS, this.changes.subscriberCount(),
					"구독자 수가 연결 수와 다르다 — 조용히 흘린 연결이 있다");

			long startedAt = System.nanoTime();
			assertEquals(200, Wire.send(this.port, "GET", "/api/health", Map.of(), null).status(),
					STREAMS + "개 연결 상태에서 다른 라우트가 막혔다");
			healthMs = elapsedMs(startedAt);

			// 트리거 요청 하나가 구독자 200명에게 직렬로 프레임을 쓴다 — 그 요청이 성공해야 한다.
			startedAt = System.nanoTime();
			Wire.Response created = Wire.json(this.port, "POST", "/api/articles", Map.of(SESSION_HEADER, token),
					"{\"title\":\"scale-" + Long.toHexString(System.nanoTime()) + "\"}");
			triggerMs = elapsedMs(startedAt);
			assertEquals(200, created.status(), "구독자 " + STREAMS + "명에 대한 fanout이 트리거 응답을 뒤집었다: "
					+ created.body());

			int delivered = 0;
			List<Integer> missing = new ArrayList<>();
			for (int i = 0; i < streams.size(); i++) {
				if (streams.get(i).awaitFrame((frame) -> "change".equals(frame.event()), WAIT) != null) {
					delivered++;
				}
				else {
					missing.add(i);
				}
			}
			assertEquals(STREAMS, delivered, "신호가 일부 연결에 도달하지 않았다 — 유실된 연결 번호=" + missing);
		}
		finally {
			streams.forEach(WireStream::close);
		}

		System.out.println("[phase 74 tester 관측] 동시 연결=" + STREAMS + " · 워커=" + MAX_WORKERS
				+ " · 트리거(POST /api/articles) 왕복=" + triggerMs + "ms · GET /api/health=" + healthMs + "ms");

		assertTrue(awaitSubscriberCount(before, RECLAIM),
				"닫힌 연결 " + STREAMS + "개의 구독이 회수되지 않았다(현재 " + this.changes.subscriberCount() + ")");
	}

	/** 끊긴 구독은 다음 write 실패에서 회수된다 — publish가 그 트리거다(decisions (12)). */
	private boolean awaitSubscriberCount(int target, Duration timeout) {
		long deadline = System.nanoTime() + timeout.toNanos();
		while (System.nanoTime() < deadline) {
			if (this.changes.subscriberCount() <= target) {
				return true;
			}
			this.changes.publish(ChangeBus.CREATE);
			try {
				Thread.sleep(50);
			}
			catch (InterruptedException ex) {
				Thread.currentThread().interrupt();
				return false;
			}
		}
		return this.changes.subscriberCount() <= target;
	}

	private static long elapsedMs(long startedAt) {
		return (System.nanoTime() - startedAt) / 1_000_000L;
	}

	private int configuredMaxWorkers() {
		Connector connector = ((TomcatWebServer) this.webServerContext.getWebServer()).getTomcat().getConnector();
		return ((AbstractProtocol<?>) connector.getProtocolHandler()).getMaxThreads();
	}

	private void ensureUser(String userId, String role) {
		Map<String, Object> dto = new LinkedHashMap<>();
		dto.put("userId", userId);
		dto.put("name", userId);
		dto.put("role", role);
		dto.put("password", PASSWORD);
		try {
			this.users.create(dto);
		}
		catch (RuntimeException ignored) {
			// 이미 있다 — 픽스처는 멱등이다.
		}
	}

}
