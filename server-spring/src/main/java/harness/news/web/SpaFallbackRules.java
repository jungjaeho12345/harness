package harness.news.web;

import java.util.List;
import java.util.Locale;

/**
 * SPA 폴백 판정 — Node {@code server/index.js} 176~196행의 <b>순수 이식</b>이다.
 *
 * <p>규칙의 정본 잠금은 {@code test/spa-serving.test.js}의 A1~A4이고, 이 클래스의 동형 잠금은
 * {@code SpaFallbackRulesTest}다. HTTP 없이 값 세 개만 받는다(정본과 같은 형태).
 *
 * <h2>이 판정이 틀리면 계약은 영원히 모른다</h2>
 * 계약 하네스({@code scripts/spring-contract.mjs})의 {@code javaChildEnv()}는 허용목록 방식이라
 * {@code SPA_DIR}을 자식에게 넘기지 않는다 — 313관측 × 2축은 <b>SPA가 꺼진 상태로</b> 돈다. 그래서
 * "미정의 {@code /api} 경로가 SPA 200으로 뒤집히는" 결함은 계약이 <b>구조적으로</b> 볼 수 없다
 * (2026-09-05 실측: 예약 접두사에서 {@code /api}를 지운 변이 M2에서도 313관측 diffs 0이었다).
 * 유일 방어선은 이 클래스와 {@code SpaServingWireTest}다.
 *
 * <h2>세 게이트</h2>
 * <ol>
 * <li><b>메서드</b> — {@code GET}·{@code HEAD}만.</li>
 * <li><b>예약 접두사</b> — {@code /api}·{@code /uploads}와 <b>정확히 같거나</b> {@code <접두사>/}로 시작하면
 * 폴백하지 않는다. 비교는 <b>소문자화</b>한다: Express 라우팅이 기본 case-insensitive라 {@code /API/...}도
 * API 네임스페이스이고, 대소문자를 구분하면 매칭 라우트가 없는 {@code /API/unknown}이 HTML을 받는다
 * (Node 178~179행). 단순 {@code startsWith}는 금지다 — {@code /apidocs}가 오제외된다(Node 177행).</li>
 * <li><b>{@code Accept}</b> — {@code text/html}을 포함할 때만. 없으면 해시가 어긋난 {@code /assets/*.js}가
 * 200 HTML로 응답돼 화면이 조용히 깨진다. 확장자 유무 판정은 <b>기각</b>이다 — {@code .do} 경로에 점이
 * 있어 반대로 동작한다(Node 184~186행).</li>
 * </ol>
 *
 * <p>경로 문자열은 {@code request.getRequestURI()}(요청줄 원문 · 쿼리 제외)에서 온다 —
 * {@link RoutePolicy}·{@link PathPolicyFilter}가 쓰는 것과 같은 값이고, Express {@code req.path}(파싱된
 * pathname · 디코딩하지 않음)와 같은 자리다.
 */
final class SpaFallbackRules {

	/**
	 * SPA 폴백에서 제외하는 예약 접두사 — 정확히 일치하거나 그 하위 경로만 제외한다.
	 * Node {@code SPA_EXCLUDED_PREFIXES}(180행)와 같은 목록이며, 늘리거나 줄이는 것은 라우팅 계약 변경이다.
	 */
	private static final List<String> EXCLUDED_PREFIXES = List.of("/api", "/uploads");

	private static final String HTML = "text/html";

	private SpaFallbackRules() {
	}

	/**
	 * 이 요청에 {@code index.html}을 돌려줘야 하는가(= 브라우저 내비게이션인가).
	 *
	 * @param method HTTP 메서드
	 * @param path 요청 경로(쿼리 제외). {@code null}이면 판정할 것이 없으므로 false다
	 * @param accept {@code Accept} 헤더 원문. 없으면 false다
	 */
	static boolean isSpaFallbackRequest(String method, String path, String accept) {
		if (!isServableMethod(method) || path == null) {
			return false;
		}
		if (isReserved(path)) {
			return false;
		}
		return accept != null && accept.contains(HTML);
	}

	/**
	 * 이 요청을 SPA 핸들러가 <b>맡을 후보</b>인가 — 매핑 층의 게이트다.
	 *
	 * <p>{@code Accept}를 보지 <b>않는다</b>: 실재하는 자산은 {@code Accept: *&#47;*}로도 서빙돼야 하기
	 * 때문이다(정본 B6). {@code Accept} 게이트는 <b>폴백</b>에만 걸린다.
	 *
	 * <p>여기서 false면 SPA 핸들러가 아예 매핑되지 않고 요청은 <b>기존 경로 그대로</b> 흐른다
	 * ({@code /uploads/**} 정적 핸들러 · Boot 기본 {@code /**} → {@code NoResourceFoundException} →
	 * {@code GlobalErrorHandler} → {@code HtmlErrors.notFound}). 404를 직접 만들지 않는 이유가 이것이다 —
	 * 바이트가 갈리지 않는 유일한 방법은 그 경로를 건드리지 않는 것이다.
	 */
	static boolean isCandidate(String method, String path) {
		return isServableMethod(method) && path != null && !isReserved(path);
	}

	private static boolean isServableMethod(String method) {
		return "GET".equals(method) || "HEAD".equals(method);
	}

	private static boolean isReserved(String path) {
		String lower = path.toLowerCase(Locale.ROOT);
		for (String prefix : EXCLUDED_PREFIXES) {
			if (lower.equals(prefix) || lower.startsWith(prefix + "/")) {
				return true;
			}
		}
		return false;
	}
}
