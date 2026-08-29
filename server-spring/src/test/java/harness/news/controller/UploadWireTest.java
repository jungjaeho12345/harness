package harness.news.controller;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import harness.news.service.SessionGuard;
import harness.news.service.UserService;
import harness.news.testsupport.TempNewsDb;
import harness.news.testsupport.Wire;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
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

	// --- 4. 미인증 401 ------------------------------------------------------------------------------

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
