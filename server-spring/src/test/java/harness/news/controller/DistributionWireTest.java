package harness.news.controller;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import harness.news.db.RequiredSchema;
import harness.news.model.ArticleAggregate;
import harness.news.model.ArticleHistoryRepository;
import harness.news.model.ArticleRepository;
import harness.news.model.DistributionTargetRepository;
import harness.news.service.SessionGuard;
import harness.news.service.UserService;
import harness.news.testsupport.TempNewsDb;
import harness.news.testsupport.Wire;
import java.io.IOException;
import java.io.UncheckedIOException;
import java.lang.reflect.Method;
import java.lang.reflect.Parameter;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Objects;
import java.util.stream.Stream;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import tools.jackson.databind.ObjectMapper;

/**
 * 배부 실행 3라우트({@code POST /api/distribution/tick} · {@code GET /api/distribution/failures} ·
 * {@code POST /api/distribution/retry})의 <b>와이어</b> 계약 — 스풀이 <b>설정된</b> 서버다.
 *
 * <pre>
 * tick     200 : {ok,at,scanned,distributed,failed,invalid} 정확 6키 · body 미판독 · 경로 유출 0
 * failures 200 : {ok,items} — limit이 무엇이든 400이 아니다(반복 키는 NaN → 기본 창)
 * retry    404 : 미해소 실패가 없으면 no-failure(식별자는 historyId 하나뿐)
 *          409 : status-changed · kind-changed · stale-cycle   (계약이 못 보는 축 — 여기가 유일 방어선)
 *          500 : spool-write-failed · invalid-spool-dir · invalid-article-id (라우트 전용 재매핑)
 * </pre>
 *
 * <p>{@code default} 프로파일의 {@code distribution-tick.contract.js}가 관측하는 축에 더해, <b>계약이
 * 결정적으로 만들 수 없는</b> 실패 원장 축(409 3종·500 3종·재전송 성공)을 원장 시드로 도달시킨다.
 */
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
class DistributionWireTest {

	private static final Path DATA_DIR = TempNewsDb.newDataDir("distribution-wire");

	private static final Path SPOOL_ROOT = tempSpoolRoot();

	private static final ObjectMapper JSON = new ObjectMapper();

	private static final List<String> TICK_KEYS =
			List.of("at", "distributed", "failed", "invalid", "ok", "scanned");

	private static final List<String> DISTRIBUTED_ITEM_KEYS = List.of("articleId", "kinds", "status");

	private static final List<String> RETRY_OK_KEYS = List.of("articleId", "at", "kind", "ok", "targetId");

	private static final String ABSENT_HISTORY_ID = "999999999";

	private static final String PRESS = "press";

	private static final String SPOOL_WRITE_FAILED = "spool-write-failed";

	private static final String DISTRIBUTE_FAILED = "distribute-failed";

	/** 시드 이력의 고정 시각 — 값 자체는 판정에 쓰이지 않는다(순서는 id가 정한다). */
	private static final String STAMP = "2026-01-01T00:00:00.000Z";

	@DynamicPropertySource
	static void environment(DynamicPropertyRegistry registry) {
		registry.add("app.data-dir", () -> DATA_DIR.toAbsolutePath().toString());
		registry.add("app.distribution.spool-dir", () -> SPOOL_ROOT.toAbsolutePath().toString());
	}

	@Value("${local.server.port}")
	private int port;

	@Autowired
	private UserService users;

	@Autowired
	private SessionGuard sessions;

	@Autowired
	private ArticleRepository articles;

	@Autowired
	private ArticleHistoryRepository history;

	@Autowired
	private DistributionTargetRepository targets;

	@Autowired
	private JdbcClient jdbc;

	// --- 1. 빈 실행: 정확 6키 · 경로 유출 0 ---------------------------------------------------------

	@Test
	void anEmptyRunAnswersWithExactlySixKeysAndLeaksNoServerPath() {
		Wire.Response response = tick(zToken(), null);

		assertEquals(200, response.status(), response.body());
		Map<String, Object> body = json(response);
		assertEquals(TICK_KEYS, sortedKeys(body), "tick 요약은 정확 6키다");
		assertEquals(Boolean.TRUE, body.get("ok"));
		assertTrue(body.get("at") instanceof String, "at은 서버 시계의 ISO 문자열이다");
		assertTrue(((Number) body.get("scanned")).intValue() >= 0);
		assertTrue(body.get("distributed") instanceof List<?>);
		assertTrue(body.get("failed") instanceof List<?>);
		assertTrue(body.get("invalid") instanceof List<?>);
		assertNoServerPath(response.body());
	}

	// --- 2. body는 읽히지 않는다(주입 무효) ---------------------------------------------------------

	@Test
	void aTickBodyIsIgnoredSoAnInjectedClockAndTargetListChangeNothing() {
		String injectedArticleId = "AKR299901010000000001";
		String injected = "{\"role\":\"Z\",\"now\":\"2999-01-01T00:00:00.000Z\","
				+ "\"targets\":[{\"id\":1,\"spoolDir\":\"x\",\"kind\":\"press\"}],"
				+ "\"articleId\":\"" + injectedArticleId + "\",\"kinds\":[\"press\",\"nonpress\"]}";

		Wire.Response response = tick(zToken(), injected);

		assertEquals(200, response.status(), response.body());
		Map<String, Object> body = json(response);
		assertEquals(TICK_KEYS, sortedKeys(body), "주입 body가 응답 shape을 바꿨다");
		assertFalse(String.valueOf(body.get("at")).startsWith("2999"),
				"주입한 시각이 서버 시계를 대체했다 — 엠바고가 무력화된다");
		for (Object item : (List<?>) body.get("distributed")) {
			assertFalse(injectedArticleId.equals(asMap(item).get("articleId")), "주입한 articleId가 배부됐다");
		}
		assertNoServerPath(response.body());
	}

	/**
	 * 구조로 잠근다 — tick 핸들러 시그니처에 {@code @RequestBody} 파라미터가 <b>0개</b>다(decisions (5)).
	 * 값이 응답에 안 보이는 것과 "읽을 경로가 없는 것"은 다르다: 판정에만 쓰고 응답에 싣지 않는 주입은
	 * 위 케이스가 놓친다.
	 */
	@Test
	void theTickHandlerDeclaresNoRequestBodyParameter() {
		Method handler = tickHandler();

		for (Parameter parameter : handler.getParameters()) {
			assertNull(parameter.getAnnotation(RequestBody.class),
					"tick 핸들러가 body를 파라미터로 받는다 — role·시각·대상 주입 경로가 열린다: " + parameter);
		}
	}

	// --- 3. 도래한 엠바고 기사 배부 + 멱등 ----------------------------------------------------------

	@Test
	void aDueEmbargoArticleIsDistributedOnceAndTheSecondTickDoesNotResendIt() {
		String slug = unique("due");
		seedTarget(unique("t"), PRESS, slug, "Y");
		String articleId = seedArticle("DES", pastIso());

		Wire.Response first = tick(zToken(), null);
		assertEquals(200, first.status(), first.body());
		Map<String, Object> mine = distributedItem(first, articleId);
		assertNotNull(mine, "도래한 엠바고 기사가 배부되지 않았다: " + first.body());
		assertEquals(DISTRIBUTED_ITEM_KEYS, sortedKeys(mine), "distributed 원소는 정확 3키다");
		assertEquals(List.of(PRESS), mine.get("kinds"), "1차 엠바고만 설정된 기사는 언론사로만 나간다");
		assertEquals("DPS", mine.get("status"), "필요한 kind가 전부 나갔으므로 완결(DPS)");
		assertNoServerPath(first.body());

		ArticleAggregate stored = this.articles.findById(articleId);
		assertEquals("DPS", stored.contents().column("status"));
		Object distributedAt = stored.contents().column("distributedAt");
		assertNotNull(distributedAt, "배부 시각이 남지 않았다");
		assertEquals(1, spoolFilesIn(slug).size(), "스풀 파일이 1건이 아니다");

		Wire.Response second = tick(zToken(), null);
		assertEquals(200, second.status(), second.body());
		assertNull(distributedItem(second, articleId), "같은 기사가 두 번 배부됐다 — 이력 기준 멱등이 깨졌다");
		assertEquals(distributedAt, this.articles.findById(articleId).contents().column("distributedAt"),
				"재배부 없이 배부 시각이 갱신됐다");
		assertEquals(1, spoolFilesIn(slug).size(), "두 번째 tick이 파일을 하나 더 썼다");
		assertNoServerPath(second.body());
	}

	// --- 4. 부수효과 라우트를 GET으로 열지 않는다 ---------------------------------------------------

	@Test
	void theTickPathIsNotExposedOverGet() {
		Wire.Response response = Wire.send(this.port, "GET", "/api/distribution/tick",
				Map.of("x-session-id", zToken()), null);

		assertEquals(404, response.status(), "GET으로 배부를 트리거할 수 있으면 안 된다");
		assertFalse(response.body().contains("\"ok\""), "GET에 성공 응답이 있어서는 안 된다: " + response.body());
	}

	// --- 5. failures: limit이 무엇이든 200이고 반복 키는 기본 창이다 ---------------------------------

	@Test
	void everyLimitProbeAnswers200AndARepeatedKeyFallsBackToTheDefaultWindow() {
		for (String query : new String[] { null, "limit=1", "limit=abc", "limit=-1", "limit=1&limit=2" }) {
			Wire.Response response = failures(zToken(), query);
			assertEquals(200, response.status(), "limit 값이 무엇이든 400이 아니다: " + query);
			Map<String, Object> body = json(response);
			assertEquals(List.of("items", "ok"), sortedKeys(body), "목록 응답은 정확 2키다");
			assertTrue(body.get("items") instanceof List<?>);
		}

		// 반복 키는 값 리스트 그대로 넘어가 Number(['1','2'])=NaN → 기본 창이다(첫 값으로 접으면 1건이 된다).
		String firstArticle = seedFailureFixture();
		String secondArticle = seedFailureFixture();

		assertEquals(1, items(failures(zToken(), "limit=1")).size(), "limit=1은 이력 1행만 훑는다");
		List<String> repeated = articleIds(failures(zToken(), "limit=1&limit=2"));
		assertTrue(repeated.contains(firstArticle) && repeated.contains(secondArticle),
				"반복 쿼리 키를 첫 값으로 접었다 — Node는 NaN → 기본 창이라 두 건이 모두 보인다: " + repeated);
	}

	// --- 6. retry: 식별자는 historyId 하나뿐 --------------------------------------------------------

	@Test
	void everyRetryProbeWithoutAnUnresolvedFailureIs404NoFailure() {
		List<String> bodies = List.of("{\"historyId\":" + ABSENT_HISTORY_ID + "}", "{}",
				"{\"historyId\":\"abc\"}",
				"{\"historyId\":" + ABSENT_HISTORY_ID + ",\"articleId\":\"AKR299901010000000001\","
						+ "\"targetId\":1,\"kind\":\"press\"}");

		for (String body : bodies) {
			Wire.Response response = retry(zToken(), body);
			assertEquals(404, response.status(), "미해소 실패가 없으면 404다: " + body);
			assertEquals("{\"ok\":false,\"reason\":\"no-failure\"}", response.body(), body);
		}
	}

	// --- 7. 409 3종(원장 시드로 도달) ---------------------------------------------------------------

	@Test
	void theThreeConflictReasonsAreReachableOverHttpAs409() {
		// (a) status-changed — 배부 가능 상태 밖으로 전이된 기사.
		String killed = seedArticle("EEK", null);
		long killedTarget = seedTarget(unique("t"), PRESS, unique("conf"), "Y");
		long killedFailure = seedFailure(killed, PRESS, killedTarget, SPOOL_WRITE_FAILED);
		assertConflict("status-changed", retry(zToken(), historyIdBody(killedFailure)));

		// (b) kind-changed — 수신처가 다른 kind로 재분류됐다.
		String retargeted = seedArticle("DPS", null);
		long retargetedTarget = seedTarget(unique("t"), "nonpress", unique("conf"), "Y");
		long retargetedFailure = seedFailure(retargeted, PRESS, retargetedTarget, SPOOL_WRITE_FAILED);
		assertConflict("kind-changed", retry(zToken(), historyIdBody(retargetedFailure)));

		// (c) stale-cycle — 실패 뒤에 재송고가 있었다(그 결정으로 지금 보내면 새 엠바고 전에 나간다).
		String resent = seedArticle("DES", null);
		long resentTarget = seedTarget(unique("t"), PRESS, unique("conf"), "Y");
		long resentFailure = seedFailure(resent, PRESS, resentTarget, SPOOL_WRITE_FAILED);
		seedSendRow(resent);
		assertConflict("stale-cycle", retry(zToken(), historyIdBody(resentFailure)));
	}

	// --- 8. 500 재매핑 3종 + 전역화 금지의 행동 그물 ------------------------------------------------

	@Test
	void theThreeServerFaultReasonsBecome500WhileTheTargetCrudKeepsItsOwn400() {
		// (a) spool-write-failed — 수신처 폴더 자리에 일반 파일이 있어 디렉토리 생성이 실패한다.
		String blockedSlug = unique("blocked");
		blockWithRegularFile(blockedSlug);
		String blocked = seedArticle("DPS", null);
		long blockedTarget = seedTarget(unique("t"), PRESS, blockedSlug, "Y");
		assertServerFault(retry(zToken(), historyIdBody(seedFailure(blocked, PRESS, blockedTarget,
				SPOOL_WRITE_FAILED))), SPOOL_WRITE_FAILED);

		// (b) invalid-spool-dir — CRUD가 거부하는 슬러그가 저장돼 있는 행(직접 시드).
		String escaped = seedArticle("DPS", null);
		long escapedTarget = seedTarget(unique("t"), PRESS, "../escape", "Y");
		assertServerFault(retry(zToken(), historyIdBody(seedFailure(escaped, PRESS, escapedTarget,
				SPOOL_WRITE_FAILED))), "invalid-spool-dir");

		// (c) invalid-article-id — 파일명 화이트리스트 밖 식별자가 저장돼 있는 행.
		String weirdId = "AKR2026.0101-" + Long.toHexString(System.nanoTime());
		seedArticleWithId(weirdId, "DPS", null);
		long weirdTarget = seedTarget(unique("t"), PRESS, unique("weird"), "Y");
		assertServerFault(retry(zToken(), historyIdBody(seedFailure(weirdId, PRESS, weirdTarget,
				SPOOL_WRITE_FAILED))), "invalid-article-id");

		// 같은 토큰이 배부 대상 CRUD에서는 여전히 400이다 — 전역 표에 넣으면 여기가 무너진다.
		Wire.Response rejected = Wire.json(this.port, "POST", "/api/distribution-targets",
				Map.of("x-session-id", zToken()),
				"{\"name\":\"" + unique("t") + "\",\"kind\":\"press\",\"spoolDir\":\"../escape\"}");
		assertEquals(400, rejected.status(), "invalid-spool-dir을 전역 500으로 만들면 CRUD 계약이 깨진다");
		assertEquals("{\"ok\":false,\"reason\":\"invalid-spool-dir\"}", rejected.body());
	}

	// --- 9. 재전송 성공 ------------------------------------------------------------------------------

	@Test
	void aSeededFailureIsResentAndLeavesARetryRowInTheLedger() {
		String slug = unique("resend");
		String articleId = seedArticle("DPS", null);
		long targetId = seedTarget(unique("t"), PRESS, slug, "Y");
		long failureId = seedFailure(articleId, PRESS, targetId, SPOOL_WRITE_FAILED);

		Wire.Response response = retry(zToken(), historyIdBody(failureId));

		assertEquals(200, response.status(), response.body());
		Map<String, Object> body = json(response);
		assertEquals(RETRY_OK_KEYS, sortedKeys(body), "재전송 성공 응답은 정확 5키다(경로 없음)");
		assertEquals(articleId, body.get("articleId"));
		assertEquals(PRESS, body.get("kind"));
		assertNoServerPath(response.body());
		assertEquals(1, spoolFilesIn(slug).size(), "재전송이 파일을 쓰지 않았다");

		List<String> events = new ArrayList<>();
		for (Map<String, Object> row : this.history.queryDistributionEvents(articleId, null)) {
			events.add(String.valueOf(row.get("eventType")));
		}
		assertTrue(events.contains("distribute-retry"), "해소 이력이 남지 않았다: " + events);
		assertTrue(events.contains(DISTRIBUTE_FAILED), "원래의 실패 행이 사라졌다(이력은 append-only다)");
		assertEquals(404, retry(zToken(), historyIdBody(failureId)).status(),
				"해소된 실패는 다시 재전송되지 않는다");
	}

	// --- 10. DB 비파괴 그물 -------------------------------------------------------------------------

	@Test
	void noneOfTheThreeRoutesEverRemovesARow() {
		List<String> tables = List.of("Article", "Contents", "ArticleHistory", "User", "ReceiverConfig",
				"DistributionTarget");
		Map<String, Long> before = new LinkedHashMap<>();
		for (String table : tables) {
			before.put(table, count(table));
		}

		String articleId = seedArticle("DPS", null);
		long targetId = seedTarget(unique("t"), PRESS, unique("keep"), "Y");
		long failureId = seedFailure(articleId, PRESS, targetId, SPOOL_WRITE_FAILED);
		tick(zToken(), null);
		failures(zToken(), "limit=1");
		retry(zToken(), historyIdBody(failureId));
		retry(zToken(), "{\"historyId\":" + ABSENT_HISTORY_ID + "}");

		for (String table : tables) {
			assertTrue(count(table) >= before.get(table).longValue(),
					table + " 행이 줄었다 — 배부 라우트는 어떤 행도 지우지 않는다");
		}
	}

	/**
	 * <b>컬럼 단위 그물</b> — 세 라우트가 {@code Contents}에 쓰는 컬럼은 {@code distributedAt}과
	 * {@code status} <b>둘뿐</b>이고, 이미 있던 원장 행은 <b>한 글자도 다시 쓰이지 않는다</b>.
	 *
	 * <p>{@link #noneOfTheThreeRoutesEverRemovesARow}의 행 수 단언({@code count >= before})으로는 모자란
	 * 자리다: 삭제 1 + 삽입 1은 합계가 그대로라 통과하고, 본문·잠금·{@code sentAt}을 함께 덮어쓰는 갱신은
	 * 행 수를 아예 바꾸지 않는다(phase 70 ④의 교훈 — 계약 163관측·정적 스캔이 전부 green인 채 테이블이
	 * 비었다). 그래서 여기서는 <b>전 컬럼 스냅샷</b>을 뜬다.
	 *
	 * <p>두 경로를 함께 태운다: tick의 배부(승격까지 = {@code status} + {@code distributedAt}) ·
	 * 재전송의 해소({@code distributedAt}만). 잠금·송고 stamp·본문이 함께 쓰이면 그 자리에서 red다.
	 */
	@Test
	void theRoutesWriteOnlyDistributedAtAndStatusAndNeverRewriteAnExistingLedgerRow() {
		String tickSlug = unique("cola");
		seedTarget(unique("t"), PRESS, tickSlug, "Y");
		String ticked = seedFullyPopulatedArticle("DES", pastIso());

		String retrySlug = unique("colb");
		long retryTarget = seedTarget(unique("t"), PRESS, retrySlug, "Y");
		String retried = seedFullyPopulatedArticle("DPS", null);
		long failureId = seedFailure(retried, PRESS, retryTarget, SPOOL_WRITE_FAILED);

		Map<String, Object> tickedBefore = contentsSnapshot(ticked);
		Map<String, Object> retriedBefore = contentsSnapshot(retried);
		Map<String, Object> articleBefore = this.articles.findById(ticked).article();
		Map<Long, Map<String, Object>> ledgerBefore = ledgerSnapshot();

		Wire.Response tickResponse = tick(zToken(), null);
		assertEquals(200, tickResponse.status(), tickResponse.body());
		Wire.Response listResponse = failures(zToken(), "limit=50");
		assertEquals(200, listResponse.status(), listResponse.body());
		Wire.Response retryResponse = retry(zToken(), historyIdBody(failureId));
		assertEquals(200, retryResponse.status(), retryResponse.body());

		// 배부가 실제로 일어났는지부터 확인한다 — 아무 일도 안 했으면 아래 단언은 공허하다.
		// 수신처는 kind별 전량 배부라 tick은 활성 press 대상 <b>전부</b>에 쓴다 — 기사 단위로 센다.
		assertEquals(1L, spoolFilesFor(tickSlug, ticked), "tick이 스풀을 쓰지 않았다 — 그물이 공허해진다");
		assertEquals(1L, spoolFilesFor(retrySlug, retried), "재전송이 스풀을 쓰지 않았다 — 그물이 공허해진다");

		assertEquals(List.of("distributedAt", "status"), changedColumns(tickedBefore, ticked),
				"tick이 배부 2컬럼 밖을 함께 썼다");
		assertEquals(List.of("distributedAt"), changedColumns(retriedBefore, retried),
				"재전송이 distributedAt 밖을 함께 썼다");
		assertEquals(articleBefore, this.articles.findById(ticked).article(),
				"본문 테이블(Article)은 배부가 건드리지 않는다");

		Map<Long, Map<String, Object>> ledgerAfter = ledgerSnapshot();
		for (Map.Entry<Long, Map<String, Object>> before : ledgerBefore.entrySet()) {
			assertEquals(before.getValue(), ledgerAfter.get(before.getKey()),
					"이력 " + before.getKey() + " 행이 사라졌거나 다시 쓰였다 — 원장은 append-only다");
		}
		assertTrue(ledgerAfter.size() > ledgerBefore.size(), "배부 사실이 원장에 남지 않았다");
	}

	// --- 9. 송고 응답의 status는 배부 <b>이전</b> 값이다(와이어) -------------------------------------

	/**
	 * 송고 훅이 행을 승격시켜도 <b>응답 status는 {@code finalStatus}</b>다 — 계약이 못 보는 축이라
	 * (forward_notes (8)⑨) 여기 <b>와이어 한 줄</b>을 더해 방어를 한 겹 늘린다(2026-08-26 ⑤ 코드리뷰 권고).
	 *
	 * <p>Node의 훅은 fire-and-forget이라 응답이 배부 이전 값으로 나간다. Spring은 훅을 동기로 실행하므로
	 * 반환을 승격 후 값으로 바꾸면 그 자리에서 계약이 갈린다 — 그래도 계약 리포트는 diff 0이다(그 픽스처가
	 * 배부를 일으키지 않는다). 단위 그물은 {@code ArticleLifecycleServiceTest}가 소유하고 여기서는
	 * <b>실제 HTTP 바이트</b>로 같은 축을 본다.
	 */
	@Test
	void theSendResponseCarriesTheStatusFromBeforeTheHookPromotedTheRow() {
		String slug = unique("hook");
		seedTarget(unique("t"), PRESS, slug, "Y");
		String articleId = seedSecondEmbargoArticle();

		Wire.Response sent = Wire.json(this.port, "POST", "/api/articles/" + articleId + "/action",
				Map.of("x-session-id", dToken()), "{\"action\":\"send\"}");

		assertEquals(200, sent.status(), sent.body());
		assertEquals("{\"ok\":true,\"status\":\"DES\"}", sent.body(),
				"응답 status는 훅이 승격시키기 전 값(finalStatus)이다");
		assertNoServerPath(sent.body());
		// 아래 둘이 없으면 위 단언이 공허하다 — 훅이 실제로 배부하고 행을 승격시켰다는 증거다.
		assertEquals(1L, spoolFilesFor(slug, articleId), "훅이 스풀을 쓰지 않았다 — 그물이 공허해진다");
		assertEquals("EPS", this.articles.findById(articleId).contents().column("status"),
				"저장된 행은 승격된다(반환만 배부 이전 값이다)");
	}

	// --- 픽스처 -------------------------------------------------------------------------------------

	/** 그 수신처 디렉토리에 <b>그 기사</b>로 나간 스풀 파일 수(파일명이 {@code articleId_}로 시작한다). */
	private static long spoolFilesFor(String slug, String articleId) {
		return spoolFilesIn(slug).stream()
				.filter((file) -> file.getFileName().toString().startsWith(articleId + "_"))
				.count();
	}

	/** {@code Contents} 27컬럼을 <b>전부</b> 채운 기사 — 함께 쓰인 컬럼이 있으면 스냅샷 비교로 드러난다. */
	private String seedFullyPopulatedArticle(String status, String embargoAt) {
		String articleId = "AKR2026" + Long.toHexString(System.nanoTime());
		this.articles.insert(
				row("articleId", articleId, "title", "제목", "markupVersion", "<p>본문(끝)</p>"),
				row("articleId", articleId, "title", "제목", "content", "본문", "author", "reporter1",
						"modifier", "desk1", "sender", "desk1", "department", "정치부",
						"departmentCode", "P01", "createdAt", STAMP, "editedAt", STAMP, "sentAt", STAMP,
						"distributedAt", null, "embargoAt", embargoAt, "secondEmbargoAt", null,
						"status", status, "lockYN", "Y", "lockerUserId", "desk1",
						"lockerSessionId", "SESSION-TOKEN", "lockerClientId", "cid-1", "lockedAt", STAMP,
						"coAuthor", "공동", "category", "정치", "region", "서울", "attribute", "속보",
						"keyword", "키워드", "internalComment", "내부메모", "externalComment", "외부메모",
						"attachmentFile", "a.jpg", "referenceFile", "r.pdf"));
		return articleId;
	}

	/** {@code Contents} 전 컬럼 스냅샷 — present-only 판정의 입력이다. */
	private Map<String, Object> contentsSnapshot(String articleId) {
		ArticleAggregate found = this.articles.findById(articleId);
		assertNotNull(found, "기사가 없다: " + articleId);
		Map<String, Object> columns = new LinkedHashMap<>();
		for (String column : RequiredSchema.CONTENTS_COLUMNS) {
			columns.put(column, found.contents().column(column));
		}
		return columns;
	}

	/** 스냅샷 이후 값이 달라진 컬럼(정렬) — 기대 목록과 그대로 비교한다. */
	private List<String> changedColumns(Map<String, Object> before, String articleId) {
		Map<String, Object> after = contentsSnapshot(articleId);
		List<String> changed = new ArrayList<>();
		for (String column : RequiredSchema.CONTENTS_COLUMNS) {
			if (!Objects.equals(before.get(column), after.get(column))) {
				changed.add(column);
			}
		}
		changed.sort(Comparator.naturalOrder());
		return changed;
	}

	/** 원장 <b>전 행 · 전 컬럼</b> 스냅샷(id → 컬럼 맵) — 재기록·삭제를 둘 다 잡는다. */
	private Map<Long, Map<String, Object>> ledgerSnapshot() {
		Map<Long, Map<String, Object>> rows = new LinkedHashMap<>();
		for (Map<String, Object> row : this.jdbc
				.sql("SELECT " + String.join(", ", RequiredSchema.HISTORY_COLUMNS) + " FROM "
						+ RequiredSchema.HISTORY_TABLE + " ORDER BY id")
				.query().listOfRows()) {
			rows.put(Long.valueOf(((Number) row.get("id")).longValue()), new LinkedHashMap<>(row));
		}
		return rows;
	}

	private static Map<String, Object> row(Object... pairs) {
		Map<String, Object> map = new LinkedHashMap<>();
		for (int i = 0; i < pairs.length; i += 2) {
			map.put((String) pairs[i], pairs[i + 1]);
		}
		return map;
	}

	private String seedArticle(String status, String embargoAt) {
		return seedArticleWithId("AKR2026" + Long.toHexString(System.nanoTime()), status, embargoAt);
	}

	private String seedArticleWithId(String articleId, String status, String embargoAt) {
		this.articles.insert(row("articleId", articleId, "title", "제목", "markupVersion", "<p>본문(끝)</p>"),
				row("articleId", articleId, "title", "제목", "status", status, "createdAt", STAMP,
						"embargoAt", embargoAt));
		return articleId;
	}

	/**
	 * 2차 엠바고만 설정된 데스크 대기 기사 — 데스크가 송고하면 {@code DES}가 되고, 훅이 <b>즉시</b>
	 * 언론사로 내보낸 뒤 행을 {@code EPS}로 승격시킨다(1차는 없으므로 press는 지금 나간다).
	 */
	private String seedSecondEmbargoArticle() {
		String articleId = "AKR2026" + Long.toHexString(System.nanoTime());
		this.articles.insert(row("articleId", articleId, "title", "제목", "markupVersion", "<p>본문(끝)</p>"),
				row("articleId", articleId, "title", "제목", "status", "RDS", "createdAt", STAMP,
						"secondEmbargoAt", futureIso()));
		return articleId;
	}

	private long seedTarget(String name, String kind, String spoolDir, String active) {
		return this.targets.insert(row("name", name, "kind", kind, "spoolDir", spoolDir, "active", active,
				"createdAt", STAMP, "updatedAt", STAMP));
	}

	private long seedFailure(String articleId, String kind, long targetId, String reason) {
		return this.history.insert(row("articleId", articleId, "eventType", DISTRIBUTE_FAILED, "action", kind,
				"targetId", Long.valueOf(targetId), "reason", reason, "actorUserId", "dw-z",
				"createdAt", STAMP));
	}

	/** 사이클 경계 행 — {@code eventType='status'} · {@code action='send'}만 경계가 된다. */
	private void seedSendRow(String articleId) {
		this.history.insert(row("articleId", articleId, "eventType", "status", "action", "send",
				"fromStatus", "DPT", "toStatus", "DES", "actorUserId", "dw-z", "createdAt", STAMP));
	}

	/** 미해소 실패 1건(활성 수신처 · 배부 가능 기사) — 목록 창 프로브용. */
	private String seedFailureFixture() {
		String articleId = seedArticle("DPS", null);
		seedFailure(articleId, PRESS, seedTarget(unique("t"), PRESS, unique("list"), "Y"),
				SPOOL_WRITE_FAILED);
		return articleId;
	}

	/** 수신처 폴더 자리에 일반 파일을 둬 디렉토리 생성이 실패하게 만든다(쓰기 실패 유도). */
	private static void blockWithRegularFile(String slug) {
		try {
			Files.write(SPOOL_ROOT.resolve(slug), new byte[0]);
		}
		catch (IOException ex) {
			throw new UncheckedIOException(ex);
		}
	}

	// --- 요청 --------------------------------------------------------------------------------------

	private Wire.Response tick(String token, String body) {
		Map<String, String> headers = Map.of("x-session-id", token);
		return (body == null) ? Wire.send(this.port, "POST", "/api/distribution/tick", headers, null)
				: Wire.json(this.port, "POST", "/api/distribution/tick", headers, body);
	}

	private Wire.Response failures(String token, String query) {
		String path = "/api/distribution/failures" + ((query == null) ? "" : "?" + query);
		return Wire.send(this.port, "GET", path, Map.of("x-session-id", token), null);
	}

	private Wire.Response retry(String token, String body) {
		return Wire.json(this.port, "POST", "/api/distribution/retry", Map.of("x-session-id", token), body);
	}

	private static String historyIdBody(long historyId) {
		return "{\"historyId\":" + historyId + "}";
	}

	private String zToken() {
		ensureUser("dw-z", "Z");
		return this.sessions.createSession("dw-z");
	}

	/** 송고 훅을 지나는 유일한 자리 — action 라우트는 배부 3라우트와 달리 데스크 권한이다. */
	private String dToken() {
		ensureUser("dw-d", "D");
		return this.sessions.createSession("dw-d");
	}

	private void ensureUser(String userId, String role) {
		Map<String, Object> dto = new LinkedHashMap<>();
		dto.put("userId", userId);
		dto.put("name", userId);
		dto.put("role", role);
		dto.put("password", "dw-wire-pw");
		try {
			this.users.create(dto);
		}
		catch (RuntimeException ignored) {
			// 이미 있다 — 픽스처는 멱등이다.
		}
	}

	// --- 관측 --------------------------------------------------------------------------------------

	private static void assertConflict(String reason, Wire.Response response) {
		assertEquals(409, response.status(), reason + "은 409여야 한다: " + response.body());
		assertEquals("{\"ok\":false,\"reason\":\"" + reason + "\"}", response.body());
	}

	private static void assertServerFault(Wire.Response response, String reason) {
		assertEquals(500, response.status(), reason + "은 라우트에서 500으로 재매핑된다: " + response.body());
		assertEquals("{\"ok\":false,\"reason\":\"" + reason + "\"}", response.body());
	}

	/** 응답 전문에 서버 파일시스템 흔적이 없다 — 계약 {@code assertNoSpoolPath}와 같은 그물이다. */
	private static void assertNoServerPath(String body) {
		assertFalse(body.contains("spoolDir"), "응답에 spoolDir 키가 실렸다: " + body);
		assertFalse(body.contains(".json"), "응답에 스풀 파일명이 실렸다: " + body);
		assertFalse(body.contains("/") || body.contains("\\"), "응답에 경로 구분자가 실렸다: " + body);
	}

	private static Map<String, Object> json(Wire.Response response) {
		return asMap(JSON.readValue(response.body(), Map.class));
	}

	@SuppressWarnings("unchecked")
	private static Map<String, Object> asMap(Object value) {
		return (Map<String, Object>) value;
	}

	private static List<String> sortedKeys(Map<String, Object> body) {
		return body.keySet().stream().sorted().toList();
	}

	private static List<Map<String, Object>> items(Wire.Response response) {
		List<Map<String, Object>> found = new ArrayList<>();
		for (Object item : (List<?>) json(response).get("items")) {
			found.add(asMap(item));
		}
		return found;
	}

	private static List<String> articleIds(Wire.Response response) {
		List<String> found = new ArrayList<>();
		for (Map<String, Object> item : items(response)) {
			found.add(String.valueOf(item.get("articleId")));
		}
		return found;
	}

	private static Map<String, Object> distributedItem(Wire.Response response, String articleId) {
		for (Object item : (List<?>) json(response).get("distributed")) {
			Map<String, Object> entry = asMap(item);
			if (articleId.equals(entry.get("articleId"))) {
				return entry;
			}
		}
		return null;
	}

	private long count(String table) {
		return this.jdbc.sql("SELECT COUNT(*) FROM " + table).query(Long.class).single().longValue();
	}

	private static List<Path> spoolFilesIn(String slug) {
		Path dir = SPOOL_ROOT.resolve(slug);
		if (!Files.isDirectory(dir)) {
			return List.of();
		}
		try (Stream<Path> walk = Files.walk(dir)) {
			return walk.filter(Files::isRegularFile).toList();
		}
		catch (IOException ex) {
			throw new UncheckedIOException(ex);
		}
	}

	/** tick 핸들러 — {@code @PostMapping("/api/distribution/tick")}이 붙은 유일한 메서드. */
	private static Method tickHandler() {
		for (Method method : DistributionController.class.getDeclaredMethods()) {
			PostMapping mapping = method.getAnnotation(PostMapping.class);
			if (mapping != null && List.of(mapping.value()).contains("/api/distribution/tick")) {
				return method;
			}
		}
		throw new AssertionError("POST /api/distribution/tick 핸들러가 없다");
	}

	/** 이미 도래한 엠바고 시각(1시간 전) — {@code Z} 표기 · 밀리초 절단. */
	private static String pastIso() {
		return Instant.now().minus(1, ChronoUnit.HOURS).truncatedTo(ChronoUnit.MILLIS).toString();
	}

	/** 아직 오지 않은 엠바고 시각(1시간 뒤) — 같은 표기. */
	private static String futureIso() {
		return Instant.now().plus(1, ChronoUnit.HOURS).truncatedTo(ChronoUnit.MILLIS).toString();
	}

	private static String unique(String prefix) {
		return prefix + Long.toHexString(System.nanoTime()).toLowerCase(Locale.ROOT);
	}

	private static Path tempSpoolRoot() {
		try {
			Path dir = Files.createTempDirectory("news-spring-distribution-spool-");
			Runtime.getRuntime().addShutdownHook(new Thread(() -> deleteRecursively(dir)));
			return dir;
		}
		catch (IOException ex) {
			throw new UncheckedIOException(ex);
		}
	}

	private static void deleteRecursively(Path root) {
		try (Stream<Path> paths = Files.walk(root)) {
			paths.sorted(Comparator.reverseOrder()).forEach(DistributionWireTest::deleteQuietly);
		}
		catch (IOException ignored) {
			// 임시 디렉토리 정리는 best-effort다.
		}
	}

	private static void deleteQuietly(Path path) {
		try {
			Files.deleteIfExists(path);
		}
		catch (IOException ignored) {
			// 위와 같다.
		}
	}

}
