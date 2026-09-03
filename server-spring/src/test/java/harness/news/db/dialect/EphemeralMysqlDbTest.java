package harness.news.db.dialect;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import harness.news.testsupport.EphemeralMysqlDb;
import java.sql.Connection;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Statement;
import java.util.List;
import org.junit.jupiter.api.Test;

/**
 * 임시 MySQL DB의 <b>삭제 경계</b>와 URL 조립을 잠근다(phase 75 step1 A).
 *
 * <p><b>변이 M2</b>(2026-09-03 실측): {@link EphemeralMysqlDb#EPHEMERAL_NAME}을 {@code ^harness_ct_.*$}
 * 로 넓히면 {@link #theDropGuardRejectsAnythingOutsideTheEphemeralNaming}의 접두사-형태만-맞는 이름 3건이
 * 통과해 red가 된다. 즉 이 가드는 "이름이 news인가"만 보는 것이 아니라 <b>형태 전체</b>를 본다.
 */
class EphemeralMysqlDbTest {

	/** 뉴스 데이터를 담은 이름들과, 접두사만 흉내 낸 이름들. 어느 쪽도 드롭되지 않는다. */
	private static final List<String> FORBIDDEN_NAMES = List.of(
			"news", "news_stage", "news_grant_probe", "mysql", "information_schema",
			"harness_ct_", "harness_ct_0123456789abcde", "harness_ct_0123456789abcdef0",
			"harness_ct_0123456789ABCDEF", "harness_ct_zzzzzzzzzzzzzzzz", "harness_ct_news",
			"xharness_ct_0123456789abcdef", "harness_ct_0123456789abcdef;DROP");

	@Test
	void theDropGuardRejectsAnythingOutsideTheEphemeralNaming() {
		for (String name : FORBIDDEN_NAMES) {
			assertThrows(IllegalArgumentException.class, () -> EphemeralMysqlDb.dropDatabase(name),
					"임시 DB 규약 밖의 이름을 드롭하려 한다: " + name);
			assertFalse(EphemeralMysqlDb.EPHEMERAL_NAME.matcher(name).matches(),
					"정규식이 넓어졌다 — 삭제 경계가 무너진다: " + name);
		}
		assertThrows(IllegalArgumentException.class, () -> EphemeralMysqlDb.dropDatabase(null));
		assertTrue(EphemeralMysqlDb.EPHEMERAL_NAME.matcher("harness_ct_0123456789abcdef").matches(),
				"정확한 형태까지 막고 있다 — 임시 DB를 만들 수 없다");
	}

	/** 만든 이름은 언제나 규약을 만족하고 매번 다르다(같은 이름이면 병렬 실행이 서로를 지운다). */
	@Test
	void everyCreatedNameMatchesTheEphemeralNaming() {
		try (EphemeralMysqlDb first = EphemeralMysqlDb.create();
				EphemeralMysqlDb second = EphemeralMysqlDb.create()) {
			assertTrue(EphemeralMysqlDb.EPHEMERAL_NAME.matcher(first.database()).matches(), first.database());
			assertTrue(EphemeralMysqlDb.EPHEMERAL_NAME.matcher(second.database()).matches(), second.database());
			assertFalse(first.database().equals(second.database()), "임시 DB 이름이 겹친다");
		}
	}

	/** URL 조립은 순수 함수다 — 틀리면 측정이 <b>엉뚱한 DB</b>에서 돈다(가장 조용한 실패 형태다). */
	@Test
	void theUrlCompositionReplacesThePathAndKeepsTheQuery() {
		assertEquals("proto://h:3306/harness_ct_00112233445566ff?a=1&b=2",
				EphemeralMysqlDb.urlForDatabase("proto://h:3306/?a=1&b=2", "harness_ct_00112233445566ff"));
		assertEquals("proto://h:3306/harness_ct_00112233445566ff?a=1",
				EphemeralMysqlDb.urlForDatabase("proto://h:3306/other?a=1", "harness_ct_00112233445566ff"));
		assertEquals("proto://h:3306/harness_ct_00112233445566ff",
				EphemeralMysqlDb.urlForDatabase("proto://h:3306", "harness_ct_00112233445566ff"));
		assertThrows(IllegalArgumentException.class,
				() -> EphemeralMysqlDb.urlForDatabase("no-scheme-here", "harness_ct_00112233445566ff"));
	}

	/** 닫으면 실제로 사라진다 — 안 그러면 실행마다 스키마가 영구히 쌓인다. */
	@Test
	void closingActuallyRemovesTheDatabase() throws SQLException {
		String name;
		try (EphemeralMysqlDb db = EphemeralMysqlDb.create()) {
			name = db.database();
			db.exec("CREATE TABLE probe (id BIGINT PRIMARY KEY)");
			assertTrue(databaseExists(db, name), "만든 DB가 카탈로그에 없다: " + name);
		}
		try (EphemeralMysqlDb other = EphemeralMysqlDb.create()) {
			assertFalse(databaseExists(other, name), "닫았는데 DB가 남아 있다: " + name);
		}
	}

	private static boolean databaseExists(EphemeralMysqlDb db, String name) throws SQLException {
		try (Connection connection = db.openConnection();
				Statement statement = connection.createStatement();
				ResultSet rs = statement.executeQuery(
						"SELECT COUNT(*) FROM INFORMATION_SCHEMA.SCHEMATA WHERE SCHEMA_NAME = '" + name + "'")) {
			return rs.next() && rs.getInt(1) > 0;
		}
	}

}
