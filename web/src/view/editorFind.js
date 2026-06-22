// 에디터 찾기/바꾸기 순수 계산 엔진 — 본문 텍스트(임베드 제외)에서 리터럴 부분문자열을 찾고 치환한다.
// 좌표는 blocksToText(blocks)(텍스트 블록만 개행으로 이은 평문)의 절대 오프셋 기준이다.
// 순수 함수, DOM/transport 비의존. 바꾸기는 텍스트 블록 text만 수정한 새 블록 배열을 돌려준다(임베드·"(끝)"·순서 불변).
// UI 다이얼로그·결선·캐럿 이동은 이 모듈이 하지 않는다(Step 1/2). editorShortcuts.js 패턴을 따른다.

import { textBlock, blocksToText, normalizeBlocks } from './editorContent.js';
import { textLineToBlockIndex } from './writerBody.js';
import { lineAtOffset } from './editorCaret.js';

// 키 인식 — 레이아웃 무관하게 code(KeyF)도 함께 본다. metaKey는 보지 않는다(기존 키 함수들과 동일 단순화).
export function isFindReplace(e) {
  return !!(e && e.ctrlKey && !e.altKey && (e.key === 'f' || e.key === 'F' || e.code === 'KeyF'));
}

// 본문 평문(blocksToText 결과)에서 query의 비중첩 매치를 순차 스캔한다.
// query는 정규식이 아니라 리터럴 부분문자열이다. 빈문자/null/undefined → []. caseSensitive=false가 기본.
// 반환: [{ start, end }] (text 절대 오프셋, end = start + query.length).
export function findMatches(text, query, { caseSensitive = false } = {}) {
  if (query === null || query === undefined || query === '') return [];
  const q = String(query);
  const src = String(text ?? '');
  const hay = caseSensitive ? src : src.toLowerCase();
  const needle = caseSensitive ? q : q.toLowerCase();
  const matches = [];
  let from = 0;
  while (from <= hay.length) {
    const idx = hay.indexOf(needle, from);
    if (idx === -1) break;
    matches.push({ start: idx, end: idx + q.length });
    from = idx + q.length; // 매치 끝 다음부터 재탐색(비중첩).
  }
  return matches;
}

// fromOffset "다음/이전" 매치의 matches 배열 인덱스(순환 탐색). matches 비면 -1.
// forward=true면 start >= fromOffset 첫 매치(없으면 0으로 wrap),
// forward=false면 start < fromOffset 중 가장 큰 것(없으면 마지막으로 wrap).
export function nextMatchIndex(matches, fromOffset, { forward = true } = {}) {
  if (!Array.isArray(matches) || matches.length === 0) return -1;
  const off = Number(fromOffset) || 0;
  if (forward) {
    for (let i = 0; i < matches.length; i += 1) {
      if (matches[i].start >= off) return i;
    }
    return 0; // wrap
  }
  for (let i = matches.length - 1; i >= 0; i -= 1) {
    if (matches[i].start < off) return i;
  }
  return matches.length - 1; // wrap
}

// 매치 오프셋이 속한 텍스트-줄과 줄안 컬럼을 구해 그 텍스트 블록의 text에서만 치환한다.
// (blocksToText는 텍스트 블록만 개행으로 잇는다 — lineAtOffset의 lineIndex는 곧 텍스트-줄 0-base 인덱스.)
function replaceAtMatch(list, text, match, replacement) {
  const { lineIndex, start: lineStart } = lineAtOffset(text, match.start);
  const blockIndex = textLineToBlockIndex(list, lineIndex);
  if (blockIndex < 0) return null; // 방어적: 매핑 실패 시 치환하지 않음.
  const col = match.start - lineStart;
  const old = list[blockIndex].text;
  const repl = String(replacement ?? '');
  const newText = old.slice(0, col) + repl + old.slice(col + (match.end - match.start));
  const next = list.slice();
  next[blockIndex] = textBlock(newText);
  return next;
}

// fromOffset 이후 첫 매치(없으면 wrap해 첫 매치) 하나만 바꾼다.
// 반환: { blocks, replaced, matchStart, caretOffset }.
//   matchStart = 치환 전 매치 시작 오프셋, caretOffset = 치환 후 새 텍스트에서 치환 결과 끝 오프셋.
//   매치 없음/빈 query → { blocks:<원본 정규화>, replaced:false, matchStart:null, caretOffset:null }.
export function replaceOne(blocks, query, replacement, { caseSensitive = false, fromOffset = 0 } = {}) {
  const list = normalizeBlocks(blocks);
  const noop = {
    blocks: list, replaced: false, matchStart: null, caretOffset: null,
  };
  if (query === null || query === undefined || query === '') return noop;
  const text = blocksToText(list);
  const matches = findMatches(text, query, { caseSensitive });
  if (matches.length === 0) return noop;
  const idx = nextMatchIndex(matches, fromOffset, { forward: true });
  const match = matches[idx];
  const next = replaceAtMatch(list, text, match, replacement);
  if (next === null) return noop;
  const repl = String(replacement ?? '');
  return {
    blocks: next,
    replaced: true,
    matchStart: match.start,
    caretOffset: match.start + repl.length, // 치환 결과 끝(앞쪽 텍스트 불변).
  };
}

// 모든 매치를 치환한 새 블록 배열 + count. 한 텍스트 블록 안의 여러 매치도 모두 치환한다.
// 임베드·블록 순서·개수 불변. 매치 0개/빈 query → { blocks:<원본 정규화>, count:0 }.
export function replaceAll(blocks, query, replacement, { caseSensitive = false } = {}) {
  const list = normalizeBlocks(blocks);
  if (query === null || query === undefined || query === '') return { blocks: list, count: 0 };
  const repl = String(replacement ?? '');
  let count = 0;
  const next = list.map((b) => {
    if (b.type !== 'text') return b; // 임베드는 그대로(순서·내용 보존).
    const matches = findMatches(b.text, query, { caseSensitive });
    if (matches.length === 0) return b;
    count += matches.length;
    let out = '';
    let cursor = 0;
    for (const m of matches) {
      out += b.text.slice(cursor, m.start) + repl;
      cursor = m.end;
    }
    out += b.text.slice(cursor);
    return textBlock(out);
  });
  return { blocks: next, count };
}
