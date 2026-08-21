package harness.news.service;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.zaxxer.hikari.HikariDataSource;
import harness.news.db.NewsDataSource;
import harness.news.model.ArticleAggregate;
import harness.news.model.ArticleHistoryRepository;
import harness.news.model.ArticleRepository;
import harness.news.model.ContentsRow;
import harness.news.testsupport.TempNewsDb;
import java.lang.reflect.Method;
import java.lang.reflect.Modifier;
import java.lang.reflect.ParameterizedType;
import java.lang.reflect.Type;
import java.lang.reflect.WildcardType;
import java.nio.file.Path;
import java.time.Clock;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.jdbc.support.JdbcTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

/**
 * 기사 읽기 서비스 — 리포 루트 {@code src/services/articleService.js}의 읽기 5경로
 * ({@code getById}·{@code query}·{@code search}·{@code queryHistory}·{@code getHistorySnapshot})와 1:1인
 * 동작 계약. HTTP는 없다(@TempDir 임시 DB + 실제 리포지토리).
 *
 * <p><b>이 서비스는 응답으로 나가는 행을 만드는 유일한 지점이다.</b> 그래서 여기서 잠그는 것은 값만이
 * 아니라 <b>무엇이 밖으로 나갈 수 있는가</b>이기도 하다.
 * <ol>
 *   <li><b>투영 단일 지점</b> — 잠금을 실제로 보유한(컬럼에 세션 토큰 원문이 든) 행에서 관측한다.
 *       투영을 빼면 그 토큰이 그대로 실린다(공허하지 않은 단언).</li>
 *   <li><b>NULL 키 보존</b> — 값이 SQL NULL이어도 27키는 흔들리지 않는다. 계약 픽스처가 못 잡는
 *       축이라(step0 발견) Java 테스트가 유일한 방어선이다.</li>
 *   <li><b>표시 파생은 송고 필터 <i>전에</i></b> 전체 이력 기준으로 계산한다 — 승계 규칙이 필터로 잘린
 *       행에 의존한다.</li>
 *   <li><b>불필요한 blob 읽기 금지</b> — v1 본문 조회는 '이력 1건 이상 + 스냅샷 0건'일 때만 일어난다
 *       (호출 횟수 스파이로 실증).</li>
 *   <li><b>읽기는 DB를 바꾸지 않는다</b>(조회 카운터·최근 열람 갱신 등 부수효과 0).</li>
 * </ol>
 *
 * <p>기대값의 출처는 계획서가 아니라 <b>Node 정본 실측</b>이다(리포 밖 임시 DB에 스키마를 세우고
 * {@code createArticleService}의 읽기 경로를 직접 관측했다 — 2026-08-21).
 */
class ArticleReadServiceTest {

	/** Contents 29컬럼 − 투영 2컬럼 = 27키(정렬). {@code articles-read.contract.js}의 상수와 같은 문자열. */
	private static final String CONTENTS_PUBLIC_KEYS =
			"articleId,attachmentFile,attribute,author,category,coAuthor,content,createdAt,"
			+ "department,departmentCode,distributedAt,editedAt,embargoAt,externalComment,internalComment,"
			+ "keyword,lockYN,lockedAt,lockerUserId,modifier,referenceFile,region,secondEmbargoAt,sender,"
			+ "sentAt,status,title";

	/** 검색 결과는 {@code Article} 행 5키다(목록의 Contents 행과 동형이 아니다 — 본문이 실린다). */
	private static final String ARTICLE_ROW_KEYS = "articleId,content,markupVersion,modifier,title";

	/** 이력 목록 행 = 리포지토리 9키 + 표시 파생 3키(title·version·status). 본문·저장 제목은 없다. */
	private static final String HISTORY_ROW_KEYS =
			"action,actorUserId,articleId,createdAt,eventType,fromStatus,hasSnapshot,id,status,title,"
			+ "toStatus,version";

	/** 단건 스냅샷 항목 7키(전이 컬럼 없음, 본문 있음). */
	private static final String SNAPSHOT_ITEM_KEYS =
			"action,actorUserId,articleId,createdAt,eventType,id,markupVersion";

	/** 잠금 컬럼에 실제로 들어가는 세션 토큰 원문 — 응답 어디에도 등장하면 안 된다. */
	private static final String SESSION_TOKEN = "SECRET-SESSION-TOKEN";

	private static final String EDIT_BODY = "{\"format\":\"yh-editor\",\"version\":1,\"blocks\":"
			+ "[{\"type\":\"text\",\"text\":\"편집제목\"},{\"type\":\"text\",\"text\":\"(끝)\"}]}";

	private static final Instant FIXED = Instant.parse("2026-08-20T12:34:56.789Z");

	@TempDir
	Path tempDir;

	private HikariDataSource dataSource;

	private JdbcClient client;

	private ArticleRepository articles;

	private ArticleHistoryRepository history;

	private ArticleReadService service;

	@BeforeEach
	void setUp() {
		TempNewsDb.seed(tempDir);
		dataSource = NewsDataSource.create(tempDir);
		client = JdbcClient.create(dataSource);
		articles = new ArticleRepository(client, transactions(), Clock.fixed(FIXED, ZoneOffset.UTC));
		history = new ArticleHistoryRepository(client);
		service = new ArticleReadService(articles, history);
	}

	@AfterEach
	void tearDown() {
		if (dataSource != null) {
			dataSource.close();
		}
	}

	private TransactionTemplate transactions() {
		return new TransactionTemplate(new JdbcTransactionManager(dataSource));
	}

	// --- 1. 단건 조회: 투영 -------------------------------------------------------------------

	@Test
	void getByIdProjectsTheContentsRowToTwentySevenKeysWithoutTheLockerSecrets() {
		givenLockedArticle("A1");

		Map<String, Object> found = service.getById("A1");

		assertNotNull(found);
		assertEquals("article,contents", keysOf(found), "두 행이 다 있으면 두 키가 다 실린다");
		Map<String, Object> contents = contentsOf(found);
		assertEquals(27, contents.size(), "투영 후 Contents는 27키다");
		assertEquals(CONTENTS_PUBLIC_KEYS, keysOf(contents), "키 집합이 계약과 같다");
		assertFalse(contents.containsKey("lockerSessionId"), "세션 토큰 컬럼은 응답에 없다");
		assertFalse(contents.containsKey("lockerClientId"), "편집 탭 식별자는 응답에 없다");
		assertFalse(String.valueOf(found).contains(SESSION_TOKEN), "직렬화 대상 어디에도 토큰 원문이 없다");

		// 잠금 표시 3컬럼은 UI 계약이라 남는다(빼면 목록이 잠금 상태를 잃는다).
		assertEquals("Y", contents.get("lockYN"));
		assertEquals("desk1", contents.get("lockerUserId"));
		assertEquals("2026-08-20T00:10:00.000Z", contents.get("lockedAt"));
		assertEquals(ARTICLE_ROW_KEYS, keysOf(articleOf(found)), "Article 행은 5키 그대로다");

		// NULL 키 보존 — 값이 없어도 키는 남는다(계약 픽스처가 못 잡는 축).
		assertTrue(contents.containsKey("sentAt"), "값이 SQL NULL인 컬럼도 키는 있다");
		assertNull(contents.get("sentAt"));

		// 내부 판정 경로는 원본을 쓴다 — 투영은 사본을 만들 뿐 DB·원본 행을 건드리지 않는다.
		ArticleAggregate raw = articles.findById("A1");
		assertEquals(SESSION_TOKEN, raw.contents().column("lockerSessionId"),
				"재로그인 takeover 판정이 읽어야 할 원본 값은 그대로다");
	}

	// --- 2. 단건 조회: '없음'과 한쪽 행만 있는 경우 ------------------------------------------------

	@Test
	void getByIdIsAbsentForAnUnknownIdAndCarriesOnlyTheSideThatExists() {
		givenLockedArticle("A1");
		articles.insert(row("articleId", "ONLY-ART", "title", "본문만", "markupVersion", "x"), null);
		articles.insert(null, row("articleId", "ONLY-CON", "title", "목록만", "status", "RDS"));

		assertNull(service.getById("NOPE"), "없는 id는 '없음'이다(HTTP가 404로 바꾼다)");
		assertNull(service.getById(null), "id가 없어도 예외가 아니라 '없음'이다");

		// 한쪽 테이블 행이 없으면 그 키를 아예 싣지 않는다(키 없음 ≠ null — decisions (20)①).
		Map<String, Object> onlyArticle = service.getById("ONLY-ART");
		assertEquals("article", keysOf(onlyArticle), "Contents 행이 없으면 contents 키가 없다");
		Map<String, Object> onlyContents = service.getById("ONLY-CON");
		assertEquals("contents", keysOf(onlyContents), "Article 행이 없으면 article 키가 없다");
		assertEquals(CONTENTS_PUBLIC_KEYS, keysOf(contentsOf(onlyContents)), "그 한쪽도 투영을 거친다");
	}

	// --- 3. 목록 ---------------------------------------------------------------------------

	@Test
	void queryProjectsEveryRowAndCarriesNoTotalOrPagingFields() {
		givenLockedArticle("A1");
		givenLockedArticle("A2");

		List<Map<String, Object>> items = service.query(Map.of());

		assertEquals(2, items.size(), "잠긴 행 2건 — 한 행만 투영되는 구현을 잡기 위한 최소 표본");
		for (Map<String, Object> item : items) {
			assertEquals(CONTENTS_PUBLIC_KEYS, keysOf(item), "모든 행이 투영을 거친다");
			assertFalse(item.containsKey("lockerSessionId"));
			assertFalse(item.containsKey("lockerClientId"));
		}
		assertFalse(String.valueOf(items).contains(SESSION_TOKEN), "목록 어디에도 토큰 원문이 없다");
		// 총수·페이징은 '없음'이 계약이다 — 결과는 행 배열 그 자체다.
		for (String paging : List.of("total", "count", "page", "pageSize", "hasNext")) {
			assertFalse(items.get(0).containsKey(paging), paging + " 키는 계약에 없다");
		}
	}

	@Test
	void queryPassesTheRawValueListsThroughWithoutReinterpretingThem() {
		givenLockedArticle("A1");
		givenLockedArticle("A2");

		// 콤마는 문법이 아니다 — 값이 하나인 문자열이라 매칭 0건인 것이 계약이다(decisions (10)).
		assertEquals(0, service.query(Map.of("status", List.of("RDS,DDH"))).size());
		assertEquals(2, service.query(Map.of("status", List.of("RDS"))).size());
	}

	// --- 4. 검색 ---------------------------------------------------------------------------

	@Test
	void searchRowsAreTheFiveArticleKeys() {
		givenLockedArticle("A1");

		List<Map<String, Object>> items = service.search("제목");

		assertEquals(1, items.size());
		assertEquals(ARTICLE_ROW_KEYS, keysOf(items.get(0)), "검색 행은 Article 5키다");
		assertEquals(1, service.search(null).size(), "질의가 없으면 빈 문자열 검색이다(전 행 매칭)");
	}

	@Test
	void searchRefusesToShipARowThatCarriesALockerSecret() {
		// 투영을 우회하는 읽기 경로가 없다는 사실의 안전망. Article 행에는 잠금 컬럼이 없어 정상 경로에서는
		// 도달하지 않지만, 스키마가 넓어져 도달하는 순간 조용한 200이 아니라 실패로 드러나야 한다.
		ArticleReadService leaking = new ArticleReadService(new LeakingSearchRepository(client, transactions()),
				history);

		assertThrows(IllegalStateException.class, () -> leaking.search("x"));
	}

	// --- 5. 이력 목록: 빈 결과 ------------------------------------------------------------------

	@Test
	void historyIsAnEmptyListForAFreshArticleAndForAnUnknownArticle() {
		givenLockedArticle("A1");

		assertEquals(List.of(), service.queryHistory("A1", false), "이력 0건은 빈 배열이다");
		assertEquals(List.of(), service.queryHistory("NO-SUCH-ARTICLE", false),
				"존재하지 않는 기사도 예외가 아니라 빈 배열이다(404가 아니다)");
		assertEquals(List.of(), service.queryHistory(null, false));
	}

	// --- 6. 이력 목록: 12키와 표시 파생 --------------------------------------------------------

	@Test
	void historyRowsCarryTwelveKeysAndTheDerivedDisplayValues() {
		givenLockedArticle("A1");
		long editId = givenEditHistory("A1");
		long sendId = givenSendHistory("A1");

		List<Map<String, Object>> items = service.queryHistory("A1", false);

		assertEquals(List.of(sendId, editId), idsOf(items), "최신이 위(id 내림차순)");
		for (Map<String, Object> item : items) {
			assertEquals(HISTORY_ROW_KEYS, keysOf(item), "이력 행은 12키 고정");
			assertFalse(item.containsKey("markupVersion"), "목록에 본문 blob이 없다");
			assertFalse(item.containsKey("snapshotTitle"), "저장 컬럼명은 응답에 없다 — 파생 키는 title");
		}

		Map<String, Object> edit = itemById(items, editId);
		Map<String, Object> send = itemById(items, sendId);
		assertEquals(1, edit.get("hasSnapshot"), "hasSnapshot은 불리언이 아니라 정수 1");
		assertEquals(0, send.get("hasSnapshot"), "전이 행은 스냅샷 0");
		assertNull(edit.get("action"), "edit 행의 action은 null");
		assertNull(edit.get("toStatus"), "edit 행은 전이가 아니다");
		assertEquals("RDS", send.get("fromStatus"));
		assertEquals("DPS", send.get("toStatus"));
		assertEquals("편집제목", edit.get("title"), "파생 title은 저장된 스냅샷 제목이다");
		assertEquals(2, edit.get("version"), "최초 저장 본문이 v1이라 첫 편집 스냅샷은 v2");
		assertEquals(2, send.get("version"), "전이 행은 버전을 올리지 않는다");
		assertEquals("RDS", edit.get("status"), "전이 이전 구간은 첫 전이의 fromStatus로 역승계된다");
		assertEquals("DPS", send.get("status"), "전이 행의 상태는 toStatus");
		assertEquals("편집제목", send.get("title"), "제목은 뒤 행으로 승계된다");
	}

	// --- 7. 송고 필터 ----------------------------------------------------------------------

	@Test
	void sendOnlyKeepsOnlyStatusSendRowsAndTheDerivationRanBeforeTheFilter() {
		givenLockedArticle("A1");
		long editId = givenEditHistory("A1");
		long sendId = givenSendHistory("A1");
		int unfilteredVersion = (int) itemById(service.queryHistory("A1", false), sendId).get("version");

		List<Map<String, Object>> items = service.queryHistory("A1", true);

		assertEquals(List.of(sendId), idsOf(items), "status/send 행만 남는다");
		assertFalse(idsOf(items).contains(editId));
		assertEquals("status", items.get(0).get("eventType"));
		assertEquals("send", items.get(0).get("action"));
		// 필터를 파생보다 먼저 적용하면 잘린 edit 스냅샷 행이 버전 증가에 기여하지 못해 1이 된다.
		assertEquals(2, items.get(0).get("version"), "표시 파생은 필터 전 전체 이력 기준이다");
		assertEquals(unfilteredVersion, items.get(0).get("version"), "필터 여부가 version을 바꾸지 않는다");
		assertEquals(HISTORY_ROW_KEYS, keysOf(items.get(0)), "필터가 shape을 바꾸지 않는다");
	}

	// --- 8. 표시 제목 조회 실패(가드 호출) ------------------------------------------------------

	@Test
	void aFailingTitleLookupStillReturnsTheListWithEmptyTitles() {
		givenLockedArticle("A1");
		long editId = givenEditHistory("A1");
		long sendId = givenSendHistory("A1");
		FailingTitleLookupRepository failing = new FailingTitleLookupRepository(client);
		ArticleReadService degraded = new ArticleReadService(articles, failing);

		List<Map<String, Object>> items = degraded.queryHistory("A1", false);

		assertEquals(List.of(sendId, editId), idsOf(items), "제목 조회가 죽어도 이력보기는 살아 있다");
		for (Map<String, Object> item : items) {
			assertEquals(HISTORY_ROW_KEYS, keysOf(item), "shape은 그대로다");
			assertEquals("", item.get("title"), "제목만 빈다");
		}
		assertEquals(2, itemById(items, editId).get("version"), "버전은 정확하다");
		assertEquals("RDS", itemById(items, editId).get("status"), "상태도 정확하다");
		assertEquals("DPS", itemById(items, sendId).get("status"));
		// 2차 폴백 금지 — 장애 시 본문 전량 읽기가 되살아나는 경로를 만들지 않는다.
		assertEquals(0, failing.snapshotByIdCalls, "실패해도 스냅샷 본문을 다시 긁지 않는다");
	}

	// --- 9. v1 본문 예외(불필요한 blob 읽기 금지) ------------------------------------------------

	@Test
	void theCurrentBodyIsReadOnlyWhenHistoryExistsWithoutAnySnapshot() {
		givenLockedArticle("A1");
		givenLockedArticle("A2");
		CountingArticleRepository counting = new CountingArticleRepository(client, transactions());
		ArticleReadService counted = new ArticleReadService(counting, history);

		// (a) 이력 0건 — 조회할 이유가 없다.
		counted.queryHistory("A2", false);
		assertEquals(0, counting.findByIdCalls, "이력이 없으면 본문을 읽지 않는다");

		// (b) 이력 1건 + 스냅샷 0건 — 이때만 현재 본문이 v1 본문이다.
		long sendId = givenSendHistory("A2");
		counting.findByIdCalls = 0;
		List<Map<String, Object>> v1 = counted.queryHistory("A2", false);
		assertEquals(1, counting.findByIdCalls, "스냅샷이 0건일 때만 현재 본문을 읽는다");
		assertEquals("현재본문", itemById(v1, sendId).get("title"), "v1 제목은 현재 본문에서 파생된다");
		assertEquals(1, itemById(v1, sendId).get("version"), "스냅샷이 없으면 버전은 1이다");

		// (c) 스냅샷이 있으면 조회하지 않는다 — 불필요한 blob 읽기 금지.
		givenEditHistory("A2");
		counting.findByIdCalls = 0;
		counted.queryHistory("A2", false);
		assertEquals(0, counting.findByIdCalls, "스냅샷이 있으면 본문 조회가 일어나지 않는다");
	}

	// --- 10. 단건 스냅샷 -------------------------------------------------------------------

	@Test
	void snapshotIsFoundForTransitionRowsTooAndIsScopedToTheArticle() {
		givenLockedArticle("A1");
		givenLockedArticle("A2");
		long editId = givenEditHistory("A1");
		long sendId = givenSendHistory("A1");

		ArticleReadService.SnapshotResult edit = service.getHistorySnapshot("A1", editId);
		assertTrue(edit.ok());
		assertNull(edit.reason());
		assertEquals(SNAPSHOT_ITEM_KEYS, keysOf(edit.item()), "item은 7키(본문 포함, 전이 컬럼 없음)");
		assertEquals(EDIT_BODY, edit.item().get("markupVersion"), "저장한 본문이 그대로 돌아온다");

		// 스냅샷이 없는 전이 행도 '없음'이 아니다 — 본문만 null이다.
		ArticleReadService.SnapshotResult transition = service.getHistorySnapshot("A1", sendId);
		assertTrue(transition.ok());
		assertEquals(SNAPSHOT_ITEM_KEYS, keysOf(transition.item()), "같은 7키");
		assertNull(transition.item().get("markupVersion"), "본문은 null");

		// 타 기사 스코프·미존재 id는 사유 토큰 not-found다(HTTP가 404로 바꾼다).
		assertNotFound(service.getHistorySnapshot("A2", editId));
		assertNotFound(service.getHistorySnapshot("A1", 2147483646L));
		assertNotFound(service.getHistorySnapshot(null, editId));
	}

	// --- 11. 타입 경계(decisions (4)①) --------------------------------------------------------

	@Test
	void thePublicSurfaceNeverMentionsTheRawContentsRowType() {
		// 컨트롤러가 손에 넣을 수 있는 것은 이 서비스의 공개 시그니처가 허용하는 것뿐이다. 원본 행 타입이
		// 여기 등장하면 '투영을 거치지 않은 값'이 응답 조립까지 갈 수 있다는 뜻이다(이름 스캔은 이 벡터를
		// 놓친다 — 우회 코드에는 컬럼명 문자열이 등장하지 않는다).
		List<Class<?>> surface = new ArrayList<>();
		surface.add(ArticleReadService.class);
		for (Class<?> nested : ArticleReadService.class.getDeclaredClasses()) {
			if (Modifier.isPublic(nested.getModifiers())) {
				surface.add(nested);
			}
		}
		for (Class<?> type : surface) {
			for (Method method : type.getDeclaredMethods()) {
				if (!Modifier.isPublic(method.getModifiers())) {
					continue;
				}
				assertFalse(mentionsRawRow(method.getGenericReturnType()),
						type.getSimpleName() + "." + method.getName() + ": 반환 타입에 원본 행 타입이 있다");
				for (Type parameter : method.getGenericParameterTypes()) {
					assertFalse(mentionsRawRow(parameter),
							type.getSimpleName() + "." + method.getName() + ": 파라미터에 원본 행 타입이 있다");
				}
			}
		}
	}

	// --- 12. 읽기 전용 -----------------------------------------------------------------------

	@Test
	void readingNeverChangesTheDatabase() {
		givenLockedArticle("A1");
		long editId = givenEditHistory("A1");
		String before = snapshotOfDb();

		service.getById("A1");
		service.query(Map.of());
		service.search("");
		service.queryHistory("A1", false);
		service.queryHistory("A1", true);
		service.getHistorySnapshot("A1", editId);

		assertEquals(before, snapshotOfDb(), "읽기 경로는 행 수도 잠금 컬럼도 바꾸지 않는다");
	}

	// --- 픽스처 ----------------------------------------------------------------------------

	/** 잠금을 실제로 보유한 기사 1건 — 컬럼에 세션 토큰 원문이 들어간다(투영 단언이 공허하지 않게). */
	private void givenLockedArticle(String articleId) {
		articles.insert(
				row("articleId", articleId, "title", "제목" + articleId, "content", "요약",
						"markupVersion", "현재본문", "modifier", "u1"),
				row("articleId", articleId, "title", "제목" + articleId, "author", "김기자",
						"status", "RDS", "department", "사회부", "createdAt", "2026-08-20T00:00:00.000Z"));
		articles.setLock(articleId, new ArticleRepository.EditLock("desk1", SESSION_TOKEN, "tab-1",
				"2026-08-20T00:10:00.000Z"));
	}

	private long givenEditHistory(String articleId) {
		return history.insert(row("articleId", articleId, "eventType", "edit", "actorUserId", "u1",
				"createdAt", "2026-08-20T01:00:00.000Z", "markupVersion", EDIT_BODY,
				"snapshotTitle", "편집제목"));
	}

	private long givenSendHistory(String articleId) {
		return history.insert(row("articleId", articleId, "eventType", "status", "action", "send",
				"fromStatus", "RDS", "toStatus", "DPS", "actorUserId", "u1",
				"createdAt", "2026-08-20T02:00:00.000Z"));
	}

	// --- 헬퍼 -----------------------------------------------------------------------------

	private static Map<String, Object> row(Object... keyValues) {
		Map<String, Object> row = new LinkedHashMap<>();
		for (int i = 0; i < keyValues.length; i += 2) {
			row.put(String.valueOf(keyValues[i]), keyValues[i + 1]);
		}
		return row;
	}

	private static String keysOf(Map<String, Object> map) {
		return map.keySet().stream().sorted().reduce((a, b) -> a + "," + b).orElse("");
	}

	@SuppressWarnings("unchecked")
	private static Map<String, Object> contentsOf(Map<String, Object> body) {
		return (Map<String, Object>) body.get("contents");
	}

	@SuppressWarnings("unchecked")
	private static Map<String, Object> articleOf(Map<String, Object> body) {
		return (Map<String, Object>) body.get("article");
	}

	private static List<Long> idsOf(List<Map<String, Object>> items) {
		List<Long> ids = new ArrayList<>();
		for (Map<String, Object> item : items) {
			ids.add(((Number) item.get("id")).longValue());
		}
		return ids;
	}

	private static Map<String, Object> itemById(List<Map<String, Object>> items, long id) {
		for (Map<String, Object> item : items) {
			if (((Number) item.get("id")).longValue() == id) {
				return item;
			}
		}
		throw new AssertionError("id " + id + " 행이 없다: " + items);
	}

	private static void assertNotFound(ArticleReadService.SnapshotResult result) {
		assertFalse(result.ok());
		assertEquals("not-found", result.reason());
		assertNull(result.item());
	}

	/** 읽기 전후 비교용 DB 스냅샷 — 행 수와 잠금 컬럼(읽기가 건드릴 만한 자리)을 함께 본다. */
	private String snapshotOfDb() {
		return client.sql("SELECT (SELECT COUNT(*) FROM Article) || '/' || (SELECT COUNT(*) FROM Contents)"
						+ " || '/' || (SELECT COUNT(*) FROM ArticleHistory) || '/'"
						+ " || (SELECT COALESCE(GROUP_CONCAT(lockYN || lockerSessionId), '-') FROM Contents)")
				.query(String.class)
				.single();
	}

	private static boolean mentionsRawRow(Type type) {
		if (type instanceof Class<?> raw) {
			return ContentsRow.class.equals(raw) || (raw.isArray() && mentionsRawRow(raw.getComponentType()));
		}
		if (type instanceof ParameterizedType parameterized) {
			if (mentionsRawRow(parameterized.getRawType())) {
				return true;
			}
			for (Type argument : parameterized.getActualTypeArguments()) {
				if (mentionsRawRow(argument)) {
					return true;
				}
			}
			return false;
		}
		if (type instanceof WildcardType wildcard) {
			for (Type bound : wildcard.getUpperBounds()) {
				if (mentionsRawRow(bound)) {
					return true;
				}
			}
			for (Type bound : wildcard.getLowerBounds()) {
				if (mentionsRawRow(bound)) {
					return true;
				}
			}
		}
		return false;
	}

	// --- 테스트 전용 리포지토리 ------------------------------------------------------------------

	/** {@code findById} 호출 횟수를 세는 스파이 — v1 본문 조회가 '언제' 일어나는지의 관측 수단이다. */
	private static final class CountingArticleRepository extends ArticleRepository {

		private int findByIdCalls;

		CountingArticleRepository(JdbcClient client, TransactionTemplate transactions) {
			super(client, transactions, Clock.fixed(FIXED, ZoneOffset.UTC));
		}

		@Override
		public ArticleAggregate findById(String articleId) {
			this.findByIdCalls++;
			return super.findById(articleId);
		}
	}

	/** 표시 제목 입력 조회가 죽는 상황 — 이력보기가 함께 죽지 않는지, 2차 폴백이 없는지를 본다. */
	private static final class FailingTitleLookupRepository extends ArticleHistoryRepository {

		private int snapshotByIdCalls;

		FailingTitleLookupRepository(JdbcClient client) {
			super(client);
		}

		@Override
		public List<Map<String, Object>> querySnapshotTitlesByArticle(String articleId) {
			throw new IllegalStateException("표시 제목 조회 실패(주입)");
		}

		@Override
		public Map<String, Object> querySnapshotById(String articleId, long id) {
			this.snapshotByIdCalls++;
			return super.querySnapshotById(articleId, id);
		}
	}

	/** 검색 결과에 잠금 비밀이 섞이는 (스키마가 넓어져야만 가능한) 상황을 강제로 만든다. */
	private static final class LeakingSearchRepository extends ArticleRepository {

		LeakingSearchRepository(JdbcClient client, TransactionTemplate transactions) {
			super(client, transactions, Clock.fixed(FIXED, ZoneOffset.UTC));
		}

		@Override
		public List<Map<String, Object>> searchByText(String query) {
			Map<String, Object> leaked = new LinkedHashMap<>();
			leaked.put("articleId", "A1");
			leaked.put("lockerSessionId", SESSION_TOKEN);
			return List.of(leaked);
		}
	}
}
