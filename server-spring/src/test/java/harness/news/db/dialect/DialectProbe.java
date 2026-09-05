package harness.news.db.dialect;

import java.io.IOException;
import java.io.UncheckedIOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Statement;
import java.util.ArrayList;
import java.util.List;

/**
 * 방언 측정용 도구 — <b>SQLite 임시 파일 DB</b>와 작은 질의 헬퍼.
 *
 * <p>리포 {@code news.db}는 열지 않는다(원본 바이트 무변이 이 phase의 완료 게이트다). 프로브는 자기
 * 픽스처만 쓴다 — SQLite는 OS 임시 디렉토리의 새 파일, MySQL은
 * {@link harness.news.testsupport.EphemeralMysqlDb}가 만드는 임시 DB다.
 */
final class DialectProbe implements AutoCloseable {

	private final Path file;

	private final Connection connection;

	private DialectProbe(Path file, Connection connection) {
		this.file = file;
		this.connection = connection;
	}

	/** 빈 SQLite 파일 DB를 열고 연결을 쥔다(테스트가 닫으면 파일까지 지운다). */
	static DialectProbe sqlite() {
		try {
			Path file = Files.createTempFile("news-dialect-probe-", ".db");
			Files.deleteIfExists(file); // 드라이버가 새로 만들게 둔다(빈 파일은 SQLite 헤더가 없다).
			Connection connection = DriverManager.getConnection("jdbc:sqlite:" + file.toAbsolutePath());
			return new DialectProbe(file, connection);
		}
		catch (IOException ex) {
			throw new UncheckedIOException(ex);
		}
		catch (SQLException ex) {
			throw new IllegalStateException("SQLite 프로브 DB를 열지 못했다", ex);
		}
	}

	Connection connection() {
		return this.connection;
	}

	void exec(String sql) {
		exec(this.connection, sql);
	}

	@Override
	public void close() {
		try {
			this.connection.close();
		}
		catch (SQLException ignored) {
			// 정리 실패는 판정에 영향을 주지 않는다.
		}
		try {
			Files.deleteIfExists(this.file);
		}
		catch (IOException ignored) {
			// 임시 파일 정리는 best-effort.
		}
	}

	// --- 공용 헬퍼 (양쪽 방언에 같은 코드로 쓴다) ---

	static void exec(Connection connection, String sql) {
		try (Statement statement = connection.createStatement()) {
			statement.executeUpdate(sql);
		}
		catch (SQLException ex) {
			throw new IllegalStateException("실행 실패: " + sql, ex);
		}
	}

	/** 첫 컬럼을 문자열 리스트로 읽는다(NULL은 그대로 {@code null}). */
	static List<String> strings(Connection connection, String sql, Object... params) {
		List<String> values = new ArrayList<>();
		try (PreparedStatement statement = connection.prepareStatement(sql)) {
			bind(statement, params);
			try (ResultSet rs = statement.executeQuery()) {
				while (rs.next()) {
					values.add(rs.getString(1));
				}
			}
		}
		catch (SQLException ex) {
			throw new IllegalStateException("질의 실패: " + sql, ex);
		}
		return values;
	}

	/** 첫 행 첫 컬럼을 문자열로 읽는다(행이 없으면 {@code null}). */
	static String string(Connection connection, String sql, Object... params) {
		List<String> values = strings(connection, sql, params);
		return values.isEmpty() ? null : values.get(0);
	}

	/** 첫 행 첫 컬럼을 정수로 읽는다. */
	static long number(Connection connection, String sql, Object... params) {
		String value = string(connection, sql, params);
		return value == null ? -1L : Long.parseLong(value.trim());
	}

	/** 파라미터를 바인딩해 갱신한다. */
	static int update(Connection connection, String sql, Object... params) {
		try (PreparedStatement statement = connection.prepareStatement(sql)) {
			bind(statement, params);
			return statement.executeUpdate();
		}
		catch (SQLException ex) {
			throw new IllegalStateException("갱신 실패: " + sql, ex);
		}
	}

	/** 갱신을 시도하고 <b>SQLState/에러코드</b>를 문자열로 돌려준다(성공이면 {@code "ok"}). */
	static String updateOutcome(Connection connection, String sql, Object... params) {
		try (PreparedStatement statement = connection.prepareStatement(sql)) {
			bind(statement, params);
			statement.executeUpdate();
			return "ok";
		}
		catch (SQLException ex) {
			return ex.getErrorCode() + "/" + ex.getSQLState();
		}
	}

	private static void bind(PreparedStatement statement, Object... params) throws SQLException {
		for (int i = 0; i < params.length; i++) {
			statement.setObject(i + 1, params[i]);
		}
	}

}
