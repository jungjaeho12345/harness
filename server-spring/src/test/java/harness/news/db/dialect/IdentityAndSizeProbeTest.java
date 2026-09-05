package harness.news.db.dialect;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import harness.news.db.RequiredSchema;
import harness.news.testsupport.EphemeralMysqlDb;
import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Statement;
import java.util.List;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;

/**
 * 방언 측정 <b>축 6·7·8</b> — id 생성 · 대용량 텍스트 · 길이 초과.
 *
 * <h2>왜 이 셋이 한 파일인가</h2>
 * 셋 다 <b>타입 매핑을 결정</b>하는 측정이다. 축 6이 {@code INTEGER PRIMARY KEY} → {@code BIGINT
 * AUTO_INCREMENT}의 대가(재사용 없음·롤백 간격)를 재고, 축 7이 텍스트 컬럼을 {@code LONGTEXT}로
 * 두어야 하는 이유를 재고, 축 8이 PK만 {@code VARCHAR(768)}인 대가(수락 vs 거부)를 잰다.
 *
 * <p><b>변이 M4</b>: {@link #TEXT_COLUMN_TYPE}을 {@code VARCHAR(768)}로 바꾸면 축 7이 red다.
 * <b>변이 M5</b>: 축 6의 id 재사용 단언을 뒤집으면 red다. 결과표는 step summary에 있다.
 */
class IdentityAndSizeProbeTest {

	/** 이 phase가 채택한 텍스트 컬럼 타입 — PK 3종을 제외한 모든 텍스트 컬럼이 이것이다. */
	static final String TEXT_COLUMN_TYPE = "LONGTEXT";

	/** PK로 매핑되는 텍스트 컬럼의 타입. 768 = utf8mb4에서 단일 컬럼 인덱스 상한 3072바이트 / 4. */
	static final String PK_COLUMN_TYPE = "VARCHAR(768)";

	/** {@code Article.markupVersion}의 소스 실측 최대치(바이트) — VARCHAR로는 담을 수 없다. */
	static final int LARGEST_MARKUP_BYTES = 165_802;

	private static EphemeralMysqlDb mysql;

	private static Connection my;

	private static DialectProbe lite;

	@BeforeAll
	static void openBoth() throws SQLException {
		mysql = EphemeralMysqlDb.create();
		my = mysql.openConnection();
		lite = DialectProbe.sqlite();
	}

	@AfterAll
	static void closeBoth() throws SQLException {
		if (my != null) {
			my.close();
		}
		if (lite != null) {
			lite.close();
		}
		if (mysql != null) {
			mysql.close();
		}
	}

	// --- 축 6: id 생성 ---

	/**
	 * <b>축 6-①②③ — 연속 삽입 · 생성 키 반환 · 최댓값 삭제 후 재삽입.</b>
	 *
	 * <p>SQLite {@code INTEGER PRIMARY KEY}는 {@code AUTOINCREMENT}가 없으면 rowid를
	 * {@code max(rowid)+1}로 잡으므로 <b>지운 번호를 재사용</b>한다. InnoDB는 재사용하지 않는다.
	 *
	 * <p>이 divergence는 <b>실제로 도달 가능</b>하다 — 이 리포에서 행 삭제가 허용된 유일한 자리가
	 * {@code ReceiverConfigRepository.remove}(153행)의 {@code DELETE FROM ReceiverConfig}이고,
	 * 계약은 그 응답을 {@code 200 {ok:true, changes:1}}로 동결하되 <b>id 원값을 리포트에 싣지 않는다</b>.
	 * 즉 계약은 이 축을 보지 못한다 — 이 테스트가 유일 방어선이다.
	 */
	@Test
	void axis6_sqliteReusesDeletedIdsAndInnodbDoesNot() throws SQLException {
		lite.exec("CREATE TABLE Reuse (id INTEGER PRIMARY KEY, name VARCHAR)");
		DialectProbe.exec(my, "CREATE TABLE Reuse (id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY, name "
				+ TEXT_COLUMN_TYPE + ") ENGINE=InnoDB");

		for (String name : List.of("a", "b", "c")) {
			assertEquals(1, DialectProbe.update(lite.connection(), "INSERT INTO Reuse (name) VALUES (?)", name));
			assertEquals(1, DialectProbe.update(my, "INSERT INTO Reuse (name) VALUES (?)", name));
		}
		assertEquals(List.of("1", "2", "3"), ids(lite.connection()), "SQLite 연속 삽입 id");
		assertEquals(List.of("1", "2", "3"), ids(my), "MySQL 연속 삽입 id");

		// ② 생성 키 반환 — 리포지토리가 GeneratedKeyHolder로 읽는 값과 같은 경로다.
		assertEquals(4L, insertReturningKey(lite.connection(), "d"), "SQLite 생성 키");
		assertEquals(4L, insertReturningKey(my, "d"), "MySQL 생성 키");

		// ③ 최댓값 행을 지운 뒤 재삽입.
		assertEquals(1, DialectProbe.update(lite.connection(), "DELETE FROM Reuse WHERE id = 4"));
		assertEquals(1, DialectProbe.update(my, "DELETE FROM Reuse WHERE id = 4"));
		DialectProbe.update(lite.connection(), "INSERT INTO Reuse (name) VALUES ('e')");
		DialectProbe.update(my, "INSERT INTO Reuse (name) VALUES ('e')");

		assertEquals(List.of("1", "2", "3", "4"), ids(lite.connection()),
				"SQLite가 지운 id 4를 재사용하지 않았다 — 축 6의 divergence 기록이 틀렸다");
		assertEquals(List.of("1", "2", "3", "5"), ids(my),
				"InnoDB가 지운 id를 재사용했다 — 축 6의 divergence 기록이 틀렸다");
		assertNotEquals(ids(lite.connection()), ids(my), "이 축은 divergence다(같아지면 기록을 갱신하라)");
	}

	/**
	 * <b>축 6-④ — 롤백 후의 다음 id.</b> InnoDB는 소비한 번호를 되돌리지 않아 <b>간격</b>이 생기고,
	 * SQLite rowid는 {@code max(rowid)+1} 재계산이라 간격이 없다.
	 */
	@Test
	void axis6_rollbackLeavesAGapInInnodbButNotInSqlite() throws SQLException {
		lite.exec("CREATE TABLE Gap (id INTEGER PRIMARY KEY, name VARCHAR)");
		DialectProbe.exec(my, "CREATE TABLE Gap (id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY, name "
				+ TEXT_COLUMN_TYPE + ") ENGINE=InnoDB");

		assertEquals(List.of("1", "3"), rollbackProbe(my), "InnoDB 롤백 뒤 id에 간격이 없다");
		assertEquals(List.of("1", "2"), rollbackProbe(lite.connection()), "SQLite 롤백 뒤 id에 간격이 있다");

		long counter = DialectProbe.number(my,
				"SELECT AUTO_INCREMENT FROM INFORMATION_SCHEMA.TABLES"
						+ " WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'gap'");
		assertEquals(4L, counter, "AUTO_INCREMENT 카운터 실측이 달라졌다(테이블 이름은 소문자다 — 축 10)");
	}

	private static List<String> rollbackProbe(Connection connection) throws SQLException {
		connection.setAutoCommit(false);
		try {
			DialectProbe.update(connection, "INSERT INTO Gap (name) VALUES ('committed')");
			connection.commit();
			DialectProbe.update(connection, "INSERT INTO Gap (name) VALUES ('rolled-back')");
			connection.rollback();
			DialectProbe.update(connection, "INSERT INTO Gap (name) VALUES ('after-rollback')");
			connection.commit();
		}
		finally {
			connection.setAutoCommit(true);
		}
		return DialectProbe.strings(connection, "SELECT id FROM Gap ORDER BY id");
	}

	// --- 축 7: 대용량 텍스트 ---

	/**
	 * <b>축 7 — 165,802바이트 왕복.</b> {@code Article.markupVersion}의 소스 최대치다.
	 *
	 * <p>{@code max_allowed_packet}은 67,108,864바이트(실측)라 이 크기는 여유롭게 들어간다.
	 * <b>변이 M4</b>: {@link #TEXT_COLUMN_TYPE}을 {@code VARCHAR(768)}로 바꾸면 이 테스트가 red다 —
	 * 그래야 이 축이 공허하지 않다.
	 */
	@Test
	void axis7_theLargestMarkupRoundTripsThroughTheDecidedTextType() {
		String payload = "k".repeat(LARGEST_MARKUP_BYTES - 6) + "needle";
		assertEquals(LARGEST_MARKUP_BYTES, payload.length());

		lite.exec("CREATE TABLE Big (id VARCHAR PRIMARY KEY, body VARCHAR)");
		DialectProbe.exec(my, "CREATE TABLE Big (id " + PK_COLUMN_TYPE + " NOT NULL PRIMARY KEY, body "
				+ TEXT_COLUMN_TYPE + ") ENGINE=InnoDB");

		assertEquals("ok", DialectProbe.updateOutcome(lite.connection(),
				"INSERT INTO Big (id, body) VALUES ('a', ?)", payload), "SQLite 대용량 삽입 실패");
		assertEquals("ok", DialectProbe.updateOutcome(my,
				"INSERT INTO Big (id, body) VALUES ('a', ?)", payload),
				"MySQL 대용량 삽입 실패 — 텍스트 컬럼 타입(" + TEXT_COLUMN_TYPE + ")이 이 크기를 담지 못한다");

		assertEquals(payload, DialectProbe.string(lite.connection(), "SELECT body FROM Big WHERE id = 'a'"));
		assertEquals(payload, DialectProbe.string(my, "SELECT body FROM Big WHERE id = 'a'"));
		assertEquals(LARGEST_MARKUP_BYTES,
				DialectProbe.number(lite.connection(), "SELECT length(body) FROM Big WHERE id = 'a'"));
		assertEquals(LARGEST_MARKUP_BYTES, DialectProbe.number(my, "SELECT LENGTH(body) FROM Big WHERE id = 'a'"));

		// 대용량 컬럼 위의 LIKE도 같은 답을 낸다(ArticleRepository의 3컬럼 LIKE 경로).
		assertEquals(1, DialectProbe.number(lite.connection(),
				"SELECT COUNT(*) FROM Big WHERE body LIKE ?", "%needle%"));
		assertEquals(1, DialectProbe.number(my, "SELECT COUNT(*) FROM Big WHERE body LIKE ?", "%needle%"));

		assertTrue(DialectProbe.number(my, "SELECT @@max_allowed_packet") > LARGEST_MARKUP_BYTES,
				"max_allowed_packet이 소스 최대 본문보다 작다 — 이관이 패킷 상한에서 죽는다");
	}

	/**
	 * <b>축 7 보조 — 왜 {@code VARCHAR}가 원천 불가한가.</b> 세 가지가 물리적으로 막는다(실측).
	 */
	@Test
	void axis7_varcharCannotCarryTheSchemaAtAll() {
		// ① 29컬럼 VARCHAR(768) utf8mb4 = 행 크기 상한(65,535) 초과 → 1118.
		StringBuilder columns = new StringBuilder();
		for (String column : RequiredSchema.CONTENTS_COLUMNS) {
			columns.append(columns.isEmpty() ? "" : ", ").append(column).append(" VARCHAR(768)");
		}
		assertEquals("1118/42000", DialectProbe.updateOutcome(my,
				"CREATE TABLE RowTooLarge (" + columns + ") ENGINE=InnoDB"),
				"Contents 전 컬럼을 VARCHAR(768)로 두면 행 크기 상한에 걸린다는 실측이 달라졌다");

		// ② LONGTEXT는 길이 없는 PK가 될 수 없다 → 1170. (그래서 PK만 VARCHAR다.)
		assertEquals("1170/42000", DialectProbe.updateOutcome(my,
				"CREATE TABLE LongPk (articleId LONGTEXT NOT NULL, PRIMARY KEY (articleId)) ENGINE=InnoDB"));

		// ③ VARCHAR(769) PK는 인덱스 키 상한(3072바이트)을 넘는다 → 1071. 768이 상한인 근거다.
		assertEquals("1071/42000", DialectProbe.updateOutcome(my,
				"CREATE TABLE Pk769 (a VARCHAR(769) NOT NULL, PRIMARY KEY (a)) ENGINE=InnoDB"));
		assertEquals("ok", DialectProbe.updateOutcome(my,
				"CREATE TABLE Pk768 (a " + PK_COLUMN_TYPE + " NOT NULL, PRIMARY KEY (a)) ENGINE=InnoDB"));

		// ④ LONGTEXT는 리터럴 DEFAULT를 가질 수 없다 → 1101. 정본(src/db/schema.js)이 선언하는
		//    DEFAULT 'Y'(active·lockYN)·DEFAULT '0'(failedLoginCount)을 그대로 옮길 수 없다는 뜻이다.
		//    식(expression) DEFAULT는 8.0.13+에서 허용된다 — 어느 쪽을 쓸지는 Flyway V1(step2)의 결정이다.
		assertEquals("1101/42000", DialectProbe.updateOutcome(my,
				"CREATE TABLE LiteralDefault (a " + TEXT_COLUMN_TYPE + " DEFAULT 'Y') ENGINE=InnoDB"),
				"LONGTEXT가 리터럴 DEFAULT를 받아들였다 — 매핑표의 DEFAULT 기술을 갱신하라");
		assertEquals("ok", DialectProbe.updateOutcome(my,
				"CREATE TABLE ExpressionDefault (a " + TEXT_COLUMN_TYPE + " DEFAULT ('Y')) ENGINE=InnoDB"),
				"식 DEFAULT까지 거부된다면 DEFAULT는 애플리케이션이 전담해야 한다");
	}

	// --- 축 8: 길이 초과 = 수락 vs 거부 ---

	/**
	 * <b>축 8 — 절단이 아니라 「SQLite 수락 / MySQL 거부」다.</b>
	 *
	 * <p>SQLite의 {@code VARCHAR(n)}은 길이를 강제하지 않아 무엇이든 받는다. MySQL은
	 * {@code STRICT_TRANS_TABLES}(실측)에서 <b>1406으로 거부</b>하고 <b>조용히 자르지 않는다</b>
	 * (자른다면 그 매핑은 채택할 수 없다 — 값이 소리 없이 변한다).
	 *
	 * <p><b>도달 경로</b>: PK로 매핑되는 텍스트 컬럼은 셋이다 — {@code User.userId} ·
	 * {@code Article.articleId} · {@code Contents.articleId}. 뒤 둘은 서버가 발급하지만
	 * ({@code ArticleWriteService} 96행 {@code generateArticleId}, 클라이언트 값은 언제나 무시된다)
	 * <b>{@code User.userId}는 관리자 생성 API의 입력이 그대로 들어가고 길이 검증이 없다</b>
	 * ({@code UserService.create} — "입력 검증이 없다"가 클래스 주석에 명시된 의도적 재현이다).
	 * ⇒ 769자 {@code userId}로 사용자를 만들면 <b>Node 200 / Spring 500</b>이다. 이 divergence는
	 * {@code docs/db-mysql-mapping.md}에 기록되고 해소는 P3(애플리케이션 입력 검증)로 넘긴다 —
	 * 768은 utf8mb4 인덱스 상한이라 <b>길이를 늘려 회피할 수 없다</b>(위 축 7 보조 ③).
	 */
	@Test
	void axis8_overlongPrimaryKeysAreAcceptedBySqliteAndRejectedByMysql() {
		String overlong = "u".repeat(769);
		lite.exec("CREATE TABLE Pk (id VARCHAR(768) PRIMARY KEY)");
		DialectProbe.exec(my, "CREATE TABLE Pk (id " + PK_COLUMN_TYPE + " NOT NULL PRIMARY KEY) ENGINE=InnoDB");

		assertEquals("ok", DialectProbe.updateOutcome(lite.connection(),
				"INSERT INTO Pk (id) VALUES (?)", overlong), "SQLite VARCHAR(n)은 길이를 강제하지 않는다");
		assertEquals(769, DialectProbe.number(lite.connection(),
				"SELECT length(id) FROM Pk"), "SQLite가 값을 잘랐다 — 이 전제가 깨지면 divergence 기술이 틀린다");

		assertEquals("1406/22001", DialectProbe.updateOutcome(my,
				"INSERT INTO Pk (id) VALUES (?)", overlong),
				"MySQL이 1406으로 거부하지 않았다 — 조용한 절단이면 이 매핑을 채택할 수 없다");
		assertEquals(0, DialectProbe.number(my, "SELECT COUNT(*) FROM Pk"),
				"거부됐는데 행이 남았다 — 부분 삽입이면 이관 대조가 무너진다");

		// 상한 이하(768자)는 양쪽 다 수락한다 — 거부 축이 과도하지 않다는 대조군.
		String atLimit = "u".repeat(768);
		assertEquals("ok", DialectProbe.updateOutcome(my, "INSERT INTO Pk (id) VALUES (?)", atLimit));

		// PK로 매핑되는 텍스트 컬럼이 정확히 셋이라는 사실을 스키마 정본에서 재확인한다.
		assertEquals("userId", RequiredSchema.USER_COLUMNS.get(0));
		assertEquals("articleId", RequiredSchema.ARTICLE_COLUMNS.get(0));
		assertEquals("articleId", RequiredSchema.CONTENTS_COLUMNS.get(0));
	}

	// --- 도구 ---

	private static List<String> ids(Connection connection) {
		return DialectProbe.strings(connection, "SELECT id FROM Reuse ORDER BY id");
	}

	private static long insertReturningKey(Connection connection, String name) throws SQLException {
		try (PreparedStatement statement = connection.prepareStatement(
				"INSERT INTO Reuse (name) VALUES (?)", Statement.RETURN_GENERATED_KEYS)) {
			statement.setString(1, name);
			statement.executeUpdate();
			try (ResultSet keys = statement.getGeneratedKeys()) {
				return keys.next() ? keys.getLong(1) : -1L;
			}
		}
	}

}
