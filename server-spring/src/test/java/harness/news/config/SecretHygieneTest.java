package harness.news.config;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.io.IOException;
import java.nio.ByteBuffer;
import java.nio.CharBuffer;
import java.nio.charset.CharsetDecoder;
import java.nio.charset.CodingErrorAction;
import java.nio.charset.StandardCharsets;
import java.nio.file.FileVisitResult;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.SimpleFileVisitor;
import java.nio.file.attribute.BasicFileAttributes;
import java.util.ArrayList;
import java.util.List;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import org.junit.jupiter.api.Test;

/**
 * <b>비밀 위생</b> — MySQL 접속 비밀번호가 리포에 들어오는 경로를 정적으로 막는다(phase 75 step0).
 *
 * <h2>왜 이 파일이 필요한가</h2>
 * P2(DB 이관)는 이 리포에 <b>처음으로 DB 접속 자격증명</b>을 들여온다. 지금까지의 비밀(수집 토큰·미디어
 * API 키)은 프로세스 환경변수로만 흘렀고 리포에 적을 이유가 없었지만, MySQL은 <b>부트스트랩 SQL</b>이라는
 * "사람이 편집해서 실행하는 파일"을 동반한다 — 그 파일에 실제 비밀번호를 적고 커밋하는 것이 가장 흔한 사고다.
 * git 이력은 되돌릴 수 없으므로(강제 푸시로도 다른 클론에 남는다) 커밋 <b>전에</b> 기계가 막는다.
 *
 * <h2>스캔 범위</h2>
 * 리포 루트 전체({@code ../} — {@link RepoDataIsolationTest}의 {@code REPO_ROOT} 도출을 그대로 승계한다)다.
 * {@code server-spring} 하위만 보면 정작 비밀이 들어오는 자리({@code ops/mysql/}·{@code docs/}·
 * {@code scripts/})를 통째로 놓친다.
 *
 * <p><b>리포트·산출물도 스캔한다</b>(예: {@code phases/**}의 실행 로그). git이 추적하지 않더라도 비밀이
 * 그 안에 적히면 유출이기 때문이다(phase 75 규율: "비밀은 리포·대화·argv·로그·리포트 어디에도 남기지 않는다").
 * 예외는 <b>비밀을 담기로 설계된 자리</b> 셋뿐이고, 그 셋은 {@link #theGitignoreCoversTheSecretBearingPaths}가
 * git에서 영구히 제외됨을 함께 단언한다 — 스캐너의 구멍과 git의 구멍이 <b>같은 목록</b>이어야 한다.
 */
class SecretHygieneTest {

	/** 모듈 루트({@code server-spring})가 작업 디렉토리다 — 리포 루트는 그 부모다. */
	private static final Path MODULE_ROOT = Path.of("").toAbsolutePath();

	private static final Path REPO_ROOT = MODULE_ROOT.getParent();

	/** 스캐너 자신 — 아래 자기 검사가 위반 문자열을 리터럴로 들고 있다(코드가 아니라 증거다). */
	private static final String SELF = "SecretHygieneTest.java";

	/** 빌드 산출물·의존성·VCS 내부. 텍스트가 아니거나 우리가 쓴 것이 아니다. */
	private static final Set<String> PRUNED_DIRECTORIES =
			Set.of("node_modules", "target", ".git", "dist", "uploads", ".idea", ".vscode", "__pycache__");

	/**
	 * <b>비밀을 담기로 설계된 자리</b> — 스캔에서 제외하는 유일한 파일들이다.
	 *
	 * <p>{@code *.env}(리포 밖 규약이지만 방어적으로) · {@code ops/mysql/*.local.sql}(사용자가 실제
	 * 비밀번호를 넣어 실행하는 사본) · {@code secrets/} 하위. 이 셋은 {@code .gitignore}가 막으므로
	 * <b>커밋될 수 없다</b> — 그 사실을 아래 단언이 함께 잠근다.
	 */
	private static boolean isSecretBearingByDesign(Path file) {
		String name = file.getFileName().toString();
		String path = REPO_ROOT.relativize(file).toString().replace('\\', '/');
		return name.endsWith(".env") || name.endsWith(".local.sql") || path.startsWith("secrets/")
				|| path.contains("/secrets/");
	}

	/** {@code .gitignore}가 반드시 담아야 하는 줄(비밀 보관 자리 3종). */
	private static final List<String> REQUIRED_GITIGNORE_ENTRIES =
			List.of("*.env", "secrets/", "ops/mysql/*.local.sql");

	/**
	 * ① 접속 URL에 비밀번호가 박힌 형태({@code //사용자:비밀번호@호스트}).
	 *
	 * <p>{@code \s*}가 붙은 이유: 판정 전에 따옴표와 {@code +}를 공백으로 지우기 때문이다
	 * ({@link #inlineConcatenation}) — 끊어 쓴 {@code "jdbc:mysql:" + "//u:p@h/d"}가 다시 잡힌다.
	 * 사용자 정보가 없는 정상 URL({@code jdbc:mysql://127.0.0.1:3306/news})은 {@code @}가 없어 통과한다.
	 */
	private static final Pattern CREDENTIALS_IN_URL =
			Pattern.compile("(?i)jdbc:mysql:\\s*//\\s*[^\\s/@]+:[^\\s/@]*@");

	/**
	 * ① 의 <b>유일한 면제</b> — 이 스캐너를 규정한 계획 문서다. 잡아야 할 형태를 <b>명세로</b> 인용하고
	 * 있으므로(코드가 아니다) 위반이 아니다.
	 *
	 * <p>면제는 "적어 두고 잊는" 순간 구멍이 된다. 그래서 {@link #noFileEmbedsACredentialInAJdbcUrl}는
	 * 면제 목록이 <b>실제 매치 집합과 정확히 일치</b>함을 단언한다 — 인용이 사라지면 면제도 red가 되어
	 * 지워야 하고(썩은 면제 금지), 새 파일이 매치하면 면제되지 않는다.
	 */
	private static final List<String> DOCUMENTED_URL_EXAMPLES =
			List.of("phases/75-mysql-migration/step0.md");

	/** ② 값 대입이 금지된 비밀번호 환경변수 이름들(<b>이름</b>의 등장 자체는 허용한다). */
	private static final List<String> PASSWORD_KEYS =
			List.of("NEWS_DB_PASSWORD", "NEWS_MIGRATOR_PASSWORD", "NEWS_CT_MYSQL_PASSWORD");

	/**
	 * ② {@code 이름=값} 대입. <b>같은 줄</b>로 제한한다({@code \s}를 쓰면 개행을 넘어 다음 줄의 첫
	 * 토큰을 값으로 오인해 빈 대입까지 위반으로 만든다).
	 */
	private static final Pattern PASSWORD_ASSIGNMENT = Pattern.compile(
			"(?i)\\b(" + String.join("|", PASSWORD_KEYS) + ")[ \\t]*=[ \\t]*([^\\s]+)");

	/**
	 * ② 값 자리에 허용하는 것 — 플레이스홀더와 변수 전개뿐이다. 실제 비밀번호는 이 형태를 띠지 않는다.
	 */
	private static boolean isPlaceholderValue(String value) {
		return value.startsWith("__CHANGE_ME") || value.startsWith("<") || value.startsWith("$")
				|| value.startsWith("%") || value.equals("\"\"") || value.equals("''");
	}

	/** ③ 부트스트랩 SQL의 {@code IDENTIFIED BY '...'} 우변. */
	private static final Pattern IDENTIFIED_BY =
			Pattern.compile("(?i)IDENTIFIED\\s+(?:WITH\\s+[^\\s']+\\s+)?BY\\s+'([^']*)'");

	private static final Path BOOTSTRAP_SQL = Path.of("ops", "mysql", "bootstrap.sql");

	private static final Path OPS_RUNBOOK = Path.of("docs", "ops-mysql.md");

	/**
	 * ① 추적되는 어떤 파일도 접속 URL에 비밀번호를 박아 두지 않는다.
	 */
	@Test
	void noFileEmbedsACredentialInAJdbcUrl() throws IOException {
		List<String> offenders = new ArrayList<>();
		List<String> waived = new ArrayList<>();

		for (Path file : scannableFiles()) {
			if (CREDENTIALS_IN_URL.matcher(inlineConcatenation(readTextOrEmpty(file))).find()) {
				(DOCUMENTED_URL_EXAMPLES.contains(relative(file)) ? waived : offenders).add(relative(file));
			}
		}

		assertTrue(offenders.isEmpty(),
				"jdbc 접속 URL에 비밀번호가 박혀 있다(git 이력은 되돌릴 수 없다): " + offenders);
		assertEquals(DOCUMENTED_URL_EXAMPLES.stream().sorted().toList(), waived.stream().sorted().toList(),
				"면제 목록이 실제와 어긋난다 — 인용이 사라졌으면 면제도 지워야 한다(썩은 면제는 구멍이다)");
	}

	/**
	 * ② 비밀번호 환경변수에 <b>값을 대입하는 줄</b>이 없다. 이름의 등장은 문서·코드 어디서든 허용한다.
	 */
	@Test
	void noFileAssignsAValueToAPasswordEnvironmentVariable() throws IOException {
		List<String> offenders = new ArrayList<>();

		for (Path file : scannableFiles()) {
			Matcher matcher = PASSWORD_ASSIGNMENT.matcher(readTextOrEmpty(file));
			while (matcher.find()) {
				if (!isPlaceholderValue(matcher.group(2))) {
					offenders.add(relative(file) + " ~ " + matcher.group(1) + "=<값이 적혀 있다>");
				}
			}
		}

		assertTrue(offenders.isEmpty(),
				"비밀번호 환경변수에 값이 적힌 줄이 있다(값은 리포 밖 env 파일에만 둔다): " + offenders);
	}

	/**
	 * ③ 부트스트랩 SQL의 비밀번호 자리는 전부 플레이스홀더다.
	 *
	 * <p>사용자는 이 파일을 그대로 실행하지 않는다 — {@code bootstrap.local.sql}로 복사해 값을 채워
	 * 실행하고, 그 사본은 {@code .gitignore}가 막는다. 즉 이 단언은 "정본에는 값이 없다"를 잠근다.
	 */
	@Test
	void theBootstrapSqlOnlyCarriesPlaceholderPasswords() throws IOException {
		Path bootstrap = REPO_ROOT.resolve(BOOTSTRAP_SQL);
		assertTrue(Files.isRegularFile(bootstrap),
				"부트스트랩 SQL이 없다 — 이 단언이 공허해진다: " + bootstrap);

		String text = Files.readString(bootstrap, StandardCharsets.UTF_8);
		List<String> values = new ArrayList<>();
		Matcher matcher = IDENTIFIED_BY.matcher(text);
		while (matcher.find()) {
			values.add(matcher.group(1));
		}

		assertFalse(values.isEmpty(),
				"IDENTIFIED BY 절을 하나도 찾지 못했다 — 정규식이 죽었으면 이 게이트는 공허하다");
		List<String> real = values.stream().filter((value) -> !value.startsWith("__CHANGE_ME")).toList();
		assertTrue(real.isEmpty(),
				"부트스트랩 SQL에 플레이스홀더가 아닌 비밀번호가 적혀 있다(자리 개수: " + real.size() + ")");
	}

	/**
	 * ④ {@code .gitignore}가 비밀 보관 자리 3종을 막는다 — 스캐너가 건너뛰는 자리와 <b>같은 목록</b>이다.
	 */
	@Test
	void theGitignoreCoversTheSecretBearingPaths() throws IOException {
		Path gitignore = REPO_ROOT.resolve(".gitignore");
		assertTrue(Files.isRegularFile(gitignore), "리포 루트에 .gitignore가 없다: " + gitignore);

		List<String> entries = Files.readAllLines(gitignore, StandardCharsets.UTF_8).stream()
				.map((line) -> line.trim())
				.filter((line) -> !line.isEmpty() && !line.startsWith("#"))
				.toList();
		List<String> missing = REQUIRED_GITIGNORE_ENTRIES.stream()
				.filter((required) -> !entries.contains(required))
				.toList();

		assertTrue(missing.isEmpty(),
				".gitignore가 비밀 보관 자리를 막지 않는다(스캐너는 이 자리를 건너뛴다 — 둘이 어긋나면 유출 경로다): "
						+ missing);
	}

	/**
	 * <b>비공허성</b> — 스캐너가 실제 위반을 잡고 정상 형태는 통과시킨다는 증거.
	 *
	 * <p>이 자기 검사가 없으면 정규식이 망가져도(예: {@code @} 앞 부분이 좁아져도) 위 세 테스트는 조용히
	 * green이다. 심는 값은 전부 <b>가짜 센티넬</b>이며 실제 자격증명이 아니다.
	 *
	 * <p><b>끊어 쓴 형태</b>(2026-09-03 변이 실측): ①은 따옴표·{@code +}를 지우고 판정하므로
	 * {@code "jdbc:mysql:" + "//u:p@h/d"}를 <b>잡는다</b>. ②는 원문 한 줄만 보는데도
	 * {@code "NEWS_DB_PASSWORD=" + pw}를 <b>잡는다</b> — 다만 이유가 다르다: {@code =} 다음 토큰이
	 * 닫는 따옴표({@code "})라 플레이스홀더가 아니어서 걸리는 것이다. 즉 ②의 그 검출은
	 * <b>부수적</b>이며, 값 자체가 변수인 형태를 의미로 판정하는 것이 아니다(과장하지 마라).
	 */
	@Test
	void theScannersCatchPlantedViolationsAndStillAllowLegitimateForms() {
		for (String planted : List.of(
				"NEWS_DB_URL=jdbc:mysql://news_app:s3ntinel-not-a-secret@127.0.0.1:3306/news",
				"url(\"jdbc:mysql:\" + \"//news_app:s3ntinel-not-a-secret@127.0.0.1:3306/news\")",
				"const url = 'jdbc:mysql:' + '//news_ct:s3ntinel@127.0.0.1:3306/harness_ct_0123456789abcdef';")) {
			assertTrue(CREDENTIALS_IN_URL.matcher(inlineConcatenation(planted)).find(),
					"URL에 박힌 비밀번호를 놓친다 — 스캐너가 공허하다: " + planted);
		}
		for (String allowed : List.of(
				"NEWS_DB_URL=jdbc:mysql://127.0.0.1:3306/news?useSSL=false",
				"jdbc:mysql://localhost:3306/harness_ct_0123456789abcdef")) {
			assertFalse(CREDENTIALS_IN_URL.matcher(inlineConcatenation(allowed)).find(),
					"사용자 정보가 없는 정상 URL까지 막고 있다: " + allowed);
		}

		for (String planted : List.of(
				"NEWS_DB_PASSWORD=s3ntinel-not-a-secret",
				"set NEWS_MIGRATOR_PASSWORD=s3ntinel-not-a-secret",
				"export NEWS_CT_MYSQL_PASSWORD='s3ntinel-not-a-secret'")) {
			Matcher matcher = PASSWORD_ASSIGNMENT.matcher(planted);
			assertTrue(matcher.find() && !isPlaceholderValue(matcher.group(2)),
					"비밀번호 값 대입을 놓친다 — 스캐너가 공허하다: " + planted);
		}
		for (String allowed : List.of(
				"NEWS_DB_PASSWORD=__CHANGE_ME_APP__",
				"NEWS_MIGRATOR_PASSWORD=",
				"NEWS_CT_MYSQL_PASSWORD=${MYSQL_CT_PW}",
				"환경변수 NEWS_DB_PASSWORD 를 읽는다",
				"env.NEWS_DB_PASSWORD")) {
			Matcher matcher = PASSWORD_ASSIGNMENT.matcher(allowed);
			assertFalse(matcher.find() && !isPlaceholderValue(matcher.group(2)),
					"플레이스홀더·이름 등장까지 막고 있다: " + allowed);
		}

		String plantedSql = "CREATE USER IF NOT EXISTS 'news_app'@'localhost' IDENTIFIED BY 's3ntinel';";
		Matcher sql = IDENTIFIED_BY.matcher(plantedSql);
		assertTrue(sql.find() && !sql.group(1).startsWith("__CHANGE_ME"),
				"IDENTIFIED BY의 실제 값을 놓친다 — 스캐너가 공허하다: " + plantedSql);
		Matcher withPlugin = IDENTIFIED_BY.matcher(
				"CREATE USER 'u'@'localhost' IDENTIFIED WITH caching_sha2_password BY '__CHANGE_ME_X__';");
		assertTrue(withPlugin.find() && withPlugin.group(1).startsWith("__CHANGE_ME"),
				"인증 플러그인을 명시한 형태를 파싱하지 못한다");
	}

	/**
	 * 스캔이 <b>실제로 리포를 훑었는가</b> — 대상이 비면 위 단언 셋이 전부 공허하다.
	 *
	 * <p>이 phase의 산출물 2개가 스캔 대상에 실제로 들어왔는지도 함께 못 박는다(가지치기 목록이 넓어져
	 * {@code ops/}·{@code docs/}를 통째로 건너뛰면 여기서 red다).
	 */
	@Test
	void theScanActuallyReachesTheRepositoryFiles() throws IOException {
		List<Path> files = scannableFiles();
		List<String> relatives = files.stream().map(SecretHygieneTest::relative).toList();

		assertTrue(files.size() >= 100, "스캔한 파일이 너무 적다 — 리포 루트 도출이 틀렸다: " + files.size());
		assertTrue(relatives.contains(relative(REPO_ROOT.resolve(BOOTSTRAP_SQL))),
				"부트스트랩 SQL이 스캔 대상에 없다: " + BOOTSTRAP_SQL);
		assertTrue(relatives.contains(relative(REPO_ROOT.resolve(OPS_RUNBOOK))),
				"운영 런북이 스캔 대상에 없다: " + OPS_RUNBOOK);
		assertTrue(relatives.stream().noneMatch((path) -> path.contains("node_modules")),
				"의존성 트리를 훑고 있다 — 가지치기가 죽었다");
	}

	// --- 도구 ---

	/** 따옴표와 {@code +}를 공백으로 지운다 — 끊어 쓴 문자열이 한 덩어리로 보이게 만든다. */
	private static String inlineConcatenation(String text) {
		return text.replaceAll("[\"'+]", " ").replaceAll("[ \\t]+", " ");
	}

	private static String relative(Path file) {
		return REPO_ROOT.relativize(file).toString().replace('\\', '/');
	}

	/**
	 * 텍스트로 읽는다. <b>바이너리는 건너뛴다</b>(NUL 바이트 유무로 판정) — {@code news.db}·이미지·jar를
	 * UTF-8로 읽으면 예외가 나고, 무엇보다 이 테스트는 리포 데이터를 <b>열지 않는 것</b>이 규율이다.
	 * 깨진 바이트는 예외 대신 대체 문자로 흘려보낸다(스캔은 판정이지 파싱이 아니다).
	 */
	private static String readTextOrEmpty(Path file) throws IOException {
		byte[] bytes = Files.readAllBytes(file);
		int probe = Math.min(bytes.length, 4096);
		for (int i = 0; i < probe; i++) {
			if (bytes[i] == 0) {
				return "";
			}
		}
		CharsetDecoder decoder = StandardCharsets.UTF_8.newDecoder()
				.onMalformedInput(CodingErrorAction.REPLACE)
				.onUnmappableCharacter(CodingErrorAction.REPLACE);
		CharBuffer decoded = decoder.decode(ByteBuffer.wrap(bytes));
		return decoded.toString();
	}

	/** 리포 루트를 훑되 빌드 산출물과 "비밀을 담기로 설계된 자리"는 뺀다. */
	private static List<Path> scannableFiles() throws IOException {
		assertTrue(REPO_ROOT != null && Files.isDirectory(REPO_ROOT),
				"리포 루트를 찾지 못했다 — 테스트 작업 디렉토리가 모듈 루트가 아니다: " + MODULE_ROOT);

		List<Path> files = new ArrayList<>();
		Files.walkFileTree(REPO_ROOT, new SimpleFileVisitor<Path>() {

			@Override
			public FileVisitResult preVisitDirectory(Path dir, BasicFileAttributes attrs) {
				String name = dir.getFileName() == null ? "" : dir.getFileName().toString();
				if (!dir.equals(REPO_ROOT) && PRUNED_DIRECTORIES.contains(name)) {
					return FileVisitResult.SKIP_SUBTREE;
				}
				return FileVisitResult.CONTINUE;
			}

			@Override
			public FileVisitResult visitFile(Path file, BasicFileAttributes attrs) {
				String name = file.getFileName().toString();
				if (!name.equals(SELF) && !isSecretBearingByDesign(file)) {
					files.add(file);
				}
				return FileVisitResult.CONTINUE;
			}

			@Override
			public FileVisitResult visitFileFailed(Path file, IOException exc) {
				return FileVisitResult.CONTINUE;
			}

		});
		return files;
	}

}
