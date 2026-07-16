// 편집 메뉴 '텍스트 붙여넣기'/'붙여넣기'(텍스트 분기)가 쓸 마커-안전 텍스트 삽입 순수 헬퍼.
// 클립보드에서 읽은(여러 줄 가능) 평문을 캐럿 위치에 삽입하되 "(끝)" 마커의 무결성을 지킨다(news.md L170).
// 순수 함수 — React/DOM/clipboard/transport 비의존(ADR-003). 비동기 클립보드 읽기·결선은 WriterPage(step1).
// insertTextIntoBlocks·isInputBlocked를 재사용해 네이티브 Ctrl+V 붙여넣기와 동작을 일치시킨다(단일 출처).

import { normalizeBlocks, blocksToText } from './editorContent.js';
import { insertTextIntoBlocks, isInputBlocked, hasEndMarker } from './editorNewline.js';

// 클립보드 평문을 캐럿에 삽입한 새 블록 배열을 돌려준다. "(끝)" 마커 무결성 보존.
// 반환: { blocks, caretLineIndex, changed }
//   - changed:false 이면 blocks는 normalizeBlocks(입력)과 동등(호출부가 커밋을 건너뛴다), caretLineIndex는 null.
//   - 텍스트는 원문 그대로 삽입한다(트림/공백제거 금지 — 클립보드 원문 보존). \r\n·\r만 \n으로 통일한다(줄 분할 일관성).
export function insertPasteTextAtCaret(blocks, caret, text) {
  const list = normalizeBlocks(blocks);

  // 빈 텍스트 no-op.
  if (String(text ?? '') === '') return { blocks: list, caretLineIndex: null, changed: false };

  // 마커 가드 — "(끝)" 마커와 같은 줄/뒤 삽입은 차단(마커 무결성, news.md L170).
  const full = blocksToText(list);
  if (caret && Number.isInteger(caret.offset)) {
    // 캐럿 유효 — 마커 시작과 같거나 그 뒤면 no-op.
    if (isInputBlocked(full, caret.offset)) return { blocks: list, caretLineIndex: null, changed: false };
  } else if (hasEndMarker(full)) {
    // 캐럿 미상/무효 — 폴백(마지막 텍스트 줄 끝)이 마커 줄을 오염시킬 수 있어, 마커 있는 본문에선 no-op.
    return { blocks: list, caretLineIndex: null, changed: false };
  }

  // \r\n·\r → \n (줄 분할 일관성). 그 외 원문 그대로.
  const normalized = String(text).replace(/\r\n?/g, '\n');
  const r = insertTextIntoBlocks(list, caret, normalized);
  return { blocks: r.blocks, caretLineIndex: r.caretLineIndex, changed: true };
}
