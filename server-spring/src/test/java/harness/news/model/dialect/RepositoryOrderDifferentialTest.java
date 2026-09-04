package harness.news.model.dialect;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import harness.news.model.ContentsRow;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;

/**
 * 차등 측정 <b>축 B-1: 정렬</b> — 같은 리포지토리 호출이 두 방언에서 <b>같은 순서</b>를 주는가
 * (phase 75 step6 B-1).
 *
 * <h2>계약은 이 축을 거의 보지 못한다(실측)</h2>
 * {@code contract/cases/default/articles-read.contract.js}는 목록을 {@code idsOf(items).sort()}로
 * 비교한다(237·382·400행) — 정렬해서 비교하므로 <b>행 순서는 단언되지 않는다</b>.
 * {@code receiver-config}·{@code distribution-targets} 케이스도 마찬가지다. <b>예외는 정확히 1건</b>:
 * {@code media-upload.contract.js} 342행이 {@code photos-search}의 반환 순서를 {@code assertDeepEqual}로
 * 직접 단언하므로 {@code PhotoRepository}의 {@code id DESC}만 이중 방어다.
 * ⇒ {@code Article}·{@code ArticleHistory}·{@code DistributionTarget}·{@code ReceiverConfig}의 정렬은
 * <b>이 클래스가 유일 방어선</b>이다.
 *
 * <h2>그래서 여기서는 {@code sort()}하지 않는다</h2>
 * 반환 리스트를 정렬한 뒤 비교하면 계약과 똑같은 맹점이 된다. 이 클래스의 모든 단언은 <b>순서 자체</b>가
 * 대상이고, {@link #theFixtureWouldHaveHiddenTheOrderingIfWeHadSortedIt}가 "정렬해 버렸다면 이 픽스처가
 * 차이를 숨겼을 것"임을 값으로 보여 준다.
 *
 * <p><b>변이 M1</b>: 어느 리포지토리든 {@code ORDER BY}를 지우면 이 클래스가 red다(결과표는 step summary).
 */
class RepositoryOrderDifferentialTest {

	/** 한글 제목 24건 — 정렬 축이 한글 데이터 위에서 돌게 한다(멀티바이트 + 조합형 없음). */
	private static final List<String> KOREAN_TITLES = List.of(
			"가나다 기사", "나라 소식", "다시 쓰는 기사", "라디오 특집", "마을 이야기", "바다 이야기",
			"사회면 머리", "아침 뉴스", "자정 속보", "차별 없는", "카메라 앞", "타는 목마름",
			"파도 소리", "하루의 끝", "Seoul 특파원", "IT 산업 2026", "K-리그 3라운드", "abc 소문자",
			"ABC 대문자", "0번 기사", "9번 기사", "_밑줄 기사", "%퍼센트 기사", "혼합 Mix 12가나");

	private static DialectPair pair;

	@BeforeAll
	static void openPair() {
		pair = DialectPair.open();
	}

	@AfterAll
	static void closePair() {
		if (pair != null) {
			pair.close();
		}
	}

	// --- Contents 목록: ORDER BY createdAt DESC ---------------------------------------------------

	/**
	 * 기사 목록의 {@code ORDER BY createdAt DESC}가 두 방언에서 같은 순서를 준다.
	 *
	 * <p>{@code createdAt}은 ISO 문자열이라 <b>사전식</b> 비교이고, 그 비교의 판정자가 collation이다.
	 * 표본에 대소문자만 다른 값({@code ...Z} vs {@code ...z})·빈 문자열·NULL을 섞어 collation이 갈릴 수
	 * 있는 자리를 전부 통과시킨다. 같은 값(tie)은 넣지 않는다 — 양쪽 다 순서를 보장하지 않으므로
	 * 그 자리를 단언하면 flake가 된다(step6 배경 4).
	 */
	@Test
	void articleListOrdersByCreatedAtDescendingIdenticallyInBothDialects() {
		String author = "ord-list";
		for (int i = 0; i < KOREAN_TITLES.size(); i++) {
			seedArticle(i, KOREAN_TITLES.get(i), createdAtSample(i), author);
		}
		Map<String, List<String>> mine = Map.of("author", List.of(author));

		List<String> onSqlite = articleIds(pair.sqlite(), mine);
		List<String> onMysql = articleIds(pair.mysql(), mine);

		assertEquals(KOREAN_TITLES.size(), onSqlite.size(), "표본이 전부 들어갔다");
		assertEquals(onSqlite, onMysql,
				"목록 정렬이 방언마다 다르다 — 계약은 sort()로 비교하므로 이 차이를 보지 못한다");
	}

	/**
	 * 위 픽스처가 <b>실제로</b> 순서를 시험한다는 증거: 정렬해서 비교했다면 같은 입력이 같은 답이 되어
	 * 어떤 차이도 드러나지 않았을 것이다. 즉 이 단언이 없으면 "순서를 본다"는 주장이 공허하다.
	 */
	@Test
	void theFixtureWouldHaveHiddenTheOrderingIfWeHadSortedIt() {
		String author = "ord-blind";
		for (int i = 0; i < KOREAN_TITLES.size(); i++) {
			seedArticle(100 + i, KOREAN_TITLES.get(i), createdAtSample(i), author);
		}

		List<String> returned = articleIds(pair.sqlite(), Map.of("author", List.of(author)));
		List<String> sorted = new ArrayList<>(returned);
		sorted.sort(null);

		assertEquals(KOREAN_TITLES.size(), returned.size());
		assertNotEquals(sorted, returned,
				"반환 순서가 이미 사전순이면 sort() 비교와 구분되지 않는다 — 픽스처가 무해하다");
	}

	/**
	 * 정렬 키에 <b>한·영·숫자·구두점이 섞인</b> 값을 넣어 collation 자체를 시험한다.
	 *
	 * <p>{@code createdAt}에 이런 값이 실제로 들어오지는 않는다. 그러나 이 문장의 정렬 판정자는 컬럼
	 * collation이고, 그 collation이 흔들리면(예: 기반선이 {@code ai_ci}로 만들어지면) <b>ASCII 대소문자와
	 * 구두점 위치</b>에서 먼저 갈린다(축 5 실측). 그 자리를 프로덕션 문장으로 직접 재는 것이 이 테스트다.
	 */
	@Test
	void theOrderByCollationOfTheProductionStatementMatchesSqliteBinary() {
		List<String> keys = List.of("Zulu", "alpha", "Alpha", "_underscore", "0zero", "9nine",
				"가나다", "다나가", "Mix12가", "mix12가", "%percent", " leading");
		String author = "ord-collation";
		for (int i = 0; i < keys.size(); i++) {
			seedArticle(1000 + i, "정렬키 " + i, keys.get(i), author);
		}

		Map<String, List<String>> filter = Map.of("author", List.of(author));
		assertEquals(articleIds(pair.sqlite(), filter), articleIds(pair.mysql(), filter),
				"정렬 키의 collation이 갈렸다 — 기반선 collation을 확인하라(축 3·5)");
	}

	// --- Photo: ORDER BY id DESC (계약과 이중 방어) -----------------------------------------------

	@Test
	void photoSearchOrdersByIdDescendingIdenticallyInBothDialects() {
		List<Long> inserted = new ArrayList<>();
		for (int i = 0; i < KOREAN_TITLES.size(); i++) {
			long id = pair.sqlite().photos().insert(row("src", "/uploads/p" + i + ".png",
					"caption", KOREAN_TITLES.get(i), "createdAt", createdAtSample(i)));
			long other = pair.mysql().photos().insert(row("src", "/uploads/p" + i + ".png",
					"caption", KOREAN_TITLES.get(i), "createdAt", createdAtSample(i)));
			assertEquals(id, other, "이관 직후의 채번이 두 방언에서 같아야 한다(축 6 — 간격 없는 연속 삽입)");
			inserted.add(id);
		}

		List<Object> onSqlite = idsOf(pair.sqlite().photos().searchByCaption(""));
		List<Object> onMysql = idsOf(pair.mysql().photos().searchByCaption(""));

		assertEquals(inserted.size(), onSqlite.size());
		assertEquals(onSqlite, onMysql, "사진 검색 정렬이 갈렸다");
		assertEquals(Long.valueOf(inserted.get(inserted.size() - 1)), onSqlite.get(0),
				"최신 등록이 맨 위다(계약 media-upload 342행과 같은 단언)");
	}

	// --- ArticleHistory: ORDER BY id DESC ---------------------------------------------------------

	@Test
	void historyListOrdersByIdDescendingIdenticallyInBothDialects() {
		String articleId = seedArticle(2000, "이력 정렬", "2026-02-01T00:00:00.000Z");
		for (int i = 0; i < 20; i++) {
			for (DialectPair.Side side : pair.both()) {
				side.history().insert(row("articleId", articleId, "eventType", "edit",
						"actorUserId", "u" + i, "createdAt", createdAtSample(i)));
			}
		}

		List<Object> onSqlite = idsOf(pair.sqlite().history().queryByArticle(articleId));
		List<Object> onMysql = idsOf(pair.mysql().history().queryByArticle(articleId));

		assertEquals(20, onSqlite.size());
		assertEquals(onSqlite, onMysql, "이력 정렬이 갈렸다");
	}

	/**
	 * 배부 이벤트 조회는 정렬에 더해 <b>{@code LIMIT ?} 바인딩</b>을 쓴다 — 파라미터 자리의 LIMIT은
	 * 드라이버마다 처리가 다를 수 있어(서버 준비문 vs 클라이언트 치환) 방언 축으로 따로 잰다.
	 */
	@Test
	void distributionEventOrderAndLimitBindingAreIdenticalInBothDialects() {
		String articleId = seedArticle(2100, "배부 이벤트", "2026-02-02T00:00:00.000Z");
		for (int i = 0; i < 12; i++) {
			String eventType = (i % 2 == 0) ? "distribute-failed" : "distribute-retry";
			for (DialectPair.Side side : pair.both()) {
				side.history().insert(row("articleId", articleId, "eventType", eventType,
						"createdAt", createdAtSample(i), "reason", "사유 " + i));
			}
		}

		List<Object> onSqlite = idsOf(pair.sqlite().history().queryDistributionEvents(articleId, 5));
		List<Object> onMysql = idsOf(pair.mysql().history().queryDistributionEvents(articleId, 5));

		assertEquals(5, onSqlite.size(), "LIMIT 바인딩이 실제로 창을 좁힌다");
		assertEquals(onSqlite, onMysql, "배부 이벤트 정렬/LIMIT이 갈렸다");
	}

	// --- ReceiverConfig · DistributionTarget: ORDER BY id (오름차순) -------------------------------

	@Test
	void receiverConfigAndDistributionTargetOrderByIdAscendingIdenticallyInBothDialects() {
		for (int i = 0; i < 20; i++) {
			for (DialectPair.Side side : pair.both()) {
				side.configs().insert(row("sourceId", "src-" + i, "type", "FTP", "name", "수신 " + i,
						"createdAt", createdAtSample(i)));
				side.targets().insert(row("name", "수신처 " + i, "kind", "general",
						"spoolDir", "target-" + i, "active", "Y", "createdAt", createdAtSample(i)));
			}
		}

		assertEquals(idsOf(pair.sqlite().configs().query(Map.of())),
				idsOf(pair.mysql().configs().query(Map.of())), "수집 설정 정렬이 갈렸다");
		assertEquals(idsOf(pair.sqlite().targets().query(Map.of())),
				idsOf(pair.mysql().targets().query(Map.of())), "배부 대상 정렬이 갈렸다");
		assertTrue(pair.sqlite().configs().query(Map.of()).size() >= 20, "표본이 들어갔다");
	}

	// --- 픽스처 헬퍼 -------------------------------------------------------------------------------

	/** 두 방언에 같은 기사 1건을 넣는다. */
	private static String seedArticle(int index, String title, String createdAt) {
		return seedArticle(index, title, createdAt, "ord-author");
	}

	private static String seedArticle(int index, String title, String createdAt, String author) {
		String articleId = "AKR%08d%09d".formatted(20260101, index);
		for (DialectPair.Side side : pair.both()) {
			side.articles().insert(
					row("articleId", articleId, "title", title, "markupVersion", "<p>" + title + "</p>"),
					row("articleId", articleId, "title", title, "author", author,
							"status", "RDS", "createdAt", createdAt));
		}
		return articleId;
	}

	/**
	 * 정렬을 시험하는 {@code createdAt} 표본 — 값은 전부 다르고(tie 없음) 대소문자만 다른 쌍·빈 문자열·
	 * NULL이 섞여 있다.
	 */
	private static String createdAtSample(int index) {
		return switch (index % 6) {
			case 0 -> "2026-01-%02dT00:00:00.000Z".formatted((index % 28) + 1);
			case 1 -> "2026-01-%02dt00:00:00.000z".formatted((index % 28) + 1);
			case 2 -> "2026-02-%02dT00:00:00.000Z".formatted((index % 28) + 1);
			case 3 -> "2025-12-%02dT23:59:59.999Z".formatted((index % 28) + 1);
			case 4 -> "";
			default -> null;
		};
	}

	private static List<String> articleIds(DialectPair.Side side, Map<String, List<String>> filters) {
		List<String> ids = new ArrayList<>();
		for (ContentsRow contentsRow : side.articles().query(filters)) {
			ids.add(String.valueOf(contentsRow.column("articleId")));
		}
		return ids;
	}

	private static List<Object> idsOf(List<Map<String, Object>> rows) {
		List<Object> ids = new ArrayList<>();
		for (Map<String, Object> row : rows) {
			ids.add(row.get("id"));
		}
		return ids;
	}

	private static Map<String, Object> row(Object... keyValues) {
		Map<String, Object> map = new LinkedHashMap<>();
		for (int i = 0; i < keyValues.length; i += 2) {
			map.put((String) keyValues[i], keyValues[i + 1]);
		}
		return map;
	}
}
