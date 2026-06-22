// 에디터 환경설정 모달 — 색상(phase 11) + 날짜형식(phase 12) + 자동저장(phase 13) + 바이라인(phase 15) 탭.
// '적용' = 영속(saveEditorPrefs: 색·자동저장·바이라인·날짜형식 함께) + 텍스트색 적용(setEditorColors) + onClose(true) → 부모가 배경 적용·Editor 재렌더.
// 날짜형식은 조회페이지(ListPage)가 마운트 시 setDateFormat으로 적용하므로 여기서는 저장만 한다(저장+적용 분리).
// 바이라인(email/blog 사용여부+값)은 localStorage 전용 — 상세보기 출력 결선은 후속 step.
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

// 환경설정 탭 — 편집/색상/자동저장/바이라인/날짜형식/맞춤법. (순서는 news.md 환경설정 순서를 따른다.)
const PREF_TABS = [
  { key: 'edit', label: '편집' },
  { key: 'colors', label: '색상' },
  { key: 'autosave', label: '자동저장' },
  { key: 'byline', label: '바이라인' },
  { key: 'dateFormat', label: '날짜형식' },
  { key: 'spellcheck', label: '맞춤법' },
];

// 편집 탭 — 언어 9종(news.md L190). value=enum 코드(store edit.language 허용값), label=한국어 표시.
const EDIT_LANGUAGES = [
  { value: 'ko', label: '한글' },
  { value: 'en', label: '영어' },
  { value: 'ja', label: '일어' },
  { value: 'zh', label: '중국어' },
  { value: 'es', label: '스페인' },
  { value: 'fr', label: '프랑스' },
  { value: 'ar', label: '아랍어' },
  { value: 'vi', label: '베트남' },
  { value: 'ru', label: '러시아어' },
];

// 편집 탭 — 줄간격 옵션(news.md L191). value=문자열, 저장 시 Number()로 변환.
const EDIT_LINE_SPACINGS = [1.0, 1.2, 1.5, 1.8, 2.0];

// 편집 탭 — 기업코드(수동/자동) · 입력모드(KSC-5601/Unicode) select 옵션.
const EDIT_COMPANY_CODES = [
  { value: 'manual', label: '수동' },
  { value: 'auto', label: '자동' },
];
const EDIT_INPUT_MODES = [
  { value: 'ksc5601', label: 'KSC-5601' },
  { value: 'unicode', label: 'Unicode' },
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

// 맞춤법 탭 — 검사옵션 5종(news.md L211, 단일 enum). value=store spellcheck.checkOption 허용값, label=한국어 표시.
const SPELLCHECK_OPTIONS = [
  { value: 'procedure', label: '절차오류' },
  { value: 'spacing', label: '띄어쓰기' },
  { value: 'joining', label: '붙여쓰기' },
  { value: 'spacingJoining', label: '띄어쓰기+붙여쓰기' },
  { value: 'circularLoan', label: '순환용어·외래어' },
];

// 맞춤법 탭 — 오류유형 6종(news.md L212, 다중 bool). key=store spellcheck.errorTypes 키.
const SPELLCHECK_ERROR_TYPES = [
  { key: 'misuse', label: '오용어' },
  { key: 'multiWord', label: '다수어절' },
  { key: 'semantic', label: '의미문체' },
  { key: 'circular', label: '순환용어' },
  { key: 'statSpacing', label: '통계붙여쓰기' },
  { key: 'others', label: '그외' },
];

// 맞춤법 탭 — 오류표현 2종(news.md L213, enum). value=store spellcheck.errorStyle 허용값.
const SPELLCHECK_ERROR_STYLES = [
  { value: 'bold', label: '굵게' },
  { value: 'underline', label: '밑줄' },
];

export function EditorPrefsDialog({ open, onClose }) {
  // 활성 탭(색상이 기본). 폼 상태(colors/dateFormat)는 모달 레벨에 둬 탭 전환해도 미적용 값이 보존된다.
  const [tab, setTab] = useState('colors');
  const [colors, setColors] = useState(() => loadEditorPrefs().colors);
  const [dateFormat, setDateFormat] = useState(() => loadEditorPrefs().dateFormat);
  const [autosave, setAutosave] = useState(() => loadEditorPrefs().autosave);
  const [byline, setByline] = useState(() => loadEditorPrefs().byline);
  const [edit, setEdit] = useState(() => loadEditorPrefs().edit);
  const [spellcheck, setSpellcheck] = useState(() => loadEditorPrefs().spellcheck);

  // 다시 열릴 때마다 저장값으로 폼을 재초기화한다(이전 미적용 편집/적용 결과가 다음 열림에 반영되도록).
  useEffect(() => {
    if (open) {
      const prefs = loadEditorPrefs();
      setColors(prefs.colors);
      setDateFormat(prefs.dateFormat);
      setAutosave(prefs.autosave);
      setByline(prefs.byline);
      setEdit(prefs.edit);
      setSpellcheck(prefs.spellcheck);
    }
  }, [open]);

  if (!open) return null;

  const setColor = (key, value) => setColors((c) => ({ ...c, [key]: value }));

  // 적용 — 색·자동저장·바이라인을 함께 영속(saveEditorPrefs) + 텍스트색 적용(setEditorColors, background 제외) + applied=true로 닫기.
  // 날짜형식은 writer 화면에 즉시 보일 대상이 없어 setDateFormat을 부르지 않는다(ListPage가 마운트 시 적용).
  const apply = () => {
    const {
      title, subtitle, body, background,
    } = colors;
    const { enabled, intervalSec, retentionDays } = autosave;
    const {
      email, emailValue, blog, blogValue,
    } = byline;
    const {
      columnLimit, dragDrop, noCommonAbbr, companyCode, language, lineSpacing, inputMode,
    } = edit;
    const { checkOption, errorTypes, errorStyle } = spellcheck;
    // colors + autosave + byline + edit + spellcheck를 setEditorPref로 합성하고 dateFormat은 spread로 보존
    // (loadEditorPrefs() base spread로 glyph 등 미합성 카테고리도 함께 보존된다 — 상호 보존 못박음).
    // errorTypes는 6키 객체 전체를 통째로 넘긴다(setEditorPref 한 단계 병합이라 부분만 넘기면 나머지 키 손실).
    const next = {
      ...setEditorPref(
        setEditorPref(
          setEditorPref(
            setEditorPref(
              setEditorPref(loadEditorPrefs(), 'colors', {
                title, subtitle, body, background,
              }),
              'autosave',
              { enabled, intervalSec: Number(intervalSec), retentionDays: Number(retentionDays) },
            ),
            'byline',
            {
              email, emailValue, blog, blogValue,
            },
          ),
          'edit',
          {
            columnLimit,
            dragDrop,
            noCommonAbbr,
            companyCode,
            language,
            lineSpacing: Number(lineSpacing),
            inputMode,
          },
        ),
        'spellcheck',
        { checkOption, errorTypes, errorStyle },
      ),
      dateFormat,
    };
    saveEditorPrefs(next);
    setEditorColors({ title, subtitle, body });
    onClose(true);
  };

  // 취소 — 저장·적용·배경 갱신 없이 닫기만(applied=false).
  const cancel = () => onClose(false);

  // 기본값 — 폼 색 + 날짜형식 + 자동저장 + 바이라인을 DEFAULT_EDITOR_PREFS로 리셋(end는 폼에 없어 건드리지 않음). 저장은 '적용' 시.
  const reset = () => {
    const d = DEFAULT_EDITOR_PREFS.colors;
    setColors((c) => ({
      ...c, title: d.title, subtitle: d.subtitle, body: d.body, background: d.background,
    }));
    setDateFormat(DEFAULT_EDITOR_PREFS.dateFormat);
    setAutosave(DEFAULT_EDITOR_PREFS.autosave);
    setByline(DEFAULT_EDITOR_PREFS.byline);
    setEdit(DEFAULT_EDITOR_PREFS.edit);
    setSpellcheck(DEFAULT_EDITOR_PREFS.spellcheck);
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

        {tab === 'edit' && (
          <div className="yh-prefs__fields">
            <div className="yh-field">
              <label htmlFor="pref-edit-columnLimit">컬럼제한</label>
              <input
                id="pref-edit-columnLimit"
                data-testid="pref-edit-columnLimit"
                type="checkbox"
                checked={edit.columnLimit}
                onChange={(e) => setEdit((s) => ({ ...s, columnLimit: e.target.checked }))}
              />
            </div>
            <div className="yh-field">
              <label htmlFor="pref-edit-dragDrop">드래그앤드롭</label>
              <input
                id="pref-edit-dragDrop"
                data-testid="pref-edit-dragDrop"
                type="checkbox"
                checked={edit.dragDrop}
                onChange={(e) => setEdit((s) => ({ ...s, dragDrop: e.target.checked }))}
              />
            </div>
            <div className="yh-field">
              <label htmlFor="pref-edit-noCommonAbbr">공용약어 사용안함</label>
              <input
                id="pref-edit-noCommonAbbr"
                data-testid="pref-edit-noCommonAbbr"
                type="checkbox"
                checked={edit.noCommonAbbr}
                onChange={(e) => setEdit((s) => ({ ...s, noCommonAbbr: e.target.checked }))}
              />
            </div>
            <div className="yh-field">
              <label htmlFor="pref-edit-companyCode">기업코드</label>
              <select
                id="pref-edit-companyCode"
                data-testid="pref-edit-companyCode"
                value={edit.companyCode}
                onChange={(e) => setEdit((s) => ({ ...s, companyCode: e.target.value }))}
              >
                {EDIT_COMPANY_CODES.map(({ value, label }) => (
                  <option key={value} value={value}>{label}</option>
                ))}
              </select>
            </div>
            <div className="yh-field">
              <label htmlFor="pref-edit-language">언어</label>
              <select
                id="pref-edit-language"
                data-testid="pref-edit-language"
                value={edit.language}
                onChange={(e) => setEdit((s) => ({ ...s, language: e.target.value }))}
              >
                {EDIT_LANGUAGES.map(({ value, label }) => (
                  <option key={value} value={value}>{label}</option>
                ))}
              </select>
            </div>
            <div className="yh-field">
              <label htmlFor="pref-edit-lineSpacing">줄간격</label>
              <select
                id="pref-edit-lineSpacing"
                data-testid="pref-edit-lineSpacing"
                value={edit.lineSpacing}
                onChange={(e) => setEdit((s) => ({ ...s, lineSpacing: e.target.value }))}
              >
                {EDIT_LINE_SPACINGS.map((v) => (
                  <option key={v} value={v}>{v.toFixed(1)}</option>
                ))}
              </select>
            </div>
            <div className="yh-field">
              <label htmlFor="pref-edit-inputMode">입력모드</label>
              <select
                id="pref-edit-inputMode"
                data-testid="pref-edit-inputMode"
                value={edit.inputMode}
                onChange={(e) => setEdit((s) => ({ ...s, inputMode: e.target.value }))}
              >
                {EDIT_INPUT_MODES.map(({ value, label }) => (
                  <option key={value} value={value}>{label}</option>
                ))}
              </select>
            </div>
          </div>
        )}

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

        {tab === 'byline' && (
          <div className="yh-prefs__fields">
            <div className="yh-field">
              <label htmlFor="pref-byline-email">E-MAIL 사용</label>
              <input
                id="pref-byline-email"
                data-testid="pref-byline-email"
                type="checkbox"
                checked={byline.email}
                onChange={(e) => setByline((b) => ({ ...b, email: e.target.checked }))}
              />
            </div>
            <div className="yh-field">
              <label htmlFor="pref-byline-emailValue">E-MAIL</label>
              <input
                id="pref-byline-emailValue"
                data-testid="pref-byline-emailValue"
                type="text"
                value={byline.emailValue}
                onChange={(e) => setByline((b) => ({ ...b, emailValue: e.target.value }))}
              />
            </div>
            <div className="yh-field">
              <label htmlFor="pref-byline-blog">Blog 사용</label>
              <input
                id="pref-byline-blog"
                data-testid="pref-byline-blog"
                type="checkbox"
                checked={byline.blog}
                onChange={(e) => setByline((b) => ({ ...b, blog: e.target.checked }))}
              />
            </div>
            <div className="yh-field">
              <label htmlFor="pref-byline-blogValue">Blog</label>
              <input
                id="pref-byline-blogValue"
                data-testid="pref-byline-blogValue"
                type="text"
                value={byline.blogValue}
                onChange={(e) => setByline((b) => ({ ...b, blogValue: e.target.value }))}
              />
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

        {tab === 'spellcheck' && (
          <div className="yh-prefs__fields">
            <div className="yh-field">
              <label htmlFor="pref-spellcheck-checkOption">검사옵션</label>
              <select
                id="pref-spellcheck-checkOption"
                data-testid="pref-spellcheck-checkOption"
                value={spellcheck.checkOption}
                onChange={(e) => setSpellcheck((s) => ({ ...s, checkOption: e.target.value }))}
              >
                {SPELLCHECK_OPTIONS.map(({ value, label }) => (
                  <option key={value} value={value}>{label}</option>
                ))}
              </select>
            </div>
            {SPELLCHECK_ERROR_TYPES.map(({ key, label }) => (
              <div className="yh-field" key={key}>
                <label htmlFor={`pref-spellcheck-errorType-${key}`}>{label}</label>
                <input
                  id={`pref-spellcheck-errorType-${key}`}
                  data-testid={`pref-spellcheck-errorType-${key}`}
                  type="checkbox"
                  checked={spellcheck.errorTypes[key]}
                  onChange={(e) => setSpellcheck((s) => ({
                    ...s, errorTypes: { ...s.errorTypes, [key]: e.target.checked },
                  }))}
                />
              </div>
            ))}
            <div className="yh-field">
              <label htmlFor="pref-spellcheck-errorStyle">오류표현</label>
              <select
                id="pref-spellcheck-errorStyle"
                data-testid="pref-spellcheck-errorStyle"
                value={spellcheck.errorStyle}
                onChange={(e) => setSpellcheck((s) => ({ ...s, errorStyle: e.target.value }))}
              >
                {SPELLCHECK_ERROR_STYLES.map(({ value, label }) => (
                  <option key={value} value={value}>{label}</option>
                ))}
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
