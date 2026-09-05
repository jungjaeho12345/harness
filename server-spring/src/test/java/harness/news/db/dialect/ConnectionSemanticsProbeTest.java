package harness.news.db.dialect;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.zaxxer.hikari.HikariConfig;
import com.zaxxer.hikari.HikariDataSource;
import harness.news.db.NewsDataSource;
import harness.news.testsupport.EphemeralMysqlDb;
import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.SQLException;
import java.sql.Statement;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;

/**
 * 방언 측정 <b>축 11</b> — 접속 파라미터 · 트랜잭션 · <b>단일 연결의 노후화</b>.
 *
 * <h2>SQLite에는 없던 축</h2>
 * 파일 DB에는 "서버가 내 연결을 끊는" 일이 없다. MySQL은 {@code wait_timeout}(실측 28,800초) 동안 유휴한
 * 연결을 <b>서버가 닫는다</b>. 그리고 이 서버는 {@link NewsDataSource#MAX_POOL_SIZE}가 <b>1</b>이라
 * (decisions (10) — 유지 결정) 그 하나가 죽으면 다음 요청이 그대로 실패할 수 있다. 운영에서 "밤새 놀다가
 * 아침 첫 요청이 500"으로 처음 드러나는 유형이라 여기서 실측한다.
 *
 * <p>8시간을 기다릴 수는 없으므로 <b>세션 {@code wait_timeout}을 줄여 축소 재현</b>한다 — 서버가 실제로
 * 유휴 연결을 죽이는지, 그리고 풀이 그것을 <b>스스로 갈아 끼우는지</b>를 본다.
 */
class ConnectionSemanticsProbeTest {

	/** 축소 재현용 세션 유휴 상한(초). 서버 기본값 28,800초를 기다릴 수는 없다. */
	private static final int SHORT_WAIT_TIMEOUT_SECONDS = 2;

	private static EphemeralMysqlDb mysql;

	private static Connection my;

	@BeforeAll
	static void openMysql() throws SQLException {
		mysql = EphemeralMysqlDb.create();
		my = mysql.openConnection();
		DialectProbe.exec(my, "CREATE TABLE Tx (id VARCHAR(768) NOT NULL PRIMARY KEY, v LONGTEXT)");
	}

	@AfterAll
	static void closeMysql() throws SQLException {
		if (my != null) {
			my.close();
		}
		if (mysql != null) {
			mysql.close();
		}
	}

	/**
	 * <b>접속 파라미터의 최소 집합.</b> 하나씩 빼 보며 실제로 필요한 것을 찾는다.
	 *
	 * <p>실측 결론(2026-09-03): <b>파라미터가 하나도 없어도 붙는다.</b> Connector/J 9의 기본
	 * {@code sslMode=PREFERRED}가 TLS를 협상하고({@code have_ssl=YES} 실측)
	 * {@code caching_sha2_password}의 최초 인증이 TLS 위에서 끝나기 때문이다.
	 * {@code allowPublicKeyRetrieval=true}가 필요한 것은 <b>{@code useSSL=false}(=평문)와 짝일 때</b>다 —
	 * 즉 그 둘은 하나의 선택지이지 각각 독립한 필수 항목이 아니다. {@code characterEncoding=UTF-8}도
	 * 서버 기본이 {@code utf8mb4}라 없어도 한글이 온전히 왕복한다(아래에서 확인한다).
	 */
	@Test
	void axis11_theConnectionParametersAreAChoiceNotARequirement() {
		Map<String, String> outcomes = new LinkedHashMap<>();
		for (String query : List.of("", "?useSSL=false&allowPublicKeyRetrieval=true",
				"?sslMode=DISABLED&allowPublicKeyRetrieval=true", "?characterEncoding=UTF-8")) {
			outcomes.put(query.isEmpty() ? "<none>" : query, connectOutcome(query));
		}
		assertEquals(Map.of("<none>", "ok",
				"?useSSL=false&allowPublicKeyRetrieval=true", "ok",
				"?sslMode=DISABLED&allowPublicKeyRetrieval=true", "ok",
				"?characterEncoding=UTF-8", "ok"), outcomes,
				"접속 파라미터 실측이 달라졌다 — docs/db-mysql-mapping.md의 확정 집합을 갱신하라");

		// 설정된 URL 자체도 붙는다(위 조합의 대조군이자 실제 사용 경로다).
		assertEquals("ok", DialectProbe.string(my, "SELECT 'ok'"));
	}

	/** 파라미터가 없어도 한글이 온전히 왕복한다 — 서버 기본 문자셋이 {@code utf8mb4}이기 때문이다. */
	@Test
	void axis11_hangulRoundTripsRegardlessOfTheEncodingParameter() throws SQLException {
		String hangul = "한글 원문 — 왕복";
		try (Connection bare = DriverManager.getConnection(
				EphemeralMysqlDb.urlForDatabase(authority(), mysql.database()),
				System.getenv(EphemeralMysqlDb.USERNAME_KEY),
				System.getenv(EphemeralMysqlDb.PASSWORD_KEY))) {
			DialectProbe.update(bare, "INSERT INTO Tx (id, v) VALUES ('bare', ?)", hangul);
			assertEquals(hangul, DialectProbe.string(bare, "SELECT v FROM Tx WHERE id = 'bare'"));
		}
		assertEquals(hangul, DialectProbe.string(my, "SELECT v FROM Tx WHERE id = 'bare'"),
				"파라미터 있는 연결에서 다시 읽었을 때 값이 달라졌다 — 인코딩이 갈렸다");

		Map<String, String> charsets = new LinkedHashMap<>();
		for (String variable : List.of("character_set_client", "character_set_connection",
				"character_set_results", "collation_connection")) {
			charsets.put(variable, DialectProbe.string(my, "SELECT @@" + variable));
		}
		// 실측(2026-09-03): character_set_results는 NULL이다 — Connector/J가 결과 문자셋을 서버 기본에
		// 맡긴다는 뜻이고, 서버 기본이 utf8mb4라 한글이 온전히 돌아온다(위 왕복이 그 증거다).
		// collation_connection은 ai_ci이지만 **컬럼 collation이 우선**한다(coercibility): 축 3의
		// axis3_equality...가 같은 연결에서 컬럼별로 다른 답을 얻은 것이 그 증거다.
		Map<String, String> expected = new LinkedHashMap<>();
		expected.put("character_set_client", "utf8mb4");
		expected.put("character_set_connection", "utf8mb4");
		expected.put("character_set_results", null);
		expected.put("collation_connection", "utf8mb4_0900_ai_ci");
		assertEquals(expected, charsets, "세션 문자셋 실측이 달라졌다");
	}

	/**
	 * <b>트랜잭션.</b> autocommit 기본값과 롤백이 SQLite와 동형인지 본다(id 축은 축 6이 따로 잰다).
	 */
	@Test
	void axis11_autocommitAndRollbackBehaveLikeSqlite() throws SQLException {
		try (DialectProbe lite = DialectProbe.sqlite()) {
			lite.exec("CREATE TABLE Tx (id VARCHAR PRIMARY KEY, v VARCHAR)");
			for (Connection connection : List.of(lite.connection(), my)) {
				String where = connection == my ? "MySQL" : "SQLite";
				assertTrue(connection.getAutoCommit(), where + ": 기본 autocommit이 켜져 있지 않다");
				DialectProbe.update(connection, "INSERT INTO Tx (id, v) VALUES ('tx', 'before')");
				connection.setAutoCommit(false);
				try {
					DialectProbe.update(connection, "UPDATE Tx SET v = 'after' WHERE id = 'tx'");
					assertEquals("after",
							DialectProbe.string(connection, "SELECT v FROM Tx WHERE id = 'tx'"),
							where + ": 트랜잭션 안에서 자기 변경이 안 보인다");
					connection.rollback();
				}
				finally {
					connection.setAutoCommit(true);
				}
				assertEquals("before", DialectProbe.string(connection, "SELECT v FROM Tx WHERE id = 'tx'"),
						where + ": 롤백이 변경을 되돌리지 않았다");
			}
		}
		assertEquals(50L, DialectProbe.number(my, "SELECT @@innodb_lock_wait_timeout"),
				"innodb_lock_wait_timeout 실측이 달라졌다");
	}

	/**
	 * <b>단일 연결의 노후화 — 이 축의 본론.</b>
	 *
	 * <p>① 서버는 유휴 연결을 실제로 죽인다(세션 {@code wait_timeout}을 줄여 축소 재현).
	 * ② 그런데도 Hikari는 빌려 줄 때 살아 있는지 확인하고 죽었으면 <b>새로 연다</b> — 풀 크기가 1이어도
	 * 다음 요청이 성공한다. ③ 그리고 Hikari 기본 {@code maxLifetime}(1,800,000ms = 30분)이
	 * 서버 {@code wait_timeout}(28,800초 = 8시간)보다 <b>훨씬 짧으므로</b> 물리 연결은 서버가 죽이기
	 * 한참 전에 스스로 교체된다. ⇒ 명시 설정을 추가할 이유가 없다(설정을 안 하는 것도 결정이다).
	 *
	 * <p><b>미측정</b>: 실제 8시간 유휴 후의 첫 요청은 재지 않았다(시간). 대신 위 축소 재현으로 같은
	 * 메커니즘을 실증했다.
	 */
	@Test
	void axis11_aPoolOfOneSurvivesTheServerKillingItsIdleConnection() throws SQLException, InterruptedException {
		long serverWaitTimeout = DialectProbe.number(my, "SELECT @@wait_timeout");
		assertEquals(28800L, serverWaitTimeout, "wait_timeout 실측이 달라졌다");

		HikariConfig config = new HikariConfig();
		config.setPoolName("dialect-probe");
		config.setJdbcUrl(mysql.jdbcUrl());
		config.setUsername(System.getenv(EphemeralMysqlDb.USERNAME_KEY));
		config.setPassword(System.getenv(EphemeralMysqlDb.PASSWORD_KEY));
		config.setMaximumPoolSize(NewsDataSource.MAX_POOL_SIZE);

		assertEquals(1, config.getMaximumPoolSize(), "이 서버의 풀 상한은 1이다(decisions (10))");
		assertTrue(config.getMaxLifetime() < serverWaitTimeout * 1000L,
				"Hikari maxLifetime(" + config.getMaxLifetime() + "ms)이 서버 wait_timeout("
						+ serverWaitTimeout + "s)보다 길다 — 서버가 먼저 끊어 다음 요청이 실패한다");

		try (HikariDataSource pool = new HikariDataSource(config)) {
			try (Connection borrowed = pool.getConnection(); Statement statement = borrowed.createStatement()) {
				statement.executeUpdate("SET SESSION wait_timeout = " + SHORT_WAIT_TIMEOUT_SECONDS);
			}
			Thread.sleep((SHORT_WAIT_TIMEOUT_SECONDS + 2) * 1000L);

			// 풀에 남아 있던 그 하나는 서버가 이미 죽였다. 그래도 다음 요청은 성공해야 한다.
			try (Connection borrowed = pool.getConnection()) {
				assertEquals("alive", DialectProbe.string(borrowed, "SELECT 'alive'"),
						"풀 크기 1에서 서버가 유휴 연결을 죽인 뒤 다음 요청이 실패했다");
			}
		}
	}

	// --- 도구 ---

	/** 설정된 URL에서 질의 문자열을 뺀 서버 주소. */
	private static String authority() {
		String url = System.getenv(EphemeralMysqlDb.URL_KEY);
		int question = url.indexOf('?');
		return question < 0 ? url : url.substring(0, question);
	}

	private static String connectOutcome(String query) {
		String url = EphemeralMysqlDb.urlForDatabase(authority(), mysql.database()) + query;
		try (Connection connection = DriverManager.getConnection(url,
				System.getenv(EphemeralMysqlDb.USERNAME_KEY),
				System.getenv(EphemeralMysqlDb.PASSWORD_KEY))) {
			return connection.isValid(2) ? "ok" : "invalid";
		}
		catch (SQLException ex) {
			return ex.getErrorCode() + "/" + ex.getSQLState();
		}
	}

}
