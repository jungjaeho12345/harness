package harness.newsmigrator;

import java.io.IOException;
import java.io.UncheckedIOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.sql.Connection;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Statement;
import java.time.ZoneOffset;
import java.time.ZonedDateTime;
import java.time.format.DateTimeFormatter;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.TreeSet;

/**
 * 전 테이블 행 수 · 전 컬럼 값 <b>100% 대조</b> — 이 phase 의 완료 게이트다.
 *
 * <h2>왜 DB 에게 비교를 시키지 않는가</h2>
 * 두 저장소를 {@code JOIN} 할 수도 없거니와, 한쪽 DB 안에서 {@code =} 로 비교하면 판정하는 것은
 * <b>그 컬럼의 collation</b> 이다. 대상 스키마가 서버 기본({@code utf8mb4_0900_ai_ci})으로 만들어졌다면
 * 대소문자만 다른 두 값이 "같다"고 보고된다 — 대조기가 스스로 눈을 감는다. 그래서 양쪽 값을 Java 로
 * 가져와 <b>UTF-8 바이트</b>로 비교한다({@link CellValues#sameBytes}). 그 차이는
 * {@code VerifyComparesBytesNotCollationTest} 가 같은 데이터에서 두 방식의 결론이 갈리는 것으로 실증한다.
 *
 * <h2>왜 정렬로 짝짓지 않는가</h2>
 * 양쪽을 PK 로 정렬해 나란히 읽으려면 <b>두 엔진의 정렬 순서가 같아야</b> 하는데, 그것은 다시 collation
 * 에 기대는 일이다(step1 이 {@code utf8mb4_0900_bin} 에서 일치를 실측했지만, 대조기가 그 실측에 <b>의존</b>
 * 하면 collation 이 흔들린 대상을 못 잡는다). 그래서 소스를 PK 로 색인해 두고 대상을 훑으며 짝을 지운다.
 *
 * <h2>행 수만 세지 않는 이유</h2>
 * 행 수 단언은 그물이 아니다 — 삭제 1건과 삽입 1건이 함께 일어나면 통과한다.
 *
 * <h2>이관 원장</h2>
 * 기반선을 적용하면 정본에 없는 테이블이 하나 생긴다({@code flyway_schema_history}). 그것은
 * <b>명시적으로</b> 제외하고 그 사실을 리포트에 적는다 — "정본에 없으면 무시"로 넓히면 이관이 통째로
 * 빠뜨린 테이블도 함께 조용해진다(ADR-016 트레이드오프 ⑨).
 */
public final class RowVerifier {

	private static final DateTimeFormatter STAMP = DateTimeFormatter.ofPattern("yyyyMMdd-HHmmss-SSS", Locale.ROOT);

	private RowVerifier() {
	}

	/** 불일치 하나 — <b>값 원문은 담지 않는다</b>(본문·bcrypt 해시·수집 비밀이 리포트로 샌다). */
	public record Difference(String table, String primaryKey, String column, String detail) {

		@Override
		public String toString() {
			return table() + " / " + primaryKey() + " / " + column() + ": " + detail();
		}

	}

	/** 테이블 하나의 대조 결과. 0행 테이블도 <b>반드시</b> 여기에 들어온다. */
	public record TableResult(String table, long sourceRows, long targetRows, int comparedColumns,
			List<Difference> differences) {
	}

	/** 대조 한 번의 결과. */
	public record Result(List<TableResult> tables, List<String> structuralProblems, List<String> excludedTables) {

		public boolean matched() {
			return structuralProblems().isEmpty() && differences().isEmpty();
		}

		public List<Difference> differences() {
			List<Difference> all = new ArrayList<>();
			for (TableResult table : tables()) {
				all.addAll(table.differences());
			}
			return all;
		}

		public long sourceRows() {
			return tables().stream().mapToLong(TableResult::sourceRows).sum();
		}

		public long targetRows() {
			return tables().stream().mapToLong(TableResult::targetRows).sum();
		}

	}

	/**
	 * 소스와 대상을 대조한다 — <b>양쪽 모두 읽기만</b> 한다.
	 *
	 * @throws IllegalStateException 대조 자체를 수행할 수 없을 때(접속·질의 실패)
	 */
	public static Result verify(SqliteSource source, TargetCredentials target) {
		BaselineSchema schema = BaselineSchema.load();
		List<String> problems = new ArrayList<>();
		List<TableResult> results = new ArrayList<>();
		try (Connection connection = TargetCredentials.open(target)) {
			problems.addAll(structuralProblems(source, connection, schema));
			TreeSet<String> targetTables = new TreeSet<>(String.CASE_INSENSITIVE_ORDER);
			targetTables.addAll(tableNames(connection));
			for (BaselineSchema.Table table : schema.tables()) {
				if (!targetTables.contains(table.name())) {
					results.add(new TableResult(table.name(), source.rowCount(table.name()), 0, 0,
							List.of(new Difference(table.name(), "(테이블)", "(전체)", "대상에 테이블이 없다"))));
					continue;
				}
				results.add(compare(source, connection, table));
			}
		}
		catch (SQLException ex) {
			throw new IllegalStateException("대조에 실패했다: " + target.describe(), ex);
		}
		return new Result(List.copyOf(results), List.copyOf(problems),
				List.of(BaselineSchema.MIGRATION_LEDGER_TABLE));
	}

	/** 리포트를 <b>리포 밖</b>(OS 임시 디렉토리)에 쓴다. 경로를 반환한다. */
	public static Path writeReport(Result result, Path source, TargetCredentials target) {
		Path directory = Path.of(System.getProperty("java.io.tmpdir"), "news-migrator");
		Path file = directory.resolve("verify-" + ZonedDateTime.now(ZoneOffset.UTC).format(STAMP) + ".txt");
		try {
			Files.createDirectories(directory);
			Files.writeString(file, render(result, source, target), StandardCharsets.UTF_8);
		}
		catch (IOException ex) {
			throw new UncheckedIOException(ex);
		}
		return file;
	}

	/** 사람이 읽는 리포트 본문 — <b>길이는 싣고 값은 싣지 않는다.</b> */
	public static String render(Result result, Path source, TargetCredentials target) {
		StringBuilder text = new StringBuilder();
		text.append("news-migrator verify (phase 75 / P2)\n");
		text.append("시각: ").append(ZonedDateTime.now(ZoneOffset.UTC)).append('\n');
		text.append("소스: ").append(source.toAbsolutePath()).append('\n');
		text.append("대상: ").append(target.describe()).append('\n');
		text.append("판정: ").append(result.matched() ? "일치" : "불일치").append('\n');
		text.append("대조 테이블 수: ").append(result.tables().size()).append(" · 소스 총 ").append(result.sourceRows())
				.append("행 · 대상 총 ").append(result.targetRows()).append("행\n");
		text.append("제외(대조 대상 아님): ").append(String.join(", ", result.excludedTables())).append('\n');
		text.append('\n');
		for (TableResult table : result.tables()) {
			text.append(String.format(Locale.ROOT, "%-20s 소스 %5d행 · 대상 %5d행 · 컬럼 %2d · 불일치 %d%n",
					table.table(), table.sourceRows(), table.targetRows(), table.comparedColumns(),
					table.differences().size()));
		}
		if (!result.structuralProblems().isEmpty()) {
			text.append("\n구조 문제\n");
			for (String problem : result.structuralProblems()) {
				text.append("  - ").append(problem).append('\n');
			}
		}
		if (!result.differences().isEmpty()) {
			text.append("\n불일치(값 원문은 싣지 않는다 — 길이만)\n");
			for (Difference difference : result.differences()) {
				text.append("  - ").append(difference).append('\n');
			}
		}
		return text.toString();
	}

	// --- 대조 ---

	private static List<String> structuralProblems(SqliteSource source, Connection connection, BaselineSchema schema)
			throws SQLException {
		List<String> problems = new ArrayList<>();
		TreeSet<String> expected = new TreeSet<>(String.CASE_INSENSITIVE_ORDER);
		expected.addAll(schema.tableNames());

		TreeSet<String> inSource = new TreeSet<>(String.CASE_INSENSITIVE_ORDER);
		inSource.addAll(source.tableNames());
		problems.addAll(mismatch("소스", expected, inSource));

		TreeSet<String> inTarget = new TreeSet<>(String.CASE_INSENSITIVE_ORDER);
		inTarget.addAll(tableNames(connection));
		inTarget.remove(BaselineSchema.MIGRATION_LEDGER_TABLE);
		problems.addAll(mismatch("대상", expected, inTarget));
		return problems;
	}

	private static List<String> mismatch(String side, TreeSet<String> expected, TreeSet<String> actual) {
		if (expected.equals(actual)) {
			return List.of();
		}
		TreeSet<String> unexpected = new TreeSet<>(String.CASE_INSENSITIVE_ORDER);
		unexpected.addAll(actual);
		unexpected.removeAll(expected);
		TreeSet<String> absent = new TreeSet<>(String.CASE_INSENSITIVE_ORDER);
		absent.addAll(expected);
		absent.removeAll(actual);
		List<String> problems = new ArrayList<>();
		if (!unexpected.isEmpty()) {
			problems.add(side + "에 정본에 없는 테이블이 있다: " + unexpected);
		}
		if (!absent.isEmpty()) {
			problems.add(side + "에 정본의 테이블이 없다: " + absent);
		}
		return problems;
	}

	private static TableResult compare(SqliteSource source, Connection connection, BaselineSchema.Table table)
			throws SQLException {
		List<Difference> differences = new ArrayList<>();
		Map<String, Map<String, Object>> pending = new LinkedHashMap<>();
		for (Map<String, Object> row : source.rows(table)) {
			Object key = row.get(table.primaryKey().name());
			if (key == null) {
				differences.add(new Difference(table.name(), "(NULL)", table.primaryKey().name(),
						"소스의 PK 가 NULL 이다 — 행을 짝지을 수 없다"));
				continue;
			}
			pending.put(String.valueOf(key), row);
		}
		long sourceRows = pending.size() + differences.size();

		long targetRows = 0;
		List<BaselineSchema.Column> columns = table.columns();
		String sql = "SELECT " + String.join(", ", columns.stream().map((column) -> Identifiers.quote(column.name()))
				.toList()) + " FROM " + Identifiers.quote(table.name());
		try (Statement statement = connection.createStatement(); ResultSet rows = statement.executeQuery(sql)) {
			while (rows.next()) {
				targetRows++;
				Map<String, Object> targetRow = new LinkedHashMap<>();
				for (int i = 0; i < columns.size(); i++) {
					BaselineSchema.Column column = columns.get(i);
					targetRow.put(column.name(),
							CellValues.read(rows, i + 1, column, table.name() + "." + column.name()));
				}
				String key = String.valueOf(targetRow.get(table.primaryKey().name()));
				Map<String, Object> sourceRow = pending.remove(key);
				if (sourceRow == null) {
					differences.add(new Difference(table.name(), key, "(행)", "대상에만 있는 행이다"));
					continue;
				}
				for (BaselineSchema.Column column : columns) {
					Object left = sourceRow.get(column.name());
					Object right = targetRow.get(column.name());
					if (!CellValues.sameBytes(left, right)) {
						differences.add(new Difference(table.name(), key, column.name(),
								"소스 " + CellValues.describe(left) + " ≠ 대상 " + CellValues.describe(right)));
					}
				}
			}
		}
		for (String missing : pending.keySet()) {
			differences.add(new Difference(table.name(), missing, "(행)", "대상에 없는 행이다"));
		}
		return new TableResult(table.name(), sourceRows, targetRows, columns.size(), List.copyOf(differences));
	}

	private static List<String> tableNames(Connection connection) throws SQLException {
		List<String> names = new ArrayList<>();
		try (Statement statement = connection.createStatement();
				ResultSet rows = statement.executeQuery("SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES"
						+ " WHERE TABLE_SCHEMA = DATABASE() AND TABLE_TYPE = 'BASE TABLE'")) {
			while (rows.next()) {
				names.add(rows.getString(1));
			}
		}
		return names;
	}

}
