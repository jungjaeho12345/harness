import {
  describe, it, expect, beforeEach, vi,
} from 'vitest';
import { loadAbbrevs, saveAbbrevs, normalizeAbbrevs } from './abbrevStore.js';

// 사용자 등록 약어(짧은형→확장형) 영속 모듈 — client localStorage 전용(서버 무관).
// editorDraft/editorPrefs/memoStore와 동일한 graceful 패턴(접근 불가/parse 실패/형식오류 → []/no-op). DOM/React 비의존.
describe('abbrevStore — 약어 목록 load/save/normalize (순수, localStorage 전용)', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('저장 전에는 loadAbbrevs()가 빈 목록([])을 반환한다(부재)', () => {
    expect(loadAbbrevs()).toEqual([]);
  });

  it('saveAbbrevs 후 loadAbbrevs()가 같은 목록을 반환한다(왕복)', () => {
    saveAbbrevs([{ short: 'US', long: 'United States' }]);
    expect(loadAbbrevs()).toEqual([{ short: 'US', long: 'United States' }]);
  });

  it('저장 키가 yh.editorAbbrevs이며 다른 기존 키를 오염시키지 않는다', () => {
    localStorage.setItem('yh.editorPrefs', 'PREFS');
    localStorage.setItem('yh.editorMemo', 'MEMO');
    saveAbbrevs([{ short: 'US', long: '미국' }]);
    expect(localStorage.getItem('yh.editorAbbrevs')).not.toBeNull();
    // 기존 키는 그대로 유지된다.
    expect(localStorage.getItem('yh.editorPrefs')).toBe('PREFS');
    expect(localStorage.getItem('yh.editorMemo')).toBe('MEMO');
  });

  it('잘못된 JSON이 저장돼 있어도 loadAbbrevs()가 안전 폴백([])하고 throw하지 않는다', () => {
    localStorage.setItem('yh.editorAbbrevs', '{{{');
    expect(() => loadAbbrevs()).not.toThrow();
    expect(loadAbbrevs()).toEqual([]);
  });

  it('비배열 JSON 값이 저장돼 있어도 loadAbbrevs()가 빈 목록([])을 반환한다', () => {
    localStorage.setItem('yh.editorAbbrevs', JSON.stringify(123));
    expect(loadAbbrevs()).toEqual([]);
  });

  it('normalizeAbbrevs/saveAbbrevs가 잡동사니를 버린다(빈 short·빈 long·비객체 제거)', () => {
    const dirty = [
      { short: 'A', long: 'B' },
      { short: '', long: 'X' },
      { short: 'C' },
      { foo: 1 },
      'str',
      null,
    ];
    expect(normalizeAbbrevs(dirty)).toEqual([{ short: 'A', long: 'B' }]);
    saveAbbrevs(dirty);
    expect(loadAbbrevs()).toEqual([{ short: 'A', long: 'B' }]);
  });

  it('short/long을 트림해 저장한다', () => {
    saveAbbrevs([{ short: '  US  ', long: ' 미국 ' }]);
    expect(loadAbbrevs()).toEqual([{ short: 'US', long: '미국' }]);
  });

  it('normalizeAbbrevs(비배열)은 []를 반환한다', () => {
    expect(normalizeAbbrevs(null)).toEqual([]);
    expect(normalizeAbbrevs(undefined)).toEqual([]);
    expect(normalizeAbbrevs(123)).toEqual([]);
    expect(normalizeAbbrevs('x')).toEqual([]);
  });

  it('normalizeAbbrevs는 입력 배열/원소를 mutate 하지 않는다(새 배열/새 객체)', () => {
    const input = [{ short: '  US  ', long: '미국' }];
    const inputItem = input[0];
    const out = normalizeAbbrevs(input);
    // 원본 불변.
    expect(input).toEqual([{ short: '  US  ', long: '미국' }]);
    expect(inputItem.short).toBe('  US  ');
    // 결과는 새 배열/새 객체.
    expect(out).not.toBe(input);
    expect(out[0]).not.toBe(inputItem);
    expect(out).toEqual([{ short: 'US', long: '미국' }]);
  });

  it('중복 short도 그대로 저장/로드한다(dedupe 강제 안 함)', () => {
    saveAbbrevs([{ short: 'US', long: '미국' }, { short: 'US', long: '미합중국' }]);
    expect(loadAbbrevs()).toEqual([{ short: 'US', long: '미국' }, { short: 'US', long: '미합중국' }]);
  });

  it('saveAbbrevs는 정규화된 목록을 반환한다', () => {
    expect(saveAbbrevs([{ short: ' A ', long: ' B ' }, { short: '', long: 'x' }])).toEqual([{ short: 'A', long: 'B' }]);
  });

  it('saveAbbrevs(null)/undefined/비배열이 throw하지 않고 []를 반환한다', () => {
    expect(() => saveAbbrevs(null)).not.toThrow();
    expect(saveAbbrevs(null)).toEqual([]);
    expect(saveAbbrevs(undefined)).toEqual([]);
    expect(saveAbbrevs(123)).toEqual([]);
    expect(loadAbbrevs()).toEqual([]);
  });

  it('localStorage.setItem이 throw해도(quota/접근불가) saveAbbrevs가 예외 없이 정규화 목록을 반환한다(graceful no-op)', () => {
    const spy = vi.spyOn(globalThis.localStorage, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceeded');
    });
    try {
      expect(() => saveAbbrevs([{ short: 'US', long: '미국' }])).not.toThrow();
      expect(saveAbbrevs([{ short: 'US', long: '미국' }])).toEqual([{ short: 'US', long: '미국' }]);
    } finally {
      spy.mockRestore();
    }
  });
});
