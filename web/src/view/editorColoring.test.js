import {
  describe, it, expect, afterEach,
} from 'vitest';
import {
  COLORS, classifyLines, colorForRole, colorLines, shouldRecolor,
  setEditorColors, resetEditorColors,
} from './editorColoring.js';

// module-level activeColors가 케이스 간 누수되지 않게 매 케이스 후 기본값으로 되돌린다(필수).
afterEach(() => resetEditorColors());

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

describe('editorColoring — user-configurable active colors', () => {
  it('defaults are unchanged when setEditorColors is not called', () => {
    expect(colorForRole('subtitle')).toBe('#c8102e');
    expect(colorForRole('title')).toBe('#0a4da6');
    expect(colorForRole('body')).toBe('#1a1a1a');
    expect(colorForRole('end')).toBe('#d4af37');
  });

  it('setEditorColors merges a whitelisted key; others stay; reset restores default', () => {
    setEditorColors({ subtitle: '#000000' });
    expect(colorForRole('subtitle')).toBe('#000000');
    expect(colorForRole('title')).toBe('#0a4da6'); // 불변
    expect(colorForRole('body')).toBe('#1a1a1a'); // 불변
    resetEditorColors();
    expect(colorForRole('subtitle')).toBe('#c8102e');
  });

  it('ignores non-whitelisted keys (unknown/background/end)', () => {
    setEditorColors({ unknown: '#fff' });
    setEditorColors({ background: '#000000' });
    setEditorColors({ end: '#000000' });
    expect(colorForRole('end')).toBe('#d4af37'); // 골드 유지
    expect(colorForRole('title')).toBe('#0a4da6');
    expect(colorForRole('subtitle')).toBe('#c8102e');
    expect(colorForRole('body')).toBe('#1a1a1a');
  });

  it('does not mutate the frozen COLORS constant', () => {
    setEditorColors({ title: '#123456' });
    expect(COLORS.title).toBe('#0a4da6');
  });
});
