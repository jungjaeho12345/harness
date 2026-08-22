// 권한 정책 (phase 64 step3 B-1) — Electron·전역·파일시스템 비의존 순수 모듈.
// setPermissionRequestHandler / setPermissionCheckHandler 두 핸들러가 공유하는 판정의 단일 출처다
// (main.js 헤더 계약·ADR-011 — 정책은 client/lib 순수 함수, Electron 없이 단위 테스트로 잠근다).
// 허용 2종의 근거: SPA 붙여넣기(navigator.clipboard.read → clipboard-read)와 복사
// (navigator.clipboard.writeText → clipboard-sanitized-write) 경로가 실제로 쓰는 권한이 이것뿐이다.
// CRITICAL: 집합을 넓히려면(media·notifications·geolocation·fullscreen 등) 근거·실측과 함께
// 별도 결정이 필요하다 — 이 목록이 곧 제품의 권한 표면이다(fail-closed: 모르는 값은 전부 거부).

export const ALLOWED_PERMISSIONS = Object.freeze(['clipboard-read', 'clipboard-sanitized-write']);

// 정확 일치만 true — 비문자열·대소문자 변형·공백 부착은 전부 false(fail-closed).
export function isAllowedPermission(permission) {
  return typeof permission === 'string' && ALLOWED_PERMISSIONS.includes(permission);
}