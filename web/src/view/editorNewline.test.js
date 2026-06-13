import { describe, it, expect } from 'vitest';
import { appendEndMarker, hasEndMarker, isInputBlocked } from './editorNewline.js';

describe('editorNewline — "(끝)" placement & input blocking', () => {
  it('appends "(끝)" on its own line after the body', () => {
    expect(appendEndMarker('본문')).toBe('본문\n(끝)');
  });

  it('does not add a double newline when body already ends with newline or is empty', () => {
    expect(appendEndMarker('본문\n')).toBe('본문\n(끝)');
    expect(appendEndMarker('')).toBe('(끝)');
  });

  it('does not insert "(끝)" again if it already exists (no duplicate)', () => {
    expect(appendEndMarker('본문\n(끝)')).toBe('본문\n(끝)');
  });

  it('hasEndMarker reflects presence', () => {
    expect(hasEndMarker('본문\n(끝)')).toBe(true);
    expect(hasEndMarker('본문')).toBe(false);
  });

  it('blocks input at or after the marker, allows input before it', () => {
    const text = '본문\n(끝)';
    const markerStart = text.indexOf('(끝)');
    expect(isInputBlocked(text, markerStart)).toBe(true); // 마커 시작
    expect(isInputBlocked(text, text.length)).toBe(true); // 마커 뒤
    expect(isInputBlocked(text, markerStart - 1)).toBe(false); // 앞 줄(개행 위치)
    expect(isInputBlocked(text, 0)).toBe(false);
  });

  it('never blocks when there is no marker', () => {
    expect(isInputBlocked('본문', 0)).toBe(false);
    expect(isInputBlocked('본문', 2)).toBe(false);
  });
});
