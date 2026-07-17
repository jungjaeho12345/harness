// 편집 메뉴 되돌리기/다시실행용 본문 히스토리 스택 — 순수 자료구조(React/DOM/clipboard/transport 비의존).
// 한 문서(탭)의 body(markupVersion 문자열) 스냅샷 과거/현재/미래를 관리한다. 탭→히스토리 매핑·키 인터셉트·
// 코얼레싱 시각 판정은 step1(WriterPage)이 담당하고, 이 모델은 coalesce 불리언만 받는다.
// CRITICAL: body는 불투명 문자열 — deserialize/JSON.parse로 해석·정규화 금지(정규화는 serialize가 담당,
// 여기서 또 하면 동일-body 판정이 어긋나 헛 스냅샷이 생긴다). 모든 함수는 입력을 mutate하지 않는다.
//
// shape: { entries: string[], index: number } — entries[index]가 '현재 본문'.
// 불변식: entries[0](베이스라인=문서를 연 시점 본문)은 코얼레싱으로 절대 교체되지 않는다(limit 절단으로만 탈락).

export function createHistory(initialBody) {
  return { entries: [String(initialBody ?? '')], index: 0 };
}

// 새 스냅샷 반영한 새 히스토리 반환. 동일 body는 no-op(동일 참조 반환 — StrictMode 이중 호출 방어).
// coalesce:true & 현재가 최신(top) & 베이스라인 아님 → top 교체(성장 없음). 그 외 redo 분기 절단 후 push.
// limit(양의 정수) 초과분은 가장 오래된 항목부터 버리고 index를 보정한다.
export function pushHistory(history, nextBody, opts = {}) {
  const next = String(nextBody ?? '');
  if (next === history.entries[history.index]) return history;
  const atTop = history.index === history.entries.length - 1;
  if (opts.coalesce === true && atTop && history.index > 0) {
    const entries = history.entries.slice();
    entries[history.index] = next;
    return { entries, index: history.index };
  }
  let entries = history.entries.slice(0, history.index + 1);
  entries.push(next);
  let index = entries.length - 1;
  const { limit } = opts;
  if (Number.isInteger(limit) && limit > 0 && entries.length > limit) {
    const drop = entries.length - limit;
    entries = entries.slice(drop);
    index = Math.max(0, index - drop);
  }
  return { entries, index };
}

// 되돌리기 — 불가(베이스라인)면 { history: 동일, body: null, changed: false }.
export function undo(history) {
  if (!canUndo(history)) return { history, body: null, changed: false };
  const index = history.index - 1;
  return { history: { entries: history.entries, index }, body: history.entries[index], changed: true };
}

// 다시실행 — 불가(이미 최신)면 { history: 동일, body: null, changed: false }.
export function redo(history) {
  if (!canRedo(history)) return { history, body: null, changed: false };
  const index = history.index + 1;
  return { history: { entries: history.entries, index }, body: history.entries[index], changed: true };
}

export function canUndo(history) {
  return history.index > 0;
}

export function canRedo(history) {
  return history.index < history.entries.length - 1;
}
