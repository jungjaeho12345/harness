import { describe, it, expect, beforeEach } from 'vitest';
import {
  DEFAULT_EDITOR_PREFS, loadEditorPrefs, saveEditorPrefs, setEditorPref,
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
    expect(edit.dragDrop).toBe(false); // news.md L186 기본 off 못박음
    expect(edit.noCommonAbbr).toBe(false);
    expect(edit.companyCode).toBe('manual');
    expect(edit.language).toBe('ko');
    expect(edit.lineSpacing).toBe(1.0);
    expect(edit.inputMode).toBe('unicode');
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
    expect(prefs.edit.dragDrop).toBe(false); // 나머지 edit 키는 기본값 유지
    expect(prefs.edit.language).toBe('ko');
    expect(prefs.edit.inputMode).toBe('unicode');
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
});
