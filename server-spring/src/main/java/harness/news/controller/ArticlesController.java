package harness.news.controller;

import harness.news.service.ArticleReadService;
import harness.news.service.ArticleWriteService;
import harness.news.service.Authorization;
import harness.news.service.EditLockService;
import harness.news.service.Identity;
import harness.news.service.SessionGuard;
import harness.news.web.JsonHttp;
import harness.news.web.ReasonStatus;
import harness.news.web.SessionTokens;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Set;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * 기사 6라우트 — 단건 3개(생성 {@code POST /api/articles} · 조회 {@code GET /api/articles/:id} ·
 * 부분 수정 {@code PUT /api/articles/:id})와 편집 잠금 3개({@code POST /api/articles/:id/lock} ·
 * {@code .../unlock} · {@code .../force-unlock}). 리포 루트 {@code server/index.js}의 같은 6라우트와
 * 1:1이다.
 *
 * <p>여섯이 한 클래스인 이유는 <b>신원 재도출 코드가 하나여야</b> 하기 때문이다: 토큰을 읽는 자리가
 * 여러 벌이면 그중 하나가 드리프트하는 순간 그 라우트가 인가 우회 표면이 된다.
 *
 * <h2>컨트롤러가 하는 일은 넷뿐이다(ADR-006 · index.json decisions (13))</h2>
 * <ol>
 *   <li><b>신원 재도출</b> — 쿠키 우선 · {@code x-session-id} 폴백으로 토큰을 읽고 세션에서 신원을 얻는다.</li>
 *   <li><b>게이트 호출</b> — 생성은 역할 집합(R/D/Z), 수정·해제는 잠금 보유자({@link EditLockService}),
 *       DPS 기사의 편집 진입은 capability 표({@link Authorization#EDIT_DPS}), 강제 해제는 역할 집합(D/Z).</li>
 *   <li><b>신뢰 경계 stamp</b> — 클라 {@code role} 제거 · 빈 부서 → 세션 부서 · 빈 작성자 → 세션 사용자 ·
 *       {@code modifier} = 세션 userId.</li>
 *   <li><b>shape 매핑</b> — {@code {ok:true, …}} 봉투 조립(서비스는 봉투를 만들지 않는다).</li>
 * </ol>
 * 상태 계산·화이트리스트 픽·이력 기록·잠금 정책은 서비스가 소유한다 — 여기서 재구현하지 않는다.
 *
 * <h2>신뢰 경계(ADR-004)</h2>
 * acting role은 <b>검증된 세션</b>에서만 나온다: 본문의 {@code role}은 판정에 쓰이지 않고 dto에서 제거되며,
 * {@code x-edit-client}는 <b>인증 수단이 아니라</b> 잠금 보유 판정의 재료다(세션 userId와 함께 판정한다).
 * 헤더가 없으면 {@code null}을 <b>그대로</b> 넘긴다 — 빈 문자열로 정규화하면 "행의 탭도 비었고 요청의 탭도
 * 비었으니 같다"가 되어 보유자가 아닌 요청이 저장 인가를 얻는다(index.json decisions (11)).
 *
 * <h2>경로 정책 필터가 앞에 있어도 자기 판정을 갖는다</h2>
 * 미인증 401은 필터가 이미 만들지만(그래서 이 컨트롤러의 401은 계약 관측에 잘 나타나지 않는다) 신원이
 * 없으면 여기서도 401을 낸다 — 게이트가 두 층에 각각 있어야 한 층을 비켜간 요청이 인가를 얻지 못한다
 * (decisions (14)). 필터에서 신원을 넘겨받지 않는 이유도 같다(요청 속성 운반은 그 자체가 우회 표면이다).
 *
 * <h2>값을 만지지 않는다</h2>
 * 본문 맵의 값은 <b>그대로</b> 서비스로 간다({@code JsonHttp.text} 같은 문자열 전용 헬퍼로 걸러 {@code null}로
 * 떨구지 않는다 — decisions (8)). 빈 값 판정(부서·작성자 보정)만 Node의 falsy 의미론과 같게 흉내 낸다.
 */
@RestController
public class ArticlesController {

	/** 기사를 만들 수 있는 역할 — 그 밖의 role은 403 {@code forbidden}이다(Node {@code ROLES}). */
	private static final Set<String> WRITE_ROLES = Set.of("R", "D", "Z");

	/**
	 * 남의 잠금을 <b>강제로</b> 풀 수 있는 역할 — 정본은 이 판정을 라우트 안에서 직접 한다
	 * ({@code me.role !== 'D' && me.role !== 'Z'} → 403). capability 표로 올리지 않은 것은 정본과
	 * 같은 자리에 두기 위해서다(표에 없는 행을 만들면 Node와 표가 갈라진다).
	 */
	private static final Set<String> FORCE_UNLOCK_ROLES = Set.of("D", "Z");

	/**
	 * 잠금 라우트 본문의 편집 의도 — {@code portalRevise} <b>정확히 그 문자열</b>만 포털고침이고
	 * 나머지는 전부 고침이다(정의 밖 문자열도 400이 아니라 고침이다 — 정본
	 * {@code req.body?.action === 'portalRevise' ? 'portalRevise' : 'revise'}).
	 */
	private static final String PORTAL_REVISE = "portalRevise";

	private static final String REVISE = "revise";

	/** 편집 탭 식별자 헤더 — 클라이언트가 만든 문자열이라 <b>인증 재료가 아니다</b>. */
	private static final String EDIT_CLIENT_HEADER = "x-edit-client";

	private static final String DEPARTMENT = "department";

	private static final String DEPARTMENT_CODE = "departmentCode";

	private static final String NOT_FOUND = "not-found";

	/** DPS 게이트의 "대상이 아니다" 신호 — 거부가 아니라 <b>통과</b>로 해석한다(정본과 같다). */
	private static final String NOT_DPS = "not-dps";

	private final SessionGuard sessions;

	private final Authorization authorization;

	private final ArticleReadService reads;

	private final ArticleWriteService writes;

	private final EditLockService locks;

	private final JsonHttp json;

	public ArticlesController(SessionGuard sessions, Authorization authorization, ArticleReadService reads,
			ArticleWriteService writes, EditLockService locks, JsonHttp json) {
		this.sessions = sessions;
		this.authorization = authorization;
		this.reads = reads;
		this.writes = writes;
		this.locks = locks;
		this.json = json;
	}

	/**
	 * 신규 저장 — R/D/Z. 응답은 {@code {ok:true, articleId}} <b>정확히 2키</b>다.
	 *
	 * <p>서버가 정하는 값: 초기 {@code status}(세션 role + 의도 {@code action}) · 부서 2종(미전달·빈 값이면
	 * 세션 부서) · 작성자(미전달·빈 값이면 세션 사용자 이름, 없으면 userId) · {@code articleId}.
	 * <b>클라가 명시한 {@code author}는 보존된다</b>(대필 입력 — 무시하면 계약 위반이다).
	 * {@code status}·{@code sender}·{@code articleId}·{@code distributedAt}은 서비스의 화이트리스트를
	 * 통과하지 못해 자연히 빠진다(여기서 개별 삭제하지 않는다 — 삭제 목록은 새 필드마다 누락된다).
	 */
	@PostMapping("/api/articles")
	public void create(HttpServletRequest request, HttpServletResponse response) {
		Identity actor = actorOf(request);
		if (actor == null) {
			deny(request, response, "unauthenticated");
			return;
		}
		if (!WRITE_ROLES.contains(actor.role())) {
			deny(request, response, "forbidden");
			return;
		}

		Map<String, Object> body = this.json.readBody(request);
		Map<String, Object> dto = new LinkedHashMap<>(body);
		dto.remove("role"); // 클라 role은 판정에도 저장에도 쓰이지 않는다.
		if (falsy(dto.get(DEPARTMENT))) {
			dto.put(DEPARTMENT, actor.department());
			dto.put(DEPARTMENT_CODE, actor.departmentCode());
		}
		if (falsy(dto.get("author"))) {
			dto.put("author", falsy(actor.name()) ? actor.userId() : actor.name());
		}

		Map<String, Object> payload = JsonHttp.ok();
		// 의도(action)만 넘긴다 — status는 서비스가 세션 role과 함께 계산한다. 문자열이 아닌 action은
		// Node에서도 'hold'와 같지 않아 기본 RDS로 수렴하므로 여기서 문자열만 읽는 것이 동형이다
		// (저장되는 값이 아니라 분기 입력이다 — 저장 값은 dto에 실려 그대로 간다).
		payload.put("articleId", this.writes.create(dto, actor.role(), JsonHttp.text(body, "action")));
		this.json.write(request, response, 200, payload);
	}

	/**
	 * 단건 조회 — 200 {@code {ok:true, article, contents}} <b>정확히 3키</b>, 없으면 404 {@code not-found}.
	 *
	 * <p>한쪽 테이블 행이 없으면 그 키를 <b>싣지 않는다</b>(decisions (20)①). 그 판단은 읽기 서비스가
	 * 이미 끝냈으므로 여기서는 결과 맵을 봉투 뒤에 그대로 붙인다 — 라우트마다 다시 판단하면 새 라우트에서
	 * 어긋난다. {@code contents}는 투영 27키이며 잠금 비밀 2컬럼은 어떤 경로로도 실리지 않는다.
	 */
	@GetMapping("/api/articles/{id}")
	public void get(@PathVariable String id, HttpServletRequest request, HttpServletResponse response) {
		Identity actor = actorOf(request);
		if (actor == null) {
			deny(request, response, "unauthenticated");
			return;
		}

		Map<String, Object> found = this.reads.getById(id);
		if (found == null) {
			deny(request, response, "not-found");
			return;
		}
		Map<String, Object> payload = JsonHttp.ok();
		payload.putAll(found);
		this.json.write(request, response, 200, payload);
	}

	/**
	 * 부분 수정 — 세션 → <b>존재(404) → 보유자(403 {@code not-holder})</b> → 저장 → 200
	 * {@code {ok:true, changes}}. 게이트 순서가 계약이다(없는 기사는 403이 아니라 404다).
	 *
	 * <p>{@code changes}는 두 갱신문의 영향 행 수 <b>합</b>이며 계약 리포트가 그 정수를 비교한다.
	 * {@code modifier}는 <b>세션 사용자로 덮어쓴다</b>(클라 값은 감사 위조 재료다). 부서 키가 있는데 값이
	 * 비어 있으면 세션 부서로 보정하고, 키가 <b>아예 없으면</b> 건드리지 않는다(부분 수정이 남의 필드를
	 * 덮지 않는다).
	 */
	@PutMapping("/api/articles/{id}")
	public void update(@PathVariable String id, HttpServletRequest request, HttpServletResponse response) {
		String token = tokenOf(request);
		Identity actor = (token == null) ? null : this.sessions.touchSession(token);
		if (actor == null) {
			deny(request, response, "unauthenticated");
			return;
		}

		EditLockService.LockResult holder = this.locks.assertHolder(id, requesterOf(request, actor, token));
		if (!holder.ok()) {
			deny(request, response, holder.reason());
			return;
		}

		Map<String, Object> fields = new LinkedHashMap<>(this.json.readBody(request));
		fields.put("modifier", actor.userId());
		fields.remove("role");
		if (fields.containsKey(DEPARTMENT) && falsy(fields.get(DEPARTMENT))) {
			fields.put(DEPARTMENT, actor.department());
			fields.put(DEPARTMENT_CODE, actor.departmentCode());
		}

		Map<String, Object> payload = JsonHttp.ok();
		payload.put("changes", this.writes.update(id, fields));
		this.json.write(request, response, 200, payload);
	}

	/**
	 * 편집 잠금 획득 — 세션 → (본문 {@code action} 정규화) → <b>DPS 게이트</b> → 잠금 서비스.
	 * 성공 응답은 {@code {ok:true}} <b>1키</b>이고 실패는 사유 토큰뿐이다(누가 잠갔는지 밝히지 않는다).
	 *
	 * <p>게이트 순서: 존재 <b>404</b> → DPS면 역할 <b>403 {@code forbidden}</b>(D 전용 — Z도 못 들어간다)
	 * → 잠금 충돌 <b>401 {@code locked}</b>. {@code not-dps}는 "이 게이트의 대상이 아니다"라는 신호이므로
	 * <b>통과</b>다(일반 기사는 인증된 R/D/Z가 잠근다). 이미 잠긴 DPS 기사에 대한 비-D의 요청은 401이
	 * 아니라 403이다 — 역할 판정이 잠금 판정보다 앞에 있기 때문이다.
	 *
	 * <p>잠금 획득은 <b>상태 전이를 일으키지 않는다</b>(DPS 기사를 잠가도 상태는 DPS다) — 전이는
	 * {@code POST /api/articles/:id/action}의 몫이다.
	 */
	@PostMapping("/api/articles/{id}/lock")
	public void lock(@PathVariable String id, HttpServletRequest request, HttpServletResponse response) {
		String token = tokenOf(request);
		Identity actor = (token == null) ? null : this.sessions.touchSession(token);
		if (actor == null) {
			deny(request, response, "unauthenticated");
			return;
		}

		String action = PORTAL_REVISE.equals(this.json.readBody(request).get("action")) ? PORTAL_REVISE : REVISE;
		Authorization.Decision probe = this.authorization.editDps(token, id, action);
		if (NOT_FOUND.equals(probe.reason())) {
			deny(request, response, NOT_FOUND);
			return;
		}
		if (!probe.ok() && !NOT_DPS.equals(probe.reason())) {
			deny(request, response, probe.reason()); // DPS인데 비-D 등 → forbidden
			return;
		}

		EditLockService.LockResult acquired = this.locks.acquire(id, requesterOf(request, actor, token));
		if (!acquired.ok()) {
			deny(request, response, acquired.reason()); // locked → 401(423·409가 아니다)
			return;
		}
		this.json.write(request, response, 200, JsonHttp.ok());
	}

	/**
	 * 편집 잠금 해제 — 보유 탭 + 보유자 본인만 푼다. <b>이미 해제됐어도 200</b>이다(탭 닫기·pagehide가
	 * 중복 호출하는 멱등 계약이라 4xx로 만들면 안 된다). 다른 사용자·다른 탭은 403 {@code not-holder},
	 * 없는 기사는 404다.
	 *
	 * <p>신원({@code userId})은 오직 검증된 세션에서 온다(ADR-004) — 남의 탭 문자열을 아는 사람이 남의
	 * 잠금을 풀지 못한다. 멱등·탭 관용 규칙은 잠금 서비스가 소유한다(여기서 복제하면 판정이 갈라진다).
	 */
	@PostMapping("/api/articles/{id}/unlock")
	public void unlock(@PathVariable String id, HttpServletRequest request, HttpServletResponse response) {
		String token = tokenOf(request);
		Identity actor = (token == null) ? null : this.sessions.touchSession(token);
		if (actor == null) {
			deny(request, response, "unauthenticated");
			return;
		}

		EditLockService.LockResult released = this.locks.release(id, requesterOf(request, actor, token));
		if (!released.ok()) {
			deny(request, response, released.reason());
			return;
		}
		this.json.write(request, response, 200, JsonHttp.ok());
	}

	/**
	 * 강제 해제 — D/Z 전용. 보유자와 무관하게 풀고 잠기지 않은 기사도 200이다.
	 *
	 * <p><b>역할 판정이 존재 검사보다 먼저다</b>(decisions (12)): R은 없는 기사에도 404가 아니라 403을
	 * 받는다. 순서를 뒤집으면 권한 없는 사용자가 <b>기사의 존재 여부</b>를 알아내는 관측 경로가 생긴다.
	 * 탭 헤더는 읽지 않는다 — 보유자와 무관한 연산이라 판정 재료가 아니다.
	 */
	@PostMapping("/api/articles/{id}/force-unlock")
	public void forceUnlock(@PathVariable String id, HttpServletRequest request, HttpServletResponse response) {
		Identity actor = actorOf(request);
		if (actor == null) {
			deny(request, response, "unauthenticated");
			return;
		}
		if (!FORCE_UNLOCK_ROLES.contains(actor.role())) {
			deny(request, response, "forbidden");
			return;
		}

		EditLockService.LockResult released = this.locks.forceRelease(id);
		if (!released.ok()) {
			deny(request, response, released.reason());
			return;
		}
		this.json.write(request, response, 200, JsonHttp.ok());
	}

	/**
	 * 요청의 신원 — 쿠키 우선 · {@code x-session-id} 폴백. 토큰이 없거나 세션이 죽었으면 {@code null}이다
	 * ({@link SessionTokens}는 요청 객체를 받지 않으므로 쿼리를 읽을 방법이 구조적으로 없다).
	 */
	private Identity actorOf(HttpServletRequest request) {
		String token = tokenOf(request);
		return (token == null) ? null : this.sessions.touchSession(token);
	}

	/**
	 * 세션 토큰 원문 — 읽는 자리가 <b>하나</b>여야 한다. 라우트마다 헤더를 따로 읽으면 그중 하나가
	 * 드리프트하는 순간(예: 쿼리 폴백 추가) 그 라우트가 인가 우회 표면이 된다.
	 */
	private static String tokenOf(HttpServletRequest request) {
		return SessionTokens.read(request.getHeader("cookie"), request.getHeader(SessionTokens.HEADER_NAME));
	}

	/**
	 * 잠금 판정의 입력 — 신원 2개는 <b>검증된 세션</b>에서, 탭은 {@code x-edit-client} 헤더에서 온다.
	 *
	 * <p>헤더가 없으면 {@code null}을 <b>그대로</b> 넘긴다: 빈 문자열로 정규화하면 "행의 탭도 비었고
	 * 요청의 탭도 비었으니 같다"가 되어 보유자가 아닌 요청이 인가를 얻는다(decisions (11)).
	 */
	private static EditLockService.Requester requesterOf(HttpServletRequest request, Identity actor, String token) {
		return new EditLockService.Requester(actor.userId(), token, request.getHeader(EDIT_CLIENT_HEADER));
	}

	/** 거부 응답 — 사유 토큰이 상태코드를 정한다({@link ReasonStatus}). */
	private void deny(HttpServletRequest request, HttpServletResponse response, String reason) {
		this.json.write(request, response, ReasonStatus.of(reason), JsonHttp.fail(reason));
	}

	/**
	 * Node의 falsy 판정({@code !value})과 같은 의미 — 부서·작성자 보정의 조건이다.
	 *
	 * <p>{@code undefined}(키 없음)·{@code null}·빈 문자열·{@code 0}·{@code NaN}·{@code false}가 빈 값이다.
	 * "null만 빈 값"으로 좁히면 {@code {"department":""}}가 그대로 저장되어 부서 없는 기사가 생긴다
	 * (계약이 관측하는 자리다 — {@code articles-write.contract.js}의 빈 부서 보정).
	 */
	private static boolean falsy(Object value) {
		if (value == null || "".equals(value) || Boolean.FALSE.equals(value)) {
			return true;
		}
		if (value instanceof Number number) {
			double d = number.doubleValue();
			return d == 0.0 || Double.isNaN(d);
		}
		return false;
	}
}
