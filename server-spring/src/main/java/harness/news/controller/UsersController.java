package harness.news.controller;

import harness.news.service.Authorization;
import harness.news.service.UserService;
import harness.news.web.JsonHttp;
import harness.news.web.ReasonStatus;
import harness.news.web.SessionTokens;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import java.util.LinkedHashMap;
import java.util.Map;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * 사용자 쓰기 2라우트 — {@code POST /api/users} · {@code PUT /api/users/:id}. 둘 다 <b>Z 전용</b>이다.
 * 컨트롤러는 게이트 호출과 shape 매핑만 하고, 판정은 {@link Authorization}·저장은 {@link UserService}가 한다.
 *
 * <h2>동결된 응답 shape</h2>
 * <ul>
 *   <li>생성 200 {@code {ok:true, user:{…}}} — {@code user}는 <b>요청에 있던 SAFE_FIELDS만</b>(+ 기본
 *       {@code active:'Y'}) 담는다. {@code password}는 어떤 경로로도 실리지 않는다.</li>
 *   <li>수정 200 {@code {ok:true, changes:<영향 행 수>}} — <b>없는 id도 200 + {@code changes:0}</b>이다
 *       (존재 판정을 하지 않는다: 404가 아니다).</li>
 *   <li>거부 {@code {ok:false, reason}} — 미인증 401 · 비-Z 403. 두 층이 각자 자기 사유를 낸다:
 *       경로 정책 필터가 미인증을 끊고, 인증된 요청은 여기 역할 게이트가 끊는다.</li>
 * </ul>
 *
 * <h2>입력 검증을 하지 않는다(의도)</h2>
 * 정의 밖 {@code role}·빈 비밀번호·중복 {@code userId}(→ 전역 핸들러의 500)는 현행 계약의
 * <b>재현</b>이다(index.json decisions (12) · {@code docs/api-contract/README.md} 결함 후보 #1·#2).
 * 여기서 4xx를 만들면 phase 69의 {@code users.contract.js}가 red가 되고 "이식 결함"과 "의도된 계약 변경"이
 * 뒤섞인다 — 고치는 시점은 Node·Spring·명세·케이스를 한 번에 바꾸는 별도 판단이다(forward_notes (6)).
 *
 * <h2>순서: 게이트 → 본문</h2>
 * 본문은 <b>인가를 통과한 뒤에만</b> 읽는다(거부될 요청의 페이로드를 파싱하지 않는다). Node는 body parser가
 * 라우트보다 먼저 돌아 깨진 JSON이면 인가 전에 500이 되지만, 그 입력은 계약이 다루지 않는 축이고
 * 미인증 요청의 본문을 먼저 해석하지 않는 편이 경계로서 옳다.
 */
@RestController
public class UsersController {

	private final Authorization authorization;

	private final UserService users;

	private final JsonHttp json;

	public UsersController(Authorization authorization, UserService users, JsonHttp json) {
		this.authorization = authorization;
		this.users = users;
		this.json = json;
	}

	/** 사용자 생성 — Z 전용. 중복 {@code userId}는 예외가 그대로 올라가 전역 500 {@code internal-error}가 된다. */
	@PostMapping("/api/users")
	public void create(HttpServletRequest request, HttpServletResponse response) {
		if (denied(request, response)) {
			return;
		}
		Map<String, Object> payload = new LinkedHashMap<>();
		payload.put("ok", true);
		payload.put("user", this.users.create(this.json.readBody(request)));
		this.json.write(request, response, 200, payload);
	}

	/**
	 * 사용자 수정 — Z 전용. 경로 변수는 URL 세그먼트 그대로다(계약 케이스가 만든 유니크 userId가 들어온다).
	 * 삭제 경로는 만들지 않는다 — 비활성화는 {@code {"active":"N"}} 패치다(DB 비파괴).
	 */
	@PutMapping("/api/users/{userId}")
	public void update(@PathVariable String userId, HttpServletRequest request, HttpServletResponse response) {
		if (denied(request, response)) {
			return;
		}
		Map<String, Object> payload = new LinkedHashMap<>();
		payload.put("ok", true);
		payload.put("changes", this.users.update(userId, this.json.readBody(request)));
		this.json.write(request, response, 200, payload);
	}

	/**
	 * Z 게이트 — 통과면 {@code false}, 거부면 사유 토큰으로 응답을 쓰고 {@code true}.
	 *
	 * <p>토큰은 쿠키 우선 · {@code x-session-id} 폴백으로만 읽는다({@link SessionTokens}는 요청 객체를 받지
	 * 않으므로 쿼리를 읽을 방법이 구조적으로 없다 — {@code ?session=} 폴백 부재가 계약이다).
	 * 판정에 쓰는 role은 게이트가 세션에서 재도출한 것뿐이다: 본문의 {@code role}은 여기까지 오지도 않는다.
	 */
	private boolean denied(HttpServletRequest request, HttpServletResponse response) {
		String token = SessionTokens.read(request.getHeader("cookie"),
				request.getHeader(SessionTokens.HEADER_NAME));
		Authorization.Decision gate = this.authorization.authorize(token, Authorization.MANAGE_USERS);
		if (gate.ok()) {
			return false;
		}
		this.json.write(request, response, ReasonStatus.of(gate.reason()), JsonHttp.fail(gate.reason()));
		return true;
	}
}
