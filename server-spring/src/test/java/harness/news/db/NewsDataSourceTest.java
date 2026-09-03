package harness.news.db;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.zaxxer.hikari.HikariConfig;
import com.zaxxer.hikari.HikariDataSource;
import harness.news.testsupport.TempNewsDb;
import java.nio.file.Files;
import java.nio.file.Path;
import java.sql.Connection;
import java.sql.ResultSet;
import java.sql.Statement;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/**
 * DataSource 계약: "없으면 만들지 말고 뜨지 말 것" + 파일 포맷을 바꾸지 말 것.
 *
 * <p>이 서버는 DB를 생성하지 않는다(스키마 소유자는 Node 서버다). 그래서 파일 부재는 조용한 생성이 아니라
 * 기동 실패여야 하고, 연결 PRAGMA는 {@code busy_timeout} 하나뿐이어야 한다 — {@code journal_mode}를
 * 건드리면 DB 파일 자체가 변형되고 {@code -wal}/{@code -shm} 부산물이 생겨 되돌리기 어렵다.
 */
class NewsDataSourceTest {

	@TempDir
	Path tempDir;

	@Test
	void missingDbFileFailsFastAndDoesNotCreateIt() {
		Path db = TempNewsDb.dbFile(tempDir);

		IllegalStateException thrown =
				assertThrows(IllegalStateException.class, () -> NewsDataSource.create(tempDir));

		assertTrue(thrown.getMessage().contains(db.toAbsolutePath().toString()),
				"실패 메시지는 어떤 경로를 열려 했는지 지목해야 한다: " + thrown.getMessage());
		assertFalse(Files.exists(db), "없는 DB 파일을 만들면 안 된다(스키마 소유자는 이 서버가 아니다)");
	}

	@Test
	void appliesBusyTimeoutAndReadsItBack() throws Exception {
		TempNewsDb.seed(tempDir);

		try (HikariDataSource dataSource = NewsDataSource.create(tempDir);
				Connection connection = dataSource.getConnection();
				Statement statement = connection.createStatement();
				ResultSet rs = statement.executeQuery("PRAGMA busy_timeout")) {
			assertTrue(rs.next());
			assertEquals(NewsDataSource.BUSY_TIMEOUT_MS, rs.getInt(1),
					"부트 PRAGMA는 Node(src/db/connection.js) 기본값과 동형이어야 한다");
		}
	}

	@Test
	void poolIsCappedAtOneConnection() {
		TempNewsDb.seed(tempDir);

		try (HikariDataSource dataSource = NewsDataSource.create(tempDir)) {
			assertEquals(1, dataSource.getMaximumPoolSize(),
					"SQLite 단일 파일 + Node 단일 연결과 동형 — 동시 쓰기 SQLITE_BUSY를 만들지 않는다");
		}
	}

	// --- 방언 분기(phase 75 step5) ------------------------------------------------------------

	/** sqlite 선택은 <b>지금까지와 같은 경로</b>다 — 여는 파일도 풀 크기도 그대로. */
	@Test
	void theSqliteKindOpensTheDataDirDatabase() {
		TempNewsDb.seed(tempDir);

		try (HikariDataSource dataSource = NewsDataSource.create(sqliteKind(), tempDir)) {
			assertEquals("jdbc:sqlite:" + TempNewsDb.dbFile(tempDir).toAbsolutePath(), dataSource.getJdbcUrl(),
					"sqlite 분기는 app.data-dir 아래 파일을 연다(URL은 여전히 파일 경로에서 나온다)");
			assertEquals(1, dataSource.getMaximumPoolSize());
		}
	}

	/**
	 * <b>분기 선택 자체를 잠근다</b> — mysql을 골랐는데 조용히 sqlite 파일을 여는 폴백이 없어야 한다.
	 *
	 * <p>이 임시 디렉토리에는 {@code news.db}가 <b>없다</b>. sqlite 분기를 탔다면 실패 메시지는
	 * "DB 파일이 없습니다"일 것이고, mysql 분기를 탔다면 접속 실패다 — 그 차이로 어느 분기를 탔는지
	 * 판정한다(MySQL 서버를 요구하지 않고 분기만 본다. 실기동 검증은 step6이다).
	 */
	@Test
	void theMysqlKindNeverFallsBackToTheSqliteFile() {
		DbProperties mysql = new DbProperties("mysql", unreachableMysqlUrl(), "u", "p");

		RuntimeException thrown = assertThrows(RuntimeException.class, () -> NewsDataSource.create(mysql, tempDir));

		assertFalse(messageChain(thrown).contains("DB 파일이 없습니다"),
				"mysql을 골랐는데 sqlite 파일을 열려 했다: " + messageChain(thrown));
		assertFalse(Files.exists(TempNewsDb.dbFile(tempDir)), "어느 분기든 DB 파일을 만들지 않는다");
	}

	/** mysql 설정은 <b>주입된 값 그대로</b>다 — URL에 무엇을 덧붙이지도, 자격을 URL에 섞지도 않는다. */
	@Test
	void theMysqlConfigCarriesTheInjectedValuesAndKeepsThePoolAtOne() {
		String url = "jdbc:mysql://127.0.0.1:3306/news"
				+ "?useSSL=false&allowPublicKeyRetrieval=true&characterEncoding=UTF-8";

		HikariConfig config = NewsDataSource.mysqlConfig(new DbProperties("mysql", url, "news_app", "pw"));

		assertEquals(url, config.getJdbcUrl(), "URL은 운영자가 준 것을 그대로 쓴다(docs/db-mysql-mapping.md §5)");
		assertEquals("news_app", config.getUsername());
		assertEquals("pw", config.getPassword());
		assertEquals(NewsDataSource.MAX_POOL_SIZE, config.getMaximumPoolSize(), "풀 상한 1은 방언과 무관하다");
		assertEquals("com.mysql.cj.jdbc.Driver", config.getDriverClassName(), "드라이버도 명시 주입이다");
		assertNull(config.getConnectionInitSql(), "SQLite 전용 연결 설정이 MySQL 연결에 실려서는 안 된다");
	}

	/** 실패 메시지가 지목하는 대상 — sqlite는 파일 경로, mysql은 <b>권한부를 지운</b> URL이다. */
	@Test
	void theTargetDescriptionNamesTheFileOrTheRedactedUrl() {
		assertEquals(TempNewsDb.dbFile(tempDir).toAbsolutePath().toString(),
				NewsDataSource.describeTarget(sqliteKind(), tempDir));

		String url = "jdbc:mysql://127.0.0.1:3306/news?useSSL=false";
		String described = NewsDataSource.describeTarget(new DbProperties("mysql", url, "u", "p"), tempDir);
		assertEquals("jdbc:mysql:", described, "호스트·DB·질의는 싣지 않는다(자격이 박힌 URL의 유출 경로)");
	}

	@Test
	void doesNotSwitchJournalModeOrLeaveWalArtifacts() throws Exception {
		TempNewsDb.seed(tempDir);

		try (HikariDataSource dataSource = NewsDataSource.create(tempDir);
				Connection connection = dataSource.getConnection();
				Statement statement = connection.createStatement();
				ResultSet rs = statement.executeQuery("PRAGMA journal_mode")) {
			assertTrue(rs.next());
			assertEquals("delete", rs.getString(1).toLowerCase(),
					"journal_mode를 바꾸면 DB 파일 포맷 자체가 변한다 — 이 서버는 절대 바꾸지 않는다");
		}

		assertFalse(Files.exists(tempDir.resolve(TempNewsDb.DB_FILE_NAME + "-wal")), "-wal 부산물이 없어야 한다");
		assertFalse(Files.exists(tempDir.resolve(TempNewsDb.DB_FILE_NAME + "-shm")), "-shm 부산물이 없어야 한다");
	}

	private static DbProperties sqliteKind() {
		return new DbProperties("sqlite", "", "", "");
	}

	/**
	 * 아무도 듣지 않는 loopback 포트 — 접속이 즉시 거부된다(대기 시간을 짧게 못 박아 이 테스트가 느린
	 * 타임아웃에 묶이지 않게 한다). 실제 MySQL을 요구하지 않는 것이 이 테스트의 요점이다.
	 */
	private static String unreachableMysqlUrl() {
		return "jdbc:mysql://127.0.0.1:1/none?connectTimeout=250&socketTimeout=250";
	}

	private static String messageChain(Throwable throwable) {
		StringBuilder sb = new StringBuilder();
		for (Throwable t = throwable; t != null; t = t.getCause()) {
			sb.append(t.getClass().getSimpleName()).append(": ").append(t.getMessage()).append('\n');
			if (t.getCause() == t) {
				break;
			}
		}
		return sb.toString();
	}
}
