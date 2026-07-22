// UI 언어 설정 다이얼로그 — 순수 controlled 컴포넌트(ADR-003).
// 표시여부(open)·현재 언어(value)·선택 처리(onSelect)·닫기(onClose)는 전부 부모(Step 3 WriterPage)가 소유한다 —
//   이 컴포넌트는 내부 state·localStorage·model·fetch가 없다. UI 언어는 전역이라 탭-로컬 좌표/선택 상태도 없다.
// 자기 자신도 번역 대상이다 — 제목/라벨/버튼은 Step 0 createTranslator 결과 t(key, fallback)로 렌더한다.
//   t 미주입 시 (k,f)=>f??k 로 저하해 ko 원문을 보여준다(ko 불변식). 전용 yh-editor-ui-language className·testid로 충돌 방지.

import { useRef } from 'react';
import { useFocusOnOpen } from './useFocusOnOpen.js';

// ko/en 두 옵션 — 각 라벨은 t로 렌더(fallback=ko 원문). 순서 고정(ko, en).
const OPTIONS = [
  { lang: 'ko', key: 'ui.dialog.ko', fallback: '한국어' },
  { lang: 'en', key: 'ui.dialog.en', fallback: '영어' },
];

export function UiLanguageDialog({
  open,
  value = 'ko', // 'ko' | 'en' — 현재 UI 언어(부모 소유 — controlled)
  t, // (key, fallback?) => string — Step 0 createTranslator 결과. 없으면 ko 원문 폴백
  onSelect, // (lang) => void — ko/en 선택 시(부모가 영속·적용)
  onClose, // () => void — '닫기'/Esc
}) {
  // t 미주입 시 fallback→key 로 저하 — 테스트가 t 없이 렌더할 수 있고 ko 원문이 나온다.
  const tr = typeof t === 'function' ? t : (key, fallback) => (fallback !== undefined ? fallback : key);

  // 열림 시 포커스를 '닫기' 버튼(비-변이 focusable 컨트롤)으로 이전 — 포커스가 에디터 본문에 남으면
  // 타이핑이 기사 본문에 삽입되고 Esc 닫기가 발화하지 않는다(useFocusOnOpen 주석).
  const closeRef = useRef(null);
  useFocusOnOpen(closeRef, open);

  if (!open) return null;

  const handleKeyDown = (e) => {
    if (e.key === 'Escape' && onClose) onClose();
  };

  return (
    <div
      className="yh-editor-dialog yh-editor-ui-language"
      role="dialog"
      aria-label={tr('ui.dialog.title', 'UI 언어 설정')}
      data-testid="ui-language-dialog"
      onKeyDown={handleKeyDown}
    >
      <h2 className="yh-editor-ui-language__title">{tr('ui.dialog.title', 'UI 언어 설정')}</h2>

      <div className="yh-editor-ui-language__options" role="radiogroup">
        {OPTIONS.map((opt) => (
          <label key={opt.lang} className="yh-editor-ui-language__option">
            <input
              type="radio"
              name="ui-language"
              data-testid={`ui-language-option-${opt.lang}`}
              value={opt.lang}
              checked={value === opt.lang}
              onChange={() => onSelect && onSelect(opt.lang)}
            />
            <span>{tr(opt.key, opt.fallback)}</span>
          </label>
        ))}
      </div>

      <div className="yh-editor-ui-language__actions">
        <button
          type="button"
          className="yh-btn"
          data-testid="ui-language-close"
          ref={closeRef}
          onClick={() => onClose && onClose()}
        >
          {tr('common.close', '닫기')}
        </button>
      </div>
    </div>
  );
}

export default UiLanguageDialog;
