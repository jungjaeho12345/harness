package harness.server;

/**
 * User 테이블 한 행(DB 레코드) — 로그인/세션 가드에 필요한 전 필드.
 *
 * <p><b>이 레코드를 응답으로 직접 직렬화하지 마라.</b> {@code password}·잠금 필드
 * (failedLoginCount·lockedUntil·lastFailedLoginAt)는 계정 열거·자격 유출 단서라, 상위 계층이
 * SAFE_FIELDS/IDENTITY 투영(명시 Map)으로만 응답을 만든다. 여기서는 도메인 로직(로그인·재도출)이
 * 읽을 수 있도록 값을 담기만 한다. 전 컬럼 TEXT affinity 이므로 필드는 전부 String(잠금 시각도 문자열 정수).
 */
public record UserRow(
        String userId,
        String name,
        String role,
        String department,
        String departmentCode,
        String active,
        String password,
        String failedLoginCount,
        String lockedUntil,
        String lastFailedLoginAt) {
}
