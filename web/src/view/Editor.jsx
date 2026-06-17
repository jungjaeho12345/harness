// 기사 에디터 컴포넌트 — 본문 블록(텍스트/임베드)을 색상 규칙대로 렌더한다.
// CRITICAL: 본문 영역 위에 '본문' 라벨 텍스트는 표시하지 않는다(접근성 aria-label은 유지 — news.md).
// 색: 제목 파랑/부제 빨강/본문 검정/"(끝)" 골드(editorColoring). transport 비의존 — 변경은 콜백(onRemoveEmbed/onKeyDown)으로만.
// 키 입력 결선(step15): "(끝)" 뒤 삽입 차단(isInputBlocked)·IME 조합 중 재색칠 금지(shouldRecolor) — news.md 162·168행.
//
// CRITICAL(타이핑 안정성): contentEditable을 매 입력마다 state로 재렌더하면 브라우저 캐럿이 초기화되어
// "맘대로 써지고", 브라우저가 직접 바꾼 DOM을 React가 재조정하다 removeChild로 크래시(화면 하얘짐)한다.
// → 타이핑 중에는 React가 편집 영역을 다시 그리지 않는다(내부 snapshot 고정). 외부/구조 변경(로드·Ctrl+D·
//   임베드 추가/삭제·Alt+Y·포커스 이탈 재색칠)일 때만 snapshot을 갱신하고 편집 div를 깨끗이 remount한다.

import { useEffect, useRef, useState } from 'react';
import { blocksToText, isEmbedBlock, isTextBlock, textBlock } from './editorContent.js';
import { classifyLines, colorForRole, shouldRecolor } from './editorColoring.js';
import { isInputBlocked } from './editorNewline.js';
import { embedFromPaste } from './clipboardEmbed.js';
import { InlineEmbed } from './InlineEmbed.jsx';

// contentEditable에서 입력된 본문 텍스트를 라인 div 기준으로 재구성한다(임베드 figure는 제외).
// jsdom·브라우저 모두에서 안정적으로 개행을 보존한다(textContent는 블록 간 개행을 넣지 않으므로).
function readEditorText(root) {
  if (!root) return '';
  const lineEls = root.querySelectorAll('.yh-editor__line');
  if (!lineEls.length) return root.textContent ?? '';
  return Array.from(lineEls).map((el) => el.textContent ?? '').join('\n');
}

// 라인 div(텍스트)와 임베드 figure를 DOM 순서대로 읽어 블록 배열로 재구성한다(텍스트 + 임베드 인터리브).
// 임베드 데이터는 figure DOM에 없으므로 스냅샷(snapshotBlocks)에서 가져온다. figure의 data-embed-key(snapshot 블록
// 인덱스)로 '안정적 매칭'을 하고, 키가 없을 때만 등장 순서로 폴백한다 — 인라인 삭제 등으로 임베드 개수가 어긋나도
// 살아남은 임베드 데이터가 뒤바뀌지 않는다.
// → 커서 위치에 넣은 임베드의 위치가 이후 타이핑/포커스 이탈 후에도 보존된다(news.md 156·167행).
function readEditorBlocks(root, snapshotBlocks) {
  if (!root) return [];
  const snap = Array.isArray(snapshotBlocks) ? snapshotBlocks : [];
  const snapEmbeds = snap.filter(isEmbedBlock);
  const nodes = root.querySelectorAll('.yh-editor__line, .yh-embed');
  if (!nodes.length) {
    // 라인 div가 아직 없는 초기/빈 편집 영역 — 브라우저가 직접 넣은 텍스트라도 보존.
    const text = root.textContent ?? '';
    return text ? [textBlock(text)] : [];
  }
  const out = [];
  let ei = 0; // data-embed-key가 없는 figure를 위한 등장 순서 폴백 인덱스
  for (const el of nodes) {
    if (el.classList.contains('yh-editor__line')) {
      out.push(textBlock(el.textContent ?? ''));
    } else { // .yh-embed figure
      const rawKey = el.dataset && el.dataset.embedKey;
      const keyed = (rawKey != null && rawKey !== '') ? snap[Number(rawKey)] : undefined;
      if (isEmbedBlock(keyed)) out.push(keyed); // 안정적 키 매칭(인라인 삭제에도 안전)
      else if (ei < snapEmbeds.length) out.push(snapEmbeds[ei]); // 폴백: DOM 등장 순서
      ei += 1;
    }
  }
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
  const [renderTick, setRenderTick] = useState(0);

  // blocks(prop)가 바뀌면 "타이핑 echo"인지 "외부/구조 변경"인지 판정한다.
  // echo(텍스트·임베드 동일)면 무시(편집 div를 다시 그리지 않음 → 캐럿 보존). 그 외엔 snapshot 갱신 + remount.
  useEffect(() => {
    const incomingText = blocksToText(blocks);
    const structural = forceRecolorRef.current
      || incomingText !== lastEmittedRef.current
      || embedSig(blocks) !== embedSig(snapRef.current);
    if (!structural) return;
    snapRef.current = blocks;
    lastEmittedRef.current = incomingText;
    forceRecolorRef.current = false;
    setRenderTick((t) => t + 1);
  }, [blocks]);

  // 렌더 소스는 snapRef(고정 스냅샷). 텍스트 라인 역할(색상)도 스냅샷 기준으로 판정한다(임베드 제외).
  const renderBlocks = snapRef.current;
  const lineRoles = classifyLines(blocksToText(renderBlocks).split('\n'));

  // 키다운 — 부모(WriterPage: Alt+Y/Ctrl+D/라인삭제)를 먼저 처리하고, 처리되지 않은 삽입성 키만 "(끝)" 뒤에서 차단.
  const handleKeyDown = (e) => {
    if (onKeyDown) onKeyDown(e);
    if (e.defaultPrevented) return;
    if (isInsertionKey(e) && caretBlocked(e.currentTarget)) e.preventDefault();
  };

  // 붙여넣기 — ① "(끝)" 뒤면 차단(텍스트·이미지 공통). ② 클립보드에 이미지 item이 있으면 임베드로 변환
  //   (preventDefault + FileReader로 data:image URL을 읽어 onPasteEmbed에 전달). ③ 그 외(일반 텍스트)는
  //   기본 붙여넣기 동작을 유지한다(preventDefault 안 함·onPasteEmbed 미호출).
  // 이미지는 텍스트를 직렬화하지 않고 캐럿 위치에만 임베드로 들어간다(news.md 156행) — 캐럿은 비동기 FileReader
  // 전에 동기로 확보한다(이후 selection이 소실될 수 있으므로).
  const handlePaste = (e) => {
    if (caretBlocked(e.currentTarget)) { e.preventDefault(); return; }
    const items = e.clipboardData && e.clipboardData.items;
    if (!items || !onPasteEmbed) return;
    const imageItem = Array.from(items).find((it) => it && typeof it.type === 'string' && it.type.startsWith('image/'));
    if (!imageItem) return; // 일반 텍스트 — 기본 동작 유지.
    const file = imageItem.getAsFile && imageItem.getAsFile();
    if (!file) return;
    e.preventDefault();
    const caret = readCaret(e.currentTarget); // 동기로 캐럿 확보(붙여넣을 위치).
    const reader = new FileReader();
    reader.onload = () => {
      // InlineEmbed가 200×200으로 캡하므로 여기서 크기는 지정하지 않는다(embedFromPaste 기본).
      onPasteEmbed(embedFromPaste({ imageDataUrl: reader.result }), caret);
    };
    reader.readAsDataURL(file);
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
