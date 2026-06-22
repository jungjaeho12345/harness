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

export default selectAllInEditor;
