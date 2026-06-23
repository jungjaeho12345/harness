import { describe, it, expect } from 'vitest';
import { wordCount, byteLength, caretPosition, charCount, lineCount } from './editorStats.js';

describe('editorStats.wordCount — 공백류로 분리된 단어 수', () => {
  it('연속 공백을 하나로 보고 단어를 센다', () => {
    expect(wordCount('가 나  다')).toBe(3);
  });
  it('빈 문자열은 0', () => {
    expect(wordCount('')).toBe(0);
  });
  it('공백뿐이면 0', () => {
    expect(wordCount('   ')).toBe(0);
  });
  it('앞뒤/중간 개행·탭도 공백류로 본다', () => {
    expect(wordCount('\t가\n나 ')).toBe(2);
  });
  it('null/undefined는 0', () => {
    expect(wordCount(null)).toBe(0);
    expect(wordCount(undefined)).toBe(0);
  });
});

describe('editorStats.byteLength — UTF-8 바이트 길이', () => {
  it('한글은 글자당 3바이트', () => {
    expect(byteLength('한글')).toBe(6);
  });
  it('ASCII는 글자당 1바이트', () => {
    expect(byteLength('ab')).toBe(2);
  });
  it('빈 문자열·null은 0', () => {
    expect(byteLength('')).toBe(0);
    expect(byteLength(null)).toBe(0);
  });
});

describe('editorStats.caretPosition — { paragraph, row, column } 1-based', () => {
  it('둘째 줄 안의 캐럿: 행=2, 열=2, 단락=1', () => {
    expect(caretPosition('가나\n다라', { lineIndex: 1, offset: 4 })).toEqual({
      paragraph: 1,
      row: 2,
      column: 2,
    });
  });
  it('빈 줄로 분리된 단락: 행=3, 열=1, 단락=2', () => {
    expect(caretPosition('가\n\n다', { lineIndex: 2, offset: 3 })).toEqual({
      paragraph: 2,
      row: 3,
      column: 1,
    });
  });
  it('caret이 null이면 포커스 전 기본값', () => {
    expect(caretPosition('가나', null)).toEqual({ paragraph: 1, row: 1, column: 1 });
  });
  it('caret이 undefined여도 기본값', () => {
    expect(caretPosition('가나', undefined)).toEqual({ paragraph: 1, row: 1, column: 1 });
  });
  it('첫 줄 시작(offset 0)은 열=1', () => {
    expect(caretPosition('가나\n다라', { lineIndex: 0, offset: 0 })).toEqual({
      paragraph: 1,
      row: 1,
      column: 1,
    });
  });
  it('연속된 빈 줄은 단락 경계 1개로 본다', () => {
    // ['가', '', '', '다'] — 빈 줄 2개가 경계 1개. 마지막 줄(offset 4 = 줄 시작)은 단락 2.
    expect(caretPosition('가\n\n\n다', { lineIndex: 3, offset: 4 })).toEqual({
      paragraph: 2,
      row: 4,
      column: 1,
    });
  });
});

describe('editorStats.charCount — 개행 제외 글자 수', () => {
  it('개행은 글자로 세지 않는다', () => {
    expect(charCount('가\n나')).toBe(2);
  });
  it('연속 개행도 모두 제외한다', () => {
    expect(charCount('가\n\n다')).toBe(2);
  });
  it('ASCII 글자 수를 센다', () => {
    expect(charCount('abc')).toBe(3);
  });
  it('공백은 글자로 센다(개행만 제외)', () => {
    expect(charCount('a b')).toBe(3);
  });
  it('빈 문자열은 0', () => {
    expect(charCount('')).toBe(0);
  });
  it('null/undefined는 0', () => {
    expect(charCount(null)).toBe(0);
    expect(charCount(undefined)).toBe(0);
  });
});

describe('editorStats.lineCount — lines(text).length 기준 줄 수', () => {
  it('빈 문자열도 1줄', () => {
    expect(lineCount('')).toBe(1);
  });
  it('개행 1개면 2줄', () => {
    expect(lineCount('가\n나')).toBe(2);
  });
  it('개행 2개(빈 줄 포함)면 3줄', () => {
    expect(lineCount('가\n\n다')).toBe(3);
  });
  it('null/undefined는 1줄', () => {
    expect(lineCount(null)).toBe(1);
    expect(lineCount(undefined)).toBe(1);
  });
});
