package harness.news.testsupport;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;

/**
 * 원시 HTTP 클라이언트(테스트 전용) — <b>와이어 바이트</b>를 그대로 관측한다.
 *
 * <p>MockMvc를 쓰지 않는 이유(step0부터의 규율)와 같은 이유로 {@code java.net.http.HttpClient}도 쓰지 않는다:
 * 그 클라이언트는 헤더 이름을 소문자로 정규화하고 여러 값을 자기 규칙으로 합친다. 이 phase의 합격 기준은
 * 계약 리포트가 비교하는 <b>헤더 문자열 원문</b>(예: {@code Content-Type: application/json; charset=utf-8}의
 * 세미콜론 뒤 공백 1바이트)이라, 관측 도구가 문자열을 만지면 판정이 무의미해진다.
 *
 * <p>요청은 {@code Connection: close}로 보내고 응답은 EOF까지 읽는다(chunked도 해독한다).
 * 헤더는 원문 그대로(ISO-8859-1로 바이트 보존) 보관하고 본문만 UTF-8로 해석한다 —
 * 바이너리 응답은 {@link #raw(int, String, String)}({@link RawResponse})으로 바이트를 그대로 받는다.
 */
public final class Wire {

	private Wire() {
	}

	/**
	 * 본문 바이트를 그대로 들고 있는 원시 응답 — <b>바이너리 응답</b>(정적 서빙 등) 관측용이다.
	 *
	 * <p>{@link Response}는 본문을 UTF-8 문자열로 해석하므로 PNG 같은 바이트열은 그 과정에서 손상된다
	 * (부정 바이트열이 U+FFFD로 치환된다) — "놓은 파일과 응답 바이트가 같다"를 단언하려면 바이트가 필요하다.
	 */
	public record RawResponse(int status, List<String> headerLines, byte[] body) {

		/** 헤더 원문 줄 전체(예: {@code "Content-Type: image/png"}). 없으면 null. */
		public String line(String name) {
			return firstLine(this.headerLines, name);
		}

		/** 이름이 일치하는 헤더 줄 전부(대소문자 무시). */
		public List<String> lines(String name) {
			return matchingLines(this.headerLines, name);
		}

		/** 본문을 ISO-8859-1로 읽은 문자열 — 바이트 손실 없이 "특정 바이트열이 들어 있나"를 볼 때 쓴다. */
		public String bodyAsLatin1() {
			return new String(this.body, StandardCharsets.ISO_8859_1);
		}
	}

	/** 원시 응답 — {@code headerLines}는 상태줄 다음 줄들의 <b>원문</b>이다(이름 대소문자·공백 포함). */
	public record Response(int status, List<String> headerLines, String body) {

		/** 헤더 원문 줄 전체(예: {@code "Content-Type: application/json; charset=utf-8"}). 없으면 null. */
		public String line(String name) {
			List<String> found = lines(name);
			return found.isEmpty() ? null : found.get(0);
		}

		/** 이름이 일치하는 헤더 줄 전부(대소문자 무시). Set-Cookie처럼 반복되는 헤더용. */
		public List<String> lines(String name) {
			return matchingLines(this.headerLines, name);
		}

		/** 헤더 값(콜론 뒤 공백 1개를 뺀 나머지 원문). 없으면 null. */
		public String value(String name) {
			String headerLine = line(name);
			return headerLine == null ? null : headerLine.substring(headerLine.indexOf(':') + 1).stripLeading();
		}

		/** 이름이 일치하는 헤더 값 전부. */
		public List<String> values(String name) {
			List<String> out = new ArrayList<>();
			for (String headerLine : lines(name)) {
				out.add(headerLine.substring(headerLine.indexOf(':') + 1).stripLeading());
			}
			return out;
		}
	}

	private static String firstLine(List<String> headerLines, String name) {
		List<String> found = matchingLines(headerLines, name);
		return found.isEmpty() ? null : found.get(0);
	}

	private static List<String> matchingLines(List<String> headerLines, String name) {
		String prefix = name.toLowerCase(Locale.ROOT) + ":";
		List<String> out = new ArrayList<>();
		for (String headerLine : headerLines) {
			if (headerLine.toLowerCase(Locale.ROOT).startsWith(prefix)) {
				out.add(headerLine);
			}
		}
		return out;
	}

	/** 헤더·본문 없는 요청. */
	public static Response send(int port, String method, String path) {
		return send(port, method, path, Map.of(), null);
	}

	/** 헤더·본문 없는 요청 — 본문을 <b>바이트 그대로</b> 돌려준다(바이너리 응답 관측용). */
	public static RawResponse raw(int port, String method, String path) {
		return raw(port, method, path, Map.of(), null);
	}

	/** JSON 본문 요청({@code Content-Type: application/json}). */
	public static Response json(int port, String method, String path, Map<String, String> headers, String body) {
		Map<String, String> merged = new LinkedHashMap<>(headers);
		merged.put("Content-Type", "application/json");
		return send(port, method, path, merged, body);
	}

	/**
	 * 요청을 보내고 응답 바이트를 그대로 읽는다.
	 *
	 * @param headers 추가 요청 헤더(Host·Connection·Content-Length는 여기서 붙인다)
	 * @param body 본문(UTF-8 인코딩). null이면 본문 없음
	 */
	public static Response send(int port, String method, String path, Map<String, String> headers, String body) {
		RawResponse response = raw(port, method, path, headers, body);
		return new Response(response.status(), response.headerLines(),
				new String(response.body(), StandardCharsets.UTF_8));
	}

	/**
	 * {@link #send(int, String, String, Map, String)}와 같은 왕복이되 본문을 디코딩하지 않는다.
	 *
	 * @param headers 추가 요청 헤더(Host·Connection·Content-Length는 여기서 붙인다)
	 * @param body 본문(UTF-8 인코딩). null이면 본문 없음
	 */
	public static RawResponse raw(int port, String method, String path, Map<String, String> headers, String body) {
		byte[] payload = (body == null) ? new byte[0] : body.getBytes(StandardCharsets.UTF_8);
		StringBuilder head = new StringBuilder();
		head.append(method).append(' ').append(path).append(" HTTP/1.1\r\n");
		head.append("Host: 127.0.0.1:").append(port).append("\r\n");
		head.append("Connection: close\r\n");
		for (Map.Entry<String, String> entry : headers.entrySet()) {
			head.append(entry.getKey()).append(": ").append(entry.getValue()).append("\r\n");
		}
		if (body != null) {
			head.append("Content-Length: ").append(payload.length).append("\r\n");
		}
		head.append("\r\n");

		try (Socket socket = new Socket()) {
			socket.connect(new InetSocketAddress("127.0.0.1", port), 5000);
			socket.setSoTimeout(15000);
			OutputStream out = socket.getOutputStream();
			out.write(head.toString().getBytes(StandardCharsets.ISO_8859_1));
			if (payload.length > 0) {
				out.write(payload);
			}
			out.flush();
			return parse(readAll(socket.getInputStream()));
		}
		catch (IOException ex) {
			throw new IllegalStateException("원시 HTTP 왕복 실패: " + method + " " + path, ex);
		}
	}

	/**
	 * 요청 <b>프레이밍을 호출자가 직접 정하는</b> 왕복 — 위 메서드들은 언제나 실제 길이의
	 * {@code Content-Length}를 붙이므로 "상한 판정이 헤더를 믿는가, 실제로 읽은 바이트를 세는가"를
	 * 관측할 수 없다. 그 축(chunked · 길이 스푸핑) 전용이다.
	 *
	 * @param requestHead 상태줄 + 헤더 원문. 끝의 빈 줄(CRLFCRLF)까지 호출자가 넣는다
	 * @param bodyBytes 헤더 뒤로 그대로 흘릴 바이트(chunk 프레이밍이 있다면 그것까지 포함)
	 * @param boundedRead {@code true}면 응답 헤더의 {@code Content-Length}만큼만 읽고 끊는다. 요청 본문을
	 *        선언한 만큼 보내지 않은 경우 EOF까지 기다리면 컨테이너가 남은 본문을 흘려버리려 기다리는
	 *        시간을 그대로 기다리게 된다 — 그러면 "응답이 곧바로 왔는가"를 관측할 수 없다
	 */
	public static Response framed(int port, String requestHead, byte[] bodyBytes, boolean boundedRead) {
		try (Socket socket = new Socket()) {
			socket.connect(new InetSocketAddress("127.0.0.1", port), 5000);
			socket.setSoTimeout(15000);
			OutputStream out = socket.getOutputStream();
			out.write(requestHead.getBytes(StandardCharsets.ISO_8859_1));
			out.write(bodyBytes);
			out.flush();
			InputStream in = socket.getInputStream();
			RawResponse response = parse(boundedRead ? readDeclaredBody(in) : readAll(in));
			return new Response(response.status(), response.headerLines(),
					new String(response.body(), StandardCharsets.UTF_8));
		}
		catch (IOException ex) {
			throw new IllegalStateException("원시 HTTP 왕복 실패(framed)", ex);
		}
	}

	/** 헤더 + 응답의 {@code Content-Length}만큼만 읽는다(EOF를 기다리지 않는다). */
	private static byte[] readDeclaredBody(InputStream in) throws IOException {
		ByteArrayOutputStream buffer = new ByteArrayOutputStream();
		byte[] chunk = new byte[4096];
		int headerEnd = -1;
		while (headerEnd < 0) {
			int read = in.read(chunk);
			if (read < 0) {
				throw new IOException("응답 헤더가 끝나기 전에 연결이 닫혔다");
			}
			buffer.write(chunk, 0, read);
			headerEnd = indexOfHeaderEnd(buffer.toByteArray());
		}
		int declared = 0;
		for (String line : new String(buffer.toByteArray(), 0, headerEnd, StandardCharsets.ISO_8859_1).split("\r\n")) {
			if (line.toLowerCase(Locale.ROOT).startsWith("content-length:")) {
				declared = Integer.parseInt(line.substring(line.indexOf(':') + 1).trim());
			}
		}
		while (buffer.size() - (headerEnd + 4) < declared) {
			int read = in.read(chunk);
			if (read < 0) {
				break;
			}
			buffer.write(chunk, 0, read);
		}
		return buffer.toByteArray();
	}

	private static byte[] readAll(InputStream in) throws IOException {
		ByteArrayOutputStream buffer = new ByteArrayOutputStream();
		byte[] chunk = new byte[8192];
		int read;
		while ((read = in.read(chunk)) != -1) {
			buffer.write(chunk, 0, read);
		}
		return buffer.toByteArray();
	}

	private static RawResponse parse(byte[] raw) {
		int split = indexOfHeaderEnd(raw);
		if (split < 0) {
			throw new IllegalStateException("응답에 헤더 종료(CRLFCRLF)가 없다: " + new String(raw, StandardCharsets.ISO_8859_1));
		}
		String headText = new String(raw, 0, split, StandardCharsets.ISO_8859_1);
		byte[] bodyBytes = new byte[raw.length - (split + 4)];
		System.arraycopy(raw, split + 4, bodyBytes, 0, bodyBytes.length);

		String[] headLines = headText.split("\r\n");
		int status = Integer.parseInt(headLines[0].split(" ")[1]);
		List<String> headerLines = new ArrayList<>();
		boolean chunked = false;
		for (int i = 1; i < headLines.length; i++) {
			headerLines.add(headLines[i]);
			if (headLines[i].toLowerCase(Locale.ROOT).startsWith("transfer-encoding:")
					&& headLines[i].toLowerCase(Locale.ROOT).contains("chunked")) {
				chunked = true;
			}
		}
		byte[] payload = chunked ? dechunk(bodyBytes) : bodyBytes;
		return new RawResponse(status, List.copyOf(headerLines), payload);
	}

	private static int indexOfHeaderEnd(byte[] raw) {
		for (int i = 0; i + 3 < raw.length; i++) {
			if (raw[i] == '\r' && raw[i + 1] == '\n' && raw[i + 2] == '\r' && raw[i + 3] == '\n') {
				return i;
			}
		}
		return -1;
	}

	/** 최소 chunked 해독 — 확장(extension)·트레일러는 이 서버가 쓰지 않으므로 다루지 않는다. */
	private static byte[] dechunk(byte[] body) {
		ByteArrayOutputStream out = new ByteArrayOutputStream();
		int cursor = 0;
		while (cursor < body.length) {
			int lineEnd = cursor;
			while (lineEnd + 1 < body.length && !(body[lineEnd] == '\r' && body[lineEnd + 1] == '\n')) {
				lineEnd++;
			}
			String sizeLine = new String(body, cursor, lineEnd - cursor, StandardCharsets.ISO_8859_1).trim();
			int size = sizeLine.isEmpty() ? 0 : Integer.parseInt(sizeLine, 16);
			cursor = lineEnd + 2;
			if (size == 0) {
				break;
			}
			out.write(body, cursor, size);
			cursor += size + 2;
		}
		return out.toByteArray();
	}
}
