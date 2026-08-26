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
import harness.news.model.DistributionTargetRepository;
import harness.news.service.DistributionTickService.TickError;
import harness.news.testsupport.MutableClock;
import harness.news.testsupport.TempNewsDb;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.time.Clock;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.stream.Stream;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.jdbc.support.JdbcTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;
import tools.jackson.databind.json.JsonMapper;

/**
 * 엠바고 시점 배부 tick — 리포 루트 {@code src/services/distributionTickService.js}(229행)의 동작 계약.
 *
 * <p>기준값은 <b>Node 실측</b>이다(2026-08-26 · 가짜 모델로 원본 {@code createDistributionTickService}를
 * 직접 호출해 20개 시나리오의 반환 키 집합·배열 원소 키·호출 순서를 표로 떴다). 계획서 문구가 아니라 그
 * 표가 정본이다.
 *
 * <p>배선은 <b>실물</b>이다: 임시 파일 DB({@code @TempDir})의 진짜 리포지토리 · 진짜
 * {@link DistributionService} · 진짜 {@link SpoolWriter}(임시 스풀 루트) · 진짜
 * {@link ArticleEmbargoService}. 리포 {@code news.db}도 {@code uploads/}도 열지 않는다.
 */
class DistributionTickServiceTest {

	private static final Instant FIXED = Instant.parse("2026-08-25T00:00:00.000Z");

	/** 실행 시각 = {@link #FIXED}의 ISO 표현. 응답 {@code at}과 모든 도래 판정이 이 값을 쓴다. */
	private static final String AT = "2026-08-25T00:00:00.000Z";

	private static final String STAMP = AT;

	private static final String PAST = "2026-08-24T00:00:00.000Z";

	private static final String FUTURE = "2026-12-31T00:00:00.000Z";

	private static final String ARTICLE_ID = "AKR20260825001";

	private static final String OTHER_ID = "AKR20260825002";

	private static final String THIRD_ID = "AKR20260825003";

	/** 두 번째 기사의 {@code createdAt} — 목록이 {@code createdAt DESC}라 처리 순서를 고정한다. */
	private static final String OLDER = "2026-08-01T00:00:00.000Z";

	private static final String ACTOR = "admin1";

	private static final String PRESS = "press";

	private static final String NONPRESS = "nonpress";

	private static final String SPOOL_WRITE_FAILED = "spool-write-failed";

	/** 정상 요약의 키 집합(정렬) — <b>정확히 6키</b>. */
	private static final List<String> TICK_KEYS = List.of("at", "distributed", "failed", "invalid", "ok", "scanned");

	/** 재진입 스킵 응답의 키 집합(정렬) — 6키 + {@code skipped}. */
	private static final List<String> SKIPPED_KEYS = List.of("at", "distributed", "failed", "invalid", "ok",
			"scanned", "skipped");

	private static final List<String> DISTRIBUTED_ITEM_KEYS = List.of("articleId", "kinds", "status");

	private static final List<String> FAILED_ITEM_KEYS = List.of("articleId", "kind", "reason", "targetId");

	private static final List<String> INVALID_ITEM_KEYS = List.of("articleId", "field");

	private static final JsonMapper JSON = JsonMapper.builder().build();

	@TempDir
	Path dataDir;

	@TempDir
	Path spoolRoot;

	private HikariDataSource dataSource;

	private JdbcClient jdbc;

	private TransactionTemplate transactions;

	private MutableClock clock;

	private ArticleRepository articles;

	private ArticleHistoryRepository history;

	private DistributionTargetRepository targets;

	private final List<TickError> errors = new ArrayList<>();

	@BeforeEach
	void setUp() {
		TempNewsDb.seed(this.dataDir);
		this.dataSource = NewsDataSource.create(this.dataDir);
		this.jdbc = JdbcClient.create(this.dataSource);
		this.transactions = new TransactionTemplate(new JdbcTransactionManager(this.dataSource));
		this.clock = new MutableClock(FIXED.toEpochMilli());
		this.articles = new ArticleRepository(this.jdbc, this.transactions, this.clock);
		this.history = new ArticleHistoryRepository(this.jdbc);
		this.targets = new DistributionTargetRepository(this.jdbc, this.transactions);
	}

	@AfterEach
	void tearDown() {
		if (this.dataSource != null) {
			this.dataSource.close();
		}
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

	private void seedArticle(String articleId, String status, String embargoAt, String secondEmbargoAt) {
		seedArticle(articleId, status, embargoAt, secondEmbargoAt, STAMP);
	}

	private void seedArticle(String articleId, String status, String embargoAt, String secondEmbargoAt,
			String createdAt) {
		this.articles.insert(row("articleId", articleId, "title", "제목", "markupVersion", "<p>본문(끝)</p>"),
				row("articleId", articleId, "title", "제목", "status", status, "embargoAt", embargoAt,
						"secondEmbargoAt", secondEmbargoAt, "createdAt", createdAt));
	}

	private long seedTarget(String name, String kind, String spoolDir) {
		return this.targets.insert(row("name", name, "kind", kind, "spoolDir", spoolDir, "active", "Y",
				"createdAt", STAMP, "updatedAt", STAMP));
	}

	private ArticleHistoryRecorder recorder(ArticleHistoryRepository historyRepo) {
		return new ArticleHistoryRecorder(historyRepo, this.clock, (error) -> {
		});
	}

	private DistributionService distribution(SpoolWriter writer, ArticleRepository articleRepo,
			ArticleHistoryRepository historyRepo) {
		return new DistributionService(this.targets, articleRepo, historyRepo, recorder(historyRepo), writer,
				this.clock, (failure) -> {
				});
	}

	/** 기본 배선 — 전부 실물이고 스풀은 임시 루트다. */
	private DistributionTickService tick() {
		return tick(this.articles, this.history, realWriter());
	}

	private DistributionTickService tick(ArticleRepository articleRepo, ArticleHistoryRepository historyRepo,
			SpoolWriter writer) {
		return tick(articleRepo, historyRepo, distribution(writer, articleRepo, historyRepo));
	}

	private DistributionTickService tick(ArticleRepository articleRepo, ArticleHistoryRepository historyRepo,
			DistributionService distribution) {
		ArticleEmbargoService embargo = new ArticleEmbargoService(articleRepo, historyRepo, recorder(historyRepo),
				this.transactions);
		return new DistributionTickService(articleRepo, historyRepo, distribution, embargo, this.clock,
				this.errors::add);
	}

	private SpoolWriter realWriter() {
		return new SpoolWriter(this.spoolRoot, this.clock);
	}

	private SpoolWriter failingWriter(List<String> failingDirs) {
		return new SpoolWriter(this.spoolRoot, this.clock, new SelectiveFs(failingDirs));
	}

	// --- 관측 헬퍼 --------------------------------------------------------------------------------

	private static List<String> sortedKeys(Map<String, Object> map) {
		return map.keySet().stream().sorted().toList();
	}

	@SuppressWarnings("unchecked")
	private static List<Map<String, Object>> items(Map<String, Object> response, String key) {
		return (List<Map<String, Object>>) response.get(key);
	}

	private static Map<String, Object> only(Map<String, Object> response, String key) {
		List<Map<String, Object>> found = items(response, key);
		assertEquals(1, found.size(), key + "가 1건이 아니다: " + found);
		return found.get(0);
	}

	private Object contentsColumn(String articleId, String column) {
		ArticleAggregate found = this.articles.findById(articleId);
		return (found == null || found.contents() == null) ? null : found.contents().column(column);
	}

	private List<Map<String, Object>> historyOf(String articleId, String eventType) {
		return this.history.queryByArticle(articleId).stream()
				.filter((row) -> eventType.equals(row.get("eventType")))
				.toList();
	}

	private List<Path> spoolFiles() {
		try (Stream<Path> walk = Files.walk(this.spoolRoot)) {
			return walk.filter(Files::isRegularFile).sorted(Comparator.comparing(Path::toString)).toList();
		}
		catch (IOException ex) {
			throw new IllegalStateException(ex);
		}
	}

	// --- seam -------------------------------------------------------------------------------------

	/** 실제 파일 연산을 하되 지정한 수신처 폴더에서만 실패하는 seam(쓰기 실패를 결정적으로 만든다). */
	private static final class SelectiveFs implements SpoolWriter.SpoolFs {

		private final List<String> failingDirs;

		SelectiveFs(List<String> failingDirs) {
			this.failingDirs = failingDirs;
		}

		private boolean fails(Path path) {
			String normalized = path.toString().replace('\\', '/');
			return this.failingDirs.stream().anyMatch((dir) -> normalized.contains("/" + dir + "/"));
		}

		@Override
		public void createDirectories(Path dir) throws IOException {
			if (fails(dir.resolve("x"))) {
				throw new IOException("planted failure");
			}
			Files.createDirectories(dir);
		}

		@Override
		public void write(Path file, byte[] bytes) throws IOException {
			if (fails(file)) {
				throw new IOException("planted failure");
			}
			Files.write(file, bytes);
		}

		@Override
		public void moveAtomically(Path source, Path target) throws IOException {
			if (fails(target)) {
				throw new IOException("planted failure");
			}
			Files.move(source, target, StandardCopyOption.ATOMIC_MOVE);
		}

	}

	/**
	 * {@code findById} <b>직전</b>에 훅을 1회 실행하는 리포지토리 — 후보 스캔과 배부 사이의 창(TOCTOU)을
	 * 결정적으로 연다. 훅이 1회인 이유: 재진입 테스트에서 무한 재귀가 되지 않게 하기 위해서다.
	 */
	private static final class HookOnFindById extends ArticleRepository {

		private final Runnable hook;

		private boolean fired;

		HookOnFindById(JdbcClient jdbc, TransactionTemplate transactions, Clock clock, Runnable hook) {
			super(jdbc, transactions, clock);
			this.hook = hook;
		}

		@Override
		public ArticleAggregate findById(String articleId) {
			if (!this.fired) {
				this.fired = true;
				this.hook.run();
			}
			return super.findById(articleId);
		}

	}

	/** 후보 조회가 던지는 리포지토리. {@code errorOnce}면 첫 조회만 {@link Error}이고 그 뒤는 정상이다. */
	private static final class ThrowingQuery extends ArticleRepository {

		private final boolean errorOnce;

		private boolean thrown;

		ThrowingQuery(JdbcClient jdbc, TransactionTemplate transactions, Clock clock, boolean errorOnce) {
			super(jdbc, transactions, clock);
			this.errorOnce = errorOnce;
		}

		@Override
		public List<harness.news.model.ContentsRow> query(Map<String, List<String>> filters) {
			if (!this.errorOnce) {
				throw new IllegalStateException("planted failure");
			}
			if (!this.thrown) {
				this.thrown = true;
				throw new PlantedError();
			}
			return super.query(filters);
		}

	}

	/** {@code RuntimeException} 가드로는 잡히지 않는 이탈 — {@code finally} 해제의 유일한 관측 창이다. */
	private static final class PlantedError extends Error {

		private static final long serialVersionUID = 1L;

	}

	/** 지정한 기사에서만 이력 조회가 던지는 리포지토리 — 기사 단위 예외를 만든다. */
	private static final class ThrowingHistory extends ArticleHistoryRepository {

		private final String failingArticleId;

		ThrowingHistory(JdbcClient jdbc, String failingArticleId) {
			super(jdbc);
			this.failingArticleId = failingArticleId;
		}

		@Override
		public List<Map<String, Object>> queryByArticle(String articleId) {
			if (this.failingArticleId.equals(articleId)) {
				throw new IllegalStateException("planted failure");
			}
			return super.queryByArticle(articleId);
		}

	}

	// --- 1. 후보 0건 -------------------------------------------------------------------------------

	/** Node 실측 1번: 엠바고가 없는 기사는 tick의 관심사가 아니다(송고 즉시 배부는 송고 훅의 몫). */
	@Test
	void aRunWithNoCandidatesReturnsTheSixKeyShape() {
		seedArticle(ARTICLE_ID, "DES", null, null);

		Map<String, Object> result = tick().run(ACTOR);

		assertEquals(TICK_KEYS, sortedKeys(result));
		assertEquals(Boolean.TRUE, result.get("ok"));
		assertEquals(AT, result.get("at"));
		assertEquals(Integer.valueOf(0), result.get("scanned"));
		assertEquals(List.of(), result.get("distributed"));
		assertEquals(List.of(), result.get("failed"));
		assertEquals(List.of(), result.get("invalid"));
		assertEquals(0, spoolFiles().size());
	}

	// --- 2. 도래 1건 -------------------------------------------------------------------------------

	/** Node 실측 2번: 1차만 설정된 기사가 도래하면 그 배부가 첫 배부이자 완결이라 {@code DPS}다. */
	@Test
	void aDueArticleIsDistributedPromotedAndStamped() {
		seedArticle(ARTICLE_ID, "DES", PAST, null);
		seedTarget("언론사1", PRESS, "press-1");

		Map<String, Object> result = tick().run(ACTOR);

		assertEquals(TICK_KEYS, sortedKeys(result));
		assertEquals(Integer.valueOf(1), result.get("scanned"));
		Map<String, Object> item = only(result, "distributed");
		assertEquals(DISTRIBUTED_ITEM_KEYS, sortedKeys(item), "distributed 원소는 정확히 3키다");
		assertEquals(ARTICLE_ID, item.get("articleId"));
		assertEquals(List.of(PRESS), item.get("kinds"));
		assertEquals("DPS", item.get("status"));
		assertEquals(List.of(), result.get("failed"));
		assertEquals(List.of(), result.get("invalid"));

		assertEquals(1, spoolFiles().size());
		assertEquals("DPS", contentsColumn(ARTICLE_ID, "status"));
		assertEquals(STAMP, contentsColumn(ARTICLE_ID, "distributedAt"));
		assertEquals(1, historyOf(ARTICLE_ID, "distribute").size());
	}

	// --- 3. 1+2차 중 1차만 도래 ---------------------------------------------------------------------

	/** Node 실측 3번: 완결 요건이 두 kind라 1차만 나가면 {@code EPS}에서 멈춘다. */
	@Test
	void onlyTheDueKindGoesOutAndTheArticleStopsAtEps() {
		seedArticle(ARTICLE_ID, "DES", PAST, FUTURE);
		seedTarget("언론사1", PRESS, "press-1");
		seedTarget("일반1", NONPRESS, "np-1");

		Map<String, Object> result = tick().run(ACTOR);

		Map<String, Object> item = only(result, "distributed");
		assertEquals(List.of(PRESS), item.get("kinds"));
		assertEquals("EPS", item.get("status"));
		assertEquals(1, spoolFiles().size(), "미도래 kind의 수신처에는 나가지 않는다");
		assertEquals("EPS", contentsColumn(ARTICLE_ID, "status"));
	}

	// --- 4. 멱등 ----------------------------------------------------------------------------------

	/** Node 실측 4번: "이미 배부됨"의 근거는 append-only 이력이라 재실행에 재배부가 없다. */
	@Test
	void aSecondRunDoesNotDistributeTheSameArticleAgain() {
		seedArticle(ARTICLE_ID, "DES", PAST, null);
		seedTarget("언론사1", PRESS, "press-1");
		DistributionTickService tick = tick();
		tick.run(ACTOR);

		this.clock.advance(3_600_000L); // 재배부가 있었다면 distributedAt이 새 시각으로 바뀐다.
		Map<String, Object> second = tick.run(ACTOR);

		assertEquals(List.of(), second.get("distributed"), "그 기사는 요약에 다시 오르지 않는다");
		assertEquals(List.of(), second.get("failed"));
		assertEquals(Integer.valueOf(1), second.get("scanned"), "후보에서 빠지지는 않는다(이력으로 거른다)");
		assertEquals(1, spoolFiles().size(), "파일이 늘지 않는다");
		assertEquals(STAMP, contentsColumn(ARTICLE_ID, "distributedAt"), "배부 시각도 그대로다");
		assertEquals(1, historyOf(ARTICLE_ID, "distribute").size());
	}

	// --- 5. 미도래 --------------------------------------------------------------------------------

	/** Node 실측 5번: 미래 엠바고는 배부하지 않고, self-heal도 바꿀 것이 없어 쓰기 0건이다. */
	@Test
	void aFutureEmbargoIsNotDistributedAndSelfHealChangesNothing() {
		seedArticle(ARTICLE_ID, "DES", FUTURE, null);
		seedTarget("언론사1", PRESS, "press-1");

		Map<String, Object> result = tick().run(ACTOR);

		assertEquals(Integer.valueOf(1), result.get("scanned"));
		assertEquals(List.of(), result.get("distributed"));
		assertEquals(List.of(), result.get("failed"));
		assertEquals(0, spoolFiles().size());
		assertEquals("DES", contentsColumn(ARTICLE_ID, "status"));
		assertNull(contentsColumn(ARTICLE_ID, "distributedAt"));
		assertEquals(List.of(), historyOf(ARTICLE_ID, "status"), "바꿀 게 없으면 이력도 0행이다");
	}

	// --- 6. 파싱 불가 엠바고 -------------------------------------------------------------------------

	/** Node 실측 6번: 오타 값은 영원히 미도래다 — 요약에 표면화한다(무음 삼킴 금지). */
	@Test
	void unparsableEmbargoValuesAreSurfacedAsInvalid() {
		seedArticle(ARTICLE_ID, "DES", "내일 아침", "언제라도");
		seedTarget("언론사1", PRESS, "press-1");

		Map<String, Object> result = tick().run(ACTOR);

		List<Map<String, Object>> invalid = items(result, "invalid");
		assertEquals(2, invalid.size());
		assertEquals(INVALID_ITEM_KEYS, sortedKeys(invalid.get(0)), "invalid 원소는 정확히 2키다");
		assertEquals(List.of(ARTICLE_ID, ARTICLE_ID), invalid.stream().map((item) -> item.get("articleId")).toList());
		assertEquals(List.of("embargoAt", "secondEmbargoAt"),
				invalid.stream().map((item) -> item.get("field")).toList());
		assertEquals(List.of(), result.get("distributed"));
		assertEquals(0, spoolFiles().size());
	}

	// --- 7. 활성 수신처 0곳 --------------------------------------------------------------------------

	/** Node 실측 7번: 도래한 kind가 성공·실패 어디에도 없는 유일한 경우 — 무음으로 사라지면 안 된다. */
	@Test
	void aDueKindWithNoActiveTargetIsReportedNotSwallowed() {
		seedArticle(ARTICLE_ID, "DES", PAST, null);

		Map<String, Object> result = tick().run(ACTOR);

		Map<String, Object> item = only(result, "failed");
		assertEquals(FAILED_ITEM_KEYS, sortedKeys(item), "failed 원소는 정확히 4키다");
		assertEquals(ARTICLE_ID, item.get("articleId"));
		assertNull(item.get("targetId"));
		assertEquals(PRESS, item.get("kind"));
		assertEquals("no-active-target", item.get("reason"));
		assertEquals(List.of(), result.get("distributed"));
		assertEquals("DES", contentsColumn(ARTICLE_ID, "status"));
	}

	// --- 8. TOCTOU: 스캔 뒤 KILL --------------------------------------------------------------------

	/** Node 실측 8번: 배부 직전 재검증에서 배부 가능 목록 밖이면 그 자리에서 멈춘다(회수 불가 방지). */
	@Test
	void anArticleKilledAfterTheScanIsStoppedWithStatusChanged() {
		seedArticle(ARTICLE_ID, "DES", PAST, null);
		seedTarget("언론사1", PRESS, "press-1");
		ArticleRepository killed = new HookOnFindById(this.jdbc, this.transactions, this.clock,
				() -> this.articles.update(ARTICLE_ID, null, row("status", "EEK")));

		Map<String, Object> result = tick(killed, this.history, realWriter()).run(ACTOR);

		Map<String, Object> item = only(result, "failed");
		assertEquals(FAILED_ITEM_KEYS, sortedKeys(item));
		assertNull(item.get("targetId"));
		assertNull(item.get("kind"));
		assertEquals("status-changed", item.get("reason"), "새 상태값은 담지 않는다");
		assertEquals(List.of(), result.get("distributed"));
		assertEquals(0, spoolFiles().size(), "킬 기사는 한 글자도 나가지 않는다");
		assertEquals("EEK", contentsColumn(ARTICLE_ID, "status"));
	}

	// --- 9. 경로 유출 0 ----------------------------------------------------------------------------

	/**
	 * 계약 {@code distribution-tick.contract.js}의 {@code assertNoSpoolPath} Java 등가 — 응답 전체
	 * 문자열에 {@code spoolDir} 키·수신처 슬러그·스풀 파일명·<b>경로 구분자</b>가 없어야 한다.
	 *
	 * <p>실물 실패 항목({@link DistributionService.Failed})은 {@code spoolDir}을 갖고 있다 — 화이트리스트
	 * 투영을 빼고 그대로 합치면 서버 파일시스템 경로가 HTTP로 나간다.
	 */
	@Test
	void theResponseNeverCarriesAServerFilesystemPath() {
		seedArticle(ARTICLE_ID, "DES", PAST, PAST);
		seedTarget("언론사1", PRESS, "ct-press-slug");
		seedTarget("일반1", NONPRESS, "ct-np-slug");

		Map<String, Object> result = tick(this.articles, this.history, failingWriter(List.of("ct-np-slug")))
				.run(ACTOR);

		assertEquals(1, items(result, "distributed").size(), "한쪽은 나가고 한쪽은 실패한 상태를 만든다");
		assertEquals(1, items(result, "failed").size());
		String raw = JSON.writeValueAsString(result);
		assertFalse(raw.contains("spoolDir"), "응답에 spoolDir 키가 실렸다: " + raw);
		assertFalse(raw.contains("ct-press-slug"), "응답에 수신처 폴더 슬러그가 실렸다");
		assertFalse(raw.contains("ct-np-slug"), "응답에 수신처 폴더 슬러그가 실렸다");
		assertFalse(raw.contains(".json"), "응답에 스풀 파일명이 실렸다");
		assertTrue(raw.indexOf('/') < 0 && raw.indexOf('\\') < 0, "응답에 경로 구분자가 실렸다: " + raw);
		assertEquals(SPOOL_WRITE_FAILED, only(result, "failed").get("reason"), "사유는 고정 토큰뿐이다");
	}

	// --- 10. 재진입·플래그 해제 ---------------------------------------------------------------------

	/** Node 실측 10번: 진행 중 재진입은 <b>스캔 없이</b> 스킵 응답 7키다. */
	@Test
	void aReentrantCallIsSkippedWithoutScanning() {
		seedArticle(ARTICLE_ID, "DES", PAST, null);
		seedTarget("언론사1", PRESS, "press-1");
		Map<String, Object>[] nested = newResponseHolder();
		DistributionTickService[] holder = new DistributionTickService[1];
		ArticleRepository reentrant = new HookOnFindById(this.jdbc, this.transactions, this.clock,
				() -> nested[0] = holder[0].run("intruder"));
		holder[0] = tick(reentrant, this.history, realWriter());

		Map<String, Object> outer = holder[0].run(ACTOR);

		assertEquals(TICK_KEYS, sortedKeys(outer));
		assertEquals(1, items(outer, "distributed").size());
		assertNotNull(nested[0], "재진입 호출이 일어나지 않았다 — seam이 무력하다");
		assertEquals(SKIPPED_KEYS, sortedKeys(nested[0]), "스킵 응답은 6키 + skipped다");
		assertEquals("in-progress", nested[0].get("skipped"));
		assertEquals(Boolean.TRUE, nested[0].get("ok"));
		assertEquals(Integer.valueOf(0), nested[0].get("scanned"), "스캔 자체를 하지 않는다");
		assertEquals(List.of(), nested[0].get("distributed"));
		assertEquals(List.of(), nested[0].get("failed"));
		assertEquals(List.of(), nested[0].get("invalid"));
		assertEquals(1, spoolFiles().size(), "재진입이 중복 배부를 만들지 않는다");

		assertEquals(TICK_KEYS, sortedKeys(holder[0].run(ACTOR)), "실행이 끝나면 다음 호출은 정상이다");
	}

	/**
	 * 플래그 해제는 {@code finally}다 — {@code RuntimeException} 가드를 뚫고 이탈하는 예외가 한 번이라도
	 * 있으면 tick이 <b>영구 무력화</b>된다(그 뒤로는 영원히 스킵 응답만 나간다).
	 */
	@Test
	void theSingleFlightFlagIsReleasedEvenWhenTheScanEscapes() {
		seedArticle(ARTICLE_ID, "DES", PAST, null);
		seedTarget("언론사1", PRESS, "press-1");
		ArticleRepository exploding = new ThrowingQuery(this.jdbc, this.transactions, this.clock, true);
		DistributionTickService tick = tick(exploding, this.history, realWriter());

		assertThrows(PlantedError.class, () -> tick.run(ACTOR), "Error는 삼키지 않는다");

		Map<String, Object> second = tick.run(ACTOR);
		assertEquals(TICK_KEYS, sortedKeys(second), "다음 호출이 스킵 응답이면 플래그가 풀리지 않은 것이다");
		assertEquals(1, items(second, "distributed").size());
	}

	// --- 11. 후보 조회 예외 -------------------------------------------------------------------------

	/** Node 실측 11번: {@code {ok:false, reason:'tick-failed'}} 2키 · 통지 1회 · <b>throw 없음</b>. */
	@Test
	void aFailingCandidateQueryReturnsTickFailedWithoutThrowing() {
		seedArticle(ARTICLE_ID, "DES", PAST, null);
		seedTarget("언론사1", PRESS, "press-1");
		ArticleRepository broken = new ThrowingQuery(this.jdbc, this.transactions, this.clock, false);

		Map<String, Object> result = tick(broken, this.history, realWriter()).run(ACTOR);

		assertEquals(List.of("ok", "reason"), sortedKeys(result), "거부 응답은 정확히 2키다");
		assertEquals(Boolean.FALSE, result.get("ok"));
		assertEquals("tick-failed", result.get("reason"));
		assertEquals(List.of(new TickError(null, "planted failure")), this.errors, "원인은 통지로만 표면화한다");
		assertEquals(0, spoolFiles().size());
	}

	// --- 12. 기사 단위 예외 -------------------------------------------------------------------------

	/** Node 실측 12번: 한 기사의 예외가 스캔을 멈추지 않는다 — 그 기사만 고정 토큰으로 남는다. */
	@Test
	void oneArticleBlowingUpDoesNotStopTheScan() {
		seedArticle(ARTICLE_ID, "DES", PAST, null);
		seedArticle(OTHER_ID, "DES", PAST, null, OLDER);
		seedTarget("언론사1", PRESS, "press-1");
		ArticleHistoryRepository broken = new ThrowingHistory(this.jdbc, ARTICLE_ID);

		Map<String, Object> result = tick(this.articles, broken, realWriter()).run(ACTOR);

		assertEquals(Integer.valueOf(2), result.get("scanned"));
		Map<String, Object> failed = only(result, "failed");
		assertEquals(FAILED_ITEM_KEYS, sortedKeys(failed));
		assertEquals(ARTICLE_ID, failed.get("articleId"));
		assertNull(failed.get("targetId"));
		assertNull(failed.get("kind"));
		assertEquals("tick-failed", failed.get("reason"), "예외 메시지가 아니라 고정 토큰이다");
		assertEquals(OTHER_ID, only(result, "distributed").get("articleId"), "뒤 기사는 계속 처리된다");
		assertEquals(List.of(new TickError(ARTICLE_ID, "planted failure")), this.errors);
	}

	// --- 13. 불변식(A) — done과 status는 항상 같은 시점 ------------------------------------------------

	/**
	 * 스냅샷 {@code DES}(사이클 범위)에서 재조회 결과가 {@code DPS}(전체 이력 범위)로 바뀌면 "이미
	 * 배부됨"도 <b>다시 세야</b> 한다. 옛 {@code done}을 그대로 쓰면 이미 나간 수신처로 중복 배부된다
	 * (회수 불가).
	 */
	@Test
	void theAlreadyDistributedSetIsRecountedWhenTheStatusChangedUnderneath() {
		seedArticle(ARTICLE_ID, "DES", PAST, null);
		seedTarget("언론사1", PRESS, "press-1");
		// 지난 사이클의 배부(id 1) → 그 뒤 재송고(id 2). DES 판정에서는 경계 밖이라 세지 않는다.
		this.history.insert(row("articleId", ARTICLE_ID, "eventType", "distribute", "action", PRESS,
				"actorUserId", ACTOR, "createdAt", OLDER));
		this.history.insert(row("articleId", ARTICLE_ID, "eventType", "status", "action", "send",
				"actorUserId", ACTOR, "createdAt", STAMP));
		ArticleRepository completed = new HookOnFindById(this.jdbc, this.transactions, this.clock,
				() -> this.articles.update(ARTICLE_ID, null, row("status", "DPS")));

		Map<String, Object> result = tick(completed, this.history, realWriter()).run(ACTOR);

		assertEquals(0, spoolFiles().size(), "전체 이력 기준으로는 이미 나간 kind다 — 다시 보내지 않는다");
		assertEquals(List.of(), result.get("distributed"));
		assertEquals(List.of(), result.get("failed"));
		assertEquals(1, historyOf(ARTICLE_ID, "distribute").size(), "새 배부 이력도 없다");
	}

	// --- 14. scanned의 의미 -------------------------------------------------------------------------

	/** {@code scanned}는 <b>엠바고 필터를 통과한 후보 수</b>다(전체 조회 수가 아니다). */
	@Test
	void scannedCountsCandidatesAfterTheEmbargoFilter() {
		seedArticle(ARTICLE_ID, "DES", FUTURE, null);
		seedArticle(OTHER_ID, "DES", null, null, OLDER);
		seedArticle(THIRD_ID, "RDS", FUTURE, null, OLDER);

		Map<String, Object> result = tick().run(ACTOR);

		assertEquals(Integer.valueOf(1), result.get("scanned"),
				"엠바고 미설정 기사와 미송고 상태(RDS)는 후보가 아니다");
		assertEquals(List.of(), result.get("distributed"));
		assertEquals(List.of(), result.get("failed"));
	}

	// --- 15. 시계는 실행당 1회 ----------------------------------------------------------------------

	/** 같은 실행 안에서 시각이 흔들리면 기사마다 판정이 갈린다 — {@code at}은 실행 시작의 값 하나다. */
	@Test
	void theClockIsReadOncePerRun() {
		seedArticle(ARTICLE_ID, "DES", PAST, null);
		seedArticle(OTHER_ID, "DES", "2026-09-15T00:00:00.000Z", null, OLDER);
		seedTarget("언론사1", PRESS, "press-1");
		// 첫 기사의 재조회 시점에 시계를 60일 전진시킨다 — 둘째 기사의 엠바고는 그 사이에 "도래"한다.
		ArticleRepository advancing = new HookOnFindById(this.jdbc, this.transactions, this.clock,
				() -> this.clock.advance(60L * 24 * 3600 * 1000));

		Map<String, Object> result = tick(advancing, this.history, realWriter()).run(ACTOR);

		assertEquals(AT, result.get("at"), "at은 실행 시작 시각 하나다");
		assertEquals(Integer.valueOf(2), result.get("scanned"));
		assertEquals(List.of(ARTICLE_ID),
				items(result, "distributed").stream().map((item) -> item.get("articleId")).toList(),
				"실행 중 전진한 시계로 둘째 기사가 도래해서는 안 된다");
		assertEquals(1, spoolFiles().size());
		assertEquals("DES", contentsColumn(OTHER_ID, "status"));
	}

	// --- 16. 전 수신처 쓰기 실패 → 거짓 완결 금지 ------------------------------------------------------

	/**
	 * 승격의 근거는 <b>실제 스풀 기록에 성공한 kind</b>뿐이다. 전 수신처가 실패했는데도 요약에 오르고
	 * 승격까지 되면 배부되지 않은 기사가 완결 처리되어 <b>다음 tick이 재시도하지 않는다</b>(거짓 완결).
	 *
	 * <p>계약은 이 축을 관측하지 못한다(excluded (f) — 스풀 쓰기 실패를 API로 만들 수 없다). 이 테스트가
	 * tick의 유일한 방어선이다.
	 */
	@Test
	void everyTargetFailingKeepsTheArticleOutOfTheDistributedSummary() {
		seedArticle(ARTICLE_ID, "DES", PAST, null);
		long first = seedTarget("언론사1", PRESS, "bad-1");
		long second = seedTarget("언론사2", PRESS, "bad-2");

		Map<String, Object> result = tick(this.articles, this.history, failingWriter(List.of("bad-1", "bad-2")))
				.run(ACTOR);

		assertEquals(List.of(), result.get("distributed"), "나간 것이 없으면 요약에도 오르지 않는다");
		List<Map<String, Object>> failed = items(result, "failed");
		assertEquals(2, failed.size(), "수신처마다 한 건씩 남는다");
		assertEquals(List.of(Long.valueOf(first), Long.valueOf(second)),
				failed.stream().map((item) -> item.get("targetId")).toList());
		assertEquals(List.of(SPOOL_WRITE_FAILED, SPOOL_WRITE_FAILED),
				failed.stream().map((item) -> item.get("reason")).toList());
		assertEquals("DES", contentsColumn(ARTICLE_ID, "status"), "승격이 일어나서는 안 된다");
		assertNull(contentsColumn(ARTICLE_ID, "distributedAt"), "배부 시각도 갱신되지 않는다");
		assertEquals(List.of(), historyOf(ARTICLE_ID, "distribute"));
		assertEquals(List.of(), historyOf(ARTICLE_ID, "status"));
		assertTrue(spoolFiles().isEmpty());
	}

	@SuppressWarnings("unchecked")
	private static Map<String, Object>[] newResponseHolder() {
		return new Map[1];
	}

}
