// 기사 에디터 컴포넌트 — 본문 블록(텍스트/임베드)을 색상 규칙대로 렌더한다.
// CRITICAL: 본문 영역 위에 '본문' 라벨 텍스트는 표시하지 않는다(접근성 aria-label은 유지 — news.md).
// 색: 제목 파랑/부제 빨강/본문 검정/"(끝)" 골드(editorColoring). transport 비의존 — 변경은 콜백(onRemoveEmbed/onKeyDown)으로만.

import { blocksToText, isEmbedBlock, isTextBlock } from './editorContent.js';
import { classifyLines, colorForRole } from './editorColoring.js';
import { InlineEmbed } from './InlineEmbed.jsx';

// contentEditable에서 입력된 본문 텍스트를 라인 div 기준으로 재구성한다(임베드 figure는 제외).
// jsdom·브라우저 모두에서 안정적으로 개행을 보존한다(textContent는 블록 간 개행을 넣지 않으므로).
function readEditorText(root) {
  if (!root) return '';
  const lines = root.querySelectorAll('.yh-editor__line');
  if (!lines.length) return root.textContent ?? '';
  return Array.from(lines).map((el) => el.textContent ?? '').join('\n');
}

export function Editor({
  blocks = [],
  onRemoveEmbed,
  onKeyDown,
  onTextChange,
  spellcheck = false,
  readOnly = false,
}) {
  // 텍스트 라인 역할(색상)은 텍스트 블록 전체 기준으로 판정한다(임베드 제외 — editorColoring).
  const lineRoles = classifyLines(blocksToText(blocks).split('\n'));

  let textLine = -1; // 텍스트 블록을 만날 때마다 증가시켜 lineRoles와 매핑.

  return (
    <div
      className="yh-editor"
      role="textbox"
      aria-label="본문"
      aria-multiline="true"
      contentEditable={!readOnly}
      suppressContentEditableWarning
      spellCheck={spellcheck}
      lang="ko"
      onKeyDown={onKeyDown}
      onInput={onTextChange ? (e) => onTextChange(readEditorText(e.currentTarget)) : undefined}
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
