// 에디터 툴바 — 글꼴/크기 셀렉트만. 기본 숨김이며 우클릭 컨텍스트 메뉴 '툴바 보이기'(ctx.showToolBar)로 토글한다.
// 구 기능 버튼군(새문서·불러오기·저장하기·인쇄·인쇄미리보기·찾기/바꾸기·맞춤법검사·약물입력·약어변환·
// 표 삽입·그림삽입·유튜브영상 삽입·메모장 — 전부 비활성 placeholder 쉘)은 사용자 요청으로 제거됨(2026-07-07).
// 해당 기능은 메뉴바(도구 등)·우클릭 컨텍스트 메뉴·단축키로 제공된다.
// controlled UI: model/fetch 없음. 셀렉트는 value(상위 state)+onChange 콜백만으로 동작한다.
// 선택값은 상위(WriterPage, step1)가 CSS 변수로 .yh-editor 전체 폰트에 반영한다(본문 데이터 markupVersion은 불변).

// 글꼴/크기 옵션 — 맨 앞 '기본'은 sentinel(override 없음 = 에디터 현재 폰트 유지). 명명 값만 실제 폰트/크기를 적용한다.
export const TOOLBAR_FONTS = Object.freeze(['기본', '바탕', '돋움', '굴림']);
export const TOOLBAR_SIZES = Object.freeze(['기본', '10', '12', '14', '16']);

export function EditorToolBar({
  font = '기본', fontSize = '기본', onFontChange, onFontSizeChange,
}) {
  return (
    <div className="yh-editor-toolbar" role="toolbar" aria-label="에디터 도구막대" data-testid="toolbar">
      {/* controlled 셀렉트 — value는 상위 state를 따르고, onChange로 선택을 알린다('기본'=override 없음).
          마우스 전용: tabIndex=-1로 Tab 포커스 제외(native 드롭다운 조작을 위해 mousedown은 막지 않는다). */}
      <select
        className="yh-editor-toolbar__select"
        aria-label="글꼴"
        data-testid="tool-font"
        value={font}
        onChange={(e) => onFontChange && onFontChange(e.target.value)}
        tabIndex={-1}
      >
        {TOOLBAR_FONTS.map((f) => (
          <option key={f} value={f}>{f}</option>
        ))}
      </select>
      <select
        className="yh-editor-toolbar__select"
        aria-label="글씨크기"
        data-testid="tool-size"
        value={fontSize}
        onChange={(e) => onFontSizeChange && onFontSizeChange(e.target.value)}
        tabIndex={-1}
      >
        {TOOLBAR_SIZES.map((size) => (
          <option key={size} value={size}>{size}</option>
        ))}
      </select>
    </div>
  );
}

export default EditorToolBar;
