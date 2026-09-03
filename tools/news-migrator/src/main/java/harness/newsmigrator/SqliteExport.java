package harness.newsmigrator;

import java.io.IOException;
import java.io.UncheckedIOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.PreparedStatement;
import java.sql.SQLException;
import java.sql.Statement;
import java.sql.Types;
import java.util.ArrayList;
import java.util.List;
import java.util.TreeSet;

/**
 * 역방향 export — MySQL 스키마 한 벌을 <b>SQLite 파일 하나</b>로 내린다.
 *
 * <h2>왜 SQLite 파일인가</h2>
 * ① 소스와 <b>같은 형식</b>이라 대조 검증기({@link RowVerifier})를 그대로 재사용한다 — 비교기가 하나면
 * 비교 규칙도 하나다 ② 산출물이 Node 서버가 <b>실제로 여는</b> DB 라 참조용 덤프가 아니라 작동하는 롤백
 * 자산이 된다 ③ JSON/CSV 는 NULL 과 빈 문자열 · 숫자 표기 · 인코딩에서 <b>새 divergence 축</b>을 만든다
 * (이 phase 가 줄이려는 바로 그 축이다 — index.json decisions (13)).
 *
 * <h2>이미 있는 파일은 덮어쓰지 않는다</h2>
 * 롤백 자산을 덮어쓰는 실수는 되돌릴 수 없다. 그래서 파일이(그리고 그 부산물이) 있으면 <b>접속하기
 * 전에</b> 멈춘다. 이 검사가 자격 조회보다 앞이라는 점이 계약의 일부다 — 뒤에 두면 "덮어쓰지 않는다"는
 * 판정이 접속 성공 여부에 매달린다.
 *
 * <h2>실패하면 반쪽 파일이 남는다(그리고 우리는 그것을 지우지 않는다)</h2>
 * 이 모듈에는 파일을 지우거나 옮기는 경로가 없다 — 정적 게이트가 그것을 금지하고
 * ({@code MigratorHasNoDestructiveSqlTest} 3군), 그 금지는 "원본 {@code news.db} 를 SQL 한 줄 없이
 * 날리는" 경로를 막기 위해 있다. 그 대가로 <b>중간에 실패하면 빈 파일이 남는다</b>. 그것을 숨기지 않고
 * 실패 메시지가 경로를 밝히며, 사람이 치우기 전에는 재실행이 위 규칙에 걸려 멈춘다. 임시 파일에 쓰고
 * 마지막에 옮기는 흔한 설계를 택하지 않은 이유가 이것이다 — 그 설계는 파일 이동 권한을 요구하고,
 * 이 도구에서 그 권한은 완료 게이트 자체를 무너뜨릴 수 있는 도구가 된다.
 *
 * <h2>내용은 그대로 옮긴다</h2>
 * id 를 다시 매기지 않고(이력 원장의 순서 키이자 배부 수신처 참조다), NULL 과 빈 문자열을 구분하며,
 * 정수와 문자열을 섞지 않는다({@link CellValues} 의 규칙 그대로다). 값 변환은 이관이 <b>동작을 바꾸는</b>
 * 일이고, 그 금지가 이 phase 의 전제다.
 */
public final class SqliteExport {

	private SqliteExport() {
	}

	/** 테이블 하나의 내려받기 결과. */
	public record TableExport(String table, long rows) {
	}

	/** export 한 번의 결과. */
	public record Result(Path file, List<TableExport> tables) {

		public long totalRows() {
			return tables().stream().mapToLong(TableExport::rows).sum();
		}

	}

	/**
	 * MySQL 스키마를 SQLite 파일로 내린다.
	 *
	 * @param source 읽을 MySQL 자격(<b>읽기만</b> 한다)
	 * @param out 만들 파일 — 이미 있으면 실패한다
	 * @return 테이블별 행 수
	 * @throws IllegalStateException 산출물이 이미 있거나 · 대상 구조가 정본과 다르거나 · 내려받기가 실패했을 때
	 */
	public static Result export(TargetCredentials source, Path out) {
		Path file = out.toAbsolutePath().normalize();
		requireAbsent(file);
		BaselineSchema schema = BaselineSchema.load();
		List<TableExport> written = new ArrayList<>();
		try (MysqlSide side = MysqlSide.open(source)) {
			requireSameStructure(side, schema);
			createParentDirectory(file);
			try (Connection connection = DriverManager.getConnection("jdbc:sqlite:" + file)) {
				connection.setAutoCommit(false);
				try {
					createSchema(connection, schema);
					for (BaselineSchema.Table table : schema.tables()) {
						written.add(new TableExport(table.name(), copy(connection, side, table)));
					}
					connection.commit();
				}
				catch (SQLException | RuntimeException ex) {
					connection.rollback();
					throw ex;
				}
				finally {
					connection.setAutoCommit(true);
				}
			}
			// 실패 원인이 SQL 이든 매핑 규칙 위반이든 사람이 알아야 할 것은 같다: 만들다 만 파일이 어디에
			// 남았는가. 그래서 두 갈래를 한 메시지로 모은다(원인 예외는 그대로 붙여 보낸다).
			catch (SQLException | RuntimeException ex) {
				throw new IllegalStateException("역방향 export 에 실패했다 — 만들다 만 파일이 남아 있으니 사람이 치운 뒤"
						+ " 다시 실행하라(이 도구는 파일을 지우지 않는다): " + file, ex);
			}
		}
		requireNoSidecars(file);
		return new Result(file, List.copyOf(written));
	}

	/**
	 * 산출물 자리가 <b>비어 있는지</b> 확인한다 — 파일도, SQLite 부산물도 없어야 한다.
	 *
	 * <p>부산물까지 보는 이유: {@code -wal}/{@code -journal} 만 남아 있는 자리는 앞선 실행이 끝나지 않은
	 * 흔적이다. 그 위에 새로 쓰면 사람이 무엇을 보고 있는지 알 수 없게 된다.
	 *
	 * @throws IllegalStateException 그 자리에 무엇인가 있을 때
	 */
	public static void requireAbsent(Path out) {
		Path file = out.toAbsolutePath().normalize();
		if (Files.exists(file)) {
			throw new IllegalStateException("산출물이 이미 있다(덮어쓰지 않는다 — 되돌릴 수 없다): " + file);
		}
		for (String suffix : SourceFingerprint.SIDECAR_SUFFIXES) {
			Path sidecar = file.resolveSibling(file.getFileName() + suffix);
			if (Files.exists(sidecar)) {
				throw new IllegalStateException("산출물 자리에 부산물이 남아 있다(앞선 실행이 끝나지 않았다): " + sidecar);
			}
		}
	}

	// --- 단계 ---

	/** 대상 스키마가 정본 그대로인지 본다 — 모자라거나 남으면 <b>조용히 건너뛰지 않고</b> 멈춘다. */
	private static void requireSameStructure(MysqlSide side, BaselineSchema schema) {
		TreeSet<String> expected = new TreeSet<>(String.CASE_INSENSITIVE_ORDER);
		expected.addAll(schema.tableNames());
		TreeSet<String> actual = new TreeSet<>(String.CASE_INSENSITIVE_ORDER);
		actual.addAll(side.tableNames());
		if (expected.equals(actual)) {
			return;
		}
		TreeSet<String> unexpected = new TreeSet<>(String.CASE_INSENSITIVE_ORDER);
		unexpected.addAll(actual);
		unexpected.removeAll(expected);
		TreeSet<String> absent = new TreeSet<>(String.CASE_INSENSITIVE_ORDER);
		absent.addAll(expected);
		absent.removeAll(actual);
		throw new IllegalStateException("대상의 테이블 집합이 기반선과 다르다(반쪽짜리 산출물을 만들지 않는다)"
				+ " — 예상 밖: " + unexpected + " · 없는 것: " + absent + " · 제외: " + side.excludedTables());
	}

	private static void createParentDirectory(Path file) {
		Path parent = file.getParent();
		if (parent == null) {
			return;
		}
		try {
			Files.createDirectories(parent);
		}
		catch (IOException ex) {
			throw new UncheckedIOException(ex);
		}
	}

	private static void createSchema(Connection connection, BaselineSchema schema) throws SQLException {
		try (Statement statement = connection.createStatement()) {
			for (String ddl : ExportSchema.ddl(schema)) {
				statement.executeUpdate(ddl);
			}
		}
	}

	/** 한 테이블을 통째로 옮긴다 — 삽입만 한다(정본 컬럼 순서 그대로 · 이름으로 바인딩). */
	private static long copy(Connection connection, MysqlSide side, BaselineSchema.Table table) throws SQLException {
		List<BaselineSchema.Column> columns = table.columns();
		StringBuilder sql = new StringBuilder("INSERT INTO ").append(Identifiers.quoteAnsi(table.name())).append(" (");
		for (int i = 0; i < columns.size(); i++) {
			sql.append((i == 0) ? "" : ", ").append(Identifiers.quoteAnsi(columns.get(i).name()));
		}
		sql.append(") VALUES (");
		for (int i = 0; i < columns.size(); i++) {
			sql.append((i == 0) ? "?" : ", ?");
		}
		sql.append(")");

		// 한 배치의 크기는 복사기와 같은 상수를 쓴다 — 두 방향이 같은 리듬으로 움직여야 한 쪽만 메모리에
		// 통째로 올라오는 일이 없다(최악의 행은 실측 165,802바이트다).
		long[] read = { 0 };
		long[] inserted = { 0 };
		int[] pending = { 0 };
		try (PreparedStatement statement = connection.prepareStatement(sql.toString())) {
			side.forEachRow(table, (row) -> {
				try {
					read[0]++;
					for (int i = 0; i < columns.size(); i++) {
						bind(statement, i + 1, columns.get(i), row.get(columns.get(i).name()));
					}
					statement.addBatch();
					pending[0]++;
					if (pending[0] == RowCopier.BATCH_ROWS) {
						inserted[0] += count(statement.executeBatch());
						pending[0] = 0;
					}
				}
				catch (SQLException ex) {
					throw new IllegalStateException(table.name() + ": 행을 옮기지 못했다", ex);
				}
			});
			if (pending[0] > 0) {
				inserted[0] += count(statement.executeBatch());
			}
		}
		if (inserted[0] != read[0]) {
			throw new IllegalStateException(table.name() + ": 내려받은 행 수가 대상과 다르다 — 대상 " + read[0]
					+ " · 산출물 " + inserted[0] + " (부분 성공을 성공으로 보고하지 않는다)");
		}
		return inserted[0];
	}

	/**
	 * 산출물 옆에 부산물이 남지 않았는지 본다.
	 *
	 * <p>남았다면 연결이 제대로 닫히지 않았다는 뜻이고, 그 파일을 그대로 옮겨 두면 나중에 <b>열리지 않는</b>
	 * 롤백 자산이 된다.
	 */
	private static void requireNoSidecars(Path file) {
		List<String> found = new ArrayList<>();
		for (String suffix : SourceFingerprint.SIDECAR_SUFFIXES) {
			Path sidecar = file.resolveSibling(file.getFileName() + suffix);
			if (Files.exists(sidecar)) {
				found.add(sidecar.getFileName().toString());
			}
		}
		if (!found.isEmpty()) {
			throw new IllegalStateException("산출물 옆에 부산물이 남았다 " + found
					+ " — 그대로 보관하면 열리지 않는 롤백 자산이 된다: " + file);
		}
	}

	private static void bind(PreparedStatement statement, int index, BaselineSchema.Column column, Object value)
			throws SQLException {
		if (value == null) {
			statement.setNull(index, column.integer() ? Types.BIGINT : Types.VARCHAR);
			return;
		}
		if (value instanceof Long number) {
			statement.setLong(index, number);
			return;
		}
		if (value instanceof String text) {
			statement.setString(index, text);
			return;
		}
		throw new IllegalStateException(column.name() + ": 매핑 규칙이 다루지 않는 값 종류다 "
				+ value.getClass().getSimpleName());
	}

	private static long count(int[] results) {
		long inserted = 0;
		for (int result : results) {
			if (result == Statement.SUCCESS_NO_INFO || result > 0) {
				inserted++;
			}
		}
		return inserted;
	}

}
