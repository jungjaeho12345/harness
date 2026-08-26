package harness.news.service;

import harness.news.model.ArticleAggregate;
import harness.news.model.ArticleHistoryRepository;
import harness.news.model.ArticleRepository;
import harness.news.model.ContentsRow;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import org.springframework.transaction.support.TransactionTemplate;

/**
 * 배부 사실을 기사 상태에 반영하는 서비스 — 리포 루트 {@code src/services/articleService.js} 277~300행
 * ({@code syncEmbargoStatus})의 1:1 이식이다. 호출자는 <b>송고 훅</b>과 <b>엠바고 tick</b> 둘이며, HTTP
 * 비의존이다(ADR-006): 서블릿 타입도 세션도 알지 못하고 행위자는 인자로만 받는다.
 *
 * <h2>전이표를 거치지 않는다</h2>
 * {@link Lifecycle#transition} 은 <b>role × action</b> 표인데 여기엔 role도 action도 없다 — 사람의
 * 액션이 아니라 <b>"이미 일어난 배부"의 반영</b>이다. 표를 태우면 도달 불가 분기가 생기고 허용 범위가 두
 * 곳으로 갈린다. 대신 허용 범위는 {@link EmbargoPolicy#embargoStatusFor}가 {@code DES}·{@code EPS}에서만
 * 계산하도록 <b>한 곳에서</b> 좁힌다({@code DPS}·{@code EEK}·{@code EEH}·{@code DPD}·{@code RDS}는 절대
 * 건드리지 않는다 — 완결·킬·보류·삭제 승인 기사의 부활은 회수 불가능한 사고다).
 *
 * <h2>승격 판정은 "이번 사이클"이다</h2>
 * 입력은 {@link EmbargoPolicy#cycleDistributedKinds}(이번 사이클)이며 <b>전체 이력
 * ({@code distributedKinds})이 아니다</b>. 전체 이력으로 판정하면 보류 → 엠바고 재설정 → 재송고로
 * {@code DES}에 재진입한 기사가 <b>거짓 완결</b>({@code DPS})되고, {@code DPS}는 상태 계산의 대상 밖이라
 * 다시는 개입하지 못한다 → 도래 시각이 와도 <b>영원히 배부되지 않는다</b>(무음 미배부 + 거짓 완결).
 * 송고 훅이 쓰는 {@code distributedKinds}("역사상 어디로 나갔나" — 정정본 대상 판정)와는 <b>질문이
 * 다르다. 두 함수는 서로를 대체하지 않는다</b>(decisions (9)).
 *
 * <h2>이력과 힌트의 합집합</h2>
 * {@code extraKinds}는 방금 성공한 배부의 kind 힌트다. {@code DistributionService}의 이력 기록은 실패를
 * 삼키므로 <b>이력만 읽으면 승격이 누락</b>되고, 반대로 <b>힌트만 보면 tick의 self-heal이 무력</b>해진다 —
 * 그래서 합집합이다. 힌트의 미지 값·{@code null} 원소는 조용히 무시된다(판정은 kind 2종만 본다).
 *
 * <h2>쓰기 규율</h2>
 * <ul>
 *   <li><b>present-only</b> — {@code status} <b>한 컬럼</b>만 쓴다. {@code sentAt}·{@code sender}·본문·
 *       잠금은 물론 {@code distributedAt}도 함께 쓰지 않는다(배부 시각 갱신은 {@code DistributionService}의
 *       단일 책임이다).</li>
 *   <li><b>바꿀 필요가 없으면 쓰기도 이력도 0건</b>이다({@code embargoStatusFor}가 {@code null}을 준다).</li>
 *   <li>상태 쓰기와 그 이력은 <b>한 트랜잭션</b>이다(decisions (19)) — 두 문장 사이에 커넥션이 반납되지
 *       않게 하기 위함이다. <b>이력 insert 실패가 상태를 되돌리지는 않는다</b>: 기록은 부가라
 *       {@link ArticleHistoryRecorder}가 삼키고 통지로만 남긴다(Node 실측 동형 — open_questions (d)).</li>
 *   <li>이력의 어휘는 {@code eventType='status'} · {@code action='embargo'}다. {@code send}로 기록하면 그
 *       행이 새 <b>사이클 경계</b>({@link EmbargoPolicy#latestSendId})가 되어 이후 배부 판정 전체가
 *       오염된다.</li>
 * </ul>
 *
 * <h2>인가를 모른다</h2>
 * role도 세션도 읽지 않는다 — 게이트는 호출자(컨트롤러)가 이미 통과시켰고, 이 서비스는 tick(시스템 실행)
 * 에서도 불린다. 빈 배선은 소비자 step(송고 훅·tick)이 함께 올린다.
 */
public class ArticleEmbargoService {

	/** 기사(또는 공통정보 행)가 없다. */
	public static final String NOT_FOUND = "not-found";

	/** 이 반영이 남기는 이력의 {@code eventType}. */
	private static final String STATUS_EVENT = "status";

	/**
	 * 이 반영이 남기는 이력의 {@code action} — <b>사람의 액션이 아니다</b>. {@code send}가 되면 그 행이
	 * 사이클 경계가 되어 다음 tick이 이번 사이클의 배부를 보지 못한다.
	 */
	private static final String EMBARGO_ACTION = "embargo";

	private static final String STATUS = "status";

	private static final String ARTICLE_ID = "articleId";

	private static final Result NOT_FOUND_RESULT = new Result(false, null, NOT_FOUND);

	private final ArticleRepository articles;

	private final ArticleHistoryRepository history;

	private final ArticleHistoryRecorder recorder;

	private final TransactionTemplate transactions;

	public ArticleEmbargoService(ArticleRepository articles, ArticleHistoryRepository history,
			ArticleHistoryRecorder recorder, TransactionTemplate transactions) {
		this.articles = articles;
		this.history = history;
		this.recorder = recorder;
		this.transactions = transactions;
	}

	/**
	 * 배부 이력(+ 방금 성공한 배부의 힌트)에 비춰 기사 상태를 {@code DES} → {@code EPS} → {@code DPS}로
	 * 반영한다. 바꿀 것이 없으면 <b>현재 상태를 그대로</b> 돌려주며 아무것도 쓰지 않는다.
	 *
	 * @param articleId 대상 기사
	 * @param extraKinds 방금 성공한 배부의 kind 힌트. {@code null}이면 이력만으로 판정한다
	 * @param actorUserId 행위자 userId. tick 실행처럼 사람이 없으면 {@code null}로 기록한다
	 */
	public Result syncEmbargoStatus(String articleId, List<String> extraKinds, String actorUserId) {
		ArticleAggregate found = this.articles.findById(articleId);
		if (found == null || found.contents() == null) {
			return NOT_FOUND_RESULT;
		}

		ContentsRow contents = found.contents();
		String fromStatus = asText(contents.column(STATUS));
		List<Map<String, Object>> historyRows = this.history.queryByArticle(articleId);
		Set<String> distributed = union(EmbargoPolicy.cycleDistributedKinds(fromStatus, historyRows), extraKinds);

		String next = EmbargoPolicy.embargoStatusFor(fromStatus, contents::column, distributed);
		if (next == null) {
			return new Result(true, fromStatus, null); // 바꿀 필요 없음 — 쓰기 0건·이력 0행.
		}

		// 두 문장은 함께 성립해야 한다(상태만 바뀌고 근거가 없는 원장은 감사도 판정도 무너뜨린다).
		// 이력 insert의 실패는 기록 헬퍼가 삼키므로 이 경계가 승격을 되돌리지는 않는다 — Node 동형이다.
		this.transactions.executeWithoutResult((tx) -> {
			// present-only — status 한 컬럼만 담는다. distributedAt은 배부 실행의 단일 책임이다.
			Map<String, Object> patch = new LinkedHashMap<>();
			patch.put(STATUS, next);
			this.articles.update(articleId, null, patch);
			this.recorder.record(entry(articleId, fromStatus, next, actorUserId));
		});
		return new Result(true, next, null);
	}

	/** 이력 1행의 내용 — 시각 stamp는 기록 헬퍼가 더한다(본문 스냅샷이 아니라 제목 컬럼은 없다). */
	private static Map<String, Object> entry(String articleId, String fromStatus, String toStatus,
			String actorUserId) {
		Map<String, Object> entry = new LinkedHashMap<>();
		entry.put(ARTICLE_ID, articleId);
		entry.put("eventType", STATUS_EVENT);
		entry.put("action", EMBARGO_ACTION);
		entry.put("fromStatus", fromStatus);
		entry.put("toStatus", toStatus);
		entry.put("actorUserId", actorUserId);
		return entry;
	}

	/**
	 * 이력에서 센 kind와 호출자 힌트의 합집합(JS {@code new Set([...a, ...b])} 동형). 힌트가 {@code null}
	 * 이면 이력뿐이고, {@code null} 원소가 섞여 있어도 던지지 않는다 — 판정은 kind 2종만 보므로 미지 값은
	 * 조용히 무시된다.
	 */
	private static Set<String> union(List<String> fromHistory, List<String> extraKinds) {
		Set<String> kinds = new LinkedHashSet<>(fromHistory);
		if (extraKinds != null) {
			kinds.addAll(extraKinds);
		}
		return Collections.unmodifiableSet(kinds);
	}

	private static String asText(Object value) {
		return (value == null) ? null : String.valueOf(value);
	}

	/**
	 * 반영 결과 — 성공이면 <b>반영 후 상태</b>(바뀌지 않았으면 현재 상태), 실패면 사유 토큰뿐이다.
	 * 상태 문자열 외에 어떤 행 값도 담지 않는다.
	 */
	public record Result(boolean ok, String status, String reason) {
	}

}
