package harness.p0_spring;

import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * SPA 폴백 규칙 (CONTRACT.md "정적 서빙 + SPA 폴백") — Express isSpaFallbackRequest 동형.
 * GET|HEAD ∧ 경로가 /api*·/uploads* 아님(소문자 비교) ∧ Accept에 text/html 포함 → index.html.
 * 확장자 유무로 판정 금지(.do 경로에 점이 있어 반대로 동작).
 */
class SpaFallbackTest {

    @Test
    void getDoRouteWithHtmlAcceptFallsBack() {
        assertThat(SpaFallback.isFallbackRequest("GET", "/writer.do", "text/html,application/xhtml+xml")).isTrue();
    }

    @Test
    void headIsAlsoFallback() {
        assertThat(SpaFallback.isFallbackRequest("HEAD", "/list.do", "text/html")).isTrue();
    }

    @Test
    void postNeverFallsBack() {
        assertThat(SpaFallback.isFallbackRequest("POST", "/writer.do", "text/html")).isFalse();
    }

    @Test
    void apiPrefixExcludedCaseInsensitive() {
        assertThat(SpaFallback.isFallbackRequest("GET", "/api", "text/html")).isFalse();
        assertThat(SpaFallback.isFallbackRequest("GET", "/api/session", "text/html")).isFalse();
        assertThat(SpaFallback.isFallbackRequest("GET", "/API/unknown", "text/html")).isFalse();
    }

    @Test
    void apidocsIsNotExcluded() {
        // 접두사 문자열 비교만 하면 오제외 — 정확 일치 또는 하위 경로만 제외한다.
        assertThat(SpaFallback.isFallbackRequest("GET", "/apidocs", "text/html")).isTrue();
    }

    @Test
    void uploadsPrefixExcluded() {
        assertThat(SpaFallback.isFallbackRequest("GET", "/uploads/a.png", "text/html")).isFalse();
    }

    @Test
    void nonHtmlAcceptDoesNotFallBack() {
        // undici fetch 기본 Accept: */* — 해시 어긋난 /assets/*.js 가 200 HTML이 되는 함정 차단.
        assertThat(SpaFallback.isFallbackRequest("GET", "/writer.do", "*/*")).isFalse();
        assertThat(SpaFallback.isFallbackRequest("GET", "/writer.do", null)).isFalse();
    }
}
