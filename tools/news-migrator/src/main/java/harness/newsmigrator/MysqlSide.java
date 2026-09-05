package harness.newsmigrator;

import java.sql.Connection;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Statement;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.function.Consumer;

/**
 * MySQL 스키마 한 벌을 <b>읽기 창구</b>로 감싼 것 — 대조의 대상 쪽이자 역방향 export 의 소스 쪽이다.
 *
 * <h2>여기에 쓰기 경로가 없다</h2>
 * 이 클래스가 여는 문장은 조회뿐이다. 적재는 {@link RowCopier} 가 자기 연결로 하고, 이쪽으로 흐르지
 * 않는다 — 읽기 창구가 쓰기도 할 수 있으면 "역방향 export 가 대상을 건드리지 않는다" 를 코드 모양으로
 * 말할 수 없다.
 *
 * <h2>이관 원장은 이 쪽에만 있다</h2>
 * 기반선을 적용하면 정본에 없는 테이블이 하나 생긴다({@code flyway_schema_history}). 그 이름은
 * {@link BaselineSchema#MIGRATION_LEDGER_TABLE} 상수 하나가 소유하고, 여기서 <b>명시적으로</b> 빠진다.
 * SQLite 쪽에는 그 테이블이 없으므로 왕복 대조({@code SQLite ↔ SQLite})의 제외 목록은 비어 있다 —
 * 그 사실 자체가 "제외가 조용한 기본 동작이 아니라 이 쪽의 성질" 이라는 증거다.
 */
public final class MysqlSide implements ComparisonSide {

	private final TargetCredentials credentials;

	private final Connection connection;

	private MysqlSide(TargetCredentials credentials, Connection connection) {
		this.credentials = credentials;
		this.connection = connection;
	}

	/**
	 * 자격으로 연결을 연다. 호출자가 {@link #close()} 한다.
	 *
	 * @throws IllegalStateException 접속하지 못했을 때 — <b>조용히 빈 쪽으로 취급하지 않는다.</b>
	 */
	public static MysqlSide open(TargetCredentials credentials) {
		try {
			return new MysqlSide(credentials, TargetCredentials.open(credentials));
		}
		catch (SQLException ex) {
			throw new IllegalStateException("대상에 접속하지 못했다: " + credentials.describe(), ex);
		}
	}

	@Override
	public String describe() {
		return this.credentials.describe();
	}

	/** 이 스키마의 실제 테이블 — 이관 원장은 빠진다. */
	@Override
	public List<String> tableNames() {
		List<String> names = new ArrayList<>();
		try (Statement statement = this.connection.createStatement();
				ResultSet rows = statement.executeQuery("SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES"
						+ " WHERE TABLE_SCHEMA = DATABASE() AND TABLE_TYPE = 'BASE TABLE'")) {
			while (rows.next()) {
				String name = rows.getString(1);
				if (!name.equalsIgnoreCase(BaselineSchema.MIGRATION_LEDGER_TABLE)) {
					names.add(name);
				}
			}
		}
		catch (SQLException ex) {
			throw new IllegalStateException("대상의 테이블 목록을 읽지 못했다: " + describe(), ex);
		}
		return names;
	}

	@Override
	public List<String> excludedTables() {
		return List.of(BaselineSchema.MIGRATION_LEDGER_TABLE);
	}

	@Override
	public void forEachRow(BaselineSchema.Table table, Consumer<Map<String, Object>> handler) {
		List<BaselineSchema.Column> columns = table.columns();
		String sql = "SELECT " + String.join(", ", columns.stream().map((column) -> Identifiers.quote(column.name()))
				.toList()) + " FROM " + Identifiers.quote(table.name());
		try (Statement statement = this.connection.createStatement(); ResultSet rows = statement.executeQuery(sql)) {
			while (rows.next()) {
				Map<String, Object> row = new LinkedHashMap<>();
				for (int i = 0; i < columns.size(); i++) {
					BaselineSchema.Column column = columns.get(i);
					row.put(column.name(), CellValues.read(rows, i + 1, column, table.name() + "." + column.name()));
				}
				handler.accept(row);
			}
		}
		catch (SQLException ex) {
			throw new IllegalStateException("대상의 행을 읽지 못했다: " + table.name() + " / " + describe(), ex);
		}
	}

	@Override
	public void close() {
		try {
			this.connection.close();
		}
		catch (SQLException ex) {
			throw new IllegalStateException("대상 연결을 닫지 못했다: " + describe(), ex);
		}
	}

}
