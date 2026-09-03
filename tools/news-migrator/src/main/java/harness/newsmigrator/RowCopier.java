package harness.newsmigrator;

import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Statement;
import java.sql.Types;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.TreeSet;

/**
 * 전 행 복사 — <b>삽입만으로</b> 완결된다.
 *
 * <h2>순서와 그 이유</h2>
 * <ol>
 * <li><b>소스 구조 확인</b>(테이블·컬럼) — 기반선이 모르는 테이블이 소스에 있으면 조용히 건너뛰지 않고
 * 멈춘다. 건너뛰면 "전 행 이관 성공"이라는 보고가 거짓이 된다(open question (8)).</li>
 * <li><b>기반선 적용</b>(Flyway) — 스키마의 정본은 이 모듈이 소유한다.</li>
 * <li><b>대상 비어 있음 확인(fail-closed)</b> — 한 행이라도 있으면 멈춘다. 비우고 다시 넣는 길은 두지
 * 않는다. 멱등성을 삭제로 사는 것이 이 리포에서 가장 위험한 지름길이고, 재실행은 사람이 빈 대상을
 * 준비하는 것으로 한다(런북).</li>
 * <li><b>복사</b> — 한 트랜잭션 안에서 7테이블을 전부 넣고 마지막에 한 번 커밋한다. 테이블마다 커밋하면
 * 중간 실패가 "일부는 들어간 대상"을 남기고, 그 상태는 위 3번 때문에 재실행도 안 된다. 전부 아니면
 * 전무여야 사람이 그냥 다시 돌릴 수 있다.</li>
 * <li><b>자동 증가 카운터 확인</b> — {@code max(id)+1} 이 아니면 이관 직후 <b>첫 삽입이 PK 충돌로 죽는다.</b>
 * 이관 당일에는 보이지 않고 다음 사용자가 겪는 종류의 고장이라 여기서 잡는다.</li>
 * </ol>
 *
 * <h2>왜 id 를 그대로 넣는가</h2>
 * {@code ArticleHistory.id} 는 이력 원장의 순서 키이고 {@code targetId} 는 그 값으로 배부 수신처를
 * 가리킨다. 재발번하면 두 참조가 조용히 어긋난다.
 */
public final class RowCopier {

	/**
	 * 한 배치에 넣는 행 수.
	 *
	 * <p>50인 이유: 최악의 행({@code Article.markupVersion} 실측 최댓값 165,802바이트)만 모여도 한 배치가
	 * 약 8 MB 로 서버의 {@code max_allowed_packet}(실측 64 MiB)에 한참 못 미친다. 더 키워서 얻을 것은
	 * 178행짜리 이관에서 의미가 없고, 넘치면 원인이 모호한 통신 오류로 나타난다.
	 */
	static final int BATCH_ROWS = 50;

	private RowCopier() {
	}

	/** 테이블 하나의 복사 결과. {@code nextAutoIncrement} 는 정수 PK 테이블에만 있다. */
	public record TableCopy(String table, long rows, Long nextAutoIncrement) {
	}

	/** 이관 한 번의 결과. */
	public record Result(List<TableCopy> tables) {

		public long totalRows() {
			return tables().stream().mapToLong(TableCopy::rows).sum();
		}

	}

	/**
	 * 소스의 전 행을 대상으로 옮긴다.
	 *
	 * @throws IllegalStateException 구조가 다르거나 · 대상이 비어 있지 않거나 · 복사가 실패했을 때
	 */
	public static Result migrate(SqliteSource source, TargetCredentials target) {
		BaselineSchema schema = BaselineSchema.load();
		requireSameStructure(source, schema);
		MigratorFlyway.forTarget(target).migrate();

		List<TableCopy> copied = new ArrayList<>();
		try (Connection connection = TargetCredentials.open(target)) {
			requireEmptyTarget(connection, schema);
			connection.setAutoCommit(false);
			try {
				for (BaselineSchema.Table table : schema.tables()) {
					copied.add(new TableCopy(table.name(), copy(connection, table, source.rows(table)), null));
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
			return new Result(withAutoIncrement(connection, schema, copied));
		}
		catch (SQLException ex) {
			throw new IllegalStateException("이관에 실패했다(부분 성공은 커밋되지 않았다): " + target.describe(), ex);
		}
	}

	// --- 단계 ---

	private static void requireSameStructure(SqliteSource source, BaselineSchema schema) {
		TreeSet<String> expected = new TreeSet<>(String.CASE_INSENSITIVE_ORDER);
		expected.addAll(schema.tableNames());
		TreeSet<String> actual = new TreeSet<>(String.CASE_INSENSITIVE_ORDER);
		actual.addAll(source.tableNames());
		if (!expected.equals(actual)) {
			TreeSet<String> unexpected = new TreeSet<>(String.CASE_INSENSITIVE_ORDER);
			unexpected.addAll(actual);
			unexpected.removeAll(expected);
			TreeSet<String> absent = new TreeSet<>(String.CASE_INSENSITIVE_ORDER);
			absent.addAll(expected);
			absent.removeAll(actual);
			throw new IllegalStateException("소스의 테이블 집합이 기반선과 다르다(조용히 건너뛰지 않는다)"
					+ " — 예상 밖: " + unexpected + " · 없는 것: " + absent);
		}
		for (BaselineSchema.Table table : schema.tables()) {
			TreeSet<String> expectedColumns = new TreeSet<>(String.CASE_INSENSITIVE_ORDER);
			expectedColumns.addAll(table.columnNames());
			TreeSet<String> actualColumns = new TreeSet<>(String.CASE_INSENSITIVE_ORDER);
			actualColumns.addAll(source.columnNames(table.name()));
			if (!expectedColumns.equals(actualColumns)) {
				throw new IllegalStateException("소스 " + table.name() + " 의 컬럼 집합이 기반선과 다르다"
						+ " — 소스: " + actualColumns + " · 기반선: " + expectedColumns);
			}
		}
	}

	private static void requireEmptyTarget(Connection connection, BaselineSchema schema) throws SQLException {
		List<String> occupied = new ArrayList<>();
		for (BaselineSchema.Table table : schema.tables()) {
			if (rowCount(connection, table.name()) > 0) {
				occupied.add(table.name());
			}
		}
		if (!occupied.isEmpty()) {
			throw new IllegalStateException("대상이 비어 있지 않다 " + occupied
					+ " — 비우고 다시 넣지 않는다. 재실행하려면 빈 대상 DB 를 준비하라(docs/ops-mysql.md).");
		}
	}

	private static long copy(Connection connection, BaselineSchema.Table table, List<Map<String, Object>> rows)
			throws SQLException {
		if (rows.isEmpty()) {
			return 0L;
		}
		List<BaselineSchema.Column> columns = table.columns();
		StringBuilder sql = new StringBuilder("INSERT INTO ").append(Identifiers.quote(table.name())).append(" (");
		for (int i = 0; i < columns.size(); i++) {
			sql.append((i == 0) ? "" : ", ").append(Identifiers.quote(columns.get(i).name()));
		}
		sql.append(") VALUES (");
		for (int i = 0; i < columns.size(); i++) {
			sql.append((i == 0) ? "?" : ", ?");
		}
		sql.append(")");

		long inserted = 0;
		try (PreparedStatement statement = connection.prepareStatement(sql.toString())) {
			int pending = 0;
			for (Map<String, Object> row : rows) {
				for (int i = 0; i < columns.size(); i++) {
					bind(statement, i + 1, columns.get(i), row.get(columns.get(i).name()));
				}
				statement.addBatch();
				pending++;
				if (pending == BATCH_ROWS) {
					inserted += count(statement.executeBatch());
					pending = 0;
				}
			}
			if (pending > 0) {
				inserted += count(statement.executeBatch());
			}
		}
		if (inserted != rows.size()) {
			throw new IllegalStateException(table.name() + ": 삽입된 행 수가 소스와 다르다 — 소스 " + rows.size()
					+ " · 삽입 " + inserted + " (부분 성공을 성공으로 보고하지 않는다)");
		}
		return inserted;
	}

	private static List<TableCopy> withAutoIncrement(Connection connection, BaselineSchema schema,
			List<TableCopy> copied) throws SQLException {
		// 정확한 값을 읽기 위해 통계 캐시를 끈다 — 기본값(86400초)이면 오래된 값이 돌아온다.
		try (Statement statement = connection.createStatement()) {
			statement.execute("SET SESSION information_schema_stats_expiry = 0");
		}
		List<TableCopy> withCounters = new ArrayList<>();
		for (TableCopy table : copied) {
			BaselineSchema.Table declared = schema.table(table.table());
			if (!declared.primaryKey().integer()) {
				withCounters.add(table);
				continue;
			}
			long next = autoIncrementOf(connection, declared.name());
			long expected = maxKey(connection, declared) + 1;
			if (next != expected) {
				throw new IllegalStateException(declared.name() + ": 자동 증가 카운터가 " + next + " 다(기대 " + expected
						+ ") — 이관 직후 첫 삽입이 PK 충돌로 죽는다");
			}
			withCounters.add(new TableCopy(table.table(), table.rows(), next));
		}
		return withCounters;
	}

	private static long autoIncrementOf(Connection connection, String table) throws SQLException {
		try (PreparedStatement statement = connection.prepareStatement("SELECT AUTO_INCREMENT"
				+ " FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = DATABASE() AND LOWER(TABLE_NAME) = ?")) {
			statement.setString(1, table.toLowerCase(Locale.ROOT));
			try (ResultSet rows = statement.executeQuery()) {
				if (!rows.next()) {
					throw new IllegalStateException("대상에 테이블이 없다: " + table);
				}
				long next = rows.getLong(1);
				return rows.wasNull() ? 1L : next;
			}
		}
	}

	private static long maxKey(Connection connection, BaselineSchema.Table table) throws SQLException {
		String sql = "SELECT MAX(" + Identifiers.quote(table.primaryKey().name()) + ") FROM "
				+ Identifiers.quote(table.name());
		try (Statement statement = connection.createStatement(); ResultSet rows = statement.executeQuery(sql)) {
			if (!rows.next()) {
				return 0L;
			}
			long max = rows.getLong(1);
			return rows.wasNull() ? 0L : max;
		}
	}

	private static long rowCount(Connection connection, String table) throws SQLException {
		try (Statement statement = connection.createStatement();
				ResultSet rows = statement.executeQuery("SELECT COUNT(*) FROM " + Identifiers.quote(table))) {
			return rows.next() ? rows.getLong(1) : 0L;
		}
	}

	private static void bind(PreparedStatement statement, int index, BaselineSchema.Column column, Object value)
			throws SQLException {
		if (value == null) {
			statement.setNull(index, column.integer() ? Types.BIGINT : Types.LONGVARCHAR);
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
