import { describe, it, expect } from 'vitest';
import {
  COLORS, classifyLines, colorForRole, colorLines, shouldRecolor,
} from './editorColoring.js';

describe('editorColoring — structure & colors', () => {
  it('first line is title, lines 2-5 subtitle, 6+ body', () => {
    const roles = classifyLines(['제목', '부제1', '부제2', '부제3', '부제4', '본문1', '본문2']);
    expect(roles).toEqual(['title', 'subtitle', 'subtitle', 'subtitle', 'subtitle', 'body', 'body']);
  });

  it('a blank line in the subtitle region (2+ newlines) makes body start at line 2', () => {
    const roles = classifyLines(['제목', '', '본문']);
    expect(roles).toEqual(['title', 'body', 'body']);
    const roles2 = classifyLines(['제목', '부제', '', '본문']);
    expect(roles2).toEqual(['title', 'body', 'body', 'body']);
  });

  it('"(끝)" line is always the end role regardless of position', () => {
    expect(classifyLines(['제목', '(끝)'])).toEqual(['title', 'end']);
    expect(classifyLines(['제목', '부제', '본문', '(끝)'])[3]).toBe('end');
  });

  it('colors map title=blue, subtitle=red, body=ink, end=gold', () => {
    expect(colorForRole('title')).toBe(COLORS.title);
    expect(COLORS.title).toBe('#0a4da6');
    expect(COLORS.subtitle).toBe('#c8102e');
    expect(COLORS.end).toBe('#d4af37');
    expect(colorForRole('unknown')).toBe(COLORS.body);
  });

  it('colorLines returns text/role/color per line', () => {
    const out = colorLines('제목\n부제');
    expect(out).toEqual([
      { text: '제목', role: 'title', color: COLORS.title },
      { text: '부제', role: 'subtitle', color: COLORS.subtitle },
    ]);
  });

  it('does not recolor during IME composition; recolors on compositionend/blur/load', () => {
    expect(shouldRecolor('compositionend', { composing: true })).toBe(false);
    expect(shouldRecolor('compositionend', { composing: false })).toBe(true);
    expect(shouldRecolor('blur')).toBe(true);
    expect(shouldRecolor('load')).toBe(true);
    expect(shouldRecolor('input')).toBe(false);
  });
});
