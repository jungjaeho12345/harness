package harness.news.db.dialect;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import harness.news.db.RequiredSchema;
import harness.news.testsupport.EphemeralMysqlDb;
import java.sql.Connection;
import java.sql.DatabaseMetaData;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.TreeSet;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;

/**
 * 방언 측정 <b>축 10·12</b> — 식별자 대소문자 · 예약어 충돌.
 *
 * <h2>축 12는 {@code decisions (16)}의 전제를 검증한다</h2>
 * 이 phase는 리포지토리 SQL을 고치지 않기로 했다. 그래서 식별자가 <b>인용부호 없이</b> 나간다
 * ({@code FROM User} · {@code status} · {@code action} · {@code region} · {@code type} · {@code port} …).
 * 하나라도 MySQL 예약어면 SQL이 <b>파싱 단계에서 죽고</b> 그 결정이 통째로 무너진다. 문서의 예약어 목록을
 * 베끼지 않고 <b>이 서버의 {@code INFORMATION_SCHEMA.KEYWORDS}</b>를 정본으로 기계 대조한다.
 *
 * <p>이 테스트는 <b>영구 회귀 그물</b>이다 — 컬럼이 추가되거나 MySQL이 업그레이드돼 예약어가 늘면
 * 여기서 red가 난다.
 *
 * <p><b>변이 M6</b>: 예약어 질의를 {@code RESERVED = 1 OR WORD = 'STATUS'}로 바꾸면 교집합이 1건이 되어
 * red다 — 목록을 실제로 읽고 있다는 증거다(빈 집합과 비교하고 있으면 무엇을 넣어도 green이다).
 */
class CatalogSemanticsProbeTest {

	/** 예약어 목록의 정본 질의. <b>변이 M6</b>이 손대는 자리다. */
	static final String RESERVED_KEYWORDS_SQL =
			"SELECT WORD FROM INFORMATION_SCHEMA.KEYWORDS WHERE RESERVED = 1";

	private static EphemeralMysqlDb mysql;

	private static Connection my;

	@BeforeAll
	static void openMysql() throws SQLException {
		mysql = EphemeralMysqlDb.create();
		my = mysql.openConnection();
		for (Map.Entry<String, List<String>> table : RequiredSchema.TABLES.entrySet()) {
			DialectProbe.exec(my, createTableSql(table.getKey(), table.getValue()));
		}
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

	// --- 축 12: 예약어 ---

	@Test
	void axis12_noTableOrColumnNameCollidesWithAReservedWord() {
		Set<String> reserved = new TreeSet<>(DialectProbe.strings(my, RESERVED_KEYWORDS_SQL));
		assertTrue(reserved.size() >= 200,
				"예약어 목록을 못 읽었다 — 교집합 0건이 공허해진다(읽은 개수: " + reserved.size() + ")");
		assertTrue(reserved.contains("SELECT") && reserved.contains("TABLE") && reserved.contains("ORDER"),
				"예약어 목록이 예약어처럼 보이지 않는다 — 질의가 엉뚱한 것을 읽고 있다");

		List<String> collisions = new ArrayList<>();
		for (String identifier : identifiers()) {
			if (reserved.contains(identifier.toUpperCase(Locale.ROOT))) {
				collisions.add(identifier);
			}
		}
		assertEquals(List.of(), collisions,
				"무인용 식별자가 MySQL 예약어와 충돌한다 — decisions (16)(리포지토리 SQL 무수정)이 먼저 무너진다: "
						+ collisions);
	}

	/**
	 * 예약어 대조는 <b>정적 판정</b>이다 — 실제로 무인용 SQL이 파싱되는지까지 본다.
	 *
	 * <p>7테이블을 결정된 타입 매핑으로 만들고(= 매핑표가 물리적으로 구성 가능한지도 함께 검증한다)
	 * <b>백틱 없이</b> 전 컬럼을 SELECT/INSERT 한다. 식별자 하나라도 예약어면 여기서 죽는다.
	 */
	@Test
	void axis12_everyTableIsUsableWithUnquotedIdentifiers() {
		for (Map.Entry<String, List<String>> table : RequiredSchema.TABLES.entrySet()) {
			List<String> columns = table.getValue();
			String columnList = String.join(", ", columns);
			String select = "SELECT " + columnList + " FROM " + table.getKey()
					+ " WHERE " + columns.get(0) + " = ? ORDER BY " + columns.get(0);
			assertEquals(List.of(), DialectProbe.strings(my, select, "no-such-row"),
					"무인용 식별자로 조회할 수 없다: " + table.getKey());
		}
	}

	// --- 축 10: 식별자 대소문자 ---

	/**
	 * <b>축 10 — {@code lower_case_table_names=1}에서 테이블 이름이 소문자로 저장된다.</b>
	 *
	 * <p>{@code CREATE TABLE User}로 만들어도 카탈로그에는 {@code user}로 남는다(실측). 이 사실이 step0의
	 * grant 실측에서 이미 드러났다 — {@code DELETE ON news_grant_probe.receiverconfig}로 붙었다.
	 * <b>전 테이블에 적용되는 사실</b>이므로 이름 표기에 기대는 코드는 전부 대소문자 무시로 비교해야 한다.
	 *
	 * <p>반면 <b>컬럼 이름은 원래 표기가 보존</b>된다. 그래서 응답 키 집합(= 계약)은 이관으로 바뀌지 않는다.
	 */
	@Test
	void axis10_tableNamesAreLowercasedButColumnNamesKeepTheirCase() throws SQLException {
		Set<String> catalogTables = new LinkedHashSet<>(DialectProbe.strings(my,
				"SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = DATABASE()"));
		Set<String> expected = new TreeSet<>();
		for (String table : RequiredSchema.TABLES.keySet()) {
			expected.add(table.toLowerCase(Locale.ROOT));
		}
		assertEquals(expected, new TreeSet<>(catalogTables),
				"카탈로그의 테이블 표기가 실측과 다르다(lower_case_table_names=1 전제)");
		assertTrue(catalogTables.contains("articlehistory") && !catalogTables.contains("ArticleHistory"),
				"테이블 이름이 소문자화되지 않았다 — 축 10의 전제가 깨졌다: " + catalogTables);

		DatabaseMetaData meta = my.getMetaData();
		assertEquals(List.of("receiverconfig"), metaTables(meta, "ReceiverConfig"),
				"DatabaseMetaData.getTables가 원래 표기를 돌려줬다");
		assertEquals(List.of("receiverconfig"), metaTables(meta, "receiverconfig"),
				"DatabaseMetaData.getTables가 소문자 패턴을 못 찾는다");

		// 컬럼 표기는 보존된다 — SchemaGuard의 toLowerCase 비교는 양쪽 방언에서 성립한다.
		assertEquals(RequiredSchema.RECEIVER_CONFIG_COLUMNS, metaColumns(meta, "receiverconfig"),
				"컬럼 이름의 원래 표기가 보존되지 않았다");
		Set<String> lowered = new LinkedHashSet<>();
		for (String column : metaColumns(meta, "receiverconfig")) {
			lowered.add(column.toLowerCase(Locale.ROOT));
		}
		for (String required : RequiredSchema.RECEIVER_CONFIG_COLUMNS) {
			assertTrue(lowered.contains(required.toLowerCase(Locale.ROOT)),
					"SchemaGuard의 대소문자 무시 비교가 MySQL에서 성립하지 않는다: " + required);
		}
	}

	// --- 도구 ---

	private static List<String> metaTables(DatabaseMetaData meta, String pattern) throws SQLException {
		List<String> names = new ArrayList<>();
		try (ResultSet rs = meta.getTables(mysql.database(), null, pattern, new String[] { "TABLE" })) {
			while (rs.next()) {
				names.add(rs.getString("TABLE_NAME"));
			}
		}
		return names;
	}

	private static List<String> metaColumns(DatabaseMetaData meta, String table) throws SQLException {
		List<String> names = new ArrayList<>();
		try (ResultSet rs = meta.getColumns(mysql.database(), null, table, "%")) {
			while (rs.next()) {
				names.add(rs.getString("COLUMN_NAME"));
			}
		}
		return names;
	}

	/** 스키마 정본의 7테이블 이름 + 전 컬럼 이름(중복 제거). */
	static Set<String> identifiers() {
		Set<String> names = new LinkedHashSet<>();
		for (Map.Entry<String, List<String>> table : RequiredSchema.TABLES.entrySet()) {
			names.add(table.getKey());
			names.addAll(table.getValue());
		}
		return names;
	}

	/**
	 * 결정된 타입 매핑({@code docs/db-mysql-mapping.md})으로 CREATE TABLE을 만든다.
	 *
	 * <p>규칙 셋뿐이다: 첫 컬럼이 {@code id}면 {@code BIGINT AUTO_INCREMENT} PK · 첫 컬럼이 텍스트면
	 * {@code VARCHAR(768)} PK · {@code targetId}는 {@code BIGINT} · 나머지는 전부 {@code LONGTEXT}.
	 * <b>보조 인덱스·FK를 만들지 않는다</b>(정본이 PK 자동 인덱스만 쓴다 — {@code src/db/schema.js} 3행).
	 */
	static String createTableSql(String table, List<String> columns) {
		StringBuilder sql = new StringBuilder("CREATE TABLE ").append(table).append(" (");
		for (int i = 0; i < columns.size(); i++) {
			String column = columns.get(i);
			if (i > 0) {
				sql.append(", ");
			}
			sql.append(column).append(' ').append(columnType(column, i == 0));
		}
		return sql.append(") ENGINE=InnoDB").toString();
	}

	private static String columnType(String column, boolean primaryKey) {
		if (primaryKey) {
			return "id".equals(column)
					? "BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY"
					: IdentityAndSizeProbeTest.PK_COLUMN_TYPE + " NOT NULL PRIMARY KEY";
		}
		return "targetId".equals(column) ? "BIGINT" : IdentityAndSizeProbeTest.TEXT_COLUMN_TYPE;
	}

}
