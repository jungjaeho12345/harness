// 편집 메뉴 문서/문단 정렬 · 단어 삭제 순수 계산 — 블록 배열 in → 블록 배열 out(입력 불변).
// editorShortcuts.js의 transformTextLine/deleteLineAt와 동일 계층(DOM/transport 비의존).
// 정책(news.md L161·165~169): "(끝)" 마커는 정렬 대상에서 제외하고 항상 최종 블록으로 유지
// (insertContinueMarker/insertEmbedAfterLine의 마커 재정규화 동형), 임베드는 정렬 대상이 아니며
// 자리를 옮기지 않는다(텍스트 값·정렬 쌍만 텍스트-블록 슬롯에 순서대로 되쓴다). 단어 삭제는 마커 줄이면 no-op
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
// align을 비교하지 않는 것은 의도다: sortDocument는 { text, align } 쌍을 텍스트 기준으로 안정 정렬하므로,
// 출력 텍스트 시퀀스가 입력과 같다면 그 정렬은 항등 순열이고 align 쌍도 이동하지 않는다.
// 판정을 align까지 넓히면 결과가 같은데도 changed=true가 되어 불필요한 dirty·저장이 생긴다(phase49 결정).
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
// align은 텍스트 값을 따라 이동한다(줄=텍스트+정렬 한 쌍) — phase 45 step0이 보류한 설계 결정을 phase 49 step4에서 확정.
// "(끝)" 마커·임베드는 정렬 대상 제외. 임베드는 제자리 유지, 마커는 최종 블록으로 재정규화
// (입력이 malformed로 마커가 중간에 있어도 최종 보장). 반환 { blocks, changed }.
export function sortDocument(blocks) {
  const list = normalizeBlocks(blocks);
  const slots = [];
  const values = [];
  for (let i = 0; i < list.length; i += 1) {
    if (isTextBlock(list[i]) && !isEndMarkerBlock(list[i])) {
      slots.push(i);
      values.push({ text: list[i].text, align: list[i].align });
    }
  }
  const sorted = values.slice().sort((a, b) => a.text.localeCompare(b.text));
  const next = list.slice();
  for (let k = 0; k < slots.length; k += 1) next[slots[k]] = textBlock(sorted[k].text, sorted[k].align);
  // 마커 재정규화 — 문서 순서상 첫 마커의 align도 승계한다(재정규화가 정렬을 지우지 않게). 텍스트는 정규 END_MARKER로 되쓴다.
  const prevMarker = next.find(isEndMarkerBlock);
  const ordered = next.filter((b) => !isEndMarkerBlock(b));
  if (prevMarker) ordered.push(textBlock(END_MARKER, prevMarker.align));
  return { blocks: ordered, changed: !sameBlocks(ordered, list) };
}

// caretLineIndex(텍스트-줄 인덱스)가 속한 문단 내부의 텍스트 줄 값만 localeCompare 오름차순 정렬한다.
// align은 텍스트 값을 따라 이동한다(줄=텍스트+정렬 한 쌍 — sortDocument와 동일 규칙, phase 49 step4 확정).
// 문단 정의는 paragraphBoundsAt(빈 줄 경계 — editorStats.paragraphIndex 동일). 범위 안 마커 줄은
// 정렬 대상에서 제외하고 위치 보존(정상 문서에선 문단과 마커가 겹치지 않지만 방어). 임베드는
// blocksToText에서 이미 빠져 문단 계산·정렬에 무관(불변). 반환 { blocks, changed }.
// caretLineIndex가 텍스트 줄에 매핑되지 않으면(음수·NaN·범위 밖 → textLineToBlockIndex -1) no-op —
// 파괴 연산 입구에서 clamp로 마지막 문단에 접히는 것을 막는다(deleteWordAt·deleteLineAt와 동형 판정).
export function sortParagraph(blocks, caretLineIndex) {
  const list = normalizeBlocks(blocks);
  if (textLineToBlockIndex(list, caretLineIndex) < 0) return { blocks: list, changed: false };
  const linesArr = blocksToText(list).split('\n');
  const { startLine, endLine } = paragraphBoundsAt(linesArr, caretLineIndex);
  const slotLines = [];
  const values = [];
  for (let ln = startLine; ln <= endLine; ln += 1) {
    if (String(linesArr[ln]).trim() === END_MARKER) continue;
    slotLines.push(ln);
    const bi = textLineToBlockIndex(list, ln);
    values.push({ text: linesArr[ln], align: bi >= 0 ? list[bi].align : undefined });
  }
  if (values.length <= 1) return { blocks: list, changed: false }; // 단일 줄 문단/빈 줄 — 정렬 대상 1개 이하.
  const sorted = values.slice().sort((a, b) => a.text.localeCompare(b.text));
  const next = list.slice();
  let changed = false;
  for (let k = 0; k < slotLines.length; k += 1) {
    const bi = textLineToBlockIndex(next, slotLines[k]);
    if (bi < 0) continue; // 방어적: 매핑 실패 슬롯은 건드리지 않는다.
    // 텍스트 OR 정렬이 다르면 되쓴다 — 동일 텍스트 줄 사이에서도 align은 실제로 이동하므로 텍스트만 보고 skip 금지.
    if (next[bi].text !== sorted[k].text || next[bi].align !== sorted[k].align) {
      next[bi] = textBlock(sorted[k].text, sorted[k].align);
      changed = true;
    }
  }
  return { blocks: next, changed };
}

// caretLineIndex 텍스트 줄의 column(줄-로컬) 위치 단어(wordBoundsAt — \S 런)를 삭제한다. 주변 공백은
// 병합/삭제하지 않는다. 마커 줄·매핑 실패·단어 없음(start === end)이면 no-op. 그 줄의 정렬(align) 필드는 승계한다.
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
  next[blockIndex] = textBlock(lineText.slice(0, start) + lineText.slice(end), list[blockIndex].align);
  return { blocks: next, changed: true, caretColumn: start };
}
