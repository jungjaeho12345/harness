package harness.newsmigrator;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.sql.Connection;
import java.sql.SQLException;
import java.sql.Statement;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/**
 * 소스는 <b>읽기 전용</b>이다 — 그리고 그 사실은 주석이 아니라 <b>드라이버의 거부</b>로 증명된다.
 *
 * <h2>왜 두 겹인가</h2>
 * 이 phase 의 완료 게이트는 "리포 {@code news.db} 가 실행 후 바이트 무변"이다. 그 게이트를 무너뜨리는
 * 경로는 SQL 만이 아니다 — 쓰기 모드로 열기만 해도 SQLite 는 저널·WAL 부산물을 남기고, WAL 전환은 파일
 * 자체를 변형한다. 그래서 ① JDBC 수준에서 읽기 전용으로 열고(잘못된 파라미터는 <b>조용히 무시</b>되므로
 * 실제로 쓰기를 시도해 확인한다) ② 마이그레이터 자신이 실행 전후의 크기·md5 를 재서 다르면 <b>비정상
 * 종료</b>한다.
 *
 * <h2>어느 파일을 쓰는가</h2>
 * 리포 {@code news.db} 는 열지 않는다. 같은 모양의 임시 파일({@link SqliteFixture})에서 판정하고, 실기
 * 원본 대조는 AC 의 1회 리허설이 소유한다.
 */
class SqliteSourceTest {

	@Test
	void aMissingSourceIsAnErrorAndIsNeverCreated(@TempDir Path directory) {
		Path missing = directory.resolve("no-such-news.db");

		IllegalStateException failure = assertThrows(IllegalStateException.class, () -> SqliteSource.open(missing));

		assertTrue(failure.getMessage().contains(missing.getFileName().toString()),
				"어느 파일이 없는지 밝히지 않는다: " + failure.getMessage());
		assertFalse(Files.exists(missing),
				"없는 소스를 새로 만들었다 — 경로 오타가 '0행 이관 성공'으로 끝나는 사고가 여기서 시작된다");
	}

	@Test
	void theSourceConnectionRefusesEveryWrite(@TempDir Path directory) throws SQLException {
		Path file = SqliteFixture.createSeeded(directory.resolve("news.db"));

		try (SqliteSource source = SqliteSource.open(file); Statement statement = source.connection().createStatement()) {
			SQLException refused = assertThrows(SQLException.class,
					() -> statement.executeUpdate("INSERT INTO User (userId) VALUES ('planted')"),
					"소스가 쓰기를 받아들였다 — 읽기 전용 설정이 조용히 무시됐다");

			assertTrue(refused.getMessage().toLowerCase().contains("readonly")
					|| refused.getMessage().toLowerCase().contains("read-only")
					|| refused.getMessage().toLowerCase().contains("read only"),
					"거부 이유가 읽기 전용이 아니다: " + refused.getMessage());
		}
	}

	@Test
	void readingLeavesTheFileByteIdenticalAndDropsNoSidecarFiles(@TempDir Path directory) throws IOException {
		Path file = SqliteFixture.createSeeded(directory.resolve("news.db"));
		SourceFingerprint before = SourceFingerprint.of(file);

		try (SqliteSource source = SqliteSource.open(file)) {
			assertEquals(4L, source.rowCount("User"), "표본 행 수");
			source.rows(BaselineSchema.load().table("Article"));
		}

		SourceFingerprint after = SourceFingerprint.of(file);
		assertEquals(before, after, "읽기만 했는데 소스 파일이 바뀌었다");
		for (String suffix : SourceFingerprint.SIDECAR_SUFFIXES) {
			Path sidecar = file.resolveSibling(file.getFileName() + suffix);
			assertFalse(Files.exists(sidecar), "읽기가 부산물을 남겼다: " + sidecar);
		}
		before.requireUnchanged(file);
	}

	@Test
	void aChangedSourceIsCaughtByTheFingerprintGuard(@TempDir Path directory) throws SQLException {
		Path file = SqliteFixture.createSeeded(directory.resolve("news.db"));
		SourceFingerprint before = SourceFingerprint.of(file);

		try (Connection connection = SqliteFixture.write(file); Statement statement = connection.createStatement()) {
			statement.executeUpdate("INSERT INTO User (userId) VALUES ('planted')");
		}

		SourceFingerprint after = SourceFingerprint.of(file);
		assertNotEquals(before.md5(), after.md5(), "픽스처가 실제로 바뀌지 않았다 — 아래 단언이 공허해진다");
		IllegalStateException failure = assertThrows(IllegalStateException.class, () -> before.requireUnchanged(file));
		assertTrue(failure.getMessage().contains("md5") || failure.getMessage().contains("크기"),
				"무엇이 달라졌는지 밝히지 않는다: " + failure.getMessage());
	}

	@Test
	void aPreExistingSidecarStopsTheRunBeforeAnythingIsRead(@TempDir Path directory) throws IOException {
		Path file = SqliteFixture.createSeeded(directory.resolve("news.db"));
		Path sidecar = file.resolveSibling(file.getFileName() + "-wal");
		Files.writeString(sidecar, "not empty", StandardCharsets.UTF_8);

		IllegalStateException failure = assertThrows(IllegalStateException.class, () -> SourceFingerprint.of(file));

		assertTrue(failure.getMessage().contains("-wal"), "어느 부산물이 있는지 밝히지 않는다: " + failure.getMessage());
	}

	@Test
	void theSourceReportsItsTablesColumnsAndCounts(@TempDir Path directory) {
		Path file = SqliteFixture.createSeeded(directory.resolve("news.db"));

		try (SqliteSource source = SqliteSource.open(file)) {
			assertEquals(List.of("Article", "ArticleHistory", "Contents", "DistributionTarget", "Photo",
					"ReceiverConfig", "User"), source.tableNames().stream().sorted().toList(), "소스 테이블 집합");
			assertEquals(0L, source.rowCount("DistributionTarget"), "빈 테이블의 행 수도 대조 대상이다");
			assertTrue(source.columnNames("Contents").containsAll(List.of("articleId", "embargoAt", "category")),
					"컬럼 이름을 읽지 못한다: " + source.columnNames("Contents"));
		}
	}

	/**
	 * <b>값 표현은 한 곳에서만 만들어진다</b> — NULL 과 빈 문자열이 구별되고, 정수 컬럼은 정수로 온다.
	 *
	 * <p>이 둘을 뭉개면 {@code embargoAt}(빈 문자열 52행 · NULL 10행 실측)의 엠바고 판정이 조용히 바뀐다.
	 */
	@Test
	void nullAndEmptyStringAndIntegersSurviveReadingUnmixed(@TempDir Path directory) {
		Path file = SqliteFixture.createSeeded(directory.resolve("news.db"));
		BaselineSchema schema = BaselineSchema.load();

		try (SqliteSource source = SqliteSource.open(file)) {
			Map<String, Object> empty = rowOf(source, schema, "Contents", "articleId", "a-1");
			Map<String, Object> missing = rowOf(source, schema, "Contents", "articleId", "a-2");
			Map<String, Object> history = rowOf(source, schema, "ArticleHistory", "id", 5L);

			assertEquals("", empty.get("embargoAt"), "빈 문자열이 NULL 로 뭉개졌다");
			assertEquals(null, missing.get("embargoAt"), "NULL 이 빈 문자열로 뭉개졌다");
			assertEquals(5L, history.get("id"), "정수 PK 가 정수로 오지 않는다");
			assertEquals(7L, history.get("targetId"), "정수 컬럼이 정수로 오지 않는다");
			assertEquals("", history.get("reason"), "빈 문자열이 사라졌다");
			assertEquals(null, history.get("markupVersion"), "NULL 이 사라졌다");
			assertEquals(SqliteFixture.LARGEST_TEXT_BYTES,
					rowOf(source, schema, "Article", "articleId", "a-1").get("markupVersion").toString()
							.getBytes(StandardCharsets.UTF_8).length,
					"최대 크기 본문이 읽는 단계에서 이미 잘렸다");
		}
	}

	private static Map<String, Object> rowOf(SqliteSource source, BaselineSchema schema, String table, String keyColumn,
			Object key) {
		for (Map<String, Object> row : source.rows(schema.table(table))) {
			if (key.equals(row.get(keyColumn))) {
				return row;
			}
		}
		throw new IllegalStateException("픽스처 행을 찾지 못했다: " + table + "." + keyColumn + "=" + key);
	}

}
