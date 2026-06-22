// 에디터 환경설정 모달 — 이번 phase(12)는 '색상'(phase 11) + '날짜형식' 탭.
// 후속 phase가 같은 다이얼로그에 자동저장/바이라인 등 탭을 더한다.
// '적용' = 영속(saveEditorPrefs: 색 + 날짜형식 함께) + 텍스트색 적용(setEditorColors) + onClose(true) → 부모가 배경 적용·Editor 재렌더.
// 날짜형식은 조회페이지(ListPage)가 마운트 시 setDateFormat으로 적용하므로 여기서는 저장만 한다(저장+적용 분리).
// 순수 폼/표시 컴포넌트 — model/fetch 없음(ADR-003). editorPrefs(localStorage)·editorColoring(module 상태)은
// view 모듈이라 직접 호출해도 ADR-003 위반이 아니다(서버 호출 아님).

import { useEffect, useState } from 'react';
import {
  loadEditorPrefs, saveEditorPrefs, setEditorPref, DEFAULT_EDITOR_PREFS,
} from './editorPrefs.js';
import { setEditorColors } from './editorColoring.js';
import { DATE_FORMATS } from './listFormat.js';

// 색상 탭 폼 필드 — 사용자 설정 대상 텍스트 3색 + 바탕색. end "(끝)" 골드는 사용자 설정 대상이 아니므로 폼에 없다.
const COLOR_FIELDS = [
  { key: 'title', label: '제목색' },
  { key: 'subtitle', label: '부제목색' },
  { key: 'body', label: '본문색' },
  { key: 'background', label: '바탕색' },
];

// 환경설정 탭 — 색상/자동저장/날짜형식. (후속 phase가 바이라인 등을 추가한다.)
const PREF_TABS = [
  { key: 'colors', label: '색상' },
  { key: 'autosave', label: '자동저장' },
  { key: 'dateFormat', label: '날짜형식' },
];

// 자동저장 저장 간격 옵션(news.md "# 에디터 환경설정 > 자동저장: 저장 간격 30초~5분").
const AUTOSAVE_INTERVALS = [
  { sec: 30, label: '30초' },
  { sec: 60, label: '1분' },
  { sec: 120, label: '2분' },
  { sec: 180, label: '3분' },
  { sec: 240, label: '4분' },
  { sec: 300, label: '5분' },
];

// 보존 기한 옵션(1~7일).
const AUTOSAVE_RETENTIONS = [1, 2, 3, 4, 5, 6, 7];

export function EditorPrefsDialog({ open, onClose }) {
  // 활성 탭(색상이 기본). 폼 상태(colors/dateFormat)는 모달 레벨에 둬 탭 전환해도 미적용 값이 보존된다.
  const [tab, setTab] = useState('colors');
  const [colors, setColors] = useState(() => loadEditorPrefs().colors);
  const [dateFormat, setDateFormat] = useState(() => loadEditorPrefs().dateFormat);
  const [autosave, setAutosave] = useState(() => loadEditorPrefs().autosave);

  // 다시 열릴 때마다 저장값으로 폼을 재초기화한다(이전 미적용 편집/적용 결과가 다음 열림에 반영되도록).
  useEffect(() => {
    if (open) {
      const prefs = loadEditorPrefs();
      setColors(prefs.colors);
      setDateFormat(prefs.dateFormat);
      setAutosave(prefs.autosave);
    }
  }, [open]);

  if (!open) return null;

  const setColor = (key, value) => setColors((c) => ({ ...c, [key]: value }));

  // 적용 — 색 + 날짜형식을 함께 영속(saveEditorPrefs) + 텍스트색 적용(setEditorColors, background 제외) + applied=true로 닫기.
  // 날짜형식은 writer 화면에 즉시 보일 대상이 없어 setDateFormat을 부르지 않는다(ListPage가 마운트 시 적용).
  const apply = () => {
    const {
      title, subtitle, body, background,
    } = colors;
    const { enabled, intervalSec, retentionDays } = autosave;
    // colors + autosave를 setEditorPref로 합성하고 dateFormat은 spread로 보존(세 설정 상호 보존 못박음).
    const next = {
      ...setEditorPref(
        setEditorPref(loadEditorPrefs(), 'colors', {
          title, subtitle, body, background,
        }),
        'autosave',
        { enabled, intervalSec: Number(intervalSec), retentionDays: Number(retentionDays) },
      ),
      dateFormat,
    };
    saveEditorPrefs(next);
    setEditorColors({ title, subtitle, body });
    onClose(true);
  };

  // 취소 — 저장·적용·배경 갱신 없이 닫기만(applied=false).
  const cancel = () => onClose(false);

  // 기본값 — 폼 색 + 날짜형식을 DEFAULT_EDITOR_PREFS로 리셋(end는 폼에 없어 건드리지 않음). 저장은 '적용' 시.
  const reset = () => {
    const d = DEFAULT_EDITOR_PREFS.colors;
    setColors((c) => ({
      ...c, title: d.title, subtitle: d.subtitle, body: d.body, background: d.background,
    }));
    setDateFormat(DEFAULT_EDITOR_PREFS.dateFormat);
    setAutosave(DEFAULT_EDITOR_PREFS.autosave);
  };

  return (
    <div className="yh-modal__backdrop" onMouseDown={cancel}>
      <div
        className="yh-modal yh-prefs"
        role="dialog"
        aria-label="환경설정"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <h2 className="yh-prefs__title">환경설정</h2>

        <div className="yh-tabs yh-prefs__tabs">
          {PREF_TABS.map((t) => (
            <button
              key={t.key}
              type="button"
              className={`yh-tab ${tab === t.key ? 'yh-tab--active' : ''}`}
              data-testid={`prefs-tab-${t.key}`}
              onClick={() => setTab(t.key)}
            >
              {t.label}
            </button>
          ))}
        </div>

        {tab === 'colors' && (
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
        )}

        {tab === 'autosave' && (
          <div className="yh-prefs__fields">
            <div className="yh-field">
              <label htmlFor="pref-autosave-enabled">사용</label>
              <input
                id="pref-autosave-enabled"
                data-testid="pref-autosave-enabled"
                type="checkbox"
                checked={autosave.enabled}
                onChange={(e) => setAutosave((a) => ({ ...a, enabled: e.target.checked }))}
              />
            </div>
            <div className="yh-field">
              <label htmlFor="pref-autosave-interval">저장 간격</label>
              <select
                id="pref-autosave-interval"
                data-testid="pref-autosave-interval"
                value={autosave.intervalSec}
                onChange={(e) => setAutosave((a) => ({ ...a, intervalSec: e.target.value }))}
              >
                {AUTOSAVE_INTERVALS.map(({ sec, label }) => (
                  <option key={sec} value={sec}>{label}</option>
                ))}
              </select>
            </div>
            <div className="yh-field">
              <label htmlFor="pref-autosave-retention">보존 기한</label>
              <select
                id="pref-autosave-retention"
                data-testid="pref-autosave-retention"
                value={autosave.retentionDays}
                onChange={(e) => setAutosave((a) => ({ ...a, retentionDays: e.target.value }))}
              >
                {AUTOSAVE_RETENTIONS.map((d) => (
                  <option key={d} value={d}>{`${d}일`}</option>
                ))}
              </select>
            </div>
          </div>
        )}

        {tab === 'dateFormat' && (
          <div className="yh-prefs__fields">
            <div className="yh-field">
              <label htmlFor="pref-dateFormat">날짜형식</label>
              <select
                id="pref-dateFormat"
                data-testid="pref-dateFormat"
                value={dateFormat}
                onChange={(e) => setDateFormat(e.target.value)}
              >
                {DATE_FORMATS.map((f) => <option key={f} value={f}>{f}</option>)}
              </select>
            </div>
          </div>
        )}

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
