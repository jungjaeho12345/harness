package harness.news.config;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.io.IOException;
import java.lang.management.ManagementFactory;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import java.util.stream.Stream;
import org.junit.jupiter.api.Test;

/**
 * <b>리포 데이터 무접촉</b> — 테스트 JVM은 리포의 {@code news.db}·{@code uploads/}를 열지도 쓰지도 않는다.
 *
 * <h2>왜 이 파일이 필요한가</h2>
 * {@code phases/73-spring-media-upload}는 <b>파일을 쓰는 라우트</b>를 처음 들여왔다. step2 변이 실측에서
 * 업로드 루트 도출을 한 번 틀리자 <b>리포에 107개 파일이 실제로 쏟아졌다</b> — 그리고 그때 Java 테스트도
 * 계약도 전부 green이었다. 되돌릴 수 없는 사고인데 아무 게이트도 울리지 않는다는 뜻이다.
 *
 * <p>계약 하네스({@code scripts/spring-contract.mjs})는 자기 실행 전후로 리포 스냅샷을 뜨지만 그 스냅샷은
 * {@code uploads} <b>최상위 엔트리 개수</b>뿐이라 "1개 지우고 1개 만들기"를 통과시킨다(2026-08-27 phase 72
 * ④가 같은 계열의 그물에서 실제로 확인한 함정). 그리고 그 스냅샷은 <b>Java 테스트 실행에는 아예 걸리지
 * 않는다</b> — {@code mvnw verify}는 그 스크립트를 거치지 않기 때문이다. 이 파일이 그 공백을 맡는다.
 *
 * <h2>세 겹</h2>
 * <ol>
 * <li><b>정적</b>(순서 무관) — 모든 테스트의 {@code app.data-dir} 값이 <b>임시 디렉토리 도출</b>에서만 온다.
 * 리터럴 경로·cwd 상대 경로를 쓰는 순간 red다.</li>
 * <li><b>cwd</b> — 모듈 작업 디렉토리에 {@code uploads}가 생기지 않았다. Node {@code createApp}의 기본값
 * {@code 'uploads'}(cwd 상대)를 이식하면 정확히 여기에 파일이 떨어진다.</li>
 * <li><b>리포 루트</b>(최선 노력) — {@code ../uploads}·{@code ../news.db}에 <b>이 JVM이 뜬 뒤 수정된</b>
 * 흔적이 없다. 클래스 실행 순서에 따라 뒤에 벌어진 오염은 놓칠 수 있으므로 ①이 주 그물이고 이것은
 * 보조다 — 그래도 "쏟아진 107개"는 mtime이 전부 새것이라 여기서 걸린다.</li>
 * </ol>
 */
class RepoDataIsolationTest {

	/** 모듈 루트({@code server-spring})가 작업 디렉토리다 — 리포 루트는 그 부모다. */
	private static final Path MODULE_ROOT = Path.of("").toAbsolutePath();

	private static final Path REPO_ROOT = MODULE_ROOT.getParent();

	private static final Path TEST_SOURCES = Path.of("src", "test", "java");

	private static final Path MAIN_SOURCES = Path.of("src", "main", "java");

	/** {@code registry.add("app.data-dir", () -> <식>)} 의 우변을 뽑는다. */
	private static final Pattern DATA_DIR_BINDING = Pattern.compile(
			"\"app\\.data-dir\"\\s*,\\s*\\(\\s*\\)\\s*->\\s*([^)]*)");

	/** 스캐너 자신 — javadoc이 바인딩 형태를 예시로 들기 때문에 자기 자신은 훑지 않는다. */
	private static final String SELF = "RepoDataIsolationTest.java";

	/** 우변이 임시 디렉토리에서 왔다고 인정하는 유일한 출처들. */
	private static final List<String> TEMP_SOURCES =
			List.of("TempNewsDb", "DATA_DIR", "tempDir", "TEMP_DIR", "createTempDirectory");

	/**
	 * ① 어떤 테스트도 데이터 디렉토리를 리터럴 경로로 지정하지 않는다.
	 *
	 * <p>이 단언이 주 그물인 이유: 실행 순서와 무관하고, 오염이 <b>벌어지기 전에</b> 그 가능성을 막는다.
	 */
	@Test
	void everyTestBindsItsDataDirectoryToATemporaryDirectory() throws IOException {
		List<String> offenders = new ArrayList<>();
		List<String> bindings = new ArrayList<>();

		for (Path file : javaFiles(TEST_SOURCES)) {
			if (file.getFileName().toString().equals(SELF)) {
				continue; // 스캐너 자신의 javadoc이 예시로 든 바인딩은 코드가 아니다.
			}
			String source = Files.readString(file, StandardCharsets.UTF_8);
			Matcher matcher = DATA_DIR_BINDING.matcher(source);
			while (matcher.find()) {
				String expression = matcher.group(1).trim();
				bindings.add(file.getFileName() + " ~ " + expression);
				if (TEMP_SOURCES.stream().noneMatch(expression::contains)) {
					offenders.add(file + " ~ " + expression);
				}
			}
		}

		assertFalse(bindings.isEmpty(),
				"app.data-dir 바인딩을 하나도 찾지 못했다 — 정규식이 죽었으면 이 게이트는 공허하다");
		assertTrue(offenders.isEmpty(),
				"임시 디렉토리가 아닌 데이터 디렉토리를 쓰는 테스트가 있다(리포 news.db·uploads를 여는 경로다): "
						+ offenders);
	}

	/**
	 * ② main 소스가 업로드/스풀 루트를 <b>cwd 상대</b>로 추정하지 않는다.
	 *
	 * <p>Node {@code createApp}의 기본값 {@code 'uploads'}는 cwd 상대이고, 그것을 그대로 이식하면 프로세스
	 * 작업 디렉토리(=리포)에 파일을 떨군다. 설정 클래스는 경로를 <b>추정하지 않고</b> 미설정이면 거부한다.
	 */
	@Test
	void noMainSourceGuessesAnUploadRootFromTheWorkingDirectory() throws IOException {
		List<String> offenders = new ArrayList<>();
		Pattern cwdRelative = Pattern.compile("(Path\\s*\\.\\s*of|Paths\\s*\\.\\s*get)\\s*\\(\\s*\"uploads\"");

		for (Path file : javaFiles(MAIN_SOURCES)) {
			String source = Files.readString(file, StandardCharsets.UTF_8);
			if (cwdRelative.matcher(source).find()) {
				offenders.add(file.toString());
			}
		}

		assertTrue(cwdRelative.matcher("Path.of(\"uploads\").resolve(name)").find(),
				"패턴이 죽었다 — 이 게이트는 공허하다");
		assertTrue(offenders.isEmpty(),
				"업로드 루트를 cwd 상대로 도출하는 main 소스가 있다(프로세스 작업 디렉토리에 파일을 떨군다): "
						+ offenders);
	}

	/** ③-a 모듈 작업 디렉토리에 {@code uploads}가 생기지 않았다(cwd 상대 도출의 착지점이다). */
	@Test
	void theModuleWorkingDirectoryHasNoUploadsDirectory() {
		Path stray = MODULE_ROOT.resolve("uploads");

		assertFalse(Files.exists(stray),
				"모듈 작업 디렉토리에 uploads가 생겼다 — 업로드 루트가 cwd 상대로 도출됐다: " + stray);
	}

	/**
	 * ③-b 리포 루트의 {@code uploads/}·{@code news.db}에 <b>이 JVM이 뜬 뒤</b> 손댄 흔적이 없다.
	 *
	 * <p>정직한 한계: 이 클래스가 오염을 일으키는 클래스보다 <b>먼저</b> 돌면 놓친다. 그래서 ①이 주 그물이고
	 * 이것은 보조다 — 그래도 "리포에 107개가 쏟아진" 형태의 사고는 파일 mtime이 전부 JVM 기동 이후라
	 * 여기서 걸린다. 리포 파일 <b>내용</b>은 읽지 않는다(DB 비파괴 규율: 이 테스트도 리포를 열지 않는다).
	 */
	@Test
	void theRepositoryUploadsAndDatabaseAreUntouchedByThisJvm() throws IOException {
		long jvmStart = ManagementFactory.getRuntimeMXBean().getStartTime();
		List<String> touched = new ArrayList<>();

		Path uploads = REPO_ROOT.resolve("uploads");
		if (Files.isDirectory(uploads)) {
			try (Stream<Path> files = Files.walk(uploads)) {
				for (Path file : files.toList()) {
					if (Files.getLastModifiedTime(file).toMillis() >= jvmStart) {
						touched.add(file.toString());
					}
				}
			}
		}
		Path db = REPO_ROOT.resolve("news.db");
		if (Files.isRegularFile(db) && Files.getLastModifiedTime(db).toMillis() >= jvmStart) {
			touched.add(db.toString());
		}

		assertTrue(touched.isEmpty(),
				"리포의 데이터가 이 테스트 JVM에서 수정됐다(되돌릴 수 없다 — DB 비파괴·uploads 무접촉): " + touched);
	}

	private static List<Path> javaFiles(Path root) throws IOException {
		assertTrue(Files.isDirectory(root),
				"스캔 대상이 없다 — 테스트 작업 디렉토리가 모듈 루트가 아니다: " + root.toAbsolutePath());
		try (Stream<Path> files = Files.walk(root)) {
			return files.filter(Files::isRegularFile)
					.filter((file) -> file.getFileName().toString().endsWith(".java"))
					.toList();
		}
	}

}
