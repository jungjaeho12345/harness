package harness.news.model.dialect;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import harness.news.model.ContentsRow;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
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
	 * 기사 목록의 {@code ORDER BY createdAt DESC}가 두 방언에서 같은 순서를 주고, 그 순서가
	 * <b>기대한 절대 순서</b>와 같다.
	 *
	 * <p><b>두 단언이 둘 다 필요하다</b>(변이 M1b 실측): 방언끼리만 비교하면 {@code ORDER BY}를 통째로
	 * 지워도 green이다 — 절이 없을 때 두 엔진이 <b>둘 다</b> PK 순서로 내주기 때문에 답이 여전히 일치한다.
	 * 그래서 기대 순서를 테스트가 직접 계산해 절대 비교도 한다.
	 *
	 * <p>{@code createdAt}은 ISO 문자열이라 <b>사전식</b> 비교이고 그 비교의 판정자가 collation이다.
	 * 표본은 <b>대소문자만 다른 쌍</b>({@code ...T...Z} vs {@code ...t...z})을 같은 날짜로 넣어 순서가
	 * 오직 대소문자로 갈리게 만든다 — 여기가 {@code 0900_bin}과 {@code ai_ci}가 갈리는 자리다.
	 * <b>같은 값(tie)은 하나도 없다</b>: tie는 양쪽 다 순서를 보장하지 않아 단언하면 flake가 된다.
	 */
	@Test
	void articleListOrdersByCreatedAtDescendingIdenticallyInBothDialects() {
		String author = "ord-list";
		Map<String, String> createdAtById = new LinkedHashMap<>();
		for (int i = 0; i < KOREAN_TITLES.size(); i++) {
			String createdAt = createdAtSample(i);
			createdAtById.put(seedArticle(i, KOREAN_TITLES.get(i), createdAt, author), createdAt);
		}
		Map<String, List<String>> mine = Map.of("author", List.of(author));

		List<String> onSqlite = articleIds(pair.sqlite(), mine);
		List<String> onMysql = articleIds(pair.mysql(), mine);

		assertEquals(KOREAN_TITLES.size(), onSqlite.size(), "표본이 전부 들어갔다");
		assertEquals(expectedDescending(createdAtById), onSqlite,
				"SQLite 목록이 기대한 절대 순서와 다르다");
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
		Map<String, String> createdAtById = new LinkedHashMap<>();
		for (int i = 0; i < keys.size(); i++) {
			createdAtById.put(seedArticle(1000 + i, "정렬키 " + i, keys.get(i), author), keys.get(i));
		}

		Map<String, List<String>> filter = Map.of("author", List.of(author));
		assertEquals(expectedDescending(createdAtById), articleIds(pair.sqlite(), filter),
				"SQLite 정렬이 BINARY(코드포인트 내림차순)와 다르다");
		assertEquals(articleIds(pair.sqlite(), filter), articleIds(pair.mysql(), filter),
				"정렬 키의 collation이 갈렸다 — 기반선 collation을 확인하라(축 3·5)");
	}

	/**
	 * 기대 순서를 테스트가 <b>직접</b> 계산한다 — {@code createdAt} 내림차순, NULL은 맨 뒤.
	 *
	 * <p>Java {@code String.compareTo}는 코드포인트 순서이고, 그것이 곧 UTF-8 바이트 순서(SQLite BINARY)이자
	 * {@code utf8mb4_0900_bin}의 순서다(BMP 범위 · 표본에 서로게이트 없음). 즉 이 계산은 두 방언의 기대값을
	 * 동시에 만든다 — 어느 한쪽을 정본으로 베끼는 것이 아니다.
	 */
	private static List<String> expectedDescending(Map<String, String> createdAtById) {
		List<String> ids = new ArrayList<>(createdAtById.keySet());
		ids.sort((left, right) -> {
			String a = createdAtById.get(left);
			String b = createdAtById.get(right);
			if (a == null || b == null) {
				return (a == null && b == null) ? 0 : ((a == null) ? 1 : -1);
			}
			return b.compareTo(a);
		});
		return ids;
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
		List<Object> inserted = new ArrayList<>();
		for (int i = 0; i < 20; i++) {
			long id = pair.sqlite().history().insert(row("articleId", articleId, "eventType", "edit",
					"actorUserId", "u" + i, "createdAt", createdAtSample(i + 2)));
			long other = pair.mysql().history().insert(row("articleId", articleId, "eventType", "edit",
					"actorUserId", "u" + i, "createdAt", createdAtSample(i + 2)));
			assertEquals(id, other, "이관 직후 채번이 두 방언에서 같아야 한다");
			inserted.add(id);
		}
		List<Object> newestFirst = new ArrayList<>(inserted);
		java.util.Collections.reverse(newestFirst);

		List<Object> onSqlite = idsOf(pair.sqlite().history().queryByArticle(articleId));
		List<Object> onMysql = idsOf(pair.mysql().history().queryByArticle(articleId));

		assertEquals(20, onSqlite.size());
		assertEquals(newestFirst, onSqlite, "이력이 최신순(id DESC)이 아니다 — 삽입 역순이어야 한다");
		assertEquals(onSqlite, onMysql, "이력 정렬이 갈렸다");
	}

	/**
	 * 배부 이벤트 조회는 정렬에 더해 <b>{@code LIMIT ?} 바인딩</b>을 쓴다 — 파라미터 자리의 LIMIT은
	 * 드라이버마다 처리가 다를 수 있어(서버 준비문 vs 클라이언트 치환) 방언 축으로 따로 잰다.
	 */
	@Test
	void distributionEventOrderAndLimitBindingAreIdenticalInBothDialects() {
		String articleId = seedArticle(2100, "배부 이벤트", "2026-02-02T00:00:00.000Z");
		List<Object> inserted = new ArrayList<>();
		for (int i = 0; i < 12; i++) {
			String eventType = (i % 2 == 0) ? "distribute-failed" : "distribute-retry";
			long id = pair.sqlite().history().insert(row("articleId", articleId, "eventType", eventType,
					"createdAt", createdAtSample(i + 2), "reason", "사유 " + i));
			long other = pair.mysql().history().insert(row("articleId", articleId, "eventType", eventType,
					"createdAt", createdAtSample(i + 2), "reason", "사유 " + i));
			assertEquals(id, other, "이관 직후 채번이 두 방언에서 같아야 한다");
			inserted.add(id);
		}
		List<Object> newestFive = new ArrayList<>(inserted.subList(inserted.size() - 5, inserted.size()));
		java.util.Collections.reverse(newestFive);

		List<Object> onSqlite = idsOf(pair.sqlite().history().queryDistributionEvents(articleId, 5));
		List<Object> onMysql = idsOf(pair.mysql().history().queryDistributionEvents(articleId, 5));

		assertEquals(5, onSqlite.size(), "LIMIT 바인딩이 실제로 창을 좁힌다");
		assertEquals(newestFive, onSqlite, "가장 최근 5건이 최신순으로 와야 한다(정렬 없이 LIMIT만 걸면 앞 5건이 온다)");
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

	/**
	 * <b>오름차순 {@code ORDER BY id}는 어떤 행동 테스트로도 관측되지 않는다</b>(2026-09-04 실측) —
	 * 그래서 이 한 축만 정적으로 지킨다.
	 *
	 * <p>변이 M1으로 알게 된 사실이다: {@code ReceiverConfigRepository}에서 {@code ORDER BY id}를 지워도
	 * 위 테스트가 <b>green</b>이었다. 두 엔진 모두 절이 없으면 PK 순서로 내주기 때문이다(InnoDB는 클러스터드
	 * 인덱스 스캔, SQLite는 rowid 스캔). 즉 "정렬을 관측한다"는 주장이 이 축에서는 성립하지 않는다.
	 *
	 * <p>내림차순({@code id DESC}·{@code createdAt DESC})은 사정이 다르다 — 자연 순서와 반대라 절을 지우면
	 * 즉시 red다(M1b·M1c·M1d로 실증). 그쪽은 행동이 지킨다.
	 *
	 * <p>정적 단언은 약한 방어선이라는 것을 인정한다(SQL 문자열의 존재만 본다). 그러나 <b>아무 방어선도
	 * 없는 것보다는 낫고</b>, 무엇보다 "이 축은 행동으로 지켜진다"는 <b>거짓 주장</b>을 남기지 않는다.
	 */
	@Test
	void theAscendingOrderByIsGuardedStaticallyBecauseNoBehaviourTestCanSeeIt() throws IOException {
		for (String file : List.of("ReceiverConfigRepository.java", "DistributionTargetRepository.java")) {
			Path source = Path.of("src", "main", "java", "harness", "news", "model", file);
			String text = Files.readString(source, StandardCharsets.UTF_8);

			assertTrue(text.contains("ORDER BY id\""),
					file + " 의 목록 조회에서 ORDER BY id 가 사라졌다 — 두 엔진의 자연 순서가 우연히 같아서 "
							+ "행동 테스트가 이 삭제를 잡지 못한다(변이 M1 실측)");
		}
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
	 * 정렬을 시험하는 {@code createdAt} 표본 — <b>tie가 하나도 없고</b> 대소문자만 다른 쌍·빈 문자열·
	 * NULL이 정확히 하나씩 섞여 있다.
	 *
	 * <p>index 0은 NULL, 1은 빈 문자열, 그 뒤로는 <b>같은 날짜의 대문자/소문자 쌍</b>이다. 쌍의 두 값은
	 * 날짜가 같으므로 순서가 <b>오직 {@code T}/{@code t}·{@code Z}/{@code z}로만</b> 갈린다 — collation이
	 * 대소문자를 무시하면 그 쌍이 tie가 되어 순서가 흔들리고, 절대 순서 단언이 그것을 잡는다.
	 */
	private static String createdAtSample(int index) {
		if (index == 0) {
			return null;
		}
		if (index == 1) {
			return "";
		}
		int day = (index / 2) + 1;
		return (index % 2 == 0)
				? "2026-01-%02dT00:00:00.000Z".formatted(day)
				: "2026-01-%02dt00:00:00.000z".formatted(day);
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
