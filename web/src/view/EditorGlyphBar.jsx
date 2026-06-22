// 약물바(glyph bar) — 자주쓰는 약물(items: string[])을 버튼으로 렌더하는 순수 표시 컴포넌트(ADR-003).
// news.md L173 "약물바 보이기" / L206~209 자주쓰는 약물. 버튼 클릭 시 onPick(glyph)로 부모에 위임한다.
// 순수 표시: model/fetch/localStorage/window/document 없음. 약물 삽입(블록/캐럿 계산)은 하지 않는다 —
//   items는 부모(WriterPage)가 loadEditorPrefs로 읽어 주입하고, 삽입 결선은 Step 2가 담당한다.
// 조회페이지(yh-context-menu)·툴바(yh-editor-toolbar)와 충돌하지 않게 전용 클래스(yh-editor-glyphbar)·testid(glyph-bar)를 쓴다.

export function EditorGlyphBar({ items = [], onPick }) {
  return (
    <div
      className="yh-editor-glyphbar"
      role="toolbar"
      aria-label="약물바"
      data-testid="glyph-bar"
    >
      {items.map((glyph, i) => (
        // 약물 텍스트가 중복될 수 있으므로 key는 인덱스를 포함해 안정화(EditorPrefsDialog glyph-list와 동일).
        <button
          key={`${glyph}-${i}`}
          type="button"
          className="yh-editor-glyphbar__btn"
          aria-label={`약물 ${glyph} 삽입`}
          data-testid={`glyph-bar-item-${i}`}
          onClick={() => { if (onPick) onPick(glyph); }}
        >
          {glyph}
        </button>
      ))}
    </div>
  );
}

export default EditorGlyphBar;
