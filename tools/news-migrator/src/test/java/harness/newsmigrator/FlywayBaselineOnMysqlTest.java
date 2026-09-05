package harness.newsmigrator;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.io.IOException;
import java.io.UncheckedIOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Statement;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.TreeSet;
import org.flywaydb.core.Flyway;
import org.flywaydb.core.api.FlywayException;
import org.flywaydb.core.api.configuration.FluentConfiguration;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;

/**
 * Flyway 기반선을 <b>실제 MySQL 에 적용해</b> 확인한다 — 그리고 {@code clean()} 이 정말로 거부되는지 본다.
 *
 * <h2>왜 정적 스캔만으로는 부족한가</h2>
 * {@code MigratorHasNoDestructiveSqlTest} 는 "소스에 그 호출이 없다"를 잡는다. 그러나 <b>설정이 조용히
 * 빠지는 것</b>은 못 잡는다 — {@code cleanDisabled(true)} 한 줄이 사라져도 소스에는 금지 철자가 없으므로
 * green 이다. 그 틈을 <b>행동</b>으로 막는다: 실제 Flyway 인스턴스에 {@code clean()} 을 걸어 예외가
 * 나는지, 그리고 그 뒤에도 <b>테이블이 살아 있는지</b>까지 본다.
 *
 * <p><b>어느 DB·어느 자격인가</b>: 전부 {@code news_ct} 자격의 {@code harness_ct_<16진수>} 임시 DB 이고
 * 클래스가 끝나면 DB 째 버린다(폭발 반경 0). {@code news}·{@code news_stage} 와 리포 {@code news.db} 는
 * 이 테스트가 열지 않는다.
 */
class FlywayBaselineOnMysqlTest {

	private static final String KEY_SET = "NEWS_CT_MYSQL";

	private static TargetCredentials root;

	private static TargetCredentials target;

	private static String database;

	@BeforeAll
	static void createEphemeralTarget() {
		root = TargetCredentials.of(KEY_SET, System::getenv);
		database = EphemeralDatabase.randomName();
		EphemeralDatabase.create(root, database);
		target = root.forDatabase(database);
	}

	@AfterAll
	static void discardEphemeralTarget() {
		if (root != null && database != null) {
			EphemeralDatabase.drop(root, database);
		}
	}

	/**
	 * <b>M10 의 방어선</b> — {@code cleanDisabled} 를 <b>명시로</b> 세운다. 라이브러리 기본값에 기대지 않는다.
	 *
	 * <p>이 단언이 씨앗 설정을 일부러 {@code false} 로 만들어 시작하는 이유가 그것이다: Flyway 10+ 의
	 * 기본값이 이미 {@code true} 라서, "기본값 그대로 두기"와 "우리가 명시로 잠그기"를 <b>결과로는 구분할
	 * 수 없다</b>. 기본값은 판본 업그레이드로 조용히 바뀔 수 있는 남의 결정이므로 우리 코드가 스스로
	 * 잠갔는지를 본다 — {@code harden()} 에서 그 한 줄을 지우면 여기가 red 다.
	 */
	@Test
	void hardenLocksCleanExplicitlyEvenWhenTheSeedTriesToTurnItOff() {
		FluentConfiguration hostile = Flyway.configure().cleanDisabled(false);

		assertTrue(MigratorFlyway.harden(hostile).isCleanDisabled(),
				"harden 이 clean 금지를 명시로 세우지 않는다 — 라이브러리 기본값에 기대고 있다");
		assertEquals(List.of(MigratorFlyway.MIGRATION_LOCATION),
				List.of(MigratorFlyway.harden(Flyway.configure()).getLocations()).stream().map(Object::toString)
						.toList(),
				"마이그레이션 위치가 고정돼 있지 않다(엉뚱한 디렉토리를 적용할 수 있다)");
	}

	@Test
	void theBaselineMigrationCreatesExactlyTheCanonicalTables() throws SQLException {
		MigratorFlyway.forTarget(target).migrate();

		TreeSet<String> expected = new TreeSet<>();
		for (String table : CanonicalSchema.load().tables().keySet()) {
			// lower_case_table_names=1 — 카탈로그에는 소문자로 남는다(step1 축 10 실측).
			expected.add(table.toLowerCase(Locale.ROOT));
		}
		expected.add("flyway_schema_history");

		assertEquals(expected, new TreeSet<>(tables()), "기반선이 만든 테이블 집합이 정본과 다르다");
	}

	/** 재실행 멱등 — 같은 대상에 두 번 적용해도 실패하지 않고 테이블도 그대로다(비파괴·멱등 규율). */
	@Test
	void applyingTheBaselineTwiceIsIdempotent() throws SQLException {
		MigratorFlyway.forTarget(target).migrate();
		List<String> after = tables();
		MigratorFlyway.forTarget(target).migrate();

		assertEquals(new TreeSet<>(after), new TreeSet<>(tables()), "두 번째 적용이 테이블 집합을 바꿨다");
	}

	/**
	 * <b>M8 의 행동 방어선</b> — {@code clean()} 은 <b>예외로 실패</b>하고 테이블은 살아남는다.
	 *
	 * <p>여기서 실제로 재는 것은 두 가지다: ① 호출이 거부된다 ② 거부가 "일부만 지우고 실패"가 아니다.
	 * ②를 함께 보지 않으면 "예외는 났는데 스키마는 이미 비었다"를 놓친다.
	 */
	@Test
	void cleanIsRefusedAtRuntimeAndEveryTableSurvives() throws SQLException {
		Flyway flyway = MigratorFlyway.forTarget(target);
		flyway.migrate();
		List<String> before = tables();
		assertTrue(before.size() >= 8, "적용 전 상태가 비어 있다 — 이 단언이 공허해진다: " + before);

		FlywayException refused = assertThrows(FlywayException.class, flyway::clean,
				"clean() 이 성공했다 — 스키마의 전 객체가 DROP 된다");

		assertNotNull(refused.getMessage());
		assertEquals(new TreeSet<>(before), new TreeSet<>(tables()),
				"clean() 이 거부되기 전에 이미 무언가를 지웠다");
	}

	/**
	 * <b>DEFAULT 이관 방식의 실측</b> — 값 없이 삽입한 컬럼이 <b>양쪽 엔진에서 같은 값</b>이 된다.
	 *
	 * <p>이 리포의 INSERT 는 전부 동적 컬럼 목록이라 값이 없는 컬럼은 SQL 에서 빠진다. 정본(SQLite)에서
	 * 그 자리는 {@code DEFAULT 'Y'} 로 채워지므로, 기반선이 DEFAULT 를 버렸다면 MySQL 에서는 {@code NULL} 이
	 * 되어 <b>이관이 동작을 바꾼다</b>. {@code LONGTEXT} 는 리터럴 DEFAULT 를 못 가지므로(1101) 식 DEFAULT
	 * 로 옮겼고, 그 선택이 실제로 같은 값을 내는지를 여기서 잰다.
	 */
	@Test
	void aColumnOmittedFromTheInsertGetsTheSameDefaultOnBothEngines() throws SQLException {
		MigratorFlyway.forTarget(target).migrate();

		Map<String, String> mysql = new LinkedHashMap<>();
		try (Connection connection = TargetCredentials.open(target)) {
			exec(connection, "INSERT INTO User (userId, name) VALUES ('probe-default', 'p')");
			mysql.put("active", scalar(connection, "SELECT active FROM User WHERE userId = 'probe-default'"));
			mysql.put("failedLoginCount",
					scalar(connection, "SELECT failedLoginCount FROM User WHERE userId = 'probe-default'"));
			exec(connection, "INSERT INTO Contents (articleId, title) VALUES ('probe-default', 't')");
			mysql.put("lockYN", scalar(connection, "SELECT lockYN FROM Contents WHERE articleId = 'probe-default'"));
		}

		Map<String, String> sqlite = new LinkedHashMap<>();
		Path file = temporarySqliteFile();
		try (Connection connection = DriverManager.getConnection("jdbc:sqlite:" + file.toAbsolutePath())) {
			for (String ddl : canonicalSqliteDdl()) {
				exec(connection, ddl);
			}
			exec(connection, "INSERT INTO User (userId, name) VALUES ('probe-default', 'p')");
			sqlite.put("active", scalar(connection, "SELECT active FROM User WHERE userId = 'probe-default'"));
			sqlite.put("failedLoginCount",
					scalar(connection, "SELECT failedLoginCount FROM User WHERE userId = 'probe-default'"));
			exec(connection, "INSERT INTO Contents (articleId, title) VALUES ('probe-default', 't')");
			sqlite.put("lockYN", scalar(connection, "SELECT lockYN FROM Contents WHERE articleId = 'probe-default'"));
		}
		finally {
			removeQuietly(file);
		}

		assertEquals(Map.of("active", "Y", "failedLoginCount", "0", "lockYN", "N"), sqlite,
				"정본(SQLite)의 DEFAULT 동작이 실측과 다르다 — 기준이 흔들렸다");
		assertEquals(sqlite, mysql, "값 없이 삽입한 컬럼이 두 엔진에서 다르다 — 이관이 동작을 바꿨다");
	}

	/** 컬럼 타입·collation 이 결정값 그대로 적용됐는가(문서가 아니라 카탈로그에서 읽는다). */
	@Test
	void theAppliedColumnTypesAndCollationMatchTheDecidedMapping() throws SQLException {
		MigratorFlyway.forTarget(target).migrate();

		try (Connection connection = TargetCredentials.open(target)) {
			assertEquals("varchar(768)", columnType(connection, "user", "userId"), "텍스트 PK 타입");
			assertEquals("longtext", columnType(connection, "user", "name"), "텍스트 컬럼 타입");
			assertEquals("bigint", columnType(connection, "articlehistory", "id"), "정수 PK 타입");
			assertEquals("bigint", columnType(connection, "articlehistory", "targetId"), "targetId 타입");
			assertEquals("utf8mb4_0900_bin", scalar(connection,
					"SELECT COLLATION_NAME FROM INFORMATION_SCHEMA.COLUMNS"
							+ " WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'user' AND COLUMN_NAME = 'userId'"),
					"컬럼 collation 이 결정값과 다르다 — = 비교(보안 축)가 SQLite 와 갈린다");
			assertEquals("auto_increment", scalar(connection,
					"SELECT EXTRA FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE()"
							+ " AND TABLE_NAME = 'articlehistory' AND COLUMN_NAME = 'id'"),
					"정수 PK 가 자동 증가가 아니다");
		}
	}

	/** 보조 인덱스가 실제로 <b>하나도 만들어지지 않았는가</b>(PK 자동 인덱스만 남는다). */
	@Test
	void noSecondaryIndexExistsAfterTheBaselineIsApplied() throws SQLException {
		MigratorFlyway.forTarget(target).migrate();

		try (Connection connection = TargetCredentials.open(target)) {
			List<String> extra = new ArrayList<>();
			try (Statement statement = connection.createStatement();
					ResultSet rs = statement.executeQuery(
							"SELECT TABLE_NAME, INDEX_NAME FROM INFORMATION_SCHEMA.STATISTICS"
									+ " WHERE TABLE_SCHEMA = DATABASE() AND INDEX_NAME <> 'PRIMARY'"
									+ " AND TABLE_NAME <> 'flyway_schema_history'")) {
				while (rs.next()) {
					extra.add(rs.getString(1) + "." + rs.getString(2));
				}
			}
			assertEquals(List.of(), extra, "PK 밖의 인덱스가 생겼다(패리티 원칙 위반 — 성능 축은 P3)");
		}
	}

	// --- 도구 ---

	private static List<String> tables() throws SQLException {
		List<String> names = new ArrayList<>();
		try (Connection connection = TargetCredentials.open(target);
				Statement statement = connection.createStatement();
				ResultSet rs = statement.executeQuery(
						"SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = DATABASE()")) {
			while (rs.next()) {
				names.add(rs.getString(1));
			}
		}
		return names;
	}

	private static String columnType(Connection connection, String table, String column) throws SQLException {
		try (Statement statement = connection.createStatement();
				ResultSet rs = statement.executeQuery("SELECT COLUMN_TYPE FROM INFORMATION_SCHEMA.COLUMNS"
						+ " WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = '" + table + "'"
						+ " AND COLUMN_NAME = '" + column + "'")) {
			return rs.next() ? rs.getString(1) : null;
		}
	}

	private static void exec(Connection connection, String sql) throws SQLException {
		try (Statement statement = connection.createStatement()) {
			statement.executeUpdate(sql);
		}
	}

	private static String scalar(Connection connection, String sql) throws SQLException {
		try (Statement statement = connection.createStatement(); ResultSet rs = statement.executeQuery(sql)) {
			return rs.next() ? rs.getString(1) : null;
		}
	}

	/** 정본 정의를 그대로 쓴 SQLite DDL — 기준 쪽을 번역하지 않는다(번역하면 무엇을 재는지 흐려진다). */
	private static List<String> canonicalSqliteDdl() {
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

	private static Path temporarySqliteFile() {
		try {
			Path file = Files.createTempFile("news-migrator-default-probe-", ".db");
			removeQuietly(file);
			return file;
		}
		catch (IOException ex) {
			throw new UncheckedIOException(ex);
		}
	}

	/** 임시 픽스처 파일 정리(테스트 트리 전용 — main 트리에는 파일을 지우는 코드가 없다). */
	private static void removeQuietly(Path file) {
		try {
			Files.deleteIfExists(file);
		}
		catch (IOException ignored) {
			// 임시 파일 정리는 best-effort — 판정에 영향을 주지 않는다.
		}
	}

}
