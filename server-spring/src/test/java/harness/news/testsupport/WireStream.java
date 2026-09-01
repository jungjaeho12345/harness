package harness.news.testsupport;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.net.Socket;
import java.net.SocketTimeoutException;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.function.Predicate;

/**
 * 원시 HTTP <b>스트림</b> 클라이언트(테스트 전용) — 열린 채로 프레임이 흘러 들어오는 응답을 관측한다.
 *
 * <h2>왜 {@link Wire}를 고치지 않고 새 파일인가</h2>
 * {@link Wire}는 요청을 {@code Connection: close}로 보내고 응답을 <b>EOF까지</b> 읽는다 — SSE에서는 서버가
 * 연결을 끝내지 않으므로 영원히 블록한다. 스트림 지원을 그 도구에 끼워 넣으면 관측 도구가 두 모드를 갖게
 * 되고, <b>한쪽만 맞아도 통과하는 자리</b>가 생긴다(기존 37 라우트의 판정 도구다 — 손대지 않는다).
 *
 * <h2>규율</h2>
 * <ul>
 *   <li>요청은 {@code Connection: keep-alive}로 보내고 <b>EOF를 기다리지 않는다</b>. 읽기는 전부
 *       데드라인 기반이고 타임아웃은 예외가 아니라 {@code null}/{@code false}다 — 실패의 의미는
 *       케이스의 단언이 표현한다.</li>
 *   <li>헤더 이름·값의 <b>원문 대소문자와 공백을 보존</b>한다({@link Wire}와 같은 이유: 도구가 문자열을
 *       만지면 {@code text/event-stream; charset=utf-8}의 공백 1바이트 판정이 무의미해진다).</li>
 *   <li>chunked를 해독하되 {@link #rawBody()}는 <b>SSE 프레임 원문</b>(LF 포함)을 그대로 보존한다 —
 *       {@code \n\n} 종결자 검사가 이 위에서 이뤄진다.</li>
 *   <li>반드시 {@code try (WireStream s = ...)}로 감싼다. 소켓이 남으면 surefire가 끝나지 않는다.</li>
 * </ul>
 */
public final class WireStream implements AutoCloseable {

	/** 소켓 읽기 1회의 최대 대기 — 데드라인을 이 조각으로 잘라 폴링한다. */
	private static final int READ_SLICE_MS = 50;

	private static final int CONNECT_TIMEOUT_MS = 5000;

	private static final Duration HEADER_TIMEOUT = Duration.ofSeconds(15);

	private final Socket socket;

	private final InputStream in;

	private final int status;

	private final List<String> headerLines;

	private final boolean chunked;

	/** 아직 해독하지 못한 원시 바이트(chunk 경계에 걸린 조각). */
	private final ByteArrayOutputStream pending = new ByteArrayOutputStream();

	/** 해독된 본문 = SSE 프레임 원문. */
	private final ByteArrayOutputStream body = new ByteArrayOutputStream();

	private final List<Frame> frames = new ArrayList<>();

	/** {@link #awaitFrame}이 이미 소비한 프레임 수. */
	private int consumed;

	/** 프레임 분해가 끝난 본문 문자 위치. */
	private int frameCursor;

	private boolean eof;

	/** SSE 프레임 1개 — {@code event:}·{@code data:} 줄만 본다(이 서버는 다른 필드를 쓰지 않는다). */
	public record Frame(String event, String data) {
	}

	private WireStream(Socket socket, InputStream in, int status, List<String> headerLines, boolean chunked) {
		this.socket = socket;
		this.in = in;
		this.status = status;
		this.headerLines = headerLines;
		this.chunked = chunked;
	}

	/**
	 * 소켓을 열어 요청을 보내고 <b>응답 헤더까지</b> 읽는다. 소켓은 닫지 않는다(스트림 유지).
	 *
	 * @param headers 추가 요청 헤더(Host·Connection은 여기서 붙인다)
	 */
	public static WireStream open(int port, String path, Map<String, String> headers) {
		StringBuilder head = new StringBuilder();
		head.append("GET ").append(path).append(" HTTP/1.1\r\n");
		head.append("Host: 127.0.0.1:").append(port).append("\r\n");
		head.append("Connection: keep-alive\r\n");
		for (Map.Entry<String, String> entry : headers.entrySet()) {
			head.append(entry.getKey()).append(": ").append(entry.getValue()).append("\r\n");
		}
		head.append("\r\n");

		Socket socket = new Socket();
		try {
			socket.connect(new InetSocketAddress("127.0.0.1", port), CONNECT_TIMEOUT_MS);
			OutputStream out = socket.getOutputStream();
			out.write(head.toString().getBytes(StandardCharsets.ISO_8859_1));
			out.flush();
			return readHead(socket);
		}
		catch (IOException ex) {
			closeQuietly(socket);
			throw new IllegalStateException("스트림 요청 실패: GET " + path, ex);
		}
	}

	public int status() {
		return this.status;
	}

	/** 헤더 원문 줄 전체(예: {@code "Content-Type: text/event-stream; charset=utf-8"}). 없으면 null. */
	public String line(String name) {
		String prefix = name.toLowerCase(Locale.ROOT) + ":";
		for (String headerLine : this.headerLines) {
			if (headerLine.toLowerCase(Locale.ROOT).startsWith(prefix)) {
				return headerLine;
			}
		}
		return null;
	}

	public List<String> headerLines() {
		return List.copyOf(this.headerLines);
	}

	/** 지금까지 받은 본문 원문(청크 해독 후 · LF 보존). 종결자 검사용이다. */
	public String rawBody() {
		return new String(this.body.toByteArray(), StandardCharsets.UTF_8);
	}

	/** 서버가 연결을 끝냈는가(마지막 읽기에서 EOF를 봤는가). */
	public boolean closedByServer() {
		return this.eof;
	}

	/**
	 * 조건을 만족하는 프레임이 데드라인 안에 도착하면 돌려주고, 아니면 <b>null</b>이다(던지지 않는다).
	 * 조건에 맞지 않는 프레임은 <b>소비</b>된다(다음 호출에서 다시 보이지 않는다).
	 */
	public Frame awaitFrame(Predicate<Frame> predicate, Duration timeout) {
		long deadline = System.nanoTime() + timeout.toNanos();
		while (true) {
			while (this.consumed < this.frames.size()) {
				Frame frame = this.frames.get(this.consumed++);
				if (predicate.test(frame)) {
					return frame;
				}
			}
			if (System.nanoTime() >= deadline || this.eof) {
				return null;
			}
			pumpOnce();
		}
	}

	/** 데드라인 동안 <b>새 프레임이 하나도 오지 않으면</b> true(봉인 단언용). */
	public boolean awaitSilence(Duration timeout) {
		int seen = this.frames.size();
		long deadline = System.nanoTime() + timeout.toNanos();
		while (System.nanoTime() < deadline) {
			if (this.frames.size() > seen) {
				return false;
			}
			if (this.eof) {
				break; // 연결이 끝났으면 더 올 것이 없다 — 침묵이다.
			}
			pumpOnce();
		}
		return this.frames.size() == seen;
	}

	@Override
	public void close() {
		closeQuietly(this.socket);
	}

	// --- 내부 -------------------------------------------------------------------------------------

	private static WireStream readHead(Socket socket) throws IOException {
		InputStream in = socket.getInputStream();
		ByteArrayOutputStream raw = new ByteArrayOutputStream();
		long deadline = System.nanoTime() + HEADER_TIMEOUT.toNanos();
		byte[] chunk = new byte[4096];
		int headerEnd = -1;
		while (headerEnd < 0) {
			if (System.nanoTime() >= deadline) {
				throw new IOException("응답 헤더가 오지 않았다(받은 바이트=" + raw.size() + ")");
			}
			socket.setSoTimeout(READ_SLICE_MS);
			int read;
			try {
				read = in.read(chunk);
			}
			catch (SocketTimeoutException ex) {
				continue;
			}
			if (read < 0) {
				throw new IOException("응답 헤더가 끝나기 전에 연결이 닫혔다");
			}
			raw.write(chunk, 0, read);
			headerEnd = indexOfHeaderEnd(raw.toByteArray());
		}

		byte[] bytes = raw.toByteArray();
		String headText = new String(bytes, 0, headerEnd, StandardCharsets.ISO_8859_1);
		String[] headLines = headText.split("\r\n");
		int status = Integer.parseInt(headLines[0].split(" ")[1]);
		List<String> headerLines = new ArrayList<>();
		boolean chunked = false;
		for (int i = 1; i < headLines.length; i++) {
			headerLines.add(headLines[i]);
			String lowered = headLines[i].toLowerCase(Locale.ROOT);
			if (lowered.startsWith("transfer-encoding:") && lowered.contains("chunked")) {
				chunked = true;
			}
		}

		WireStream stream = new WireStream(socket, in, status, List.copyOf(headerLines), chunked);
		int bodyStart = headerEnd + 4;
		if (bytes.length > bodyStart) {
			stream.pending.write(bytes, bodyStart, bytes.length - bodyStart);
			stream.decode();
		}
		return stream;
	}

	/** 최대 {@link #READ_SLICE_MS} 동안 한 번 읽고 해독한다(타임아웃은 정상이다). */
	private void pumpOnce() {
		try {
			this.socket.setSoTimeout(READ_SLICE_MS);
			byte[] chunk = new byte[8192];
			int read = this.in.read(chunk);
			if (read < 0) {
				this.eof = true;
				return;
			}
			this.pending.write(chunk, 0, read);
			decode();
		}
		catch (SocketTimeoutException ex) {
			// 아직 아무것도 오지 않았다 — 데드라인이 판정한다.
		}
		catch (IOException ex) {
			this.eof = true;
		}
	}

	/** 원시 버퍼에서 <b>완성된</b> 청크만 본문으로 옮기고, 새로 완성된 프레임을 분해한다. */
	private void decode() {
		byte[] raw = this.pending.toByteArray();
		int cursor = 0;
		if (this.chunked) {
			while (cursor < raw.length) {
				int lineEnd = indexOfCrLf(raw, cursor);
				if (lineEnd < 0) {
					break; // 크기 줄이 아직 다 오지 않았다.
				}
				String sizeLine = new String(raw, cursor, lineEnd - cursor, StandardCharsets.ISO_8859_1).trim();
				if (sizeLine.isEmpty()) {
					cursor = lineEnd + 2;
					continue;
				}
				int size = Integer.parseInt(sizeLine, 16);
				int dataStart = lineEnd + 2;
				if (size == 0) {
					cursor = dataStart;
					this.eof = true; // 마지막 청크 — 서버가 스트림을 끝냈다.
					break;
				}
				if (dataStart + size + 2 > raw.length) {
					break; // 청크 본문이 아직 다 오지 않았다.
				}
				this.body.write(raw, dataStart, size);
				cursor = dataStart + size + 2;
			}
		}
		else {
			this.body.write(raw, 0, raw.length);
			cursor = raw.length;
		}
		this.pending.reset();
		if (cursor < raw.length) {
			this.pending.write(raw, cursor, raw.length - cursor);
		}
		splitFrames();
	}

	private void splitFrames() {
		String text = rawBody();
		int cursor = this.frameCursor;
		int end;
		while ((end = text.indexOf("\n\n", cursor)) >= 0) {
			String block = text.substring(cursor, end);
			cursor = end + 2;
			String event = null;
			String data = null;
			for (String line : block.split("\n")) {
				if (event == null && line.startsWith("event: ")) {
					event = line.substring("event: ".length());
				}
				else if (data == null && line.startsWith("data: ")) {
					data = line.substring("data: ".length());
				}
			}
			this.frames.add(new Frame(event, data));
		}
		this.frameCursor = cursor;
	}

	private static int indexOfHeaderEnd(byte[] raw) {
		for (int i = 0; i + 3 < raw.length; i++) {
			if (raw[i] == '\r' && raw[i + 1] == '\n' && raw[i + 2] == '\r' && raw[i + 3] == '\n') {
				return i;
			}
		}
		return -1;
	}

	private static int indexOfCrLf(byte[] raw, int from) {
		for (int i = from; i + 1 < raw.length; i++) {
			if (raw[i] == '\r' && raw[i + 1] == '\n') {
				return i;
			}
		}
		return -1;
	}

	private static void closeQuietly(Socket socket) {
		try {
			socket.close();
		}
		catch (IOException ex) {
			// 이미 끊긴 소켓 — 테스트 정리 경로다.
		}
	}

}
