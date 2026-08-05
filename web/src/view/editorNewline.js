// 에디터 개행 규칙 + "(끝)" 마커 텍스트 처리 (news.md 기사 에디터).
// "(끝)"은 본문 맨 마지막 다음 개행에 자기 줄로 들어간다(본문이 '...본문\n(끝)'로 끝남).
// 본문이 이미 개행으로 끝나거나 비어 있으면 이중 개행 없이 "(끝)"만 들어간다. 이미 있으면 삽입 안 함.
// CRITICAL: "(끝)" 마커 뒤에는 어떤 입력도 할 수 없다(타이핑/Enter/붙여넣기/IME). 앞 줄 편집·삭제는 허용.

import {
  END_MARKER, textBlock, isTextBlock, isEmbedBlock, normalizeBlocks,
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

// UTF-16 서로게이트 판정 헬퍼 — shouldOverwriteNextChar/overwriteExtendLength가 공유(마법 숫자 중복 방지).
// astral 문자(이모지 등)는 high(0xD800~0xDBFF) + low(0xDC00~0xDFFF) 2 코드유닛 페어로 표현된다.
const isHighSurrogate = (code) => code >= 0xD800 && code <= 0xDBFF;
const isLowSurrogate = (code) => code >= 0xDC00 && code <= 0xDFFF;

// 수정(overwrite) 모드에서 캐럿 바로 뒤 글자를 덮어쓸 대상인지 — 순수 판정(DOM 비의존).
// text = blocksToText(blocks)(텍스트 블록만 '\n'으로 조인, 임베드 제외). offset = readCaret().offset(절대 텍스트 좌표).
// true: text[offset]가 같은 줄 일반 글자(캐럿 뒤 1글자를 selection 확장해 네이티브 입력으로 대체). 아래는 전부 false(삽입 폴백):
//   - offset이 정수가 아니거나 음수/문서 끝 초과(>= length) — 무효/문서 끝.
//   - text[offset] === '\n' — 줄 끝(다음 줄·임베드 앞 침범 금지). 임베드는 blocksToText에서 제외되어 경계가 '\n'/문서 끝으로 나타난다.
//   - isInputBlocked(text, offset) — "(끝)" 마커 시작 이상(입력 차단 계약 재사용). 마커 직전은 '\n'(마커 자기 줄)이라 위에서 이미 차단.
//   - offset이 서로게이트 페어 내부(low 서로게이트이고 직전이 high) — 반쪽(low)만 대체되면 lone high가 남아
//     본문에 깨진 코드유닛이 저장·전파되므로 차단. lone low(직전이 high 아님)는 페어가 아니라 허용(반쪽 대체 문제 없음).
export function shouldOverwriteNextChar(text, offset) {
  const s = String(text ?? '');
  if (!Number.isInteger(offset) || offset < 0 || offset >= s.length) return false;
  if (s[offset] === '\n') return false;
  if (isInputBlocked(s, offset)) return false;
  if (offset > 0 && isLowSurrogate(s.charCodeAt(offset)) && isHighSurrogate(s.charCodeAt(offset - 1))) return false;
  return true;
}

// 수정(overwrite) 모드에서 캐럿 뒤 "한 문자(코드포인트)"를 덮어쓸 때 확장할 UTF-16 코드유닛 수(1 또는 2).
// text[offset]가 high 서로게이트이고 text[offset+1]가 low 서로게이트면 2(astral 문자=이모지 온전히 대체), 아니면 1.
// convertSimpTrad의 코드포인트 단위 순회와 동형(서로게이트 페어 인지). 무효/범위 밖/lone 서로게이트는 1(안전 기본).
// 페어 내부 offset(low 위치)은 게이트(shouldOverwriteNextChar)에서 이미 걸러져 여기 도달하지 않는다.
export function overwriteExtendLength(text, offset) {
  const s = String(text ?? '');
  const i = Number(offset);
  if (!Number.isInteger(i) || i < 0 || i >= s.length) return 1;
  if (isHighSurrogate(s.charCodeAt(i)) && i + 1 < s.length && isLowSurrogate(s.charCodeAt(i + 1))) return 2;
  return 1;
}

// 캐럿 위치에 텍스트(개행 포함 가능)를 삽입한 블록 배열을 만든다 — Enter('\n' 1개 삽입)·여러 줄 붙여넣기 공용.
// blocks: 텍스트/임베드가 섞인 현재 DOM 블록. caret: { lineIndex, offset }(텍스트-only 기준) 또는 null.
// text: 삽입할 문자열('\n'이면 Enter 분할). 반환 { blocks: 다음블록, caretLineIndex: 캐럿을 둘 텍스트-라인 인덱스(라인 시작) }.
// 캐럿이 속한 텍스트 블록을 오프셋 기준 head/tail로 나누고, 삽입 줄들을 그 사이에 끼워 "1줄 = 1 텍스트 블록"을 유지한다.
// 임베드는 삭제되지 않는다(텍스트 블록만 분할/삽입 — 범위 대체 시 병합 결과 뒤로 밀릴 수 있다: 규칙 4 참조).
// 캐럿이 없거나(빈/비래핑 본문) 범위를 벗어나면 마지막 텍스트 줄 끝에
// 덧붙인다 — 단, 그 줄이 "(끝)" 마커면 마커 줄 직전에 삽입한다(replaceRangeInBlocks 규칙 1-b — 마커 오염 금지).
// collapsed 캐럿 삽입은 "start === end인 범위 대체"의 특수형이다 — 규칙을 두 벌 유지하지 않도록 위임한다.
// 시그니처·반환 shape은 계약이다(Editor.jsx emitInsert·editorClipboard.insertPasteTextAtCaret 두 호출부).
export function insertTextIntoBlocks(blocks, caret, text) {
  return replaceRangeInBlocks(blocks, { start: caret, end: caret }, text);
}

// 블록 단위 "(끝)" 마커 판정 — trim 정확 비교. 재정규화 주체인 writerBody.serializeBodyFromBlocks(L20)와 같은 기준이다.
// CRITICAL: isInputBlocked의 lastIndexOf(END_MARKER)(텍스트 substring) 기준과 섞지 마라.
//   - 재정규화가 인식하지 못하는 줄을 보호 대상으로 삼으면 보호가 헛돌고,
//   - 반대로 substring 기준으로 clamp하면 "(끝)"을 본문 중간에 인용한 기사에서 정상 편집이 막힌다.
const isMarkerBlock = (b) => isTextBlock(b) && String(b.text).trim() === END_MARKER;

// 선택 범위(비-collapsed selection)를 지우고 그 자리에 텍스트를 삽입한 블록 배열을 만든다 — Enter·여러 줄 붙여넣기 공용.
// range: null | { start: Point|null, end: Point|null },  Point = { lineIndex, offset }
//   좌표 계약은 insertTextIntoBlocks와 동일하다 — lineIndex = 텍스트 블록 순번(임베드 제외),
//   offset = blocksToText(텍스트 블록만 '\n' 조인) 기준 절대 텍스트 오프셋.
// 반환 { blocks, caretLineIndex } — caretLineIndex = start.lineIndex + (삽입 줄 수 - 1).
// 순수 함수 — DOM/window/React/전역 상태 비의존(ADR-003). DOM selection → 좌표 환산·결선은 Editor.jsx(호출부)의 책임이다.
//
// 설계 이유(벗어나지 마라):
//  - 규칙 3(마커 clamp): 삭제로 tail이 '(끝)' 줄에 붙으면('B(끝)') serializeBodyFromBlocks의 trim 정확 비교가
//    마커를 놓쳐 재정규화·정렬 제외·치환 가드가 전부 풀리는데, 송고 가드 hasEndMarker는 substring이라 오염된 본문이
//    그대로 송고·배부된다(ADR-008 배부는 송고 훅에서 즉시 스풀에 기록 — 되돌릴 수 없다). 그래서 마커 줄과 그 뒤 블록은
//    이 함수가 절대 변경하지 않는다: end는 마커 줄 시작 이전으로 clamp하고, start가 마커 줄 이상이면 삽입 지점 자체를
//    규칙 1-b(마커 직전)로 되돌린다.
//    start도 이 함수가 막는 이유(리뷰 반영 — 종전에는 "호출부 책임"으로 미뤘다): 호출부 가드 Editor.caretBlocked는
//    readCaret(.yh-editor__line 앵커) 기준이라 요소 앵커에서 null을 돌려주고(전체 선택 selectNodeContents(root)·
//    문단 선택 setStartBefore/setEndAfter), 그 제스처가 정확히 start를 마커 줄에 얹는다 — 가드가 볼 수 없는 start가
//    실제로 도달한다('[(끝)] + Ctrl+A + 붙여넣기' → 'X\nY(끝)'). 보호를 순수 계층 한 곳에 모아 A-3(caretBlocked
//    무접촉)을 지키면서 호출부 좌표계 차이와 무관하게 마커를 지킨다.
//  - 규칙 4(임베드 보존): 삭제 범위 안의 임베드는 삭제되지 않고, 병합된 텍스트 블록들 **뒤**에 원래 상대 순서로
//    남는다('제자리'가 아니다 — 범위가 텍스트 한 덩어리로 합쳐지므로 그 뒤가 유일하게 안정적인 자리다).
//    미디어가 무음으로 사라지면 복구 수단이 없어서다. 삭제 수단은 임베드 × 버튼과 줄 삭제로 이미 존재한다
//    (news.md 173·174행).
//  - 규칙 5(정렬 승계): 결과 첫 줄 = start 줄 align, 마지막 줄 = end 줄 align, 중간 새 줄 = start 줄 align.
//    editorDate.js L86~92·editorGlyph.js L84~90의 "새 줄 생성 분기는 승계 대상 아님"과 반대인 이유는 대상이 다르기
//    때문이다 — 그 둘의 '새 줄'은 삽입할 줄이 아예 없어 만들어내는 무연고 줄이지만, Enter/범위 대체가 만드는 줄은
//    원본 줄을 두 조각으로 쪼갠 연속물이라 양쪽 모두 원본 서식을 이어받는 것이 맞다(워드프로세서 표준).
export function replaceRangeInBlocks(blocks, range, text) {
  const list = normalizeBlocks(blocks); // 복사본 — 입력 배열/원소를 mutate하지 않는다.
  const insLines = String(text ?? '').split('\n');

  // 텍스트 줄 인덱스(lineIndex) → list 배열 인덱스.
  const textArrIdx = [];
  for (let i = 0; i < list.length; i += 1) if (isTextBlock(list[i])) textArrIdx.push(i);
  const lineLen = (li) => list[textArrIdx[li]].text.length;

  // clamp 기준은 "첫 번째" 마커 줄(M) — 그 뒤 블록(둘째 마커 포함)은 이 함수의 관할이 아니다.
  let markerLine = -1;
  for (let li = 0; li < textArrIdx.length; li += 1) {
    if (isMarkerBlock(list[textArrIdx[li]])) { markerLine = li; break; }
  }

  // 좌표 해석 — 캐럿 미상/범위 밖이면 null(오늘의 폴백 조건과 동일).
  const resolve = (p) => {
    if (!p || !Number.isInteger(p.lineIndex) || p.lineIndex < 0 || p.lineIndex >= textArrIdx.length) return null;
    let before = 0;
    for (let i = 0; i < p.lineIndex; i += 1) before += lineLen(i) + 1;
    let inLine = Number(p.offset) - before;
    if (!Number.isFinite(inLine)) inLine = 0; // 무효 offset — 오늘의 slice(NaN)(=줄 시작)과 같은 결과.
    return { lineIndex: p.lineIndex, inLine: Math.max(0, Math.min(inLine, lineLen(p.lineIndex))) };
  };
  const isAfter = (a, b) => a.lineIndex > b.lineIndex || (a.lineIndex === b.lineIndex && a.inLine > b.inLine);

  // 규칙 1-a — 한쪽만 있으면 있는 쪽으로 collapsed 취급, 역방향 선택(start > end)은 swap.
  let start = resolve(range && range.start);
  let end = resolve(range && range.end);
  if (!start) start = end;
  if (!end) end = start;
  if (start && isAfter(start, end)) { const t = start; start = end; end = t; }

  // 규칙 1-b 공통 지점 — "마커 앞"에 삽입한다(마커가 없으면 오늘과 동일하게 마지막 텍스트 줄 끝).
  // 반환 { result }: 즉시 반환할 결과(마커가 첫 텍스트 줄이라 그 앞에 새 줄을 만들어야 하는 경우),
  //        { point }: 그 지점으로 collapsed 삽입(마커 직전 줄 끝).
  // 캐럿 미상 폴백(바로 아래)과 start clamp(규칙 3-start)가 이 한 곳을 공유한다 — 마커 보호 지점이 두 벌이면 갈린다.
  const insertBeforeMarker = () => {
    // 마커 앞에 텍스트 줄이 없다(빈 문서에서 Alt+Y를 누른 상태) — 마커 바로 앞에 새 텍스트 줄을 만들어 그 자리에 삽입.
    // 여기서 "없으면 마지막 텍스트 줄"로 폴백하면 그 줄이 곧 마커 줄이라 '(끝)A' 오염이 되살아난다.
    if (markerLine === 0) {
      const next = list.slice();
      next.splice(textArrIdx[0], 0, ...insLines.map((t) => textBlock(t)));
      return { result: { blocks: next, caretLineIndex: insLines.length - 1 } };
    }
    const targetLine = markerLine > 0 ? markerLine - 1 : textArrIdx.length - 1;
    // 삽입 대상 줄 끝 — caretLineIndex base도 이 줄이다.
    return { point: { lineIndex: targetLine, inLine: lineLen(targetLine) } };
  };

  // 규칙 1-b — 캐럿 미상 폴백. 삽입 지점은 "마커 줄 직전"이다(마커가 없으면 오늘과 동일하게 마지막 텍스트 줄 끝).
  // 오늘의 폴백은 무조건 마지막 텍스트 줄에 이어붙여, 그 줄이 '(끝)'이면 '(끝)A'로 마커를 오염시킨다.
  // 전체 선택(selectNodeContents(root))은 root 요소 앵커라 readCaret도 null을 돌려줘 caretBlocked가 막지 못하는
  // 실제 도달 가능 경로다. editorClipboard L24~27은 같은 위험을 no-op으로 회피하지만, 여기서는 삽입 위치를 마커
  // 앞으로 옮겨 사용자의 입력을 살리면서 마커를 지킨다.
  if (!start) {
    // 텍스트 줄이 하나도 없으면 오늘과 동일하게 블록 배열 끝(임베드 뒤)에 덧붙인다.
    if (textArrIdx.length === 0) {
      return { blocks: list.concat(insLines.map((t) => textBlock(t))), caretLineIndex: insLines.length - 1 };
    }
    const fb = insertBeforeMarker();
    if (fb.result) return fb.result;
    start = fb.point;
    end = start;
  }

  // 규칙 3-start — 삽입 지점(start)이 마커 줄 이상이면 규칙 1-b(마커 직전)로 되돌린다. 선택 범위 전체가
  // 마커 줄 이상이라는 뜻이므로(start가 범위의 앞점) 삭제 대상도 마커·그 뒤 블록뿐이라 함께 접는다.
  // 이 가드가 없으면 요소 앵커 제스처(전체 선택·문단 선택)에서 마커 줄이 'X\nY(끝)'로 오염된다 — 위 설계 이유 참조.
  if (markerLine >= 0 && start.lineIndex >= markerLine) {
    const fb = insertBeforeMarker();
    if (fb.result) return fb.result;
    start = fb.point;
    end = start;
  }

  // 규칙 3-end — 삭제 end를 마커 줄 시작 이전으로 clamp. clamp 결과가 start보다 앞이면 삭제 없이 삽입만 한다.
  if (markerLine >= 0 && end.lineIndex >= markerLine) {
    const clamped = markerLine > 0 ? { lineIndex: markerLine - 1, inLine: lineLen(markerLine - 1) } : null;
    end = clamped && !isAfter(start, clamped) ? clamped : start;
  }

  // 규칙 4·5 — start 줄 head + 삽입 줄들 + end 줄 tail로 병합하고, 범위 안의 임베드는 병합 결과 뒤에 순서대로 남긴다.
  const startArr = textArrIdx[start.lineIndex];
  const endArr = textArrIdx[end.lineIndex];
  const startAlign = list[startArr].align;
  const endAlign = list[endArr].align;
  const newLines = insLines.slice();
  newLines[0] = list[startArr].text.slice(0, start.inLine) + newLines[0];
  newLines[newLines.length - 1] += list[endArr].text.slice(end.inLine);
  const last = newLines.length - 1;
  const newBlocks = newLines.map((t, i) => textBlock(t, i === last && last > 0 ? endAlign : startAlign));
  const keptEmbeds = list.slice(startArr, endArr + 1).filter(isEmbedBlock);
  const next = list.slice();
  next.splice(startArr, endArr - startArr + 1, ...newBlocks, ...keptEmbeds);
  return { blocks: next, caretLineIndex: start.lineIndex + (insLines.length - 1) };
}
