import { describe, it, expect, beforeEach } from 'vitest';
import {
  saveDraft, loadDraft, clearDraft, expireDrafts,
} from './editorDraft.js';

const DAY = 86400000;

// 초안 자동저장 저장소(localStorage) — key별 { data, savedAt }. 시간은 인자(nowMs)로 받는 순수 모듈.
// editorPrefs/columnConfig와 동일한 graceful 패턴. 타이머/복구 결선은 Step 1.
describe('editorDraft — 초안 자동저장 저장소', () => {
  beforeEach(() => { localStorage.clear(); });

  it('saveDraft 후 loadDraft가 같은 data를 반환한다(없는 key는 null)', () => {
    saveDraft('a', { title: 't' }, 1000);
    expect(loadDraft('a')).toEqual({ title: 't' });
    expect(loadDraft('none')).toBeNull();
  });

  it('여러 key의 초안을 독립적으로 보존한다', () => {
    saveDraft('a', { title: 'A' }, 1000);
    saveDraft('b', { title: 'B' }, 2000);
    expect(loadDraft('a')).toEqual({ title: 'A' });
    expect(loadDraft('b')).toEqual({ title: 'B' });
  });

  it('같은 key를 다시 저장하면 최신 data로 덮어쓴다', () => {
    saveDraft('a', { title: 'old' }, 1000);
    saveDraft('a', { title: 'new' }, 2000);
    expect(loadDraft('a')).toEqual({ title: 'new' });
  });

  it('clearDraft 후 그 key는 null(다른 key는 보존)', () => {
    saveDraft('a', { title: 't' }, 1000);
    saveDraft('b', { title: 'u' }, 1000);
    clearDraft('a');
    expect(loadDraft('a')).toBeNull();
    expect(loadDraft('b')).toEqual({ title: 'u' });
  });

  it('expireDrafts는 보존 기한이 지난 초안만 제거한다', () => {
    saveDraft('old', { title: 'O' }, 1000);
    saveDraft('fresh', { title: 'F' }, 1000 + DAY); // 1일 뒤 저장
    // 기준 시각: old 저장 후 2일. 보존 1일 → old(2일 경과)는 제거, fresh(1일 경과)는 유지.
    expireDrafts(1, 1000 + 2 * DAY);
    expect(loadDraft('old')).toBeNull();
    expect(loadDraft('fresh')).toEqual({ title: 'F' });
  });

  it('expireDrafts 경계: 정확히 보존 기한이면 유지한다(< nowMs - retention만 제거)', () => {
    saveDraft('edge', { title: 'E' }, 1000);
    expireDrafts(1, 1000 + DAY); // 경과 == 보존 → 제거 안 함
    expect(loadDraft('edge')).toEqual({ title: 'E' });
  });

  it('localStorage가 막혀도(throw) save/load/clear/expire가 예외 없이 동작한다', () => {
    const original = globalThis.localStorage;
    try {
      Object.defineProperty(globalThis, 'localStorage', {
        configurable: true,
        get() { throw new Error('localStorage blocked'); },
      });
      expect(() => saveDraft('a', { title: 't' }, 1000)).not.toThrow();
      expect(loadDraft('a')).toBeNull();
      expect(() => clearDraft('a')).not.toThrow();
      expect(() => expireDrafts(1, 9_999_999_999)).not.toThrow();
    } finally {
      Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: original });
    }
  });
});
