// 에디터 툴바 — 글꼴/크기 셀렉트만. 기본 숨김이며 우클릭 컨텍스트 메뉴 '툴바 보이기'(ctx.showToolBar)로 토글한다.
// 구 기능 버튼군(새문서·불러오기·저장하기·인쇄·인쇄미리보기·찾기/바꾸기·맞춤법검사·약물입력·약어변환·
// 표 삽입·그림삽입·유튜브영상 삽입·메모장 — 전부 비활성 placeholder 쉘)은 사용자 요청으로 제거됨(2026-07-07).
// 해당 기능은 메뉴바(도구 등)·우클릭 컨텍스트 메뉴·단축키로 제공된다.
// 순수 UI: model/fetch 없음. 셀렉트는 표시만(에디터 폰트를 실제로 바꾸지 않는다).

// 글꼴/크기 placeholder 옵션 — 표시 전용(에디터 폰트 미적용).
export const TOOLBAR_FONTS = Object.freeze(['바탕', '돋움', '굴림']);
export const TOOLBAR_SIZES = Object.freeze(['10', '12', '14', '16']);

export function EditorToolBar() {
  return (
    <div className="yh-editor-toolbar" role="toolbar" aria-label="에디터 도구막대" data-testid="toolbar">
      {/* 표시 전용 셀렉트 — 선택값은 보존되지만 에디터 폰트를 실제로 바꾸지 않는다(placeholder).
          마우스 전용: tabIndex=-1로 Tab 포커스 제외(native 드롭다운 조작을 위해 mousedown은 막지 않는다). */}
      <select className="yh-editor-toolbar__select" aria-label="글꼴" data-testid="tool-font" defaultValue="바탕" tabIndex={-1}>
        {TOOLBAR_FONTS.map((font) => (
          <option key={font} value={font}>{font}</option>
        ))}
      </select>
      <select className="yh-editor-toolbar__select" aria-label="글씨크기" data-testid="tool-size" defaultValue="14" tabIndex={-1}>
        {TOOLBAR_SIZES.map((size) => (
          <option key={size} value={size}>{size}</option>
        ))}
      </select>
    </div>
  );
}

export default EditorToolBar;
