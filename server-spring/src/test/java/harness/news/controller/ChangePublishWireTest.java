package harness.news.controller;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.junit.jupiter.api.Assertions.fail;

import harness.news.model.ArticleHistoryRepository;
import harness.news.model.ArticleRepository;
import harness.news.model.DistributionTargetRepository;
import harness.news.model.ReceiverConfigRepository;
import harness.news.service.ApiSourceFetcher;
import harness.news.service.ChangeBus;
import harness.news.service.SessionGuard;
import harness.news.service.UserService;
import harness.news.testsupport.TempNewsDb;
import harness.news.testsupport.Wire;
import java.io.IOException;
import java.io.UncheckedIOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.regex.Pattern;
import java.util.stream.Stream;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.context.TestConfiguration;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Primary;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;

/**
 * <b>무효화 신호 발행 11지점</b>의 와이어 계약 — 리포 루트 {@code server/index.js}의
 * {@code app.notifyChange(...)} HTTP 호출 <b>11곳</b>(749 · 787 · 867 · 883 · 902 · 944 · 963 · 976 ·
 * 988 · 1090 · 1116행, 2026-08-30 재실측)과 1:1이다.
 *
 * <h2>계약은 이 축을 하나도 관측하지 못한다</h2>
 * 이 step 시점에는 구독자(=SSE 라우트)가 아직 없어 발행이 와이어로 나가지 않는다. 그리고 SSE가 붙은 뒤에도
 * {@code contract/cases/default/sse-stream.contract.js}가 보는 것은 <b>기사 4종</b>(create · update ·
 * status · lock)뿐이다 — <b>tick · retry · collection 3묶음은 영원히 Java 테스트만 본다</b>. 하나라도
 * 빠지면 계약 리포트는 diffs 0으로 통과하면서 화면의 상태 배지만 조용히 죽는다. 그래서 이 클래스가 그
 * 11지점의 <b>유일한 방어선</b>이다(72에서 송고 훅 반환 status 변이가 계약 198관측을 diffs 0으로 통과하고
 * Java 1건만 red였던 것과 같은 축).
 *
 * <h2>관측 수단: 실제 빈에 구독한다</h2>
 * {@code @MockBean}으로 {@link ChangeBus}를 갈아끼우지 않고 <b>컨텍스트의 실제 빈</b>에 테스트 구독자를
 * 붙인다 — 그래야 "컨트롤러가 정말 그 빈을 쓰는가"까지 함께 검증된다(빈을 교체하면 배선이 끊겨 있어도
 * green이 된다).
 *
 * <h2>거부·실패에는 발행하지 않는다</h2>
 * {@code docs/api-contract/sse.md}가 "거부/실패 응답은 신호를 내지 않는다(변경 0건 재조회 낭비 + 오신호
 * 방지)"로 동결했다. {@code tick}의 <b>{@code distributed} 0건 성공</b>도 같은 축이다 — 200인데 발행 0이다.
 *
 * <p>세션은 {@link SessionGuard#createSession}으로 직접 만든다(로그인 레이트리밋 예산을 쓰지 않는다).
 * DB·스풀 루트는 이 클래스 전용 임시 사본이며 리포 {@code news.db}는 열지 않는다.
 */
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT,
		properties = "app.collection.token=" + ChangePublishWireTest.COLLECTION_TOKEN)
class ChangePublishWireTest {

	/** 이 파일 전용 테스트 토큰(운영 비밀 아님) — 애노테이션 상수라 컴파일 타임 리터럴이어야 한다. */
	static final String COLLECTION_TOKEN = "change-publish-collection-token";

	private static final String COLLECTION_HEADER = "x-collection-token";

	private static final String EDIT_CLIENT_HEADER = "x-edit-client";

	private static final Path DATA_DIR = TempNewsDb.newDataDir("change-publish-wire");

	private static final Path SPOOL_ROOT = tempSpoolRoot();

	/** 발행 어휘 4종({@code docs/api-contract/sse.md}) — 이 밖의 문자열이 나가면 클라가 알아듣지 못한다. */
	private static final Set<String> KINDS =
			Set.of(ChangeBus.CREATE, ChangeBus.UPDATE, ChangeBus.STATUS, ChangeBus.LOCK);

	/** 컨트롤러 소스에서 허용되는 발행 호출의 <b>유일한</b> 모양 — 리터럴 kind를 막는다. */
	private static final Pattern PUBLISH_CALL =
			Pattern.compile("\\.publish\\(ChangeBus\\.(CREATE|UPDATE|STATUS|LOCK)\\)");

	private static final Path CONTROLLER_SOURCES =
			Path.of("src", "main", "java", "harness", "news", "controller");

	private static final String PRESS = "press";

	private static final String STAMP = "2026-01-01T00:00:00.000Z";

	private static final String SPOOL_WRITE_FAILED = "spool-write-failed";

	/** 끝 마커가 있는 본문 — 송고 게이트({@code no-end-marker})를 통과하는 최소 마크업이다. */
	private static final String MARKUP = "<p>본문(끝)</p>";

	/** 어떤 서버에서도 미해소 실패로 매치되지 않는 값. */
	private static final String ABSENT_HISTORY_ID = "999999999";

	private static final String NO_SUCH_ARTICLE = "AKR19700101000000000";

	/**
	 * {@code pull} 경로의 외부 호출 seam — 네트워크 없이 결정적으로 성공/실패시킨다.
	 * ({@code CollectionService}는 어댑터의 실패·예외를 {@code fetch-failed}로 수렴시킨다.)
	 */
	@TestConfiguration
	static class StubFetcherConfig {

		@Bean
		@Primary
		ApiSourceFetcher stubFetcher() {
			return (endpoint, apiKey) -> new ApiSourceFetcher.FetchResult(
					!String.valueOf(endpoint).contains("fail"), "수집 제목\n수집 본문");
		}

	}

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
	private ReceiverConfigRepository configs;

	/** 관측 대상 — <b>실제 빈</b>이다(교체하지 않는다). */
	@Autowired
	private ChangeBus changes;

	@BeforeEach
	void seedUsers() {
		ensureUser("cp-r", "R");
		ensureUser("cp-r2", "R");
		ensureUser("cp-d", "D");
		ensureUser("cp-z", "Z");
		ensureUser("cp-x", "X"); // R/D/Z 밖 — 쓰기 게이트가 막는다.
	}

	// --- 1. 발행 11지점(성공 경로에서 정확히 1회 · 정확한 kind) --------------------------------------

	/** 지점 1 — {@code POST /api/articles} 성공(Node 867행 {@code if (r.ok)}). */
	@Test
	void creatingAnArticlePublishesExactlyOneCreateSignal() {
		String token = sessionFor("cp-r");
		Wire.Response[] seen = new Wire.Response[1];

		List<String> kinds = capture(() -> seen[0] = Wire.json(this.port, "POST", "/api/articles",
				Map.of("x-session-id", token), "{\"title\":\"" + unique("cp-title") + "\"}"));

		assertEquals(200, seen[0].status(), seen[0].body());
		assertEquals(List.of(ChangeBus.CREATE), kinds, "신규 저장은 create 1회다");
	}

	/** 지점 2 — {@code POST /api/articles/:id/derive} 성공(Node 902행). */
	@Test
	void derivingAnArticlePublishesExactlyOneCreateSignal() {
		String token = sessionFor("cp-r");
		String articleId = seedArticle("RDS", null);
		Wire.Response[] seen = new Wire.Response[1];

		List<String> kinds = capture(() -> seen[0] = Wire.json(this.port, "POST",
				"/api/articles/" + articleId + "/derive", Map.of("x-session-id", token),
				"{\"mode\":\"followUp\"}"));

		assertEquals(200, seen[0].status(), seen[0].body());
		assertEquals(List.of(ChangeBus.CREATE), kinds, "파생도 새 기사라 create 1회다");
	}

	/** 지점 3 — {@code POST /api/articles/:id/action} 성공(Node 883행 — {@code fail} 409를 지난 뒤). */
	@Test
	void applyingALifecycleActionPublishesExactlyOneStatusSignal() {
		String token = sessionFor("cp-d");
		String articleId = seedArticle("RDS", null);
		Wire.Response[] seen = new Wire.Response[1];

		List<String> kinds = capture(() -> seen[0] = Wire.json(this.port, "POST",
				"/api/articles/" + articleId + "/action", Map.of("x-session-id", token),
				"{\"action\":\"hold\"}"));

		assertEquals(200, seen[0].status(), seen[0].body());
		assertEquals(List.of(ChangeBus.STATUS), kinds, "생애주기 전이는 status 1회다");
	}

	/** 지점 4 — {@code PUT /api/articles/:id} 성공(Node 944행 {@code if (r.ok)}). */
	@Test
	void updatingAnArticlePublishesExactlyOneUpdateSignal() {
		String token = sessionFor("cp-r");
		String clientId = unique("cp-tab");
		String articleId = seedArticle("RDS", null);
		assertEquals(200, lock(token, clientId, articleId).status());
		Wire.Response[] seen = new Wire.Response[1];

		List<String> kinds = capture(() -> seen[0] = Wire.json(this.port, "PUT", "/api/articles/" + articleId,
				Map.of("x-session-id", token, EDIT_CLIENT_HEADER, clientId),
				"{\"title\":\"" + unique("cp-edited") + "\"}"));

		assertEquals(200, seen[0].status(), seen[0].body());
		assertEquals(List.of(ChangeBus.UPDATE), kinds, "부분 수정은 update 1회다");
	}

	/** 지점 5 — {@code POST /api/articles/:id/lock} 성공(Node 963행). */
	@Test
	void acquiringAnEditLockPublishesExactlyOneLockSignal() {
		String token = sessionFor("cp-r");
		String clientId = unique("cp-tab");
		String articleId = seedArticle("RDS", null);
		Wire.Response[] seen = new Wire.Response[1];

		List<String> kinds = capture(() -> seen[0] = lock(token, clientId, articleId));

		assertEquals(200, seen[0].status(), seen[0].body());
		assertEquals(List.of(ChangeBus.LOCK), kinds, "잠금 획득은 lock 1회다");
	}

	/** 지점 6 — {@code POST /api/articles/:id/unlock} 성공(Node 976행). */
	@Test
	void releasingAnEditLockPublishesExactlyOneLockSignal() {
		String token = sessionFor("cp-r");
		String clientId = unique("cp-tab");
		String articleId = seedArticle("RDS", null);
		assertEquals(200, lock(token, clientId, articleId).status());
		Wire.Response[] seen = new Wire.Response[1];

		List<String> kinds = capture(() -> seen[0] = Wire.json(this.port, "POST",
				"/api/articles/" + articleId + "/unlock",
				Map.of("x-session-id", token, EDIT_CLIENT_HEADER, clientId), "{}"));

		assertEquals(200, seen[0].status(), seen[0].body());
		assertEquals(List.of(ChangeBus.LOCK), kinds, "잠금 해제도 lock 1회다");
	}

	/** 지점 7 — {@code POST /api/articles/:id/force-unlock} 성공(Node 988행). */
	@Test
	void forceReleasingAnEditLockPublishesExactlyOneLockSignal() {
		String holder = sessionFor("cp-r");
		String desk = sessionFor("cp-d");
		String articleId = seedArticle("RDS", null);
		assertEquals(200, lock(holder, unique("cp-tab"), articleId).status());
		Wire.Response[] seen = new Wire.Response[1];

		List<String> kinds = capture(() -> seen[0] = Wire.json(this.port, "POST",
				"/api/articles/" + articleId + "/force-unlock", Map.of("x-session-id", desk), "{}"));

		assertEquals(200, seen[0].status(), seen[0].body());
		assertEquals(List.of(ChangeBus.LOCK), kinds, "강제 해제도 lock 1회다");
	}

	/**
	 * 지점 8 — {@code POST /api/distribution/tick}이 <b>실제로 배부했을 때만</b>(Node 749행
	 * {@code Array.isArray(r.distributed) && r.distributed.length > 0}).
	 */
	@Test
	void aTickThatDistributedSomethingPublishesExactlyOneStatusSignal() {
		String token = sessionFor("cp-z");
		seedTarget(PRESS, unique("cp-tick"));
		String articleId = seedArticle("DES", pastIso());
		Wire.Response[] seen = new Wire.Response[1];

		List<String> kinds = capture(() -> seen[0] = tick(token));

		assertEquals(200, seen[0].status(), seen[0].body());
		// 공허 방지 — 정말로 배부가 있었는지부터 본다(0건이면 아래 단언이 무의미하다).
		assertTrue(seen[0].body().contains(articleId),
				"tick이 그 기사를 배부하지 않았다 — 단언이 공허해진다: " + seen[0].body());
		assertEquals(List.of(ChangeBus.STATUS), kinds, "배부가 있었으면 status 1회다");
	}

	/** 지점 9 — {@code POST /api/distribution/retry} 성공 분기(Node 787행). */
	@Test
	void aSuccessfulRetryPublishesExactlyOneStatusSignal() {
		String token = sessionFor("cp-z");
		long failureId = seedFailureFor(seedArticle("DPS", null), unique("cp-retry"));
		Wire.Response[] seen = new Wire.Response[1];

		List<String> kinds = capture(() -> seen[0] = retry(token, historyIdBody(failureId)));

		assertEquals(200, seen[0].status(), seen[0].body());
		assertEquals(List.of(ChangeBus.STATUS), kinds, "재전송 성공은 status 1회다");
	}

	/** 지점 10 — {@code POST /api/collection/receive} 성공(Node 1090행). */
	@Test
	void aSuccessfulCollectionReceivePublishesExactlyOneCreateSignal() {
		String sourceId = registerSource(Map.of());
		Wire.Response[] seen = new Wire.Response[1];

		List<String> kinds = capture(() -> seen[0] = collection("receive",
				"{\"sourceId\":\"" + sourceId + "\",\"payload\":\"수집 제목\\n수집 본문\"}"));

		assertEquals(200, seen[0].status(), seen[0].body());
		assertEquals(List.of(ChangeBus.CREATE), kinds, "수집 등록도 새 기사라 create 1회다");
	}

	/** 지점 11 — {@code POST /api/collection/pull} 성공(Node 1116행). */
	@Test
	void aSuccessfulCollectionPullPublishesExactlyOneCreateSignal() {
		String sourceId = registerApiSource("https://example.invalid/ok");
		Wire.Response[] seen = new Wire.Response[1];

		List<String> kinds =
				capture(() -> seen[0] = collection("pull", "{\"sourceId\":\"" + sourceId + "\"}"));

		assertEquals(200, seen[0].status(), seen[0].body());
		assertEquals(List.of(ChangeBus.CREATE), kinds, "능동 수집도 create 1회다");
	}

	// --- 2. 거부·실패 경로은 아무것도 발행하지 않는다 ------------------------------------------------

	@Test
	void rejectedArticleWritesPublishNothing() {
		String reporter = sessionFor("cp-r");
		String alien = sessionFor("cp-x");
		String articleId = seedArticle("RDS", null);
		List<String> kinds = capture(() -> {
			// create — 미인증 401 · 정의 밖 역할 403.
			assertRejected(401, Wire.json(this.port, "POST", "/api/articles", Map.of(), "{\"title\":\"x\"}"));
			assertRejected(403, Wire.json(this.port, "POST", "/api/articles",
					Map.of("x-session-id", alien), "{\"title\":\"x\"}"));
			// derive — 미인증 401 · 어휘 밖 모드 400 · 없는 원본 404.
			assertRejected(401, Wire.json(this.port, "POST", "/api/articles/" + articleId + "/derive",
					Map.of(), "{\"mode\":\"followUp\"}"));
			assertRejected(400, Wire.json(this.port, "POST", "/api/articles/" + articleId + "/derive",
					Map.of("x-session-id", reporter), "{\"mode\":\"nope\"}"));
			assertRejected(404, Wire.json(this.port, "POST", "/api/articles/" + NO_SUCH_ARTICLE + "/derive",
					Map.of("x-session-id", reporter), "{\"mode\":\"followUp\"}"));
			// action — 미인증 401 · 어휘 밖 400 · 없는 기사 404 · 전이 불가 409.
			assertRejected(401, Wire.json(this.port, "POST", "/api/articles/" + articleId + "/action",
					Map.of(), "{\"action\":\"hold\"}"));
			assertRejected(400, Wire.json(this.port, "POST", "/api/articles/" + articleId + "/action",
					Map.of("x-session-id", reporter), "{\"action\":\"nope\"}"));
			assertRejected(404, Wire.json(this.port, "POST", "/api/articles/" + NO_SUCH_ARTICLE + "/action",
					Map.of("x-session-id", reporter), "{\"action\":\"hold\"}"));
			assertRejected(409, Wire.json(this.port, "POST", "/api/articles/" + articleId + "/action",
					Map.of("x-session-id", reporter), "{\"action\":\"approveDelete\"}"));
		});

		assertEquals(List.of(), kinds, "거부된 쓰기가 신호를 냈다 — sse.md가 동결한 축이다: " + kinds);
	}

	@Test
	void rejectedUpdatesAndLockOperationsPublishNothing() {
		String reporter = sessionFor("cp-r");
		String other = sessionFor("cp-r2");
		String holderTab = unique("cp-tab");
		String held = seedArticle("RDS", null);
		assertEquals(200, lock(reporter, holderTab, held).status());
		List<String> kinds = capture(() -> {
			// update — 잠금 미보유 403 · 없는 기사 404.
			assertRejected(403, Wire.json(this.port, "PUT", "/api/articles/" + held,
					Map.of("x-session-id", other, EDIT_CLIENT_HEADER, unique("cp-tab")), "{\"title\":\"x\"}"));
			assertRejected(404, Wire.json(this.port, "PUT", "/api/articles/" + NO_SUCH_ARTICLE,
					Map.of("x-session-id", reporter, EDIT_CLIENT_HEADER, holderTab), "{\"title\":\"x\"}"));
			// lock — 이미 잠긴 기사 401 locked · 없는 기사 404.
			assertRejected(401, lock(other, unique("cp-tab"), held));
			assertRejected(404, lock(reporter, unique("cp-tab"), NO_SUCH_ARTICLE));
			// unlock — 비보유자 403 not-holder · 없는 기사 404.
			assertRejected(403, Wire.json(this.port, "POST", "/api/articles/" + held + "/unlock",
					Map.of("x-session-id", other, EDIT_CLIENT_HEADER, unique("cp-tab")), "{}"));
			assertRejected(404, Wire.json(this.port, "POST", "/api/articles/" + NO_SUCH_ARTICLE + "/unlock",
					Map.of("x-session-id", reporter, EDIT_CLIENT_HEADER, holderTab), "{}"));
			// force-unlock — R은 403 forbidden(존재 검사보다 역할 판정이 먼저다).
			assertRejected(403, Wire.json(this.port, "POST", "/api/articles/" + held + "/force-unlock",
					Map.of("x-session-id", reporter), "{}"));
		});

		assertEquals(List.of(), kinds, "거부된 잠금·수정이 신호를 냈다: " + kinds);
	}

	/**
	 * <b>가장 중요한 한 건</b> — {@code tick}이 200인데 배부가 0건이면 발행도 0이다(Node 749행의
	 * {@code distributed.length > 0}). 이 조건을 지우면 클라이언트가 <b>변경 0건</b>을 위해 목록을 다시
	 * 읽는다(재조회 낭비 + 오신호).
	 */
	@Test
	void aTickThatDistributedNothingPublishesNothingEvenThoughItIs200() {
		String token = sessionFor("cp-z");
		// 다른 테스트가 남긴 배부 대상이 있으면 먼저 비운다(실행 순서에 의존하지 않는다).
		tick(token);
		Wire.Response[] seen = new Wire.Response[1];

		List<String> kinds = capture(() -> seen[0] = tick(token));

		assertEquals(200, seen[0].status(), seen[0].body());
		assertTrue(seen[0].body().contains("\"distributed\":[]"),
				"배부 0건 상태를 만들지 못했다 — 단언이 공허해진다: " + seen[0].body());
		assertEquals(List.of(), kinds, "배부 0건인데 신호가 나갔다");
	}

	@Test
	void rejectedAndServerFaultRetriesPublishNothing() {
		String token = sessionFor("cp-z");
		// 4xx — 미해소 실패가 없다(404) · 미인증(401) · 비-Z(403).
		String conflicted = seedArticle("EEK", null); // 배부 가능 상태 밖 → 409 status-changed.
		long conflictedFailure = seedFailureFor(conflicted, unique("cp-conf"));
		// 500 재매핑 3토큰 — 라우트 로컬 매핑이라 성공이 아니다.
		String blockedSlug = unique("cp-blocked");
		blockWithRegularFile(blockedSlug);
		long blockedFailure = seedFailure(seedArticle("DPS", null), seedTarget(PRESS, blockedSlug));
		long escapedFailure = seedFailure(seedArticle("DPS", null), seedTarget(PRESS, "../escape"));
		String weirdId = "AKR2026.0101-" + Long.toHexString(System.nanoTime());
		seedArticleWithId(weirdId, "DPS", null);
		long weirdFailure = seedFailure(weirdId, seedTarget(PRESS, unique("cp-weird")));

		List<String> kinds = capture(() -> {
			assertRejected(404, retry(token, "{\"historyId\":" + ABSENT_HISTORY_ID + "}"));
			assertRejected(401, retry(null, "{\"historyId\":" + ABSENT_HISTORY_ID + "}"));
			assertRejected(403, retry(sessionFor("cp-r"), "{\"historyId\":" + ABSENT_HISTORY_ID + "}"));
			assertRejected(409, retry(token, historyIdBody(conflictedFailure)));
			assertRejected(500, retry(token, historyIdBody(blockedFailure)));
			assertRejected(500, retry(token, historyIdBody(escapedFailure)));
			assertRejected(500, retry(token, historyIdBody(weirdFailure)));
		});

		assertEquals(List.of(), kinds,
				"거부·500 재매핑 경로가 신호를 냈다 — 500은 성공 분기 밖이다: " + kinds);
	}

	@Test
	void rejectedCollectionIngestsPublishNothing() {
		String registered = registerSource(Map.of());
		String inactive = registerSource(Map.of("active", "N"));
		String nonApi = registerSource(Map.of());
		String failing = registerApiSource("https://example.invalid/fail");

		List<String> kinds = capture(() -> {
			// 401 — 토큰 헤더 없음(가드가 서비스보다 앞이다).
			assertRejected(401, Wire.json(this.port, "POST", "/api/collection/receive", Map.of(),
					"{\"sourceId\":\"" + registered + "\",\"payload\":\"제목\"}"));
			// 403 — 미등록 · 비활성.
			assertRejected(403, collection("receive", "{\"sourceId\":\"cp-not-registered\"}"));
			assertRejected(403, collection("receive", "{\"sourceId\":\"" + inactive + "\"}"));
			assertRejected(403, collection("pull", "{\"sourceId\":\"cp-not-registered\"}"));
			// 400 — 활성 API 소스 없음 · 외부 호출 실패(폴백 400이 계약이다).
			assertRejected(400, collection("pull", "{\"sourceId\":\"" + nonApi + "\"}"));
			assertRejected(400, collection("pull", "{\"sourceId\":\"" + failing + "\"}"));
		});

		assertEquals(List.of(), kinds, "거부된 수집이 신호를 냈다: " + kinds);
	}

	// --- 3. kind 어휘 잠금 ---------------------------------------------------------------------------

	/**
	 * 발행 어휘는 4종뿐이고 <b>{@code null}이 흘러도 NPE가 되지 않는다</b>.
	 *
	 * <p>{@code Set.of(...).contains(null)}은 {@link NullPointerException}이다 — 68·69·70·73에서 반복해
	 * <b>400이어야 할 응답을 500으로</b> 만든 함정이며, 발행 경로에서는 더 나쁘다(성공한 저장이 500으로
	 * 뒤집힌다). 그래서 어휘 검사는 반드시 {@code kind == null ||}로 먼저 거른다
	 * (정본 선례: {@code Authorization.java} 170행 {@code if (action == null || !REVISE_ACTIONS.contains(action))}).
	 */
	@Test
	void thePublishedVocabularyIsFourWordsAndANullKindNeverThrows() {
		// (a) 실제 성공 경로가 내는 kind는 전부 어휘 안이다.
		assertVocabulary(capture(this::driveEveryPublishingRouteOnce));

		// (b) null kind를 명시적으로 태운다 — 버스도 어휘 검사도 NPE를 내지 않는다.
		List<String> observed = capture(() -> this.changes.publish(null));
		assertEquals(1, observed.size(), "구독자가 null kind를 받지 못했다: " + observed);
		assertNull(observed.get(0));
		assertThrows(AssertionError.class, () -> assertVocabulary(observed),
				"어휘 검사가 null에서 NPE를 냈다 — kind == null 가드가 없다");

		// (c) 어휘 밖 문자열은 반드시 걸린다(검사가 늘 통과하는 상태로 green이 되지 않게).
		assertThrows(AssertionError.class, () -> assertVocabulary(List.of("delete")));
	}

	/**
	 * <b>정적 그물</b> — 컨트롤러 층의 발행 호출은 정확히 11개이고 전부 {@link ChangeBus} 상수 4종이다.
	 * 행동 테스트가 놓칠 수 있는 "한 지점이 통째로 사라졌다"를 파일별 분포로 함께 못 박는다.
	 */
	@Test
	void theControllerLayerPublishesTheFourConstantsAtExactlyElevenSites() {
		Map<String, Integer> byFile = new LinkedHashMap<>();
		List<String> sites = new ArrayList<>();
		for (Path source : controllerSources()) {
			String name = source.getFileName().toString();
			for (String line : linesOf(source)) {
				if (line.contains(".publish(")) {
					sites.add(name + ": " + line.trim());
					byFile.merge(name, 1, Integer::sum);
				}
			}
		}

		assertEquals(11, sites.size(), "발행 지점이 11곳이 아니다(Node HTTP 라우트 11곳과 1:1): " + sites);
		for (String site : sites) {
			assertTrue(PUBLISH_CALL.matcher(site).find(),
					"발행은 ChangeBus 상수 4종으로만 한다(리터럴 금지): " + site);
		}
		assertEquals(Map.of("ArticlesController.java", 7, "DistributionController.java", 2,
				"CollectionController.java", 2), byFile, "컨트롤러별 발행 분포가 다르다: " + byFile);
	}

	// --- 4. 발행은 응답을 바꾸지 않는다 --------------------------------------------------------------

	/**
	 * 구독자가 {@link RuntimeException}을 던져도 <b>응답 status·본문이 동일</b>하다.
	 *
	 * <p>Node {@code server/index.js} 1144~1150행 주석이 명시한 위험이다 — 예외가 라우트로 새면 이미 성공한
	 * 저장이 전역 에러 핸들러에 걸려 500으로 뒤집히고 클라이언트 재시도가 <b>중복 저장</b>을 만든다.
	 */
	@Test
	void aThrowingSubscriberChangesNeitherStatusNorBody() {
		List<Wire.Response> clean = driveEveryPublishingRouteOnce();
		for (Wire.Response response : clean) {
			assertEquals(200, response.status(), "기준 실행이 이미 실패했다: " + response.body());
		}

		AutoCloseable handle = this.changes.subscribe((kind) -> {
			throw new IllegalStateException("구독자 고장");
		});
		List<Wire.Response> broken;
		try {
			broken = driveEveryPublishingRouteOnce();
		}
		finally {
			closeQuietly(handle);
		}

		assertEquals(clean.size(), broken.size());
		for (int i = 0; i < clean.size(); i++) {
			assertEquals(clean.get(i).status(), broken.get(i).status(),
					"구독자 예외가 응답 status를 바꿨다(경로 " + i + "): " + broken.get(i).body());
			assertEquals(normalize(clean.get(i).body()), normalize(broken.get(i).body()),
					"구독자 예외가 응답 본문을 바꿨다(경로 " + i + ")");
		}
	}

	// --- 5. 송고 훅의 엠바고 승격은 자체 신호를 내지 않는다 ------------------------------------------

	/**
	 * 배부 결선이 있는 서버에서 {@code send}가 내는 신호는 <b>{@code status} 1건뿐</b>이다.
	 *
	 * <p>훅이 기사를 실제로 배부하고 행을 {@code DES} → {@code EPS}로 승격시켜도 신호는 늘지 않는다 —
	 * {@code docs/api-contract/sse.md}가 "송고 훅의 비동기 엠바고 승격은 자체 신호를 내지 않는다"로 동결했다.
	 * 발행을 서비스층으로 내리면 여기서 즉시 red다(Node에 없는 신호가 추가로 나간다).
	 */
	@Test
	void theSendHookPromotionAddsNoSignalOfItsOwn() {
		String token = sessionFor("cp-d");
		String slug = unique("cp-hook");
		seedTarget(PRESS, slug);
		String articleId = seedSecondEmbargoArticle();
		Wire.Response[] seen = new Wire.Response[1];

		List<String> kinds = capture(() -> seen[0] = Wire.json(this.port, "POST",
				"/api/articles/" + articleId + "/action", Map.of("x-session-id", token),
				"{\"action\":\"send\"}"));

		assertEquals(200, seen[0].status(), seen[0].body());
		assertEquals("{\"ok\":true,\"status\":\"DES\"}", seen[0].body(), "응답 status는 승격 이전 값이다");
		// 공허 방지 — 훅이 정말로 배부하고 행을 승격시켰다는 증거.
		assertEquals(1L, spoolFilesFor(slug, articleId), "훅이 스풀을 쓰지 않았다 — 단언이 공허해진다");
		assertEquals("EPS", String.valueOf(this.articles.findById(articleId).contents().column("status")),
				"저장된 행이 승격되지 않았다 — 단언이 공허해진다");
		assertEquals(List.of(ChangeBus.STATUS), kinds, "훅의 승격이 자체 신호를 냈다: " + kinds);
	}

	// --- 관측 도구 -----------------------------------------------------------------------------------

	/** 실제 {@link ChangeBus} 빈에 구독자를 붙여 동작 구간의 kind 시퀀스를 모은다. */
	private List<String> capture(Runnable action) {
		List<String> kinds = Collections.synchronizedList(new ArrayList<>());
		AutoCloseable handle = this.changes.subscribe(kinds::add);
		try {
			action.run();
		}
		finally {
			closeQuietly(handle);
		}
		return new ArrayList<>(kinds);
	}

	/**
	 * 어휘 검사 — <b>{@code kind == null} 가드가 먼저다.</b> {@code Set.of(...).contains(null)}은 NPE이고,
	 * 그 NPE는 이 프로젝트에서 400을 500으로 만든 전례가 68·69·70·73에 있다.
	 */
	private static void assertVocabulary(List<String> kinds) {
		for (String kind : kinds) {
			if (kind == null || !KINDS.contains(kind)) {
				fail("발행 어휘(create|update|status|lock) 밖의 kind: " + kind);
			}
		}
	}

	/**
	 * 11지점 전부를 성공 경로로 <b>한 번씩</b> 태우고 응답을 순서대로 돌려준다(픽스처는 매번 새로 만든다).
	 * 반환 순서는 이 클래스 상단의 지점 1~11 순서와 같다.
	 */
	private List<Wire.Response> driveEveryPublishingRouteOnce() {
		String reporter = sessionFor("cp-r");
		String desk = sessionFor("cp-d");
		String admin = sessionFor("cp-z");
		String tab = unique("cp-tab");

		List<Wire.Response> responses = new ArrayList<>();
		// 1 create
		responses.add(Wire.json(this.port, "POST", "/api/articles", Map.of("x-session-id", reporter),
				"{\"title\":\"" + unique("cp-title") + "\"}"));
		// 2 derive
		responses.add(Wire.json(this.port, "POST", "/api/articles/" + seedArticle("RDS", null) + "/derive",
				Map.of("x-session-id", reporter), "{\"mode\":\"followUp\"}"));
		// 3 action
		responses.add(Wire.json(this.port, "POST", "/api/articles/" + seedArticle("RDS", null) + "/action",
				Map.of("x-session-id", desk), "{\"action\":\"hold\"}"));
		// 4 update(잠금 보유 뒤)
		String editable = seedArticle("RDS", null);
		assertEquals(200, lock(reporter, tab, editable).status());
		responses.add(Wire.json(this.port, "PUT", "/api/articles/" + editable,
				Map.of("x-session-id", reporter, EDIT_CLIENT_HEADER, tab),
				"{\"title\":\"" + unique("cp-edited") + "\"}"));
		// 5 lock · 6 unlock · 7 force-unlock
		String lockable = seedArticle("RDS", null);
		responses.add(lock(reporter, tab, lockable));
		responses.add(Wire.json(this.port, "POST", "/api/articles/" + lockable + "/unlock",
				Map.of("x-session-id", reporter, EDIT_CLIENT_HEADER, tab), "{}"));
		responses.add(Wire.json(this.port, "POST", "/api/articles/" + lockable + "/force-unlock",
				Map.of("x-session-id", desk), "{}"));
		// 8 tick(배부 1건)
		seedTarget(PRESS, unique("cp-tick"));
		seedArticle("DES", pastIso());
		responses.add(tick(admin));
		// 9 retry(성공)
		responses.add(retry(admin, historyIdBody(seedFailureFor(seedArticle("DPS", null), unique("cp-retry")))));
		// 10 receive · 11 pull
		responses.add(collection("receive", "{\"sourceId\":\"" + registerSource(Map.of())
				+ "\",\"payload\":\"수집 제목\\n수집 본문\"}"));
		responses.add(collection("pull",
				"{\"sourceId\":\"" + registerApiSource("https://example.invalid/ok") + "\"}"));
		return responses;
	}

	/** 실행마다 달라지는 값(기사 id · 시각 · 정수)을 지운 응답 본문 — 두 실행의 동일성 비교용이다. */
	private static String normalize(String body) {
		return body.replaceAll("AKR[0-9A-Za-z.\\-]+", "<id>")
				.replaceAll("\\d{4}-\\d{2}-\\d{2}T[0-9:.\\-]+Z", "<at>")
				.replaceAll("(?<=:)-?\\d+", "<n>");
	}

	private static void assertRejected(int status, Wire.Response response) {
		assertEquals(status, response.status(), response.body());
		assertFalse(response.body().contains("\"ok\":true"),
				"거부 응답에 성공 표시가 있다: " + response.body());
	}

	// --- 요청 ---------------------------------------------------------------------------------------

	private Wire.Response lock(String token, String clientId, String articleId) {
		return Wire.json(this.port, "POST", "/api/articles/" + articleId + "/lock",
				Map.of("x-session-id", token, EDIT_CLIENT_HEADER, clientId), "{}");
	}

	private Wire.Response tick(String token) {
		return Wire.send(this.port, "POST", "/api/distribution/tick", Map.of("x-session-id", token), null);
	}

	private Wire.Response retry(String token, String body) {
		Map<String, String> headers = (token == null) ? Map.of() : Map.of("x-session-id", token);
		return Wire.json(this.port, "POST", "/api/distribution/retry", headers, body);
	}

	private Wire.Response collection(String route, String body) {
		return Wire.json(this.port, "POST", "/api/collection/" + route,
				Map.of(COLLECTION_HEADER, COLLECTION_TOKEN), body);
	}

	// --- 픽스처 -------------------------------------------------------------------------------------

	private String sessionFor(String userId) {
		return this.sessions.createSession(userId);
	}

	private void ensureUser(String userId, String role) {
		Map<String, Object> dto = new LinkedHashMap<>();
		dto.put("userId", userId);
		dto.put("name", userId);
		dto.put("role", role);
		dto.put("password", "change-publish-pw");
		try {
			this.users.create(dto);
		}
		catch (RuntimeException ignored) {
			// 이미 있다 — 픽스처는 멱등이다.
		}
	}

	private String seedArticle(String status, String embargoAt) {
		return seedArticleWithId("AKR2026" + Long.toHexString(System.nanoTime()), status, embargoAt);
	}

	private String seedArticleWithId(String articleId, String status, String embargoAt) {
		this.articles.insert(row("articleId", articleId, "title", "제목", "markupVersion", MARKUP),
				row("articleId", articleId, "title", "제목", "status", status, "createdAt", STAMP,
						"embargoAt", embargoAt));
		return articleId;
	}

	/** 2차 엠바고만 설정된 데스크 대기 기사 — 송고하면 {@code DES}가 되고 훅이 행을 {@code EPS}로 올린다. */
	private String seedSecondEmbargoArticle() {
		String articleId = "AKR2026" + Long.toHexString(System.nanoTime());
		this.articles.insert(row("articleId", articleId, "title", "제목", "markupVersion", MARKUP),
				row("articleId", articleId, "title", "제목", "status", "RDS", "createdAt", STAMP,
						"secondEmbargoAt", futureIso()));
		return articleId;
	}

	private long seedTarget(String kind, String spoolDir) {
		return this.targets.insert(row("name", unique("cp-t"), "kind", kind, "spoolDir", spoolDir,
				"active", "Y", "createdAt", STAMP, "updatedAt", STAMP));
	}

	private long seedFailure(String articleId, long targetId) {
		return this.history.insert(row("articleId", articleId, "eventType", "distribute-failed",
				"action", PRESS, "targetId", Long.valueOf(targetId), "reason", SPOOL_WRITE_FAILED,
				"actorUserId", "cp-z", "createdAt", STAMP));
	}

	/** 미해소 실패 1건(활성 수신처 + 그 기사) — 재전송 성공 경로의 입력이다. */
	private long seedFailureFor(String articleId, String slug) {
		return seedFailure(articleId, seedTarget(PRESS, slug));
	}

	private String registerSource(Map<String, Object> extra) {
		String sourceId = unique("cp-src");
		Map<String, Object> entry = new LinkedHashMap<>();
		entry.put("sourceId", sourceId);
		entry.put("type", "FTP");
		entry.putAll(extra);
		this.configs.insert(entry);
		return sourceId;
	}

	private String registerApiSource(String endpoint) {
		String sourceId = unique("cp-api");
		Map<String, Object> entry = new LinkedHashMap<>();
		entry.put("sourceId", sourceId);
		entry.put("type", "API");
		entry.put("apiEndpoint", endpoint);
		entry.put("active", "Y");
		this.configs.insert(entry);
		return sourceId;
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

	/** 그 수신처 디렉토리에 <b>그 기사</b>로 나간 스풀 파일 수. */
	private static long spoolFilesFor(String slug, String articleId) {
		Path dir = SPOOL_ROOT.resolve(slug);
		if (!Files.isDirectory(dir)) {
			return 0L;
		}
		try (Stream<Path> paths = Files.list(dir)) {
			return paths.filter((file) -> file.getFileName().toString().startsWith(articleId + "_")).count();
		}
		catch (IOException ex) {
			throw new UncheckedIOException(ex);
		}
	}

	private static Map<String, Object> row(Object... pairs) {
		Map<String, Object> map = new LinkedHashMap<>();
		for (int i = 0; i < pairs.length; i += 2) {
			map.put((String) pairs[i], pairs[i + 1]);
		}
		return map;
	}

	private static String historyIdBody(long historyId) {
		return "{\"historyId\":" + historyId + "}";
	}

	private static String unique(String prefix) {
		return prefix + "-" + Long.toHexString(System.nanoTime()).toLowerCase(Locale.ROOT);
	}

	private static String pastIso() {
		return "2000-01-01T00:00:00.000Z";
	}

	private static String futureIso() {
		return "2999-01-01T00:00:00.000Z";
	}

	private static void closeQuietly(AutoCloseable handle) {
		try {
			handle.close();
		}
		catch (Exception ex) {
			throw new IllegalStateException("구독 해제가 실패했다", ex);
		}
	}

	private static List<Path> controllerSources() {
		try (Stream<Path> paths = Files.list(CONTROLLER_SOURCES)) {
			List<Path> sources = paths.filter((path) -> path.getFileName().toString().endsWith(".java"))
					.sorted(Comparator.comparing(Path::toString)).toList();
			assertFalse(sources.isEmpty(), "스캔 대상이 없다 — 작업 디렉토리가 모듈 루트가 아니다: "
					+ CONTROLLER_SOURCES.toAbsolutePath());
			return sources;
		}
		catch (IOException ex) {
			throw new UncheckedIOException(ex);
		}
	}

	private static List<String> linesOf(Path source) {
		try {
			return Files.readAllLines(source, StandardCharsets.UTF_8);
		}
		catch (IOException ex) {
			throw new UncheckedIOException(ex);
		}
	}

	private static Path tempSpoolRoot() {
		try {
			return Files.createTempDirectory("news-spring-change-publish-spool-");
		}
		catch (IOException ex) {
			throw new UncheckedIOException(ex);
		}
	}

}

/**
 * 배부·수집이 <b>비활성</b>인 서버 — 실패·fail-closed 경로에서도 발행이 0임을 잠근다.
 *
 * <pre>
 * tick       503 spool-disabled        ← 스풀 루트 미설정(Node 749행은 !r.ok에서 fail로 빠진다)
 * collection 503 collection-disabled   ← 비-loopback 바인딩 + 토큰 미설정(가드가 서비스 앞이다)
 * </pre>
 *
 * <p>구성이 곧 계약이라 컨텍스트를 따로 둔다({@code CollectionWireTest}의 세 컨텍스트 선례).
 */
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT,
		properties = { "app.distribution.spool-dir=", "server.address=0.0.0.0", "app.collection.token=" })
class ChangePublishDisabledWireTest {

	private static final Path DATA_DIR = TempNewsDb.newDataDir("change-publish-disabled-wire");

	@DynamicPropertySource
	static void dataDir(DynamicPropertyRegistry registry) {
		registry.add("app.data-dir", () -> DATA_DIR.toAbsolutePath().toString());
	}

	@Value("${local.server.port}")
	private int port;

	@Autowired
	private UserService users;

	@Autowired
	private SessionGuard sessions;

	@Autowired
	private ChangeBus changes;

	@BeforeEach
	void seedUsers() {
		ensureUser("cpd-z", "Z");
	}

	@Test
	void aFailedTickPublishesNothing() {
		String token = this.sessions.createSession("cpd-z");
		List<String> kinds = Collections.synchronizedList(new ArrayList<>());
		AutoCloseable handle = this.changes.subscribe(kinds::add);
		Wire.Response response;
		try {
			response = Wire.send(this.port, "POST", "/api/distribution/tick",
					Map.of("x-session-id", token), null);
		}
		finally {
			close(handle);
		}

		assertEquals(503, response.status(), response.body());
		assertEquals("{\"ok\":false,\"reason\":\"spool-disabled\"}", response.body());
		assertEquals(List.of(), new ArrayList<>(kinds), "실패한 tick이 신호를 냈다: " + kinds);
	}

	@Test
	void failClosedCollectionRoutesPublishNothing() {
		List<String> kinds = Collections.synchronizedList(new ArrayList<>());
		AutoCloseable handle = this.changes.subscribe(kinds::add);
		try {
			for (String route : List.of("receive", "pull")) {
				Wire.Response response = Wire.json(this.port, "POST", "/api/collection/" + route, Map.of(),
						"{\"sourceId\":\"cpd-src\",\"payload\":\"제목\"}");
				assertEquals(503, response.status(), response.body());
				assertEquals("{\"ok\":false,\"reason\":\"collection-disabled\"}", response.body());
			}
		}
		finally {
			close(handle);
		}

		assertEquals(List.of(), new ArrayList<>(kinds), "닫힌 수집 라우트가 신호를 냈다: " + kinds);
	}

	private void ensureUser(String userId, String role) {
		Map<String, Object> dto = new LinkedHashMap<>();
		dto.put("userId", userId);
		dto.put("name", userId);
		dto.put("role", role);
		dto.put("password", "change-publish-pw");
		try {
			this.users.create(dto);
		}
		catch (RuntimeException ignored) {
			// 이미 있다 — 픽스처는 멱등이다.
		}
	}

	private static void close(AutoCloseable handle) {
		try {
			handle.close();
		}
		catch (Exception ex) {
			throw new IllegalStateException("구독 해제가 실패했다", ex);
		}
	}

}
