package harness.news.controller;

import harness.news.service.Authorization;
import harness.news.service.LogRecord;
import harness.news.service.LogService;
import harness.news.web.JsonHttp;
import harness.news.web.ReasonStatus;
import harness.news.web.SessionTokens;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * 로그 다이제스트 — {@code GET /api/logs/digest}. <b>Z 전용</b>이다(ADR-007).
 *
 * <p>이 라우트가 이 phase에 있는 이유는 로그 도메인이 아니라 <b>세션 가드 축</b>이다:
 * {@code contract/cases/default/session-guard.contract.js}가 "Z 전용 라우트"로 이 경로를 써서
 * 강등 전 200 → 강등 후 403(재로그인 없이)을 검증한다. 그래서 여기서 중요한 것은 로그 도메인이 아니라
 * <b>role을 검증된 세션에서만 도출한다</b>는 사실이다(ADR-004).
 *
 * <h2>인가 2단</h2>
 * 미인증 401은 경로 정책 필터가 컨트롤러 앞에서 끊고({@code endpoints.json}의 {@code auth: admin} 행),
 * 인증된 요청의 비-Z 403은 여기 역할 게이트가 낸다. 두 층이 각자 자기 사유 토큰을 낸다 —
 * {@code /api/stream}(로그인만 요구)과 달리 이 라우트에는 role 게이트가 있다.
 *
 * <h2>읽기 전용 · 스텁 아님</h2>
 * {@link LogService}의 in-memory 링 버퍼에 위임만 한다(파일·DB를 만들거나 건드리지 않는다).
 * 응답의 {@code items}가 비어 있는 것은 <b>정상</b>이다: 창이 {@code [전날 06:00, 당일 06:00)}이라
 * 갓 기동한 서버에는 창 안의 레코드가 없다. 그러나 <b>빈 배열을 하드코딩하지 않는다</b> —
 * 창 안에 레코드가 있으면 그대로 나온다는 사실은 {@code LogsWireTest}가 시계를 주입해 잠근다
 * (index.json decisions (18)(b): 스텁 핸들러 금지).
 */
@RestController
public class LogsController {

	private final Authorization authorization;

	private final LogService logs;

	private final JsonHttp json;

	public LogsController(Authorization authorization, LogService logs, JsonHttp json) {
		this.authorization = authorization;
		this.logs = logs;
		this.json = json;
	}

	@GetMapping("/api/logs/digest")
	public void digest(HttpServletRequest request, HttpServletResponse response) {
		String token = SessionTokens.read(request.getHeader("cookie"),
				request.getHeader(SessionTokens.HEADER_NAME));
		Authorization.Decision gate = this.authorization.authorize(token, Authorization.VIEW_LOGS);
		if (!gate.ok()) {
			this.json.write(request, response, ReasonStatus.of(gate.reason()), JsonHttp.fail(gate.reason()));
			return;
		}

		List<Map<String, Object>> items = new ArrayList<>();
		for (LogRecord record : this.logs.digest()) {
			items.add(record.asMap());
		}
		Map<String, Object> payload = new LinkedHashMap<>();
		payload.put("ok", true);
		payload.put("items", items);
		this.json.write(request, response, 200, payload);
	}
}
