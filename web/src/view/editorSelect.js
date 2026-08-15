// 에디터 전체 선택 view 헬퍼 — selection API만 사용해 root 내용 전체를 선택한다.
// CRITICAL: 본문 텍스트/DOM 구조를 절대 바꾸지 않는다(선택 연산만). Editor.jsx 불변식과 무관.
// 메뉴(edit.selectAll) 경로에서 에디터 포커스가 빠진 경우 명시적으로 전체를 선택하기 위한 것.
// (Ctrl+A 키 입력은 브라우저 기본 동작이 contentEditable 전체를 선택하므로 가로채지 않는다.)
// window.getSelection + Range만 쓰고 document.execCommand/contentEditable 텍스트 조작은 하지 않는다.

export function selectAllInEditor(root) {
  if (!root) return; // 방어적 no-op — selection 무변경.
  const sel = typeof window !== 'undefined' && window.getSelection ? window.getSelection() : null;
  if (!sel) return;
  if (typeof root.focus === 'function') root.focus(); // 메뉴 클릭으로 빠진 포커스를 되돌린다(선택 가시화).
  const range = document.createRange();
  range.selectNodeContents(root); // root의 자식 내용 전체를 선택(노드 텍스트/구조 무변경).
  sel.removeAllRanges();
  sel.addRange(range);
}

// 줄/단어/문단 선택 공용 준비 — selection·텍스트-줄(.yh-editor__line) 목록 확보 + 포커스 복원.
// 선택을 걸 수 없는 상태(null root/selection 없음/줄 없음)면 null(방어적 no-op).
function prepareLineSelection(root) {
  if (!root) return null;
  const sel = typeof window !== 'undefined' && window.getSelection ? window.getSelection() : null;
  if (!sel) return null;
  if (typeof root.focus === 'function') root.focus(); // 메뉴 클릭으로 빠진 포커스를 되돌린다(선택 가시화).
  const lineEls = typeof root.querySelectorAll === 'function' ? root.querySelectorAll('.yh-editor__line') : null;
  if (!lineEls || !lineEls.length) return null;
  return { sel, lineEls };
}

function applyRange(sel, range) {
  sel.removeAllRanges();
  sel.addRange(range);
}

// 지정 텍스트-줄(.yh-editor__line[lineIndex]) 내용 전체를 선택한다. 범위 밖 lineIndex는 no-op(선택 무변경).
export function selectLineInEditor(root, lineIndex) {
  const ctx = prepareLineSelection(root);
  if (!ctx) return;
  if (!Number.isInteger(lineIndex) || lineIndex < 0 || lineIndex >= ctx.lineEls.length) return;
  const range = document.createRange();
  range.selectNodeContents(ctx.lineEls[lineIndex]);
  applyRange(ctx.sel, range);
}

// 지정 텍스트-줄의 [colStart, colEnd) 문자 범위(줄-로컬 char 오프셋)를 선택한다.
// 좌표 계약(캐럿 읽기 39-1과 동형): col은 줄 요소 자손 텍스트 전체 기준이고 clamp도 줄 textContent 전체 길이다 —
// 맞춤법 하이라이트가 줄을 [텍스트, span, 텍스트]로 쪼개므로 시작·끝이 서로 다른 텍스트 노드에 걸릴 수 있다.
// 좌표 계산은 호출부(editorRange) 몫 — 여기서는 clamp 후 Range만 건다. 빈 범위/빈 줄이면 no-op(단어 없음 신호).
export function selectWordInEditor(root, lineIndex, colStart, colEnd) {
  const ctx = prepareLineSelection(root);
  if (!ctx) return;
  if (!Number.isInteger(lineIndex) || lineIndex < 0 || lineIndex >= ctx.lineEls.length) return;
  const lineEl = ctx.lineEls[lineIndex];
  const textNodes = [];
  const collect = (node) => { // 자손 텍스트 노드를 document 순서로 수집(클래스 무관 — 구조적 사실만 본다)
    for (let child = node.firstChild; child; child = child.nextSibling) {
      if (child.nodeType === 3) textNodes.push(child);
      else collect(child);
    }
  };
  collect(lineEl);
  if (!textNodes.length) return; // 텍스트 노드 없음(빈 줄) — 선택 무변경
  const len = (lineEl.textContent ?? '').length;
  const start = Math.max(0, Math.min(colStart, len));
  const end = Math.max(0, Math.min(colEnd, len));
  if (!(start < end)) return; // 빈 범위(colStart===colEnd 포함) — NaN도 여기서 걸러진다
  // 줄-로컬 col → (텍스트 노드, 노드-로컬 오프셋). endSide=true면 누적 구간 경계를 앞 노드의 끝에 붙인다
  // (시작점은 뒤 구간의 시작 쪽) — 그래야 경계에서 범위가 접히지 않는다.
  const locate = (col, endSide) => {
    let acc = 0;
    for (const tn of textNodes) {
      const tlen = tn.nodeValue.length;
      if (tlen === 0) continue; // 빈 텍스트 노드는 경계 판정에서 건너뛴다
      if (col < acc + tlen || (endSide && col === acc + tlen)) return { node: tn, offset: col - acc };
      acc += tlen;
    }
    return null; // 도달 불가(시작점은 col<len, 끝점은 endSide가 줄 끝 경계를 앞 노드 끝으로 흡수) — 방어
  };
  const startPos = locate(start, false);
  const endPos = locate(end, true);
  if (!startPos || !endPos) return; // 방어적 no-op — 선택 무변경
  const range = document.createRange();
  range.setStart(startPos.node, startPos.offset);
  range.setEnd(endPos.node, endPos.offset);
  applyRange(ctx.sel, range);
}

// startLine..endLine(포함)의 텍스트-줄들을 하나의 범위로 선택한다.
// startLine > endLine이면 swap, 범위 밖 인덱스는 존재하는 줄 개수로 clamp(문단 꼬리가 마지막 줄을 넘어도 동작).
export function selectParagraphInEditor(root, startLine, endLine) {
  const ctx = prepareLineSelection(root);
  if (!ctx) return;
  let start = startLine;
  let end = endLine;
  if (!Number.isInteger(start) || !Number.isInteger(end)) return;
  if (start > end) [start, end] = [end, start];
  const last = ctx.lineEls.length - 1;
  start = Math.max(0, Math.min(start, last));
  end = Math.max(0, Math.min(end, last));
  const range = document.createRange();
  range.setStartBefore(ctx.lineEls[start]);
  range.setEndAfter(ctx.lineEls[end]);
  applyRange(ctx.sel, range);
}

export default selectAllInEditor;
