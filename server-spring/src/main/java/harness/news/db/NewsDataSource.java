package harness.news.db;

import com.zaxxer.hikari.HikariConfig;
import com.zaxxer.hikari.HikariDataSource;
import java.nio.file.Files;
import java.nio.file.Path;
import java.sql.Connection;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Statement;

/**
 * 데이터 디렉토리의 {@code news.db}(SQLite)를 여는 DataSource 팩토리.
 *
 * <p>규칙 셋을 지킨다.
 * <ol>
 *   <li><b>없으면 만들지 않는다.</b> SQLite JDBC는 파일이 없으면 조용히 새 파일을 만든다 — 그러면
 *       "빈 DB로 떠서 첫 로그인에서 터지는" 상태가 된다. 그래서 여는 <i>전에</i> 존재를 확인하고,
 *       없으면 경로를 담은 메시지로 기동을 실패시킨다.</li>
 *   <li><b>연결 PRAGMA는 {@code busy_timeout} 하나뿐이다.</b> Node 부트 연결
 *       ({@code src/db/connection.js})과 같은 값을 쓰고, 적용됐는지 read-back으로 확인한다
 *       (조용히 적용 안 된 채 진행하면 경합 완화가 없다는 사실이 장애 때야 드러난다).
 *       {@code journal_mode}·{@code synchronous}는 <b>절대</b> 건드리지 않는다 — WAL 전환은 DB 파일
 *       자체를 변형하고 {@code -wal}/{@code -shm} 부산물을 남겨 되돌리기 어렵다.</li>
 *   <li><b>풀 최대 1.</b> SQLite는 단일 파일이라 동시 쓰기가 {@code SQLITE_BUSY}를 낸다. Node 서버는
 *       단일 연결·동기 실행이라 이 문제가 없었고, 여기서도 같은 형태로 시작한다. 이 실패는 계약
 *       스위트에서 간헐적으로 나타나 flake로 오인되므로 애초에 만들지 않는 편이 진단에 낫다.</li>
 * </ol>
 */
public final class NewsDataSource {

	/** 데이터 디렉토리 안의 DB 파일 이름 — Node 서버가 쓰는 이름과 같다. */
	public static final String DB_FILE_NAME = "news.db";

	/** 부트 PRAGMA 값. Node {@code DEFAULT_BUSY_TIMEOUT_MS}와 동형(5000ms). */
	public static final int BUSY_TIMEOUT_MS = 5000;

	/** 커넥션 풀 상한. 위 3번 근거로 1이다. */
	public static final int MAX_POOL_SIZE = 1;

	private NewsDataSource() {
	}

	/**
	 * 데이터 디렉토리의 {@code news.db}를 여는 DataSource를 만든다.
	 *
	 * @param dataDir {@code app.data-dir}(환경변수 {@code DATA_DIR})가 가리키는 디렉토리
	 * @throws IllegalStateException DB 파일이 없거나 열 수 없을 때(기동 실패)
	 */
	public static HikariDataSource create(Path dataDir) {
		Path db = dataDir.resolve(DB_FILE_NAME).toAbsolutePath();
		if (!Files.isRegularFile(db)) {
			throw new IllegalStateException(
					"DB 파일이 없습니다: " + db + " — 이 서버는 DB를 만들지 않습니다(스키마 소유자는 Node 서버입니다). "
							+ "app.data-dir(환경변수 DATA_DIR)이 올바른 데이터 디렉토리를 가리키는지 확인하세요.");
		}

		HikariConfig config = new HikariConfig();
		config.setPoolName("news-db");
		config.setDriverClassName("org.sqlite.JDBC");
		config.setJdbcUrl("jdbc:sqlite:" + db);
		config.setMaximumPoolSize(MAX_POOL_SIZE);
		// 물리 연결마다 1회 실행된다 — 연결 단위 설정인 busy_timeout에 정확히 맞는 자리다.
		config.setConnectionInitSql("PRAGMA busy_timeout = " + BUSY_TIMEOUT_MS);

		HikariDataSource dataSource = new HikariDataSource(config);
		try {
			verifyBusyTimeout(dataSource, db);
		}
		catch (RuntimeException ex) {
			dataSource.close();
			throw ex;
		}
		return dataSource;
	}

	/** 적용 후 read-back — Node {@code applyConnectionPragmas}와 같은 규율(조용한 no-op 금지). */
	private static void verifyBusyTimeout(HikariDataSource dataSource, Path db) {
		try (Connection connection = dataSource.getConnection();
				Statement statement = connection.createStatement();
				ResultSet rs = statement.executeQuery("PRAGMA busy_timeout")) {
			int applied = rs.next() ? rs.getInt(1) : -1;
			if (applied != BUSY_TIMEOUT_MS) {
				throw new IllegalStateException(
						"busy_timeout read-back 불일치 — expected=" + BUSY_TIMEOUT_MS + " actual=" + applied
								+ " (" + db + ")");
			}
		}
		catch (SQLException ex) {
			throw new IllegalStateException("DB 연결에 실패했습니다: " + db, ex);
		}
	}
}
