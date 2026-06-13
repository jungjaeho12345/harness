// 기사 생애주기 전이 — 순수 함수 (HTTP/DB 비의존). role은 항상 인자로 받는다.
// (신뢰 검증은 step8 HTTP 계층 — 이 계층은 클라이언트 role을 검증하지 않는다.)
// news.md "기사 생애주기" 전이표를 그대로 옮긴다. 정의 외 (status, role, action) 조합은 모두 거부.
//
// 신규 기사의 "최초 송고"는 권한 무관 RDS 유지인데, 이는 신규 저장(create)이 status를
// 항상 RDS로 두어 실현된다. transition()은 "기존 기사(편집 컨텍스트)"의 전이만 다룬다.

const ACTIONS = new Set(['send', 'hold', 'kill', 'approveDelete']);

// D(데스크)와 Z(관리자)는 동일하게 전이한다.
// 표에 없는 (status, action) 칸은 전이 불가(거부)를 뜻한다.
const DESK_TABLE = {
  RDS: { send: 'DPS', hold: 'DDH', kill: 'DDK' },
  DPS: { send: 'DPS', hold: 'DDH', approveDelete: 'DPD' }, // DPS는 재송고만, 바로 KILL 불가
  DDH: { send: 'DPS', kill: 'DDK' },                       // 이미 보류이므로 hold 없음
};

// R(기자)는 RDS 기사만 다룰 수 있고, approveDelete는 불가하다.
const REPORTER_TABLE = {
  RDS: { send: 'RDS', hold: 'RRH', kill: 'RRK' },
};

// 다음 status를 { ok:true, status } 로 반환하거나, 정의 외 조합은 { ok:false, reason } 로 거부.
export function transition(status, role, action) {
  if (!ACTIONS.has(action)) return { ok: false, reason: 'unknown-action' };

  const table = role === 'R' ? REPORTER_TABLE
    : (role === 'D' || role === 'Z') ? DESK_TABLE
      : null;
  if (!table) return { ok: false, reason: 'unknown-role' };

  const next = table[status] && table[status][action];
  if (!next) return { ok: false, reason: 'forbidden-transition' };

  return { ok: true, status: next };
}
