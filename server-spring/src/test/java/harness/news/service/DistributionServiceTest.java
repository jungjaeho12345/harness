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
import harness.news.service.DistributionService.Distributed;
import harness.news.service.DistributionService.DistributionFailure;
import harness.news.service.DistributionService.Failed;
import harness.news.service.DistributionService.Result;
import harness.news.testsupport.MutableClock;
import harness.news.testsupport.TempNewsDb;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.time.Clock;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import java.util.stream.Stream;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.jdbc.support.JdbcTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

/**
 * 배부 실행 서비스 — 리포 루트 {@code src/services/distributionService.js}(244행)의 동작 계약.
 *
 * <p>기준값은 <b>Node 실측</b>이다(2026-08-25 · 가짜 모델·가짜 writer로 원본 {@code createDistributionService}를
 * 직접 호출해 18개 시나리오의 반환·이력 insert·update 호출을 표로 떴다). 계획서 문구가 아니라 그 표가 정본이다.
 *
 * <p>임시 파일 DB({@code @TempDir})와 임시 스풀 루트만 쓴다 — 리포 {@code news.db}도 {@code uploads/}도 열지
 * 않는다. 스풀 파일은 전부 {@code @TempDir} 아래에 남는다.
 */
class DistributionServiceTest {

	private static final Instant FIXED = Instant.parse("2026-08-25T00:00:00.000Z");

	private static final String STAMP = "2026-08-25T00:00:00.000Z";

	private static final String ARTICLE_ID = "AKR20260825001";

	private static final String ACTOR = "reporter1";

	private static final String PRESS = "press";

	private static final String NONPRESS = "nonpress";

	private static final String DISTRIBUTE = "distribute";

	private static final String DISTRIBUTE_FAILED = "distribute-failed";

	private static final String SPOOL_WRITE_FAILED = "spool-write-failed";

	private static final String STATUS_CHANGED = "status-changed";

	/**
	 * 표시용 목록 창을 넘기고도 남는 최신 이벤트 수 — Node 실측(2026-08-25) {@code DEFAULT_LIST_LIMIT=200} ·
	 * {@code MAX_LIST_LIMIT=1000} · 모델 기본 창 {@code 500} 셋을 전부 넘긴다. 중복 억제 조회는
	 * {@code FAILURE_DEDUP_SCAN_LIMIT=1000000}(사실상 무제한)이라 그 밖으로 밀려도 최신 실패가 보인다.
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

	private final List<DistributionFailure> failures = new ArrayList<>();

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

	private void seedArticle(String status) {
		this.articles.insert(row("articleId", ARTICLE_ID, "title", "제목", "markupVersion", "<p>본문(끝)</p>"),
				row("articleId", ARTICLE_ID, "title", "제목", "status", status, "createdAt", STAMP));
	}

	private long seedTarget(String name, String kind, String spoolDir, String active) {
		return this.targets.insert(row("name", name, "kind", kind, "spoolDir", spoolDir, "active", active,
				"createdAt", STAMP, "updatedAt", STAMP));
	}

	private DistributionService service(SpoolWriter writer) {
		return service(writer, this.articles, this.history);
	}

	/**
	 * 읽기는 언제나 진짜 리포지토리로, 쓰기(이력)는 주어진 리포지토리로 한다 — 이력 insert만 실패하는
	 * 상황을 만들기 위한 분리다.
	 */
	private DistributionService service(SpoolWriter writer, ArticleRepository articleRepo,
			ArticleHistoryRepository historyRepo) {
		ArticleHistoryRecorder recorder = new ArticleHistoryRecorder(historyRepo, this.clock, this.historyErrors::add);
		return new DistributionService(this.targets, articleRepo, this.history, recorder, writer, this.clock,
				this.failures::add);
	}

	private SpoolWriter realWriter() {
		return new SpoolWriter(this.spoolRoot, this.clock);
	}

	private SpoolWriter writer(SpoolWriter.SpoolFs fs) {
		return new SpoolWriter(this.spoolRoot, this.clock, fs);
	}

	// --- 관측 헬퍼 --------------------------------------------------------------------------------

	private List<Map<String, Object>> ledger() {
		return this.history.queryDistributionEvents(ARTICLE_ID, null);
	}

	private List<Map<String, Object>> historyOf(String eventType) {
		return this.history.queryByArticle(ARTICLE_ID).stream()
				.filter((row) -> eventType.equals(row.get("eventType")))
				.toList();
	}

	private Object contentsColumn(String column) {
		ArticleAggregate found = this.articles.findById(ARTICLE_ID);
		return (found == null || found.contents() == null) ? null : found.contents().column(column);
	}

	private List<Path> filesUnder(Path root) {
		try (Stream<Path> walk = Files.walk(root)) {
			return walk.filter(Files::isRegularFile).sorted(Comparator.comparing(Path::toString)).toList();
		}
		catch (IOException ex) {
			throw new IllegalStateException(ex);
		}
	}

	private List<Path> filesIn(String spoolDir) {
		Path dir = this.spoolRoot.resolve(spoolDir);
		return Files.isDirectory(dir) ? filesUnder(dir) : List.of();
	}

	/**
	 * 실제 파일 연산을 하되 지정한 수신처 폴더에서만 실패하는 seam — 수신처 1곳의 쓰기 실패를 결정적으로
	 * 만든다. 게시 직후 훅으로 "쓰기 사이의 상태 전이"(TOCTOU)도 재현한다.
	 */
	private static final class SelectiveFs implements SpoolWriter.SpoolFs {

		private final List<String> failingDirs;

		private final Runnable afterPublish;

		SelectiveFs(List<String> failingDirs) {
			this(failingDirs, null);
		}

		SelectiveFs(List<String> failingDirs, Runnable afterPublish) {
			this.failingDirs = failingDirs;
			this.afterPublish = afterPublish;
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
			if (this.afterPublish != null) {
				this.afterPublish.run();
			}
		}

	}

	/** 최초 스냅샷을 읽은 <b>직후</b> 상태를 전이시키는 리포지토리 — TOCTOU 창을 결정적으로 연다. */
	private static final class TransitionAfterSnapshot extends ArticleRepository {

		private final Runnable transition;

		TransitionAfterSnapshot(JdbcClient jdbc, TransactionTemplate transactions, Clock clock, Runnable transition) {
			super(jdbc, transactions, clock);
			this.transition = transition;
		}

		@Override
		public ArticleAggregate findById(String articleId) {
			ArticleAggregate snapshot = super.findById(articleId);
			this.transition.run();
			return snapshot;
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

	// --- 1. 활성 2곳 성공 --------------------------------------------------------------------------

	/** Node 실측 1번: 파일 2개 · {@code distributed} 2건 · {@code distribute} 이력 <b>1행</b>(kind당 1행). */
	@Test
	void twoActiveTargetsGetTheFileAndTheKindGetsOneHistoryRow() {
		seedArticle("DES");
		long first = seedTarget("언론사1", PRESS, "press-1", "Y");
		long second = seedTarget("언론사2", PRESS, "press-2", "Y");

		Result result = service(realWriter()).distribute(ARTICLE_ID, List.of(PRESS), ACTOR);

		assertTrue(result.ok());
		assertNull(result.reason());
		assertEquals(List.of(Long.valueOf(first), Long.valueOf(second)),
				result.distributed().stream().map(Distributed::targetId).toList());
		assertEquals(List.of(PRESS, PRESS), result.distributed().stream().map(Distributed::kind).toList());
		assertEquals(List.of(), result.failed());
		assertEquals(1, filesIn("press-1").size());
		assertEquals(1, filesIn("press-2").size());

		List<Map<String, Object>> distributeRows = historyOf(DISTRIBUTE);
		assertEquals(1, distributeRows.size(), "kind당 1행이다 — 수신처마다 남기지 않는다");
		assertEquals(PRESS, distributeRows.get(0).get("action"));
		assertEquals(ACTOR, distributeRows.get(0).get("actorUserId"));
		assertEquals(STAMP, distributeRows.get(0).get("createdAt"));
		assertEquals(STAMP, contentsColumn("distributedAt"), "성공 1건 이상이면 배부 시각을 갱신한다");
		assertEquals("DES", contentsColumn("status"), "상태 전이는 이 서비스의 책임이 아니다");
		assertEquals(List.of(), this.failures);
	}

	// --- 2. 활성 0곳 -------------------------------------------------------------------------------

	/** Node 실측 2번: 파일 0 · 이력 0 · {@code distributedAt} 미갱신 · 두 배열 모두 비었음. */
	@Test
	void withNoActiveTargetNothingIsWrittenRecordedOrStamped() {
		seedArticle("DES");
		seedTarget("비활성", PRESS, "press-off", "N");

		Result result = service(realWriter()).distribute(ARTICLE_ID, List.of(PRESS, NONPRESS), ACTOR);

		assertTrue(result.ok());
		assertEquals(List.of(), result.distributed());
		assertEquals(List.of(), result.failed(), "활성 수신처가 없는 kind는 failed에도 남지 않는다");
		assertEquals(List.of(), filesUnder(this.spoolRoot));
		assertEquals(List.of(), this.history.queryByArticle(ARTICLE_ID));
		assertNull(contentsColumn("distributedAt"));
	}

	// --- 3. 비활성 수신처 --------------------------------------------------------------------------

	/** {@code active='N'}은 배부 대상이 아니다 — 그 수신처 폴더는 만들어지지도 않는다. */
	@Test
	void inactiveTargetsAreNeverWrittenTo() {
		seedArticle("DES");
		seedTarget("활성", PRESS, "press-on", "Y");
		seedTarget("비활성", PRESS, "press-off", "N");

		Result result = service(realWriter()).distribute(ARTICLE_ID, List.of(PRESS), ACTOR);

		assertEquals(1, result.distributed().size());
		assertEquals(1, filesIn("press-on").size());
		assertEquals(List.of(), filesIn("press-off"), "비활성 수신처에는 한 건도 나가지 않는다");
		assertFalse(Files.isDirectory(this.spoolRoot.resolve("press-off")), "폴더조차 만들지 않는다");
	}

	// --- 4. 부분 실패 ------------------------------------------------------------------------------

	/**
	 * Node 실측 3번: 성공 1 · {@code failed} 1 · <b>{@code distribute} 이력은 남는다</b>({@code okInKind > 0}) ·
	 * {@code distribute-failed} 1행 영속 · {@code distributedAt} 갱신.
	 *
	 * <p>이 단언이 "한 배부 호출 전체를 하나의 트랜잭션으로 묶는" 변이를 잡는다 — 묶으면 뒤따르는 실패가
	 * 앞선 성공의 사실 기록까지 되돌려 다음 tick이 중복 배부한다(회수 불가).
	 */
	@Test
	void aPartialFailureKeepsTheSuccessRecordAndPersistsTheFailure() {
		seedArticle("DES");
		long okTarget = seedTarget("언론사1", PRESS, "press-ok", "Y");
		long badTarget = seedTarget("언론사2", PRESS, "press-bad", "Y");

		Result result = service(writer(new SelectiveFs(List.of("press-bad"))))
				.distribute(ARTICLE_ID, List.of(PRESS), ACTOR);

		assertTrue(result.ok());
		assertEquals(List.of(Long.valueOf(okTarget)), result.distributed().stream().map(Distributed::targetId).toList());
		assertEquals(1, result.failed().size());
		Failed failed = result.failed().get(0);
		assertEquals(Long.valueOf(badTarget), failed.targetId());
		assertEquals(SPOOL_WRITE_FAILED, failed.reason());
		assertEquals("press-bad", failed.spoolDir(), "내부 타입은 경로를 담는다 — 투영은 tick의 책임이다");

		assertEquals(1, historyOf(DISTRIBUTE).size(), "성공분의 사실 기록은 남는다");
		assertEquals(STAMP, contentsColumn("distributedAt"));
		List<Map<String, Object>> ledger = ledger();
		assertEquals(1, ledger.size());
		assertEquals(DISTRIBUTE_FAILED, ledger.get(0).get("eventType"));
		assertEquals(PRESS, ledger.get(0).get("action"));
		assertEquals(Long.valueOf(badTarget), ledger.get(0).get("targetId"));
		assertEquals(SPOOL_WRITE_FAILED, ledger.get(0).get("reason"));
		assertEquals(ACTOR, ledger.get(0).get("actorUserId"));
	}

	// --- 5. 전부 실패 ------------------------------------------------------------------------------

	/** Node 실측 4번: {@code distribute} 이력 <b>0행</b>(거짓 기록 금지) · {@code distributedAt} 미갱신. */
	@Test
	void whenEveryTargetFailsThereIsNoKindHistoryRowAndNoStamp() {
		seedArticle("DES");
		seedTarget("언론사1", PRESS, "bad-1", "Y");
		seedTarget("언론사2", PRESS, "bad-2", "Y");

		Result result = service(writer(new SelectiveFs(List.of("bad-1", "bad-2"))))
				.distribute(ARTICLE_ID, List.of(PRESS), ACTOR);

		assertTrue(result.ok());
		assertEquals(List.of(), result.distributed());
		assertEquals(2, result.failed().size());
		assertEquals(List.of(), historyOf(DISTRIBUTE), "스풀에 나간 게 없으면 배부 이력을 남기지 않는다");
		assertNull(contentsColumn("distributedAt"));
		assertEquals(2, ledger().size(), "수신처 단위 실패는 각각 영속된다");
	}

	// --- 6. TOCTOU 가드(i == 0) --------------------------------------------------------------------

	/**
	 * 최초 스냅샷 직후 {@code EEK}로 전이되면 <b>첫 수신처부터</b> 쓰지 않는다 — 파일 0 ·
	 * {@code failed}에 {@code targetId:null} 항목 · <b>다음 kind도 시작하지 않는다</b>(중단 전파).
	 *
	 * <p>이 테스트가 지키는 것은 회수 불가능한 KILL 기사 유출이다. 쓰기 직전 재조회를 없애면 최초
	 * 스냅샷의 {@code DES}로 판정해 파일이 나간다.
	 */
	@Test
	void aTransitionBeforeTheFirstWriteAbortsEveryKind() {
		seedArticle("DES");
		seedTarget("언론사1", PRESS, "press-1", "Y");
		seedTarget("언론사2", PRESS, "press-2", "Y");
		seedTarget("비언론사1", NONPRESS, "nonpress-1", "Y");
		ArticleRepository flipping = new TransitionAfterSnapshot(this.jdbc, this.transactions, this.clock,
				() -> this.articles.update(ARTICLE_ID, null, row("status", "EEK")));

		Result result = service(realWriter(), flipping, this.history)
				.distribute(ARTICLE_ID, List.of(PRESS, NONPRESS), ACTOR);

		assertTrue(result.ok());
		assertEquals(List.of(), result.distributed());
		assertEquals(List.of(), filesUnder(this.spoolRoot), "전이된 기사는 한 건도 나가지 않는다");
		assertEquals(2, result.failed().size(), "시작도 못 한 kind도 failed에 남는다(tick의 touched 판정)");
		assertEquals(List.of(PRESS, NONPRESS), result.failed().stream().map(Failed::kind).toList());
		for (Failed failed : result.failed()) {
			assertNull(failed.targetId(), "kind 단위 항목이다");
			assertNull(failed.spoolDir());
			assertEquals(STATUS_CHANGED, failed.reason());
		}
		assertEquals(List.of(), this.history.queryByArticle(ARTICLE_ID));
		assertNull(contentsColumn("distributedAt"));
	}

	// --- 7. TOCTOU 가드(i > 0) ---------------------------------------------------------------------

	/** 첫 게시 뒤 전이되면 <b>남은 수신처</b>가 {@code targetId} 있는 {@code status-changed} 항목이 된다. */
	@Test
	void aTransitionAfterTheFirstWriteMarksTheRemainingTargets() {
		seedArticle("DES");
		long first = seedTarget("언론사1", PRESS, "press-1", "Y");
		long second = seedTarget("언론사2", PRESS, "press-2", "Y");
		long third = seedTarget("언론사3", PRESS, "press-3", "Y");
		seedTarget("비언론사1", NONPRESS, "nonpress-1", "Y");
		SelectiveFs fs = new SelectiveFs(List.of(),
				() -> this.articles.update(ARTICLE_ID, null, row("status", "EEK")));

		Result result = service(writer(fs)).distribute(ARTICLE_ID, List.of(PRESS, NONPRESS), ACTOR);

		assertEquals(List.of(Long.valueOf(first)), result.distributed().stream().map(Distributed::targetId).toList());
		assertEquals(1, filesUnder(this.spoolRoot).size(), "전이 뒤로는 한 건도 나가지 않는다");
		assertEquals(Arrays.asList(Long.valueOf(second), Long.valueOf(third), null),
				result.failed().stream().map(Failed::targetId).toList());
		assertEquals(Arrays.asList("press-2", "press-3", null),
				result.failed().stream().map(Failed::spoolDir).toList());
		assertEquals(List.of(PRESS, PRESS, NONPRESS), result.failed().stream().map(Failed::kind).toList());
		assertEquals(List.of(STATUS_CHANGED, STATUS_CHANGED, STATUS_CHANGED),
				result.failed().stream().map(Failed::reason).toList());
		assertEquals(1, historyOf(DISTRIBUTE).size(), "실제로 나간 kind의 이력은 남는다");
		assertEquals(STAMP, contentsColumn("distributedAt"));
	}

	// --- 8. 실패 영속 조건 -------------------------------------------------------------------------

	/** {@code status-changed}와 {@code targetId:null} 항목은 원장에 남지 않는다(영원히 해소되지 않는 항목 금지). */
	@Test
	void statusChangedItemsAreNeverPersistedToTheLedger() {
		seedArticle("DES");
		seedTarget("언론사1", PRESS, "press-1", "Y");
		seedTarget("언론사2", PRESS, "press-2", "Y");
		SelectiveFs fs = new SelectiveFs(List.of(),
				() -> this.articles.update(ARTICLE_ID, null, row("status", "EEK")));

		Result result = service(writer(fs)).distribute(ARTICLE_ID, List.of(PRESS, NONPRESS), ACTOR);

		assertFalse(result.failed().isEmpty(), "failed 반환·통지는 기록 생략과 무관하게 일어난다");
		assertEquals(result.failed().size(), this.failures.size());
		assertEquals(List.of(), ledger(), "재전송 대상이 아닌 사유는 영속하지 않는다");
	}

	/** 재전송 가능 3사유는 영속된다 — {@code invalid-spool-dir}는 슬러그 재검증이 만든 사유다. */
	@Test
	void retryableReasonsArePersistedWithTheirFixedToken() {
		seedArticle("DES");
		long target = seedTarget("언론사1", PRESS, "../바깥", "Y");

		Result result = service(realWriter()).distribute(ARTICLE_ID, List.of(PRESS), ACTOR);

		assertEquals(1, result.failed().size());
		assertEquals(SpoolWriter.INVALID_SPOOL_DIR, result.failed().get(0).reason());
		assertEquals(List.of(), filesUnder(this.spoolRoot));
		List<Map<String, Object>> ledger = ledger();
		assertEquals(1, ledger.size());
		assertEquals(Long.valueOf(target), ledger.get(0).get("targetId"));
		assertEquals(SpoolWriter.INVALID_SPOOL_DIR, ledger.get(0).get("reason"));
	}

	// --- 9. 같은 사이클 중복 억제 ------------------------------------------------------------------

	/** Node 실측 7번: 같은 (기사,수신처,kind,사유)로 두 번 실패하면 원장 행은 <b>1행</b>이다. */
	@Test
	void theSameFailureInTheSameCycleIsRecordedOnce() {
		seedArticle("DES");
		seedTarget("언론사1", PRESS, "bad-1", "Y");
		DistributionService service = service(writer(new SelectiveFs(List.of("bad-1"))));

		Result first = service.distribute(ARTICLE_ID, List.of(PRESS), ACTOR);
		Result second = service.distribute(ARTICLE_ID, List.of(PRESS), ACTOR);

		assertEquals(1, first.failed().size());
		assertEquals(1, second.failed().size(), "억제해도 failed 반환은 매번 일어난다");
		assertEquals(2, this.failures.size(), "통지도 매번 일어난다(무음 삼킴 금지)");
		assertEquals(1, ledger().size(), "같은 사이클의 같은 사유는 한 행이다");
	}

	/** 사유가 달라지면(원인 변화) 새 사실이므로 반드시 남는다 — Node 실측 7b번. */
	@Test
	void aDifferentReasonInTheSameCycleGetsItsOwnRow() {
		seedArticle("DES");
		long target = seedTarget("언론사1", PRESS, "bad-1", "Y");

		service(writer(new SelectiveFs(List.of("bad-1")))).distribute(ARTICLE_ID, List.of(PRESS), ACTOR);
		this.targets.update(target, row("spoolDir", "../바깥"));
		service(realWriter()).distribute(ARTICLE_ID, List.of(PRESS), ACTOR);

		assertEquals(List.of(SpoolWriter.INVALID_SPOOL_DIR, SPOOL_WRITE_FAILED),
				ledger().stream().map((row) -> row.get("reason")).toList());
	}

	/** 재전송으로 해소된 뒤 다시 실패하면 새 행이다(그룹의 최신 행이 {@code distribute-retry}였다). */
	@Test
	void aFailureAfterAResolvingRetryGetsItsOwnRow() {
		seedArticle("DES");
		long target = seedTarget("언론사1", PRESS, "bad-1", "Y");
		DistributionService service = service(writer(new SelectiveFs(List.of("bad-1"))));

		service.distribute(ARTICLE_ID, List.of(PRESS), ACTOR);
		this.history.insert(row("articleId", ARTICLE_ID, "eventType", "distribute-retry", "action", PRESS,
				"targetId", Long.valueOf(target), "actorUserId", ACTOR, "createdAt", STAMP));
		service.distribute(ARTICLE_ID, List.of(PRESS), ACTOR);

		assertEquals(2, ledger().stream().filter((row) -> DISTRIBUTE_FAILED.equals(row.get("eventType"))).count(),
				"해소된 뒤의 재실패는 새 사실이다");
	}

	// --- 10. 사이클 경계 --------------------------------------------------------------------------

	/**
	 * CRITICAL: 경계 <b>이전</b> 행과의 일치는 중복이 아니다. 재송고로 새 사이클이 열리면 같은 실패라도
	 * 새 행을 얻어야 한다 — 그러지 않으면 재전송이 {@code stale-cycle}로 영구 409가 되고 tick도 재시도하지
	 * 않아 그 수신처의 복구 경로가 0이 된다.
	 */
	@Test
	void aFailureAfterANewSendCycleIsRecordedAgain() {
		seedArticle("DES");
		seedTarget("언론사1", PRESS, "bad-1", "Y");
		DistributionService service = service(writer(new SelectiveFs(List.of("bad-1"))));

		service.distribute(ARTICLE_ID, List.of(PRESS), ACTOR);
		this.history.insert(row("articleId", ARTICLE_ID, "eventType", "status", "action", "send",
				"actorUserId", ACTOR, "createdAt", STAMP));
		service.distribute(ARTICLE_ID, List.of(PRESS), ACTOR);

		assertEquals(2, ledger().size(), "새 사이클의 재실패는 새 행이다(failedAt 신선도·재전송 경로 복원)");
	}

	/** 경계 <b>이후</b>의 같은 실패는 억제된다 — Node 실측 8b번(같은 사이클이므로 중복이다). */
	@Test
	void aFailureRecordedAfterTheBoundaryIsSuppressed() {
		seedArticle("DES");
		seedTarget("언론사1", PRESS, "bad-1", "Y");
		this.history.insert(row("articleId", ARTICLE_ID, "eventType", "status", "action", "send",
				"actorUserId", ACTOR, "createdAt", STAMP));
		DistributionService service = service(writer(new SelectiveFs(List.of("bad-1"))));

		service.distribute(ARTICLE_ID, List.of(PRESS), ACTOR);
		service.distribute(ARTICLE_ID, List.of(PRESS), ACTOR);

		assertEquals(1, ledger().size());
	}

	// --- 11. 페이로드 스냅샷 ----------------------------------------------------------------------

	/** 한 배부 배치는 같은 본문을 내보낸다 — 재조회는 status 판정 전용이다. */
	@Test
	void everyTargetInOneCallGetsTheFirstSnapshot() throws IOException {
		seedArticle("DES");
		seedTarget("언론사1", PRESS, "press-1", "Y");
		seedTarget("언론사2", PRESS, "press-2", "Y");
		SelectiveFs fs = new SelectiveFs(List.of(),
				() -> this.articles.update(ARTICLE_ID, null, row("title", "바뀐제목")));

		Result result = service(writer(fs)).distribute(ARTICLE_ID, List.of(PRESS), ACTOR);

		assertEquals(2, result.distributed().size());
		for (Distributed distributed : result.distributed()) {
			String json = Files.readString(Path.of(distributed.file()), StandardCharsets.UTF_8);
			assertTrue(json.contains("\"title\":\"제목\""), "두 번째 수신처도 최초 스냅샷을 받는다: " + json);
		}
	}

	// --- 12. kinds 정규화 -------------------------------------------------------------------------

	/**
	 * Node 실측 9번: 허용 밖 값은 조용히 버리고 순서는 상수 순서({@code press} → {@code nonpress})다.
	 * 걸러진 결과가 비면 <b>기사 조회조차 하지 않는다</b>({@code getById} 0회).
	 */
	@Test
	void unknownKindsAreDroppedAndTheOrderIsFixed() {
		seedArticle("DES");
		seedTarget("언론사1", PRESS, "press-1", "Y");
		seedTarget("비언론사1", NONPRESS, "nonpress-1", "Y");
		DistributionService service = service(realWriter());

		assertEquals(List.of(PRESS),
				service.distribute(ARTICLE_ID, List.of(PRESS, "bogus"), ACTOR).distributed().stream()
						.map(Distributed::kind).toList());
		assertEquals(List.of(PRESS, NONPRESS),
				service.distribute(ARTICLE_ID, List.of(NONPRESS, PRESS), ACTOR).distributed().stream()
						.map(Distributed::kind).toList());
		assertEquals(List.of(PRESS),
				service.distribute(ARTICLE_ID, List.of(PRESS, PRESS), ACTOR).distributed().stream()
						.map(Distributed::kind).toList());
	}

	/** {@code null}·빈 목록·미지 값뿐이면 성공 반환이고 아무것도 하지 않는다. */
	@Test
	void anEmptyKindSelectionDoesNothingAtAll() {
		seedArticle("DES");
		seedTarget("언론사1", PRESS, "press-1", "Y");
		DistributionService service = service(realWriter());

		for (List<String> kinds : List.of(List.<String>of(), List.of("bogus"))) {
			Result result = service.distribute(ARTICLE_ID, kinds, ACTOR);
			assertTrue(result.ok());
			assertEquals(List.of(), result.distributed());
			assertEquals(List.of(), result.failed());
		}
		Result nullKinds = service.distribute(ARTICLE_ID, null, ACTOR);
		assertTrue(nullKinds.ok());
		assertEquals(List.of(), nullKinds.distributed());
		assertEquals(List.of(), filesUnder(this.spoolRoot));
		assertEquals(List.of(), this.history.queryByArticle(ARTICLE_ID));
	}

	/** 목록 안 {@code null} 원소도 조용히 걸러진다({@code Set.of(...).contains(null)}은 NPE다). */
	@Test
	void aNullElementInTheKindListIsDroppedSilently() {
		seedArticle("DES");
		seedTarget("언론사1", PRESS, "press-1", "Y");
		List<String> kinds = new ArrayList<>();
		kinds.add(null);
		kinds.add(PRESS);

		Result result = service(realWriter()).distribute(ARTICLE_ID, kinds, ACTOR);

		assertEquals(List.of(PRESS), result.distributed().stream().map(Distributed::kind).toList());
	}

	// --- 거부 경로 --------------------------------------------------------------------------------

	/** 스풀 writer가 없으면(= 스풀 루트 미설정) 어떤 조회도 하기 전에 {@code spool-disabled}다. */
	@Test
	void withoutASpoolWriterEverythingIsDisabled() {
		seedArticle("DES");
		seedTarget("언론사1", PRESS, "press-1", "Y");

		Result result = service(null).distribute(ARTICLE_ID, List.of(PRESS), ACTOR);

		assertFalse(result.ok());
		assertEquals(SpoolWriter.SPOOL_DISABLED, result.reason());
		assertEquals(List.of(), filesUnder(this.spoolRoot));
	}

	/** 기사(또는 공통정보 행)가 없으면 {@code not-found}이고 수신처 조회도 하지 않는다. */
	@Test
	void anAbsentArticleIsNotFound() {
		seedTarget("언론사1", PRESS, "press-1", "Y");

		Result result = service(realWriter()).distribute(ARTICLE_ID, List.of(PRESS), ACTOR);

		assertFalse(result.ok());
		assertEquals(DistributionService.NOT_FOUND, result.reason());
		assertEquals(List.of(), filesUnder(this.spoolRoot));
	}

	/** 배부 가능 목록 밖 상태는 첫 수신처 직전 가드에서 걸린다(전이가 배부보다 먼저 일어난 경우). */
	@Test
	void anArticleAlreadyOutsideTheDistributableStatusesIsNeverWritten() {
		seedArticle("EEK");
		seedTarget("언론사1", PRESS, "press-1", "Y");

		Result result = service(realWriter()).distribute(ARTICLE_ID, List.of(PRESS), ACTOR);

		assertEquals(List.of(), result.distributed());
		assertEquals(List.of(), filesUnder(this.spoolRoot));
		assertEquals(STATUS_CHANGED, result.failed().get(0).reason());
	}

	// --- 13. 이력 기록 실패 -----------------------------------------------------------------------

	/** Node 실측 12번: 이력 insert가 실패해도 배부는 성공이고 통지가 1회 오며 예외가 밖으로 나가지 않는다. */
	@Test
	void aFailingHistoryInsertIsSwallowedButNotified() {
		seedArticle("DES");
		seedTarget("언론사1", PRESS, "press-1", "Y");

		Result result = service(realWriter(), this.articles, new FailingHistory(this.jdbc))
				.distribute(ARTICLE_ID, List.of(PRESS), ACTOR);

		assertTrue(result.ok());
		assertEquals(1, result.distributed().size());
		assertEquals(STAMP, contentsColumn("distributedAt"), "이미 나간 배부를 되돌리지 않는다");
		assertEquals(1, this.historyErrors.size(), "이력 실패는 삼키되 반드시 남긴다");
		assertEquals(DISTRIBUTE, this.historyErrors.get(0).eventType());
		assertEquals(PRESS, this.historyErrors.get(0).action());
		assertEquals(List.of(), this.failures, "이력 실패를 수신처 미발송 어휘로 흘리지 않는다");
	}

	// --- 14. 통지 payload -------------------------------------------------------------------------

	/** 통지에는 식별자와 고정 사유만 담는다 — 경로가 실리면 로그 다이제스트로 그대로 나간다. */
	@Test
	void theFailureNotificationCarriesNoPath() {
		seedArticle("DES");
		long target = seedTarget("언론사1", PRESS, "bad-1", "Y");

		service(writer(new SelectiveFs(List.of("bad-1")))).distribute(ARTICLE_ID, List.of(PRESS), ACTOR);

		assertEquals(1, this.failures.size());
		DistributionFailure failure = this.failures.get(0);
		assertEquals(ARTICLE_ID, failure.articleId());
		assertEquals(Long.valueOf(target), failure.targetId());
		assertEquals(PRESS, failure.kind());
		assertEquals(SPOOL_WRITE_FAILED, failure.reason());
		assertEquals(4, DistributionFailure.class.getRecordComponents().length, "통지 payload는 4키다");
		assertFalse(failure.toString().contains("bad-1"), "통지에 수신처 폴더가 실리면 안 된다");
		assertFalse(failure.toString().contains(this.spoolRoot.toString()), "통지에 스풀 루트가 실리면 안 된다");
		assertFalse(failure.toString().contains(".json"), "통지에 파일명이 실리면 안 된다");
	}

	/** 통지 자체의 실패·부재가 배부를 깨뜨리지 않는다. */
	@Test
	void aBrokenOrAbsentListenerDoesNotBreakDistribution() {
		seedArticle("DES");
		seedTarget("언론사1", PRESS, "bad-1", "Y");
		ArticleHistoryRecorder recorder = new ArticleHistoryRecorder(this.history, this.clock,
				this.historyErrors::add);
		SpoolWriter failing = writer(new SelectiveFs(List.of("bad-1")));

		Result thrown = new DistributionService(this.targets, this.articles, this.history, recorder, failing,
				this.clock, (failure) -> {
					throw new IllegalStateException("planted failure");
				}).distribute(ARTICLE_ID, List.of(PRESS), ACTOR);
		Result absent = new DistributionService(this.targets, this.articles, this.history, recorder, failing,
				this.clock, null).distribute(ARTICLE_ID, List.of(PRESS), ACTOR);

		assertTrue(thrown.ok());
		assertEquals(1, thrown.failed().size());
		assertTrue(absent.ok());
		assertEquals(1, absent.failed().size());
	}

	// --- 15. 동시 삽입 id 귀속(회귀 잠금) ----------------------------------------------------------

	/**
	 * 실패 이력의 id는 <b>재전송 식별자</b>다 — 삽입이 남의 행 id를 돌려주면 재전송이 남의 실패를 보낸다.
	 * {@code ArticleHistoryRepository.insert}는 {@code GeneratedKeyHolder}로 삽입과 id 회수를 한 문장에서
	 * 처리하므로 <b>지금 안전하다</b>. 이 테스트는 그 안전이 유지된다는 사실을 지키는 회귀 잠금이다.
	 */
	@Test
	void concurrentFailureInsertsEachReturnTheIdOfTheirOwnRow() throws Exception {
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
						String marker = "reason-" + index + "-" + i;
						byMarker.put(marker, this.history.insert(row("articleId", ARTICLE_ID,
								"eventType", DISTRIBUTE_FAILED, "action", PRESS, "targetId", Long.valueOf(index + 1),
								"reason", marker, "createdAt", STAMP)));
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
			assertEquals(inserted.getKey(), found.get("reason"), "삽입이 남의 행 id를 돌려줬다");
		}
	}

	// --- 16. 중복 억제 조회 상한 ------------------------------------------------------------------

	/**
	 * 중복 억제 판정의 조회 상한은 <b>표시용 창이 아니다</b>(decisions (16)). 그 그룹의 최신 실패가
	 * 표시용 창(200·1000) 밖으로 밀려도 억제 판정에 보여야 한다 — 못 보면 같은 실패가 tick마다 새 행으로
	 * 무한 누적된다.
	 */
	@Test
	void theDedupScanIsNotLimitedToTheDisplayWindow() {
		seedArticle("DES");
		long target = seedTarget("언론사1", PRESS, "bad-1", "Y");
		DistributionService service = service(writer(new SelectiveFs(List.of("bad-1"))));
		service.distribute(ARTICLE_ID, List.of(PRESS), ACTOR);
		assertEquals(1, rowsForTarget(target).size());

		// 같은 기사의 **다른 수신처** 실패로 창을 채운다 — 그룹이 다르므로 억제 판정에는 관여하지 않는다.
		this.transactions.executeWithoutResult((status) -> {
			for (int i = 0; i < BEYOND_DISPLAY_WINDOW; i++) {
				this.history.insert(row("articleId", ARTICLE_ID, "eventType", DISTRIBUTE_FAILED, "action", PRESS,
						"targetId", Long.valueOf(1000 + i), "reason", SPOOL_WRITE_FAILED, "createdAt", STAMP));
			}
		});

		service.distribute(ARTICLE_ID, List.of(PRESS), ACTOR);

		assertEquals(1, rowsForTarget(target).size(),
				"창 밖으로 밀린 최신 실패를 놓치면 같은 실패가 새 행으로 쌓인다");
	}

	/** 그 수신처 그룹의 원장 행 — 창 밖까지 본다(모델 기본 창 500과 무관하게 판정한다). */
	private List<Map<String, Object>> rowsForTarget(long targetId) {
		return this.history.queryDistributionEvents(ARTICLE_ID, Integer.valueOf(1_000_000)).stream()
				.filter((row) -> Long.valueOf(targetId).equals(row.get("targetId")))
				.toList();
	}

	// --- 컨텍스트 규율 ----------------------------------------------------------------------------

	/** 성공 경로에는 억제 컨텍스트 조회가 없다(lazy) — 실패가 하나도 없으면 스캔 비용을 얹지 않는다. */
	@Test
	void theDedupContextIsBuiltOnlyWhenAFailureHappens() {
		seedArticle("DES");
		seedTarget("언론사1", PRESS, "press-1", "Y");
		CountingHistory counting = new CountingHistory(this.jdbc);
		ArticleHistoryRecorder recorder = new ArticleHistoryRecorder(this.history, this.clock,
				this.historyErrors::add);

		new DistributionService(this.targets, this.articles, counting, recorder, realWriter(), this.clock,
				this.failures::add).distribute(ARTICLE_ID, List.of(PRESS), ACTOR);

		assertEquals(0, counting.distributionEventQueries, "성공만 있으면 원장을 읽지 않는다");
		assertEquals(0, counting.articleQueries);
	}

	/** 컨텍스트는 <b>호출 안에서만</b> 재사용된다 — 수신처마다 전체 스캔을 다시 하지 않는다. */
	@Test
	void theDedupContextIsQueriedOncePerCall() {
		seedArticle("DES");
		seedTarget("언론사1", PRESS, "bad-1", "Y");
		seedTarget("언론사2", PRESS, "bad-2", "Y");
		seedTarget("비언론사1", NONPRESS, "bad-3", "Y");
		CountingHistory counting = new CountingHistory(this.jdbc);
		ArticleHistoryRecorder recorder = new ArticleHistoryRecorder(this.history, this.clock,
				this.historyErrors::add);
		DistributionService service = new DistributionService(this.targets, this.articles, counting, recorder,
				writer(new SelectiveFs(List.of("bad-1", "bad-2", "bad-3"))), this.clock, this.failures::add);

		service.distribute(ARTICLE_ID, List.of(PRESS, NONPRESS), ACTOR);

		assertEquals(3, ledger().size(), "그룹이 다르면 각각 남는다");
		assertEquals(1, counting.distributionEventQueries, "기사 단위 1회 lazy 조회다");
		assertEquals(1, counting.articleQueries);

		service.distribute(ARTICLE_ID, List.of(PRESS), ACTOR);

		assertEquals(2, counting.distributionEventQueries, "호출 사이 캐시는 금지 — 원장은 호출마다 자란다");
	}

	/** 억제 컨텍스트 조회가 실패하면 <b>기록하는 쪽</b>으로 둔다(과다 기록 > 무음 유실). */
	@Test
	void aFailingDedupLookupFallsBackToRecording() {
		seedArticle("DES");
		seedTarget("언론사1", PRESS, "bad-1", "Y");
		ArticleHistoryRecorder recorder = new ArticleHistoryRecorder(this.history, this.clock,
				this.historyErrors::add);
		DistributionService service = new DistributionService(this.targets, this.articles,
				new BrokenReadHistory(this.jdbc), recorder, writer(new SelectiveFs(List.of("bad-1"))), this.clock,
				this.failures::add);

		service.distribute(ARTICLE_ID, List.of(PRESS), ACTOR);
		service.distribute(ARTICLE_ID, List.of(PRESS), ACTOR);

		assertEquals(2, ledger().size(), "모르면 기록한다 — 조회 실패가 배부를 깨뜨리지도 않는다");
	}

	/** 조회 횟수를 세는 리포지토리 — lazy·1회 규율의 유일한 관측 수단이다. */
	private static final class CountingHistory extends ArticleHistoryRepository {

		private int distributionEventQueries;

		private int articleQueries;

		CountingHistory(JdbcClient jdbc) {
			super(jdbc);
		}

		@Override
		public List<Map<String, Object>> queryDistributionEvents(String articleId, Integer limit) {
			this.distributionEventQueries++;
			return super.queryDistributionEvents(articleId, limit);
		}

		@Override
		public List<Map<String, Object>> queryByArticle(String articleId) {
			this.articleQueries++;
			return super.queryByArticle(articleId);
		}

	}

	/** 억제 판정용 조회만 실패하는 리포지토리. */
	private static final class BrokenReadHistory extends ArticleHistoryRepository {

		BrokenReadHistory(JdbcClient jdbc) {
			super(jdbc);
		}

		@Override
		public List<Map<String, Object>> queryDistributionEvents(String articleId, Integer limit) {
			throw new IllegalStateException("planted failure");
		}

		@Override
		public List<Map<String, Object>> queryByArticle(String articleId) {
			throw new IllegalStateException("planted failure");
		}

	}

}
