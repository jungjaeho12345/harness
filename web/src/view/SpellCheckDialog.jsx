// 맞춤법 검사 결과 목록 다이얼로그 — 순수 표시(읽기전용) 컴포넌트(ADR-003). FileInfoDialog 구조를 본뜬다.
// 오류 후보 목록(issues)은 부모(Step 2 WriterPage)가 Step 0 checkSpelling 결과에 snippet(오류 조각 텍스트)을
//   더해 props로 주입한다 — 이 컴포넌트는 editorSpell.js를 import하지 않고(의도된 독립), 오프셋(start)도 해석하지
//   않는다(항목 클릭 시 issue 그대로 onSelect 위임 — 캐럿 이동은 부모 몫).
// 교정 제안(suggestion)은 표시만 한다 — 자동교체 버튼 없음(news.md 확정 정책: 본문 자동 수정 금지).
// model/fetch/localStorage/window/document 호출 없음. 찾기(yh-find-replace)·파일정보(yh-file-info)·
//   이력비교(yh-history-compare) 등과 충돌하지 않게 전용 클래스(yh-spellcheck)·testid(spellcheck*)를 쓴다.

import { useRef } from 'react';
import { useFocusOnOpen } from './useFocusOnOpen.js';

export function SpellCheckDialog({
  open,
  issues, // [{ start, snippet, group, message, suggestion }] — 필드명은 Step 0 Issue 계약(start/group/message/suggestion)
  errorStyle, // 'bold' | 'underline' — 오류 조각 렌더 스타일(news.md 오류 표현 굵게/밑줄)
  onSelect, // (issue) => void — 항목 클릭 시(부모가 issue.start로 캐럿 이동)
  onClose, // () => void
}) {
  // 열림 시 포커스를 '닫기' 버튼으로 이전(issues가 비면 항목 버튼이 없어 항상 실재하는 닫기 버튼을 쓴다) —
  // 포커스가 에디터 본문에 남으면 Esc 닫기가 발화하지 않고 타이핑이 본문에 들어간다(Step 0 27-editor-critical-fixes).
  const closeRef = useRef(null);
  useFocusOnOpen(closeRef, open);

  if (!open) return null;

  // issues 미주입/비배열이어도 죽지 않게 안전 폴백한다(빈 상태로 렌더).
  const list = Array.isArray(issues) ? issues : [];
  // errorStyle이 비정상 값이어도 렌더가 깨지지 않게 기본값 bold로 폴백(editorPrefs 기본값과 동일).
  const style = errorStyle === 'underline' ? 'underline' : 'bold';

  const handleKeyDown = (e) => {
    if (e.key === 'Escape' && onClose) onClose();
  };

  return (
    <div
      className="yh-editor-dialog yh-spellcheck"
      role="dialog"
      aria-label="맞춤법 검사"
      data-testid="spellcheck"
      onKeyDown={handleKeyDown}
    >
      <h2 className="yh-spellcheck__title">맞춤법 검사</h2>

      {list.length === 0 ? (
        <p className="yh-spellcheck__empty" data-testid="spellcheck-empty">
          맞춤법 오류가 없습니다.
        </p>
      ) : (
        <>
          <p className="yh-spellcheck__count" data-testid="spellcheck-count">
            {list.length}건
          </p>
          <ul className="yh-spellcheck__list">
            {list.map((issue, i) => (
              <li key={i} className="yh-spellcheck__item">
                <button
                  type="button"
                  className="yh-spellcheck__item-btn"
                  data-testid={`spellcheck-item-${i}`}
                  onClick={() => onSelect && onSelect(issue)}
                >
                  <span
                    className={`yh-spellcheck__snippet yh-spellcheck__snippet--${style}`}
                    data-testid="spellcheck-snippet"
                    data-style={style}
                  >
                    {issue.snippet}
                  </span>
                  <span className="yh-spellcheck__message">{issue.message}</span>
                  {issue.suggestion != null && (
                    <span className="yh-spellcheck__suggestion" data-testid="spellcheck-suggestion">
                      → {issue.suggestion}
                    </span>
                  )}
                </button>
              </li>
            ))}
          </ul>
        </>
      )}

      <div className="yh-spellcheck__actions">
        <button
          type="button"
          className="yh-btn yh-btn--primary"
          data-testid="spellcheck-close"
          ref={closeRef}
          onClick={() => onClose && onClose()}
        >
          닫기
        </button>
      </div>
    </div>
  );
}

export default SpellCheckDialog;
