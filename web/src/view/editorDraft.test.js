import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  saveDraft, loadDraft, clearDraft, expireDrafts, draftScopeId, draftKeyFor,
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

// 54-5: 초안 키 규약 — localStorage는 같은 출처의 모든 창이 공유하므로 신규 탭 키(tab-1, tab-2…)가 창 사이에서
// 충돌한다(서로 덮어쓰기·다른 문서 오복구·남의 초안 삭제). 브라우저 탭 스코프 id(sessionStorage 보관)를
// 신규 탭 키에만 접두사로 붙여 격리한다. 기존 기사 키(articleId)는 전역 고유라 그대로 쓴다.
describe('editorDraft — 초안 키 스코프(draftScopeId/draftKeyFor)', () => {
  beforeEach(() => { localStorage.clear(); sessionStorage.clear(); });

  it('기존 기사(articleId)는 접두사 없이 그대로 키가 된다(창을 옮겨도 같은 초안을 찾는다)', () => {
    expect(draftKeyFor('AKR1', 'tab-1')).toBe('AKR1');
  });

  it('신규 탭(articleId 없음)은 "<스코프>:<tabId>" 키가 되고 tabId 자체와 다르다', () => {
    for (const empty of [null, '', undefined]) {
      const key = draftKeyFor(empty, 'tab-1');
      expect(key).not.toBe('tab-1');
      expect(key).toBe(`${draftScopeId()}:tab-1`);
      expect(key.endsWith(':tab-1')).toBe(true);
    }
  });

  it('같은 로드 안에서는 여러 번 불러도 스코프가 동일하다(키 안정성)', () => {
    expect(draftKeyFor(null, 'tab-1')).toBe(draftKeyFor(null, 'tab-1'));
    expect(draftScopeId()).toBe(draftScopeId());
  });

  it('sessionStorage가 비면(=다른 창) 스코프가 달라지고, 값이 남아 있으면(F5) 같은 키가 나온다', async () => {
    const first = draftKeyFor(null, 'tab-1');

    // F5 모사 — 모듈 캐시를 버리고 다시 로드해도 sessionStorage 값이 남아 있으면 같은 키.
    vi.resetModules();
    const reloaded = await import('./editorDraft.js');
    expect(reloaded.draftKeyFor(null, 'tab-1')).toBe(first);

    // 다른 창 모사 — sessionStorage는 창/탭별 격리라 비어 있고, 새 스코프가 발급된다.
    sessionStorage.clear();
    expect(reloaded.draftKeyFor(null, 'tab-1')).not.toBe(first);
  });

  it('sessionStorage 접근이 throw해도 예외 없이 안정된 문자열 키를 돌려준다(graceful)', () => {
    const original = globalThis.sessionStorage;
    try {
      Object.defineProperty(globalThis, 'sessionStorage', {
        configurable: true,
        get() { throw new Error('sessionStorage blocked'); },
      });
      let key;
      expect(() => { key = draftKeyFor(null, 'tab-1'); }).not.toThrow();
      expect(typeof key).toBe('string');
      expect(key.endsWith(':tab-1')).toBe(true);
      expect(draftKeyFor(null, 'tab-1')).toBe(key); // 이 페이지 로드 동안은 안정
      expect(draftKeyFor('AKR1', 'tab-1')).toBe('AKR1'); // 기존 기사 키는 스코프와 무관
    } finally {
      Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: original });
    }
  });

  it('키 규약만 바뀐다 — saveDraft/loadDraft/clearDraft는 그 키로 그대로 동작한다(저장 shape 불변)', () => {
    const key = draftKeyFor(null, 'tab-1');
    saveDraft(key, { title: 'N' }, 1000);
    saveDraft('AKR1', { title: 'A' }, 1000);
    expect(loadDraft(key)).toEqual({ title: 'N' });
    clearDraft(key);
    expect(loadDraft(key)).toBeNull();
    expect(loadDraft('AKR1')).toEqual({ title: 'A' }); // 다른 키는 보존
  });
});
