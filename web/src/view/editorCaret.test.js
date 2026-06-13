import { describe, it, expect } from 'vitest';
import { lines, lineAtOffset, removeLineFromText } from './editorCaret.js';

describe('editorCaret — line math', () => {
  it('splits text into lines', () => {
    expect(lines('a\nb\nc')).toEqual(['a', 'b', 'c']);
  });

  it('lineAtOffset finds the line index and bounds for a caret', () => {
    const text = 'aa\nbbb\nc';
    expect(lineAtOffset(text, 0)).toEqual({ lineIndex: 0, start: 0, end: 2 });
    expect(lineAtOffset(text, 4)).toEqual({ lineIndex: 1, start: 3, end: 6 }); // within "bbb"
    expect(lineAtOffset(text, text.length)).toEqual({ lineIndex: 2, start: 7, end: 8 });
  });

  it('clamps out-of-range offsets', () => {
    expect(lineAtOffset('abc', -5).lineIndex).toBe(0);
    expect(lineAtOffset('abc', 999).lineIndex).toBe(0);
  });

  it('removeLineFromText removes the target line and returns the removed text', () => {
    const r = removeLineFromText('a\nb\nc', 1);
    expect(r.text).toBe('a\nc');
    expect(r.removed).toBe('b');
  });

  it('removeLineFromText positions caret at the line that took the slot', () => {
    const r = removeLineFromText('a\nb\nc', 1);
    // 남은 텍스트 "a\nc" 에서 인덱스 1 자리(=c)의 시작 오프셋 2.
    expect(r.caret).toBe(2);
  });

  it('removeLineFromText is a no-op for out-of-range indexes', () => {
    expect(removeLineFromText('a\nb', 5)).toEqual({ text: 'a\nb', removed: null, caret: 0 });
  });
});
