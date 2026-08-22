package harness.news.service;

import harness.news.model.ArticleAggregate;
import harness.news.model.ArticleHistoryRepository;
import harness.news.model.ArticleRepository;
import harness.news.model.ContentsProjection;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.springframework.stereotype.Service;

/**
 * 기사 <b>읽기</b> 서비스 — 리포 루트 {@code src/services/articleService.js}의 읽기 5경로
 * ({@code getById}·{@code query}·{@code search}·{@code queryHistory}·{@code getHistorySnapshot})와 1:1
 * 이식이다. HTTP 비의존이며(ADR-006) 서블릿 타입을 알지 못한다. <b>읽기 전용</b>이라 DB를 바꾸지 않는다
 * (조회 카운터·최근 열람 갱신 같은 부수효과를 만들지 마라 — 계약이 읽기 전용을 전제하고, 부수효과는
 * 이중 실행 diff가 된다).
 *
 * <h2>이 클래스가 응답 행을 만드는 유일한 지점이다</h2>
 * 클라이언트로 나가는 {@code Contents} 행은 여기서만 만들어지고, 만들어지는 방법은
 * {@link ContentsProjection#toPublic} 하나뿐이다(27키 = 스키마 29컬럼 − 세션 토큰·편집 탭 식별자 2컬럼).
 * 투영을 컨트롤러·리포지토리로 옮기거나 복제하지 마라 — 새 라우트에서 반드시 누락되고, 그 누락이 이
 * 결함의 원래 원인이었다. 반대로 <b>내부 판정 경로</b>(잠금 획득·보유자 검사·전이)는 투영되지 않은 원본이
 * 필요하므로(재로그인 takeover 판정이 {@code lockerSessionId}를 읽는다) 이 서비스를 거치지 않고
 * 리포지토리를 직접 부른다. 그래서 이 클래스의 공개 시그니처에는 원본 행 타입({@code ContentsRow})이
 * 등장하지 않는다 — 컨트롤러가 손에 넣을 수 있는 것은 투영을 통과한 값뿐이다(decisions (4)① 타입 경계).
 *
 * <h2>계약의 '없음'들</h2>
 * <ul>
 *   <li>목록·검색·이력에 <b>총수·페이징 필드가 없다</b>(그 '없음'이 계약이다).</li>
 *   <li>빈 결과는 404가 아니라 <b>빈 배열</b>이다 — 이력은 기사가 아예 없어도 그렇다.</li>
 *   <li>단건 조회에서 한쪽 테이블 행이 없으면 그 <b>키를 싣지 않는다</b>(키 없음 ≠ 값 null —
 *       decisions (20)①). 반대로 컬럼 값이 SQL NULL인 것은 키를 남기고 {@code null}이다.</li>
 * </ul>
 */
@Service
public class ArticleReadService {

	/**
	 * 목록 조회가 허용하는 필터 키 <b>13개</b>. 어떤 키를 통과시킬지는 HTTP 계층이 소유하지만
	 * <b>목록 자체의 단일 출처는 리포지토리</b>다({@link ArticleRepository#FILTER_KEYS}) — 두 벌이 되면
	 * 한쪽만 늘어나 "받아 주는데 조건이 걸리지 않는" 키가 생긴다. 컨트롤러가 리포지토리를 직접 알지
	 * 않도록 인접 계층인 여기서 되비춘다.
	 */
	public static final List<String> FILTER_KEYS = ArticleRepository.FILTER_KEYS;

	/** 이력 목록 응답 봉투의 두 갈래 판정 키 — 송고 필터가 보는 값이다. */
	private static final String EVENT_TYPE = "eventType";

	private static final String ACTION = "action";

	private final ArticleRepository articles;

	private final ArticleHistoryRepository history;

	public ArticleReadService(ArticleRepository articles, ArticleHistoryRepository history) {
		this.articles = articles;
		this.history = history;
	}

	// --- 기사 읽기 --------------------------------------------------------------------------

	/**
	 * 단건 조회 — 본문({@code Article.markupVersion})을 포함한 한 기사.
	 *
	 * @return {@code article}(5키 원본 맵)·{@code contents}(투영 27키) 중 <b>존재하는 쪽만</b> 담은 맵.
	 *     두 행이 다 없으면 {@code null}이며 HTTP 계층이 그것을 404로 바꾼다. 키를 빼는 판단이 여기 있는
	 *     이유는 그래야 라우트가 결과를 <b>그대로 직렬화</b>하면 되기 때문이다(라우트마다 다시 판단하면
	 *     새 라우트에서 어긋난다).
	 */
	public Map<String, Object> getById(String articleId) {
		ArticleAggregate found = this.articles.findById(articleId);
		if (found == null) {
			return null;
		}
		Map<String, Object> body = new LinkedHashMap<>();
		if (found.article() != null) {
			body.put("article", found.article());
		}
		if (found.contents() != null) {
			body.put("contents", ContentsProjection.toPublic(found.contents()));
		}
		return body;
	}

	/**
	 * 목록 조회 — 필터를 리포지토리에 <b>그대로</b> 넘기고 결과를 행마다 투영한다.
	 *
	 * <p>입력은 HTTP 계층이 화이트리스트 13키로 걸러 준 <b>원문 값 배열 맵</b>이다. 여기서 값을
	 * 재해석하지 마라(콤마 분해·트림·형변환 금지) — {@code ?status=RDS,DDH}가 매칭 0건인 것이 계약이다
	 * (decisions (10)). 어떤 키를 통과시킬지는 HTTP 계층이 소유한다(Node의 {@code pickFilters}가 라우트
	 * 옆에 있는 것과 동형).
	 */
	public List<Map<String, Object>> query(Map<String, List<String>> filters) {
		return ContentsProjection.toPublicAll(this.articles.query(filters));
	}

	/**
	 * 제목·본문·마크업 검색 — 결과는 {@code Article} 행 5키다(목록의 {@code Contents} 행과 동형이 아니라
	 * 본문 {@code markupVersion}이 실린다). 질의가 없으면 빈 문자열 검색이다(거부가 아니다).
	 *
	 * <p>Node는 이 행에도 같은 투영을 통과시키지만 {@code Article} 테이블에는 잠금 컬럼이 없어 제거되는
	 * 키가 없다. Java에서는 두 행이 <b>다른 타입</b>이라 같은 투영 함수를 태울 수 없고, 태울 이유도 없다 —
	 * 대신 그 규율이 실제로 지키려는 것(잠금 비밀이 미투영 경로로 나가지 않는다)을
	 * {@link #assertCarriesNoLockerSecret}로 확인한다. 스키마가 넓어져 도달하는 날, 조용한 200이 아니라
	 * 실패로 드러난다.
	 */
	public List<Map<String, Object>> search(String query) {
		List<Map<String, Object>> rows = this.articles.searchByText(query == null ? "" : query);
		for (Map<String, Object> row : rows) {
			assertCarriesNoLockerSecret(row);
		}
		return rows;
	}

	// --- 이력 읽기 --------------------------------------------------------------------------

	/**
	 * 이력 목록 — 리포지토리 9키에 표시 파생 3키({@code title}·{@code version}·{@code status})를 얹은
	 * <b>12키</b> 행들. 본문(blob)은 싣지 않는다(목록은 경량 계약이고 그 결과는 다른 판정의 입력이기도 하다).
	 *
	 * <p><b>순서가 계약이다</b>: 목록 조회 → (가드) 표시 제목 입력 조회 → (조건부) v1 본문 조회 → 표시 파생
	 * → <b>그 다음에</b> 송고 필터. 파생을 필터 뒤로 옮기면 잘린 편집 스냅샷 행이 버전 승계에 기여하지
	 * 못해 남은 행의 {@code version}이 달라진다.
	 *
	 * <p>표시 제목 입력 조회는 <b>가드 호출</b>이다 — 실패해도 이력보기는 죽지 않고 제목만 빈다(버전·상태는
	 * 정확하다). <b>2차 폴백은 없다</b>: 실패했다고 스냅샷 본문을 다시 긁으면 장애 상황에서 하필 최악
	 * 비용(본문 전량 읽기)이 되살아난다.
	 *
	 * @param sendOnly 송고 이력만 남길지. 판정(빈 값도 참 · {@code '0'}·{@code 'false'}만 거짓 ·
	 *     {@code type=send}) 자체는 HTTP 계층이 소유하고, 여기서는 결과를 강제한다.
	 * @return 이력이 없거나 <b>기사가 존재하지 않아도</b> 빈 배열(예외도 404도 아니다)
	 */
	public List<Map<String, Object>> queryHistory(String articleId, boolean sendOnly) {
		List<Map<String, Object>> rows = this.history.queryByArticle(articleId);
		List<Map<String, Object>> snapshots = titleInputs(articleId);
		Object v1Body = (!rows.isEmpty() && snapshots.isEmpty()) ? currentBody(articleId) : null;

		List<Map<String, Object>> decorated = HistoryMeta.decorateHistoryRows(rows, snapshots, v1Body);
		if (!sendOnly) {
			return decorated;
		}
		List<Map<String, Object>> filtered = new ArrayList<>();
		for (Map<String, Object> row : decorated) {
			if ("status".equals(row.get(EVENT_TYPE)) && "send".equals(row.get(ACTION))) {
				filtered.add(row);
			}
		}
		return filtered;
	}

	/**
	 * 단건 이력 스냅샷 — 기사이력비교가 사용자가 고른 항목만 지연 조회한다(본문 포함 7키).
	 *
	 * <p>{@code articleId} 스코프는 리포지토리가 강제한다(id 하나로 남의 본문을 읽는 경로를 만들지 않는다).
	 * <b>스냅샷이 없는 전이 행도 '없음'이 아니다</b> — 항목은 있고 본문만 {@code null}이다. 이 항목은
	 * 투영 대상이 아니다({@code ArticleHistory}에는 잠금 컬럼이 없고 조회 SQL이 이미 나갈 컬럼만 고른다).
	 */
	public SnapshotResult getHistorySnapshot(String articleId, long historyId) {
		Map<String, Object> item = this.history.querySnapshotById(articleId, historyId);
		return (item == null) ? SnapshotResult.notFound() : new SnapshotResult(true, null, item);
	}

	/** 단건 스냅샷 조회 결과 — 실패는 사유 토큰만 남긴다(HTTP 상태코드는 web 계층이 정한다). */
	public record SnapshotResult(boolean ok, String reason, Map<String, Object> item) {

		static SnapshotResult notFound() {
			return new SnapshotResult(false, "not-found", null);
		}
	}

	// --- 내부 --------------------------------------------------------------------------------

	/**
	 * 표시 제목 파생의 입력(저장 제목 + 레거시 행에 한한 본문). 조회는 <b>한 번</b>이고 실패는 빈 목록이다.
	 * 부분 스텁·조회 실패에도 이력보기가 살아 있어야 한다는 정본 규율과 동형이다.
	 */
	private List<Map<String, Object>> titleInputs(String articleId) {
		try {
			List<Map<String, Object>> found = this.history.querySnapshotTitlesByArticle(articleId);
			return (found == null) ? List.of() : found;
		}
		catch (RuntimeException ex) {
			return List.of();
		}
	}

	/**
	 * v1 본문 예외 — <b>이력이 1건 이상이고 스냅샷이 0건일 때만</b> 현재 본문을 v1 본문으로 넘긴다.
	 * 그 외에는 조회하지 않는다(결과에 쓰이지 않는 blob 읽기를 만들지 않는다). 실패는 {@code null}이며
	 * 그때도 목록은 돌아간다.
	 */
	private Object currentBody(String articleId) {
		try {
			ArticleAggregate current = this.articles.findById(articleId);
			return (current == null || current.article() == null) ? null : current.article().get("markupVersion");
		}
		catch (RuntimeException ex) {
			return null;
		}
	}

	/**
	 * 투영을 거치지 않는 행이 잠금 비밀을 싣고 있지 않은지 확인한다. 제거 목록의 단일 출처는
	 * {@link ContentsProjection#PRIVATE_COLUMNS}이며 <b>여기서 지우지 않는다</b> — 지우면 투영이 두 벌이
	 * 된다. 도달하면 그것은 데이터 shape이 바뀐 것이고, 조용히 계속하는 것보다 실패가 옳다.
	 */
	private static void assertCarriesNoLockerSecret(Map<String, Object> row) {
		for (String hidden : ContentsProjection.PRIVATE_COLUMNS) {
			if (row.containsKey(hidden)) {
				throw new IllegalStateException(
						"투영을 거치지 않은 행에 " + hidden + "이(가) 있다 — 응답 조립 전에 막는다");
			}
		}
	}
}
