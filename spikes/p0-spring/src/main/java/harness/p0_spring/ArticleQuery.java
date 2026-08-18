package harness.p0_spring;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;

/**
 * /api/articles 쿼리 빌더 — src/models/articleModel.js query() 동형 (CONTRACT.md /api/articles 절).
 * 화이트리스트 키만 통과(그 외 무시), 값은 전부 바인드 파라미터(문자열 연결 금지).
 */
public final class ArticleQuery {

    public record Built(String sql, List<String> params) {
    }

    private ArticleQuery() {
    }

    private static String[] values(Map<String, String[]> query, String key) {
        String[] v = query.get(key);
        return (v == null || v.length == 0) ? null : v;
    }

    private static String first(Map<String, String[]> query, String key) {
        String[] v = values(query, key);
        return v == null ? null : v[0];
    }

    private static String placeholders(int n) {
        return String.join(", ", java.util.Collections.nCopies(n, "?"));
    }

    public static Built build(Map<String, String[]> query) {
        List<String> conds = new ArrayList<>();
        List<String> params = new ArrayList<>();

        // 스칼라 동등 조건 — articleId/author/sender.
        for (String key : new String[]{"articleId", "author", "sender"}) {
            String v = first(query, key);
            if (v != null) {
                conds.add(key + " = ?");
                params.add(v);
            }
        }

        // status 포함 — 반복 키 = IN.
        String[] status = values(query, "status");
        if (status != null) {
            conds.add("status IN (" + placeholders(status.length) + ")");
            params.addAll(List.of(status));
        }

        // status 제외 — NOT IN.
        String[] exclude = values(query, "excludeStatus");
        if (exclude != null) {
            conds.add("status NOT IN (" + placeholders(exclude.length) + ")");
            params.addAll(List.of(exclude));
        }

        // 부서 다중 선택 — departments 배열 우선, 없으면 department 단일.
        String[] departments = values(query, "departments");
        if (departments == null) {
            String single = first(query, "department");
            if (single != null) {
                departments = new String[]{single};
            }
        }
        if (departments != null) {
            conds.add("department IN (" + placeholders(departments.length) + ")");
            params.addAll(List.of(departments));
        }

        // 시간 범위 — ISO-8601 UTC 문자열은 사전식 비교로 범위가 성립한다.
        for (String[] range : new String[][]{
                {"createdAt", "createdAtFrom", "createdAtTo"},
                {"sentAt", "sentAtFrom", "sentAtTo"},
                {"distributedAt", "distributedAtFrom", "distributedAtTo"}}) {
            String from = first(query, range[1]);
            if (from != null) {
                conds.add(range[0] + " >= ?");
                params.add(from);
            }
            String to = first(query, range[2]);
            if (to != null) {
                conds.add(range[0] + " <= ?");
                params.add(to);
            }
        }

        String where = conds.isEmpty() ? "" : " WHERE " + String.join(" AND ", conds);
        return new Built("SELECT * FROM Contents" + where + " ORDER BY createdAt DESC", params);
    }
}
