package harness.news.service;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.zaxxer.hikari.HikariDataSource;
import harness.news.db.NewsDataSource;
import harness.news.model.ArticleHistoryRepository;
import harness.news.model.ArticleRepository;
import harness.news.model.ReceiverConfigRepository;
import harness.news.testsupport.TempNewsDb;
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
 * 수집(자동기사) 서비스 — 리포 루트 {@code src/services/collectionService.js}와 1:1인 동작 계약.
 *
 * <p>HTTP는 없다(@TempDir 임시 DB + 실제 리포지토리 · 가짜 fetcher — 리포 {@code news.db}·네트워크
 * 무접촉). 이 서비스는 <b>세션·role·{@code Authorization}을 전혀 모른다</b>: 수집 라우트의 방어는
 * 바인딩과 수집 토큰뿐이고 그 둘은 web 계층 소유다.
 *
 * <p>잠그는 축.
 * <ol>
 *   <li><b>판정 순서</b>: 등록({@code unregistered}) → 활성({@code inactive}) → 파싱 → 등록. pull은
 *       등록 → 소스 선택({@code no-active-api-source}) → 1회 호출({@code fetch-failed}) → <b>receive
 *       재사용</b>.</li>
 *   <li><b>활성 판정은 {@code (active ?? 'Y') !== 'N'}</b> — NULL은 활성이고 소문자 {@code 'n'}도
 *       활성이다(관용을 더하지도 빼지도 않는다). 이 규칙을 {@code "Y".equals(active)}로 좁히면 그
 *       순간 <b>기존 수집 소스가 전부 죽는다</b>.</li>
 *   <li><b>수집 기사의 고정값</b>: {@code attribute='자동기사'} · {@code status='RDS'} · 이력 0행.</li>
 *   <li><b>실패는 예외가 아니라 사유 토큰</b>이다(graceful 거부 — news.md). 재시도는 없다.</li>
 * </ol>
 *
 * <p>기대값의 출처는 계획서가 아니라 <b>Node 정본 실측</b>이다(2026-08-25 {@code contract-run.mjs
 * --profile default --files contract/cases/default/collection.contract.js} 리포트: receive 성공 200
 * {@code [articleId, ok]} · {@code attribute='자동기사'} · {@code status='RDS'} · payload 누락도 200에
 * 블록 1개 · pull FTP 400 {@code no-active-api-source} · 연결 거부 400 {@code fetch-failed} ·
 * {@code {"ok":true}} 응답은 200에 빈 제목·블록 1개).
 */
class CollectionServiceTest {

	/** rcv.md 규칙 — 수집 기사는 반드시 이 속성을 갖는다. */
	private static final String AUTO_ATTRIBUTE = "자동기사";

	private static final Instant T0 = Instant.parse("2026-08-22T01:02:03.004Z");

	@TempDir
	Path tempDir;

	private HikariDataSource dataSource;

	private JdbcClient client;

	private ReceiverConfigRepository configs;

	private RecordingFetcher fetcher;

	private CollectionService service;

	@BeforeEach
	void setUp() {
		TempNewsDb.seed(this.tempDir);
		this.dataSource = NewsDataSource.create(this.tempDir);
		this.client = JdbcClient.create(this.dataSource);
		Clock clock = Clock.fixed(T0, ZoneOffset.UTC);
		TransactionTemplate transactions = new TransactionTemplate(new JdbcTransactionManager(this.dataSource));
		ArticleRepository articles = new ArticleRepository(this.client, transactions, clock);
		ArticleWriteService writes = new ArticleWriteService(articles,
				new ArticleHistoryRecorder(new ArticleHistoryRepository(this.client), clock, (error) -> {
					// 이력 통지는 이 축의 관심사가 아니다(수집 create는 이력을 남기지 않는다).
				}), clock);
		this.configs = new ReceiverConfigRepository(this.client);
		this.fetcher = new RecordingFetcher();
		this.service = new CollectionService(this.configs, writes, this.fetcher);
	}

	@AfterEach
	void tearDown() {
		if (this.dataSource != null) {
			this.dataSource.close();
		}
	}

	// --- 1. receive 게이트: 등록 → 활성 -----------------------------------------------------------

	@Test
	void receiveRejectsSourceIdsThatWereNeverRegistered() {
		register("sourceId", "src-registered", "type", "FTP");

		CollectionService.Result result = this.service.receive("src-unknown", "제목\n본문");

		assertFalse(result.ok());
		assertEquals("unregistered", result.reason());
		assertNull(result.articleId());
		assertEquals(0, countRows("Article"), "거부된 수신은 기사를 만들지 않는다");
	}

	@Test
	void receiveRejectsWhenEveryRegisteredRowIsInactive() {
		register("sourceId", "src-off", "type", "FTP", "active", "N");
		register("sourceId", "src-off", "type", "API", "active", "N");

		CollectionService.Result result = this.service.receive("src-off", "제목\n본문");

		assertFalse(result.ok(), "전부 비활성이면 수신하지 않는다");
		assertEquals("inactive", result.reason(), "미등록(unregistered)과 구분되는 사유다");
		assertEquals(0, countRows("Article"));
	}

	@Test
	void aMissingActiveColumnMeansActiveAndOnlyTheExactStringNDisables() {
		// (active ?? 'Y') !== 'N' — NULL은 활성이고 소문자 'n'·'Y' 이외의 값도 전부 활성이다.
		register("sourceId", "src-null-active", "type", "FTP");
		register("sourceId", "src-lower-n", "type", "FTP", "active", "n");
		register("sourceId", "src-blank", "type", "FTP", "active", "");

		assertTrue(this.service.receive("src-null-active", "널 활성\n본문").ok(),
				"active가 NULL이면 활성이다(?? 'Y') — 좁히면 기존 수집 소스가 전부 죽는다");
		assertTrue(this.service.receive("src-lower-n", "소문자\n본문").ok(),
				"소문자 'n'은 'N'이 아니므로 활성이다(관용 추가 금지 — Node 그대로)");
		assertTrue(this.service.receive("src-blank", "빈 값\n본문").ok(), "빈 문자열도 'N'이 아니다");
	}

	@Test
	void oneActiveRowAmongInactiveOnesIsEnough() {
		register("sourceId", "src-mixed", "type", "FTP", "active", "N");
		register("sourceId", "src-mixed", "type", "FTP", "active", "Y");
		register("sourceId", "src-mixed", "type", "API", "active", "N");

		CollectionService.Result result = this.service.receive("src-mixed", "혼합\n본문");

		assertTrue(result.ok(), "하나라도 활성이면 수신한다(some)");
		assertEquals(1, countRows("Article"));
	}

	@Test
	void aMissingSourceIdDropsTheFilterEntirelyJustLikeNode() {
		// Node 모델은 undefined·null 필터를 건너뛰므로 query({sourceId: undefined})가 전 행을 돌려준다
		// — 그래서 sourceId 없는 수신은 '미등록'이 아니라 '아무 설정이나 있으면 통과'다. 계약은 언제나
		// sourceId를 보내 이 축을 관측하지 않지만, 여기에 null 거부를 더하면 두 서버가 갈린다.
		register("sourceId", "src-any", "type", "FTP");

		CollectionService.Result result = this.service.receive(null, "널 소스\n본문");

		assertTrue(result.ok(), "Node 동형: 필터가 통째로 빠져 등록된 아무 행이나 매치한다");
	}

	@Test
	void aSourceIdOfAnUnbindableTypeFailsLoudlyInsteadOfBeingStringified() {
		// 값 바인딩 정책(ColumnValues) 단일 출처를 그대로 탄다 — 불리언은 예외(→ 전역 핸들러 500)이며
		// 조용한 문자열화는 Node(node:sqlite TypeError)와 갈린다.
		assertThrows(IllegalArgumentException.class, () -> this.service.receive(Boolean.TRUE, "제목"));
	}

	// --- 2. receive 성공: 고정값과 본문 조립 -------------------------------------------------------

	@Test
	void receiveStampsTheAutoAttributeAndRdsStatusAndLeavesNoHistory() {
		register("sourceId", "src-ok", "type", "FTP");

		CollectionService.Result result = this.service.receive("src-ok", "첫줄제목\n본문 줄");

		assertTrue(result.ok());
		assertNull(result.reason());
		assertNotNull(result.articleId());
		Map<String, Object> row = contentsOf(result.articleId());
		assertEquals("첫줄제목", row.get("title"), "문자열 payload의 첫 줄이 제목이다");
		assertEquals(AUTO_ATTRIBUTE, row.get("attribute"));
		assertEquals("RDS", row.get("status"), "role·action 없이 create → initialStatus 기본값");
		assertEquals("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":["
				+ "{\"type\":\"text\",\"text\":\"첫줄제목\"},{\"type\":\"text\",\"text\":\"본문 줄\"}]}",
				markupOf(result.articleId()), "제목이 본문 블록의 첫 줄로 한 번 더 들어간다");
		assertEquals(0, countRows("ArticleHistory"), "create는 이력을 남기지 않는다(계약)");
	}

	@Test
	void anObjectPayloadTakesTitleAndBodyFromItsFields() {
		register("sourceId", "src-obj", "type", "FTP");

		CollectionService.Result result = this.service.receive("src-obj",
				payload("title", "필드제목", "content", "필드본문"));

		assertTrue(result.ok());
		assertEquals("필드제목", contentsOf(result.articleId()).get("title"));
		assertEquals(List.of("필드제목", "필드본문"), blockTextsOf(result.articleId()));
	}

	@Test
	void aMissingPayloadIsNotRejectedAndCreatesAnEmptyArticle() {
		// 입력 검증이 없다는 것이 계약이다(receive-missing-payload: 200 · 빈 제목 · 블록 1개).
		register("sourceId", "src-empty", "type", "FTP");

		CollectionService.Result result = this.service.receive("src-empty", null);

		assertTrue(result.ok(), "payload 누락도 200이다(400이 아니다)");
		assertEquals("", contentsOf(result.articleId()).get("title"));
		assertEquals(AUTO_ATTRIBUTE, contentsOf(result.articleId()).get("attribute"));
		assertEquals(List.of(""), blockTextsOf(result.articleId()), "빈 기사의 블록은 1개다");
	}

	@Test
	void koreanTitlesAndBodiesSurviveTheRoundTripToTheDatabase() {
		register("sourceId", "src-utf8", "type", "FTP");

		CollectionService.Result result = this.service.receive("src-utf8",
				"한글 제목 — 물결表現\n둘째 줄 본문 ①②③\n셋째 줄");

		assertTrue(result.ok());
		assertEquals("한글 제목 — 물결表現", contentsOf(result.articleId()).get("title"));
		assertEquals(List.of("한글 제목 — 물결表現", "둘째 줄 본문 ①②③", "셋째 줄"),
				blockTextsOf(result.articleId()));
	}

	// --- 3. pull 소스 선택 -------------------------------------------------------------------------

	@Test
	void pullRejectsSourceIdsThatWereNeverRegistered() {
		CollectionService.Result result = this.service.pull("src-unknown");

		assertFalse(result.ok());
		assertEquals("unregistered", result.reason());
		assertEquals(0, this.fetcher.calls(), "미등록이면 외부 호출 자체가 없다");
	}

	@Test
	void pullNeedsAnActiveApiSourceThatHasAnEndpoint() {
		register("sourceId", "src-ftp", "type", "FTP", "apiEndpoint", "http://127.0.0.1:1/");
		register("sourceId", "src-no-endpoint", "type", "API");
		register("sourceId", "src-empty-endpoint", "type", "API", "apiEndpoint", "");
		register("sourceId", "src-inactive-api", "type", "API",
				"apiEndpoint", "http://127.0.0.1:1/", "active", "N");
		register("sourceId", "src-lowercase-api", "type", "api", "apiEndpoint", "http://127.0.0.1:1/");

		for (String sourceId : List.of("src-ftp", "src-no-endpoint", "src-empty-endpoint",
				"src-inactive-api", "src-lowercase-api")) {
			CollectionService.Result result = this.service.pull(sourceId);
			assertFalse(result.ok(), sourceId);
			assertEquals("no-active-api-source", result.reason(), sourceId);
		}
		assertEquals(0, this.fetcher.calls(), "소스를 고르지 못하면 외부 호출이 없다");
		assertEquals(0, countRows("Article"));
	}

	@Test
	void pullPassesTheApiKeyOnlyWhenTheSourceHasOne() {
		register("sourceId", "src-keyed", "type", "API",
				"apiEndpoint", "http://127.0.0.1:9/keyed", "apiKey", "k-1");
		register("sourceId", "src-keyless", "type", "API", "apiEndpoint", "http://127.0.0.1:9/keyless");
		register("sourceId", "src-blank-key", "type", "API",
				"apiEndpoint", "http://127.0.0.1:9/blank", "apiKey", "");
		this.fetcher.returns(true, "본문");

		this.service.pull("src-keyed");
		this.service.pull("src-keyless");
		this.service.pull("src-blank-key");

		assertEquals(List.of("http://127.0.0.1:9/keyed", "http://127.0.0.1:9/keyless",
				"http://127.0.0.1:9/blank"), this.fetcher.endpoints());
		assertEquals("k-1", this.fetcher.apiKeys().get(0), "키가 있으면 어댑터로 넘어간다");
		assertNull(this.fetcher.apiKeys().get(1), "키가 없으면 null이 넘어간다(헤더 없음)");
		assertNull(this.fetcher.apiKeys().get(2), "빈 문자열 키는 falsy라 키가 없는 것과 같다");
	}

	// --- 4. pull 실패 경로: 1회 시도 후 사유 반환 ---------------------------------------------------

	@Test
	void pullReportsFetchFailedWithoutRetryingWhenTheFetcherFails() {
		register("sourceId", "src-fail", "type", "API", "apiEndpoint", "http://127.0.0.1:1/");
		this.fetcher.returns(false, "");

		CollectionService.Result result = this.service.pull("src-fail");

		assertFalse(result.ok());
		assertEquals("fetch-failed", result.reason());
		assertEquals(1, this.fetcher.calls(), "ADR-008 (6) — 재시도·백오프 없이 1회 시도다");
		assertEquals(0, countRows("Article"), "실패한 pull은 기사를 만들지 않는다");
	}

	@Test
	void pullReportsFetchFailedWhenTheAdapterReturnsNothing() {
		register("sourceId", "src-null", "type", "API", "apiEndpoint", "http://127.0.0.1:1/");
		this.fetcher.returnsNothing();

		CollectionService.Result result = this.service.pull("src-null");

		assertFalse(result.ok());
		assertEquals("fetch-failed", result.reason(), "Node의 !res 가지와 같다");
	}

	@Test
	void pullReportsFetchFailedWhenTheAdapterThrows() {
		register("sourceId", "src-throw", "type", "API", "apiEndpoint", "http://127.0.0.1:1/");
		this.fetcher.throwsFailure(new IllegalStateException("연결 거부(주입)"));

		CollectionService.Result result = this.service.pull("src-throw");

		assertFalse(result.ok(), "어댑터 예외가 500으로 새어나가면 계약(400)이 깨진다");
		assertEquals("fetch-failed", result.reason());
		assertEquals(1, this.fetcher.calls());
	}

	// --- 5. pull 성공: 본문 판독(JSON → 값 · 실패 → 평문) -------------------------------------------

	@Test
	void aJsonObjectBodyFeedsTheParserFields() {
		register("sourceId", "src-json", "type", "API", "apiEndpoint", "http://127.0.0.1:9/json");
		this.fetcher.returns(true, "{\"title\":\"T\",\"content\":\"C\"}");

		CollectionService.Result result = this.service.pull("src-json");

		assertTrue(result.ok());
		assertEquals("T", contentsOf(result.articleId()).get("title"));
		assertEquals(AUTO_ATTRIBUTE, contentsOf(result.articleId()).get("attribute"));
		assertEquals("RDS", contentsOf(result.articleId()).get("status"));
		assertEquals(List.of("T", "C"), blockTextsOf(result.articleId()));
	}

	@Test
	void aBodyThatIsNotJsonStaysPlainTextSoTheFirstLineIsTheTitle() {
		register("sourceId", "src-plain", "type", "API", "apiEndpoint", "http://127.0.0.1:9/plain");
		this.fetcher.returns(true, "평문 제목\n평문 본문");

		CollectionService.Result result = this.service.pull("src-plain");

		assertTrue(result.ok());
		assertEquals("평문 제목", contentsOf(result.articleId()).get("title"));
		assertEquals(List.of("평문 제목", "평문 본문"), blockTextsOf(result.articleId()));
	}

	@Test
	void aJsonBodyWithoutTitleOrContentStillRegistersAnEmptyArticle() {
		// 계약의 결정적 성공 경로: 대상 서버 자신의 /api/health 응답 {"ok":true}가 이 모양이다.
		register("sourceId", "src-health", "type", "API", "apiEndpoint", "http://127.0.0.1:9/health");
		this.fetcher.returns(true, "{\"ok\":true}");

		CollectionService.Result result = this.service.pull("src-health");

		assertTrue(result.ok(), "pull 성공 = 기사 1건 생성이며 내용 유효성 검사는 없다");
		assertEquals("", contentsOf(result.articleId()).get("title"));
		assertEquals(AUTO_ATTRIBUTE, contentsOf(result.articleId()).get("attribute"));
		assertEquals(List.of(""), blockTextsOf(result.articleId()));
	}

	@Test
	void pullReusesReceiveSoTheRegistrationIsCheckedAgainAfterTheCall() {
		// 외부 호출 중에 설정이 비활성으로 바뀌면 등록이 거부된다 — pull이 receive를 재사용한다는 사실의
		// 유일한 관측점이다(직접 create로 바꾸면 이 경우가 200이 된다).
		register("sourceId", "src-flip", "type", "API", "apiEndpoint", "http://127.0.0.1:9/flip");
		this.fetcher.returns(true, "제목\n본문");
		this.fetcher.onCall(() -> deactivate("src-flip"));

		CollectionService.Result result = this.service.pull("src-flip");

		assertFalse(result.ok(), "호출 뒤 재확인이 없으면 비활성 소스의 기사가 등록된다");
		assertEquals("inactive", result.reason());
		assertEquals(1, this.fetcher.calls());
		assertEquals(0, countRows("Article"));
	}

	// --- 헬퍼 -------------------------------------------------------------------------------------

	/** 수신 설정 1행 등록(키·값 나열). 주지 않은 컬럼은 NULL로 남는다. */
	private void register(Object... keyValues) {
		this.configs.insert(payload(keyValues));
	}

	/** 테스트에서 {@code active='N'}으로 바꾼다 — 행을 지우지 않는다(DB 비파괴). */
	private void deactivate(String sourceId) {
		this.client.sql("UPDATE ReceiverConfig SET active = 'N' WHERE sourceId = ?")
				.param(sourceId)
				.update();
	}

	private static Map<String, Object> payload(Object... keyValues) {
		Map<String, Object> map = new LinkedHashMap<>();
		for (int i = 0; i < keyValues.length; i += 2) {
			map.put((String) keyValues[i], keyValues[i + 1]);
		}
		return map;
	}

	private Map<String, Object> contentsOf(String articleId) {
		return this.client.sql("SELECT title, attribute, status FROM Contents WHERE articleId = ?")
				.param(articleId)
				.query()
				.singleRow();
	}

	private String markupOf(String articleId) {
		return this.client.sql("SELECT markupVersion FROM Article WHERE articleId = ?")
				.param(articleId)
				.query(String.class)
				.single();
	}

	/** 저장된 본문 블록의 텍스트 목록 — 계약이 단건 조회에서 확인하는 값과 같은 것이다. */
	private List<String> blockTextsOf(String articleId) {
		Object document = MarkupJson.parseOrNull(markupOf(articleId));
		assertNotNull(document, "본문이 블록 문서 JSON이 아니다: " + articleId);
		Map<?, ?> doc = (Map<?, ?>) document;
		assertEquals("yh-editor", doc.get("format"));
		assertEquals(1, doc.get("version"));
		List<String> texts = new ArrayList<>();
		for (Object block : (List<?>) doc.get("blocks")) {
			texts.add((String) ((Map<?, ?>) block).get("text"));
		}
		return texts;
	}

	private int countRows(String table) {
		return this.client.sql("SELECT COUNT(*) FROM " + table).query(Integer.class).single();
	}

	/** 인자와 호출 횟수를 기록하는 가짜 어댑터 — 네트워크는 없다(step4가 실제 구현을 만든다). */
	private static final class RecordingFetcher implements ApiSourceFetcher {

		private final List<String> endpoints = new ArrayList<>();

		private final List<String> apiKeys = new ArrayList<>();

		private ApiSourceFetcher.FetchResult next = new ApiSourceFetcher.FetchResult(true, "");

		private RuntimeException failure;

		private Runnable onCall;

		@Override
		public ApiSourceFetcher.FetchResult fetch(String endpoint, String apiKey) {
			this.endpoints.add(endpoint);
			this.apiKeys.add(apiKey);
			if (this.onCall != null) {
				this.onCall.run();
			}
			if (this.failure != null) {
				throw this.failure;
			}
			return this.next;
		}

		void returns(boolean ok, String body) {
			this.next = new ApiSourceFetcher.FetchResult(ok, body);
		}

		void returnsNothing() {
			this.next = null;
		}

		void throwsFailure(RuntimeException error) {
			this.failure = error;
		}

		void onCall(Runnable effect) {
			this.onCall = effect;
		}

		List<String> endpoints() {
			return List.copyOf(this.endpoints);
		}

		List<String> apiKeys() {
			return this.apiKeys;
		}

		int calls() {
			return this.endpoints.size();
		}

	}

}
