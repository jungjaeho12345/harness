package harness.news.service;

import harness.news.model.ArticleAggregate;
import harness.news.model.ArticleRepository;
import harness.news.model.ContentsRow;
import java.time.Clock;
import org.springframework.stereotype.Service;

/**
 * <b>편집 잠금</b> 서비스 — 리포 루트 {@code src/services/articleService.js}의
 * {@code acquireEditLock}·{@code releaseEditLock}·{@code forceReleaseEditLock}·
 * {@code assertLockHolder} 4연산과 1:1 이식이다. HTTP 비의존이며(ADR-006) 서블릿 타입을 알지 못한다 —
 * 신원과 탭은 {@link Requester}로만 받고, 사유 토큰을 상태코드로 옮기는 것은 web 계층의 몫이다
 * ({@code locked} 401 · {@code not-holder} 403 · {@code not-found} 404 — decisions (19)).
 *
 * <h2>보유자 모델</h2>
 * 보유자 식별자는 <b>편집 탭</b>({@code x-edit-client} 헤더의 {@code clientId})이지만 <b>인가는 탭
 * 문자열 하나로 하지 않는다</b>(ADR-004): 반드시 검증된 세션의 {@code userId}와 잠금 행의
 * {@code lockerUserId}를 함께 대조한다. 탭 식별자는 클라이언트가 만든 문자열이라, 그것 하나로 인가하면
 * 남의 탭 문자열을 아는 사람이 남의 잠금을 푼다.
 * <ul>
 *   <li><b>획득</b>: 잠겨 있고 stale이 아니면 <b>같은 탭</b>(F5 새로고침)이거나 <b>같은 사용자의 다른
 *       세션</b>(재로그인 takeover)일 때만 통과하고 그 외에는 {@code locked}다. 통과하면 5컬럼을 현재
 *       시각으로 다시 세팅한다(재획득도 시각을 갱신해 TTL을 되감는다).</li>
 *   <li><b>해제</b>: 잠겨 있지 않으면 <b>멱등 성공</b>이다(탭 닫기·pagehide가 중복 호출한다). 잠겨
 *       있으면 사용자 대조 → 탭 대조(행의 탭이 비어 있으면 건너뛴다) → 해제.</li>
 *   <li><b>강제 해제</b>: 보유자와 무관하게 푼다. <b>권한(D/Z) 판정은 여기 없다</b> — 기사 상태와 역할을
 *       보는 게이트는 HTTP 계층이 소유한다(두 곳에 두면 판정이 갈라진다).</li>
 *   <li><b>보유자 검사</b>(저장 인가): 보유 탭 + 보유자 본인만 통과한다. TTL은 보지 않는다 — 30분 넘게
 *       편집하던 보유자의 저장을 막지 않는다(TTL은 획득 경쟁에만 쓰인다).</li>
 * </ul>
 *
 * <h2>이 서비스가 하지 않는 것</h2>
 * <ul>
 *   <li><b>세션 일치 강제</b> — 해제·보유자 검사는 {@code sessionId}를 판정에 쓰지 않는다. 강제하면
 *       세션이 갱신된 편집자가 자기 잠금을 놓지도 저장하지도 못해 30분간 편집물이 유실된다.</li>
 *   <li><b>"값이 없으면 통과" 폴백</b> — 요청 신원이 없거나 잠금 행의 보유자 id가 비어 있으면
 *       <b>거부</b>다. 그 폴백이 곧 아무나 남의 잠금을 푸는 구멍이며, 그런 잠금을 푸는 수단은 강제
 *       해제와 30분 stale 재획득으로 이미 있다.</li>
 *   <li><b>보유자 노출</b> — 실패는 {@code locked}/{@code not-holder} 토큰뿐이고 결과 타입에 보유자
 *       식별자를 담을 자리가 없다(누가 잠갔는지 알려주지 않는 것이 계약이고, 탭 식별자는 사칭 재료다).</li>
 *   <li><b>읽기 서비스 경유</b> — 리포지토리를 직접 부른다. 재로그인 판정에 <b>투영되지 않은</b>
 *       {@code lockerSessionId}가 필요하고 응답 투영은 그 컬럼을 지운다(decisions (4)).</li>
 *   <li><b>행 삭제</b> — 해제는 5컬럼 갱신이다(DB 비파괴 최상위 규칙).</li>
 * </ul>
 *
 * <p>값 비교는 전부 {@link LockValues}를 거친다 — DB NULL과 헤더 부재를 같다고 보는 순간 인가가 열린다
 * (decisions (11)).
 */
@Service
public class EditLockService {

	private static final String LOCK_YN = "lockYN";

	private static final String LOCKER_USER_ID = "lockerUserId";

	private static final String LOCKER_SESSION_ID = "lockerSessionId";

	private static final String LOCKER_CLIENT_ID = "lockerClientId";

	private static final String LOCKED_AT = "lockedAt";

	private final ArticleRepository articles;

	private final Clock clock;

	public EditLockService(ArticleRepository articles, Clock clock) {
		this.articles = articles;
		this.clock = clock;
	}

	/**
	 * 편집 잠금 획득. 잠겨 있어도 stale(30분 무갱신)이면 가져갈 수 있고, 실패 사유는 누가 잠갔는지를
	 * 밝히지 않는 {@code locked} 하나다.
	 *
	 * @return 성공 또는 {@code locked}/{@code not-found}
	 */
	public LockResult acquire(String articleId, Requester who) {
		ContentsRow row = lockRowOf(articleId);
		if (row == null) {
			return LockResult.notFound();
		}

		boolean held = LockValues.held(row.column(LOCK_YN), row.column(LOCKER_CLIENT_ID));
		if (held && !EditLockTtl.isStale(row.column(LOCKED_AT), this.clock)) {
			// 같은 탭(clientId)이면 재획득(F5 새로고침) — 허용.
			boolean sameTab = LockValues.same(row.column(LOCKER_CLIENT_ID), who.clientId());
			// 같은 사용자가 다른 세션으로 재로그인 — 이전 세션은 만료된 것으로 보고 takeover 허용.
			boolean sameUserReLogin = LockValues.same(row.column(LOCKER_USER_ID), who.userId())
					&& LockValues.differs(row.column(LOCKER_SESSION_ID), who.sessionId());
			// 같은 세션의 다른 탭 등 그 외는 차단(다른 사용자 포함) — 한 사용자가 여러 탭에서 동시 편집 금지.
			if (!sameTab && !sameUserReLogin) {
				return LockResult.locked();
			}
		}

		this.articles.setLock(articleId, new ArticleRepository.EditLock(who.userId(), who.sessionId(),
				who.clientId(), Iso8601.now(this.clock)));
		return LockResult.success();
	}

	/**
	 * 편집 잠금 해제 — 보유자(검증 세션의 {@code userId} + 보유 탭)만 푼다. 이미 해제된 잠금의 해제는
	 * <b>멱등 성공</b>이고 아무것도 쓰지 않는다.
	 *
	 * <p>{@code sessionId}는 판정에 쓰지 않는다(같은 사용자의 재로그인을 허용하기 위한 관용도이며
	 * {@code acquire}의 takeover와 짝이다).
	 *
	 * @return 성공 또는 {@code not-holder}/{@code not-found}
	 */
	public LockResult release(String articleId, Requester who) {
		ContentsRow row = lockRowOf(articleId);
		if (row == null) {
			return LockResult.notFound();
		}
		if (!LockValues.flagSet(row.column(LOCK_YN))) {
			return LockResult.success(); // 멱등 — 탭 닫기·pagehide가 중복 호출한다.
		}
		if (!LockValues.present(who.userId()) || !LockValues.present(row.column(LOCKER_USER_ID))) {
			return LockResult.notHolder(); // 신원 미상(레거시 잠금 행 포함) → 거부.
		}
		if (!LockValues.same(row.column(LOCKER_USER_ID), who.userId())) {
			return LockResult.notHolder(); // 남의 탭 문자열을 알아도 사람이 다르면 거부.
		}
		if (LockValues.releaseTabMismatch(row.column(LOCKER_CLIENT_ID), who.clientId())) {
			return LockResult.notHolder(); // 탭 규칙 — 행의 탭이 비어 있을 때만 건너뛴다.
		}

		this.articles.clearLock(articleId);
		return LockResult.success();
	}

	/**
	 * 강제 해제 — 보유자와 무관하게 푼다. 잠겨 있지 않은 기사도 성공이며 <b>존재만 확인</b>한다.
	 * 권한(D/Z) 게이트는 HTTP 계층 책임이다.
	 *
	 * @return 성공 또는 {@code not-found}
	 */
	public LockResult forceRelease(String articleId) {
		if (lockRowOf(articleId) == null) {
			return LockResult.notFound();
		}
		this.articles.clearLock(articleId);
		return LockResult.success();
	}

	/**
	 * 저장 인가 — 이 편집 탭이 잠금 보유자인가. 같은 사용자의 2번째 탭도 저장하지 못한다.
	 *
	 * <p><b>존재 판정이 잠금 판정보다 먼저다</b>(없는 기사는 403이 아니라 404다 — decisions (12)).
	 * TTL은 보지 않는다.
	 *
	 * @return 성공 또는 {@code not-holder}/{@code not-found}
	 */
	public LockResult assertHolder(String articleId, Requester who) {
		ContentsRow row = lockRowOf(articleId);
		if (row == null) {
			return LockResult.notFound();
		}
		if (!LockValues.flagSet(row.column(LOCK_YN))) {
			return LockResult.notHolder();
		}
		if (!LockValues.same(row.column(LOCKER_CLIENT_ID), who.clientId())) {
			return LockResult.notHolder(); // 탭 규칙 — DB NULL과 헤더 부재는 같은 값이 아니다.
		}
		if (!LockValues.present(who.userId()) || !LockValues.present(row.column(LOCKER_USER_ID))) {
			return LockResult.notHolder(); // 신원 미상(레거시 잠금 행 포함) → 거부.
		}
		if (!LockValues.same(row.column(LOCKER_USER_ID), who.userId())) {
			return LockResult.notHolder(); // 남의 탭 문자열을 알아도 사람이 다르면 거부.
		}
		return LockResult.success();
	}

	/**
	 * 판정의 입력이 되는 <b>투영되지 않은</b> {@code Contents} 행. {@code Article} 행만 있고
	 * {@code Contents} 행이 없는 기사는 <b>없는 기사</b>다(정본 {@code !row || !row.contents}).
	 */
	private ContentsRow lockRowOf(String articleId) {
		ArticleAggregate found = this.articles.findById(articleId);
		return (found == null) ? null : found.contents();
	}

	/**
	 * 잠금 요청자 — <b>신원은 검증된 세션에서만</b> 오고({@code userId}·{@code sessionId}) 탭은
	 * {@code x-edit-client} 헤더에서 온다(ADR-004). 이름 있는 필드로 받는 이유는 세 문자열의 자리가
	 * 바뀌면 그것이 곧 인가 사고이기 때문이다(탭 문자열이 {@code lockerUserId} 자리로 들어가는 순간
	 * 사칭이 성립한다).
	 *
	 * <p>정본은 인자 객체를 통째로 생략할 수 있어 {@code = {}} 기본값을 두지만, 여기서는 호출자가
	 * 컨트롤러 하나이고 그 컨트롤러가 세션에서 값을 채워 넣으므로 그 분기를 만들지 않는다(도달하지 않는
	 * 분기는 검증되지 않은 표면이다). 값이 <b>비어 있는</b> 경우는 판정 규칙이 이미 fail-closed로 덮는다.
	 */
	public record Requester(String userId, String sessionId, String clientId) {
	}

	/**
	 * 잠금 4연산의 결과 — 성공은 {@code ok}뿐이고 실패는 <b>사유 토큰 하나</b>다.
	 *
	 * <p>여기에 보유자 {@code userId}·세션·탭을 <b>담지 마라</b>: 누가 잠갔는지 노출하지 않는 것이 계약이고
	 * (성공 응답조차 {@code {ok:true}} 뿐이다), 탭 식별자는 그대로 사칭 재료다. 그래서 필드가 둘뿐이라는
	 * 사실 자체를 테스트가 잠근다.
	 */
	public record LockResult(boolean ok, String reason) {

		static LockResult success() {
			return new LockResult(true, null);
		}

		static LockResult notFound() {
			return new LockResult(false, "not-found");
		}

		static LockResult locked() {
			return new LockResult(false, "locked");
		}

		static LockResult notHolder() {
			return new LockResult(false, "not-holder");
		}
	}
}
