package harness.news.model;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.zaxxer.hikari.HikariDataSource;
import harness.news.db.NewsDataSource;
import harness.news.db.RequiredSchema;
import harness.news.testsupport.TempNewsDb;
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
 * 수신 설정 리포지토리 — 리포 루트 {@code src/models/receiverConfigModel.js}와 1:1인 3연산의 동작 계약.
 *
 * <p>계약 스위트가 관측하지 못하는 축이 여기 모여 있다(index.json forward_notes (5)):
 * <ol>
 *   <li><b>숫자 저장 표현</b>(gap #4) — {@code 42}는 {@code "42.0"}으로 저장된다(node:sqlite REAL→TEXT).
 *       계약 픽스처는 {@code port}를 문자열 {@code '21'}로만 보내므로 이 테스트가 유일한 방어선이다.</li>
 *   <li><b>비-ASCII 왕복</b>(gap #5) — 한글 name/sourceId 저장 후 그 값으로 필터 조회 시 매치.</li>
 *   <li><b>키 집합 = 요구 스키마 컬럼</b>이고 값이 SQL NULL이어도 키가 남는다({@code SELECT *} 금지).</li>
 *   <li><b>행 삭제 경계</b> — {@code remove}는 {@code ReceiverConfig} 테이블 하나에만 {@code DELETE}를 낸다.</li>
 * </ol>
 *
 * <p>2026-08-22 Node 대조 실측(작업 A)과 1:1이다: id는 number(정수), port 42→{@code "42.0"},
 * 필터 {@code password}는 화이트리스트라 적용되고(결함 후보 #3), 미지 키는 무시,
 * {@code remove(NaN)}·없는 id·재삭제는 모두 {@code 0}(예외 없음).
 *
 * <p>임시 파일 DB(@TempDir)만 쓴다 — 리포 {@code news.db}는 열지 않는다.
 */
class ReceiverConfigRepositoryTest {

	@TempDir
	Path tempDir;

	private HikariDataSource dataSource;

	private ReceiverConfigRepository configs;

	@BeforeEach
	void setUp() {
		TempNewsDb.seed(tempDir);
		dataSource = NewsDataSource.create(tempDir);
		configs = new ReceiverConfigRepository(JdbcClient.create(dataSource));
	}

	@AfterEach
	void tearDown() {
		if (dataSource != null) {
			dataSource.close();
		}
	}

	// --- 삽입·조회 -----------------------------------------------------------------------------

	@Test
	void insertReturnsTheRowIdAndQueryCarriesEveryColumnKeepingNullKeys() {
		long id1 = configs.insert(row("sourceId", "S1", "type", "ftp", "name", "한글이름",
				"port", "21", "active", "Y"));
		long id2 = configs.insert(row("sourceId", "S2", "name", "second"));

		assertEquals(1L, id1, "id는 자동 증가 정수다");
		assertEquals(2L, id2);

		List<Map<String, Object>> all = configs.query(Map.of());
		assertEquals(List.of(1L, 2L), ids(all), "ORDER BY id 오름차순");
		assertEquals(RequiredSchema.RECEIVER_CONFIG_COLUMNS, List.copyOf(all.get(0).keySet()),
				"행은 12키 전부를 스키마 순서로 담는다");

		Map<String, Object> first = all.get(0);
		assertEquals(1L, first.get("id"), "id는 정수(number)로 읽는다 — Node 동형");
		assertEquals("S1", first.get("sourceId"));
		assertEquals("한글이름", first.get("name"));
		// 미전달 컬럼도 키는 남기고 값은 null이다(응답 키 집합이 값에 따라 흔들리지 않게).
		assertTrue(first.containsKey("host"));
		assertNull(first.get("host"));
		assertNull(first.get("createdAt"), "서버는 receiver-config의 createdAt을 stamp하지 않는다");
	}

	@Test
	void insertWithoutAnyWhitelistedColumnIsRejected() {
		// Node insert와 동형 — 빈 INSERT 문을 만들지 않는다(id는 삽입 대상이 아니다).
		assertThrows(IllegalArgumentException.class, () -> configs.insert(row("unknown", "x")));
		assertThrows(IllegalArgumentException.class, () -> configs.insert(row("id", 5)));
	}

	@Test
	void aNewColumnInTheDbDoesNotWidenTheRowKeySet() {
		// 응답 키 집합의 출처는 DB가 아니라 요구 목록이다(SELECT * 금지). 시크릿 컬럼이 추가돼도 새지 않는다.
		TempNewsDb.exec(TempNewsDb.dbFile(tempDir), "ALTER TABLE ReceiverConfig ADD COLUMN secretToken VARCHAR");
		configs.insert(row("sourceId", "S-G", "name", "gamma"));

		Map<String, Object> only = configs.query(Map.of()).get(0);
		assertEquals(RequiredSchema.RECEIVER_CONFIG_COLUMNS, List.copyOf(only.keySet()));
		assertFalse(only.containsKey("secretToken"));
	}

	// --- 필터 ---------------------------------------------------------------------------------

	@Test
	void filtersAreWhitelistColumnAndEquality() {
		configs.insert(row("sourceId", "S1", "name", "한글이름", "active", "Y"));
		configs.insert(row("sourceId", "S2", "name", "second", "active", "N"));

		assertEquals(List.of(1L), ids(configs.query(Map.of("name", "한글이름"))), "비-ASCII 필터 왕복(gap #5)");
		assertEquals(List.of(2L), ids(configs.query(Map.of("active", "N"))));
		assertEquals(List.of(1L, 2L), ids(configs.query(Map.of())), "빈 필터는 전건이다");
	}

	@Test
	void unknownFilterKeysAreIgnoredNotRejected() {
		configs.insert(row("sourceId", "S1", "name", "alpha"));
		configs.insert(row("sourceId", "S2", "name", "beta"));

		// 화이트리스트 밖 키는 조용히 무시된다(거부가 아니다) — Node 동형(전건 반환).
		assertEquals(List.of(1L, 2L), ids(configs.query(Map.of("nickname", "x", "foo", "bar"))));
	}

	@Test
	void idFilterMatchesRegardlessOfStringOrNumber() {
		configs.insert(row("sourceId", "S1", "name", "alpha"));
		configs.insert(row("sourceId", "S2", "name", "beta"));

		// id는 INTEGER 컬럼이라 SQLite affinity가 문자열 '1'도 정수 1로 비교한다(Node 실측 동형).
		assertEquals(List.of(1L), ids(configs.query(Map.of("id", 1))));
		assertEquals(List.of(1L), ids(configs.query(Map.of("id", "1"))));
	}

	@Test
	void secretColumnsAreAcceptedAsFilterKeysDefectCandidate3() {
		// 결함 후보 #3 재현: FILTERABLE이 password·apiKey를 포함하므로 그 키의 필터가 적용된다.
		// 여기서 고치지 않는다(Node 동형 — 값 확인 오라클). 미지 키(무시=전건)와 달리 값을 되묻는다.
		configs.insert(row("sourceId", "S1", "name", "alpha", "password", "pw-1"));
		configs.insert(row("sourceId", "S2", "name", "beta", "password", "pw-2"));

		assertEquals(List.of(1L), ids(configs.query(Map.of("password", "pw-1"))),
				"password 필터가 적용된다(무시가 아니다) — 결함 후보 #3");
		assertEquals(List.of(), ids(configs.query(Map.of("apiKey", "없는키"))),
				"apiKey 필터도 적용된다(매치 0)");
	}

	// --- 숫자 바인딩 정책(gap #4) --------------------------------------------------------------

	@Test
	void numbersAreStoredAsTextTheSameWayNodeStoresThem() {
		// node:sqlite는 JS number를 REAL로 내리고 TEXT affinity 컬럼이 42를 "42.0"으로 저장한다(작업 A 실측).
		// Java에서 String.valueOf로 문자열을 만들면 "42"가 되어 두 서버의 저장값이 갈린다(Types.DOUBLE 필수).
		configs.insert(row("sourceId", "S1", "name", "alpha", "port", 42));
		configs.insert(row("sourceId", "S2", "name", "beta", "port", 1_000_000_000));

		assertEquals("42.0", configs.query(Map.of("id", 1)).get(0).get("port"));
		assertEquals("1000000000.0", configs.query(Map.of("id", 2)).get(0).get("port"));
	}

	@Test
	void nullIsStoredAsSqlNullAndTheKeyRemains() {
		configs.insert(row("sourceId", "S1", "name", "alpha", "host", null));

		Map<String, Object> only = configs.query(Map.of()).get(0);
		assertNull(only.get("host"));
		assertTrue(only.containsKey("host"));
	}

	// --- 삭제(시스템 유일의 행 삭제 라우트) ----------------------------------------------------

	@Test
	void removeDeletesTheConfigRowAndIsIdempotent() {
		configs.insert(row("sourceId", "S1", "name", "alpha"));
		configs.insert(row("sourceId", "S2", "name", "beta"));

		assertEquals(1, configs.remove(1), "성공 삭제는 changes:1");
		assertEquals(0, configs.remove(1), "재삭제는 changes:0(멱등)");
		assertEquals(0, configs.remove(999), "없는 id는 changes:0");
		assertEquals(List.of(2L), ids(configs.query(Map.of())), "다른 행은 남는다");
	}

	@Test
	void removeWithNaNChangesNothingWithoutThrowing() {
		configs.insert(row("sourceId", "S1", "name", "alpha"));

		// 라우트가 Number(req.params.id)로 숫자화하므로 'abc' 같은 경로는 NaN이 된다.
		// Node node:sqlite는 NaN을 바인딩해 매치 0건(changes:0)이고 던지지 않는다(작업 A 실측).
		assertEquals(0, configs.remove(Double.NaN), "NaN id는 changes:0(예외 아님)");
		assertEquals(List.of(1L), ids(configs.query(Map.of())), "행은 그대로다");
	}

	@Test
	void removeOnlyTouchesTheReceiverConfigTable() {
		// 행 삭제 경계 — 같은 sourceId의 수집 기사(Article/Contents)는 건드리지 않는다.
		configs.insert(row("sourceId", "S1", "name", "alpha"));
		TempNewsDb.exec(TempNewsDb.dbFile(tempDir),
				"INSERT INTO Contents (articleId, sender) VALUES ('A-1', 'S1')");

		assertEquals(1, configs.remove(1));

		List<String> survivors = new ArrayList<>(JdbcClient.create(dataSource)
				.sql("SELECT articleId FROM Contents WHERE sender = 'S1'")
				.query(String.class)
				.list());
		assertEquals(List.of("A-1"), survivors, "설정 행 삭제가 수집 기사를 지우면 안 된다");
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
