// 에디터 단축키 — Alt+Y "(끝)" 삽입(골드·중복 금지·맞춤법 on·마커 뒤 입력 차단), Ctrl+D 라인 삭제(임베드 동반).
// 블록 모델 위에서 동작한다(본문은 항상 블록 구조 — news.md/schema.md). 순수 함수, DOM/transport 비의존.

import {
  END_MARKER, textBlock, blocksToText, isEmbedBlock, isTextBlock, normalizeBlocks,
} from './editorContent.js';

// 키 인식 — 레이아웃 무관하게 code(KeyY/KeyD)도 함께 본다.
export function isInsertEndMarker(e) {
  return !!(e && e.altKey && !e.ctrlKey && (e.key === 'y' || e.key === 'Y' || e.code === 'KeyY'));
}

export function isDeleteLine(e) {
  return !!(e && e.ctrlKey && !e.altKey && (e.key === 'd' || e.key === 'D' || e.code === 'KeyD'));
}

// Alt+Y — "(끝)"을 최종 블록으로 삽입한다(본문 텍스트 → 임베드 → "(끝)" 순). 중복이면 삽입하지 않는다.
// 맞춤법 검사는 이 시점부터 켠다(spellcheck=true). 반환 spellcheck는 항상 true(Alt+Y 처리됨).
export function insertEndMarker(blocks) {
  const list = normalizeBlocks(blocks);
  if (blocksToText(list).includes(END_MARKER)) {
    return { blocks: list, inserted: false, spellcheck: true };
  }
  return { blocks: [...list, textBlock(END_MARKER)], inserted: true, spellcheck: true };
}

// Ctrl+D / Backspace / Delete — 해당 라인(블록) 제거. 텍스트 라인을 지우면 바로 뒤 임베드 한 개도 함께 제거.
export function deleteLineAt(blocks, index) {
  const list = normalizeBlocks(blocks);
  if (index < 0 || index >= list.length) {
    return { blocks: list, removed: null, removedEmbed: false };
  }
  const removed = list[index];
  const next = list.slice();
  next.splice(index, 1);
  let removedEmbed = false;
  // 텍스트 라인의 임베드는 그 라인 바로 뒤 임베드 블록 — 한 번에 한 개만 동반 삭제.
  if (isTextBlock(removed) && isEmbedBlock(next[index])) {
    next.splice(index, 1);
    removedEmbed = true;
  }
  return { blocks: next, removed, removedEmbed };
}
