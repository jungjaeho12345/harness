package harness.news.db;

import static org.junit.jupiter.api.Assertions.assertDoesNotThrow;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.zaxxer.hikari.HikariDataSource;
import harness.news.testsupport.TempNewsDb;
import java.nio.file.Path;
import java.util.List;
import java.util.Set;
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
	void requiredArticleColumnsMatchNodeSchema() {
		// 리포 루트 `src/db/schema.js`의 SCHEMA.Article과 순서까지 1:1이다(SELECT 나열의 단일 출처).
		assertEquals(
				List.of("articleId", "title", "content", "markupVersion", "modifier"),
				RequiredSchema.ARTICLE_COLUMNS);
	}

	@Test
	void requiredContentsColumnsMatchNodeSchema() {
		// 29컬럼·순서 그대로. 이 목록이 곧 응답 키 집합(투영 후 27키)이라 순서 드리프트도 계약 위반이다.
		assertEquals(
				List.of("articleId", "title", "content", "author", "modifier", "sender",
						"department", "departmentCode", "createdAt", "editedAt", "sentAt",
						"distributedAt", "embargoAt", "secondEmbargoAt", "status",
						"lockYN", "lockerUserId", "lockerSessionId", "lockerClientId", "lockedAt",
						"coAuthor", "category", "region", "attribute", "keyword",
						"internalComment", "externalComment", "attachmentFile", "referenceFile"),
				RequiredSchema.CONTENTS_COLUMNS);
		assertEquals(29, RequiredSchema.CONTENTS_COLUMNS.size(), "Contents는 29컬럼이다");
	}

	@Test
	void bootVerifiesEveryTableThisPhaseReadsOrWrites() {
		// 부팅 검증 대상은 요구 목록 전체다 — 여기서 테이블이 빠지면 그 테이블의 드리프트가 런타임까지 산다.
		assertEquals(Set.of("User", "Article", "Contents"), RequiredSchema.TABLES.keySet());
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
	void missingContentsColumnsAreNamedInTheFailure() {
		// User·Article·ArticleHistory는 정본과 같고 Contents만 2컬럼이 빠진 DB — 결함이 그 둘뿐이라
		// 컬럼 단위 지목이 다른 문제에 가려지지 않는다.
		TempNewsDb.seed(tempDir, TempNewsDb.ARTICLE_DRIFT_FIXTURE);

		try (HikariDataSource dataSource = NewsDataSource.create(tempDir)) {
			SchemaGuard guard = new SchemaGuard(JdbcClient.create(dataSource), TempNewsDb.dbFile(tempDir));

			IllegalStateException thrown = assertThrows(IllegalStateException.class, guard::verify);

			String message = thrown.getMessage();
			assertTrue(message.contains("Contents"), "어느 테이블인지 지목해야 한다: " + message);
			assertTrue(message.contains("secondEmbargoAt"), "빠진 컬럼을 지목해야 한다: " + message);
			assertTrue(message.contains("lockerSessionId"), "빠진 컬럼을 전부 지목해야 한다: " + message);
			assertFalse(message.contains("테이블 없음"), "이 DB에 없는 테이블은 없다(지목이 정확해야 한다): " + message);
		}
	}

	@Test
	void missingArticleTablesAreNamedInTheFailure() {
		// User만 있는 옛 드리프트 DB — 요구 목록이 넓어진 뒤로는 기사 3테이블이 통째로 없는 DB이기도 하다.
		TempNewsDb.seed(tempDir, TempNewsDb.DRIFT_FIXTURE);

		try (HikariDataSource dataSource = NewsDataSource.create(tempDir)) {
			SchemaGuard guard = new SchemaGuard(JdbcClient.create(dataSource), TempNewsDb.dbFile(tempDir));

			IllegalStateException thrown = assertThrows(IllegalStateException.class, guard::verify);

			String message = thrown.getMessage();
			assertTrue(message.contains("Article"), "없는 테이블 이름을 지목해야 한다: " + message);
			assertTrue(message.contains("Contents"), "없는 테이블 이름을 전부 지목해야 한다: " + message);
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
