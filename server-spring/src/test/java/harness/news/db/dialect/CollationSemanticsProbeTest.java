package harness.news.db.dialect;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import harness.news.testsupport.EphemeralMysqlDb;
import java.nio.charset.StandardCharsets;
import java.sql.Connection;
import java.sql.SQLException;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;

/**
 * 방언 측정 <b>축 3·4·5</b> — collation. <b>이 phase 최대의 위험 축</b>이다.
 *
 * <h2>세 축이 서로 싸운다(2026-09-03 실측)</h2>
 * <table border="1">
 * <caption>SQLite BINARY 대비</caption>
 * <tr><th>collation</th><th>PAD</th><th>{@code =} 대소문자</th><th>{@code =} 후행 공백</th><th>LIKE 대소문자</th></tr>
 * <tr><td>SQLite BINARY</td><td>NO PAD</td><td>구분</td><td>구분</td><td><b>무시</b>(ASCII)</td></tr>
 * <tr><td>{@code utf8mb4_bin}</td><td><b>PAD SPACE</b></td><td>구분</td><td><b>무시 — 탈락</b></td><td>구분</td></tr>
 * <tr><td>{@code utf8mb4_0900_bin}</td><td>NO PAD</td><td>구분</td><td>구분</td><td>구분</td></tr>
 * <tr><td>{@code utf8mb4_0900_ai_ci}</td><td>NO PAD</td><td><b>무시 — 탈락</b></td><td>구분</td><td>무시</td></tr>
 * </table>
 *
 * <p><b>세 축을 동시에 만족하는 collation은 없다.</b> 판정: {@code =}(보안 축)와 {@code ORDER BY}를 우선해
 * {@link EphemeralMysqlDb#DEFAULT_COLLATION}({@code utf8mb4_0900_bin})을 채택하고 <b>LIKE 대소문자를
 * 포기</b>한다. 근거는 피해의 비대칭이다 — {@code WHERE userId = ?}가 대소문자나 후행 공백을 무시하면
 * <b>다른 계정으로 로그인</b>되지만({@code utf8mb4_bin}은 {@code 'x' = 'x '}가 참이다 — 실측),
 * LIKE가 대소문자를 구분하면 검색 결과가 좁아질 뿐이다. {@code server/**}를 고쳐 맞추지 않는다
 * (open question (2)의 기본 결정).
 *
 * <p><b>포기한 축의 방어선은 이 파일의 {@link #axis4_likeCaseSensitivityIsTheSacrificedAxis}다</b> —
 * 계약은 이 축을 보지 못한다({@code photos-search}가 소문자 랜덤 토큰만 쓴다 — 실측).
 *
 * <p><b>변이 M3</b>: {@link EphemeralMysqlDb#DEFAULT_COLLATION}을 {@code utf8mb4_0900_ai_ci}로 바꾸면
 * 축 3·4·5의 「채택 collation」 단언이 red다(결과표는 step summary).
 */
class CollationSemanticsProbeTest {

	/** 실측 대상 3종. */
	static final List<String> CANDIDATES =
			List.of("utf8mb4_bin", "utf8mb4_0900_bin", "utf8mb4_0900_ai_ci");

	/** 이 phase가 채택한 collation — 결정의 단일 출처는 {@link EphemeralMysqlDb#DEFAULT_COLLATION}이다. */
	static final String DECIDED = EphemeralMysqlDb.DEFAULT_COLLATION;

	/** 전각 대문자 A(U+FF21) — 눈으로 구분되지 않으므로 코드포인트로 적는다. */
	private static final String FULLWIDTH_A = "Ａ";

	/** 완성형 '가'(U+AC00)와 자모 조합 '가'(U+1100 U+1161) — 같은 이유로 코드포인트로 적는다. */
	private static final String HANGUL_COMPOSED = "가";

	private static final String HANGUL_DECOMPOSED = "가";

	private static EphemeralMysqlDb mysql;

	private static Connection my;

	private static DialectProbe lite;

	@BeforeAll
	static void openBoth() throws SQLException {
		mysql = EphemeralMysqlDb.create();
		my = mysql.openConnection();
		lite = DialectProbe.sqlite();
		lite.exec("CREATE TABLE Eq (v VARCHAR)");
		lite.exec("CREATE TABLE Ord (v VARCHAR)");
		for (String collation : CANDIDATES) {
			DialectProbe.exec(my, "CREATE TABLE " + eqTable(collation)
					+ " (v VARCHAR(768) COLLATE " + collation + ")");
			DialectProbe.exec(my, "CREATE TABLE " + ordTable(collation)
					+ " (v VARCHAR(768) COLLATE " + collation + ")");
		}
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

	// --- 축 3: = 비교 (보안 축) ---

	/** 저장값 → 질의값. 이 넷이 갈리면 「다른 값이 같다고 판정되는」 경로가 생긴다. */
	private static final Map<String, String[]> EQUALITY_PAIRS = equalityPairs();

	private static Map<String, String[]> equalityPairs() {
		Map<String, String[]> pairs = new LinkedHashMap<>();
		pairs.put("case", new String[] { "abc", "ABC" });
		pairs.put("trailing-space", new String[] { "x", "x " });
		pairs.put("leading-space", new String[] { "x", " x" });
		pairs.put("fullwidth", new String[] { "A", FULLWIDTH_A });
		pairs.put("hangul-decomposed", new String[] { HANGUL_COMPOSED, HANGUL_DECOMPOSED });
		pairs.put("identical", new String[] { "abc", "abc" });
		return pairs;
	}

	@Test
	void axis3_equalityIsTheSecurityAxisAndOnlyOneCandidateMatchesSqlite() {
		Map<String, Boolean> sqlite = new LinkedHashMap<>();
		for (Map.Entry<String, String[]> pair : EQUALITY_PAIRS.entrySet()) {
			DialectProbe.update(lite.connection(), "DELETE FROM Eq");
			DialectProbe.update(lite.connection(), "INSERT INTO Eq (v) VALUES (?)", pair.getValue()[0]);
			sqlite.put(pair.getKey(),
					DialectProbe.number(lite.connection(), "SELECT COUNT(*) FROM Eq WHERE v = ?",
							pair.getValue()[1]) > 0);
		}
		assertEquals(Map.of("case", false, "trailing-space", false, "leading-space", false,
				"fullwidth", false, "hangul-decomposed", false, "identical", true), sqlite,
				"SQLite BINARY 실측이 달라졌다 — 이 축의 기준선이 무너진다");

		Map<String, Map<String, Boolean>> byCollation = new LinkedHashMap<>();
		for (String collation : CANDIDATES) {
			Map<String, Boolean> measured = new LinkedHashMap<>();
			for (Map.Entry<String, String[]> pair : EQUALITY_PAIRS.entrySet()) {
				DialectProbe.update(my, "DELETE FROM " + eqTable(collation));
				DialectProbe.update(my, "INSERT INTO " + eqTable(collation) + " (v) VALUES (?)",
						pair.getValue()[0]);
				measured.put(pair.getKey(), DialectProbe.number(my,
						"SELECT COUNT(*) FROM " + eqTable(collation) + " WHERE v = ?",
						pair.getValue()[1]) > 0);
			}
			byCollation.put(collation, measured);
		}

		// utf8mb4_bin은 PAD SPACE라 'x' = 'x ' 가 참이다 — 보안 축에서 탈락한다.
		assertTrue(byCollation.get("utf8mb4_bin").get("trailing-space"),
				"utf8mb4_bin의 PAD SPACE 실측이 달라졌다: " + byCollation.get("utf8mb4_bin"));
		// utf8mb4_0900_ai_ci는 대소문자·전각·자모를 전부 무시한다 — 보안 축에서 탈락한다.
		assertTrue(byCollation.get("utf8mb4_0900_ai_ci").get("case"));
		assertTrue(byCollation.get("utf8mb4_0900_ai_ci").get("fullwidth"));
		assertTrue(byCollation.get("utf8mb4_0900_ai_ci").get("hangul-decomposed"));

		assertEquals(sqlite, byCollation.get(DECIDED),
				"채택 collation(" + DECIDED + ")의 = 의미론이 SQLite BINARY와 갈렸다 — 보안 축이다");
		List<String> matching = CANDIDATES.stream().filter((c) -> sqlite.equals(byCollation.get(c))).toList();
		assertEquals(List.of("utf8mb4_0900_bin"), matching,
				"= 축에서 SQLite와 일치하는 후보 집합이 실측과 다르다: " + byCollation);
	}

	// --- 축 4: LIKE (포기한 축) ---

	@Test
	void axis4_likeCaseSensitivityIsTheSacrificedAxis() {
		DialectProbe.update(lite.connection(), "DELETE FROM Eq");
		DialectProbe.update(lite.connection(), "INSERT INTO Eq (v) VALUES ('ABC')");
		assertTrue(DialectProbe.number(lite.connection(), "SELECT COUNT(*) FROM Eq WHERE v LIKE ?", "abc") > 0,
				"SQLite LIKE는 ASCII 대소문자를 무시한다 — 이 전제가 깨지면 divergence 자체가 사라진다");

		Map<String, Boolean> likeCase = new LinkedHashMap<>();
		for (String collation : CANDIDATES) {
			DialectProbe.update(my, "DELETE FROM " + eqTable(collation));
			DialectProbe.update(my, "INSERT INTO " + eqTable(collation) + " (v) VALUES ('ABC')");
			likeCase.put(collation, DialectProbe.number(my,
					"SELECT COUNT(*) FROM " + eqTable(collation) + " WHERE v LIKE ?", "abc") > 0);
		}
		assertEquals(Map.of("utf8mb4_bin", false, "utf8mb4_0900_bin", false,
				"utf8mb4_0900_ai_ci", true), likeCase, "LIKE 대소문자 실측이 달라졌다");

		// 이것이 이 phase가 기록하는 divergence다 — 감추지 말고 양쪽 기대값을 각각 못 박는다.
		assertFalse(likeCase.get(DECIDED),
				"채택 collation에서 LIKE가 대소문자를 무시하게 됐다면 divergence 기록을 갱신해야 한다");
	}

	/** 와일드카드·이스케이프 없음·NULL — 이 축들은 <b>양쪽이 같다</b>(실측). */
	@Test
	void axis4_wildcardsAndNullBehaveIdenticallyInBothDialects() {
		String table = eqTable(DECIDED);
		DialectProbe.update(lite.connection(), "DELETE FROM Eq");
		DialectProbe.update(my, "DELETE FROM " + table);
		for (String value : List.of("a%b", "axxb", "axb", "가나다")) {
			DialectProbe.update(lite.connection(), "INSERT INTO Eq (v) VALUES (?)", value);
			DialectProbe.update(my, "INSERT INTO " + table + " (v) VALUES (?)", value);
		}
		DialectProbe.update(lite.connection(), "INSERT INTO Eq (v) VALUES (NULL)");
		DialectProbe.update(my, "INSERT INTO " + table + " (v) VALUES (NULL)");

		// 질의어에 든 %와 _ 는 ESCAPE 없이 바인딩되므로 양쪽 다 와일드카드로 동작한다
		// (PhotoRepository 34행 — 이 리포는 ESCAPE를 붙이지 않는다).
		// 'a%b'의 %는 0자 이상이므로 'a%b'(리터럴 %) · 'axb' · 'axxb'가 전부 걸린다 — 이스케이프가 없다는
		// 사실이 이렇게 드러난다(사용자가 검색어에 %를 넣으면 그것이 와일드카드로 동작한다).
		assertLike("query-percent", "a%b", List.of("a%b", "axb", "axxb"), table);
		assertLike("query-underscore", "a_b", List.of("a%b", "axb"), table);
		assertLike("empty-query", "%%", List.of("a%b", "axxb", "axb", "가나다"), table);
		assertLike("hangul-contains", "%나%", List.of("가나다"), table);
	}

	private static void assertLike(String label, String query, List<String> expected, String table) {
		List<String> sqlite = DialectProbe.strings(lite.connection(),
				"SELECT v FROM Eq WHERE v LIKE ?", query);
		List<String> mysqlRows = DialectProbe.strings(my,
				"SELECT v FROM " + table + " WHERE v LIKE ?", query);
		assertEquals(expected.stream().sorted().toList(), sqlite.stream().sorted().toList(),
				label + ": SQLite LIKE 결과가 실측과 다르다");
		assertEquals(expected.stream().sorted().toList(), mysqlRows.stream().sorted().toList(),
				label + ": MySQL LIKE 결과가 SQLite와 갈렸다");
	}

	// --- 축 5: ORDER BY ---

	/** 한글 24 + 영숫자 혼합 12 + ISO 시각 4 = 40개. 정렬 divergence를 드러내는 최소 표본이다. */
	static final List<String> SORT_SAMPLE = List.of(
			"가", "나", "다", "라", "마", "바", "사", "아",
			"자", "차", "카", "타", "파", "하", "강", "김",
			"박", "이", "최", "정", "한글", "한국", "서울", "부산",
			"Apple", "apple", "Banana", "banana", "Zebra", "zebra", "10", "2", "100", "_x", "AB", "ab",
			"2026-01-02T03:04:05.000Z", "2026-01-02T03:04:05Z", "2025-12-31T23:59:59.999Z",
			"2026-01-02T03:04:04.999Z");

	@Test
	void axis5_orderByMatchesSqliteOnlyUnderBinaryCollations() {
		for (String value : SORT_SAMPLE) {
			DialectProbe.update(lite.connection(), "INSERT INTO Ord (v) VALUES (?)", value);
			for (String collation : CANDIDATES) {
				DialectProbe.update(my, "INSERT INTO " + ordTable(collation) + " (v) VALUES (?)", value);
			}
		}

		List<String> sqlite = DialectProbe.strings(lite.connection(), "SELECT v FROM Ord ORDER BY v");
		assertEquals(utf8ByteOrder(SORT_SAMPLE), sqlite,
				"SQLite ORDER BY가 UTF-8 바이트 순서가 아니다 — BINARY 전제가 깨졌다");

		Map<String, List<String>> byCollation = new LinkedHashMap<>();
		for (String collation : CANDIDATES) {
			byCollation.put(collation,
					DialectProbe.strings(my, "SELECT v FROM " + ordTable(collation) + " ORDER BY v"));
		}

		assertEquals(sqlite, byCollation.get("utf8mb4_0900_bin"), "utf8mb4_0900_bin 정렬이 SQLite와 갈렸다");
		assertEquals(sqlite, byCollation.get("utf8mb4_bin"), "utf8mb4_bin 정렬이 SQLite와 갈렸다");
		assertNotEquals(sqlite, byCollation.get("utf8mb4_0900_ai_ci"),
				"utf8mb4_0900_ai_ci가 SQLite와 같은 순서를 냈다 — 그렇다면 이 축의 divergence 기록이 틀렸다");
		assertEquals(sqlite, byCollation.get(DECIDED),
				"채택 collation(" + DECIDED + ")의 정렬이 SQLite와 갈렸다");

		// 갈리는 지점을 사람이 이해할 수 있는 형태로 못 박는다(「갈린다」만 적으면 회귀 때 원인을 못 찾는다).
		List<String> aici = byCollation.get("utf8mb4_0900_ai_ci");
		assertTrue(sqlite.indexOf("Banana") < sqlite.indexOf("apple"),
				"BINARY에서는 대문자 전부가 소문자보다 앞이다");
		assertTrue(aici.indexOf("apple") < aici.indexOf("Banana"),
				"ai_ci에서는 대소문자를 무시하고 사전순으로 섞인다 — 이것이 정렬 divergence의 정체다");
	}

	/** 동일 키 tie의 반환 순서는 <b>양쪽 다 비보장</b>이다 — 그 사실 자체를 단언으로 남긴다. */
	@Test
	void axis5_tiesAreUnorderedInBothDialectsSoNothingMayDependOnThem() {
		DialectProbe.update(lite.connection(), "DELETE FROM Eq");
		DialectProbe.update(my, "DELETE FROM " + eqTable(DECIDED));
		for (int i = 0; i < 5; i++) {
			DialectProbe.update(lite.connection(), "INSERT INTO Eq (v) VALUES ('tie')");
			DialectProbe.update(my, "INSERT INTO " + eqTable(DECIDED) + " (v) VALUES ('tie')");
		}
		assertEquals(5, DialectProbe.strings(lite.connection(), "SELECT v FROM Eq ORDER BY v").size());
		assertEquals(5, DialectProbe.strings(my,
				"SELECT v FROM " + eqTable(DECIDED) + " ORDER BY v").size());
		// 순서를 단언하지 않는다 — 두 방언 모두 tie-break를 보장하지 않는다.
		// 소스 데이터에는 tie가 없다(Contents.createdAt 77/77 상이 — step1 배경 1).
	}

	// --- 도구 ---

	private static String eqTable(String collation) {
		return "eq_" + collation.replace("utf8mb4_", "");
	}

	private static String ordTable(String collation) {
		return "ord_" + collation.replace("utf8mb4_", "");
	}

	/** UTF-8 바이트를 부호 없이 비교한 순서 = SQLite BINARY의 정의. */
	static List<String> utf8ByteOrder(List<String> values) {
		List<String> sorted = new ArrayList<>(values);
		sorted.sort(Comparator.comparing((String s) -> s.getBytes(StandardCharsets.UTF_8),
				CollationSemanticsProbeTest::compareUnsigned));
		return sorted;
	}

	private static int compareUnsigned(byte[] left, byte[] right) {
		int limit = Math.min(left.length, right.length);
		for (int i = 0; i < limit; i++) {
			int diff = (left[i] & 0xFF) - (right[i] & 0xFF);
			if (diff != 0) {
				return diff;
			}
		}
		return left.length - right.length;
	}

}
