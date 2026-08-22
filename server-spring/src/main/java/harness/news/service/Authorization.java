package harness.news.service;

import harness.news.model.ArticleRepository;
import java.util.List;
import java.util.Map;
import java.util.Set;
import org.springframework.stereotype.Service;

/**
 * 인가(capability) 게이트 — 리포 루트 {@code src/services/authorization.js}와 동형이다. HTTP 비의존이며
 * 사유 토큰만 돌려준다(상태코드 매핑은 web 계층 {@code ReasonStatus}의 몫이다).
 *
 * <h2>CRITICAL — acting role은 검증된 세션에서만 도출한다(ADR-004)</h2>
 * 이 클래스의 공개 API는 <b>role을 파라미터로 받지 않는다</b>. role은 오직 {@link SessionGuard}가
 * 매 호출 User 행을 다시 읽어 만든 신원에서 읽는다. 그래서
 * <ul>
 *   <li>요청 본문·헤더·쿼리의 {@code role}은 판정에 <b>닿을 방법이 구조적으로 없고</b>(누구나 Z가 되는 경로 차단),</li>
 *   <li>강등·비활성화가 <b>재로그인 없이 다음 요청부터</b> 반영된다
 *       ({@code contract/cases/default/session-guard.contract.js}가 동결한 축).</li>
 * </ul>
 * Node는 {@code assertAuthorized(role, capability)}를 함께 export하지만 여기서는 <b>일부러 비공개</b>다 —
 * role을 받는 공개 진입점이 하나라도 있으면 위 불변식이 호출자 규율로 내려앉는다.
 *
 * <h2>표 구조는 Node와 동형이다</h2>
 * 이 phase가 쓰는 행은 {@code manageUsers: [Z]} · {@code viewLogs: [Z]} · {@code editDps: [D]} 셋이다.
 * 나머지 capability(수신 설정·배부)는
 * 그 라우트를 소유하는 phase가 <b>행만</b> 추가한다 — 도달하지 않는 행을 미리 적어 두면 검증되지 않은
 * 인가 표가 쌓이고, 나중에 "이미 맞다"는 착시를 준다.
 */
@Service
public class Authorization {

	/** 사용자(USER) 관리 — Z 전용. */
	public static final String MANAGE_USERS = "manageUsers";

	/**
	 * 서버 로그 열람 — Z 전용(ADR-007). 로그는 <b>전 사용자의 요청 흔적</b>이라 R/D에게 열면 안 된다.
	 *
	 * <p>Node는 이 게이트를 라우트 안에서 {@code me.role !== 'Z'}로 직접 판정한다
	 * ({@code server/index.js} 1168~1175행) — 표에 행이 없다. 여기서는 <b>같은 규칙을 표의 행으로</b>
	 * 표현한다: acting role을 판정하는 자리가 라우트마다 흩어지면 한 곳만 빠뜨려도 그대로 노출이고,
	 * 표에 모이면 "누가 무엇을 할 수 있는가"를 한눈에 감사할 수 있다. 관측 결과(미인증 401 · 비-Z 403)는
	 * Node와 바이트 동일하다.
	 */
	public static final String VIEW_LOGS = "viewLogs";

	/**
	 * DPS 기사의 고침/포털고침 <b>편집 진입</b> — D 전용(news.md 권한 규칙 ·
	 * {@code src/services/authorization.js} {@code editDps: ['D']}).
	 *
	 * <p>Z를 넣지 마라: 관리자는 사용자·설정을 관리하지만 <b>송고된 기사의 본문을 고치는 권한</b>은
	 * 데스크의 것이다. 넓히는 순간 권한 모델이 코드와 명세로 갈라진다.
	 */
	public static final String EDIT_DPS = "editDps";

	/**
	 * 수집(자동기사) 수신 설정 관리 — Z 전용({@code src/services/authorization.js}
	 * {@code manageReceiverConfig: ['Z']}). phase 70이 receiver-config 3라우트를 구현하며 추가한 행이다.
	 */
	public static final String MANAGE_RECEIVER_CONFIG = "manageReceiverConfig";

	/** capability → 허용 역할. 표에 없는 capability는 거부다(기본값이 허용이면 오타 한 번이 게이트를 연다). */
	static final Map<String, List<String>> CAPABILITIES = Map.of(
			MANAGE_USERS, List.of("Z"),
			VIEW_LOGS, List.of("Z"),
			EDIT_DPS, List.of("D"),
			MANAGE_RECEIVER_CONFIG, List.of("Z"));

	/** 고침/포털고침으로 인정하는 액션(Node {@code REVISE_ACTIONS}). 그 밖의 값은 어휘 밖이다. */
	private static final Set<String> REVISE_ACTIONS = Set.of("revise", "portalRevise");

	/** 편집 진입 게이트가 발동하는 상태 — 송고 완료 기사다. */
	private static final String SENT_STATUS = "DPS";

	private final SessionGuard sessions;

	private final ArticleRepository articles;

	public Authorization(SessionGuard sessions, ArticleRepository articles) {
		this.sessions = sessions;
		this.articles = articles;
	}

	/**
	 * 인가 판정 결과 — 성공이면 사유가 없고, 실패면 사유 토큰만 있다.
	 * 신원을 담지 않는 것은 의도다: 게이트가 "누구인지"를 흘리기 시작하면 거부 경로에서도 신원이 새어
	 * 나가고, 필요한 라우트는 가드에 직접 물어보면 된다(재조회는 멱등이다).
	 */
	public record Decision(boolean ok, String reason) {

		private static Decision deny(String reason) {
			return new Decision(false, reason);
		}

		private static final Decision ALLOWED = new Decision(true, null);
	}

	/**
	 * 세션 토큰이 이 capability를 수행할 수 있는가.
	 *
	 * <p>판정 순서는 Node와 같다: <b>세션 검증이 먼저</b>고(미인증에는 capability의 존재 여부조차
	 * 알려주지 않는다) 그다음이 표 조회다.
	 *
	 * @param sessionToken 쿠키·헤더에서 읽은 세션 토큰(없으면 {@code null})
	 * @param capability {@link #CAPABILITIES}의 키
	 * @return 거부 사유는 미인증 {@code unauthenticated} · 역할 불일치 {@code forbidden} ·
	 *     미정의 capability {@code unknown-capability}
	 */
	public Decision authorize(String sessionToken, String capability) {
		Identity actor = (sessionToken == null) ? null : this.sessions.touchSession(sessionToken);
		if (actor == null) {
			return Decision.deny("unauthenticated");
		}
		return allow(actor.role(), capability);
	}

	/**
	 * DPS 기사의 편집 진입 게이트 — {@code src/services/authorization.js}의 {@code editDps}와 1:1이다.
	 *
	 * <h2>판정 순서가 계약이다</h2>
	 * 세션({@code unauthenticated}) → 액션 어휘({@code unknown-action}) → 기사 존재
	 * ({@code not-found}) → 상태({@code not-dps}) → 역할({@code forbidden}). 순서가 바뀌면 같은 요청이
	 * 다른 상태코드를 받는다(index.json decisions (12)).
	 *
	 * <h2>{@code not-dps}는 거부가 아니라 "이 게이트의 대상이 아니다"라는 신호다</h2>
	 * 호출자(잠금 라우트)는 그 사유를 <b>통과</b>로 해석한다 — 일반 기사는 인증된 R/D/Z가 잠글 수 있다.
	 * 여기서 {@code ok:true}로 만들지 않는 이유는 정본과 사유 토큰을 맞추기 위해서다(그리고 "DPS 기사에
	 * 대한 D의 허가"와 "게이트 미적용"은 실제로 다른 사실이다).
	 *
	 * <p>기사 존재는 <b>{@code Contents} 행의 존재</b>다(정본 {@code !row || !row.contents}) —
	 * {@code Article} 행만 있는 기사는 없는 기사다.
	 *
	 * @param sessionToken 쿠키·헤더에서 읽은 세션 토큰(없으면 {@code null})
	 * @param articleId 편집 진입 대상
	 * @param action {@code revise} 또는 {@code portalRevise}. 그 밖의 값은 {@code unknown-action}이다
	 *     (라우트가 본문 값을 두 어휘로 정규화하므로 HTTP로는 도달하지 않는다 — 정본과 같은 fail-closed
	 *     기본값이며, 다른 호출자가 생겼을 때 조용히 통과하지 않게 한다)
	 */
	public Decision editDps(String sessionToken, String articleId, String action) {
		Identity actor = (sessionToken == null) ? null : this.sessions.touchSession(sessionToken);
		if (actor == null) {
			return Decision.deny("unauthenticated");
		}
		if (action == null || !REVISE_ACTIONS.contains(action)) {
			return Decision.deny("unknown-action");
		}
		ArticleRepository.StatusLookup found = this.articles.findStatus(articleId);
		if (!found.present()) {
			return Decision.deny("not-found");
		}
		if (!SENT_STATUS.equals(found.status())) {
			return Decision.deny("not-dps");
		}
		return allow(actor.role(), EDIT_DPS);
	}

	/**
	 * 표 조회 — role은 <b>이미 세션에서 도출된 값</b>만 들어온다(비공개인 이유는 클래스 주석 참조).
	 * 판정 지점이 하나라 capability마다 규칙이 갈라질 자리가 없다.
	 */
	private Decision allow(String role, String capability) {
		List<String> allowed = CAPABILITIES.get(capability);
		if (allowed == null) {
			return Decision.deny("unknown-capability");
		}
		if (!allowed.contains(role)) {
			return Decision.deny("forbidden");
		}
		return Decision.ALLOWED;
	}
}
