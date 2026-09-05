package harness.news.db.dialect;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.zaxxer.hikari.HikariDataSource;
import harness.news.db.DbProperties;
import harness.news.db.NewsDataSource;
import harness.news.testsupport.EphemeralMysqlDb;
import java.nio.file.Path;
import java.sql.Connection;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Statement;
import java.util.LinkedHashMap;
import java.util.Map;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;

/**
 * MySQL 분기의 <b>접속 후 read-back</b>(phase 75 step6 A) — 조용히 다른 설정으로 뜨지 않는다.
 *
 * <h2>왜 이 검증이 필요한가</h2>
 * 이 서버는 접속 파라미터를 코드에서 덧붙이지 않는다({@code NewsDataSource.mysqlConfig} — 배포마다
 * 다르기 때문이다). 그 결정의 대가는 <b>세션 설정의 출처가 배포 환경</b>이라는 것이고, 그래서 "어떤
 * 설정으로 떴는지"를 서버가 스스로 읽어 확인하지 않으면 아무도 확인하지 않는다.
 *
 * <p>가장 비싼 실패는 {@code STRICT_TRANS_TABLES}가 빠진 세션이다. 그 모드가 없으면 상한을 넘는 값이
 * <b>1406으로 거부되는 대신 조용히 잘려서</b> 저장된다 — 텍스트 PK를 {@code VARCHAR(768)}로 옮긴 결정이
 * "MySQL은 절단하지 않는다"는 축 8 실측 위에 서 있으므로(docs/db-mysql-mapping.md), 절단이 살아나면
 * {@code userId} 하나가 다른 계정과 충돌하는 형태의 데이터 손상이 된다. 이 클래스는 그 상황을
 * {@code sessionVariables}로 <b>실제로 재현해</b> 기동이 거부되는지 본다.
 *
 * <p><b>변이 M7</b>: {@code NewsDataSource.verifySession} 호출을 지우면 아래 거부 테스트가 red다
 * (결과표는 step summary).
 *
 * <p>대상 DB는 {@link EphemeralMysqlDb}가 만드는 {@code harness_ct_<16진수>}이고 자격은 {@code news_ct}다
 * — 리포 {@code news.db}도 {@code news_stage}도 열지 않는다.
 */
class MysqlSessionGuardTest {

	/** 대상 표기에 자격이 실리지 않았는지 보는 자리 — 실패 메시지는 {@code //} 이전만 싣는다. */
	private static final String SAFE_TARGET = NewsDataSource.MYSQL_URL_PREFIX;

	/**
	 * STRICT 없는 세션을 만드는 <b>유일한</b> URL 조합(2026-09-03 실측).
	 *
	 * <p>{@code sessionVariables}만으로는 만들어지지 않는다 — Connector/J는 기본
	 * {@code jdbcCompliantTruncation=true}일 때 세션 {@code sql_mode}에 {@code STRICT_TRANS_TABLES}를
	 * <b>스스로 다시 붙인다</b>(실측: {@code sql_mode='NO_ENGINE_SUBSTITUTION'}로 세워도 결과가
	 * {@code STRICT_TRANS_TABLES,NO_ENGINE_SUBSTITUTION}이었다). 즉 절단 방어선은 두 겹이고, 둘 다
	 * 무너뜨려야 이 상황이 재현된다. 그 사실 자체가 기록할 값이다(docs/db-mysql-mapping.md).
	 */
	private static final String WITHOUT_STRICT =
			"jdbcCompliantTruncation=false&sessionVariables=sql_mode='NO_ENGINE_SUBSTITUTION'";

	/** 문자셋이 어긋난 세션 — {@code characterEncoding} 한 글자 오타로 실제로 만들어진다(실측). */
	private static final String WRONG_CHARSET = "characterEncoding=latin1";

	private static EphemeralMysqlDb mysql;

	@BeforeAll
	static void createDatabase() {
		mysql = EphemeralMysqlDb.create();
	}

	@AfterAll
	static void dropDatabase() {
		if (mysql != null) {
			mysql.close();
		}
	}

	/** 기본 경로: 이 인스턴스의 세션은 의도한 값이고 서버는 그대로 뜬다. */
	@Test
	void theMysqlBranchOpensWhenTheSessionMatchesWhatWeIntend() throws SQLException {
		try (HikariDataSource dataSource = open(mysql.dbProperties())) {
			Map<String, String> session = readSession(dataSource);
			assertTrue(session.get("sql_mode").contains(NewsDataSource.REQUIRED_SQL_MODE),
					"이 인스턴스의 세션 sql_mode: " + session.get("sql_mode"));
			assertEquals(NewsDataSource.REQUIRED_CHARSET, session.get("character_set_client"));
			assertEquals(NewsDataSource.REQUIRED_CHARSET, session.get("character_set_connection"));
			assertTrue(session.get("collation_connection").startsWith(NewsDataSource.REQUIRED_CHARSET + "_"),
					"collation_connection: " + session.get("collation_connection"));
			assertEquals(NewsDataSource.MAX_POOL_SIZE, dataSource.getMaximumPoolSize(),
					"MySQL 분기도 풀 상한 1이다(ADR-016 결정 6)");
		}
	}

	/**
	 * <b>이 클래스의 핵심</b> — STRICT 모드가 빠진 세션으로는 뜨지 않는다.
	 *
	 * <p>{@code sessionVariables}로 접속 직후 {@code sql_mode}를 갈아 끼운다: 이것은 가공의 상황이 아니라
	 * 운영에서 {@code my.ini} 한 줄이나 URL 파라미터 하나로 실제로 만들어지는 상태다.
	 */
	@Test
	void startupIsRefusedWhenTheSessionLosesStrictMode() {
		DbProperties weakened = mysql.dbProperties(WITHOUT_STRICT);

		IllegalStateException thrown = assertThrows(IllegalStateException.class, () -> open(weakened).close());

		assertTrue(thrown.getMessage().contains(NewsDataSource.REQUIRED_SQL_MODE),
				"무엇이 없는지 지목해야 한다: " + thrown.getMessage());
		assertTrue(thrown.getMessage().contains("sql_mode"), thrown.getMessage());
	}

	/**
	 * 이 거부가 <b>공허하지 않다</b>는 증거 — 같은 세션에서 절단이 실제로 일어난다.
	 *
	 * <p>거부를 걷어내면 무엇을 잃는지 값으로 보여 준다: STRICT가 없는 세션은 상한을 넘는 값을 <b>거부하지
	 * 않고 잘라서</b> 저장한다. 축 8의 "MySQL은 절단하지 않는다"가 세션 설정에 달려 있다는 사실이 곧
	 * 이 read-back의 존재 이유다.
	 *
	 * <p>동시에 <b>방어가 두 겹</b>임도 보여 준다({@link #WITHOUT_STRICT}) — 서버 {@code sql_mode}만
	 * 약해져서는 이 상태가 되지 않고 드라이버의 {@code jdbcCompliantTruncation}까지 꺼야 한다. 그래도
	 * 읽어 확인하는 이유는 그 둘 다 <b>배포 환경이 정하는 값</b>이기 때문이다.
	 */
	@Test
	void withoutStrictModeAnOversizedValueIsSilentlyTruncatedInsteadOfRejected() throws SQLException {
		mysql.exec("CREATE TABLE IF NOT EXISTS SessionProbe (v VARCHAR(8)) "
				+ "ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin");

		String tooLong = "0123456789";
		String stored;
		try (Connection connection = openRaw(WITHOUT_STRICT);
				Statement statement = connection.createStatement()) {
			statement.executeUpdate("INSERT INTO SessionProbe (v) VALUES ('" + tooLong + "')");
			try (ResultSet rs = statement.executeQuery("SELECT v FROM SessionProbe")) {
				stored = rs.next() ? rs.getString(1) : null;
			}
		}

		assertEquals("01234567", stored, "STRICT가 없으면 거부가 아니라 절단이다 — 이것이 조용한 데이터 손상이다");
		assertFalse(tooLong.equals(stored), "절단이 실제로 일어났다");
	}

	/**
	 * 문자셋이 어긋난 세션도 거부한다 — {@code characterEncoding} 오타 하나가 한글을 깨뜨린다.
	 *
	 * <p>실측: {@code characterEncoding=latin1}이면 {@code character_set_client}·
	 * {@code character_set_connection}이 {@code latin1}이 되고 {@code collation_connection}은
	 * {@code latin1_swedish_ci}가 된다 — 기반선({@code utf8mb4_0900_bin}) 위에서 그대로 돌면 한글이
	 * 왕복에서 깨진다. 이 URL은 런북의 접속 문자열에서 값 하나만 바꾼 형태다.
	 */
	@Test
	void startupIsRefusedWhenTheConnectionCharacterSetIsNotUtf8mb4() {
		DbProperties mismatched = mysql.dbProperties(WRONG_CHARSET);

		IllegalStateException thrown = assertThrows(IllegalStateException.class, () -> open(mismatched).close());

		assertTrue(thrown.getMessage().contains("character_set_connection"),
				"어느 값이 어긋났는지 지목해야 한다: " + thrown.getMessage());
		assertTrue(thrown.getMessage().contains(NewsDataSource.REQUIRED_CHARSET), thrown.getMessage());
	}

	/**
	 * 실패 메시지가 <b>자격도 호스트도</b> 싣지 않는다 — 기동 로그는 가장 널리 읽히는 출력이다.
	 * ({@code NewsDataSource.describeTarget}의 규율을 이 경로도 따르는지 본다.)
	 */
	@Test
	void theRefusalMessageCarriesNeitherCredentialsNorHost() {
		DbProperties weakened = mysql.dbProperties(WITHOUT_STRICT);

		IllegalStateException thrown = assertThrows(IllegalStateException.class, () -> open(weakened).close());

		String message = thrown.getMessage();
		assertTrue(message.contains(SAFE_TARGET), "대상 표기는 방언 스킴까지다: " + message);
		assertFalse(message.contains("//"), "권한부(호스트·DB·질의)는 메시지에 없다: " + message);
		assertFalse(message.contains(mysql.database()), "임시 DB 이름조차 싣지 않는다: " + message);
		assertFalse(message.contains(weakened.username()), "계정 이름이 새지 않는다: " + message);
	}

	private static HikariDataSource open(DbProperties db) {
		return NewsDataSource.create(db, Path.of("."));
	}

	/** 서버 코드를 거치지 않고 같은 세션 설정으로 직접 연다(비공허성 실증 전용). */
	private static Connection openRaw(String extraQuery) throws SQLException {
		DbProperties db = mysql.dbProperties(extraQuery);
		return java.sql.DriverManager.getConnection(db.url(), db.username(), db.password());
	}

	private static Map<String, String> readSession(HikariDataSource dataSource) throws SQLException {
		Map<String, String> values = new LinkedHashMap<>();
		try (Connection connection = dataSource.getConnection();
				Statement statement = connection.createStatement();
				ResultSet rs = statement.executeQuery("SELECT @@session.sql_mode, @@session.character_set_client,"
						+ " @@session.character_set_connection, @@session.collation_connection")) {
			assertTrue(rs.next(), "세션 변수를 읽지 못했다");
			values.put("sql_mode", rs.getString(1));
			values.put("character_set_client", rs.getString(2));
			values.put("character_set_connection", rs.getString(3));
			values.put("collation_connection", rs.getString(4));
		}
		return values;
	}
}
