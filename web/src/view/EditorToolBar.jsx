// 에디터 툴바(쉘) — 메뉴바 아래 글꼴/크기 셀렉트 + 버튼군.
// news.md "기사 에디터": 상단 메뉴바 밑에 글씨체·글씨크기·새문서·불러오기·저장하기·인쇄·인쇄미리보기·
// 찾기/바꾸기·맞춤법검사·약물입력·약어변환·표 삽입·그림삽입·유튜브영상 삽입·메모장이 있다.
// 이번 phase는 쉘이므로 버튼은 모두 비활성(disabled) placeholder다 — 실제 액션 결선은 후속 phase.
// 순수 UI: model/fetch 없음. 셀렉트는 표시만(에디터 폰트를 실제로 바꾸지 않는다).
// onSelect는 계약상 받아두지만(후속 phase 결선용) 버튼이 disabled라 이번 phase에선 호출되지 않는다.

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

export function EditorToolBar({ onSelect }) {
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
          // 쉘 — 모든 버튼은 비활성 placeholder다. 액션 결선은 후속 phase.
          disabled
          // 계약상 onSelect를 받아두지만 버튼이 disabled라 이번 phase에선 호출되지 않는다.
          onClick={() => { if (onSelect) onSelect(btn.id); }}
        >
          {btn.label}
        </button>
      ))}
    </div>
  );
}

export default EditorToolBar;
