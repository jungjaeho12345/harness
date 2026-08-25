package harness.news.service;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.zaxxer.hikari.HikariDataSource;
import harness.news.db.NewsDataSource;
import harness.news.db.RequiredSchema;
import harness.news.model.ArticleAggregate;
import harness.news.model.ArticleHistoryRepository;
import harness.news.model.ArticleRepository;
import harness.news.model.ContentsRow;
import harness.news.testsupport.MutableClock;
import harness.news.testsupport.TempNewsDb;
import java.nio.file.Path;
import java.time.Instant;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import java.util.TreeSet;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.jdbc.support.JdbcTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

/**
 * 생애주기 서비스 — 리포 루트 {@code src/services/articleService.js}의 {@code applyAction}·
 * {@code deriveArticle}과 1:1인 동작 계약. HTTP는 없다(@TempDir 임시 DB + 실제 리포지토리 —
 * 리포 {@code news.db} 무접촉).
 *
 * <p>여기서 잠그는 것은 다섯 가지다.
 * <ol>
 *   <li><b>가드 순서</b> — 존재 → <b>전이표</b> → 마커 → 엠바고 → stamp·저장 → 이력. 순서가 한 칸
 *       바뀌면 같은 요청이 400과 409 사이에서 갈린다(계약이 그 순서를 명시적으로 동결했다).</li>
 *   <li><b>엠바고 진입은 설정 여부만 본다</b> — 시각 비교를 넣으면 도래 전 기사가 즉시 배부 상태로
 *       떨어진다. "지금이 엠바고 시각인가"는 배부 tick의 질문이다(ADR-008).</li>
 *   <li><b>거부 경로는 아무것도 남기지 않는다</b> — 상태도 이력도. 이력은 감사 기록이자 판정 입력이다.</li>
 *   <li><b>DB 비파괴</b> — 삭제 승인은 상태 전이라 행이 남고, 상태 저장은 present-only라 본문·잠금·
 *       {@code distributedAt}을 함께 쓰지 않으며, 파생은 원본을 한 글자도 바꾸지 않는다.</li>
 *   <li><b>배부 훅의 의도된 부재</b> — 송고가 {@code distributedAt}을 채우지 않고 {@code distribute}
 *       이력도 남기지 않는다(excluded (c) — 배부 phase 소유).</li>
 * </ol>
 *
 * <p>기대값의 출처는 계획서가 아니라 <b>Node 정본 실측</b>이다(리포 밖 임시 DB에 스키마를 세우고
 * {@code createArticleService}의 {@code applyAction}·{@code deriveArticle}을 상태 11 × role 5 ×
 * action 6 격자와 엠바고 7변형 × 5경로로 직접 관측했다 — 2026-08-21).
 */
class ArticleLifecycleServiceTest {

	/** 소수 <b>3자리 고정</b> ISO-8601 UTC — 정렬 키이자 범위 필터 입력이다(decisions (6)). */
	private static final String ISO_MILLIS_RE = "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$";

	/** 계약이 동결한 형태: {@code AKR} + 숫자 8자리(UTC 날짜) + 숫자 9자리. */
	private static final String ARTICLE_ID_RE = "^AKR\\d{8}\\d{9}$";

	/** 송고 가드를 통과하는 본문(마커 포함). 블록에 {@code type} 키가 없는 계약 픽스처와 같은 모양이다. */
	private static final String BODY_WITH_MARKER =
			"{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"text\":\"본문\"},{\"text\":\"(끝)\"}]}";

	/** 마커가 없는 본문 — 송고 가드에 걸린다. */
	private static final String BODY_WITHOUT_MARKER =
			"{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"text\":\"마커 없는 본문\"}]}";

	private static final String MISSING_ID = "AKR00000000000000000";

	private static final Instant T0 = Instant.parse("2026-08-20T12:34:56.789Z");

	/**
	 * 전이표의 <b>허용 칸 15</b> — 데스크 12 + 기자 3. {@code role}은 그 칸이 속한 표의 대표값이다
	 * (D와 Z는 같은 표를 쓰며 그 동형은 별도 테스트가 12칸 전수로 잠근다).
	 *
	 * <p>이 목록은 {@code src/services/lifecycle.js} 전수 관측(11 status × 3 role × 4 action에서
	 * 허용 27건 → Z를 D로 접으면 서로 다른 칸 15)의 결과다. <b>칸을 늘리는 것은 계약 변경이다.</b>
	 */
	private static final List<Cell> ALLOWED_CELLS = List.of(
			new Cell("RDS", "D", "send", "DPS"),
			new Cell("RDS", "D", "hold", "DDH"),
			new Cell("RDS", "D", "kill", "DDK"),
			new Cell("DPS", "D", "send", "DPS"),
			new Cell("DPS", "D", "hold", "DDH"),
			new Cell("DPS", "D", "approveDelete", "DPD"),
			new Cell("DDH", "D", "send", "DPS"),
			new Cell("DDH", "D", "kill", "DDK"),
			new Cell("DES", "D", "kill", "EEK"),
			new Cell("DES", "D", "hold", "EEH"),
			new Cell("EPS", "D", "kill", "EEK"),
			new Cell("EPS", "D", "hold", "EEH"),
			new Cell("RDS", "R", "send", "RDS"),
			new Cell("RDS", "R", "hold", "RRH"),
			new Cell("RDS", "R", "kill", "RRK"));

	/**
	 * {@code contract/cases/minimal/transitions.contract.js}의 {@code ALLOWED} 배열 <b>16건</b>을
	 * 그대로 옮긴 것. 칸 수(15)와 <b>수가 다르다</b> — Z 3건이 D와 같은 칸을 두 번 관측하기 때문이며,
	 * 대신 계약은 {@code EPS}발 2칸에 도달하지 못한다(excluded (d)).
	 */
	private static final List<Cell> CONTRACT_CASES = List.of(
			new Cell("RDS", "D", "send", "DPS"),
			new Cell("RDS", "D", "hold", "DDH"),
			new Cell("RDS", "D", "kill", "DDK"),
			new Cell("DPS", "D", "send", "DPS"),
			new Cell("DPS", "D", "hold", "DDH"),
			new Cell("DPS", "D", "approveDelete", "DPD"),
			new Cell("DDH", "D", "send", "DPS"),
			new Cell("DDH", "D", "kill", "DDK"),
			new Cell("DES", "D", "kill", "EEK"),
			new Cell("DES", "D", "hold", "EEH"),
			new Cell("RDS", "Z", "send", "DPS"),
			new Cell("RDS", "Z", "hold", "DDH"),
			new Cell("DPS", "Z", "approveDelete", "DPD"),
			new Cell("RDS", "R", "send", "RDS"),
			new Cell("RDS", "R", "hold", "RRH"),
			new Cell("RDS", "R", "kill", "RRK"));

	/** 계약이 관측하는 거부 칸 5 — 전이표 밖이라 {@code forbidden-transition}이다. */
	private static final List<Cell> REJECTED_CELLS = List.of(
			new Cell("DPS", "R", "send", null),
			new Cell("RDS", "R", "approveDelete", null),
			new Cell("DDH", "D", "hold", null),
			new Cell("RRK", "D", "send", null),
			new Cell("DPD", "D", "send", null));

	/** 파생이 복사하는 공통정보 <b>9키</b>(실측 — 주석이 아니라 이 목록이 계약이다). */
	private static final List<String> DERIVE_COPIED_FIELDS = List.of(
			"coAuthor", "category", "region", "attribute", "keyword",
			"internalComment", "externalComment", "attachmentFile", "referenceFile");

	@TempDir
	Path tempDir;

	private HikariDataSource dataSource;

	private JdbcClient client;

	private MutableClock clock;

	private ArticleRepository articles;

	private ArticleHistoryRepository history;

	private ArticleWriteService writeService;

	private ArticleLifecycleService service;

	@BeforeEach
	void setUp() {
		TempNewsDb.seed(tempDir);
		dataSource = NewsDataSource.create(tempDir);
		client = JdbcClient.create(dataSource);
		clock = new MutableClock(T0.toEpochMilli());
		articles = new ArticleRepository(client, transactions(), clock);
		history = new ArticleHistoryRepository(client);
		ArticleHistoryRecorder recorder = new ArticleHistoryRecorder(history, clock, error -> {
		});
		writeService = new ArticleWriteService(articles, recorder, clock);
		service = new ArticleLifecycleService(articles, writeService, recorder, clock);
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

	// --- 1. 전이 허용 칸 전수 --------------------------------------------------------------------

	@Test
	void everyAllowedCellOfTheTableMovesTheArticleAndTheReadBackAgrees() {
		assertEquals(15, ALLOWED_CELLS.size(), "전이표의 허용 칸은 15다(데스크 12 + 기자 3)");

		for (Cell cell : ALLOWED_CELLS) {
			String articleId = place(cell.from());
			ArticleLifecycleService.ActionResult result =
					service.applyAction(articleId, cell.role(), cell.action(), "u-grid");

			assertTrue(result.ok(), cell + ": 허용 칸인데 거부됐다 — " + result.reason());
			assertNull(result.reason(), cell + ": 허용 결과에는 사유가 없다");
			assertEquals(cell.to(), result.status(), cell + ": 전이 결과");
			assertEquals(cell.to(), statusOf(articleId), cell + ": 되읽은 상태(응답과 DB가 갈라지면 결함)");
		}
	}

	@Test
	void theAdminRoleUsesTheSameTableAsTheDesk() {
		// 계약은 Z를 대표 3칸으로만 못 박는다 — 데스크 12칸 전수의 동형은 이 테스트가 유일한 방어선이다.
		int deskCells = 0;
		for (Cell cell : ALLOWED_CELLS) {
			if (!"D".equals(cell.role())) {
				continue;
			}
			deskCells++;
			String articleId = place(cell.from());
			ArticleLifecycleService.ActionResult result =
					service.applyAction(articleId, "Z", cell.action(), "u-admin");

			assertTrue(result.ok(), cell + ": Z도 같은 표를 쓴다 — " + result.reason());
			assertEquals(cell.to(), result.status(), cell + ": Z의 전이 결과는 D와 같다");
			assertEquals(cell.to(), statusOf(articleId), cell + ": Z의 되읽은 상태");
		}
		assertEquals(12, deskCells, "데스크 표의 칸은 12다");
	}

	@Test
	void theSixteenContractCasesCoverThirteenOfTheFifteenCellsAndTheTwoLeftOverStartFromEps() {
		assertEquals(16, CONTRACT_CASES.size(), "계약 케이스는 16건이다(칸 수 15와 다르다 — Z 3건이 중복 관측)");

		Set<String> tableCells = new TreeSet<>();
		for (Cell cell : ALLOWED_CELLS) {
			tableCells.add(cellKey(cell));
		}
		assertEquals(15, tableCells.size(), "칸의 좌표는 (이전 상태, 표, action)이다 — 15칸이 서로 다르다");

		Set<String> covered = new TreeSet<>();
		for (Cell cell : CONTRACT_CASES) {
			// 계약 케이스는 전부 표 안의 칸이어야 한다(표에 없는 칸을 계약이 관측한다면 둘 중 하나가 틀렸다).
			String key = cellKey(cell);
			assertTrue(tableCells.contains(key), cell + ": 계약 케이스가 표 밖의 칸을 가리킨다");
			covered.add(key);

			// 그리고 실제로 그 결과가 나와야 한다(수 세기만 하는 공허한 단언이 되지 않게 서비스를 통과시킨다).
			String articleId = place(cell.from());
			ArticleLifecycleService.ActionResult result =
					service.applyAction(articleId, cell.role(), cell.action(), "u-contract");
			assertTrue(result.ok(), cell + ": 계약이 허용으로 동결한 칸이다 — " + result.reason());
			assertEquals(cell.to(), result.status(), cell + ": 계약이 동결한 결과 상태");
		}

		assertEquals(13, covered.size(), "16 케이스가 덮는 서로 다른 칸은 13이다");
		Set<String> uncovered = new TreeSet<>(tableCells);
		uncovered.removeAll(covered);
		assertEquals(Set.of("EPS+D+hold", "EPS+D+kill"), uncovered,
				"계약이 도달하지 못하는 2칸은 EPS발뿐이다(excluded (d) — 실제 배부가 있어야 생기는 상태)");
	}

	/** 칸의 좌표 — Z는 D와 <b>같은 표</b>를 쓰므로 같은 칸으로 접는다(그래서 케이스 16 ≠ 칸 15다). */
	private static String cellKey(Cell cell) {
		return cell.from() + "+" + ("Z".equals(cell.role()) ? "D" : cell.role()) + "+" + cell.action();
	}

	// --- 2. 거부 칸 --------------------------------------------------------------------------------

	@Test
	void rejectedCellsChangeNoStatusAndAppendNoHistoryRow() {
		for (Cell cell : REJECTED_CELLS) {
			String articleId = place(cell.from());
			ArticleLifecycleService.ActionResult result =
					service.applyAction(articleId, cell.role(), cell.action(), "u-denied");

			assertFalse(result.ok(), cell + ": 표 밖의 칸은 거부다");
			assertEquals("forbidden-transition", result.reason(), cell + ": 사유 토큰");
			assertNull(result.status(), cell + ": 거부 결과에는 상태가 없다");
			assertEquals(cell.from(), statusOf(articleId), cell + ": 거부는 상태를 건드리지 않는다");
			assertEquals(List.of(), historyRowsOf(articleId), cell + ": 거부 경로는 이력을 남기지 않는다");
		}
	}

	@Test
	void anUnknownActionOrRoleIsRejectedWithItsOwnReasonToken() {
		String articleId = place("RDS");

		assertEquals("unknown-action", service.applyAction(articleId, "D", "bogus", "u1").reason());
		assertEquals("unknown-action", service.applyAction(articleId, "D", null, "u1").reason());
		assertEquals("unknown-role", service.applyAction(articleId, "X", "send", "u1").reason());
		assertEquals("unknown-role", service.applyAction(articleId, null, "send", "u1").reason());

		assertEquals("RDS", statusOf(articleId), "어휘·role 거부도 상태를 건드리지 않는다");
		assertEquals(List.of(), historyRowsOf(articleId), "어휘·role 거부도 이력을 남기지 않는다");
	}

	// --- 3. 가드 순서: 전이 판정이 마커 검사보다 먼저다 ------------------------------------------

	@Test
	void theTransitionTableIsJudgedBeforeTheEndMarker() {
		// 마커도 없고 전이도 불가한 입력 — 계약은 409 forbidden-transition이지 400 no-end-marker가 아니다.
		String killed = placeWithBody("DDK", BODY_WITHOUT_MARKER);
		ArticleLifecycleService.ActionResult denied = service.applyAction(killed, "D", "send", "u1");

		assertFalse(denied.ok());
		assertEquals("forbidden-transition", denied.reason(),
				"전이 판정이 먼저다 — 순서가 바뀌면 이 요청이 no-end-marker(400)가 된다");
		assertEquals("DDK", statusOf(killed));
		assertEquals(List.of(), historyRowsOf(killed));
	}

	@Test
	void aSendWithoutTheEndMarkerIsRejectedAndLeavesEverythingAlone() {
		String articleId = placeWithBody("RDS", BODY_WITHOUT_MARKER);

		ArticleLifecycleService.ActionResult result = service.applyAction(articleId, "D", "send", "u1");

		assertFalse(result.ok());
		assertEquals("no-end-marker", result.reason());
		assertNull(result.status());
		assertEquals("RDS", statusOf(articleId), "마커 실패는 상태를 건드리지 않는다");
		assertNull(contentsOf(articleId).get("sender"), "마커 실패는 stamp도 하지 않는다");
		assertNull(contentsOf(articleId).get("sentAt"));
		assertEquals(List.of(), historyRowsOf(articleId), "마커 실패 경로는 이력을 남기지 않는다");
	}

	@Test
	void addingTheMarkerWithAnEditLetsTheSameSendThrough() {
		String articleId = placeWithBody("RDS", BODY_WITHOUT_MARKER);
		writeService.update(articleId, Map.of("markupVersion", BODY_WITH_MARKER, "modifier", "u1"));

		ArticleLifecycleService.ActionResult result = service.applyAction(articleId, "D", "send", "u1");

		assertTrue(result.ok(), "마커가 생겼으므로 같은 요청이 통과한다");
		assertEquals("DPS", result.status());
		assertEquals("DPS", statusOf(articleId));
	}

	// --- 4. 존재 검사가 맨 앞이다 -------------------------------------------------------------------

	@Test
	void aMissingArticleIsNotFoundBeforeTheVocabularyOrTheTable() {
		assertEquals("not-found", service.applyAction(MISSING_ID, "D", "send", "u1").reason());
		// 어휘도 role도 틀린 요청이 여전히 not-found다 — 존재 검사가 그 둘보다 앞이라는 음성 증거.
		assertEquals("not-found", service.applyAction(MISSING_ID, "X", "bogus", "u1").reason());
		assertEquals("not-found", service.applyAction(null, "D", "send", "u1").reason());

		// Article 행만 있고 Contents 행이 없는 기사도 not-found다(전이 판정 입력이 없다).
		articles.insert(Map.of("articleId", "AKR20260820111111111", "title", "고아 본문"), null);
		assertEquals("not-found",
				service.applyAction("AKR20260820111111111", "D", "send", "u1").reason(),
				"Contents 행이 없으면 상태가 없다 — 전이표에 물어보지 않는다");
	}

	// --- 5. 송고 stamp ------------------------------------------------------------------------------

	@Test
	void sendStampsTheSenderAndTheSentAtFromTheInjectedClock() {
		String articleId = place("RDS");
		assertNull(contentsOf(articleId).get("sender"), "송고 전에는 비어 있다");
		assertNull(contentsOf(articleId).get("sentAt"));

		assertTrue(service.applyAction(articleId, "D", "send", "sender-1").ok());

		Map<String, Object> contents = contentsOf(articleId);
		assertEquals("sender-1", contents.get("sender"), "sender는 호출자가 준 userId다");
		assertEquals("2026-08-20T12:34:56.789Z", contents.get("sentAt"), "sentAt은 주입 시계에서만 온다");
		assertTrue(String.valueOf(contents.get("sentAt")).matches(ISO_MILLIS_RE), "소수 3자리 고정 형식");
	}

	@Test
	void everyActionOtherThanSendLeavesTheSendStampAlone() {
		for (Cell cell : ALLOWED_CELLS) {
			if ("send".equals(cell.action())) {
				continue;
			}
			String articleId = place(cell.from());
			assertTrue(service.applyAction(articleId, cell.role(), cell.action(), "u1").ok());

			Map<String, Object> contents = contentsOf(articleId);
			assertNull(contents.get("sender"), cell + ": 송고가 아닌 액션은 sender를 쓰지 않는다");
			assertNull(contents.get("sentAt"), cell + ": 송고가 아닌 액션은 sentAt을 쓰지 않는다");
		}
	}

	@Test
	void aSendWithoutAnActorStampsANullSender() {
		String articleId = place("RDS");

		assertTrue(service.applyAction(articleId, "D", "send", null).ok());

		assertNull(contentsOf(articleId).get("sender"), "호출자가 userId를 주지 않으면 null이다");
		assertNotNull(contentsOf(articleId).get("sentAt"), "sentAt은 그래도 stamp된다");
	}

	// --- 6. 상태 저장은 present-only다 ---------------------------------------------------------------

	@Test
	void theStatusUpdateWritesNoColumnBeyondTheThreeItOwns() {
		String articleId = place("RDS", Map.of("department", "사회부", "departmentCode", "D01",
				"category", "정치", "internalComment", "내부메모"));
		// 잠긴 기사 + 이미 배부된 흔적을 만들어 둔다 — 함께 쓰이면 그 자리에서 드러난다.
		articles.setLock(articleId, new ArticleRepository.EditLock("holder", "SESSION-TOKEN", "tab-a",
				"2020-01-01T00:00:00.000Z"));
		articles.update(articleId, null, Map.of("distributedAt", "2020-02-02T00:00:00.000Z"));

		Map<String, Object> before = contentsOf(articleId);
		Map<String, Object> beforeArticle = articleOf(articleId);

		assertTrue(service.applyAction(articleId, "D", "send", "u1").ok());

		Map<String, Object> after = contentsOf(articleId);
		List<String> changed = new ArrayList<>();
		for (String column : RequiredSchema.CONTENTS_COLUMNS) {
			if (!Objects.equals(before.get(column), after.get(column))) {
				changed.add(column);
			}
		}
		assertEquals(List.of("sender", "sentAt", "status"), new ArrayList<>(new TreeSet<>(changed)),
				"송고가 쓰는 컬럼은 셋뿐이다(present-only가 DB 비파괴의 실질 보증이다)");
		assertEquals("Y", after.get("lockYN"), "잠금은 그대로다");
		assertEquals("SESSION-TOKEN", after.get("lockerSessionId"));
		assertEquals("2020-02-02T00:00:00.000Z", after.get("distributedAt"), "distributedAt은 배부의 것이다");
		assertEquals(beforeArticle, articleOf(articleId), "본문 테이블은 전혀 건드리지 않는다");
	}

	// --- 7. 엠바고 DES 진입 ---------------------------------------------------------------------------

	@Test
	void anEmbargoedSendLandsOnDesFromBothEntryStatuses() {
		List<Map<String, Object>> variants = List.of(
				row("embargoAt", "2026-08-21T00:00:00.000Z"),
				row("secondEmbargoAt", "2026-08-22T00:00:00.000Z"),
				row("embargoAt", "2026-08-21T00:00:00.000Z", "secondEmbargoAt", "2026-08-22T00:00:00.000Z"));

		for (Map<String, Object> fields : variants) {
			for (String from : List.of("RDS", "DDH")) {
				for (String role : List.of("D", "Z")) {
					String articleId = place(from, fields);
					ArticleLifecycleService.ActionResult result =
							service.applyAction(articleId, role, "send", "u1");

					assertTrue(result.ok(), fields + " " + from + "/" + role);
					assertEquals("DES", result.status(),
							fields + " " + from + "/" + role + ": 엠바고 기사는 DPS가 아니라 DES다");
					assertEquals("DES", statusOf(articleId), "되읽은 상태도 DES다");
				}
			}
		}
	}

	@Test
	void theEmbargoEntryNeverComparesTimes() {
		// 이미 지난 시각·파싱 불가한 값이어도 "설정돼 있다"는 사실만으로 DES다.
		// 시각 비교를 넣으면 도래 전 기사가 즉시 배부 상태(DPS)로 떨어진다 — 회수 수단이 없다.
		for (String value : List.of("2000-01-01T00:00:00.000Z", "언젠가", "2026-08-20T12:34:56.789Z")) {
			String articleId = place("RDS", row("embargoAt", value));
			assertEquals("DES", service.applyAction(articleId, "D", "send", "u1").status(),
					"embargoAt=" + value + ": 시각을 비교하지 않는다");
		}
	}

	@Test
	void emptyEmbargoColumnsAreNotSetSoTheSendLandsOnDps() {
		String articleId = place("RDS", row("embargoAt", "", "secondEmbargoAt", ""));

		assertEquals("DPS", service.applyAction(articleId, "D", "send", "u1").status(),
				"빈 문자열은 미설정이다(Node falsy 의미론)");
		assertEquals("DPS", statusOf(articleId));

		String plain = place("RDS");
		assertEquals("DPS", service.applyAction(plain, "D", "send", "u1").status(),
				"엠바고 컬럼이 NULL이면 당연히 DPS다");
	}

	@Test
	void theReporterSendStaysInRdsEvenWhenTheEmbargoIsSet() {
		String articleId = place("RDS", row("embargoAt", "2026-08-21T00:00:00.000Z"));

		ArticleLifecycleService.ActionResult result = service.applyAction(articleId, "R", "send", "u1");

		assertEquals("RDS", result.status(), "DES 진입은 전이 결과가 DPS일 때만이다");
		assertEquals("RDS", statusOf(articleId));
	}

	@Test
	void theEmbargoEntryDoesNotReachStatusesOutsideTheTwoEntryPoints() {
		// DPS 재송고는 진입 상태가 아니다 — 엠바고가 설정돼 있어도 DPS 그대로다(승격은 배부 phase의 몫).
		String articleId = place("DPS", row("embargoAt", "2026-08-21T00:00:00.000Z"));

		assertEquals("DPS", service.applyAction(articleId, "D", "send", "u1").status(),
				"DES 진입 상태는 RDS·DDH 둘뿐이다");
	}

	// --- 7-1. EmbargoPolicy와의 정합성 (phase 72 decisions (10)) ---------------------------------------

	/**
	 * <b>DES 진입 판정과 {@link EmbargoPolicy#requiredKinds}가 같은 것을 본다</b>는 등가성 잠금.
	 *
	 * <p>왜 필요한가: 이 서비스의 {@code embargoSet}과 {@code EmbargoPolicy.requiredKinds}는 <b>서로 다른
	 * 두 벌의 코드</b>다(Node도 {@code articleService.js}에서 인라인 판정을 쓰므로 갈린 것이 정본이다).
	 * 두 판정이 어긋나면 "송고는 {@code DPS}로 떨어졌는데 배부 모듈은 엠바고가 있다고 본다"(또는 그 반대)가
	 * 되고, 앞쪽은 <b>엠바고 전량 즉시 누수</b>다. 외부로 나간 기사는 회수 수단이 없다.
	 *
	 * <p>왜 이 형태인가: {@code embargoSet}은 {@code private static}이라 같은 패키지 테스트도 부를 수 없고,
	 * 가시성을 넓히는 것은 그 자체가 소스 변경이다. 그래서 <b>관측 가능한 경로</b>(송고 결과)로만 잠근다 —
	 * 리플렉션도 쓰지 않는다.
	 *
	 * <p><b>CRITICAL — 반환 status로 단언하고 되읽은 status로 단언하지 않는다.</b> 배부 phase가 송고 훅을
	 * 붙이면 {@code secondEmbargoAt}만 설정된 조합에서 송고 즉시 {@code press} 배부가 성공하고
	 * {@code syncEmbargoStatus}가 <b>저장된</b> status를 {@code EPS}로 승격시킨다
	 * ({@code src/services/embargoPolicy.js} 200~202행). 되읽기로 단언하면 그때 red가 되는데, 그 red의
	 * 잘못된 복구는 "동치 단언을 완화"하는 것이다. {@code applyAction}의 반환값은 훅 실행 여부와 무관하게
	 * 언제나 {@code finalStatus}이므로(phase 72 decisions (8)) 그 함정을 구조적으로 피한다.
	 */
	@Test
	void desEntryAgreesWithEmbargoPolicyAcrossTheFourByFourColumnGrid() {
		// Contents 시간 컬럼이 실제로 가질 수 있는 4형태. NULL은 "키 자체가 없다"로 만든다.
		Map<String, Object> forms = new LinkedHashMap<>();
		forms.put("설정", "2026-08-21T00:00:00.000Z");
		forms.put("빈문자열", "");
		forms.put("NULL", null);
		forms.put("공백만", "   ");

		int desCells = 0;
		int dpsCells = 0;
		for (Map.Entry<String, Object> first : forms.entrySet()) {
			for (Map.Entry<String, Object> second : forms.entrySet()) {
				String label = "embargoAt=" + first.getKey() + " secondEmbargoAt=" + second.getKey();
				Map<String, Object> fields = row();
				if (first.getValue() != null) {
					fields.put("embargoAt", first.getValue());
				}
				if (second.getValue() != null) {
					fields.put("secondEmbargoAt", second.getValue());
				}

				String articleId = place("RDS", fields);
				ContentsRow stored = storedContents(articleId);
				assertEquals(first.getValue(), stored.column("embargoAt"), label + ": 저장된 1차 값");
				assertEquals(second.getValue(), stored.column("secondEmbargoAt"), label + ": 저장된 2차 값");
				boolean embargoRequired = !EmbargoPolicy.requiredKinds(stored::column).isEmpty();

				ArticleLifecycleService.ActionResult result =
						service.applyAction(articleId, "D", "send", "u-embargo-grid");

				assertTrue(result.ok(), label + ": 송고는 성공한다 — " + result.reason());
				assertEquals(embargoRequired, "DES".equals(result.status()),
						label + ": DES 진입 == requiredKinds가 비어 있지 않음(두 판정은 같은 것을 본다)");
				assertEquals(embargoRequired ? "DES" : "DPS", result.status(), label + ": 최종 상태");
				if (embargoRequired) {
					desCells++;
				}
				else {
					dpsCells++;
				}
			}
		}

		// 공허하지 않다는 증거 — 두 결과가 모두 관측된다. 미설정은 (빈문자열|NULL)² = 4칸뿐이다.
		assertEquals(16, desCells + dpsCells, "4형태 × 2컬럼 = 16칸을 전수로 본다");
		assertEquals(12, desCells, "공백만도 '설정'이다(Node falsy 의미론 — trim하지 않는다)");
		assertEquals(4, dpsCells, "미설정 조합은 빈 문자열·NULL의 4칸뿐이다");
	}

	// --- 8. 이력 부수효과 ---------------------------------------------------------------------------

	@Test
	void aSuccessfulTransitionAppendsExactlyOneStatusHistoryRow() {
		String articleId = place("RDS");

		assertTrue(service.applyAction(articleId, "D", "hold", "actor-1").ok());

		List<Map<String, Object>> rows = historyRowsOf(articleId);
		assertEquals(1, rows.size(), "전이 하나에 이력 한 행이다");
		Map<String, Object> row = rows.get(0);
		assertEquals("status", row.get("eventType"));
		assertEquals("hold", row.get("action"));
		assertEquals("RDS", row.get("fromStatus"));
		assertEquals("DDH", row.get("toStatus"));
		assertEquals("actor-1", row.get("actorUserId"));
		assertEquals("2026-08-20T12:34:56.789Z", row.get("createdAt"), "시각은 기록 헬퍼가 붙인다");
		assertNull(row.get("markupVersion"), "상태 전이는 본문 스냅샷을 싣지 않는다");
		assertNull(row.get("snapshotTitle"), "스냅샷이 없으면 제목 컬럼도 NULL이다");
	}

	@Test
	void theHistoryRowOfAnEmbargoedSendCarriesTheFinalStatusNotTheTableResult() {
		String articleId = place("RDS", row("embargoAt", "2026-08-21T00:00:00.000Z"));

		assertTrue(service.applyAction(articleId, "D", "send", "actor-2").ok());

		Map<String, Object> row = historyRowsOf(articleId).get(0);
		assertEquals("send", row.get("action"));
		assertEquals("RDS", row.get("fromStatus"));
		assertEquals("DES", row.get("toStatus"), "이력의 toStatus는 저장된 최종 상태다(DPS가 아니다)");
	}

	// --- 9. 삭제 승인은 상태 전이이고 행은 남는다 -----------------------------------------------------

	@Test
	void approveDeleteIsAStatusTransitionAndBothRowsSurvive() {
		String articleId = place("DPS");
		int contentsBefore = countRows(RequiredSchema.CONTENTS_TABLE);
		int articleBefore = countRows(RequiredSchema.ARTICLE_TABLE);

		ArticleLifecycleService.ActionResult result =
				service.applyAction(articleId, "D", "approveDelete", "u1");

		assertTrue(result.ok());
		assertEquals("DPD", result.status());
		assertEquals(contentsBefore, countRows(RequiredSchema.CONTENTS_TABLE), "행 수가 줄지 않는다");
		assertEquals(articleBefore, countRows(RequiredSchema.ARTICLE_TABLE));

		ArticleAggregate found = articles.findById(articleId);
		assertNotNull(found, "삭제 승인 뒤에도 조회된다(DB 비파괴 — 계약이 단언한다)");
		assertNotNull(found.contents());
		assertNotNull(found.article());
		assertEquals("DPD", statusOf(articleId));
	}

	// --- 10. 배부 훅의 의도된 부재 ---------------------------------------------------------------------

	@Test
	void nothingInThisServiceDistributes() {
		String articleId = place("RDS", row("embargoAt", "2026-08-21T00:00:00.000Z"));

		assertEquals("DES", service.applyAction(articleId, "D", "send", "u1").status());

		assertNull(contentsOf(articleId).get("distributedAt"),
				"배부 훅은 이 phase 범위 밖이다(excluded (c)) — 송고가 distributedAt을 채우지 않는다");
		List<String> eventTypes = new ArrayList<>();
		for (Map<String, Object> row : historyRowsOf(articleId)) {
			eventTypes.add(String.valueOf(row.get("eventType")));
		}
		assertEquals(List.of("status"), eventTypes, "distribute 이력 행이 생기지 않는다");
		assertEquals("DES", statusOf(articleId), "승격(DES→EPS→DPS)도 일어나지 않는다");
	}

	// --- 11. 파생: 새 기사 --------------------------------------------------------------------------

	@Test
	void deriveCreatesANewRdsArticleAuthoredByTheDeriver() {
		for (String mode : List.of("followUp", "continue")) {
			String source = place("DPS", row("author", "원작성자"));
			ArticleLifecycleService.DeriveResult result = service.derive(source, mode, "파생실행자");

			assertTrue(result.ok(), mode + ": 파생은 성공한다");
			assertNull(result.reason());
			assertNotNull(result.articleId());
			assertTrue(result.articleId().matches(ARTICLE_ID_RE), mode + ": 새 articleId 형태");
			assertFalse(result.articleId().equals(source), mode + ": 원본과 다른 새 id다");

			Map<String, Object> created = contentsOf(result.articleId());
			assertEquals("RDS", created.get("status"), mode + ": 원본이 DPS여도 새 기사는 RDS다");
			assertEquals("파생실행자", created.get("author"), mode + ": 작성자는 파생 실행자다");
			assertEquals(result.articleId(), created.get("articleId"));
			assertEquals("제목", articleOf(result.articleId()).get("title"), mode + ": 제목은 복사된다");
			assertEquals("제목", created.get("title"), mode + ": Contents 제목도 복사된다");
			assertEquals(List.of(), historyRowsOf(result.articleId()), mode + ": 신규 저장은 이력을 남기지 않는다");
		}
	}

	@Test
	void theBodyIsCopiedOnlyForContinue() {
		String source = place("RDS");

		String followUp = service.derive(source, "followUp", "d1").articleId();
		String continued = service.derive(source, "continue", "d1").articleId();

		assertEquals("", articleOf(followUp).get("markupVersion"), "후속은 빈 본문에서 새로 쓴다");
		assertEquals(BODY_WITH_MARKER, articleOf(continued).get("markupVersion"), "계속은 원문을 이어쓴다");
	}

	// --- 12. 파생 복사 필드 실측 ----------------------------------------------------------------------

	@Test
	void deriveCopiesTheNineCommonFieldsAndResetsTheEmbargoAndDropsTheDepartment() {
		Map<String, Object> fields = row(
				"coAuthor", "공동", "category", "정치", "region", "서울", "attribute", "속성", "keyword", "키워드",
				"internalComment", "내부", "externalComment", "외부",
				"attachmentFile", "/uploads/a.png", "referenceFile", "/uploads/r.png",
				"department", "사회부", "departmentCode", "D01",
				"embargoAt", "2026-08-21T00:00:00.000Z", "secondEmbargoAt", "2026-08-22T00:00:00.000Z",
				"modifier", "원수정자");
		String source = place("RDS", fields);
		assertTrue(service.applyAction(source, "D", "send", "sender-x").ok(), "송고 stamp를 가진 원본을 만든다");
		Map<String, Object> before = contentsOf(source);

		String derived = service.derive(source, "continue", "파생실행자").articleId();
		Map<String, Object> created = contentsOf(derived);

		for (String key : DERIVE_COPIED_FIELDS) {
			assertEquals(before.get(key), created.get(key), key + "는 복사된다");
		}
		assertEquals("", created.get("embargoAt"), "엠바고 1차는 빈 문자열로 초기화된다(NULL이 아니다)");
		assertEquals("", created.get("secondEmbargoAt"), "엠바고 2차도 빈 문자열이다");
		assertNull(created.get("department"), "부서는 복사하지 않는다(실측 — dto에 없다)");
		assertNull(created.get("departmentCode"), "부서코드도 복사하지 않는다");
		assertNull(created.get("sender"), "송고 stamp는 복사하지 않는다");
		assertNull(created.get("sentAt"));
		assertNull(created.get("distributedAt"));
		assertNull(created.get("modifier"), "수정자도 복사하지 않는다");
		assertNull(created.get("editedAt"), "신규 저장은 editedAt을 stamp하지 않는다");
		assertEquals("N", created.get("lockYN"), "잠금은 복사하지 않는다");
		assertNull(created.get("lockerUserId"));
		assertNull(created.get("lockerSessionId"));
		assertEquals("RDS", created.get("status"), "상태는 신규 저장이 강제한다");
		assertEquals("2026-08-20T12:34:56.789Z", created.get("createdAt"), "생성 시각은 새로 stamp된다");
	}

	// --- 13. 파생: 원본 무변 · 사유 토큰 --------------------------------------------------------------

	@Test
	void deriveLeavesTheSourceUntouched() {
		String source = place("DPS", row("department", "사회부", "category", "정치",
				"embargoAt", "2026-08-21T00:00:00.000Z"));
		Map<String, Object> beforeContents = contentsOf(source);
		Map<String, Object> beforeArticle = articleOf(source);
		List<Map<String, Object>> beforeHistory = historyRowsOf(source);

		for (String mode : List.of("followUp", "continue", "followUp")) {
			assertTrue(service.derive(source, mode, "파생실행자").ok());
		}

		assertEquals(beforeContents, contentsOf(source), "원본 Contents 29컬럼이 한 글자도 바뀌지 않는다");
		assertEquals(beforeArticle, articleOf(source), "원본 Article 5컬럼도 그대로다");
		assertEquals(beforeHistory, historyRowsOf(source), "파생은 원본 이력도 남기지 않는다");
	}

	@Test
	void deriveChecksTheModeBeforeTheSource() {
		String source = place("RDS");

		assertEquals("unknown-mode", service.derive(source, "bogus", "d1").reason());
		assertEquals("unknown-mode", service.derive(source, null, "d1").reason());
		// 없는 원본 + 정의 밖 모드에서도 unknown-mode다 — 모드 검증이 조회보다 앞이라는 음성 증거.
		assertEquals("unknown-mode", service.derive(MISSING_ID, "bogus", "d1").reason());
		assertEquals("not-found", service.derive(MISSING_ID, "followUp", "d1").reason());
		assertNull(service.derive(MISSING_ID, "followUp", "d1").articleId());

		// Contents 행이 없는 기사도 not-found다(복사할 공통정보가 없다).
		articles.insert(Map.of("articleId", "AKR20260820222222222", "title", "고아 본문"), null);
		assertEquals("not-found", service.derive("AKR20260820222222222", "continue", "d1").reason());
	}

	// --- 헬퍼 -----------------------------------------------------------------------------------------

	/** 전이표의 한 칸. {@code to}가 {@code null}이면 거부 칸이다. */
	private record Cell(String from, String role, String action, String to) {

		@Override
		public String toString() {
			return this.from + "+" + this.role + "+" + this.action;
		}
	}

	/** 마커가 있는 본문으로 기사를 만들고 원하는 상태에 놓는다(단위 테스트 전용 — API 경로가 아니다). */
	private String place(String status) {
		return place(status, Map.of());
	}

	private String place(String status, Map<String, Object> extra) {
		return place(status, extra, BODY_WITH_MARKER);
	}

	private String placeWithBody(String status, String body) {
		return place(status, Map.of(), body);
	}

	private String place(String status, Map<String, Object> extra, String body) {
		Map<String, Object> dto = row("title", "제목", "markupVersion", body);
		dto.putAll(extra);
		String articleId = writeService.create(dto, null, null);
		if (!"RDS".equals(status)) {
			// EPS처럼 API로 도달할 수 없는 상태까지 덮기 위해 리포지토리로 직접 놓는다(임시 DB).
			articles.update(articleId, null, Map.of("status", status));
		}
		return articleId;
	}

	private static Map<String, Object> row(Object... keyValues) {
		Map<String, Object> row = new LinkedHashMap<>();
		for (int i = 0; i < keyValues.length; i += 2) {
			row.put(String.valueOf(keyValues[i]), keyValues[i + 1]);
		}
		return row;
	}

	private String statusOf(String articleId) {
		return String.valueOf(contentsOf(articleId).get("status"));
	}

	/** 저장된 행 그대로 — {@code EmbargoPolicy}가 실제 판정에서 받는 것과 <b>같은 접근자</b>를 얻기 위해서다. */
	private ContentsRow storedContents(String articleId) {
		ArticleAggregate found = articles.findById(articleId);
		assertNotNull(found, "기사가 없다: " + articleId);
		assertNotNull(found.contents(), "Contents 행이 없다: " + articleId);
		return found.contents();
	}

	/** 저장된 {@code Contents} 29컬럼 전부를 읽는다(투영 전 — 잠금 컬럼까지 확인하기 위해서다). */
	private Map<String, Object> contentsOf(String articleId) {
		ArticleAggregate found = articles.findById(articleId);
		assertNotNull(found, "기사가 없다: " + articleId);
		assertNotNull(found.contents(), "Contents 행이 없다: " + articleId);
		Map<String, Object> columns = new LinkedHashMap<>();
		for (String column : RequiredSchema.CONTENTS_COLUMNS) {
			columns.put(column, found.contents().column(column));
		}
		return columns;
	}

	private Map<String, Object> articleOf(String articleId) {
		ArticleAggregate found = articles.findById(articleId);
		assertNotNull(found, "기사가 없다: " + articleId);
		assertNotNull(found.article(), "Article 행이 없다: " + articleId);
		return found.article();
	}

	/** 원장을 직접 읽는다(조회 API는 저장 제목·본문 컬럼을 싣지 않는다). */
	private List<Map<String, Object>> historyRowsOf(String articleId) {
		return client.sql("SELECT id, eventType, action, fromStatus, toStatus, actorUserId, createdAt,"
						+ " markupVersion, snapshotTitle FROM " + RequiredSchema.HISTORY_TABLE
						+ " WHERE articleId = ? ORDER BY id")
				.param(articleId)
				.query()
				.listOfRows();
	}

	private int countRows(String table) {
		return client.sql("SELECT COUNT(*) FROM " + table).query(Integer.class).single();
	}

}
