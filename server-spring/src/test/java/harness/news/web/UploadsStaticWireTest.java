package harness.news.web;

import static org.junit.jupiter.api.Assertions.assertArrayEquals;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import harness.news.testsupport.TempNewsDb;
import harness.news.testsupport.Wire;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Base64;
import java.util.List;
import java.util.regex.Pattern;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;

/**
 * 업로드 파일 정적 서빙({@code GET /uploads/<32hex>.<ext>})의 <b>와이어</b> 계약.
 *
 * <p>정본은 Node {@code server/index.js} 560~562행 {@code app.use('/uploads', express.static(uploadDir))}이고
 * 그 마운트는 <b>세션 게이트보다 앞</b>이다. 계약 리포트 실측({@code x-uploads-static} 관측 1건):
 * {@code status 200} · {@code ok true} · {@code bodyKeys []} ·
 * <b>{@code content-type: image/png}(charset 파라미터 없음)</b>.
 *
 * <h2>이 테스트가 잠그는 것</h2>
 * <ol>
 * <li><b>미인증 200</b> — 비밀은 32-hex 파일명뿐인 <b>capability URL 모델</b>이다. 여기에 세션을 요구하면
 * 발행 HTML에 재임베드된 이미지가 외부에서 깨진다(계약 파일이 CRITICAL로 명시한 축). 계약도 이 축을 보지만
 * 그쪽은 헤더 1개만 보고, 여기서는 <b>헤더 줄 원문</b>을 정확 비교한다.</li>
 * <li><b>{@code Content-Type} 바이트</b> — 리포트 diff는 이 문자열을 정확 비교하므로 세미콜론·charset이
 * 한 글자라도 붙으면 계약이 red다.</li>
 * <li><b>경로 탈출 거부</b> — {@code ../}·인코딩 변형·백슬래시·이중 인코딩. 데이터 디렉토리 바로 위에
 * 실제 {@code news.db}가 있는 배치에서 관측한다(탈출이 되면 DB 바이트가 그대로 나간다).</li>
 * <li><b>형제 파일 비노출</b> — 리소스 위치를 uploads의 <b>부모</b>로 잘못 도출하면 데이터 디렉토리가
 * 통째로 열린다(2026-08-28 변이 실측: 이 테스트가 red). 끝 슬래시 누락은 프레임워크
 * ({@code ResourceHandlerUtils})가 WARN과 함께 스스로 보정하므로 그 변이만으로는 재현되지 않는다.</li>
 * <li><b>디렉토리 목록 0</b> · <b>절대경로 비유출</b> — 어떤 응답에도 서버 파일시스템 경로가 실리지 않는다.</li>
 * </ol>
 *
 * <p><b>부팅 시점에 uploads 루트는 없다</b>({@link harness.news.service.UploadStore}가 lazy mkdir이므로 이것이
 * 정상 상태다) — 이 테스트는 컨텍스트 기동 뒤에 파일을 놓고, 그래도 서빙되는지를 본다.
 *
 * <p><b>리포 {@code uploads/}·{@code news.db}는 무접촉</b>이다: 데이터 디렉토리는 OS 임시 디렉토리이고
 * 종료 훅으로 지워진다.
 *
 * <h2>Node와의 문서화된 divergence(계약 밖 · 맞추지 않는다 — index.json open_questions (4))</h2>
 * Node(express.static)는 {@code Accept-Ranges: bytes} · {@code Cache-Control: public, max-age=0} ·
 * {@code Last-Modified} · 약한 {@code ETag}를 함께 보낸다(2026-08-28 원시 소켓 프로브). 같은 날 이 서버
 * 실측은 {@code Last-Modified} · {@code Accept-Ranges: bytes} · {@code Content-Length}는 같고
 * <b>{@code Cache-Control}·{@code ETag}가 없다</b>. 계약 리포트의 {@code ALLOWED_HEADERS}는
 * {@code content-type}만 싣기 때문에 나머지는 관측되지 않는다 — 캐시 헤더를 흉내 내려다 조건부 요청 304
 * 경로가 갈리면 표면만 넓어지므로 맞추지 않고 기록만 한다. 확장자별 미디어타입도 마찬가지다:
 * {@code .pdf}는 양쪽 {@code application/pdf}, {@code .txt}는 Node {@code text/plain; charset=UTF-8} 대
 * 이 서버 {@code text/plain}(charset 없음)이다. 계약이 보는 {@code .png}만 바이트 동일이 요구된다.
 */
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
class UploadsStaticWireTest {

	private static final Path DATA_DIR = TempNewsDb.newDataDir("uploads-static");

	/** 서버가 발급하는 형태의 저장명(32자 소문자 hex). */
	private static final String HEX = "0123456789abcdef0123456789abcdef";

	/** 1x1 PNG — 첫 바이트가 {@code 0x89}라 UTF-8 문자열로 읽으면 손상된다(그래서 바이트로 관측한다). */
	private static final byte[] PNG = Base64.getDecoder().decode(
			"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==");

	private static final String SIBLING_SECRET = "SIBLING-SECRET-MUST-NOT-BE-SERVED";

	/** uploads 아래 하위 디렉토리 — 디렉토리 목록 노출 프로브가 요청하는 자리다. */
	private static final String NESTED_DIR = "nested-dir";

	private static final String NESTED_FILE = "nested-name-must-not-be-listed.txt";

	/** SQLite 파일의 매직 헤더 — 응답 본문에 이 바이트열이 있으면 DB가 새어 나간 것이다. */
	private static final String SQLITE_MAGIC = "SQLite format 3";

	/** 윈도우 드라이브 문자로 시작하는 절대경로(예: {@code D:\...}·{@code D:/...}). */
	private static final Pattern DRIVE_ABSOLUTE_PATH = Pattern.compile("[A-Za-z]:[\\\\/]");

	@DynamicPropertySource
	static void dataDir(DynamicPropertyRegistry registry) {
		registry.add("app.data-dir", () -> DATA_DIR.toAbsolutePath().toString());
	}

	@Value("${local.server.port}")
	private int port;

	/**
	 * 파일 배치 — <b>컨텍스트 기동 뒤</b>다. uploads 루트는 부팅 시점에 없었고(lazy mkdir) 그 뒤 생겼다.
	 * 데이터 디렉토리에는 {@link TempNewsDb}가 시드한 실제 {@code news.db}가 이미 있다.
	 */
	@BeforeAll
	static void placeFiles() throws IOException {
		Path uploads = DATA_DIR.resolve("uploads");
		Files.createDirectories(uploads);
		Files.write(uploads.resolve(HEX + ".png"), PNG);
		Files.write(uploads.resolve(HEX + ".pdf"), "%PDF-1.4 fixture".getBytes(StandardCharsets.UTF_8));
		Files.write(uploads.resolve(HEX + ".txt"), "fixture-text".getBytes(StandardCharsets.UTF_8));
		Files.write(DATA_DIR.resolve("sibling-secret.txt"), SIBLING_SECRET.getBytes(StandardCharsets.UTF_8));
		// 하위 디렉토리 — 디렉토리 요청이 목록을 내는지 보는 프로브다(빈 경로 '/uploads/'는 프레임워크
		// 상류에서 무시되므로, 목록 노출은 이런 라우팅되는 경로에서만 표현될 수 있다).
		Path nested = uploads.resolve(NESTED_DIR);
		Files.createDirectories(nested);
		Files.write(nested.resolve(NESTED_FILE), "nested-fixture".getBytes(StandardCharsets.UTF_8));
	}

	@Test
	void theUploadedFileIsServedWithoutASession() {
		Wire.RawResponse response = Wire.raw(this.port, "GET", "/uploads/" + HEX + ".png");

		assertEquals(200, response.status(),
				"미인증 정적 서빙이 200이 아니다 — capability URL 모델이 깨지면 발행 HTML의 재임베드 이미지가 외부에서 깨진다");
		assertArrayEquals(PNG, response.body(), "서빙된 바이트가 놓은 파일과 다르다");
	}

	@Test
	void theContentTypeIsExactlyImagePngWithoutCharset() {
		Wire.RawResponse response = Wire.raw(this.port, "GET", "/uploads/" + HEX + ".png");

		assertEquals("Content-Type: image/png", response.line("content-type"),
				"계약 리포트 실측은 charset 없는 image/png다 — 리포트 diff는 이 문자열을 정확 비교한다");
	}

	@Test
	void aMissingFileIsNotServed() {
		Wire.RawResponse response = Wire.raw(this.port, "GET", "/uploads/ffffffffffffffffffffffffffffffff.png");

		assertNotEquals(200, response.status(),
				"없는 파일이 200이다 — 헤더: " + response.headerLines());
	}

	/**
	 * 경로 탈출 전량 거부. 데이터 디렉토리 바로 위 계층에 실제 {@code news.db}가 있으므로, 탈출이 성립하면
	 * 상태코드가 아니라 <b>본문 바이트</b>로 드러난다 — 그래서 SQLite 매직 헤더까지 함께 본다.
	 */
	@Test
	void pathTraversalIsRejectedAndTheDatabaseIsNeverServed() {
		List<String> escapes = List.of(
				"/uploads/../news.db",
				"/uploads/..%2fnews.db",
				"/uploads/%2e%2e/news.db",
				"/uploads/%2e%2e%2fnews.db",
				"/uploads/....//news.db",
				"/uploads/..%5cnews.db",
				"/uploads/%252e%252e/news.db",
				"/uploads/..%c0%afnews.db");

		for (String escape : escapes) {
			Wire.RawResponse response = Wire.raw(this.port, "GET", escape);
			assertNotEquals(200, response.status(), "경로 탈출이 200을 받았다: " + escape);
			assertFalse(response.bodyAsLatin1().contains(SQLITE_MAGIC),
					"응답 본문에 news.db 바이트가 실렸다: " + escape);
		}
	}

	/** 백슬래시 원문 변형 — 요청줄에 그대로 실어 보낸다(브라우저는 {@code /}로 정규화하지만 공격자는 안 한다). */
	@Test
	void backslashTraversalIsRejected() {
		Wire.RawResponse response = Wire.raw(this.port, "GET", "/uploads/..\\news.db");

		assertNotEquals(200, response.status(), "백슬래시 경로 탈출이 200을 받았다");
		assertFalse(response.bodyAsLatin1().contains(SQLITE_MAGIC), "응답 본문에 news.db 바이트가 실렸다");
	}

	/**
	 * uploads 루트의 <b>형제</b> 파일은 서빙되지 않는다 — 리소스 위치가 uploads가 아니라 그 부모
	 * ({@code file:<dataDir>/})로 도출되면 {@code news.db}를 포함한 데이터 디렉토리가 통째로 열린다.
	 * 2026-08-28 실측: 그 변이에서 이 테스트가 red다.
	 */
	@Test
	void theSiblingOfTheUploadsRootIsNotServed() {
		Wire.RawResponse response = Wire.raw(this.port, "GET", "/uploads/sibling-secret.txt");

		assertNotEquals(200, response.status(), "uploads 형제 파일이 서빙됐다 — 위치 문자열의 끝 슬래시를 확인하라");
		assertFalse(response.bodyAsLatin1().contains(SIBLING_SECRET), "형제 파일 내용이 응답에 실렸다");
	}

	/**
	 * 디렉토리 목록 0.
	 *
	 * <p>2026-08-28 변이 실측: 목록 노출은 이 층에서 <b>성립 자체가 안 된다</b>. {@code /uploads/}는 빈 하위
	 * 경로라 {@code ResourceHandlerUtils.shouldIgnoreInputPath}가 리졸버 앞에서 떨구고(404), 디렉토리
	 * 리소스는 {@code isReadable()=false}라 역시 404이며, 목록을 합성해 돌려주는 리졸버를 심어도
	 * {@code lastModified()}가 실패해 500이 된다. 그래도 <b>빈 경로 하나만 보는 그물은 공허</b>하므로
	 * 라우팅되는 하위 디렉토리 경로까지 함께 보고, 상태코드뿐 아니라 <b>이름이 새어 나왔는지</b>를 단언한다.
	 */
	@Test
	void theDirectoryListingIsNotExposed() {
		List<String> directories = List.of("/uploads/", "/uploads", "/uploads/" + NESTED_DIR + "/",
				"/uploads/" + NESTED_DIR);

		for (String directory : directories) {
			Wire.RawResponse response = Wire.raw(this.port, "GET", directory);
			assertNotEquals(200, response.status(), "디렉토리 요청이 200을 받았다: " + directory);
			String body = response.bodyAsLatin1();
			assertFalse(body.contains(HEX), "디렉토리 목록에 저장 파일명이 노출됐다: " + directory);
			assertFalse(body.contains(NESTED_FILE), "디렉토리 목록에 하위 파일명이 노출됐다: " + directory);
			assertFalse(body.contains(NESTED_DIR), "디렉토리 목록에 하위 디렉토리명이 노출됐다: " + directory);
		}
	}

	/** 응답 어디에도 서버 파일시스템 절대경로가 실리지 않는다(72 tick 규율과 동형 · ADR-007). */
	@Test
	void noResponseCarriesAServerAbsolutePath() {
		List<String> probes = List.of(
				"/uploads/" + HEX + ".png",
				"/uploads/ffffffffffffffffffffffffffffffff.png",
				"/uploads/../news.db",
				"/uploads/sibling-secret.txt",
				"/uploads/");

		for (String probe : probes) {
			Wire.RawResponse response = Wire.raw(this.port, "GET", probe);
			String wire = String.join("\n", response.headerLines()) + "\n" + response.bodyAsLatin1();
			assertFalse(wire.contains(DATA_DIR.toAbsolutePath().toString()),
					"응답에 데이터 디렉토리 절대경로가 실렸다: " + probe);
			assertFalse(DRIVE_ABSOLUTE_PATH.matcher(wire).find(),
					"응답에 드라이브 문자로 시작하는 절대경로가 실렸다: " + probe + " / " + wire);
		}
	}

	/**
	 * 다른 확장자의 미디어타입은 <b>기록만</b> 한다 — 계약이 관측하는 것은 png 하나뿐이고, charset 파라미터
	 * 유무는 Node와의 문서화된 divergence(클래스 javadoc)다. 타입 자체가 뒤집히는 것(예: 전부
	 * {@code application/octet-stream})은 여기서 잡힌다.
	 */
	@Test
	void otherExtensionsKeepTheirMediaTypeFamily() {
		Wire.RawResponse pdf = Wire.raw(this.port, "GET", "/uploads/" + HEX + ".pdf");
		Wire.RawResponse txt = Wire.raw(this.port, "GET", "/uploads/" + HEX + ".txt");

		assertEquals(200, pdf.status());
		assertEquals(200, txt.status());
		assertEquals("Content-Type: application/pdf", pdf.line("content-type"));
		assertTrue(txt.line("content-type").startsWith("Content-Type: text/plain"),
				"text/plain 계열이 아니다: " + txt.line("content-type"));
	}
}
