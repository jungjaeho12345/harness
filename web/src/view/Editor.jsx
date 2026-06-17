// 기사 에디터 컴포넌트 — 본문 블록(텍스트/임베드)을 색상 규칙대로 렌더한다.
// CRITICAL: 본문 영역 위에 '본문' 라벨 텍스트는 표시하지 않는다(접근성 aria-label은 유지 — news.md).
// 색: 제목 파랑/부제 빨강/본문 검정/"(끝)" 골드(editorColoring). transport 비의존 — 변경은 콜백(onRemoveEmbed/onKeyDown)으로만.
// 키 입력 결선(step15): "(끝)" 뒤 삽입 차단(isInputBlocked)·IME 조합 중 재색칠 금지(shouldRecolor) — news.md 162·168행.
//
// CRITICAL(타이핑 안정성): contentEditable을 매 입력마다 state로 재렌더하면 브라우저 캐럿이 초기화되어
// "맘대로 써지고", 브라우저가 직접 바꾼 DOM을 React가 재조정하다 removeChild로 크래시(화면 하얘짐)한다.
// → 타이핑 중에는 React가 편집 영역을 다시 그리지 않는다(내부 snapshot 고정). 외부/구조 변경(로드·Ctrl+D·
//   임베드 추가/삭제·Alt+Y·포커스 이탈 재색칠)일 때만 snapshot을 갱신하고 편집 div를 깨끗이 remount한다.

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { blocksToText, isEmbedBlock, isTextBlock, textBlock } from './editorContent.js';
import { classifyLines, colorForRole, shouldRecolor } from './editorColoring.js';
import { isInputBlocked, insertTextIntoBlocks } from './editorNewline.js';
import { embedFromPaste } from './clipboardEmbed.js';
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
      for (const line of elementToLines(el)) out.push(textBlock(line));
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

// 현재 selection 캐럿을 { lineIndex, offset }으로 읽는다 — lineIndex는 라인 div(=텍스트 블록) 순서,
// offset은 readEditorText(=blocksToText) 기준 텍스트 오프셋. selection이 없거나 에디터 밖이면 null(차단/삭제 판정에서 허용 기본값).
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
  const offsetInLine = node.nodeType === 3 ? sel.anchorOffset : 0;
  let offset = 0;
  for (let i = 0; i < lineIndex; i += 1) offset += (lineEls[i].textContent ?? '').length + 1; // +1 개행
  return { lineIndex, offset: offset + offsetInLine };
}

// 캐럿이 "(끝)" 마커 시작 이상이면 삽입 차단 대상(news.md 162행). 캐럿 미상이면 차단하지 않는다.
function caretBlocked(root) {
  const caret = readCaret(root);
  return !!caret && isInputBlocked(readEditorText(root), caret.offset);
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

// readOnly: 완전 읽기전용(텍스트 비편집 + 임베드 × 버튼 숨김 — 상세보기 등).
// textEditable: 본문 텍스트 편집 가능 여부. false면 본문 텍스트 타이핑이 body에 반영되지 않는다.
//   단 임베드 × 삭제 버튼은 그대로 노출된다(매핑 모드 — 텍스트 비편집 + 임베드 추가/삭제 허용).
//   ※ "임베드 × 버튼 노출"과 "텍스트 contentEditable"을 같은 불리언에 묶지 않는다(매핑의 핵심 차이).
export function Editor({
  blocks = [],
  onRemoveEmbed,
  onKeyDown,
  onTextChange,
  onPasteEmbed,
  onCaretChange,
  pendingCaretLine = null,
  spellcheck = false,
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
  // forceRecolorRef: blur 시 한 번 재색칠을 강제하는 플래그.
  // renderTick: 구조 변경 시 증가 → 편집 div의 key가 바뀌어 깨끗이 remount(브라우저가 바꾼 DOM과의 diff 회피).
  const snapRef = useRef(blocks);
  const lastEmittedRef = useRef(blocksToText(blocks));
  const forceRecolorRef = useRef(false);
  // rootRef: 편집 div DOM 참조(remount 후 포커스/캐럿 복원용). refocusRef: 복원 대상 { lineIndex } 또는 null.
  const rootRef = useRef(null);
  const refocusRef = useRef(null);
  // nextCaretLineRef: Enter 분할/여러 줄 붙여넣기가 "remount 후 캐럿을 둘 텍스트-라인 인덱스"를 미리 지정한다(없으면 현재 캐럿 유지).
  const nextCaretLineRef = useRef(null);
  const [renderTick, setRenderTick] = useState(0);

  // blocks(prop)가 바뀌면 "타이핑 echo"인지 "외부/구조 변경"인지 판정한다.
  // echo(텍스트·임베드 동일)면 무시(편집 div를 다시 그리지 않음 → 캐럿 보존). 그 외엔 snapshot 갱신 + remount.
  useEffect(() => {
    const incomingText = blocksToText(blocks);
    const structural = forceRecolorRef.current
      || incomingText !== lastEmittedRef.current
      || embedSig(blocks) !== embedSig(snapRef.current);
    if (!structural) { nextCaretLineRef.current = null; return; }
    // remount(아래 setRenderTick)로 편집 div가 새로 그려지면 포커스/캐럿이 빠진다.
    // Enter 분할/여러 줄 붙여넣기는 새 줄 위치를 nextCaretLineRef로 명시한다(이 경로는 항상 편집 중).
    // 그 외 구조 변경은 직전 편집 중(에디터 포커스 보유)이었다면 현재 캐럿 라인을 복원 대상으로 기록한다.
    // 포커스가 에디터 밖(blur 재색칠·외부 로드·검색 임베드 삽입)이면 복원하지 않는다(포커스 가로채기 금지).
    const focusedRoot = rootRef.current;
    const wasFocused = !!focusedRoot && typeof document !== 'undefined' && document.activeElement === focusedRoot;
    const override = nextCaretLineRef.current;
    nextCaretLineRef.current = null;
    if (override != null) {
      refocusRef.current = { lineIndex: override };
    } else {
      const caretNow = wasFocused ? readCaret(focusedRoot) : null;
      refocusRef.current = wasFocused ? { lineIndex: caretNow ? caretNow.lineIndex : 0 } : null;
    }
    snapRef.current = blocks;
    lastEmittedRef.current = incomingText;
    forceRecolorRef.current = false;
    setRenderTick((t) => t + 1);
  }, [blocks]);

  // remount(renderTick 증가)/지정 줄 포커스(pendingCaretLine) 복원 — 단일 경로.
  // ① pendingCaretLine: Step 3에서 body 변경(remount)과 같은 렌더에 함께 온다. number면 wasFocused 복원보다
  //    먼저/우선 그 줄에 focus+caret을 둔다(이전 포커스 여부 무관). renderTick(remount)마다 새 DOM에 다시 적용된다.
  //    textLocked(읽기전용/매핑)면 무시한다.
  // ② refocusRef(wasFocused): 직전 편집 중이었다면 편집 div에 포커스/캐럿을 복원한다.
  //    없으면 Ctrl+D 라인 삭제 시 remount로 포커스가 빠져, 다음 Ctrl+D가 브라우저 기본동작(북마크)으로 샌다.
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
    focusLineStart(root, target.lineIndex); // 삭제 위치의 라인 시작에 캐럿 — 연속 Ctrl+D가 자연스럽게 이어진다.
  }, [renderTick, pendingCaretLine, textLocked]);

  // 렌더 소스는 snapRef(고정 스냅샷). 텍스트 라인 역할(색상)도 스냅샷 기준으로 판정한다(임베드 제외).
  const renderBlocks = snapRef.current;
  const lineRoles = classifyLines(blocksToText(renderBlocks).split('\n'));

  // 캐럿 위치에 text(개행 가능)를 삽입한 블록을 부모로 내보내고, remount 후 캐럿을 둘 줄을 예약한다.
  // lastEmittedRef를 갱신하지 않아(echo가 아니라) 구조 변경으로 판정되고 편집 div가 깨끗이 remount된다 →
  // 브라우저가 <br>/미래핑 노드를 만들지 못해 "1줄 = 1 .yh-editor__line = 1 텍스트 블록" 불변식이 유지된다.
  const emitInsert = (root, text) => {
    const caret = readCaret(root);
    const cur = readEditorBlocks(root, snapRef.current);
    const { blocks: next, caretLineIndex } = insertTextIntoBlocks(cur, caret, text);
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
    onCaretChange({ lineIndex: caret.lineIndex });
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

  // 붙여넣기 — ① "(끝)" 뒤면 차단(텍스트·이미지 공통). ② 클립보드에 이미지 item이 있으면 임베드로 변환
  //   (preventDefault + FileReader로 data:image URL을 읽어 onPasteEmbed에 전달). ③ 그 외(일반 텍스트)는
  //   기본 붙여넣기 동작을 유지한다(preventDefault 안 함·onPasteEmbed 미호출).
  // 이미지는 텍스트를 직렬화하지 않고 캐럿 위치에만 임베드로 들어간다(news.md 156행) — 캐럿은 비동기 FileReader
  // 전에 동기로 확보한다(이후 selection이 소실될 수 있으므로).
  const handlePaste = (e) => {
    if (caretBlocked(e.currentTarget)) { e.preventDefault(); return; }
    const data = e.clipboardData;
    const items = data && data.items;
    // ① 클립보드 이미지 → 임베드(캐럿 위치). 텍스트는 직렬화하지 않는다(news.md 156행).
    const imageItem = items && onPasteEmbed
      && Array.from(items).find((it) => it && typeof it.type === 'string' && it.type.startsWith('image/'));
    if (imageItem) {
      const file = imageItem.getAsFile && imageItem.getAsFile();
      if (file) {
        e.preventDefault();
        const caret = readCaret(e.currentTarget); // 동기로 캐럿 확보(붙여넣을 위치).
        const reader = new FileReader();
        reader.onload = () => {
          // InlineEmbed가 200×200으로 캡하므로 여기서 크기는 지정하지 않는다(embedFromPaste 기본).
          onPasteEmbed(embedFromPaste({ imageDataUrl: reader.result }), caret);
        };
        reader.readAsDataURL(file);
        return;
      }
    }
    // ② 여러 줄 텍스트(개행 포함) → 캐럿 위치에 텍스트 블록으로 삽입(개행 보존). 한 줄 텍스트는 기본 동작 유지.
    if (!textLocked && onTextChange && data && typeof data.getData === 'function') {
      const text = data.getData('text/plain');
      if (typeof text === 'string' && text.includes('\n')) {
        e.preventDefault();
        emitInsert(e.currentTarget, text);
      }
    }
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
      lang="ko"
      onKeyDown={handleKeyDown}
      onPaste={handlePaste}
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
          return (
            <div
              key={`text-${i}`}
              className="yh-editor__line"
              data-role={role}
              style={{ color: colorForRole(role) }}
            >
              {block.text}
            </div>
          );
        }
        return null;
      })}
    </div>
  );
}

export default Editor;
