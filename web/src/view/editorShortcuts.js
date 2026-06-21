// 에디터 단축키 — Alt+Y "(끝)" 삽입(골드·중복 금지·맞춤법 on·마커 뒤 입력 차단), Ctrl+Y "(계속)" 삽입,
// Ctrl+D 라인 삭제(임베드 동반), 보기 메뉴 대소문자 변환(텍스트-줄 단위).
// 블록 모델 위에서 동작한다(본문은 항상 블록 구조 — news.md/schema.md). 순수 함수, DOM/transport 비의존.

import {
  END_MARKER, textBlock, blocksToText, isEmbedBlock, isTextBlock, normalizeBlocks,
} from './editorContent.js';
import { textLineToBlockIndex } from './writerBody.js';

export const CONTINUE_MARKER = '(계속)';

// 키 인식 — 레이아웃 무관하게 code(KeyY/KeyD)도 함께 본다.
export function isInsertEndMarker(e) {
  return !!(e && e.altKey && !e.ctrlKey && (e.key === 'y' || e.key === 'Y' || e.code === 'KeyY'));
}

export function isDeleteLine(e) {
  return !!(e && e.ctrlKey && !e.altKey && (e.key === 'd' || e.key === 'D' || e.code === 'KeyD'));
}

// Ctrl+Y — "(계속)" 삽입(편집 메뉴). Alt+Y("(끝)")와 구분해 ctrl만 본다.
export function isInsertContinueMarker(e) {
  return !!(e && e.ctrlKey && !e.altKey && (e.key === 'y' || e.key === 'Y' || e.code === 'KeyY'));
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

// Ctrl+Y — 주어진 텍스트-줄 다음에 "(계속)" 한 줄을 삽입한다(임베드 삽입과 달리 빈 줄을 만들지 않음).
// "(끝)"은 항상 최종 텍스트 블록으로 유지(있으면 그 앞). textLineIndex가 null/음수/범위 밖이면 끝("(끝)" 앞)에 둔다.
// (끝)과 달리 멱등이 아니다(여러 번 삽입 가능). 임베드 순서는 보존. 반환: { blocks: 배열, caretTextLine: 삽입된 '(계속)' 줄 인덱스 }.
export function insertContinueMarker(blocks, textLineIndex) {
  const list = normalizeBlocks(blocks);
  const blockIndex = textLineToBlockIndex(list, textLineIndex);
  const marker = textBlock(CONTINUE_MARKER);
  const next = list.slice();
  if (blockIndex < 0) next.push(marker); // 폴백: 끝에 추가(아래 정규화로 "(끝)"은 다시 최종으로).
  else next.splice(blockIndex + 1, 0, marker); // 지정 텍스트 줄 블록 다음.
  // "(끝)"을 최종 블록으로 정규화(insertEmbedAfterLine과 동일 규칙)한 뒤, 삽입된 마커의 텍스트-줄 인덱스를 센다.
  const isEnd = (b) => b.type === 'text' && String(b.text).trim() === END_MARKER;
  const hasEnd = next.some(isEnd);
  const ordered = next.filter((b) => !isEnd(b));
  if (hasEnd) ordered.push(textBlock(END_MARKER));
  let caretTextLine = null;
  let count = -1;
  for (const b of ordered) {
    if (b.type === 'text') {
      count += 1;
      if (b === marker) { caretTextLine = count; break; }
    }
  }
  return { blocks: ordered, caretTextLine };
}

// 보기 메뉴 대소문자 변환 — 텍스트-줄 인덱스(텍스트 블록만 0-base로 센 순번)의 텍스트에 fn 적용.
// 임베드/다른 줄/"(끝)"은 불변. 범위 밖이면 변경 없이 그대로 반환. 입력 blocks는 변형하지 않는다.
export function transformTextLine(blocks, textLineIndex, fn) {
  const list = normalizeBlocks(blocks);
  const blockIndex = textLineToBlockIndex(list, textLineIndex);
  if (blockIndex < 0) return { blocks: list };
  const next = list.slice();
  next[blockIndex] = textBlock(fn(next[blockIndex].text));
  return { blocks: next };
}

// 대소문자 변환 문자열 함수 4종(순수).
export function toUpper(s) {
  return String(s).toUpperCase();
}

export function toLower(s) {
  return String(s).toLowerCase();
}

export function capitalizeFirst(s) {
  const str = String(s);
  return str.charAt(0).toUpperCase() + str.slice(1).toLowerCase();
}

export function toggleCase(s) {
  return Array.from(String(s)).map((ch) => {
    const up = ch.toUpperCase();
    const lo = ch.toLowerCase();
    if (ch === lo && ch !== up) return up; // 소문자 → 대문자
    if (ch === up && ch !== lo) return lo; // 대문자 → 소문자
    return ch; // 비알파벳은 그대로
  }).join('');
}
