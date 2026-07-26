// 에디터 정보 다이얼로그 — 순수 표시(읽기전용) 컴포넌트(ADR-003).
// 에디터 이름·버전 등 정적 정보만 보여준다. Date/외부 fetch/model/localStorage/window import 없음(순수).
// controlled: 표시여부(open)·닫기(onClose)는 부모(WriterPage)가 소유한다 — 내부 state 없음.
// 자기 텍스트도 번역 대상 — 제목/라벨/이름은 t(key, fallback)로 렌더(t 미주입 시 ko 원문 폴백). 버전 값은 정적 상수/props.
// 전용 yh-editor-about className·about-dialog testid로 다른 다이얼로그와 충돌 방지.

import { useRef } from 'react';
import { useFocusOnOpen } from './useFocusOnOpen.js';

// 에디터 버전 — 정적 상수(동적 조회/외부 fetch 없음). 부모가 version prop으로 덮어쓸 수 있다.
export const EDITOR_VERSION = '1.0.0';

export function AboutDialog({
  open,
  t, // (key, fallback?) => string — createTranslator 결과. 없으면 ko 원문 폴백
  version = EDITOR_VERSION, // 표시할 버전(정적 주입) — 기본은 모듈 상수
  onClose, // () => void — '닫기'/Esc
}) {
  // t 미주입 시 fallback→key 로 저하 — 테스트가 t 없이 렌더할 수 있고 ko 원문이 나온다(EditorMenuBar 폴백 관례).
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
      className="yh-editor-dialog yh-editor-about"
      role="dialog"
      aria-label={tr('help.about', '에디터 정보')}
      data-testid="about-dialog"
      onKeyDown={handleKeyDown}
    >
      <h2 className="yh-editor-about__title">{tr('help.about', '에디터 정보')}</h2>

      <dl className="yh-editor-about__list">
        <div className="yh-editor-about__row">
          <dt className="yh-editor-about__label">{tr('help.dialog.nameLabel', '이름')}</dt>
          <dd className="yh-editor-about__value" data-testid="about-dialog-name">
            {tr('help.dialog.appName', '기사 작성기')}
          </dd>
        </div>
        <div className="yh-editor-about__row">
          <dt className="yh-editor-about__label">{tr('help.dialog.versionLabel', '버전')}</dt>
          <dd className="yh-editor-about__value" data-testid="about-dialog-version">{version}</dd>
        </div>
      </dl>

      <div className="yh-editor-about__actions">
        <button
          type="button"
          className="yh-btn yh-btn--primary"
          data-testid="about-dialog-close"
          ref={closeRef}
          onClick={() => onClose && onClose()}
        >
          {tr('common.close', '닫기')}
        </button>
      </div>
    </div>
  );
}

export default AboutDialog;
