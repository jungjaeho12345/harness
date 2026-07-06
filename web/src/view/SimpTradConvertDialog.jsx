// 간↔번 방향 선택 다이얼로그 — 순수 표시(stateless) 컴포넌트(ADR-003). 내부 state·localStorage·model 없음.
// 방향만 onConvert(direction)로 부모에 위임한다(실제 본문 변환은 Step 1 WriterPage가 안전 경로로 수행).
// 전용 yh-simptrad-convert/simptrad-convert className·testid로 다른 다이얼로그와 충돌 방지. Escape만 닫기.
// simpTradTable/simpTradConvert를 import 하지 않는다(변환은 부모의 몫 — Enter 미인터셉트). 방향은 문자열 리터럴로 위임.

import { useRef } from 'react';
import { useFocusOnOpen } from './useFocusOnOpen.js';

export function SimpTradConvertDialog({
  open,
  onConvert, // (direction: 'toTrad' | 'toSimp') => void — 방향 버튼 클릭 시
  onClose, // () => void — '닫기'/Esc
}) {
  // 열림 시 포커스를 '닫기' 버튼으로 이전 — 변환 버튼(simptrad-to-trad 등)에 두면 열림 직후 Space/Enter로
  // 본문 전체가 우발 변환되고, 포커스가 에디터 본문에 남으면 Esc 닫기가 발화하지 않는다(Step 0 27-editor-critical-fixes).
  const closeRef = useRef(null);
  useFocusOnOpen(closeRef, open);

  if (!open) return null;

  const handleKeyDown = (e) => {
    if (e.key === 'Escape' && onClose) onClose(); // Escape만 닫기(Enter 미인터셉트).
  };

  return (
    <div
      className="yh-simptrad-convert"
      role="dialog"
      aria-label="간체/번체 변환"
      data-testid="simptrad-convert"
      onKeyDown={handleKeyDown}
    >
      <h2 className="yh-simptrad-convert__title">간체↔번체 변환</h2>

      <p className="yh-simptrad-convert__note">
        변환표는 상용 한자 위주로 완전하지 않을 수 있습니다. 미등록 문자는 원문이 유지됩니다.
      </p>

      <div className="yh-simptrad-convert__form">
        <button
          type="button"
          className="yh-btn yh-btn--primary"
          data-testid="simptrad-to-trad"
          onClick={() => onConvert && onConvert('toTrad')}
        >
          간체→번체
        </button>
        <button
          type="button"
          className="yh-btn yh-btn--primary"
          data-testid="simptrad-to-simp"
          onClick={() => onConvert && onConvert('toSimp')}
        >
          번체→간체
        </button>
      </div>

      <div className="yh-simptrad-convert__actions">
        <button
          type="button"
          className="yh-btn"
          data-testid="simptrad-close"
          ref={closeRef}
          onClick={() => onClose && onClose()}
        >
          닫기
        </button>
      </div>
    </div>
  );
}

export default SimpTradConvertDialog;
