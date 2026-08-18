package harness.p0_spring;

import java.util.List;

/**
 * SPA 폴백 규칙 (CONTRACT.md "정적 서빙 + SPA 폴백") — server/index.js isSpaFallbackRequest 동형.
 * GET|HEAD ∧ 경로가 /api*·/uploads* 아님(소문자 비교) ∧ Accept에 text/html 포함 → index.html.
 * 확장자 유무 판정 금지 — .do 경로에 점이 있어 반대로 동작한다.
 */
public final class SpaFallback {

    private static final List<String> EXCLUDED_PREFIXES = List.of("/api", "/uploads");

    private SpaFallback() {
    }

    /** 예약 접두사(정확 일치 또는 하위 경로)인가 — /apidocs 는 제외 대상이 아니다. */
    public static boolean isExcludedPath(String path) {
        if (path == null) {
            return true;
        }
        String lower = path.toLowerCase();
        for (String prefix : EXCLUDED_PREFIXES) {
            if (lower.equals(prefix) || lower.startsWith(prefix + "/")) {
                return true;
            }
        }
        return false;
    }

    public static boolean isFallbackRequest(String method, String path, String accept) {
        if (!"GET".equals(method) && !"HEAD".equals(method)) {
            return false;
        }
        if (path == null || isExcludedPath(path)) {
            return false;
        }
        return accept != null && accept.contains("text/html");
    }
}
