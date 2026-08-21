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
import harness.news.testsupport.MutableClock;
import harness.news.testsupport.TempNewsDb;
import java.nio.file.Path;
import java.time.Instant;
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
 * 기사 쓰기 서비스 — 리포 루트 {@code src/services/articleService.js}의 {@code create}·{@code update}와
 * 1:1인 동작 계약. HTTP는 없다(@TempDir 임시 DB + 실제 리포지토리 — 리포 {@code news.db} 무접촉).
 *
 * <p>여기서 잠그는 것은 "저장되는 값"만이 아니라 <b>무엇이 저장될 수 <i>없는가</i></b>이다.
 * <ol>
 *   <li><b>화이트리스트 픽이 유일한 방어 수단이다</b> — 클라이언트가 보낸 {@code status}·{@code sender}·
 *       {@code articleId}·{@code distributedAt}·잠금 5컬럼은 <b>삭제 코드 없이</b> 자연히 빠진다.
 *       (삭제 목록은 새 필드가 생길 때마다 누락되지만 화이트리스트는 그렇지 않다.)</li>
 *   <li><b>{@code status}는 서버 계산값이다</b> — 클라가 정하면 그것이 권한 상승이다(ADR-004).</li>
 *   <li><b>{@code changes}는 두 갱신문의 합</b>이고 그 정수가 계약 리포트의 비교 값이다(decisions (18)).</li>
 *   <li><b>이력 실패는 삼키되 반드시 남긴다</b> — 이미 커밋된 편집을 되돌릴 수 없는 자리에서 예외로
 *       승격하면 호출자가 깨진다. 통지 페이로드에는 본문·토큰이 없다(LOGS.md 마스킹).</li>
 *   <li><b>present-only</b> — 주지 않은 필드는 건드리지 않는다(파일 참조 정화도 present인 것만).
 *       이것이 부분 수정이 남의 필드를 덮지 않는다는 DB 비파괴의 실질 보증이다.</li>
 * </ol>
 *
 * <p>기대값의 출처는 계획서가 아니라 <b>Node 정본 실측</b>이다(리포 밖 임시 DB에 스키마를 세우고
 * {@code createArticleService}의 쓰기 경로를 직접 관측했다 — 2026-08-21).
 */
class ArticleWriteServiceTest {

	/** 계약이 동결한 형태: {@code AKR} + 숫자 8자리(UTC 날짜) + 숫자 9자리. */
	private static final String ARTICLE_ID_RE = "^AKR\\d{8}\\d{9}$";

	/** 소수 <b>3자리 고정</b> ISO-8601 UTC — 정렬 키이자 범위 필터 입력이다(decisions (6)). */
	private static final String ISO_MILLIS_RE = "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$";

	/** 표시 제목이 {@code 첫줄제목}으로 파생되는 본문. */
	private static final String BODY = "{\"format\":\"yh-editor\",\"version\":1,\"blocks\":"
			+ "[{\"type\":\"text\",\"text\":\"첫줄제목\"},{\"type\":\"text\",\"text\":\"(끝)\"}]}";

	/** 공백만 있는 본문 — 파생 결과가 빈 문자열이다(그래도 저장한다: '' ≠ NULL). */
	private static final String BLANK_BODY = "{\"blocks\":[{\"type\":\"text\",\"text\":\"   \"}]}";

	private static final Instant T0 = Instant.parse("2026-08-20T12:34:56.789Z");

	private static final long ONE_MINUTE_MS = 60_000L;

	private static final long ONE_DAY_MS = 24L * 60L * 60L * 1000L;

	@TempDir
	Path tempDir;

	private HikariDataSource dataSource;

	private JdbcClient client;

	private MutableClock clock;

	private ArticleRepository articles;

	private ArticleHistoryRepository history;

	private CapturingListener notices;

	private ArticleWriteService service;

	@BeforeEach
	void setUp() {
		TempNewsDb.seed(tempDir);
		dataSource = NewsDataSource.create(tempDir);
		client = JdbcClient.create(dataSource);
		clock = new MutableClock(T0.toEpochMilli());
		articles = new ArticleRepository(client, transactions(), clock);
		history = new ArticleHistoryRepository(client);
		notices = new CapturingListener();
		service = new ArticleWriteService(articles, new ArticleHistoryRecorder(history, clock, notices), clock);
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

	// --- 1. 신규 저장: 서버 계산값 + 발급 ---------------------------------------------------------

	@Test
	void createIssuesTheArticleIdAndStampsTheServerComputedStatusAndTime() {
		String articleId = service.create(
				row("title", "제목1", "markupVersion", BODY, "modifier", "u1", "author", "김기자",
						"department", "사회부", "departmentCode", "D01", "category", "정치"),
				"R", null);

		assertNotNull(articleId);
		assertTrue(articleId.matches(ARTICLE_ID_RE), "articleId는 AKR + 8자리 날짜 + 9자리 난수다: " + articleId);
		assertTrue(articleId.startsWith("AKR20260820"), "날짜는 로컬이 아니라 UTC다(주입 시계 기준)");

		Map<String, Object> contents = contentsOf(articleId);
		assertEquals("RDS", contents.get("status"), "초기 status는 서버 계산값 RDS다");
		assertEquals("2026-08-20T12:34:56.789Z", contents.get("createdAt"), "createdAt은 주입 시계에서만 온다");
		assertTrue(String.valueOf(contents.get("createdAt")).matches(ISO_MILLIS_RE), "소수 3자리 고정 형식");
		assertEquals(articleId, contents.get("articleId"));
		assertEquals("제목1", contents.get("title"));
		assertEquals("김기자", contents.get("author"));
		assertEquals("사회부", contents.get("department"));
		assertEquals("정치", contents.get("category"));

		Map<String, Object> article = articleOf(articleId);
		assertEquals(articleId, article.get("articleId"));
		assertEquals("제목1", article.get("title"));
		assertEquals(BODY, article.get("markupVersion"), "본문은 Article 테이블에 들어간다");
		assertEquals("u1", article.get("modifier"));

		// 신규 저장은 잠기지 않는다(잠금 컬럼을 쓰지 않으므로 스키마 기본값 그대로다).
		assertEquals("N", contents.get("lockYN"));
		assertNull(contents.get("lockerUserId"));
		assertNull(contents.get("editedAt"), "신규 저장은 editedAt을 stamp하지 않는다");
	}

	@Test
	void createIgnoresEveryColumnTheClientCannotDecide() {
		// 클라이언트가 결정할 수 없는 값을 전부 실어 보낸다 — 반영되면 그것이 결함이다(ADR-004).
		String articleId = service.create(
				row("title", "신뢰경계", "markupVersion", BODY,
						"status", "DPS", "sender", "client-sender", "articleId", "client-supplied-id",
						"distributedAt", "2020-01-01T00:00:00.000Z", "sentAt", "2020-01-01T00:00:00.000Z",
						"createdAt", "2020-01-01T00:00:00.000Z", "editedAt", "2020-01-01T00:00:00.000Z",
						"role", "Z", "lockYN", "Y", "lockerUserId", "hacker", "lockerSessionId", "STOLEN",
						"lockerClientId", "tab-x", "lockedAt", "2020-01-01T00:00:00.000Z",
						"content", "클라가 보낸 content", "bogusKey", "무시"),
				"R", null);

		assertFalse("client-supplied-id".equals(articleId), "articleId는 서버가 발급한다");
		Map<String, Object> contents = contentsOf(articleId);
		assertEquals("RDS", contents.get("status"), "클라가 보낸 status는 반영되지 않는다");
		assertEquals(articleId, contents.get("articleId"), "저장된 articleId는 서버 발급 값이다");
		assertNull(contents.get("sender"), "sender는 송고가 정한다");
		assertNull(contents.get("distributedAt"), "distributedAt은 배부가 정한다");
		assertNull(contents.get("sentAt"));
		assertEquals("2026-08-20T12:34:56.789Z", contents.get("createdAt"), "createdAt도 서버가 정한다");
		assertNull(contents.get("editedAt"));

		// 잠금 5컬럼은 화이트리스트 밖이라 문장에 아예 들어가지 않는다 — 세션 토큰을 주입할 자리가 없다.
		assertEquals("N", contents.get("lockYN"));
		assertNull(contents.get("lockerUserId"));
		assertNull(contents.get("lockerSessionId"));
		assertNull(contents.get("lockerClientId"));
		assertNull(contents.get("lockedAt"));

		// content 컬럼은 어느 화이트리스트에도 없다 — 두 테이블 모두 NULL로 남는다(키는 응답 27키에 있다).
		assertNull(contents.get("content"), "Contents.content는 쓰지 않는다");
		assertNull(articleOf(articleId).get("content"), "Article.content는 쓰지 않는다");
	}

	// --- 2. 초기 상태 계산 ----------------------------------------------------------------------

	@Test
	void theInitialStatusComesFromTheSessionRoleAndTheIntent() {
		assertEquals("DDH", statusOfNew("D", "hold"), "D + hold");
		assertEquals("RRH", statusOfNew("R", "hold"), "R + hold");
		assertEquals("DDH", statusOfNew("Z", "hold"), "Z는 D와 같은 표를 쓴다");
		assertEquals("RDS", statusOfNew("D", "send"), "최초 송고는 권한 무관 RDS 유지다");
		assertEquals("RDS", statusOfNew(null, null), "role·action 미지정이면 RDS다");
		assertEquals("RDS", statusOfNew("X", "hold"), "표가 모르는 role의 보류도 RDS로 흡수된다");
	}

	// --- 3. 신규 저장은 이력을 남기지 않는다 ------------------------------------------------------

	@Test
	void createLeavesNoHistoryRow() {
		// 계약: 갓 만든 기사의 이력은 빈 배열이다. 여기서 create 행을 남기면 그 단언이 깨진다.
		String articleId = service.create(row("title", "t", "markupVersion", BODY), "R", "hold");

		// 공허하지 않은 단언이 되게 기사부터 확인한다 — "아무것도 안 하면 통과"하는 테스트를 만들지 않는다.
		assertNotNull(articles.findById(articleId), "기사는 저장됐다(없는 것은 이력뿐이다)");
		assertEquals("RRH", contentsOf(articleId).get("status"), "R + hold의 초기 상태");
		assertEquals(List.of(), history.queryByArticle(articleId), "생성은 이력 행을 남기지 않는다");
		assertEquals(0, countRows("ArticleHistory"), "원장 전체에도 행이 없다");
		assertEquals(List.of(), notices.captured, "실패 통지도 없다");
	}

	// --- 4. 부분 수정: present-only + editedAt + changes -----------------------------------------

	@Test
	void updateAppliesOnlyTheGivenFieldsAndStampsEditedAt() {
		String articleId = service.create(
				row("title", "원제목", "markupVersion", BODY, "author", "김기자", "department", "사회부",
						"category", "정치"),
				"R", null);
		clock.advance(ONE_MINUTE_MS);

		int changes = service.update(articleId, row("title", "새제목", "markupVersion", BODY, "modifier", "u2"));

		assertEquals(2, changes, "Article 1행 + Contents 1행 = 2");
		Map<String, Object> contents = contentsOf(articleId);
		assertEquals("새제목", contents.get("title"));
		assertEquals("u2", contents.get("modifier"));
		assertEquals("2026-08-20T12:35:56.789Z", contents.get("editedAt"), "editedAt은 주입 시계에서만 온다");
		assertEquals("2026-08-20T12:34:56.789Z", contents.get("createdAt"), "createdAt은 그대로다");
		// 주지 않은 필드는 문장에 들어가지 않는다 — 부분 수정이 남의 필드를 덮지 않는다(DB 비파괴).
		assertEquals("김기자", contents.get("author"), "미전달 필드는 보존된다");
		assertEquals("사회부", contents.get("department"));
		assertEquals("정치", contents.get("category"));
		assertEquals("RDS", contents.get("status"), "status는 전이 라우트만 바꾼다");
		assertEquals("새제목", articleOf(articleId).get("title"), "Article도 함께 바뀐다");
	}

	@Test
	void changesIsTheSumOfTheTwoUpdateStatements() {
		String articleId = service.create(row("title", "t", "markupVersion", BODY), "R", null);

		// 정본 실측 그대로: 두 테이블 2 / Contents만 1 / 빈 입력도 1(editedAt은 언제나 stamp된다).
		assertEquals(2, service.update(articleId, row("title", "새제목", "modifier", "u2")), "양쪽 테이블 = 2");
		assertEquals(1, service.update(articleId, row("category", "정치")), "Contents 전용 필드 = 1");
		assertEquals(2, service.update(articleId, row("markupVersion", BODY)), "Article + editedAt = 2");
		assertEquals(1, service.update(articleId, Map.of()), "입력이 없어도 editedAt 한 문장은 돈다");
		assertEquals(1, service.update(articleId, row("bogus", "x", "lockYN", "Y", "status", "DPS")),
				"화이트리스트 밖 키만 와도 editedAt 문장 때문에 1이다");
		assertEquals(0, service.update("NO-SUCH-ARTICLE", row("title", "x")),
				"없는 기사면 영향 행이 0이다(존재 검사는 호출자 몫 — 여기서 404를 만들지 않는다)");
	}

	// --- 5. 편집 이력 ---------------------------------------------------------------------------

	@Test
	void updateAppendsAnEditHistoryRowWhoseSnapshotFollowsTheBody() {
		String articleId = service.create(row("title", "t", "markupVersion", BODY), "R", null);
		clock.advance(ONE_MINUTE_MS);

		service.update(articleId, row("title", "새제목", "markupVersion", BODY, "modifier", "u2"));
		clock.advance(ONE_MINUTE_MS);
		service.update(articleId, row("category", "정치", "modifier", "u3")); // 본문 없는 메타 편집

		List<Map<String, Object>> rows = historyRowsOf(articleId);
		assertEquals(2, rows.size(), "편집 2회 = 이력 2행(append-only)");

		Map<String, Object> withBody = rows.get(0);
		assertEquals("edit", withBody.get("eventType"));
		assertEquals("u2", withBody.get("actorUserId"), "actor는 호출자가 stamp한 modifier다");
		assertEquals(BODY, withBody.get("markupVersion"), "이 편집에서 저장되는 본문이 스냅샷이다");
		assertEquals("2026-08-20T12:35:56.789Z", withBody.get("createdAt"));
		assertNull(withBody.get("action"), "편집은 전이가 아니다");
		assertNull(withBody.get("fromStatus"));
		assertNull(withBody.get("toStatus"));

		Map<String, Object> metaOnly = rows.get(1);
		assertEquals("edit", metaOnly.get("eventType"));
		assertEquals("u3", metaOnly.get("actorUserId"));
		assertNull(metaOnly.get("markupVersion"), "본문 없는 편집은 스냅샷이 없다");

		// 이력 목록의 hasSnapshot(정수 1/0)이 본문 유무를 따른다.
		List<Map<String, Object>> listed = history.queryByArticle(articleId);
		assertEquals(2, listed.size(), "이력 목록도 2행이다");
		assertEquals(1, hasSnapshotOf(listed, withBody), "본문 있는 편집의 hasSnapshot은 1이다");
		assertEquals(0, hasSnapshotOf(listed, metaOnly), "본문 없는 메타 편집의 hasSnapshot은 0이다");
	}

	// --- 6. 표시 제목 파생 저장 -----------------------------------------------------------------

	@Test
	void theDisplayTitleIsStoredWheneverTheBodyIsANonEmptyStringIncludingAnEmptyDerivation() {
		String articleId = service.create(row("title", "t", "markupVersion", BODY), "R", null);

		service.update(articleId, row("markupVersion", BODY, "modifier", "u1"));
		service.update(articleId, row("markupVersion", BLANK_BODY, "modifier", "u1"));
		service.update(articleId, row("markupVersion", "", "modifier", "u1"));
		service.update(articleId, row("modifier", "u1"));

		List<Map<String, Object>> rows = historyRowsOf(articleId);
		assertEquals(4, rows.size());
		assertEquals("첫줄제목", rows.get(0).get("snapshotTitle"), "본문이 있으면 표시 제목을 파생해 함께 저장한다");
		// 빈 파생 결과도 그대로 저장한다 — NULL로 바꾸면 그 행이 영구 레거시로 오판돼 이력보기마다 본문을 다시 읽는다.
		assertEquals("", rows.get(1).get("snapshotTitle"), "파생 결과가 ''여도 저장한다('' ≠ NULL)");
		assertNotNull(rows.get(1).get("snapshotTitle"), "빈 문자열은 NULL이 아니다");
		assertNull(rows.get(2).get("snapshotTitle"), "본문이 빈 문자열이면 제목 컬럼을 싣지 않는다");
		assertNull(rows.get(3).get("snapshotTitle"), "본문이 없는 편집도 마찬가지다");
	}

	// --- 7. 이력 실패 격리 ---------------------------------------------------------------------

	@Test
	void aFailingHistoryInsertStillSavesTheEditAndNotifiesWithoutTheBody() {
		ArticleWriteService degraded = new ArticleWriteService(articles,
				new ArticleHistoryRecorder(new FailingHistoryRepository(client), clock, notices), clock);
		String articleId = degraded.create(row("title", "t", "markupVersion", BODY), "R", null);

		int changes = degraded.update(articleId, row("title", "실패에도저장", "markupVersion", BODY, "modifier", "u1"));

		assertEquals(2, changes, "이력 실패는 편집을 되돌리지 않는다(예외 승격 금지)");
		assertEquals("실패에도저장", contentsOf(articleId).get("title"), "편집은 커밋된 채로 남는다");

		assertEquals(1, notices.captured.size(), "삼키되 반드시 남긴다");
		ArticleHistoryRecorder.HistoryError notice = notices.captured.get(0);
		assertEquals(articleId, notice.articleId(), "식별자는 담는다");
		assertEquals("edit", notice.eventType());
		assertNull(notice.action(), "편집은 전이가 아니라 action이 없다");
		assertEquals("이력 저장 실패(주입)", notice.reason(), "사유는 원인 예외의 메시지다");
		// LOGS.md 마스킹 — 통지 페이로드에 본문 스냅샷이 없다.
		assertFalse(String.valueOf(notice).contains("첫줄제목"), "통지에 본문이 없다");
		assertFalse(String.valueOf(notice).contains(BODY), "통지에 본문 원문이 없다");
	}

	@Test
	void aFailingNotificationDoesNotBreakTheEdit() {
		ArticleHistoryRecorder.HistoryErrorListener exploding = (error) -> {
			throw new IllegalStateException("통지 실패");
		};
		ArticleWriteService degraded = new ArticleWriteService(articles,
				new ArticleHistoryRecorder(new FailingHistoryRepository(client), clock, exploding), clock);
		String articleId = degraded.create(row("title", "t", "markupVersion", BODY), "R", null);

		assertEquals(2, degraded.update(articleId, row("title", "통지실패에도저장", "markupVersion", BODY)),
				"통지 자체의 실패도 본 기능을 막지 않는다");
		assertEquals("통지실패에도저장", contentsOf(articleId).get("title"));
	}

	@Test
	void theDefaultListenerWritesAWarningLineThatCarriesNoBody() {
		LogService logs = new LogService(clock, LogService.DEFAULT_CAP, LogService.KST_OFFSET_MINUTES);
		ArticleWriteService degraded = new ArticleWriteService(articles,
				new ArticleHistoryRecorder(new FailingHistoryRepository(client), clock,
						new HistoryErrorLogger(logs)),
				clock);
		String articleId = degraded.create(row("title", "t", "markupVersion", BODY), "R", null);

		degraded.update(articleId, row("title", "x", "markupVersion", BODY, "modifier", "u1"));

		// 다이제스트 창은 언제나 '과거 구간'이라 방금 쌓인 줄은 다음 06:00이 지나야 들어온다 —
		// 하루 뒤 시점으로 조회한다(그 창 규칙 자체는 LogServiceTest의 소유다).
		List<LogRecord> written = logs.digest(clock.millis() + ONE_DAY_MS);
		assertEquals(1, written.size(), "경고가 정확히 한 줄 남는다");
		LogRecord warning = written.get(0);
		assertEquals(LogRecord.Level.WARN, warning.level(), "레벨은 WARN이다(본 기능은 실패하지 않았다)");
		assertTrue(warning.message().contains(articleId), "식별자는 담는다");
		assertTrue(warning.message().contains("이력 저장 실패(주입)"), "사유는 담는다");
		// 이 버퍼는 GET /api/logs/digest로 밖으로 나간다 — 본문 한 조각도 담기면 그것이 곧 응답이다.
		assertFalse(warning.line().contains("첫줄제목"), "로그 줄에 본문이 없다");
		assertFalse(warning.line().contains(BODY), "로그 줄에 본문 원문이 없다");
	}

	// --- 8. 파일 참조 정화(present-only) --------------------------------------------------------

	@Test
	void fileReferencesAreSanitizedOnlyWhenPresent() {
		String articleId = service.create(
				row("title", "t", "markupVersion", BODY,
						"attachmentFile", "/uploads/ok.jpg", "referenceFile", "javascript:alert(1)"),
				"R", null);

		Map<String, Object> created = contentsOf(articleId);
		assertEquals("/uploads/ok.jpg", created.get("attachmentFile"), "업로드 경로는 보존된다");
		assertEquals("", created.get("referenceFile"), "위험 스킴은 빈 문자열로 무력화된다");

		// 미전달 필드는 추가·변경하지 않는다 — 정화를 미전달 필드에까지 적용하면 null이 ''로 바뀐다.
		String bare = service.create(row("title", "t", "markupVersion", BODY), "R", null);
		assertNull(contentsOf(bare).get("attachmentFile"), "미전달 파일 참조는 NULL로 남는다(''가 아니다)");
		assertNull(contentsOf(bare).get("referenceFile"));

		service.update(articleId, row("attachmentFile", "https://cdn.example.com/a.jpg"));
		assertEquals("https://cdn.example.com/a.jpg", contentsOf(articleId).get("attachmentFile"),
				"https는 원문 그대로 통과한다");
		assertEquals("", contentsOf(articleId).get("referenceFile"), "미전달 필드는 그대로다");

		service.update(articleId, row("attachmentFile", "/uploads/a/../../etc/passwd"));
		assertEquals("", contentsOf(articleId).get("attachmentFile"), "traversal은 거부된다");
	}

	// --- 9. 트랜잭션 원자성 ---------------------------------------------------------------------

	@Test
	void aFailedContentsInsertLeavesNoArticleRow() {
		// author는 Contents 화이트리스트에만 있다 — Article 삽입이 끝난 뒤 Contents 삽입에서 실패한다.
		// 불리언은 바인딩 정책이 거부하는 값이다(decisions (8) — Node의 node:sqlite도 TypeError를 던진다).
		Map<String, Object> dto = row("title", "트랜잭션실패제목", "markupVersion", BODY, "author", Boolean.TRUE);

		assertThrows(IllegalArgumentException.class, () -> service.create(dto, "R", null));

		assertEquals(0, countRows("Article"), "Contents가 실패하면 Article 행도 남지 않는다");
		assertEquals(0, countRows("Contents"));
		assertEquals(0, countArticlesTitled("트랜잭션실패제목"), "반쪽 기사가 만들어지지 않는다");
	}

	// --- 10. 화이트리스트 밖 키 + 잠금 컬럼 보존 --------------------------------------------------

	@Test
	void keysOutsideTheWhitelistAreIgnoredAndTheLockColumnsSurviveTheEdit() {
		String articleId = service.create(row("title", "t", "markupVersion", BODY), "R", null);
		articles.setLock(articleId, new ArticleRepository.EditLock("desk1", "SECRET-SESSION-TOKEN", "tab-1",
				"2026-08-20T12:00:00.000Z"));

		int changes = service.update(articleId,
				row("title", "새제목",
						"lockYN", "N", "lockerUserId", "hacker", "lockerSessionId", "STOLEN",
						"lockerClientId", "tab-x", "lockedAt", "2020-01-01T00:00:00.000Z",
						"status", "DPS", "sender", "탈취", "articleId", "다른기사", "role", "Z",
						"distributedAt", "2020-01-01T00:00:00.000Z", "createdAt", "2020-01-01T00:00:00.000Z",
						"bogusKey", "무시"));

		assertEquals(2, changes);
		Map<String, Object> contents = contentsOf(articleId);
		assertEquals("새제목", contents.get("title"), "화이트리스트 안 필드는 반영된다");
		// 잠금 5컬럼은 잠금 라우트만 바꾼다 — 저장 요청으로 보유자를 갈아치울 수 없다.
		assertEquals("Y", contents.get("lockYN"));
		assertEquals("desk1", contents.get("lockerUserId"));
		assertEquals("SECRET-SESSION-TOKEN", contents.get("lockerSessionId"));
		assertEquals("tab-1", contents.get("lockerClientId"));
		assertEquals("2026-08-20T12:00:00.000Z", contents.get("lockedAt"));
		// 전이·배부 컬럼도 그대로다.
		assertEquals("RDS", contents.get("status"));
		assertNull(contents.get("sender"));
		assertNull(contents.get("distributedAt"));
		assertEquals(articleId, contents.get("articleId"), "PK는 SET 대상이 아니다");
		assertEquals("2026-08-20T12:34:56.789Z", contents.get("createdAt"));
	}

	// --- 픽스처·헬퍼 ---------------------------------------------------------------------------

	private String statusOfNew(String role, String action) {
		String articleId = service.create(row("title", "t", "markupVersion", BODY), role, action);
		return String.valueOf(contentsOf(articleId).get("status"));
	}

	private static Map<String, Object> row(Object... keyValues) {
		Map<String, Object> row = new LinkedHashMap<>();
		for (int i = 0; i < keyValues.length; i += 2) {
			row.put(String.valueOf(keyValues[i]), keyValues[i + 1]);
		}
		return row;
	}

	/** 저장된 {@code Contents} 원본 컬럼을 읽는다(투영 전 — 잠금 컬럼까지 확인하기 위해서다). */
	private Map<String, Object> contentsOf(String articleId) {
		ArticleAggregate found = articles.findById(articleId);
		assertNotNull(found, "기사가 저장되지 않았다: " + articleId);
		assertNotNull(found.contents(), "Contents 행이 없다: " + articleId);
		Map<String, Object> columns = new LinkedHashMap<>();
		for (String column : List.of("articleId", "title", "content", "author", "modifier", "sender",
				"department", "departmentCode", "createdAt", "editedAt", "sentAt", "distributedAt",
				"embargoAt", "secondEmbargoAt", "status", "lockYN", "lockerUserId", "lockerSessionId",
				"lockerClientId", "lockedAt", "category", "attachmentFile", "referenceFile")) {
			columns.put(column, found.contents().column(column));
		}
		return columns;
	}

	private Map<String, Object> articleOf(String articleId) {
		ArticleAggregate found = articles.findById(articleId);
		assertNotNull(found, "기사가 저장되지 않았다: " + articleId);
		assertNotNull(found.article(), "Article 행이 없다: " + articleId);
		return found.article();
	}

	/** 저장 제목 컬럼까지 보려면 원장을 직접 읽어야 한다(조회 API 3종은 그 컬럼을 싣지 않는다). */
	private List<Map<String, Object>> historyRowsOf(String articleId) {
		return client.sql("SELECT id, eventType, action, fromStatus, toStatus, actorUserId, createdAt,"
						+ " markupVersion, snapshotTitle FROM ArticleHistory WHERE articleId = ? ORDER BY id")
				.param(articleId)
				.query()
				.listOfRows();
	}

	private static int hasSnapshotOf(List<Map<String, Object>> listed, Map<String, Object> row) {
		long id = ((Number) row.get("id")).longValue();
		for (Map<String, Object> item : listed) {
			if (((Number) item.get("id")).longValue() == id) {
				return ((Number) item.get("hasSnapshot")).intValue();
			}
		}
		throw new AssertionError("id " + id + " 행이 목록에 없다: " + listed);
	}

	private int countRows(String table) {
		return client.sql("SELECT COUNT(*) FROM " + table).query(Integer.class).single();
	}

	private int countArticlesTitled(String title) {
		return client.sql("SELECT COUNT(*) FROM Article WHERE title = ?")
				.param(title)
				.query(Integer.class)
				.single();
	}

	/** 통지 seam 관측용 — Node의 {@code onHistoryError} 콜백과 같은 자리다. */
	private static final class CapturingListener implements ArticleHistoryRecorder.HistoryErrorListener {

		private final List<ArticleHistoryRecorder.HistoryError> captured = new ArrayList<>();

		@Override
		public void onHistoryError(ArticleHistoryRecorder.HistoryError error) {
			this.captured.add(error);
		}

	}

	/** 이력 삽입만 실패하는 리포지토리 — 실패가 본 기능을 막지 않는다는 것을 실증한다. */
	private static final class FailingHistoryRepository extends ArticleHistoryRepository {

		FailingHistoryRepository(JdbcClient jdbcClient) {
			super(jdbcClient);
		}

		@Override
		public long insert(Map<String, ?> record) {
			throw new IllegalStateException("이력 저장 실패(주입)");
		}

	}

}
