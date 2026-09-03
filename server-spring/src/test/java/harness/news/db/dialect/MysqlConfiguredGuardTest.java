package harness.news.db.dialect;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import harness.news.testsupport.EphemeralMysqlDb;
import java.sql.Connection;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Statement;
import java.util.List;
import org.junit.jupiter.api.Test;

/**
 * <b>fail-closed 가드</b> — MySQL이 없으면 이 스위트는 <b>green이 되지 않는다</b>(phase 75 decisions (14)).
 *
 * <h2>왜 skip이 아니라 fail인가</h2>
 * 이 리포의 정적 게이트는 <b>매번 공허했다</b>(71a 12/12 · 72 11/11 · 73 8/10 · 74 2건이 전부 green인 채로
 * 뚫렸다). 그 실패의 공통 형태는 "검사가 돌지 않았는데 green"이다. MySQL 측정 테스트를 조건부 skip으로
 * 두면 정확히 같은 형태가 재발한다 — 다른 사람이 다른 날 환경변수 없이 돌리면 P2의 모든 게이트가 조용히
 * 사라지고 스위트는 green이다.
 *
 * <p>대가는 명시적이다: <b>이 모듈의 {@code mvnw verify}는 MySQL 서버를 요구한다.</b> 그 트레이드오프는
 * ADR-016(step2)에 기록한다.
 *
 * <p><b>변이 M1</b>(2026-09-03 실측): 환경변수를 싣지 않고 {@code mvnw test}를 돌리면
 * {@link #theMysqlCredentialsAreConfigured}가 red다 — 이 가드가 공허하지 않다는 증거다.
 */
class MysqlConfiguredGuardTest {

	@Test
	void theMysqlCredentialsAreConfigured() {
		List<String> missing = EphemeralMysqlDb.missingKeys();
		assertTrue(missing.isEmpty(),
				"MySQL 접속 환경변수가 없다 — 이 스위트는 건너뛰지 않고 실패한다(조용한 skip 금지): " + missing
						+ " / 절차는 docs/ops-mysql.md");
		assertTrue(EphemeralMysqlDb.isConfigured(), "isConfigured()와 missingKeys()가 어긋난다");
	}

	/** 설정이 있다는 것과 <b>실제로 붙는다</b>는 것은 다르다 — 왕복 1건으로 그것까지 잠근다. */
	@Test
	void theCredentialsActuallyReachTheServer() throws SQLException {
		try (EphemeralMysqlDb db = EphemeralMysqlDb.create();
				Connection connection = db.openConnection();
				Statement statement = connection.createStatement();
				ResultSet rs = statement.executeQuery("SELECT DATABASE(), VERSION()")) {
			assertTrue(rs.next(), "SELECT가 행을 내지 않았다");
			assertEquals(db.database(), rs.getString(1), "만든 임시 DB가 아니라 다른 DB에 붙었다");
			assertTrue(rs.getString(2).startsWith("8.0."),
					"이 phase가 대상으로 삼은 MySQL 8.0이 아니다: " + rs.getString(2));
		}
	}

	/** 이 phase가 요구하는 서버 설정 — 세션 실측값이 정본이다(step0 D-3). */
	@Test
	void theServerSessionCarriesTheMeasuredSettings() throws SQLException {
		try (EphemeralMysqlDb db = EphemeralMysqlDb.create(); Connection connection = db.openConnection()) {
			assertEquals("1", variable(connection, "lower_case_table_names"),
					"테이블 이름 소문자화 전제가 깨졌다 — 축 10의 측정이 통째로 달라진다");
			assertTrue(variable(connection, "sql_mode").contains("STRICT_TRANS_TABLES"),
					"STRICT 모드가 아니면 축 8의 「길이 초과 = 거부」가 「조용한 절단」으로 바뀐다");
			assertEquals("utf8mb4", variable(connection, "character_set_server"));
			assertEquals(EphemeralMysqlDb.DEFAULT_COLLATION, variable(connection, "collation_database"),
					"임시 DB가 이 phase의 결정 collation으로 만들어지지 않았다");
		}
	}

	static String variable(Connection connection, String name) throws SQLException {
		try (Statement statement = connection.createStatement();
				ResultSet rs = statement.executeQuery("SHOW VARIABLES LIKE '" + name + "'")) {
			return rs.next() ? rs.getString(2) : null;
		}
	}

}
