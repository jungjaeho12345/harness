// 에디터 개행 규칙 + "(끝)" 마커 텍스트 처리 (news.md 기사 에디터).
// "(끝)"은 본문 맨 마지막 다음 개행에 자기 줄로 들어간다(본문이 '...본문\n(끝)'로 끝남).
// 본문이 이미 개행으로 끝나거나 비어 있으면 이중 개행 없이 "(끝)"만 들어간다. 이미 있으면 삽입 안 함.
// CRITICAL: "(끝)" 마커 뒤에는 어떤 입력도 할 수 없다(타이핑/Enter/붙여넣기/IME). 앞 줄 편집·삭제는 허용.

import { END_MARKER } from './editorContent.js';

export function hasEndMarker(text) {
  return String(text ?? '').includes(END_MARKER);
}

// 본문 텍스트 끝에 "(끝)"을 자기 줄로 붙인다. 중복이면 그대로 둔다(news.md).
export function appendEndMarker(text) {
  const s = String(text ?? '');
  if (s.includes(END_MARKER)) return s;
  if (s === '' || s.endsWith('\n')) return s + END_MARKER;
  return s + '\n' + END_MARKER;
}

// 캐럿 위치에서의 입력(삽입)이 차단되는지 — "(끝)" 마커 시작과 같거나 그 뒤면 차단.
// 마커 앞(위 줄들) 편집은 허용하므로 caret < markerStart면 허용. 삭제/이동/선택 차단에는 쓰지 않는다.
export function isInputBlocked(text, caretOffset) {
  const s = String(text ?? '');
  const idx = s.lastIndexOf(END_MARKER);
  if (idx === -1) return false;
  return Number(caretOffset) >= idx;
}
