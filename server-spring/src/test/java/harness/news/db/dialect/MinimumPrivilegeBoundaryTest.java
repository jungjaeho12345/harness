package harness.news.db.dialect;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import harness.news.db.RequiredSchema;
import harness.news.testsupport.NewsAppMysql;
import java.sql.Connection;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Statement;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import org.junit.jupiter.api.Test;

/**
 * <b>최소 권한이 DB 비파괴의 1차 방어선</b>이라는 주장의 근거(phase 75 step6 C · open question (6)).
 *
 * <h2>무엇을 증명해야 하는가</h2>
 * ADR-016은 "정적 스캔이 뚫려도 DB 서버가 막는다"고 적었다. 그 주장이 성립하려면 <b>같은 DB·같은
 * 자격</b>에서 성공과 거부가 갈려야 한다 — 전부 거부되는 곳(예: {@code news_app}이 권한 0인
 * {@code harness_ct_*})에서 "6/6 거부"를 보이면 그것은 권한 경계가 아니라 <b>접근 자체의 부재</b>이고
 * 아무것도 증명하지 않는다. 그래서 이 클래스는 두 자리에서 잰다.
 * <ol>
 *   <li><b>{@code news_stage}</b>(실제 스키마 7테이블) — 같은 자격으로 {@code SELECT}·{@code UPDATE}는
 *       되는데 {@code DELETE}는 거부되는가. 즉 거부가 <b>문장 단위</b>인가.</li>
 *   <li><b>{@code news_grant_probe}</b>(step0이 만든 껍데기 2테이블) — 테이블 단위 {@code DELETE} 예외가
 *       실제로 <b>한 테이블에만</b> 걸리는가. 성공({@code ReceiverConfig})과 거부({@code Contents})가
 *       같은 DB·같은 자격에서 갈린다.</li>
 * </ol>
 *
 * <h2>기대값을 코드에 박지 않는다</h2>
 * grant 부여는 root가 손으로 하는 일이라 리포가 통제하지 못한다. 그래서 판정은 "우리가 기대한 표와
 * 같은가"가 아니라 <b>"서버가 자기 grant 표({@code SHOW GRANTS})대로 실제로 막는가"</b>다 — 선언과 행동을
 * 대조하므로 grant가 붙기 전에도 뒤에도 같은 테스트가 의미를 갖는다.
 *
 * <h2>DB 비파괴</h2>
 * 모든 {@code DELETE}·{@code UPDATE} 시도는 <b>어떤 행에도 매치될 수 없는 조건</b>으로 던진다(MySQL은
 * 권한을 실행 전에 판정하므로 그것으로 충분하다). {@code news_stage}에서 이 클래스가 지우거나 바꾸는
 * 행은 <b>0건</b>이다. 껍데기 DB에서만 자기가 넣은 행 하나를 지운다.
 *
 * <p><b>변이 M9</b>: 스모크/측정 경로에 {@code Contents} 행 삭제를 심으면 서버가 거부하는가 —
 * 이 클래스의 {@link #everyOtherTableRefusesDeleteWithTheSameCredentialInTheSameDatabase}가 그 답이다.
 */
class MinimumPrivilegeBoundaryTest {

	/** 어떤 행에도 매치되지 않는 조건 값 — 이 문자열을 PK로 갖는 행은 만들어질 수 없다. */
	private static final String SENTINEL = "phase75-step6-privilege-probe-no-such-row";

	/** 테이블 → 매치 불가능한 WHERE 절. 정수 PK는 음수를 쓴다(자동 증가는 1부터다). */
	private static final Map<String, String> IMPOSSIBLE_WHERE = impossibleWhere();

	private static Map<String, String> impossibleWhere() {
		Map<String, String> where = new LinkedHashMap<>();
		where.put(RequiredSchema.USER_TABLE, "userId = '" + SENTINEL + "'");
		where.put(RequiredSchema.ARTICLE_TABLE, "articleId = '" + SENTINEL + "'");
		where.put(RequiredSchema.CONTENTS_TABLE, "articleId = '" + SENTINEL + "'");
		where.put(RequiredSchema.HISTORY_TABLE, "id = -1");
		where.put(RequiredSchema.RECEIVER_CONFIG_TABLE, "id = -1");
		where.put(RequiredSchema.DISTRIBUTION_TARGET_TABLE, "id = -1");
		where.put(RequiredSchema.PHOTO_TABLE, "id = -1");
		return where;
	}

	/** 테이블 → 아무 행도 바꾸지 않는 자기 대입 SET 절(권한 판정은 실행 전에 끝난다). */
	private static final Map<String, String> NO_OP_SET = Map.of(
			RequiredSchema.USER_TABLE, "name = name",
			RequiredSchema.ARTICLE_TABLE, "title = title",
			RequiredSchema.CONTENTS_TABLE, "title = title",
			RequiredSchema.HISTORY_TABLE, "reason = reason",
			RequiredSchema.RECEIVER_CONFIG_TABLE, "name = name",
			RequiredSchema.DISTRIBUTION_TARGET_TABLE, "name = name",
			RequiredSchema.PHOTO_TABLE, "caption = caption");

	/** MySQL 권한 거부 오류코드 — {@code ERROR 1142 (42000): command denied to user}. */
	private static final int ACCESS_DENIED = 1142;

	// --- 1. news_stage: 거부는 문장 단위다 --------------------------------------------------------

	/**
	 * <b>같은 자격·같은 DB·같은 테이블</b>에서 읽기와 갱신은 되고 삭제만 거부된다 — 이 대비가 없으면
	 * "6/6 거부"는 접근 부재와 구분되지 않는다.
	 */
	@Test
	void theSameCredentialCanReadAndUpdateEveryTableItCannotDeleteFrom() throws SQLException {
		try (Connection connection = NewsAppMysql.open(NewsAppMysql.STAGING_DATABASE)) {
			for (String table : RequiredSchema.TABLES.keySet()) {
				assertEquals("ok", outcome(connection, "SELECT COUNT(*) FROM " + table),
						table + ": 읽기가 거부됐다 — 자격/스키마 전제가 깨졌다");
				assertEquals("ok", outcome(connection, "UPDATE " + table + " SET " + NO_OP_SET.get(table)
						+ " WHERE " + IMPOSSIBLE_WHERE.get(table)),
						table + ": 갱신이 거부됐다 — 서버가 이 테이블에 쓸 수 없다");
			}
		}
	}

	/**
	 * <b>이 step의 실증</b> — 삭제 시도의 결과가 {@code SHOW GRANTS}와 정확히 일치한다.
	 *
	 * <p>{@code ReceiverConfig}를 뺀 6테이블은 <b>언제나</b> 거부여야 한다(그 grant는 부트스트랩에
	 * 존재하지 않는다). {@code ReceiverConfig}는 grant가 붙었으면 성공, 아직이면 거부이고 어느 쪽이든
	 * 선언과 행동이 같아야 한다.
	 */
	@Test
	void everyOtherTableRefusesDeleteWithTheSameCredentialInTheSameDatabase() throws SQLException {
		Set<String> granted = NewsAppMysql.tablesWithDeleteGrant(NewsAppMysql.STAGING_DATABASE);
		assertFalse(granted.contains(NewsAppMysql.ALL_TABLES),
				"스키마 전체 DELETE 가 부여돼 있다 — 최소 권한 설계가 깨졌다: " + granted);

		Set<String> refused = new LinkedHashSet<>();
		Set<String> allowed = new LinkedHashSet<>();
		try (Connection connection = NewsAppMysql.open(NewsAppMysql.STAGING_DATABASE)) {
			for (String table : RequiredSchema.TABLES.keySet()) {
				String result = outcome(connection,
						"DELETE FROM " + table + " WHERE " + IMPOSSIBLE_WHERE.get(table));
				if ("ok".equals(result)) {
					allowed.add(table.toLowerCase(Locale.ROOT));
				}
				else {
					assertEquals(String.valueOf(ACCESS_DENIED), result.split("/")[0],
							table + ": 거부는 됐는데 권한 오류가 아니다 — " + result);
					refused.add(table.toLowerCase(Locale.ROOT));
				}
			}
		}

		assertEquals(granted, allowed, "서버가 자기 grant 표대로 막지 않는다(선언 ≠ 행동)");
		for (String table : List.of(RequiredSchema.USER_TABLE, RequiredSchema.ARTICLE_TABLE,
				RequiredSchema.CONTENTS_TABLE, RequiredSchema.HISTORY_TABLE,
				RequiredSchema.DISTRIBUTION_TARGET_TABLE, RequiredSchema.PHOTO_TABLE)) {
			assertTrue(refused.contains(table.toLowerCase(Locale.ROOT)),
					table + ": 행 삭제가 DB 서버에 의해 거부되지 않았다 — ADR-016의 1차 방어선 주장이 무너진다");
		}
		assertEquals(RequiredSchema.TABLES.size() - granted.size(), refused.size(),
				"거부와 허용의 합이 7테이블이어야 한다: refused=" + refused + " allowed=" + allowed);
	}

	// --- 2. news_grant_probe: 예외가 한 테이블에만 걸린다 -------------------------------------------

	/**
	 * 테이블 단위 {@code DELETE} 예외가 <b>실재</b>한다 — 같은 DB·같은 자격에서 한 테이블은 지워지고
	 * 다른 테이블은 거부된다. 이것이 open question (6)의 답이다.
	 *
	 * <p>껍데기 DB에는 뉴스 데이터가 없고(컬럼이 {@code probe_only} 하나뿐이다) 지우는 것은
	 * <b>이 테스트가 방금 넣은 행</b>이다.
	 */
	@Test
	void theTableScopedDeleteExceptionIsRealInTheProbeDatabase() throws SQLException {
		try (Connection connection = NewsAppMysql.open(NewsAppMysql.GRANT_PROBE_DATABASE)) {
			int probeId = insertProbeRow(connection);

			assertEquals("ok", outcome(connection, "DELETE FROM ReceiverConfig WHERE probe_only = " + probeId),
					"예외 테이블의 삭제가 거부됐다 — §7 grant 를 확인하라");
			assertEquals(0, countProbeRow(connection, probeId), "삭제가 실제로 일어났다");

			String denied = outcome(connection, "DELETE FROM Contents WHERE probe_only = -1");
			assertNotEquals("ok", denied, "같은 DB의 다른 테이블 삭제가 통과했다 — 예외가 테이블 단위가 아니다");
			assertEquals(String.valueOf(ACCESS_DENIED), denied.split("/")[0], "권한 오류여야 한다: " + denied);
			assertEquals("ok", outcome(connection, "SELECT COUNT(*) FROM Contents"),
					"읽기는 되는데 삭제만 거부된다 — 접근 부재가 아니라 권한 경계다");
		}
	}

	// --- 헬퍼 --------------------------------------------------------------------------------------

	/** 문장을 실행하고 결과를 {@code "ok"} 또는 {@code "<errorCode>/<sqlState>"}로 돌려준다. */
	private static String outcome(Connection connection, String sql) {
		try (Statement statement = connection.createStatement()) {
			statement.execute(sql);
			return "ok";
		}
		catch (SQLException ex) {
			return ex.getErrorCode() + "/" + ex.getSQLState();
		}
	}

	private static int insertProbeRow(Connection connection) throws SQLException {
		try (Statement statement = connection.createStatement()) {
			statement.executeUpdate("INSERT INTO ReceiverConfig () VALUES ()",
					Statement.RETURN_GENERATED_KEYS);
			try (ResultSet keys = statement.getGeneratedKeys()) {
				assertTrue(keys.next(), "껍데기 행의 id를 돌려받지 못했다");
				return keys.getInt(1);
			}
		}
	}

	private static int countProbeRow(Connection connection, int probeId) throws SQLException {
		try (Statement statement = connection.createStatement();
				ResultSet rs = statement.executeQuery(
						"SELECT COUNT(*) FROM ReceiverConfig WHERE probe_only = " + probeId)) {
			return rs.next() ? rs.getInt(1) : -1;
		}
	}
}
