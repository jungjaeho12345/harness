package harness.newsmigrator;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.sql.Connection;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Statement;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.TreeSet;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/**
 * 행 복사와 <b>100% 대조</b> — 이 phase 의 완료 게이트가 걸린 자리다.
 *
 * <h2>어느 DB·어느 자격인가</h2>
 * 전부 {@code news_ct} 자격의 {@code harness_ct_<16진수>} 임시 DB 이고, <b>테스트마다</b> 새로 만들고
 * 끝나면 DB 째 버린다. 대조가 무엇을 잡는지 보이려면 대상 데이터를 <b>일부러 망가뜨려야</b> 하는데,
 * {@code news_stage} 에서는 그럴 수 없고(그 자격에 갱신·삭제 권한이 없다) 그래서도 안 된다(되돌릴 수
 * 없다). {@code news}·{@code news_stage} 와 리포 {@code news.db} 는 이 테스트가 열지 않는다.
 *
 * <h2>왜 "행 수가 같다"로 끝내지 않는가</h2>
 * 행 수 단언은 그물이 아니다 — 삭제 1건과 삽입 1건이 함께 일어나면 통과한다. 그래서 <b>전 컬럼 값</b>을
 * PK 로 짝지어 바이트로 비교하고, 그 대조가 실제로 무엇을 잡는지(글자 하나 · NULL↔빈 문자열 · 사라진 행
 * · 잘린 본문 · 빈 테이블에 생긴 행)를 아래에서 하나씩 실증한다.
 */
class RowCopyOnMysqlTest {

	private static final String KEY_SET = "NEWS_CT_MYSQL";

	private static TargetCredentials server;

	@TempDir
	private Path directory;

	private String database;

	private TargetCredentials target;

	private Path sourceFile;

	@BeforeAll
	static void readCredentials() {
		server = TargetCredentials.of(KEY_SET, System::getenv);
	}

	@BeforeEach
	void createEphemeralTarget() {
		this.database = EphemeralDatabase.randomName();
		EphemeralDatabase.create(server, this.database);
		this.target = server.forDatabase(this.database);
		this.sourceFile = SqliteFixture.createSeeded(this.directory.resolve("news.db"));
	}

	@AfterEach
	void discardEphemeralTarget() {
		if (this.database != null) {
			EphemeralDatabase.drop(server, this.database);
		}
	}

	// --- 복사 ---

	@Test
	void everyRowOfEveryTableLandsInTheTargetAndTheComparisonAgrees() {
		RowCopier.Result copied = migrate();

		assertEquals(List.of("User", "Article", "Contents", "ArticleHistory", "ReceiverConfig", "DistributionTarget",
				"Photo"), copied.tables().stream().map(RowCopier.TableCopy::table).toList(),
				"복사가 정본의 7테이블을 전부 다루지 않는다");
		assertEquals(Map.of("User", 4L, "Article", 2L, "Contents", 2L, "ArticleHistory", 3L, "ReceiverConfig", 0L,
				"DistributionTarget", 0L, "Photo", 1L), counts(copied), "테이블별 복사 행 수");
		assertEquals(12L, copied.totalRows(), "총 복사 행 수");

		RowVerifier.Result verified = verify();

		assertTrue(verified.matched(), "복사 직후 대조가 불일치를 보고한다: " + verified.differences());
		assertEquals(List.of(), verified.structuralProblems(), "구조 대조가 실패했다");
		assertEquals(12L, verified.sourceRows(), "소스 총 행 수");
		assertEquals(12L, verified.targetRows(), "대상 총 행 수");
	}

	/** 빈 문자열과 NULL 은 <b>같은 컬럼에 공존</b>한다(실측) — 뭉개면 엠바고 판정이 조용히 바뀐다. */
	@Test
	void nullAndEmptyStringStayDistinctInTheTarget() throws SQLException {
		migrate();

		assertEquals("빈문자열", scalar("SELECT CASE WHEN embargoAt IS NULL THEN 'NULL' WHEN embargoAt = '' THEN"
				+ " '빈문자열' ELSE '값' END FROM Contents WHERE articleId = 'a-1'"), "빈 문자열이 NULL 이 됐다");
		assertEquals("NULL", scalar("SELECT CASE WHEN embargoAt IS NULL THEN 'NULL' WHEN embargoAt = '' THEN"
				+ " '빈문자열' ELSE '값' END FROM Contents WHERE articleId = 'a-2'"), "NULL 이 빈 문자열이 됐다");
		assertEquals("NULL", scalar("SELECT CASE WHEN targetId IS NULL THEN 'NULL' ELSE '값' END"
				+ " FROM ArticleHistory WHERE id = 1"), "정수 컬럼의 NULL 이 값이 됐다");
	}

	/** 165,802바이트 본문이 <b>잘리지 않고</b> 들어간다(step1 축 7 의 결론을 실제 이관에서 재확인한다). */
	@Test
	void theLargestTextSurvivesTheCopyUncut() throws SQLException {
		migrate();

		assertEquals(String.valueOf(SqliteFixture.LARGEST_TEXT_BYTES),
				scalar("SELECT LENGTH(markupVersion) FROM Article WHERE articleId = 'a-1'"), "본문이 잘렸다(바이트)");
		assertTrue(verify().matched(), "최대 크기 본문에서 대조가 갈린다");
	}

	/**
	 * <b>id 를 재발번하지 않는다</b> — 그리고 이관 직후의 첫 삽입이 PK 충돌로 죽지 않는다.
	 *
	 * <p>{@code ArticleHistory.id} 는 이력 원장의 순서 키다. 재발번하면 사건의 순서가 바뀌고, 자동 증가
	 * 카운터가 최댓값보다 작게 남으면 <b>이관 다음 삽입</b>이 중복 키로 실패한다.
	 */
	@Test
	void idsAreCopiedAsIsAndTheAutoIncrementCounterContinuesAfterTheMaximum() throws SQLException {
		RowCopier.Result copied = migrate();

		assertEquals(List.of(1L, 5L, 12L), longs("SELECT id FROM ArticleHistory ORDER BY id"), "id 가 재발번됐다");
		assertEquals(List.of(3L), longs("SELECT id FROM Photo ORDER BY id"), "id 가 재발번됐다");
		Map<String, Long> next = new LinkedHashMap<>();
		for (RowCopier.TableCopy table : copied.tables()) {
			if (table.nextAutoIncrement() != null) {
				next.put(table.table(), table.nextAutoIncrement());
			}
		}
		assertEquals(Map.of("ArticleHistory", 13L, "Photo", 4L, "ReceiverConfig", 1L, "DistributionTarget", 1L), next,
				"자동 증가 카운터가 max(id)+1 이 아니다 — 이관 직후 첫 삽입이 PK 충돌로 죽는다");
	}

	/** 대소문자만 다른 두 PK 가 <b>둘 다</b> 남는다(collation 이 흔들리면 여기서 중복 키로 죽는다). */
	@Test
	void primaryKeysThatDifferOnlyInCaseBothSurvive() throws SQLException {
		migrate();

		assertEquals("2", scalar("SELECT COUNT(*) FROM User WHERE userId IN ('u-3', 'U-3')"), "대소문자만 다른 PK 가 뭉개졌다");
		assertEquals("Kim", scalar("SELECT name FROM User WHERE userId = 'u-3'"), "같은 키로 취급돼 값이 섞였다");
	}

	/**
	 * <b>후행 공백만 다른 두 PK 도 둘 다 남는다</b> — 이 축은 대소문자 축과 <b>같은 등급의 인증 축</b>이다.
	 *
	 * <p>왜 따로 재는가: 대소문자와 후행 공백은 collation 의 <b>다른 성질</b>이 정한다. 대소문자는
	 * {@code _bin}/{@code _ai_ci} 가 갈리는 자리이고, 후행 공백은 <b>PAD SPACE / NO PAD</b> 가 갈리는
	 * 자리다 — {@code utf8mb4_bin} 은 이름이 {@code _bin} 이라 안전해 보이지만 <b>PAD SPACE 라
	 * {@code 'x' = 'x '} 가 참</b>이다(step1 축 3 실측). 그 collation 으로 기반선이 서면 이 이관은
	 * {@code userId} 가 하나로 뭉개진 채 "성공" 한다 = <b>다른 계정으로 로그인</b>된다.
	 *
	 * <p>대소문자 테스트만으로는 그 사고를 잡지 못한다({@code utf8mb4_bin} 은 대소문자를 구분하므로 위
	 * {@link #primaryKeysThatDifferOnlyInCaseBothSurvive} 는 green 이다). 그리고 step9 변이 M6 이 남긴
	 * 정직한 기록에 따르면 기반선 collation 드리프트를 잡는 것은 프로브 3건뿐이었다 — 이 테스트가
	 * <b>이관 경로 위에서</b> 같은 축을 한 겹 더 세운다(PAD SPACE 이면 두 번째 삽입이 중복 키로 죽는다).
	 */
	@Test
	void primaryKeysThatDifferOnlyInATrailingSpaceBothSurvive() throws SQLException {
		try (Connection connection = SqliteFixture.write(this.sourceFile);
				Statement statement = connection.createStatement()) {
			statement.executeUpdate("INSERT INTO User (userId, name, password, role, department, departmentCode,"
					+ " active, failedLoginCount) VALUES ('u-3 ', 'Trailing', 'pw-space', 'REPORTER', '사회부',"
					+ " 'D3', 'Y', '0')");
		}

		migrate();

		assertEquals("2", scalar("SELECT COUNT(*) FROM User WHERE userId IN ('u-3', 'u-3 ')"),
				"후행 공백만 다른 PK 가 뭉개졌다 — 기반선 collation 이 PAD SPACE 계열이다(인증 축이 무너진다)");
		assertEquals("Kim", scalar("SELECT name FROM User WHERE userId = 'u-3'"), "같은 키로 취급돼 값이 섞였다");
		assertEquals("Trailing", scalar("SELECT name FROM User WHERE userId = 'u-3 '"),
				"후행 공백이 있는 키가 없는 키의 행을 가리킨다");
		RowVerifier.Result verified = verify();
		assertTrue(verified.matched(), "후행 공백 PK 가 대조에서 갈렸다: " + verified.differences());
	}

	/**
	 * <b>fail-closed</b> — 대상에 이미 행이 있으면 멈춘다. 비우고 다시 넣지 않는다.
	 *
	 * <p>멱등성을 삭제로 사는 것이 이 리포에서 가장 위험한 지름길이다. 재실행하려면 사람이 빈 대상을
	 * 준비한다(런북의 일이다).
	 */
	@Test
	void aSecondMigrateIntoANonEmptyTargetStopsAndChangesNothing() throws SQLException {
		migrate();
		String before = scalar("SELECT COUNT(*) FROM Contents");

		IllegalStateException refused = assertThrows(IllegalStateException.class, this::migrate,
				"이미 행이 있는 대상에 두 번째 이관이 성공했다");

		assertTrue(refused.getMessage().contains("Contents") || refused.getMessage().contains("User"),
				"어느 테이블이 비어 있지 않은지 밝히지 않는다: " + refused.getMessage());
		assertEquals(before, scalar("SELECT COUNT(*) FROM Contents"), "거부하면서 대상을 건드렸다");
		assertTrue(verify().matched(), "거부 뒤 대상이 소스와 갈렸다");
	}

	/** 소스에 예상 밖 테이블이 있으면 <b>조용히 건너뛰지 않고</b> 멈춘다(open question (8)). */
	@Test
	void anUnexpectedTableInTheSourceStopsTheMigration() throws SQLException {
		try (Connection connection = SqliteFixture.write(this.sourceFile);
				Statement statement = connection.createStatement()) {
			statement.executeUpdate("CREATE TABLE zz_unexpected (id INTEGER PRIMARY KEY)");
		}

		IllegalStateException refused = assertThrows(IllegalStateException.class, this::migrate);

		assertTrue(refused.getMessage().contains("zz_unexpected"), "어느 테이블이 예상 밖인지 밝히지 않는다: "
				+ refused.getMessage());
	}

	// --- 대조가 무엇을 잡는가 ---

	/** <b>M1</b> — 대상에서 한 글자를 바꾸면 red 다. */
	@Test
	void aSingleChangedCharacterIsCaught() throws SQLException {
		migrate();
		execute("UPDATE Contents SET title = '제목 하나!' WHERE articleId = 'a-1'");

		RowVerifier.Result verified = verify();

		assertFalse(verified.matched(), "한 글자 차이를 대조가 통과시켰다");
		assertEquals(1, verified.differences().size(), "차이가 하나로 지목되지 않는다: " + verified.differences());
		RowVerifier.Difference difference = verified.differences().get(0);
		assertEquals("Contents", difference.table(), "어느 테이블인지");
		assertEquals("a-1", difference.primaryKey(), "어느 행인지");
		assertEquals("title", difference.column(), "어느 컬럼인지");
	}

	/** <b>M2</b> — NULL 을 빈 문자열로, 빈 문자열을 NULL 로 바꾸면 <b>양방향 모두</b> red 다. */
	@Test
	void nullTurnedIntoEmptyStringAndTheOtherDirectionAreBothCaught() throws SQLException {
		migrate();
		execute("UPDATE Contents SET embargoAt = '' WHERE articleId = 'a-2'");

		RowVerifier.Result nullToEmpty = verify();
		assertFalse(nullToEmpty.matched(), "NULL → 빈 문자열을 통과시켰다");
		assertEquals("embargoAt", nullToEmpty.differences().get(0).column(), "어느 컬럼인지");

		execute("UPDATE Contents SET embargoAt = NULL WHERE articleId = 'a-2'");
		execute("UPDATE Contents SET embargoAt = NULL WHERE articleId = 'a-1'");

		RowVerifier.Result emptyToNull = verify();
		assertFalse(emptyToNull.matched(), "빈 문자열 → NULL 을 통과시켰다");
		assertEquals("a-1", emptyToNull.differences().get(0).primaryKey(), "어느 행인지");
	}

	/** <b>M3</b> — 행 하나가 사라지면 행 수 대조와 행 짝짓기 양쪽이 red 다. */
	@Test
	void aRemovedRowIsCaughtByBothTheCountAndThePairing() throws SQLException {
		migrate();
		execute("DELETE FROM ArticleHistory WHERE id = 5");

		RowVerifier.Result verified = verify();

		assertFalse(verified.matched(), "사라진 행을 통과시켰다");
		RowVerifier.TableResult history = tableResult(verified, "ArticleHistory");
		assertEquals(3L, history.sourceRows(), "소스 행 수");
		assertEquals(2L, history.targetRows(), "대상 행 수");
		assertEquals("5", verified.differences().get(0).primaryKey(), "사라진 행의 PK 를 지목하지 않는다");
	}

	/** <b>M5</b> — 165,802바이트 본문에서 1바이트만 잘려도 red 다. */
	@Test
	void aTruncatedLargeTextIsCaught() throws SQLException {
		migrate();
		execute("UPDATE Article SET markupVersion = LEFT(markupVersion, CHAR_LENGTH(markupVersion) - 1)"
				+ " WHERE articleId = 'a-1'");

		RowVerifier.Result verified = verify();

		assertFalse(verified.matched(), "잘린 본문을 통과시켰다");
		assertEquals("markupVersion", verified.differences().get(0).column(), "어느 컬럼인지");
		assertTrue(verified.differences().get(0).detail().contains("B"),
				"양쪽 길이를 밝히지 않는다: " + verified.differences().get(0).detail());
	}

	/**
	 * <b>M4 의 방어선</b> — 0행 테이블도 대조 대상이다.
	 *
	 * <p>빈 테이블을 건너뛰면 "옮길 것이 없으니 볼 것도 없다"가 되어, 대상에만 생긴 행을 영영 못 본다.
	 */
	@Test
	void theComparisonCoversEveryTableIncludingTheEmptyOnesAndSeesRowsThatExistOnlyInTheTarget()
			throws SQLException {
		migrate();

		assertEquals(7, verify().tables().size(), "대조가 7테이블 전부를 다루지 않는다");
		assertEquals(List.of(0L, 0L), List.of(tableResult(verify(), "DistributionTarget").sourceRows(),
				tableResult(verify(), "ReceiverConfig").sourceRows()), "빈 테이블의 행 수가 보고되지 않는다");

		execute("INSERT INTO DistributionTarget (name, kind, spoolDir) VALUES ('planted', 'file', '/tmp')");

		RowVerifier.Result verified = verify();
		assertFalse(verified.matched(), "빈 테이블에 생긴 행을 통과시켰다");
		assertEquals("DistributionTarget", verified.differences().get(0).table(), "어느 테이블인지");
	}

	/**
	 * 이관 원장은 대조에서 <b>명시적으로</b> 빠지고, 그 밖의 예상 밖 테이블은 <b>구조 문제</b>로 잡힌다.
	 *
	 * <p>기반선을 적용하면 정본에 없는 테이블이 하나 생긴다({@code flyway_schema_history}). 그것을 그냥
	 * 두면 대조가 영원히 red 이고, "정본에 없으면 무시"로 넓히면 이관이 빠뜨린 테이블도 함께 사라진다.
	 */
	@Test
	void theMigrationLedgerIsExcludedButAnyOtherExtraTableIsReported() throws SQLException {
		migrate();

		RowVerifier.Result clean = verify();
		assertTrue(clean.matched(), "원장 때문에 대조가 red 다: " + clean.structuralProblems());
		assertFalse(clean.tables().stream().anyMatch((table) -> table.table().equalsIgnoreCase(
				BaselineSchema.MIGRATION_LEDGER_TABLE)), "원장이 대조 대상에 섞였다");
		assertTrue(clean.excludedTables().contains(BaselineSchema.MIGRATION_LEDGER_TABLE),
				"원장 제외가 리포트에 기록되지 않는다: " + clean.excludedTables());
		assertTrue(scalarLong("SELECT COUNT(*) FROM " + BaselineSchema.MIGRATION_LEDGER_TABLE) > 0,
				"원장이 비어 있다 — 위 단언이 공허해진다");

		execute("CREATE TABLE zz_extra (id BIGINT)");

		RowVerifier.Result verified = verify();
		assertFalse(verified.matched(), "대상의 예상 밖 테이블을 통과시켰다");
		assertTrue(String.join(" ", verified.structuralProblems()).contains("zz_extra"),
				"어느 테이블이 예상 밖인지 밝히지 않는다: " + verified.structuralProblems());
	}

	// --- 리포트·원본 ---

	@Test
	void theReportIsWrittenOutsideTheRepositoryAndNamesLengthsNeverValues() throws IOException, SQLException {
		migrate();
		execute("UPDATE User SET password = '$2b$10$0000000000000000000000' WHERE userId = 'u-1'");

		RowVerifier.Result verified = verify();
		Path report = RowVerifier.writeReport(verified, this.sourceFile, this.target);
		String text = Files.readString(report, StandardCharsets.UTF_8);

		assertFalse(report.toAbsolutePath().startsWith(Path.of("..", "..").toAbsolutePath().normalize()),
				"리포트를 리포 안에 썼다: " + report.toAbsolutePath());
		assertTrue(text.contains("User") && text.contains("password") && text.contains("u-1"),
				"불일치를 지목하지 않는다: " + text);
		assertFalse(text.contains("$2b$10$"), "리포트에 값 원문이 실렸다(bcrypt 해시가 로그로 샌다)");
		assertFalse(text.contains(this.target.password()), "리포트에 비밀번호가 실렸다");
		assertTrue(text.contains("7") && text.contains(BaselineSchema.MIGRATION_LEDGER_TABLE),
				"리포트가 테이블 수·제외 대상을 밝히지 않는다: " + text);
	}

	/** 이 phase 의 완료 게이트 — {@code migrate}·{@code verify} 뒤에도 소스는 <b>바이트 무변</b>이다. */
	@Test
	void theSourceFileIsByteIdenticalAfterMigrateAndVerify() throws IOException {
		SourceFingerprint before = SourceFingerprint.of(this.sourceFile);

		migrate();
		verify();

		before.requireUnchanged(this.sourceFile);
		assertEquals(before, SourceFingerprint.of(this.sourceFile), "소스가 바뀌었다");
		for (String suffix : SourceFingerprint.SIDECAR_SUFFIXES) {
			assertFalse(Files.exists(this.sourceFile.resolveSibling(this.sourceFile.getFileName() + suffix)),
					"이관이 소스 옆에 부산물을 남겼다: " + suffix);
		}
	}

	// --- 도구 ---

	private RowCopier.Result migrate() {
		try (SqliteSource source = SqliteSource.open(this.sourceFile)) {
			return RowCopier.migrate(source, this.target);
		}
	}

	private RowVerifier.Result verify() {
		try (SqliteSource source = SqliteSource.open(this.sourceFile)) {
			return RowVerifier.verify(source, this.target);
		}
	}

	private static Map<String, Long> counts(RowCopier.Result result) {
		Map<String, Long> counts = new LinkedHashMap<>();
		for (RowCopier.TableCopy table : result.tables()) {
			counts.put(table.table(), table.rows());
		}
		return counts;
	}

	private static RowVerifier.TableResult tableResult(RowVerifier.Result result, String table) {
		return result.tables().stream().filter((each) -> each.table().equalsIgnoreCase(table)).findFirst()
				.orElseThrow(() -> new IllegalStateException("대조 결과에 그 테이블이 없다: " + table + " / "
						+ new TreeSet<>(result.tables().stream().map(RowVerifier.TableResult::table).toList())));
	}

	/** 대상 데이터를 <b>일부러 망가뜨리는</b> 통로 — 임시 DB 전용이다(테스트 트리에만 있다). */
	private void execute(String sql) throws SQLException {
		try (Connection connection = TargetCredentials.open(this.target);
				Statement statement = connection.createStatement()) {
			statement.executeUpdate(sql);
		}
	}

	private String scalar(String sql) throws SQLException {
		try (Connection connection = TargetCredentials.open(this.target);
				Statement statement = connection.createStatement();
				ResultSet rows = statement.executeQuery(sql)) {
			return rows.next() ? rows.getString(1) : null;
		}
	}

	private long scalarLong(String sql) throws SQLException {
		return Long.parseLong(scalar(sql));
	}

	private List<Long> longs(String sql) throws SQLException {
		List<Long> values = new ArrayList<>();
		try (Connection connection = TargetCredentials.open(this.target);
				Statement statement = connection.createStatement();
				ResultSet rows = statement.executeQuery(sql)) {
			while (rows.next()) {
				values.add(rows.getLong(1));
			}
		}
		return values;
	}

}
