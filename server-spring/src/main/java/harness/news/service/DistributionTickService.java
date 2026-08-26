package harness.news.service;

import harness.news.model.ArticleAggregate;
import harness.news.model.ArticleHistoryRepository;
import harness.news.model.ArticleRepository;
import harness.news.model.ContentsRow;
import java.time.Clock;
import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * 엠바고 시점 배부 tick — 리포 루트 {@code src/services/distributionTickService.js}(229행)의 1:1
 * 이식이며 HTTP 비의존이다(ADR-006). 서블릿 타입도 세션도 알지 못하고 행위자는 인자로만 받는다(ADR-004).
 *
 * <h2>트리거는 외부 cron 하나뿐이다(ADR-008 (3))</h2>
 * 이 모듈에는 <b>주기 실행이 없다</b>({@code @Scheduled}·{@code TaskScheduler}·타이머·워커 스레드 0 —
 * {@code Adr008DisciplineTest}가 기계로 막는다). 실행은 {@code POST /api/distribution/tick} 호출자만
 * 만든다. <b>egress도 없다</b>: 밖으로 나가는 유일한 경로는 {@code DistributionService} →
 * {@link SpoolWriter}의 파일 쓰기다. 자동 재시도·백오프·재시도 큐도 없다(ADR-008 (6)) — 실패는 요약과
 * 실패 원장에 남고 복구는 사람이 부르는 재전송이 한다.
 *
 * <h2>하는 일은 하나다</h2>
 * "엠바고 시각이 도래했는데 아직 배부되지 않은 kind"를 찾아 배부를 <b>지시</b>한다. 판정도 실행도 이
 * 모듈의 것이 아니다:
 * <ul>
 *   <li>무엇이 도래·미배부인가 → {@link EmbargoPolicy}(단일 출처)</li>
 *   <li>어디에 어떻게 쓰는가 → {@link DistributionService}(대상 선정·스풀 쓰기·{@code distributedAt}·이력)</li>
 *   <li>배부 후 상태는 무엇인가 → {@link ArticleEmbargoService}(생애주기 단일 출처)</li>
 * </ul>
 * 그래서 이 클래스는 {@code status}도 {@code distributedAt}도 <b>직접 쓰지 않는다</b> — 두 곳에서 쓰면
 * 판정이 발산한다.
 *
 * <h2>응답은 화이트리스트 투영이다</h2>
 * 반환 맵은 그대로 HTTP 응답이 된다. 실물 실패 항목({@link DistributionService.Failed})은
 * {@code spoolDir}을 갖고 있으므로 <b>그대로 합치면 서버 파일시스템 경로가 유출된다</b>. 사유도 <b>고정
 * 토큰만</b> 싣는다 — 예외 메시지({@code String(e)})를 쓰면 메시지에 경로가 실려 화이트리스트가 그대로
 * 우회된다. 향후 실패 항목에 필드가 추가돼도 기본값은 "미노출"이다(안전 기본값).
 *
 * <h2>throw하지 않는다</h2>
 * 라우트가 500으로 새면 운영 cron이 원인을 알 수 없다. 후보 조회 실패는 {@code tick-failed} 거부로,
 * 기사 단위 예외는 <b>그 기사만</b> 실패로 남기고 스캔을 계속한다. 원인은 {@link TickErrorListener}로
 * 표면화한다(응답에는 고정 토큰만 남으므로 이 통지가 없으면 원인이 무음으로 사라진다).
 *
 * <h2>빈 배선은 컨트롤러 step이 올린다</h2>
 * {@code DIST_SPOOL_DIR} 미설정이면 스풀 writer가 없고, 그러면 {@link DistributionService}도 없다
 * (decisions (3)). 이 서비스는 그 상태를 {@code distribution == null}로 받아 {@code spool-disabled}를
 * 돌려준다 — 판정 지점을 늘리지 않기 위해 여기서 설정을 다시 읽지 않는다. {@code @Service}가 없는 것도
 * 같은 이유다(소비자 step이 함께 올린다 — {@code DistributionService}·{@code ArticleEmbargoService} 선례).
 */
public class DistributionTickService {

	/** 기사 단위 예외·후보 조회 실패의 고정 사유 토큰. 원시 에러 문자열을 쓰지 않는다(경로 유출). */
	public static final String TICK_FAILED = "tick-failed";

	/**
	 * 도래한 kind의 활성 수신처가 0곳이라 성공·실패 기록이 모두 0건으로 끝난 경우의 사유. 요약 어디에도
	 * 안 남으면 미배부가 <b>무음</b>으로 사라진다.
	 */
	public static final String NO_ACTIVE_TARGET = "no-active-target";

	/** 진행 중 재진입 응답에만 더해지는 키의 값. */
	public static final String IN_PROGRESS = "in-progress";

	/** 배부 서비스가 사유를 주지 않은 경우의 기본값(실물은 항상 토큰을 준다 — 방어). */
	private static final String UNKNOWN_FAILURE = SpoolWriter.SPOOL_WRITE_FAILED;

	/**
	 * self-heal을 시도할 상태 — Node의 {@code effective.status === 'DES' || 'EPS'} 그대로다.
	 *
	 * <p>{@link EmbargoPolicy#CYCLE_SCOPED_STATUSES}와 값이 같지만 <b>질문이 다르다</b>(저쪽은 "이력을
	 * 어디까지 셀 것인가"). 허용 범위의 정본은 {@code embargoStatusFor}이고 이 목록은 불필요한 호출을
	 * 줄이는 사전 필터일 뿐이다 — 둘을 한 상수로 합치면 두 질문이 한 곳에서 묶여 한쪽만 옳은 변경이
	 * 다른 쪽을 조용히 망가뜨린다(decisions (9) 계열).
	 */
	private static final List<String> SELF_HEALABLE_STATUSES = List.of("DES", "EPS");

	private static final String ARTICLE_ID = "articleId";

	private static final String STATUS = "status";

	private static final String OK = "ok";

	private static final String REASON = "reason";

	private static final String AT = "at";

	private static final String SCANNED = "scanned";

	private static final String DISTRIBUTED = "distributed";

	private static final String FAILED = "failed";

	private static final String INVALID = "invalid";

	private static final String SKIPPED = "skipped";

	private static final String KINDS = "kinds";

	private static final String TARGET_ID = "targetId";

	private static final String KIND = "kind";

	private static final String FIELD = "field";

	private final ArticleRepository articles;

	private final ArticleHistoryRepository history;

	private final DistributionService distribution;

	private final ArticleEmbargoService embargo;

	private final Clock clock;

	private final TickErrorListener listener;

	/**
	 * single-flight 플래그 — cron 중복 트리거·수동 호출 겹침으로 실행이 겹치면 같은 기사가 두 번 스풀된다
	 * (멱등 근거인 배부 이력은 스풀 쓰기 <b>뒤</b>에 남아 동시 실행의 스캔에는 보이지 않는다).
	 *
	 * <p><b>프로세스 내 보호일 뿐이다.</b> 다중 인스턴스 중복은 ADR-008 (3)의 "외부 cron 단일 트리거"
	 * 운영 규율이 막는다 — 분산 락을 넣지 마라(검증되지 않은 새 표면이 생긴다 · excluded (m)).
	 */
	private final AtomicBoolean running = new AtomicBoolean();

	/**
	 * @param distribution 스풀이 설정되지 않았으면 {@code null} — 그때 배부는 전면 비활성이다
	 * @param embargo 상태 반영 서비스. {@code null}이면 상태를 바꾸지 않는다(배부는 그대로 일어난다)
	 * @param listener 기사 단위 예외 통지 seam. {@code null}이면 통지하지 않는다(Node의 선택적
	 *     {@code onError} 동형)
	 */
	public DistributionTickService(ArticleRepository articles, ArticleHistoryRepository history,
			DistributionService distribution, ArticleEmbargoService embargo, Clock clock,
			TickErrorListener listener) {
		this.articles = articles;
		this.history = history;
		this.distribution = distribution;
		this.embargo = embargo;
		this.clock = clock;
		this.listener = listener;
	}

	/**
	 * 도래한 엠바고 배부를 1회 실행한다 — 외부 cron이 주기 호출하는 유일한 진입점이다.
	 *
	 * @param actorUserId 행위자 userId. <b>검증된 세션에서만</b> 오며, 클라이언트가 보낸 값이 여기까지
	 *     오지 않는다(ADR-004). 시스템 실행이면 {@code null}
	 * @return 정확히 6키의 요약 {@code {ok,at,scanned,distributed,failed,invalid}}, 재진입이면 여기에
	 *     {@code skipped}가 더해진 7키, 미가용이면 2키 {@code {ok:false, reason}}. <b>throw하지 않는다</b>
	 */
	public Map<String, Object> run(String actorUserId) {
		if (this.distribution == null) {
			return denied(SpoolWriter.SPOOL_DISABLED);
		}

		// 진행 중이면 새 스캔을 시작하지 않는다 — 응답 shape은 정상 요약과 동형(화이트리스트 위생 유지)이고
		// skipped 토큰만 더해져 운영 cron이 "겹침 스킵"을 관측할 수 있다.
		if (!this.running.compareAndSet(false, true)) {
			return skipped();
		}
		try {
			return runOnce(actorUserId);
		}
		finally {
			// CRITICAL: 실패 반환 경로에서도, 가드를 뚫고 이탈하는 예외에서도 반드시 해제한다 —
			// 한 번이라도 켜진 채 남으면 그 뒤 모든 tick이 스킵 응답만 내고 배부가 영구 정지한다.
			this.running.set(false);
		}
	}

	private Map<String, Object> runOnce(String actorUserId) {
		// 시계는 실행당 한 번만 읽는다 — 같은 실행 안에서 시각이 흔들리면 기사마다 판정이 갈린다.
		String at = Iso8601.now(this.clock);

		List<ContentsRow> candidates;
		try {
			candidates = scan();
		}
		catch (RuntimeException ex) {
			notifyError(null, ex);
			return denied(TICK_FAILED);
		}

		Summary summary = new Summary();
		// 순차 처리 — 병렬 배부 금지(같은 SQLite 파일에 상태·이력을 쓰고, 테스트도 결정적이어야 한다).
		for (ContentsRow contents : candidates) {
			String articleId = asText(contents.column(ARTICLE_ID));
			try {
				distributeDue(articleId, contents, at, actorUserId, summary);
			}
			catch (RuntimeException ex) {
				// 한 기사의 예외가 스캔 전체를 중단시키지 않는다. 응답에는 고정 토큰만, 원인은 통지로.
				notifyError(articleId, ex);
				summary.failed.add(failure(articleId, null, null, TICK_FAILED));
			}
		}
		return summary.toResponse(at, candidates.size());
	}

	/**
	 * 배부 후보 — 송고된 전 기사를 로드한 뒤 <b>엠바고가 설정된 것만</b> 남긴다.
	 *
	 * <p>비용 인식(의도적 수용): {@code DPS} 전량을 읽는다. SQL에 엠바고 조건을 넣어 좁히면 phase 47
	 * 이전에 송고돼 {@code DPS}로 남은 레거시 엠바고 기사 픽업을 잃는다 — 규모는 {@code scanned}로 노출해
	 * 운영자가 관측한다.
	 */
	private List<ContentsRow> scan() {
		Map<String, List<String>> filters = new LinkedHashMap<>();
		// 상태 allowlist는 EmbargoPolicy가 단일 출처다 — 미송고·킬·보류·삭제가 나가면 회수 수단이 없다.
		filters.put(STATUS, EmbargoPolicy.EMBARGO_DISTRIBUTABLE_STATUSES);

		List<ContentsRow> candidates = new ArrayList<>();
		for (ContentsRow contents : this.articles.query(filters)) {
			// 엠바고가 설정되지 않은 기사는 tick의 관심사가 아니다(송고 즉시 배부는 송고 훅의 책임).
			if (contents != null && !EmbargoPolicy.requiredKinds(contents::column).isEmpty()) {
				candidates.add(contents);
			}
		}
		return candidates;
	}

	/** 기사 1건의 도래분을 배부한다. 예외는 호출자가 잡는다(그 기사만 실패로 남는다). */
	private void distributeDue(String articleId, ContentsRow contents, String at, String actorUserId,
			Summary summary) {
		// 오타 등 파싱 불가 엠바고 값은 "미도래"로 취급되어 영원히 배부되지 않는다 — 표면화한다.
		for (String field : EmbargoPolicy.unparsableEmbargoFields(contents::column)) {
			summary.invalid.add(invalid(articleId, field));
		}

		String status = asText(contents.column(STATUS));
		// 불변식(A): done을 계산할 때 쓴 status와 그 done을 넘기는 dueKinds의 status는 항상 같아야 한다
		// (사이클 범위가 status에 따라 달라진다).
		List<String> done = distributedOf(articleId, status);
		List<String> due = EmbargoPolicy.dueKinds(status, contents::column, done, at);
		String effectiveStatus = status;

		if (!due.isEmpty()) {
			// TOCTOU 재검증: 후보 스캔의 스냅샷과 실제 배부 사이에 KILL(EEK)·보류(EEH)·삭제(DPD)로
			// 전이됐을 수 있다 — 한 번 나간 기사는 회수 수단이 없으므로 배부 지시 직전에 1회 재조회한다.
			ArticleAggregate fresh = this.articles.findById(articleId);
			ContentsRow freshContents = (fresh == null) ? null : fresh.contents();
			// 행이 사라졌거나 상태가 배부 가능 목록 밖이면 그 자리에서 멈춘다. 불변 목록의
			// contains(null)은 NPE이므로 상태가 NULL인 행을 먼저 거른다.
			String freshStatus = (freshContents == null) ? null : asText(freshContents.column(STATUS));
			if (freshContents == null || freshStatus == null
					|| !EmbargoPolicy.EMBARGO_DISTRIBUTABLE_STATUSES.contains(freshStatus)) {
				// 무음 스킵 금지 — 요약에 고정 사유로만 남긴다(새 상태값·경로 비노출).
				summary.failed.add(failure(articleId, null, null, DistributionService.STATUS_CHANGED));
				return;
			}
			effectiveStatus = freshStatus;
			// status가 달라졌으면 "이미 배부됨"도 fresh 기준으로 다시 센다(위 불변식). 예: 스냅샷
			// DES(사이클 범위) → 완결로 전이(DPS·전체 이력 범위). 옛 done을 쓰면 이미 나간 수신처로
			// 중복 배부된다(회수 불가).
			if (!Objects.equals(freshStatus, status)) {
				done = distributedOf(articleId, freshStatus);
			}
			due = EmbargoPolicy.dueKinds(freshStatus, freshContents::column, done, at);
		}

		if (due.isEmpty()) {
			// 재정합(self-heal): 이력은 있는데 승격이 누락된 기사(이력 insert 실패·과거 데이터)가 영원히
			// 대기 상태로 남지 않게 한다. 바꿀 게 없으면 embargoStatusFor가 null을 주므로 쓰기 0건이다.
			if (effectiveStatus != null && SELF_HEALABLE_STATUSES.contains(effectiveStatus)) {
				syncStatus(articleId, List.of(), actorUserId, effectiveStatus);
			}
			return;
		}

		DistributionService.Result result = this.distribution.distribute(articleId, due, actorUserId);
		// {ok:false, reason:'spool-disabled'|'not-found'} — 배부 자체가 성립하지 않은 경우.
		if (result == null || !result.ok()) {
			summary.failed.add(failure(articleId, null, null, token(result == null ? null : result.reason())));
			return;
		}

		for (DistributionService.Failed item : result.failed()) {
			summary.failed.add(project(articleId, item));
		}
		// 도래한 kind가 성공·실패 어느 쪽에도 없는 유일한 경우는 그 kind의 활성 수신처가 0곳일 때다
		// (배부 서비스는 수신처마다 둘 중 하나에 반드시 기록한다). 그대로 두면 요약 어디에도 안 남는다.
		Set<String> touched = touchedKinds(result);
		for (String kind : due) {
			if (!touched.contains(kind)) {
				summary.failed.add(failure(articleId, null, kind, NO_ACTIVE_TARGET));
			}
		}

		// 승격 근거는 **실제 스풀 기록에 성공한 kind**뿐이다 — 거짓 완결 금지. 전 수신처가 실패하면
		// 상태는 그대로 두고 failed로만 보고한다(그래야 다음 tick이 다시 시도한다).
		List<String> okKinds = okKinds(result);
		if (okKinds.isEmpty()) {
			return;
		}

		// distributedAt은 여기서 쓰지 않는다 — 배부 시각 갱신은 DistributionService의 단일 책임이다.
		String status2 = syncStatus(articleId, okKinds, actorUserId, effectiveStatus);
		summary.distributed.add(distributed(articleId, okKinds, status2));
	}

	/**
	 * 이번 <b>사이클</b>에서 이미 배부된 kind — "이미 배부됨"의 유일한 근거는 append-only 이력이다.
	 *
	 * <p>상태가 아니라 이력으로 판정하기 때문에 멱등이 자연 성립하고(같은 시각 반복 호출에도 재배부 없음),
	 * 레거시 {@code DPS} 엠바고 기사도 후보에서 빠지지 않는다. 범위는 <b>이번 사이클</b>이다: 보류 →
	 * 엠바고 재설정 → 재송고로 {@code DES}에 재진입한 기사를 전체 이력으로 보면 도래분이 "이미 배부됨"으로
	 * 걸러져 영원히 배부되지 않고, 이어지는 self-heal이 거짓 완결까지 만든다(복구 경로 없음).
	 */
	private List<String> distributedOf(String articleId, String status) {
		if (this.history == null) {
			return List.of();
		}
		return EmbargoPolicy.cycleDistributedKinds(status, this.history.queryByArticle(articleId));
	}

	/**
	 * 상태 전이는 전적으로 {@link ArticleEmbargoService}에 위임한다(생애주기 단일 출처).
	 *
	 * @return 반영 후 상태. 서비스가 없거나 반영이 실패하면 {@code fallback}
	 */
	private String syncStatus(String articleId, List<String> extraKinds, String actorUserId, String fallback) {
		if (this.embargo == null) {
			return fallback;
		}
		ArticleEmbargoService.Result result = this.embargo.syncEmbargoStatus(articleId, extraKinds, actorUserId);
		return (result != null && result.ok()) ? result.status() : fallback;
	}

	/** 배부 서비스가 성공·실패 어느 쪽으로든 "손댄" kind 집합. */
	private static Set<String> touchedKinds(DistributionService.Result result) {
		Set<String> touched = new LinkedHashSet<>();
		for (DistributionService.Distributed item : result.distributed()) {
			if (item != null) {
				touched.add(item.kind());
			}
		}
		for (DistributionService.Failed item : result.failed()) {
			if (item != null) {
				touched.add(item.kind());
			}
		}
		return touched;
	}

	/** 실제로 스풀 기록에 성공한 kind(중복 제거 · 빈 값 제외). */
	private static List<String> okKinds(DistributionService.Result result) {
		Set<String> kinds = new LinkedHashSet<>();
		for (DistributionService.Distributed item : result.distributed()) {
			if (item != null && item.kind() != null) {
				kinds.add(item.kind());
			}
		}
		return List.copyOf(kinds);
	}

	/** 통지 실패가 스캔을 멈추지 않게 격리한다. */
	private void notifyError(String articleId, RuntimeException cause) {
		if (this.listener == null) {
			return;
		}
		try {
			this.listener.onTickError(new TickError(articleId, reasonOf(cause)));
		}
		catch (RuntimeException ignored) {
			// 로그 실패는 배부를 막지 않는다.
		}
	}

	/** 메시지가 없는 예외는 타입 이름으로 남긴다({@link ArticleHistoryRecorder}와 같은 규칙). */
	private static String reasonOf(RuntimeException cause) {
		String message = cause.getMessage();
		return (message == null) ? cause.getClass().getName() : message;
	}

	// --- 투영 -------------------------------------------------------------------------------------

	/**
	 * 배부 실패 항목을 <b>식별자와 사유만</b> 남게 투영한다. 실물 항목은 {@code spoolDir}을 갖고 있어
	 * 그대로 합치면 서버 파일시스템 경로가 HTTP로 나간다.
	 */
	private static Map<String, Object> project(String articleId, DistributionService.Failed item) {
		if (item == null) {
			return failure(articleId, null, null, UNKNOWN_FAILURE);
		}
		return failure(articleId, item.targetId(), item.kind(), token(item.reason()));
	}

	/** 사유가 없으면 기본 토큰이다 — 예외 메시지를 채워 넣지 않는다. */
	private static String token(String reason) {
		return (reason == null) ? UNKNOWN_FAILURE : reason;
	}

	private static Map<String, Object> failure(String articleId, Long targetId, String kind, String reason) {
		Map<String, Object> item = new LinkedHashMap<>();
		item.put(ARTICLE_ID, articleId);
		item.put(TARGET_ID, targetId);
		item.put(KIND, kind);
		item.put(REASON, reason);
		return Collections.unmodifiableMap(item);
	}

	private static Map<String, Object> distributed(String articleId, List<String> kinds, String status) {
		Map<String, Object> item = new LinkedHashMap<>();
		item.put(ARTICLE_ID, articleId);
		item.put(KINDS, kinds);
		item.put(STATUS, status);
		return Collections.unmodifiableMap(item);
	}

	private static Map<String, Object> invalid(String articleId, String field) {
		Map<String, Object> item = new LinkedHashMap<>();
		item.put(ARTICLE_ID, articleId);
		item.put(FIELD, field);
		return Collections.unmodifiableMap(item);
	}

	private static Map<String, Object> denied(String reason) {
		Map<String, Object> response = new LinkedHashMap<>();
		response.put(OK, Boolean.FALSE);
		response.put(REASON, reason);
		return Collections.unmodifiableMap(response);
	}

	/** 재진입 응답 — 정상 요약과 동형이고 {@code skipped} 하나만 더해진다(스캔은 하지 않는다). */
	private Map<String, Object> skipped() {
		Map<String, Object> response = new Summary().toResponse(Iso8601.now(this.clock), 0);
		Map<String, Object> withSkip = new LinkedHashMap<>(response);
		withSkip.put(SKIPPED, IN_PROGRESS);
		return Collections.unmodifiableMap(withSkip);
	}

	private static String asText(Object value) {
		return (value == null) ? null : String.valueOf(value);
	}

	/** 한 실행이 모으는 세 목록 — 반환 shape의 조립도 여기 한 곳이다. */
	private static final class Summary {

		private final List<Map<String, Object>> distributed = new ArrayList<>();

		private final List<Map<String, Object>> failed = new ArrayList<>();

		private final List<Map<String, Object>> invalid = new ArrayList<>();

		/** 키 순서는 {@code LinkedHashMap}으로 고정한다 — 이 맵이 그대로 응답이 된다. */
		Map<String, Object> toResponse(String at, int scanned) {
			Map<String, Object> response = new LinkedHashMap<>();
			response.put(OK, Boolean.TRUE);
			response.put(AT, at);
			response.put(SCANNED, Integer.valueOf(scanned));
			response.put(DISTRIBUTED, List.copyOf(this.distributed));
			response.put(FAILED, List.copyOf(this.failed));
			response.put(INVALID, List.copyOf(this.invalid));
			return Collections.unmodifiableMap(response);
		}

	}

	/**
	 * 기사 단위 예외 통지 payload — <b>식별자 하나와 사유 하나뿐</b>이다(본문·세션 토큰·수신처 경로를
	 * 담지 않는다 · LOGS.md 마스킹 규율).
	 *
	 * <p>{@code reason}은 원인 예외의 메시지다(Node {@code onError}의 {@code error?.message} 동형 ·
	 * {@link ArticleHistoryRecorder.HistoryError}와 같은 규칙). <b>이 값은 HTTP 응답으로 나가지 않는다</b> —
	 * 응답의 사유는 언제나 고정 토큰 {@code tick-failed}다.
	 *
	 * @param articleId 기사 id. 후보 조회 자체가 실패했으면 {@code null}
	 */
	public record TickError(String articleId, String reason) {
	}

	/**
	 * 기사 단위 예외 통지 seam — Node의 {@code onError} 콜백과 같은 자리다.
	 *
	 * <p>응답에는 고정 토큰만 담으므로 이 훅이 없으면 원인이 무음으로 사라진다(무음 삼킴 금지).
	 */
	@FunctionalInterface
	public interface TickErrorListener {

		void onTickError(TickError error);

	}

}
