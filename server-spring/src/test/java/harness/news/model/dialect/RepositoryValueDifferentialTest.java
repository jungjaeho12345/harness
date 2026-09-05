package harness.news.model.dialect;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;

import harness.news.model.ContentsRow;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;

/**
 * 차등 측정 <b>축 B-3(id 생성·재사용)</b> · <b>B-4(바인딩 표현)</b> · <b>B-5(NULL vs 빈 문자열)</b>
 * (phase 75 step6).
 *
 * <h2>계약이 못 보는 축들이다(실측)</h2>
 * {@code receiver-config} 계약 케이스는 <b>id 원값을 리포트에 싣지 않는다</b>(생성 응답의 {@code id}는
 * {@code bodyKeys}로만 관측된다). 그래서 "삭제한 자리의 id가 재사용되는가"는 계약이 구조적으로 볼 수
 * 없고, 그 축은 <b>행 삭제가 허용된 유일한 테이블</b>에서만 도달 가능하다 —
 * {@code DELETE FROM ReceiverConfig}가 그 경로다. 바인딩 표현과 NULL/빈 문자열도 계약 케이스가 문자열만
 * 보내므로 관측되지 않는다.
 *
 * <p>대상 DB는 SQLite 임시 파일과 {@code harness_ct_<16진수>}({@code news_ct} 자격)다 —
 * 이 클래스는 행을 지우므로(id 재사용 측정) <b>운영·스테이징에서는 절대 돌지 않는다</b>.
 */
class RepositoryValueDifferentialTest {

	private static DialectPair pair;

	@BeforeAll
	static void openPair() {
		pair = DialectPair.open();
	}

	@AfterAll
	static void closePair() {
		if (pair != null) {
			pair.close();
		}
	}

	// --- 축 B-3: id 생성·재사용 --------------------------------------------------------------------

	/**
	 * <b>최댓값 행을 지운 뒤 재삽입하면 id가 갈린다</b> — SQLite는 재사용하고 InnoDB는 재사용하지 않는다.
	 *
	 * <p>divergence를 없애려 하지 않고 <b>양쪽 기대값을 각각 명시</b>해 고정한다. 실제 영향은 크지 않다
	 * (id는 응답에 실리지만 계약이 원값을 비교하지 않는다). 그러나 두 저장소를 오가는 롤백 시나리오에서
	 * "같은 id가 다른 행을 가리키는" 상태가 만들어질 수 있으므로 사실 자체를 기록해 둔다.
	 */
	@Test
	void deletingTheMaxRowThenReinsertingReusesTheIdOnSqliteButNotOnMysql() {
		Map<String, List<Integer>> byDialect = new LinkedHashMap<>();
		for (DialectPair.Side side : pair.both()) {
			int first = side.configs().insert(config("reuse-1"));
			int second = side.configs().insert(config("reuse-2"));
			assertEquals(first + 1, second, "연속 삽입은 두 방언 모두 간격이 없다");

			assertEquals(1, side.configs().remove(second), "유일한 행 삭제 예외 경로다");
			int reinserted = side.configs().insert(config("reuse-3"));
			byDialect.put(side.name(), List.of(first, second, reinserted));
		}

		List<Integer> onSqlite = byDialect.get("sqlite");
		List<Integer> onMysql = byDialect.get("mysql");
		assertEquals(onSqlite.get(1), onSqlite.get(2), "SQLite는 지워진 최댓값 id를 재사용한다");
		assertEquals(onMysql.get(1) + 1, onMysql.get(2), "InnoDB는 재사용하지 않는다(카운터가 앞으로만 간다)");
		assertNotEquals(onSqlite.get(2), onMysql.get(2), "이 축은 divergence다(축 6 — 유일 방어선은 이 테스트다)");
	}

	/** 롤백된 삽입도 같은 방향으로 갈린다 — SQLite는 간격을 남기지 않고 InnoDB는 남긴다. */
	@Test
	void aRolledBackInsertLeavesAGapOnMysqlButNotOnSqlite() {
		Map<String, List<Integer>> byDialect = new LinkedHashMap<>();
		for (DialectPair.Side side : pair.both()) {
			int before = side.configs().insert(config("rollback-before"));
			side.transactions().execute((status) -> {
				side.configs().insert(config("rollback-doomed"));
				status.setRollbackOnly();
				return null;
			});
			int after = side.configs().insert(config("rollback-after"));
			byDialect.put(side.name(), List.of(before, after));
		}

		List<Integer> onSqlite = byDialect.get("sqlite");
		List<Integer> onMysql = byDialect.get("mysql");
		assertEquals(onSqlite.get(0) + 1, onSqlite.get(1), "SQLite: 롤백된 id는 다시 쓰인다");
		assertEquals(onMysql.get(0) + 2, onMysql.get(1), "InnoDB: 롤백된 id는 버려진다(간격 1)");
	}

	/** 롤백 자체는 <b>동형</b>이다 — 행이 남지 않는다(간격만 갈린다). */
	@Test
	void rollbackDiscardsTheRowInBothDialects() {
		for (DialectPair.Side side : pair.both()) {
			String marker = "rollback-marker-" + side.name();
			side.transactions().execute((status) -> {
				side.configs().insert(config(marker));
				status.setRollbackOnly();
				return null;
			});

			assertEquals(List.of(), side.configs().query(Map.of("sourceId", marker)),
					side.name() + ": 롤백했는데 행이 남았다");
		}
	}

	// --- 축 B-4: 바인딩 표현 ------------------------------------------------------------------------

	/**
	 * 숫자는 {@code ColumnValues}가 <b>REAL로</b> 내린다 — 그 값이 텍스트 컬럼에 어떤 문자열로 앉는지를
	 * 잰다. <b>작은 값은 같고 큰 값은 갈린다</b>(2026-09-04 실측 — step1 축 1은 작은 값만 봐서 "divergence
	 * 0"으로 끝났다).
	 *
	 * <table border="1">
	 * <caption>{@code ReceiverConfig.port}에 남는 문자열</caption>
	 * <tr><th>바인딩 값</th><th>SQLite</th><th>MySQL</th></tr>
	 * <tr><td>{@code 0}</td><td>{@code 0.0}</td><td>{@code 0.0}</td></tr>
	 * <tr><td>{@code 21}</td><td>{@code 21.0}</td><td>{@code 21.0}</td></tr>
	 * <tr><td>{@code 2.0}</td><td>{@code 2.0}</td><td>{@code 2.0}</td></tr>
	 * <tr><td>{@code 1.5}</td><td>{@code 1.5}</td><td>{@code 1.5}</td></tr>
	 * <tr><td>{@code 1e9}</td><td>{@code 1000000000.0}</td><td><b>{@code 1000000000}</b></td></tr>
	 * <tr><td>{@code 1.2345678901234567e19}</td><td><b>{@code 1.23456789012346e+19}</b>(15자리)</td>
	 *     <td><b>{@code 1.2345678901234567e19}</b>(17자리)</td></tr>
	 * </table>
	 *
	 * <p><b>도달 경로가 있다</b>: JSON 본문의 숫자 리터럴({@code {"port": 1000000000}})이 그대로
	 * {@code ColumnValues}까지 온다. 계약 케이스는 문자열만 보내므로 이 축은 관측되지 않는다 —
	 * 이 테스트가 유일 방어선이다. <b>고치지 않는다</b>: 자체 숫자 포매터를 만들면
	 * {@code ColumnValues}의 근거("같은 변환 코드가 돌게 둔다")가 무너지고, {@code server/**}는 무수정
	 * 정본이다. divergence로 기록한다(docs/db-mysql-mapping.md §7).
	 */
	@Test
	void numericBindingsLandAsTheSameTextUntilTheMagnitudeGrows() {
		Map<String, String> expected = new LinkedHashMap<>();
		expected.put("0", "0.0 | 0.0");
		expected.put("21", "21.0 | 21.0");
		expected.put("2.0", "2.0 | 2.0");
		expected.put("1.5", "1.5 | 1.5");
		expected.put("1.0E9", "1000000000.0 | 1000000000");
		expected.put("1.2345678901234567E19", "1.23456789012346e+19 | 1.2345678901234567e19");

		List<Object> samples = new ArrayList<>();
		samples.add(Integer.valueOf(0));
		samples.add(Integer.valueOf(21));
		samples.add(Double.valueOf(2.0));
		samples.add(Double.valueOf(1.5));
		samples.add(Double.valueOf(1e9));
		samples.add(Double.valueOf(1.2345678901234567e19));

		Map<String, String> measured = new LinkedHashMap<>();
		for (Object sample : samples) {
			String marker = "bind-" + sample;
			measured.put(String.valueOf(sample), storedPort(pair.sqlite(), marker, sample)
					+ " | " + storedPort(pair.mysql(), marker, sample));
		}

		assertEquals(expected, measured, "숫자 바인딩의 저장 표현이 기록된 표와 다르다(양쪽 기대값을 각각 명시했다)");
	}

	/** 불리언·객체는 <b>양쪽 다</b> 바인딩 전에 거부된다(500 internal-error로 수렴 — Node 동형). */
	@Test
	void nonScalarBindingsAreRefusedBeforeTouchingEitherDialect() {
		for (DialectPair.Side side : pair.both()) {
			assertThrows(IllegalArgumentException.class,
					() -> side.configs().insert(config("boolean", Boolean.TRUE)),
					side.name() + ": 불리언이 거부되지 않았다");
		}
	}

	/**
	 * 정수 컬럼({@code ArticleHistory.targetId})의 표현도 잰다 — 이 컬럼만 TEXT affinity가 아니라
	 * (SQLite INTEGER · MySQL {@code BIGINT}) 숫자 바인딩의 착지점이 다르다.
	 */
	@Test
	void integerColumnBindingsLandTheSameWayInBothDialects() {
		String articleId = seedArticle(4100, "정수 컬럼 바인딩");
		for (Object sample : List.of(Integer.valueOf(42), Double.valueOf(42.0))) {
			Object onSqlite = storedTargetId(pair.sqlite(), articleId, sample);
			Object onMysql = storedTargetId(pair.mysql(), articleId, sample);
			assertEquals(String.valueOf(onSqlite), String.valueOf(onMysql),
					"targetId " + sample + " 의 저장 표현이 갈렸다");
		}
	}

	// --- 축 B-5: NULL vs 빈 문자열 ------------------------------------------------------------------

	/**
	 * NULL과 빈 문자열은 <b>다른 값</b>이고 왕복에서 서로 뒤바뀌지 않는다. 리포 {@code news.db}에 두 표현이
	 * 같은 컬럼에 공존하므로({@code embargoAt} 빈 문자열 52 + NULL 10 — 계획서 실측) 이 축이 무너지면
	 * 이관이 값을 바꾼다.
	 */
	@Test
	void nullAndEmptyStringSurviveTheRoundTripAsDistinctValuesInBothDialects() {
		for (DialectPair.Side side : pair.both()) {
			int nullId = side.configs().insert(config("null-vs-empty-null", "name", null));
			int emptyId = side.configs().insert(config("null-vs-empty-empty", "name", ""));

			assertNull(valueOf(side, nullId, "name"), side.name() + ": NULL이 빈 문자열로 바뀌었다");
			assertEquals("", valueOf(side, emptyId, "name"), side.name() + ": 빈 문자열이 NULL로 바뀌었다");
			assertNull(valueOf(side, nullId, "host"), side.name() + ": 주지 않은 컬럼은 NULL이다");
		}
	}

	/** 동등 필터의 3값 논리도 동형이다 — {@code = ''}는 빈 문자열만 고르고 NULL 행은 고르지 않는다. */
	@Test
	void anEqualityFilterOnTheEmptyStringSelectsTheSameRowsInBothDialects() {
		List<List<Object>> perDialect = new ArrayList<>();
		for (DialectPair.Side side : pair.both()) {
			String tag = "empty-filter-" + side.name();
			side.configs().insert(config(tag + "-a", "apiEndpoint", ""));
			side.configs().insert(config(tag + "-b", "apiEndpoint", null));
			side.configs().insert(config(tag + "-c", "apiEndpoint", "https://example.test"));

			List<Object> matched = new ArrayList<>();
			for (Map<String, Object> row : side.configs().query(Map.of("apiEndpoint", ""))) {
				String sourceId = String.valueOf(row.get("sourceId"));
				if (sourceId.startsWith(tag)) {
					matched.add(sourceId.substring(tag.length()));
				}
			}
			perDialect.add(matched);
		}

		assertEquals(List.of("-a"), perDialect.get(0), "빈 문자열 필터는 빈 문자열 행만 고른다");
		assertEquals(perDialect.get(0), perDialect.get(1), "빈 문자열 동등 필터가 갈렸다");
	}

	/** {@code Contents}의 시각 컬럼에서도 같은 축을 확인한다(두 표현이 실제로 공존하는 자리다). */
	@Test
	void theContentsProjectionKeepsNullAndEmptyApartInBothDialects() {
		String articleId = seedArticle(4200, "NULL과 빈 문자열", "", null);

		for (DialectPair.Side side : pair.both()) {
			ContentsRow row = onlyRow(side, articleId);
			assertEquals("", row.column("embargoAt"), side.name() + ": 빈 문자열이 보존되지 않았다");
			assertNull(row.column("secondEmbargoAt"), side.name() + ": NULL이 보존되지 않았다");
		}
	}

	// --- 픽스처 헬퍼 -------------------------------------------------------------------------------

	private static Map<String, Object> config(String sourceId) {
		return row("sourceId", sourceId, "type", "FTP", "name", "수신 " + sourceId,
				"createdAt", "2026-04-01T00:00:00.000Z");
	}

	private static Map<String, Object> config(String sourceId, Object port) {
		Map<String, Object> entry = config(sourceId);
		entry.put("port", port);
		return entry;
	}

	private static Map<String, Object> config(String sourceId, String column, Object value) {
		Map<String, Object> entry = config(sourceId);
		entry.put(column, value);
		return entry;
	}

	/** 숫자를 {@code port}에 넣고 <b>저장된 문자열</b>을 되읽는다. */
	private static String storedPort(DialectPair.Side side, String marker, Object value) {
		int id = side.configs().insert(config(marker + "-" + side.name(), value));
		Object stored = valueOf(side, id, "port");
		return (stored == null) ? null : String.valueOf(stored);
	}

	private static Object storedTargetId(DialectPair.Side side, String articleId, Object value) {
		long id = side.history().insert(row("articleId", articleId, "eventType", "distribute-failed",
				"targetId", value, "createdAt", "2026-04-01T00:00:00.000Z"));
		for (Map<String, Object> row : side.history().queryDistributionEvents(articleId, 50)) {
			if (((Number) row.get("id")).longValue() == id) {
				return row.get("targetId");
			}
		}
		throw new IllegalStateException("방금 넣은 이력 행을 찾지 못했다: " + id);
	}

	private static Object valueOf(DialectPair.Side side, int id, String column) {
		List<Map<String, Object>> rows = side.configs().query(Map.of("id", Integer.valueOf(id)));
		assertEquals(1, rows.size(), side.name() + ": id=" + id + " 행을 찾지 못했다");
		return rows.get(0).get(column);
	}

	private static ContentsRow onlyRow(DialectPair.Side side, String articleId) {
		List<ContentsRow> rows = side.articles().query(Map.of("articleId", List.of(articleId)));
		assertEquals(1, rows.size(), side.name() + ": 기사 1건이어야 한다");
		return rows.get(0);
	}

	private static String seedArticle(int index, String title) {
		return seedArticle(index, title, null, null);
	}

	private static String seedArticle(int index, String title, Object embargoAt, Object secondEmbargoAt) {
		String articleId = "AKR%08d%09d".formatted(20260401, index);
		Map<String, Object> contents = row("articleId", articleId, "title", title, "status", "RDS",
				"createdAt", "2026-04-01T00:00:00.000Z");
		contents.put("embargoAt", embargoAt);
		contents.put("secondEmbargoAt", secondEmbargoAt);
		for (DialectPair.Side side : pair.both()) {
			side.articles().insert(row("articleId", articleId, "title", title), contents);
		}
		return articleId;
	}

	private static Map<String, Object> row(Object... keyValues) {
		Map<String, Object> map = new LinkedHashMap<>();
		for (int i = 0; i < keyValues.length; i += 2) {
			map.put((String) keyValues[i], keyValues[i + 1]);
		}
		return map;
	}
}
