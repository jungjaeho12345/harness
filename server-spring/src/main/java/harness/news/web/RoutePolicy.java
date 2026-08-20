package harness.news.web;

import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.Locale;
import java.util.regex.Pattern;
import org.springframework.web.util.UriUtils;

/**
 * 경로 → {@code auth} 클래스 표.
 *
 * <h2>출처</h2>
 * {@code docs/api-contract/endpoints.json}(39행)의 복제본이다. <b>런타임에 그 문서를 읽지 않는다</b> —
 * 배포 산출물(jar)에 문서가 없기 때문이다. 대신 {@code RoutePolicyTest}가 두 벌을 대조해 드리프트를 막는다.
 * <b>라우트가 늘면 인벤토리와 이 표를 함께 갱신한다.</b>
 *
 * <h2>클래스를 보존한다(뭉개지 않는다)</h2>
 * "{@code public}이 아니면 세션"으로 뭉개면 {@code auth: "token"} 라우트(수집 2건)가 유효 토큰에도 401이 된다
 * — 그 둘은 {@code x-collection-token} + loopback으로 인증하므로 세션이 <b>없는 것이 정상</b>이고,
 * 이 표는 후속 phase가 그대로 물려받기 때문에 오류가 수집 도메인까지 상속된다. 그래서 클래스를 그대로 남기고
 * {@link AuthClass#requiresSession()}만 {@code false}로 둔다(수집 도메인 phase가 fail-closed 503 → 토큰 인증
 * 순서까지 포함해 소유한다).
 *
 * <h2>세션을 요구한다는 것의 의미</h2>
 * 이 표는 <b>세션 유무</b>만 본다. 역할(session-role)·관리자(admin)·잠금 보유자(lock-holder) 판정은 라우트가
 * 자기 문맥으로 한다(Node 동형) — 여기서 흉내 내면 판정이 두 곳으로 갈라진다.
 */
final class RoutePolicy {

	/** {@code endpoints.json}의 {@code auth} 값 6종. */
	enum AuthClass {

		/** 인증 불요. */
		PUBLIC("public", false),
		/** 유효 세션 필요. */
		SESSION("session", true),
		/** 유효 세션 + 라우트의 역할 판정. */
		SESSION_ROLE("session-role", true),
		/** 유효 세션 + 관리자(Z) 판정. */
		ADMIN("admin", true),
		/** 유효 세션 + 편집 잠금 보유 판정. */
		LOCK_HOLDER("lock-holder", true),
		/**
		 * {@code x-collection-token} + loopback 인증. <b>세션 요구 대상이 아니다</b>
		 * — 수집 도메인 phase 소유(fail-closed 503 → 토큰 인증 순서 포함).
		 */
		TOKEN("token", false);

		private final String token;

		private final boolean requiresSession;

		AuthClass(String token, boolean requiresSession) {
			this.token = token;
			this.requiresSession = requiresSession;
		}

		/** 인벤토리 문자열({@code endpoints.json}의 {@code auth} 값). */
		String token() {
			return this.token;
		}

		/** 이 phase의 경로 정책 필터가 세션을 요구하는가. */
		boolean requiresSession() {
			return this.requiresSession;
		}
	}

	/** 표의 한 행 — 인벤토리 1행과 1:1이다. */
	static final class Route {

		private final String id;

		private final String method;

		private final String path;

		private final AuthClass auth;

		private final Pattern pattern;

		Route(String id, String method, String path, AuthClass auth) {
			this.id = id;
			this.method = method;
			this.path = path;
			this.auth = auth;
			this.pattern = compile(path);
		}

		String id() {
			return this.id;
		}

		String method() {
			return this.method;
		}

		String path() {
			return this.path;
		}

		AuthClass auth() {
			return this.auth;
		}

		boolean matches(String candidate) {
			return this.pattern.matcher(candidate).matches();
		}

		/** {@code :param}은 세그먼트 <b>하나</b>만 먹는다(슬래시를 넘지 않는다). 나머지는 리터럴이다. */
		private static Pattern compile(String path) {
			StringBuilder regex = new StringBuilder();
			for (String segment : path.split("/", -1)) {
				if (regex.length() > 0) {
					regex.append('/');
				}
				regex.append(segment.startsWith(":") ? "[^/]+" : Pattern.quote(segment));
			}
			return Pattern.compile(regex.toString());
		}
	}

	/**
	 * 표 본문 — 순서·표기 모두 {@code docs/api-contract/endpoints.json}과 같다.
	 * 매칭은 <b>선언 순서 우선</b>이라 리터럴 경로({@code /api/articles/search})가 같은 모양의
	 * 파라미터 경로({@code /api/articles/:id})보다 앞에 있어야 한다 — 그 순서도 인벤토리가 이미 지키고 있다.
	 */
	static final List<Route> ROUTES = List.of(
			new Route("health", "GET", "/api/health", AuthClass.PUBLIC),
			new Route("login", "POST", "/api/login", AuthClass.PUBLIC),
			new Route("logout", "POST", "/api/logout", AuthClass.PUBLIC),
			new Route("session", "GET", "/api/session", AuthClass.SESSION),
			new Route("users-list", "GET", "/api/users", AuthClass.SESSION),
			new Route("users-create", "POST", "/api/users", AuthClass.ADMIN),
			new Route("users-update", "PUT", "/api/users/:id", AuthClass.ADMIN),
			new Route("receiver-config-list", "GET", "/api/receiver-config", AuthClass.ADMIN),
			new Route("receiver-config-create", "POST", "/api/receiver-config", AuthClass.ADMIN),
			new Route("receiver-config-delete", "DELETE", "/api/receiver-config/:id", AuthClass.ADMIN),
			new Route("distribution-targets-list", "GET", "/api/distribution-targets", AuthClass.ADMIN),
			new Route("distribution-targets-create", "POST", "/api/distribution-targets", AuthClass.ADMIN),
			new Route("distribution-targets-update", "PUT", "/api/distribution-targets/:id", AuthClass.ADMIN),
			new Route("distribution-targets-deactivate", "POST", "/api/distribution-targets/:id/deactivate",
					AuthClass.ADMIN),
			new Route("distribution-tick", "POST", "/api/distribution/tick", AuthClass.ADMIN),
			new Route("distribution-failures", "GET", "/api/distribution/failures", AuthClass.ADMIN),
			new Route("distribution-retry", "POST", "/api/distribution/retry", AuthClass.ADMIN),
			new Route("articles-search", "GET", "/api/articles/search", AuthClass.SESSION),
			new Route("articles-list", "GET", "/api/articles", AuthClass.SESSION),
			new Route("articles-get", "GET", "/api/articles/:id", AuthClass.SESSION),
			new Route("articles-history", "GET", "/api/articles/:id/history", AuthClass.SESSION),
			new Route("articles-history-snapshot", "GET", "/api/articles/:id/history/:historyId", AuthClass.SESSION),
			new Route("articles-create", "POST", "/api/articles", AuthClass.SESSION_ROLE),
			new Route("articles-action", "POST", "/api/articles/:id/action", AuthClass.SESSION_ROLE),
			new Route("articles-derive", "POST", "/api/articles/:id/derive", AuthClass.SESSION_ROLE),
			new Route("articles-translate", "POST", "/api/articles/:id/translate", AuthClass.SESSION),
			new Route("articles-update", "PUT", "/api/articles/:id", AuthClass.LOCK_HOLDER),
			new Route("articles-lock", "POST", "/api/articles/:id/lock", AuthClass.SESSION),
			new Route("articles-unlock", "POST", "/api/articles/:id/unlock", AuthClass.LOCK_HOLDER),
			new Route("articles-force-unlock", "POST", "/api/articles/:id/force-unlock", AuthClass.SESSION_ROLE),
			new Route("media-search", "GET", "/api/media/search", AuthClass.SESSION),
			new Route("upload", "POST", "/api/upload", AuthClass.SESSION),
			new Route("photos-create", "POST", "/api/photos", AuthClass.SESSION),
			new Route("photos-search", "GET", "/api/photos/search", AuthClass.SESSION),
			new Route("collection-receive", "POST", "/api/collection/receive", AuthClass.TOKEN),
			new Route("collection-pull", "POST", "/api/collection/pull", AuthClass.TOKEN),
			new Route("stream", "GET", "/api/stream", AuthClass.SESSION),
			new Route("logs-digest", "GET", "/api/logs/digest", AuthClass.ADMIN),
			new Route("logs-stream", "GET", "/api/logs/stream", AuthClass.ADMIN));

	private RoutePolicy() {
	}

	/**
	 * 요청에 해당하는 행. 없으면 {@code null}이며 <b>그 요청은 그대로 통과</b>한다(컨테이너 404로 흘러간다).
	 *
	 * @param method HTTP 메서드. {@code HEAD}는 {@code GET}으로 본다 — express가 HEAD를 GET 핸들러로
	 *     라우팅하므로 Node의 {@code HEAD /api/articles}도 401이다.
	 * @param path 요청 경로(쿼리 제외 — {@code getRequestURI()}의 <b>원문</b>을 그대로 준다).
	 *     후행 슬래시 · 경로 파라미터({@code ;k=v}) · 퍼센트 인코딩은 이 클래스가 정규화한다.
	 */
	static Route match(String method, String path) {
		Route direct = matchNormalized(method, path);
		return (direct != null) ? direct : matchNormalized(method, decode(path));
	}

	/**
	 * 이 요청이 유효 세션을 요구하는가 — 원문·디코딩 중 <b>하나라도</b> 요구하면 요구한다.
	 * 표에 없으면 요구하지 않는다(그 요청은 통과해 컨테이너 404가 된다).
	 */
	static boolean requiresSession(String method, String path) {
		return demandsSession(matchNormalized(method, path)) || demandsSession(matchNormalized(method, decode(path)));
	}

	private static boolean demandsSession(Route route) {
		return route != null && route.auth().requiresSession();
	}

	private static Route matchNormalized(String method, String path) {
		if (method == null || path == null) {
			return null;
		}
		String verb = method.toUpperCase(Locale.ROOT);
		String routed = "HEAD".equals(verb) ? "GET" : verb;
		String normalized = normalize(path);
		for (Route route : ROUTES) {
			if (route.method().equals(routed) && route.matches(normalized)) {
				return route;
			}
		}
		return null;
	}

	/**
	 * 정규화 파이프라인 — <b>경로 파라미터 제거 → 후행 슬래시 제거</b>. {@link #decode(String)}까지 합쳐
	 * 세 규칙이 한 곳에 있어야 한다(규칙이 흩어지면 한쪽만 고쳐지는 사고가 반복된다 — step10의 교훈).
	 *
	 * <ul>
	 *   <li><b>경로 파라미터</b>({@code ;name=value}): Spring의 {@code PathPatternParser}/{@code RequestPath}는
	 *       세그먼트에서 이 부분을 <b>떼어내고</b> 매칭한다. 표가 원문만 보면 디스패처는
	 *       {@code POST /api/login;x=1}을 로그인 핸들러로 보내는데 이 표는 아무 행도 돌려주지 않는다 =
	 *       리터럴 경로 <b>전부</b>의 게이트가 세미콜론 한 글자로 우회된다(2026-08-20 실측: {@code ;x=1}로 12회를
	 *       쳐도 전건 401 · 429 없음 · 미인증 {@code GET /api/articles;a=b}는 404).</li>
	 *   <li><b>후행 슬래시</b>: express는 기본(strict routing off)에서 {@code /api/articles/}를 같은 라우트로 본다.</li>
	 * </ul>
	 */
	private static String normalize(String path) {
		String trimmed = stripPathParameters(path);
		while (trimmed.length() > 1 && trimmed.endsWith("/")) {
			trimmed = trimmed.substring(0, trimmed.length() - 1);
		}
		return trimmed;
	}

	/**
	 * 세그먼트마다 첫 {@code ;} 이후를 잘라낸다({@code PathContainer} 파싱과 동형).
	 *
	 * <p>이 정규화는 원문뿐 아니라 <b>디코딩한 형태에도</b> 걸린다(같은 파이프라인이므로). 그래서
	 * {@code /api/articles%3Ba=b}처럼 컨테이너가 파라미터로 보지 <b>않는</b> 경로까지 세션을 요구하게 되는데,
	 * 그것은 의도한 과대 판정이다 — 이 클래스의 규율대로 <b>넓은 쪽으로만</b> 틀린다(세지 않아 뚫리는 것보다
	 * 세고 나서 404가 되는 편이 안전하다). 표에 없는 경로는 파라미터를 떼어내도 여전히 표 밖이므로
	 * "미정의 경로 = 404 비-JSON" 계약은 그대로다.
	 */
	private static String stripPathParameters(String path) {
		if (path.indexOf(';') < 0) {
			return path;
		}
		String[] segments = path.split("/", -1);
		StringBuilder stripped = new StringBuilder(path.length());
		for (int i = 0; i < segments.length; i++) {
			if (i > 0) {
				stripped.append('/');
			}
			int semicolon = segments[i].indexOf(';');
			stripped.append((semicolon < 0) ? segments[i] : segments[i].substring(0, semicolon));
		}
		return stripped.toString();
	}

	/**
	 * 컨테이너가 <b>라우팅에 실제로 쓰는 형태</b>(세그먼트 1회 디코딩). 인코딩이 없거나 깨졌으면 {@code null}
	 * — 그러면 원문 판정만 남는다(깨진 인코딩은 컨테이너가 400으로 거른다. 여기서 추측하지 않는다).
	 *
	 * <h3>왜 원문만 보면 안 되는가(실측)</h3>
	 * Spring의 {@code PathPatternParser}는 세그먼트를 디코딩해 매칭하므로 {@code GET /api/artic%6Ces}는
	 * <b>{@code /api/articles} 핸들러로 라우팅된다</b>(express는 반대로 원문 매칭이라 404다 — 이식 과정에서
	 * 새로 생긴 표면이다). 2026-08-20 실측: 원문만 보던 시절 미인증 {@code GET /api/articles}는 401인데
	 * {@code GET /api/artic%6Ces}는 경로 정책 필터를 통과해 404가 됐다. 핸들러가 없어 404로 끝났을 뿐,
	 * 실제 핸들러가 붙는 순간 <b>미인증 요청이 핸들러에 도달</b>한다.
	 *
	 * <h3>판정은 넓은 쪽으로만 틀린다</h3>
	 * 원문·디코딩 <b>둘 다</b> 보는 이유는 두 방향의 오류가 비대칭이기 때문이다: 세지 않아 뚫리는 것보다
	 * 세고 나서 404가 되는 편이 안전하다. 그래서 {@code /api/articles/AKR%2F1}처럼 디코딩하면 세그먼트가
	 * 갈라져 매칭이 사라지는 경로도 원문 판정으로 게이트가 유지된다. 디코딩은 <b>한 번만</b> 한다
	 * — 두 번 풀면 표가 컨테이너보다 넓어져 미정의 경로가 401이 되고 "미정의 = 404 비-JSON" 계약이 깨진다.
	 */
	private static String decode(String path) {
		if (path == null || path.indexOf('%') < 0) {
			return null;
		}
		try {
			return UriUtils.decode(path, StandardCharsets.UTF_8);
		}
		catch (IllegalArgumentException ex) {
			return null;
		}
	}
}
