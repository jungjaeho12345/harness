// 에디터 상태표시줄 계산 — 워드수/바이트수/캐럿 위치(단락·행·열). 순수 함수(DOM 비의존).
// 입력 caret은 Editor.readCaret 계약 { lineIndex, offset }을 그대로 받는다(Step 3에서 주입).
// row는 lineIndex만, column은 offset만 쓴다(두 값은 같은 caret에서 와야 정합).

import { lines } from './editorCaret.js';

// 공백류(\s+)로 분리된 단어 수. 빈/공백뿐이면 0.
export function wordCount(text) {
  return String(text ?? '')
    .trim()
    .split(/\s+/)
    .filter(Boolean).length;
}

// UTF-8 바이트 길이.
export function byteLength(text) {
  return new TextEncoder().encode(String(text ?? '')).length;
}

// 캐럿 줄까지의 "비빈 줄 그룹" 개수(빈 줄로 분리, 연속 빈 줄은 경계 1개). 최소 1.
function paragraphIndex(linesArr, lineIndex) {
  let count = 0;
  let inGroup = false;
  const last = Math.min(lineIndex, linesArr.length - 1);
  for (let i = 0; i <= last; i += 1) {
    if (linesArr[i] !== '') {
      if (!inGroup) {
        count += 1;
        inGroup = true;
      }
    } else {
      inGroup = false;
    }
  }
  return Math.max(1, count);
}

// caret { lineIndex, offset } → { paragraph, row, column } (모두 1-based).
// caret이 null/undefined면 포커스 전 기본값 { paragraph:1, row:1, column:1 }.
export function caretPosition(text, caret) {
  if (caret == null) return { paragraph: 1, row: 1, column: 1 };
  const linesArr = lines(text);
  const lineIndex = Math.max(0, Math.trunc(Number(caret.lineIndex)) || 0);
  const offset = Math.max(0, Math.trunc(Number(caret.offset)) || 0);
  // 현재 줄 시작 오프셋 = 앞선 줄들의 길이 합 + 개행 수.
  let lineStart = 0;
  for (let i = 0; i < lineIndex && i < linesArr.length; i += 1) {
    lineStart += linesArr[i].length + 1;
  }
  return {
    paragraph: paragraphIndex(linesArr, lineIndex),
    row: lineIndex + 1,
    column: Math.max(1, offset - lineStart + 1),
  };
}
