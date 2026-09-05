package harness.news.service;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.zaxxer.hikari.HikariDataSource;
import harness.news.db.NewsDataSource;
import harness.news.model.ArticleAggregate;
import harness.news.model.ArticleHistoryRepository;
import harness.news.model.ArticleRepository;
import harness.news.model.DistributionTargetRepository;
import harness.news.service.DistributionRetryService.RetryFailure;
import harness.news.testsupport.MutableClock;
import harness.news.testsupport.TempNewsDb;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
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
 * 배부 실패 조회·재전송 서비스 — 리포 루트 {@code src/services/distributionRetryService.js}(259행)의 동작
 * 계약.
 *
 * <p>기준값은 <b>Node 실측</b>이다(2026-08-26 · 가짜 모델로 원본 {@code createDistributionRetryService}를
 * 직접 호출해 상수 3종·{@code limit} 정규화 12종·게이트 9종·성공/실패 경로의 insert·update·통지를 표로
 * 떴다). 계획서 문구가 아니라 그 표가 정본이다.
 *
 * <p>임시 파일 DB({@code @TempDir})와 임시 스풀 루트만 쓴다 — 리포 {@code news.db}도 {@code uploads/}도
 * 열지 않는다.
 */
class DistributionRetryServiceTest {

	private static final JsonMapper JSON = JsonMapper.builder().build();

	private static final Instant FIXED = Instant.parse("2026-08-26T00:00:00.000Z");

	private static final String STAMP = "2026-08-26T00:00:00.000Z";

	private static final String ARTICLE_ID = "AKR20260826001";

	private static final String OTHER_ARTICLE_ID = "AKR20260826002";

	private static final String ACTOR = "z9";

	private static final String PRESS = "press";

	private static final String NONPRESS = "nonpress";

	private static final String DISTRIBUTE = "distribute";

	private static final String DISTRIBUTE_FAILED = "distribute-failed";

	private static final String DISTRIBUTE_RETRY = "distribute-retry";

	private static final String SPOOL_WRITE_FAILED = "spool-write-failed";

	private static final String INVALID_SPOOL_DIR = "invalid-spool-dir";

	private static final String NO_FAILURE = "no-failure";

	private static final String ITEMS = "items";

	private static final String REASON = "reason";

	private static final String TARGET_ID = "targetId";

	private static final String HISTORY_ID = "historyId";

	/** 계약 {@code distribution-tick.contract.js}의 {@code FAILURE_ITEM_KEYS}(정렬된 10키) 그대로. */
	private static final List<String> FAILURE_ITEM_KEYS = List.of(
			"articleId", "failedAt", "historyId", "kind", "kindDistributed",
			"reason", "targetActive", "targetId", "targetKind", "targetName");

	/** 성공 반환의 정렬된 5키 — {@code file}·{@code spoolDir}은 없다. */
	private static final List<String> RETRY_OK_KEYS = List.of("articleId", "at", "kind", "ok", "targetId");

	/**
	 * 표시용 목록 창을 넘기고도 남는 최신 이벤트 수 — Node 실측(2026-08-26) {@code DEFAULT_LIST_LIMIT=200} ·
	 * {@code MAX_LIST_LIMIT=1000}을 둘 다 넘긴다. 재전송 게이트의 스캔은 {@code RETRY_SCAN_LIMIT=1000000}
	 * (사실상 무제한)이라 그 밖으로 밀린 오래된 실패도 보인다.
	 */
	private static final int BEYOND_DISPLAY_WINDOW = 1010;

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

	private final List<RetryFailure> failures = new ArrayList<>();

	private final List<ArticleHistoryRecorder.HistoryError> historyErrors = new ArrayList<>();

	@BeforeEach
	void setUp() {
		TempNewsDb.seed(this.dataDir);
		this.dataSource = NewsDataSource.create(this.dataDir);
		this.jdbc = JdbcClient.create(this.dataSource);
		this.transactions = new TransactionTemplate(new JdbcTransactionManager(this.dataSource));
		this.clock = new MutableClock(FIXED.toEpochMilli());
		this.articles = new ArticleRepository(this.jdbc, this.transactions, this.clock);
		this.history = new ArticleHistoryRepository(this.jdbc);
		this.targets = new DistributionTargetRepository(this.jdbc);
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

	private void seedArticle(String articleId, String status) {
		this.articles.insert(row("articleId", articleId, "title", "제목", "markupVersion", "<p>본문(끝)</p>"),
				row("articleId", articleId, "title", "제목", "status", status, "createdAt", STAMP));
	}

	private long seedTarget(String name, String kind, String spoolDir, String active) {
		return this.targets.insert(row("name", name, "kind", kind, "spoolDir", spoolDir, "active", active,
				"createdAt", STAMP, "updatedAt", STAMP));
	}

	private long seedFailure(String articleId, String kind, long targetId, String reason) {
		return this.history.insert(row("articleId", articleId, "eventType", DISTRIBUTE_FAILED, "action", kind,
				"targetId", Long.valueOf(targetId), "reason", reason, "actorUserId", ACTOR, "createdAt", STAMP));
	}

	private long seedRetryRow(String articleId, String kind, long targetId) {
		return this.history.insert(row("articleId", articleId, "eventType", DISTRIBUTE_RETRY, "action", kind,
				"targetId", Long.valueOf(targetId), "actorUserId", ACTOR, "createdAt", STAMP));
	}

	/** 사이클 경계 행 — {@code eventType='status'} · {@code action='send'}만 경계가 된다. */
	private long seedSendRow(String articleId) {
		return this.history.insert(row("articleId", articleId, "eventType", "status", "action", "send",
				"fromStatus", "DPT", "toStatus", "DES", "actorUserId", ACTOR, "createdAt", STAMP));
	}

	private long seedDistributeRow(String articleId, String kind) {
		return this.history.insert(row("articleId", articleId, "eventType", DISTRIBUTE, "action", kind,
				"actorUserId", ACTOR, "createdAt", STAMP));
	}

	private DistributionRetryService service(SpoolWriter writer) {
		return service(writer, this.history, this.targets, this.articles);
	}

	/** 읽기는 진짜 리포지토리로, 이력 쓰기만 주어진 리포지토리로 한다(이력 insert 실패 재현용). */
	private DistributionRetryService service(SpoolWriter writer, ArticleHistoryRepository writeHistory,
			DistributionTargetRepository targetRepo, ArticleRepository articleRepo) {
		ArticleHistoryRecorder recorder = new ArticleHistoryRecorder(writeHistory, this.clock,
				this.historyErrors::add);
		return new DistributionRetryService(this.history, recorder, targetRepo, articleRepo, writer,
				this.transactions, this.clock, this.failures::add);
	}

	/** 읽기·쓰기 모두 주어진 리포지토리로 한다(호출 계수 스파이용). */
	private DistributionRetryService serviceReading(SpoolWriter writer, ArticleHistoryRepository spyHistory,
			DistributionTargetRepository targetRepo, ArticleRepository articleRepo) {
		ArticleHistoryRecorder recorder = new ArticleHistoryRecorder(spyHistory, this.clock,
				this.historyErrors::add);
		return new DistributionRetryService(spyHistory, recorder, targetRepo, articleRepo, writer,
				this.transactions, this.clock, this.failures::add);
	}

	private SpoolWriter realWriter() {
		return new SpoolWriter(this.spoolRoot, this.clock);
	}

	private SpoolWriter writer(SpoolWriter.SpoolFs fs) {
		return new SpoolWriter(this.spoolRoot, this.clock, fs);
	}

	/** 실패 1건 + 활성 수신처 1곳 + 배부 가능 기사 — 성공 경로의 최소 픽스처. */
	private long seedRetryableFailure() {
		seedArticle(ARTICLE_ID, "DPS");
		long target = seedTarget("언론사1", PRESS, "press-a", "Y");
		return seedFailure(ARTICLE_ID, PRESS, target, SPOOL_WRITE_FAILED);
	}

	// --- 관측 헬퍼 --------------------------------------------------------------------------------

	private List<Map<String, Object>> ledger(String articleId) {
		return this.history.queryDistributionEvents(articleId, null);
	}

	private long historyRowCount() {
		return this.jdbc.sql("SELECT COUNT(*) FROM ArticleHistory").query(Long.class).single().longValue();
	}

	private Object contentsColumn(String articleId, String column) {
		ArticleAggregate found = this.articles.findById(articleId);
		return (found == null || found.contents() == null) ? null : found.contents().column(column);
	}

	private List<Path> spoolFiles() {
		try (Stream<Path> walk = Files.walk(this.spoolRoot)) {
			return walk.filter(Files::isRegularFile).sorted(Comparator.comparing(Path::toString)).toList();
		}
		catch (IOException ex) {
			throw new IllegalStateException(ex);
		}
	}

	@SuppressWarnings("unchecked")
	private static List<Map<String, Object>> items(Map<String, Object> result) {
		return (List<Map<String, Object>>) result.get(ITEMS);
	}

	/** 직렬화된 키 집합 — 맵이든 레코드든 "밖으로 나가는 모양"을 본다. */
	private static List<String> sortedKeys(Object value) {
		Map<?, ?> serialized = JSON.readValue(JSON.writeValueAsString(value), Map.class);
		return serialized.keySet().stream().map(String::valueOf).sorted().toList();
	}

	// --- 스파이 ------------------------------------------------------------------------------------

	/** 모든 조회·삽입을 세는 이력 리포지토리 — "DB 무접촉"을 행동으로 단언한다. */
	private static final class CountingHistory extends ArticleHistoryRepository {

		private final AtomicInteger anyCall = new AtomicInteger();

		private final List<Integer> limits = new ArrayList<>();

		CountingHistory(JdbcClient jdbc) {
			super(jdbc);
		}

		@Override
		public List<Map<String, Object>> queryDistributionEvents(String articleId, Integer limit) {
			this.anyCall.incrementAndGet();
			this.limits.add(limit);
			return super.queryDistributionEvents(articleId, limit);
		}

		@Override
		public Map<String, Object> getDistributionEventById(long id) {
			this.anyCall.incrementAndGet();
			return super.getDistributionEventById(id);
		}

		@Override
		public List<Map<String, Object>> queryByArticle(String articleId) {
			this.anyCall.incrementAndGet();
			return super.queryByArticle(articleId);
		}

		@Override
		public long insert(Map<String, ?> record) {
			this.anyCall.incrementAndGet();
			return super.insert(record);
		}

	}

	private static final class CountingTargets extends DistributionTargetRepository {

		private final AtomicInteger findById = new AtomicInteger();

		CountingTargets(JdbcClient jdbc) {
			super(jdbc);
		}

		@Override
		public Optional<Map<String, Object>> findById(double id) {
			this.findById.incrementAndGet();
			return super.findById(id);
		}

	}

	private static final class CountingArticles extends ArticleRepository {

		private final AtomicInteger anyCall = new AtomicInteger();

		CountingArticles(JdbcClient jdbc, TransactionTemplate transactions, MutableClock clock) {
			super(jdbc, transactions, clock);
		}

		@Override
		public ArticleAggregate findById(String articleId) {
			this.anyCall.incrementAndGet();
			return super.findById(articleId);
		}

		@Override
		public StatusLookup findStatus(String articleId) {
			this.anyCall.incrementAndGet();
			return super.findStatus(articleId);
		}

		@Override
		public int update(String articleId, Map<String, ?> article, Map<String, ?> contents) {
			this.anyCall.incrementAndGet();
			return super.update(articleId, article, contents);
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

	/** 지정한 수신처 폴더에서만 실패하는 파일 seam. */
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
	 * 게시 직전에 멈추는 파일 seam — 재전송 1건이 <b>쓰기 중</b>인 창을 결정적으로 연다.
	 *
	 * <p>{@code retry-in-flight}는 원장 시드로는 도달하지 않는다(동시 실행이 있어야 한다). main 소스에
	 * 지연을 심는 것은 ADR-008 정적 게이트가 막으므로 지연은 <b>테스트 전용 seam</b>에만 둔다.
	 */
	private static final class BlockingFs implements SpoolWriter.SpoolFs {

		private final CountDownLatch entered = new CountDownLatch(1);

		private final CountDownLatch release = new CountDownLatch(1);

		private volatile boolean armed = true;

		@Override
		public void createDirectories(Path dir) throws IOException {
			Files.createDirectories(dir);
		}

		@Override
		public void write(Path file, byte[] bytes) throws IOException {
			Files.write(file, bytes);
		}

		@Override
		public void moveAtomically(Path source, Path target) throws IOException {
			if (this.armed) {
				this.armed = false;
				this.entered.countDown();
				try {
					this.release.await(30, TimeUnit.SECONDS);
				}
				catch (InterruptedException ex) {
					Thread.currentThread().interrupt();
					throw new IOException(ex);
				}
			}
			Files.move(source, target, StandardCopyOption.ATOMIC_MOVE);
		}

	}

	// ==============================================================================================
	// list
	// ==============================================================================================

	/** Node 실측 A2: 항목은 <b>정확히 10키</b>(계약 {@code FAILURE_ITEM_KEYS})이고 값은 원장 + 수신처다. */
	@Test
	void listItemsCarryExactlyTheTenContractKeys() {
		seedArticle(ARTICLE_ID, "DPS");
		long press = seedTarget("언론사1", PRESS, "press-a", "Y");
		long nonpress = seedTarget("일반1", NONPRESS, "np-b", "N");
		long older = seedFailure(ARTICLE_ID, NONPRESS, nonpress, INVALID_SPOOL_DIR);
		long newer = seedFailure(ARTICLE_ID, PRESS, press, SPOOL_WRITE_FAILED);

		Map<String, Object> result = service(realWriter()).list(null);

		assertEquals(List.of("items", "ok"), sortedKeys(result));
		assertEquals(Boolean.TRUE, result.get("ok"));
		assertEquals(2, items(result).size());
		assertEquals(List.of(Long.valueOf(newer), Long.valueOf(older)),
				items(result).stream().map((item) -> item.get(HISTORY_ID)).toList(), "historyId DESC");
		for (Map<String, Object> item : items(result)) {
			assertEquals(FAILURE_ITEM_KEYS, sortedKeys(item), "항목 키 집합");
		}

		Map<String, Object> first = items(result).get(0);
		assertEquals(ARTICLE_ID, first.get("articleId"));
		assertEquals(Long.valueOf(press), first.get(TARGET_ID), "정수를 소수점 없이 싣는다");
		assertEquals(PRESS, first.get("kind"));
		assertEquals(SPOOL_WRITE_FAILED, first.get(REASON));
		assertEquals(STAMP, first.get("failedAt"));
		assertEquals("언론사1", first.get("targetName"));
		assertEquals("Y", first.get("targetActive"));
		assertEquals(PRESS, first.get("targetKind"));
		assertEquals(Boolean.FALSE, first.get("kindDistributed"));

		Map<String, Object> second = items(result).get(1);
		assertEquals("일반1", second.get("targetName"));
		assertEquals("N", second.get("targetActive"), "비활성 수신처는 그대로 보인다");
		assertEquals(NONPRESS, second.get("targetKind"));
		assertEquals(INVALID_SPOOL_DIR, second.get(REASON));
	}

	/** Node 실측 A4/A7: 수신처 행이 사라졌으면 이름·kind는 {@code null}, active는 <b>{@code 'N'}</b>이다. */
	@Test
	void aFailureWhoseTargetRowIsGoneFallsBackToInactive() {
		seedArticle(ARTICLE_ID, "DPS");
		seedFailure(ARTICLE_ID, PRESS, 4242L, SPOOL_WRITE_FAILED);

		Map<String, Object> item = items(service(realWriter()).list(null)).get(0);

		assertEquals(FAILURE_ITEM_KEYS, sortedKeys(item), "값이 없어도 키는 보존된다");
		assertNull(item.get("targetName"));
		assertNull(item.get("targetKind"));
		assertEquals("N", item.get("targetActive"), "재전송 불가 쪽으로 폴백한다");
	}

	/**
	 * Node 실측 A6: {@code kindDistributed}는 <b>이번 사이클</b> 판정({@code cycleDistributedKinds})이다.
	 *
	 * <p>전체 이력({@code distributedKinds})으로 바꾸면 재송고로 새 사이클이 열린 기사에서 과거 사이클
	 * 배부 행에 가려져 {@code true}가 되고, 경고가 막으려던 중복 배부가 무경고로 지나간다.
	 */
	@Test
	void kindDistributedCountsOnlyTheCurrentCycle() {
		seedArticle(ARTICLE_ID, "DES");
		long target = seedTarget("언론사1", PRESS, "press-a", "Y");
		seedDistributeRow(ARTICLE_ID, PRESS); // 지난 사이클의 배부
		seedSendRow(ARTICLE_ID);              // 재송고 — 여기서 새 사이클이 열린다
		seedFailure(ARTICLE_ID, PRESS, target, SPOOL_WRITE_FAILED);

		assertEquals(Boolean.FALSE, items(service(realWriter()).list(null)).get(0).get("kindDistributed"),
				"지난 사이클의 배부는 이번 사이클의 '이미 배부됨'이 아니다");

		seedDistributeRow(ARTICLE_ID, PRESS); // 이번 사이클의 배부
		assertEquals(Boolean.TRUE, items(service(realWriter()).list(null)).get(0).get("kindDistributed"));
	}

	/** 사이클 밖 상태({@code DPS})는 전체 이력 판정이다 — Node 실측 A6. */
	@Test
	void aCompletedArticleIsJudgedOnItsWholeHistory() {
		seedArticle(ARTICLE_ID, "DPS");
		long target = seedTarget("언론사1", PRESS, "press-a", "Y");
		seedDistributeRow(ARTICLE_ID, PRESS);
		seedSendRow(ARTICLE_ID);
		seedFailure(ARTICLE_ID, PRESS, target, SPOOL_WRITE_FAILED);

		assertEquals(Boolean.TRUE, items(service(realWriter()).list(null)).get(0).get("kindDistributed"));
	}

	/**
	 * Node 실측 A1: {@code limit} 정규화는 <b>정수 ≥1이 아니면 기본값 200</b>, 맞으면 {@code min(limit,1000)}.
	 *
	 * <p>{@code '5'}가 200인 것은 오타가 아니다 — {@code Number.isInteger('5')}는 거짓이다. HTTP 경계의
	 * {@code Number(req.query.limit)} 변환은 <b>라우트</b>의 몫이고(step9), 이 서비스는 그 뒤의 정규화만
	 * 소유한다. 두 단계를 한 곳에 합치면 반복 쿼리 키({@code ?limit=1&limit=2})의 Node 의미론이 흐려진다.
	 */
	@Test
	void theListLimitIsNormalizedLikeNode() {
		seedArticle(ARTICLE_ID, "DPS");
		CountingHistory spy = new CountingHistory(this.jdbc);
		DistributionRetryService service = serviceReading(realWriter(), spy, this.targets, this.articles);

		List<Object> inputs = new ArrayList<>();
		inputs.add(null);
		inputs.add(Integer.valueOf(0));
		inputs.add(Integer.valueOf(-1));
		inputs.add(Integer.valueOf(1));
		inputs.add(Double.valueOf(1e9));
		inputs.add("abc");
		inputs.add(Double.valueOf(200.5));
		inputs.add(Integer.valueOf(1000));
		inputs.add(Integer.valueOf(1001));
		inputs.add(Boolean.TRUE);
		inputs.add("5");
		inputs.add(Double.valueOf(Double.NaN));
		for (Object input : inputs) {
			service.list(input);
		}

		assertEquals(List.of(200, 200, 200, 1, 1000, 200, 200, 1000, 1000, 200, 200, 200), spy.limits,
				"Node 실측표와 어긋난다");
	}

	/** 스풀 미설정이어도 목록은 결선된다(minimal 프로파일의 200) — Node 실측 동형. */
	@Test
	void theListWorksWithoutASpoolRoot() {
		seedArticle(ARTICLE_ID, "DPS");
		long target = seedTarget("언론사1", PRESS, "press-a", "Y");
		seedFailure(ARTICLE_ID, PRESS, target, SPOOL_WRITE_FAILED);

		Map<String, Object> result = service(null).list(null);

		assertEquals(Boolean.TRUE, result.get("ok"));
		assertEquals(1, items(result).size());
	}

	/**
	 * Node 실측 A3: 수신처 조회는 <b>호출당</b> targetId 1회다. 호출 <b>사이</b>에는 캐시하지 않는다 —
	 * 수신처의 active·kind 변경이 다음 조회에 즉시 보여야 한다(재전송 가능 여부 안내의 근거값이다).
	 */
	@Test
	void theTargetIsLookedUpOncePerCallAndNeverCachedAcrossCalls() {
		seedArticle(ARTICLE_ID, "DPS");
		long target = seedTarget("언론사1", PRESS, "press-a", "Y");
		seedFailure(ARTICLE_ID, PRESS, target, SPOOL_WRITE_FAILED);
		seedFailure(ARTICLE_ID, NONPRESS, target, SPOOL_WRITE_FAILED);
		CountingTargets spy = new CountingTargets(this.jdbc);
		DistributionRetryService service = service(realWriter(), this.history, spy, this.articles);

		assertEquals(2, items(service.list(null)).size());
		assertEquals(1, spy.findById.get(), "같은 수신처는 한 번만 조회한다");

		service.list(null);
		assertEquals(2, spy.findById.get(), "호출 사이에 캐시하지 않는다");
	}

	/** 목록에는 서버 파일시스템 경로가 한 글자도 실리지 않는다(투영은 화이트리스트다). */
	@Test
	void theListNeverCarriesAServerFilesystemPath() {
		seedArticle(ARTICLE_ID, "DPS");
		long target = seedTarget("언론사1", PRESS, "ct-press-slug", "Y");
		seedFailure(ARTICLE_ID, PRESS, target, SPOOL_WRITE_FAILED);

		String raw = JSON.writeValueAsString(service(realWriter()).list(null));

		assertFalse(raw.contains("spoolDir"), "응답에 spoolDir 키가 실렸다: " + raw);
		assertFalse(raw.contains("ct-press-slug"), "응답에 수신처 폴더 슬러그가 실렸다: " + raw);
		assertFalse(raw.contains(".json"), "응답에 스풀 파일명이 실렸다: " + raw);
		assertTrue(raw.indexOf('/') < 0 && raw.indexOf('\\') < 0, "응답에 경로 구분자가 실렸다: " + raw);
	}

	// ==============================================================================================
	// retry — 게이트
	// ==============================================================================================

	/** Node 실측 B1 — (a) 스풀 미설정은 <b>DB를 건드리기 전에</b> 거부한다. */
	@Test
	void spoolDisabledIsDecidedWithoutTouchingTheDatabase() {
		long failureId = seedRetryableFailure();
		CountingHistory historySpy = new CountingHistory(this.jdbc);
		CountingTargets targetSpy = new CountingTargets(this.jdbc);
		CountingArticles articleSpy = new CountingArticles(this.jdbc, this.transactions, this.clock);

		Map<String, Object> result = serviceReading(null, historySpy, targetSpy, articleSpy)
				.retry(Long.valueOf(failureId), ACTOR);

		assertEquals(List.of("ok", "reason"), sortedKeys(result), "거부는 정확히 2키다");
		assertEquals(Boolean.FALSE, result.get("ok"));
		assertEquals(SpoolWriter.SPOOL_DISABLED, result.get(REASON));
		assertEquals(0, historySpy.anyCall.get(), "이력 리포지토리를 불렀다");
		assertEquals(0, targetSpy.findById.get(), "수신처 리포지토리를 불렀다");
		assertEquals(0, articleSpy.anyCall.get(), "기사 리포지토리를 불렀다");
	}

	/**
	 * Node 실측 B2 — 무효 식별자는 즉시 {@code no-failure}이고 <b>어떤 이력 조회도 하지 않는다</b>
	 * (전역 스캔 봉쇄: {@code Number('')=0}·{@code Number(undefined)=NaN}이 조회 인자로 흘러들면 안 된다).
	 */
	@Test
	void anInvalidHistoryIdIsRejectedWithoutAnyLedgerQuery() {
		seedRetryableFailure();
		CountingHistory spy = new CountingHistory(this.jdbc);
		DistributionRetryService service = serviceReading(realWriter(), spy, this.targets, this.articles);

		List<Object> invalid = new ArrayList<>();
		invalid.add(null);
		invalid.add("");
		invalid.add("abc");
		invalid.add(Integer.valueOf(0));
		invalid.add(Integer.valueOf(-1));
		invalid.add(Double.valueOf(1.5));
		invalid.add(Boolean.TRUE);
		invalid.add(Map.of());
		invalid.add(List.of());
		invalid.add(Double.valueOf(Double.NaN));
		for (Object value : invalid) {
			Map<String, Object> result = service.retry(value, ACTOR);
			assertEquals(Boolean.FALSE, result.get("ok"), "historyId=" + value);
			assertEquals(NO_FAILURE, result.get(REASON), "historyId=" + value);
		}

		assertEquals(0, spy.anyCall.get(), "무효 식별자로 DB를 조회했다 — 전역 스캔 봉쇄가 뚫렸다");
	}

	/** Node 실측 B3/C1 — 없는 id·배부 이벤트가 아닌 행은 {@code no-failure}다. */
	@Test
	void anUnknownOrNonDistributionEventIsNoFailure() {
		long failureId = seedRetryableFailure();
		long statusRow = seedSendRow(ARTICLE_ID);
		DistributionRetryService service = service(realWriter());

		assertEquals(NO_FAILURE, service.retry(Long.valueOf(failureId + 9999), ACTOR).get(REASON));
		assertEquals(NO_FAILURE, service.retry(Long.valueOf(statusRow), ACTOR).get(REASON),
				"전이 이력 행이 재전송 경로로 새면 임의 배부가 된다");
		assertEquals(0, spoolFiles().size());
	}

	/**
	 * (b) 미해소 집합 멤버십 — <b>보안 핵심</b>이다. 그룹의 최신이 아닌 실패 id는 목록에 없으므로
	 * 재전송도 통과하지 못한다(목록과 게이트가 같은 파생 하나를 쓴다).
	 */
	@Test
	void aFailureThatIsNoLongerTheLatestInItsGroupIsNoFailure() {
		seedArticle(ARTICLE_ID, "DPS");
		long target = seedTarget("언론사1", PRESS, "press-a", "Y");
		long stale = seedFailure(ARTICLE_ID, PRESS, target, SPOOL_WRITE_FAILED);
		seedRetryRow(ARTICLE_ID, PRESS, target); // 해소됨 — 그룹의 최신은 retry 행이다

		Map<String, Object> result = service(realWriter()).retry(Long.valueOf(stale), ACTOR);

		assertEquals(NO_FAILURE, result.get(REASON));
		assertEquals(0, spoolFiles().size(), "해소된 실패로는 한 글자도 나가지 않는다");
	}

	/**
	 * Node 실측 C3 — (b') {@code stale-cycle}: 실패 행이 마지막 송고 경계보다 앞(id ≤ 경계)이면 거부한다.
	 * 경계 미확정({@code null})이면 거부하지 않는다(기존 복구 경로 보존).
	 */
	@Test
	void aFailureFromAPreviousSendCycleIsRejected() {
		seedArticle(ARTICLE_ID, "DPS");
		long target = seedTarget("언론사1", PRESS, "press-a", "Y");
		long failureId = seedFailure(ARTICLE_ID, PRESS, target, SPOOL_WRITE_FAILED);
		seedSendRow(ARTICLE_ID); // 재송고 — 실패 행보다 뒤(id가 크다)

		Map<String, Object> result = service(realWriter()).retry(Long.valueOf(failureId), ACTOR);

		assertEquals(Boolean.FALSE, result.get("ok"));
		assertEquals("stale-cycle", result.get(REASON));
		assertEquals(0, spoolFiles().size(), "미도래 스풀 유출 금지");
	}

	/** 경계가 실패 행보다 <b>앞</b>이면 이번 사이클의 실패다 — 재전송이 성립한다(Node 실측 C3c). */
	@Test
	void aFailureAfterTheSendBoundaryIsRetryable() {
		seedArticle(ARTICLE_ID, "DPS");
		long target = seedTarget("언론사1", PRESS, "press-a", "Y");
		seedSendRow(ARTICLE_ID);
		long failureId = seedFailure(ARTICLE_ID, PRESS, target, SPOOL_WRITE_FAILED);

		assertEquals(Boolean.TRUE, service(realWriter()).retry(Long.valueOf(failureId), ACTOR).get("ok"));
	}

	/**
	 * (c) {@code retry-in-flight} — 같은 수신처로 동시에 두 번 나가지 않는다(해소 이력은 쓰기 <b>뒤</b>에
	 * 남아 동시 실행의 게이트 조회에는 보이지 않는다). 해제는 {@code finally}이므로 그 뒤 재전송은 산다.
	 */
	@Test
	void aConcurrentRetryForTheSameTargetIsRejectedAndTheKeyIsReleased() throws Exception {
		seedArticle(ARTICLE_ID, "DPS");
		long target = seedTarget("언론사1", PRESS, "press-a", "Y");
		long failureId = seedFailure(ARTICLE_ID, PRESS, target, SPOOL_WRITE_FAILED);
		BlockingFs blocking = new BlockingFs();
		DistributionRetryService service = service(writer(blocking));

		ExecutorService pool = Executors.newSingleThreadExecutor();
		try {
			Future<Map<String, Object>> first = pool.submit(() -> service.retry(Long.valueOf(failureId), ACTOR));
			assertTrue(blocking.entered.await(30, TimeUnit.SECONDS), "쓰기 창이 열리지 않았다");

			Map<String, Object> second = service.retry(Long.valueOf(failureId), ACTOR);
			assertEquals(Boolean.FALSE, second.get("ok"));
			assertEquals("retry-in-flight", second.get(REASON));

			blocking.release.countDown();
			assertEquals(Boolean.TRUE, first.get(30, TimeUnit.SECONDS).get("ok"));
		}
		finally {
			pool.shutdownNow();
		}

		assertEquals(1, spoolFiles().size(), "겹친 호출이 같은 수신처로 두 번 나갔다");

		// 해제 확인 — 새 실패가 쌓이면 같은 (기사,수신처) 재전송이 다시 통과해야 한다.
		this.clock.advance(1000L);
		long again = seedFailure(ARTICLE_ID, PRESS, target, SPOOL_WRITE_FAILED);
		assertEquals(Boolean.TRUE, service.retry(Long.valueOf(again), ACTOR).get("ok"),
				"in-flight 키가 영구 봉쇄됐다");
		assertEquals(2, spoolFiles().size());
	}

	/** Node 실측 B7/C2 — (d) 대상 없음은 {@code not-found}, 비활성은 {@code inactive}다. */
	@Test
	void anInactiveOrMissingTargetIsRejected() {
		seedArticle(ARTICLE_ID, "DPS");
		long inactive = seedTarget("언론사1", PRESS, "press-a", "N");
		long missingTargetFailure = seedFailure(ARTICLE_ID, PRESS, 9999L, SPOOL_WRITE_FAILED);
		long inactiveFailure = seedFailure(ARTICLE_ID, PRESS, inactive, SPOOL_WRITE_FAILED);
		DistributionRetryService service = service(realWriter());

		assertEquals("not-found", service.retry(Long.valueOf(missingTargetFailure), ACTOR).get(REASON));
		assertEquals("inactive", service.retry(Long.valueOf(inactiveFailure), ACTOR).get(REASON));
		assertEquals(0, spoolFiles().size());
	}

	/**
	 * Node 실측 B8 — (e) 대상의 현재 kind와 실패 이력의 kind는 <b>엄격 비교</b>다(대소문자·공백 관용 없음).
	 *
	 * <p>어긋난 채 보내면 2차 엠바고 전에 비언론사로 나가고(회수 불가) 이력에는 옛 kind가 남아 tick이
	 * 같은 수신처에 중복 배부한다.
	 */
	@Test
	void aRetargetedKindIsRejectedStrictly() {
		seedArticle(ARTICLE_ID, "DPS");
		long reclassified = seedTarget("언론사1", NONPRESS, "np-a", "Y");
		long spaced = seedTarget("언론사2", " PRESS ", "press-b", "Y");
		long a = seedFailure(ARTICLE_ID, PRESS, reclassified, SPOOL_WRITE_FAILED);
		long b = seedFailure(ARTICLE_ID, PRESS, spaced, SPOOL_WRITE_FAILED);
		DistributionRetryService service = service(realWriter());

		assertEquals("kind-changed", service.retry(Long.valueOf(a), ACTOR).get(REASON));
		assertEquals("kind-changed", service.retry(Long.valueOf(b), ACTOR).get(REASON), "trim·소문자 관용 금지");
		assertEquals(0, spoolFiles().size());
	}

	/** Node 실측 B9/B10/C7/C8 — (f) 기사 없음은 {@code not-found}, (g) 배부 불가 status는 {@code status-changed}. */
	@Test
	void aMissingArticleOrANonDistributableStatusIsRejected() {
		seedArticle(ARTICLE_ID, "EEK");
		seedArticle(OTHER_ARTICLE_ID, "DPS");
		long target = seedTarget("언론사1", PRESS, "press-a", "Y");
		long killed = seedFailure(ARTICLE_ID, PRESS, target, SPOOL_WRITE_FAILED);
		long ghost = seedFailure("AKR20260826999", PRESS, target, SPOOL_WRITE_FAILED);
		DistributionRetryService service = service(realWriter());

		assertEquals("status-changed", service.retry(Long.valueOf(killed), ACTOR).get(REASON),
				"킬 기사는 회수 수단이 없다");
		assertEquals("not-found", service.retry(Long.valueOf(ghost), ACTOR).get(REASON));
		assertEquals(0, spoolFiles().size());
	}

	// ==============================================================================================
	// retry — 쓰기
	// ==============================================================================================

	/** Node 실측 B11 — 성공은 파일 1개 · {@code distribute-retry} 1행 · {@code distributedAt} 갱신 · 5키다. */
	@Test
	void aSuccessfulRetryPublishesOnceAndResolvesTheFailure() {
		long failureId = seedRetryableFailure();
		long before = historyRowCount();

		Map<String, Object> result = service(realWriter()).retry(Long.valueOf(failureId), ACTOR);

		assertEquals(RETRY_OK_KEYS, sortedKeys(result), "성공 반환은 정확히 5키다 — file·spoolDir을 담지 마라");
		assertEquals(Boolean.TRUE, result.get("ok"));
		assertEquals(ARTICLE_ID, result.get("articleId"));
		assertEquals(PRESS, result.get("kind"));
		assertEquals(STAMP, result.get("at"));

		assertEquals(1, spoolFiles().size());
		assertEquals(before + 1, historyRowCount(), "해소는 새 행 하나로만 표현된다");
		Map<String, Object> latest = ledger(ARTICLE_ID).get(0);
		assertEquals(DISTRIBUTE_RETRY, latest.get("eventType"));
		assertEquals(PRESS, latest.get("action"));
		assertEquals(ACTOR, latest.get("actorUserId"));
		assertEquals(latest.get(TARGET_ID), result.get(TARGET_ID), "정수를 소수점 없이 싣는다");
		assertNull(latest.get(REASON), "해소 행에는 사유가 없다");
		assertEquals(STAMP, contentsColumn(ARTICLE_ID, "distributedAt"));

		assertEquals(0, items(service(realWriter()).list(null)).size(), "해소된 실패는 목록에서 사라진다");
		assertTrue(this.failures.isEmpty(), "성공은 실패 통지를 내지 않는다");
	}

	/** 반환에 서버 파일시스템 경로가 없다 — {@code file}·{@code spoolDir} 금지. */
	@Test
	void theRetryResultNeverCarriesAServerFilesystemPath() {
		long failureId = seedRetryableFailure();

		String raw = JSON.writeValueAsString(service(realWriter()).retry(Long.valueOf(failureId), ACTOR));

		assertFalse(raw.contains("press-a"), raw);
		assertFalse(raw.contains(".json"), raw);
		assertTrue(raw.indexOf('/') < 0 && raw.indexOf('\\') < 0, raw);
	}

	/**
	 * Node 실측 B12 — 재전송 실패도 새 {@code distribute-failed} 행으로 append되고(그룹 최신이 다시 실패가
	 * 되어 목록에 남는다) 통지 1회 · 사유 그대로 · {@code distributedAt}은 <b>갱신하지 않는다</b>.
	 */
	@Test
	void aFailedRetryAppendsANewFailureRowAndNotifiesOnce() {
		long failureId = seedRetryableFailure();
		long before = historyRowCount();

		Map<String, Object> result = service(writer(new SelectiveFs(List.of("press-a"))))
				.retry(Long.valueOf(failureId), ACTOR);

		assertEquals(List.of("ok", "reason"), sortedKeys(result));
		assertEquals(SPOOL_WRITE_FAILED, result.get(REASON));
		assertEquals(before + 1, historyRowCount());
		Map<String, Object> latest = ledger(ARTICLE_ID).get(0);
		assertEquals(DISTRIBUTE_FAILED, latest.get("eventType"));
		assertEquals(SPOOL_WRITE_FAILED, latest.get(REASON));
		assertNull(contentsColumn(ARTICLE_ID, "distributedAt"), "나가지 않았으면 배부 시각도 없다");

		assertEquals(1, this.failures.size());
		RetryFailure notified = this.failures.get(0);
		assertEquals(ARTICLE_ID, notified.articleId());
		assertEquals(PRESS, notified.kind());
		assertEquals(SPOOL_WRITE_FAILED, notified.reason());
		assertEquals(latest.get(TARGET_ID), Long.valueOf((long) notified.targetId()));
		assertEquals(List.of("articleId", "kind", "reason", "targetId"), sortedKeys(notified),
				"통지는 식별자 3개와 고정 사유뿐이다 — 경로 금지");

		assertEquals(1, items(service(realWriter()).list(null)).size(), "미해소로 남는다");
		assertEquals(latest.get("id"), items(service(realWriter()).list(null)).get(0).get(HISTORY_ID),
				"목록의 키는 새 실패 행이다");
	}

	/** 저장된 {@code spoolDir}이 규칙 위반이면 writer 토큰 그대로 돌아온다(사유는 고정 토큰만). */
	@Test
	void aRejectedSpoolDirComesBackAsTheWriterToken() {
		seedArticle(ARTICLE_ID, "DPS");
		long target = seedTarget("언론사1", PRESS, "../outside", "Y");
		long failureId = seedFailure(ARTICLE_ID, PRESS, target, SPOOL_WRITE_FAILED);

		Map<String, Object> result = service(realWriter()).retry(Long.valueOf(failureId), ACTOR);

		assertEquals(Boolean.FALSE, result.get("ok"));
		assertEquals(INVALID_SPOOL_DIR, result.get(REASON));
		assertEquals(0, spoolFiles().size());
		assertEquals(INVALID_SPOOL_DIR, ledger(ARTICLE_ID).get(0).get(REASON));
	}

	/** 게이트 거부는 <b>이력을 남기지 않는다</b> — 시도조차 하지 않았으므로 사실 기록이 아니다. */
	@Test
	void noGateRejectionEverAppendsToTheLedger() {
		seedArticle(ARTICLE_ID, "EEK");
		seedArticle(OTHER_ARTICLE_ID, "DPS");
		long inactive = seedTarget("언론사1", PRESS, "press-a", "N");
		long reclassified = seedTarget("일반1", NONPRESS, "np-a", "Y");
		long killed = seedFailure(ARTICLE_ID, PRESS, inactive, SPOOL_WRITE_FAILED);
		long kindChanged = seedFailure(ARTICLE_ID, PRESS, reclassified, SPOOL_WRITE_FAILED);
		long ghost = seedFailure("AKR20260826999", PRESS, 4242L, SPOOL_WRITE_FAILED);
		long resolved = seedFailure(ARTICLE_ID, NONPRESS, reclassified, SPOOL_WRITE_FAILED);
		seedRetryRow(ARTICLE_ID, NONPRESS, reclassified);
		long stale = seedFailure(OTHER_ARTICLE_ID, PRESS, inactive, SPOOL_WRITE_FAILED);
		seedSendRow(OTHER_ARTICLE_ID);
		long before = historyRowCount();

		DistributionRetryService disabled = service(null);
		DistributionRetryService service = service(realWriter());
		assertEquals(SpoolWriter.SPOOL_DISABLED, disabled.retry(Long.valueOf(killed), ACTOR).get(REASON));
		assertEquals(NO_FAILURE, service.retry("abc", ACTOR).get(REASON));
		assertEquals(NO_FAILURE, service.retry(Long.valueOf(999999999L), ACTOR).get(REASON));
		assertEquals(NO_FAILURE, service.retry(Long.valueOf(resolved), ACTOR).get(REASON));
		assertEquals("stale-cycle", service.retry(Long.valueOf(stale), ACTOR).get(REASON));
		assertEquals("inactive", service.retry(Long.valueOf(killed), ACTOR).get(REASON));
		assertEquals("kind-changed", service.retry(Long.valueOf(kindChanged), ACTOR).get(REASON));
		assertEquals("not-found", service.retry(Long.valueOf(ghost), ACTOR).get(REASON));

		assertEquals(before, historyRowCount(), "게이트 거부가 원장을 오염시켰다");
		assertEquals(0, spoolFiles().size());
		assertTrue(this.failures.isEmpty(), "거부는 미발송 통지가 아니다");
	}

	/**
	 * 재전송 게이트의 미해소 조회는 <b>표시용 창이 아니다</b>(decisions (16)). 표시 창 밖으로 밀린 오래된
	 * 실패도 재전송이 성립해야 한다 — 아니면 그 수신처는 앱 안에서 <b>복구 경로가 0</b>이 된다.
	 */
	@Test
	void theRetryScanIsNotLimitedToTheDisplayWindow() {
		seedArticle(ARTICLE_ID, "DPS");
		long target = seedTarget("언론사1", PRESS, "press-a", "Y");
		long old = seedFailure(ARTICLE_ID, PRESS, target, SPOOL_WRITE_FAILED);

		// 같은 기사의 **다른 수신처** 실패로 창을 채운다 — 그룹이 다르므로 판정에는 관여하지 않는다.
		this.transactions.executeWithoutResult((status) -> {
			for (int i = 0; i < BEYOND_DISPLAY_WINDOW; i++) {
				seedFailure(ARTICLE_ID, PRESS, 1000L + i, SPOOL_WRITE_FAILED);
			}
		});
		assertEquals(0, items(service(realWriter()).list(null)).stream()
				.filter((item) -> Long.valueOf(old).equals(item.get(HISTORY_ID)))
				.count(), "표시용 창 밖으로 밀렸다(전제)");

		assertEquals(Boolean.TRUE, service(realWriter()).retry(Long.valueOf(old), ACTOR).get("ok"),
				"창을 통일하면 오래된 실패가 no-failure로 오거부된다 — 복구 불가");
	}

	/**
	 * 동시 삽입 id 귀속(회귀 잠금) — 이력 id가 <b>재전송 식별자</b>이므로 뒤바뀌면 남의 실패를 재전송한다.
	 * {@code ArticleHistoryRepository.insert}는 {@code GeneratedKeyHolder}로 한 문장에서 처리하므로 지금
	 * 안전하다. 이 테스트는 그 안전이 유지된다는 사실을 지킨다.
	 */
	@Test
	void concurrentRetryFailureInsertsEachReturnTheIdOfTheirOwnRow() throws Exception {
		Map<String, Long> byMarker = new ConcurrentHashMap<>();
		int workers = 4;
		int perWorker = 10;
		CountDownLatch start = new CountDownLatch(1);
		ExecutorService pool = Executors.newFixedThreadPool(workers);
		List<Future<?>> running = new ArrayList<>();
		try {
			for (int worker = 0; worker < workers; worker++) {
				int index = worker;
				running.add(pool.submit(() -> {
					start.await();
					for (int i = 0; i < perWorker; i++) {
						String marker = "retry-" + index + "-" + i;
						byMarker.put(marker, Long.valueOf(seedFailure(ARTICLE_ID, PRESS, index + 1L, marker)));
					}
					return null;
				}));
			}
			start.countDown();
			for (Future<?> task : running) {
				task.get(120, TimeUnit.SECONDS);
			}
		}
		finally {
			pool.shutdownNow();
		}

		assertEquals(workers * perWorker, byMarker.size());
		for (Map.Entry<String, Long> inserted : byMarker.entrySet()) {
			Map<String, Object> found = this.history.getDistributionEventById(inserted.getValue().longValue());
			assertNotNull(found, "돌려준 id의 행이 없다: " + inserted);
			assertEquals(inserted.getKey(), found.get(REASON), "삽입이 남의 행 id를 돌려줬다");
		}
	}

	/**
	 * <b>성공 경로의 이력 insert 실패</b>(step4·step5와 동형 · open_questions (d) 확정 결정) —
	 * Node 실측 B13: 반환은 {@code ok:true} 5키 그대로, {@code distributedAt} 갱신은 <b>유지</b>,
	 * {@code onHistoryError} 1회, 예외는 밖으로 나가지 않는다.
	 *
	 * <p>이유는 하나다: <b>스풀 파일은 이미 나갔다</b>. 되돌릴 수 없는 일을 되돌린 척하면(예외 전파·롤백)
	 * 재전송 성공이 500이 되고, 그 축은 계약이 절대 관측하지 못해 divergence가 영구히 남는다.
	 */
	@Test
	void aFailedLedgerInsertKeepsTheRetryResultAndTheDistributedAt() {
		long failureId = seedRetryableFailure();
		long before = historyRowCount();

		Map<String, Object> result = service(realWriter(), new FailingHistory(this.jdbc), this.targets,
				this.articles).retry(Long.valueOf(failureId), ACTOR);

		assertEquals(Boolean.TRUE, result.get("ok"), "이력 실패가 재전송 성공을 뒤집었다");
		assertEquals(RETRY_OK_KEYS, sortedKeys(result));
		assertEquals(STAMP, contentsColumn(ARTICLE_ID, "distributedAt"), "distributedAt 갱신이 롤백됐다");
		assertEquals(before, historyRowCount(), "이력은 실패했으므로 늘지 않는다");
		assertEquals(1, spoolFiles().size());
		assertEquals(1, this.historyErrors.size(), "무음 삼킴 금지");
		assertEquals(DISTRIBUTE_RETRY, this.historyErrors.get(0).eventType());
	}

	/**
	 * <b>타입 게이트는 여기서도 살아 있다</b>(2026-08-26 ⑤ 코드리뷰 반려 폐색). {@link SpoolDir}의 1단계는
	 * "String이 아니면 거부"이고 그 주석이 이유를 적어 뒀다 — {@code '123'}·{@code 'true'}는 슬러그
	 * 화이트리스트를 <b>통과</b>하므로 호출부가 {@code String.valueOf}로 강제변환하는 순간 검증기가
	 * 무력화된다.
	 *
	 * <p>오늘 {@code DistributionTargetRepository}는 {@code rs.getString}이라 비문자열이 올라오지 않는다 —
	 * 도달 불가한 방어를 잠그는 테스트다(리포지토리 판독이 바뀌면 여기가 먼저 red를 낸다). 판정은
	 * {@code DistributionService.spoolDirOf} <b>한 벌</b>이고 tick 경로와 재전송 경로가 그것을 공유한다.
	 */
	@Test
	void aNonStringSpoolDirIsRejectedInsteadOfBeingCoercedIntoASlug() {
		seedArticle(ARTICLE_ID, "DPS");
		long target = seedTarget("언론사1", PRESS, "press-a", "Y");
		long failureId = seedFailure(ARTICLE_ID, PRESS, target, SPOOL_WRITE_FAILED);
		// 전제 — 강제변환된 문자열은 슬러그 화이트리스트를 통과한다(그래서 타입 게이트가 필요하다).
		assertEquals("123", SpoolDir.sanitizeSpoolDir("123"), "전제 확인");

		Map<String, Object> result = service(realWriter(),
				this.history, new IntegerSpoolDirTargets(this.jdbc), this.articles)
						.retry(Long.valueOf(failureId), ACTOR);

		assertEquals(Boolean.FALSE, result.get("ok"), "비문자열 spoolDir로 재전송이 성공했다: " + result);
		assertEquals(INVALID_SPOOL_DIR, result.get(REASON));
		assertEquals(0, spoolFiles().size(), "강제변환된 폴더명으로 파일이 나갔다");
		assertFalse(Files.exists(this.spoolRoot.resolve("123")), "강제변환된 폴더가 만들어졌다");
	}

	/** {@code spoolDir}만 비문자열로 바꿔 돌려주는 수신처 리포지토리(리포지토리 판독 변경의 대역). */
	private static final class IntegerSpoolDirTargets extends DistributionTargetRepository {

		IntegerSpoolDirTargets(JdbcClient jdbc) {
			super(jdbc);
		}

		@Override
		public Optional<Map<String, Object>> findById(double id) {
			return super.findById(id).map((found) -> {
				Map<String, Object> poisoned = new LinkedHashMap<>(found);
				poisoned.put("spoolDir", Integer.valueOf(123));
				return poisoned;
			});
		}

	}

}
