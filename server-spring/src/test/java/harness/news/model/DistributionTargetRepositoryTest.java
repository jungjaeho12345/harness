package harness.news.model;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.zaxxer.hikari.HikariDataSource;
import harness.news.db.NewsDataSource;
import harness.news.db.RequiredSchema;
import harness.news.testsupport.TempNewsDb;
import java.lang.reflect.Method;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.jdbc.core.simple.JdbcClient;

/**
 * 배부 수신처 리포지토리 — 리포 루트 {@code src/models/distributionTargetModel.js}와 1:1인 4연산의 동작
 * 계약(query·findById·insert·update). <b>삭제 함수는 없다</b>(soft delete는 서비스가 update로 한다).
 *
 * <p>계약 스위트가 관측하지 못하는 축(index.json forward_notes (5)): 숫자 저장 표현(gap #4 · {@code "42.0"}),
 * 비-ASCII 왕복(gap #5), 키 집합=요구 스키마 컬럼, present-only update·no-op(0컬럼→0).
 *
 * <p>2026-08-22 Node 대조 실측(작업 A)과 1:1이다: id는 number, findById(없는 id·NaN)→null(예외 없음),
 * update present-only·{name만 바꿔도 spoolDir 불변}·no-op(빈/ id만)→0·없는 id→0.
 *
 * <p>임시 파일 DB(@TempDir)만 쓴다 — 리포 {@code news.db}는 열지 않는다.
 */
class DistributionTargetRepositoryTest {

	@TempDir
	Path tempDir;

	private HikariDataSource dataSource;

	private DistributionTargetRepository targets;

	@BeforeEach
	void setUp() {
		TempNewsDb.seed(tempDir);
		dataSource = NewsDataSource.create(tempDir);
		targets = new DistributionTargetRepository(JdbcClient.create(dataSource));
	}

	@AfterEach
	void tearDown() {
		if (dataSource != null) {
			dataSource.close();
		}
	}

	// --- 삽입·조회 -----------------------------------------------------------------------------

	@Test
	void insertReturnsRowIdAndQueryCarriesEveryColumnKeepingNullKeys() {
		long id1 = targets.insert(row("name", "언론사", "kind", "press", "spoolDir", "press-1",
				"active", "Y", "createdAt", "t0", "updatedAt", "t0"));
		long id2 = targets.insert(row("name", "비언론사", "kind", "nonpress", "spoolDir", "np"));

		assertEquals(1L, id1);
		assertEquals(2L, id2);

		List<Map<String, Object>> all = targets.query(Map.of());
		assertEquals(List.of(1L, 2L), ids(all), "ORDER BY id 오름차순");
		assertEquals(RequiredSchema.DISTRIBUTION_TARGET_COLUMNS, List.copyOf(all.get(0).keySet()),
				"행은 7키 전부를 스키마 순서로 담는다");

		Map<String, Object> second = all.get(1);
		assertEquals(2L, second.get("id"), "id는 정수(number)로 읽는다");
		assertTrue(second.containsKey("updatedAt"));
		assertNull(second.get("updatedAt"), "미전달 컬럼도 키는 남기고 값은 null이다");
	}

	@Test
	void insertWithoutAnyWhitelistedColumnIsRejected() {
		assertThrows(IllegalArgumentException.class, () -> targets.insert(row("unknown", "x")));
		assertThrows(IllegalArgumentException.class, () -> targets.insert(row("id", 5)), "id는 삽입 대상이 아니다");
	}

	@Test
	void aNewColumnInTheDbDoesNotWidenTheRowKeySet() {
		TempNewsDb.exec(TempNewsDb.dbFile(tempDir), "ALTER TABLE DistributionTarget ADD COLUMN secretNote VARCHAR");
		targets.insert(row("name", "g", "kind", "press", "spoolDir", "g1"));

		Map<String, Object> only = targets.query(Map.of()).get(0);
		assertEquals(RequiredSchema.DISTRIBUTION_TARGET_COLUMNS, List.copyOf(only.keySet()));
		assertFalse(only.containsKey("secretNote"));
	}

	// --- findById -----------------------------------------------------------------------------

	@Test
	void findByIdReturnsARowOrNull() {
		targets.insert(row("name", "a", "kind", "press", "spoolDir", "a1"));

		Map<String, Object> found = targets.findById(1);
		assertEquals("a", found.get("name"));
		assertEquals(1L, found.get("id"));

		assertNull(targets.findById(999), "없는 id는 null이다(Node undefined)");
		assertNull(targets.findById(Double.NaN), "NaN id는 null이다(예외 아님 — 작업 A 실측)");
	}

	// --- 필터 ---------------------------------------------------------------------------------

	@Test
	void filtersAreWhitelistColumnAndEquality() {
		targets.insert(row("name", "한글수신처", "kind", "press", "spoolDir", "press-1"));
		targets.insert(row("name", "second", "kind", "nonpress", "spoolDir", "np"));

		assertEquals(List.of(1L), ids(targets.query(Map.of("spoolDir", "press-1"))));
		assertEquals(List.of(2L), ids(targets.query(Map.of("kind", "nonpress"))));
		assertEquals(List.of(1L), ids(targets.query(Map.of("name", "한글수신처"))), "비-ASCII 필터 왕복(gap #5)");
		assertEquals(List.of(1L, 2L), ids(targets.query(Map.of("nickname", "x"))), "미지 키는 무시(전건)");
		assertEquals(List.of(1L, 2L), ids(targets.query(Map.of())));
	}

	// --- update(present-only) ------------------------------------------------------------------

	@Test
	void updateTouchesOnlyGivenColumnsAndReturnsAffectedRowCount() {
		targets.insert(row("name", "옛이름", "kind", "press", "spoolDir", "press-1",
				"active", "Y", "createdAt", "t0", "updatedAt", "t0"));

		assertEquals(1, targets.update(1, row("name", "새이름", "updatedAt", "t1")));

		Map<String, Object> after = targets.findById(1);
		assertEquals("새이름", after.get("name"));
		assertEquals("t1", after.get("updatedAt"));
		assertEquals("press-1", after.get("spoolDir"), "주지 않은 컬럼은 그대로다");
		assertEquals("t0", after.get("createdAt"), "createdAt은 update가 건드리지 않는다");
	}

	@Test
	void updateWithNoWhitelistedColumnsIsAQuietZero() {
		targets.insert(row("name", "a", "kind", "press", "spoolDir", "a1"));

		assertEquals(0, targets.update(1, row()), "컬럼 0개면 no-op 0");
		assertEquals(0, targets.update(1, row("id", 9)), "id만 주면 SET 대상이 없어 0");
		assertEquals(0, targets.update(1, row("nickname", "x")), "미지 컬럼만 주면 0");
	}

	@Test
	void updateOfAMissingIdIsZero() {
		assertEquals(0, targets.update(999, row("name", "z")), "없는 id는 0(존재 판정은 서비스 몫)");
	}

	@Test
	void primaryKeyIsNeverAssignedByUpdate() {
		targets.insert(row("name", "a", "kind", "press", "spoolDir", "a1"));

		assertEquals(0, targets.update(1, row("id", 42)));
		assertNull(targets.findById(42), "PK는 SET 대상이 아니다");
		assertEquals("a", targets.findById(1).get("name"));
	}

	// --- 숫자 바인딩 정책(gap #4) --------------------------------------------------------------

	@Test
	void numbersAreStoredAsTextTheSameWayNodeStoresThem() {
		targets.insert(row("name", "a", "kind", "press", "spoolDir", "a1"));
		targets.update(1, row("updatedAt", 100));

		// node:sqlite는 100을 REAL로 내리고 TEXT affinity가 "100.0"으로 저장한다(작업 A 실측).
		assertEquals("100.0", targets.findById(1).get("updatedAt"));
	}

	// --- 삭제 함수 부재(decisions (1)) ---------------------------------------------------------

	@Test
	void theRepositoryExposesNoDeleteOrRemoveMethod() {
		// 대상 제거는 active='N' soft delete가 유일 경로다 — 리포지토리에 삭제 진입점이 있으면 안 된다.
		for (Method method : DistributionTargetRepository.class.getMethods()) {
			String name = method.getName().toLowerCase();
			assertFalse(name.contains("delete") || name.contains("remove"),
					"DistributionTargetRepository에 삭제 메서드가 있으면 안 된다: " + method.getName());
		}
	}

	// --- 헬퍼 ---------------------------------------------------------------------------------

	private static List<Long> ids(List<Map<String, Object>> rows) {
		List<Long> out = new ArrayList<>();
		for (Map<String, Object> row : rows) {
			out.add((Long) row.get("id"));
		}
		return out;
	}

	private static Map<String, Object> row(Object... keyValues) {
		Map<String, Object> map = new LinkedHashMap<>();
		for (int i = 0; i < keyValues.length; i += 2) {
			map.put((String) keyValues[i], keyValues[i + 1]);
		}
		return map;
	}
}
