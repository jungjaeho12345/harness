package harness.newsmigrator;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.sql.Connection;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Statement;
import java.util.ArrayList;
import java.util.List;
import org.junit.jupiter.api.Test;

/**
 * 임시 DB 는 <b>만들고 버리는</b> 물건이다 — 그리고 버리는 통로는 정확히 하나이고 아주 좁다.
 *
 * <h2>왜 드롭이 허용되는가</h2>
 * 최상위 규칙(DB 에 있는 내용은 절대 삭제하지 않는다)이 지키는 대상은 <b>뉴스 데이터</b>다. 계약 하네스는
 * 패스마다 임시 SQLite 파일을 만들고 지우고 있고, 임시 MySQL DB 는 그것과 같은 지위다. 안 지우면 실행마다
 * 스키마가 영구히 쌓인다. 그래도 실수 한 번이 되돌릴 수 없으므로 보호를 <b>세 겹</b>으로 건다:
 * <ol>
 * <li>이름 정규식({@code ^harness_ct_[0-9a-f]{16}$}) — 그 밖의 이름은 <b>접속조차 하지 않고</b> 던진다.</li>
 * <li>정적 게이트 — 드롭 문장이 있는 파일은 리포 전체에서 이 한 파일뿐임을 기계가 단언한다.</li>
 * <li>MySQL grant — {@code news_ct} 는 {@code harness\_ct\_%} 밖에 아무 권한이 없다. 정규식이 뚫려도
 * 서버가 막는다(그리고 {@code news_migrator} 에는 {@code DROP} 자체가 없다).</li>
 * </ol>
 *
 * <p><b>어느 DB·어느 자격인가</b>: 이 테스트는 {@code news_ct} 자격으로 {@code harness_ct_<16진수>} 를
 * 만들고 버린다. {@code news}·{@code news_stage} 는 이 자격에 보이지도 않는다(step0 D-2 실측).
 */
class EphemeralDatabaseTest {

	/** 계약 하네스가 쓰는 키 집합 — 값은 리포 밖 env 파일에만 있다. */
	private static final String KEY_SET = "NEWS_CT_MYSQL";

	/**
	 * <b>fail-closed</b>: 설정이 없으면 skip 이 아니라 fail 이다(decisions (14)).
	 * 조용한 skip 은 아래 실기 단언들을 전부 공허하게 만든다.
	 */
	@Test
	void theMysqlCredentialsAreConfiguredOtherwiseEveryGateBelowIsVacuous() {
		TargetCredentials credentials = TargetCredentials.of(KEY_SET, System::getenv);

		assertTrue(credentials.url().startsWith("jdbc:mysql:"),
				"계약 하네스 자격이 MySQL 을 가리키지 않는다: " + credentials.describe());
	}

	/** <b>M6</b> — 규약을 벗어난 이름은 어떤 것도 통과하지 못한다(접두사만 흉내 낸 것도 포함). */
	@Test
	void onlyTheReservedSixteenHexShapeIsAcceptedAsAnEphemeralName() {
		for (String rejected : List.of("news", "news_stage", "mysql", "information_schema", "harness_ct_",
				"harness_ct_0123456789abcde", "harness_ct_0123456789abcdef0", "harness_ct_0123456789ABCDEF",
				"harness_ct_0123456789abcdeg", "harness_ct_0123456789abcdef ", " harness_ct_0123456789abcdef",
				"harness_ct_0123456789abcdef`; DROP", "")) {
			assertThrows(IllegalArgumentException.class, () -> EphemeralDatabase.requireEphemeralName(rejected),
					"임시 DB 규약을 벗어난 이름을 받아들인다: [" + rejected + "]");
		}
		assertThrows(IllegalArgumentException.class, () -> EphemeralDatabase.requireEphemeralName(null),
				"null 이름을 받아들인다");

		assertEquals("harness_ct_0123456789abcdef",
				EphemeralDatabase.requireEphemeralName("harness_ct_0123456789abcdef"), "규약에 맞는 이름을 거부한다");
	}

	/** 무작위로 만든 이름은 <b>언제나</b> 규약 안이다(만드는 쪽과 버리는 쪽이 같은 규약을 쓴다). */
	@Test
	void generatedNamesAlwaysSatisfyTheSameShapeThatGuardsTheDrop() {
		for (int i = 0; i < 64; i++) {
			String name = EphemeralDatabase.randomName();
			assertTrue(EphemeralDatabase.EPHEMERAL_NAME.matcher(name).matches(), "생성한 이름이 규약 밖이다: " + name);
			assertEquals(name, EphemeralDatabase.requireEphemeralName(name), "생성한 이름을 스스로 거부한다");
		}
	}

	/** 만들고 → 보이고 → 버리고 → 사라진다. 같은 DB·같은 자격에서 왕복을 실측한다. */
	@Test
	void anEphemeralDatabaseIsCreatedSeenAndDiscardedWithTheSameCredential() throws SQLException {
		TargetCredentials root = TargetCredentials.of(KEY_SET, System::getenv);
		String name = EphemeralDatabase.randomName();

		EphemeralDatabase.create(root, name);
		try {
			assertTrue(databases(root).contains(name), "만든 임시 DB 가 보이지 않는다: " + name);
			try (Connection connection = TargetCredentials.open(root.forDatabase(name))) {
				assertEquals(name, scalar(connection, "SELECT DATABASE()"), "임시 DB 를 가리키지 않는다");
				assertEquals("utf8mb4_0900_bin", scalar(connection,
						"SELECT DEFAULT_COLLATION_NAME FROM INFORMATION_SCHEMA.SCHEMATA WHERE SCHEMA_NAME = DATABASE()"),
						"임시 DB 의 기본 collation 이 step1 의 결정값과 다르다");
			}
		}
		finally {
			EphemeralDatabase.drop(root, name);
		}

		assertFalse(databases(root).contains(name), "버린 임시 DB 가 남아 있다: " + name);
	}

	/** 버리기는 멱등이다 — 없는 것을 버려도 성공한다(하네스가 정리 경로에서 두 번 부를 수 있다). */
	@Test
	void discardingAnAbsentEphemeralDatabaseIsIdempotent() {
		TargetCredentials root = TargetCredentials.of(KEY_SET, System::getenv);
		String name = EphemeralDatabase.randomName();

		EphemeralDatabase.drop(root, name);
		EphemeralDatabase.drop(root, name);
	}

	/** 규약 밖 이름은 <b>접속조차 하지 않는다</b> — 자격이 살아 있는 상태에서도 그렇다. */
	@Test
	void aProductionDatabaseNameIsRefusedEvenWithLiveCredentials() {
		TargetCredentials root = TargetCredentials.of(KEY_SET, System::getenv);

		for (String protectedName : List.of("news", "news_stage", "news_grant_probe")) {
			assertThrows(IllegalArgumentException.class, () -> EphemeralDatabase.drop(root, protectedName),
					"보호 대상 DB 이름을 드롭 통로가 받아들인다: " + protectedName);
			assertThrows(IllegalArgumentException.class, () -> EphemeralDatabase.create(root, protectedName),
					"보호 대상 DB 이름으로 생성까지 시도한다: " + protectedName);
		}
	}

	private static List<String> databases(TargetCredentials root) throws SQLException {
		List<String> names = new ArrayList<>();
		try (Connection connection = TargetCredentials.open(root);
				Statement statement = connection.createStatement();
				ResultSet rs = statement.executeQuery("SHOW DATABASES")) {
			while (rs.next()) {
				names.add(rs.getString(1));
			}
		}
		return names;
	}

	private static String scalar(Connection connection, String sql) throws SQLException {
		try (Statement statement = connection.createStatement(); ResultSet rs = statement.executeQuery(sql)) {
			return rs.next() ? rs.getString(1) : null;
		}
	}

}
