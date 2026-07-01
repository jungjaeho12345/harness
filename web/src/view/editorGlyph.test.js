import { describe, it, expect } from 'vitest';
import { insertGlyphAtCaret, normalizeGlyph } from './editorGlyph.js';
import {
  textBlock, embedBlock, END_MARKER, blocksToText,
} from './editorContent.js';

describe('editorGlyph — normalizeGlyph', () => {
  it('trims and returns the glyph string', () => {
    expect(normalizeGlyph('  ※  ')).toBe('※');
    expect(normalizeGlyph('※')).toBe('※');
  });

  it('returns empty string for empty/null/undefined', () => {
    expect(normalizeGlyph('')).toBe('');
    expect(normalizeGlyph('   ')).toBe('');
    expect(normalizeGlyph(null)).toBe('');
    expect(normalizeGlyph(undefined)).toBe('');
  });
});

describe('editorGlyph — insertGlyphAtCaret', () => {
  it('inserts the glyph at the in-line column from caret offset', () => {
    // 권위 있는 계약(step0.md 규칙3·40행): col = caret.offset - lineStart, text.slice(0,col)+glyph+text.slice(col).
    // offset 2, start 0 → col 2 → '가나' 다음에 삽입 = '가나※다'. (step0 예시 63행의 '가※나다' 리터럴은 "컬럼 2"
    //  라벨과 모순되는 오타 — slice 알고리즘과 Step 2/4 캐럿 정합이 load-bearing 계약이므로 그쪽을 따른다.)
    const r = insertGlyphAtCaret([textBlock('가나다')], { lineIndex: 0, offset: 2 }, '※');
    expect(blocksToText(r.blocks).split('\n')).toEqual(['가나※다']);
    expect(r.caretTextLine).toBe(0);
    // 컬럼 1(=offset 1) 삽입은 '가※나다'.
    const r1 = insertGlyphAtCaret([textBlock('가나다')], { lineIndex: 0, offset: 1 }, '※');
    expect(blocksToText(r1.blocks)).toBe('가※나다');
  });

  it('inserts at the start when offset is 0', () => {
    const r = insertGlyphAtCaret([textBlock('가나다')], { lineIndex: 0, offset: 0 }, '※');
    expect(blocksToText(r.blocks)).toBe('※가나다');
    expect(r.caretTextLine).toBe(0);
  });

  it('inserts at the end when offset equals line length', () => {
    const r = insertGlyphAtCaret([textBlock('가나다')], { lineIndex: 0, offset: 3 }, '※');
    expect(blocksToText(r.blocks)).toBe('가나다※');
    expect(r.caretTextLine).toBe(0);
  });

  it('uses the correct in-line column on a multi-line caret offset', () => {
    // blocksToText = 'abc\ndef'; second line starts at offset 4, so offset 5 → column 1 of 'def'.
    const r = insertGlyphAtCaret([textBlock('abc'), textBlock('def')], { lineIndex: 1, offset: 5 }, '*');
    expect(blocksToText(r.blocks).split('\n')).toEqual(['abc', 'd*ef']);
    expect(r.caretTextLine).toBe(1);
  });

  it('is a no-op for empty glyph', () => {
    const input = [textBlock('가나다')];
    expect(insertGlyphAtCaret(input, { lineIndex: 0, offset: 1 }, '')).toEqual({
      blocks: [textBlock('가나다')], caretTextLine: null,
    });
  });

  it('is a no-op for null/undefined glyph', () => {
    const input = [textBlock('가나다')];
    expect(insertGlyphAtCaret(input, { lineIndex: 0, offset: 1 }, null).caretTextLine).toBe(null);
    expect(insertGlyphAtCaret(input, { lineIndex: 0, offset: 1 }, undefined).caretTextLine).toBe(null);
    expect(blocksToText(insertGlyphAtCaret(input, { lineIndex: 0, offset: 1 }, '').blocks)).toBe('가나다');
  });

  it('is a no-op for whitespace-only glyph', () => {
    const r = insertGlyphAtCaret([textBlock('가나다')], { lineIndex: 0, offset: 1 }, '   ');
    expect(r.caretTextLine).toBe(null);
    expect(blocksToText(r.blocks)).toBe('가나다');
  });

  it('falls back to the last text line end when caret is null', () => {
    const r = insertGlyphAtCaret([textBlock('첫줄'), textBlock('둘째줄')], null, '※');
    expect(blocksToText(r.blocks).split('\n')).toEqual(['첫줄', '둘째줄※']);
    expect(r.caretTextLine).toBe(1);
  });

  it('falls back to the last text line end when caret.lineIndex is out of range', () => {
    const r = insertGlyphAtCaret([textBlock('첫줄'), textBlock('둘째줄')], { lineIndex: 9, offset: 0 }, '※');
    expect(blocksToText(r.blocks).split('\n')).toEqual(['첫줄', '둘째줄※']);
    expect(r.caretTextLine).toBe(1);
  });

  it('creates a first text block when there is no text block (embed-only)', () => {
    const r = insertGlyphAtCaret([embedBlock({ embedType: 'image', src: 'x' })], null, '※');
    expect(blocksToText(r.blocks)).toBe('※');
    expect(r.caretTextLine).toBe(0);
    // 임베드는 보존된다(텍스트 블록만 추가).
    expect(r.blocks.some((b) => b.type === 'embed')).toBe(true);
  });

  it('keeps embed blocks position/content/count unchanged when inserting into a text line', () => {
    const input = [
      textBlock('a'),
      embedBlock({ embedType: 'image', src: 'x' }),
      textBlock('b'),
    ];
    // blocksToText = 'a\nb'; text-line 1 = 'b', offset 2 → column 0 of 'b'.
    const r = insertGlyphAtCaret(input, { lineIndex: 1, offset: 2 }, '※');
    expect(r.blocks).toEqual([
      textBlock('a'),
      embedBlock({ embedType: 'image', src: 'x' }),
      textBlock('※b'),
    ]);
    expect(r.blocks.length).toBe(3);
    expect(r.caretTextLine).toBe(1);
  });

  it('does not change the "(끝)" text on fallback — inserts into the line before "(끝)"', () => {
    const input = [textBlock('본문'), textBlock(END_MARKER)];
    const r = insertGlyphAtCaret(input, null, '※');
    expect(blocksToText(r.blocks).split('\n')).toEqual(['본문※', '(끝)']);
    expect(r.caretTextLine).toBe(0);
  });

  it('falls back to before "(끝)" even when caret targets the "(끝)" line', () => {
    const input = [textBlock('본문'), textBlock(END_MARKER)];
    // caret lineIndex 1 == "(끝)" line — should not be modified; falls back to '본문'.
    const r = insertGlyphAtCaret(input, { lineIndex: 1, offset: 3 }, '※');
    expect(blocksToText(r.blocks).split('\n')).toEqual(['본문※', '(끝)']);
    expect(r.caretTextLine).toBe(0);
  });

  it('does not mutate the input blocks array or its elements', () => {
    const input = [
      textBlock('가나다'),
      embedBlock({ embedType: 'video', videoId: 'a' }),
    ];
    const snapshot = JSON.parse(JSON.stringify(input));
    const r = insertGlyphAtCaret(input, { lineIndex: 0, offset: 1 }, '※');
    expect(input).toEqual(snapshot); // 입력 불변
    expect(r.blocks).not.toBe(input); // 새 배열
  });

  it('returns normalized blocks (drops unknown block types) on no-op', () => {
    const input = [textBlock('x'), { type: 'bogus' }];
    const r = insertGlyphAtCaret(input, { lineIndex: 0, offset: 0 }, '');
    expect(r.blocks).toEqual([textBlock('x')]);
    expect(r.caretTextLine).toBe(null);
  });

  // --- 보강: 경계/에러 경로 (Step 2/4가 실제 statusCaret를 넘기므로 좌표 어긋남·클램프 계약을 고정) ---

  it('trusts caret.lineIndex for the block and clamps the offset column to that block', () => {
    // blocksToText='ab\ncd'; offset 4 = "cd" 시작이지만 lineIndex 0(블록 'ab')을 신뢰한다.
    // col = offset(4) - start(3) = 1 → 'ab'의 col 1 ('aXb'). col은 대상 블록 길이로 클램프된다.
    const r = insertGlyphAtCaret([textBlock('ab'), textBlock('cd')], { lineIndex: 0, offset: 4 }, 'X');
    expect(blocksToText(r.blocks).split('\n')).toEqual(['aXb', 'cd']);
    expect(r.caretTextLine).toBe(0);
  });

  it('clamps an over-large offset to the end of the target line', () => {
    const r = insertGlyphAtCaret([textBlock('가나다')], { lineIndex: 0, offset: 999 }, 'X');
    expect(blocksToText(r.blocks)).toBe('가나다X');
    expect(r.caretTextLine).toBe(0);
  });

  it('clamps a negative offset to the start of the target line', () => {
    const r = insertGlyphAtCaret([textBlock('가나다')], { lineIndex: 0, offset: -5 }, 'X');
    expect(blocksToText(r.blocks)).toBe('X가나다');
    expect(r.caretTextLine).toBe(0);
  });

  it('falls back when caret.lineIndex is not an integer', () => {
    const r = insertGlyphAtCaret([textBlock('첫'), textBlock('둘')], { lineIndex: 0.5, offset: 0 }, 'X');
    expect(blocksToText(r.blocks).split('\n')).toEqual(['첫', '둘X']);
    expect(r.caretTextLine).toBe(1);
  });

  it('inserts a multi-character glyph intact at the column', () => {
    const r = insertGlyphAtCaret([textBlock('가나다')], { lineIndex: 0, offset: 1 }, '☆★');
    expect(blocksToText(r.blocks)).toBe('가☆★나다');
    expect(r.caretTextLine).toBe(0);
  });

  it('creates a text block and preserves the embed when a non-null caret targets a non-existent text line (embed-only)', () => {
    const r = insertGlyphAtCaret([embedBlock({ embedType: 'image', src: 'x' })], { lineIndex: 0, offset: 0 }, 'X');
    expect(blocksToText(r.blocks)).toBe('X');
    expect(r.caretTextLine).toBe(0);
    expect(r.blocks.some((b) => b.type === 'embed')).toBe(true);
    expect(r.blocks.length).toBe(2);
  });

  it('does not mutate the input on a no-op (empty glyph) either', () => {
    const input = [textBlock('가나다'), embedBlock({ embedType: 'image', src: 'x' })];
    const snapshot = JSON.parse(JSON.stringify(input));
    const r = insertGlyphAtCaret(input, { lineIndex: 0, offset: 1 }, '   ');
    expect(input).toEqual(snapshot);
    expect(r.blocks).not.toBe(input);
    expect(r.caretTextLine).toBe(null);
  });
});
