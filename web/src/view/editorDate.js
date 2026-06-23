// 날짜 삽입 순수 계산 — (이미 포맷된) 날짜 문자열을 캐럿 {lineIndex, offset} 위치의 텍스트 줄 안 컬럼에 삽입한다.
// 좌표는 blocksToText(blocks)(텍스트 블록만 개행으로 이은 평문)의 절대 오프셋 기준이다(editorGlyph와 동일 좌표계).
// 순수 함수, DOM/window/transport/React 비의존. 입력 blocks는 변형하지 않는다(새 배열/새 textBlock만).
// 임베드·"(끝)"·블록 순서·개수는 불변 — 날짜는 텍스트 블록의 text만 바꾼다.
// CRITICAL: 비결정 시각(new Date)/포맷팅(applyDateFormat)은 이 모듈에서 호출하지 않는다 — 호출자(Step 1 WriterPage)가
//           완성된 평문 dateString을 주입한다(테스트 가능성·계층 분리).
// UI/결선/DOM 반영(updateField('body', serialize(...)) + setPendingCaretLine)은 Step 1 WriterPage가 한다.
// editorGlyph.js 패턴을 그대로 따른다(단, 약물/날짜는 별개 관심사 — 한쪽 변경이 다른 쪽을 깨지 않도록 import하지 않는다).

import {
  textBlock, blocksToText, normalizeBlocks, END_MARKER,
} from './editorContent.js';
import { textLineToBlockIndex } from './writerBody.js';
import { lineAtOffset } from './editorCaret.js';

// 날짜 문자열 정규화(트림). 빈값/null/undefined → '' (UI에서 빈 날짜를 no-op 판정하는 데 재사용 가능).
export function normalizeDateString(dateString) {
  if (dateString === null || dateString === undefined) return '';
  return String(dateString).trim();
}

// 텍스트 블록(blocks 배열)에서 "(끝)" 마커가 아닌 마지막 텍스트 블록의 배열 인덱스를 구한다.
// 폴백 삽입 대상 — "(끝)" 텍스트는 건드리지 않는다. 없으면 -1.
function lastEditableTextBlockIndex(list) {
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const b = list[i];
    if (b && b.type === 'text' && String(b.text).trim() !== END_MARKER) return i;
  }
  return -1;
}

// 배열 인덱스(blocks 인덱스) → 그 텍스트 블록의 텍스트-줄 인덱스(텍스트 블록만 0-base로 센 순번). 텍스트 블록이 아니면 -1.
function blockIndexToTextLine(list, blockIndex) {
  let count = -1;
  for (let i = 0; i < list.length; i += 1) {
    if (list[i] && list[i].type === 'text') {
      count += 1;
      if (i === blockIndex) return count;
    }
  }
  return -1;
}

// 날짜 문자열(이미 완성된 평문)을 캐럿 {lineIndex, offset}의 텍스트 줄 안 컬럼에 삽입한 새 블록 배열을 돌려준다.
// 반환: { blocks, caretTextLine }
//   - blocks: 삽입 결과 블록 배열(입력 mutate 금지 — 새 배열).
//   - caretTextLine: 삽입된 줄의 텍스트-줄 인덱스(number) 또는 null(삽입 실패/no-op).
//
// 규칙:
//  1) dateString 빈값/공백뿐 → no-op: { blocks: normalizeBlocks(blocks), caretTextLine: null }.
//  2) caret이 유효하면 lineAtOffset(blocksToText(list), caret.offset)로 줄 시작(start)을 구하고
//     col = caret.offset - start 를 줄 안 컬럼으로, 해당 텍스트 블록 text를 slice 삽입으로 교체한다.
//     lineIndex는 caret.lineIndex를 신뢰하되 textLineToBlockIndex로 blocks 인덱스를 구한다.
//     단, "(끝)" 블록을 가리키면 폴백한다("(끝)" 텍스트 불변).
//  3) caret이 null/범위 밖이면 폴백: "(끝)"이 아닌 마지막 텍스트 줄 끝에 삽입(없으면 첫 텍스트 블록 생성).
//  4) 임베드·"(끝)"·블록 순서·개수 불변.
export function insertDateAtCaret(blocks, caret, dateString) {
  const list = normalizeBlocks(blocks);
  const d = normalizeDateString(dateString);
  if (d === '') return { blocks: list, caretTextLine: null };

  const text = blocksToText(list);

  // 캐럿 유효성: caret이 있고 lineIndex가 텍스트 블록 범위 안이며 "(끝)" 블록이 아닐 때만 정확 컬럼 삽입.
  let blockIndex = -1;
  let col = -1;
  if (caret && Number.isInteger(caret.lineIndex)) {
    const bi = textLineToBlockIndex(list, caret.lineIndex);
    if (bi >= 0 && list[bi].type === 'text' && String(list[bi].text).trim() !== END_MARKER) {
      const { start } = lineAtOffset(text, caret.offset);
      blockIndex = bi;
      col = Math.max(0, Math.min(Number(caret.offset) - start, list[bi].text.length));
    }
  }

  // 폴백: "(끝)"이 아닌 마지막 텍스트 줄 끝.
  if (blockIndex < 0) {
    const fallbackIdx = lastEditableTextBlockIndex(list);
    if (fallbackIdx < 0) {
      // 텍스트 블록이 전혀 없음(임베드만/빈 배열) — 첫 텍스트 블록을 만들어 날짜만 담는다(임베드 보존, 맨 앞).
      const next = [textBlock(d), ...list];
      return { blocks: next, caretTextLine: 0 };
    }
    blockIndex = fallbackIdx;
    col = list[fallbackIdx].text.length; // 줄 끝.
  }

  const old = list[blockIndex].text;
  const next = list.slice();
  next[blockIndex] = textBlock(old.slice(0, col) + d + old.slice(col));
  return { blocks: next, caretTextLine: blockIndexToTextLine(next, blockIndex) };
}
