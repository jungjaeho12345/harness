package harness.news.web;

import jakarta.servlet.Filter;
import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.ServletRequest;
import jakarta.servlet.ServletResponse;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import java.io.IOException;
import java.util.Locale;
import java.util.Set;

/**
 * CSRF 방어 — 상태 변경 메서드 전용 Origin/Referer 게이트(ADR-009, server/index.js
 * {@code csrfOriginGuard} 동형).
 *
 * <p>CORS는 simple request의 <b>실행</b>을 막지 않고 <b>응답 읽기</b>만 막는다 → 본문 없는 cross-site POST가
 * 피해자 쿠키와 함께 실행되는 표면을 여기서 닫는다. 브라우저는 비-GET에 Origin을 항상 붙인다(Fetch 표준).
 *
 * <h2>판정 순서(그대로가 계약이다)</h2>
 * <ol>
 *   <li>GET·HEAD·OPTIONS는 보지 않는다(OPTIONS는 애초에 {@link CorsFilter}가 끝낸다).</li>
 *   <li>Origin → 없으면 Referer의 origin.</li>
 *   <li><b>둘 다 없으면 통과</b> — 서버-서버/cron 클라이언트다(브라우저 공격 벡터가 아니다).
 *       계약 스위트 전체가 이 관용 위에서 돈다.</li>
 *   <li>Referer가 해석 불가면 403(통과가 아니다).</li>
 *   <li>자기 출처면 통과 → allowlist면 통과 → 비프로덕션이면 loopback 관용 → 그 외 403.</li>
 * </ol>
 *
 * <h2>지키는 두 가지 규율</h2>
 * <ul>
 *   <li><b>라우트별 예외 목록을 두지 않는다.</b> 서버-서버 관용은 "Origin·Referer 부재" 단일 규칙으로만
 *       표현한다 — 예외 목록은 이식 과정에서 조용히 늘어나 게이트를 무력화한다.</li>
 *   <li><b>자기 출처 판정에 {@code X-Forwarded-Host}/{@code X-Forwarded-Proto}를 쓰지 않는다.</b>
 *       헤더 스푸핑으로 게이트가 통째로 뚫린다(Node 주석의 CRITICAL). 호스트 재작성 배포는
 *       {@code ALLOWED_ORIGINS}로 명시 등록한다. 그래서 판정에 쓰는 값은 요청 라인의 스킴과
 *       <b>{@code Host} 헤더 원문</b>뿐이다({@code server.forward-headers-strategy=none}도 함께 잠근다).</li>
 * </ul>
 */
final class CsrfOriginFilter implements Filter {

	/** 상태를 바꾸지 않는 메서드 — 게이트 대상이 아니다. */
	private static final Set<String> SAFE_METHODS = Set.of("GET", "HEAD", "OPTIONS");

	/**
	 * 거부 상태. Node도 전역 사유→상태 표({@code STATUS_BY_REASON})가 아니라 <b>가드가 직접</b> 403을 낸다
	 * — {@code forbidden-origin}은 그 표에 없다(docs/api-contract/reason-tokens.md 표 2 #14).
	 */
	private static final int FORBIDDEN_ORIGIN_STATUS = 403;

	private final AllowedOrigins origins;

	private final JsonHttp json;

	CsrfOriginFilter(AllowedOrigins origins, JsonHttp json) {
		this.origins = origins;
		this.json = json;
	}

	@Override
	public void doFilter(ServletRequest request, ServletResponse response, FilterChain chain)
			throws IOException, ServletException {
		HttpServletRequest httpRequest = (HttpServletRequest) request;
		HttpServletResponse httpResponse = (HttpServletResponse) response;

		if (SAFE_METHODS.contains(httpRequest.getMethod().toUpperCase(Locale.ROOT))) {
			chain.doFilter(request, response);
			return;
		}

		String claimed = httpRequest.getHeader("Origin");
		if (claimed == null || claimed.isBlank()) {
			String referer = httpRequest.getHeader("Referer");
			if (referer == null || referer.isBlank()) {
				chain.doFilter(request, response); // 서버-서버/cron 관용.
				return;
			}
			claimed = Origins.fromReferer(referer);
			if (claimed == null) {
				reject(httpRequest, httpResponse);
				return;
			}
		}

		if (claimed.equals(selfOrigin(httpRequest)) || this.origins.allows(claimed)
				|| (!this.origins.production() && Origins.isLoopback(claimed))) {
			chain.doFilter(request, response);
			return;
		}
		reject(httpRequest, httpResponse);
	}

	/**
	 * 자기 출처 문자열. {@code Host} 헤더가 없는 비정상 요청은 {@code null}이라 어떤 Origin과도 같지 않다
	 * (그 요청은 allowlist·loopback 관용으로만 통과할 수 있다).
	 */
	private static String selfOrigin(HttpServletRequest request) {
		String host = request.getHeader("Host"); // X-Forwarded-Host를 보지 않는다.
		return (host == null || host.isBlank()) ? null : request.getScheme() + "://" + host;
	}

	private void reject(HttpServletRequest request, HttpServletResponse response) {
		this.json.write(request, response, FORBIDDEN_ORIGIN_STATUS, JsonHttp.fail("forbidden-origin"));
	}
}
