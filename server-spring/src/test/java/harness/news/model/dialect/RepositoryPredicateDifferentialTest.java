package harness.news.model.dialect;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;

/**
 * 차등 측정 <b>축 B-2: {@code LIKE}</b>와 <b>축 B-7: {@code length()} 술어</b>(phase 75 step6).
 *
 * <h2>{@code LIKE} 대소문자는 이 phase가 <b>포기한 축</b>이다</h2>
 * step1이 세 collation을 나란히 재서 확인했다: {@code =}(보안 축)·{@code ORDER BY}·{@code LIKE} 세 축을
 * 동시에 만족하는 collation은 <b>없다</b>. {@code utf8mb4_0900_bin}만이 {@code =}와 정렬에서 SQLite
 * BINARY와 완전히 일치하고, 그 대가로 {@code LIKE}가 대소문자를 <b>구분</b>하게 된다(SQLite는 ASCII
 * 대소문자를 무시한다). 피해의 비대칭이 근거다 — {@code =}가 무너지면 다른 계정으로 로그인되고,
 * {@code LIKE}가 갈리면 검색 결과가 좁아질 뿐이다.
 *
 * <p>그래서 이 클래스는 <b>차이를 없애려 하지 않고 고정</b>한다: 아래
 * {@link #asciiCaseIsTheSacrificedAxisAndBothExpectationsAreStatedHere}가 <b>양쪽 기대값을 각각 명시</b>해
 * 두 방언의 답을 못 박는다. {@code server/**}를 고쳐 맞추지 않는다(무수정 정본).
 *
 * <p><b>계약은 이 축을 보지 못한다</b>(실측): {@code photos-search} 케이스는 소문자 랜덤 토큰만 질의어로
 * 쓰므로 대소문자 축이 관측되지 않는다. 이 클래스가 유일 방어선이다.
 *
 * <p><b>변이 M2</b>: 기반선 collation을 {@code utf8mb4_0900_ai_ci}로 바꾸면 아래 대소문자 단언의 MySQL
 * 기대값이 뒤집혀 red다(결과표는 step summary).
 */
class RepositoryPredicateDifferentialTest {

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

	// --- 축 B-2: LIKE ------------------------------------------------------------------------------

	/**
	 * <b>포기한 축의 고정 지점</b> — 같은 질의어에 SQLite는 3건, MySQL은 1건을 준다.
	 *
	 * <p>기대값을 "다르다"로 적지 않는다: 양쪽이 각각 <b>어떤 행 집합</b>을 주는지 적어야 나중에 어느
	 * 쪽이 바뀌었는지 알 수 있다(docs/db-mysql-mapping.md §7이 같은 내용을 표로 싣는다).
	 */
	@Test
	void asciiCaseIsTheSacrificedAxisAndBothExpectationsAreStatedHere() {
		String token = "CaseNeedle";
		long lower = seedPhoto("소문자 " + token.toLowerCase(java.util.Locale.ROOT) + " 캡션");
		long upper = seedPhoto("대문자 " + token.toUpperCase(java.util.Locale.ROOT) + " 캡션");
		long exact = seedPhoto("원문 " + token + " 캡션");

		List<Object> onSqlite = captionSearchIds(pair.sqlite(), token);
		List<Object> onMysql = captionSearchIds(pair.mysql(), token);

		assertEquals(List.of(exact, upper, lower), onSqlite,
				"SQLite LIKE는 ASCII 대소문자를 무시한다 — 세 행이 모두 걸린다(id DESC)");
		assertEquals(List.of(exact), onMysql,
				"MySQL(utf8mb4_0900_bin) LIKE는 대소문자를 구분한다 — 원문만 걸린다");
		assertNotEquals(onSqlite, onMysql, "이 축은 divergence로 기록됐다(축 4 · 유일 방어선은 이 테스트다)");
	}

	/** 한글은 갈리지 않는다 — 포기한 것은 <b>ASCII 대소문자뿐</b>임을 못 박는다(과장 금지). */
	@Test
	void koreanNeedlesMatchIdenticallyInBothDialects() {
		String token = "한글바늘";
		long first = seedPhoto("사진 " + token + " 하나");
		long second = seedPhoto(token + " 로 시작하는 캡션");
		seedPhoto("관계없는 캡션");

		assertEquals(List.of(second, first), captionSearchIds(pair.sqlite(), token));
		assertEquals(captionSearchIds(pair.sqlite(), token), captionSearchIds(pair.mysql(), token),
				"한글 부분일치가 갈렸다");
	}

	/**
	 * 질의어에 든 {@code %}·{@code _}는 <b>양쪽 다</b> 와일드카드로 동작한다({@code ESCAPE} 절이 없다 —
	 * {@code PhotoRepository} 111행). 그 사실을 고정한다: 한쪽만 이스케이프를 붙이면 검색 결과가 갈린다.
	 */
	@Test
	void queryWildcardsBehaveIdenticallyBecauseNeitherStatementHasAnEscapeClause() {
		String tag = "wild" + System.nanoTime();
		long withPercent = seedPhoto(tag + " a%b");
		long withUnderscore = seedPhoto(tag + " a_b");
		long plain = seedPhoto(tag + " axb");

		List<Object> underscoreSqlite = captionSearchIds(pair.sqlite(), "a_b");
		List<Object> underscoreMysql = captionSearchIds(pair.mysql(), "a_b");
		assertTrue(underscoreSqlite.containsAll(List.of(withUnderscore, plain)),
				"밑줄은 한 글자 와일드카드다 — axb도 걸린다");
		assertEquals(underscoreSqlite, underscoreMysql, "밑줄 와일드카드 해석이 갈렸다");

		assertEquals(captionSearchIds(pair.sqlite(), "a%b"), captionSearchIds(pair.mysql(), "a%b"),
				"퍼센트 와일드카드 해석이 갈렸다");
		assertTrue(captionSearchIds(pair.sqlite(), "a%b").contains(withPercent));
	}

	/**
	 * 빈 질의는 {@code LIKE '%%'}라 전체가 나온다(400이 아니다). 단 <b>캡션이 NULL인 행은 걸리지 않는다</b>
	 * — {@code NULL LIKE ...}가 NULL이기 때문이고, 그 3값 논리가 두 방언에서 같은지 본다.
	 */
	@Test
	void anEmptyQueryMatchesEveryNonNullCaptionInBothDialects() {
		long withCaption = seedPhoto("빈 질의 대상");
		long nullCaption = seedPhoto(null);

		List<Object> onSqlite = captionSearchIds(pair.sqlite(), "");
		List<Object> onMysql = captionSearchIds(pair.mysql(), "");

		assertTrue(onSqlite.contains(withCaption));
		assertFalse(onSqlite.contains(nullCaption), "NULL 캡션은 LIKE에 걸리지 않는다");
		assertEquals(onSqlite, onMysql, "빈 질의의 결과 집합·순서가 갈렸다");
	}

	/**
	 * 기사 본문 검색은 3컬럼 {@code LIKE}를 {@code OR}로 잇는다({@code ArticleRepository} 259행) — 같은
	 * 대소문자 축이 여기서도 갈린다. 그 사실을 <b>이 문장으로도</b> 고정한다(테이블마다 collation이 따로
	 * 붙으므로 한 테이블에서 확인한 것이 다른 테이블의 보증이 아니다).
	 */
	@Test
	void articleTextSearchDivergesOnAsciiCaseInTheSameDirection() {
		String token = "BodyNeedle";
		String lowerId = seedArticle(3001, "제목 " + token.toLowerCase(java.util.Locale.ROOT));
		String exactId = seedArticle(3002, "제목 " + token);

		List<String> onSqlite = articleIdsOf(pair.sqlite().articles().searchByText(token));
		List<String> onMysql = articleIdsOf(pair.mysql().articles().searchByText(token));

		assertTrue(onSqlite.containsAll(List.of(lowerId, exactId)), "SQLite는 두 건 다 찾는다: " + onSqlite);
		assertEquals(List.of(exactId), onMysql, "MySQL은 원문만 찾는다");
	}

	// --- 축 B-7: length() 술어 ---------------------------------------------------------------------

	/**
	 * {@code length(markupVersion) > 0}은 <b>값이 갈려도 술어는 갈리지 않는다</b>.
	 *
	 * <p>{@code length('가나다')}는 SQLite에서 3(문자), MySQL {@code LENGTH()}에서 9(바이트)다 — 값은
	 * 확실히 다르다. 그러나 이 문장이 쓰는 비교는 "비어 있지 않은가"이고, NULL·빈 문자열·ASCII·한글
	 * 어느 행에서도 같은 답을 준다. 이 테스트가 그 주장을 <b>프로덕션 문장으로</b> 확인한다 —
	 * 술어를 길이 비교로 바꾸면(예: {@code > 5}) 즉시 red다.
	 */
	@Test
	void theLengthPredicateSelectsTheSameRowsInBothDialects() {
		String articleId = seedArticle(3100, "길이 술어");
		Map<String, Long> ids = new LinkedHashMap<>();
		for (DialectPair.Side side : pair.both()) {
			ids.put(side.name() + "-null", side.history().insert(historyRow(articleId, null)));
			ids.put(side.name() + "-empty", side.history().insert(historyRow(articleId, "")));
			ids.put(side.name() + "-ascii", side.history().insert(historyRow(articleId, "abc")));
			ids.put(side.name() + "-korean", side.history().insert(historyRow(articleId, "가나다")));
			ids.put(side.name() + "-one", side.history().insert(historyRow(articleId, "a")));
		}

		List<Object> onSqlite = idsOf(pair.sqlite().history().querySnapshotTitlesByArticle(articleId));
		List<Object> onMysql = idsOf(pair.mysql().history().querySnapshotTitlesByArticle(articleId));

		assertEquals(3, onSqlite.size(), "NULL과 빈 문자열은 빠지고 세 행만 남는다: " + onSqlite);
		assertEquals(onSqlite, onMysql, "length() 술어가 두 방언에서 다른 행 집합을 준다");
		assertTrue(onSqlite.contains(ids.get("sqlite-korean")), "한글 본문 행이 포함된다");
	}

	/** 위 술어가 <b>실제로</b> 거른다는 증거 — 거르지 않으면 5행이 다 나온다. */
	@Test
	void theLengthPredicateReallyFiltersAndIsNotAPassThrough() {
		String articleId = seedArticle(3200, "술어 비공허성");
		for (DialectPair.Side side : pair.both()) {
			side.history().insert(historyRow(articleId, null));
			side.history().insert(historyRow(articleId, ""));
			side.history().insert(historyRow(articleId, "본문"));
		}

		assertEquals(3, pair.mysql().history().queryByArticle(articleId).size(), "행은 셋 다 있다");
		assertEquals(1, pair.mysql().history().querySnapshotTitlesByArticle(articleId).size(),
				"술어가 둘을 걸러 낸다");
	}

	// --- 픽스처 헬퍼 -------------------------------------------------------------------------------

	/** 두 방언에 같은 사진 1건을 넣고 그 id를 준다(양쪽 id가 다르면 픽스처가 깨진 것이다). */
	private static long seedPhoto(String caption) {
		Map<String, Object> record = row("src", "/uploads/pred.png", "caption", caption,
				"createdAt", "2026-03-01T00:00:00.000Z");
		long onSqlite = pair.sqlite().photos().insert(record);
		long onMysql = pair.mysql().photos().insert(record);
		assertEquals(onSqlite, onMysql, "양쪽 픽스처의 id가 어긋났다");
		return onSqlite;
	}

	private static String seedArticle(int index, String title) {
		String articleId = "AKR%08d%09d".formatted(20260301, index);
		for (DialectPair.Side side : pair.both()) {
			side.articles().insert(
					row("articleId", articleId, "title", title, "markupVersion", "<p>" + title + "</p>"),
					row("articleId", articleId, "title", title, "status", "RDS",
							"createdAt", "2026-03-01T00:00:00.000Z"));
		}
		return articleId;
	}

	private static Map<String, Object> historyRow(String articleId, String markup) {
		return row("articleId", articleId, "eventType", "edit", "markupVersion", markup,
				"createdAt", "2026-03-01T00:00:00.000Z");
	}

	private static List<Object> captionSearchIds(DialectPair.Side side, String needle) {
		return idsOf(side.photos().searchByCaption(needle));
	}

	private static List<Object> idsOf(List<Map<String, Object>> rows) {
		List<Object> ids = new ArrayList<>();
		for (Map<String, Object> row : rows) {
			ids.add(row.get("id"));
		}
		return ids;
	}

	private static List<String> articleIdsOf(List<Map<String, Object>> rows) {
		List<String> ids = new ArrayList<>();
		for (Map<String, Object> row : rows) {
			ids.add(String.valueOf(row.get("articleId")));
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
