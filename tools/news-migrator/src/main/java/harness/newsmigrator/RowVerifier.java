package harness.newsmigrator;

import java.io.IOException;
import java.io.UncheckedIOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
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
 * <h2>양쪽이 대칭이다(step4)</h2>
 * 대조기는 저장소가 아니라 {@link ComparisonSide} 를 본다. 그래서 같은 판정 규칙이 <b>SQLite → MySQL</b>
 * (이관 검증)에도 <b>SQLite ↔ SQLite</b>(왕복 검증)에도 그대로 쓰인다. 방향마다 대조기를 따로 두면
 * 규칙이 두 벌이 되고, 갈리는 쪽은 언제나 덜 엄격한 쪽이다.
 *
 * <h2>이관 원장</h2>
 * 기반선을 적용하면 정본에 없는 테이블이 하나 생긴다({@code flyway_schema_history}). 그것은
 * <b>명시적으로</b> 제외하고 그 사실을 리포트에 적는다 — "정본에 없으면 무시"로 넓히면 이관이 통째로
 * 빠뜨린 테이블도 함께 조용해진다(ADR-016 트레이드오프 ⑨). 제외는 그 이름을 가진 쪽
 * ({@link MysqlSide})의 성질이므로, SQLite ↔ SQLite 대조에서는 제외 목록이 비어 있다.
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
	 * 소스 파일과 MySQL 대상을 대조한다(이관 검증) — <b>양쪽 모두 읽기만</b> 한다.
	 *
	 * @throws IllegalStateException 대조 자체를 수행할 수 없을 때(접속·질의 실패)
	 */
	public static Result verify(SqliteSource source, TargetCredentials target) {
		try (MysqlSide targetSide = MysqlSide.open(target)) {
			return verify(source, targetSide);
		}
	}

	/**
	 * 두 쪽을 대조한다 — <b>양쪽 모두 읽기만</b> 한다.
	 *
	 * <p>왕복 검증({@code news.db} ↔ 역방향 산출물)이 부르는 것이 이 형태다.
	 *
	 * @throws IllegalStateException 대조 자체를 수행할 수 없을 때(접속·질의 실패)
	 */
	public static Result verify(ComparisonSide source, ComparisonSide target) {
		BaselineSchema schema = BaselineSchema.load();
		List<String> problems = new ArrayList<>();
		problems.addAll(mismatch("소스", schema.tableNames(), source.tableNames()));
		problems.addAll(mismatch("대상", schema.tableNames(), target.tableNames()));

		TreeSet<String> inSource = caseInsensitive(source.tableNames());
		TreeSet<String> inTarget = caseInsensitive(target.tableNames());
		List<TableResult> results = new ArrayList<>();
		for (BaselineSchema.Table table : schema.tables()) {
			if (!inSource.contains(table.name())) {
				results.add(new TableResult(table.name(), 0, 0, 0,
						List.of(new Difference(table.name(), "(테이블)", "(전체)", "소스에 테이블이 없다"))));
				continue;
			}
			results.add(compare(source, target, table, inTarget.contains(table.name())));
		}

		TreeSet<String> excluded = new TreeSet<>();
		excluded.addAll(source.excludedTables());
		excluded.addAll(target.excludedTables());
		return new Result(List.copyOf(results), List.copyOf(problems), List.copyOf(excluded));
	}

	/** 리포트를 <b>리포 밖</b>(OS 임시 디렉토리)에 쓴다. 경로를 반환한다. */
	public static Path writeReport(Result result, Path source, TargetCredentials target) {
		return writeReport(result, source.toAbsolutePath().toString(), target.describe());
	}

	/** 리포트를 <b>리포 밖</b>(OS 임시 디렉토리)에 쓴다 — 양쪽을 이름으로만 받는다. */
	public static Path writeReport(Result result, String source, String target) {
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
		return render(result, source.toAbsolutePath().toString(), target.describe());
	}

	/** 사람이 읽는 리포트 본문 — <b>길이는 싣고 값은 싣지 않는다.</b> */
	public static String render(Result result, String source, String target) {
		StringBuilder text = new StringBuilder();
		text.append("news-migrator verify (phase 75 / P2)\n");
		text.append("시각: ").append(ZonedDateTime.now(ZoneOffset.UTC)).append('\n');
		text.append("소스: ").append(source).append('\n');
		text.append("대상: ").append(target).append('\n');
		text.append("판정: ").append(result.matched() ? "일치" : "불일치").append('\n');
		text.append("대조 테이블 수: ").append(result.tables().size()).append(" · 소스 총 ").append(result.sourceRows())
				.append("행 · 대상 총 ").append(result.targetRows()).append("행\n");
		text.append("제외(대조 대상 아님): ")
				.append(result.excludedTables().isEmpty() ? "없음" : String.join(", ", result.excludedTables()))
				.append('\n');
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

	private static TreeSet<String> caseInsensitive(List<String> names) {
		TreeSet<String> set = new TreeSet<>(String.CASE_INSENSITIVE_ORDER);
		set.addAll(names);
		return set;
	}

	private static List<String> mismatch(String side, List<String> expectedNames, List<String> actualNames) {
		TreeSet<String> expected = caseInsensitive(expectedNames);
		TreeSet<String> actual = caseInsensitive(actualNames);
		if (expected.equals(actual)) {
			return List.of();
		}
		TreeSet<String> unexpected = caseInsensitive(actualNames);
		unexpected.removeAll(expected);
		TreeSet<String> absent = caseInsensitive(expectedNames);
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

	/**
	 * 테이블 하나를 대조한다 — 소스를 PK 로 색인하고 대상을 훑으며 짝을 지운다.
	 *
	 * <p>{@code targetHasTable} 이 거짓이면 대상 쪽은 읽지 않는다(질의가 실패할 자리다). 그래도 소스 쪽
	 * 행 수는 세서 보고한다 — "대상에 테이블이 없다" 는 진단은 몇 행을 잃었는지까지 말해야 쓸모가 있다.
	 */
	private static TableResult compare(ComparisonSide source, ComparisonSide target, BaselineSchema.Table table,
			boolean targetHasTable) {
		List<Difference> differences = new ArrayList<>();
		Map<String, Map<String, Object>> pending = new LinkedHashMap<>();
		source.forEachRow(table, (row) -> {
			Object key = row.get(table.primaryKey().name());
			if (key == null) {
				differences.add(new Difference(table.name(), "(NULL)", table.primaryKey().name(),
						"소스의 PK 가 NULL 이다 — 행을 짝지을 수 없다"));
				return;
			}
			pending.put(String.valueOf(key), row);
		});
		long sourceRows = pending.size() + differences.size();
		if (!targetHasTable) {
			differences.add(new Difference(table.name(), "(테이블)", "(전체)", "대상에 테이블이 없다"));
			return new TableResult(table.name(), sourceRows, 0, 0, List.copyOf(differences));
		}

		List<BaselineSchema.Column> columns = table.columns();
		long[] targetRows = { 0 };
		target.forEachRow(table, (targetRow) -> {
			targetRows[0]++;
			String key = String.valueOf(targetRow.get(table.primaryKey().name()));
			Map<String, Object> sourceRow = pending.remove(key);
			if (sourceRow == null) {
				differences.add(new Difference(table.name(), key, "(행)", "대상에만 있는 행이다"));
				return;
			}
			for (BaselineSchema.Column column : columns) {
				Object left = sourceRow.get(column.name());
				Object right = targetRow.get(column.name());
				if (!CellValues.sameBytes(left, right)) {
					differences.add(new Difference(table.name(), key, column.name(),
							"소스 " + CellValues.describe(left) + " ≠ 대상 " + CellValues.describe(right)));
				}
			}
		});
		for (String missing : pending.keySet()) {
			differences.add(new Difference(table.name(), missing, "(행)", "대상에 없는 행이다"));
		}
		return new TableResult(table.name(), sourceRows, targetRows[0], columns.size(), List.copyOf(differences));
	}

}
