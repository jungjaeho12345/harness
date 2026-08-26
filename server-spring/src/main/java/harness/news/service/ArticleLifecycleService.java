package harness.news.service;

import harness.news.model.ArticleAggregate;
import harness.news.model.ArticleHistoryRepository;
import harness.news.model.ArticleRepository;
import harness.news.model.ContentsRow;
import java.time.Clock;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.stereotype.Service;

/**
 * 기사 <b>생애주기</b> 서비스 — 리포 루트 {@code src/services/articleService.js}의 {@code applyAction}·
 * {@code deriveArticle}과 1:1 이식이다. HTTP 비의존이며(ADR-006) 서블릿 타입을 알지 못한다: 세션도
 * 요청 객체도 읽지 않고 <b>신원과 의도는 인자로만</b> 받는다. acting role을 검증된 세션에서 도출하는 것은
 * 컨트롤러의 책임이다(ADR-004).
 *
 * <h2>가드 순서가 계약이다</h2>
 * <ol>
 *   <li><b>존재</b> — {@code Contents} 행이 없으면 {@code not-found}. 어휘·role보다 앞이다.</li>
 *   <li><b>전이표</b>({@link Lifecycle}) — 정의 밖이면 {@code unknown-action}·{@code unknown-role}·
 *       {@code forbidden-transition}.</li>
 *   <li><b>"(끝)" 마커</b>({@link EndMarker}) — 송고에만 있고, 없으면 {@code no-end-marker}.</li>
 *   <li>엠바고 후처리 → {@code sender}/{@code sentAt} stamp + 상태 저장 → 이력 기록.</li>
 * </ol>
 * <b>전이가 불가하면 마커 검사에 도달하지 않는다.</b> 순서를 한 칸만 바꿔도 같은 요청(마커도 없고 전이도
 * 불가한 송고)이 409와 400 사이에서 갈린다 — 계약이 그 순서를 명시적으로 동결했다.
 *
 * <h2>엠바고 진입은 설정 여부만 본다</h2>
 * 이전 상태가 {@code RDS}·{@code DDH}이고 role이 D·Z이며 전이 결과가 {@code DPS}이고 <b>엠바고 두 컬럼 중
 * 하나라도 값이 있으면</b> 최종 상태는 {@code DES}다. <b>시각을 비교하지 않는다</b> — "지금이 엠바고
 * 시각인가"는 배부 tick의 질문이고(ADR-008), 여기서 비교하면 도래 전 기사가 즉시 배부 상태로 떨어져
 * 엠바고가 새어 나간다(외부로 나간 기사는 회수 수단이 없다). 판정 입력은 <b>DB에 저장된 값</b>뿐이다
 * (클라이언트 값 불신 — 애초에 이 시그니처로는 엠바고를 넘길 수 없다).
 *
 * <h2>송고 훅은 잇기만 한다</h2>
 * 송고가 성공하면 {@link SendDistribution}의 판정으로 배부 서비스를 부르고, 실제로 나간 kind가 있으면
 * 엠바고 상태 반영을 부른다(ADR-008 (4)). <b>판정도 스풀 쓰기도 승격도 이 서비스의 코드가 아니다</b> —
 * 순서와 격리만 여기 있다. 배부 서비스가 없으면({@code DIST_SPOOL_DIR} 미설정) 훅 자체가 없고, 훅이
 * 무엇을 했든 <b>반환 status는 배부 이전 값</b>이다. 앱 안에 타이머·직접 전송·재시도 큐는 여전히 없다.
 *
 * <h2>이 서비스가 하지 않는 것</h2>
 * <ul>
 *   <li><b>배부 시점 판정</b> — "지금이 엠바고 시각인가"는 tick pull의 질문이다(ADR-008 (3)). 훅은
 *       시각을 비교하지 않는다.</li>
 *   <li><b>행 삭제</b> — {@code approveDelete}는 {@code DPD}로 가는 <b>상태 전이</b>이고 두 행은 그대로
 *       남는다(최상위 규칙 · 계약이 삭제 승인 뒤 조회를 단언한다).</li>
 *   <li><b>존재·인가 판단 밖의 게이트</b>(세션·역할 집합·잠금) — 컨트롤러가 자기 문맥으로 한다.</li>
 *   <li><b>응답 shape 조립</b>·<b>SSE 통지</b> — HTTP 계층·다른 phase의 소유다.</li>
 * </ul>
 */
@Service
public class ArticleLifecycleService {

	/** 송고 액션 이름. 마커 게이트와 stamp가 걸리는 유일한 액션이다. */
	private static final String SEND = "send";

	/** 엠바고 {@code DES} 진입이 가능한 <b>이전</b> 상태 2종. */
	private static final Set<String> DES_ENTRY_STATUSES = Set.of("RDS", "DDH");

	/** 엠바고 유형(1차·2차·1+2차)은 두 시간 컬럼의 조합으로 도출된다 — 별도 컬럼을 두지 않는다. */
	private static final List<String> EMBARGO_COLUMNS = List.of("embargoAt", "secondEmbargoAt");

	private static final String STATUS = "status";

	private static final String ARTICLE_ID = "articleId";

	private static final String TITLE = "title";

	private static final String MARKUP_VERSION = "markupVersion";

	private static final String FOLLOW_UP = "followUp";

	private static final String CONTINUE = "continue";

	/** 파생이 복사하는 공통정보 <b>9키</b>. 주석이 아니라 이 목록이 계약이다(부서 2종은 없다). */
	private static final List<String> DERIVED_COMMON_FIELDS = List.of(
			"coAuthor", "category", "region", "attribute", "keyword",
			"internalComment", "externalComment", "attachmentFile", "referenceFile");

	private static final ActionResult NOT_FOUND = new ActionResult(false, null, "not-found");

	private static final ActionResult NO_END_MARKER = new ActionResult(false, null, "no-end-marker");

	private static final DeriveResult UNKNOWN_MODE = new DeriveResult(false, null, "unknown-mode");

	private static final DeriveResult DERIVE_NOT_FOUND = new DeriveResult(false, null, "not-found");

	private static final Logger logger = LoggerFactory.getLogger(ArticleLifecycleService.class);

	private final ArticleRepository articles;

	private final ArticleWriteService writeService;

	private final ArticleHistoryRecorder recorder;

	private final Clock clock;

	private final ArticleHistoryRepository history;

	private final ObjectProvider<DistributionService> distribution;

	private final ObjectProvider<ArticleEmbargoService> embargo;

	/**
	 * @param history 훅의 "이미 배부된 kind" 조회 경로다(이력 <b>기록</b>은 {@code recorder}가 한다)
	 * @param distribution 배부 실행 서비스. {@code DIST_SPOOL_DIR} 미설정이면 <b>빈이 없고</b>, 그러면
	 *     송고 훅도 없다(선택 의존)
	 * @param embargo 배부 사실의 상태 반영. 배부가 성공한 뒤에만 불린다(선택 의존)
	 */
	public ArticleLifecycleService(ArticleRepository articles, ArticleWriteService writeService,
			ArticleHistoryRecorder recorder, Clock clock, ArticleHistoryRepository history,
			ObjectProvider<DistributionService> distribution, ObjectProvider<ArticleEmbargoService> embargo) {
		this.articles = articles;
		this.writeService = writeService;
		this.recorder = recorder;
		this.clock = clock;
		this.history = history;
		this.distribution = distribution;
		this.embargo = embargo;
	}

	/**
	 * 생애주기 액션(송고·보류·KILL·삭제 승인)을 적용한다.
	 *
	 * <p>성공하면 <b>저장된 최종 상태</b>를 돌려준다(엠바고 후처리를 거친 값이다 — 전이표의 결과가 아니다).
	 * 거부하면 사유 토큰만 돌려주며 <b>상태도 이력도 남기지 않는다</b>: 이력은 감사 기록이자 판정 입력이라
	 * 거부 경로의 기록 하나가 표시와 판정을 함께 틀리게 만든다.
	 *
	 * @param articleId 대상 기사
	 * @param role 검증된 세션에서 도출한 acting role(클라이언트 값이 아니다)
	 * @param action {@code send}·{@code hold}·{@code kill}·{@code approveDelete}
	 * @param actorUserId 행위자 userId. 없으면 {@code null}로 stamp·기록한다.
	 */
	public ActionResult applyAction(String articleId, String role, String action, String actorUserId) {
		ArticleAggregate found = this.articles.findById(articleId);
		if (found == null || found.contents() == null) {
			return NOT_FOUND;
		}

		ContentsRow contents = found.contents();
		String fromStatus = asText(contents.column(STATUS));

		Lifecycle.Transition transition = Lifecycle.transition(fromStatus, role, action);
		if (!transition.ok()) {
			return new ActionResult(false, null, transition.reason());
		}

		// 전이 판정 뒤에 온다 — 앞으로 옮기면 전이 불가한 기사의 송고가 409가 아니라 400이 된다.
		if (SEND.equals(action) && !EndMarker.present(markupVersionOf(found))) {
			return NO_END_MARKER;
		}

		String finalStatus = embargoAware(transition.status(), fromStatus, role, action, contents);

		// present-only — status(+송고면 2컬럼)만 쓴다. 본문·잠금·distributedAt을 함께 쓰지 않는 것이
		// DB 비파괴의 실질 보증이다.
		Map<String, Object> update = new LinkedHashMap<>();
		update.put(STATUS, finalStatus);
		if (SEND.equals(action)) {
			update.put("sender", actorUserId);
			update.put("sentAt", Iso8601.now(this.clock));
		}
		this.articles.update(articleId, null, update);

		// 전이 성공 직후에만 기록한다. 시각 stamp·표시 제목 파생·실패 격리는 기록 헬퍼가 한 곳에서 한다.
		Map<String, Object> entry = new LinkedHashMap<>();
		entry.put(ARTICLE_ID, articleId);
		entry.put("eventType", STATUS);
		entry.put("action", action);
		entry.put("fromStatus", fromStatus);
		entry.put("toStatus", finalStatus);
		entry.put("actorUserId", actorUserId);
		this.recorder.record(entry);

		// 송고 성공 직후 즉시 배부(ADR-008 (4)) — 이력 기록 **뒤**다(위 주석의 사이클 경계 불변식).
		if (SEND.equals(action)) {
			distributeAfterSend(articleId, finalStatus, contents, actorUserId);
		}

		// 반환 status는 훅이 무엇을 했든 finalStatus다 — 배부 이후 승격 값을 담지 않는다(decisions (8)).
		return new ActionResult(true, finalStatus, null);
	}

	/**
	 * 송고 훅 — 판정은 {@link SendDistribution#kindsForSend}가, 실행은 배부 서비스가, 상태 반영은 엠바고
	 * 서비스가 한다. 이 메서드가 하는 일은 <b>그 셋을 순서대로 잇는 것</b>뿐이다.
	 *
	 * <h2>동기로 실행하되 반환에는 영향을 주지 않는다</h2>
	 * Node는 fire-and-forget이라 {@code applyAction}이 <b>배부 이전</b> status를 즉시 돌려준다. Spring은
	 * 별도 스레드를 두지 않으므로(ADR-008 (6): 워커·타이머·재시도 큐 없음 · 비동기는 계약 하네스의 자기
	 * 결정성도 깨뜨린다) 여기서 동기로 실행하고, <b>반환값은 호출부에서 {@code finalStatus} 그대로</b>
	 * 둔다. 2차 엠바고만 설정된 기사는 이 훅이 끝난 뒤 저장된 행이 {@code EPS}지만 응답은 {@code DES}다.
	 *
	 * <h2>배부 실패가 송고를 되돌리지 않는다</h2>
	 * 전이는 이미 커밋됐고 나간 파일은 회수할 수 없다 — 훅에서 예외가 새면 스풀 쓰기 실패 하나로 기사가
	 * 송고 불가 상태에 묶인다(복구 수단 없음). 그래서 <b>블록 전체</b>를 격리하고 로그만 남긴다.
	 *
	 * @param contents <b>전이 전에 읽은 스냅샷</b>이다(Node {@code row.contents} 동형). 판정 입력은 DB에
	 *     저장된 값뿐이며 클라이언트가 준 값은 애초에 여기까지 오지 못한다(ADR-004)
	 */
	private void distributeAfterSend(String articleId, String finalStatus, ContentsRow contents,
			String actorUserId) {
		try {
			DistributionService service = (this.distribution == null) ? null : this.distribution.getIfAvailable();
			if (service == null) {
				return; // 스풀 미설정 = 배부 전면 비활성. 송고는 훅이 없던 때와 완전히 같이 동작한다.
			}

			List<String> kinds = SendDistribution.kindsForSend(finalStatus, contents::column,
					alreadyDistributedKinds(articleId));
			if (kinds.isEmpty()) {
				return; // 지금 나갈 것이 없다(미도래분은 tick의 몫이다).
			}

			DistributionService.Result result = service.distribute(articleId, kinds, actorUserId);
			// 승격의 근거는 **실제로 나간 목록**뿐이다. ok만 보면 {ok:true, distributed:[], failed:[...]}
			// (전 수신처 쓰기 실패)에도 승격이 일어나 배부되지 않은 기사가 완결 처리된다.
			if (result == null || !result.ok() || result.distributed().isEmpty()) {
				return;
			}
			ArticleEmbargoService embargoService = (this.embargo == null) ? null : this.embargo.getIfAvailable();
			if (embargoService != null) {
				embargoService.syncEmbargoStatus(articleId, doneKinds(result), actorUserId);
			}
		}
		catch (RuntimeException ex) {
			// 삼키되 남긴다 — 무음 미배부는 운영이 알 방법이 없다(payload는 담지 않는다).
			logger.warn("send distribution hook failed articleId={} {}", articleId, ex.toString());
		}
	}

	/**
	 * 이 기사에서 <b>이미 배부된 kind</b>(전체 이력 — "역사상 어디로 나갔나"). 조회 실패·미주입은
	 * <b>"아는 배부 이력 없음"</b>으로 폴백한다: 엠바고가 설정된 재송고는 곧바로 배부 없음(안전 기본값)이
	 * 되고, 엠바고 미설정 기사는 이 값을 참조하지 않으므로 조회 장애가 일반 배부를 막지 않는다.
	 */
	private List<String> alreadyDistributedKinds(String articleId) {
		if (this.history == null) {
			return List.of();
		}
		try {
			return EmbargoPolicy.distributedKinds(this.history.queryByArticle(articleId));
		}
		catch (RuntimeException ex) {
			return List.of();
		}
	}

	/** 실제로 나간 kind(중복 제거 · 빈 값 제외) — JS {@code [...new Set(...filter(Boolean))]} 동형. */
	private static List<String> doneKinds(DistributionService.Result result) {
		Set<String> kinds = new LinkedHashSet<>();
		for (DistributionService.Distributed item : result.distributed()) {
			if (item != null && item.kind() != null && !item.kind().isEmpty()) {
				kinds.add(item.kind());
			}
		}
		return List.copyOf(kinds);
	}

	/**
	 * 후속({@code followUp})·계속({@code continue}) 기사 작성 — 원본을 출발점으로 <b>새 기사</b>를 만든다.
	 *
	 * <p><b>원본은 한 글자도 바뀌지 않는다</b>(파생 카운터·마지막 파생 시각 같은 것을 원본에 쓰지 않는다 —
	 * 계약이 원본 두 테이블 전체의 무변을 단언한다). 새 행은 <b>언제나 신규 저장 경로</b>로만 만든다:
	 * 새 {@code articleId} 발급·초기 상태 {@code RDS}·트랜잭션 규율이 한 곳에 있어야 갈라지지 않는다.
	 *
	 * <p>복사 규칙은 <b>실측</b>이다(주석이 아니라 아래 목록이 계약이다): 제목 복사 · 본문은
	 * {@code continue}만 복사하고 {@code followUp}은 빈 문자열 · 공통정보 9키 복사 · 엠바고 2컬럼은 빈
	 * 문자열로 초기화 · <b>부서 2종은 복사하지 않는다</b> · 송고 stamp·{@code distributedAt}·잠금·
	 * {@code modifier}도 복사하지 않는다. 작성자는 <b>파생 실행자</b>이며 호출자가 넘긴다.
	 *
	 * @param sourceArticleId 원본 기사
	 * @param mode {@code followUp} 또는 {@code continue}
	 * @param author 파생 실행자(컨트롤러가 세션 사용자로 stamp한다)
	 */
	public DeriveResult derive(String sourceArticleId, String mode, String author) {
		if (!FOLLOW_UP.equals(mode) && !CONTINUE.equals(mode)) {
			return UNKNOWN_MODE;
		}

		ArticleAggregate source = this.articles.findById(sourceArticleId);
		if (source == null || source.contents() == null) {
			return DERIVE_NOT_FOUND;
		}
		ContentsRow contents = source.contents();

		Map<String, Object> dto = new LinkedHashMap<>();
		dto.put(TITLE, titleOf(source));
		// 후속은 주제만 이어받아 새로 쓰고, 계속은 원문에서 이어쓴다. 값이 없으면 양쪽 다 빈 문자열이다.
		dto.put(MARKUP_VERSION, FOLLOW_UP.equals(mode) ? "" : asText(markupVersionOf(source), ""));
		dto.put("author", author);
		for (String field : DERIVED_COMMON_FIELDS) {
			dto.put(field, contents.column(field));
		}
		// 엠바고는 새 기사에서 새로 설정한다 — 빈 값으로 초기화한다(NULL이 아니다).
		for (String column : EMBARGO_COLUMNS) {
			dto.put(column, "");
		}
		// status·sender·sentAt·editedAt·distributedAt·잠금·부서·articleId는 dto에 넣지 않는다:
		// 신규 저장이 새 id와 RDS를 강제하고, 송고·배부·잠금 이력은 새 기사에 없다.

		return new DeriveResult(true, this.writeService.create(dto, null, null), null);
	}

	/**
	 * 엠바고 후처리 — 전이표는 순수하게 두고({@code RDS}/{@code DDH} + D·Z + send = {@code DPS}) 여기서만
	 * {@code DES}로 바꾼다.
	 *
	 * <p>{@code DDH} 경로를 포함하는 이유: 보류된 엠바고 기사도 송고 순간은 "엠바고 배부 대기"다 — 빠지면
	 * 그 기사가 {@code DPS}로 떨어져 언론사·비언론사 전량이 즉시 배부된다(엠바고 누수). 반대로 R의 송고는
	 * 전이 결과가 {@code RDS}라 이 분기에 들어오지 않는다.
	 */
	private static String embargoAware(String tableStatus, String fromStatus, String role, String action,
			ContentsRow contents) {
		if (!SEND.equals(action) || !"DPS".equals(tableStatus)) {
			return tableStatus;
		}
		if (!DES_ENTRY_STATUSES.contains(fromStatus) || !("D".equals(role) || "Z".equals(role))) {
			return tableStatus;
		}
		return embargoSet(contents) ? "DES" : tableStatus;
	}

	/** 두 컬럼 중 하나라도 값이 있는가. 빈 문자열은 미설정이다(Node falsy 의미론). */
	private static boolean embargoSet(ContentsRow contents) {
		for (String column : EMBARGO_COLUMNS) {
			Object value = contents.column(column);
			if (value != null && !String.valueOf(value).isEmpty()) {
				return true;
			}
		}
		return false;
	}

	/** 본문은 {@code Article} 행에 있다. 그 행이 없으면 마커도 없고 복사할 본문도 없다. */
	private static Object markupVersionOf(ArticleAggregate found) {
		return (found.article() == null) ? null : found.article().get(MARKUP_VERSION);
	}

	private static String titleOf(ArticleAggregate found) {
		return (found.article() == null) ? null : asText(found.article().get(TITLE));
	}

	private static String asText(Object value) {
		return (value == null) ? null : String.valueOf(value);
	}

	private static String asText(Object value, String fallback) {
		return (value == null) ? fallback : String.valueOf(value);
	}

	/**
	 * 액션 적용 결과. 성공이면 <b>저장된 최종 상태</b>만, 거부면 사유 토큰만 채워진다 — 서블릿·SQL 타입을
	 * 참조하지 않는 순수 값이다(사유 토큰 → 상태코드 매핑은 web 계층의 표가 한다).
	 */
	public record ActionResult(boolean ok, String status, String reason) {
	}

	/** 파생 결과. 성공이면 <b>새로 발급된</b> {@code articleId}만, 거부면 사유 토큰만 채워진다. */
	public record DeriveResult(boolean ok, String articleId, String reason) {
	}

}
