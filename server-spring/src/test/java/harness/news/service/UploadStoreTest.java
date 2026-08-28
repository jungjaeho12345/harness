package harness.news.service;

import static org.junit.jupiter.api.Assertions.assertArrayEquals;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import harness.news.config.AppProperties;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import java.util.regex.Pattern;
import java.util.stream.Stream;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/**
 * 업로드 저장 어댑터의 동작 계약 — Node {@code server/index.js} 1011~1043행의 파일 쓰기 세 줄
 * ({@code mkdirSync(recursive)} · {@code randomBytes(16).toString('hex')} · {@code writeFileSync(flag:'wx')})과
 * 1:1이다.
 *
 * <p>이 파일은 {@code Adr008DisciplineTest} 4군의 <b>예외 ②</b>({@code UploadStore.java})가 그은 구멍을
 * 안쪽에서 메우는 그물이다. 정적 스캔은 "무엇을 부르는가"만 보고 <b>"어디에 쓰는가"는 보지 못한다</b> —
 * 예외 파일 안에서 경로 합성이 틀리면 게이트는 green이다. 그래서 여기서 잠그는 것 여섯 가지:
 * <ol>
 * <li><b>lazy mkdir</b> — 생성자는 파일시스템을 만지지 않는다(부팅만으로 디렉토리가 생기지 않는다).</li>
 * <li><b>경로 도출의 단일 출처</b> — uploads 루트는 {@code AppProperties.dataDirPath().resolve("uploads")}
 * 한 지점이고 <b>프로세스 cwd가 아니다</b>(cwd 상대 경로를 쓰면 리포를 오염시킨다 — 그 변이를 잡는다).</li>
 * <li><b>미덮어쓰기</b> — {@code CREATE_NEW}. 충돌하면 기존 파일이 <b>그대로 남고</b> 저장이 실패한다
 * (재시도하지 않는다 — 자동 재시도는 ADR-008 (6) 위반이자 Node와의 divergence다).</li>
 * <li><b>서버 발급 이름</b> — 32자 소문자 hex가 호출마다 다르다. 호출자 문자열은 경로에 끼어들지 못한다.</li>
 * <li><b>디렉토리 탈출 거부</b> — 확장자 인자가 좁은 형태를 벗어나면 <b>파일시스템 무접촉</b>으로 거부한다
 * (호출자가 검증한다는 가정에 기대지 않는다). {@code null}도 NPE가 아니라 거부다(decisions (24)).</li>
 * <li><b>절대경로 비유출</b> — 반환값·예외 메시지에 서버 파일시스템 경로가 한 조각도 실리지 않는다
 * (72 tick 규율과 동형 — 그 값은 응답이나 {@code /api/logs/digest}로 나간다).</li>
 * </ol>
 *
 * <p>리포 {@code uploads/}는 무접촉이다 — 이 테스트는 {@code @TempDir}만 쓴다.
 */
class UploadStoreTest {

	/** 응답에 그대로 실리는 상대 경로의 형태(계약: {@code /uploads/<32hex>.<ext>}). */
	private static final Pattern STORED_PATH = Pattern.compile("^/uploads/[0-9a-f]{32}\\.[a-z0-9]+$");

	private static final String NAME_A = "0123456789abcdef0123456789abcdef";

	private static final String NAME_B = "fedcba9876543210fedcba9876543210";

	/** uploads 루트 이름 — 프로덕션 상수와 같은 값이지만 <b>테스트가 독립적으로</b> 적는다. */
	private static final String UPLOADS = "uploads";

	/** 이름 발급 seam — 충돌을 강제하려면 발급을 고정할 수 있어야 한다. */
	private static UploadStore.NameSource fixed(String... names) {
		List<String> queue = new ArrayList<>(List.of(names));
		return () -> queue.isEmpty() ? names[names.length - 1] : queue.remove(0);
	}

	private static AppProperties propertiesFor(Path dataDir) {
		return new AppProperties(dataDir.toString(), null, null);
	}

	/** 부팅만으로는 아무 디렉토리도 생기지 않는다 — 생성은 <b>쓰기 직전</b>이다(Node lazy mkdir 동형). */
	@Test
	void theUploadsRootIsNotCreatedUntilTheFirstWrite(@TempDir Path dataDir) throws IOException {
		UploadStore store = new UploadStore(propertiesFor(dataDir), fixed(NAME_A));

		assertFalse(Files.exists(dataDir.resolve(UPLOADS)),
				"생성자가 uploads 루트를 만들었다 — Node는 첫 업로드 때 lazy 생성한다");

		store.save("hello".getBytes(StandardCharsets.UTF_8), "png");

		assertTrue(Files.isDirectory(dataDir.resolve(UPLOADS)), "쓰기 직전 mkdir이 일어나지 않았다");
	}

	/** 반환값은 <b>응답에 그대로 실리는 상대 경로</b>이고 확장자가 보존된다. */
	@Test
	void theStoredPathIsTheServerIssuedHexNameWithThePreservedExtension(@TempDir Path dataDir) throws IOException {
		UploadStore store = new UploadStore(propertiesFor(dataDir), fixed(NAME_A));

		String stored = store.save(new byte[] { 1, 2, 3 }, "jpeg");

		assertEquals("/uploads/" + NAME_A + ".jpeg", stored);
		assertTrue(STORED_PATH.matcher(stored).matches(), "저장 경로가 계약 형태를 벗어났다: " + stored);
		assertTrue(Files.isRegularFile(dataDir.resolve(UPLOADS).resolve(NAME_A + ".jpeg")),
				"파일이 uploads 루트 아래 발급명으로 놓이지 않았다");
	}

	/** 반환값에도 예외에도 서버 파일시스템 절대경로가 실리지 않는다. */
	@Test
	void theReturnedPathCarriesNoServerAbsolutePath(@TempDir Path dataDir) throws IOException {
		UploadStore store = new UploadStore(propertiesFor(dataDir), fixed(NAME_A));

		String stored = store.save(new byte[] { 9 }, "png");

		assertFalse(stored.contains(dataDir.toString()), "반환 경로에 데이터 디렉토리 절대경로가 실렸다: " + stored);
		assertFalse(stored.contains("\\"), "반환 경로에 OS 구분자가 실렸다(웹 경로는 언제나 /): " + stored);
	}

	/** 쓴 바이트는 입력과 정확히 같다 — 0바이트 입력과 0..255 전 바이트를 함께 본다. */
	@Test
	void theBytesOnDiskAreExactlyTheInputBytes(@TempDir Path dataDir) throws IOException {
		byte[] all = new byte[256];
		for (int i = 0; i < all.length; i++) {
			all[i] = (byte) i;
		}
		UploadStore store = new UploadStore(propertiesFor(dataDir), fixed(NAME_A, NAME_B));

		store.save(all, "bin");
		store.save(new byte[0], "png");

		assertArrayEquals(all, Files.readAllBytes(dataDir.resolve(UPLOADS).resolve(NAME_A + ".bin")));
		assertArrayEquals(new byte[0], Files.readAllBytes(dataDir.resolve(UPLOADS).resolve(NAME_B + ".png")),
				"0바이트 입력이 0바이트 파일이 되지 않았다(Node는 빈 Buffer도 그대로 쓴다)");
	}

	/**
	 * <b>기존 파일을 절대 덮지 않는다</b>({@code CREATE_NEW}). 이름 발급을 고정해 충돌을 강제한다 —
	 * 실제 32-hex 충돌은 사실상 없지만 <b>플래그가 바뀌면 조용히 덮어쓰기가 된다</b>.
	 */
	@Test
	void anExistingFileIsNeverOverwritten(@TempDir Path dataDir) throws IOException {
		UploadStore store = new UploadStore(propertiesFor(dataDir), fixed(NAME_A, NAME_A));
		byte[] first = "original".getBytes(StandardCharsets.UTF_8);
		store.save(first, "png");
		Path target = dataDir.resolve(UPLOADS).resolve(NAME_A + ".png");

		IOException failure = assertThrows(IOException.class,
				() -> store.save("overwrite".getBytes(StandardCharsets.UTF_8), "png"),
				"이름이 충돌했는데 저장이 성공했다 — CREATE_NEW가 아니다(Node는 flag:'wx'로 던진다)");

		assertArrayEquals(first, Files.readAllBytes(target), "기존 파일의 내용이 바뀌었다");
		assertEquals(1, countFiles(dataDir.resolve(UPLOADS)), "충돌 뒤 파일 개수가 1이 아니다(재시도한 흔적)");
		assertFalse(failure.getMessage() != null && failure.getMessage().contains(dataDir.toString()),
				"실패 메시지에 서버 절대경로가 실렸다: " + failure.getMessage());
		assertFalse(failure.getMessage() != null && failure.getMessage().contains(NAME_A),
				"실패 메시지에 저장 파일명이 실렸다: " + failure.getMessage());
	}

	/**
	 * 발급명은 호출마다 다르다 — <b>프로덕션 생성자</b>(기본 seam)로 100회 확인한다.
	 * 이 테스트가 유일하게 실제 {@code SecureRandom} 배선을 지난다.
	 */
	@Test
	void everyCallGetsAFreshThirtyTwoHexName(@TempDir Path dataDir) throws IOException {
		UploadStore store = new UploadStore(propertiesFor(dataDir));
		Set<String> seen = new HashSet<>();

		for (int i = 0; i < 100; i++) {
			String stored = store.save(new byte[] { (byte) i }, "png");
			assertTrue(STORED_PATH.matcher(stored).matches(), "발급 경로가 계약 형태를 벗어났다: " + stored);
			assertTrue(seen.add(stored), "발급명이 반복됐다(무작위원이 죽었다): " + stored);
		}

		assertEquals(100, countFiles(dataDir.resolve(UPLOADS)));
	}

	/**
	 * 확장자 인자가 좁은 형태({@code ^[a-z0-9]{1,10}$})를 벗어나면 <b>파일시스템 무접촉</b>으로 거부한다.
	 * 호출자(step3 서비스)가 화이트리스트를 먼저 본다는 가정에 기대지 않는 심화 방어다 —
	 * {@code null}도 NPE가 아니라 거부여야 한다(decisions (24): 400이 500이 되는 반복 함정).
	 */
	@Test
	void anExtensionThatCouldEscapeTheDirectoryIsRejectedWithoutTouchingTheFilesystem(@TempDir Path dataDir) {
		List<String> hostile = new ArrayList<>();
		hostile.add(null);
		hostile.addAll(List.of("", " ", "..", ".", "../png", "..\\png", "/etc/passwd", "C:/windows/win",
				"a/b", "a\\b", "a\0b", "png ", " png", "pn.g", "PNG", "Png", "abcdefghijk", "png\n", "p:g",
				"%2e%2e%2fpng", "~", "png/../../news"));
		UploadStore store = new UploadStore(propertiesFor(dataDir), fixed(NAME_A));

		for (String extension : hostile) {
			assertThrows(IllegalArgumentException.class, () -> store.save(new byte[] { 7 }, extension),
					"확장자 인자를 그대로 받아들였다(경로 탈출 표면): " + extension);
		}

		assertFalse(Files.exists(dataDir.resolve(UPLOADS)),
				"거부 경로가 파일시스템을 만졌다 — 거부는 디렉토리조차 만들지 않는다");
		assertFalse(Files.exists(dataDir.resolve("news.db")), "거부 경로가 데이터 디렉토리에 무언가를 만들었다");
	}

	/**
	 * <b>발급된 이름도 자기가 다시 검증한다</b> — seam은 주입 가능하므로 그 자체가 경로 합성 표면이다.
	 * 32자 소문자 hex가 아니면 파일을 만들지 않는다.
	 */
	@Test
	void anIssuedNameThatIsNotThirtyTwoLowercaseHexIsRejected(@TempDir Path dataDir) {
		for (String bad : List.of("../evil", "0123456789ABCDEF0123456789ABCDEF", "short", NAME_A + "0", "")) {
			UploadStore store = new UploadStore(propertiesFor(dataDir), fixed(bad));

			assertThrows(IllegalStateException.class, () -> store.save(new byte[] { 7 }, "png"),
					"발급명 재검증이 없다 — 이름 seam이 곧 경로 합성 표면이다: " + bad);
		}

		assertFalse(Files.exists(dataDir.resolve(UPLOADS)), "거부 경로가 파일시스템을 만졌다");
	}

	/**
	 * <b>uploads 루트는 {@code app.data-dir} 파생이고 프로세스 cwd가 아니다.</b>
	 *
	 * <p>이 단언이 이 테스트 클래스의 마지막 방어선이다: 도출을 {@code Path.of("uploads")}(cwd 상대)로 바꾸는
	 * 변이는 다른 모든 테스트도 red로 만들지만, <b>왜</b> red인지를 말해 주는 것은 여기뿐이다 —
	 * 그 변이가 통과하면 서버가 프로세스 cwd(=리포)에 업로드 파일을 떨군다.
	 */
	@Test
	void theUploadsRootComesFromTheDataDirNotTheProcessWorkingDirectory(@TempDir Path dataDir) throws IOException {
		Path cwdRelative = Path.of(UPLOADS).toAbsolutePath();
		UploadStore store = new UploadStore(propertiesFor(dataDir), fixed(NAME_A));

		store.save(new byte[] { 4, 2 }, "png");

		Path expected = dataDir.resolve(UPLOADS).resolve(NAME_A + ".png");
		assertTrue(expected.isAbsolute(), "기준 경로가 절대경로가 아니다 — 이 단언은 무의미해진다");
		assertTrue(Files.isRegularFile(expected), "데이터 디렉토리 아래 uploads/에 파일이 없다: " + expected);
		assertFalse(Files.exists(cwdRelative),
				"프로세스 작업 디렉토리에 uploads/가 생겼다 — cwd 상대 경로로 도출하고 있다: " + cwdRelative);
	}

	private static long countFiles(Path dir) throws IOException {
		try (Stream<Path> files = Files.list(dir)) {
			return files.filter(Files::isRegularFile).count();
		}
	}

}
