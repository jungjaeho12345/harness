// 에디터 환경설정 모달 — 이번 phase(11)는 '색상' 탭만(제목/부제목/본문/바탕).
// 후속 phase가 같은 다이얼로그에 자동저장/바이라인/날짜형식 탭을 추가한다.
// '적용' = 영속(saveEditorPrefs) + 텍스트색 적용(setEditorColors) + onClose(true) → 부모가 배경 적용·Editor 재렌더.
// 순수 폼/표시 컴포넌트 — model/fetch 없음(ADR-003). editorPrefs(localStorage)·editorColoring(module 상태)은
// view 모듈이라 직접 호출해도 ADR-003 위반이 아니다(서버 호출 아님).

import { useEffect, useState } from 'react';
import {
  loadEditorPrefs, saveEditorPrefs, setEditorPref, DEFAULT_EDITOR_PREFS,
} from './editorPrefs.js';
import { setEditorColors } from './editorColoring.js';

// 색상 탭 폼 필드 — 사용자 설정 대상 텍스트 3색 + 바탕색. end "(끝)" 골드는 사용자 설정 대상이 아니므로 폼에 없다.
const COLOR_FIELDS = [
  { key: 'title', label: '제목색' },
  { key: 'subtitle', label: '부제목색' },
  { key: 'body', label: '본문색' },
  { key: 'background', label: '바탕색' },
];

export function EditorPrefsDialog({ open, onClose }) {
  // 폼 색 상태 — 열릴 때 저장값(loadEditorPrefs().colors)으로 초기화한다.
  const [colors, setColors] = useState(() => loadEditorPrefs().colors);

  // 다시 열릴 때마다 저장값으로 폼을 재초기화한다(이전 미적용 편집/적용 결과가 다음 열림에 반영되도록).
  useEffect(() => {
    if (open) setColors(loadEditorPrefs().colors);
  }, [open]);

  if (!open) return null;

  const setColor = (key, value) => setColors((c) => ({ ...c, [key]: value }));

  // 적용 — 저장(saveEditorPrefs) + 텍스트색 적용(setEditorColors, background 제외) + applied=true로 닫기.
  const apply = () => {
    const {
      title, subtitle, body, background,
    } = colors;
    const next = setEditorPref(loadEditorPrefs(), 'colors', {
      title, subtitle, body, background,
    });
    saveEditorPrefs(next);
    setEditorColors({ title, subtitle, body });
    onClose(true);
  };

  // 취소 — 저장·적용·배경 갱신 없이 닫기만(applied=false).
  const cancel = () => onClose(false);

  // 기본값 — 폼 색을 DEFAULT_EDITOR_PREFS의 title/subtitle/body/background로 리셋(end는 폼에 없어 건드리지 않음).
  const reset = () => {
    const d = DEFAULT_EDITOR_PREFS.colors;
    setColors((c) => ({
      ...c, title: d.title, subtitle: d.subtitle, body: d.body, background: d.background,
    }));
  };

  return (
    <div className="yh-modal__backdrop" onMouseDown={cancel}>
      <div
        className="yh-modal yh-prefs"
        role="dialog"
        aria-label="환경설정"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <h2 className="yh-prefs__title">환경설정 — 색상</h2>
        <div className="yh-prefs__fields">
          {COLOR_FIELDS.map(({ key, label }) => (
            <div className="yh-field" key={key}>
              <label htmlFor={`pref-color-${key}`}>{label}</label>
              <input
                id={`pref-color-${key}`}
                data-testid={`pref-color-${key}`}
                type="color"
                value={colors[key]}
                onChange={(e) => setColor(key, e.target.value)}
              />
            </div>
          ))}
        </div>
        <div className="yh-prefs__actions">
          <button type="button" className="yh-btn" data-testid="prefs-reset" onClick={reset}>기본값</button>
          <button type="button" className="yh-btn" data-testid="prefs-cancel" onClick={cancel}>취소</button>
          <button type="button" className="yh-btn yh-btn--primary" data-testid="prefs-apply" onClick={apply}>적용</button>
        </div>
      </div>
    </div>
  );
}

export default EditorPrefsDialog;
