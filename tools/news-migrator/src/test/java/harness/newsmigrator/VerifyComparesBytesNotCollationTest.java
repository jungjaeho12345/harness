package harness.newsmigrator;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.sql.Connection;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Statement;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;

/**
 * <b>M8 의 자리</b> — 대조를 DB 의 {@code =} 에 맡기면 무엇이 통과하는가.
 *
 * <h2>왜 이것이 설계 판정인가</h2>
 * "대조기가 두 값을 어떻게 비교하는가"는 취향이 아니다. DB 의 {@code =} 로 비교하면 판정자는
 * <b>그 컬럼의 collation</b> 이고, 그것은 대조기가 통제하지 못하는 값이다 — 이 서버의 기본 collation 은
 * {@code utf8mb4_0900_ai_ci}(step0 실측)이므로, 대상 스키마가 손으로 만들어졌거나 기반선이 바뀌면 대조는
 * <b>조용히 눈을 감는다</b>. 그때 통과하는 것은 사소한 차이가 아니다: 대소문자만 다른 {@code userId} 는
 * 인증 축이고(다른 계정으로 로그인), 후행 공백은 비밀번호 비교 축이다.
 *
 * <p>그래서 대조는 Java 에서 UTF-8 바이트로 한다({@link CellValues#sameBytes}). 아래는 <b>같은 데이터에서
 * 두 방식의 결론이 실제로 갈리는지</b>를 잰 기록이다 — 갈리지 않으면 이 설계 결정에 근거가 없다.
 *
 * <p><b>어느 DB·어느 자격</b>: {@code news_ct} 자격의 {@code harness_ct_<16진수>} 임시 DB. 끝나면 DB 째
 * 버린다.
 */
class VerifyComparesBytesNotCollationTest {

	private static final String KEY_SET = "NEWS_CT_MYSQL";

	private static TargetCredentials server;

	private static TargetCredentials target;

	private static String database;

	@BeforeAll
	static void createEphemeralTarget() throws SQLException {
		server = TargetCredentials.of(KEY_SET, System::getenv);
		database = EphemeralDatabase.randomName();
		EphemeralDatabase.create(server, database);
		target = server.forDatabase(database);
		try (Connection connection = TargetCredentials.open(target); Statement statement = connection.createStatement()) {
			// 서버 기본 collation 으로 만들어진 대상(= 사람이 손으로 만든 스키마)을 흉내 낸다.
			statement.executeUpdate("CREATE TABLE drifted (v LONGTEXT COLLATE utf8mb4_0900_ai_ci)");
			statement.executeUpdate("CREATE TABLE padded (v LONGTEXT COLLATE utf8mb4_bin)");
			statement.executeUpdate("CREATE TABLE decided (v LONGTEXT COLLATE utf8mb4_0900_bin)");
			for (String table : new String[] { "drifted", "padded", "decided" }) {
				statement.executeUpdate("INSERT INTO " + table + " (v) VALUES ('abc')");
				statement.executeUpdate("INSERT INTO " + table + " (v) VALUES ('x')");
			}
		}
	}

	@AfterAll
	static void discardEphemeralTarget() {
		if (server != null && database != null) {
			EphemeralDatabase.drop(server, database);
		}
	}

	/** 대상 collation 이 흔들리면 DB 의 {@code =} 는 <b>대소문자 차이를 통과시킨다</b>. */
	@Test
	void theDatabaseEqualsOperatorPassesACaseOnlyDifferenceWhenTheCollationDrifts() throws SQLException {
		assertEquals(1, matches("drifted", "ABC"), "ai_ci 대상에서 대소문자 차이가 걸렸다 — 이 측정의 전제가 깨졌다");

		assertFalse(CellValues.sameBytes("abc", "ABC"), "바이트 대조가 대소문자 차이를 통과시켰다");
	}

	/** {@code utf8mb4_bin} 은 PAD SPACE 라 <b>후행 공백을 무시한다</b>(step1 축 3 실측의 재확인). */
	@Test
	void theDatabaseEqualsOperatorPassesATrailingSpaceUnderThePaddingCollation() throws SQLException {
		assertEquals(1, matches("padded", "x "), "utf8mb4_bin 이 후행 공백을 구분했다 — 이 측정의 전제가 깨졌다");

		assertFalse(CellValues.sameBytes("x", "x "), "바이트 대조가 후행 공백을 통과시켰다");
	}

	/**
	 * 우리가 고른 collation({@code utf8mb4_0900_bin})에서는 두 방식의 결론이 <b>같다</b>.
	 *
	 * <p>이 단언이 있는 이유: "그러면 DB 의 {@code =} 로도 되지 않느냐"는 반문에 대한 답이 여기 있다.
	 * 지금 같다는 사실은 <b>지금의 기반선</b>이 그 collation 을 쓰기 때문이고, 대조기가 그 사실에 의존하면
	 * 기반선이 흔들린 대상을 못 잡는다. 대조기는 자기가 통제하는 것(바이트)만 믿는다.
	 */
	@Test
	void underTheDecidedCollationBothApproachesAgreeWhichIsWhyTheDependencyMustNotBeHidden() throws SQLException {
		assertEquals(0, matches("decided", "ABC"), "결정한 collation 이 대소문자를 무시한다 — 인증 축이 무너진다");
		assertEquals(0, matches("decided", "x "), "결정한 collation 이 후행 공백을 무시한다 — 인증 축이 무너진다");

		assertTrue(CellValues.sameBytes("abc", "abc"), "같은 값을 다르다고 본다");
	}

	private static int matches(String table, String probe) throws SQLException {
		try (Connection connection = TargetCredentials.open(target);
				Statement statement = connection.createStatement();
				ResultSet rows = statement
						.executeQuery("SELECT COUNT(*) FROM " + table + " WHERE v = '" + probe + "'")) {
			return rows.next() ? rows.getInt(1) : -1;
		}
	}

}
