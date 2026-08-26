package harness.news.service;

import harness.news.model.ArticleAggregate;
import harness.news.model.ArticleHistoryRepository;
import harness.news.model.ArticleRepository;
import harness.news.model.DistributionTargetRepository;
import java.time.Clock;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;

/**
 * 배부 실행 서비스 — 리포 루트 {@code src/services/distributionService.js}(244행)의 1:1 이식이며 HTTP
 * 비의존이다(ADR-006). 서블릿 타입도 세션도 알지 못하고 <b>행위자와 의도는 인자로만</b> 받는다(ADR-004).
 *
 * <h2>책임은 셋뿐이다</h2>
 * <ol>
 *   <li>주어진 kind의 <b>활성</b> 수신처 선정({@code active='Y'}).</li>
 *   <li>수신처별 스풀 쓰기 — 파일 shape·allowlist·원자 게시는 {@link SpoolWriter}가 단일 출처다.</li>
 *   <li><b>사실 기록</b> — {@code Contents.distributedAt} 갱신 + {@code distribute} 이력(append-only) +
 *       수신처 단위 실패의 영속({@code distribute-failed} — 재전송의 유일한 근거).</li>
 * </ol>
 *
 * <h2>책임이 아닌 것</h2>
 * <ul>
 *   <li><b>시점 판정</b>("지금이 엠바고 시각인가")과 주기 실행 — tick pull의 몫이다(ADR-008 (3)).
 *       여기엔 타이머도, 자동 재시도·백오프·큐도, 병렬 실행도 없다(ADR-008 (6)). 수신처는 <b>순차</b>
 *       처리한다: 같은 SQLite 파일에 쓰므로 순서가 예측 가능해야 하고 테스트도 결정적이어야 한다.</li>
 *   <li><b>어떤 kind로 배부할지</b>의 판정 — 호출자(송고 훅·tick)가 정해서 {@code kinds}로 넘긴다.</li>
 *   <li><b>상태 전이</b>(EPS→DPS 승격) — 생애주기는 {@code ArticleLifecycleService}/엠바고 상태 서비스가
 *       단일 출처다. 이 서비스는 status를 <b>읽기만</b> 한다(아래 TOCTOU 가드는 전이가 아니라 안전 중단이다).</li>
 * </ul>
 *
 * <h2>TOCTOU 가드 — 쓰기 직전 재조회</h2>
 * 한 번 나간 기사는 회수 수단이 없다. 그래서 <b>매 쓰기 직전</b> 최신 status를 다시 읽어 배부 가능 목록
 * ({@link EmbargoPolicy#EMBARGO_DISTRIBUTABLE_STATUSES} — 복제 금지)을 벗어났으면 그 자리에서 멈추고
 * <b>남은 수신처·남은 kind 전부를 중단</b>한다. 수신처 수만큼 조회가 늘어나는 비용(N+1)은
 * <b>의도적으로 수용</b>한다 — KILL 기사 유출을 막는 가치가 압도한다.
 *
 * <p>재조회는 <b>status 판정 전용</b>이다: 페이로드는 최초 스냅샷을 계속 쓴다(한 배부 배치는 같은 본문을
 * 내보내야 정정 추적이 가능하다). 조회는 본문 blob을 읽지 않는 {@link ArticleRepository#findStatus}로 한다 —
 * Node의 {@code getById} 재조회와 판정이 동치이고(행 없음 → 배부 불가 · status가 목록 밖 → 배부 불가)
 * 배부 배치마다 본문을 N번 다시 읽지 않는다.
 *
 * <h2>트랜잭션 경계</h2>
 * <b>한 배부 호출 전체를 하나의 트랜잭션으로 묶지 않는다</b>(decisions (19)): 수신처 A 성공 후 B 실패에서
 * A의 이력까지 롤백되면 "나간 파일은 있는데 기록은 없는" 상태가 되어 다음 tick이 <b>중복 배부</b>한다
 * (회수 불가). 이 서비스가 쓰는 문장은 전부 그 자체로 독립적인 사실이므로 여기엔
 * {@code TransactionTemplate}이 필요한 자리가 없다.
 *
 * <h2>빈 배선은 소비자(tick·재전송) step이 함께 올린다</h2>
 * {@code DIST_SPOOL_DIR} 미설정이면 <b>스풀 writer가 없고, 그러면 이 서비스도 없다</b>(Node
 * {@code src/controllers/index.js} 71~130행 동형 · decisions (3)). 활성 판정의 단일 출처는
 * {@code SpoolProperties.rootPath()}이며, 그 판정을 컨텍스트 배선으로 옮기는 것이 tick/retry의 503 조건과
 * 같은 지점에서 갈라지지 않게 하는 유일한 방법이다. 그래서 이 클래스에는 {@code @Service}가 없다 —
 * 소비자가 없는 상태에서 빈만 올리면 "비활성일 때 빈이 있어야 하나"라는 결정을 검증 없이 굳히게 된다
 * ({@code CollectionService}가 같은 이유로 뒤 step에서 {@code @Service}를 얻었다).
 */
public class DistributionService {

	/** 기사(또는 공통정보 행)가 없다. */
	public static final String NOT_FOUND = "not-found";

	/**
	 * 배부 중 status가 배부 가능 목록 밖으로 전이돼 중단된 항목의 사유 토큰. tick의 재검증 스킵과 <b>같은
	 * 어휘</b>다(운영 요약 통일). 새 상태값(EEK/EEH/DPD…)은 담지 않는다 — 요약은 식별자·고정 사유만 담는
	 * 화이트리스트다.
	 */
	public static final String STATUS_CHANGED = "status-changed";

	/** 이 사실 기록의 {@code eventType} — tick의 "이미 배부됨" 멱등 판정 근거다. */
	public static final String DISTRIBUTE_EVENT = "distribute";

	/** 배부 대상 종류. <b>반환·처리 순서가 이 상수 순서</b>다(호출자가 준 순서가 아니다). */
	private static final List<String> KINDS = List.of("press", "nonpress");

	/**
	 * 중복 억제 판정의 이력 조회 한도 — Node {@code distributionService.js} 30행
	 * {@code FAILURE_DEDUP_SCAN_LIMIT} 실측값(2026-08-25). <b>표시용 목록 창이 아니다</b>: 창 밖으로 밀린
	 * 최신 실패를 놓치면 억제가 무의미해져 같은 실패가 tick마다 새 행으로 무한 누적된다. 조회가
	 * {@code articleId} 스코프로 좁혀져 있어 비용은 작다.
	 *
	 * <p>세 상한(표시용 목록 창 · 재전송 게이트 스캔 · 이 억제 스캔)을 <b>하나로 합치지 마라</b> —
	 * 목적이 다르고, 합치는 순간 그중 하나가 조용히 좁아진다(decisions (16)).
	 */
	private static final int FAILURE_DEDUP_SCAN_LIMIT = 1_000_000;

	private static final String ARTICLE_ID = "articleId";

	private static final String EVENT_TYPE = "eventType";

	private static final String ACTION = "action";

	private static final String TARGET_ID = "targetId";

	private static final String REASON = "reason";

	private static final String ACTOR_USER_ID = "actorUserId";

	private static final String KIND = "kind";

	private static final String ACTIVE = "active";

	private static final String ACTIVE_YES = "Y";

	private static final String SPOOL_DIR = "spoolDir";

	private static final String ID = "id";

	private static final String DISTRIBUTED_AT = "distributedAt";

	private final DistributionTargetRepository targets;

	private final ArticleRepository articles;

	private final ArticleHistoryRepository history;

	private final ArticleHistoryRecorder recorder;

	private final SpoolWriter spoolWriter;

	private final Clock clock;

	private final DistributionFailureListener listener;

	/**
	 * @param history 억제 판정 입력을 <b>읽는</b> 경로다(기록은 {@code recorder}가 한다)
	 * @param spoolWriter 스풀 루트가 설정되지 않았으면 {@code null} — 그때 배부는 전면 비활성이다
	 * @param listener 수신처 미발송 통지 seam. {@code null}이면 통지하지 않는다(Node의 선택적
	 *     {@code onFailure} 동형)
	 */
	public DistributionService(DistributionTargetRepository targets, ArticleRepository articles,
			ArticleHistoryRepository history, ArticleHistoryRecorder recorder, SpoolWriter spoolWriter,
			Clock clock, DistributionFailureListener listener) {
		this.targets = targets;
		this.articles = articles;
		this.history = history;
		this.recorder = recorder;
		this.spoolWriter = spoolWriter;
		this.clock = clock;
		this.listener = listener;
	}

	/**
	 * 지금 이 kind들로 배부한다 — <b>언제</b> 부를지는 호출자가 정한다(송고 훅 / tick).
	 *
	 * @param articleId 대상 기사
	 * @param kinds 배부할 kind 목록. 허용 밖 값·{@code null}은 조용히 걸러낸다(호출자 실수가 임의 폴더
	 *     배부로 이어지지 않게). 걸러낸 결과가 비면 <b>기사 조회조차 하지 않는다</b>
	 * @param actorUserId 행위자 userId(검증된 세션에서 도출된 값). 없으면 {@code null}로 기록한다
	 * @return 거부면 {@code ok=false}와 사유 토큰, 그 밖에는 {@code ok=true}와 두 목록. <b>throw하지
	 *     않는다</b> — 한 수신처의 실패가 다른 수신처나 송고를 막아서는 안 된다
	 */
	public Result distribute(String articleId, List<String> kinds, String actorUserId) {
		if (this.spoolWriter == null) {
			return Result.deny(SpoolWriter.SPOOL_DISABLED);
		}

		List<String> wanted = wantedKinds(kinds);
		if (wanted.isEmpty()) {
			return Result.of(List.of(), List.of());
		}

		ArticleAggregate snapshot = this.articles.findById(articleId);
		if (snapshot == null || snapshot.contents() == null) {
			return Result.deny(NOT_FOUND);
		}

		return new Call(articleId, actorUserId, snapshot).run(wanted);
	}

	/** 허용 목록과의 교집합 — 순서는 {@link #KINDS} 상수 순서이고 중복은 접힌다. */
	private static List<String> wantedKinds(List<String> kinds) {
		if (kinds == null) {
			return List.of();
		}
		List<String> wanted = new ArrayList<>();
		for (String kind : KINDS) {
			if (kinds.contains(kind)) {
				wanted.add(kind);
			}
		}
		return wanted;
	}

	/**
	 * 한 번의 배부 호출 — Node의 {@code distribute} 클로저와 같은 수명이다. 억제 컨텍스트가 <b>호출
	 * 사이에 남지 않는</b> 것이 구조로 보장된다(원장은 호출마다 자란다 — 낡은 컨텍스트는 신선한 실패를
	 * 무음으로 삼킨다).
	 */
	private final class Call {

		private final String articleId;

		private final String actorUserId;

		private final ArticleAggregate snapshot;

		private final List<Distributed> distributed = new ArrayList<>();

		private final List<Failed> failed = new ArrayList<>();

		/** 가드에 걸렸다 — 남은 수신처도 남은 kind도 시작하지 않는다. */
		private boolean aborted;

		/** 억제 판정 컨텍스트. lazy — 실패가 하나도 없으면 조회 자체가 없다. */
		private FailureContext failureContext;

		Call(String articleId, String actorUserId, ArticleAggregate snapshot) {
			this.articleId = articleId;
			this.actorUserId = actorUserId;
			this.snapshot = snapshot;
		}

		Result run(List<String> wanted) {
			for (String kind : wanted) {
				// 앞선 kind에서 가드가 걸렸다. 그래도 failed에 남긴다: tick은 distributed∪failed에 등장한
				// kind만 "처리됨"으로 보므로, 빠뜨리면 활성 수신처가 있는데도 no-active-target으로 오보한다.
				if (this.aborted) {
					reportFailure(new Failed(this.articleId, null, kind, null, STATUS_CHANGED));
					continue;
				}
				distributeKind(kind);
			}

			// 배부 지시가 1건이라도 성공하면 배부 시각을 갱신한다(ADR-008: 스풀 기록 시각 = distributedAt).
			// present-only 갱신이라 status·sentAt·본문·잠금은 건드리지 않는다(DB 비파괴).
			if (!this.distributed.isEmpty()) {
				Map<String, Object> patch = new LinkedHashMap<>();
				patch.put(DISTRIBUTED_AT, Iso8601.now(DistributionService.this.clock));
				DistributionService.this.articles.update(this.articleId, null, patch);
			}
			return Result.of(this.distributed, this.failed);
		}

		private void distributeKind(String kind) {
			// 비활성('N') 대상은 배부하지 않는다(SCHEMA.md — active='N'이면 배부 대상에서 제외).
			Map<String, Object> filters = new LinkedHashMap<>();
			filters.put(KIND, kind);
			filters.put(ACTIVE, ACTIVE_YES);
			List<Map<String, Object>> found = DistributionService.this.targets.query(filters);
			int okInKind = 0;

			for (int i = 0; i < found.size(); i++) {
				Map<String, Object> target = found.get(i);
				if (!isDistributable()) {
					this.aborted = true;
					abortRemaining(kind, found, i);
					break;
				}
				if (write(kind, target)) {
					okInKind++;
				}
			}

			// 실제로 스풀에 기록된 게 있을 때만 이력을 남긴다 — 거짓 기록 금지.
			// 이 행이 없으면 다음 tick이 같은 기사를 다시 쓴다(중복 배부, 회수 불가). 반대로 나간 게
			// 없는데 남기면 tick이 재시도하지 않아 무음 미배부가 된다.
			if (okInKind > 0) {
				Map<String, Object> entry = new LinkedHashMap<>();
				entry.put(ARTICLE_ID, this.articleId);
				entry.put(EVENT_TYPE, DISTRIBUTE_EVENT);
				entry.put(ACTION, kind);
				entry.put(ACTOR_USER_ID, this.actorUserId);
				DistributionService.this.recorder.record(entry);
			}
		}

		/** 가드에 걸린 자리에서 아직 처리하지 못한 수신처를 기존 {@link Failed}와 같은 shape로 남긴다. */
		private void abortRemaining(String kind, List<Map<String, Object>> found, int from) {
			if (from == 0) {
				// 이 kind는 쓰기를 하나도 시작하지 않았다 — kind 단위 항목(targetId 없음)이다.
				reportFailure(new Failed(this.articleId, null, kind, null, STATUS_CHANGED));
				return;
			}
			for (Map<String, Object> rest : found.subList(from, found.size())) {
				reportFailure(new Failed(this.articleId, targetIdOf(rest), kind, spoolDirOf(rest), STATUS_CHANGED));
			}
		}

		/** 수신처 1곳에 쓴다. 성공이면 {@code true}. */
		private boolean write(String kind, Map<String, Object> target) {
			SpoolWriter.WriteResult result;
			try {
				// 페이로드는 최초 스냅샷이다 — 가드의 재조회 결과를 쓰지 않는다.
				result = DistributionService.this.spoolWriter.write(spoolDirOf(target), this.articleId,
						this.snapshot.article(), this.snapshot.contents());
			}
			catch (RuntimeException ex) {
				// writer는 throw하지 않는 계약이지만 방어적으로 감싼다 — 한 수신처의 예외가 다른 수신처를
				// 막지 않는다. 사유에 예외 메시지를 담지 않는다(경로가 실린다).
				result = null;
			}
			if (result != null && result.ok()) {
				this.distributed.add(new Distributed(targetIdOf(target), kind, spoolDirOf(target), result.file()));
				return true;
			}
			String reason = (result == null || result.reason() == null)
					? SpoolWriter.SPOOL_WRITE_FAILED : result.reason();
			reportFailure(new Failed(this.articleId, targetIdOf(target), kind, spoolDirOf(target), reason));
			return false;
		}

		/** 최신 행이 배부 가능한 상태인가 — allowlist는 {@link EmbargoPolicy}가 단일 출처다(복제 금지). */
		private boolean isDistributable() {
			ArticleRepository.StatusLookup lookup = DistributionService.this.articles.findStatus(this.articleId);
			// 불변 목록의 contains(null)은 NPE다 — 상태가 NULL인 행이 500을 만들지 않게 먼저 거른다.
			return lookup != null && lookup.present() && lookup.status() != null
					&& EmbargoPolicy.EMBARGO_DISTRIBUTABLE_STATUSES.contains(lookup.status());
		}

		/**
		 * 실패 표면화의 <b>단일 경로</b> — 쓰기 실패·중단 항목 전부 여기를 지난다. 반환({@code failed})과
		 * 통지는 <b>기록 생략과 무관하게 매번</b> 일어난다(무음 삼킴 금지).
		 */
		private void reportFailure(Failed item) {
			this.failed.add(item);
			notifyFailure(item);
			recordTargetFailure(item);
		}

		/** 통지 payload는 <b>식별자와 고정 사유만</b>이다 — 경로는 담지 않는다(로그는 밖으로 나간다). */
		private void notifyFailure(Failed item) {
			if (DistributionService.this.listener == null) {
				return;
			}
			try {
				DistributionService.this.listener.onDistributionFailure(new DistributionFailure(item.articleId(),
						item.targetId(), item.kind(), item.reason()));
			}
			catch (RuntimeException ignored) {
				// 알림 실패는 배부를 막지 않는다 — 이미 나간 파일을 되돌릴 수 없다.
			}
		}

		/**
		 * 수신처 단위 미발송 사실을 영속한다(append-only) — 재전송의 유일한 근거다.
		 *
		 * <p>기록 조건은 <b>이 한 곳뿐</b>이다: {@code targetId}가 있고(수신처 특정) 재전송 가능한 사유일
		 * 때만. {@code status-changed}(안전 중단)·{@code targetId} 없는 kind 단위 항목은 재전송 대상이
		 * 아니며, 영속하면 <b>영원히 해소되지 않는 항목</b>이 원장에 쌓인다.
		 */
		private void recordTargetFailure(Failed item) {
			if (item.targetId() == null || !DistributionFailureLog.isRetryableFailureReason(item.reason())) {
				return;
			}
			if (isDuplicateSameCycleFailure(item)) {
				return;
			}
			Map<String, Object> entry = new LinkedHashMap<>();
			entry.put(ARTICLE_ID, item.articleId());
			entry.put(EVENT_TYPE, DistributionFailureLog.DISTRIBUTE_FAILED_EVENT);
			entry.put(ACTION, item.kind());
			entry.put(TARGET_ID, item.targetId());
			// 사유는 writer의 고정 토큰 그대로다 — 예외 메시지·경로를 넣지 않는다.
			entry.put(REASON, item.reason());
			entry.put(ACTOR_USER_ID, this.actorUserId);
			DistributionService.this.recorder.record(entry);
		}

		/**
		 * 그 그룹의 미해소 최신 실패가 <b>이번 사이클(마지막 send 경계 이후)의</b> 같은 사유 실패인가.
		 *
		 * <p>CRITICAL: 경계 <b>이전</b> 행과의 일치는 중복이 <b>아니다</b> — 그 행만 남기면 재전송이
		 * {@code stale-cycle} 게이트에 걸려 영구 409가 되고, 그 kind의 {@code distribute} 행이 있으면 tick도
		 * 재시도하지 않아 그 수신처는 앱 안에서 <b>복구 경로가 0</b>이 된다. 경계를 넘긴 재실패는 항상 새
		 * 행을 얻어야 한다.
		 *
		 * <p>경계 미확정({@code null})이면 사이클 구분이 없다 — {@code stale-cycle} 거부도 없으므로 억제해도
		 * 복구 경로가 산다.
		 *
		 * <p>판정은 {@link DistributionFailureLog#unresolvedFailures}와 {@link EmbargoPolicy#latestSendId}만
		 * 재사용한다 — <b>새 판정 규칙을 만들지 않는다</b>.
		 */
		private boolean isDuplicateSameCycleFailure(Failed item) {
			FailureContext context = failureContext();
			double targetId = item.targetId().doubleValue();
			for (DistributionFailureLog.Failure candidate : context.unresolved()) {
				if (Objects.equals(candidate.articleId(), item.articleId())
						&& Double.compare(candidate.targetId(), targetId) == 0
						&& Objects.equals(candidate.kind(), item.kind())
						&& Objects.equals(candidate.reason(), item.reason())) {
					return context.boundaryId() == null || candidate.historyId() > context.boundaryId().longValue();
				}
			}
			return false;
		}

		/**
		 * 억제 판정 컨텍스트 — <b>이 호출 안에서 기사 단위 1회</b>만 조회한다(수신처마다 전체 스캔 금지).
		 *
		 * <p>호출 안 재사용은 안전하다: 한 호출에서 같은 {@code (targetId, kind)} 그룹은 최대 1회만
		 * 기록되므로 컨텍스트가 자기 기록으로 낡을 일이 없다.
		 *
		 * <p>조회가 실패하면 <b>빈 컨텍스트</b>다 — 억제는 최적화일 뿐이므로 모르면 기록하는 쪽으로 둔다
		 * (안전 방향: 과다 기록 &gt; 무음 유실). 조회 실패가 배부를 깨뜨리지도 않는다.
		 */
		private FailureContext failureContext() {
			if (this.failureContext == null) {
				Long boundaryId = null;
				List<DistributionFailureLog.Failure> unresolved = List.of();
				try {
					boundaryId = EmbargoPolicy
							.latestSendId(DistributionService.this.history.queryByArticle(this.articleId));
					unresolved = DistributionFailureLog.unresolvedFailures(DistributionService.this.history
							.queryDistributionEvents(this.articleId, Integer.valueOf(FAILURE_DEDUP_SCAN_LIMIT)));
				}
				catch (RuntimeException ex) {
					boundaryId = null;
					unresolved = List.of();
				}
				this.failureContext = new FailureContext(boundaryId, unresolved);
			}
			return this.failureContext;
		}

	}

	private static Long targetIdOf(Map<String, Object> target) {
		Object id = (target == null) ? null : target.get(ID);
		return (id instanceof Number number) ? Long.valueOf(number.longValue()) : null;
	}

	private static String spoolDirOf(Map<String, Object> target) {
		Object dir = (target == null) ? null : target.get(SPOOL_DIR);
		return (dir == null) ? null : String.valueOf(dir);
	}

	/** 억제 판정 입력 한 벌 — 사이클 경계와 그 시점의 미해소 실패 목록. */
	private record FailureContext(Long boundaryId, List<DistributionFailureLog.Failure> unresolved) {
	}

	/**
	 * 배부 실행 결과. 거부({@code ok=false})면 사유 토큰만 의미가 있고 두 목록은 비어 있다 — Node는 그
	 * 경로에서 키 자체를 싣지 않으므로 <b>거부 경로의 빈 목록을 "아무 수신처도 없었다"로 읽지 마라</b>.
	 *
	 * @param ok 실행됐는가(수신처 실패가 있어도 {@code true}다 — 개별 결과는 두 목록에 있다)
	 * @param reason 거부 사유 고정 토큰({@code spool-disabled}·{@code not-found}). 실행됐으면 {@code null}
	 */
	public record Result(boolean ok, String reason, List<Distributed> distributed, List<Failed> failed) {

		static Result deny(String reason) {
			return new Result(false, reason, List.of(), List.of());
		}

		static Result of(List<Distributed> distributed, List<Failed> failed) {
			return new Result(true, null, List.copyOf(distributed), List.copyOf(failed));
		}
	}

	/**
	 * 수신처 1곳에 실제로 나간 항목.
	 *
	 * <p><b>{@code spoolDir}·{@code file}은 서버 파일시스템 경로다</b> — HTTP 응답으로 나가지 않게 하는 것은
	 * tick 응답 투영의 책임이다(고정 키 화이트리스트).
	 */
	public record Distributed(Long targetId, String kind, String spoolDir, String file) {
	}

	/**
	 * 미발송 항목 — <b>내부 타입</b>이다.
	 *
	 * <p>{@code spoolDir}을 담는다(운영 진단용). <b>이 값이 HTTP로 나가지 않게 하는 것은 tick 응답 투영의
	 * 책임</b>이며, 통지({@link DistributionFailure})에는 애초에 담기지 않는다.
	 *
	 * @param targetId 수신처 id. kind 단위 중단 항목이면 {@code null}이다
	 * @param spoolDir 수신처 폴더명. kind 단위 중단 항목이면 {@code null}이다
	 * @param reason 고정 사유 토큰({@code spool-write-failed}·{@code invalid-spool-dir}·
	 *     {@code invalid-article-id}·{@code status-changed})
	 */
	public record Failed(String articleId, Long targetId, String kind, String spoolDir, String reason) {
	}

	/**
	 * 수신처 미발송 통지 payload — <b>식별자 3개와 고정 사유 하나뿐</b>이다(정확히 4키).
	 *
	 * <p>경로({@code spoolDir}·파일명)·본문·세션 토큰을 담지 않는다: 기본 통지 대상은 로그 버퍼이고 그
	 * 버퍼는 {@code GET /api/logs/digest}로 <b>밖으로 나간다</b>(LOGS.md 마스킹 규율 · ADR-007). Node의
	 * {@code onFailure} 결선도 같은 4개만 읽는다({@code src/controllers/index.js}).
	 */
	public record DistributionFailure(String articleId, Long targetId, String kind, String reason) {
	}

	/**
	 * 미발송 통지 seam — Node의 {@code onFailure} 콜백과 같은 자리다.
	 *
	 * <p>배부 호출자는 fire-and-forget이라 반환값을 보지 않는다: 이 통지가 없으면 미발송이 무음으로
	 * 사라진다. <b>이력 쓰기 실패</b>는 다른 사건이므로 다른 어휘로 통지한다
	 * ({@link ArticleHistoryRecorder.HistoryErrorListener} — 섞으면 운영자가 배부 실패로 오독한다).
	 */
	@FunctionalInterface
	public interface DistributionFailureListener {

		void onDistributionFailure(DistributionFailure failure);

	}

}
