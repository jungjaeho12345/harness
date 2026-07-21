import { describe, it, expect } from 'vitest';
import { normalizeInputMode, euckrStats } from './editorEncoding.js';

describe('editorEncoding — euckrStats 기본 분류', () => {
  it('빈 문자열 → 0바이트 0비호환', () => {
    expect(euckrStats('')).toEqual({ bytes: 0, incompatible: 0 });
  });

  it('null/undefined → 빈 문자열 취급', () => {
    expect(euckrStats(null)).toEqual({ bytes: 0, incompatible: 0 });
    expect(euckrStats(undefined)).toEqual({ bytes: 0, incompatible: 0 });
  });

  it('ASCII는 1바이트 — abc → 3', () => {
    expect(euckrStats('abc')).toEqual({ bytes: 3, incompatible: 0 });
  });

  it('한글 음절(완성형)은 2바이트 — 한글 → 4', () => {
    expect(euckrStats('한글')).toEqual({ bytes: 4, incompatible: 0 });
  });

  it('한글·ASCII 혼합 — 가A나 → 2+1+2=5', () => {
    expect(euckrStats('가A나')).toEqual({ bytes: 5, incompatible: 0 });
  });

  it('CJK 통합 한자는 2바이트 — 日本語 → 6', () => {
    expect(euckrStats('日本語')).toEqual({ bytes: 6, incompatible: 0 });
  });

  it('히라가나는 2바이트 — あ → 2', () => {
    expect(euckrStats('あ')).toEqual({ bytes: 2, incompatible: 0 });
  });

  it('개행은 ASCII 1바이트 — 한\\n글 → 2+1+2=5', () => {
    expect(euckrStats('한\n글')).toEqual({ bytes: 5, incompatible: 0 });
  });

  it('키릴은 2바이트 — Ру → 4 (러시아어)', () => {
    expect(euckrStats('Ру')).toEqual({ bytes: 4, incompatible: 0 });
  });
});

describe('editorEncoding — euckrStats 비호환(0바이트 + 카운트)', () => {
  it('비BMP 이모지는 비호환 1로 한 번만 센다 — a😀 → { bytes: 1, incompatible: 1 }', () => {
    // 😀 U+1F600 — surrogate pair를 한 코드포인트로 다뤄 2배로 세지 않는다.
    expect(euckrStats('a😀')).toEqual({ bytes: 1, incompatible: 1 });
  });

  it('라틴 확장은 비호환 — café → { bytes: 3, incompatible: 1 }', () => {
    // é U+00E9 — EUC-KR 인코딩 불가. 바이트에 0 기여, 카운트만 상승.
    expect(euckrStats('café')).toEqual({ bytes: 3, incompatible: 1 });
  });

  it('아랍 문자는 비호환 — ا → { bytes: 0, incompatible: 1 }', () => {
    expect(euckrStats('ا')).toEqual({ bytes: 0, incompatible: 1 });
  });

  it('태국 문자는 비호환 — ก → { bytes: 0, incompatible: 1 }', () => {
    expect(euckrStats('ก')).toEqual({ bytes: 0, incompatible: 1 });
  });
});

describe('editorEncoding — euckrStats 2바이트 범위 대표 문자 잠금', () => {
  it.each([
    ['그리스 Ω U+03A9', 'Ω'],
    ['한글 자모 ᄀ U+1100', 'ᄀ'],
    ['전각 기호 。 U+3002', '。'],
    ['가타카나 カ U+30AB', 'カ'],
    ['한글 호환 자모 ㄱ U+3131', 'ㄱ'],
    ['CJK 호환 한자 豈 U+F900', '豈'],
    ['전각 형태 Ａ U+FF21', 'Ａ'],
  ])('%s → 2바이트', (_label, ch) => {
    expect(euckrStats(ch)).toEqual({ bytes: 2, incompatible: 0 });
  });
});

describe('editorEncoding — normalizeInputMode', () => {
  it("'ksc5601' → 'ksc5601'", () => {
    expect(normalizeInputMode('ksc5601')).toBe('ksc5601');
  });

  it("'unicode'/undefined/미지원 문자열 → 'unicode' 폴백", () => {
    expect(normalizeInputMode('unicode')).toBe('unicode');
    expect(normalizeInputMode(undefined)).toBe('unicode');
    expect(normalizeInputMode('')).toBe('unicode');
    expect(normalizeInputMode('xxx')).toBe('unicode');
  });
});
