package harness.news.web;

import jakarta.servlet.Filter;
import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.ServletRequest;
import jakarta.servlet.ServletResponse;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import java.io.IOException;

/**
 * {@code POST /api/login} <b>한 라우트</b>의 IP 레이트리밋(15분/10회) — Node의 {@code loginLimiter} 동형.
 *
 * <h2>왜 전역이 아닌가</h2>
 * 계약은 로그인 라우트 한 곳의 IP 한도만 동결한다. 다른 라우트에 걸면 계약 스위트가 <b>픽스처를 만드는
 * 도중</b> 429로 무너지고, 원인이 이 파일에 없어 진단이 가장 어려운 실패가 된다.
 *
 * <h2>대상 판정은 경로 표에서 나온다</h2>
 * 경로 문자열을 여기서 다시 적지 않고 {@link RoutePolicy}에 물어본다 — 그래야 후행 슬래시 정규화가
 * 경로 정책 필터와 같은 규칙이 된다. express는 기본(strict routing off)에서 {@code /api/login/}을 같은
 * 라우트로 보므로, 정규화를 빠뜨리면 슬래시 한 개로 예산이 새로 생긴다.
 *
 * <h2>클라이언트는 원격 소켓 주소로만 식별한다</h2>
 * {@code X-Forwarded-For}·{@code X-Real-IP}를 보지 않는다 — 보는 순간 헤더 한 줄로 한도가 무한 우회된다.
 * Node도 비프로덕션에서 프록시를 신뢰하지 않는다({@code server/index.js} 486행: {@code trust proxy}는
 * HTTPS 강제일 때만 켠다). 컨테이너 차원에서도 {@code server.forward-headers-strategy=none}으로 잠겨 있어
 * {@code getRemoteAddr()}는 항상 소켓 상대 주소다. 리버스 프록시 뒤 배포는 별도 판단이다(지금은 프록시가 없다).
 *
 * <h2>순서</h2>
 * {@link FilterOrder#LOGIN_RATE_LIMIT} — CSRF 다음, 경로 정책 앞. Node도 CSRF 가드를 통과한 뒤
 * 라우트 진입 시점에 센다. 로그인은 {@code public} 라우트라 경로 정책과는 순서가 무관하지만,
 * <b>잠금 423과의 순서는 계약</b>이다: 한도 안에서는 라우트가 423을 만들고, 한도를 넘기는 순간
 * 이 필터가 429를 만든다({@code login-negative.contract.js} C-3이 "429 전까지는 423"을 단언한다).
 */
final class LoginRateLimitFilter implements Filter {

	/** 대상 라우트의 인벤토리 id({@code docs/api-contract/endpoints.json}). */
	private static final String LOGIN_ROUTE_ID = "login";

	private final LoginRateLimit limiter;

	LoginRateLimitFilter(LoginRateLimit limiter) {
		this.limiter = limiter;
	}

	@Override
	public void doFilter(ServletRequest request, ServletResponse response, FilterChain chain)
			throws IOException, ServletException {
		HttpServletRequest httpRequest = (HttpServletRequest) request;

		if (!isLogin(httpRequest) || !this.limiter.exceeded(httpRequest.getRemoteAddr())) {
			chain.doFilter(request, response);
			return;
		}

		HttpServletResponse httpResponse = (HttpServletResponse) response;
		// 한도 선언 헤더 2종만 싣는다(둘 다 결정적이고 Node 실측과 바이트 동일).
		// -Remaining·-Reset·Retry-After는 값이 시간에 따라 변해 이중 실행 diff를 무의미하게 만든다
		// — contract/lib/record.js가 그래서 리포트 허용 목록에서 뺐다.
		httpResponse.setHeader("RateLimit-Policy", LoginRateLimit.LIMIT + ";w=" + LoginRateLimit.WINDOW_MS / 1000L);
		httpResponse.setHeader("RateLimit-Limit", String.valueOf(LoginRateLimit.LIMIT));
		HtmlErrors.tooManyRequests(httpRequest, httpResponse);
	}

	/**
	 * 이 요청이 로그인 라우트인가 — 판정 규칙(후행 슬래시 · 퍼센트 인코딩 · HEAD)은 전부
	 * {@link RoutePolicy}가 소유한다.
	 *
	 * <p>{@code /api/lo%67in}은 원문으로는 아무 라우트도 아니지만 Spring 디스패처는 세그먼트를 디코딩해
	 * 매칭하므로 <b>로그인 핸들러가 실제로 실행된다</b>(실측 2026-08-20: 원문만 보던 시절 예산을 소진한
	 * 뒤에도 401이 나왔다 = 인코딩 한 글자로 한도 무한 우회). step7이 이 필터 안에서 원문+디코딩 이중 판정으로
	 * 막았고, step10이 같은 노출을 갖고 있던 경로 정책 필터와 함께 닫으려고 그 규칙을 {@link RoutePolicy}로
	 * 옮겼다 — 규칙이 두 벌이면 한쪽만 고쳐지는 사고가 반복된다.
	 */
	private static boolean isLogin(HttpServletRequest request) {
		RoutePolicy.Route route = RoutePolicy.match(request.getMethod(), request.getRequestURI());
		return route != null && LOGIN_ROUTE_ID.equals(route.id());
	}

}
