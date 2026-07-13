// 편집 메뉴 문서/문단 정렬 · 단어 삭제 순수 계산 — 블록 배열 in → 블록 배열 out(입력 불변).
// editorShortcuts.js의 transformTextLine/deleteLineAt와 동일 계층(DOM/transport 비의존).
// 정책(news.md L161·165~169): "(끝)" 마커는 정렬 대상에서 제외하고 항상 최종 블록으로 유지
// (insertContinueMarker/insertEmbedAfterLine의 마커 재정규화 동형), 임베드는 정렬 대상이 아니며
// 자리를 옮기지 않는다(텍스트 값만 텍스트-블록 슬롯에 순서대로 되쓴다). 단어 삭제는 마커 줄이면 no-op
// — 부분 삭제가 마커를 '끝)' 같은 손상 조각으로 만들어 송고 자격을 조용히 깨는 것을 막는다(editorFind 가드 동형).
// 한줄 지우기 헬퍼는 여기 만들지 않는다 — deleteLineAt(Ctrl+D)이 단일 출처이며, 마커 줄 통째 삭제는
// news.md "(끝)을 지우면 입력이 재개된다"에 따라 허용된다(결선은 step 4).

import {
  END_MARKER, textBlock, blocksToText, isTextBlock, normalizeBlocks,
} from './editorContent.js';
import { textLineToBlockIndex } from './writerBody.js';
import { wordBoundsAt, paragraphBoundsAt } from './editorRange.js';

// "(끝)" 종료 마커 텍스트 블록 판정 — 형제 도구(abbrevConvert/editorFind)와 동일 기준(trim 비교).
function isEndMarkerBlock(b) {
  return isTextBlock(b) && String(b.text).trim() === END_MARKER;
}

// 두 블록 배열이 내용상 같은지(changed 판정용). 텍스트는 text 값 비교, 임베드는 참조 비교로 충분
// (이 모듈은 임베드 객체를 새로 만들지 않고 그대로 옮기므로 참조가 다르면 자리가 바뀐 것이다).
function sameBlocks(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] === b[i]) continue;
    if (isTextBlock(a[i]) && isTextBlock(b[i]) && a[i].text === b[i].text) continue;
    return false;
  }
  return true;
}

// 문서 전체 텍스트 줄 값을 localeCompare 오름차순 정렬한다(안정 정렬 — 동일 값 상대 순서 보존, 빈 줄도 '' 값으로 함께).
// "(끝)" 마커·임베드는 정렬 대상 제외. 임베드는 제자리 유지, 마커는 최종 블록으로 재정규화
// (입력이 malformed로 마커가 중간에 있어도 최종 보장). 반환 { blocks, changed }.
export function sortDocument(blocks) {
  const list = normalizeBlocks(blocks);
  const slots = [];
  const values = [];
  for (let i = 0; i < list.length; i += 1) {
    if (isTextBlock(list[i]) && !isEndMarkerBlock(list[i])) {
      slots.push(i);
      values.push(list[i].text);
    }
  }
  const sorted = values.slice().sort((a, b) => a.localeCompare(b));
  const next = list.slice();
  for (let k = 0; k < slots.length; k += 1) next[slots[k]] = textBlock(sorted[k]);
  const hasEnd = next.some(isEndMarkerBlock);
  const ordered = next.filter((b) => !isEndMarkerBlock(b));
  if (hasEnd) ordered.push(textBlock(END_MARKER));
  return { blocks: ordered, changed: !sameBlocks(ordered, list) };
}

// caretLineIndex(텍스트-줄 인덱스)가 속한 문단 내부의 텍스트 줄 값만 localeCompare 오름차순 정렬한다.
// 문단 정의는 paragraphBoundsAt(빈 줄 경계 — editorStats.paragraphIndex 동일). 범위 안 마커 줄은
// 정렬 대상에서 제외하고 위치 보존(정상 문서에선 문단과 마커가 겹치지 않지만 방어). 임베드는
// blocksToText에서 이미 빠져 문단 계산·정렬에 무관(불변). 반환 { blocks, changed }.
export function sortParagraph(blocks, caretLineIndex) {
  const list = normalizeBlocks(blocks);
  const linesArr = blocksToText(list).split('\n');
  const { startLine, endLine } = paragraphBoundsAt(linesArr, caretLineIndex);
  const slotLines = [];
  const values = [];
  for (let ln = startLine; ln <= endLine; ln += 1) {
    if (String(linesArr[ln]).trim() === END_MARKER) continue;
    slotLines.push(ln);
    values.push(linesArr[ln]);
  }
  if (values.length <= 1) return { blocks: list, changed: false }; // 단일 줄 문단/빈 줄 — 정렬 대상 1개 이하.
  const sorted = values.slice().sort((a, b) => a.localeCompare(b));
  const next = list.slice();
  let changed = false;
  for (let k = 0; k < slotLines.length; k += 1) {
    const bi = textLineToBlockIndex(next, slotLines[k]);
    if (bi < 0) continue; // 방어적: 매핑 실패 슬롯은 건드리지 않는다.
    if (next[bi].text !== sorted[k]) {
      next[bi] = textBlock(sorted[k]);
      changed = true;
    }
  }
  return { blocks: next, changed };
}

// caretLineIndex 텍스트 줄의 column(줄-로컬) 위치 단어(wordBoundsAt — \S 런)를 삭제한다. 주변 공백은
// 병합/삭제하지 않는다. 마커 줄·매핑 실패·단어 없음(start === end)이면 no-op.
// 반환 { blocks, changed, caretColumn } — caretColumn은 삭제 후 캐럿을 둘 줄-로컬 위치(단어 start), no-op이면 null.
export function deleteWordAt(blocks, caretLineIndex, column) {
  const list = normalizeBlocks(blocks);
  const blockIndex = textLineToBlockIndex(list, caretLineIndex);
  if (blockIndex < 0) return { blocks: list, changed: false, caretColumn: null };
  const lineText = String(list[blockIndex].text);
  if (lineText.trim() === END_MARKER) return { blocks: list, changed: false, caretColumn: null };
  const { start, end } = wordBoundsAt(lineText, column);
  if (start === end) return { blocks: list, changed: false, caretColumn: null };
  const next = list.slice();
  next[blockIndex] = textBlock(lineText.slice(0, start) + lineText.slice(end));
  return { blocks: next, changed: true, caretColumn: start };
}
