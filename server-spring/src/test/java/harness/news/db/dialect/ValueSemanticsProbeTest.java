package harness.news.db.dialect;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;

import harness.news.testsupport.EphemeralMysqlDb;
import java.sql.Connection;
import java.sql.SQLException;
import java.util.LinkedHashMap;
import java.util.Map;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;

/**
 * 방언 측정 <b>축 1·2·9</b> — 바인딩 표현 · 빈 문자열 vs NULL · {@code length()}.
 *
 * <p>측정 규율: 기대값을 상상해서 적지 않는다. 먼저 값을 출력해 보고 <b>그 실측값</b>을 단언으로 박았다
 * (2026-09-03, MySQL 8.0.46 / sqlite-jdbc 3.47.2.0). 결과표는 {@code docs/db-mysql-mapping.md}에 있다.
 */
class ValueSemanticsProbeTest {

	private static EphemeralMysqlDb mysql;

	private static Connection my;

	private static DialectProbe lite;

	@BeforeAll
	static void openBoth() throws SQLException {
		mysql = EphemeralMysqlDb.create();
		my = mysql.openConnection();
		lite = DialectProbe.sqlite();
		// 같은 논리 스키마 — 타입만 각 방언의 매핑 규칙을 따른다(docs/db-mysql-mapping.md).
		lite.exec("CREATE TABLE Probe (k VARCHAR PRIMARY KEY, v VARCHAR)");
		DialectProbe.exec(my, "CREATE TABLE Probe (k VARCHAR(768) NOT NULL PRIMARY KEY, v LONGTEXT)");
	}

	@AfterAll
	static void closeBoth() throws SQLException {
		if (my != null) {
			my.close();
		}
		if (lite != null) {
			lite.close();
		}
		if (mysql != null) {
			mysql.close();
		}
	}

	/**
	 * <b>축 1 — 바인딩 표현.</b> 텍스트 컬럼에 숫자·불리언을 바인딩하면 <b>무슨 문자열</b>이 저장되는가.
	 *
	 * <p>Node {@code node:sqlite}가 {@code 2.0}을 {@code "2.0"}으로 저장한다는 것이 74 이월 실측이고,
	 * Java 쪽 단일 출처는 {@code ColumnValues}다. MySQL이 같은 표현을 내는지가 이 축이다.
	 */
	@Test
	void axis1_boundValuesRenderAsTheSameTextInBothDialects() {
		Map<String, Object> inputs = new LinkedHashMap<>();
		inputs.put("int-0", 0);
		inputs.put("int-2", 2);
		inputs.put("long-2", 2L);
		inputs.put("double-0.0", 0.0d);
		inputs.put("double-2.0", 2.0d);
		inputs.put("double-2.5", 2.5d);
		inputs.put("bool-true", Boolean.TRUE);
		inputs.put("bool-false", Boolean.FALSE);
		inputs.put("string-2.0", "2.0");

		Map<String, String> sqlite = new LinkedHashMap<>();
		Map<String, String> mysqlValues = new LinkedHashMap<>();
		for (Map.Entry<String, Object> input : inputs.entrySet()) {
			DialectProbe.update(lite.connection(), "INSERT INTO Probe (k, v) VALUES (?, ?)",
					input.getKey(), input.getValue());
			DialectProbe.update(my, "INSERT INTO Probe (k, v) VALUES (?, ?)",
					input.getKey(), input.getValue());
			sqlite.put(input.getKey(),
					DialectProbe.string(lite.connection(), "SELECT v FROM Probe WHERE k = ?", input.getKey()));
			mysqlValues.put(input.getKey(),
					DialectProbe.string(my, "SELECT v FROM Probe WHERE k = ?", input.getKey()));
		}

		assertEquals(Map.of("int-0", "0", "int-2", "2", "long-2", "2", "double-0.0", "0.0",
				"double-2.0", "2.0", "double-2.5", "2.5", "bool-true", "1", "bool-false", "0",
				"string-2.0", "2.0"), sqlite, "SQLite 바인딩 표현이 실측과 다르다");
		assertEquals(Map.of("int-0", "0", "int-2", "2", "long-2", "2", "double-0.0", "0.0",
				"double-2.0", "2.0", "double-2.5", "2.5", "bool-true", "1", "bool-false", "0",
				"string-2.0", "2.0"), mysqlValues, "MySQL 바인딩 표현이 실측과 다르다");
		assertEquals(sqlite, mysqlValues, "축 1은 divergence 0이어야 한다(양쪽 표현이 갈리면 대조가 무너진다)");
	}

	/**
	 * <b>축 2 — 빈 문자열 vs NULL.</b> 소스 데이터에서 둘이 <b>같은 컬럼에 공존</b>한다
	 * ({@code Contents.embargoAt} = 빈 문자열 52 + NULL 10 — step1 배경 1). 왕복에서 섞이면
	 * 이관 대조가 통째로 무너진다.
	 */
	@Test
	void axis2_emptyStringAndNullStayDistinctInBothDialects() {
		DialectProbe.update(lite.connection(), "INSERT INTO Probe (k, v) VALUES ('empty', '')");
		DialectProbe.update(my, "INSERT INTO Probe (k, v) VALUES ('empty', '')");
		DialectProbe.update(lite.connection(), "INSERT INTO Probe (k, v) VALUES ('null', NULL)");
		DialectProbe.update(my, "INSERT INTO Probe (k, v) VALUES ('null', NULL)");

		for (Connection connection : new Connection[] { lite.connection(), my }) {
			String where = connection == my ? "MySQL" : "SQLite";
			assertEquals("", DialectProbe.string(connection, "SELECT v FROM Probe WHERE k = 'empty'"),
					where + ": 빈 문자열이 왕복에서 변했다");
			assertNull(DialectProbe.string(connection, "SELECT v FROM Probe WHERE k = 'null'"),
					where + ": NULL이 왕복에서 변했다");
			assertEquals(1, DialectProbe.number(connection,
					"SELECT COUNT(*) FROM Probe WHERE k IN ('empty','null') AND v IS NULL"),
					where + ": IS NULL이 빈 문자열까지 잡았다");
			assertEquals(1, DialectProbe.number(connection,
					"SELECT COUNT(*) FROM Probe WHERE k IN ('empty','null') AND v = ''"),
					where + ": = '' 가 NULL까지 잡았다");
			assertEquals("X", DialectProbe.string(connection,
					"SELECT COALESCE(v, 'X') FROM Probe WHERE k = 'null'"), where + ": COALESCE 차이");
			assertEquals("", DialectProbe.string(connection,
					"SELECT COALESCE(v, 'X') FROM Probe WHERE k = 'empty'"), where + ": COALESCE 차이");
		}
	}

	/**
	 * <b>축 9 — {@code length()}.</b> SQLite는 <b>문자</b> 수, MySQL {@code LENGTH()}는 <b>바이트</b> 수다.
	 *
	 * <p>이 리포에서 {@code length()}를 쓰는 자리는 하나뿐이다 —
	 * {@code ArticleHistoryRepository} 198행의 {@code length(markupVersion) &gt; 0}. 술어가 {@code &gt; 0}
	 * 이라 <b>같은 행 집합</b>을 주는지가 실제 판정 대상이고, 값 자체는 갈린다(한글 1자 = 1 vs 3).
	 */
	@Test
	void axis9_lengthCountsCharactersInSqliteAndBytesInMysqlButThePredicateAgrees() {
		DialectProbe.update(lite.connection(), "INSERT INTO Probe (k, v) VALUES ('len-ascii', 'abc')");
		DialectProbe.update(my, "INSERT INTO Probe (k, v) VALUES ('len-ascii', 'abc')");
		DialectProbe.update(lite.connection(), "INSERT INTO Probe (k, v) VALUES ('len-hangul', ?)", HANGUL);
		DialectProbe.update(my, "INSERT INTO Probe (k, v) VALUES ('len-hangul', ?)", HANGUL);
		DialectProbe.update(lite.connection(), "INSERT INTO Probe (k, v) VALUES ('len-empty', '')");
		DialectProbe.update(my, "INSERT INTO Probe (k, v) VALUES ('len-empty', '')");
		DialectProbe.update(lite.connection(), "INSERT INTO Probe (k, v) VALUES ('len-null', NULL)");
		DialectProbe.update(my, "INSERT INTO Probe (k, v) VALUES ('len-null', NULL)");

		assertEquals(3, DialectProbe.number(lite.connection(),
				"SELECT length(v) FROM Probe WHERE k = 'len-hangul'"), "SQLite length()는 문자 수다");
		assertEquals(9, DialectProbe.number(my, "SELECT length(v) FROM Probe WHERE k = 'len-hangul'"),
				"MySQL LENGTH()는 바이트 수다(한글 1자 = utf8mb4 3바이트)");
		assertEquals(3, DialectProbe.number(my, "SELECT CHAR_LENGTH(v) FROM Probe WHERE k = 'len-hangul'"),
				"MySQL에서 문자 수를 원하면 CHAR_LENGTH다");

		String predicate = "SELECT k FROM Probe WHERE k LIKE 'len-%' AND length(v) > 0 ORDER BY k";
		assertEquals(java.util.List.of("len-ascii", "len-hangul"),
				DialectProbe.strings(lite.connection(), predicate));
		assertEquals(java.util.List.of("len-ascii", "len-hangul"), DialectProbe.strings(my, predicate),
				"length(x) > 0 술어의 행 집합이 갈렸다 — ArticleHistoryRepository 198행이 방언에 물든다");
	}

	/** 한글 3자 — utf8mb4에서 9바이트다. 소스로 쓰기 위해 코드포인트로 적는다(인코딩 사고 방지). */
	private static final String HANGUL = "가나다";

}
