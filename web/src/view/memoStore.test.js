import { describe, it, expect, beforeEach, vi } from 'vitest';
import { loadMemo, saveMemo } from './memoStore.js';

// 전역 메모(스크래치패드) 영속 모듈 — client localStorage 전용(서버 무관, 기사와 무관한 단일 전역 메모 1개).
// editorDraft/editorPrefs와 동일한 graceful 패턴(접근 불가/parse 실패 → 안전 폴백). DOM/React 비의존.
describe('memoStore — 전역 메모 load/save (순수, localStorage 전용)', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('저장 전에는 loadMemo()가 빈 문자열을 반환한다(부재)', () => {
    expect(loadMemo()).toBe('');
  });

  it("saveMemo('안녕') 후 loadMemo()가 '안녕'을 반환한다(왕복)", () => {
    saveMemo('안녕');
    expect(loadMemo()).toBe('안녕');
  });

  it('여러 줄 메모를 저장하면 개행이 보존된다', () => {
    saveMemo('여러\n줄\n메모');
    expect(loadMemo()).toBe('여러\n줄\n메모');
  });

  it('저장 키가 yh.editorMemo이며 다른 기존 키를 오염시키지 않는다', () => {
    localStorage.setItem('yh.editorPrefs', 'PREFS');
    localStorage.setItem('yh.editorDrafts', 'DRAFTS');
    saveMemo('메모 내용');
    expect(localStorage.getItem('yh.editorMemo')).not.toBeNull();
    // 기존 키는 그대로 유지된다.
    expect(localStorage.getItem('yh.editorPrefs')).toBe('PREFS');
    expect(localStorage.getItem('yh.editorDrafts')).toBe('DRAFTS');
  });

  it('saveMemo가 저장한 문자열을 반환한다', () => {
    expect(saveMemo('반환값')).toBe('반환값');
  });

  it('잘못된 JSON이 저장돼 있어도 loadMemo()가 안전 폴백(빈 문자열)하고 throw하지 않는다', () => {
    localStorage.setItem('yh.editorMemo', '{{{');
    expect(() => loadMemo()).not.toThrow();
    expect(loadMemo()).toBe('');
  });

  it('문자열이 아닌 JSON 값이 저장돼 있어도 loadMemo()가 빈 문자열을 반환한다', () => {
    localStorage.setItem('yh.editorMemo', JSON.stringify(123));
    expect(loadMemo()).toBe('');
  });

  it('saveMemo(null)/saveMemo(undefined)가 throw하지 않고 이후 loadMemo()가 빈 문자열이다', () => {
    expect(() => saveMemo(null)).not.toThrow();
    expect(loadMemo()).toBe('');
    expect(() => saveMemo(undefined)).not.toThrow();
    expect(loadMemo()).toBe('');
  });

  it('빈 문자열을 저장하면 loadMemo()가 빈 문자열을 반환한다', () => {
    saveMemo('내용');
    expect(loadMemo()).toBe('내용');
    saveMemo('');
    expect(loadMemo()).toBe('');
  });

  it('localStorage.setItem이 throw해도(quota/접근불가) saveMemo가 예외 없이 값을 반환한다(graceful no-op)', () => {
    const spy = vi.spyOn(globalThis.localStorage, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceeded');
    });
    try {
      expect(() => saveMemo('저장 실패해도 안전')).not.toThrow();
      // 저장 실패는 삼키되(no-op) 호출자에겐 정규화된 값을 그대로 돌려준다.
      expect(saveMemo('반환값 유지')).toBe('반환값 유지');
    } finally {
      spy.mockRestore();
    }
  });
});
