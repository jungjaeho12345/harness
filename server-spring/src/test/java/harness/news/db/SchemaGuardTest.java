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
	void requiredHistoryColumnsMatchNodeSchema() {
		// 리포 루트 `src/db/schema.js`의 SCHEMA.ArticleHistory와 순서까지 1:1이다.
		// id는 자동 증가 정수이고 targetId도 정수 컬럼이다(VARCHAR면 수신처 매칭이 조용히 깨진다 — SCHEMA.md).
		assertEquals(
				List.of("id", "articleId", "eventType", "action", "fromStatus", "toStatus",
						"actorUserId", "createdAt", "markupVersion", "snapshotTitle", "targetId", "reason"),
				RequiredSchema.HISTORY_COLUMNS);
		assertEquals(12, RequiredSchema.HISTORY_COLUMNS.size(), "ArticleHistory는 12컬럼이다");
	}

	@Test
	void requiredReceiverConfigColumnsMatchNodeSchema() {
		// 리포 루트 `src/db/schema.js`의 SCHEMA.ReceiverConfig와 순서까지 1:1이다(id 포함 — SELECT 나열의 단일 출처).
		// password·apiKey는 스키마에는 있지만 서비스 투영(SAFE_FIELDS)에는 없는 쓰기 전용 시크릿이다.
		assertEquals(
				List.of("id", "sourceId", "type", "name", "host", "port", "username",
						"password", "apiEndpoint", "apiKey", "active", "createdAt"),
				RequiredSchema.RECEIVER_CONFIG_COLUMNS);
		assertEquals(12, RequiredSchema.RECEIVER_CONFIG_COLUMNS.size(), "ReceiverConfig는 12컬럼이다");
	}

	@Test
	void requiredDistributionTargetColumnsMatchNodeSchema() {
		// 리포 루트 `src/db/schema.js`의 SCHEMA.DistributionTarget와 순서까지 1:1이다(id 포함).
		assertEquals(
				List.of("id", "name", "kind", "spoolDir", "active", "createdAt", "updatedAt"),
				RequiredSchema.DISTRIBUTION_TARGET_COLUMNS);
		assertEquals(7, RequiredSchema.DISTRIBUTION_TARGET_COLUMNS.size(), "DistributionTarget는 7컬럼이다");
	}

	@Test
	void requiredPhotoColumnsMatchNodeSchema() {
		// 리포 루트 `src/db/schema.js`의 SCHEMA.Photo와 순서까지 1:1이다(id 포함 — SELECT 나열의 단일 출처).
		// 이 6키가 곧 사진 검색 응답의 원소 키다(투영·마스킹 없음 — openapi.yaml /api/photos/search).
		assertEquals(
				List.of("id", "src", "caption", "sourceArticleId", "registeredBy", "createdAt"),
				RequiredSchema.PHOTO_COLUMNS);
		assertEquals(6, RequiredSchema.PHOTO_COLUMNS.size(), "Photo는 6컬럼이다");
	}

	@Test
	void bootVerifiesEveryTableThisPhaseReadsOrWrites() {
		// 부팅 검증 대상은 요구 목록 전체다 — 여기서 테이블이 빠지면 그 테이블의 드리프트가 런타임까지 산다.
		// phase 70이 ReceiverConfig·DistributionTarget를 additive로 넣어 4→6테이블이 됐고,
		// phase 73이 Photo를 넣어 6→7이 됐다.
		assertEquals(
				Set.of("User", "Article", "Contents", "ArticleHistory", "ReceiverConfig", "DistributionTarget",
						"Photo"),
				RequiredSchema.TABLES.keySet());
	}

	/**
	 * 텍스트 PK 표가 요구 컬럼 목록과 <b>어긋나지 않는다</b>(⑤ [med] 3).
	 *
	 * <p>손으로 적은 표는 정본이 바뀔 때 조용히 낡는다 — 그러면 부팅 collation 검증이 <b>없는 컬럼</b>을
	 * 보게 되고, 그 실패는 "카탈로그에 없다"로 나타나 원인이 스키마 드리프트인지 표의 오타인지 구분되지
	 * 않는다. 그래서 ① 세 항목뿐이고 ② 각각이 그 테이블 컬럼 목록의 <b>첫 항목</b>(=기본키)인지 잠근다.
	 */
	@Test
	void theTextPrimaryKeyListStaysInSyncWithTheRequiredColumnLists() {
		assertEquals(Set.of("User", "Article", "Contents"), RequiredSchema.TEXT_PRIMARY_KEYS.keySet(),
				"텍스트 기본키를 가진 테이블은 셋뿐이다(나머지 넷의 PK는 정수이거나 이 축의 대상이 아니다)");
		assertEquals("userId", RequiredSchema.TEXT_PRIMARY_KEYS.get("User"));
		assertEquals("articleId", RequiredSchema.TEXT_PRIMARY_KEYS.get("Article"));
		assertEquals("articleId", RequiredSchema.TEXT_PRIMARY_KEYS.get("Contents"));
		RequiredSchema.TEXT_PRIMARY_KEYS.forEach((table, column) -> {
			List<String> columns = RequiredSchema.TABLES.get(table);
			assertTrue(columns != null && !columns.isEmpty(), "요구 목록에 없는 테이블이다: " + table);
			assertEquals(columns.get(0), column,
					table + " 의 기본키가 컬럼 목록의 첫 항목이 아니다 — 표가 낡았거나 정본 순서가 바뀌었다");
		});
	}

	@Test
	void missingPhotoColumnsAreNamedInTheFailure() {
		// 다른 6테이블은 정본과 같고 Photo만 2컬럼(registeredBy·createdAt)이 빠진 DB — 결함이 그 둘뿐이라
		// 컬럼 단위 지목이 다른 문제에 가려지지 않는다. registeredBy가 없으면 신원 stamp(ADR-004)가 조용히 깨진다.
		TempNewsDb.seed(tempDir, TempNewsDb.PHOTO_DRIFT_FIXTURE);

		try (HikariDataSource dataSource = NewsDataSource.create(tempDir)) {
			SchemaGuard guard = new SchemaGuard(
					dataSource, TempNewsDb.dbFile(tempDir).toAbsolutePath().toString(), false);

			IllegalStateException thrown = assertThrows(IllegalStateException.class, guard::verify);

			String message = thrown.getMessage();
			assertTrue(message.contains("Photo"), "어느 테이블인지 지목해야 한다: " + message);
			assertTrue(message.contains("registeredBy"), "빠진 컬럼을 지목해야 한다: " + message);
			assertTrue(message.contains("createdAt"), "빠진 컬럼을 전부 지목해야 한다: " + message);
			assertFalse(message.contains("테이블 없음"), "이 DB에 없는 테이블은 없다(지목이 정확해야 한다): " + message);
		}
	}

	@Test
	void missingPhotoTableIsNamedInTheFailure() {
		// 정본 픽스처에서 Photo 문장만 빼고 시드한다 — 나머지 6테이블은 정본과 같으므로 "테이블 없음 = Photo"
		// 하나만 남는다. 별도 픽스처 파일을 두지 않는 이유: 이 DB의 정의가 "정본 − Photo"라 정본을 그대로
		// 읽는 편이 두 파일이 어긋날 여지를 없앤다.
		seedCanonicalWithoutPhoto();

		try (HikariDataSource dataSource = NewsDataSource.create(tempDir)) {
			SchemaGuard guard = new SchemaGuard(
					dataSource, TempNewsDb.dbFile(tempDir).toAbsolutePath().toString(), false);

			IllegalStateException thrown = assertThrows(IllegalStateException.class, guard::verify);

			assertEquals("테이블 없음 = Photo", onlyProblem(thrown.getMessage()),
					"없는 테이블은 Photo 하나이고 그것을 지목해야 한다: " + thrown.getMessage());
		}
	}

	/** 정본 픽스처의 CREATE 문장 중 Photo만 빼고 임시 DB를 세운다(테이블 자체가 없는 상황 재현). */
	private void seedCanonicalWithoutPhoto() {
		for (String statement : TempNewsDb.statements(TempNewsDb.CANONICAL_FIXTURE)) {
			if (!statement.contains(RequiredSchema.PHOTO_TABLE)) {
				TempNewsDb.exec(TempNewsDb.dbFile(tempDir), statement);
			}
		}
	}

	/** 실패 메시지에서 문제 목록만 떼어 낸다(앞의 경로·뒤의 안내 문장 제거). */
	private static String onlyProblem(String message) {
		int start = message.indexOf("): ");
		int end = message.lastIndexOf(". 이 서버는");
		return (start < 0 || end < 0) ? message : message.substring(start + 3, end);
	}

	@Test
	void missingReceiverConfigColumnsAreNamedInTheFailure() {
		// 다른 5테이블은 정본과 같고 ReceiverConfig만 2컬럼(apiKey·createdAt)이 빠진 DB — 결함이 그 둘뿐이라
		// 컬럼 단위 지목이 다른 문제에 가려지지 않는다.
		TempNewsDb.seed(tempDir, TempNewsDb.RECEIVER_CONFIG_DRIFT_FIXTURE);

		try (HikariDataSource dataSource = NewsDataSource.create(tempDir)) {
			SchemaGuard guard = new SchemaGuard(
					dataSource, TempNewsDb.dbFile(tempDir).toAbsolutePath().toString(), false);

			IllegalStateException thrown = assertThrows(IllegalStateException.class, guard::verify);

			String message = thrown.getMessage();
			assertTrue(message.contains("ReceiverConfig"), "어느 테이블인지 지목해야 한다: " + message);
			assertTrue(message.contains("apiKey"), "빠진 컬럼을 지목해야 한다: " + message);
			assertTrue(message.contains("createdAt"), "빠진 컬럼을 전부 지목해야 한다: " + message);
			assertFalse(message.contains("테이블 없음"), "이 DB에 없는 테이블은 없다(지목이 정확해야 한다): " + message);
		}
	}

	@Test
	void missingDistributionTargetColumnsAreNamedInTheFailure() {
		// 다른 5테이블은 정본과 같고 DistributionTarget만 2컬럼(spoolDir·updatedAt)이 빠진 DB.
		TempNewsDb.seed(tempDir, TempNewsDb.DISTRIBUTION_TARGET_DRIFT_FIXTURE);

		try (HikariDataSource dataSource = NewsDataSource.create(tempDir)) {
			SchemaGuard guard = new SchemaGuard(
					dataSource, TempNewsDb.dbFile(tempDir).toAbsolutePath().toString(), false);

			IllegalStateException thrown = assertThrows(IllegalStateException.class, guard::verify);

			String message = thrown.getMessage();
			assertTrue(message.contains("DistributionTarget"), "어느 테이블인지 지목해야 한다: " + message);
			assertTrue(message.contains("spoolDir"), "빠진 컬럼을 지목해야 한다: " + message);
			assertTrue(message.contains("updatedAt"), "빠진 컬럼을 전부 지목해야 한다: " + message);
			assertFalse(message.contains("테이블 없음"), "이 DB에 없는 테이블은 없다(지목이 정확해야 한다): " + message);
		}
	}

	@Test
	void canonicalSchemaPasses() {
		TempNewsDb.seed(tempDir);

		try (HikariDataSource dataSource = NewsDataSource.create(tempDir)) {
			SchemaGuard guard = new SchemaGuard(
					dataSource, TempNewsDb.dbFile(tempDir).toAbsolutePath().toString(), false);
			assertDoesNotThrow(guard::verify);
		}
	}

	@Test
	void missingColumnsAreNamedInTheFailure() {
		TempNewsDb.seed(tempDir, TempNewsDb.DRIFT_FIXTURE);

		try (HikariDataSource dataSource = NewsDataSource.create(tempDir)) {
			SchemaGuard guard = new SchemaGuard(
					dataSource, TempNewsDb.dbFile(tempDir).toAbsolutePath().toString(), false);

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
			SchemaGuard guard = new SchemaGuard(
					dataSource, TempNewsDb.dbFile(tempDir).toAbsolutePath().toString(), false);

			IllegalStateException thrown = assertThrows(IllegalStateException.class, guard::verify);

			String message = thrown.getMessage();
			assertTrue(message.contains("Contents"), "어느 테이블인지 지목해야 한다: " + message);
			assertTrue(message.contains("secondEmbargoAt"), "빠진 컬럼을 지목해야 한다: " + message);
			assertTrue(message.contains("lockerSessionId"), "빠진 컬럼을 전부 지목해야 한다: " + message);
			assertFalse(message.contains("테이블 없음"), "이 DB에 없는 테이블은 없다(지목이 정확해야 한다): " + message);
		}
	}

	@Test
	void missingHistoryColumnsAreNamedInTheFailure() {
		// User·Article·Contents는 정본과 같고 ArticleHistory만 2컬럼이 빠진 DB — 넓어진 요구 목록에서도
		// 컬럼 단위 지목이 살아 있는지(단언 약화 없이) 실증한다.
		TempNewsDb.seed(tempDir, TempNewsDb.HISTORY_DRIFT_FIXTURE);

		try (HikariDataSource dataSource = NewsDataSource.create(tempDir)) {
			SchemaGuard guard = new SchemaGuard(
					dataSource, TempNewsDb.dbFile(tempDir).toAbsolutePath().toString(), false);

			IllegalStateException thrown = assertThrows(IllegalStateException.class, guard::verify);

			String message = thrown.getMessage();
			assertTrue(message.contains("ArticleHistory"), "어느 테이블인지 지목해야 한다: " + message);
			assertTrue(message.contains("snapshotTitle"), "빠진 컬럼을 지목해야 한다: " + message);
			assertTrue(message.contains("targetId"), "빠진 컬럼을 전부 지목해야 한다: " + message);
			assertFalse(message.contains("테이블 없음"), "이 DB에 없는 테이블은 없다(지목이 정확해야 한다): " + message);
		}
	}

	@Test
	void missingArticleTablesAreNamedInTheFailure() {
		// User만 있는 옛 드리프트 DB — 요구 목록이 넓어진 뒤로는 기사 3테이블이 통째로 없는 DB이기도 하다.
		TempNewsDb.seed(tempDir, TempNewsDb.DRIFT_FIXTURE);

		try (HikariDataSource dataSource = NewsDataSource.create(tempDir)) {
			SchemaGuard guard = new SchemaGuard(
					dataSource, TempNewsDb.dbFile(tempDir).toAbsolutePath().toString(), false);

			IllegalStateException thrown = assertThrows(IllegalStateException.class, guard::verify);

			String message = thrown.getMessage();
			assertTrue(message.contains("Article"), "없는 테이블 이름을 지목해야 한다: " + message);
			assertTrue(message.contains("Contents"), "없는 테이블 이름을 전부 지목해야 한다: " + message);
			assertTrue(message.contains("ArticleHistory"), "이력 테이블도 요구 목록에 있다: " + message);
		}
	}

	@Test
	void missingTableIsNamedInTheFailure() {
		TempNewsDb.seedEmpty(tempDir);

		try (HikariDataSource dataSource = NewsDataSource.create(tempDir)) {
			SchemaGuard guard = new SchemaGuard(
					dataSource, TempNewsDb.dbFile(tempDir).toAbsolutePath().toString(), false);

			IllegalStateException thrown = assertThrows(IllegalStateException.class, guard::verify);

			assertTrue(thrown.getMessage().contains("User"), "없는 테이블 이름을 지목해야 한다: " + thrown.getMessage());
		}
	}
}
