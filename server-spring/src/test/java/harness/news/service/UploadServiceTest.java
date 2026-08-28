package harness.news.service;

import static org.junit.jupiter.api.Assertions.assertArrayEquals;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import harness.news.config.AppProperties;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Base64;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.regex.Pattern;
import java.util.stream.Stream;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/**
 * {@code POST /api/upload}의 도메인 계약 — Node {@code server/index.js} 1011~1043행의 게이트 순서와 1:1이다.
 *
 * <h2>이 라우트는 multipart가 아니라 base64 JSON이다</h2>
 * 본문은 {@code {filename, contentBase64}} 둘뿐이고 서버는 <b>내용을 검사하지 않는다</b> — 확장자와
 * 디코드된 바이트 수만 본다. 그래서 게이트는 정확히 셋이고 <b>순서가 계약</b>이다:
 * <ol>
 * <li>타입: {@code typeof filename !== 'string' || typeof contentBase64 !== 'string'} → {@code invalid-file}</li>
 * <li>확장자: {@code path.extname(...).slice(1).toLowerCase()}가 비었거나 화이트리스트 밖 → {@code invalid-file}</li>
 * <li>크기: <b>디코드된</b> 바이트가 5,242,880 <b>초과</b> → {@code too-large}</li>
 * </ol>
 * 셋을 전부 통과한 뒤에야 파일이 만들어진다 — <b>거부 경로는 디렉토리조차 만들지 않는다</b>.
 *
 * <h2>계약이 보지 못하는 축(여기가 유일 방어선 · decisions (22)③⑤)</h2>
 * <ul>
 * <li><b>5MB 정확 경계</b> — 계약은 6MB 초과 한 건만 본다(계약 파일 296행이 "경계값 미동결"이라고 명시).</li>
 * <li><b>거부 경로의 디스크 무기록</b> — 계약은 응답만 본다.</li>
 * <li><b>관대한 base64</b> — {@code "!!!"}은 400이 아니라 <b>0바이트 파일 + 200</b>이다.
 * {@code Base64.getDecoder()}로 바꾸면 같은 요청이 500이 된다(step1 {@code NodeBase64}가 살아 있다는 통합 증거).</li>
 * <li><b>게이트 순서</b> — 확장자 위반 + 초과 본문이 {@code too-large}가 아니라 {@code invalid-file}이다.</li>
 * <li><b>저장 실패는 사유가 아니라 예외</b> — Node는 {@code flag:'wx'} 충돌에서 500이 된다.</li>
 * </ul>
 *
 * <p>리포 {@code uploads/}는 무접촉이다 — {@code @TempDir}만 쓴다.
 */
class UploadServiceTest {

	/** 계약 파일 37행의 {@code UPLOAD_PATH_RE}와 같은 형태(테스트가 독립적으로 적는다). */
	private static final Pattern UPLOAD_PATH = Pattern.compile("^/uploads/[0-9a-f]{32}\\.[a-z]+$");

	/** Node {@code UPLOAD_MAX_BYTES} — 5MB, <b>디코드된 바이트 기준</b>. */
	private static final int MAX_BYTES = 5 * 1024 * 1024;

	private static final String UPLOADS = "uploads";

	/** 1x1 투명 PNG의 raw base64 — 계약 파일 191~193행과 같은 값이다. */
	private static final String PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJ"
			+ "AAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

	private static final String NAME_A = "0123456789abcdef0123456789abcdef";

	private static AppProperties propertiesFor(Path dataDir) {
		return new AppProperties(dataDir.toString(), null, null);
	}

	private static UploadService serviceFor(Path dataDir) {
		return new UploadService(new UploadStore(propertiesFor(dataDir)));
	}

	/** 파일시스템을 한 번도 만지지 않았는가 — 거부 경로의 단언이다. */
	private static void assertUntouched(Path dataDir, String what) throws IOException {
		assertFalse(Files.exists(dataDir.resolve(UPLOADS)), "거부가 uploads 디렉토리를 만들었다: " + what);
		try (Stream<Path> entries = Files.list(dataDir)) {
			assertEquals(List.of(), entries.toList(), "거부가 데이터 디렉토리에 무언가를 남겼다: " + what);
		}
	}

	private static long countFiles(Path dir) throws IOException {
		if (!Files.isDirectory(dir)) {
			return 0;
		}
		try (Stream<Path> entries = Files.list(dir)) {
			return entries.count();
		}
	}

	private static Path storedFile(Path dataDir, Map<String, Object> result) {
		String path = (String) result.get("path");
		return dataDir.resolve(UPLOADS).resolve(path.substring("/uploads/".length()));
	}

	/** 성공 응답은 {@code {ok, path, filename}} 세 키이고 <b>순서까지</b> Node와 같다. */
	@Test
	void aSuccessfulUploadAnswersOkPathFilenameInThatOrder(@TempDir Path dataDir) throws IOException {
		UploadService service = serviceFor(dataDir);

		Map<String, Object> result = service.upload("contract-upload.png", PNG_BASE64);

		assertEquals(List.of("ok", "path", "filename"), new ArrayList<>(result.keySet()));
		assertEquals(Boolean.TRUE, result.get("ok"));
		assertEquals("contract-upload.png", result.get("filename"));
		String path = (String) result.get("path");
		assertTrue(UPLOAD_PATH.matcher(path).matches(), "저장 경로가 계약 형태를 벗어났다: " + path);
		assertTrue(path.endsWith(".png"));
		assertArrayEquals(Base64.getDecoder().decode(PNG_BASE64), Files.readAllBytes(storedFile(dataDir, result)),
				"디스크의 바이트가 요청 본문의 디코드 결과와 다르다");
	}

	/**
	 * 저장명은 <b>서버가 발급</b>하고 요청 {@code filename}은 확장자 판정에만 쓰인다 — 응답 {@code filename}은
	 * 원문 대소문자를 그대로 되돌리고 {@code path}의 확장자는 소문자다.
	 */
	@Test
	void theStoredNameIsServerIssuedWhileTheEchoedFilenameKeepsItsOriginalCase(@TempDir Path dataDir)
			throws IOException {
		UploadService service = serviceFor(dataDir);

		Map<String, Object> result = service.upload("contract-upload.PNG", PNG_BASE64);

		assertEquals("contract-upload.PNG", result.get("filename"), "응답 filename이 정규화됐다");
		String path = (String) result.get("path");
		assertTrue(UPLOAD_PATH.matcher(path).matches(), path);
		assertTrue(path.endsWith(".png"), "확장자가 소문자로 정규화되지 않았다: " + path);
		assertFalse(path.contains("contract-upload"), "응답 path에 사용자 파일명이 섞였다: " + path);
	}

	/** 발급명은 호출마다 다르다 — 같은 파일명을 반복 업로드해도 서로 덮지 않는다. */
	@Test
	void repeatedUploadsOfTheSameFilenameNeverCollide(@TempDir Path dataDir) throws IOException {
		UploadService service = serviceFor(dataDir);
		Set<String> paths = new HashSet<>();

		for (int i = 0; i < 20; i++) {
			Map<String, Object> result = service.upload("same-name.png", PNG_BASE64);
			assertTrue(paths.add((String) result.get("path")), "저장 경로가 반복됐다");
		}

		assertEquals(20, countFiles(dataDir.resolve(UPLOADS)));
	}

	/**
	 * 타입 게이트 — Node {@code typeof x === 'string'} 동형이다. 숫자 {@code 12345}·{@code null}·불리언·
	 * 배열·객체는 <b>전부 문자열이 아니다</b>(강제변환하지 않는다).
	 *
	 * <p>{@code null} 입력이 400이고 500이 아닌지가 여기서 함께 잠긴다(decisions (24)).
	 */
	@Test
	void anythingButAStringOnEitherFieldIsInvalidFileAndNeverAnError(@TempDir Path dataDir) throws IOException {
		UploadService service = serviceFor(dataDir);
		List<Object[]> hostile = new ArrayList<>();
		hostile.add(new Object[] { null, null });
		hostile.add(new Object[] { null, PNG_BASE64 });
		hostile.add(new Object[] { "a.png", null });
		hostile.add(new Object[] { "a.png", 12345 });
		hostile.add(new Object[] { 12345, PNG_BASE64 });
		hostile.add(new Object[] { "a.png", Boolean.TRUE });
		hostile.add(new Object[] { "a.png", List.of(PNG_BASE64) });
		hostile.add(new Object[] { "a.png", Map.of("data", PNG_BASE64) });
		hostile.add(new Object[] { List.of("a.png"), PNG_BASE64 });
		hostile.add(new Object[] { new StringBuilder("a.png"), PNG_BASE64 });

		for (Object[] body : hostile) {
			assertRejected(service.upload(body[0], body[1]), "invalid-file", Arrays.toString(body));
		}

		assertUntouched(dataDir, "타입 게이트");
	}

	/** 확장자 게이트 — 없거나 화이트리스트 밖이면 {@code invalid-file}이고 디스크는 무접촉이다. */
	@Test
	void aMissingOrDisallowedExtensionIsInvalidFile(@TempDir Path dataDir) throws IOException {
		UploadService service = serviceFor(dataDir);
		List<String> denied = List.of("malware.exe", "noextension", ".png", "a.", "a.png.", "a.tar.gz",
				"a.png ", "a.png\t", "a.png?x=1", "C:.png", "", ".", "..", "dir.d/name", "a.PNG.exe", "ａ.ｐｎｇ");

		for (String filename : denied) {
			assertRejected(service.upload(filename, PNG_BASE64), "invalid-file", filename);
		}

		assertUntouched(dataDir, "확장자 게이트");
	}

	/** 화이트리스트 14종은 <b>내용이 전부 같은 png 바이트여도</b> 200이다(서버는 내용을 보지 않는다). */
	@Test
	void allFourteenAllowedExtensionsSucceedWithTheSameBytes(@TempDir Path dataDir) throws IOException {
		UploadService service = serviceFor(dataDir);
		List<String> accepted = new ArrayList<>();

		for (String ext : List.of("png", "jpg", "jpeg", "gif", "webp", "pdf", "doc", "docx", "xls", "xlsx",
				"txt", "hwp", "ppt", "pptx")) {
			Map<String, Object> result = service.upload("contract-allow." + ext, PNG_BASE64);

			assertEquals(Boolean.TRUE, result.get("ok"), "." + ext + " → 거부됐다");
			String path = (String) result.get("path");
			assertTrue(UPLOAD_PATH.matcher(path).matches(), path);
			assertTrue(path.endsWith("." + ext), "." + ext + " 확장자가 저장명에 보존되지 않았다: " + path);
			accepted.add(ext);
		}

		assertEquals(14, accepted.size());
		assertEquals(14, countFiles(dataDir.resolve(UPLOADS)));
	}

	/**
	 * <b>5MB 경계는 엄격 부등호다</b> — 정확히 5,242,880바이트는 성공하고 한 바이트 더는 {@code too-large}다.
	 * 계약은 6MB 한 건만 보므로(계약 296행 "경계값 미동결") 이 단언이 유일 방어선이다.
	 */
	@Test
	void exactlyFiveMegabytesSucceedsAndOneByteMoreIsTooLarge(@TempDir Path dataDir) throws IOException {
		UploadService service = serviceFor(dataDir);
		String atLimit = Base64.getEncoder().encodeToString(new byte[MAX_BYTES]);
		String overLimit = Base64.getEncoder().encodeToString(new byte[MAX_BYTES + 1]);

		Map<String, Object> ok = service.upload("boundary.pdf", atLimit);
		Map<String, Object> denied = service.upload("boundary.pdf", overLimit);

		assertEquals(Boolean.TRUE, ok.get("ok"), "정확히 5,242,880바이트가 거부됐다(부등호가 >=다)");
		assertEquals(MAX_BYTES, Files.size(storedFile(dataDir, ok)));
		assertRejected(denied, "too-large", "5,242,881바이트");
		assertEquals(1, countFiles(dataDir.resolve(UPLOADS)), "too-large 거부가 파일을 남겼다");
	}

	/**
	 * <b>상한은 원문 길이가 아니라 디코드된 바이트에 걸린다.</b> base64는 약 4/3로 팽창하므로 5MB를 넘는
	 * 문자열도 디코드하면 5MB 이하일 수 있다 — 그 요청은 200이다(원문 길이로 추정하면 갈린다).
	 */
	@Test
	void theLimitIsMeasuredOnDecodedBytesNotOnTheRequestString(@TempDir Path dataDir) throws IOException {
		UploadService service = serviceFor(dataDir);
		int payload = 4 * 1024 * 1024;
		String encoded = Base64.getEncoder().encodeToString(new byte[payload]);

		assertTrue(encoded.length() > MAX_BYTES, "이 테스트는 원문이 상한보다 길어야 의미가 있다");
		Map<String, Object> result = service.upload("expanded.pdf", encoded);

		assertEquals(Boolean.TRUE, result.get("ok"), "디코드 전 길이로 상한을 판정하고 있다");
		assertEquals(payload, Files.size(storedFile(dataDir, result)));
	}

	/**
	 * <b>게이트 순서</b> — 확장자 위반 + 6MB 본문은 {@code too-large}가 아니라 {@code invalid-file}이다.
	 * 크기 검사를 앞으로 옮기면 같은 요청의 사유가 바뀐다(계약 밖 축).
	 */
	@Test
	void theExtensionGateRunsBeforeTheSizeGate(@TempDir Path dataDir) throws IOException {
		UploadService service = serviceFor(dataDir);
		String oversized = Base64.getEncoder().encodeToString(new byte[6 * 1024 * 1024]);

		assertRejected(service.upload("malware.exe", oversized), "invalid-file", "malware.exe + 6MB");
		assertRejected(service.upload("noextension", oversized), "invalid-file", "noextension + 6MB");
		assertRejected(service.upload(12345, oversized), "invalid-file", "비문자열 filename + 6MB");
		assertRejected(service.upload("contract-big.pdf", oversized), "too-large", "허용 확장자 + 6MB");

		assertUntouched(dataDir, "게이트 순서");
	}

	/**
	 * <b>망가진 base64는 거부가 아니다.</b> Node는 알파벳 밖 문자를 건너뛰고 남은 것을 디코드하므로
	 * {@code "!!!"}은 <b>0바이트 파일 + 200</b>이 된다. {@code Base64.getDecoder()}를 쓰면 같은 요청이
	 * 예외로 500이 된다 — step1 {@code NodeBase64}가 이 경로에 실제로 배선돼 있다는 통합 증거다.
	 */
	@Test
	void garbageBase64IsNotRejectedButDecodedTheNodeWay(@TempDir Path dataDir) throws IOException {
		UploadService service = serviceFor(dataDir);

		Map<String, Object> empty = service.upload("garbage.png", "!!!");
		Map<String, Object> skipped = service.upload("spaced.png", "QU FB");
		Map<String, Object> urlAlias = service.upload("alias.png", "-_");
		Map<String, Object> stopped = service.upload("padded.png", "QQ==QQ==");

		assertEquals(Boolean.TRUE, empty.get("ok"), "'!!!'이 거부됐다 — Node는 200 + 0바이트 파일이다");
		assertEquals(0, Files.size(storedFile(dataDir, empty)), "0바이트 파일이 만들어지지 않았다");
		assertArrayEquals(new byte[] { 0x41, 0x41, 0x41 }, Files.readAllBytes(storedFile(dataDir, skipped)),
				"'QU FB' 디코드 결과가 Node와 다르다(Node 실측: 414141)");
		assertArrayEquals(new byte[] { (byte) 0xfb }, Files.readAllBytes(storedFile(dataDir, urlAlias)),
				"base64url 별칭이 Node처럼 읽히지 않았다");
		assertArrayEquals(new byte[] { 0x41 }, Files.readAllBytes(storedFile(dataDir, stopped)),
				"'=' 종료 의미론이 Node와 다르다");
		assertEquals(4, countFiles(dataDir.resolve(UPLOADS)));
	}

	/** 빈 문자열 본문도 200이다(0바이트 파일). 확장자만 맞으면 내용은 묻지 않는다. */
	@Test
	void anEmptyContentStringStillProducesAFile(@TempDir Path dataDir) throws IOException {
		UploadService service = serviceFor(dataDir);

		Map<String, Object> result = service.upload("empty.txt", "");

		assertEquals(Boolean.TRUE, result.get("ok"));
		assertEquals(0, Files.size(storedFile(dataDir, result)));
	}

	/**
	 * 응답 어디에도 <b>서버 파일시스템 절대경로·OS 구분자·데이터 디렉토리 조각</b>이 없다
	 * (72 tick 규율과 동형 — 그 값은 응답과 {@code /api/logs/digest}로 나간다).
	 */
	@Test
	void noValueInTheResponseLeaksAServerAbsolutePath(@TempDir Path dataDir) throws IOException {
		UploadService service = serviceFor(dataDir);

		Map<String, Object> result = service.upload("/uploads/../secret.png", PNG_BASE64);

		String rendered = String.valueOf(result);
		assertFalse(rendered.contains(dataDir.toString()), "응답에 데이터 디렉토리 절대경로가 실렸다: " + rendered);
		assertFalse(rendered.contains(dataDir.getRoot().toString()), "응답에 드라이브 루트가 실렸다: " + rendered);
		String path = (String) result.get("path");
		assertTrue(UPLOAD_PATH.matcher(path).matches(), path);
		assertFalse(path.contains("secret"), "응답 path에 사용자 파일명 조각이 섞였다: " + path);
		assertFalse(path.contains(".."), "응답 path에 traversal 조각이 남았다: " + path);
		assertEquals("/uploads/../secret.png", result.get("filename"), "응답 filename은 요청 원문 그대로다");
	}

	/**
	 * <b>저장 실패를 사유 토큰으로 접지 않는다.</b> 이름이 충돌하면 예외가 그대로 올라가 전역 핸들러가
	 * 500을 만든다(Node {@code flag:'wx'} 동형). 400으로 접거나 다시 발급해 재시도하면 divergence이자
	 * ADR-008 (6) 위반이다.
	 */
	@Test
	void aStoreFailurePropagatesInsteadOfBecomingAReason(@TempDir Path dataDir) throws IOException {
		UploadStore store = new UploadStore(propertiesFor(dataDir), () -> NAME_A);
		UploadService service = new UploadService(store);
		service.upload("first.png", PNG_BASE64);

		IOException failure = assertThrows(IOException.class, () -> service.upload("second.png", PNG_BASE64),
				"이름 충돌이 사유 토큰으로 접혔다 — Node는 500이 된다");

		assertEquals(1, countFiles(dataDir.resolve(UPLOADS)), "충돌 뒤 파일이 늘었다(재시도한 흔적)");
		assertFalse(String.valueOf(failure.getMessage()).contains(dataDir.toString()),
				"실패 메시지에 서버 절대경로가 실렸다: " + failure.getMessage());
	}

	/** 거부 응답은 {@code {ok:false, reason}} 두 키뿐이다(사유 토큰은 전역 표에 없어 폴백 400으로 나간다). */
	private static void assertRejected(Map<String, Object> result, String reason, String what) {
		assertEquals(List.of("ok", "reason"), new ArrayList<>(result.keySet()), "거부 응답 키가 다르다: " + what);
		assertEquals(Boolean.FALSE, result.get("ok"), what);
		assertEquals(reason, result.get("reason"), what);
	}

}
