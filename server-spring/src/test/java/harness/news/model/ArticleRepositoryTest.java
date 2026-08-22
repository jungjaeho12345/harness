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
import java.nio.file.Path;
import java.time.Clock;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.random.RandomGenerator;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.dao.DataAccessException;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.jdbc.support.JdbcTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

/**
 * 기사 리포지토리 — 리포 루트 {@code src/models/articleModel.js}와 1:1인 8연산의 동작 계약.
 *
 * <p>계약 스위트가 관측하지 못하는 축이 여기 모여 있다(step0 발견: 계약 픽스처는 NULL 키 보존 축을 못
 * 잡는다). 특히 다음 넷은 <b>이 테스트가 유일한 방어선</b>이다.
 * <ol>
 *   <li><b>키 집합 = 스키마 컬럼 집합</b>이고 값이 NULL이어도 키가 남는다(decisions (5)).</li>
 *   <li><b>present-only</b> 삽입·갱신 — 주지 않은 컬럼은 문장에 넣지 않는다(부분 수정이 본문·상태·잠금을
 *       조용히 지우면 DB 비파괴 위반이다).</li>
 *   <li><b>스칼라 전용 필터 키의 반복은 예외</b>다(결함 후보 #4의 재현 — 400으로 고치면 계약이 red다).</li>
 *   <li><b>잠금 해제는 갱신</b>이지 삭제가 아니다(행 수가 변하지 않는다).</li>
 * </ol>
 *
 * <p>임시 파일 DB(@TempDir)만 쓴다 — 리포 {@code news.db}는 열지 않는다.
 */
class ArticleRepositoryTest {

	private static final Instant FIXED = Instant.parse("2026-08-20T12:34:56.789Z");

	@TempDir
	Path tempDir;

	private HikariDataSource dataSource;

	private ArticleRepository articles;

	@BeforeEach
	void setUp() {
		TempNewsDb.seed(tempDir);
		dataSource = NewsDataSource.create(tempDir);
		articles = repository(sequence(42));
	}

	@AfterEach
	void tearDown() {
		if (dataSource != null) {
			dataSource.close();
		}
	}

	private ArticleRepository repository(RandomGenerator random) {
		return new ArticleRepository(
				JdbcClient.create(dataSource),
				new TransactionTemplate(new JdbcTransactionManager(dataSource)),
				Clock.fixed(FIXED, ZoneOffset.UTC),
				random);
	}

	// --- 삽입·조회 -----------------------------------------------------------------------------

	@Test
	void insertThenFindByIdCarriesEveryColumnAndLeavesUngivenOnesNull() {
		articles.insert(
				row("articleId", "AKR-1", "title", "제목", "content", "요약", "markupVersion", "{}",
						"modifier", "desk"),
				row("articleId", "AKR-1", "title", "제목", "author", "김기자", "status", "RDS",
						"createdAt", "2026-08-01T00:00:00.000Z"));

		ArticleAggregate found = articles.findById("AKR-1");

		assertNotNull(found);
		assertEquals(RequiredSchema.ARTICLE_COLUMNS, List.copyOf(found.article().keySet()),
				"Article 행은 5키 전부를 스키마 순서로 담는다");
		assertEquals(RequiredSchema.CONTENTS_COLUMNS, List.copyOf(found.contents().columns().keySet()),
				"Contents 행은 29키 전부를 스키마 순서로 담는다");

		assertEquals("{}", found.article().get("markupVersion"));
		assertEquals("김기자", found.contents().column("author"));
		assertEquals("RDS", found.contents().column("status"));
		// 값이 SQL NULL인 컬럼도 키는 남는다 — 이 축이 무너지면 응답 27키가 값에 따라 흔들린다.
		assertTrue(found.contents().columns().containsKey("sentAt"), "미전달 컬럼도 키는 있다");
		assertNull(found.contents().column("sentAt"), "미전달 컬럼의 값은 null이다");
		assertNull(found.contents().column("lockerSessionId"));
		assertEquals("N", found.contents().column("lockYN"), "미전달 lockYN은 DB DEFAULT('N')를 따른다");
	}

	@Test
	void aNewColumnInTheDbDoesNotWidenTheRowKeySet() {
		// 응답 키 집합의 출처는 DB가 아니라 요구 목록이다. SELECT *(+ 메타데이터 매핑)이었다면 스키마가
		// 넓어지는 순간 투영이 모르는 새 컬럼이 그대로 응답에 실린다 — 그것이 SELECT * 금지의 이유다.
		TempNewsDb.exec(TempNewsDb.dbFile(tempDir), "ALTER TABLE Contents ADD COLUMN secretNote VARCHAR");
		articles.insert(null, row("articleId", "AKR-G", "title", "제목"));

		ArticleAggregate found = articles.findById("AKR-G");
		assertEquals(RequiredSchema.CONTENTS_COLUMNS, List.copyOf(found.contents().columns().keySet()));
		assertFalse(found.contents().columns().containsKey("secretNote"));

		// 목록 경로도 같은 매핑을 쓴다(라우트마다 다른 매핑을 두지 않는다).
		assertEquals(RequiredSchema.CONTENTS_COLUMNS,
				List.copyOf(articles.query(Map.of()).get(0).columns().keySet()));
	}

	@Test
	void findByIdIsNullOnlyWhenNeitherTableHasTheRow() {
		assertNull(articles.findById("AKR-없음"));

		// 한쪽만 있으면 그 한쪽만 담는다 — 응답에서 '키 없음'과 'null'을 가르는 근거다(decisions (20)①).
		articles.insert(null, row("articleId", "AKR-2", "status", "RDS"));

		ArticleAggregate found = articles.findById("AKR-2");
		assertNotNull(found);
		assertNull(found.article(), "Article 행이 없으면 null이다(빈 맵이 아니다)");
		assertNotNull(found.contents());
	}

	@Test
	void insertWithoutAnyWhitelistedColumnIsRejected() {
		// Node insertInto와 동형 — 빈 INSERT 문을 만들지 않는다.
		assertThrows(IllegalArgumentException.class, () -> articles.insert(null, row("nickname", "x")));
	}

	@Test
	void insertIsAtomicAcrossBothTablesAndKeepsTheOriginalCause() {
		articles.insert(row("articleId", "AKR-3"), row("articleId", "AKR-3"));

		// Article은 새 id, Contents는 이미 있는 id → 두 번째 문장에서 PK 충돌.
		// 던져지는 것은 DB 예외 그대로다 — 롤백 예외가 원인을 교체하면(TransactionException) 이 단언이 깨진다.
		assertThrows(DataAccessException.class,
				() -> articles.insert(row("articleId", "AKR-4"), row("articleId", "AKR-3")));

		assertNull(articles.findById("AKR-4"), "롤백됐으므로 Article 행도 남지 않는다");
	}

	// --- 갱신 ---------------------------------------------------------------------------------

	@Test
	void updateTouchesOnlyGivenColumnsAndReturnsTheSumOfBothStatements() {
		articles.insert(
				row("articleId", "AKR-5", "title", "옛 제목", "content", "요약", "markupVersion", "본문",
						"modifier", "desk"),
				row("articleId", "AKR-5", "title", "옛 제목", "content", "요약", "status", "RDS",
						"author", "김기자", "lockYN", "Y", "lockerUserId", "desk"));

		int changes = articles.update("AKR-5", row("title", "새 제목"), row("title", "새 제목"));

		assertEquals(2, changes, "changes는 두 갱신문의 영향 행 수 합이다");
		ArticleAggregate found = articles.findById("AKR-5");
		assertEquals("새 제목", found.article().get("title"));
		assertEquals("새 제목", found.contents().column("title"));
		assertEquals("본문", found.article().get("markupVersion"), "주지 않은 본문은 그대로다");
		assertEquals("RDS", found.contents().column("status"), "주지 않은 상태는 그대로다");
		assertEquals("Y", found.contents().column("lockYN"), "주지 않은 잠금은 그대로다");
		assertEquals("desk", found.contents().column("lockerUserId"));
		assertEquals("김기자", found.contents().column("author"));
	}

	@Test
	void updateOfOneTableCountsOne() {
		articles.insert(row("articleId", "AKR-6"), row("articleId", "AKR-6"));

		assertEquals(1, articles.update("AKR-6", null, row("status", "DDH")));
		assertEquals("DDH", articles.findById("AKR-6").contents().column("status"));
	}

	@Test
	void unknownColumnsAreIgnoredSoTheUpdateIsAQuietZero() {
		articles.insert(row("articleId", "AKR-7"), row("articleId", "AKR-7"));

		// 거부가 아니라 무시다 — 계약이 200 {changes:0}을 동결하고 있다.
		assertEquals(0, articles.update("AKR-7", null, row("nickname", "x")));
		assertEquals(0, articles.update("AKR-7", row("nickname", "x"), row("nickname", "x")));
	}

	@Test
	void primaryKeyIsNeverAssignedByUpdate() {
		articles.insert(row("articleId", "AKR-8"), row("articleId", "AKR-8"));

		assertEquals(0, articles.update("AKR-8", row("articleId", "AKR-바뀜"), row("articleId", "AKR-바뀜")));
		assertNotNull(articles.findById("AKR-8"), "PK는 SET 대상이 아니다");
	}

	@Test
	void explicitNullClearsTheColumnWithoutDeletingTheRow() {
		articles.insert(null, row("articleId", "AKR-9", "status", "RDS", "sentAt", "2026-08-01T00:00:00.000Z"));

		assertEquals(1, articles.update("AKR-9", null, row("sentAt", null)));

		ArticleAggregate found = articles.findById("AKR-9");
		assertNull(found.contents().column("sentAt"));
		assertTrue(found.contents().columns().containsKey("sentAt"), "키는 남는다");
	}

	// --- 상태만 읽는 경량 조회 ------------------------------------------------------------------

	@Test
	void findStatusSeparatesMissingRowFromNullColumn() {
		assertFalse(articles.findStatus("AKR-없음").present(), "행이 없으면 present=false다(Node undefined)");

		articles.insert(null, row("articleId", "AKR-10"));
		assertTrue(articles.findStatus("AKR-10").present());
		assertNull(articles.findStatus("AKR-10").status(), "컬럼이 NULL이면 status=null이다(Node null)");

		articles.update("AKR-10", null, row("status", "DPS"));
		assertEquals("DPS", articles.findStatus("AKR-10").status());
	}

	// --- 목록 조회(필터) ------------------------------------------------------------------------

	@Test
	void filterKeysAreTheThirteenNodeWhitelistKeys() {
		// server/index.js의 FILTER_KEYS와 1:1(계획서 부록 A의 '15키'는 드리프트 — 코드가 정본).
		assertEquals(
				List.of("articleId", "author", "sender", "status", "excludeStatus",
						"department", "departments",
						"createdAtFrom", "createdAtTo", "sentAtFrom", "sentAtTo",
						"distributedAtFrom", "distributedAtTo"),
				ArticleRepository.FILTER_KEYS);
		assertEquals(List.of("status", "excludeStatus", "departments"),
				ArticleRepository.ARRAY_CAPABLE_FILTER_KEYS, "배열이 허용되는 키는 3개뿐이다");
	}

	@Test
	void noFilterReturnsEveryRowNewestFirst() {
		seedThree();

		assertEquals(List.of("AKR-C", "AKR-B", "AKR-A"), ids(articles.query(Map.of())),
				"정렬은 createdAt 내림차순이다");
		assertEquals(List.of("AKR-C", "AKR-B", "AKR-A"), ids(articles.query(null)));
	}

	@Test
	void equalityFiltersMatchArticleIdAuthorAndSender() {
		seedThree();

		assertEquals(List.of("AKR-B"), ids(articles.query(filters("articleId", "AKR-B"))));
		assertEquals(List.of("AKR-A"), ids(articles.query(filters("author", "김기자"))));
		assertEquals(List.of("AKR-C"), ids(articles.query(filters("sender", "desk"))));
		assertEquals(List.of(), ids(articles.query(filters("sender", "없는사람"))));
	}

	@Test
	void statusFilterIsInAndExcludeStatusIsNotIn() {
		seedThree();

		assertEquals(List.of("AKR-A"), ids(articles.query(filters("status", "RDS"))));
		assertEquals(List.of("AKR-B", "AKR-A"), ids(articles.query(filters("status", "RDS", "status", "DDH"))),
				"반복 키는 IN이다");
		assertEquals(List.of("AKR-C", "AKR-B"), ids(articles.query(filters("excludeStatus", "RDS"))));
		assertEquals(List.of("AKR-B"),
				ids(articles.query(filters("excludeStatus", "RDS", "excludeStatus", "DPS"))),
				"반복 키는 NOT IN이다");
	}

	@Test
	void commaSeparatedValueIsNotSplit() {
		seedThree();

		// ?status=RDS,DDH는 값이 하나인 문자열이다 — 매칭 0건이 계약이다.
		assertEquals(List.of(), ids(articles.query(filters("status", "RDS,DDH"))));
	}

	@Test
	void departmentsWinsOverDepartment() {
		seedThree();

		assertEquals(List.of("AKR-A"), ids(articles.query(filters("department", "사회부"))));
		assertEquals(List.of("AKR-B", "AKR-A"),
				ids(articles.query(filters("departments", "사회부", "departments", "정치부"))));
		assertEquals(List.of("AKR-B"),
				ids(articles.query(filters("department", "사회부", "departments", "정치부"))),
				"departments가 있으면 department는 무시된다");
	}

	@Test
	void dateRangesAreLexicographicAndDropNullRows() {
		seedThree();

		assertEquals(List.of("AKR-C", "AKR-B"),
				ids(articles.query(filters("createdAtFrom", "2026-08-02T00:00:00.000Z"))));
		assertEquals(List.of("AKR-B", "AKR-A"),
				ids(articles.query(filters("createdAtTo", "2026-08-02T00:00:00.000Z"))));
		assertEquals(List.of(),
				ids(articles.query(filters("createdAtFrom", "2999-12-31T23:59:59.999Z"))));

		// sentAt이 NULL인 행은 어느 방향의 범위 조건에도 걸리지 않는다(SQL NULL 비교).
		assertEquals(List.of("AKR-C"), ids(articles.query(filters("sentAtFrom", "2000-01-01T00:00:00.000Z"))));
		assertEquals(List.of("AKR-C"), ids(articles.query(filters("sentAtTo", "2999-12-31T23:59:59.999Z"))));
		assertEquals(List.of(),
				ids(articles.query(filters("distributedAtFrom", "2000-01-01T00:00:00.000Z"))));
	}

	@Test
	void keysOutsideTheWhitelistAreIgnoredNotRejected() {
		seedThree();

		assertEquals(List.of("AKR-C", "AKR-B", "AKR-A"),
				ids(articles.query(filters("nickname", "x", "lockerSessionId", "훔친토큰"))));
	}

	@Test
	void allThirteenFilterKeysCanBeUsedAtOnce() {
		seedThree();

		Map<String, List<String>> all = filters(
				"articleId", "AKR-C", "author", "박데스크", "sender", "desk",
				"status", "DPS", "excludeStatus", "RDS",
				"department", "경제부", "departments", "경제부",
				"createdAtFrom", "2000-01-01T00:00:00.000Z", "createdAtTo", "2999-12-31T23:59:59.999Z",
				"sentAtFrom", "2000-01-01T00:00:00.000Z", "sentAtTo", "2999-12-31T23:59:59.999Z",
				"distributedAtFrom", "2000-01-01T00:00:00.000Z", "distributedAtTo", "2999-12-31T23:59:59.999Z");

		assertEquals(13, all.size(), "FILTER_KEYS는 13키다");
		assertEquals(List.of(), ids(articles.query(all)), "distributedAt이 NULL이라 전수 적용은 0건이다");

		Map<String, List<String>> eleven = new LinkedHashMap<>(all);
		eleven.remove("distributedAtFrom");
		eleven.remove("distributedAtTo");
		assertEquals(List.of("AKR-C"), ids(articles.query(eleven)), "11키 동시 적용에도 C가 잡힌다");
	}

	@Test
	void repeatingAScalarOnlyKeyThrows() {
		seedThree();

		// 결함 후보 #4의 재현: Node는 배열을 그대로 SQL 바인딩에 내려 500 internal-error가 된다.
		// 400으로 고치면 articles-read.contract.js의 x-articles-list-repeated-scalar-key가 red다.
		for (String key : List.of("articleId", "author", "sender", "department",
				"createdAtFrom", "createdAtTo", "sentAtFrom", "sentAtTo",
				"distributedAtFrom", "distributedAtTo")) {
			assertThrows(IllegalArgumentException.class,
					() -> articles.query(filters(key, "값1", key, "값2")),
					key + "는 스칼라 전용 키다");
		}
	}

	@Test
	void repeatingAnArrayCapableKeyIsFine() {
		seedThree();

		assertEquals(List.of("AKR-B", "AKR-A"), ids(articles.query(filters("status", "RDS", "status", "DDH"))));
		assertEquals(List.of("AKR-B"),
				ids(articles.query(filters("excludeStatus", "RDS", "excludeStatus", "DPS"))));
		assertEquals(List.of("AKR-B", "AKR-A"),
				ids(articles.query(filters("departments", "사회부", "departments", "정치부"))));
	}

	@Test
	void emptyValueIsStillAPresentFilterKey() {
		seedThree();

		// Node는 query[k] !== undefined로 판정한다 — ?author= 는 '빈 문자열과 같은가'라는 조건이다.
		assertEquals(List.of(), ids(articles.query(filters("author", ""))));
	}

	// --- 검색 ---------------------------------------------------------------------------------

	@Test
	void searchMatchesTitleContentOrMarkupAndProjectsNothing() {
		articles.insert(row("articleId", "AKR-S1", "title", "폭염 특보", "content", "요약1",
				"markupVersion", "{\"blocks\":[]}", "modifier", "desk"), null);
		articles.insert(row("articleId", "AKR-S2", "title", "제목2", "content", "장마 전선",
				"markupVersion", "{}", "modifier", "desk"), null);
		articles.insert(row("articleId", "AKR-S3", "title", "제목3", "content", "요약3",
				"markupVersion", "{\"blocks\":[{\"text\":\"태풍\"}]}", "modifier", "desk"), null);

		assertEquals(List.of("AKR-S1"), articleIds(articles.searchByText("폭염")));
		assertEquals(List.of("AKR-S2"), articleIds(articles.searchByText("장마")));
		assertEquals(List.of("AKR-S3"), articleIds(articles.searchByText("태풍")));
		assertEquals(List.of(), articleIds(articles.searchByText("없는말")));

		assertEquals(RequiredSchema.ARTICLE_COLUMNS,
				List.copyOf(articles.searchByText("폭염").get(0).keySet()),
				"검색 행은 Article 5키다(투영하지 않는다)");
	}

	@Test
	void emptyQueryMatchesEveryRow() {
		articles.insert(row("articleId", "AKR-S4", "title", "제목", "content", "요약",
				"markupVersion", "{}", "modifier", "desk"), null);

		// 빈 질의는 거부가 아니라 전 행 매칭이다.
		assertEquals(List.of("AKR-S4"), articleIds(articles.searchByText("")));
	}

	// --- 잠금 ---------------------------------------------------------------------------------

	@Test
	void setLockWritesFiveColumnsAndClearLockResetsThemWithoutDeletingTheRow() {
		articles.insert(null, row("articleId", "AKR-L", "status", "RDS", "title", "제목"));

		int locked = articles.setLock("AKR-L",
				new ArticleRepository.EditLock("desk", "SESSION-TOKEN", "tab-1", "2026-08-20T12:00:00.000Z"));

		assertEquals(1, locked);
		ArticleAggregate held = articles.findById("AKR-L");
		assertEquals("Y", held.contents().column("lockYN"));
		assertEquals("desk", held.contents().column("lockerUserId"));
		assertEquals("SESSION-TOKEN", held.contents().column("lockerSessionId"));
		assertEquals("tab-1", held.contents().column("lockerClientId"));
		assertEquals("2026-08-20T12:00:00.000Z", held.contents().column("lockedAt"));

		assertEquals(1, articles.clearLock("AKR-L"));

		ArticleAggregate free = articles.findById("AKR-L");
		assertEquals("N", free.contents().column("lockYN"));
		assertNull(free.contents().column("lockerUserId"));
		assertNull(free.contents().column("lockerSessionId"));
		assertNull(free.contents().column("lockerClientId"));
		assertNull(free.contents().column("lockedAt"));
		assertEquals("제목", free.contents().column("title"), "해제는 다른 컬럼을 건드리지 않는다");
		assertEquals(1, articles.query(Map.of()).size(), "해제는 갱신이지 삭제가 아니다 — 행 수가 그대로다");
	}

	@Test
	void lockOnMissingRowChangesNothing() {
		assertEquals(0, articles.setLock("AKR-없음",
				new ArticleRepository.EditLock("desk", "s", "c", "2026-08-20T12:00:00.000Z")));
		assertEquals(0, articles.clearLock("AKR-없음"));
	}

	@Test
	void lockColumnsWithoutValuesBecomeSqlNull() {
		articles.insert(null, row("articleId", "AKR-L2", "status", "RDS"));

		assertEquals(1, articles.setLock("AKR-L2", new ArticleRepository.EditLock(null, null, null, null)));

		ArticleAggregate held = articles.findById("AKR-L2");
		assertEquals("Y", held.contents().column("lockYN"), "lockYN은 언제나 'Y'다");
		assertNull(held.contents().column("lockerUserId"));
		assertNull(held.contents().column("lockedAt"));
	}

	// --- 바인딩 정책 ---------------------------------------------------------------------------

	@Test
	void numbersAreStoredAsTextTheSameWayNodeStoresThem() {
		articles.insert(null, row("articleId", "AKR-N1", "title", 42));
		articles.insert(null, row("articleId", "AKR-N2", "title", 1.5));
		articles.insert(null, row("articleId", "AKR-N3", "title", 1_000_000_000));

		// 전 컬럼이 TEXT affinity라 숫자도 텍스트가 된다. 그 텍스트가 무엇인지가 이 단언의 요점이다 —
		// node:sqlite는 JS number를 REAL로 내리므로 42는 "42"가 아니라 "42.0"으로 저장된다(2026-08-21 실측).
		// Java에서 String.valueOf로 문자열을 만들면 "42"가 되어 두 서버의 저장값이 갈린다.
		assertEquals("42.0", articles.findById("AKR-N1").contents().column("title"));
		assertEquals("1.5", articles.findById("AKR-N2").contents().column("title"));
		assertEquals("1000000000.0", articles.findById("AKR-N3").contents().column("title"));
	}

	@Test
	void booleansAndStructuredValuesAreRejected() {
		// Node의 node:sqlite가 TypeError를 던져 500이 되는 입력이다 — 조용한 문자열화는 패리티를 깬다.
		assertThrows(IllegalArgumentException.class,
				() -> articles.insert(null, row("articleId", "AKR-B1", "title", Boolean.TRUE)));
		assertThrows(IllegalArgumentException.class,
				() -> articles.insert(null, row("articleId", "AKR-B2", "title", List.of("a", "b"))));
		assertThrows(IllegalArgumentException.class,
				() -> articles.insert(null, row("articleId", "AKR-B3", "title", Map.of("a", "b"))));

		articles.insert(null, row("articleId", "AKR-B4"));
		assertThrows(IllegalArgumentException.class,
				() -> articles.update("AKR-B4", null, row("title", Boolean.FALSE)));
	}

	@Test
	void nullIsBoundAsSqlNull() {
		articles.insert(null, row("articleId", "AKR-NULL", "title", null, "status", "RDS"));

		ArticleAggregate found = articles.findById("AKR-NULL");
		assertNull(found.contents().column("title"));
		assertTrue(found.contents().columns().containsKey("title"));
	}

	// --- articleId 발급 ------------------------------------------------------------------------

	@Test
	void generatedArticleIdMatchesTheFrozenFormat() {
		String id = articles.generateArticleId();

		assertEquals("AKR20260820000000042", id, "AKR + UTC yyyyMMdd + 9자리 0채움 난수");
		assertTrue(id.matches("AKR\\d{8}\\d{9}"));
	}

	@Test
	void generatorRedrawsUntilTheIdIsFreeInBothTables() {
		ArticleRepository fixed = repository(sequence(1, 2, 3));
		// 후보 1은 Article에, 후보 2는 Contents에 이미 있다 — 유일성 확인은 두 테이블을 모두 본다.
		fixed.insert(row("articleId", "AKR20260820000000001"), null);
		fixed.insert(null, row("articleId", "AKR20260820000000002"));

		assertEquals("AKR20260820000000003", fixed.generateArticleId());
	}

	@Test
	void generatorGivesUpLoudlyInsteadOfLoopingForever() {
		ArticleRepository stuck = repository(sequence(7));
		stuck.insert(row("articleId", "AKR20260820000000007"), null);

		assertThrows(IllegalStateException.class, stuck::generateArticleId);
	}

	// --- 헬퍼 ---------------------------------------------------------------------------------

	/** 세 건을 시드한다: A(RDS·사회부) · B(DDH·정치부) · C(DPS·경제부, 송고됨). createdAt은 A<B<C. */
	private void seedThree() {
		articles.insert(null, row("articleId", "AKR-A", "author", "김기자", "status", "RDS",
				"department", "사회부", "createdAt", "2026-08-01T00:00:00.000Z"));
		articles.insert(null, row("articleId", "AKR-B", "author", "이기자", "status", "DDH",
				"department", "정치부", "createdAt", "2026-08-02T00:00:00.000Z"));
		articles.insert(null, row("articleId", "AKR-C", "author", "박데스크", "sender", "desk",
				"status", "DPS", "department", "경제부", "createdAt", "2026-08-03T00:00:00.000Z",
				"sentAt", "2026-08-03T01:00:00.000Z"));
	}

	private static List<String> ids(List<ContentsRow> rows) {
		List<String> out = new ArrayList<>();
		for (ContentsRow row : rows) {
			out.add((String) row.column("articleId"));
		}
		return out;
	}

	private static List<String> articleIds(List<Map<String, Object>> rows) {
		List<String> out = new ArrayList<>();
		for (Map<String, Object> row : rows) {
			out.add((String) row.get("articleId"));
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

	/** 서블릿 파라미터 맵과 같은 모양 — 같은 키를 두 번 주면 값이 쌓인다(콤마 분해가 아니다). */
	private static Map<String, List<String>> filters(String... keyValues) {
		Map<String, List<String>> map = new LinkedHashMap<>();
		for (int i = 0; i < keyValues.length; i += 2) {
			map.computeIfAbsent(keyValues[i], key -> new ArrayList<>()).add(keyValues[i + 1]);
		}
		return map;
	}

	/** 고정 난수원 — 마지막 값을 계속 돌려준다(상한 이탈 없이 '항상 충돌' 상황을 만든다). */
	private static RandomGenerator sequence(int... values) {
		return new RandomGenerator() {

			private int index;

			@Override
			public long nextLong() {
				return nextInt(Integer.MAX_VALUE);
			}

			@Override
			public int nextInt(int bound) {
				int value = values[Math.min(this.index, values.length - 1)];
				this.index++;
				return value;
			}
		};
	}
}
