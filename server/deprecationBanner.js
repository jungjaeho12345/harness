// Node 서버 은퇴 예고 배너 (76-server-cutover-ops step5).
// 순수 함수 — 기동 로그 문자열만 정한다. 앱 동작·HTTP 응답·계약과 무관하다(ADR-016 · decisions (5)).
//
// opt-in: NODE_SERVER_DEPRECATED === '1' 일 때만 배너 문자열을 돌려주고, 그 외에는 null(기본 침묵).
// 병행 운영/롤백 중에는 Node가 정상 서비스일 수 있으므로 기본 off다 — 은퇴는 운영자가 명시적으로 표시한다.
// 위생(ADR-007): 세션·토큰·비밀번호·실데이터·절대경로를 담지 않는다.
export function deprecationBanner(env) {
  if (!env || env.NODE_SERVER_DEPRECATED !== '1') return null;
  return (
    'DEPRECATION: this Node server is marked for retirement (NODE_SERVER_DEPRECATED=1). '
    + 'The source of truth is the Spring/MySQL server — avoid new writes here. '
    + 'To roll back, follow the rollback procedure in docs/ops-mysql.md.'
  );
}
