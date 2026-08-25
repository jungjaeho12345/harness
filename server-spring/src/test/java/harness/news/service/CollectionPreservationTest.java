package harness.news.service;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
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
 * DB 비파괴의 <b>행동 그물</b> — 수집 인제스트는 <b>삽입만</b> 한다.
 *
 * <h2>왜 이 파일이 따로 있는가(phase 70 testing_gate의 교훈)</h2>
 * phase 70에서 수신설정 삭제 코드가 문자열을 끊어 쓰면({@code "delete from" + " Article WHERE …"})
 * {@code Article} 테이블을 <b>통째로 비워도</b> Java 651건 · 계약 163관측 · 정적 스캔이 <b>전부
 * green</b>이었다. 그때 유일하게 남은 방어선이 <b>행 수 생존 단언</b>이었다. 수집은 같은 위험을 더 크게
 * 진다: 이 도메인은 {@code ArticleWriteService.create}를 재사용하고 {@code ReceiverConfigRepository}를
 * 읽으며, 두 저장소 모두 파괴적 문장을 가진 클래스다({@code update}·{@code DELETE FROM ReceiverConfig}).
 * "수집이 기존 데이터를 건드리지 않는다"는 사실은 <b>어떤 계약 케이스로도 관측되지 않는다</b> —
 * 계약은 자기가 만든 기사만 읽기 때문이다. 그래서 여기서 <b>운영 DB의 대역</b>(선행 데이터)을 깔고
 * 그 위로 성공·거부 전 경로를 통과시킨 뒤 <b>선행 행이 한 바이트도 변하지 않았음</b>을 단언한다.
 *
 * <h2>잠그는 명제</h2>
 * <ol>
 *   <li>성공 1회 = {@code Article}·{@code Contents} 정확히 <b>+1행</b>(그 이상도 이하도 아니다).</li>
 *   <li>거부 경로({@code unregistered}·{@code inactive}·{@code no-active-api-source}·
 *       {@code fetch-failed})는 <b>+0행</b>이다 — 부분 삽입 후 롤백이 아니라 아예 쓰지 않는다.</li>
 *   <li>선행 기사의 모든 컬럼이 <b>불변</b>이다(제목·본문·{@code status}·{@code createdAt}·
 *       {@code editedAt}). 수집이 기존 행을 {@code UPDATE}하면 여기서 red다.</li>
 *   <li>{@code ReceiverConfig}는 <b>읽기 전용</b>이다 — 수집이 수신 설정을 지우거나 고치지 않는다.</li>
 *   <li>{@code ArticleHistory}는 <b>0행 그대로</b>다(수집 create는 이력을 남기지 않는다).</li>
 * </ol>
 *
 * <p>DB는 {@code @TempDir} 임시 파일뿐이다 — 리포 {@code news.db}는 열지 않는다.
 */
class CollectionPreservationTest {

	private static final Instant T0 = Instant.parse("2026-08-22T01:02:03.004Z");

	/** 선행 데이터가 쓰는 표식 — 수집이 만든 기사와 섞이지 않게 한다. */
	private static final String LEGACY = "선행기사";

	@TempDir
	Path tempDir;

	private HikariDataSource dataSource;

	private JdbcClient client;

	private ReceiverConfigRepository configs;

	private ArticleWriteService writes;

	private StubFetcher fetcher;

	private CollectionService service;

	@BeforeEach
	void setUp() {
		TempNewsDb.seed(this.tempDir);
		this.dataSource = NewsDataSource.create(this.tempDir);
		this.client = JdbcClient.create(this.dataSource);
		Clock clock = Clock.fixed(T0, ZoneOffset.UTC);
		TransactionTemplate transactions = new TransactionTemplate(new JdbcTransactionManager(this.dataSource));
		ArticleRepository articles = new ArticleRepository(this.client, transactions, clock);
		this.writes = new ArticleWriteService(articles,
				new ArticleHistoryRecorder(new ArticleHistoryRepository(this.client), clock, (error) -> {
					// 이력 통지는 이 축의 관심사가 아니다.
				}), clock);
		this.configs = new ReceiverConfigRepository(this.client, transactions);
		this.fetcher = new StubFetcher();
		this.service = new CollectionService(this.configs, this.writes, this.fetcher);
	}

	@AfterEach
	void tearDown() {
		if (this.dataSource != null) {
			this.dataSource.close();
		}
	}

	/**
	 * 성공·거부를 섞어 전 경로를 통과시킨 뒤 <b>선행 행 전체</b>를 스냅샷과 대조한다.
	 *
	 * <p>단언이 "개수"와 "내용" 둘 다인 이유: 개수만 보면 같은 수의 행을 지우고 다시 넣는 코드가
	 * 통과하고, 내용만 보면 선행 행은 그대로 둔 채 다른 행을 지우는 코드가 통과한다.
	 */
	@Test
	void collectionOnlyEverInsertsAndLeavesEveryPreexistingRowByteForByte() {
		List<String> legacyIds = seedLegacyArticles(3);
		List<Map<String, Object>> articlesBefore = snapshot("Article");
		List<Map<String, Object>> contentsBefore = snapshot("Contents");

		register("sourceId", "keep-ftp", "type", "FTP");
		register("sourceId", "keep-api", "type", "API", "apiEndpoint", "http://127.0.0.1:1/x");
		register("sourceId", "keep-off", "type", "FTP", "active", "N");
		// 수신 설정 스냅샷은 등록 '뒤'에 뜬다 — 이 테스트가 보는 것은 "수집이 그 행을 건드리는가"다.
		List<Map<String, Object>> receiversBefore = snapshot("ReceiverConfig");
		int receiversAfterRegistration = count("ReceiverConfig");

		// 거부 4경로 — 한 행도 쓰지 않는다.
		assertDenied(this.service.receive("keep-none", "제목\n본문"), "unregistered");
		assertDenied(this.service.receive("keep-off", "제목\n본문"), "inactive");
		assertDenied(this.service.pull("keep-ftp"), "no-active-api-source");
		this.fetcher.fails();
		assertDenied(this.service.pull("keep-api"), "fetch-failed");

		assertEquals(legacyIds.size(), count("Article"), "거부 경로가 기사를 만들었다");
		assertEquals(legacyIds.size(), count("Contents"), "거부 경로가 본문을 만들었다");

		// 성공 2경로 — 정확히 2행이 늘어난다.
		this.fetcher.succeeds("{\"title\":\"수집제목\",\"content\":\"수집본문\"}");
		assertTrue(this.service.receive("keep-ftp", "밀어넣은 제목\n본문").ok());
		assertTrue(this.service.pull("keep-api").ok());

		assertEquals(legacyIds.size() + 2, count("Article"), "성공 1회는 Article 정확히 +1행이다");
		assertEquals(legacyIds.size() + 2, count("Contents"), "성공 1회는 Contents 정확히 +1행이다");
		assertEquals(0, count("ArticleHistory"), "수집 create는 이력을 남기지 않는다");
		assertEquals(receiversAfterRegistration, count("ReceiverConfig"),
				"수집이 수신 설정 행을 지웠다 — 이 도메인은 ReceiverConfig를 읽기만 한다");

		// 선행 행은 한 컬럼도 변하지 않았다.
		assertEquals(articlesBefore, rowsOf(snapshot("Article"), legacyIds),
				"선행 Article 행이 변했다 — 수집이 기존 기사를 갱신·삭제한다");
		assertEquals(contentsBefore, rowsOf(snapshot("Contents"), legacyIds),
				"선행 Contents 행이 변했다 — 수집이 기존 본문을 갱신·삭제한다");
		assertEquals(receiversBefore, rowsOf(snapshot("ReceiverConfig"), List.of()),
				"수집 실행 전에 있던 수신 설정 행이 변했다");
	}

	/**
	 * 파싱이 <b>예외로 죽는 값</b>이 와도 선행 데이터가 남는가.
	 *
	 * <p>{@code sourceId}가 바인딩 불가 타입이면 리포지토리가 던진다(→ 전역 핸들러 500). 그 경로가
	 * 트랜잭션을 열어 둔 채 죽으면 뒤이은 정상 수집이나 선행 행이 다칠 수 있다.
	 */
	@Test
	void aFailingRequestLeavesTheDatabaseExactlyAsItWas() {
		List<String> legacyIds = seedLegacyArticles(2);
		register("sourceId", "keep-ftp", "type", "FTP");
		List<Map<String, Object>> articlesBefore = snapshot("Article");
		List<Map<String, Object>> contentsBefore = snapshot("Contents");
		List<Map<String, Object>> receiversBefore = snapshot("ReceiverConfig");

		assertFalse(runQuietly(() -> this.service.receive(Boolean.TRUE, "제목")),
				"바인딩 불가 sourceId는 조용히 성공하면 안 된다");

		assertEquals(legacyIds.size(), count("Article"));
		assertEquals(articlesBefore, snapshot("Article"), "예외 경로가 선행 Article을 건드렸다");
		assertEquals(contentsBefore, snapshot("Contents"), "예외 경로가 선행 Contents를 건드렸다");
		assertEquals(receiversBefore, snapshot("ReceiverConfig"), "예외 경로가 수신 설정을 건드렸다");

		// 예외 뒤에도 정상 수집이 계속 된다(연결·트랜잭션이 남아 있지 않다).
		assertTrue(this.service.receive("keep-ftp", "그 다음 제목\n본문").ok());
		assertEquals(legacyIds.size() + 1, count("Article"));
	}

	/**
	 * 같은 {@code sourceId}로 여러 번 수집해도 <b>매번 새 행</b>이다(덮어쓰기가 아니다).
	 *
	 * <p>수집은 기사 식별자를 서버가 발급하므로 "같은 소스의 두 번째 수집"이 첫 번째를 덮으면 운영에서
	 * 기사가 조용히 사라진다. {@code articleId}가 전부 서로 다른지도 함께 본다.
	 */
	@Test
	void repeatedCollectionFromTheSameSourceAppendsInsteadOfOverwriting() {
		register("sourceId", "keep-ftp", "type", "FTP");

		List<String> created = new ArrayList<>();
		for (int i = 0; i < 5; i++) {
			CollectionService.Result result = this.service.receive("keep-ftp", "제목 " + i + "\n본문 " + i);
			assertTrue(result.ok());
			created.add(result.articleId());
		}

		assertEquals(5, count("Article"), "같은 소스의 반복 수집이 덮어썼다");
		assertEquals(5, created.stream().distinct().count(), "articleId가 재사용됐다");
		for (int i = 0; i < created.size(); i++) {
			assertEquals("제목 " + i, titleOf(created.get(i)), "먼저 만든 기사의 제목이 나중 수집에 덮였다");
		}
	}

	// --- 헬퍼 -------------------------------------------------------------------------------------

	/** 운영 DB의 대역 — 수집이 손대면 안 되는 선행 기사. */
	private List<String> seedLegacyArticles(int howMany) {
		List<String> ids = new ArrayList<>();
		for (int i = 0; i < howMany; i++) {
			Map<String, Object> dto = new LinkedHashMap<>();
			dto.put("title", LEGACY + " " + i);
			dto.put("markupVersion", "{\"format\":\"yh-editor\",\"version\":1,\"blocks\":["
					+ "{\"type\":\"text\",\"text\":\"" + LEGACY + " " + i + "\"}]}");
			dto.put("attribute", "일반기사");
			ids.add(this.writes.create(dto, "R", null));
		}
		return ids;
	}

	private void register(Object... keyValues) {
		Map<String, Object> entry = new LinkedHashMap<>();
		for (int i = 0; i < keyValues.length; i += 2) {
			entry.put((String) keyValues[i], keyValues[i + 1]);
		}
		this.configs.insert(entry);
	}

	private static void assertDenied(CollectionService.Result result, String reason) {
		assertFalse(result.ok(), reason + " 경로가 성공했다");
		assertEquals(reason, result.reason());
	}

	/** 예외를 삼키고 "성공했는가"만 돌려준다 — 어떤 예외 타입인지는 다른 테스트의 관심사다. */
	private static boolean runQuietly(Runnable body) {
		try {
			body.run();
			return true;
		}
		catch (RuntimeException ex) {
			return false;
		}
	}

	/** 테이블 전체를 결정적 순서로 읽는다(컬럼 이름·값 그대로 — 정규화하면 변화를 놓친다). */
	private List<Map<String, Object>> snapshot(String table) {
		return this.client.sql("SELECT * FROM " + table + " ORDER BY 1").query().listOfRows();
	}

	/** 스냅샷에서 선행 행만 남긴다 — 수집이 새로 만든 행은 비교 대상이 아니다. */
	private static List<Map<String, Object>> rowsOf(List<Map<String, Object>> rows, List<String> legacyIds) {
		if (legacyIds.isEmpty()) {
			return rows;
		}
		List<Map<String, Object>> kept = new ArrayList<>();
		for (Map<String, Object> row : rows) {
			if (legacyIds.contains(String.valueOf(row.get("articleId")))) {
				kept.add(row);
			}
		}
		return kept;
	}

	private int count(String table) {
		return this.client.sql("SELECT COUNT(*) FROM " + table).query(Integer.class).single();
	}

	private String titleOf(String articleId) {
		return this.client.sql("SELECT title FROM Contents WHERE articleId = ?")
				.param(articleId)
				.query(String.class)
				.single();
	}

	/** 네트워크 없는 어댑터 — 성공/실패만 정한다. */
	private static final class StubFetcher implements ApiSourceFetcher {

		private ApiSourceFetcher.FetchResult next = new ApiSourceFetcher.FetchResult(false, null);

		@Override
		public ApiSourceFetcher.FetchResult fetch(String endpoint, String apiKey) {
			return this.next;
		}

		void fails() {
			this.next = new ApiSourceFetcher.FetchResult(false, null);
		}

		void succeeds(String body) {
			this.next = new ApiSourceFetcher.FetchResult(true, body);
		}

	}

}
