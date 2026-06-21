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
});
