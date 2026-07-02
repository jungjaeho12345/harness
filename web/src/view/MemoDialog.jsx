// 메모장 다이얼로그 — 순수 표시/폼 컴포넌트(ADR-003). 본문과 무관한 자유 텍스트 스크래치패드.
// 텍스트는 부모(WriterPage)가 props.text로 주입하는 제어 컴포넌트다 — 자체 useState/영속화(saveMemo)·
//   본문(blocks/updateField)·캐럿 접근을 하지 않는다. 변경은 onChange, 닫기는 onClose로 위임한다(영속화는 부모 책임).
// GlyphInputDialog와 동일 패턴(if(!open) return null·role="dialog"·Escape→onClose·닫기 버튼).
// 전용 클래스/testid(yh-memo·memo·memo-*)로 다른 다이얼로그(yh-glyph-input·yh-find-replace)와 충돌하지 않게 한다.
// model/fetch/localStorage/window/document(이벤트 핸들러 인자 제외) 호출 없음.

export function MemoDialog({
  open,
  text = '', // string — 표시할 메모 텍스트(부모 주입)
  onChange, // (text) => void — textarea 입력 시
  onClose, // () => void — 닫기 버튼/Escape
}) {
  if (!open) return null;

  const handleKeyDown = (e) => {
    if (e.key === 'Escape' && onClose) onClose();
  };

  return (
    <div
      className="yh-memo"
      role="dialog"
      aria-label="메모장"
      data-testid="memo"
      onKeyDown={handleKeyDown}
    >
      <h2 className="yh-memo__title">메모장</h2>

      <textarea
        className="yh-memo__textarea"
        aria-label="메모 내용"
        data-testid="memo-textarea"
        value={text}
        onChange={(e) => { if (onChange) onChange(e.target.value); }}
      />

      <div className="yh-memo__actions">
        <button
          type="button"
          className="yh-btn yh-btn--primary"
          data-testid="memo-close"
          onClick={() => onClose && onClose()}
        >
          닫기
        </button>
      </div>
    </div>
  );
}

export default MemoDialog;
