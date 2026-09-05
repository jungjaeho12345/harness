package harness.news.model;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.zaxxer.hikari.HikariDataSource;
import harness.news.db.NewsDataSource;
import harness.news.db.RequiredSchema;
import harness.news.testsupport.TempNewsDb;
import java.lang.reflect.Method;
import java.lang.reflect.Modifier;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.TreeSet;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.jdbc.core.simple.JdbcClient;

/**
 * 이력 리포지토리 — 리포 루트 {@code src/models/articleHistoryModel.js}의 삽입·조회 3종과 1:1인 동작 계약.
 *
 * <p>이 원장은 <b>append-only</b>다. 그래서 이 테스트가 지키는 것은 "무엇을 할 수 있는가"만이 아니라
 * <b>무엇을 할 수 없는가</b>이기도 하다 — 갱신·삭제 연산이 존재하지 않는다는 사실을 리플렉션과
 * 행 수 시나리오로 함께 잠근다(감사 기록이자 판정 입력이라 한 번 지우면 복구 수단이 없다).
 *
 * <p>계약 스위트가 관측하지 못하는 축이 여기 모여 있다.
 * <ol>
 *   <li><b>{@code hasSnapshot}은 불리언이 아니라 정수 1/0</b>이다 — 계약은 값만 보지만 Java 타입이
 *       불리언이면 JSON이 {@code true}가 되어 그 자리에서 diff가 된다.</li>
 *   <li><b>목록 행 9키 고정 + NULL 키 보존</b>(step0 발견: 계약 픽스처는 NULL 키 보존 축을 못 잡는다).</li>
 *   <li><b>{@code targetId}는 INTEGER 컬럼</b>이라 Node와 같은 정수 표현으로 저장돼야 한다 —
 *       문자열로 저장되면 다음 phase의 수신처 매칭이 조용히 깨진다.</li>
 *   <li><b>단건 스냅샷은 {@code articleId} 스코프</b>다 — 빠지면 id만으로 남의 본문을 읽는 권한 우회다.</li>
 * </ol>
 *
 * <p>임시 파일 DB(@TempDir)만 쓴다 — 리포 {@code news.db}는 열지 않는다.
 */
class ArticleHistoryRepositoryTest {

	/** 목록 행의 고정 키 — 모델 8컬럼 + 파생 {@code hasSnapshot}. 정렬한 형태로 비교한다. */
	private static final List<String> LIST_ROW_KEYS = List.of(
			"action", "actorUserId", "articleId", "createdAt", "eventType", "fromStatus",
			"hasSnapshot", "id", "toStatus");

	/** 단건 스냅샷 항목의 고정 키 7개(전이 컬럼 없음, 본문 있음). */
	private static final List<String> SNAPSHOT_ITEM_KEYS = List.of(
			"action", "actorUserId", "articleId", "createdAt", "eventType", "id", "markupVersion");

	/**
	 * 배부 이벤트 행의 고정 키 8개 — 목록 9키와 <b>다르다</b>({@code targetId}·{@code reason}이 여기에만
	 * 있고 전이 2컬럼·{@code hasSnapshot}은 없다). 정렬한 형태로 비교한다.
	 */
	private static final List<String> DISTRIBUTION_EVENT_KEYS = List.of(
			"action", "actorUserId", "articleId", "createdAt", "eventType", "id", "reason", "targetId");

	/** 컬럼 목록 순서 그대로의 키 8개 — 맵이 {@code LinkedHashMap}이라는 사실까지 잠근다. */
	private static final List<String> DISTRIBUTION_EVENT_KEY_ORDER = List.of(
			"id", "articleId", "eventType", "action", "targetId", "reason", "actorUserId", "createdAt");

	@TempDir
	Path tempDir;

	private HikariDataSource dataSource;

	private ArticleHistoryRepository history;

	@BeforeEach
	void setUp() {
		TempNewsDb.seed(tempDir);
		dataSource = NewsDataSource.create(tempDir);
		history = new ArticleHistoryRepository(JdbcClient.create(dataSource));
	}

	@AfterEach
	void tearDown() {
		if (dataSource != null) {
			dataSource.close();
		}
	}

	// --- 1. 삽입 ------------------------------------------------------------------------------

	@Test
	void insertReturnsTheNewRowIdAndTheRowIsVisibleInTheList() {
		long first = history.insert(row("articleId", "A1", "eventType", "edit",
				"actorUserId", "u1", "createdAt", "2026-08-20T00:00:00.000Z",
				"markupVersion", "본문", "snapshotTitle", "제목"));
		long second = history.insert(row("articleId", "A1", "eventType", "status", "action", "send",
				"fromStatus", "RDS", "toStatus", "DPS", "actorUserId", "u1",
				"createdAt", "2026-08-20T00:00:01.000Z"));

		assertTrue(first >= 1, "새 행의 id는 1 이상의 정수다: " + first);
		assertTrue(second > first, "id는 증가한다: " + first + " → " + second);

		List<Map<String, Object>> rows = history.queryByArticle("A1");
		assertEquals(List.of(second, first), ids(rows), "삽입한 두 행이 모두 보인다(최신이 위)");
	}

	@Test
	void insertWithoutAnyWhitelistedColumnIsRejected() {
		// Node insertInto와 동형 — 빈 INSERT 문을 만들지 않는다.
		assertThrows(IllegalArgumentException.class, () -> history.insert(Map.of()));
		assertThrows(IllegalArgumentException.class, () -> history.insert(row("nickname", "x")));
	}

	@Test
	void idIsNotAnInsertableColumn() {
		// 삽입 화이트리스트는 요구 컬럼 12개에서 id를 뺀 11개다(배부 2컬럼은 남는다 — 다음 phase가 쓴다).
		assertEquals(
				List.of("articleId", "eventType", "action", "fromStatus", "toStatus", "actorUserId",
						"createdAt", "markupVersion", "snapshotTitle", "targetId", "reason"),
				ArticleHistoryRepository.INSERTABLE_COLUMNS);

		// id는 자동 증가다 — 호출자가 주더라도 삽입 문장에 들어가지 않는다(주면 원장의 순서가 조작된다).
		assertThrows(IllegalArgumentException.class, () -> history.insert(row("id", 7)));

		assertEquals(List.of("articleId", "eventType"),
				nonNullColumnsAfterInsert(row("id", 7, "articleId", "A1", "eventType", "edit")),
				"화이트리스트에서 id는 빠져 있다 — 주어진 7은 어느 컬럼에도 앉지 않는다");
		assertEquals(List.of(1L), ids(history.queryByArticle("A1")),
				"id는 자동 증가 값이지 입력값이 아니다(7이 아니다)");
	}

	// --- 2. 목록 조회 shape --------------------------------------------------------------------

	@Test
	void listRowsAreExactlyNineKeysWithNoBodyOrDistributionColumns() {
		history.insert(row("articleId", "A1", "eventType", "distribute-failed", "action", "press",
				"actorUserId", "u1", "createdAt", "c", "markupVersion", "본문",
				"snapshotTitle", "제목", "targetId", 3, "reason", "connect-failed"));

		Map<String, Object> only = history.queryByArticle("A1").get(0);

		assertEquals(LIST_ROW_KEYS, sortedKeys(only), "목록 행은 9키 고정이다");
		assertFalse(only.containsKey("markupVersion"), "목록에 본문 blob이 없다");
		assertFalse(only.containsKey("snapshotTitle"), "저장 제목 컬럼은 목록에 없다");
		assertFalse(only.containsKey("targetId"), "배부 수신처 id는 이력보기 계약에 없다");
		assertFalse(only.containsKey("reason"), "배부 실패 사유는 이력보기 계약에 없다");
	}

	@Test
	void listRowsKeepNullValuedKeys() {
		// 계약 픽스처가 못 잡는 축이다 — 키가 값에 따라 사라지면 응답 9키가 흔들린다.
		history.insert(row("articleId", "A1", "eventType", "edit"));

		Map<String, Object> only = history.queryByArticle("A1").get(0);

		assertEquals(LIST_ROW_KEYS, sortedKeys(only));
		assertNull(only.get("action"));
		assertNull(only.get("fromStatus"));
		assertNull(only.get("toStatus"));
		assertNull(only.get("actorUserId"));
		assertNull(only.get("createdAt"));
	}

	@Test
	void unknownArticleIsAnEmptyListNotAnError() {
		assertEquals(List.of(), history.queryByArticle("없는기사"));
		assertEquals(List.of(), history.queryByArticle(null), "null 스코프는 어떤 행에도 매칭되지 않는다");
	}

	// --- 3. hasSnapshot ------------------------------------------------------------------------

	@Test
	void hasSnapshotIsAnIntegerOneOrZeroNeverABoolean() {
		long withBody = history.insert(row("articleId", "A1", "eventType", "edit", "markupVersion", "본문"));
		long nullBody = history.insert(row("articleId", "A1", "eventType", "status", "toStatus", "DPS"));
		long emptyBody = history.insert(row("articleId", "A1", "eventType", "edit", "markupVersion", ""));

		Map<Long, Object> flags = new LinkedHashMap<>();
		for (Map<String, Object> row : history.queryByArticle("A1")) {
			flags.put(((Number) row.get("id")).longValue(), row.get("hasSnapshot"));
		}

		assertEquals(1, flags.get(withBody), "본문이 있으면 1");
		assertEquals(0, flags.get(nullBody), "본문이 NULL이면 0");
		assertEquals(0, flags.get(emptyBody), "본문이 빈 문자열이어도 0");
		for (Object flag : flags.values()) {
			assertTrue(flag instanceof Integer, "정수여야 한다(불리언이면 JSON이 true/false가 된다): "
					+ flag.getClass().getName());
		}
	}

	// --- 4. 정렬 ------------------------------------------------------------------------------

	@Test
	void listIsOrderedByIdDescendingEvenWhenTimestampsAreIdentical() {
		// 같은 시각 문자열 3행 — 순서 판단의 기준이 시각이 아니라 id라는 사실을 실증한다.
		long a = history.insert(row("articleId", "A1", "eventType", "edit", "createdAt", "같은시각"));
		long b = history.insert(row("articleId", "A1", "eventType", "edit", "createdAt", "같은시각"));
		long c = history.insert(row("articleId", "A1", "eventType", "edit", "createdAt", "같은시각"));

		assertEquals(List.of(c, b, a), ids(history.queryByArticle("A1")));
	}

	// --- 5. 단건 스냅샷 조회 --------------------------------------------------------------------

	@Test
	void snapshotByIdCarriesTheBodyInSevenKeys() {
		long id = history.insert(row("articleId", "A1", "eventType", "edit", "actorUserId", "u1",
				"createdAt", "2026-08-20T00:00:00.000Z", "markupVersion", "본문", "snapshotTitle", "제목"));

		Map<String, Object> item = history.querySnapshotById("A1", id);

		assertNotNull(item);
		assertEquals(SNAPSHOT_ITEM_KEYS, sortedKeys(item), "item은 7키다");
		assertEquals("본문", item.get("markupVersion"));
		assertEquals("A1", item.get("articleId"), "스코프한 articleId가 응답에도 실린다");
		assertEquals(id, ((Number) item.get("id")).longValue());
		assertFalse(item.containsKey("hasSnapshot"), "단건 조회에는 파생 플래그가 없다");
		assertFalse(item.containsKey("fromStatus"), "단건 조회에 전이 컬럼은 없다");
		assertFalse(item.containsKey("toStatus"));
		assertFalse(item.containsKey("snapshotTitle"));
		assertFalse(item.containsKey("targetId"));
		assertFalse(item.containsKey("reason"));
	}

	@Test
	void snapshotByIdAlsoReturnsTransitionRowsWithANullBody() {
		long id = history.insert(row("articleId", "A1", "eventType", "status", "action", "send",
				"fromStatus", "RDS", "toStatus", "DPS", "actorUserId", "u1", "createdAt", "c"));

		Map<String, Object> item = history.querySnapshotById("A1", id);

		assertNotNull(item, "이 라우트는 스냅샷 보유 행으로 제한되지 않는다");
		assertEquals(SNAPSHOT_ITEM_KEYS, sortedKeys(item), "같은 7키");
		assertNull(item.get("markupVersion"), "본문은 null이다");
		assertTrue(item.containsKey("markupVersion"), "값이 null이어도 키는 남는다");
	}

	@Test
	void snapshotByIdIsScopedByArticleIdSoBodiesDoNotLeakAcrossArticles() {
		long id = history.insert(row("articleId", "A1", "eventType", "edit", "markupVersion", "비밀본문"));

		assertNotNull(history.querySnapshotById("A1", id));
		assertNull(history.querySnapshotById("A2", id), "다른 기사 id로는 조회되지 않는다(권한 우회 방지)");
		assertNull(history.querySnapshotById(null, id), "스코프가 비어 있으면 매칭되지 않는다");
		assertNull(history.querySnapshotById("A1", 2147483646L), "없는 id는 '없음'이다");
	}

	// --- 6. 표시 제목 입력 조회 -----------------------------------------------------------------

	@Test
	void snapshotTitleInputsCarryTheStoredTitleOnlyForNewRows() {
		history.insert(row("articleId", "A1", "eventType", "edit",
				"markupVersion", "본문", "snapshotTitle", "제목"));

		assertEquals(List.of(Map.of("snapshotTitle", "제목")), titlePayloads("A1"),
				"저장 제목이 있으면 본문을 싣지 않는다(신규 행만 있으면 본문 0건)");
	}

	@Test
	void snapshotTitleInputsCarryTheBodyOnlyForLegacyRows() {
		history.insert(row("articleId", "A1", "eventType", "edit",
				"markupVersion", "신규본문", "snapshotTitle", "제목"));
		history.insert(row("articleId", "A1", "eventType", "edit", "markupVersion", "레거시본문"));

		// 혼재: 레거시 행(저장 제목 NULL)만 본문을 동반한다. 순서는 id DESC다.
		assertEquals(List.of(Map.of("markupVersion", "레거시본문"), Map.of("snapshotTitle", "제목")),
				titlePayloads("A1"));
	}

	@Test
	void snapshotTitleInputsSkipRowsWithoutABody() {
		// 필터는 본문 길이 > 0이다(hasSnapshot 판정과 동치) — 저장 제목 기준으로 거르면 레거시 행이 사라진다.
		history.insert(row("articleId", "A1", "eventType", "edit", "markupVersion", ""));
		history.insert(row("articleId", "A1", "eventType", "status", "toStatus", "DPS"));
		history.insert(row("articleId", "A1", "eventType", "edit", "markupVersion", "", "snapshotTitle", ""));

		assertEquals(List.of(), history.querySnapshotTitlesByArticle("A1"));
	}

	@Test
	void snapshotTitleInputRowsAreThreeKeysWithAnIntegerId() {
		long id = history.insert(row("articleId", "A1", "eventType", "edit",
				"markupVersion", "본문", "snapshotTitle", "제목"));

		Map<String, Object> only = history.querySnapshotTitlesByArticle("A1").get(0);

		assertEquals(List.of("id", "markupVersion", "snapshotTitle"), sortedKeys(only));
		assertEquals(id, ((Number) only.get("id")).longValue());
		assertNull(only.get("markupVersion"), "저장 제목이 있는 행의 본문 자리는 NULL이다");
	}

	// --- 7. 정수 컬럼(id·targetId)의 저장 표현 ---------------------------------------------------

	@Test
	void targetIdIsStoredAsAnIntegerLikeNodeDoes() {
		// 2026-08-21 실측(node:sqlite): targetId=42(JS number)는 REAL로 내려가지만 INTEGER affinity가
		// 무손실 정수로 되돌려 typeof(targetId)='integer', CAST(... AS TEXT)='42'로 저장된다.
		// TEXT affinity 컬럼(reason)에서는 같은 값이 '42.0'이 된다 — 두 컬럼의 결과가 다른 것이 정상이다.
		long id = history.insert(row("articleId", "A1", "eventType", "distribute-failed",
				"action", "press", "targetId", 42, "reason", 42));

		Map<String, Object> stored = JdbcClient.create(dataSource)
				.sql("SELECT typeof(targetId) AS targetType, CAST(targetId AS TEXT) AS targetText,"
						+ " typeof(reason) AS reasonType, reason FROM ArticleHistory WHERE id = ?")
				.param(id)
				.query()
				.singleRow();

		assertEquals("integer", stored.get("targetType"), "INTEGER 컬럼에는 정수로 앉아야 한다");
		assertEquals("42", stored.get("targetText"), "'42.0'이면 수신처 매칭이 조용히 깨진다");
		assertEquals("text", stored.get("reasonType"));
		assertEquals("42.0", stored.get("reason"), "TEXT affinity 컬럼은 node:sqlite와 같은 REAL 표현이다");

		// 정수로 저장됐으므로 정수 조건으로 매칭된다.
		assertEquals(1, JdbcClient.create(dataSource)
				.sql("SELECT count(*) FROM ArticleHistory WHERE targetId = ?")
				.param(42)
				.query(Integer.class)
				.single());
	}

	@Test
	void booleansAndStructuredValuesAreRejected() {
		// Node의 node:sqlite가 TypeError를 던져 500이 되는 입력이다 — 조용한 문자열화는 패리티를 깬다.
		assertThrows(IllegalArgumentException.class,
				() -> history.insert(row("articleId", "A1", "markupVersion", Boolean.TRUE)));
		assertThrows(IllegalArgumentException.class,
				() -> history.insert(row("articleId", "A1", "reason", List.of("a"))));
		assertThrows(IllegalArgumentException.class,
				() -> history.insert(row("articleId", "A1", "reason", Map.of("a", "b"))));
	}

	// --- 8. 배부 이벤트 조회 2종 ----------------------------------------------------------------

	@Test
	void distributionEventsCarryOnlyTheTwoLedgerVocabularyRows() {
		long failed = history.insert(row("articleId", "A1", "eventType", "distribute-failed",
				"action", "press", "targetId", 3, "reason", "spool-write-failed",
				"actorUserId", "z1", "createdAt", "c1"));
		long retry = history.insert(row("articleId", "A1", "eventType", "distribute-retry",
				"action", "press", "targetId", 3, "actorUserId", "z1", "createdAt", "c2"));
		history.insert(row("articleId", "A1", "eventType", "distribute", "action", "press", "createdAt", "c3"));
		history.insert(row("articleId", "A1", "eventType", "status", "action", "send", "toStatus", "DPS"));
		history.insert(row("articleId", "A1", "eventType", "edit", "markupVersion", "본문"));
		history.insert(row("articleId", "A1", "eventType", "create", "createdAt", "c4"));

		assertEquals(List.of(retry, failed), ids(history.queryDistributionEvents("A1", null)),
				"어휘는 distribute-failed·distribute-retry 둘뿐이다 — 배부 성공(distribute) 행도 아니다");
	}

	@Test
	void distributionEventRowsAreExactlyEightKeysInColumnOrder() {
		long id = history.insert(row("articleId", "A1", "eventType", "distribute-failed",
				"action", "press", "fromStatus", "DPS", "toStatus", "DPS",
				"targetId", 3, "reason", "spool-write-failed", "actorUserId", "z1",
				"createdAt", "2026-08-25T00:00:00.000Z", "markupVersion", "본문", "snapshotTitle", "제목"));

		Map<String, Object> only = history.queryDistributionEvents(null, null).get(0);

		assertEquals(DISTRIBUTION_EVENT_KEYS, sortedKeys(only), "배부 이벤트 행은 8키 고정이다");
		assertEquals(DISTRIBUTION_EVENT_KEY_ORDER, List.copyOf(only.keySet()), "키 순서는 컬럼 목록 순서다");
		assertEquals(id, ((Number) only.get("id")).longValue());
		assertFalse(only.containsKey("markupVersion"), "본문 blob은 이 경로로 나가지 않는다");
		assertFalse(only.containsKey("snapshotTitle"));
		assertFalse(only.containsKey("hasSnapshot"), "파생 플래그는 목록 조회 전용이다");
		assertFalse(only.containsKey("fromStatus"), "전이 컬럼은 배부 이벤트 조회에 없다");
		assertFalse(only.containsKey("toStatus"));
		assertEquals(DISTRIBUTION_EVENT_KEY_ORDER,
				List.copyOf(history.getDistributionEventById(id).keySet()),
				"단건 조회도 같은 8키·같은 순서다");
	}

	@Test
	void distributionEventsAreWindowedByIdDescendingWithNodesDefaultOf500() {
		// Node 실측(2026-08-25): DISTRIBUTION_EVENTS_DEFAULT_LIMIT = 500이고 정수 ≥1이 아닌 값은 전부 그 기본값이다.
		seedDistributionFailures(501);

		List<Long> byDefault = ids(history.queryDistributionEvents(null, null));

		assertEquals(500, byDefault.size(), "기본 창은 500이다");
		assertEquals(501L, byDefault.get(0), "최신(id 최대)이 맨 위다 — ORDER BY id DESC");
		assertEquals(2L, byDefault.get(499), "가장 오래된 1행이 창 밖으로 밀린다");
		assertFalse(byDefault.contains(1L));

		assertEquals(byDefault, ids(history.queryDistributionEvents(null, 0)), "0은 창이 아니라 기본값이다");
		assertEquals(byDefault, ids(history.queryDistributionEvents(null, -1)), "음수도 기본값이다");
		assertEquals(List.of(501L, 500L, 499L), ids(history.queryDistributionEvents(null, 3)),
				"창은 최신부터 채운다");
		assertEquals(1, history.queryDistributionEvents(null, 1).size());
		assertEquals(501, history.queryDistributionEvents(null, 1000).size(),
				"창이 행 수보다 크면 전부 나온다 — 모델은 서비스 클램프(1000)를 알지 못한다");
	}

	@Test
	void distributionEventsAreScopedByArticleIdOnlyWhenOneIsGiven() {
		long a1 = history.insert(row("articleId", "A1", "eventType", "distribute-failed", "createdAt", "c1"));
		long a2 = history.insert(row("articleId", "A2", "eventType", "distribute-failed", "createdAt", "c2"));

		assertEquals(List.of(a1), ids(history.queryDistributionEvents("A1", null)));
		assertEquals(List.of(a2), ids(history.queryDistributionEvents("A2", null)));
		assertEquals(List.of(a2, a1), ids(history.queryDistributionEvents(null, null)),
				"스코프를 주지 않으면 전 기사다(Node의 articleId 미지정과 동형)");
		assertEquals(List.of(), history.queryDistributionEvents("없는기사", null));
	}

	@Test
	void distributionEventByIdIsFilteredByTheLedgerVocabulary() {
		long failed = history.insert(row("articleId", "A1", "eventType", "distribute-failed",
				"action", "press", "targetId", 3, "reason", "invalid-spool-dir", "createdAt", "c1"));
		long status = history.insert(row("articleId", "A1", "eventType", "status", "action", "send",
				"fromStatus", "RDS", "toStatus", "DPS", "createdAt", "c2"));
		long snapshot = history.insert(row("articleId", "A1", "eventType", "edit", "markupVersion", "비밀본문"));

		Map<String, Object> event = history.getDistributionEventById(failed);
		assertNotNull(event);
		assertEquals(DISTRIBUTION_EVENT_KEYS, sortedKeys(event));
		assertEquals("invalid-spool-dir", event.get("reason"));

		assertNull(history.getDistributionEventById(status),
				"배부 이벤트가 아닌 id는 '없음'이다 — 재전송 게이트의 1차 방어");
		assertNull(history.getDistributionEventById(snapshot),
				"임의 id로 본문 스냅샷 행이 이 경로로 새면 안 된다");
		assertNull(history.getDistributionEventById(2147483646L), "없는 id는 '없음'이다");
	}

	@Test
	void distributionEventTargetIdRoundTripsComparableWithDistributionTargetIds() {
		// 이 축은 계약이 절대 보지 못한다: targetId가 "3"이나 3.0으로 돌아오면 수신처 매칭이 조용히 깨진다.
		DistributionTargetRepository targets = new DistributionTargetRepository(JdbcClient.create(dataSource));
		int targetId = targets.insert(Map.of("name", "조판", "kind", "press",
				"spoolDir", "press-a", "active", "Y", "createdAt", "c0"));
		long id = history.insert(row("articleId", "A1", "eventType", "distribute-failed",
				"action", "press", "targetId", targetId, "reason", "spool-write-failed", "createdAt", "c1"));

		Object stored = history.getDistributionEventById(id).get("targetId");
		Object targetRowId = targets.query(Map.of()).get(0).get("id");

		assertEquals(targetRowId, stored,
				"수신처 행의 id와 같은 표현이어야 한다(문자열·실수면 equals가 그 자리에서 깨진다)");
		assertEquals(Long.valueOf(targetId), stored, "정수(Long)로 돌아온다");
		assertEquals(stored, history.queryDistributionEvents(null, null).get(0).get("targetId"),
				"목록 조회와 단건 조회의 표현이 같다");
	}

	@Test
	void distributionEventNullColumnsKeepTheirKeys() {
		// kind 단위 실패는 targetId를 갖지 않고, 레거시·수기 행은 reason이 비어 있을 수 있다.
		long id = history.insert(row("articleId", "A1", "eventType", "distribute-failed", "createdAt", "c1"));

		Map<String, Object> only = history.queryDistributionEvents(null, null).get(0);

		assertEquals(DISTRIBUTION_EVENT_KEYS, sortedKeys(only), "값이 NULL이어도 8키는 그대로다");
		assertTrue(only.containsKey("targetId"));
		assertNull(only.get("targetId"), "정수 컬럼의 NULL은 0이 아니라 null이다");
		assertNull(only.get("reason"));
		assertNull(only.get("action"));
		assertNull(only.get("actorUserId"));
		assertEquals(DISTRIBUTION_EVENT_KEYS, sortedKeys(history.getDistributionEventById(id)));
		assertNull(history.getDistributionEventById(id).get("targetId"));
	}

	@Test
	void nonAsciiReasonsSurviveTheRoundTrip() {
		// 실제 사유는 고정 ASCII 토큰이지만 인코딩 경로를 함께 덮는다(방어적).
		long id = history.insert(row("articleId", "기사-가", "eventType", "distribute-failed",
				"reason", "실패 사유", "createdAt", "c1"));

		assertEquals("실패 사유", history.getDistributionEventById(id).get("reason"));
		assertEquals("기사-가", history.queryDistributionEvents("기사-가", null).get(0).get("articleId"));
	}

	@Test
	void theOpenHistoryListStillCarriesNoDistributionColumns() {
		// 회귀 잠금: 배부 조회가 생겼다고 해서 전 사용자에게 열린 이력보기 계약이 넓어지면 안 된다.
		history.insert(row("articleId", "A1", "eventType", "distribute-failed", "action", "press",
				"targetId", 3, "reason", "spool-write-failed", "createdAt", "c1"));

		Map<String, Object> listed = history.queryByArticle("A1").get(0);

		assertEquals(LIST_ROW_KEYS, sortedKeys(listed), "목록은 여전히 9키다");
		assertFalse(listed.containsKey("targetId"));
		assertFalse(listed.containsKey("reason"));
	}

	// --- 9. append-only: 갱신·삭제 표면이 없다 ---------------------------------------------------

	@Test
	void theRepositoryExposesInsertAndReadsOnly() {
		List<String> operations = new ArrayList<>();
		for (Method method : ArticleHistoryRepository.class.getDeclaredMethods()) {
			if (Modifier.isPublic(method.getModifiers()) && !method.isSynthetic()) {
				operations.add(method.getName());
			}
		}
		operations.sort(String::compareTo);

		assertEquals(
				List.of("getDistributionEventById", "insert", "queryByArticle", "queryDistributionEvents",
						"querySnapshotById", "querySnapshotTitlesByArticle"),
				operations,
				"append-only 원장이다 — 갱신·삭제 연산을 추가하면 이 단언이 먼저 깨진다");
	}

	@Test
	void everyInsertAddsOneRowAndNothingEverRemovesOne() {
		for (int i = 0; i < 5; i++) {
			history.insert(row("articleId", "A1", "eventType", "edit", "markupVersion", "본문" + i));
		}
		history.insert(row("articleId", "A2", "eventType", "status", "toStatus", "DPS"));

		assertEquals(5, history.queryByArticle("A1").size());
		assertEquals(6, totalRows(), "삽입 횟수와 행 수가 같다 — 어떤 조회도 행을 줄이지 않는다");

		// 모든 조회 경로를 한 번씩 지나고도 행 수는 그대로다.
		history.querySnapshotById("A1", ids(history.queryByArticle("A1")).get(0));
		history.querySnapshotTitlesByArticle("A1");
		history.queryDistributionEvents(null, null);
		history.queryDistributionEvents("A1", 1);
		history.getDistributionEventById(1L);
		assertEquals(6, totalRows());
	}

	// --- 도우미 -------------------------------------------------------------------------------

	private int totalRows() {
		return JdbcClient.create(dataSource)
				.sql("SELECT count(*) FROM ArticleHistory")
				.query(Integer.class)
				.single();
	}

	/**
	 * 배부 실패 행 {@code count}개를 <b>한 문장으로</b> 시드한다 — 기본 창(500) 경계를 넘기려면 행이
	 * 501개 필요한데 한 건씩 넣으면 삽입마다 fsync가 걸린다. 리포지토리 삽입 경로는 다른 테스트가
	 * 이미 덮으므로 여기서는 행이 존재하기만 하면 된다. id는 1..count로 순서대로 매겨진다.
	 */
	private void seedDistributionFailures(int count) {
		JdbcClient.create(dataSource)
				.sql("WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM seq WHERE n < " + count + ")"
						+ " INSERT INTO ArticleHistory (articleId, eventType, action, createdAt)"
						+ " SELECT 'A1', 'distribute-failed', 'press', 'c' || n FROM seq")
				.update();
	}

	/** 삽입 뒤 값이 남아 있는 컬럼(id 제외) — 어떤 컬럼이 실제로 채워졌는지를 저장 결과로 확인한다. */
	private List<String> nonNullColumnsAfterInsert(Map<String, Object> record) {
		long id = history.insert(record);
		List<String> written = new ArrayList<>();
		Map<String, Object> stored = JdbcClient.create(dataSource)
				.sql("SELECT " + String.join(", ", RequiredSchema.HISTORY_COLUMNS)
						+ " FROM ArticleHistory WHERE id = ?")
				.param(id)
				.query()
				.singleRow();
		for (String column : RequiredSchema.HISTORY_COLUMNS) {
			if (!column.equals("id") && stored.get(column) != null) {
				written.add(column);
			}
		}
		return written;
	}

	/** 표시 제목 입력 행에서 값이 있는 키만 남긴다(id는 값이 매번 달라 비교에서 뺀다). */
	private List<Map<String, Object>> titlePayloads(String articleId) {
		List<Map<String, Object>> out = new ArrayList<>();
		for (Map<String, Object> row : history.querySnapshotTitlesByArticle(articleId)) {
			Map<String, Object> payload = new LinkedHashMap<>();
			for (Map.Entry<String, Object> entry : row.entrySet()) {
				if (!entry.getKey().equals("id") && entry.getValue() != null) {
					payload.put(entry.getKey(), entry.getValue());
				}
			}
			out.add(payload);
		}
		return out;
	}

	private static List<Long> ids(List<Map<String, Object>> rows) {
		List<Long> out = new ArrayList<>();
		for (Map<String, Object> row : rows) {
			out.add(((Number) row.get("id")).longValue());
		}
		return out;
	}

	private static List<String> sortedKeys(Map<String, Object> row) {
		return List.copyOf(new TreeSet<>(row.keySet()));
	}

	private static Map<String, Object> row(Object... keyValues) {
		Map<String, Object> map = new LinkedHashMap<>();
		for (int i = 0; i < keyValues.length; i += 2) {
			map.put((String) keyValues[i], keyValues[i + 1]);
		}
		return map;
	}
}
