package harness.spring_auth;

import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import java.io.IOException;
import java.util.LinkedHashMap;
import java.util.Map;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RestController;

/**
 * 인증/세션 라우트 — POST /api/login, POST /api/logout, GET /api/session.
 * acting 신원은 세션에서만 도출한다(요청 body의 role 불신 — ADR-004). 모든 응답은 JSON
 * (레이트리밋 429는 필터가 응답하는 유일한 비-JSON 예외). content-type은 JsonHttp가 Node와 바이트 동일하게 강제.
 */
@RestController
public class AuthController {

	private final AuthService authService;
	private final SessionGuard guard;
	private final SessionCookieWriter cookieWriter;

	public AuthController(AuthService authService, SessionGuard guard, SessionCookieWriter cookieWriter) {
		this.authService = authService;
		this.guard = guard;
		this.cookieWriter = cookieWriter;
	}

	private static String asStr(Object v) {
		return v == null ? null : String.valueOf(v);
	}

	@PostMapping("/api/login")
	public void login(@RequestBody(required = false) Map<String, Object> body, HttpServletResponse res)
			throws IOException {
		String userId = body == null ? null : asStr(body.get("userId"));
		String password = body == null ? null : asStr(body.get("password"));
		AuthService.Result r = authService.login(userId, password);

		if (r.ok()) {
			String sid = guard.issue(r.userId());
			res.setHeader("Set-Cookie", cookieWriter.issue(sid));
			Map<String, Object> out = new LinkedHashMap<>();
			out.put("ok", true);
			out.put("sessionId", sid);
			out.put("user", r.user());
			JsonHttp.write(res, 200, out);
			return;
		}
		// 로그인 전용 매핑: 계정 잠금은 423, 비활성 403, 그 외(invalid-credentials) 401.
		int status = switch (r.reason()) {
			case "locked" -> 423;
			case "inactive" -> 403;
			default -> 401;
		};
		Map<String, Object> out = new LinkedHashMap<>();
		out.put("ok", false);
		out.put("reason", r.reason());
		JsonHttp.write(res, status, out);
	}

	@PostMapping("/api/logout")
	public void logout(HttpServletRequest req, @RequestBody(required = false) Map<String, Object> body,
			HttpServletResponse res) throws IOException {
		String token = SessionTokens.read(req);
		if (token == null && body != null) {
			token = asStr(body.get("sessionId"));
		}
		guard.remove(token); // 세션 유무와 무관하게 항상 200(멱등).
		res.setHeader("Set-Cookie", cookieWriter.expire());
		Map<String, Object> out = new LinkedHashMap<>();
		out.put("ok", true);
		JsonHttp.write(res, 200, out);
	}

	@GetMapping("/api/session")
	public void session(HttpServletRequest req, HttpServletResponse res) throws IOException {
		Identity me = guard.touch(SessionTokens.read(req));
		if (me == null) {
			Map<String, Object> out = new LinkedHashMap<>();
			out.put("ok", false);
			out.put("reason", "unauthenticated");
			JsonHttp.write(res, 401, out);
			return;
		}
		Map<String, Object> out = new LinkedHashMap<>();
		out.put("ok", true);
		out.put("user", identityUser(me));
		JsonHttp.write(res, 200, out);
	}

	/** GET /api/session 응답 user — 정확 5키(active·password 없음). null 값도 실을 수 있어 LinkedHashMap. */
	static Map<String, Object> identityUser(Identity me) {
		Map<String, Object> user = new LinkedHashMap<>();
		user.put("userId", me.userId());
		user.put("name", me.name());
		user.put("role", me.role());
		user.put("department", me.department());
		user.put("departmentCode", me.departmentCode());
		return user;
	}
}
