package harness.news.db;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

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
}
