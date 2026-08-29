package harness.news.controller;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import harness.news.service.SessionGuard;
import harness.news.service.UserService;
import harness.news.testsupport.TempNewsDb;
import harness.news.testsupport.Wire;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Arrays;
import java.util.Base64;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import java.util.stream.Stream;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;

/**
 * 파일 업로드({@code POST /api/upload})의 <b>와이어</b> 계약 — 정본은 Node
 * {@code server/index.js} 1011~1043행이고 본문은 <b>multipart가 아니라 base64 JSON</b>이다.
 *
 * <p>동결된 shape:
 * <pre>
 * 200 : {"ok":true,"path":"/uploads/&lt;32hex&gt;.&lt;ext&gt;","filename":"&lt;요청 원문&gt;"}
 * 400 : {"ok":false,"reason":"invalid-file"}   ← 타입·확장자 위반(라우트 직접 400 · ReasonStatus 무접촉)
 * 400 : {"ok":false,"reason":"too-large"}      ← 디코드 5MB 초과
 * 401 : {"ok":false,"reason":"unauthenticated"}
 * </pre>
 *
 * <h2>여기서만 관측되는 축</h2>
 * <ul>
 * <li><b>응답에 서버 파일시스템 경로가 없다</b> — 응답 {@code path}는 언제나 URL 상대경로이고 드라이브
 * 문자로 시작하는 절대경로·경로 구분자가 한 글자도 실리지 않는다(72 tick 규율과 동형).</li>
 * <li><b>저장 파일이 실제로 생긴다</b> — 계약은 {@code /uploads} GET으로 간접 확인하지만 여기서는
 * 데이터 디렉토리를 직접 들여다본다(발급명 = 응답 {@code path}의 마지막 조각).</li>
 * <li><b>거부는 디스크를 만지지 않는다</b> — 거부 5종 뒤에도 uploads 디렉토리의 파일 수가 그대로다.</li>
 * </ul>
 *
 * <p>업로드 파일은 이 클래스 전용 <b>임시</b> 데이터 디렉토리에만 떨어진다 — 리포 {@code uploads/}는
 * 무접촉이다.
 */
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
class UploadWireTest {

	private static final Path DATA_DIR = TempNewsDb.newDataDir("upload-wire");

	private static final String JSON_CONTENT_TYPE = "Content-Type: application/json; charset=utf-8";

	/** 계약 파일과 같은 1x1 투명 PNG의 raw base64(데이터 URI prefix 없음). */
	private static final String PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJ"
			+ "AAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

	/** {@code UPLOAD_EXT_ALLOWLIST} 14종 — 목록 자체가 계약이다. */
	private static final List<String> ALLOWED_EXTS = List.of("png", "jpg", "jpeg", "gif", "webp", "pdf",
			"doc", "docx", "xls", "xlsx", "txt", "hwp", "ppt", "pptx");

	/** Node {@code express.json({limit:'10mb'})}의 {@code bytes('10mb')} = 10 MiB. 경계값 자신은 통과다. */
	private static final int BODY_LIMIT_BYTES = 10 * 1024 * 1024;

	private static final Pattern PATH_VALUE = Pattern.compile("\"path\":\"(/uploads/[0-9a-f]{32}\\.[a-z]+)\"");

	/** 윈도우 드라이브 문자로 시작하는 절대경로(예: {@code D:\...}·{@code D:/...}). */
	private static final Pattern DRIVE_ABSOLUTE_PATH = Pattern.compile("[A-Za-z]:[\\\\/]");

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

	@BeforeEach
	void seedUser() {
		ensureUser("upload-r", "R");
	}

	// --- 1. 성공: 서버 발급명 · 요청 파일명 반향 · 실제 저장 ----------------------------------------

	@Test
	void aPngIsStoredUnderAServerIssuedNameAndTheRequestFilenameIsEchoed() throws IOException {
		Wire.Response response = upload("{\"filename\":\"contract-upload.png\",\"contentBase64\":\""
				+ PNG_BASE64 + "\"}");

		assertEquals(200, response.status());
		assertEquals(JSON_CONTENT_TYPE, response.line("content-type"));
		String path = pathOf(response.body());
		assertEquals("{\"ok\":true,\"path\":\"" + path + "\",\"filename\":\"contract-upload.png\"}",
				response.body(), "응답은 {ok,path,filename} 3키이고 이 순서다");
		assertTrue(path.endsWith(".png"));
		assertFalse(path.contains("contract-upload"), "저장 경로에 사용자 파일명이 섞이면 안 된다");

		Path stored = DATA_DIR.resolve("uploads").resolve(path.substring("/uploads/".length()));
		assertTrue(Files.isRegularFile(stored), "발급명으로 실제 파일이 생겨야 한다: " + path);
		assertEquals(70, Files.size(stored), "디코드된 바이트가 그대로 저장된다(1x1 PNG = 70바이트)");
	}

	@Test
	void theExtensionIsLowercasedButTheEchoedFilenameKeepsItsCase() {
		Wire.Response response = upload("{\"filename\":\"contract-upload.PNG\",\"contentBase64\":\""
				+ PNG_BASE64 + "\"}");

		assertEquals(200, response.status());
		assertTrue(pathOf(response.body()).endsWith(".png"), "저장 확장자는 소문자다");
		assertTrue(response.body().contains("\"filename\":\"contract-upload.PNG\""),
				"응답 filename은 원본 대소문자를 보존한다: " + response.body());
	}

	@Test
	void allFourteenAllowedExtensionsAre200AndKeepTheirExtension() {
		for (String ext : ALLOWED_EXTS) {
			Wire.Response response = upload("{\"filename\":\"contract-allow." + ext
					+ "\",\"contentBase64\":\"" + PNG_BASE64 + "\"}");

			assertEquals(200, response.status(), "." + ext + " → 200");
			String path = pathOf(response.body());
			assertTrue(path.endsWith("." + ext), "." + ext + " 확장자가 저장명에 보존된다: " + path);
		}
	}

	// --- 2. 거부: 400 고정 · 디스크 무기록 ----------------------------------------------------------

	@Test
	void rejectedRequestsAre400AndNeverTouchTheDisk() throws IOException {
		long before = storedFileCount();

		record Probe(String caseId, String body) {
		}
		List<Probe> probes = List.of(
				new Probe("ext-denied", "{\"filename\":\"malware.exe\",\"contentBase64\":\"" + PNG_BASE64 + "\"}"),
				new Probe("ext-missing", "{\"filename\":\"noextension\",\"contentBase64\":\"" + PNG_BASE64 + "\"}"),
				new Probe("content-missing", "{\"filename\":\"a.png\"}"),
				new Probe("content-not-string", "{\"filename\":\"a.png\",\"contentBase64\":12345}"),
				new Probe("filename-not-string", "{\"filename\":123,\"contentBase64\":\"" + PNG_BASE64 + "\"}"),
				new Probe("leading-dot", "{\"filename\":\".png\",\"contentBase64\":\"" + PNG_BASE64 + "\"}"),
				new Probe("trailing-space", "{\"filename\":\"a.png \",\"contentBase64\":\"" + PNG_BASE64 + "\"}"));

		for (Probe probe : probes) {
			Wire.Response response = upload(probe.body());

			assertEquals(400, response.status(), probe.caseId() + " → 400");
			assertEquals("{\"ok\":false,\"reason\":\"invalid-file\"}", response.body(), probe.caseId());
			assertEquals(JSON_CONTENT_TYPE, response.line("content-type"), probe.caseId());
		}

		assertEquals(before, storedFileCount(), "거부된 업로드가 파일을 만들었다");
	}

	@Test
	void sixMegabytesIsTooLargeAndNothingIsStored() throws IOException {
		long before = storedFileCount();
		byte[] oversized = new byte[6 * 1024 * 1024];
		java.util.Arrays.fill(oversized, (byte) 0x41);

		Wire.Response response = upload("{\"filename\":\"contract-big.pdf\",\"contentBase64\":\""
				+ Base64.getEncoder().encodeToString(oversized) + "\"}");

		assertEquals(400, response.status());
		assertEquals("{\"ok\":false,\"reason\":\"too-large\"}", response.body());
		assertEquals(before, storedFileCount(), "상한을 넘긴 업로드가 파일을 만들었다");
	}

	// --- 3. 응답에 서버 파일시스템이 새지 않는다 ----------------------------------------------------

	@Test
	void noResponseEverCarriesAServerFilesystemPath() {
		List<Wire.Response> responses = List.of(
				upload("{\"filename\":\"contract-upload.png\",\"contentBase64\":\"" + PNG_BASE64 + "\"}"),
				upload("{\"filename\":\"malware.exe\",\"contentBase64\":\"" + PNG_BASE64 + "\"}"),
				upload("{\"filename\":\"../../secret.png\",\"contentBase64\":\"" + PNG_BASE64 + "\"}"),
				upload("{\"filename\":\"/etc/passwd.png\",\"contentBase64\":\"" + PNG_BASE64 + "\"}"));

		for (Wire.Response response : responses) {
			String body = response.body();
			assertFalse(DRIVE_ABSOLUTE_PATH.matcher(body).find(), "절대경로가 응답에 실렸다: " + body);
			assertFalse(body.contains("\\"), "경로 구분자가 응답에 실렸다: " + body);
			assertFalse(body.contains("uploads/uploads"), "디렉토리 구조가 응답에 실렸다: " + body);
			assertFalse(body.contains(DATA_DIR.getFileName().toString()),
					"데이터 디렉토리 이름이 응답에 실렸다: " + body);
		}
	}

	/**
	 * 경로 조각을 담은 파일명도 <b>확장자 판정에만</b> 쓰인다 — 저장명은 서버가 발급하므로 탈출 조각이
	 * 저장 경로에 끼어들 여지가 구조적으로 없다.
	 */
	@Test
	void aTraversalFilenameStillStoresUnderTheIssuedNameOnly() throws IOException {
		Wire.Response response = upload("{\"filename\":\"../../secret.png\",\"contentBase64\":\""
				+ PNG_BASE64 + "\"}");

		assertEquals(200, response.status(), "경로 조각은 판정에만 쓰이고 거부 사유가 아니다");
		String path = pathOf(response.body());
		assertTrue(Files.isRegularFile(DATA_DIR.resolve("uploads")
				.resolve(path.substring("/uploads/".length()))), "발급명으로만 저장된다");
		assertFalse(Files.exists(DATA_DIR.getParent().resolve("secret.png")), "상위 디렉토리에 파일이 생겼다");
	}

	// --- 4. 본문 크기 상한 10 MiB ---------------------------------------------------------------------

	/**
	 * 경계 3점 — <b>미만</b> · <b>정확히 10 MiB</b> · <b>1바이트 초과</b>.
	 *
	 * <p>정본은 이 라우트에만 {@code express.json({limit:'10mb'})}를 건다({@code server/index.js} 1011행).
	 * {@code bytes('10mb')}는 <b>10 MiB = 10,485,760</b>이고 {@code raw-body}는 {@code length > limit}일 때만
	 * 거부하므로 <b>경계값 자신은 통과</b>다. 초과는 파서 오류가 되어 전역 에러 핸들러(1244행)로 흘러
	 * <b>500 {@code internal-error}</b>가 된다 — 413이 아니다(핸들러가 {@code err.status}를 보지 않는다).
	 *
	 * <p><b>2026-08-29 정본 실측</b>(리포 {@code node_modules} · 실제 {@code createApp} · 유효 세션 · 원시 소켓):
	 * <pre>
	 * Content-Length 정직  10,485,759 B → 400 {"ok":false,"reason":"too-large"}
	 * Content-Length 정직  10,485,760 B → 400 {"ok":false,"reason":"too-large"}   ← 경계값 통과
	 * Content-Length 정직  10,485,761 B → 500 {"ok":false,"reason":"internal-error"}
	 * Content-Length 정직  10,489,856 B → 500 동일
	 * </pre>
	 * 파서를 통과한 두 경우가 200이 아니라 {@code 400 too-large}인 것은 이 본문이 디코드되면 ~7.8 MB로
	 * 5 MB 상한을 넘기 때문이다 — 파서 통과 여부는 그 사유가 <b>나온다</b>는 사실로 관측한다.
	 * 어느 경우에도 업로드 디렉토리에 파일은 생기지 않았다(실측 {@code []}).
	 */
	@Test
	void theRequestBodyLimitIsTenMebibytesAndTheBoundaryItselfPasses() throws IOException {
		long before = storedFileCount();
		String atLimit = paddedBody(BODY_LIMIT_BYTES);
		assertEquals(BODY_LIMIT_BYTES, atLimit.length(), "픽스처가 정확히 10 MiB가 아니다");

		Wire.Response under = upload(paddedBody(BODY_LIMIT_BYTES - 1));
		assertEquals(400, under.status(), "상한 미만은 파서를 통과한다");
		assertEquals("{\"ok\":false,\"reason\":\"too-large\"}", under.body());

		Wire.Response exact = upload(atLimit);
		assertEquals(400, exact.status(), "정확히 10 MiB는 정본도 통과시킨다(초과일 때만 거부)");
		assertEquals("{\"ok\":false,\"reason\":\"too-large\"}", exact.body());

		Wire.Response over = upload(paddedBody(BODY_LIMIT_BYTES + 1));
		assertEquals(500, over.status(), "1바이트 초과는 정본에서 파서 오류 → 전역 500이다");
		assertEquals("{\"ok\":false,\"reason\":\"internal-error\"}", over.body());
		assertEquals(JSON_CONTENT_TYPE, over.line("content-type"));

		assertEquals(before, storedFileCount(), "상한을 넘긴 요청이 파일을 만들었다");
	}

	/**
	 * 상한은 <b>실제로 읽은 바이트</b>에 걸린다 — 클라이언트가 선언한 {@code Content-Length}를 믿지 않는다.
	 * 헤더가 <b>아예 없는</b> chunked 요청으로 관측한다(있는 헤더를 믿는지 여부는 이 축으로만 갈린다).
	 *
	 * <p>2026-08-29 정본 실측(같은 하네스, {@code Transfer-Encoding: chunked} · {@code Content-Length} 없음):
	 * <pre>
	 * 10,485,760 B → 400 {"ok":false,"reason":"too-large"}
	 * 10,485,761 B → 500 {"ok":false,"reason":"internal-error"}
	 * 31,457,280 B → 500 동일
	 * </pre>
	 * {@code raw-body}는 선언 길이가 없으면 수신 바이트를 누적해 {@code received > limit}에서 끊는다 —
	 * 같은 경계·같은 부등호다.
	 */
	@Test
	void theCapCountsBytesActuallyReadSoAChunkedBodyIsCappedTheSameWay() throws IOException {
		long before = storedFileCount();

		Wire.Response exact = uploadChunked(paddedBody(BODY_LIMIT_BYTES));
		assertEquals(400, exact.status(), "chunked·경계값도 파서를 통과한다");
		assertEquals("{\"ok\":false,\"reason\":\"too-large\"}", exact.body());

		Wire.Response over = uploadChunked(paddedBody(BODY_LIMIT_BYTES + 1));
		assertEquals(500, over.status(), "선언 길이가 없어도 실제 읽은 바이트로 끊어야 한다");
		assertEquals("{\"ok\":false,\"reason\":\"internal-error\"}", over.body());

		assertEquals(before, storedFileCount(), "상한을 넘긴 chunked 요청이 파일을 만들었다");
	}

	/**
	 * 상한 초과 본문은 <b>스트림을 끝까지 읽지 않고</b> 중단된다 — 이 게이트의 존재 이유가 그것이다
	 * (세션 하나로 수백 MB JSON을 밀어 힙을 태우는 것을 막는다).
	 *
	 * <p>{@code Content-Length}는 <b>64 MiB</b>로 선언하고 실제로는 {@code 상한+1}바이트만 흘린 뒤 멈춘다.
	 * 상한이 없으면({@code readAllBytes}) 서버는 남은 53.5 MiB를 기다리며 블록해 응답이 <b>오지 않고</b>
	 * 소켓 상한(15초)이 이 테스트를 red로 만든다(2026-08-29 실측: 상한 없는 구현에서 정확히 그 형태로 red).
	 * 상한이 있으면 초과를 감지한 그 자리에서 500이 돌아온다.
	 *
	 * <p><b>여기는 정본과 갈린다(의도된 divergence)</b>. 같은 날 실측: 정본은 이 요청에
	 * <b>응답을 아무것도 주지 않는다</b>(20초 관측 TIMEOUT · 선언 CL 64 MiB에 상한+1만 보낸 경우도,
	 * 선언 200 MiB에 1 KiB만 보낸 경우도 같다). {@code body-parser}가 상한 초과를 감지한 뒤
	 * {@code stream.resume()} + {@code onFinished(req, ...)}로 <b>요청이 끝나기를 기다렸다가</b> 오류를
	 * 넘기기 때문이다({@code body-parser/lib/read.js}) — 요청이 끝나지 않으므로 응답도 없다.
	 * 정본은 그동안 수신 바이트를 버리기만 해 힙이 늘지 않지만, 여기서는 조기 종료가 같은 보호를
	 * 더 단순하게 준다. 이 축을 관측하는 계약 케이스는 없다(계약 클라이언트는 언제나 정직한 길이를 보낸다).
	 *
	 * <p>응답 본문은 {@code Content-Length}만큼만 읽고 끊는다 — EOF까지 기다리면 컨테이너가 남은 요청
	 * 본문을 흘려버리려(swallow) 블록하는 시간을 그대로 기다리게 된다.
	 */
	@Test
	void anOversizedBodyIsAnsweredWithoutReadingTheDeclaredLengthToTheEnd() throws IOException {
		long before = storedFileCount();
		int declaredLength = 64 * 1024 * 1024;

		Wire.Response response = postTruncated(declaredLength, BODY_LIMIT_BYTES + 1);

		assertEquals(500, response.status(), "상한 초과가 즉시 중단되지 않았다(응답이 왔다면 상태만 다르다)");
		assertEquals("{\"ok\":false,\"reason\":\"internal-error\"}", response.body());
		assertEquals(before, storedFileCount(), "중단된 요청이 파일을 만들었다");
	}

	// --- 5. 미인증 401 ------------------------------------------------------------------------------

	@Test
	void withoutASessionItIs401() {
		Wire.Response response = Wire.json(this.port, "POST", "/api/upload", Map.of(),
				"{\"filename\":\"a.png\",\"contentBase64\":\"" + PNG_BASE64 + "\"}");

		assertEquals(401, response.status());
		assertEquals("{\"ok\":false,\"reason\":\"unauthenticated\"}", response.body());
	}

	// --- 도구 --------------------------------------------------------------------------------------

	private Wire.Response upload(String body) {
		return Wire.json(this.port, "POST", "/api/upload", Map.of("x-session-id", token()), body);
	}

	/** 전체 길이가 정확히 {@code totalBytes}(전부 ASCII)인 유효한 업로드 본문 — 남는 자리는 base64 패딩이다. */
	private static String paddedBody(int totalBytes) {
		String head = "{\"filename\":\"contract-limit.pdf\",\"contentBase64\":\"";
		String tail = "\"}";
		return head + "A".repeat(totalBytes - head.length() - tail.length()) + tail;
	}

	/** 요청 헤더 원문 — 프레이밍 헤더(길이/전송 인코딩)만 호출자가 정한다. */
	private String requestHead(String framingHeader) {
		return "POST /api/upload HTTP/1.1\r\n"
				+ "Host: 127.0.0.1:" + this.port + "\r\n"
				+ "Connection: close\r\n"
				+ "Content-Type: application/json\r\n"
				+ "x-session-id: " + token() + "\r\n"
				+ framingHeader + "\r\n\r\n";
	}

	/** {@code Content-Length} 없이 chunked로 보낸다 — 상한이 헤더가 아니라 실제 바이트에 걸리는지 본다. */
	private Wire.Response uploadChunked(String body) {
		byte[] payload = body.getBytes(StandardCharsets.US_ASCII);
		ByteArrayOutputStream framed = new ByteArrayOutputStream();
		int step = 64 * 1024;
		for (int offset = 0; offset < payload.length; offset += step) {
			int size = Math.min(step, payload.length - offset);
			framed.writeBytes((Integer.toHexString(size) + "\r\n").getBytes(StandardCharsets.ISO_8859_1));
			framed.write(payload, offset, size);
			framed.writeBytes("\r\n".getBytes(StandardCharsets.ISO_8859_1));
		}
		framed.writeBytes("0\r\n\r\n".getBytes(StandardCharsets.ISO_8859_1));
		return Wire.framed(this.port, requestHead("Transfer-Encoding: chunked"), framed.toByteArray(), false);
	}

	/**
	 * {@code Content-Length}를 크게 선언하고 <b>일부만</b> 보낸 뒤 멈춘다({@link Wire#json}은 언제나 실제
	 * 길이를 선언하므로 이 축은 {@link Wire#framed}로만 만들 수 있다). 응답은 헤더의
	 * {@code Content-Length}만큼만 읽는다(EOF를 기다리면 조기 응답 여부를 관측할 수 없다).
	 */
	private Wire.Response postTruncated(int declaredLength, int sendBytes) {
		byte[] partial = new byte[sendBytes];
		Arrays.fill(partial, (byte) 'A');
		return Wire.framed(this.port, requestHead("Content-Length: " + declaredLength), partial, true);
	}

	private String token() {
		return this.sessions.createSession("upload-r");
	}

	private static String pathOf(String body) {
		Matcher matcher = PATH_VALUE.matcher(body);
		assertTrue(matcher.find(), "응답 path가 /uploads/<32hex>.<ext> 형태가 아니다: " + body);
		return matcher.group(1);
	}

	private static long storedFileCount() throws IOException {
		Path uploads = DATA_DIR.resolve("uploads");
		if (!Files.isDirectory(uploads)) {
			return 0L;
		}
		try (Stream<Path> files = Files.list(uploads)) {
			return files.filter(Files::isRegularFile).count();
		}
	}

	private void ensureUser(String userId, String role) {
		Map<String, Object> dto = new LinkedHashMap<>();
		dto.put("userId", userId);
		dto.put("name", userId);
		dto.put("role", role);
		dto.put("password", "upload-wire-pw");
		try {
			this.users.create(dto);
		}
		catch (RuntimeException ignored) {
			// 이미 있다 — 픽스처는 멱등이다.
		}
	}

}
