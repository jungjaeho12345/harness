// 에디터 개행 규칙 + "(끝)" 마커 텍스트 처리 (news.md 기사 에디터).
// "(끝)"은 본문 맨 마지막 다음 개행에 자기 줄로 들어간다(본문이 '...본문\n(끝)'로 끝남).
// 본문이 이미 개행으로 끝나거나 비어 있으면 이중 개행 없이 "(끝)"만 들어간다. 이미 있으면 삽입 안 함.
// CRITICAL: "(끝)" 마커 뒤에는 어떤 입력도 할 수 없다(타이핑/Enter/붙여넣기/IME). 앞 줄 편집·삭제는 허용.

import {
  END_MARKER, textBlock, isTextBlock, normalizeBlocks,
} from './editorContent.js';

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

// 수정(overwrite) 모드에서 캐럿 바로 뒤 글자를 덮어쓸 대상인지 — 순수 판정(DOM 비의존).
// text = blocksToText(blocks)(텍스트 블록만 '\n'으로 조인, 임베드 제외). offset = readCaret().offset(절대 텍스트 좌표).
// true: text[offset]가 같은 줄 일반 글자(캐럿 뒤 1글자를 selection 확장해 네이티브 입력으로 대체). 아래는 전부 false(삽입 폴백):
//   - offset이 정수가 아니거나 음수/문서 끝 초과(>= length) — 무효/문서 끝.
//   - text[offset] === '\n' — 줄 끝(다음 줄·임베드 앞 침범 금지). 임베드는 blocksToText에서 제외되어 경계가 '\n'/문서 끝으로 나타난다.
//   - isInputBlocked(text, offset) — "(끝)" 마커 시작 이상(입력 차단 계약 재사용). 마커 직전은 '\n'(마커 자기 줄)이라 위에서 이미 차단.
export function shouldOverwriteNextChar(text, offset) {
  const s = String(text ?? '');
  if (!Number.isInteger(offset) || offset < 0 || offset >= s.length) return false;
  if (s[offset] === '\n') return false;
  if (isInputBlocked(s, offset)) return false;
  return true;
}

// 수정(overwrite) 모드에서 캐럿 뒤 "한 문자(코드포인트)"를 덮어쓸 때 확장할 UTF-16 코드유닛 수(1 또는 2).
// text[offset]가 high 서로게이트이고 text[offset+1]가 low 서로게이트면 2(astral 문자=이모지 온전히 대체), 아니면 1.
// convertSimpTrad의 코드포인트 단위 순회와 동형(서로게이트 페어 인지). 무효/범위 밖/lone 서로게이트는 1(안전 기본).
export function overwriteExtendLength(text, offset) {
  const s = String(text ?? '');
  const i = Number(offset);
  if (!Number.isInteger(i) || i < 0 || i >= s.length) return 1;
  const hi = s.charCodeAt(i);
  if (hi >= 0xD800 && hi <= 0xDBFF && i + 1 < s.length) {
    const lo = s.charCodeAt(i + 1);
    if (lo >= 0xDC00 && lo <= 0xDFFF) return 2;
  }
  return 1;
}

// 캐럿 위치에 텍스트(개행 포함 가능)를 삽입한 블록 배열을 만든다 — Enter('\n' 1개 삽입)·여러 줄 붙여넣기 공용.
// blocks: 텍스트/임베드가 섞인 현재 DOM 블록. caret: { lineIndex, offset }(텍스트-only 기준) 또는 null.
// text: 삽입할 문자열('\n'이면 Enter 분할). 반환 { blocks: 다음블록, caretLineIndex: 캐럿을 둘 텍스트-라인 인덱스(라인 시작) }.
// 캐럿이 속한 텍스트 블록을 오프셋 기준 head/tail로 나누고, 삽입 줄들을 그 사이에 끼워 "1줄 = 1 텍스트 블록"을 유지한다.
// 임베드는 위치를 보존한다(텍스트 블록만 분할/삽입). 캐럿이 없거나(빈/비래핑 본문) 범위를 벗어나면 마지막 텍스트 줄 끝에 덧붙인다.
export function insertTextIntoBlocks(blocks, caret, text) {
  const list = normalizeBlocks(blocks);
  const insLines = String(text ?? '').split('\n');
  const textBlocks = list.filter(isTextBlock);

  // caret.lineIndex(N번째 텍스트 블록) → list 배열 인덱스.
  let textIdx = -1;
  let targetArrIdx = -1;
  for (let i = 0; i < list.length; i += 1) {
    if (isTextBlock(list[i])) {
      textIdx += 1;
      if (caret && textIdx === caret.lineIndex) { targetArrIdx = i; break; }
    }
  }

  // 캐럿 미상/범위 밖 — 마지막 텍스트 줄 끝에 삽입(라인 래퍼가 아직 없는 빈/초기 본문에서 Enter 등).
  if (targetArrIdx === -1) {
    const next = list.slice();
    let lastTextArrIdx = -1;
    for (let i = 0; i < next.length; i += 1) if (isTextBlock(next[i])) lastTextArrIdx = i;
    const head = lastTextArrIdx >= 0 ? next[lastTextArrIdx].text : '';
    const newLines = insLines.slice();
    newLines[0] = head + newLines[0];
    const newBlocks = newLines.map(textBlock);
    if (lastTextArrIdx >= 0) next.splice(lastTextArrIdx, 1, ...newBlocks);
    else next.push(...newBlocks);
    const baseLine = lastTextArrIdx >= 0 ? textBlocks.length - 1 : 0;
    return { blocks: next, caretLineIndex: baseLine + (insLines.length - 1) };
  }

  // 정확 분할 — 캐럿 오프셋(텍스트-only)에서 대상 줄의 in-line 오프셋을 구해 head/tail로 나눈다.
  let before = 0;
  for (let i = 0; i < caret.lineIndex; i += 1) before += textBlocks[i].text.length + 1;
  const lineText = list[targetArrIdx].text;
  let inLine = caret.offset - before;
  inLine = Math.max(0, Math.min(inLine, lineText.length));
  const head = lineText.slice(0, inLine);
  const tail = lineText.slice(inLine);
  const newLines = insLines.slice();
  newLines[0] = head + newLines[0];
  newLines[newLines.length - 1] += tail;
  const next = list.slice();
  next.splice(targetArrIdx, 1, ...newLines.map(textBlock));
  return { blocks: next, caretLineIndex: caret.lineIndex + (insLines.length - 1) };
}
