import { describe, it, expect, beforeEach } from 'vitest';
import { loadMemo, saveMemo } from './editorMemo.js';

// 메모장 영속 모듈(editorMemo.js) — 본문을 건드리지 않는 client 스크래치패드 텍스트를
// localStorage(전용 키 yh.editorMemo)에 저장/로드한다. editorPrefs와 분리(적용/취소 게이트 결합 회피).
describe('editorMemo — 메모장 텍스트 저장소', () => {
  beforeEach(() => { localStorage.clear(); });

  it('저장값이 없으면 loadMemo()가 빈 문자열을 반환한다', () => {
    expect(loadMemo()).toBe('');
  });

  it('saveMemo → loadMemo 왕복 일관성', () => {
    saveMemo('취재 메모');
    expect(loadMemo()).toBe('취재 메모');
  });

  it('빈 문자열 저장/로드가 정상 동작한다', () => {
    saveMemo('먼저');
    saveMemo('');
    expect(loadMemo()).toBe('');
  });

  it('saveMemo는 저장한 text를 반환한다', () => {
    expect(saveMemo('반환값')).toBe('반환값');
  });

  it('여러 줄/유니코드 텍스트도 왕복한다', () => {
    const text = '첫 줄\n둘째 줄 ※ ℃';
    saveMemo(text);
    expect(loadMemo()).toBe(text);
  });

  it('localStorage가 없거나 throw하는 환경에서 graceful(loadMemo→"", saveMemo no-op·throw 없음)', () => {
    const original = globalThis.localStorage;
    try {
      Object.defineProperty(globalThis, 'localStorage', {
        configurable: true,
        get() { throw new Error('localStorage blocked'); },
      });
      expect(() => loadMemo()).not.toThrow();
      expect(loadMemo()).toBe('');
      expect(() => saveMemo('x')).not.toThrow();
      expect(saveMemo('x')).toBe('x'); // no-op이어도 넘긴 text를 반환
    } finally {
      Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: original });
    }
  });
});
