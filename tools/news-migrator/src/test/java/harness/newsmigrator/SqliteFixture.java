package harness.newsmigrator;

import java.nio.file.Path;
import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.PreparedStatement;
import java.sql.SQLException;
import java.sql.Statement;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;

/**
 * 이관 <b>소스</b> 픽스처 — 정본({@code src/db/schema.js})의 정의를 그대로 쓴 SQLite 파일을 만든다.
 *
 * <h2>왜 리포 news.db 를 테스트에 쓰지 않는가</h2>
 * 그 파일은 이 phase 의 완료 게이트({@code md5} 무변)가 걸린 자산이다. 테스트가 그것을 열면
 * "테스트가 원본을 건드렸는가"라는 질문이 매 실행마다 생긴다. 그래서 <b>실기 대조는 AC 의 1회 리허설</b>이
 * 소유하고, 자동 스위트는 같은 모양의 임시 파일에서 판정한다.
 *
 * <h2>픽스처가 담는 값들은 임의가 아니다</h2>
 * 전부 소스 실측(2026-09-01)에서 온 형태다: NULL 과 빈 문자열의 공존({@code embargoAt} 은 빈 문자열 52행
 * · NULL 10행) · 한글({@code Contents.title} 76/77) · 165,802바이트 본문({@code Article.markupVersion}
 * 최댓값) · 비어 있는 테이블 2개({@code DistributionTarget} · {@code ReceiverConfig}) · 연속하지 않는
 * 정수 id. 대소문자만 다른 PK 는 실측 데이터에는 없지만 <b>collation 이 흔들리면 즉시 깨지는</b> 자리라
 * (ai_ci 면 두 행이 같은 키가 되어 삽입이 실패한다) 일부러 넣는다.
 */
final class SqliteFixture {

	/** {@code Article.markupVersion} 실측 최댓값 — 이 크기가 잘리지 않고 들어가는지가 step1 축 7 의 결론이다. */
	static final int LARGEST_TEXT_BYTES = 165_802;

	private SqliteFixture() {
	}

	/** 정본 스키마만 있는 빈 SQLite 파일을 만든다. */
	static Path createEmpty(Path file) {
		try (Connection connection = write(file); Statement statement = connection.createStatement()) {
			for (String ddl : canonicalDdl()) {
				statement.executeUpdate(ddl);
			}
		}
		catch (SQLException ex) {
			throw new IllegalStateException("픽스처 생성 실패: " + file, ex);
		}
		return file;
	}

	/** 정본 스키마 + 실측에서 온 표본 행들. */
	static Path createSeeded(Path file) {
		createEmpty(file);
		try (Connection connection = write(file)) {
			connection.setAutoCommit(false);
			insert(connection, "User", List.of("userId", "name", "password", "role", "department", "departmentCode",
					"active", "failedLoginCount", "lockedUntil", "lastFailedLoginAt"),
					List.of(row("u-1", "한글이름", "$2b$10$abcdefghijklmnopqrstuv", "ADMIN", "편집국", "D1", "Y", "0", null,
							null),
							// 빈 문자열과 NULL 이 같은 컬럼에 공존한다(실측) — 뭉개면 여기서 드러난다.
							row("u-2", "", "", "REPORTER", "", "D2", "Y", "3", "", null),
							// 대소문자만 다른 두 PK — ai_ci 였다면 두 번째 삽입이 중복 키로 죽는다.
							row("u-3", "Kim", "pw", "REPORTER", "사회부", "D3", "N", "0", null, null),
							row("U-3", "KIM", "PW", "REPORTER", "사회부", "D3", "Y", "0", null, null)));
			insert(connection, "Article", List.of("articleId", "title", "content", "markupVersion", "modifier"),
					List.of(row("a-1", "제목 하나", null, largestText(), "u-1"),
							row("a-2", "title two", null, "<p>짧은 본문</p>", null)));
			insert(connection, "Contents",
					List.of("articleId", "title", "author", "createdAt", "embargoAt", "secondEmbargoAt", "status",
							"lockYN", "category"),
					List.of(row("a-1", "제목 하나", "u-1", "2026-09-01T00:00:00.000Z", "", "", "작성중", "N", null),
							row("a-2", "title two", "u-2", "2026-09-01T00:00:01.000Z", null, null, "송고", "Y", "사회")));
			insert(connection, "ArticleHistory",
					List.of("id", "articleId", "eventType", "action", "actorUserId", "createdAt", "targetId", "reason"),
					// id 는 연속하지 않는다 — 재발번하면 이력 원장의 순서 키가 바뀐다.
					List.of(row(1L, "a-1", "created", "create", "u-1", "2026-09-01T00:00:00.000Z", null, null),
							row(5L, "a-1", "sent", "send", "u-1", "2026-09-01T00:00:02.000Z", 7L, ""),
							row(12L, "a-2", "distributed", null, "u-2", "2026-09-01T00:00:03.000Z", null, "재전송")));
			insert(connection, "Photo", List.of("id", "src", "caption", "sourceArticleId", "registeredBy", "createdAt"),
					List.of(row(3L, "/uploads/p.jpg", "사진 설명", "a-1", "u-1", "2026-09-01T00:00:04.000Z")));
			// DistributionTarget · ReceiverConfig 는 일부러 비운다(0행도 대조 대상이다).
			connection.commit();
		}
		catch (SQLException ex) {
			throw new IllegalStateException("픽스처 적재 실패: " + file, ex);
		}
		return file;
	}

	/** 실측 최댓값과 <b>같은 바이트 수</b>의 본문(한글 3바이트 × n + 1바이트). */
	static String largestText() {
		int hangul = (LARGEST_TEXT_BYTES - 1) / 3;
		return "가".repeat(hangul) + "x";
	}

	/** 쓰기 가능한 연결 — <b>테스트 트리 전용</b>이다(main 트리는 소스를 읽기 전용으로만 연다). */
	static Connection write(Path file) throws SQLException {
		return DriverManager.getConnection("jdbc:sqlite:" + file.toAbsolutePath());
	}

	private static void insert(Connection connection, String table, List<String> columns, List<List<Object>> rows)
			throws SQLException {
		String sql = "INSERT INTO " + table + " (" + String.join(", ", columns) + ") VALUES ("
				+ String.join(", ", columns.stream().map((ignored) -> "?").toList()) + ")";
		try (PreparedStatement statement = connection.prepareStatement(sql)) {
			for (List<Object> values : rows) {
				for (int i = 0; i < values.size(); i++) {
					statement.setObject(i + 1, values.get(i));
				}
				statement.addBatch();
			}
			statement.executeBatch();
		}
	}

	private static List<Object> row(Object... values) {
		List<Object> row = new ArrayList<>();
		for (Object value : values) {
			row.add(value);
		}
		return row;
	}

	/** 정본 정의를 그대로 쓴 SQLite DDL — 번역하지 않는다(번역하면 무엇을 재는지 흐려진다). */
	private static List<String> canonicalDdl() {
		List<String> ddl = new ArrayList<>();
		for (Map.Entry<String, List<CanonicalSchema.Column>> table : CanonicalSchema.load().tables().entrySet()) {
			List<String> columns = new ArrayList<>();
			for (CanonicalSchema.Column column : table.getValue()) {
				columns.add(column.name() + " " + column.definition());
			}
			ddl.add("CREATE TABLE IF NOT EXISTS " + table.getKey() + " (" + String.join(", ", columns) + ")");
		}
		return ddl;
	}

}
