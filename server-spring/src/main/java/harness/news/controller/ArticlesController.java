package harness.news.controller;

import harness.news.service.ArticleLifecycleService;
import harness.news.service.ArticleReadService;
import harness.news.service.ArticleWriteService;
import harness.news.service.Authorization;
import harness.news.service.ChangeBus;
import harness.news.service.EditLockService;
import harness.news.service.Identity;
import harness.news.service.SessionGuard;
import harness.news.service.TranslationService;
import harness.news.web.JsonHttp;
import harness.news.web.NodeNumber;
import harness.news.web.ReasonStatus;
import harness.news.web.SessionTokens;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * 기사 13라우트 — 단건 3개(생성 {@code POST /api/articles} · 조회 {@code GET /api/articles/:id} ·
 * 부분 수정 {@code PUT /api/articles/:id}) · 편집 잠금 3개({@code POST /api/articles/:id/lock} ·
 * {@code .../unlock} · {@code .../force-unlock}) · 생애주기 2개({@code POST /api/articles/:id/action} ·
 * {@code .../derive}) · 조회 4개(검색 {@code GET /api/articles/search} · 목록 {@code GET /api/articles} ·
 * 이력 {@code GET /api/articles/:id/history} · 스냅샷 {@code .../history/:historyId}) ·
 * <b>번역 1개</b>({@code POST /api/articles/:id/translate} — phase 73 step9).
 * 리포 루트 {@code server/index.js}의 같은 13라우트와 1:1이다.
 *
 * <p>열셋이 한 클래스인 이유는 <b>신원 재도출 코드가 하나여야</b> 하기 때문이다: 토큰을 읽는 자리가
 * 여러 벌이면 그중 하나가 드리프트하는 순간 그 라우트가 인가 우회 표면이 된다. 번역이 미디어·업로드와
 * 다른 클래스에 있는 것도 같은 이유다 — 경로가 {@code /api/articles/:id/...}라 신원 재도출이 여기 있어야
 * 한다(index.json decisions (17)).
 *
 * <h2>컨트롤러가 하는 일은 넷뿐이다(ADR-006 · index.json decisions (13))</h2>
 * <ol>
 *   <li><b>신원 재도출</b> — 쿠키 우선 · {@code x-session-id} 폴백으로 토큰을 읽고 세션에서 신원을 얻는다.</li>
 *   <li><b>게이트 호출</b> — 생성·전이·파생은 역할 집합(R/D/Z), 수정·해제는 잠금 보유자
 *       ({@link EditLockService}), DPS 기사의 편집 진입은 capability 표({@link Authorization#EDIT_DPS}),
 *       강제 해제는 역할 집합(D/Z).</li>
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

	/**
	 * 기사를 만들고 전이·파생시킬 수 있는 역할 — 그 밖의 role은 403 {@code forbidden}이다
	 * (Node {@code ROLES}).
	 *
	 * <p>이 게이트를 빼면 안 된다: {@link ArticleLifecycleService}는 표 밖 role에
	 * {@code unknown-role}을 돌려주는데 그 토큰은 이 phase의 {@link ReasonStatus} 표에 <b>없다</b>
	 * (index.json decisions (19) — 도달하지 않는 토큰을 미리 적지 않는다). 게이트가 사라지면 그 사유가
	 * 라우트 폴백(action은 409)을 타고 새 shape으로 나간다.
	 */
	private static final Set<String> WRITE_ROLES = Set.of("R", "D", "Z");

	/**
	 * 생애주기 액션 어휘 — 정본 {@code ACTION_SET}. <b>문자열 비교</b>다: 본문 값이 문자열이 아니면
	 * 어휘에 없으므로 400이다(Node의 {@code Set.has(비문자열)}과 같은 결과).
	 */
	private static final Set<String> ACTIONS = Set.of("send", "hold", "kill", "approveDelete");

	/** 파생 모드 어휘 — 정본 {@code DERIVE_MODE_SET}. */
	private static final Set<String> DERIVE_MODES = Set.of("followUp", "continue");

	/**
	 * {@code action} 라우트의 실패 폴백 — 전역 400이 아니라 <b>409</b>다(정본
	 * {@code fail(res, r, 409)}). {@code not-found} 404 · {@code no-end-marker} 400처럼 표에 있는
	 * 토큰은 표가 이기고, 표에 없는 사유는 409로 나간다. {@code derive}는 정본이 {@code fail(res, r)}이라
	 * 전역 폴백 400을 그대로 쓴다 — <b>두 라우트의 폴백이 다르다</b>.
	 */
	private static final int ACTION_FALLBACK = 409;

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

	private final ArticleLifecycleService lifecycle;

	private final TranslationService translation;

	private final JsonHttp json;

	/**
	 * 무효화 신호 버스 — <b>생성자 주입</b>이다(ADR-013 · 필드 주입·정적 참조 금지).
	 *
	 * <p>신호는 <b>transport에서만</b> 낸다. 서비스층으로 내리면 같은 서비스를 부르는 다른 경로(송고 훅
	 * 안의 엠바고 승격 등)에서 <b>Node에 없는 신호</b>가 추가로 나가고, 그것은 계약이 관측하지 못한다
	 * ({@code docs/api-contract/sse.md}가 "송고 훅의 비동기 엠바고 승격은 자체 신호를 내지 않는다"로
	 * 동결한 축이다).
	 *
	 * <p>넘기는 것은 <b>kind 문자열 하나</b>뿐이다 — 행 데이터를 실으면 ADR-005의 "무효화 신호에는 행
	 * 데이터가 없다"가 깨지고, 컨트롤러가 모델 타입을 알게 되는 경로도 함께 열린다(ADR-006).
	 */
	private final ChangeBus changes;

	public ArticlesController(SessionGuard sessions, Authorization authorization, ArticleReadService reads,
			ArticleWriteService writes, EditLockService locks, ArticleLifecycleService lifecycle,
			TranslationService translation, JsonHttp json, ChangeBus changes) {
		this.sessions = sessions;
		this.authorization = authorization;
		this.reads = reads;
		this.writes = writes;
		this.locks = locks;
		this.lifecycle = lifecycle;
		this.translation = translation;
		this.json = json;
		this.changes = changes;
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
		// 성공 분기에서만, 응답을 쓰기 **직전**에(Node 867행: notifyChange → res.json 순서).
		this.changes.publish(ChangeBus.CREATE);
		this.json.write(request, response, 200, payload);
	}

	/**
	 * 제목·본문·마크업 검색 — 200 {@code {ok:true, items}} <b>정확히 2키</b>(총수·페이징 필드가 없다).
	 * 행은 {@code Article} 5키이며 본문 {@code markupVersion}이 실린다(목록의 {@code Contents} 행과
	 * 동형이 아니다).
	 *
	 * <p>{@code q}가 없으면 <b>빈 문자열</b>이다(거부가 아니다) — 빈 질의는 {@code LIKE '%%'}라 전 행이
	 * 매칭되고, 무매칭도 404가 아니라 200 빈 목록이다.
	 *
	 * <p><b>매핑 우선순위</b>: 이 리터럴 경로는 {@link #get} 의 {@code /api/articles/{id}}와 같은 자리를
	 * 두고 겨룬다. Spring의 패턴 비교는 리터럴을 경로 변수보다 구체적으로 보므로 이 핸들러가 이긴다 —
	 * <b>추측이 아니라 와이어로 실측했다</b>({@code ArticleQueryWireTest}가 두 라우트를 함께 부른다).
	 * 뒤집히면 검색이 "id가 search인 기사"를 찾아 404 {@code not-found}가 되므로 조용히 깨진다.
	 */
	@GetMapping("/api/articles/search")
	public void search(HttpServletRequest request, HttpServletResponse response) {
		Identity actor = actorOf(request);
		if (actor == null) {
			deny(request, response, "unauthenticated");
			return;
		}

		Map<String, Object> payload = JsonHttp.ok();
		payload.put("items", this.reads.search(queryValue(request, "q")));
		this.json.write(request, response, 200, payload);
	}

	/**
	 * 목록 조회 — 200 {@code {ok:true, items}} <b>정확히 2키</b>. 행은 투영 27키이고 잠금 비밀 2컬럼은
	 * 어떤 경로로도 실리지 않는다. <b>역할 필터가 없다</b>(R도 남의 부서 기사를 본다 — 목록 화면의 계약).
	 *
	 * <p>필터는 {@link ArticleReadService#FILTER_KEYS} <b>13키 화이트리스트</b>이고 그 밖의 키는
	 * <b>조용히 무시</b>한다(400이 아니다). 값은 <b>원문 배열 그대로</b> 넘긴다 — 콤마를 분해하거나
	 * 트림·형변환하지 마라({@code ?status=RDS,DDH}가 매칭 0건인 것이 계약이다. Spring MVC의
	 * {@code @RequestParam List<String>}은 기본으로 콤마를 분해하므로 <b>쓰면 즉시 계약 위반</b>이다).
	 *
	 * <p>배열을 받을 수 있는 키는 {@code status}·{@code excludeStatus}·{@code departments} 3개뿐이고
	 * 나머지 10키를 반복하면 리포지토리가 예외를 던져 <b>500 {@code internal-error}</b>가 된다
	 * (결함 후보 #4 재현 — decisions (9)). <b>여기서 400으로 미리 막지 마라</b>: 계약이 500을 동결했고
	 * 고치는 것은 Node·명세·케이스를 함께 바꾸는 별도 판단이다.
	 */
	@GetMapping("/api/articles")
	public void list(HttpServletRequest request, HttpServletResponse response) {
		Identity actor = actorOf(request);
		if (actor == null) {
			deny(request, response, "unauthenticated");
			return;
		}

		Map<String, Object> payload = JsonHttp.ok();
		payload.put("items", this.reads.query(pickFilters(request)));
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
	 * 이력 목록 — 200 {@code {ok:true, items}}이고 행은 <b>12키</b>(저장 8컬럼 + {@code hasSnapshot} +
	 * 표시 파생 {@code title}·{@code version}·{@code status}). 본문 blob·저장 제목·배부 컬럼은 없다.
	 *
	 * <p><b>이력이 없거나 기사가 아예 없어도 200 빈 배열</b>이다(404가 아니다 — 편집 이력 패널이 새
	 * 기사에서 오류 화면이 되면 안 된다). 단건 스냅샷({@link #historySnapshot})만 404를 쓴다 — 두 규칙을
	 * 섞지 마라.
	 *
	 * <p>{@code sendOnly} 판정식은 <b>이 계층의 소유</b>다(정본도 라우트에서 판정한다): 파라미터가
	 * <b>존재하고</b> 값이 {@code '0'}도 {@code 'false'}도 아니면 참이다(빈 문자열·{@code 'no'}도 참),
	 * 또는 {@code type === 'send'}면 참. 계약이 8변형을 전수 동결했다.
	 */
	@GetMapping("/api/articles/{id}/history")
	public void history(@PathVariable String id, HttpServletRequest request, HttpServletResponse response) {
		Identity actor = actorOf(request);
		if (actor == null) {
			deny(request, response, "unauthenticated");
			return;
		}

		String flag = queryValue(request, "sendOnly");
		boolean sendOnly = (flag != null && !"0".equals(flag) && !"false".equals(flag))
				|| "send".equals(queryValue(request, "type"));

		Map<String, Object> payload = JsonHttp.ok();
		payload.put("items", this.reads.queryHistory(id, sendOnly));
		this.json.write(request, response, 200, payload);
	}

	/**
	 * 단건 이력 스냅샷 — 200 {@code {ok:true, item}}이고 {@code item}은 <b>7키</b>(본문 포함, 전이 컬럼
	 * 없음). 기사이력비교가 사용자가 고른 항목의 본문만 지연 조회한다.
	 *
	 * <p><b>스냅샷이 없는 전이 행도 200</b>이고 본문만 {@code null}이다("항목 없음"이 아니다).
	 * 반대로 <b>비정수·미존재·타 기사 스코프는 전부 404</b> {@code not-found}다 — 세 경우를 구분해
	 * 알려 주지 않는 것이 계약이다(id 하나로 남의 본문을 읽는 경로를 만들지 않는다. 스코프는
	 * 리포지토리가 {@code articleId AND id}로 강제한다).
	 *
	 * <p>정수 판정은 {@link NodeNumber}가 소유한다 — Java의 파싱 관용을 쓰면 {@code "1.0"}·{@code "0x1"}
	 * 같은 표기에서 두 서버가 갈린다.
	 */
	@GetMapping("/api/articles/{id}/history/{historyId}")
	public void historySnapshot(@PathVariable String id, @PathVariable String historyId,
			HttpServletRequest request, HttpServletResponse response) {
		Identity actor = actorOf(request);
		if (actor == null) {
			deny(request, response, "unauthenticated");
			return;
		}

		Long parsed = NodeNumber.integerOf(historyId);
		if (parsed == null) {
			deny(request, response, NOT_FOUND); // 정수가 아니면 조회하지 않는다(400이 아니라 404다).
			return;
		}

		ArticleReadService.SnapshotResult found = this.reads.getHistorySnapshot(id, parsed);
		if (!found.ok()) {
			deny(request, response, found.reason());
			return;
		}
		Map<String, Object> payload = JsonHttp.ok();
		payload.put("item", found.item());
		this.json.write(request, response, 200, payload);
	}

	/**
	 * 기사 본문 번역 — 세션 → <b>존재(404 {@code not-found})</b> → 번역 위임 → <b>언제나 200</b>.
	 *
	 * <h2>상태코드로 성공을 판정할 수 없다</h2>
	 * 키가 없거나 외부 호출이 실패해도 <b>200</b>이고 본문만 {@code {ok:false, reason:'no-key'|'error',
	 * translatedText:원문}}이다(graceful degrade — 계약 머리말과 reason-tokens.md 표 3 #13). 4xx/5xx로
	 * 감싸면 상태코드를 해석하지 않는 클라이언트({@code httpModel})가 조용히 깨진다. 그래서 두 사유는
	 * {@link ReasonStatus} 표에 <b>넣지 않는다</b> — 상태 매핑이 아니라 200 본문의 필드다(decisions (16)).
	 *
	 * <h2>번역 대상은 서버 DB에서만 온다(ADR-004)</h2>
	 * 요청 본문에서 읽는 값은 {@code targetLang} <b>하나뿐</b>이고 {@code text}는 읽지 않는다 — 읽으면
	 * 서버 보유 키로 임의 문자열을 번역시키는 무료 프록시가 열린다. 본문 도출({@code articleToText})은
	 * <b>서비스 안에서 끝난다</b>: 여기서 원본 행을 만지면 투영 타입 경계 게이트가 red다.
	 *
	 * <p>{@code targetLang}은 본문 값을 <b>그대로</b> 넘긴다({@code String.valueOf}로 강제하지 마라).
	 * 정본이 {@code ?? 'ko'}(null 병합)라 부재·{@code null}만 기본값이 되고 빈 문자열·숫자는 그대로 가며,
	 * 그 병합은 서비스가 소유한다.
	 */
	@PostMapping("/api/articles/{id}/translate")
	public void translate(@PathVariable String id, HttpServletRequest request, HttpServletResponse response) {
		Identity actor = actorOf(request);
		if (actor == null) {
			deny(request, response, "unauthenticated");
			return;
		}

		// 본문 판독은 세션 게이트 직후다 — 정본에서도 body parser가 라우트 로직보다 먼저 돈다.
		Object targetLang = this.json.readBody(request).get("targetLang");
		Map<String, Object> found = this.reads.getById(id);
		if (found == null) {
			deny(request, response, NOT_FOUND);
			return;
		}
		this.json.write(request, response, 200, this.translation.translateArticle(found, targetLang));
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
		this.changes.publish(ChangeBus.UPDATE); // Node 944행 — 잠금 미보유·미존재 거부는 위에서 끝났다.
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
		this.changes.publish(ChangeBus.LOCK); // Node 963행.
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
		this.changes.publish(ChangeBus.LOCK); // Node 976행.
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
		this.changes.publish(ChangeBus.LOCK); // Node 988행.
		this.json.write(request, response, 200, JsonHttp.ok());
	}

	/**
	 * 송고·보류·KILL·삭제 승인 — R/D/Z. 성공 응답은 {@code {ok:true, status}} <b>정확히 2키</b>이고
	 * 그 {@code status}는 <b>저장된 최종 상태</b>다(엠바고 송고는 {@code DPS}가 아니라 {@code DES}다).
	 *
	 * <p>게이트 순서: 세션 → 역할 집합(403 {@code forbidden}) → <b>어휘 검증(400
	 * {@code unknown-action})</b> → 서비스(존재 404 → 전이표 409 → 마커 400). 어휘 검증이 서비스보다
	 * <b>앞</b>이라야 (a) 거부가 기사에 손대지 않고 (b) 없는 기사에 정의 밖 action을 보냈을 때 정본과 같은
	 * 400이 나간다(뒤로 옮기면 404가 된다).
	 *
	 * <p>(상태, role, action) 유효성은 {@link ArticleLifecycleService}가 강제한다 — 여기서는
	 * <b>capability 게이트만</b> 한다(정본과 같은 분업). acting role은 검증된 세션에서만 오고
	 * {@code req.body.role}은 읽지 않는다(ADR-004).
	 */
	@PostMapping("/api/articles/{id}/action")
	public void action(@PathVariable String id, HttpServletRequest request, HttpServletResponse response) {
		Identity actor = actorOf(request);
		if (actor == null) {
			deny(request, response, "unauthenticated");
			return;
		}
		if (!WRITE_ROLES.contains(actor.role())) {
			deny(request, response, "forbidden");
			return;
		}

		String action = JsonHttp.text(this.json.readBody(request), "action");
		if (action == null || !ACTIONS.contains(action)) {
			deny(request, response, "unknown-action");
			return;
		}

		ArticleLifecycleService.ActionResult result =
				this.lifecycle.applyAction(id, actor.role(), action, actor.userId());
		if (!result.ok()) {
			deny(request, response, result.reason(), ACTION_FALLBACK); // 폴백 409(전역 400이 아니다).
			return;
		}
		Map<String, Object> payload = JsonHttp.ok();
		payload.put("status", result.status());
		// Node 883행 — 409/400/403 거부를 전부 지난 뒤다. 송고 훅의 엠바고 승격은 여기서 신호를 늘리지
		// 않는다(그 승격은 서비스 안에서 일어나고 sse.md가 "자체 신호를 내지 않는다"로 동결했다).
		this.changes.publish(ChangeBus.STATUS);
		this.json.write(request, response, 200, payload);
	}

	/**
	 * 후속({@code followUp})·계속({@code continue}) 기사 작성 — 원본을 바탕으로 <b>새 기사</b>를 만든다.
	 * 신규 작성과 같은 권한(R/D/Z)이고 응답은 {@code {ok:true, articleId}} <b>정확히 2키</b>다.
	 *
	 * <p>게이트 순서: 세션 → 역할 집합 → 모드 어휘(400 {@code unknown-mode}) → 서비스(없는 원본 404).
	 * 실패 폴백은 <b>400</b>이다(정본 {@code fail(res, r)} — action의 409와 다르다).
	 *
	 * <p><b>작성자는 세션 사용자로 stamp한다</b>: {@code name ?? userId} — <b>null 병합</b>이라
	 * 이름이 빈 문자열인 계정은 <b>빈 문자열</b>이 그대로 stamp된다. 신규 저장({@link #create})의
	 * {@code name || userId}와 <b>연산자가 다르고</b> 그 계정에서 결과가 갈린다 — 계약 시드 계정은 전부
	 * 이름이 채워져 있어 관측되지 않는 축이지만, 정본과 같은 의미론을 그대로 옮긴다.
	 * 클라가 보낸 {@code author}·{@code role}·{@code status}·{@code articleId}는 쓰지 않는다(ADR-004):
	 * 나머지 필드는 서비스가 원본에서 복사하고 신규 저장이 새 id와 {@code RDS}를 강제한다.
	 */
	@PostMapping("/api/articles/{id}/derive")
	public void derive(@PathVariable String id, HttpServletRequest request, HttpServletResponse response) {
		Identity actor = actorOf(request);
		if (actor == null) {
			deny(request, response, "unauthenticated");
			return;
		}
		if (!WRITE_ROLES.contains(actor.role())) {
			deny(request, response, "forbidden");
			return;
		}

		String mode = JsonHttp.text(this.json.readBody(request), "mode");
		if (mode == null || !DERIVE_MODES.contains(mode)) {
			deny(request, response, "unknown-mode");
			return;
		}

		// name ?? userId — 빈 문자열은 값이 있는 것이다(falsy 폴백을 쓰면 정본과 갈린다).
		String author = (actor.name() == null) ? actor.userId() : actor.name();
		ArticleLifecycleService.DeriveResult result = this.lifecycle.derive(id, mode, author);
		if (!result.ok()) {
			deny(request, response, result.reason()); // 전역 폴백 400.
			return;
		}
		Map<String, Object> payload = JsonHttp.ok();
		payload.put("articleId", result.articleId());
		this.changes.publish(ChangeBus.CREATE); // Node 902행 — 파생도 "새 기사"라 create다.
		this.json.write(request, response, 200, payload);
	}

	/**
	 * 목록 필터 — 화이트리스트 <b>13키</b>만, <b>값 배열 원문 그대로</b>. Node {@code pickFilters}와 1:1이다.
	 *
	 * <p>"키가 있는가"의 판정은 {@code query[k] !== undefined} 동형이다 — {@code ?author=} 처럼 <b>값이
	 * 비어 있어도 존재</b>이고 그 빈 문자열이 조건이 된다. 값을 만지지 않는 이유는 두 가지다: (a) 콤마는
	 * 문법이 아니고 (b) 스칼라 전용 키의 반복은 <b>리포지토리가 예외로 만들어</b> 500이 되어야 한다.
	 */
	private static Map<String, List<String>> pickFilters(HttpServletRequest request) {
		Map<String, List<String>> filters = new LinkedHashMap<>();
		for (String key : ArticleReadService.FILTER_KEYS) {
			String[] values = request.getParameterValues(key);
			if (values != null) {
				filters.put(key, List.of(values));
			}
		}
		return filters;
	}

	/**
	 * 쿼리 파라미터 하나를 <b>Node가 보는 문자열</b>로 읽는다 — 없으면 {@code null}, 하나면 그 값,
	 * <b>반복되면 콤마로 이어 붙인 값</b>이다.
	 *
	 * <p>계약이 동결하지 않은 축이라 실측으로 정했다(index.json forward_notes (4)⑤): express는 반복 키를
	 * 배열로 파싱하고, 그 배열이 쓰이는 두 자리가 모두 {@code Array#toString}(= 콤마 결합)과 같은 결과를
	 * 낸다 — 검색은 {@code `%${q}%`} 템플릿이 문자열화하고({@code ?q=a&q=b} → {@code LIKE '%a,b%'}),
	 * {@code sendOnly}는 {@code flag !== '0'} 비교가 배열에 대해 <b>항상 참</b>인데 콤마 결합 문자열도
	 * 2개 이상이면 반드시 콤마를 포함해 {@code '0'}·{@code 'false'}와 같아질 수 없다. 첫 값만 취하면
	 * ({@code getParameter}의 기본 동작) 두 자리 모두 Node와 갈린다.
	 */
	private static String queryValue(HttpServletRequest request, String key) {
		String[] values = request.getParameterValues(key);
		return (values == null) ? null : String.join(",", values);
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

	/** 거부 응답 — 사유 토큰이 상태코드를 정한다({@link ReasonStatus}). 폴백은 전역 400이다. */
	private void deny(HttpServletRequest request, HttpServletResponse response, String reason) {
		deny(request, response, reason, ReasonStatus.FALLBACK);
	}

	/**
	 * 거부 응답 + <b>라우트 폴백</b> — 표에 없는 사유의 상태코드가 라우트마다 다르다(정본
	 * {@code fail(res, result, fallback)}). {@code action}만 409를 쓴다({@link #ACTION_FALLBACK}).
	 */
	private void deny(HttpServletRequest request, HttpServletResponse response, String reason, int fallback) {
		this.json.write(request, response, ReasonStatus.of(reason, fallback), JsonHttp.fail(reason));
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
