package harness.news.db;

import static org.junit.jupiter.api.Assertions.assertDoesNotThrow;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.zaxxer.hikari.HikariDataSource;
import harness.news.testsupport.TempNewsDb;
import java.nio.file.Path;
import java.util.List;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.jdbc.core.simple.JdbcClient;

/**
 * 부팅 스키마 검증(읽기 전용) — "없으면 만들지 않고, 무엇이 없는지 말하고 뜨지 않는다".
 *
 * <p>이 서버는 스키마를 만들지 않으므로(정본은 Node `src/db/schema.js`) 요구 컬럼이 빠진 DB는
 * 런타임에 조용히 깨지는 대신 부팅에서 잡혀야 한다. 특히 잠금 컬럼이 없으면 계정 잠금 계약이
 * 조용히 무력화된다.
 */
class SchemaGuardTest {

	@TempDir
	Path tempDir;

	@Test
	void requiredUserColumnsMatchNodeModelWhitelist() {
		// 리포 루트 `src/models/userModel.js`의 COLUMNS와 순서까지 1:1이다.
		assertEquals(
				List.of("userId", "name", "password", "role", "department", "departmentCode", "active",
						"failedLoginCount", "lockedUntil", "lastFailedLoginAt"),
				RequiredSchema.USER_COLUMNS);
	}

	@Test
	void canonicalSchemaPasses() {
		TempNewsDb.seed(tempDir);

		try (HikariDataSource dataSource = NewsDataSource.create(tempDir)) {
			SchemaGuard guard = new SchemaGuard(JdbcClient.create(dataSource), TempNewsDb.dbFile(tempDir));
			assertDoesNotThrow(guard::verify);
		}
	}

	@Test
	void missingColumnsAreNamedInTheFailure() {
		TempNewsDb.seed(tempDir, TempNewsDb.DRIFT_FIXTURE);

		try (HikariDataSource dataSource = NewsDataSource.create(tempDir)) {
			SchemaGuard guard = new SchemaGuard(JdbcClient.create(dataSource), TempNewsDb.dbFile(tempDir));

			IllegalStateException thrown = assertThrows(IllegalStateException.class, guard::verify);

			String message = thrown.getMessage();
			assertTrue(message.contains("User"), "어느 테이블인지 지목해야 한다: " + message);
			assertTrue(message.contains("lockedUntil"), "빠진 컬럼을 지목해야 한다: " + message);
			assertTrue(message.contains("lastFailedLoginAt"), "빠진 컬럼을 전부 지목해야 한다: " + message);
			assertTrue(message.contains(TempNewsDb.dbFile(tempDir).toAbsolutePath().toString()),
					"어느 파일인지 지목해야 한다: " + message);
		}
	}

	@Test
	void missingTableIsNamedInTheFailure() {
		TempNewsDb.seedEmpty(tempDir);

		try (HikariDataSource dataSource = NewsDataSource.create(tempDir)) {
			SchemaGuard guard = new SchemaGuard(JdbcClient.create(dataSource), TempNewsDb.dbFile(tempDir));

			IllegalStateException thrown = assertThrows(IllegalStateException.class, guard::verify);

			assertTrue(thrown.getMessage().contains("User"), "없는 테이블 이름을 지목해야 한다: " + thrown.getMessage());
		}
	}
}
