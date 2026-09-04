package harness.news.db.dialect;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.zaxxer.hikari.HikariDataSource;
import harness.news.db.NewsDataSource;
import harness.news.db.RequiredSchema;
import harness.news.db.SchemaGuard;
import harness.news.testsupport.EphemeralMysqlDb;
import java.nio.file.Path;
import java.sql.Connection;
import java.sql.DatabaseMetaData;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import org.junit.jupiter.api.Test;

/**
 * 부팅 스키마 검증이 <b>MySQL에서도</b> 7테이블·전 컬럼을 보고, 결손을 <b>컬럼 이름으로 지목</b>하는지
 * (phase 75 step6 A).
 *
 * <h2>왜 SQLite 쪽 테스트로 충분하지 않은가</h2>
 * step5가 {@code SchemaGuard}를 SQLite 전용 테이블 값 함수에서 JDBC {@link DatabaseMetaData}로 옮겼다.
 * 그 전환은 <b>다른 카탈로그 구현</b> 위에서 같은 답을 낸다는 가정 위에 서 있고, 그 가정은 MySQL에서만
 * 깨질 수 있다. 실제로 이 방언에는 SQLite에 없는 함정이 셋 있다: 테이블 이름이 소문자로 저장되고
 * ({@code lower_case_table_names=1} — 축 10), {@code getColumns}의 테이블 인자가 <b>패턴</b>이라
 * {@code _}가 와일드카드이며, 접속 자격이 보는 <b>다른 스키마</b>의 동명 테이블이 섞여 들어올 수 있다.
 *
 * <p><b>변이 M8</b>: 결손 판정을 무력화하면(예: 컬럼 비교를 항상 통과로) 아래 두 거부 테스트가 red다.
 *
 * <p>드리프트는 <b>기반선 텍스트에서 컬럼 한 줄을 빼서</b> 만든다 — 만들어 둔 테이블에서 컬럼을
 * 드롭하지 않는다(이 리포에서 드롭은 임시 DB 이름 하나에만 허용된 연산이고, 여기서 필요한 것은
 * "처음부터 그 컬럼이 없는 DB"다). 대상은 {@code harness_ct_<16진수>}이고 자격은 {@code news_ct}다.
 */
class MysqlSchemaGuardTest {

	/** 드리프트로 뺄 컬럼 — {@code Contents}에만 있고 편집 잠금 계약이 그 값을 읽는다. */
	private static final String DROPPED_COLUMN = "lockerSessionId";

	@Test
	void theGuardAcceptsTheMigratorBaselineOnMysql() {
		try (EphemeralMysqlDb db = EphemeralMysqlDb.create()) {
			db.applyBaselineSchema();

			try (HikariDataSource dataSource = NewsDataSource.create(db.dbProperties(), Path.of("."))) {
				new SchemaGuard(dataSource, "mysql-baseline").verify();
			}
		}
	}

	/** 카탈로그가 실제로 7테이블을 <b>소문자로</b> 돌려준다(축 10의 전제를 이 경로에서 다시 확인한다). */
	@Test
	void theCatalogReturnsEveryRequiredTableInLowerCase() throws SQLException {
		try (EphemeralMysqlDb db = EphemeralMysqlDb.create()) {
			db.applyBaselineSchema();

			try (HikariDataSource dataSource = NewsDataSource.create(db.dbProperties(), Path.of("."));
					Connection connection = dataSource.getConnection()) {
				Set<String> seen = new LinkedHashSet<>();
				try (ResultSet rs = connection.getMetaData()
						.getTables(connection.getCatalog(), null, "%", new String[] { "TABLE" })) {
					while (rs.next()) {
						seen.add(rs.getString("TABLE_NAME"));
					}
				}
				for (String table : RequiredSchema.TABLES.keySet()) {
					assertTrue(seen.contains(table.toLowerCase(Locale.ROOT)),
							"카탈로그에 " + table + " 이(가) 소문자로 있어야 한다: " + seen);
				}
			}
		}
	}

	/**
	 * <b>컬럼 결손을 이름으로 지목하며 거부</b>한다 — "테이블이 없다"로 뭉개지 않는다.
	 * (step5의 M3가 SQLite에서 잡은 실패 양식과 같은 자리다.)
	 */
	@Test
	void theGuardNamesTheMissingColumnOnMysql() {
		try (EphemeralMysqlDb db = EphemeralMysqlDb.create()) {
			applyBaselineWithout(db, DROPPED_COLUMN);

			try (HikariDataSource dataSource = NewsDataSource.create(db.dbProperties(), Path.of("."))) {
				SchemaGuard guard = new SchemaGuard(dataSource, "mysql-drift");

				IllegalStateException thrown = assertThrows(IllegalStateException.class, guard::verify);

				assertTrue(thrown.getMessage().contains(DROPPED_COLUMN),
						"빠진 컬럼 이름을 지목해야 한다: " + thrown.getMessage());
				assertTrue(thrown.getMessage().contains(RequiredSchema.CONTENTS_TABLE),
						"어느 테이블인지도 지목해야 한다: " + thrown.getMessage());
			}
		}
	}

	/** 위 드리프트가 <b>실제로</b> 컬럼을 뺐는지 — 픽스처가 무해하면 그 red는 공허하다(step4 M4의 교훈). */
	@Test
	void theDriftFixtureReallyLacksTheColumn() throws SQLException {
		try (EphemeralMysqlDb db = EphemeralMysqlDb.create()) {
			applyBaselineWithout(db, DROPPED_COLUMN);

			try (Connection connection = db.openConnection()) {
				Set<String> columns = new LinkedHashSet<>();
				try (ResultSet rs = connection.getMetaData().getColumns(connection.getCatalog(), null,
						RequiredSchema.CONTENTS_TABLE, "%")) {
					while (rs.next()) {
						columns.add(rs.getString("COLUMN_NAME"));
					}
				}
				assertFalse(columns.isEmpty(), "테이블 자체는 있어야 한다(테이블 결손과 컬럼 결손은 다른 실패다)");
				assertFalse(columns.contains(DROPPED_COLUMN), "드리프트 픽스처에 그 컬럼이 남아 있다: " + columns);
				assertEquals(RequiredSchema.CONTENTS_COLUMNS.size() - 1, columns.size(),
						"정확히 한 컬럼만 빠져야 한다: " + columns);
			}
		}
	}

	/** 테이블 자체가 없으면 그것대로 지목한다(빈 DB로 조용히 뜨지 않는다). */
	@Test
	void theGuardNamesTheMissingTableOnMysql() {
		try (EphemeralMysqlDb db = EphemeralMysqlDb.create()) {
			try (HikariDataSource dataSource = NewsDataSource.create(db.dbProperties(), Path.of("."))) {
				SchemaGuard guard = new SchemaGuard(dataSource, "mysql-empty");

				IllegalStateException thrown = assertThrows(IllegalStateException.class, guard::verify);

				assertTrue(thrown.getMessage().contains(RequiredSchema.USER_TABLE), thrown.getMessage());
			}
		}
	}

	/**
	 * 기반선에서 컬럼 선언 <b>한 줄</b>을 빼고 적용한다. 빼지 못했으면 던진다 — 형식이 바뀌어 아무것도
	 * 지우지 못한 채 "정상 스키마"를 세우면 위 테스트가 조용히 green이 된다.
	 */
	private static void applyBaselineWithout(EphemeralMysqlDb db, String column) {
		boolean removed = false;
		List<String> applied = new ArrayList<>();
		for (String statement : EphemeralMysqlDb.baselineStatements()) {
			StringBuilder kept = new StringBuilder();
			for (String line : statement.split("\n")) {
				if (line.strip().startsWith(column + " ")) {
					removed = true;
					continue;
				}
				kept.append(line).append('\n');
			}
			applied.add(kept.toString().strip());
		}
		if (!removed) {
			throw new IllegalStateException("기반선에서 컬럼 선언을 찾지 못했다(형식이 바뀌었다): " + column);
		}
		for (String statement : applied) {
			db.exec(statement);
		}
	}
}
