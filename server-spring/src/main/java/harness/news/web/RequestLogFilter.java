package harness.news.web;

import harness.news.service.LogService;
import jakarta.servlet.Filter;
import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.ServletRequest;
import jakarta.servlet.ServletResponse;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import java.io.IOException;
import java.time.Clock;

/**
 * 액세스 로그 1줄 — {@code 메서드 경로 상태 소요시간}(INFO). Node {@code server/index.js} 545~553행과
 * 동형이고, 등록 위치도 같다: <b>CORS 다음 · CSRF 앞</b>(그래서 CSRF 거부 403도 액세스 로그에 남는다).
 * preflight는 CORS 필터가 먼저 끝내므로 여기 도달하지 않는다 — Node도 마찬가지다.
 *
 * <h2>CRITICAL(마스킹): 경로만 담는다</h2>
 * 쿼리스트링·헤더·쿠키·본문은 <b>한 조각도</b> 담지 않는다(LOGS.md · ADR-007). 이 버퍼는 Z 전용이지만
 * {@code GET /api/logs/digest}로 <b>밖으로 나간다</b> — 여기 들어간 세션 토큰·비밀번호는 곧 응답이다.
 * 그래서 {@code getRequestURI()}(쿼리가 없는 원문 경로)만 읽고, {@code getQueryString()}은
 * 이 계층 전체에서 정적 스캔으로 금지돼 있다({@code WebWiringTest}).
 *
 * <p>소요시간과 상태는 체인이 돌아온 뒤에 읽는다(Node의 {@code res.on('finish')}와 같은 자리다 —
 * 이 서버의 모든 응답은 체인 안에서 완성된다: 전역 예외 핸들러도 디스패처 안에서 500을 쓴다).
 * 시각은 주입 시계에서만 읽는다(decisions (14)) — 고정 시계 테스트에서 소요시간은 {@code 0ms}가 된다.
 */
final class RequestLogFilter implements Filter {

	private final LogService logs;

	private final Clock clock;

	RequestLogFilter(LogService logs, Clock clock) {
		this.logs = logs;
		this.clock = clock;
	}

	@Override
	public void doFilter(ServletRequest request, ServletResponse response, FilterChain chain)
			throws IOException, ServletException {
		HttpServletRequest httpRequest = (HttpServletRequest) request;
		HttpServletResponse httpResponse = (HttpServletResponse) response;
		long startedAt = this.clock.millis();
		try {
			chain.doFilter(request, response);
		}
		finally {
			this.logs.info(httpRequest.getMethod() + " " + httpRequest.getRequestURI() + " "
					+ httpResponse.getStatus() + " " + (this.clock.millis() - startedAt) + "ms");
		}
	}
}
