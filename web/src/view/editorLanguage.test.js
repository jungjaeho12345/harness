import { describe, it, expect } from 'vitest';
import { LANGUAGE_LABELS, languageLabel, normalizeLanguage } from './editorLanguage.js';

describe('editorLanguage — LANGUAGE_LABELS 9종 잠금 (news.md L196 순서·표기)', () => {
  it('코드 배열이 news.md L196 순서와 일치한다', () => {
    expect(LANGUAGE_LABELS.map((e) => e.code)).toEqual([
      'ko', 'en', 'ja', 'zh', 'es', 'fr', 'ar', 'vi', 'ru',
    ]);
  });

  it('라벨 배열이 news.md L196 표기와 일치한다 (ko는 한국어가 아닌 한글)', () => {
    expect(LANGUAGE_LABELS.map((e) => e.label)).toEqual([
      '한글', '영어', '일어', '중국어', '스페인', '프랑스', '아랍어', '베트남', '러시아어',
    ]);
  });
});

describe('editorLanguage — languageLabel', () => {
  it("'ko' → '한글'", () => {
    expect(languageLabel('ko')).toBe('한글');
  });

  it("'en' → '영어'", () => {
    expect(languageLabel('en')).toBe('영어');
  });

  it("'ru' → '러시아어'", () => {
    expect(languageLabel('ru')).toBe('러시아어');
  });

  it("미지원 코드/undefined → '한글' 폴백", () => {
    expect(languageLabel('xx')).toBe('한글');
    expect(languageLabel(undefined)).toBe('한글');
  });
});

describe('editorLanguage — normalizeLanguage', () => {
  it("허용 9종 코드는 그대로 — 'ja' → 'ja'", () => {
    expect(normalizeLanguage('ja')).toBe('ja');
  });

  it("미지원/undefined/대문자 → 'ko' 폴백", () => {
    expect(normalizeLanguage('xx')).toBe('ko');
    expect(normalizeLanguage(undefined)).toBe('ko');
    expect(normalizeLanguage('KO')).toBe('ko');
  });
});
