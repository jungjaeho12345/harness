// 메모장 다이얼로그 — 순수 표시/입력(controlled) 컴포넌트(ADR-003).
// 값(value)·영속·표시여부는 부모(Step 1 WriterPage)가 소유한다 — 이 컴포넌트는 내부 state·localStorage·model이 없다.
// 기사 본문/markupVersion과 무관한 전역 스크래치패드. 전용 yh-editor-memo/editor-memo className·testid로 다른 다이얼로그와 충돌 방지.
// Enter는 개행이어야 하므로 가로채지 않는다 — Escape만 닫기로 처리한다(UrlEmbedDialog와 다름).

export function MemoDialog({
  open,
  value = '', // 현재 메모 텍스트(부모 소유 — controlled)
  onChange, // (text) => void — textarea 입력 시
  onSave, // () => void — '저장' 클릭 시(부모가 localStorage 영속)
  onClose, // () => void — '닫기'/Esc
}) {
  if (!open) return null;

  const handleKeyDown = (e) => {
    if (e.key === 'Escape' && onClose) onClose();
  };

  return (
    <div
      className="yh-editor-memo"
      role="dialog"
      aria-label="메모장"
      data-testid="editor-memo"
      onKeyDown={handleKeyDown}
    >
      <h2 className="yh-editor-memo__title">메모장</h2>

      <textarea
        className="yh-editor-memo__text"
        data-testid="editor-memo-text"
        aria-label="메모"
        value={value}
        onChange={(e) => onChange && onChange(e.target.value)}
      />

      <div className="yh-editor-memo__actions">
        <button
          type="button"
          className="yh-btn yh-btn--primary"
          data-testid="editor-memo-save"
          onClick={() => onSave && onSave()}
        >
          저장
        </button>
        <button
          type="button"
          className="yh-btn"
          data-testid="editor-memo-close"
          onClick={() => onClose && onClose()}
        >
          닫기
        </button>
      </div>
    </div>
  );
}

export default MemoDialog;
