package harness.spring_auth;

/**
 * 세션 가드가 매 요청 DB에서 재도출한 정제 신원 — 비밀번호·잠금 메타·active는 담지 않는다(ADR-004).
 * GET /api/session 응답의 user 5키(userId·name·role·department·departmentCode)와 1:1.
 */
public record Identity(String userId, String name, String role, String department, String departmentCode) {
}
