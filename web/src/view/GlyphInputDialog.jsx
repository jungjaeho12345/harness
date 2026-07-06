// 약물입력(Alt+O) 다이얼로그 — 순수 표시/폼 컴포넌트(ADR-003).
// 자주쓰는 약물(favorites: string[]) 중 하나를 선택하면 onPick(glyph)로 삽입을 위임한다.
// 사용자 키보드 약물(keymap: {keys, glyph}[])은 참조용으로 `keys → glyph` 형식으로 표시만 하며(EditorPrefsDialog 동일 표기),
//   편의상 클릭하면 onPick(glyph)로 삽입한다. 키 입력을 받아 keys 매칭으로 치환하는 로직은 만들지 않는다(키조합 인터셉트는 범위 밖 — 표시만).
// 약물 삽입(블록/캐럿 계산)은 하지 않는다 — favorites/keymap은 부모(WriterPage)가 loadEditorPrefs로 읽어 주입하고,
//   캐럿 위치 삽입 결선은 Step 4가 담당한다. 동작은 onPick/onClose 콜백으로만 위임한다.
// model/fetch/localStorage/window/document 호출 없음. 찾기/바꾸기(yh-find-replace)·약물바(yh-editor-glyphbar)와
//   충돌하지 않게 전용 클래스(yh-glyph-input)·testid(glyph-input)를 쓴다.

import { useRef } from 'react';
import { useFocusOnOpen } from './useFocusOnOpen.js';

export function GlyphInputDialog({
  open,
  favorites = [], // string[] — 자주쓰는 약물
  keymap = [], // {keys, glyph}[] — 사용자 키보드 약물(참조 표시)
  onPick, // (glyph) => void — 약물 선택 시
  onClose, // () => void
}) {
  // 열림 시 포커스를 '닫기' 버튼으로 이전(텍스트 입력 없음) — 약물 버튼에 두면 Space/Enter로 우발 삽입되고,
  // 포커스가 에디터 본문에 남으면 Esc 닫기가 발화하지 않는다(Step 0 27-editor-critical-fixes).
  const closeRef = useRef(null);
  useFocusOnOpen(closeRef, open);

  if (!open) return null;

  // 약물 선택 시 부모에 삽입을 위임한다. 닫을지(onClose)는 부모 재량에 맡기고 여기서는 닫지 않는다 —
  //   여러 약물을 연속 삽입할 수 있게 다이얼로그를 열어 둔다(닫기는 닫기 버튼/Esc로 명시).
  const pick = (glyph) => {
    if (onPick) onPick(glyph);
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Escape' && onClose) onClose();
  };

  return (
    <div
      className="yh-glyph-input"
      role="dialog"
      aria-label="약물 입력"
      data-testid="glyph-input"
      onKeyDown={handleKeyDown}
    >
      <h2 className="yh-glyph-input__title">약물 입력</h2>

      <div className="yh-glyph-input__section">
        <div className="yh-glyph-input__label">자주쓰는 약물</div>
        {favorites.length > 0 ? (
          <div className="yh-glyph-input__grid">
            {favorites.map((glyph, i) => (
              // 약물 텍스트가 중복될 수 있으므로 key는 인덱스를 포함해 안정화한다(EditorPrefsDialog glyph-list와 동일).
              <button
                key={`${glyph}-${i}`}
                type="button"
                className="yh-glyph-input__glyph"
                aria-label={`약물 ${glyph} 삽입`}
                data-testid={`glyph-input-fav-${i}`}
                onClick={() => pick(glyph)}
              >
                {glyph}
              </button>
            ))}
          </div>
        ) : (
          <div className="yh-glyph-input__empty" data-testid="glyph-input-fav-empty">
            등록된 약물 없음 (환경설정 &gt; 자주쓰는 약물)
          </div>
        )}
      </div>

      <div className="yh-glyph-input__section">
        <div className="yh-glyph-input__label">키보드 약물</div>
        {keymap.length > 0 ? (
          <ul className="yh-glyph-input__keylist">
            {keymap.map((m, i) => (
              // 참조 표시(keys → glyph). 키 입력 매칭 치환은 하지 않고, 편의상 클릭 시에만 onPick으로 삽입한다.
              <li className="yh-glyph-input__keyrow" key={`${m.keys}-${m.glyph}-${i}`}>
                <button
                  type="button"
                  className="yh-glyph-input__keybtn"
                  aria-label={`약물 ${m.glyph} 삽입`}
                  data-testid={`glyph-input-key-${i}`}
                  onClick={() => pick(m.glyph)}
                >
                  {`${m.keys} → ${m.glyph}`}
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <div className="yh-glyph-input__empty" data-testid="glyph-input-key-empty">
            등록된 약물 없음 (환경설정 &gt; 사용자 키보드 약물)
          </div>
        )}
      </div>

      <div className="yh-glyph-input__actions">
        <button
          type="button"
          className="yh-btn yh-btn--primary"
          data-testid="glyph-input-close"
          ref={closeRef}
          onClick={() => onClose && onClose()}
        >
          닫기
        </button>
      </div>
    </div>
  );
}

export default GlyphInputDialog;
