package harness.news.model;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.zaxxer.hikari.HikariDataSource;
import harness.news.db.NewsDataSource;
import harness.news.testsupport.TempNewsDb;
import java.nio.file.Path;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.jdbc.core.simple.JdbcClient;

/**
 * DistributionTarget 리포지토리 — 리포 루트 {@code src/models/distributionTargetModel.js}와 1:1 대응하는
 * 4연산(query·findById·insert·update)의 동작 계약. <b>삭제 연산은 없다</b>(soft delete만).
 *
 * <p>핵심 축: (1) query는 화이트리스트 AND 동등이며 {@code active}로 자동 필터링하지 않는다(비활성 행도
 * 남는다). (2) update는 present-only(전달 컬럼만·id는 SET 제외)이고 빈 fields면 changes 0. (3) 비수치
 * id는 NaN으로 넘어와 findById가 빈 Optional이다(서비스의 not-found 수렴 재료). (4) active='N' update는
 * 행을 지우지 않는다.
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
		TempNewsDb.seed(this.tempDir);
		this.dataSource = NewsDataSource.create(this.tempDir);
		this.targets = new DistributionTargetRepository(JdbcClient.create(this.dataSource));
	}

	@AfterEach
	void tearDown() {
		if (this.dataSource != null) {
			this.dataSource.close();
		}
	}

	private static Map<String, Object> row(Object... keyValues) {
		Map<String, Object> map = new LinkedHashMap<>();
		for (int i = 0; i < keyValues.length; i += 2) {
			map.put((String) keyValues[i], keyValues[i + 1]);
		}
		return map;
	}

	// --- insert + findById/query round trip -----------------------------------------------------

	@Test
	void insertThenReadRoundTripsEveryColumn() {
		int id = this.targets.insert(row(
				"name", "대상1", "kind", "press", "spoolDir", "press-1",
				"active", "Y", "createdAt", "2026-08-22T00:00:00.000Z", "updatedAt", "2026-08-22T00:00:00.000Z"));

		assertTrue(id > 0);
		Optional<Map<String, Object>> found = this.targets.findById(id);
		assertTrue(found.isPresent());
		Map<String, Object> target = found.get();
		assertEquals(Long.valueOf(id), target.get("id"), "id는 정수로 읽힌다");
		assertEquals("대상1", target.get("name"));
		assertEquals("press", target.get("kind"));
		assertEquals("press-1", target.get("spoolDir"));
		assertEquals("Y", target.get("active"));
		assertEquals("2026-08-22T00:00:00.000Z", target.get("updatedAt"));
	}

	@Test
	void insertIgnoresIdAndRejectsEmptyWhitelist() {
		int id = this.targets.insert(row("id", 999, "name", "대상2", "kind", "nonpress", "notAColumn", "무시"));
		assertEquals(Long.valueOf(id), this.targets.findById(id).get().get("id"),
				"id는 호출자 값이 아니라 자동 증가값이다");

		assertThrows(IllegalArgumentException.class, () -> this.targets.insert(row("notAColumn", "x")));
		assertThrows(IllegalArgumentException.class, () -> this.targets.insert(row()));
	}

	// --- query 화이트리스트 · 비활성 행 보존 -------------------------------------------------------

	@Test
	void queryFiltersByWhitelistIgnoresUnknownKeysAndKeepsInactiveRows() {
		int press = this.targets.insert(row("name", "언론사", "kind", "press", "spoolDir", "sp-press", "active", "Y"));
		this.targets.insert(row("name", "비언론사", "kind", "nonpress", "spoolDir", "sp-non", "active", "N"));

		// spoolDir로 좁히면 그 행만.
		List<Map<String, Object>> bySpool = this.targets.query(row("spoolDir", "sp-press"));
		assertEquals(1, bySpool.size());
		assertEquals(Long.valueOf(press), bySpool.get(0).get("id"));

		// AND 불일치 → 빈 목록.
		assertEquals(0, this.targets.query(row("spoolDir", "sp-press", "kind", "nonpress")).size());

		// 화이트리스트 밖 키는 무시.
		assertEquals(1, this.targets.query(row("spoolDir", "sp-press", "notAColumn", "zzz")).size());

		// active로 자동 필터링하지 않는다 — 비활성 행도 전건 목록에 남는다.
		assertEquals(2, this.targets.query(row()).size(), "비활성 행도 목록에 남는다");
	}

	// --- update present-only · id는 SET 제외 -------------------------------------------------------

	@Test
	void updateAppliesOnlyGivenColumnsAndLeavesTheRest() {
		int id = this.targets.insert(row("name", "원래이름", "kind", "press", "spoolDir", "sp-u", "active", "Y"));

		assertEquals(1, this.targets.update(id, row("name", "바뀐이름", "updatedAt", "2026-08-22T01:00:00.000Z")));

		Map<String, Object> target = this.targets.findById(id).get();
		assertEquals("바뀐이름", target.get("name"));
		assertEquals("press", target.get("kind"), "전달하지 않은 컬럼은 불변");
		assertEquals("sp-u", target.get("spoolDir"), "전달하지 않은 컬럼은 불변");
	}

	@Test
	void updateWithEmptyOrIdOnlyFieldsReturnsZeroChanges() {
		int id = this.targets.insert(row("name", "x", "kind", "press", "spoolDir", "sp-e"));

		assertEquals(0, this.targets.update(id, row()), "빈 fields → changes 0(SQL 미실행)");
		assertEquals(0, this.targets.update(id, row("id", 1, "notAColumn", "y")), "id·미지 키만 → changes 0");
	}

	@Test
	void deactivationKeepsTheRow() {
		int id = this.targets.insert(row("name", "비활성대상", "kind", "press", "spoolDir", "sp-d", "active", "Y"));

		assertEquals(1, this.targets.update(id, row("active", "N")));

		assertTrue(this.targets.findById(id).isPresent(), "soft delete는 행을 지우지 않는다");
		assertEquals("N", this.targets.findById(id).get().get("active"), "soft delete는 active만 바꾼다");
	}

	// --- 비수치(NaN) id 수렴 ----------------------------------------------------------------------

	@Test
	void findByIdOfNanIsEmptyAndUpdateOfNanChangesNothing() {
		int id = this.targets.insert(row("name", "살아있음", "kind", "press", "spoolDir", "sp-live"));

		assertTrue(this.targets.findById(Double.NaN).isEmpty(), "NaN id는 어떤 행에도 매치되지 않는다");
		assertEquals(0, this.targets.update(Double.NaN, row("name", "안바뀜")), "NaN id update는 매칭 0 → changes 0");
		assertEquals("살아있음", this.targets.findById(id).get().get("name"), "다른 행은 불변");
	}

	@Test
	void findByIdOfAbsentIsEmpty() {
		assertTrue(this.targets.findById(999_999).isEmpty());
	}

	// --- 값 바인딩 정책(decisions (13)) -----------------------------------------------------------

	@Test
	void insertRejectsNonScalarBindingValues() {
		assertThrows(IllegalArgumentException.class,
				() -> this.targets.insert(row("name", Boolean.TRUE)));
		assertThrows(IllegalArgumentException.class,
				() -> this.targets.insert(row("name", List.of("x"))));
	}
}
