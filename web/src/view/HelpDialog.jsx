// 도움말 열기 다이얼로그 — 순수 표시(읽기전용) 컴포넌트(ADR-003).
// 자주 쓰는 단축키/기능 안내를 정적으로 보여준다. 입력 폼·onSubmit·model/fetch/localStorage/Date/window import 없음.
// controlled: 표시여부(open)·닫기(onClose)는 부모(WriterPage)가 소유한다 — 내부 state 없음.
// 자기 텍스트도 번역 대상 — 제목/섹션/설명은 t(key, fallback)로 렌더(t 미주입 시 ko 원문 폴백). 단축키 글리프는 언어 무관.
// 단축키 목록은 실제 editorShortcuts/editorFind/editorGlyphKeymap predicate와 일치시킨다(죽은 안내 방지).
// 전용 yh-editor-help className·help-dialog testid로 다른 다이얼로그(약물입력/URL임베드/찾기 등)와 충돌 방지.

import { useRef } from 'react';
import { useFocusOnOpen } from './useFocusOnOpen.js';

// 정적 단축키 표 — { keys(언어 무관 글리프), descKey(i18n 키), descFallback(ko 원문) }.
// 각 조합은 실제 predicate에서 검증됨:
//   Alt+Y=isInsertEndMarker, Ctrl+Y=isInsertContinueMarker, Ctrl+D=isDeleteLine, Ctrl+F=isFindReplace,
//   Alt+O=isGlyphInput, Alt+V=isPasteOriginal, Ctrl+Z=isUndo, Ctrl+Shift+Z=isRedo,
//   Insert=isToggleOverwrite(이번 phase 신설), Ctrl+B=isCompanyCode.
const SHORTCUTS = [
  { keys: 'Alt+Y', descKey: 'edit.insertEnd', descFallback: '(끝)삽입' },
  { keys: 'Ctrl+Y', descKey: 'edit.insertContinue', descFallback: '(계속)삽입' },
  { keys: 'Ctrl+D', descKey: 'edit.deleteLine', descFallback: '한줄 지우기' },
  { keys: 'Ctrl+F', descKey: 'edit.findReplace', descFallback: '찾기/바꾸기' },
  { keys: 'Alt+O', descKey: 'tools.symbolInput', descFallback: '약물 입력' },
  { keys: 'Alt+V', descKey: 'edit.pasteOriginal', descFallback: '원본 붙여넣기' },
  { keys: 'Ctrl+B', descKey: 'help.dialog.companyCode', descFallback: '기업코드 변환' },
  { keys: 'Ctrl+Z', descKey: 'edit.undo', descFallback: '되돌리기' },
  { keys: 'Ctrl+Shift+Z', descKey: 'edit.redo', descFallback: '다시실행' },
  { keys: 'Insert', descKey: 'help.dialog.overwrite', descFallback: '삽입/수정 모드 전환' },
];

export function HelpDialog({
  open,
  t, // (key, fallback?) => string — createTranslator 결과. 없으면 ko 원문 폴백
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
      className="yh-editor-dialog yh-editor-help"
      role="dialog"
      aria-label={tr('help.open', '도움말 열기')}
      data-testid="help-dialog"
      onKeyDown={handleKeyDown}
    >
      <h2 className="yh-editor-help__title">{tr('help.open', '도움말 열기')}</h2>

      <h3 className="yh-editor-help__section">{tr('help.dialog.shortcutsTitle', '단축키')}</h3>
      <dl className="yh-editor-help__list" data-testid="help-dialog-shortcuts">
        {SHORTCUTS.map((s) => (
          <div key={s.keys} className="yh-editor-help__row">
            <dt className="yh-editor-help__keys">{s.keys}</dt>
            <dd className="yh-editor-help__desc">{tr(s.descKey, s.descFallback)}</dd>
          </div>
        ))}
      </dl>

      <div className="yh-editor-help__actions">
        <button
          type="button"
          className="yh-btn yh-btn--primary"
          data-testid="help-dialog-close"
          ref={closeRef}
          onClick={() => onClose && onClose()}
        >
          {tr('common.close', '닫기')}
        </button>
      </div>
    </div>
  );
}

export default HelpDialog;
