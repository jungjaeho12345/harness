package harness.news.service;

import harness.news.model.ArticleAggregate;
import harness.news.model.ArticleHistoryRepository;
import harness.news.model.ArticleRepository;
import harness.news.model.DistributionTargetRepository;
import harness.news.web.NodeNumber;
import java.time.Clock;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Optional;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import org.springframework.transaction.support.TransactionTemplate;

/**
 * 배부 실패 조회·재전송 서비스 — 리포 루트 {@code src/services/distributionRetryService.js}(259행)의 1:1
 * 이식이며 HTTP 비의존이다(ADR-006). 서블릿 타입도 세션도 알지 못하고 <b>행위자는 인자로만</b> 받는다.
 *
 * <h2>ADR-008 MVP-4 — 복구 트리거는 사람뿐이다</h2>
 * 여기에 타이머·자동 재시도·지수 백오프·재시도 큐를 두지 않는다(ADR-008 (6) · excluded (l)):
 * 재전송은 Z가 목록을 보고 <b>명시적으로 한 번</b> 누르는 조작이다. 앱은 스풀 파일을 다시 쓸 뿐 네트워크
 * 전송을 하지 않는다(egress 0 — 발송은 외부 전송기의 몫이다).
 *
 * <h2>책임은 둘뿐이다</h2>
 * <ol>
 *   <li>{@link #list} — 미해소 수신처 실패 목록의 파생 + <b>화이트리스트 투영</b>(경로성 필드 미노출)</li>
 *   <li>{@link #retry} — 그 수신처 <b>한 곳</b>에만 스풀 재기록 + 결과의 append-only 기록</li>
 * </ol>
 * 책임이 아닌 것: 인가·HTTP shape(컨트롤러) · 시점 판정({@link EmbargoPolicy#dueKinds}) · kind 단위
 * 배부({@link DistributionService}) · 상태 전이(생애주기는 {@code ArticleLifecycleService}가 단일 출처이고
 * 이 서비스는 status를 <b>읽기만</b> 한다).
 *
 * <p>재전송은 <b>새 배부 결정이 아니라 이미 내려진 결정의 복구</b>다 — 미해소 실패 행의 존재 자체가
 * "그 시점에 배부가 이미 지시됐다"는 사실 기록이므로 도래 시각을 재판정하지 않는다.
 *
 * <h2>미해소 판정은 복제하지 않는다</h2>
 * 목록과 재전송 게이트가 {@link DistributionFailureLog#unresolvedFailures} <b>하나</b>를 부른다. 두 곳이
 * 갈라지면 <b>목록에 없는 실패로 재전송이 통과한다 — 인가 우회다</b>.
 *
 * <h2>반환이 곧 응답이다</h2>
 * {@link DistributionTickService}와 같은 규율로 <b>투영까지 이 서비스가 소유</b>한다(컨트롤러는 shape
 * 매핑만 한다). 원장 행에는 사유·수신처가 들어 있고 수신처 행에는 {@code spoolDir}(서버 파일시스템 경로)이
 * 들어 있다 — 행을 그대로 펼치면 그 경로가 HTTP로 나간다. 그래서 키는 <b>고정 화이트리스트</b>이고 향후
 * 컬럼이 늘어도 기본값은 "미노출"이다.
 *
 * <h2>빈 배선은 컨트롤러 step이 올린다</h2>
 * {@code DIST_SPOOL_DIR} 미설정이면 {@link SpoolWriter}가 없고 그러면 재전송은 {@code spool-disabled}다.
 * <b>목록은 스풀 설정과 무관하게 항상 결선된다</b>(Node {@code src/controllers/index.js} 동형 ·
 * decisions (3)) — 그래서 이 클래스는 설정을 다시 읽지 않고 writer의 유무만 본다(판정 지점 단일화).
 */
public class DistributionRetryService {

	/** 그 id의 미해소 실패가 없다(행 부재·어휘 밖·이미 해소됨·무효 식별자). */
	public static final String NO_FAILURE = "no-failure";

	/** 실패 행이 마지막 송고 경계보다 앞이다 — 지난 사이클의 결정으로 지금 내보낼 수 없다. */
	public static final String STALE_CYCLE = "stale-cycle";

	/** 같은 수신처의 재전송이 이미 진행 중이다(프로세스 내 single-flight). */
	public static final String RETRY_IN_FLIGHT = "retry-in-flight";

	/** 수신처 행이 없거나 기사 행이 없다 — Node는 두 경우에 같은 토큰을 쓴다. */
	public static final String NOT_FOUND = "not-found";

	/** 수신처가 비활성({@code active != 'Y'})이다 — 배부 대상이 아니다(SCHEMA.md). */
	public static final String INACTIVE = "inactive";

	/** 수신처의 현재 kind가 실패 이력의 kind와 다르다(재분류) — 아무것도 보내지 않는다. */
	public static final String KIND_CHANGED = "kind-changed";

	/**
	 * 표시용 목록 창 — Node {@code distributionRetryService.js} 25~26행 실측값(2026-08-26). 보조 인덱스
	 * 없는 id DESC 스캔 + LIMIT이라 창은 비용 인식의 결과다(SCHEMA.md).
	 */
	private static final int DEFAULT_LIST_LIMIT = 200;

	private static final int MAX_LIST_LIMIT = 1000;

	/**
	 * 재전송 게이트의 미해소 조회 상한 — Node 29행 실측값 {@code 1000000}(articleId 스코프 + 사실상
	 * 무제한)이다.
	 *
	 * <p>CRITICAL: <b>표시용 창을 그대로 쓰지 마라</b>. 오래돼 창 밖으로 밀린 실패가 {@code no-failure}로
	 * 오거부되고, 그 수신처는 앱 안에서 <b>복구 경로가 0</b>이 된다(자동 재시도가 없으므로 사람이 누르는
	 * 이 버튼이 유일한 복구 수단이다). 한 기사로 좁혀져 있어 비용은 작다.
	 *
	 * <p>세 상한(이 스캔 · 표시용 목록 창 · {@code DistributionService}의 중복 억제 스캔)을 <b>하나로
	 * 합치지 마라</b> — 목적이 다르고, 합치는 순간 그중 하나가 조용히 좁아진다(decisions (16)).
	 */
	private static final int RETRY_SCAN_LIMIT = 1_000_000;

	/** 수신처가 활성일 조건 — 정확히 이 값이어야 한다(NULL·소문자는 비활성이다). */
	private static final String ACTIVE_YES = "Y";

	private static final String OK = "ok";

	private static final String REASON = "reason";

	private static final String ITEMS = "items";

	private static final String ARTICLE_ID = "articleId";

	private static final String EVENT_TYPE = "eventType";

	private static final String ACTION = "action";

	private static final String TARGET_ID = "targetId";

	private static final String ACTOR_USER_ID = "actorUserId";

	private static final String KIND = "kind";

	private static final String ACTIVE = "active";

	private static final String NAME = "name";

	private static final String SPOOL_DIR = "spoolDir";

	private static final String STATUS = "status";

	private static final String DISTRIBUTED_AT = "distributedAt";

	private static final String AT = "at";

	private final ArticleHistoryRepository history;

	private final ArticleHistoryRecorder recorder;

	private final DistributionTargetRepository targets;

	private final ArticleRepository articles;

	private final SpoolWriter spoolWriter;

	private final TransactionTemplate transactions;

	private final Clock clock;

	private final RetryFailureListener listener;

	/**
	 * 프로세스 내 single-flight 가드 — 같은 {@code (articleId, targetId)}의 재전송이 겹치면 같은 수신처로
	 * 스풀이 2회 나간다(해소 이력은 쓰기 <b>뒤</b>에 남아 동시 실행의 게이트 조회에는 보이지 않는다).
	 *
	 * <p>{@link DistributionTickService}의 실행 플래그와 동형이되 키를 <b>수신처 단위</b>로 좁힌다 — 다른
	 * 수신처의 재전송까지 직렬화할 이유가 없다. 다중 인스턴스 중복은 ADR-008 (3)의 운영 규율이 막는다
	 * (분산 락 금지 · excluded (m)).
	 */
	private final Set<FlightKey> inFlight = ConcurrentHashMap.newKeySet();

	/**
	 * @param history 원장을 <b>읽는</b> 경로다(기록은 {@code recorder}가 한다)
	 * @param spoolWriter 스풀 루트가 설정되지 않았으면 {@code null} — 그때 재전송은 전면 비활성이고
	 *     목록만 산다
	 * @param transactions 해소 이력 + {@code distributedAt} 갱신을 <b>한 커넥션</b>으로 묶는다
	 * @param listener 재전송 실패 통지 seam. {@code null}이면 통지하지 않는다(Node의 선택적
	 *     {@code onFailure} 동형)
	 */
	public DistributionRetryService(ArticleHistoryRepository history, ArticleHistoryRecorder recorder,
			DistributionTargetRepository targets, ArticleRepository articles, SpoolWriter spoolWriter,
			TransactionTemplate transactions, Clock clock, RetryFailureListener listener) {
		this.history = history;
		this.recorder = recorder;
		this.targets = targets;
		this.articles = articles;
		this.spoolWriter = spoolWriter;
		this.transactions = transactions;
		this.clock = clock;
		this.listener = listener;
	}

	// --- 목록 ---------------------------------------------------------------------------------------

	/**
	 * 미해소 수신처 실패 목록 — Z 전용 조회의 유일한 경로다(인가 게이트는 컨트롤러가 이미 통과시켰다).
	 *
	 * @param limit 표시 창. Node {@code Number.isInteger(limit) && limit >= 1}이 아니면 기본값
	 *     {@value #DEFAULT_LIST_LIMIT}이고, 맞으면 {@value #MAX_LIST_LIMIT}으로 클램프한다. <b>문자열은
	 *     정수가 아니다</b>({@code Number.isInteger('5')}는 거짓) — HTTP 경계의
	 *     {@code Number(req.query.limit)} 변환은 라우트의 몫이고 이 서비스는 그 뒤의 정규화만 소유한다
	 *     (반복 쿼리 키 {@code ?limit=1&limit=2}가 NaN이 되는 Node 의미론이 그 분리에 달려 있다)
	 * @return {@code {ok:true, items:[...]}} — 항목은 <b>정확히 10키</b>이고 {@code historyId} DESC다
	 */
	public Map<String, Object> list(Object limit) {
		List<Map<String, Object>> rows = this.history.queryDistributionEvents(null,
				Integer.valueOf(normalizeListLimit(limit)));
		Listing listing = new Listing();
		List<Map<String, Object>> items = new ArrayList<>();
		for (DistributionFailureLog.Failure failure : DistributionFailureLog.unresolvedFailures(rows)) {
			items.add(listing.project(failure));
		}

		Map<String, Object> response = new LinkedHashMap<>();
		response.put(OK, Boolean.TRUE);
		response.put(ITEMS, List.copyOf(items));
		return Collections.unmodifiableMap(response);
	}

	/**
	 * 한 번의 목록 호출 — 조회 캐시가 <b>호출 사이에 남지 않는</b> 것이 구조로 보장된다.
	 *
	 * <p>호출 사이에 캐시하면 수신처의 {@code active}·{@code kind} 변경이 다음 조회에 보이지 않는다 —
	 * 그 두 값은 "재전송이 지금 가능한가"의 근거로 화면에 나가므로 낡으면 안내가 거짓이 된다.
	 */
	private final class Listing {

		/** 대상 행 부재({@code Optional.empty()})도 캐시해 재조회를 막는다. */
		private final Map<Double, Optional<Map<String, Object>>> targetCache = new HashMap<>();

		/** 기사별 "이번 사이클에 이미 배부된 kind" — status + 이력 조회를 기사당 1회로 접는다. */
		private final Map<String, List<String>> cycleCache = new HashMap<>();

		Map<String, Object> project(DistributionFailureLog.Failure failure) {
			Map<String, Object> target = targetOf(failure.targetId());
			Map<String, Object> item = new LinkedHashMap<>();
			item.put(ARTICLE_ID, failure.articleId());
			item.put(TARGET_ID, nodeNumber(failure.targetId()));
			item.put(KIND, failure.kind());
			item.put(REASON, failure.reason());
			item.put("failedAt", failure.failedAt());
			item.put("historyId", Long.valueOf(failure.historyId()));
			// 대상 행 부재(방어) 폴백: 이름·kind는 null, active는 'N'(재전송 불가 쪽으로).
			item.put("targetName", (target == null) ? null : asText(target.get(NAME)));
			item.put("targetActive", activeOf(target));
			item.put("targetKind", (target == null) ? null : asText(target.get(KIND)));
			item.put("kindDistributed", Boolean.valueOf(cycleKindsOf(failure.articleId())
					.contains(failure.kind())));
			return Collections.unmodifiableMap(item);
		}

		private Map<String, Object> targetOf(double targetId) {
			return this.targetCache
					.computeIfAbsent(Double.valueOf(targetId), DistributionRetryService.this.targets::findById)
					.orElse(null);
		}

		/**
		 * {@code kindDistributed} = "다음 tick이 이 kind를 이미 배부됐다고 보는가" — tick의 실판정 함수
		 * ({@link EmbargoPolicy#cycleDistributedKinds})를 <b>그대로</b> 재사용한다.
		 *
		 * <p>CRITICAL: {@link EmbargoPolicy#distributedKinds}(전체 이력)를 쓰지 마라 — 재송고로 새 사이클이
		 * 열린 기사에서 이번 사이클 전량 실패가 과거 사이클 배부 행에 가려져 {@code true}가 되고, 경고가
		 * 막으려던 중복 배부가 무경고로 지나간다.
		 *
		 * <p>상태는 본문 blob을 읽지 않는 경량 조회로 얻는다(행이 없으면 {@code null} — 그 경우
		 * {@code cycleDistributedKinds}는 전체 이력 판정으로 폴백한다).
		 */
		private List<String> cycleKindsOf(String articleId) {
			return this.cycleCache.computeIfAbsent(articleId, (id) -> {
				ArticleRepository.StatusLookup lookup = DistributionRetryService.this.articles.findStatus(id);
				String status = (lookup == null || !lookup.present()) ? null : lookup.status();
				return EmbargoPolicy.cycleDistributedKinds(status,
						DistributionRetryService.this.history.queryByArticle(id));
			});
		}

	}

	// --- 재전송 -------------------------------------------------------------------------------------

	/**
	 * 실패한 수신처 <b>한 곳</b>에만 기사 파일을 다시 쓴다.
	 *
	 * <p>식별자는 {@code historyId}(목록의 키) <b>하나뿐</b>이고 {@code articleId}·{@code targetId}·
	 * {@code kind}는 전부 그 실패 행에서만 도출한다(ADR-004) — 호출자가 고르게 하면 임의 수신처로 임의
	 * 기사를 내보내는 경로가 열린다. {@code (articleId,targetId)} 쌍을 키로 쓰지 않는 이유도 있다: 같은
	 * 쌍에 kind 2종이 동시에 미해소일 때 오래된 쪽이 영구 복구 불가가 된다(최신 항목만 매칭된다).
	 *
	 * <p><b>게이트 순서가 계약이다</b> — 부작용 없는 판정을 전부 통과한 뒤에야 쓴다:
	 * (a) {@link SpoolWriter} 유무(<b>DB 무접촉</b>) → 식별자 정규화(<b>어떤 이력 조회도 하지 않는다</b> —
	 * 전역 스캔 봉쇄) → (b) 배부 이벤트 단건 + <b>미해소 집합 멤버십</b>(보안 핵심) → (b') 사이클 경계 →
	 * (c) 동시 재전송 → (d) 대상 존재·활성 → (e) kind 일치 → (f) 기사 존재 → (g) status allowlist →
	 * (h) 쓰기. <b>어떤 거부 경로에서도 쓰기가 일어나지 않고, 게이트 거부는 이력을 남기지 않는다</b>
	 * (시도조차 하지 않았으므로 사실 기록이 아니다).
	 *
	 * @param historyId 재전송할 실패 이력 행의 id. 양의 정수로 읽히지 않으면 {@code no-failure}다
	 * @param actorUserId 행위자 userId(<b>검증된 세션에서 도출된 값</b>). 없으면 {@code null}로 기록한다
	 * @return 성공이면 <b>정확히 5키</b> {@code {ok,articleId,targetId,kind,at}}, 그 밖에는 2키
	 *     {@code {ok:false, reason}}. {@code file}·{@code spoolDir}은 어느 쪽에도 담기지 않는다
	 */
	public Map<String, Object> retry(Object historyId, String actorUserId) {
		// (a) 스풀 미설정 — DB를 건드리지 않는다.
		if (this.spoolWriter == null) {
			return denied(SpoolWriter.SPOOL_DISABLED);
		}

		// 무효 식별자는 즉시 거부한다 — 어떤 이력 조회도 하지 않는다(Node Number('')=0·NaN 같은 값이
		// 조회 인자로 흘러들면 스코프 없는 전역 스캔이 된다).
		Long id = normalizeHistoryId(historyId);
		if (id == null) {
			return denied(NO_FAILURE);
		}

		// (b) 미해소 실패 존재 — 행이 없거나 배부 이벤트가 아니면 임의 배부 경로가 된다(이 게이트가 보안 핵심).
		Map<String, Object> eventRow = this.history.getDistributionEventById(id.longValue());
		if (eventRow == null) {
			return denied(NO_FAILURE);
		}
		// articleId는 이후 조회의 스코프다 — 비문자열·빈 값이면 스코프 없는 전 기사 스캔이 되므로 봉쇄한다.
		if (!(eventRow.get(ARTICLE_ID) instanceof String articleId) || articleId.isEmpty()) {
			return denied(NO_FAILURE);
		}

		DistributionFailureLog.Failure failure = unresolvedFailure(articleId, id.longValue());
		if (failure == null) {
			return denied(NO_FAILURE);
		}

		// (b') stale-cycle — 실패 행이 마지막 송고 이력보다 앞(id가 작거나 같음)이면 이전 배부 사이클의
		// 기록이다. 그 결정으로 지금 스풀을 쓰면 보류 → 엠바고 재설정 → 재송고된 기사가 새 엠바고 도래
		// 전에 나간다(회수 불가). 경계 미확정(null)이면 거부하지 않는다 — 기존 복구 경로 보존.
		Long boundaryId = EmbargoPolicy.latestSendId(this.history.queryByArticle(articleId));
		if (boundaryId != null && failure.historyId() <= boundaryId.longValue()) {
			return denied(STALE_CYCLE);
		}

		// (c) 동시 재전송 가드 — 키는 수신처 단위다. add가 실패하면 다른 호출이 이미 쓰는 중이다.
		FlightKey key = new FlightKey(articleId, failure.targetId());
		if (!this.inFlight.add(key)) {
			return denied(RETRY_IN_FLIGHT);
		}
		try {
			return send(articleId, failure, actorUserId);
		}
		finally {
			// CRITICAL: 거부·실패·예외 어느 경로에서도 반드시 해제한다 — 한 번이라도 남으면 그 수신처의
			// 재전송이 영구 봉쇄되고, 자동 재시도가 없으므로 복구 수단이 사라진다.
			this.inFlight.remove(key);
		}
	}

	/**
	 * 미해소 집합의 멤버십 — 그 id가 그룹({@code (articleId,targetId,action)})의 <b>최신 실패</b>여야 한다.
	 *
	 * <p>판정은 {@link DistributionFailureLog#unresolvedFailures} <b>하나</b>만 쓴다(복제 금지 — 목록과
	 * 게이트가 갈라지면 목록에 없는 실패로 재전송이 통과한다). 조회는 {@code articleId} 스코프 +
	 * {@link #RETRY_SCAN_LIMIT}이며 <b>표시용 창과 다르다</b>.
	 */
	private DistributionFailureLog.Failure unresolvedFailure(String articleId, long historyId) {
		List<Map<String, Object>> rows = this.history.queryDistributionEvents(articleId,
				Integer.valueOf(RETRY_SCAN_LIMIT));
		for (DistributionFailureLog.Failure candidate : DistributionFailureLog.unresolvedFailures(rows)) {
			if (candidate.historyId() == historyId) {
				return candidate;
			}
		}
		return null;
	}

	/** 게이트 (d)~(h) — in-flight 키를 쥔 채 실행되는 구간이다. */
	private Map<String, Object> send(String articleId, DistributionFailureLog.Failure failure,
			String actorUserId) {
		// (d) 대상 존재/활성 — 비활성 수신처는 배부 대상이 아니다(SCHEMA.md).
		Optional<Map<String, Object>> found = this.targets.findById(failure.targetId());
		if (found.isEmpty()) {
			return denied(NOT_FOUND);
		}
		Map<String, Object> target = found.get();
		if (!ACTIVE_YES.equals(target.get(ACTIVE))) {
			return denied(INACTIVE);
		}

		// (e) 대상의 현재 kind == 실패 이력의 kind — 엄격 비교(trim·소문자 관용 금지). 실패 이력의 kind는
		// "그때의 분류", 스풀 대상은 "지금의 분류"다. 어긋나면 아무것도 보내지 않는다: press 실패 →
		// nonpress 재분류 → 재전송이면 2차 엠바고 전에 비언론사로 나가고(회수 불가), 이력에는 press가
		// 남아 tick이 같은 수신처에 중복 배부한다.
		if (!Objects.equals(target.get(KIND), failure.kind())) {
			return denied(KIND_CHANGED);
		}

		// (f) 기사 존재 — 페이로드는 항상 현재 DB 행이다(호출자가 준 값이 아니다, ADR-004).
		ArticleAggregate row = this.articles.findById(articleId);
		if (row == null || row.contents() == null) {
			return denied(NOT_FOUND);
		}

		// (g) 배부 가능 status — allowlist는 EmbargoPolicy가 단일 출처다(복제 금지). KILL·보류·삭제 승인
		// 기사는 회수 수단이 없으므로 재전송하지 않는다. 불변 목록의 contains(null)은 NPE다.
		Object status = row.contents().column(STATUS);
		if (!(status instanceof String text) || !EmbargoPolicy.EMBARGO_DISTRIBUTABLE_STATUSES.contains(text)) {
			return denied(DistributionService.STATUS_CHANGED);
		}

		// (h) 스풀 재기록 — writer는 throw하지 않는 계약이지만 방어적으로 감싼다(예외 원문 비노출).
		SpoolWriter.WriteResult result;
		try {
			result = this.spoolWriter.write(asText(target.get(SPOOL_DIR)), articleId, row.article(),
					row.contents());
		}
		catch (RuntimeException ex) {
			result = null;
		}
		if (result == null || !result.ok()) {
			return failed(articleId, failure, actorUserId, result);
		}
		return resolved(articleId, failure, actorUserId);
	}

	/**
	 * 재전송 실패 — 새 {@code distribute-failed} 행으로 append한다(그룹 최신이 다시 실패가 되어 목록에
	 * 남는다). 기록 조건은 {@link DistributionService}와 같은 <b>단일 술어</b>다(재전송 가능 사유만 —
	 * 그 밖을 영속하면 영원히 해소되지 않는 항목이 쌓인다).
	 */
	private Map<String, Object> failed(String articleId, DistributionFailureLog.Failure failure,
			String actorUserId, SpoolWriter.WriteResult result) {
		String reason = (result == null || result.reason() == null)
				? SpoolWriter.SPOOL_WRITE_FAILED : result.reason();
		if (DistributionFailureLog.isRetryableFailureReason(reason)) {
			Map<String, Object> entry = entry(articleId, DistributionFailureLog.DISTRIBUTE_FAILED_EVENT,
					failure, actorUserId);
			// 사유는 writer의 고정 토큰 그대로다 — 예외 메시지·경로를 넣지 않는다.
			entry.put(REASON, reason);
			this.recorder.record(entry);
		}
		notifyFailure(new RetryFailure(articleId, failure.targetId(), failure.kind(), reason));
		return denied(reason);
	}

	/**
	 * 재전송 성공 — 해소를 <b>새 행</b>으로 기록하고(원장 append-only) 배부 시각을 <b>present-only</b>로
	 * 갱신한다(SCHEMA.md: {@code distributedAt}은 스풀 파일이 실제로 나간 최신 시각이다).
	 *
	 * <p>두 문장을 한 트랜잭션에 두는 것은 <b>그 사이에 커넥션이 반납되지 않게</b> 하기 위함이다
	 * (decisions (19)). <b>이력 insert 실패가 이 갱신을 롤백하게 만들지 마라</b>: 기록은 부가라
	 * {@link ArticleHistoryRecorder}가 삼키고 통지로만 남긴다(Node 실측 동형). 이유는 하나다 —
	 * <b>스풀 파일은 이미 나갔다</b>. 되돌릴 수 없는 일을 되돌린 척하면 재전송 성공이 500이 되고, 그 축은
	 * 계약이 관측하지 못해 divergence가 영구히 남는다.
	 */
	private Map<String, Object> resolved(String articleId, DistributionFailureLog.Failure failure,
			String actorUserId) {
		String at = Iso8601.now(this.clock);
		this.transactions.executeWithoutResult((tx) -> {
			this.recorder.record(entry(articleId, DistributionFailureLog.DISTRIBUTE_RETRY_EVENT, failure,
					actorUserId));
			// present-only — distributedAt 한 컬럼만 담는다(본문·잠금·sentAt·status는 건드리지 않는다).
			Map<String, Object> patch = new LinkedHashMap<>();
			patch.put(DISTRIBUTED_AT, at);
			this.articles.update(articleId, null, patch);
		});

		// 반환에 file·spoolDir을 싣지 않는다 — 서버 파일시스템 경로는 HTTP로 나가면 안 된다.
		Map<String, Object> response = new LinkedHashMap<>();
		response.put(OK, Boolean.TRUE);
		response.put(ARTICLE_ID, articleId);
		response.put(TARGET_ID, nodeNumber(failure.targetId()));
		response.put(KIND, failure.kind());
		response.put(AT, at);
		return Collections.unmodifiableMap(response);
	}

	/** 이력 1행의 공통 내용 — 시각 stamp는 기록 헬퍼가 더한다. */
	private static Map<String, Object> entry(String articleId, String eventType,
			DistributionFailureLog.Failure failure, String actorUserId) {
		Map<String, Object> entry = new LinkedHashMap<>();
		entry.put(ARTICLE_ID, articleId);
		entry.put(EVENT_TYPE, eventType);
		entry.put(ACTION, failure.kind());
		// Node가 JS number를 바인딩하는 것과 같은 표현(REAL)이다 — INTEGER affinity가 정수로 접는다.
		entry.put(TARGET_ID, Double.valueOf(failure.targetId()));
		entry.put(ACTOR_USER_ID, actorUserId);
		return entry;
	}

	/** 통지 실패가 재전송을 막지 않게 격리한다 — 이미 나간 파일을 되돌릴 수 없다. */
	private void notifyFailure(RetryFailure failure) {
		if (this.listener == null) {
			return;
		}
		try {
			this.listener.onRetryFailure(failure);
		}
		catch (RuntimeException ignored) {
			// 알림 실패는 재전송을 막지 않는다.
		}
	}

	// --- 정규화·투영 헬퍼 ---------------------------------------------------------------------------

	/**
	 * Node {@code normalizeListLimit} — {@code Number.isInteger(limit) && limit >= 1}이 아니면 기본값,
	 * 맞으면 {@code Math.min(limit, MAX_LIST_LIMIT)}.
	 *
	 * <p>수가 <b>아닌</b> 값(문자열·불리언·{@code null})은 전부 기본값이다: {@code Number.isInteger}는
	 * 타입을 관용하지 않는다. HTTP 문자열을 수로 읽는 것은 라우트의 {@code Number(req.query.limit)}이고
	 * 그 판독의 단일 출처는 {@link NodeNumber#toNumber}다(decisions (18)).
	 */
	private static int normalizeListLimit(Object limit) {
		if (!(limit instanceof Number number)) {
			return DEFAULT_LIST_LIMIT;
		}
		double value = number.doubleValue();
		if (!Double.isFinite(value) || value != Math.rint(value) || value < 1.0d) {
			return DEFAULT_LIST_LIMIT;
		}
		return (int) Math.min(value, MAX_LIST_LIMIT);
	}

	/**
	 * Node {@code normalizeHistoryId} — 재전송 식별자를 양의 정수로 읽는다. 무효면 {@code null}이고
	 * 호출자는 <b>어떤 이력 조회도 하지 않고</b> 거부한다(전역 스캔 봉쇄).
	 *
	 * <p>{@code typeof}가 number·string이 아니면 즉시 {@code null}이다(불리언·객체·배열이 1이나 0으로
	 * 접혀 <b>실재하지 않는 행</b>을 가리키지 않게). 문자열 판독은 {@link NodeNumber#toNumber} 단일
	 * 출처이며, 빈 문자열 검사는 Node의 {@code value === ''}와 같은 자리(trim 이전)다.
	 *
	 * <p>{@code long} 범위 밖은 {@code null}로 접는다 — Node도 그 값으로 조회해 <b>행을 찾지 못하므로</b>
	 * 관측 결과가 같다({@link NodeNumber#integerOf}와 같은 근거).
	 */
	private static Long normalizeHistoryId(Object value) {
		double numeric;
		if (value instanceof Number number) {
			numeric = number.doubleValue();
		}
		else if (value instanceof CharSequence text) {
			String raw = text.toString();
			if (raw.isEmpty()) {
				return null;
			}
			numeric = NodeNumber.toNumber(raw);
		}
		else {
			return null;
		}
		if (!Double.isFinite(numeric) || numeric != Math.rint(numeric) || numeric < 1.0d) {
			return null;
		}
		if (numeric > Long.MAX_VALUE) {
			return null;
		}
		return Long.valueOf((long) numeric);
	}

	/**
	 * 수신처 id를 <b>JSON에 실을 표현</b>으로 바꾼다 — 정수는 소수점 없이 나가야 한다.
	 *
	 * <p>{@link DistributionFailureLog.Failure#targetId()}는 Node의 number와 같은 {@code double}이라
	 * 그대로 실으면 {@code 3.0}이 되는데 Node의 {@code JSON.stringify(3)}은 {@code 3}이다(step2 인계 사항).
	 */
	private static Object nodeNumber(double value) {
		if (value == Math.rint(value) && Math.abs(value) <= Long.MAX_VALUE) {
			return Long.valueOf((long) value);
		}
		return Double.valueOf(value);
	}

	/** 대상 행 부재·{@code active} NULL은 전부 {@code 'N'}이다(재전송 불가 쪽으로). */
	private static String activeOf(Map<String, Object> target) {
		if (target == null) {
			return "N";
		}
		String active = asText(target.get(ACTIVE));
		return (active == null) ? "N" : active;
	}

	private static String asText(Object value) {
		return (value == null) ? null : String.valueOf(value);
	}

	/** 거부 응답 — <b>정확히 2키</b>다(식별자도 경로도 담지 않는다). */
	private static Map<String, Object> denied(String reason) {
		Map<String, Object> response = new LinkedHashMap<>();
		response.put(OK, Boolean.FALSE);
		response.put(REASON, reason);
		return Collections.unmodifiableMap(response);
	}

	/**
	 * single-flight 키 — 문자열을 이어 붙이지 않으므로 구분자 충돌이 원천적으로 없다
	 * ({@link DistributionFailureLog}의 그룹 키와 같은 규율).
	 */
	private record FlightKey(String articleId, double targetId) {
	}

	/**
	 * 재전송 실패 통지 payload — <b>식별자 3개와 고정 사유 하나뿐</b>이다(정확히 4키).
	 *
	 * <p>경로({@code spoolDir}·파일명)·본문·세션 토큰을 담지 않는다: 기본 통지 대상은 로그 버퍼이고 그
	 * 버퍼는 {@code GET /api/logs/digest}로 <b>밖으로 나간다</b>(LOGS.md 마스킹 규율 · ADR-007).
	 *
	 * <p>{@link DistributionService.DistributionFailure}와 모양은 같지만 <b>다른 사건</b>이다(Node도 두
	 * 콜백을 따로 받아 다른 로그 문구를 남긴다) — 배부 시도의 미발송과 사람이 누른 복구의 실패를 같은
	 * 어휘로 섞으면 운영자가 오독한다.
	 */
	public record RetryFailure(String articleId, double targetId, String kind, String reason) {
	}

	/**
	 * 재전송 실패 통지 seam — Node의 {@code onFailure} 콜백과 같은 자리다.
	 *
	 * <p><b>이력 쓰기 실패</b>는 다른 사건이므로 다른 어휘로 통지한다
	 * ({@link ArticleHistoryRecorder.HistoryErrorListener} — 섞으면 배부 실패로 오독된다. 스풀은 나갔다).
	 */
	@FunctionalInterface
	public interface RetryFailureListener {

		void onRetryFailure(RetryFailure failure);

	}

}
