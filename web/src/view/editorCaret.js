// 에디터 캐럿/라인 계산 — 캐럿 오프셋이 속한 라인 인덱스/경계, 텍스트 라인 삭제.
// 순수 함수(DOM 비의존). 컴포넌트(step12)가 실제 DOM 캐럿을 이 오프셋과 동기화한다.

export function lines(text) {
  return String(text ?? '').split('\n');
}

// 캐럿 오프셋이 속한 라인의 {lineIndex, start, end} (start/end는 텍스트 내 오프셋).
export function lineAtOffset(text, caretOffset) {
  const s = String(text ?? '');
  const clamped = Math.max(0, Math.min(Number(caretOffset) || 0, s.length));
  const before = s.slice(0, clamped);
  const lineIndex = (before.match(/\n/g) || []).length;
  const start = before.lastIndexOf('\n') + 1; // 개행 없으면 0
  const nl = s.indexOf('\n', clamped);
  const end = nl === -1 ? s.length : nl;
  return { lineIndex, start, end };
}

// 특정 라인을 텍스트에서 제거한 결과 {text, removed, caret}. caret은 삭제 후 그 자리(다음/마지막 라인 시작).
export function removeLineFromText(text, lineIndex) {
  const arr = lines(text);
  if (lineIndex < 0 || lineIndex >= arr.length) {
    return { text: String(text ?? ''), removed: null, caret: 0 };
  }
  const removed = arr[lineIndex];
  arr.splice(lineIndex, 1);
  const newText = arr.join('\n');
  // 삭제된 라인 자리(이제 그 인덱스에 온 라인)의 시작 오프셋으로 캐럿 이동. 마지막을 지웠으면 새 끝.
  const target = Math.min(lineIndex, arr.length - 1);
  let caret = 0;
  if (arr.length === 0) caret = 0;
  else {
    caret = arr.slice(0, target).reduce((sum, l) => sum + l.length + 1, 0);
    caret = Math.min(caret, newText.length);
  }
  return { text: newText, removed, caret };
}
