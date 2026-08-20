package harness.news.web;

import jakarta.servlet.Filter;
import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.ServletRequest;
import jakarta.servlet.ServletResponse;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import java.io.IOException;
import java.util.List;

/**
 * CORS allowlist·preflight — Node의 {@code cors({credentials:true, origin: origins, ...})} 동형.
 *
 * <h2>왜 서블릿 필터인가(프레임워크 CORS 지원을 쓰지 않는 이유)</h2>
 * Spring MVC의 preflight 처리(@{@code CrossOrigin}·{@code CorsConfiguration})는 <b>매칭되는 핸들러를 요구</b>한다.
 * 계약 케이스는 {@code OPTIONS /api/articles}로 preflight를 검증하는데 이 phase에는 기사 핸들러가 없어
 * 404가 난다. Node의 cors 미들웨어는 라우트를 모르는 채 응답을 끝내므로, 여기서도 <b>필터가 직접</b> 끝낸다.
 *
 * <h2>Node 실측 기준값(2026-08-20)</h2>
 * <pre>
 * OPTIONS(허용 출처) → 204 · ACAO=요청 Origin · ACAC=true · ACAM · ACAH(4종) · Vary: Origin
 * OPTIONS(비허용)    → 204 · <b>ACAO 없음</b> · 나머지는 동일
 * 일반 응답           → ACAC·Vary는 항상, ACAO는 허용 출처일 때만
 * </pre>
 * <b>204는 계약이다</b> — 계약 케이스는 {@code status < 300}으로만 보지만 리포트 diff는 상태 정수를 정확
 * 비교한다(2xx 아무 값이나 내면 기능 green·패리티 red).
 *
 * <p>비허용 출처를 403으로 막지 않는다 — CORS는 "실행"이 아니라 "응답 판독"을 막는 장치이고, 판독 차단은
 * ACAO 부재가 담당한다(쓰기 실행을 막는 것은 {@link CsrfOriginFilter}의 일이다).
 *
 * <p>{@code credentials: true}이므로 ACAO에 와일드카드({@code *})를 쓸 수 없다 — 브라우저가 거부한다.
 * 그래서 allowlist가 필수이며 목록은 {@link AllowedOrigins} 하나뿐이다.
 */
final class CorsFilter implements Filter {

	/**
	 * 허용 요청 헤더 — <b>정확히 4종</b>이다. 늘리는 것은 계약 변경이다(계약 케이스가 집합을 단언한다).
	 */
	static final List<String> ALLOWED_HEADERS =
			List.of("Content-Type", "x-session-id", "x-collection-token", "x-edit-client");

	/** 허용 메서드 — Node cors 설정과 같은 5종·같은 표기다. */
	static final String ALLOWED_METHODS = "GET,POST,PUT,DELETE,OPTIONS";

	/** preflight 응답 상태(Node 실측). */
	static final int PREFLIGHT_STATUS = 204;

	private final AllowedOrigins origins;

	CorsFilter(AllowedOrigins origins) {
		this.origins = origins;
	}

	@Override
	public void doFilter(ServletRequest request, ServletResponse response, FilterChain chain)
			throws IOException, ServletException {
		HttpServletRequest httpRequest = (HttpServletRequest) request;
		HttpServletResponse httpResponse = (HttpServletResponse) response;

		// 응답이 Origin에 따라 달라진다는 사실을 캐시에 알린다(Node cors도 항상 싣는다).
		httpResponse.setHeader("Vary", "Origin");
		httpResponse.setHeader("Access-Control-Allow-Credentials", "true");

		String origin = httpRequest.getHeader("Origin");
		if (this.origins.allows(origin)) {
			httpResponse.setHeader("Access-Control-Allow-Origin", origin); // 요청 Origin을 그대로 반향.
		}

		if ("OPTIONS".equalsIgnoreCase(httpRequest.getMethod())) {
			httpResponse.setHeader("Access-Control-Allow-Methods", ALLOWED_METHODS);
			httpResponse.setHeader("Access-Control-Allow-Headers", String.join(",", ALLOWED_HEADERS));
			httpResponse.setStatus(PREFLIGHT_STATUS);
			httpResponse.setContentLength(0);
			return; // 여기서 끝난다 — CSRF 가드·세션 판정·핸들러 매핑에 도달하지 않는다.
		}

		chain.doFilter(request, response);
	}
}
