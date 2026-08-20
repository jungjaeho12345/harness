package harness.news.controller;

import harness.news.service.Identity;
import harness.news.service.SessionGuard;
import harness.news.service.UserService;
import harness.news.web.JsonHttp;
import harness.news.web.ReasonStatus;
import harness.news.web.SessionCookies;
import harness.news.web.SessionTokens;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import java.util.LinkedHashMap;
import java.util.Map;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * 인증·세션 3라우트. 컨트롤러는 <b>shape 매핑과 게이트 호출만</b> 한다 — 판정은 서비스가, 와이어 포맷은
 * web 계층이 소유한다(ADR-006 동형).
 *
 * <h2>이 라우트들이 지키는 계약</h2>
 * <ul>
 *   <li><b>토큰 운반 2수단</b>: {@code sid} 쿠키 우선 · {@code x-session-id} 헤더 폴백.
 *       {@code ?session=} 쿼리 폴백은 <b>부재가 계약</b>이다(유효 토큰을 쿼리로 줘도 401).</li>
 *   <li><b>모든 거부에 JSON 바디</b>: 401·403·423도 {@code {ok:false, reason}}을 싣는다 —
 *       클라이언트(httpModel)는 상태코드가 아니라 본문 {@code ok}/{@code reason}을 읽는다.
 *       바디 없는 401은 SPA를 "세션 복원 중"에서 영구 정지시킨다.</li>
 *   <li><b>두 user shape은 다르다</b>: 로그인 200은 SAFE_FIELDS <b>6키</b>({@code active} 포함),
 *       세션 200은 신원 <b>5키</b>다. 값이 NULL이어도 키는 남는다(키를 빼면 계약 위반).</li>
 *   <li><b>로그아웃은 항상 200</b> {@code {ok:true}}: 세션이 없어도, 토큰이 이상해도 성공이다(멱등).</li>
 * </ul>
 */
@RestController
public class AuthController {

	private final UserService users;

	private final SessionGuard sessions;

	private final SessionCookies cookies;

	private final JsonHttp json;

	public AuthController(UserService users, SessionGuard sessions, SessionCookies cookies, JsonHttp json) {
		this.users = users;
		this.sessions = sessions;
		this.cookies = cookies;
		this.json = json;
	}

	/**
	 * 로그인 — 자격 판정(서비스) → 성공 시 세션 발급 + 쿠키.
	 *
	 * <p>실패 사유는 로그인 <b>로컬</b> 매핑으로 상태가 된다: {@code invalid-credentials} 401 ·
	 * {@code inactive} 403 · {@code locked} <b>423</b>(전역 401을 덮어쓴다).
	 */
	@PostMapping("/api/login")
	public void login(HttpServletRequest request, HttpServletResponse response) {
		Map<String, Object> body = this.json.readBody(request);
		String userId = JsonHttp.text(body, "userId");
		String password = JsonHttp.text(body, "password");

		UserService.LoginResult result = this.users.login(userId, password);
		if (!result.ok()) {
			this.json.write(request, response, ReasonStatus.forLogin(result.reason()),
					JsonHttp.fail(result.reason()));
			return;
		}

		// 세션은 입력값이 아니라 DB 행에서 나온 userId로 만든다(대소문자·공백이 다른 입력이 별도 세션을 만들지 않게).
		String sessionId = this.sessions.createSession((String) result.user().get("userId"));
		response.addHeader("Set-Cookie", this.cookies.issue(sessionId));

		Map<String, Object> payload = new LinkedHashMap<>();
		payload.put("ok", true);
		payload.put("sessionId", sessionId); // 헤더 폴백 클라이언트용 — 쿠키 값과 같은 토큰이다.
		payload.put("user", result.user());
		this.json.write(request, response, 200, payload);
	}

	/**
	 * 로그아웃 — <b>항상</b> 200 {@code {ok:true}} + 만료 쿠키.
	 *
	 * <p>본문을 먼저 읽는다: Node는 body parser가 라우트보다 먼저 돌기 때문이다(깨진 JSON이면 그 시점에
	 * 500이 된다). 토큰은 쿠키·헤더 → 없으면 {@code body.sessionId} 폴백 순서로 찾는다.
	 * 무효화 성공 여부는 응답에 싣지 않는다 — 세션 존재 여부를 알려주는 것 자체가 단서다.
	 */
	@PostMapping("/api/logout")
	public void logout(HttpServletRequest request, HttpServletResponse response) {
		Map<String, Object> body = this.json.readBody(request);
		String token = tokenOf(request);
		if (token == null) {
			token = JsonHttp.text(body, "sessionId");
		}
		if (token != null) {
			this.sessions.invalidate(token);
		}
		response.addHeader("Set-Cookie", this.cookies.clear());
		this.json.write(request, response, 200, JsonHttp.ok());
	}

	/**
	 * 세션 복원(F5) — 토큰으로 신원을 재도출해 돌려준다.
	 *
	 * <p>가드가 매 호출 User 행을 다시 읽으므로 강등·비활성화가 재로그인 없이 즉시 반영된다(ADR-004).
	 */
	@GetMapping("/api/session")
	public void session(HttpServletRequest request, HttpServletResponse response) {
		String token = tokenOf(request);
		Identity identity = (token == null) ? null : this.sessions.touchSession(token);
		if (identity == null) {
			this.json.write(request, response, ReasonStatus.of("unauthenticated"),
					JsonHttp.fail("unauthenticated"));
			return;
		}

		Map<String, Object> payload = new LinkedHashMap<>();
		payload.put("ok", true);
		payload.put("user", identity.asMap()); // 5키 — 값이 없어도 키는 남는다.
		this.json.write(request, response, 200, payload);
	}

	/** 쿠키 우선 · 헤더 폴백. 쿼리는 판독기에 전달조차 하지 않는다(부재가 계약). */
	private static String tokenOf(HttpServletRequest request) {
		return SessionTokens.read(request.getHeader("cookie"), request.getHeader(SessionTokens.HEADER_NAME));
	}
}
