import { describe, it, expect, beforeEach } from 'vitest';
import {
  DEFAULT_EDITOR_PREFS, loadEditorPrefs, saveEditorPrefs, setEditorPref, normalizeLineSpacing,
  fontFamilyCss, fontSizeCss,
} from './editorPrefs.js';
import { COLORS } from './editorColoring.js';

describe('editorPrefs — editor preference store', () => {
  beforeEach(() => { localStorage.clear(); });

  it('color defaults match editorColoring.COLORS (+ background)', () => {
    expect(DEFAULT_EDITOR_PREFS.colors.title).toBe(COLORS.title);
    expect(DEFAULT_EDITOR_PREFS.colors.subtitle).toBe(COLORS.subtitle);
    expect(DEFAULT_EDITOR_PREFS.colors.body).toBe(COLORS.body);
    expect(DEFAULT_EDITOR_PREFS.colors.end).toBe(COLORS.end);
    expect(DEFAULT_EDITOR_PREFS.colors.background).toBe('#ffffff');
  });

  it('returns defaults when nothing is saved', () => {
    const prefs = loadEditorPrefs();
    expect(prefs.colors).toEqual(DEFAULT_EDITOR_PREFS.colors);
    expect(prefs.autosave).toEqual(DEFAULT_EDITOR_PREFS.autosave);
    expect(prefs.byline).toEqual(DEFAULT_EDITOR_PREFS.byline);
    expect(prefs.dateFormat).toBe(DEFAULT_EDITOR_PREFS.dateFormat);
  });

  it('merges a partial save onto defaults (category-level)', () => {
    localStorage.setItem('yh.editorPrefs', JSON.stringify({ colors: { subtitle: '#000000' } }));
    const prefs = loadEditorPrefs();
    expect(prefs.colors.subtitle).toBe('#000000'); // 저장값 적용
    expect(prefs.colors.title).toBe(DEFAULT_EDITOR_PREFS.colors.title); // 나머지는 기본값 유지
    expect(prefs.autosave).toEqual(DEFAULT_EDITOR_PREFS.autosave); // 저장 안 한 카테고리도 기본값
  });

  it('save → load round-trips values', () => {
    const next = setEditorPref(loadEditorPrefs(), 'autosave', { enabled: true, intervalSec: 120 });
    saveEditorPrefs(next);
    const loaded = loadEditorPrefs();
    expect(loaded.autosave.enabled).toBe(true);
    expect(loaded.autosave.intervalSec).toBe(120);
    expect(loaded.autosave.retentionDays).toBe(DEFAULT_EDITOR_PREFS.autosave.retentionDays);
  });

  it('setEditorPref returns a new object and does not mutate input', () => {
    const prefs = loadEditorPrefs();
    const next = setEditorPref(prefs, 'colors', { body: '#222' });
    expect(next.colors.body).toBe('#222');
    expect(next).not.toBe(prefs);
    expect(next.colors).not.toBe(prefs.colors);
    expect(prefs.colors.body).toBe(DEFAULT_EDITOR_PREFS.colors.body); // 원본 불변
  });

  it('setEditorPref ignores an unknown category (no change)', () => {
    const prefs = loadEditorPrefs();
    const next = setEditorPref(prefs, 'nope', { x: 1 });
    expect(next).toEqual(prefs);
  });

  it('saveEditorPrefs returns the prefs it was given', () => {
    const prefs = loadEditorPrefs();
    expect(saveEditorPrefs(prefs)).toBe(prefs);
  });

  it('is graceful when localStorage is unavailable (no throw, defaults/no-op)', () => {
    const original = globalThis.localStorage;
    try {
      Object.defineProperty(globalThis, 'localStorage', {
        configurable: true,
        get() { throw new Error('localStorage blocked'); },
      });
      expect(() => loadEditorPrefs()).not.toThrow();
      expect(loadEditorPrefs().colors).toEqual(DEFAULT_EDITOR_PREFS.colors);
      expect(() => saveEditorPrefs(DEFAULT_EDITOR_PREFS)).not.toThrow();
    } finally {
      Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: original });
    }
  });

  // --- 신규 카테고리 4종 (edit / spellcheck / glyphFavorites / glyphKeymap) ---

  it('returns edit defaults when nothing is saved', () => {
    const { edit } = loadEditorPrefs();
    expect(edit).toEqual(DEFAULT_EDITOR_PREFS.edit);
    expect(edit.columnLimit).toBe(false);
    expect(edit.dragDrop).toBe(true); // news.md L193 "기본값은 된다" — 기본 on 못박음
    expect(edit.noCommonAbbr).toBe(false);
    expect(edit.companyCode).toBe('manual');
    expect(edit.language).toBe('ko');
    expect(edit.lineSpacing).toBe(1.8); // base = CSS line-height 1.8 (기본 시각 회귀 방지)
    expect(edit.inputMode).toBe('unicode');
    expect(edit.editorFont).toBe('기본'); // sentinel '기본' = override 없음 (바이트 동일 회귀 방지)
    expect(edit.editorFontSize).toBe('기본');
  });

  it('returns spellcheck defaults when nothing is saved', () => {
    const { spellcheck } = loadEditorPrefs();
    expect(spellcheck).toEqual(DEFAULT_EDITOR_PREFS.spellcheck);
    expect(spellcheck.checkOption).toBe('spacing');
    expect(spellcheck.errorStyle).toBe('bold');
    expect(spellcheck.errorTypes).toEqual({
      misuse: false, multiWord: false, semantic: false, circular: false, statSpacing: false, others: false,
    });
    expect(spellcheck.errorTypes.misuse).toBe(false);
  });

  it('returns glyphFavorites / glyphKeymap defaults (empty item lists) when nothing is saved', () => {
    const { glyphFavorites, glyphKeymap } = loadEditorPrefs();
    expect(glyphFavorites).toEqual({ items: [] });
    expect(Array.isArray(glyphFavorites.items)).toBe(true);
    expect(glyphFavorites.items).toHaveLength(0);
    expect(glyphKeymap).toEqual({ items: [] });
    expect(Array.isArray(glyphKeymap.items)).toBe(true);
    expect(glyphKeymap.items).toHaveLength(0);
  });

  it('merges a partial edit save onto defaults (category-level, one-deep)', () => {
    localStorage.setItem('yh.editorPrefs', JSON.stringify({ edit: { columnLimit: true } }));
    const prefs = loadEditorPrefs();
    expect(prefs.edit.columnLimit).toBe(true); // 저장값 적용
    expect(prefs.edit.dragDrop).toBe(true); // 나머지 edit 키는 기본값 유지
    expect(prefs.edit.language).toBe('ko');
    expect(prefs.edit.inputMode).toBe('unicode');
    expect(prefs.edit.editorFont).toBe('기본'); // 새 additive 키도 기본값으로 병합(1단계 병합 회귀)
    expect(prefs.edit.editorFontSize).toBe('기본');
    expect(prefs.colors).toEqual(DEFAULT_EDITOR_PREFS.colors); // 저장 안 한 카테고리도 기본값
  });

  it('edit save → load round-trips values', () => {
    const next = setEditorPref(loadEditorPrefs(), 'edit', { language: 'ja', lineSpacing: 1.5 });
    saveEditorPrefs(next);
    const loaded = loadEditorPrefs();
    expect(loaded.edit.language).toBe('ja');
    expect(loaded.edit.lineSpacing).toBe(1.5);
    expect(loaded.edit.companyCode).toBe(DEFAULT_EDITOR_PREFS.edit.companyCode);
  });

  it('setEditorPref on spellcheck returns a new object and does not mutate input', () => {
    const prefs = loadEditorPrefs();
    const next = setEditorPref(prefs, 'spellcheck', { errorStyle: 'underline' });
    expect(next.spellcheck.errorStyle).toBe('underline');
    expect(next).not.toBe(prefs);
    expect(next.spellcheck).not.toBe(prefs.spellcheck);
    expect(prefs.spellcheck.errorStyle).toBe(DEFAULT_EDITOR_PREFS.spellcheck.errorStyle); // 원본 불변
  });

  it('is graceful for new categories when localStorage is unavailable', () => {
    const original = globalThis.localStorage;
    try {
      Object.defineProperty(globalThis, 'localStorage', {
        configurable: true,
        get() { throw new Error('localStorage blocked'); },
      });
      expect(() => loadEditorPrefs()).not.toThrow();
      expect(loadEditorPrefs().edit).toEqual(DEFAULT_EDITOR_PREFS.edit);
      expect(loadEditorPrefs().spellcheck).toEqual(DEFAULT_EDITOR_PREFS.spellcheck);
      expect(loadEditorPrefs().glyphFavorites).toEqual(DEFAULT_EDITOR_PREFS.glyphFavorites);
      expect(loadEditorPrefs().glyphKeymap).toEqual(DEFAULT_EDITOR_PREFS.glyphKeymap);
    } finally {
      Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: original });
    }
  });

  // --- ui 카테고리 (UI 언어 ko/en) — edit.language(문서 언어 9종)와 별개의 additive 신규 키 ---

  it('returns ui.language default "ko" when nothing is saved', () => {
    const { ui } = loadEditorPrefs();
    expect(ui).toEqual(DEFAULT_EDITOR_PREFS.ui);
    expect(ui.language).toBe('ko');
  });

  it('ui.language save → load round-trips to "en"', () => {
    const next = setEditorPref(loadEditorPrefs(), 'ui', { language: 'en' });
    saveEditorPrefs(next);
    const loaded = loadEditorPrefs();
    expect(loaded.ui.language).toBe('en');
  });

  it('ui category is separate from edit.language (문서 언어) — patching ui does not touch edit', () => {
    const next = setEditorPref(loadEditorPrefs(), 'ui', { language: 'en' });
    saveEditorPrefs(next);
    const loaded = loadEditorPrefs();
    expect(loaded.ui.language).toBe('en');
    expect(loaded.edit.language).toBe('ko'); // 문서 언어는 불변
  });

  it('merges a partial ui save onto defaults and preserves other categories', () => {
    localStorage.setItem('yh.editorPrefs', JSON.stringify({ ui: { language: 'en' } }));
    const prefs = loadEditorPrefs();
    expect(prefs.ui.language).toBe('en'); // 저장값 적용
    expect(prefs.colors).toEqual(DEFAULT_EDITOR_PREFS.colors); // 저장 안 한 카테고리도 기본값
    expect(prefs.edit).toEqual(DEFAULT_EDITOR_PREFS.edit); // edit 카테고리 불변
  });

  it('is graceful for ui category when localStorage is unavailable', () => {
    const original = globalThis.localStorage;
    try {
      Object.defineProperty(globalThis, 'localStorage', {
        configurable: true,
        get() { throw new Error('localStorage blocked'); },
      });
      expect(() => loadEditorPrefs()).not.toThrow();
      expect(loadEditorPrefs().ui).toEqual(DEFAULT_EDITOR_PREFS.ui);
    } finally {
      Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: original });
    }
  });

  // --- 회귀: setEditorPref 합성 보존 (한 카테고리 패치가 다른 카테고리를 잃지 않는다) ---

  it('setEditorPref preserves all other categories on a save → load round-trip (synthesis preservation)', () => {
    // 신규 edit 카테고리만 패치해 저장해도 기존 4탭(colors/autosave/byline/dateFormat) + 나머지 신규 카테고리가 보존돼야 한다.
    const next = setEditorPref(loadEditorPrefs(), 'edit', { language: 'ja' });
    saveEditorPrefs(next);
    const loaded = loadEditorPrefs();
    // 패치한 카테고리
    expect(loaded.edit.language).toBe('ja');
    // 기존 4탭 전부 기본값 보존
    expect(loaded.colors).toEqual(DEFAULT_EDITOR_PREFS.colors);
    expect(loaded.colors.subtitle).toBe('#c8102e'); // 부제목 빨강 기본 불변
    expect(loaded.autosave).toEqual(DEFAULT_EDITOR_PREFS.autosave);
    expect(loaded.byline).toEqual(DEFAULT_EDITOR_PREFS.byline);
    expect(loaded.dateFormat).toBe(DEFAULT_EDITOR_PREFS.dateFormat);
    // 패치하지 않은 신규 카테고리도 보존
    expect(loaded.spellcheck).toEqual(DEFAULT_EDITOR_PREFS.spellcheck);
    expect(loaded.glyphFavorites).toEqual(DEFAULT_EDITOR_PREFS.glyphFavorites);
    expect(loaded.glyphKeymap).toEqual(DEFAULT_EDITOR_PREFS.glyphKeymap);
  });

  it('consecutive setEditorPref patches across categories accumulate without dropping earlier ones', () => {
    // 색상(기존) → edit(신규) → spellcheck(신규) 연속 패치 후 셋 다 보존되는지(합성 누적).
    let prefs = loadEditorPrefs();
    prefs = setEditorPref(prefs, 'colors', { body: '#222222' });
    prefs = setEditorPref(prefs, 'edit', { columnLimit: true });
    prefs = setEditorPref(prefs, 'spellcheck', { errorStyle: 'underline' });
    saveEditorPrefs(prefs);
    const loaded = loadEditorPrefs();
    expect(loaded.colors.body).toBe('#222222');
    expect(loaded.colors.title).toBe(DEFAULT_EDITOR_PREFS.colors.title); // 같은 카테고리 다른 키 보존
    expect(loaded.edit.columnLimit).toBe(true);
    expect(loaded.spellcheck.errorStyle).toBe('underline');
    expect(loaded.spellcheck.checkOption).toBe('spacing'); // 같은 카테고리 다른 키 보존
  });

  // --- glyph 카테고리 items 라운드트립 (step3가 쓸 실제 페이로드) ---

  it('glyphFavorites / glyphKeymap items round-trip through save → load', () => {
    let prefs = loadEditorPrefs();
    prefs = setEditorPref(prefs, 'glyphFavorites', { items: ['℃', '㎡'] });
    prefs = setEditorPref(prefs, 'glyphKeymap', { items: [{ keys: 'ctrl+1', glyph: '①' }] });
    saveEditorPrefs(prefs);
    const loaded = loadEditorPrefs();
    expect(loaded.glyphFavorites.items).toEqual(['℃', '㎡']);
    expect(loaded.glyphKeymap.items).toEqual([{ keys: 'ctrl+1', glyph: '①' }]);
  });

  // --- 한 단계(얕은) 병합 경계: 깊은 병합을 도입하지 않았음을 못박는다 (의도된 설계) ---

  it('does NOT deep-merge nested errorTypes — a saved errorTypes object replaces the default wholesale', () => {
    // 저장값이 errorTypes의 일부 키만 가질 때, 한 단계 병합은 그 객체로 통째 대체한다(깊은 병합 아님).
    // step2가 항상 errorTypes 전체를 저장하므로 부분 손실은 없지만, 깊은 병합 회귀를 막기 위해 경계 동작을 고정한다.
    localStorage.setItem('yh.editorPrefs', JSON.stringify({ spellcheck: { errorTypes: { misuse: true } } }));
    const { spellcheck } = loadEditorPrefs();
    expect(spellcheck.errorTypes).toEqual({ misuse: true }); // wholesale 대체 — others 등 기본 키는 합쳐지지 않음
    expect(spellcheck.errorTypes.others).toBeUndefined();
    expect(spellcheck.checkOption).toBe('spacing'); // 같은 카테고리의 다른 키는 한 단계 병합으로 기본값 유지
    expect(spellcheck.errorStyle).toBe('bold');
  });

  it('does NOT deep-merge glyph items — a saved items array replaces the default wholesale', () => {
    localStorage.setItem('yh.editorPrefs', JSON.stringify({ glyphFavorites: { items: ['α'] } }));
    const { glyphFavorites } = loadEditorPrefs();
    expect(glyphFavorites.items).toEqual(['α']); // 기본 [] 와 합쳐지지 않고 대체
  });

  // --- autosave 정규화: 손상된 저장값이 setInterval 타이트 루프/즉시 만료를 일으키지 않게 안전 범위로 폴백 ---
  // (WriterPage 자동저장 effect가 intervalSec*1000을 그대로 setInterval에 넘기므로 0·음수·NaN이면 성능/저장소 파괴.)

  it('normalizes autosave.intervalSec: 0 to a finite positive number (no setInterval tight loop)', () => {
    localStorage.setItem('yh.editorPrefs', JSON.stringify({ autosave: { intervalSec: 0 } }));
    const { autosave } = loadEditorPrefs();
    expect(Number.isFinite(autosave.intervalSec)).toBe(true);
    expect(autosave.intervalSec).toBeGreaterThan(0);
    expect(autosave.intervalSec).toBe(DEFAULT_EDITOR_PREFS.autosave.intervalSec); // 기본값 60 폴백
  });

  it('normalizes autosave.intervalSec: negative to a finite positive number', () => {
    localStorage.setItem('yh.editorPrefs', JSON.stringify({ autosave: { intervalSec: -5 } }));
    const { autosave } = loadEditorPrefs();
    expect(Number.isFinite(autosave.intervalSec)).toBe(true);
    expect(autosave.intervalSec).toBeGreaterThan(0);
  });

  it('normalizes autosave.intervalSec: non-numeric string to the positive default (never NaN)', () => {
    localStorage.setItem('yh.editorPrefs', JSON.stringify({ autosave: { intervalSec: 'abc' } }));
    const { autosave } = loadEditorPrefs();
    expect(Number.isFinite(autosave.intervalSec)).toBe(true);
    expect(autosave.intervalSec).toBe(DEFAULT_EDITOR_PREFS.autosave.intervalSec);
    expect(Number.isNaN(autosave.intervalSec * 1000)).toBe(false); // WriterPage가 곱하는 형태 그대로 가드
  });

  it('normalizes autosave.retentionDays: 0 / negative / non-numeric to a finite positive number', () => {
    for (const bad of [0, -1, 'x']) {
      localStorage.setItem('yh.editorPrefs', JSON.stringify({ autosave: { retentionDays: bad } }));
      const { autosave } = loadEditorPrefs();
      expect(Number.isFinite(autosave.retentionDays)).toBe(true);
      expect(autosave.retentionDays).toBeGreaterThan(0);
      expect(autosave.retentionDays).toBe(DEFAULT_EDITOR_PREFS.autosave.retentionDays); // 기본값 1 폴백
    }
  });

  it('normalizes autosave.enabled: non-boolean to a boolean (truthy string does not enable)', () => {
    localStorage.setItem('yh.editorPrefs', JSON.stringify({ autosave: { enabled: 'yes' } }));
    const { autosave } = loadEditorPrefs();
    expect(typeof autosave.enabled).toBe('boolean');
    expect(autosave.enabled).toBe(false); // === true 강제 — 비불리언은 기본값(false)
  });

  it('preserves valid saved autosave values untouched (no clobbering of user settings)', () => {
    localStorage.setItem('yh.editorPrefs', JSON.stringify({ autosave: { enabled: true, intervalSec: 120, retentionDays: 3 } }));
    const { autosave } = loadEditorPrefs();
    expect(autosave.enabled).toBe(true);
    expect(autosave.intervalSec).toBe(120);
    expect(autosave.retentionDays).toBe(3);
  });

  it('regression guard: empty save still yields autosave defaults and dateFormat validation is intact', () => {
    localStorage.setItem('yh.editorPrefs', JSON.stringify({}));
    const prefs = loadEditorPrefs();
    expect(prefs.autosave).toEqual(DEFAULT_EDITOR_PREFS.autosave);
    expect(prefs.dateFormat).toBe(DEFAULT_EDITOR_PREFS.dateFormat);
    // dateFormat 비문자열은 기존 검증대로 기본값 폴백(선례 유지)
    localStorage.setItem('yh.editorPrefs', JSON.stringify({ dateFormat: 42 }));
    expect(loadEditorPrefs().dateFormat).toBe(DEFAULT_EDITOR_PREFS.dateFormat);
  });

  // --- normalizeLineSpacing: 저장된 줄간격을 실제 line-height로 정규화 (소비 시점 전용) ---
  // 레거시 기본 sentinel(1.0)과 무효값(≤1.0·비유한)은 base(1.8)로, 유효 선택값(1.2/1.5/1.8/2.0)은 그대로 통과.

  it('normalizeLineSpacing: 레거시 기본 sentinel 1.0을 base 1.8로 정규화한다', () => {
    expect(normalizeLineSpacing(1.0)).toBe(1.8);
  });

  it('normalizeLineSpacing: 무효/비유한 입력(0·-1·NaN·undefined·문자열x)을 base 1.8로 폴백한다', () => {
    expect(normalizeLineSpacing(0)).toBe(1.8);
    expect(normalizeLineSpacing(-1)).toBe(1.8);
    expect(normalizeLineSpacing(NaN)).toBe(1.8);
    expect(normalizeLineSpacing(undefined)).toBe(1.8);
    expect(normalizeLineSpacing('x')).toBe(1.8);
  });

  it('normalizeLineSpacing: 유효 선택값 1.2/1.5/1.8/2.0은 그대로 통과한다', () => {
    expect(normalizeLineSpacing(1.2)).toBe(1.2);
    expect(normalizeLineSpacing(1.5)).toBe(1.5);
    expect(normalizeLineSpacing(1.8)).toBe(1.8);
    expect(normalizeLineSpacing(2.0)).toBe(2.0);
  });

  it("normalizeLineSpacing: 문자열 숫자('1.5')도 Number()로 받아 통과한다(dialog onChange가 문자열 저장)", () => {
    expect(normalizeLineSpacing('1.5')).toBe(1.5);
  });

  // --- fontFamilyCss / fontSizeCss: 저장된 글꼴/크기 선택값을 실제 CSS 문자열로 매핑 (소비 시점 전용) ---
  // sentinel '기본'과 미상/무효값은 null(override 없음 → CSS 변수 미주입 → fallback=현재값 렌더 = 바이트 동일).
  // 명명 폰트/수치만 실제 CSS 값을 반환한다(거짓 컨트롤 금지).

  it("fontFamilyCss: '기본'/미상/무효값은 null을 반환한다(override 없음 = 바이트 동일 회귀 가드)", () => {
    expect(fontFamilyCss('기본')).toBe(null);
    expect(fontFamilyCss(undefined)).toBe(null);
    expect(fontFamilyCss('없는값')).toBe(null);
  });

  it("fontFamilyCss: 명명 폰트('바탕'/'돋움'/'굴림')는 비어있지 않은 CSS font-family 스택을 반환한다", () => {
    for (const font of ['바탕', '돋움', '굴림']) {
      const css = fontFamilyCss(font);
      expect(typeof css).toBe('string');
      expect(css.length).toBeGreaterThan(0);
    }
  });

  it("fontSizeCss: '기본'/미상/무효값은 null을 반환한다(override 없음)", () => {
    expect(fontSizeCss('기본')).toBe(null);
    expect(fontSizeCss('없는값')).toBe(null);
    expect(fontSizeCss(0)).toBe(null);
    expect(fontSizeCss('x')).toBe(null);
  });

  it("fontSizeCss: 숫자 문자열은 '<n>px'로 매핑한다", () => {
    expect(fontSizeCss('10')).toBe('10px');
    expect(fontSizeCss('12')).toBe('12px');
    expect(fontSizeCss('14')).toBe('14px');
    expect(fontSizeCss('16')).toBe('16px');
  });
});
