package harness.newsmigrator;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.sql.Connection;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Statement;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.stream.Stream;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/**
 * <b>왕복</b>({@code news.db} → MySQL → {@code export.db})이 셀 하나까지 같은가 — 이 step 의 핵심 AC 다.
 *
 * <h2>왜 역방향을 SQLite 파일로 내리는가</h2>
 * ① 소스와 <b>같은 형식</b>이라 step3 의 대조 검증기를 그대로 재사용한다(비교기가 하나면 비교 규칙도
 * 하나다) ② 그 산출물은 Node 서버가 <b>실제로 여는</b> DB 라 참조용 덤프가 아니라 작동하는 롤백 자산이다
 * ③ JSON/CSV 는 NULL 과 빈 문자열 · 숫자 표기 · 인코딩에서 <b>새 divergence 축</b>을 만든다 — 이 phase 가
 * 줄이려는 바로 그 축이다(index.json decisions (13)).
 *
 * <h2>어느 DB·어느 자격인가</h2>
 * 전부 {@code news_ct} 자격의 {@code harness_ct_<16진수>} 임시 DB 이고 <b>테스트마다</b> 새로 만들고 끝나면
 * DB 째 버린다. 왕복이 무엇을 잡는지 보이려면 MySQL 쪽 값을 <b>일부러 망가뜨려야</b> 하는데
 * {@code news_stage} 에서는 그럴 수 없고({@code news_migrator} 에 갱신 권한이 없다) 그래서도 안 된다
 * (되돌릴 수 없다). {@code news}·{@code news_stage} 와 리포 {@code news.db} 는 이 테스트가 열지 않는다.
 *
 * <h2>산출물은 어디에 쓰는가</h2>
 * {@code @TempDir} 뿐이다 — 리포 안에는 한 바이트도 쓰지 않는다. 실기 export 는 AC 의 1회 리허설이
 * 소유하고 그 경로도 리포 밖이다.
 */
class ExportRoundTripOnMysqlTest {

	private static final String KEY_SET = "NEWS_CT_MYSQL";

	private static TargetCredentials server;

	@TempDir
	private Path directory;

	private String database;

	private TargetCredentials target;

	private Path sourceFile;

	private Path out;

	@BeforeAll
	static void readCredentials() {
		server = TargetCredentials.of(KEY_SET, System::getenv);
	}

	@BeforeEach
	void createEphemeralTargetAndMigrate() {
		this.database = EphemeralDatabase.randomName();
		EphemeralDatabase.create(server, this.database);
		this.target = server.forDatabase(this.database);
		this.sourceFile = SqliteFixture.createSeeded(this.directory.resolve("news.db"));
		this.out = this.directory.resolve("export").resolve("export.db");
		try (SqliteSource source = SqliteSource.open(this.sourceFile)) {
			RowCopier.migrate(source, this.target);
		}
	}

	@AfterEach
	void discardEphemeralTarget() {
		if (this.database != null) {
			EphemeralDatabase.drop(server, this.database);
		}
	}

	// --- 핵심 AC ---

	/** 왕복 대조 <b>불일치 0</b> — 7테이블 전부 · 0행 테이블 포함 · 소스는 바이트 무변. */
	@Test
	void theRoundTripThroughMysqlAndBackAgreesCellForCell() throws IOException {
		SourceFingerprint before = SourceFingerprint.of(this.sourceFile);

		SqliteExport.Result exported = SqliteExport.export(this.target, this.out);

		assertEquals(List.of("User", "Article", "Contents", "ArticleHistory", "ReceiverConfig", "DistributionTarget",
				"Photo"), exported.tables().stream().map(SqliteExport.TableExport::table).toList(),
				"export 가 정본의 7테이블을 전부 다루지 않는다");
		assertEquals(12L, exported.totalRows(), "내려받은 총 행 수");

		RowVerifier.Result verified = roundTrip();

		assertTrue(verified.matched(), "왕복 대조가 불일치를 보고한다: " + verified.differences()
				+ " / " + verified.structuralProblems());
		assertEquals(List.of(), verified.structuralProblems(), "구조 대조가 실패했다");
		assertEquals(7, verified.tables().size(), "왕복 대조가 7테이블 전부를 다루지 않는다");
		assertEquals(12L, verified.sourceRows(), "소스 총 행 수");
		assertEquals(12L, verified.targetRows(), "산출물 총 행 수");
		assertEquals(List.of(), verified.excludedTables(),
				"SQLite ↔ SQLite 대조에는 제외 대상이 없다(이관 원장은 MySQL 쪽에만 있다): " + verified.excludedTables());

		before.requireUnchanged(this.sourceFile);
	}

	/**
	 * 산출물의 <b>카탈로그</b>가 정본으로 만든 DB 와 같다 — 컬럼 이름·순서·PK·DEFAULT.
	 *
	 * <p>{@link ExportSchemaTest} 는 DDL 문자열을 보고, 여기서는 <b>실제 파일</b>을 SQLite 에게 물어본다.
	 * 두 자리 모두 필요하다: 문자열이 맞아도 파일이 그렇게 만들어졌다는 보장은 별개이기 때문이다.
	 * 선언 타입은 affinity 로 비교한다(근거는 {@link ExportSchemaTest} 머리말).
	 */
	@Test
	void theExportedFileHasTheSameCatalogAsADatabaseBuiltFromTheCanonicalSchema() throws SQLException {
		SqliteExport.export(this.target, this.out);
		Path canonical = createCanonicalDatabase(this.directory.resolve("canonical.db"));

		assertEquals(catalog(canonical), catalog(this.out),
				"산출물의 카탈로그가 정본으로 만든 DB 와 다르다 — Node 서버가 그 파일을 열면 스키마가 갈린다");
		assertEquals(List.of(), objects(this.out, "index"),
				"산출물에 보조 인덱스가 있다(정본은 PK 자동 인덱스만 쓴다)");
		assertEquals(List.of(), objects(this.out, "trigger"), "산출물에 트리거가 있다");
	}

	/** <b>M6</b> — 이미 있는 파일은 덮어쓰지 않는다. 롤백 자산을 덮어쓰는 실수는 되돌릴 수 없다. */
	@Test
	void anExistingOutputFileIsRefusedAndLeftUntouched() throws IOException {
		SqliteExport.export(this.target, this.out);
		SourceFingerprint before = SourceFingerprint.of(this.out);

		IllegalStateException refused = assertThrows(IllegalStateException.class,
				() -> SqliteExport.export(this.target, this.out), "이미 있는 파일에 두 번째 export 가 성공했다");

		assertTrue(refused.getMessage().contains(this.out.getFileName().toString()),
				"어느 파일이 이미 있는지 밝히지 않는다: " + refused.getMessage());
		// 거부한 이유까지 본다 — "쓰다가 실패했다"와 "이미 있어서 쓰지 않았다"는 전혀 다른 사건이고,
		// 앞의 것으로도 예외는 던져진다(중복 PK). 그 둘을 구분하지 않으면 이 단언이 공허해진다.
		assertTrue(refused.getMessage().contains("덮어쓰지 않는다"),
				"거부 이유가 '덮어쓰지 않는다' 임을 밝히지 않는다: " + refused.getMessage());
		before.requireUnchanged(this.out);
	}

	// --- 왕복이 무엇을 잡는가 ---

	/** <b>M1</b> — MySQL 쪽 한 컬럼 값을 바꾸면 왕복이 red 다(어느 테이블·행·컬럼인지 지목한다). */
	@Test
	void aChangedCellInTheMiddleOfTheRoundTripIsCaught() throws SQLException {
		execute("UPDATE Contents SET title = '제목 하나!' WHERE articleId = 'a-1'");

		SqliteExport.export(this.target, this.out);
		RowVerifier.Result verified = roundTrip();

		assertFalse(verified.matched(), "MySQL 쪽에서 바뀐 한 글자를 왕복이 통과시켰다");
		assertEquals(1, verified.differences().size(), "차이가 하나로 지목되지 않는다: " + verified.differences());
		assertEquals("Contents", verified.differences().get(0).table(), "어느 테이블인지");
		assertEquals("a-1", verified.differences().get(0).primaryKey(), "어느 행인지");
		assertEquals("title", verified.differences().get(0).column(), "어느 컬럼인지");
	}

	/** <b>M2</b> — NULL 과 빈 문자열은 산출물에서도 <b>구분된 채</b> 남는다(양방향). */
	@Test
	void nullAndEmptyStringStayDistinctInTheExportedFile() throws SQLException {
		SqliteExport.export(this.target, this.out);

		assertEquals("빈문자열", exportedScalar("SELECT CASE WHEN embargoAt IS NULL THEN 'NULL'"
				+ " WHEN embargoAt = '' THEN '빈문자열' ELSE '값' END FROM Contents WHERE articleId = 'a-1'"),
				"빈 문자열이 NULL 이 됐다");
		assertEquals("NULL", exportedScalar("SELECT CASE WHEN embargoAt IS NULL THEN 'NULL'"
				+ " WHEN embargoAt = '' THEN '빈문자열' ELSE '값' END FROM Contents WHERE articleId = 'a-2'"),
				"NULL 이 빈 문자열이 됐다");
		assertEquals("NULL", exportedScalar("SELECT CASE WHEN targetId IS NULL THEN 'NULL' ELSE '값' END"
				+ " FROM ArticleHistory WHERE id = 1"), "정수 컬럼의 NULL 이 값이 됐다");
		assertEquals("integer", exportedScalar("SELECT typeof(targetId) FROM ArticleHistory WHERE id = 5"),
				"정수가 문자열로 내려왔다 — targetId 매칭이 조용히 깨진다");
		assertTrue(roundTrip().matched(), "NULL/빈 문자열 축에서 왕복이 갈린다");
	}

	/** <b>M4</b> — 165,802바이트 본문이 <b>한 바이트도 잘리지 않고</b> 내려온다. */
	@Test
	void theLargestTextComesBackUncut() throws SQLException {
		SqliteExport.export(this.target, this.out);

		assertEquals(String.valueOf(SqliteFixture.LARGEST_TEXT_BYTES),
				exportedScalar("SELECT length(CAST(markupVersion AS BLOB)) FROM Article WHERE articleId = 'a-1'"),
				"본문이 잘렸다(바이트)");
		assertTrue(roundTrip().matched(), "최대 크기 본문에서 왕복이 갈린다");
	}

	/**
	 * <b>M5</b> — id 를 재발번하지 않는다.
	 *
	 * <p>{@code ArticleHistory.id} 는 이력 원장의 순서 키이고 {@code targetId} 가 그 값으로 수신처를
	 * 가리킨다. 재발번하면 두 참조가 <b>조용히</b> 어긋난다(대조 없이는 보이지 않는다).
	 */
	@Test
	void idsAreCarriedBackAsIsAndAreNotRenumbered() throws SQLException {
		SqliteExport.export(this.target, this.out);

		assertEquals(List.of(1L, 5L, 12L), exportedLongs("SELECT id FROM ArticleHistory ORDER BY id"),
				"이력 id 가 재발번됐다");
		assertEquals(List.of(3L), exportedLongs("SELECT id FROM Photo ORDER BY id"), "사진 id 가 재발번됐다");
		assertEquals(List.of(7L), exportedLongs("SELECT targetId FROM ArticleHistory WHERE targetId IS NOT NULL"),
				"수신처 참조가 바뀌었다");
	}

	/** 대소문자만 다른 두 PK 가 <b>둘 다</b> 살아 돌아온다(뭉개지면 계정 하나가 사라진다). */
	@Test
	void primaryKeysThatDifferOnlyInCaseBothSurviveTheRoundTrip() throws SQLException {
		SqliteExport.export(this.target, this.out);

		assertEquals("2", exportedScalar("SELECT COUNT(*) FROM User WHERE userId IN ('u-3', 'U-3')"),
				"대소문자만 다른 PK 가 뭉개졌다");
		assertEquals("Kim", exportedScalar("SELECT name FROM User WHERE userId = 'u-3'"), "값이 섞였다");
	}

	/** MySQL 쪽에 정본 밖 테이블이 있으면 <b>조용히 건너뛰지 않고</b> 멈춘다(이관 원장은 예외다). */
	@Test
	void anUnexpectedTableOnTheMysqlSideStopsTheExport() throws SQLException {
		execute("CREATE TABLE zz_extra (id BIGINT)");

		IllegalStateException refused = assertThrows(IllegalStateException.class,
				() -> SqliteExport.export(this.target, this.out));

		assertTrue(refused.getMessage().contains("zz_extra"),
				"어느 테이블이 예상 밖인지 밝히지 않는다: " + refused.getMessage());
		assertFalse(Files.exists(this.out), "거부하면서 반쪽짜리 산출물을 남겼다: " + this.out);
	}

	// --- 파일 위생 ---

	/** 산출물 옆에 <b>부산물이 남지 않는다</b>({@code -wal}·{@code -shm}·{@code -journal}). */
	@Test
	void theExportLeavesNothingBesideItsOwnFile() throws IOException {
		SqliteExport.export(this.target, this.out);

		List<String> written;
		try (Stream<Path> files = Files.list(this.out.getParent())) {
			written = files.map((file) -> file.getFileName().toString()).sorted().toList();
		}
		assertEquals(List.of("export.db"), written, "산출물 디렉토리에 다른 파일이 남았다: " + written);
	}

	/** 왕복 대조 뒤에도 <b>양쪽 파일 모두</b> 바이트 무변이다 — 대조는 읽기만 한다. */
	@Test
	void bothFilesAreByteIdenticalAfterTheComparison() throws IOException {
		SqliteExport.export(this.target, this.out);
		SourceFingerprint sourceBefore = SourceFingerprint.of(this.sourceFile);
		SourceFingerprint exportBefore = SourceFingerprint.of(this.out);

		assertTrue(roundTrip().matched(), "왕복 대조가 red 다");

		assertEquals(sourceBefore, SourceFingerprint.of(this.sourceFile), "대조가 소스를 바꿨다");
		assertEquals(exportBefore, SourceFingerprint.of(this.out), "대조가 산출물을 바꿨다");
	}

	// --- 도구 ---

	private RowVerifier.Result roundTrip() {
		try (SqliteSource source = SqliteSource.open(this.sourceFile); SqliteSource exported = SqliteSource.open(this.out)) {
			return RowVerifier.verify(source, exported);
		}
	}

	/** 정본 <b>선언 순서 그대로</b>인 빈 DB({@link SqliteFixture} 는 순서를 일부러 뒤집으므로 쓸 수 없다). */
	private static Path createCanonicalDatabase(Path file) throws SQLException {
		try (Connection connection = SqliteFixture.write(file); Statement statement = connection.createStatement()) {
			for (Map.Entry<String, List<CanonicalSchema.Column>> table : CanonicalSchema.load().tables().entrySet()) {
				List<String> columns = table.getValue().stream()
						.map((column) -> column.name() + " " + column.definition()).toList();
				statement.executeUpdate("CREATE TABLE IF NOT EXISTS " + table.getKey() + " ("
						+ String.join(", ", columns) + ")");
			}
		}
		return file;
	}

	/** 테이블 → 컬럼 카탈로그 줄(위치 · 이름 · affinity · NOT NULL · DEFAULT · PK). */
	private static Map<String, List<String>> catalog(Path file) throws SQLException {
		Map<String, List<String>> catalog = new LinkedHashMap<>();
		try (Connection connection = SqliteFixture.write(file); Statement statement = connection.createStatement()) {
			for (String table : tableNames(statement)) {
				List<String> columns = new ArrayList<>();
				try (ResultSet rows = statement.executeQuery("PRAGMA table_info(\"" + table + "\")")) {
					while (rows.next()) {
						columns.add(rows.getInt("cid") + "|" + rows.getString("name") + "|"
								+ affinity(rows.getString("type")) + "|notnull=" + rows.getInt("notnull")
								+ "|default=" + rows.getString("dflt_value") + "|pk=" + rows.getInt("pk"));
					}
				}
				catalog.put(table, columns);
			}
		}
		return catalog;
	}

	private static List<String> tableNames(Statement statement) throws SQLException {
		List<String> names = new ArrayList<>();
		try (ResultSet rows = statement.executeQuery("SELECT name FROM sqlite_master WHERE type = 'table'"
				+ " AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' ORDER BY name")) {
			while (rows.next()) {
				names.add(rows.getString(1));
			}
		}
		return names;
	}

	private static List<String> objects(Path file, String type) throws SQLException {
		List<String> names = new ArrayList<>();
		try (Connection connection = SqliteFixture.write(file);
				Statement statement = connection.createStatement();
				ResultSet rows = statement.executeQuery("SELECT name FROM sqlite_master WHERE type = '" + type
						+ "' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' ORDER BY name")) {
			while (rows.next()) {
				names.add(rows.getString(1));
			}
		}
		return names;
	}

	/** SQLite 의 선언 타입 → affinity(앞의 두 단계만 쓴다 — 그 밖은 이름을 그대로 남겨 대조가 실패하게 둔다). */
	private static String affinity(String type) {
		String upper = (type == null) ? "" : type.toUpperCase(Locale.ROOT);
		if (upper.contains("INT")) {
			return "INTEGER";
		}
		if (upper.contains("CHAR") || upper.contains("CLOB") || upper.contains("TEXT")) {
			return "TEXT";
		}
		return "예상 밖 선언: " + type;
	}

	/** 대상 데이터를 <b>일부러 망가뜨리는</b> 통로 — 임시 DB 전용이다(테스트 트리에만 있다). */
	private void execute(String sql) throws SQLException {
		try (Connection connection = TargetCredentials.open(this.target);
				Statement statement = connection.createStatement()) {
			statement.executeUpdate(sql);
		}
	}

	private String exportedScalar(String sql) throws SQLException {
		try (Connection connection = SqliteFixture.write(this.out);
				Statement statement = connection.createStatement();
				ResultSet rows = statement.executeQuery(sql)) {
			return rows.next() ? rows.getString(1) : null;
		}
	}

	private List<Long> exportedLongs(String sql) throws SQLException {
		List<Long> values = new ArrayList<>();
		try (Connection connection = SqliteFixture.write(this.out);
				Statement statement = connection.createStatement();
				ResultSet rows = statement.executeQuery(sql)) {
			while (rows.next()) {
				values.add(rows.getLong(1));
			}
		}
		return values;
	}

}
