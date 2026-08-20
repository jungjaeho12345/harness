package harness.news.web;

import harness.news.service.Identity;
import harness.news.service.SessionGuard;
import jakarta.servlet.Filter;
import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.ServletRequest;
import jakarta.servlet.ServletResponse;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import java.io.IOException;

/**
 * 선언된 보호 경로의 <b>미인증 401</b> — 스텁 핸들러가 아니라 경계 정책이다.
 *
 * <p>Node는 라우트 <b>안에서</b> 세션을 검사한다. 이 phase에는 기사·사용자·로그 핸들러가 아직 없지만
 * 결과는 동형이어야 한다: {@code session-guard.contract.js}의 마지막 케이스가 죽은 토큰으로
 * {@code GET /api/articles}를 호출해 401 {@code {ok:false, reason:'unauthenticated'}}를 요구한다.
 * 그 401을 만드는 것이 이 필터다.
 *
 * <h2>넓히지 않는다</h2>
 * <ul>
 *   <li>{@code /api/**} 와일드카드로 걸지 않는다 — 미정의 경로가 401이 되면 "404 + 비-JSON"이라는 동결된
 *       에러 shape이 깨진다. 표({@link RoutePolicy})에 <b>매칭되는 경로만</b> 본다.</li>
 *   <li>{@code auth: "token"} 라우트는 대상이 아니다(표가 클래스를 보존한다).</li>
 *   <li>인증된 요청은 통과시킨다 — 핸들러가 없으면 404가 되며 <b>그것이 의도된 상태</b>다
 *       (구현 여부가 정직하게 드러난다).</li>
 * </ul>
 *
 * <h2>경로 판정을 여기서 하지 않는다</h2>
 * 경로 문자열을 이 필터가 직접 비교하면 컨테이너가 라우팅에 쓰는 형태와 어긋난다. 정규화 규칙
 * (후행 슬래시 · 경로 파라미터 {@code ;k=v} · 1회 퍼센트 디코딩 · HEAD→GET)은 전부 {@link RoutePolicy}가
 * 소유하며, 어긋나는 순간 그 차이가 곧 인가 우회다(2026-08-20 실측: 미인증 {@code GET /api/articles}는 401인데
 * {@code GET /api/articles;a=b}는 404였다 = 이 필터가 못 보는 요청을 디스패처는 핸들러로 보낸다).
 *
 * <p>세션 판정은 {@link SessionGuard}를 통해서만 한다(스토어 직접 접근 금지) — 가드가 매 조회 User 행을
 * 다시 읽어 비활성·강등을 즉시 반영한다(ADR-004). 토큰 판독은 {@link SessionTokens}(쿠키 우선 · 헤더 폴백,
 * 쿼리는 구조적으로 읽을 수 없다).
 */
final class PathPolicyFilter implements Filter {

	private final SessionGuard sessions;

	private final JsonHttp json;

	PathPolicyFilter(SessionGuard sessions, JsonHttp json) {
		this.sessions = sessions;
		this.json = json;
	}

	@Override
	public void doFilter(ServletRequest request, ServletResponse response, FilterChain chain)
			throws IOException, ServletException {
		HttpServletRequest httpRequest = (HttpServletRequest) request;

		if (!RoutePolicy.requiresSession(httpRequest.getMethod(), httpRequest.getRequestURI())) {
			chain.doFilter(request, response);
			return;
		}

		String token = SessionTokens.read(httpRequest.getHeader("cookie"),
				httpRequest.getHeader(SessionTokens.HEADER_NAME));
		Identity identity = (token == null) ? null : this.sessions.touchSession(token);
		if (identity == null) {
			this.json.write(httpRequest, (HttpServletResponse) response, ReasonStatus.of("unauthenticated"),
					JsonHttp.fail("unauthenticated"));
			return;
		}

		chain.doFilter(request, response);
	}
}
