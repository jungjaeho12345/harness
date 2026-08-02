// Contents 행의 "응답용 투영" — 순수 모듈(DB·HTTP·시계 비의존).
// 존재 이유(ADR-004 신뢰 경계): 세션 토큰은 그 자체가 권한이다. Contents.lockerSessionId에는
// 편집 중인 사용자의 **유효 세션 토큰 원문**이, lockerClientId에는 저장 인가에 쓰이는 편집 탭
// 식별자가 들어 있다. 이 값이 조회 응답에 실리면 인증된 아무 사용자나(예: R 기자) 목록만 조회해
// 데스크의 토큰/탭 식별자를 얻어 권한 상승·탭 사칭을 할 수 있다.
//
// 규율:
//  - DB 컬럼과 저장 로직은 그대로 둔다(DB 비파괴, ADR-002). lockerSessionId는 재로그인 takeover
//    판정(articleService.acquireEditLock의 sameUserReLogin)에 필요하다 — 모델은 계속 전 컬럼을 돌려준다.
//  - 제거는 **응답 투영 한 곳**에서만 한다. 라우트/컨트롤러에서 `delete row.lockerSessionId` 식으로
//    개별 처리하면 새 라우트에서 반드시 누락된다(이 결함의 원인 자체가 라우트별 처리 부재였다).
//  - 원본 객체를 mutate하지 않는다 — 같은 행 객체가 잠금 판정 등 후속 로직에서 재사용될 수 있다.
//  - 토큰을 해시·마스킹·prefix 등 다른 형태로 파생해 내보내지 않는다(부분 노출도 공격 표면).
// 외부 반출(배부 스풀)의 필드 allowlist는 spoolWriter가 별도로 소유한다 — 목적이 다르므로 분리한다.

// 응답으로 나가면 안 되는 Contents 컬럼의 단일 출처. 값이 곧 인증 자격이거나 위조 재료인 것만 담는다.
// (lockYN·lockerUserId·lockedAt은 잠금 표시 UI 계약이므로 여기에 넣지 않는다.)
export const PRIVATE_CONTENTS_COLS = Object.freeze(['lockerSessionId', 'lockerClientId']);

// Contents 행 → 클라이언트로 내보낼 안전한 사본. 원본은 변형하지 않는다.
// 방어: null/undefined/비객체 입력은 그대로 돌려준다(투영이 호출자를 깨뜨리지 않는다).
export function toPublicContents(contents) {
  if (contents === null || typeof contents !== 'object') return contents;
  const out = {};
  for (const [key, value] of Object.entries(contents)) {
    if (PRIVATE_CONTENTS_COLS.includes(key)) continue;
    out[key] = value;
  }
  return out;
}
