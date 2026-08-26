package harness.news.service;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertSame;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.zaxxer.hikari.HikariDataSource;
import harness.news.db.NewsDataSource;
import harness.news.db.RequiredSchema;
import harness.news.model.ArticleAggregate;
import harness.news.model.ArticleHistoryRepository;
import harness.news.model.ArticleRepository;
import harness.news.service.ArticleEmbargoService.Result;
import harness.news.testsupport.MutableClock;
import harness.news.testsupport.TempNewsDb;
import java.nio.file.Path;
import java.time.Clock;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import javax.sql.DataSource;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.jdbc.support.JdbcTransactionManager;
import org.springframework.transaction.support.TransactionSynchronizationManager;
import org.springframework.transaction.support.TransactionTemplate;

/**
 * 엠바고 상태 반영 서비스 — 리포 루트 {@code src/services/articleService.js} 277~300행
 * ({@code syncEmbargoStatus})의 동작 계약. HTTP는 없다(@TempDir 임시 DB + 실제 리포지토리 — 리포
 * {@code news.db} 무접촉).
 *
 * <p>기대값의 출처는 계획서가 아니라 <b>Node 정본 실측</b>이다(2026-08-26 · 가짜 모델로 원본
 * {@code createArticleService}의 {@code syncEmbargoStatus}를 직접 호출해 27개 시나리오의 반환·
 * {@code update} 인자·이력 insert 인자를 표로 떴다). 계획서 문구가 실측과 갈린 자리가 실제로 있었다:
 * "EPS + nonpress → DPS"는 <b>틀렸다</b> — 1+2차 엠바고 기사의 required는 {@code [press, nonpress]}라
 * nonpress 하나만으로는 완결되지 않고 EPS 그대로다(변화 0건). DPS가 되려면 이번 사이클에 두 kind가 모두
 * 있어야 한다.
 *
 * <p>여기서 잠그는 것은 다섯 가지다.
 * <ol>
 *   <li><b>승격 판정은 이번 사이클이다</b>({@code cycleDistributedKinds}) — 전체 이력으로 판정하면
 *       재엠바고 기사가 거짓 완결(DPS)되고, DPS는 상태 계산 대상 밖이라 도래해도 영원히 배부되지 않는다.</li>
 *   <li><b>역행 금지·불변 상태 밖 무접촉</b> — EPS는 DES로 내려가지 않고 DPS·EEK·EEH·DPD·RDS는 손대지
 *       않는다(부활은 회수 불가능한 사고다).</li>
 *   <li><b>present-only</b> — 승격은 {@code status} 한 컬럼만 쓴다. {@code distributedAt}은
 *       {@code DistributionService}의 단일 책임이라 여기서 함께 쓰지 않는다.</li>
 *   <li><b>이력 어휘</b> — {@code eventType='status'} · {@code action='embargo'}. {@code send}로 기록되면
 *       그 행이 새 사이클 경계({@code latestSendId})가 되어 배부 판정 전체가 오염된다.</li>
 *   <li><b>바꿀 필요가 없으면 아무것도 쓰지 않는다</b> — 업데이트 0회 · 이력 0행.</li>
 * </ol>
 *
 * <p>이 테스트는 행을 <b>하나도 지우지 않는다</b>(DB 비파괴 — 상태별 격자는 삭제가 아니라 기사 id를 달리
 * 해서 만든다).
 */
class ArticleEmbargoServiceTest {

	private static final Instant T0 = Instant.parse("2026-08-26T00:00:00.000Z");

	private static final String STAMP = "2026-08-26T00:00:00.000Z";

	private static final String ARTICLE_ID = "AKR20260826000000001";

	private static final String MISSING_ID = "AKR00000000000000000";

	/** 1차 엠바고(언론사 = press) 시각. */
	private static final String FIRST_EMBARGO = "2026-08-27T00:00:00.000Z";

	/** 2차 엠바고(비언론사 = nonpress) 시각. */
	private static final String SECOND_EMBARGO = "2026-08-28T00:00:00.000Z";

	private static final String PRESS = "press";

	private static final String NONPRESS = "nonpress";

	private static final String ACTOR = "u-desk";

	private static final String DES = "DES";

	private static final String EPS = "EPS";

	private static final String DPS = "DPS";

	@TempDir
	Path tempDir;

	private HikariDataSource dataSource;

	private JdbcClient client;

	private MutableClock clock;

	private ArticleRepository articles;

	private ArticleHistoryRepository history;

	private final List<ArticleHistoryRecorder.HistoryError> historyErrors = new ArrayList<>();

	private ArticleEmbargoService service;

	@BeforeEach
	void setUp() {
		TempNewsDb.seed(this.tempDir);
		this.dataSource = NewsDataSource.create(this.tempDir);
		this.client = JdbcClient.create(this.dataSource);
		this.clock = new MutableClock(T0.toEpochMilli());
		this.articles = new ArticleRepository(this.client, transactions(), this.clock);
		this.history = new ArticleHistoryRepository(this.client);
		this.service = service(this.articles, this.history);
	}

	@AfterEach
	void tearDown() {
		if (this.dataSource != null) {
			this.dataSource.close();
		}
	}

	private TransactionTemplate transactions() {
		return new TransactionTemplate(new JdbcTransactionManager(this.dataSource));
	}

	/**
	 * 읽기는 언제나 진짜 리포지토리로, 이력 기록만 주어진 리포지토리로 한다 — 이력 insert만 실패하는
	 * 상황을 만들기 위한 분리다(Node의 {@code record} 격리 동형 확인용).
	 */
	private ArticleEmbargoService service(ArticleRepository articleRepo, ArticleHistoryRepository ledgerRepo) {
		ArticleHistoryRecorder recorder = new ArticleHistoryRecorder(ledgerRepo, this.clock, this.historyErrors::add);
		return new ArticleEmbargoService(articleRepo, this.history, recorder, transactions());
	}

	// --- 픽스처 -----------------------------------------------------------------------------------

	/** 값이 {@code null}인 컬럼도 담아야 하므로 {@code Map.of}를 쓰지 않는다. */
	private static Map<String, Object> row(Object... pairs) {
		Map<String, Object> map = new LinkedHashMap<>();
		for (int i = 0; i < pairs.length; i += 2) {
			map.put((String) pairs[i], pairs[i + 1]);
		}
		return map;
	}

	private void seedArticle(String status, String embargoAt, String secondEmbargoAt) {
		seedArticle(ARTICLE_ID, status, embargoAt, secondEmbargoAt);
	}

	/** 엠바고 2컬럼과 상태를 지정해 기사 1건을 심는다. 나머지 컬럼도 값을 채워 present-only를 관측한다. */
	private void seedArticle(String articleId, String status, String embargoAt, String secondEmbargoAt) {
		this.articles.insert(
				row("articleId", articleId, "title", "제목", "markupVersion", "{\"blocks\":[]}"),
				row("articleId", articleId, "title", "제목", "content", "본문", "author", "reporter1",
						"modifier", "desk1", "sender", "desk1", "department", "정치부", "departmentCode", "P01",
						"createdAt", STAMP, "editedAt", STAMP, "sentAt", STAMP, "distributedAt", STAMP,
						"embargoAt", embargoAt, "secondEmbargoAt", secondEmbargoAt, "status", status,
						"lockYN", "Y", "lockerUserId", "desk1", "lockerSessionId", "sid-1",
						"lockerClientId", "cid-1", "lockedAt", STAMP,
						"coAuthor", "공동", "category", "정치", "region", "서울", "attribute", "속보",
						"keyword", "키워드", "internalComment", "내부메모", "externalComment", "외부메모",
						"attachmentFile", "a.jpg", "referenceFile", "r.pdf"));
	}

	private long seedDistribute(String kind) {
		return seedDistribute(ARTICLE_ID, kind);
	}

	/** 배부 사실 1행({@code eventType='distribute'} · {@code action=kind}). */
	private long seedDistribute(String articleId, String kind) {
		return this.history.insert(row("articleId", articleId, "eventType", "distribute", "action", kind,
				"targetId", 1L, "actorUserId", ACTOR, "createdAt", STAMP));
	}

	private long seedSend() {
		return seedSend(ARTICLE_ID);
	}

	/** 송고 이력 1행 — 이 행의 id가 배부 사이클 경계다. */
	private long seedSend(String articleId) {
		return this.history.insert(row("articleId", articleId, "eventType", "status", "action", "send",
				"fromStatus", "RDS", "toStatus", DPS, "actorUserId", ACTOR, "createdAt", STAMP));
	}

	// --- 관측 헬퍼 --------------------------------------------------------------------------------

	private String statusOf() {
		return statusOf(ARTICLE_ID);
	}

	private String statusOf(String articleId) {
		Object status = contentsOf(articleId).get("status");
		return (status == null) ? null : String.valueOf(status);
	}

	/** {@code Contents} 전 컬럼 스냅샷 — present-only 판정의 입력이다. */
	private Map<String, Object> contentsOf(String articleId) {
		ArticleAggregate found = this.articles.findById(articleId);
		assertNotNull(found, "기사가 없다: " + articleId);
		assertNotNull(found.contents(), "공통정보 행이 없다: " + articleId);
		Map<String, Object> columns = new LinkedHashMap<>();
		for (String column : RequiredSchema.CONTENTS_COLUMNS) {
			columns.put(column, found.contents().column(column));
		}
		return columns;
	}

	private Map<String, Object> articleRowOf(String articleId) {
		ArticleAggregate found = this.articles.findById(articleId);
		assertNotNull(found, "기사가 없다: " + articleId);
		return found.article();
	}

	private List<Map<String, Object>> ledgerRowsOf() {
		return ledgerRowsOf(ARTICLE_ID);
	}

	/** 원장을 직접 읽는다(조회 API는 저장 제목 컬럼을 싣지 않는다). */
	private List<Map<String, Object>> ledgerRowsOf(String articleId) {
		return this.client.sql("SELECT id, articleId, eventType, action, fromStatus, toStatus, actorUserId,"
						+ " createdAt, targetId, reason, markupVersion, snapshotTitle FROM "
						+ RequiredSchema.HISTORY_TABLE + " WHERE articleId = ? ORDER BY id")
				.param(articleId)
				.query()
				.listOfRows();
	}

	private int countRows(String table) {
		return this.client.sql("SELECT COUNT(*) FROM " + table).query(Integer.class).single();
	}

	// --- 1. Node 실측 표 --------------------------------------------------------------------------

	/** Node 실측 1번: 1차만 설정된 기사(required=[press])는 press 배부 하나로 <b>완결</b>이다. */
	@Test
	void aFirstOnlyEmbargoIsCompletedByASinglePressDistribution() {
		seedArticle(DES, FIRST_EMBARGO, "");

		Result result = this.service.syncEmbargoStatus(ARTICLE_ID, List.of(PRESS), ACTOR);

		assertTrue(result.ok());
		assertNull(result.reason());
		assertEquals(DPS, result.status());
		assertEquals(DPS, statusOf(), "되읽은 상태가 반환과 갈라지면 결함이다");
	}

	/** Node 실측 2번: 1+2차 기사는 press 하나로는 완결되지 않는다(부분 배부 = EPS). */
	@Test
	void aBothEmbargoArticleBecomesEpsOnTheFirstKind() {
		seedArticle(DES, FIRST_EMBARGO, SECOND_EMBARGO);

		Result result = this.service.syncEmbargoStatus(ARTICLE_ID, List.of(PRESS), ACTOR);

		assertTrue(result.ok());
		assertEquals(EPS, result.status());
		assertEquals(EPS, statusOf());
	}

	/**
	 * Node 실측 3번 — <b>계획서 문구가 틀린 자리</b>: "EPS + nonpress → DPS"가 아니다. required가
	 * {@code [press, nonpress]}인데 이번 사이클 배부가 nonpress 하나뿐이면 next는 EPS이고 현재 상태와 같아
	 * <b>쓰기가 0건</b>이다.
	 */
	@Test
	void anEpsArticleWithOnlyOneKindStaysEpsAndWritesNothing() {
		seedArticle(EPS, FIRST_EMBARGO, SECOND_EMBARGO);

		Result result = this.service.syncEmbargoStatus(ARTICLE_ID, List.of(NONPRESS), ACTOR);

		assertTrue(result.ok());
		assertEquals(EPS, result.status());
		assertEquals(EPS, statusOf());
		assertEquals(0, ledgerRowsOf().size(), "바꿀 것이 없으면 이력도 남기지 않는다");
	}

	/** Node 실측 A번: 이번 사이클 press 이력 + 힌트 nonpress = 전량 → EPS에서 DPS로 승격된다. */
	@Test
	void anEpsArticleIsPromotedWhenTheCycleCompletes() {
		seedArticle(EPS, FIRST_EMBARGO, SECOND_EMBARGO);
		seedSend();
		seedDistribute(PRESS);

		Result result = this.service.syncEmbargoStatus(ARTICLE_ID, List.of(NONPRESS), ACTOR);

		assertEquals(DPS, result.status());
		assertEquals(DPS, statusOf());
	}

	/** Node 실측 B번: 힌트가 없어도 이번 사이클 이력이 전량이면 승격된다(tick self-heal 경로). */
	@Test
	void theCycleHistoryAloneCanCompleteTheArticle() {
		seedArticle(EPS, FIRST_EMBARGO, SECOND_EMBARGO);
		seedSend();
		seedDistribute(PRESS);
		seedDistribute(NONPRESS);

		Result result = this.service.syncEmbargoStatus(ARTICLE_ID, List.of(), ACTOR);

		assertEquals(DPS, result.status());
		assertEquals(DPS, statusOf());
	}

	/** Node 실측 6번: 엠바고 미설정 기사는 이 모듈의 관여 대상이 아니다(required가 비어 있다). */
	@Test
	void anArticleWithoutAnyEmbargoIsNeverTouched() {
		seedArticle(DES, "", "");

		Result result = this.service.syncEmbargoStatus(ARTICLE_ID, List.of(PRESS, NONPRESS), ACTOR);

		assertTrue(result.ok());
		assertEquals(DES, result.status());
		assertEquals(DES, statusOf());
		assertEquals(0, ledgerRowsOf().size());
	}

	/** Node 실측 11·I번: kind와 엠바고 컬럼이 어긋나도 "1건 이상 배부"는 EPS다(required는 nonpress뿐). */
	@Test
	void aDistributionOfAnUnrelatedKindStillCountsAsPartial() {
		seedArticle(DES, "", SECOND_EMBARGO);

		Result result = this.service.syncEmbargoStatus(ARTICLE_ID, List.of(PRESS), ACTOR);

		assertEquals(EPS, result.status());
		assertEquals(EPS, statusOf());
	}

	/** Node 실측 H번: 송고 이력이 없어 경계를 확정할 수 없으면 <b>전체 이력</b>을 센다(안전측). */
	@Test
	void withoutASendBoundaryTheWholeHistoryCounts() {
		seedArticle(DES, FIRST_EMBARGO, SECOND_EMBARGO);
		seedDistribute(PRESS);

		Result result = this.service.syncEmbargoStatus(ARTICLE_ID, List.of(), ACTOR);

		assertEquals(EPS, result.status());
		assertEquals(EPS, statusOf());
	}

	/** Node 실측 G번: 상태 컬럼이 NULL이면 불변 상태 집합 밖이라 계산이 관여하지 않는다. */
	@Test
	void aNullStatusColumnIsLeftAlone() {
		seedArticle(null, FIRST_EMBARGO, "");

		Result result = this.service.syncEmbargoStatus(ARTICLE_ID, List.of(PRESS), ACTOR);

		assertTrue(result.ok());
		assertNull(result.status());
		assertNull(statusOf());
		assertEquals(0, ledgerRowsOf().size());
	}

	// --- 2. 역행 금지 · 불변 상태 밖 무접촉 --------------------------------------------------------

	/** Node 실측 4번: 배부 이력이 하나도 없어도 EPS는 DES로 내려가지 않는다(쓰기 0건 · 이력 0행). */
	@Test
	void anEpsArticleNeverFallsBackToDes() {
		seedArticle(EPS, FIRST_EMBARGO, SECOND_EMBARGO);

		Result result = this.service.syncEmbargoStatus(ARTICLE_ID, List.of(), ACTOR);

		assertTrue(result.ok());
		assertEquals(EPS, result.status());
		assertEquals(EPS, statusOf());
		assertEquals(0, ledgerRowsOf().size());
	}

	/**
	 * Node 실측 5·J·K번: 완결(DPS)·킬(EEK)·보류(EEH)·삭제 승인(DPD)·작성(RDS) 등 불변 상태 집합 밖은
	 * 손대지 않는다. 하나라도 되살아나면 회수 불가능한 사고다.
	 */
	@Test
	void statusesOutsideTheMutableSetAreNeverTouched() {
		List<String> frozen = List.of(DPS, "EEK", "EEH", "DPD", "RDS", "DDH", "DDK");
		for (int i = 0; i < frozen.size(); i++) {
			String status = frozen.get(i);
			String articleId = "AKR2026082600000010" + i;
			seedArticle(articleId, status, FIRST_EMBARGO, SECOND_EMBARGO);
			seedSend(articleId);
			seedDistribute(articleId, PRESS);
			seedDistribute(articleId, NONPRESS);

			Result result = this.service.syncEmbargoStatus(articleId, List.of(PRESS, NONPRESS), ACTOR);

			assertTrue(result.ok(), status + ": 거부가 아니라 무변경이다");
			assertEquals(status, result.status(), status + ": 상태가 그대로 반환된다");
			assertEquals(status, statusOf(articleId), status + ": 저장된 상태도 그대로다");
			assertEquals(3, ledgerRowsOf(articleId).size(), status + ": 승격 이력이 추가되지 않았다");
		}
	}

	// --- 3. 거짓 완결 방지(사이클 판정) ------------------------------------------------------------

	/**
	 * <b>이 phase의 핵심 함정</b>: 과거 사이클의 배부 2건이 남아 있는 재엠바고 기사(보류→엠바고 재설정→
	 * 재송고로 DES 재진입)를 전체 이력({@code distributedKinds})으로 판정하면 DPS로 <b>거짓 완결</b>되고,
	 * DPS는 불변 상태 집합 밖이라 도래 시각이 와도 <b>영원히 배부되지 않는다</b>(무음 미배부).
	 */
	@Test
	void pastCycleDistributionsDoNotCompleteAReEmbargoedArticle() {
		seedArticle(DES, FIRST_EMBARGO, SECOND_EMBARGO);
		seedDistribute(PRESS);
		seedDistribute(NONPRESS);
		seedSend();

		Result result = this.service.syncEmbargoStatus(ARTICLE_ID, List.of(), ACTOR);

		assertTrue(result.ok());
		assertEquals(DES, result.status(), "과거 사이클 배부는 이번 사이클의 완결 근거가 아니다");
		assertEquals(DES, statusOf());
		assertEquals(3, ledgerRowsOf().size(), "승격이 없으면 이력도 늘지 않는다");
	}

	// --- 4. present-only ---------------------------------------------------------------------------

	/** 승격은 {@code status} <b>한 컬럼</b>만 쓴다 — {@code distributedAt}·송고 stamp·잠금·본문 무변경. */
	@Test
	void thePromotionWritesOnlyTheStatusColumn() {
		seedArticle(DES, FIRST_EMBARGO, "");
		Map<String, Object> before = contentsOf(ARTICLE_ID);
		Map<String, Object> articleBefore = articleRowOf(ARTICLE_ID);

		Result result = this.service.syncEmbargoStatus(ARTICLE_ID, List.of(PRESS), ACTOR);
		assertEquals(DPS, result.status());

		Map<String, Object> after = contentsOf(ARTICLE_ID);
		for (String column : RequiredSchema.CONTENTS_COLUMNS) {
			if ("status".equals(column)) {
				assertEquals(DES, before.get(column));
				assertEquals(DPS, after.get(column));
				continue;
			}
			assertEquals(before.get(column), after.get(column), column + ": 승격이 함께 쓴 컬럼이 있다");
		}
		assertEquals(articleBefore, articleRowOf(ARTICLE_ID), "Article 행은 한 글자도 바뀌지 않는다");
	}

	// --- 5. 이력 행의 어휘 -------------------------------------------------------------------------

	/**
	 * 이력은 {@code eventType='status'} · {@code action='embargo'}다. {@code send}로 기록되면 그 행이
	 * 새 사이클 경계({@code EmbargoPolicy.latestSendId})가 되어 이후 배부 판정 전체가 오염된다.
	 * 본문 스냅샷이 아니므로 {@code markupVersion}·{@code snapshotTitle}은 NULL이다.
	 */
	@Test
	void thePromotionLeavesOneEmbargoStatusRowWithoutASnapshot() {
		seedArticle(DES, FIRST_EMBARGO, SECOND_EMBARGO);

		this.service.syncEmbargoStatus(ARTICLE_ID, List.of(PRESS), ACTOR);

		List<Map<String, Object>> rows = ledgerRowsOf();
		assertEquals(1, rows.size());
		Map<String, Object> entry = rows.get(0);
		assertEquals(ARTICLE_ID, entry.get("articleId"));
		assertEquals("status", entry.get("eventType"));
		assertEquals("embargo", entry.get("action"), "사람의 액션이 아니다 — send가 아니라 embargo다");
		assertEquals(DES, entry.get("fromStatus"));
		assertEquals(EPS, entry.get("toStatus"));
		assertEquals(ACTOR, entry.get("actorUserId"));
		assertEquals(STAMP, entry.get("createdAt"), "시각 stamp는 기록 헬퍼가 주입한다");
		assertNull(entry.get("markupVersion"), "본문 스냅샷 행이 아니다");
		assertNull(entry.get("snapshotTitle"), "저장 제목을 남기지 않는다");
		assertNull(entry.get("targetId"), "수신처 이벤트가 아니다");
		assertNull(entry.get("reason"));
	}

	/** Node 실측 E번: 행위자가 없으면 {@code null}로 stamp한다(빈 문자열·시스템 계정을 지어내지 않는다). */
	@Test
	void aSystemRunStampsANullActor() {
		seedArticle(DES, FIRST_EMBARGO, "");

		this.service.syncEmbargoStatus(ARTICLE_ID, List.of(PRESS), null);

		List<Map<String, Object>> rows = ledgerRowsOf();
		assertEquals(1, rows.size());
		assertNull(rows.get(0).get("actorUserId"));
	}

	// --- 6. 바꿀 것이 없으면 쓰지 않는다 -----------------------------------------------------------

	/** {@code next == null}이면 업데이트 호출 자체가 없다(무의미한 쓰기 금지 — 되읽기가 아니라 호출 카운트). */
	@Test
	void whenNothingChangesThereIsNoUpdateCallAndNoLedgerRow() {
		seedArticle(EPS, FIRST_EMBARGO, SECOND_EMBARGO);
		ProbeArticles probe = new ProbeArticles(this.client, transactions(), this.clock, this.dataSource);
		ArticleEmbargoService probed = service(probe, this.history);

		Result result = probed.syncEmbargoStatus(ARTICLE_ID, List.of(NONPRESS), ACTOR);

		assertEquals(EPS, result.status());
		assertEquals(0, probe.updates, "바꿀 것이 없는데 업데이트를 불렀다");
		assertEquals(0, ledgerRowsOf().size());
	}

	// --- 7. 없는 기사 ------------------------------------------------------------------------------

	/** 없는 기사는 예외가 아니라 사유 토큰이다(tick이 한 건 때문에 통째로 죽지 않는다). */
	@Test
	void aMissingArticleIsRejectedWithoutThrowing() {
		Result result = this.service.syncEmbargoStatus(MISSING_ID, List.of(PRESS), ACTOR);

		assertFalse(result.ok());
		assertEquals("not-found", result.reason());
		assertNull(result.status());
		assertEquals(0, countRows(RequiredSchema.HISTORY_TABLE));
	}

	// --- 8. extraKinds 합집합 ----------------------------------------------------------------------

	/** Node 실측 9a·12번: 힌트가 {@code null}이거나 비어 있으면 이력만으로 판정한다. */
	@Test
	void extraKindsMayBeNullOrEmpty() {
		seedArticle(DES, FIRST_EMBARGO, SECOND_EMBARGO);

		assertEquals(DES, this.service.syncEmbargoStatus(ARTICLE_ID, null, ACTOR).status());
		assertEquals(DES, this.service.syncEmbargoStatus(ARTICLE_ID, List.of(), ACTOR).status());
		assertEquals(0, ledgerRowsOf().size());

		seedSend();
		seedDistribute(PRESS);
		assertEquals(EPS, this.service.syncEmbargoStatus(ARTICLE_ID, null, ACTOR).status());
	}

	/**
	 * Node 실측 9b·D번: 미지 kind·{@code null}·빈 문자열 원소는 조용히 무시된다. {@code null} 원소는
	 * {@code Set.of(...).contains(null)}이 NPE를 던지는 자리라 <b>도달 테스트가 필요하다</b>.
	 */
	@Test
	void unknownAndNullElementsInTheHintAreIgnored() {
		seedArticle(DES, FIRST_EMBARGO, SECOND_EMBARGO);

		Result result = this.service.syncEmbargoStatus(ARTICLE_ID, Arrays.asList(null, "", "wire", PRESS), ACTOR);

		assertEquals(EPS, result.status());
		assertEquals(EPS, statusOf());
	}

	/** Node 실측 9c·9d번: 이력과 힌트는 <b>합집합</b>이다(중복은 접히고, 서로 다른 kind는 완결을 만든다). */
	@Test
	void theHintIsUnionedWithTheCycleHistory() {
		seedArticle(DES, FIRST_EMBARGO, SECOND_EMBARGO);
		seedSend();
		seedDistribute(PRESS);

		// 중복(이력 press + 힌트 press) → 여전히 부분 배부다.
		assertEquals(EPS, this.service.syncEmbargoStatus(ARTICLE_ID, List.of(PRESS), ACTOR).status());
		assertEquals(EPS, statusOf());

		// 합집합(이력 press + 힌트 nonpress) → 완결이다.
		assertEquals(DPS, this.service.syncEmbargoStatus(ARTICLE_ID, List.of(NONPRESS), ACTOR).status());
		assertEquals(DPS, statusOf());
	}

	// --- 9. 이력 실패 처분 · 트랜잭션 경계 ---------------------------------------------------------

	/**
	 * <b>Node 동형(실측 10번)</b>: 이력 insert가 던져도 <b>상태 승격은 남는다</b> — 기록은 부가이고,
	 * 예외를 승격시키면 이미 나간 배부를 되돌릴 수 없는 자리에서 호출자가 깨진다. 대신 무음으로 사라지지
	 * 않는다(통지 1건).
	 *
	 * <p>이것이 open_questions (d)의 확정이다: 트랜잭션 원자성(이력 실패 시 상태도 롤백)을 택하지 않는다 —
	 * Node가 삼키고 상태를 남기므로 그쪽을 택하면 같은 입력에서 두 서버의 저장 상태가 갈린다.
	 */
	@Test
	void aFailedLedgerInsertKeepsThePromotedStatus() {
		seedArticle(DES, FIRST_EMBARGO, "");
		ArticleEmbargoService probed = service(this.articles, new FailingHistory(this.client));

		Result result = probed.syncEmbargoStatus(ARTICLE_ID, List.of(PRESS), ACTOR);

		assertTrue(result.ok());
		assertEquals(DPS, result.status());
		assertEquals(DPS, statusOf(), "이력 실패가 상태를 되돌리지 않는다(Node 동형)");
		assertEquals(0, ledgerRowsOf().size());
		assertEquals(1, this.historyErrors.size(), "삼키되 반드시 남긴다");
		assertEquals("embargo", this.historyErrors.get(0).action());
	}

	/**
	 * 상태 쓰기와 이력 insert는 <b>같은 트랜잭션</b> 안에서 실행된다(decisions (19)). 두 문장 사이에
	 * 커넥션이 반납되면 SQLite 파일 잠금을 두 번 잡았다 놓게 되고, 그 틈에 다른 쓰기가 끼어들 수 있다.
	 * 관측은 두 지점에서 <b>같은 커넥션 홀더</b>가 바인딩돼 있다는 사실이다.
	 */
	@Test
	void theStatusWriteAndTheLedgerRowShareOneTransaction() {
		seedArticle(DES, FIRST_EMBARGO, "");
		ProbeArticles probe = new ProbeArticles(this.client, transactions(), this.clock, this.dataSource);
		ProbeHistory ledger = new ProbeHistory(this.client, this.dataSource);
		ArticleEmbargoService probed = new ArticleEmbargoService(probe, this.history,
				new ArticleHistoryRecorder(ledger, this.clock, this.historyErrors::add), transactions());

		assertEquals(DPS, probed.syncEmbargoStatus(ARTICLE_ID, List.of(PRESS), ACTOR).status());

		assertEquals(1, probe.updates);
		assertEquals(1, ledger.inserts);
		assertNotNull(probe.holder, "상태 쓰기가 트랜잭션 밖에서 일어났다");
		assertNotNull(ledger.holder, "이력 기록이 트랜잭션 밖에서 일어났다");
		assertSame(probe.holder, ledger.holder, "두 문장이 서로 다른 커넥션을 썼다");
	}

	// --- 테스트 더블 ------------------------------------------------------------------------------

	/** 업데이트 호출을 세고 그 시점의 트랜잭션 바인딩을 붙잡는 리포지토리. 동작은 진짜와 같다. */
	private static final class ProbeArticles extends ArticleRepository {

		private final DataSource key;

		private int updates;

		private Object holder;

		ProbeArticles(JdbcClient jdbc, TransactionTemplate transactions, Clock clock, DataSource key) {
			super(jdbc, transactions, clock);
			this.key = key;
		}

		@Override
		public int update(String articleId, Map<String, ?> article, Map<String, ?> contents) {
			this.updates++;
			this.holder = TransactionSynchronizationManager.getResource(this.key);
			return super.update(articleId, article, contents);
		}

	}

	/** 이력 삽입 시점의 트랜잭션 바인딩을 붙잡는 리포지토리. 동작은 진짜와 같다. */
	private static final class ProbeHistory extends ArticleHistoryRepository {

		private final DataSource key;

		private int inserts;

		private Object holder;

		ProbeHistory(JdbcClient jdbc, DataSource key) {
			super(jdbc);
			this.key = key;
		}

		@Override
		public long insert(Map<String, ?> record) {
			this.inserts++;
			this.holder = TransactionSynchronizationManager.getResource(this.key);
			return super.insert(record);
		}

	}

	/** 이력 insert만 실패하는 리포지토리 — 조회는 이 인스턴스로 하지 않는다. */
	private static final class FailingHistory extends ArticleHistoryRepository {

		FailingHistory(JdbcClient jdbc) {
			super(jdbc);
		}

		@Override
		public long insert(Map<String, ?> record) {
			throw new IllegalStateException("planted failure");
		}

	}

}
