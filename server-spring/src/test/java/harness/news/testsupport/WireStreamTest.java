package harness.news.testsupport;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.List;
import java.util.Map;
import java.util.concurrent.BlockingQueue;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import org.junit.jupiter.api.Test;

/**
 * 관측 도구 자신의 검증 — {@link WireStream}이 <b>알려진 바이트열</b>을 정확히 읽는지 확인한다.
 *
 * <p>도구가 검증되지 않으면 그 도구로 낸 green은 아무것도 증명하지 못한다. 그래서 실제 SSE 라우트가
 * 생기기 전(step4·step5)에, 손으로 만든 canned 응답으로 ① 헤더 원문 보존 ② chunked 해독 ③ 프레임 분해
 * ④ <b>EOF를 기다리지 않는다</b>(서버가 연결을 열어 둔 채여도 반환한다) ⑤ 타임아웃이 예외가 아니라
 * {@code null}/{@code false}라는 것을 잠근다.
 */
class WireStreamTest {

	private static final String READY_FRAME = "event: ready\ndata: {\"ok\":true}\n\n";

	@Test
	void theInstrumentReadsHeadersAndFramesWithoutWaitingForEof() throws Exception {
		try (CannedSseServer server = CannedSseServer.start()) {
			server.push(READY_FRAME);

			try (WireStream stream = WireStream.open(server.port(), "/api/stream", Map.of())) {
				WireStream.Frame ready = stream.awaitFrame((frame) -> "ready".equals(frame.event()),
						Duration.ofSeconds(5));

				assertNotNull(ready, "ready 프레임을 읽지 못했다(연결은 열려 있다 — EOF를 기다리면 안 된다)");
				assertEquals("{\"ok\":true}", ready.data());
				assertEquals(200, stream.status());
				assertEquals("Content-Type: text/event-stream; charset=utf-8", stream.line("Content-Type"),
						"헤더 원문(대소문자·공백)이 보존되지 않았다");
				assertEquals("Cache-Control: no-cache", stream.line("cache-control"),
						"헤더 조회는 대소문자를 무시하되 원문을 돌려줘야 한다");
				assertTrue(stream.rawBody().startsWith(READY_FRAME),
						"본문 원문이 프레임 바이트 그대로가 아니다: " + stream.rawBody());
				assertTrue(stream.rawBody().endsWith("\n\n"), "프레임 종결자가 보존되지 않았다");
				assertFalse(stream.rawBody().contains("\r"), "청크 프레이밍의 CR이 본문에 섞였다");
			}
		}
	}

	@Test
	void timeoutsAreNullAndSilenceIsObservable() throws Exception {
		try (CannedSseServer server = CannedSseServer.start()) {
			server.push(READY_FRAME);

			try (WireStream stream = WireStream.open(server.port(), "/api/stream", Map.of())) {
				assertNotNull(stream.awaitFrame((frame) -> "ready".equals(frame.event()), Duration.ofSeconds(5)));

				assertNull(stream.awaitFrame((frame) -> "change".equals(frame.event()), Duration.ofMillis(300)),
						"오지 않는 프레임은 예외가 아니라 null이어야 한다");
				assertTrue(stream.awaitSilence(Duration.ofMillis(200)), "아무것도 보내지 않았는데 침묵이 아니라고 한다");

				server.push("event: change\ndata: {\"kind\":\"create\"}\n\n");

				assertFalse(stream.awaitSilence(Duration.ofSeconds(2)), "새 프레임이 왔는데 침묵이라고 한다");
				assertEquals("{\"kind\":\"create\"}",
						stream.awaitFrame((frame) -> "change".equals(frame.event()), Duration.ofSeconds(5)).data());
				assertEquals(List.of("Content-Type: text/event-stream; charset=utf-8", "Cache-Control: no-cache",
						"Connection: keep-alive", "Transfer-Encoding: chunked"), stream.headerLines());
			}
		}
	}

	/** 손으로 만든 SSE 응답 서버 — 헤더를 쓴 뒤 연결을 <b>열어 둔 채</b> 요청받은 프레임만 흘린다. */
	private static final class CannedSseServer implements AutoCloseable {

		private static final String HEAD = "HTTP/1.1 200 OK\r\n"
				+ "Content-Type: text/event-stream; charset=utf-8\r\n"
				+ "Cache-Control: no-cache\r\n"
				+ "Connection: keep-alive\r\n"
				+ "Transfer-Encoding: chunked\r\n\r\n";

		private final ServerSocket listener;

		private final BlockingQueue<String> outbox = new LinkedBlockingQueue<>();

		private final AtomicBoolean stopped = new AtomicBoolean();

		private final Thread worker;

		private CannedSseServer(ServerSocket listener) {
			this.listener = listener;
			this.worker = new Thread(this::serve, "canned-sse");
			this.worker.setDaemon(true);
			this.worker.start();
		}

		static CannedSseServer start() throws IOException {
			return new CannedSseServer(new ServerSocket(0, 1, InetAddress.getByName("127.0.0.1")));
		}

		int port() {
			return this.listener.getLocalPort();
		}

		void push(String frame) {
			this.outbox.add(frame);
		}

		private void serve() {
			try (Socket socket = this.listener.accept()) {
				readRequestHead(socket.getInputStream());
				OutputStream out = socket.getOutputStream();
				out.write(HEAD.getBytes(StandardCharsets.ISO_8859_1));
				out.flush();
				while (!this.stopped.get()) {
					String frame = this.outbox.poll(50, TimeUnit.MILLISECONDS);
					if (frame == null) {
						continue;
					}
					byte[] payload = frame.getBytes(StandardCharsets.UTF_8);
					out.write((Integer.toHexString(payload.length) + "\r\n").getBytes(StandardCharsets.ISO_8859_1));
					out.write(payload);
					out.write("\r\n".getBytes(StandardCharsets.ISO_8859_1));
					out.flush();
				}
			}
			catch (IOException | InterruptedException ex) {
				// 테스트 종료 경로다 — 클라이언트가 먼저 끊으면 여기로 온다.
			}
		}

		private static void readRequestHead(InputStream in) throws IOException {
			StringBuilder head = new StringBuilder();
			int read;
			while ((read = in.read()) >= 0) {
				head.append((char) read);
				if (head.length() >= 4 && head.substring(head.length() - 4).equals("\r\n\r\n")) {
					return;
				}
			}
		}

		@Override
		public void close() throws IOException {
			this.stopped.set(true);
			this.listener.close();
		}

	}

}
