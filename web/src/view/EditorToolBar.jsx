// 에디터 툴바(쉘) — 메뉴바 아래 글꼴/크기 셀렉트 + 버튼군.
// news.md "기사 에디터": 상단 메뉴바 밑에 글씨체·글씨크기·새문서·불러오기·저장하기·인쇄·인쇄미리보기·
// 찾기/바꾸기·맞춤법검사·약물입력·약어변환·표 삽입·그림삽입·유튜브영상 삽입·메모장이 있다.
// enabledIds에 든 버튼만 활성이고 그 외는 비활성(disabled) placeholder다 — 나머지 액션 결선은 후속 phase.
// enabledIds 미전달 시 전 버튼 disabled(쉘 하위호환). EditorMenuBar와 동일한 enabledSet 규약을 쓴다.
// 순수 UI: model/fetch 없음. 셀렉트는 표시만(에디터 폰트를 실제로 바꾸지 않는다).
// 활성 버튼 클릭 시에만 onSelect(id)로 위임한다(disabled 버튼은 호출되지 않음).

// 글꼴/크기 placeholder 옵션 — 표시 전용(에디터 폰트 미적용).
export const TOOLBAR_FONTS = Object.freeze(['바탕', '돋움', '굴림']);
export const TOOLBAR_SIZES = Object.freeze(['10', '12', '14', '16']);

// 버튼군 (news.md 순서). {id(안정 키), label}.
export const TOOLBAR_BUTTONS = Object.freeze([
  { id: 'tool.new', label: '새문서' },
  { id: 'tool.open', label: '불러오기' },
  { id: 'tool.save', label: '저장하기' },
  { id: 'tool.print', label: '인쇄' },
  { id: 'tool.printPreview', label: '인쇄미리보기' },
  { id: 'tool.findReplace', label: '찾기/바꾸기' },
  { id: 'tool.spellCheck', label: '맞춤법검사' },
  { id: 'tool.symbolInput', label: '약물입력' },
  { id: 'tool.abbrConvert', label: '약어변환' },
  { id: 'tool.insertTable', label: '표 삽입' },
  { id: 'tool.insertImage', label: '그림삽입' },
  { id: 'tool.insertYoutube', label: '유튜브영상 삽입' },
  { id: 'tool.memo', label: '메모장' },
]);

export function EditorToolBar({ onSelect, enabledIds }) {
  // EditorMenuBar와 동일 규약 — enabledIds 미전달(undefined) 시 빈 집합 → 전 버튼 disabled(쉘 하위호환).
  const enabledSet = enabledIds instanceof Set ? enabledIds : new Set(enabledIds || []);
  return (
    <div className="yh-editor-toolbar" role="toolbar" aria-label="에디터 도구막대" data-testid="toolbar">
      {/* 표시 전용 셀렉트 — 선택값은 보존되지만 에디터 폰트를 실제로 바꾸지 않는다(placeholder). */}
      <select className="yh-editor-toolbar__select" aria-label="글꼴" data-testid="tool-font" defaultValue="바탕">
        {TOOLBAR_FONTS.map((font) => (
          <option key={font} value={font}>{font}</option>
        ))}
      </select>
      <select className="yh-editor-toolbar__select" aria-label="글씨크기" data-testid="tool-size" defaultValue="14">
        {TOOLBAR_SIZES.map((size) => (
          <option key={size} value={size}>{size}</option>
        ))}
      </select>
      <span className="yh-editor-toolbar__sep" aria-hidden="true" />
      {TOOLBAR_BUTTONS.map((btn) => (
        <button
          key={btn.id}
          type="button"
          className="yh-editor-toolbar__btn"
          aria-label={btn.label}
          data-testid={`tool-${btn.label}`}
          // enabledIds에 든 버튼만 활성, 그 외는 비활성 placeholder(EditorMenuBar 규약).
          disabled={!enabledSet.has(btn.id)}
          // 활성 버튼 클릭 시에만 onSelect(id)로 위임한다.
          onClick={() => { if (enabledSet.has(btn.id) && onSelect) onSelect(btn.id); }}
        >
          {btn.label}
        </button>
      ))}
    </div>
  );
}

export default EditorToolBar;
