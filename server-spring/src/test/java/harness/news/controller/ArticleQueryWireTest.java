package harness.news.controller;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import harness.news.service.UserService;
import harness.news.testsupport.MutableClock;
import harness.news.testsupport.TempNewsDb;
import harness.news.testsupport.Wire;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.time.Clock;
import java.time.Instant;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.TreeSet;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
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
import tools.jackson.databind.json.JsonMapper;

/**
 * 기사 <b>조회 4라우트</b>의 와이어 계약 — {@code GET /api/articles/search} ·
 * {@code GET /api/articles} · {@code GET /api/articles/:id/history} ·
 * {@code GET /api/articles/:id/history/:historyId}.
 *
 * <pre>
 * 목록   200 {"ok":true,"items":[ …27키… ]}  ← 봉투 2키(총수·페이징 없음) · 잠금 비밀 2컬럼 부재
 *        500 internal-error                  ← 스칼라 전용 필터 키를 반복했을 때(결함 후보 #4 재현)
 * 검색   200 {"ok":true,"items":[ …Article 5키… ]} ← 빈 q·q 미전달은 전 행, 무매칭도 200
 * 이력   200 {"ok":true,"items":[ …12키… ]}  ← 기사가 없어도 빈 배열(404가 아니다)
 * 스냅샷 200 {"ok":true,"item":{ …7키… }}     ← 비정수·미존재·타 기사 스코프는 404
 * </pre>
 *
 * <h2>이 클래스가 덮는 것과 계약이 덮는 것</h2>
 * 이 4라우트는 같은 step에서 {@code contract/cases/default/articles-read.contract.js}가 green이 되므로
 * 단언이 계약과 겹친다 — 겹치는 것이 목적이다. 계약이 관측하지 <b>않는</b> 축을 여기서 덮는다:
 * 필터 값의 <b>비-ASCII 왕복</b>(계약 픽스처는 ASCII 토큰만 쓴다) · {@code hasSnapshot}의 <b>와이어
 * 원문</b>(정수 1/0이지 {@code true}/{@code false}가 아니다 — JSON 파서를 거치면 두 표현이 같아 보인다) ·
 * 반복 {@code q}·반복 {@code sendOnly}의 Node 동형(계약 미동결 축) · {@code historyId} 정수 판정의
 * 대체 표기(16진·지수·소수점 0) · 라우트 우선순위({@code /search}가 {@code /{id}}에 흡수되지 않는다).
 *
 * <p>DB는 이 클래스 전용 임시 사본이며 리포 {@code news.db}는 열지 않는다. 픽스처는 전부 <b>HTTP
 * 경로</b>로 만든다(리포지토리로 행을 직접 놓지 않는다 — 관측 대상이 그 경로다).
 */
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
class ArticleQueryWireTest {

	private static final Path DATA_DIR = TempNewsDb.newDataDir("article-query-wire");

	private static final Pattern SESSION_ID = Pattern.compile("\"sessionId\":\"([0-9a-f]{64})\"");

	private static final Pattern CREATED = Pattern.compile("^\\{\"ok\":true,\"articleId\":\"(AKR\\d{8}\\d{9})\"\\}$");

	private static final String PASSWORD = "article-query-pw-1";

	private static final String JSON_CONTENT_TYPE = "Content-Type: application/json; charset=utf-8";

	private static final String NOT_FOUND = "{\"ok\":false,\"reason\":\"not-found\"}";

	private static final String UNAUTHENTICATED = "{\"ok\":false,\"reason\":\"unauthenticated\"}";

	private static final String INTERNAL_ERROR = "{\"ok\":false,\"reason\":\"internal-error\"}";

	private static final String NO_SUCH_ARTICLE = "AKR19700101000000000";

	/** {@code Contents} 29컬럼 − 투영 2컬럼 = 27키(계약 파일의 {@code CONTENTS_ROW_KEYS}와 같은 문자열). */
	private static final String CONTENTS_ROW_KEYS = "articleId,attachmentFile,attribute,author,category,coAuthor,"
			+ "content,createdAt,department,departmentCode,distributedAt,editedAt,embargoAt,externalComment,"
			+ "internalComment,keyword,lockYN,lockedAt,lockerUserId,modifier,referenceFile,region,secondEmbargoAt,"
			+ "sender,sentAt,status,title";

	/** 검색 행은 {@code Article} 테이블 행이다(본문 {@code markupVersion}이 실린다). */
	private static final String ARTICLE_ROW_KEYS = "articleId,content,markupVersion,modifier,title";

	/** 이력 목록 행 = 저장 8컬럼 + {@code hasSnapshot} + 표시 파생 3키. 본문 blob·저장 제목은 없다. */
	private static final String HISTORY_ROW_KEYS = "action,actorUserId,articleId,createdAt,eventType,fromStatus,"
			+ "hasSnapshot,id,status,title,toStatus,version";

	/** 단건 스냅샷 item = 7키(본문 있음, 전이 컬럼 없음). */
	private static final String SNAPSHOT_ITEM_KEYS = "action,actorUserId,articleId,createdAt,eventType,id,"
			+ "markupVersion";

	/** 날짜 범위 필터의 사전식 경계 — 실제 데이터 시각을 몰라도 결정적으로 판정한다. */
	private static final String FAR_PAST = "2000-01-01T00:00:00.000Z";

	private static final String FAR_FUTURE = "2999-12-31T23:59:59.999Z";

	/** 로그인 IP 레이트리밋(15분/10회) 예산을 테스트마다 리셋하기 위한 창 길이. */
	private static final long RATE_LIMIT_WINDOW_MS = 15L * 60L * 1000L;

	private static final MutableClock CLOCK = new MutableClock(Instant.parse("2026-08-20T00:00:00Z").toEpochMilli());

	private static final JsonMapper JSON = JsonMapper.builder().build();

	@TestConfiguration
	static class MutableClockConfig {

		@Bean
		@Primary
		Clock mutableClock() {
			return CLOCK;
		}

	}

	@DynamicPropertySource
	static void dataDir(DynamicPropertyRegistry registry) {
		registry.add("app.data-dir", () -> DATA_DIR.toAbsolutePath().toString());
	}

	@Value("${local.server.port}")
	private int port;

	/** 픽스처 계정 생성 전용(테스트 대상은 HTTP 경로다). */
	@Autowired
	private UserService users;

	@BeforeEach
	void freshLoginBudget() {
		CLOCK.advance(RATE_LIMIT_WINDOW_MS + 1);
	}

	@BeforeEach
	void seedFixtures() {
		ensureUser("aq-r", "R", "기자하나", "사회부", "SOC");
		ensureUser("aq-d", "D", "데스크하나", "정치부", "POL");
		ensureUser("aq-z", "Z", "관리자하나", "편집국", "EDT");
	}

	// --- 1. 목록 shape · 투영 · 역할 무관 -----------------------------------------------------------

	@Test
	void theListIsExactlyTwoKeysAndEveryRowIsTheTwentySevenKeyProjection() {
		Fixture fx = fixture();

		Wire.Response response = list(fx.desk, "");

		assertEquals(200, response.status());
		assertEquals(JSON_CONTENT_TYPE, response.line("content-type"));
		Map<String, Object> body = json(response);
		assertEquals("items,ok", sortedKeys(body), "봉투는 ok·items 2키뿐이다(총수·페이징 필드가 없다)");
		List<Map<String, Object>> mine = rowsOf(body, fx.ids());
		assertEquals(3, mine.size(), "자기 픽스처 3건이 기본 목록에 있다");
		for (Map<String, Object> row : mine) {
			assertEquals(CONTENTS_ROW_KEYS, sortedKeys(row), "행 키 집합 = Contents 27키(투영 후)");
		}
		for (String consumed : List.of("articleId", "title", "author", "modifier", "department", "departmentCode",
				"createdAt", "editedAt", "sentAt", "distributedAt", "status", "lockYN")) {
			assertTrue(mine.get(0).containsKey(consumed), "목록 소비 키가 없다: " + consumed);
		}
		assertTrue(mine.get(0).containsKey("sentAt"), "값이 NULL인 컬럼도 키는 남는다");
	}

	@Test
	void aLockedRowCarriesTheLockDisplayColumnsButNeitherSecret() {
		Fixture fx = fixture();

		Wire.Response response = list(fx.desk, "?articleId=" + fx.c);

		Map<String, Object> body = json(response);
		List<Map<String, Object>> items = items(body);
		assertEquals(1, items.size(), "articleId 필터는 정확히 그 기사만 돌려준다");
		Map<String, Object> row = items.get(0);
		assertEquals("Y", row.get("lockYN"), "픽스처 C는 잠금 보유 상태다(투영 단언이 공허하지 않다)");
		assertEquals("aq-d", row.get("lockerUserId"), "lockerUserId는 잠금 표시 계약이라 남는다");
		assertFalse(row.containsKey("lockerSessionId"), "lockerSessionId 키 자체가 없다");
		assertFalse(row.containsKey("lockerClientId"), "lockerClientId 키 자체가 없다");
		assertNoSecretLeak(response, fx, "list-locked-row");
	}

	@Test
	void theListIsTheSameForEveryRole() {
		Fixture fx = fixture();
		String query = "?departments=" + enc(fx.deptA) + "&departments=" + enc(fx.deptB)
				+ "&departments=" + enc(fx.deptC);

		Wire.Response reporter = list(fx.reporter, query);
		Wire.Response desk = list(fx.desk, query);
		Wire.Response admin = list(fx.admin, query);

		List<String> expected = new ArrayList<>(fx.ids());
		expected.sort(null);
		for (Wire.Response response : List.of(reporter, desk, admin)) {
			assertEquals(200, response.status());
			List<String> ids = idsOf(response);
			ids.sort(null);
			assertEquals(expected, ids, "역할 필터가 없다 — R도 남의 부서 기사를 본다");
			assertNoSecretLeak(response, fx, "list-role-agnostic");
		}
		assertEquals(sortedKeys(items(json(reporter)).get(0)), sortedKeys(items(json(admin)).get(0)),
				"행 shape도 역할 무관이다");
	}

	// --- 2. 필터 문법(반복 키 · 콤마 미분해 · 우선순위 · 범위 · 13키 · 화이트리스트) -----------------

	@Test
	void repeatedKeysAreInAndOutClausesAndCommasAreNotSyntax() {
		Fixture fx = fixture();

		List<String> both = idsOf(list(fx.desk, "?status=RDS&status=DDH"));
		assertTrue(both.contains(fx.a), "RDS 픽스처 A가 포함된다(반복 키는 IN)");
		assertFalse(both.contains(fx.c), "송고된 DPS 픽스처 C는 빠진다");

		List<String> excluded = idsOf(list(fx.desk, "?excludeStatus=DPS&excludeStatus=DDH"));
		assertTrue(excluded.contains(fx.a), "RDS 픽스처는 남는다(NOT IN)");
		assertFalse(excluded.contains(fx.c), "DPS 픽스처가 제외된다");

		List<String> comma = idsOf(list(fx.desk, "?status=RDS,DDH"));
		assertFalse(comma.contains(fx.a), "콤마는 반복 키의 대체 문법이 아니다 — RDS 픽스처도 안 잡힌다");
		assertFalse(comma.contains(fx.c), "어느 것도 매칭되지 않는다(값이 하나인 문자열이다)");
	}

	@Test
	void departmentsWinsOverDepartmentAndNonAsciiValuesSurviveTheRoundTrip() {
		Fixture fx = fixture();

		assertEquals(List.of(fx.a), idsOf(list(fx.desk, "?department=" + enc(fx.deptA))), "department=A는 A만");
		List<String> multi = idsOf(list(fx.desk, "?departments=" + enc(fx.deptA) + "&departments=" + enc(fx.deptB)));
		multi.sort(null);
		List<String> expected = new ArrayList<>(List.of(fx.a, fx.b));
		expected.sort(null);
		assertEquals(expected, multi, "departments 반복 키는 IN이다");
		assertEquals(List.of(fx.b), idsOf(list(fx.desk, "?department=" + enc(fx.deptA) + "&departments=" + enc(fx.deptB))),
				"둘 다 주면 departments가 이긴다(department는 평가되지 않는다)");

		// 계약 픽스처는 ASCII 토큰만 쓴다 — 실제 부서명은 한글이라 쿼리 디코딩이 깨지면 필터가 통째로 죽는다.
		assertEquals(List.of(fx.korean), idsOf(list(fx.desk, "?department=" + enc(fx.deptKorean))),
				"비-ASCII 필터 값이 왕복해야 한다(쿼리 문자열 디코딩)");
	}

	@Test
	void rangeFiltersDropRowsWhoseColumnIsNull() {
		Fixture fx = fixture();

		assertEquals(List.of(fx.a),
				idsOf(list(fx.desk, "?articleId=" + fx.a + "&createdAtFrom=" + FAR_PAST + "&createdAtTo=" + FAR_FUTURE)),
				"createdAt 범위 안이면 잡힌다");
		assertEquals(List.of(), idsOf(list(fx.desk, "?articleId=" + fx.a + "&createdAtFrom=" + FAR_FUTURE)),
				"createdAtFrom이 미래면 빠진다");
		assertEquals(List.of(fx.c), idsOf(list(fx.desk, "?articleId=" + fx.c + "&sentAtFrom=" + FAR_PAST)),
				"송고된 C는 sentAt 범위에 잡힌다");
		assertEquals(List.of(), idsOf(list(fx.desk, "?articleId=" + fx.a + "&sentAtFrom=" + FAR_PAST)),
				"sentAt이 NULL인 A는 범위 필터에서 탈락한다");
		assertEquals(List.of(), idsOf(list(fx.desk, "?articleId=" + fx.a + "&distributedAtTo=" + FAR_FUTURE)),
				"distributedAt이 NULL인 행은 To 범위에서도 탈락한다");
	}

	@Test
	void allThirteenFilterKeysAtOnceAre200AndKeysOutsideTheWhitelistAreIgnored() {
		Fixture fx = fixture();
		String all13 = "?articleId=" + fx.c + "&author=" + enc(fx.authorC) + "&sender=aq-d"
				+ "&status=DPS&excludeStatus=RDS&department=" + enc(fx.deptC) + "&departments=" + enc(fx.deptC)
				+ "&createdAtFrom=" + FAR_PAST + "&createdAtTo=" + FAR_FUTURE
				+ "&sentAtFrom=" + FAR_PAST + "&sentAtTo=" + FAR_FUTURE
				+ "&distributedAtFrom=" + FAR_PAST + "&distributedAtTo=" + FAR_FUTURE;

		assertEquals(200, list(fx.desk, all13).status(), "13키 전수는 400이 아니라 200이다");
		// 배부 축 2키를 뺀 11키는 동시에 양성이어야 한다(나머지 키가 조용히 무시되지 않았다는 증거).
		String eleven = all13.replace("&distributedAtFrom=" + FAR_PAST, "").replace("&distributedAtTo=" + FAR_FUTURE, "");
		assertEquals(List.of(fx.c), idsOf(list(fx.desk, eleven)), "11키 동시 적용에도 C가 잡힌다");

		List<String> plain = idsOf(list(fx.desk, "?status=RDS"));
		List<String> bogus = idsOf(list(fx.desk, "?status=RDS&bogusKey=1&limit=1&q=x&lockerSessionId=x"));
		assertEquals(200, list(fx.desk, "?bogusKey=1").status(), "알 수 없는 키에도 400이 아니라 200이다");
		assertEquals(plain, bogus, "화이트리스트 밖 키는 조용히 무시된다(결과가 같다)");
	}

	@Test
	void anEmptyFilterValueIsStillAFilter() {
		Fixture fx = fixture();

		// Node는 query[k] !== undefined 로 존재를 판정한다 — ?author= 도 조건이다(author = '').
		List<String> empty = idsOf(list(fx.desk, "?author="));

		assertFalse(empty.contains(fx.a), "빈 값도 조건이라 작성자가 있는 행은 빠진다");
	}

	// --- 3. 스칼라 전용 키 반복 = 500(결함 후보 #4 재현 — 400으로 고치지 않는다) ---------------------

	@Test
	void repeatingAScalarOnlyFilterKeyIs500NotA400() {
		Fixture fx = fixture();

		for (String query : List.of(
				"?department=" + enc(fx.deptA) + "&department=" + enc(fx.deptB),
				"?articleId=" + fx.a + "&articleId=" + fx.b,
				"?author=x&author=y",
				"?sender=x&sender=y",
				"?createdAtFrom=" + FAR_PAST + "&createdAtFrom=" + FAR_FUTURE)) {
			Wire.Response response = list(fx.desk, query);

			assertEquals(500, response.status(), query + ": 배열 허용 키가 아니면 서버 오류다(400이 아니다)");
			assertEquals(INTERNAL_ERROR, response.body(), query + ": 전역 에러 핸들러의 고정 본문");
			assertEquals(JSON_CONTENT_TYPE, response.line("content-type"));
		}
	}

	// --- 4. 검색 ------------------------------------------------------------------------------------

	@Test
	void searchMatchesTokensAndReturnsArticleRowsOfFiveKeys() {
		Fixture fx = fixture();

		Wire.Response hit = search(fx.reporter, "?q=" + enc(fx.token));

		assertEquals(200, hit.status());
		assertEquals(JSON_CONTENT_TYPE, hit.line("content-type"));
		Map<String, Object> body = json(hit);
		assertEquals("items,ok", sortedKeys(body), "목록과 같은 봉투(총수 필드 없음)");
		List<String> ids = idsOf(hit);
		ids.sort(null);
		List<String> expected = new ArrayList<>(fx.ids());
		expected.add(fx.korean);
		expected.sort(null);
		assertEquals(expected, ids, "고유 토큰은 내 픽스처만 매칭한다");
		for (Map<String, Object> row : items(body)) {
			assertEquals(ARTICLE_ROW_KEYS, sortedKeys(row), "검색 행 = Article 5키(본문 포함)");
		}
		assertNoSecretLeak(hit, fx, "search");
	}

	@Test
	void anEmptyOrMissingQueryMatchesEverythingAndAMissMatchesNothing() {
		Fixture fx = fixture();

		Wire.Response empty = search(fx.reporter, "?q=");
		Wire.Response missing = search(fx.reporter, "");
		Wire.Response miss = search(fx.reporter, "?q=" + enc(fx.token) + "-no-such-suffix");

		assertEquals(200, empty.status(), "빈 q도 200(400이 아니다)");
		assertTrue(idsOf(empty).contains(fx.a), "빈 q는 전 행 매칭이다");
		assertEquals(200, missing.status(), "q 미전달도 200");
		assertTrue(idsOf(missing).contains(fx.a), "q 미전달은 빈 문자열 폴백과 같다");
		assertEquals(200, miss.status(), "무매칭도 200 빈 목록(404가 아니다)");
		assertFalse(idsOf(miss).contains(fx.a), "내 픽스처가 매칭되지 않는다");
	}

	@Test
	void aRepeatedQueryParameterIsJoinedLikeNodeDoes() {
		Fixture fx = fixture();

		// 미동결 축(index.json forward_notes (4)⑤). Node 실측: express가 배열로 파싱하고
		// `%${q}%` 템플릿이 Array#toString으로 콤마 결합한다 → ?q=a&q=b 는 LIKE '%a,b%'와 같다.
		List<String> repeated = idsOf(search(fx.reporter, "?q=" + enc(fx.token) + "&q=X"));
		List<String> comma = idsOf(search(fx.reporter, "?q=" + enc(fx.token + ",X")));

		assertEquals(comma, repeated, "반복 q는 콤마 결합 1개 값과 같은 결과다(Node 동형)");
		assertFalse(repeated.contains(fx.a), "결합된 문자열은 어느 픽스처에도 없다");
	}

	// --- 5. 이력 목록 -------------------------------------------------------------------------------

	@Test
	void aFreshArticleAndAnUnknownArticleBothAnswerWithAnEmptyList() {
		Fixture fx = fixture();

		Wire.Response fresh = history(fx.reporter, fx.b, "");
		Wire.Response unknown = history(fx.reporter, NO_SUCH_ARTICLE, "");

		assertEquals(200, fresh.status(), "생성만 된 기사도 200");
		assertEquals("{\"ok\":true,\"items\":[]}", fresh.body(), "기사 생성은 이력 행을 남기지 않는다");
		assertEquals(200, unknown.status(), "존재하지 않는 기사도 404가 아니라 200이다");
		assertEquals("{\"ok\":true,\"items\":[]}", unknown.body(), "빈 배열");
		assertEquals(JSON_CONTENT_TYPE, unknown.line("content-type"));
	}

	@Test
	void historyRowsAreTwelveKeysWithIntegerHasSnapshotAndDerivedDisplayFields() {
		Fixture fx = fixture();

		Wire.Response response = history(fx.reporter, fx.c, "");

		assertEquals(200, response.status());
		Map<String, Object> body = json(response);
		assertEquals("items,ok", sortedKeys(body));
		for (Map<String, Object> row : items(body)) {
			assertEquals(HISTORY_ROW_KEYS, sortedKeys(row), "이력 행은 12키 고정이다");
			assertFalse(row.containsKey("markupVersion"), "목록에 본문 blob이 없다");
			assertFalse(row.containsKey("snapshotTitle"), "저장 컬럼명은 응답에 없다 — 파생 키는 title이다");
			assertFalse(row.containsKey("targetId"), "배부 컬럼은 Z 전용 표면이다");
			assertFalse(row.containsKey("reason"), "배부 컬럼은 Z 전용 표면이다");
		}
		Map<String, Object> edit = rowWhere(body, "eventType", "edit");
		Map<String, Object> send = rowWhere(body, "eventType", "status");
		assertEquals(1, edit.get("hasSnapshot"), "hasSnapshot은 불리언이 아니라 정수 1이다");
		assertEquals(0, send.get("hasSnapshot"), "상태 전이 행은 스냅샷 0이다");
		assertTrue(response.body().contains("\"hasSnapshot\":1"), "와이어 원문도 정수다(true가 아니다)");
		assertTrue(response.body().contains("\"hasSnapshot\":0"), "와이어 원문도 정수다(false가 아니다)");
		assertNull(edit.get("action"), "edit 행의 action은 null이다");
		assertNull(edit.get("fromStatus"), "edit 행은 전이가 아니다");
		assertNull(edit.get("toStatus"), "edit 행은 전이가 아니다");
		assertEquals("send", send.get("action"));
		assertEquals("RDS", send.get("fromStatus"));
		assertEquals("DPS", send.get("toStatus"));
		assertEquals(fx.editMark, edit.get("title"), "파생 title은 저장된 스냅샷 제목(본문 첫 텍스트 줄)이다");
		assertEquals(2, edit.get("version"), "최초 저장 본문이 v1이라 첫 편집 스냅샷은 v2다");
		assertEquals(2, send.get("version"), "전이 행은 버전을 올리지 않는다");
		assertEquals("RDS", edit.get("status"), "전이 이전 구간의 상태는 첫 전이의 fromStatus로 역승계된다");
		assertEquals("DPS", send.get("status"), "전이 행의 상태는 toStatus다");
		assertNoSecretLeak(response, fx, "history");
	}

	@Test
	void theSendOnlyPredicateFollowsNodeExactly() {
		Fixture fx = fixture();
		long editId = idOf(rowWhere(json(history(fx.reporter, fx.c, "")), "eventType", "edit"));
		long sendId = idOf(rowWhere(json(history(fx.reporter, fx.c, "")), "eventType", "status"));

		Map<String, Boolean> variants = new LinkedHashMap<>();
		variants.put("?sendOnly=1", true);
		variants.put("?type=send", true);
		variants.put("?sendOnly=", true); // 빈 값도 참이다('0'도 'false'도 아니다).
		variants.put("?sendOnly=no", true);
		variants.put("?sendOnly=0&type=send", true);
		variants.put("?sendOnly=0", false);
		variants.put("?sendOnly=false", false);
		variants.put("?type=edit", false);

		for (Map.Entry<String, Boolean> variant : variants.entrySet()) {
			Wire.Response response = history(fx.reporter, fx.c, variant.getKey());
			assertEquals(200, response.status(), variant.getKey() + ": 200");
			List<Long> ids = new ArrayList<>();
			for (Map<String, Object> row : items(json(response))) {
				ids.add(idOf(row));
			}
			assertTrue(ids.contains(sendId), variant.getKey() + ": 송고 행은 항상 남는다");
			assertEquals(!variant.getValue(), ids.contains(editId),
					variant.getKey() + ": 편집 행 포함 여부가 sendOnly 판정과 어긋난다");
		}
	}

	@Test
	void aRepeatedSendOnlyParameterIsTruthyLikeNodeDoes() {
		Fixture fx = fixture();
		long editId = idOf(rowWhere(json(history(fx.reporter, fx.c, "")), "eventType", "edit"));

		// 미동결 축(forward_notes (4)⑤). Node 실측: 반복 키는 배열이고 배열은 '0'·'false'와 절대 같지
		// 않으므로 참이다 — ?sendOnly=0&sendOnly=0 도 송고 필터가 걸린다.
		Wire.Response response = history(fx.reporter, fx.c, "?sendOnly=0&sendOnly=0");

		List<Long> ids = new ArrayList<>();
		for (Map<String, Object> row : items(json(response))) {
			ids.add(idOf(row));
		}
		assertFalse(ids.contains(editId), "반복 sendOnly는 참이다(스칼라 '0'과 같지 않다)");
	}

	// --- 6. 단건 스냅샷 -----------------------------------------------------------------------------

	@Test
	void aSnapshotRowCarriesTheBodyAndATransitionRowCarriesNull() {
		Fixture fx = fixture();
		Map<String, Object> listing = json(history(fx.reporter, fx.c, ""));
		long editId = idOf(rowWhere(listing, "eventType", "edit"));
		long sendId = idOf(rowWhere(listing, "eventType", "status"));

		Wire.Response edit = snapshot(fx.reporter, fx.c, String.valueOf(editId));
		Wire.Response transition = snapshot(fx.reporter, fx.c, String.valueOf(sendId));

		assertEquals(200, edit.status());
		assertEquals(JSON_CONTENT_TYPE, edit.line("content-type"));
		Map<String, Object> body = json(edit);
		assertEquals("item,ok", sortedKeys(body), "봉투는 ok·item 2키다");
		Map<String, Object> item = item(body);
		assertEquals(SNAPSHOT_ITEM_KEYS, sortedKeys(item), "item = 7키(본문 포함, 전이 컬럼 없음)");
		assertEquals(fx.editBody, item.get("markupVersion"), "스냅샷 본문이 저장한 본문과 같다");
		assertEquals(fx.c, item.get("articleId"), "articleId 스코프가 응답에도 실린다");

		assertEquals(200, transition.status(), "스냅샷이 없는 전이 행도 200이다");
		Map<String, Object> transitionItem = item(json(transition));
		assertEquals(SNAPSHOT_ITEM_KEYS, sortedKeys(transitionItem), "같은 7키");
		assertNull(transitionItem.get("markupVersion"), "본문만 null이다");
		assertTrue(transition.body().contains("\"markupVersion\":null"), "키는 남고 값이 null이다");
		assertNoSecretLeak(edit, fx, "snapshot");
	}

	@Test
	void nonIntegerUnknownAndCrossArticleSnapshotIdsAreAll404() {
		Fixture fx = fixture();
		long editId = idOf(rowWhere(json(history(fx.reporter, fx.c, "")), "eventType", "edit"));

		Map<String, String> cases = new LinkedHashMap<>();
		cases.put("abc", fx.c);
		cases.put("1.5", fx.c);
		cases.put("2147483646", fx.c);
		cases.put(String.valueOf(editId), fx.b); // 다른 기사 스코프(권한 우회 방지)

		for (Map.Entry<String, String> variant : cases.entrySet()) {
			Wire.Response response = snapshot(fx.reporter, variant.getValue(), variant.getKey());

			assertEquals(404, response.status(), "historyId=" + variant.getKey() + ": 404여야 한다");
		}
		assertEquals(NOT_FOUND, snapshot(fx.reporter, fx.c, "abc").body(), "본문 고정");
		assertEquals(JSON_CONTENT_TYPE, snapshot(fx.reporter, fx.c, "abc").line("content-type"));
	}

	@Test
	void theIntegerTestFollowsNodesNumberConversion() {
		Fixture fx = fixture();
		long editId = idOf(rowWhere(json(history(fx.reporter, fx.c, "")), "eventType", "edit"));

		// Node는 Number(param) + Number.isInteger로 판정한다 — 16진·지수·소수점 0·공백·부호가 전부
		// 같은 정수로 수렴한다(forward_notes (4)⑥이 미검증으로 남긴 축을 여기서 닫는다).
		for (String spelling : List.of(String.valueOf(editId), editId + ".0", editId + "e0",
				"0x" + Long.toHexString(editId), "+" + editId, "%20" + editId)) {
			Wire.Response response = snapshot(fx.reporter, fx.c, spelling);

			assertEquals(200, response.status(), "historyId=" + spelling + ": Node는 이 표기를 정수로 읽는다");
			assertEquals(editId, idOf(item(json(response))), "같은 이력 행이어야 한다");
		}
		for (String spelling : List.of("1e1000", "Infinity", "1_0", "0b12", "1.5e0")) {
			assertEquals(404, snapshot(fx.reporter, fx.c, spelling).status(),
					"historyId=" + spelling + ": Node에서도 이 표기는 행에 닿지 않는다");
		}
	}

	// --- 7. 인가(4라우트 미인증 401 · 우회 변형) -----------------------------------------------------

	@Test
	void allFourQueryRoutesAre401WithoutASession() {
		Fixture fx = fixture();

		for (String path : List.of("/api/articles/search?q=x", "/api/articles",
				"/api/articles/" + fx.a + "/history", "/api/articles/" + fx.a + "/history/1")) {
			Wire.Response noSession = Wire.send(this.port, "GET", path);
			Wire.Response deadToken = Wire.send(this.port, "GET", path, Map.of("x-session-id", "0".repeat(64)), null);

			for (Wire.Response denied : List.of(noSession, deadToken)) {
				assertEquals(401, denied.status(), path + ": 미인증은 401이다");
				assertEquals(UNAUTHENTICATED, denied.body(), path + ": 본문 고정");
				assertEquals(JSON_CONTENT_TYPE, denied.line("content-type"));
			}
		}
	}

	@Test
	void encodingAndPathParameterVariantsStayGuarded() {
		Fixture fx = fixture();

		for (String path : List.of("/api/artic%6Ces", "/api/articles;a=b", "/api/articles/",
				"/api/articles/" + fx.a + ";v=2/history", "/api/articles/" + fx.a + "/history;v=2")) {
			Wire.Response response = Wire.send(this.port, "GET", path);

			assertEquals(401, response.status(), path + ": 우회 변형도 401이다");
			assertEquals(UNAUTHENTICATED, response.body(), path + ": 본문 고정");
		}
	}

	// --- 8. 라우트 우선순위(리터럴이 경로 변수를 이긴다) ---------------------------------------------

	@Test
	void theSearchRouteIsNotSwallowedByTheSingleArticleMapping() {
		Fixture fx = fixture();

		Wire.Response searched = search(fx.reporter, "?q=" + enc(fx.token));
		Wire.Response single = Wire.send(this.port, "GET", "/api/articles/" + fx.a,
				Map.of("x-session-id", fx.reporter), null);

		assertEquals(200, searched.status(), "/search가 /{id}에 흡수되면 404 not-found가 된다");
		assertEquals("items,ok", sortedKeys(json(searched)), "검색 봉투(ok·items)가 그대로다");
		assertEquals(200, single.status(), "단건 조회도 함께 살아 있다");
		assertEquals("article,contents,ok", sortedKeys(json(single)), "단건 봉투(ok·article·contents)가 그대로다");
	}

	// --- 도구 ---------------------------------------------------------------------------------------

	private Wire.Response list(String sessionId, String query) {
		return Wire.send(this.port, "GET", "/api/articles" + query, Map.of("x-session-id", sessionId), null);
	}

	private Wire.Response search(String sessionId, String query) {
		return Wire.send(this.port, "GET", "/api/articles/search" + query, Map.of("x-session-id", sessionId), null);
	}

	private Wire.Response history(String sessionId, String articleId, String query) {
		return Wire.send(this.port, "GET", "/api/articles/" + articleId + "/history" + query,
				Map.of("x-session-id", sessionId), null);
	}

	private Wire.Response snapshot(String sessionId, String articleId, String historyId) {
		return Wire.send(this.port, "GET", "/api/articles/" + articleId + "/history/" + historyId,
				Map.of("x-session-id", sessionId), null);
	}

	/**
	 * 응답 어디에도 잠금 비밀·세션 토큰 원문이 없다 — 키 집합 비교가 놓치는 중첩·문자열 연결 유출을
	 * 원문 전체 훑기로 잡는다(계약 파일의 {@code assertNoLockerLeak}와 같은 규율).
	 */
	private static void assertNoSecretLeak(Wire.Response response, Fixture fx, String label) {
		String body = response.body();
		assertFalse(body.contains("lockerSessionId"), label + ": 응답에 lockerSessionId가 등장한다");
		assertFalse(body.contains("lockerClientId"), label + ": 응답에 lockerClientId가 등장한다");
		for (String token : List.of(fx.reporter, fx.desk, fx.admin)) {
			assertFalse(body.contains(token), label + ": 응답에 세션 토큰 원문이 등장한다");
		}
		assertFalse(body.contains(fx.clientId), label + ": 응답에 편집 탭 식별자가 등장한다");
	}

	@SuppressWarnings("unchecked")
	private static Map<String, Object> json(Wire.Response response) {
		return JSON.readValue(response.body(), Map.class);
	}

	@SuppressWarnings("unchecked")
	private static List<Map<String, Object>> items(Map<String, Object> body) {
		return (List<Map<String, Object>>) body.get("items");
	}

	@SuppressWarnings("unchecked")
	private static Map<String, Object> item(Map<String, Object> body) {
		return (Map<String, Object>) body.get("item");
	}

	private static List<String> idsOf(Wire.Response response) {
		List<String> ids = new ArrayList<>();
		for (Map<String, Object> row : items(json(response))) {
			ids.add(String.valueOf(row.get("articleId")));
		}
		return ids;
	}

	private static List<Map<String, Object>> rowsOf(Map<String, Object> body, List<String> articleIds) {
		List<Map<String, Object>> found = new ArrayList<>();
		for (Map<String, Object> row : items(body)) {
			if (articleIds.contains(row.get("articleId"))) {
				found.add(row);
			}
		}
		return found;
	}

	private static Map<String, Object> rowWhere(Map<String, Object> body, String key, String value) {
		for (Map<String, Object> row : items(body)) {
			if (value.equals(row.get(key))) {
				return row;
			}
		}
		throw new AssertionError("이력 행을 찾지 못했다: " + key + "=" + value + " in " + body);
	}

	private static long idOf(Map<String, Object> row) {
		return ((Number) row.get("id")).longValue();
	}

	/** 키 집합을 정렬해 이어 붙인 문자열 — 계약 리포트가 비교하는 것과 같은 표현이다. */
	private static String sortedKeys(Map<String, Object> value) {
		return String.join(",", new TreeSet<>(value.keySet()));
	}

	private static String enc(String value) {
		return URLEncoder.encode(value, StandardCharsets.UTF_8);
	}

	/**
	 * 픽스처 한 벌 — A(RDS 유지) · B(다른 작성자·부서) · C(편집 스냅샷 + 송고 + <b>잠금 유지</b>) ·
	 * 한글 부서 1건. 잠금을 일부러 풀지 않는 이유는 잠금 비밀이 실제로 DB에 들어 있는 상태에서 투영을
	 * 관측하기 위해서다(그러지 않으면 투영 단언이 공허하다).
	 */
	private Fixture fixture() {
		String token = unique("aq");
		String reporter = login("aq-r");
		String desk = login("aq-d");
		String admin = login("aq-z");
		Fixture fx = new Fixture(token, reporter, desk, admin);
		fx.deptA = unique("aq-dept-a");
		fx.deptB = unique("aq-dept-b");
		fx.deptC = unique("aq-dept-c");
		fx.deptKorean = "국제부-" + token;
		fx.authorA = unique("aq-author-a");
		fx.authorB = unique("aq-author-b");
		fx.authorC = unique("aq-author-c");
		fx.editMark = unique("aq-edit");
		fx.clientId = unique("aq-tab");

		fx.a = create(desk, token + " A", fx.authorA, fx.deptA);
		fx.b = create(reporter, token + " B", fx.authorB, fx.deptB);
		fx.c = create(desk, token + " C", fx.authorC, fx.deptC);
		fx.korean = create(desk, token + " K", fx.authorA, fx.deptKorean);

		// C: 잠금 획득 → PUT 저장(= edit 이력 + 본문 스냅샷) → 송고(= status/send 이력).
		assertEquals(200, Wire.json(this.port, "POST", "/api/articles/" + fx.c + "/lock",
				Map.of("x-session-id", desk, "x-edit-client", fx.clientId), "{}").status(), "픽스처: 잠금 획득");
		fx.editBody = "{\"format\":\"yh-editor\",\"version\":1,\"blocks\":["
				+ "{\"type\":\"text\",\"text\":\"" + fx.editMark + "\"},"
				+ "{\"type\":\"text\",\"text\":\"(끝)\"}]}";
		assertEquals(200, Wire.json(this.port, "PUT", "/api/articles/" + fx.c,
				Map.of("x-session-id", desk, "x-edit-client", fx.clientId),
				"{\"markupVersion\":\"" + escaped(fx.editBody) + "\"}").status(), "픽스처: PUT 저장");
		Wire.Response sent = Wire.json(this.port, "POST", "/api/articles/" + fx.c + "/action",
				Map.of("x-session-id", desk), "{\"action\":\"send\"}");
		assertEquals("{\"ok\":true,\"status\":\"DPS\"}", sent.body(), "픽스처: 무엠바고 송고는 DPS");
		return fx;
	}

	/** 픽스처 값 묶음 — 필드가 많아 record 대신 가변 홀더를 쓴다(테스트 전용). */
	private static final class Fixture {

		private final String token;

		private final String reporter;

		private final String desk;

		private final String admin;

		private String a;

		private String b;

		private String c;

		private String korean;

		private String deptA;

		private String deptB;

		private String deptC;

		private String deptKorean;

		private String authorA;

		private String authorB;

		private String authorC;

		private String editMark;

		private String editBody;

		private String clientId;

		private Fixture(String token, String reporter, String desk, String admin) {
			this.token = token;
			this.reporter = reporter;
			this.desk = desk;
			this.admin = admin;
		}

		private List<String> ids() {
			return List.of(this.a, this.b, this.c);
		}

	}

	private String create(String sessionId, String title, String author, String department) {
		String body = "{\"title\":\"" + title + "\",\"author\":\"" + author + "\",\"department\":\"" + department
				+ "\",\"departmentCode\":\"AQ\",\"markupVersion\":\"" + escaped("{\"blocks\":[{\"type\":\"text\","
				+ "\"text\":\"" + title + " 본문.\\n(끝)\"}]}") + "\"}";
		Wire.Response response = Wire.json(this.port, "POST", "/api/articles", Map.of("x-session-id", sessionId), body);
		Matcher matcher = CREATED.matcher(response.body());
		assertTrue(matcher.matches(), "픽스처 생성 실패: " + response.status() + " " + response.body());
		return matcher.group(1);
	}

	private String login(String userId) {
		Wire.Response response = Wire.json(this.port, "POST", "/api/login", Map.of(),
				"{\"userId\":\"" + userId + "\",\"password\":\"" + PASSWORD + "\"}");
		Matcher matcher = SESSION_ID.matcher(response.body());
		assertTrue(matcher.find(), "로그인 응답에 sessionId가 없다: status=" + response.status());
		return matcher.group(1);
	}

	private void ensureUser(String userId, String role, String name, String department, String departmentCode) {
		Map<String, Object> dto = new LinkedHashMap<>();
		dto.put("userId", userId);
		dto.put("name", name);
		dto.put("role", role);
		dto.put("department", department);
		dto.put("departmentCode", departmentCode);
		dto.put("password", PASSWORD);
		try {
			this.users.create(dto);
		}
		catch (RuntimeException ignored) {
			// 이미 있다 — 픽스처는 멱등이다(행을 지우지 않는다).
		}
	}

	private static String unique(String prefix) {
		return prefix + "-" + Long.toString(System.nanoTime(), 36);
	}

	/** JSON <b>문자열 값</b>으로 실을 수 있게 이스케이프한 형태. */
	private static String escaped(String raw) {
		return raw.replace("\\", "\\\\").replace("\"", "\\\"");
	}

}
