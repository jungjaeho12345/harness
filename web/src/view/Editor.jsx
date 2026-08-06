// 기사 에디터 컴포넌트 — 본문 블록(텍스트/임베드)을 색상 규칙대로 렌더한다.
// CRITICAL: 본문 영역 위에 '본문' 라벨 텍스트는 표시하지 않는다(접근성 aria-label은 유지 — news.md).
// 색: 제목 파랑/부제 빨강/본문 검정/"(끝)" 골드(editorColoring). transport 비의존 — 변경은 콜백(onRemoveEmbed/onKeyDown)으로만.
// 키 입력 결선(step15): "(끝)" 뒤 삽입 차단(isInputBlocked)·IME 조합 중 재색칠 금지(shouldRecolor) — news.md 162·168행.
//
// CRITICAL(타이핑 안정성): contentEditable을 매 입력마다 state로 재렌더하면 브라우저 캐럿이 초기화되어
// "맘대로 써지고", 브라우저가 직접 바꾼 DOM을 React가 재조정하다 removeChild로 크래시(화면 하얘짐)한다.
// → 타이핑 중에는 React가 편집 영역을 다시 그리지 않는다(내부 snapshot 고정). 외부/구조 변경(로드·Ctrl+D·
//   임베드 추가/삭제·Alt+Y·포커스 이탈 재색칠)일 때만 snapshot을 갱신하고 편집 div를 깨끗이 remount한다.
// 맞춤법 하이라이트(39-1): spellHighlights(blocksToText 절대 오프셋 span)를 표시전용으로 렌더한다 —
//   세그먼트는 highlightSnapRef 스냅샷에서만 읽고(prop 직접 읽기 금지), 변화는 renderTick remount로만 반영한다.

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { blocksToText, isEmbedBlock, isTextBlock, isValidAlign, textBlock } from './editorContent.js';
import { classifyLines, colorForRole, shouldRecolor } from './editorColoring.js';
import { isInputBlocked, replaceRangeInBlocks } from './editorNewline.js';
import { buildLineHighlights } from './editorSpellHighlight.js';
import { InlineEmbed } from './InlineEmbed.jsx';

// contentEditable에서 입력된 본문 텍스트를 라인 div 기준으로 재구성한다(임베드 figure는 제외).
// readCaret과 같은 기준(.yh-editor__line indexOf)을 쓴다 — "(끝)" 차단 판정(caretBlocked)용.
function readEditorText(root) {
  if (!root) return '';
  const lineEls = root.querySelectorAll('.yh-editor__line');
  if (!lineEls.length) return root.textContent ?? '';
  return Array.from(lineEls).map((el) => el.textContent ?? '').join('\n');
}

// 블록 경계로 취급할 태그(브라우저가 Enter/붙여넣기로 만드는 줄 래퍼).
const BLOCK_TAGS = new Set(['DIV', 'P', 'SECTION', 'ARTICLE', 'LI']);

// 한 요소의 내용을 "줄 문자열 배열"로 펼친다. <br>와 블록 요소(div/p…)는 줄 경계로, 인라인/텍스트는 누적한다.
// 깨끗한 .yh-editor__line은 자식이 텍스트뿐이라 [textContent] 한 줄이 된다. 브라우저가 만든 중첩 div/<br>도 개행으로 복원.
function elementToLines(el) {
  const out = [];
  let cur = '';
  let dirty = false; // cur에 내용이 들어왔는지(빈 줄과 "줄 없음"을 구분)
  const push = () => { out.push(cur); cur = ''; dirty = false; };
  for (const child of el.childNodes) {
    if (child.nodeType === 3) { // 텍스트 노드
      cur += child.textContent ?? '';
      dirty = true;
    } else if (child.nodeType === 1) { // 요소
      if (child.tagName === 'BR') {
        push();
      } else if (BLOCK_TAGS.has(child.tagName)) {
        if (dirty) push(); // 블록 자식 앞의 인라인 줄을 먼저 닫는다
        for (const sub of elementToLines(child)) { cur = sub; push(); }
      } else { // span 등 인라인 요소
        cur += child.textContent ?? '';
        dirty = true;
      }
    }
  }
  if (dirty || out.length === 0) push(); // 마지막 줄(또는 완전히 빈 요소 → 빈 줄 1개) 보장
  return out;
}

// 편집 영역 DOM을 텍스트/임베드 블록 배열로 재구성한다(DOM 순서대로 인터리브, 개행 보존).
// 깨끗한 경우: 자식은 .yh-editor__line(텍스트 줄)과 .yh-embed(임베드)뿐 → 1줄 = 1 텍스트 블록.
// 거친 경우: 브라우저가 Enter/붙여넣기로 만든 <br>·클래스 없는 중첩 div·맨 앞 bare 텍스트노드도 개행으로 복원한다
//   (textContent는 블록 경계 개행을 넣지 않아 여러 줄이 한 블록으로 합쳐지던 버그를 막는다).
// 임베드 데이터는 figure DOM에 없으므로 스냅샷(snapshotBlocks)에서 가져온다. figure의 data-embed-key(snapshot 블록
// 인덱스)로 '안정적 매칭'을 하고, 키가 없을 때만 등장 순서로 폴백한다 — 인라인 삭제 등으로 임베드 개수가 어긋나도
// 살아남은 임베드 데이터가 뒤바뀌지 않는다(news.md 156·167행).
function readEditorBlocks(root, snapshotBlocks) {
  if (!root) return [];
  const snap = Array.isArray(snapshotBlocks) ? snapshotBlocks : [];
  const snapEmbeds = snap.filter(isEmbedBlock);
  const out = [];
  let pending = null; // 최상위의 느슨한 인라인 텍스트(bare 텍스트노드/인라인 요소) 누적값 — null이면 줄 미시작
  let ei = 0; // data-embed-key가 없는 figure를 위한 등장 순서 폴백 인덱스
  const flush = () => { if (pending !== null) { out.push(textBlock(pending)); pending = null; } };
  const add = (s) => { pending = (pending ?? '') + s; };

  for (const node of root.childNodes) {
    if (node.nodeType === 3) { add(node.textContent ?? ''); continue; }
    if (node.nodeType !== 1) continue;
    const el = node;
    if (el.classList && el.classList.contains('yh-embed')) {
      flush();
      const rawKey = el.dataset && el.dataset.embedKey;
      const keyed = (rawKey != null && rawKey !== '') ? snap[Number(rawKey)] : undefined;
      if (isEmbedBlock(keyed)) out.push(keyed); // 안정적 키 매칭(인라인 삭제에도 안전)
      else if (ei < snapEmbeds.length) out.push(snapEmbeds[ei]); // 폴백: DOM 등장 순서
      ei += 1;
    } else if (el.tagName === 'BR') { // 최상위 <br> — 현재 느슨한 줄을 닫는다(빈 줄이라도)
      out.push(textBlock(pending ?? ''));
      pending = null;
    } else if ((el.classList && el.classList.contains('yh-editor__line')) || BLOCK_TAGS.has(el.tagName)) {
      flush();
      // 정렬을 DOM(data-align)에서 되읽어 첫 줄에만 승계한다(임베드가 data-embed-key로 생존하는 것과 동형).
      // 클린 케이스(.yh-editor__line 1요소=1줄)에선 그 줄에 정렬이 살아나고, dirty(중첩→여러 줄)면 새로 생긴
      // 나머지 줄은 미정렬로 둔다(새 줄은 미정렬이 정상 — stale 좌표 추정 금지).
      const a = (el.dataset && isValidAlign(el.dataset.align)) ? el.dataset.align : undefined;
      const lines = elementToLines(el);
      lines.forEach((line, idx) => out.push(textBlock(line, idx === 0 ? a : undefined)));
    } else { // 인라인 요소
      add(el.textContent ?? '');
    }
  }
  flush();
  return out;
}

// 임베드 블록들의 서명 — 구조(임베드 추가/삭제/변경) 변화 감지에 쓴다(텍스트 타이핑과 무관).
function embedSig(blocks) {
  return JSON.stringify((Array.isArray(blocks) ? blocks : []).filter(isEmbedBlock));
}

// 텍스트 블록들의 정렬 서명 — 정렬만 바뀐 변경도 remount(재렌더)시키기 위함(텍스트/임베드와 독립).
function alignSig(blocks) {
  return JSON.stringify((Array.isArray(blocks) ? blocks : []).filter(isTextBlock).map((b) => b.align || ''));
}

// 맞춤법 하이라이트 서명 — 하이라이트 유무/내용/스타일 변화 판정 전용(텍스트·임베드·정렬 echo 판정과 독립 —
// 표시 신호가 echo 판정을 오염시키면 타이핑마다 헛 remount가 난다: phase 35 alignSig 계열 회귀).
// 스타일(bold↔underline) 변경도 remount가 필요하므로 시그니처에 포함한다.
function highlightSig(spans, style) {
  return JSON.stringify({ s: spans || [], st: style });
}

// 현재 selection 캐럿을 { lineIndex, offset, col }으로 읽는다 — lineIndex는 라인 div(=텍스트 블록) 순서,
// offset은 readEditorText(=blocksToText) 기준 텍스트 오프셋, col은 줄 내 열(=offsetInLine).
// selection이 없거나 에디터 밖이면 null(차단/삭제 판정에서 허용 기본값).
// offsetInLine 계약(39-1): 줄 요소 시작부터 캐럿 지점 (anchorNode, anchorOffset)까지 document-order로
// 앞서는 모든 텍스트의 길이(하이라이트 span 내부 텍스트 포함). 하이라이트 span이 생기면 줄이
// [텍스트, <span>, 텍스트, …]가 되므로, anchorOffset만 보는 좁은 규칙은 앞 span 길이를 누락해 col이 과소 계산된다.
// 단일 텍스트 노드 줄에선 range.toString().length === anchorOffset이라 기존과 동일(하위호환).
export function readCaret(root) {
  const sel = (typeof window !== 'undefined' && window.getSelection) ? window.getSelection() : null;
  if (!root || !sel || sel.rangeCount === 0) return null;
  const node = sel.anchorNode;
  if (!node || !root.contains(node)) return null;
  const lineEls = Array.from(root.querySelectorAll('.yh-editor__line'));
  let lineEl = node.nodeType === 3 ? node.parentElement : node;
  while (lineEl && lineEl !== root && !(lineEl.classList && lineEl.classList.contains('yh-editor__line'))) {
    lineEl = lineEl.parentElement;
  }
  const lineIndex = lineEls.indexOf(lineEl);
  if (lineIndex === -1) return null;
  let offsetInLine;
  if (typeof document !== 'undefined' && document.createRange) {
    const r = document.createRange();
    r.selectNodeContents(lineEl); // 줄 내용 시작
    r.setEnd(node, sel.anchorOffset); // 캐럿 지점까지(요소 anchor면 그 자식 경계까지)
    offsetInLine = r.toString().length; // 앞선 전체 텍스트 길이(span 내부 포함)
  } else {
    offsetInLine = node.nodeType === 3 ? sel.anchorOffset : 0; // Range 미지원 폴백(기존 좁은 규칙)
  }
  let offset = 0;
  for (let i = 0; i < lineIndex; i += 1) offset += (lineEls[i].textContent ?? '').length + 1; // +1 개행
  return { lineIndex, offset: offset + offsetInLine, col: offsetInLine };
}

// emitInsert(Enter·여러 줄 붙여넣기) 전용 지점 환산 — readEditorBlocks/elementToLines와 "같은 줄 기준"으로
// (node, offset) 지점을 { lineIndex(텍스트-줄 순서), offset(blocksToText 좌표) }으로 바꾼다.
// readCaret(.yh-editor__line 단위)과 달리 줄 안 <br>·중첩 블록까지 분할해 세므로, dirty DOM(브라우저가 만든
// 줄 안 <br> 등)에서도 분할 위치가 정확하다. 깨끗한 DOM에선 readCaret과 동일 결과(1 .yh-editor__line = 1 줄).
// 에디터 밖/미발견이면 null.
// 지점 해석 규칙:
//  - 텍스트 노드 지점: offset은 문자 오프셋(줄 안 col로 누적 환산).
//  - 요소 지점: offset은 문자 오프셋이 아니라 DOM Range 표준의 "자식 경계 인덱스"다.
//      offset < childNodes.length  → childNodes[offset] "바로 앞" 지점
//      offset >= childNodes.length → 그 요소 "내용의 끝" 지점(selectNodeContents의 end·setEndAfter가 만드는 지점)
//    node === root도 반드시 같은 규칙으로 환산한다 — 편집>전체 선택(selectNodeContents(root))·문단 선택
//    (setStartBefore/setEndAfter)이 만드는 앵커가 root이고, null로 흘리면 그 흔한 제스처에서 선택 범위가
//    통째로 유실된다(요소 앵커를 col 0으로 접는 것도 같은 이유로 금지 — 한 줄 선택이 collapsed로 접힌다).
//  - 임베드(.yh-embed)는 blocksToText에 포함되지 않으므로(step0 좌표 계약) 그 경계는 앞 텍스트 줄의 끝 /
//    다음 텍스트 줄의 시작으로 수렴시킨다.
// 회귀 안전: 오늘 요소 지점을 만드는 경로(focusLineStart·focusCaretAt 빈 줄 폴백)는 전부 offset 0이라
// "첫 자식 앞" = 줄 시작 = col 0으로 기존과 같은 값이 나온다(빈 줄은 자식이 없어 "내용 끝" = col 0).
function readPointForInsert(root, node, offset) {
  if (!root || !node || !root.contains(node)) return null;
  const raw = Number(offset);
  const O = Number.isFinite(raw) ? Math.max(0, raw) : 0;
  // 지점 정규화 — 텍스트 지점(pText) / "이 노드 바로 앞"(pBefore) / "이 요소 내용 끝"(pEnd) 중 하나.
  let pText = null;
  let pBefore = null;
  let pEnd = null;
  if (node.nodeType === 3) pText = node;
  else if (node.nodeType === 1) {
    if (O < node.childNodes.length) pBefore = node.childNodes[O];
    else pEnd = node;
  } else return null;

  const out = []; // 완성된 텍스트 줄(임베드 제외 — blocksToText와 동일 시퀀스)
  let pending = null; // 최상위 인라인 누적 줄
  let caretLine = null;
  let caretCol = null;
  const hit = (line, col) => { if (caretLine === null) { caretLine = line; caretCol = col; } };
  const isEmbedEl = (el) => !!(el.classList && el.classList.contains('yh-embed'));
  const isLineEl = (el) => !!((el.classList && el.classList.contains('yh-editor__line')) || BLOCK_TAGS.has(el.tagName));
  const flush = () => { if (pending !== null) { out.push(pending); pending = null; } };
  // 임베드 경계·문서 끝 — 진행 중인 줄이 있으면 그 끝, 없으면 직전 텍스트 줄의 끝(둘 다 없으면 문서 시작).
  const hitAtTextEnd = () => {
    if (pending !== null) hit(out.length, pending.length);
    else if (out.length) hit(out.length - 1, out[out.length - 1].length);
    else hit(0, 0);
  };
  // 인라인 요소(하이라이트 span 등) 안의 지점 — 앞선 텍스트 길이를 누적해 col을 잡는다(span 없을 땐 미사용).
  const seekInline = (el, base) => {
    let acc = base;
    const walk = (el2) => {
      for (const sub of el2.childNodes) {
        if (sub === pBefore) { hit(out.length, acc); return true; }
        if (sub === pText) { hit(out.length, acc + Math.min(O, (sub.textContent ?? '').length)); return true; }
        if (sub.nodeType === 3) acc += (sub.textContent ?? '').length;
        else if (sub.nodeType === 1) {
          if (walk(sub)) return true;
          if (sub === pEnd) { hit(out.length, acc); return true; }
        }
      }
      return false;
    };
    return walk(el);
  };

  // 블록 요소(.yh-editor__line/div/p…) 내용을 줄로 펼치며 지점을 추적(elementToLines와 동일 규칙).
  const walkBlock = (el) => {
    const startLen = out.length;
    let cur = '';
    let dirty = false;
    const pushLine = () => { out.push(cur); cur = ''; dirty = false; };
    for (const child of el.childNodes) {
      // 자식 경계 지점 — 블록 자식 앞이면 그 블록의 첫 줄 시작, 그 외(텍스트/인라인/<br>)엔 현재 줄의 현재 열.
      if (child === pBefore) {
        if (child.nodeType === 1 && isLineEl(child)) hit(out.length + (dirty ? 1 : 0), 0);
        else hit(out.length, cur.length);
      }
      if (child.nodeType === 3) {
        if (child === pText) hit(out.length, cur.length + Math.min(O, (child.textContent ?? '').length));
        cur += child.textContent ?? ''; dirty = true;
      } else if (child.nodeType === 1) {
        if (child.tagName === 'BR') {
          pushLine();
        } else if (isLineEl(child)) {
          if (dirty) pushLine();
          walkBlock(child);
        } else { // 인라인 — 내부에 지점이 있으면 앞선 텍스트 길이를 누적해 col을 잡는다(하이라이트 span 안 Enter).
          if (caretLine === null && child.contains && child.contains(node)) seekInline(child, cur.length);
          cur += child.textContent ?? ''; dirty = true;
          if (child === pEnd) hit(out.length, cur.length); // 인라인 내용의 끝
        }
      }
    }
    if (dirty || out.length === startLen) pushLine();
    if (el === pEnd) { // 이 요소 내용의 끝 = 이 요소가 만든 마지막 줄의 끝(한 줄 선택 selectNodeContents(lineEl)의 end)
      const li = Math.max(startLen, out.length - 1);
      hit(li, (out[li] ?? '').length);
    }
  };

  for (const nd of root.childNodes) {
    if (nd === pBefore) { // root의 자식 경계(전체 선택 start·문단 선택 start/end)
      if (nd.nodeType === 1 && isEmbedEl(nd)) hitAtTextEnd(); // 임베드 앞 = 앞 텍스트 줄의 끝
      else if (nd.nodeType === 1 && isLineEl(nd)) hit(out.length + (pending !== null ? 1 : 0), 0);
      else hit(out.length, (pending ?? '').length);
    }
    if (nd.nodeType === 3) {
      if (pending === null) pending = '';
      if (nd === pText) hit(out.length, pending.length + Math.min(O, (nd.textContent ?? '').length));
      pending += nd.textContent ?? '';
      continue;
    }
    if (nd.nodeType !== 1) continue;
    const el = nd;
    if (isEmbedEl(el)) { if (el === pEnd) hitAtTextEnd(); flush(); continue; } // 임베드: 텍스트 줄 분리(텍스트 없음)
    if (el.tagName === 'BR') { out.push(pending ?? ''); pending = null; continue; } // 최상위 <br> — 현재 줄 닫음(빈 줄이라도)
    if (isLineEl(el)) {
      flush(); walkBlock(el);
    } else { // 최상위 인라인
      if (pending === null) pending = '';
      if (caretLine === null && el.contains && el.contains(node)) seekInline(el, pending.length);
      pending += el.textContent ?? '';
      if (el === pEnd) hit(out.length, pending.length);
    }
  }
  if (root === pEnd) hitAtTextEnd(); // root 내용의 끝(전체 선택 focus — selectNodeContents(root)의 end)
  flush();

  if (caretLine === null) return null;
  let abs = caretCol;
  for (let i = 0; i < caretLine; i += 1) abs += (out[i] ?? '').length + 1; // 앞 줄들 + 각 '\n'
  return { lineIndex: caretLine, offset: abs };
}

// 현재 selection을 삽입용 range로 읽는다 — { start, end }(둘 다 readPointForInsert 좌표) 또는 null.
// Enter·여러 줄 붙여넣기는 preventDefault로 브라우저의 기본 대체(선택 삭제 후 삽입)를 막으므로,
// 선택 범위 삭제를 우리 경로가 넘겨야 한다(넘기지 않으면 선택 텍스트가 그대로 남아 본문이 파손된다).
// - anchor 환산이 null이면 range 전체를 null로 흘린다(focus가 유효해도 범위를 지어내지 않는다 — 오늘의 캐럿 미상 폴백 유지).
// - collapsed·focus 미상·focus가 에디터 밖·focus 환산 실패면 anchor로 collapsed range(삭제 없음).
// - 역방향(anchor가 뒤) 정규화·마커 clamp·임베드 보존은 순수 계층(replaceRangeInBlocks)의 몫이다 — 여기서 중복 구현하지 않는다.
function readSelectionForInsert(root) {
  const sel = (typeof window !== 'undefined' && window.getSelection) ? window.getSelection() : null;
  if (!root || !sel || sel.rangeCount === 0) return null;
  const start = readPointForInsert(root, sel.anchorNode, sel.anchorOffset);
  if (!start) return null;
  const f = sel.focusNode;
  if (sel.isCollapsed || !f || !root.contains(f)) return { start, end: start };
  const end = readPointForInsert(root, f, sel.focusOffset);
  return { start, end: end || start };
}

// 캐럿이 "(끝)" 마커 시작 이상이면 삽입 차단 대상(news.md 162행). 캐럿 미상이면 차단하지 않는다.
function caretBlocked(root) {
  const caret = readCaret(root);
  return !!caret && isInputBlocked(readEditorText(root), caret.offset);
}

// dataTransfer(드롭)에서 첫 이미지 파일을 찾는다 — files 우선, 없으면 items에서 getAsFile로 꺼낸다.
// 판정 규칙은 handlePaste의 클립보드 이미지 판정과 같다(type이 'image/'로 시작).
function findImageFile(dt) {
  if (!dt) return null;
  const files = dt.files ? Array.from(dt.files) : [];
  const direct = files.find((f) => f && typeof f.type === 'string' && f.type.startsWith('image/'));
  if (direct) return direct;
  const items = dt.items ? Array.from(dt.items) : [];
  for (const it of items) {
    if (it && typeof it.type === 'string' && it.type.startsWith('image/') && typeof it.getAsFile === 'function') {
      const f = it.getAsFile();
      if (f) return f;
    }
  }
  return null;
}

// 삽입성 키 — 문자 입력과 Enter만. 삭제/이동/선택 키(Backspace/Delete/방향키/Ctrl·Meta 조합)는 제외한다(news.md: 삭제/이동/선택은 항상 허용).
function isInsertionKey(e) {
  if (e.key === 'Enter') return true;
  return typeof e.key === 'string' && e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey;
}

// 편집 div에 focus 후 지정 텍스트-줄(.yh-editor__line) 시작에 캐럿을 둔다.
// remount 후 캐럿 복원(refocusRef)과 지정 줄 포커스(pendingCaretLine)의 공용 경로.
function focusLineStart(root, lineIndex) {
  if (!root) return;
  root.focus();
  const lineEls = root.querySelectorAll('.yh-editor__line');
  if (!lineEls.length) return;
  const idx = Math.max(0, Math.min(lineIndex, lineEls.length - 1));
  const sel = (typeof window !== 'undefined' && window.getSelection) ? window.getSelection() : null;
  if (!sel || typeof document === 'undefined' || !document.createRange) return;
  const range = document.createRange();
  range.selectNodeContents(lineEls[idx]);
  range.collapse(true); // 줄 시작에 캐럿
  sel.removeAllRanges();
  sel.addRange(range);
}

// 편집 div에 focus 후 지정 텍스트-줄(clamp)의 col 위치에 collapsed 캐럿을 둔다(focusLineStart의 형제).
// 39-1: 하이라이트-only 클리어 remount 전용 — 클리어 직후 그 줄은 항상 하이라이트가 비어 단일 텍스트 노드라
// firstChild(텍스트 노드) 가정이 성립한다(span이 남는 SET-while-focused에서는 호출되지 않는다).
// 줄이 비어 텍스트 노드가 없으면 줄 시작으로 폴백.
function focusCaretAt(root, lineIndex, col) {
  if (!root) return;
  root.focus();
  const lineEls = root.querySelectorAll('.yh-editor__line');
  if (!lineEls.length) return;
  const idx = Math.max(0, Math.min(lineIndex, lineEls.length - 1));
  const sel = (typeof window !== 'undefined' && window.getSelection) ? window.getSelection() : null;
  if (!sel || typeof document === 'undefined' || !document.createRange) return;
  const range = document.createRange();
  const tn = lineEls[idx].firstChild;
  if (tn && tn.nodeType === 3) {
    range.setStart(tn, Math.max(0, Math.min(col, tn.length)));
  } else {
    range.selectNodeContents(lineEls[idx]); // 빈 줄 폴백 — 줄 시작
  }
  range.collapse(true);
  sel.removeAllRanges();
  sel.addRange(range);
}

// readOnly: 완전 읽기전용(텍스트 비편집 + 임베드 × 버튼 숨김 — 상세보기 등).
// textEditable: 본문 텍스트 편집 가능 여부. false면 본문 텍스트 타이핑이 body에 반영되지 않는다.
//   단 임베드 × 삭제 버튼은 그대로 노출된다(매핑 모드 — 텍스트 비편집 + 임베드 추가/삭제 허용).
//   ※ "임베드 × 버튼 노출"과 "텍스트 contentEditable"을 같은 불리언에 묶지 않는다(매핑의 핵심 차이).
export function Editor({
  blocks = [],
  onRemoveEmbed,
  onKeyDown,
  onTextChange,
  onPasteImageFile,
  onDropImageFile, // 이미지 파일 드롭 위임 — (file, caret). 없으면 드롭은 차단만 된다(환경설정 off).
  onCaretChange,
  pendingCaretLine = null,
  spellcheck = false,
  spellHighlights = [], // [{ start, end }] — blocksToText 절대 오프셋 span 목록(맞춤법 하이라이트 표시 대상)
  spellHighlightStyle = 'bold', // 'bold' | 'underline' — 오류 표현(news.md 맞춤법 설정). 둘 다 표시 전용(콜백 미유발)
  lang = 'ko', // 편집 div lang 속성(표시 전용 — spellcheck prop 동형, 네이티브 사전 언어 힌트). 유효 코드는 부모가 보장.
  readOnly = false,
  textEditable = true,
}) {
  // 본문 텍스트 편집 차단 — readOnly(완전 잠금)이거나 textEditable=false(매핑)면 텍스트 입력을 body에 반영하지 않는다.
  const textLocked = readOnly || !textEditable;

  // IME 조합 상태 — 조합 중에는 본문 동기화/재색칠을 미룬다(news.md 168행).
  const composingRef = useRef(false);

  // ── 타이핑 중 재렌더 방지(캐럿 안정 + 크래시 방지) ──────────────────────────
  // snapRef: 실제로 DOM에 그려진 블록(렌더 소스). 타이핑 echo로는 갱신하지 않는다.
  // lastEmittedRef: 마지막으로 onTextChange로 내보낸 본문 텍스트(= DOM의 현재 텍스트). echo 판별 기준.
  // lastAlignRef: 마지막으로 emit/렌더된 정렬 서명(= DOM의 현재 정렬). 정렬-only 변경 판별 기준 — 텍스트의
  //   lastEmittedRef와 동형이다. snapRef(스냅샷)와 비교하면 줄 수가 바뀌는 echo(빈줄→입력·브라우저 줄병합)에서
  //   서명 길이가 어긋나 헛remount가 나므로, 반드시 "마지막 emit 기준"으로 비교한다.
  // forceRecolorRef: blur 시 한 번 재색칠을 강제하는 플래그.
  // renderTick: 구조 변경 시 증가 → 편집 div의 key가 바뀌어 깨끗이 remount(브라우저가 바꾼 DOM과의 diff 회피).
  const snapRef = useRef(blocks);
  const lastEmittedRef = useRef(blocksToText(blocks));
  const lastAlignRef = useRef(alignSig(blocks));
  const forceRecolorRef = useRef(false);
  // highlightSnapRef: 실제로 DOM에 그려진 맞춤법 하이라이트 스냅샷({ map: 줄 인덱스→세그먼트, style }) 또는 null.
  // 렌더는 이 ref만 읽는다 — spellHighlights prop을 직접 읽으면 타이핑 중 부모 재렌더가 편집 div 자식(span)을
  // 브라우저 변형 DOM과 child-diff해 removeChild 크래시/캐럿 소실(파일 상단 CRITICAL). 하이라이트가 없으면 null
  // → 렌더는 순수 텍스트 노드 폴백(오늘과 동일 DOM — 기존 캐럿/echo/IME 불변식 보존, 회귀 표면 0).
  // 계산은 최초 마운트 1회 + structural remount 시에만(렌더/타이핑마다 buildLineHighlights 재계산 금지).
  const highlightSnapRef = useRef(undefined);
  if (highlightSnapRef.current === undefined) {
    highlightSnapRef.current = (spellHighlights && spellHighlights.length)
      ? { map: buildLineHighlights(blocksToText(blocks), spellHighlights), style: spellHighlightStyle }
      : null;
  }
  // lastHighlightSigRef: 마지막으로 렌더된 하이라이트 서명 — 하이라이트 변화 판정 전용.
  // 하이라이트 유무/내용은 lastEmittedRef(텍스트)·embedSig·alignSig에 절대 영향 주지 않는다.
  const lastHighlightSigRef = useRef(highlightSig(spellHighlights, spellHighlightStyle));
  // rootRef: 편집 div DOM 참조(remount 후 포커스/캐럿 복원용). refocusRef: 복원 대상 { lineIndex } 또는 null.
  const rootRef = useRef(null);
  const refocusRef = useRef(null);
  // nextCaretLineRef: Enter 분할/여러 줄 붙여넣기가 "remount 후 캐럿을 둘 텍스트-라인 인덱스"를 미리 지정한다(없으면 현재 캐럿 유지).
  const nextCaretLineRef = useRef(null);
  const [renderTick, setRenderTick] = useState(0);

  // blocks(prop)/하이라이트가 바뀌면 "타이핑 echo"인지 "외부/구조 변경"인지 판정한다.
  // echo(텍스트·임베드·정렬·하이라이트 동일)면 무시(편집 div를 다시 그리지 않음 → 캐럿 보존). 그 외엔 snapshot 갱신 + remount.
  // 하이라이트 변화도 remount로만 반영한다(bare prop 재조정 금지 — 브라우저 변형 DOM과의 child-diff 회피).
  useEffect(() => {
    const incomingText = blocksToText(blocks);
    const textChanged = incomingText !== lastEmittedRef.current;
    const embedChanged = embedSig(blocks) !== embedSig(snapRef.current);
    const alignChanged = alignSig(blocks) !== lastAlignRef.current;
    const hlSig = highlightSig(spellHighlights, spellHighlightStyle);
    const hlChanged = hlSig !== lastHighlightSigRef.current;
    const structural = forceRecolorRef.current || textChanged || embedChanged || alignChanged || hlChanged;
    if (!structural) { nextCaretLineRef.current = null; return; }
    // remount(아래 setRenderTick)로 편집 div가 새로 그려지면 포커스/캐럿이 빠진다.
    // Enter 분할/여러 줄 붙여넣기는 새 줄 위치를 nextCaretLineRef로 명시한다(이 경로는 항상 편집 중).
    // 그 외 구조 변경은 직전 편집 중(에디터 포커스 보유)이었다면 현재 캐럿 라인을 복원 대상으로 기록한다.
    // 포커스가 에디터 밖(blur 재색칠·외부 로드·검색 임베드 삽입)이면 복원하지 않는다(포커스 가로채기 금지).
    // 열(col) 복원은 "하이라이트-only 클리어 while focused"에만 한다 — 타이핑-echo 클리어 remount가
    // 줄 시작으로 튀지 않게. 신규 하이라이트가 비지 않는 SET-while-focused는 제외해(hlOnlyClear 조건)
    // focusCaretAt이 항상 "클리어 후 단일 텍스트 노드 줄"에서만 호출되게 한다.
    // 하이라이트 외 structural(Ctrl+D/Enter/로드)은 기존 줄-시작 복원 그대로(계약 불변).
    const hlOnlyClear = hlChanged && !textChanged && !embedChanged && !alignChanged
      && !(spellHighlights && spellHighlights.length);
    const focusedRoot = rootRef.current;
    const wasFocused = !!focusedRoot && typeof document !== 'undefined' && document.activeElement === focusedRoot;
    const override = nextCaretLineRef.current;
    nextCaretLineRef.current = null;
    if (override != null) {
      refocusRef.current = { lineIndex: override };
    } else if (wasFocused && hlOnlyClear) {
      const c = readCaret(focusedRoot); // span-aware — 앞 span 길이 포함 col
      refocusRef.current = c ? { lineIndex: c.lineIndex, col: c.col } : { lineIndex: 0 };
    } else if (wasFocused) {
      const c = readCaret(focusedRoot);
      refocusRef.current = { lineIndex: c ? c.lineIndex : 0 };
    } else {
      refocusRef.current = null;
    }
    snapRef.current = blocks;
    lastEmittedRef.current = incomingText;
    lastAlignRef.current = alignSig(blocks);
    forceRecolorRef.current = false;
    highlightSnapRef.current = (spellHighlights && spellHighlights.length)
      ? { map: buildLineHighlights(incomingText, spellHighlights), style: spellHighlightStyle }
      : null;
    lastHighlightSigRef.current = hlSig;
    setRenderTick((t) => t + 1);
  }, [blocks, spellHighlights, spellHighlightStyle]);

  // remount(renderTick 증가)/지정 줄 포커스(pendingCaretLine) 복원 — 단일 경로.
  // ① pendingCaretLine: Step 3에서 body 변경(remount)과 같은 렌더에 함께 온다. number면 wasFocused 복원보다
  //    먼저/우선 그 줄에 focus+caret을 둔다(이전 포커스 여부 무관). renderTick(remount)마다 새 DOM에 다시 적용된다.
  //    textLocked(읽기전용/매핑)면 무시한다.
  // ② refocusRef(wasFocused): 직전 편집 중이었다면 편집 div에 포커스/캐럿을 복원한다.
  //    없으면 Ctrl+D 라인 삭제 시 remount로 포커스가 빠져, 다음 Ctrl+D가 브라우저 기본동작(북마크)으로 샌다.
  //    col이 있으면(하이라이트-only 클리어, 39-1) 줄 시작이 아니라 그 열에 복원한다 — 그 외엔 기존 줄-시작 그대로.
  useLayoutEffect(() => {
    const target = refocusRef.current;
    refocusRef.current = null; // 항상 소비(원본 동작)
    const root = rootRef.current;
    if (!root || textLocked) return; // 읽기전용/매핑은 포커스 가로채지 않음
    if (typeof pendingCaretLine === 'number') {
      focusLineStart(root, pendingCaretLine); // 지정 줄 우선(wasFocused 복원보다 먼저)
      return;
    }
    if (!target) return;
    if (target.col != null) {
      focusCaretAt(root, target.lineIndex, target.col); // 하이라이트-only 클리어 — 열-정확 복원(줄 시작 튐 방지)
      return;
    }
    focusLineStart(root, target.lineIndex); // 삭제 위치의 라인 시작에 캐럿 — 연속 Ctrl+D가 자연스럽게 이어진다.
  }, [renderTick, pendingCaretLine, textLocked]);

  // 렌더 소스는 snapRef(고정 스냅샷). 텍스트 라인 역할(색상)도 스냅샷 기준으로 판정한다(임베드 제외).
  const renderBlocks = snapRef.current;
  const lineRoles = classifyLines(blocksToText(renderBlocks).split('\n'));

  // 선택 범위(비-collapsed면 그 범위를 지우고, collapsed면 캐럿 위치에)에 text(개행 가능)를 넣은 블록을 부모로
  // 내보내고, remount 후 캐럿을 둘 줄을 예약한다.
  // lastEmittedRef를 갱신하지 않아(echo가 아니라) 구조 변경으로 판정되고 편집 div가 깨끗이 remount된다 →
  // 브라우저가 <br>/미래핑 노드를 만들지 못해 "1줄 = 1 .yh-editor__line = 1 텍스트 블록" 불변식이 유지된다.
  const emitInsert = (root, text) => {
    const range = readSelectionForInsert(root); // readEditorBlocks와 같은 줄 기준 — dirty DOM에서도 분할 위치 정합
    const cur = readEditorBlocks(root, snapRef.current);
    const { blocks: next, caretLineIndex } = replaceRangeInBlocks(cur, range, text);
    nextCaretLineRef.current = caretLineIndex;
    if (onTextChange) onTextChange(blocksToText(next), next);
  };

  // 캐럿 보고 — 캐럿이 에디터 안에서 이동하는 이벤트에서 현재 텍스트-줄 인덱스를 부모로 알린다(Step 3 검색 삽입 위치).
  // readCaret이 null이면(에디터 밖으로 selection이 빠짐) 보고하지 않는다 → 부모의 lastCaret을 지우지 않는다.
  // 이벤트 핸들러/effect에서만 호출한다(렌더 본문 동기 호출 금지 — 무한 렌더 방지).
  const reportCaret = (root) => {
    if (!onCaretChange) return;
    const caret = readCaret(root);
    if (!caret) return;
    onCaretChange({ lineIndex: caret.lineIndex, offset: caret.offset });
  };
  const handleCaretEvent = (e) => reportCaret(e.currentTarget);

  // 키다운 — 부모(WriterPage: Alt+Y/Ctrl+D/라인삭제)를 먼저 처리하고, 그 다음 Enter(줄 분할)·"(끝)" 뒤 삽입 차단.
  const handleKeyDown = (e) => {
    if (onKeyDown) onKeyDown(e);
    if (e.defaultPrevented) return;
    // Enter — 브라우저 기본 줄바꿈(<br>/미래핑 div) 대신 블록 모델로 분할한다(개행 합쳐짐 버그 방지).
    // "(끝)" 뒤면 차단만 하고 삽입하지 않는다. 매핑/읽기전용(textLocked)·조합 중에는 개입하지 않는다.
    if (e.key === 'Enter' && !textLocked && onTextChange && !composingRef.current) {
      e.preventDefault();
      if (!caretBlocked(e.currentTarget)) emitInsert(e.currentTarget, '\n');
      return;
    }
    if (isInsertionKey(e) && caretBlocked(e.currentTarget)) e.preventDefault();
  };

  // 붙여넣기 — ① 클립보드에 이미지 item이 있으면 "(끝)" 캐럿 차단보다 먼저 raw File을 상위로 위임한다
  //   (preventDefault + 동기 캐럿 스냅샷 + onPasteImageFile(file, caret)). 마커 차단은 텍스트 삽입 규칙
  //   (news.md 162행 — "(끝)"이 최종 텍스트여야 함)이고, 임베드는 insertEmbedAfterLine이 "(끝)"을 항상 최종
  //   블록으로 재정규화하므로 문서 끝(마커 줄)에서 붙여넣어도 무결성이 깨지지 않는다(끝에서 무피드백 차단되던 결함 수정).
  //   여기서 base64(data URL)를 절대 만들지 않는다 — 업로드→경로 임베드 오케스트레이션은 WriterPage가
  //   model.uploadFile로 수행한다(ADR-003).
  //   ② 텍스트는 "(끝)" 뒤면 차단. ③ 그 외(일반 텍스트)는 기본 붙여넣기 동작을 유지한다(preventDefault 안 함·핸들러 미호출).
  // 이미지는 텍스트를 직렬화하지 않고 캐럿 위치에만 임베드로 들어간다(news.md 156행) — 캐럿은 위임(이후 비동기
  // 업로드) 전에 동기로 확보한다(이후 selection이 소실될 수 있으므로).
  const handlePaste = (e) => {
    const data = e.clipboardData;
    const items = data && data.items;
    // ① 클립보드 이미지 → raw File 위임(캐럿 위치). 핸들러가 없으면 이미지 붙여넣기 비활성(base64 미생성).
    const imageItem = items && onPasteImageFile
      && Array.from(items).find((it) => it && typeof it.type === 'string' && it.type.startsWith('image/'));
    if (imageItem) {
      const file = imageItem.getAsFile && imageItem.getAsFile();
      if (file) {
        e.preventDefault();
        const caret = readCaret(e.currentTarget); // 동기로 캐럿 확보(붙여넣을 위치).
        onPasteImageFile(file, caret);
        return;
      }
    }
    // ② 텍스트 삽입은 "(끝)" 뒤면 차단(마커 무결성 — 삭제/이동/선택은 keydown 쪽 규칙대로 허용).
    if (caretBlocked(e.currentTarget)) { e.preventDefault(); return; }
    // ③ 여러 줄 텍스트(개행 포함) → 캐럿 위치에 텍스트 블록으로 삽입(개행 보존). 한 줄 텍스트는 기본 동작 유지.
    if (!textLocked && onTextChange && data && typeof data.getData === 'function') {
      const text = data.getData('text/plain');
      if (typeof text === 'string' && text.includes('\n')) {
        e.preventDefault();
        emitInsert(e.currentTarget, text);
      }
    }
  };

  // 드래그앤드롭 — 네이티브 드롭은 전면 차단하고 이미지 파일만 상위로 위임한다(53-2 B 결함).
  // 왜 전면 차단인가: 핸들러가 없으면 브라우저가 드롭 지점(마커 줄 안쪽 포함)에 텍스트/DOM을 그대로 떨구고
  //   handleInput이 그것을 본문으로 커밋한다. 마커 줄이 '(끝)단어'가 되면 serializeBodyFromBlocks(trim 정확
  //   비교)는 마커를 놓쳐 재정규화·정렬 제외·치환 가드가 전부 풀리는데, 송고 가드 hasEndMarker는 substring이라
  //   그대로 통과한다 → 오염된 본문이 송고·배부된다(ADR-008: 송고 즉시 스풀 기록 — 되돌릴 수 없다).
  // 왜 이미지만 위임하나: news.md 192행("이미지를 드래그앤 드롭이 허용된다. 기본값은 된다")이 정의하는 유일한
  //   드롭 스펙이고, 위임 계약은 붙여넣기 이미지와 같다(raw File → 상위가 업로드→경로 임베드, ADR-003).
  //   텍스트/HTML 드롭과 드래그 이동(drag-move)은 스펙에 없고 원본 범위 삭제 의미론이 필요해 결선하지 않는다.
  // caretBlocked로 이미지 드롭을 막지 않는 이유는 handlePaste의 이미지 분기와 같다 — 임베드 삽입은
  //   insertEmbedAfterLine이 "(끝)"을 항상 최종 블록으로 재정규화하므로 마커 무결성이 유지된다.
  const handleDragOver = (e) => {
    e.preventDefault(); // drop 이벤트 수신 보장 + 네이티브 삽입 준비(드롭 캐럿) 차단
  };

  // 드래그 이동(drag-move) 원본 삭제 차단 — 드롭 차단만으로는 부족하다.
  // 브라우저의 드래그 이동은 "드롭 수락 → dragend에서 원본 범위 삭제"가 한 쌍이라, 드롭을 preventDefault로
  // 취소해도 최종 drag operation이 'move'로 남으면 UA가 원본 선택을 지운다 → 삽입은 없고 삭제만 남는다(본문 유실).
  // 원본 삭제 여부를 UA 구현에 맡기지 않도록 시작점에서 닫는다: 편집 영역 안에서 시작하는 드래그(텍스트 선택·
  // 임베드 이미지)를 dragstart에서 열지 않는다. 외부(OS·다른 앱)에서 끌어온 이미지 파일 드롭은 dragstart가
  // 여기서 나지 않으므로 영향받지 않는다(news.md 192행 스펙 유지).
  // 잔여(미차단): selection이 편집 영역 "밖"에서 시작해 안까지 걸치면 dragstart가 바깥 노드에서 나 여기에
  //   도달하지 않는다. 대개 UA가 non-editable source를 copy로 강등해 원본을 지우지 않지만 보장은 아니다.
  const handleDragStart = (e) => {
    e.preventDefault();
  };

  const handleDrop = (e) => {
    e.preventDefault(); // 어떤 데이터든 브라우저가 편집 div에 직접 떨구지 못하게 한다(조건 분기보다 먼저).
    // 최종 drag operation을 'move'가 아닌 값으로 확정한다 — 'move'로 남으면 출처 문서(다른 앱·다른 창)에서
    // 원본이 삭제된다. 우리는 어떤 경우에도 이동을 수행하지 않는다: 받지 않으면 'none', 이미지는 복사 삽입.
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'none';
    if (!onDropImageFile) return; // 드롭 위임 비활성(환경설정 off) — 차단만.
    const file = findImageFile(e.dataTransfer);
    if (!file) return; // 텍스트/HTML 등은 아무것도 하지 않는다(삽입 금지·콜백 없음).
    e.dataTransfer.dropEffect = 'copy';
    const caret = readCaret(e.currentTarget); // 위임 전 동기 확보(이후 비동기 업로드 중 selection 소실 대비)
    onDropImageFile(file, caret);
  };

  const handleCompositionStart = (e) => {
    composingRef.current = true;
    if (caretBlocked(e.currentTarget)) e.preventDefault();
  };

  // 입력 반영 — 조합 중에는 미룬다(텍스트는 contentEditable DOM에 남고 compositionend에서 동기화).
  // 본문을 부모로 내보내되(가드/제목 동기화용), 위 effect가 echo로 판정해 편집 div를 다시 그리지 않는다(캐럿 보존).
  const handleInput = (e) => {
    if (composingRef.current) return;
    const editBlocks = readEditorBlocks(e.currentTarget, snapRef.current);
    const text = blocksToText(editBlocks);
    lastEmittedRef.current = text;
    lastAlignRef.current = alignSig(editBlocks); // DOM에서 되읽은 정렬을 echo 기준으로 갱신(헛remount 방지)
    if (onTextChange) onTextChange(text, editBlocks);
    reportCaret(e.currentTarget); // 타이핑 후 캐럿 위치 갱신(echo 경로라 selection이 보존됨)
  };

  // 조합 완료 → 본문 반영(동기화). 재색칠(remount)은 하지 않는다 — 조합마다 remount하면 캐럿이 튄다(한글 입력).
  const handleCompositionEnd = (e) => {
    composingRef.current = false;
    if (!textLocked && onTextChange) {
      const editBlocks = readEditorBlocks(e.currentTarget, snapRef.current);
      const text = blocksToText(editBlocks);
      lastEmittedRef.current = text;
      lastAlignRef.current = alignSig(editBlocks); // 조합 완료 emit도 정렬 echo 기준 갱신(handleInput과 동형)
      onTextChange(text, editBlocks);
    }
  };

  // 포커스 이탈 시 재색칠(news.md: 색 적용은 조합 완료/포커스 이탈/로드 시점). 조합 중 blur면 재색칠하지 않는다.
  // blur는 편집이 멈춘 시점이라 remount(재색칠)해도 캐럿 튐이 보이지 않는다 → forceRecolor로 한 번 강제.
  const handleBlur = (e) => {
    // blur 계약: 캐럿이 에디터 안이면(readCaret 비-null) 마지막 캐럿을 보고, 밖이면(null) 보고하지 않는다(부모 lastCaret 유지).
    reportCaret(e.currentTarget);
    if (!textLocked && onTextChange && shouldRecolor('blur', { composing: composingRef.current })) {
      forceRecolorRef.current = true;
      const editBlocks = readEditorBlocks(e.currentTarget, snapRef.current);
      onTextChange(blocksToText(editBlocks), editBlocks);
    }
  };

  let textLine = -1; // 텍스트 블록을 만날 때마다 증가시켜 lineRoles와 매핑.

  return (
    <div
      key={renderTick}
      ref={rootRef}
      className="yh-editor"
      role="textbox"
      aria-label="본문"
      aria-multiline="true"
      contentEditable={!textLocked}
      suppressContentEditableWarning
      spellCheck={spellcheck}
      lang={lang}
      onKeyDown={handleKeyDown}
      onPaste={handlePaste}
      onDragStart={handleDragStart}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
      onCompositionStart={handleCompositionStart}
      onCompositionEnd={handleCompositionEnd}
      onBlur={handleBlur}
      onKeyUp={onCaretChange ? handleCaretEvent : undefined}
      onMouseUp={onCaretChange ? handleCaretEvent : undefined}
      onSelect={onCaretChange ? handleCaretEvent : undefined}
      onInput={(!textLocked && onTextChange) ? handleInput : undefined}
    >
      {renderBlocks.map((block, i) => {
        if (isEmbedBlock(block)) {
          return (
            <InlineEmbed
              key={`embed-${i}`}
              blockIndex={i}
              embed={block}
              readOnly={readOnly}
              onRemove={() => onRemoveEmbed && onRemoveEmbed(i)}
            />
          );
        }
        if (isTextBlock(block)) {
          textLine += 1;
          const role = lineRoles[textLine];
          // 화이트리스트를 통과한 정렬만 렌더에 쓴다(step3와 방어 깊이 통일). 미정렬/무효면 속성·스타일 생략
          // → data-align={undefined}는 속성이 안 붙어 현행 DOM과 동일(회귀 안전).
          const align = isValidAlign(block.align) ? block.align : undefined;
          // 맞춤법 하이라이트(39-1): 세그먼트는 highlightSnapRef 스냅샷에서만 읽는다(prop 직접 읽기 금지 —
          // 파일 상단 CRITICAL). hl 세그먼트가 없는 줄은 {block.text} 순수 텍스트 노드 폴백(오늘과 동일 DOM).
          // 비-hl 세그먼트는 bare 문자열(텍스트 노드), hl 세그먼트만 span. span은 색 미지정(줄 role 색 상속).
          const hl = highlightSnapRef.current;
          const segs = hl ? hl.map[textLine] : null;
          const hlStyle = (hl && hl.style === 'underline') ? 'underline' : 'bold';
          return (
            <div
              key={`text-${i}`}
              className="yh-editor__line"
              data-role={role}
              data-align={align}
              style={{ color: colorForRole(role), ...(align ? { textAlign: align } : null) }}
            >
              {(segs && segs.length && segs.some((s) => s.hl))
                ? segs.map((seg, k) => (seg.hl
                  ? (
                    <span key={k} className={`yh-editor__spell yh-editor__spell--${hlStyle}`} data-testid="spell-hl">
                      {seg.text}
                    </span>
                  )
                  : seg.text))
                : block.text}
            </div>
          );
        }
        return null;
      })}
    </div>
  );
}

export default Editor;
