// 기사 작성페이지 송고/보류/KILL 버튼 표시 규칙 (news.md 기사 작성 페이지 내 버튼).
// 진입 컨텍스트(mode)·진입 상태(status)·권한(role)·신규여부(articleId)로 표시할 액션을 결정한다.
// 순수 함수 — 컴포넌트(WriterPage)가 이 결과로 버튼을 그린다. 표/규칙에 없는 조합은 빈 배열(표시 안 함).
//
// 진리표 (step12):
//  RDS(편집)      R·D·Z → 송고·보류·KILL
//  DDH(편집)      D·Z   → 송고·KILL (보류 없음, 이미 보류 상태) / R → 없음
//  신규(미저장)    R·D·Z → 송고·보류 (KILL 숨김)
//  DPS 고침/포털고침 D     → 송고·보류 (KILL 없음) / 그 외 → 없음

export const SUBMIT_LABELS = Object.freeze({
  send: '송고',
  hold: '보류',
  kill: 'KILL',
  save: '저장',
});

// 표시 순서 — 항상 송고 → 보류 → KILL 순으로 거른다.
const ORDER = ['send', 'hold', 'kill'];

function order(set) {
  return ORDER.filter((k) => set.includes(k));
}

export function submitButtons({ mode, status, role, articleId } = {}) {
  // 매핑(mapping) — 임베드 전용 제한 편집. 상태 전이 없음 → 송고/보류/KILL 액션바를 노출하지 않는다(step11).
  if (mode === 'mapping') return [];

  // 신규(미저장, 기사아이디 없음) — 권한 무관 송고·보류만(KILL 숨김).
  if (!articleId || mode === 'new') {
    return order(['send', 'hold']);
  }

  // DPS 고침/포털고침 진입 — 권한 D만, 송고·보류만(KILL 없음). 단순 편집 진입(전이 없음).
  if (mode === 'revise' || mode === 'portalRevise') {
    return role === 'D' ? order(['send', 'hold']) : [];
  }

  // 편집(mode 'edit') — 진입 상태에 따라.
  if (status === 'RDS') {
    if (role === 'R' || role === 'D' || role === 'Z') return order(['send', 'hold', 'kill']);
    return [];
  }
  if (status === 'DDH') {
    // 데스크 보류 — D/Z만 송고·KILL(보류 없음). R은 어떤 버튼도 없음.
    if (role === 'D' || role === 'Z') return order(['send', 'kill']);
    return [];
  }

  // 표/규칙에 없는 (상태, 권한, 진입) 조합 — 버튼 표시 안 함.
  return [];
}
