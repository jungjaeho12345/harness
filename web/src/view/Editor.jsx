// 기사 에디터 컴포넌트 — 본문 블록(텍스트/임베드)을 색상 규칙대로 렌더한다.
// CRITICAL: 본문 영역 위에 '본문' 라벨 텍스트는 표시하지 않는다(접근성 aria-label은 유지 — news.md).
// 색: 제목 파랑/부제 빨강/본문 검정/"(끝)" 골드(editorColoring). transport 비의존 — 변경은 콜백(onRemoveEmbed/onKeyDown)으로만.
// 키 입력 결선(step15): "(끝)" 뒤 삽입 차단(isInputBlocked)·IME 조합 중 재색칠 금지(shouldRecolor) — news.md 162·168행.

import { useRef } from 'react';
import { blocksToText, isEmbedBlock, isTextBlock } from './editorContent.js';
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
  // 텍스트 라인 역할(색상)은 텍스트 블록 전체 기준으로 판정한다(임베드 제외 — editorColoring).
  const lineRoles = classifyLines(blocksToText(blocks).split('\n'));

  // IME 조합 상태 — 조합 중에는 본문 동기화/재색칠을 미룬다(news.md 168행).
  const composingRef = useRef(false);

  // 키다운 — 부모(WriterPage: Alt+Y/Ctrl+D/라인삭제)를 먼저 처리하고, 처리되지 않은 삽입성 키만 "(끝)" 뒤에서 차단.
  const handleKeyDown = (e) => {
    if (onKeyDown) onKeyDown(e);
    if (e.defaultPrevented) return;
    if (isInsertionKey(e) && caretBlocked(e.currentTarget)) e.preventDefault();
  };

  // 붙여넣기 — ① "(끝)" 뒤면 차단(텍스트·이미지 공통). ② 클립보드에 이미지 item이 있으면 임베드로 변환
  //   (preventDefault + FileReader로 data:image URL을 읽어 onPasteEmbed에 전달). ③ 그 외(일반 텍스트)는
  //   기본 붙여넣기 동작을 유지한다(preventDefault 안 함·onPasteEmbed 미호출).
  const handlePaste = (e) => {
    if (caretBlocked(e.currentTarget)) { e.preventDefault(); return; }
    const items = e.clipboardData && e.clipboardData.items;
    if (!items || !onPasteEmbed) return;
    const imageItem = Array.from(items).find((it) => it && typeof it.type === 'string' && it.type.startsWith('image/'));
    if (!imageItem) return; // 일반 텍스트 — 기본 동작 유지.
    const file = imageItem.getAsFile && imageItem.getAsFile();
    if (!file) return;
    e.preventDefault();
    const reader = new FileReader();
    reader.onload = () => {
      // InlineEmbed가 200×200으로 캡하므로 여기서 크기는 지정하지 않는다(embedFromPaste 기본).
      onPasteEmbed(embedFromPaste({ imageDataUrl: reader.result }));
    };
    reader.readAsDataURL(file);
  };

  const handleCompositionStart = (e) => {
    composingRef.current = true;
    if (caretBlocked(e.currentTarget)) e.preventDefault();
  };

  // 입력 반영 — 조합 중에는 미룬다(텍스트는 contentEditable DOM에 남고 compositionend에서 동기화·재색칠).
  const handleInput = (e) => {
    if (composingRef.current) return;
    if (onTextChange) onTextChange(readEditorText(e.currentTarget));
  };

  // 조합 완료 → 본문 반영 + 재색칠(re-render). shouldRecolor로 게이트(RECOLOR_TRIGGERS: compositionend).
  const handleCompositionEnd = (e) => {
    composingRef.current = false;
    if (!textLocked && onTextChange && shouldRecolor('compositionend', { composing: composingRef.current })) {
      onTextChange(readEditorText(e.currentTarget));
    }
  };

  // 포커스 이탈 시 재색칠(news.md: 색 적용은 조합 완료/포커스 이탈/로드 시점). 조합 중 blur면 재색칠하지 않는다.
  const handleBlur = (e) => {
    if (!textLocked && onTextChange && shouldRecolor('blur', { composing: composingRef.current })) {
      onTextChange(readEditorText(e.currentTarget));
    }
  };

  let textLine = -1; // 텍스트 블록을 만날 때마다 증가시켜 lineRoles와 매핑.

  return (
    <div
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
      {blocks.map((block, i) => {
        if (isEmbedBlock(block)) {
          return (
            <InlineEmbed
              key={`embed-${i}`}
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
