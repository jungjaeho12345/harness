package harness.newsmigrator;

import java.nio.file.Path;
import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Statement;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.sqlite.SQLiteConfig;

/**
 * 이관 <b>소스</b>({@code news.db}) — 읽기 전용으로만 열린다.
 *
 * <h2>두 겹으로 잠근다</h2>
 * <ol>
 * <li><b>드라이버 수준</b>: {@link SQLiteConfig#setReadOnly(boolean)} 이 열기 모드에서 생성·쓰기 플래그를
 * 뺀다. 파일이 없으면 새로 만들지 않고 열기 자체가 실패한다 — 경로 오타가 빈 DB 를 만들어 "0행 이관
 * 성공"으로 끝나는 사고를 막는다.</li>
 * <li><b>결과 수준</b>: {@link SourceFingerprint} 가 열기 전에 크기·md5 를 재고, {@link #close()} 가
 * 닫은 뒤 다시 재서 다르면 던진다. 설정은 조용히 무시될 수 있지만 <b>바이트는 거짓말하지 않는다.</b></li>
 * </ol>
 *
 * <h2>왜 쓰기 모드로 열면 안 되는가</h2>
 * 쓰기 모드는 SQL 을 한 줄도 실행하지 않아도 저널 부산물을 만들고, WAL 전환은 파일 자체를 변형해 되돌리기
 * 어렵다. 이 phase 의 완료 게이트가 "원본 바이트 무변"이므로, 그 게이트는 SQL 없이도 무너질 수 있다
 * ({@code NewsDataSource} 의 javadoc 이 같은 이유를 적는다).
 */
public final class SqliteSource implements AutoCloseable {

	private final Path file;

	private final SourceFingerprint fingerprint;

	private final Connection connection;

	private SqliteSource(Path file, SourceFingerprint fingerprint, Connection connection) {
		this.file = file;
		this.fingerprint = fingerprint;
		this.connection = connection;
	}

	/**
	 * 소스를 읽기 전용으로 연다.
	 *
	 * @throws IllegalStateException 파일이 없거나 · 부산물이 있거나 · 열지 못했을 때
	 */
	public static SqliteSource open(Path file) {
		SourceFingerprint fingerprint = SourceFingerprint.of(file);
		SQLiteConfig config = new SQLiteConfig();
		config.setReadOnly(true);
		try {
			Connection connection = DriverManager.getConnection("jdbc:sqlite:" + file.toAbsolutePath(),
					config.toProperties());
			return new SqliteSource(file, fingerprint, connection);
		}
		catch (SQLException ex) {
			throw new IllegalStateException("소스를 열지 못했다: " + file.toAbsolutePath(), ex);
		}
	}

	public Path file() {
		return this.file;
	}

	/** 열기 직전에 잰 지문 — 실행이 끝나면 이 값과 같아야 한다. */
	public SourceFingerprint fingerprint() {
		return this.fingerprint;
	}

	/** 읽기 전용으로 열린 연결. 쓰기를 시도하면 드라이버가 거부한다({@code SqliteSourceTest} 가 실측한다). */
	public Connection connection() {
		return this.connection;
	}

	/** 소스에 실제로 있는 테이블(SQLite 내부 테이블은 빼고). */
	public List<String> tableNames() {
		List<String> names = new ArrayList<>();
		try (Statement statement = this.connection.createStatement();
				ResultSet rows = statement.executeQuery("SELECT name FROM sqlite_master WHERE type = 'table'"
						+ " AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' ORDER BY name")) {
			while (rows.next()) {
				names.add(rows.getString(1));
			}
		}
		catch (SQLException ex) {
			throw new IllegalStateException("소스의 테이블 목록을 읽지 못했다: " + this.file, ex);
		}
		return names;
	}

	/** 소스가 실제로 가진 컬럼 이름(선언 순서 — 정본과 <b>순서가 다를 수 있다</b>). */
	public List<String> columnNames(String table) {
		List<String> names = new ArrayList<>();
		try (Statement statement = this.connection.createStatement();
				ResultSet rows = statement.executeQuery("PRAGMA table_info(" + Identifiers.quoteAnsi(table) + ")")) {
			while (rows.next()) {
				names.add(rows.getString("name"));
			}
		}
		catch (SQLException ex) {
			throw new IllegalStateException("소스의 컬럼 목록을 읽지 못했다: " + table, ex);
		}
		return names;
	}

	public long rowCount(String table) {
		try (Statement statement = this.connection.createStatement();
				ResultSet rows = statement.executeQuery("SELECT COUNT(*) FROM " + Identifiers.quoteAnsi(table))) {
			return rows.next() ? rows.getLong(1) : 0L;
		}
		catch (SQLException ex) {
			throw new IllegalStateException("소스의 행 수를 읽지 못했다: " + table, ex);
		}
	}

	/**
	 * 한 테이블의 전 행을 읽는다 — 컬럼은 <b>이름으로</b> 고른다.
	 *
	 * <p>위치로 고르면 안 되는 이유가 실측에 있다: 리포 {@code news.db} 의 컬럼 순서는 정본의 선언 순서와
	 * <b>다르다</b>({@code ArticleHistory} 는 {@code snapshotTitle} 이 맨 뒤에 있고 {@code Contents} 는
	 * {@code category} 가 맨 뒤다 — 추가 컬럼이 {@code ALTER ... ADD COLUMN} 으로 붙은 순서 그대로다).
	 * 위치로 옮기면 값이 옆 컬럼으로 들어간다.
	 */
	public List<Map<String, Object>> rows(BaselineSchema.Table table) {
		List<String> columns = table.columnNames();
		String sql = "SELECT " + String.join(", ", columns.stream().map(Identifiers::quoteAnsi).toList()) + " FROM "
				+ Identifiers.quoteAnsi(table.name());
		List<Map<String, Object>> rows = new ArrayList<>();
		try (Statement statement = this.connection.createStatement(); ResultSet result = statement.executeQuery(sql)) {
			while (result.next()) {
				Map<String, Object> row = new LinkedHashMap<>();
				for (int i = 0; i < columns.size(); i++) {
					BaselineSchema.Column column = table.columns().get(i);
					row.put(column.name(),
							CellValues.read(result, i + 1, column, table.name() + "." + column.name()));
				}
				rows.add(row);
			}
		}
		catch (SQLException ex) {
			throw new IllegalStateException("소스의 행을 읽지 못했다: " + table.name(), ex);
		}
		return rows;
	}

	/** 연결을 닫고 <b>원본이 그대로인지</b> 다시 잰다 — 이 클래스를 거친 모든 경로가 그 확인을 받는다. */
	@Override
	public void close() {
		try {
			this.connection.close();
		}
		catch (SQLException ex) {
			throw new IllegalStateException("소스 연결을 닫지 못했다: " + this.file, ex);
		}
		this.fingerprint.requireUnchanged(this.file);
	}

}
