package harness.news.web;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.List;
import org.junit.jupiter.api.Test;

/**
 * SPA 폴백 판정 규칙 — <b>HTTP 없이</b> 규칙만 잠근다.
 *
 * <p>정본은 Node {@code server/index.js} 176~196행({@code SPA_EXCLUDED_PREFIXES} ·
 * {@code isSpaFallbackRequest})이고, 그 규칙의 잠금은 {@code test/spa-serving.test.js}의 <b>A1~A4</b>다.
 * 이 클래스는 그 네 항을 그대로 옮긴다(그 파일은 무접촉이며 여기서는 <b>명세서로만</b> 읽었다).
 *
 * <h2>세 게이트가 각각 무엇을 막는가</h2>
 * <ul>
 * <li><b>메서드</b>(GET/HEAD) — 쓰기 요청이 HTML 200을 받으면 클라이언트는 실패를 성공으로 읽는다.</li>
 * <li><b>예약 접두사</b>({@code /api} · {@code /uploads}) — 이 게이트가 없으면 <b>미정의 {@code /api} 경로가
 * SPA 200으로 뒤집힌다</b>. 계약 하네스는 {@code SPA_DIR}을 자식에게 넘기지 않으므로(313관측이 언제나
 * 비활성 상태로 돈다) 그 결함을 <b>영원히 보지 못한다</b> — 이 파일과 {@link SpaServingWireTest}가 유일
 * 방어선이다.</li>
 * <li><b>{@code Accept: text/html}</b> — 없으면 해시가 어긋난 {@code /assets/*.js}가 200 HTML이 되어 화면이
 * 조용히 깨진다(Node 184~186행 주석 · C16).</li>
 * </ul>
 *
 * <p>소문자화의 근거도 Node 주석 그대로다(178~179행): Express 라우팅이 기본 case-insensitive라
 * {@code /API/...}도 API 네임스페이스다. 대소문자를 구분하면 매칭 라우트가 없는 {@code /API/unknown}이
 * HTML을 받는다.
 */
class SpaFallbackRulesTest {

	private static final String HTML_ACCEPT = "text/html,application/xhtml+xml,*/*;q=0.8";

	/** A1: 브라우저 내비게이션 GET은 true. */
	@Test
	void aBrowserNavigationIsAFallbackRequest() {
		for (String path : List.of("/list.do", "/writer.do", "/", "/login.do", "/unknown/deep/path")) {
			assertTrue(SpaFallbackRules.isSpaFallbackRequest("GET", path, HTML_ACCEPT), path);
		}
	}

	/** A2: 메서드 게이트 — GET/HEAD만 true. */
	@Test
	void onlyGetAndHeadAreFallbackRequests() {
		for (String method : List.of("POST", "PUT", "DELETE", "OPTIONS", "PATCH", "get")) {
			assertFalse(SpaFallbackRules.isSpaFallbackRequest(method, "/list.do", HTML_ACCEPT), method);
		}
		assertTrue(SpaFallbackRules.isSpaFallbackRequest("HEAD", "/list.do", HTML_ACCEPT));
		assertTrue(SpaFallbackRules.isSpaFallbackRequest("GET", "/list.do", HTML_ACCEPT));
	}

	/** A3: 예약 접두사 게이트 — 정확 일치·하위 경로, <b>대소문자 무관</b>. */
	@Test
	void reservedPrefixesAreNeverFallbackRequests() {
		for (String path : List.of("/api", "/api/", "/api/health", "/api/stream", "/uploads", "/uploads/x.png")) {
			assertFalse(SpaFallbackRules.isSpaFallbackRequest("GET", path, HTML_ACCEPT), path);
		}
		for (String path : List.of("/API/health", "/Api/unknown", "/UPLOADS/x.png", "/Uploads")) {
			assertFalse(SpaFallbackRules.isSpaFallbackRequest("GET", path, HTML_ACCEPT), path);
		}
	}

	/** A3(뒷면): 접두사가 단어 경계에서 끊기지 않으면 제외 대상이 아니다(단순 startsWith 금지의 잠금). */
	@Test
	void aPrefixThatDoesNotEndAtASegmentBoundaryIsNotReserved() {
		for (String path : List.of("/apidocs", "/uploadsomething", "/api-docs", "/uploads.do")) {
			assertTrue(SpaFallbackRules.isSpaFallbackRequest("GET", path, HTML_ACCEPT), path);
		}
	}

	/** A4: {@code Accept} 게이트 — {@code text/html} 포함일 때만 true. */
	@Test
	void onlyRequestsThatAcceptHtmlAreFallbackRequests() {
		for (String accept : new String[] { "*/*", "application/json", null, "", "text/plain" }) {
			assertFalse(SpaFallbackRules.isSpaFallbackRequest("GET", "/list.do", accept), String.valueOf(accept));
		}
		assertTrue(SpaFallbackRules.isSpaFallbackRequest("GET", "/list.do", "text/html"));
	}

	/** 경로가 null이면 판정할 것이 없다 — throw 하지 않고 false다. */
	@Test
	void aMissingPathIsNotAFallbackRequest() {
		assertFalse(SpaFallbackRules.isSpaFallbackRequest("GET", null, HTML_ACCEPT));
	}

	/**
	 * 매핑 게이트({@code isCandidate})는 <b>{@code Accept}를 보지 않는다</b> — 실재하는 자산은
	 * {@code Accept: *&#47;*}로도 서빙돼야 하기 때문이다(B6). {@code Accept} 게이트는 <b>폴백</b>에만 걸린다.
	 */
	@Test
	void theMappingGateIgnoresAcceptButKeepsMethodAndReservedPrefixes() {
		assertTrue(SpaFallbackRules.isCandidate("GET", "/assets/app-abc123.js"));
		assertTrue(SpaFallbackRules.isCandidate("HEAD", "/list.do"));
		assertFalse(SpaFallbackRules.isCandidate("POST", "/list.do"));
		assertFalse(SpaFallbackRules.isCandidate("GET", "/api/health"));
		assertFalse(SpaFallbackRules.isCandidate("GET", "/UPLOADS/x.png"));
		assertFalse(SpaFallbackRules.isCandidate("GET", null));
	}
}
