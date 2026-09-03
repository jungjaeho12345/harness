package harness.newsmigrator;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.regex.Pattern;
import java.util.stream.Stream;
import org.junit.jupiter.api.Test;

/**
 * 정적 잠금 — 이 마이그레이터의 main 트리에는 <b>지우는 경로가 없다</b>.
 *
 * <h2>왜 server-spring 의 게이트를 그대로 베끼면 공허한가</h2>
 * {@code server-spring} 의 {@code NoSchemaSqlInMainSourcesTest} 는 "파괴는 SQL 문자열로만 나타난다"는
 * 전제 위에 서 있다. 그 전제는 그 모듈에서 참이다 — 거기에는 JDBC 밖으로 나가는 파괴 경로가 없다.
 * <b>이 모듈에서는 거짓이다.</b> 이 모듈은 Flyway 와 {@code java.nio.file} 을 직접 쓴다:
 * <ul>
 * <li>{@code flyway.clean()} 한 줄이면 스키마의 <b>전 객체가 DROP</b> 된다 — SQL 문자열이 하나도 없다.</li>
 * <li>{@code Files.deleteIfExists(source)} 한 줄이면 <b>소스 news.db 파일 자체</b>가 사라진다 —
 * "원본 바이트 무변" 이라는 이 phase 의 완료 게이트가 SQL 한 줄 없이 무너진다.</li>
 * </ul>
 * 그래서 금지 패턴을 <b>두 군</b>으로 둔다: SQL 텍스트를 보는 군과 <b>API 호출</b>을 보는 군이다.
 * 71a(12/12 통과) · 72(11/11 통과) · 73(8/10 통과) · 74({@code ScopedValue})가 전부 "게이트 green 인
 * 채로" 뚫린 전례가 있으므로, 각 군마다 <b>심어 본 우회 형태</b>를 자기 검사로 남긴다.
 *
 * <h2>왜 두 모듈이 코드를 공유하지 않는가</h2>
 * {@code server-spring} 과 이 모듈은 서로의 소스를 볼 수 없다(독립 Maven 프로젝트 · reactor 아님 —
 * {@code scripts/spring-contract.mjs} 가 {@code server-spring/target/*.jar} 경로에 의존하므로 reactor
 * 전환은 계약 하네스를 깬다). 그래서 이것은 <b>복제가 아니라 같은 규율의 재적용</b>이고, 두 게이트는
 * 각자의 모듈에서 각자 red 를 낸다. 물리적 공유가 불가능하다는 사실 자체를 여기 적어 둔다.
 *
 * <h2>정규화가 두 가지인 이유</h2>
 * <ul>
 * <li><b>{@link Normalization#SQL_TEXT}</b> — 주석·문자열을 <b>구분하지 않는다</b>. SQL 은 문자열 리터럴
 * 안에 있으므로 리터럴을 지우면 아무것도 못 본다. 따옴표와 {@code +} 를 공백으로 만들어 <b>끊어 쓴
 * 문자열</b>을 펴고, 테이블 이름 상수를 펼친 뒤 대소문자를 무시하고 본다. 대가는 주석에 그 낱말을 쓸 수
 * 없다는 것이고, 그것은 {@code NoSchemaSqlInMainSourcesTest} 가 이미 택한 규율이다("주석에도 쓰지 않는
 * 편이 안전하고 판정이 단순하다").</li>
 * <li><b>{@link Normalization#CODE_TOKENS}</b> — 주석과 <b>리터럴 내용</b>을 지운다. API 호출은 실행되는
 * 토큰이라 리터럴 안에 있을 수 없고, 반대로 이 규칙을 <b>문서화</b>하려면 javadoc 에 그 철자를 쓸 수
 * 있어야 한다. 리터럴 속 {@code //} 가 줄 주석으로 오인돼 그 줄의 위반이 통째로 사라지는 실측된 우회
 * (2026-08-25)를 막기 위해 좌→우 1회 훑기로 구현한다.</li>
 * </ul>
 *
 * <h2>덮지 못하는 벡터(정직한 기록)</h2>
 * 리플렉션({@code Class.forName} + {@code Method.invoke})으로 만든 호출과, API 이름을 문자로 조립해
 * 리플렉션에 넘기는 형태는 이 스캔이 보지 못한다. 그 축의 실질 방어선은 두 겹이다 — ① 이 모듈의 행동
 * 테스트(원본 md5 무변 · {@code clean()} 예외) ② MySQL grant({@code news_migrator} 에는
 * {@code DELETE}·{@code DROP} 이 없다 — 서버가 거부한다).
 */
class MigratorHasNoDestructiveSqlTest {

	/** 스캔 뿌리 — java 와 resources 를 <b>함께</b> 훑는다(마이그레이션 SQL 이 리소스에 있다). */
	private static final Path MAIN = Path.of("src", "main");

	/** 예외 판정의 키는 {@link #MAIN} 기준 상대 경로다(이름이 아니다 — 아래 오배치 테스트가 그 이유다). */
	private static final String EPHEMERAL_DROP_FILE = "java/harness/newsmigrator/EphemeralDatabase.java";

	/** 정규화 방식 — 무엇을 지우고 무엇을 남길 것인가. */
	private enum Normalization {

		/** 주석·리터럴을 남긴다. 따옴표·{@code +} 만 공백으로 지워 끊어 쓴 SQL 을 편다. */
		SQL_TEXT,

		/** 주석과 리터럴 <b>내용</b>을 지운다. 남는 것은 실행되는 토큰뿐이다. */
		CODE_TOKENS

	}

	/**
	 * 금지 규칙 한 묶음 — 이름 · 패턴 · 정규화 · <b>경로 단위 예외</b>.
	 *
	 * <p>예외를 규칙 안에 묶는 이유는 {@code Adr008DisciplineTest} 와 같다: 예외가 <b>자기 군에만</b>
	 * 적용된다는 사실이 구조로 보장된다(임시 DB 를 버리는 파일이라고 해서 {@code flyway.clean()} 이
	 * 허용되지는 않는다).
	 */
	private record Rule(String name, List<Pattern> patterns, Normalization normalization, List<String> exemptPaths) {
	}

	/**
	 * 1군 — <b>파괴적 SQL</b>(예외 0).
	 *
	 * <p>{@code UPDATE} 까지 막는 이유: 이관은 <b>삽입만으로</b> 완결돼야 한다. 갱신이 있으면 "부분 실패
	 * 후 덮어쓰기" 경로가 생겨 멱등성 판정이 흐려지고, 대조가 "무엇을 옮겼는가"가 아니라 "무엇이 마지막에
	 * 남았는가"를 재게 된다. {@code executeUpdate(} 는 낱말 경계 때문에 걸리지 않는다(앞 글자가 단어 문자다).
	 */
	private static final Rule DESTRUCTIVE_SQL = new Rule("파괴적 SQL", List.of(
			Pattern.compile("(?i)\\bdelete\\s+from\\b"),
			Pattern.compile("(?i)\\bdrop\\s+(table|index|view|trigger|column|user|function|procedure|event)\\b"),
			Pattern.compile("(?i)\\btruncate\\b"),
			Pattern.compile("(?i)\\brename\\s+table\\b"),
			Pattern.compile("(?i)\\breplace\\s+into\\b"),
			Pattern.compile("(?i)\\binsert\\s+or\\s+replace\\b"),
			Pattern.compile("(?i)\\bupdate\\s+[A-Za-z_`]")),
			Normalization.SQL_TEXT, List.of());

	/**
	 * 2군 — <b>데이터베이스 통째로 버리기</b>(예외 정확히 1파일).
	 *
	 * <p>1군에서 분리한 이유: 임시 DB({@code harness_ct_<16진수>}) 폐기는 계약 하네스가 실제로 필요로
	 * 하는 유일한 드롭이고, 그것을 1군에 예외로 넣으면 <b>그 파일 안에서 행 삭제까지 허용</b>된다.
	 * 군을 쪼개면 예외의 면적이 정확히 필요한 만큼만 열린다.
	 */
	private static final Rule DROP_DATABASE = new Rule("데이터베이스 드롭", List.of(
			Pattern.compile("(?i)\\bdrop\\s+(database|schema)\\b")),
			Normalization.SQL_TEXT, List.of(EPHEMERAL_DROP_FILE));

	/**
	 * 3군 — <b>SQL 이 아닌 파괴 경로</b>(예외 0). 이 군이 이 게이트의 존재 이유다.
	 *
	 * <p>{@code cleanDisabled} 는 <b>끄는 형태만</b> 막는다. 넓게 잡으면 아래 행동 잠금이 요구하는
	 * {@code cleanDisabled(true)} 명시 설정이 스스로 red 가 되어 이 절이 자기 요구와 충돌한다.
	 *
	 * <p>{@code delete}·{@code move} 는 <b>맨이름 호출</b>까지 본다({@code import static
	 * java.nio.file.Files.deleteIfExists;} 뒤의 {@code deleteIfExists(p)} 는 {@code Files.} 가 사라진
	 * 형태다). 메서드 참조({@code Files::delete})도 별도로 잡는다 — {@code .forEach(Files::delete)} 는
	 * 괄호가 붙지 않아 호출 패턴이 놓친다.
	 */
	private static final Rule DESTRUCTIVE_API = new Rule("SQL 밖 파괴 경로", List.of(
			Pattern.compile("\\.\\s*clean\\s*\\("),
			Pattern.compile("\\bclean\\s*\\("),
			Pattern.compile("\\bcleanDisabled\\s*\\(\\s*false"),
			Pattern.compile("\\bFiles\\s*\\.\\s*(delete|deleteIfExists|move)\\s*\\("),
			Pattern.compile("\\b(delete|deleteIfExists|move)\\s*\\("),
			Pattern.compile("\\bFiles\\s*::\\s*(delete|deleteIfExists|move)\\b")),
			Normalization.CODE_TOKENS, List.of());

	private static final List<Rule> RULES = List.of(DESTRUCTIVE_SQL, DROP_DATABASE, DESTRUCTIVE_API);

	/**
	 * 테이블 이름 상수 → 실제 이름. 정본({@code src/db/schema.js})에서 읽어 만든다 — 이 표를 손으로 적으면
	 * 정본에 테이블이 늘 때 조용히 낡는다.
	 *
	 * <p>step3 의 복사기가 어떤 표기를 고를지 아직 모르므로 <b>두 관용 표기를 미리 편다</b>:
	 * {@code CONTENTS_TABLE} 와 {@code TABLES.CONTENTS} 형태 둘 다. 클래스 한정자는 {@code DROP TABLE}
	 * 판정에 영향을 주지 않으므로(패턴이 이름을 요구하지 않는다) 따로 떼지 않는다.
	 */
	private static final Map<String, String> TABLE_CONSTANTS = tableConstants();

	// --- 실제 스캔 ---

	@Test
	void theMainTreeContainsNoDestructiveSqlAndNoDestructiveApiCall() throws IOException {
		assertTrue(Files.isDirectory(MAIN.resolve("java")),
				"스캔 대상이 없다 — 작업 디렉토리가 모듈 루트가 아니다: " + MAIN.resolve("java").toAbsolutePath());
		assertTrue(Files.isDirectory(MAIN.resolve("resources")),
				"리소스 트리가 없다 — 마이그레이션 SQL 이 스캔에서 빠진다: " + MAIN.resolve("resources").toAbsolutePath());
		assertTrue(scannedFileCount() >= 2,
				"스캔한 파일이 너무 적다 — 뿌리가 어긋나면 어떤 위반도 잡히지 않는다(공허한 green): " + scannedFileCount());

		List<String> hits = new ArrayList<>();
		for (Rule rule : RULES) {
			hits.addAll(scan(rule));
		}

		assertTrue(hits.isEmpty(),
				"마이그레이터 main 트리에 파괴 경로가 있다(허용은 임시 DB 드롭 1파일뿐이다): " + hits);
	}

	/** 마이그레이션 리소스가 실제로 스캔 범위 안에 있는가 — 리소스가 빠지면 SQL 군이 통째로 공허해진다. */
	@Test
	void theBaselineMigrationResourceIsInsideTheScannedTree() throws IOException {
		List<String> scanned = new ArrayList<>();
		try (Stream<Path> files = Files.walk(MAIN)) {
			for (Path file : files.filter(Files::isRegularFile).toList()) {
				scanned.add(relativePath(file));
			}
		}

		assertTrue(scanned.contains("resources/db/migration/V1__baseline.sql"),
				"기반선 SQL 이 스캔 대상에 없다: " + scanned);
	}

	// --- 예외 목록의 크기와 구성 ---

	/**
	 * 예외는 <b>정확히 1파일</b>이고 그 자리(경로)와 소속 군까지 고정이다.
	 *
	 * <p>{@code Adr008DisciplineTest.theExceptionListIsExactlyFourFiles} 의 규율이다 — 예외가 늘어나면
	 * 그 사실이 반드시 diff 와 red 로 드러난다. 목록을 넓히는 것은 그 자체가 아키텍처 결정이다.
	 */
	@Test
	void theExceptionListIsExactlyOneFile() {
		List<String> allExemptions = RULES.stream().flatMap((rule) -> rule.exemptPaths().stream()).toList();

		assertEquals(List.of(EPHEMERAL_DROP_FILE), allExemptions,
				"파괴 경로의 예외는 임시 DB 를 버리는 파일 하나뿐이고 그 경로까지 고정이다");
		assertEquals(1, allExemptions.size(), "예외 목록 크기");
		assertEquals(List.of(), DESTRUCTIVE_SQL.exemptPaths(), "파괴적 SQL 은 예외 0이다");
		assertEquals(List.of(), DESTRUCTIVE_API.exemptPaths(),
				"SQL 밖 파괴 경로는 예외 0이다 — 여기에 예외를 열면 1·2군 목록이 통째로 무의미해진다");
		assertEquals(List.of(EPHEMERAL_DROP_FILE), DROP_DATABASE.exemptPaths(), "데이터베이스 드롭 예외는 하나다");
		for (String exempt : allExemptions) {
			assertTrue(exempt.contains("/"),
					"예외 항목이 경로가 아니라 이름이다 — 이름 매칭이면 다른 패키지의 동명 파일이 예외를 가져간다: " + exempt);
		}
	}

	/** 예외 이름을 가진 파일은 리포에 <b>정확히 하나</b>이고 그 하나는 <b>등재된 자리</b>에 있다. */
	@Test
	void theExemptNameResolvesToExactlyOneFileAtItsDeclaredPath() throws IOException {
		String fileName = EPHEMERAL_DROP_FILE.substring(EPHEMERAL_DROP_FILE.lastIndexOf('/') + 1);
		List<String> found;
		try (Stream<Path> files = Files.walk(MAIN)) {
			found = files.filter(Files::isRegularFile)
					.filter((file) -> file.getFileName().toString().equals(fileName))
					.map(MigratorHasNoDestructiveSqlTest::relativePath)
					.sorted()
					.toList();
		}

		assertEquals(List.of(EPHEMERAL_DROP_FILE), found,
				"예외 이름이 붙은 파일은 등재된 자리에 정확히 하나여야 한다(0 또는 여럿·오배치는 red): " + found);
	}

	/**
	 * 예외는 <b>그 파일에서, 그 군에만</b> 적용된다 — 그리고 <b>같은 이름을 다른 패키지에 둔 파일</b>은
	 * 예외를 가져가지 못한다(2026-08-25 ⑤ 반려로 폐색된 실측 우회의 재적용).
	 */
	@Test
	void theExemptionAppliesOnlyToItsOwnFileAndItsOwnGroup() {
		assertTrue(violations(DROP_DATABASE, EPHEMERAL_DROP_FILE, "DROP DATABASE IF EXISTS x", "planted").isEmpty(),
				"임시 DB 드롭이 자기 자리에서도 막힌다 — 그러면 계약 하네스가 시작부터 red 다");
		assertFalse(violations(DROP_DATABASE, "java/harness/newsmigrator/RowCopier.java",
				"DROP DATABASE IF EXISTS x", "planted").isEmpty(), "등재되지 않은 파일의 데이터베이스 드롭까지 허용한다");
		assertFalse(violations(DESTRUCTIVE_SQL, EPHEMERAL_DROP_FILE,
				"sql(\"DELETE FROM Contents WHERE 1=1\")", "planted").isEmpty(),
				"드롭 예외가 행 삭제 군으로 새어 나간다 — 군을 쪼갠 이유가 사라진다");
		assertFalse(violations(DESTRUCTIVE_API, EPHEMERAL_DROP_FILE, "flyway.clean();", "planted").isEmpty(),
				"드롭 예외가 API 군으로 새어 나간다");
		assertFalse(violations(DROP_DATABASE, "java/harness/other/EphemeralDatabase.java",
				"DROP DATABASE IF EXISTS x", "planted").isEmpty(),
				"다른 패키지의 동명 파일이 드롭 예외를 가져간다(이름 매칭의 잔재)");
		assertFalse(violations(DROP_DATABASE, "EphemeralDatabase.java", "DROP DATABASE IF EXISTS x",
				"planted").isEmpty(), "패키지 없이 소스 루트에 둔 동명 파일이 예외를 가져간다");
	}

	// --- 자기 검사: 스캐너가 공허하지 않다 ---

	/**
	 * <b>M1·M2·M3·M5·M11 계열</b> — 실제 변이와 같은 형태를 심어 잡히는지 본다.
	 *
	 * <p>여기 있는 형태는 전부 <b>이 리포에서 실제로 게이트를 뚫었던 우회</b>이거나 그 동형이다:
	 * 끊어 쓴 문자열(2026-08-24 실측 — 원문만 보는 정규식이 놓쳤다) · 테이블 이름 상수 조립(같은 날 실측)
	 * · 클래스 한정 이름 · 대소문자 뒤섞기.
	 */
	@Test
	void theSqlScannerSeesThroughConcatenationConstantsAndCase() {
		for (String planted : List.of(
				"sql(\"DELETE FROM Contents WHERE 1=1\")",
				"sql(\"delete from\" + \" Contents WHERE 1=1\")",
				"sql(\"DROP TABLE \" + TABLES.CONTENTS)",
				"sql(\"DROP TABLE \" + CONTENTS_TABLE)",
				"sql(\"drop table \" + RequiredSchema.USER_TABLE)",
				"sql(\"DrOp TaBlE User\")",
				"sql(\"TRUNCATE TABLE Article\")",
				"sql(\"truncate\" + \" table Article\")",
				"sql(\"RENAME TABLE Contents TO Contents_old\")",
				"sql(\"DROP USER news_app\")",
				"sql(\"REPLACE INTO Contents VALUES (?)\")",
				"sql(\"INSERT OR REPLACE INTO Contents VALUES (?)\")",
				"sql(\"UPDATE Contents SET status = ?\")",
				"sql(\"update \" + TABLES.USER + \" SET password = ?\")",
				"java.sql.Statement s = c.createStatement(); s.executeUpdate(\"DELETE FROM \" + TABLES.PHOTO);")) {
			assertTrue(matches(DESTRUCTIVE_SQL, planted) || matches(DROP_DATABASE, planted),
					"파괴적 SQL 을 놓친다 — 스캐너가 공허하다: " + planted);
		}
	}

	/**
	 * <b>M4 — 리터럴 안에 주석 형태로 감춘 SQL.</b>
	 *
	 * <p>{@code String s = "-- DROP TABLE User";} 는 실행되지 않는 문자열이지만 <b>잡힌다</b>(SQL 군은
	 * 주석·리터럴을 구분하지 않으므로). 이것은 <b>의도된 과탐</b>이다 — 이 방향의 오탐은 "그 낱말을 쓰지
	 * 마라"로 해소되고, 반대 방향(놓치기)은 데이터 손실이다. 실제로 그 문자열이 나중에
	 * {@code stripLeadingComment} 한 번이면 실행 SQL 이 된다.
	 */
	@Test
	void sqlHiddenInsideACommentedOutLiteralIsStillCaught() {
		assertTrue(matches(DESTRUCTIVE_SQL, "String s = \"-- DROP TABLE User\";"),
				"리터럴 속 주석 형태의 DDL 을 놓친다");
		assertTrue(matches(DESTRUCTIVE_SQL, "// DELETE FROM Contents 는 하지 않는다"),
				"줄 주석 속 삭제문을 놓친다(SQL 군은 주석을 구분하지 않는다)");
		assertTrue(matches(DESTRUCTIVE_SQL, "/* TRUNCATE TABLE Article */"),
				"블록 주석 속 파괴문을 놓친다");
	}

	/**
	 * <b>M8·M9 — SQL 이 한 글자도 없는 파괴 경로.</b> 이 테스트가 red 를 내지 못하면 이 게이트는
	 * 이 모듈에서 공허하다(=이 step 의 존재 이유가 사라진다).
	 */
	@Test
	void theApiScannerCatchesFlywayCleanAndFileDeletionIncludingQualifiedNames() {
		for (String planted : List.of(
				// M8 — Flyway.clean(): 스키마의 전 객체를 DROP 한다.
				"flyway.clean();",
				"Flyway.configure().dataSource(ds).load().clean();",
				"flyway\n\t\t.clean();",
				"org.flywaydb.core.Flyway.configure().load().clean();",
				"configuration.cleanDisabled(false);",
				"configuration.cleanDisabled( false );",
				// M9 — 소스 파일 자체를 지우거나 옮긴다.
				"Files.deleteIfExists(source);",
				"Files.delete(source);",
				"Files.move(source, backup);",
				"java.nio.file.Files.deleteIfExists(source);",
				"java.nio.file.Files.delete(source);",
				"deleteIfExists(source);",
				"source.toFile().delete();",
				"paths.forEach(Files::delete);",
				"Files . deleteIfExists ( source );")) {
			assertTrue(matches(DESTRUCTIVE_API, planted),
					"SQL 밖 파괴 경로를 놓친다 — 이 게이트는 이 모듈에서 공허하다: " + planted);
		}
	}

	/**
	 * <b>리터럴 속 {@code //} 뒤에 숨은 API 호출</b>도 잡는다(2026-08-25 실측 우회의 재적용).
	 *
	 * <p>줄 주석을 정규식 한 방으로 지우면 {@code "jdbc:mysql://127.0.0.1"} 의 {@code //} 가 주석 시작으로
	 * 읽혀 그 줄의 나머지가 통째로 사라진다. 이 모듈의 코드에는 그 URL 이 <b>실제로</b> 들어 있으므로
	 * 우연이 아니라 손 닿는 곳의 우회다.
	 */
	@Test
	void anApiCallHidingBehindAUrlLiteralIsStillCaught() {
		assertTrue(matches(DESTRUCTIVE_API,
				"String url = \"jdbc:mysql://127.0.0.1:3306/news\"; Files.deleteIfExists(source);"),
				"URL 리터럴 속 //가 뒤따르는 파일 삭제를 가린다");
		assertTrue(matches(DESTRUCTIVE_API, "log(\"skip // \" + name); flyway.clean();"),
				"문자열 속 //가 뒤따르는 clean() 호출을 가린다");
	}

	/**
	 * 반대 방향 — API 군은 <b>규칙을 문서화</b>할 수 있어야 한다. 리터럴·주석 속 철자는 실행되는 토큰이
	 * 아니다. 이 단언이 없으면 스캔이 넓어져 자기 javadoc 을 막는 쪽으로 드리프트한다.
	 */
	@Test
	void theApiScannerAllowsTheRuleToBeDocumentedAndTheNormalApisThisModuleUses() {
		for (String allowed : List.of(
				"/** {@code flyway.clean()} 은 금지다 — 스키마의 전 객체를 DROP 한다. */",
				"// Files.deleteIfExists( 는 이 모듈에 두지 않는다.",
				"throw new IllegalStateException(\"flyway.clean() is forbidden\");",
				"String note = \"Files.delete\";",
				"configuration.cleanDisabled(true);",
				"return Flyway.configure().dataSource(url, user, password).cleanDisabled(true).load();",
				"String text = Files.readString(file, StandardCharsets.UTF_8);",
				"try (Connection connection = DriverManager.getConnection(url, user, password)) { }",
				"Files.createDirectories(out.getParent());",
				"try (OutputStream stream = Files.newOutputStream(out)) { }")) {
			assertFalse(matches(DESTRUCTIVE_API, allowed),
					"API 스캔이 정상 코드·문서화까지 막고 있다: " + allowed);
		}
	}

	/** SQL 군도 정상 코드를 막지 않는다 — 이관은 <b>삽입과 조회</b>로 이뤄진다. */
	@Test
	void theSqlScannerAllowsTheStatementsThisModuleActuallyNeeds() {
		for (String allowed : List.of(
				"sql(\"INSERT INTO Contents (articleId) VALUES (?)\")",
				"sql(\"SELECT * FROM Contents ORDER BY articleId\")",
				"sql(\"CREATE TABLE IF NOT EXISTS Contents (articleId VARCHAR(768))\")",
				"int changed = statement.executeUpdate(sql);",
				"statement.executeUpdate(\"INSERT INTO User (userId) VALUES (?)\")",
				"CREATE TABLE IF NOT EXISTS ArticleHistory (id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY)")) {
			for (Rule rule : RULES) {
				assertFalse(matches(rule, allowed), rule.name() + " 스캔이 정상 SQL 까지 막고 있다: " + allowed);
			}
		}
	}

	/** 죽은 정규식이 남지 않는다 — 모든 패턴이 심어 둔 형태 중 적어도 하나를 잡는다. */
	@Test
	void everyPatternCatchesAtLeastOnePlantedForm() {
		Map<Rule, List<String>> planted = new LinkedHashMap<>();
		planted.put(DESTRUCTIVE_SQL, List.of("DELETE FROM Contents", "DROP TABLE User", "TRUNCATE TABLE Article",
				"RENAME TABLE a TO b", "REPLACE INTO Contents VALUES (1)", "INSERT OR REPLACE INTO Contents VALUES (1)",
				"UPDATE Contents SET status = 'x'"));
		planted.put(DROP_DATABASE, List.of("DROP DATABASE news", "DROP SCHEMA news"));
		planted.put(DESTRUCTIVE_API, List.of("flyway.clean();", "clean();", "cleanDisabled(false)",
				"Files.deleteIfExists(p);", "deleteIfExists(p);", "Files::delete"));

		for (Rule rule : RULES) {
			assertFalse(rule.patterns().isEmpty(), rule.name() + " 패턴 목록이 비었다 — 그 군은 아무것도 막지 못한다");
			for (Pattern pattern : rule.patterns()) {
				assertTrue(planted.get(rule).stream()
						.anyMatch((snippet) -> pattern.matcher(normalize(rule, snippet)).find()),
						rule.name() + " 패턴이 어떤 심은 형태도 잡지 못한다(죽은 정규식): " + pattern.pattern());
			}
		}
	}

	/** 테이블 이름 상수 표는 정본에서 읽는다 — 손으로 적은 표는 정본이 늘 때 조용히 낡는다. */
	@Test
	void theTableConstantTableIsDerivedFromTheCanonicalSchema() {
		assertEquals(7, CanonicalSchema.load().tables().size(), "정본 테이블 수");
		assertTrue(TABLE_CONSTANTS.containsKey("CONTENTS_TABLE") && TABLE_CONSTANTS.containsKey("TABLES.CONTENTS"),
				"두 관용 표기를 모두 펴지 않는다: " + TABLE_CONSTANTS.keySet());
		assertEquals("ArticleHistory", TABLE_CONSTANTS.get("HISTORY_TABLE"),
				"이력 테이블 상수가 정본 이름으로 펼쳐지지 않는다");
		assertEquals("User", TABLE_CONSTANTS.get("USER_TABLE"), "사용자 테이블 상수");
	}

	// --- 판정 도구 ---

	private static long scannedFileCount() throws IOException {
		try (Stream<Path> files = Files.walk(MAIN)) {
			return files.filter(Files::isRegularFile).count();
		}
	}

	private static List<String> scan(Rule rule) throws IOException {
		List<String> hits = new ArrayList<>();
		try (Stream<Path> files = Files.walk(MAIN)) {
			for (Path file : files.filter(Files::isRegularFile).toList()) {
				hits.addAll(violations(rule, relativePath(file), Files.readString(file, StandardCharsets.UTF_8),
						file.toString()));
			}
		}
		return hits;
	}

	/**
	 * 파일 하나에 규칙 하나를 적용한다 — 예외 판정도 여기 있다(위 자기 검사가 이 함수를 직접 부른다).
	 *
	 * @param path {@link #MAIN} 기준 상대 경로. <b>이름이 아니다.</b>
	 */
	private static List<String> violations(Rule rule, String path, String source, String label) {
		if (rule.exemptPaths().contains(path)) {
			return List.of();
		}
		List<String> hits = new ArrayList<>();
		String text = normalize(rule, source);
		for (Pattern pattern : rule.patterns()) {
			if (pattern.matcher(text).find()) {
				hits.add(label + " ~ " + pattern.pattern());
			}
		}
		return hits;
	}

	private static boolean matches(Rule rule, String snippet) {
		String text = normalize(rule, snippet);
		return rule.patterns().stream().anyMatch((pattern) -> pattern.matcher(text).find());
	}

	private static String normalize(Rule rule, String source) {
		return switch (rule.normalization()) {
			case SQL_TEXT -> inlineSqlText(source);
			case CODE_TOKENS -> stripCommentsAndLiterals(source);
		};
	}

	/**
	 * 끊어 쓴 SQL 을 편다 — 테이블 이름 상수를 실제 이름으로 바꾸고 따옴표·{@code +} 를 공백으로 지운다.
	 *
	 * <p>{@code "DROP TABLE " + TABLES.CONTENTS} 가 {@code DROP TABLE Contents} 가 되고,
	 * {@code "delete from" + " Contents"} 가 {@code delete from Contents} 가 된다.
	 */
	private static String inlineSqlText(String source) {
		String out = source;
		for (Map.Entry<String, String> constant : TABLE_CONSTANTS.entrySet()) {
			out = out.replaceAll("\\b" + Pattern.quote(constant.getKey()) + "\\b", constant.getValue());
		}
		return out.replaceAll("[\"'+]", " ").replaceAll("[ \\t]+", " ");
	}

	/**
	 * 주석·문자열·문자 리터럴·텍스트 블록을 <b>공백 하나</b>로 바꾼다 — 남는 것은 실행되는 토큰뿐이다.
	 *
	 * <p>정규식 한 방({@code //[^\n]*})을 쓰지 않는 이유는 클래스 머리말에 적었다: 리터럴 속 {@code //} 가
	 * 줄 주석으로 오인돼 <b>그 줄의 위반이 통째로 사라진다</b>(2026-08-25 실측 우회).
	 */
	private static String stripCommentsAndLiterals(String source) {
		StringBuilder code = new StringBuilder(source.length());
		int i = 0;
		int end = source.length();
		while (i < end) {
			char c = source.charAt(i);
			if (c == '/' && i + 1 < end && source.charAt(i + 1) == '*') {
				int close = source.indexOf("*/", i + 2);
				i = (close < 0) ? end : close + 2;
				code.append(' ');
			}
			else if (c == '/' && i + 1 < end && source.charAt(i + 1) == '/') {
				while (i < end && source.charAt(i) != '\n') {
					i++;
				}
				code.append(' ');
			}
			else if (c == '"' && source.startsWith("\"\"\"", i)) {
				int close = source.indexOf("\"\"\"", i + 3);
				i = (close < 0) ? end : close + 3;
				code.append(' ');
			}
			else if (c == '"' || c == '\'') {
				i = skipLiteral(source, i, c);
				code.append(' ');
			}
			else {
				code.append(c);
				i++;
			}
		}
		return code.toString();
	}

	/** 여는 따옴표에서 시작해 <b>닫는 따옴표 다음</b> 인덱스를 준다(줄바꿈을 만나면 거기서 끝낸다). */
	private static int skipLiteral(String source, int open, char quote) {
		int i = open + 1;
		int end = source.length();
		while (i < end) {
			char c = source.charAt(i);
			if (c == '\\') {
				i += 2;
				continue;
			}
			if (c == quote) {
				return i + 1;
			}
			if (c == '\n') {
				return i;
			}
			i++;
		}
		return end;
	}

	private static String relativePath(Path file) {
		return MAIN.relativize(file).toString().replace('\\', '/');
	}

	/** 정본 테이블 이름에서 두 관용 상수 표기를 만든다({@code XXX_TABLE} · {@code TABLES.XXX}). */
	private static Map<String, String> tableConstants() {
		Map<String, String> constants = new LinkedHashMap<>();
		for (String table : CanonicalSchema.load().tables().keySet()) {
			String key = ("ArticleHistory".equals(table) ? "HISTORY" : table).toUpperCase(Locale.ROOT);
			constants.put(key + "_TABLE", table);
			constants.put("TABLES." + key, table);
		}
		return constants;
	}

}
