import { describe, it, expect } from 'vitest';
import {
  RESERVED_COMBOS, parseKeyCombo, compileGlyphKeymap, matchGlyphKeymap,
} from './editorGlyphKeymap.js';

describe('editorGlyphKeymap — parseKeyCombo 정상', () => {
  it('parses Ctrl+1 into a normalized combo', () => {
    expect(parseKeyCombo('Ctrl+1')).toEqual({
      ctrl: true, alt: false, shift: false, meta: false, key: '1',
    });
  });

  it('parses lowercase ctrl+k (대소문자 무관)', () => {
    expect(parseKeyCombo('ctrl+k')).toEqual({
      ctrl: true, alt: false, shift: false, meta: false, key: 'k',
    });
  });

  it('parses Ctrl+Shift+K with shift flag and lowercased key', () => {
    expect(parseKeyCombo('Ctrl+Shift+K')).toEqual({
      ctrl: true, alt: false, shift: true, meta: false, key: 'k',
    });
  });

  it('parses Alt+2 with alt flag', () => {
    expect(parseKeyCombo('Alt+2')).toEqual({
      ctrl: false, alt: true, shift: false, meta: false, key: '2',
    });
  });

  it('accepts modifier aliases (control/option/cmd)', () => {
    expect(parseKeyCombo('Control+K')).toEqual({
      ctrl: true, alt: false, shift: false, meta: false, key: 'k',
    });
    expect(parseKeyCombo('Option+2')).toEqual({
      ctrl: false, alt: true, shift: false, meta: false, key: '2',
    });
    expect(parseKeyCombo('Cmd+K')).toEqual({
      ctrl: false, alt: false, shift: false, meta: true, key: 'k',
    });
  });

  it('trims whitespace around tokens', () => {
    expect(parseKeyCombo('  Ctrl + 1  ')).toEqual({
      ctrl: true, alt: false, shift: false, meta: false, key: '1',
    });
  });
});

describe('editorGlyphKeymap — parseKeyCombo null (매칭 불가 입력)', () => {
  it('returns null for empty / whitespace-only strings', () => {
    expect(parseKeyCombo('')).toBe(null);
    expect(parseKeyCombo('   ')).toBe(null);
    expect(parseKeyCombo(null)).toBe(null);
    expect(parseKeyCombo(undefined)).toBe(null);
  });

  it('returns null for a bare key without modifiers (실수식어 필수 — 타이핑 파괴 방지)', () => {
    expect(parseKeyCombo('K')).toBe(null);
    expect(parseKeyCombo('a')).toBe(null);
    expect(parseKeyCombo('1')).toBe(null);
  });

  it('returns null for Shift-only combos (Shift는 실수식어가 아님)', () => {
    expect(parseKeyCombo('Shift+1')).toBe(null);
    expect(parseKeyCombo('Shift+K')).toBe(null);
  });

  it('returns null when there is no key token', () => {
    expect(parseKeyCombo('Ctrl')).toBe(null);
    expect(parseKeyCombo('Ctrl+Shift')).toBe(null);
  });

  it('returns null when there are two or more key tokens', () => {
    expect(parseKeyCombo('Ctrl+A+B')).toBe(null);
  });
});

describe('editorGlyphKeymap — compileGlyphKeymap 제외 규칙', () => {
  it('returns [] for non-array input', () => {
    expect(compileGlyphKeymap(null)).toEqual([]);
    expect(compileGlyphKeymap(undefined)).toEqual([]);
    expect(compileGlyphKeymap('x')).toEqual([]);
  });

  it('drops entries with empty/whitespace glyph', () => {
    expect(compileGlyphKeymap([
      { keys: 'Ctrl+1', glyph: '' },
      { keys: 'Ctrl+2', glyph: '   ' },
    ])).toEqual([]);
  });

  it('drops entries whose keys fail to parse', () => {
    expect(compileGlyphKeymap([
      { keys: 'a', glyph: '★' },
      { keys: 'Shift+1', glyph: '★' },
      { keys: '', glyph: '★' },
    ])).toEqual([]);
  });

  it('drops reserved-combo conflicts (섀도잉 금지)', () => {
    expect(compileGlyphKeymap([
      { keys: 'Ctrl+Z', glyph: 'x' },
      { keys: 'Ctrl+F', glyph: 'y' },
      { keys: 'Ctrl+D', glyph: 'z' },
      { keys: 'Ctrl+A', glyph: 'w' },
      { keys: 'Alt+O', glyph: 'q' },
    ])).toEqual([]);
  });

  it('keeps a normal entry and trims its glyph', () => {
    const compiled = compileGlyphKeymap([{ keys: 'Ctrl+1', glyph: ' ★ ' }]);
    expect(compiled).toEqual([{
      combo: {
        ctrl: true, alt: false, shift: false, meta: false, key: '1',
      },
      glyph: '★',
    }]);
  });

  it('excludes Ctrl+Shift+Z (redo 예약) but keeps Ctrl+Shift+F (비예약 — shift 차이로 충돌 판정 정확)', () => {
    expect(compileGlyphKeymap([{ keys: 'Ctrl+Shift+Z', glyph: 'x' }])).toEqual([]);
    const compiled = compileGlyphKeymap([{ keys: 'Ctrl+Shift+F', glyph: '☆' }]);
    expect(compiled).toHaveLength(1);
    expect(compiled[0].glyph).toBe('☆');
  });
});

describe('editorGlyphKeymap — matchGlyphKeymap', () => {
  const compiled = compileGlyphKeymap([{ keys: 'Ctrl+1', glyph: '★' }]);

  it('matches by e.key', () => {
    expect(matchGlyphKeymap(compiled, { ctrlKey: true, key: '1' })).toBe('★');
  });

  it('matches by e.code (Digit / Numpad)', () => {
    expect(matchGlyphKeymap(compiled, { ctrlKey: true, code: 'Digit1' })).toBe('★');
    expect(matchGlyphKeymap(compiled, { ctrlKey: true, code: 'Numpad1' })).toBe('★');
  });

  it('rejects on modifier mismatch (수식어 정확 일치)', () => {
    expect(matchGlyphKeymap(compiled, { ctrlKey: true, shiftKey: true, key: '1' })).toBe(null);
    expect(matchGlyphKeymap(compiled, { ctrlKey: true, altKey: true, key: '1' })).toBe(null);
  });

  it('fast-exits to null when no real modifier is pressed (일반 타이핑 비간섭)', () => {
    expect(matchGlyphKeymap(compiled, { key: '1' })).toBe(null);
    expect(matchGlyphKeymap(compiled, { shiftKey: true, key: '1' })).toBe(null);
    expect(matchGlyphKeymap(compiled, null)).toBe(null);
    expect(matchGlyphKeymap(compiled, undefined)).toBe(null);
  });

  it('matches letters via e.code when e.key is a Hangul jamo (한영/레이아웃 견고성)', () => {
    const c = compileGlyphKeymap([{ keys: 'Ctrl+K', glyph: '§' }]);
    expect(matchGlyphKeymap(c, { ctrlKey: true, code: 'KeyK', key: 'ㅏ' })).toBe('§');
  });

  it('matches letters case-insensitively via e.key', () => {
    const c = compileGlyphKeymap([{ keys: 'Ctrl+Shift+K', glyph: '§' }]);
    expect(matchGlyphKeymap(c, { ctrlKey: true, shiftKey: true, key: 'K' })).toBe('§');
  });

  it('matches named keys via e.key lowercased (베스트에포트)', () => {
    const c = compileGlyphKeymap([{ keys: 'Ctrl+F2', glyph: '¶' }]);
    expect(matchGlyphKeymap(c, { ctrlKey: true, key: 'F2' })).toBe('¶');
  });

  it('returns the first-registered glyph when two entries share a combo (등록 순서 우선)', () => {
    const c = compileGlyphKeymap([
      { keys: 'Ctrl+1', glyph: '첫째' },
      { keys: 'ctrl+1', glyph: '둘째' },
    ]);
    expect(matchGlyphKeymap(c, { ctrlKey: true, key: '1' })).toBe('첫째');
  });
});

describe('editorGlyphKeymap — 입력 불변(mutate 금지)', () => {
  it('parse/compile/match never mutate their inputs', () => {
    const items = [
      { keys: 'Ctrl+1', glyph: '★' },
      { keys: 'a', glyph: 'bad' },
    ];
    const itemsSnapshot = JSON.parse(JSON.stringify(items));
    const e = { ctrlKey: true, key: '1', code: 'Digit1' };
    const eSnapshot = { ...e };

    parseKeyCombo('Ctrl+1');
    const compiled = compileGlyphKeymap(items);
    matchGlyphKeymap(compiled, e);

    expect(items).toEqual(itemsSnapshot);
    expect(e).toEqual(eSnapshot);
  });

  it('is deterministic — same inputs, same outputs', () => {
    const items = [{ keys: 'Ctrl+1', glyph: '★' }];
    expect(compileGlyphKeymap(items)).toEqual(compileGlyphKeymap(items));
    expect(parseKeyCombo('Ctrl+K')).toEqual(parseKeyCombo('Ctrl+K'));
  });
});

describe('editorGlyphKeymap — RESERVED_COMBOS 잠금 (news.md L178 회귀 방지)', () => {
  const reservedStrings = [
    'Ctrl+B', 'Ctrl+X', 'Ctrl+C', 'Ctrl+V', 'Alt+V', 'Alt+O', 'Ctrl+F',
    'Ctrl+A', 'Ctrl+Y', 'Ctrl+Z', 'Ctrl+Shift+Z', 'Ctrl+D', 'Alt+Y',
  ];

  it('has at least 13 reserved combos', () => {
    expect(RESERVED_COMBOS.length).toBeGreaterThanOrEqual(13);
  });

  it.each(reservedStrings)('compile drops a keymap entry for reserved %s', (keys) => {
    expect(compileGlyphKeymap([{ keys, glyph: 'x' }])).toEqual([]);
  });
});
