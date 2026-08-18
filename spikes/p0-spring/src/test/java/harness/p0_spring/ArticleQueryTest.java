package harness.p0_spring;

import java.util.Map;
import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * /api/articles 쿼리 빌더 — src/models/articleModel.js query() 동형 (CONTRACT.md /api/articles 절).
 * 화이트리스트만 통과, 반복 키 배열 = IN, excludeStatus = NOT IN, departments 우선,
 * 시간 범위는 ISO-8601 문자열 사전식 비교, 정렬은 항상 createdAt DESC.
 */
class ArticleQueryTest {

    @Test
    void emptyQuerySelectsAllOrderedByCreatedAtDesc() {
        ArticleQuery.Built b = ArticleQuery.build(Map.of());
        assertThat(b.sql()).isEqualTo("SELECT * FROM Contents ORDER BY createdAt DESC");
        assertThat(b.params()).isEmpty();
    }

    @Test
    void repeatedStatusBecomesIn() {
        ArticleQuery.Built b = ArticleQuery.build(Map.of("status", new String[]{"RDS", "DDH"}));
        assertThat(b.sql()).contains("status IN (?, ?)").endsWith("ORDER BY createdAt DESC");
        assertThat(b.params()).containsExactly("RDS", "DDH");
    }

    @Test
    void excludeStatusBecomesNotIn() {
        ArticleQuery.Built b = ArticleQuery.build(Map.of("excludeStatus", new String[]{"DPS", "RRH"}));
        assertThat(b.sql()).contains("status NOT IN (?, ?)");
        assertThat(b.params()).containsExactly("DPS", "RRH");
    }

    @Test
    void departmentsTakesPriorityOverDepartment() {
        ArticleQuery.Built b = ArticleQuery.build(Map.of(
                "departments", new String[]{"사회부", "편집부"},
                "department", new String[]{"운영부"}));
        assertThat(b.sql()).contains("department IN (?, ?)");
        assertThat(b.params()).containsExactly("사회부", "편집부");
    }

    @Test
    void singleDepartmentBecomesIn() {
        ArticleQuery.Built b = ArticleQuery.build(Map.of("department", new String[]{"사회부"}));
        assertThat(b.sql()).contains("department IN (?)");
        assertThat(b.params()).containsExactly("사회부");
    }

    @Test
    void scalarKeysBecomeEquality() {
        ArticleQuery.Built b = ArticleQuery.build(Map.of("author", new String[]{"기자"}));
        assertThat(b.sql()).contains("author = ?");
        assertThat(b.params()).containsExactly("기자");
    }

    @Test
    void createdAtRangeUsesLexicographicBounds() {
        ArticleQuery.Built b = ArticleQuery.build(Map.of(
                "createdAtFrom", new String[]{"2026-01-01T00:00:00.000Z"},
                "createdAtTo", new String[]{"2026-12-31T23:59:59.999Z"}));
        assertThat(b.sql()).contains("createdAt >= ?").contains("createdAt <= ?");
        assertThat(b.params()).containsExactly("2026-01-01T00:00:00.000Z", "2026-12-31T23:59:59.999Z");
    }

    @Test
    void nonWhitelistedKeysAreIgnored() {
        ArticleQuery.Built b = ArticleQuery.build(Map.of(
                "hack", new String[]{"1; DROP TABLE Contents"},
                "limit", new String[]{"1"}));
        assertThat(b.sql()).isEqualTo("SELECT * FROM Contents ORDER BY createdAt DESC");
        assertThat(b.params()).isEmpty();
    }

    @Test
    void conditionsCombineWithAnd() {
        ArticleQuery.Built b = ArticleQuery.build(Map.of(
                "status", new String[]{"RDS"},
                "author", new String[]{"기자"}));
        assertThat(b.sql()).contains(" WHERE ").contains(" AND ");
        assertThat(b.params()).hasSize(2);
    }
}
