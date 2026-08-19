package harness.spring_auth;

import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import java.io.IOException;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RestController;

/**
 * 가드 의존 최소 지원 라우트 — session-guard 계약이 재도출(ADR-004)을 실증하려 건드리는 것만:
 *   POST /api/users(Z)·PUT /api/users/:id(Z)·GET /api/logs/digest(Z 게이트)·GET /api/articles(세션 게이트).
 * 이 라우트들의 전체 도메인 계약은 이 phase 밖이다 — session-guard가 관측하는 동작만 Node와 일치시킨다.
 * acting role은 SessionGuard가 재도출한 신원의 role에서만 온다(요청 body의 role 불신 — 반드시 가드 경유).
 */
@RestController
public class SupportController {

	private final SessionGuard guard;
	private final UserService userService;
	private final NewsDb db;

	public SupportController(SessionGuard guard, UserService userService, NewsDb db) {
		this.guard = guard;
		this.userService = userService;
		this.db = db;
	}

	private static void writeUnauthenticated(HttpServletResponse res) throws IOException {
		Map<String, Object> out = new LinkedHashMap<>();
		out.put("ok", false);
		out.put("reason", "unauthenticated");
		JsonHttp.write(res, 401, out);
	}

	private static void writeForbidden(HttpServletResponse res) throws IOException {
		Map<String, Object> out = new LinkedHashMap<>();
		out.put("ok", false);
		out.put("reason", "forbidden");
		JsonHttp.write(res, 403, out);
	}

	/** Z 전용 게이트 — 매 요청 재도출 신원. 미인증이면 null 반환 + 401 기록, 비-Z면 null + 403 기록. */
	private Identity requireZ(HttpServletRequest req, HttpServletResponse res) throws IOException {
		Identity me = guard.touch(SessionTokens.read(req));
		if (me == null) {
			writeUnauthenticated(res);
			return null;
		}
		if (!"Z".equals(me.role())) {
			writeForbidden(res);
			return null;
		}
		return me;
	}

	@PostMapping("/api/users")
	public void createUser(@RequestBody(required = false) Map<String, Object> body, HttpServletRequest req,
			HttpServletResponse res) throws IOException {
		if (requireZ(req, res) == null) {
			return;
		}
		JsonHttp.write(res, 200, userService.create(body == null ? Map.of() : body));
	}

	@PutMapping("/api/users/{id}")
	public void updateUser(@PathVariable String id, @RequestBody(required = false) Map<String, Object> body,
			HttpServletRequest req, HttpServletResponse res) throws IOException {
		if (requireZ(req, res) == null) {
			return;
		}
		JsonHttp.write(res, 200, userService.update(id, body == null ? Map.of() : body));
	}

	@GetMapping("/api/logs/digest")
	public void logsDigest(HttpServletRequest req, HttpServletResponse res) throws IOException {
		if (requireZ(req, res) == null) {
			return;
		}
		// 최소 다이제스트 — top-level 키는 반드시 items·ok(Node와 bodyKeys 동일). 내용은 패리티 비교 대상 아님.
		Map<String, Object> out = new LinkedHashMap<>();
		out.put("ok", true);
		out.put("items", List.of());
		JsonHttp.write(res, 200, out);
	}

	@GetMapping("/api/articles")
	public void listArticles(HttpServletRequest req, HttpServletResponse res) throws IOException {
		Identity me = guard.touch(SessionTokens.read(req)); // 세션 게이트(role 무관 — 로그인만).
		if (me == null) {
			writeUnauthenticated(res);
			return;
		}
		Map<String, Object> out = new LinkedHashMap<>();
		out.put("ok", true);
		out.put("items", db.listArticles());
		JsonHttp.write(res, 200, out);
	}
}
