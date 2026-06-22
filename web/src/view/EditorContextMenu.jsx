// 에디터 본문 우클릭 컨텍스트 메뉴(news.md L173). 순수 표시 컴포넌트(ADR-003) — transport/model/fetch 없음.
// 항목은 명세 순서대로 전부 노출하되, 활성/비활성은 enabledIds로만 결정한다(EditorMenuBar enabledSet 패턴 그대로).
//   - enabledIds(배열/Set) 미전달 시 빈 집합 → 전 항목 비활성(placeholder).
//   - 활성 항목 클릭 시에만 onSelect(item.id) + onClose() 위임. id는 ctx.* 네임스페이스(라벨 라우팅 금지).
// checkedIds(배열/Set): 보이기 토글 항목의 현재 on/off 표시(aria-checked + ✓). disabled와 무관한 선택 표시.
// 조회페이지 ContextMenu.jsx(yh-context-menu/buildContextMenuItems)와 충돌하지 않게 별도 클래스(yh-editor-context-menu)·
// testid(editor-context-menu)를 쓴다. 위치/닫기는 ListPage 패턴(position.x/y + Esc/마우스 이탈 → onClose)을 따른다.

// 항목 config — news.md L173 순서. {id, label, shortcut?}.
export const EDITOR_CONTEXT_ITEMS = Object.freeze([
  { id: 'ctx.companyCode', label: '기업코드변환', shortcut: 'Ctrl+B' },
  { id: 'ctx.cut', label: '잘라내기', shortcut: 'Ctrl+X' },
  { id: 'ctx.copy', label: '복사', shortcut: 'Ctrl+C' },
  { id: 'ctx.paste', label: '붙여넣기', shortcut: 'Ctrl+V' },
  { id: 'ctx.pasteOriginal', label: '원본 붙여넣기', shortcut: 'Alt+V' },
  { id: 'ctx.pasteText', label: '텍스트 붙여넣기', shortcut: 'Ctrl+V' },
  { id: 'ctx.symbolInput', label: '약물입력', shortcut: 'Alt+O' },
  { id: 'ctx.findReplace', label: '찾기/바꾸기', shortcut: 'Ctrl+F' },
  { id: 'ctx.selectAll', label: '전체 선택', shortcut: 'Ctrl+A' },
  { id: 'ctx.showMenuBar', label: '메뉴바 보이기' },
  { id: 'ctx.showToolBar', label: '툴바 보이기' },
  { id: 'ctx.showGlyphBar', label: '약물바 보이기' },
]);

export function EditorContextMenu({
  position = {}, enabledIds, checkedIds, onSelect, onClose,
}) {
  // 활성/체크 id 집합 — 배열/Set 모두 허용. 미전달(undefined)이면 빈 집합(전 항목 비활성 / 체크 없음).
  const enabledSet = enabledIds instanceof Set ? enabledIds : new Set(enabledIds || []);
  const checkedSet = checkedIds instanceof Set ? checkedIds : new Set(checkedIds || []);

  const style = { position: 'absolute', left: position.x ?? 0, top: position.y ?? 0 };

  // Esc로 닫기 — 메뉴 자체(div)에 onKeyDown을 단다(전역 리스너 없이 단순화, FindReplaceDialog Esc 패턴과 동일).
  const onKeyDown = (e) => { if (e.key === 'Escape' && onClose) onClose(); };

  return (
    <ul
      className="yh-editor-context-menu"
      data-testid="editor-context-menu"
      role="menu"
      style={style}
      onMouseLeave={onClose}
      onKeyDown={onKeyDown}
    >
      {EDITOR_CONTEXT_ITEMS.map((item) => {
        const enabled = enabledSet.has(item.id);
        const checked = checkedSet.has(item.id);
        return (
          <li key={item.id} role="none">
            <button
              type="button"
              role="menuitem"
              className="yh-editor-context-menu__item"
              // enabledIds에 든 항목만 활성. 그 외(미결선·aux placeholder)는 비활성.
              disabled={!enabled}
              // 보이기 토글 항목의 현재 on/off 표시(선택). disabled와 무관.
              aria-checked={checked}
              // 활성 항목만 onSelect 위임(disabled 항목은 호출되지 않음 + 코드 가드).
              onClick={() => {
                if (!enabled) return;
                if (onSelect) onSelect(item.id);
                if (onClose) onClose();
              }}
            >
              <span className="yh-editor-context-menu__check" aria-hidden="true">{checked ? '✓' : ''}</span>
              <span className="yh-editor-context-menu__label">{item.label}</span>
              {item.shortcut && (
                <span className="yh-editor-context-menu__shortcut" aria-hidden="true">{item.shortcut}</span>
              )}
            </button>
          </li>
        );
      })}
    </ul>
  );
}

export default EditorContextMenu;
