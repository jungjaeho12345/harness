import { describe, it, expect } from 'vitest';
import { insertDateAtCaret, normalizeDateString } from './editorDate.js';
import {
  textBlock, embedBlock, END_MARKER, blocksToText,
} from './editorContent.js';

describe('editorDate — normalizeDateString', () => {
  it('trims and returns the date string', () => {
    expect(normalizeDateString('  2026-06-24  ')).toBe('2026-06-24');
    expect(normalizeDateString('2026-06-24')).toBe('2026-06-24');
  });

  it('returns empty string for empty/null/undefined', () => {
    expect(normalizeDateString('')).toBe('');
    expect(normalizeDateString('   ')).toBe('');
    expect(normalizeDateString(null)).toBe('');
    expect(normalizeDateString(undefined)).toBe('');
  });
});

describe('editorDate — insertDateAtCaret', () => {
  it('inserts the date at the in-line column from caret offset', () => {
    // col = caret.offset - lineStart, text.slice(0,col)+date+text.slice(col).
    // offset 2, start 0 → col 2 → '가나' 다음에 삽입 = '가나2026-06-24다'.
    const r = insertDateAtCaret([textBlock('가나다')], { lineIndex: 0, offset: 2 }, '2026-06-24');
    expect(blocksToText(r.blocks).split('\n')).toEqual(['가나2026-06-24다']);
    expect(r.caretTextLine).toBe(0);
    // 컬럼 1(=offset 1) 삽입은 '가2026-06-24나다'.
    const r1 = insertDateAtCaret([textBlock('가나다')], { lineIndex: 0, offset: 1 }, '2026-06-24');
    expect(blocksToText(r1.blocks)).toBe('가2026-06-24나다');
  });

  it('inserts at the start when offset is 0', () => {
    const r = insertDateAtCaret([textBlock('가나다')], { lineIndex: 0, offset: 0 }, '2026.06.24');
    expect(blocksToText(r.blocks)).toBe('2026.06.24가나다');
    expect(r.caretTextLine).toBe(0);
  });

  it('inserts at the end when offset equals line length', () => {
    const r = insertDateAtCaret([textBlock('가나다')], { lineIndex: 0, offset: 3 }, '2026.06.24');
    expect(blocksToText(r.blocks)).toBe('가나다2026.06.24');
    expect(r.caretTextLine).toBe(0);
  });

  it('uses the correct in-line column on a multi-line caret offset', () => {
    // blocksToText = 'abc\ndef'; second line starts at offset 4, so offset 5 → column 1 of 'def'.
    const r = insertDateAtCaret([textBlock('abc'), textBlock('def')], { lineIndex: 1, offset: 5 }, '06/24');
    expect(blocksToText(r.blocks).split('\n')).toEqual(['abc', 'd06/24ef']);
    expect(r.caretTextLine).toBe(1);
  });

  it('is a no-op for empty date string', () => {
    const input = [textBlock('가나다')];
    expect(insertDateAtCaret(input, { lineIndex: 0, offset: 1 }, '')).toEqual({
      blocks: [textBlock('가나다')], caretTextLine: null,
    });
  });

  it('is a no-op for null/undefined date string', () => {
    const input = [textBlock('가나다')];
    expect(insertDateAtCaret(input, { lineIndex: 0, offset: 1 }, null).caretTextLine).toBe(null);
    expect(insertDateAtCaret(input, { lineIndex: 0, offset: 1 }, undefined).caretTextLine).toBe(null);
    expect(blocksToText(insertDateAtCaret(input, { lineIndex: 0, offset: 1 }, '').blocks)).toBe('가나다');
  });

  it('is a no-op for whitespace-only date string', () => {
    const r = insertDateAtCaret([textBlock('가나다')], { lineIndex: 0, offset: 1 }, '   ');
    expect(r.caretTextLine).toBe(null);
    expect(blocksToText(r.blocks)).toBe('가나다');
  });

  it('falls back to the last text line end when caret is null', () => {
    const r = insertDateAtCaret([textBlock('첫줄'), textBlock('둘째줄')], null, '2026-06-24');
    expect(blocksToText(r.blocks).split('\n')).toEqual(['첫줄', '둘째줄2026-06-24']);
    expect(r.caretTextLine).toBe(1);
  });

  it('falls back to the last text line end when caret.lineIndex is out of range', () => {
    const r = insertDateAtCaret([textBlock('첫줄'), textBlock('둘째줄')], { lineIndex: 9, offset: 0 }, '2026-06-24');
    expect(blocksToText(r.blocks).split('\n')).toEqual(['첫줄', '둘째줄2026-06-24']);
    expect(r.caretTextLine).toBe(1);
  });

  it('creates a first text block when there is no text block (embed-only)', () => {
    const r = insertDateAtCaret([embedBlock({ embedType: 'image', src: 'x' })], null, '2026-06-24');
    expect(blocksToText(r.blocks)).toBe('2026-06-24');
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
    const r = insertDateAtCaret(input, { lineIndex: 1, offset: 2 }, '2026-06-24');
    expect(r.blocks).toEqual([
      textBlock('a'),
      embedBlock({ embedType: 'image', src: 'x' }),
      textBlock('2026-06-24b'),
    ]);
    expect(r.blocks.length).toBe(3);
    expect(r.caretTextLine).toBe(1);
  });

  it('preserves embed embedType/order/count when inserting (explicit invariant)', () => {
    const input = [
      embedBlock({ embedType: 'video', videoId: 'v1' }),
      textBlock('본문'),
      embedBlock({ embedType: 'image', src: 'p.png' }),
    ];
    const r = insertDateAtCaret(input, { lineIndex: 0, offset: 0 }, '2026-06-24');
    const embeds = r.blocks.filter((b) => b.type === 'embed');
    expect(embeds).toEqual([
      embedBlock({ embedType: 'video', videoId: 'v1' }),
      embedBlock({ embedType: 'image', src: 'p.png' }),
    ]);
    expect(r.blocks.length).toBe(3);
    expect(blocksToText(r.blocks)).toBe('2026-06-24본문');
  });

  it('does not change the "(끝)" text on fallback — inserts into the line before "(끝)"', () => {
    const input = [textBlock('본문'), textBlock(END_MARKER)];
    const r = insertDateAtCaret(input, null, '2026-06-24');
    expect(blocksToText(r.blocks).split('\n')).toEqual(['본문2026-06-24', '(끝)']);
    expect(r.caretTextLine).toBe(0);
  });

  it('falls back to before "(끝)" even when caret targets the "(끝)" line', () => {
    const input = [textBlock('본문'), textBlock(END_MARKER)];
    // caret lineIndex 1 == "(끝)" line — should not be modified; falls back to '본문'.
    const r = insertDateAtCaret(input, { lineIndex: 1, offset: 3 }, '2026-06-24');
    expect(blocksToText(r.blocks).split('\n')).toEqual(['본문2026-06-24', '(끝)']);
    expect(r.caretTextLine).toBe(0);
  });

  it('does not mutate the input blocks array or its elements', () => {
    const input = [
      textBlock('가나다'),
      embedBlock({ embedType: 'video', videoId: 'a' }),
    ];
    const snapshot = JSON.parse(JSON.stringify(input));
    const r = insertDateAtCaret(input, { lineIndex: 0, offset: 1 }, '2026-06-24');
    expect(input).toEqual(snapshot); // 입력 불변
    expect(r.blocks).not.toBe(input); // 새 배열
  });

  it('returns normalized blocks (drops unknown block types) on no-op', () => {
    const input = [textBlock('x'), { type: 'bogus' }];
    const r = insertDateAtCaret(input, { lineIndex: 0, offset: 0 }, '');
    expect(r.blocks).toEqual([textBlock('x')]);
    expect(r.caretTextLine).toBe(null);
  });

  // --- 경계/에러 경로 (실제 caret 좌표 어긋남·클램프 계약을 고정) ---

  it('trusts caret.lineIndex for the block and clamps the offset column to that block', () => {
    // blocksToText='ab\ncd'; offset 4 = "cd" 시작이지만 lineIndex 0(블록 'ab')을 신뢰한다.
    const r = insertDateAtCaret([textBlock('ab'), textBlock('cd')], { lineIndex: 0, offset: 4 }, 'X');
    expect(blocksToText(r.blocks).split('\n')).toEqual(['aXb', 'cd']);
    expect(r.caretTextLine).toBe(0);
  });

  it('clamps an over-large offset to the end of the target line', () => {
    const r = insertDateAtCaret([textBlock('가나다')], { lineIndex: 0, offset: 999 }, 'X');
    expect(blocksToText(r.blocks)).toBe('가나다X');
    expect(r.caretTextLine).toBe(0);
  });

  it('clamps a negative offset to the start of the target line', () => {
    const r = insertDateAtCaret([textBlock('가나다')], { lineIndex: 0, offset: -5 }, 'X');
    expect(blocksToText(r.blocks)).toBe('X가나다');
    expect(r.caretTextLine).toBe(0);
  });

  it('falls back when caret.lineIndex is not an integer', () => {
    const r = insertDateAtCaret([textBlock('첫'), textBlock('둘')], { lineIndex: 0.5, offset: 0 }, 'X');
    expect(blocksToText(r.blocks).split('\n')).toEqual(['첫', '둘X']);
    expect(r.caretTextLine).toBe(1);
  });

  it('inserts a multi-character date string intact at the column', () => {
    const r = insertDateAtCaret([textBlock('가나다')], { lineIndex: 0, offset: 1 }, '2026년 06월 24일');
    expect(blocksToText(r.blocks)).toBe('가2026년 06월 24일나다');
    expect(r.caretTextLine).toBe(0);
  });

  it('creates a text block and preserves the embed when a non-null caret targets a non-existent text line (embed-only)', () => {
    const r = insertDateAtCaret([embedBlock({ embedType: 'image', src: 'x' })], { lineIndex: 0, offset: 0 }, 'X');
    expect(blocksToText(r.blocks)).toBe('X');
    expect(r.caretTextLine).toBe(0);
    expect(r.blocks.some((b) => b.type === 'embed')).toBe(true);
    expect(r.blocks.length).toBe(2);
  });

  it('does not mutate the input on a no-op (empty date) either', () => {
    const input = [textBlock('가나다'), embedBlock({ embedType: 'image', src: 'x' })];
    const snapshot = JSON.parse(JSON.stringify(input));
    const r = insertDateAtCaret(input, { lineIndex: 0, offset: 1 }, '   ');
    expect(input).toEqual(snapshot);
    expect(r.blocks).not.toBe(input);
    expect(r.caretTextLine).toBe(null);
  });

  it('preserves the align field of the line the date is inserted into (승계)', () => {
    const r = insertDateAtCaret([textBlock('머리글', 'justify')], { lineIndex: 0, offset: 3 }, '2026-07-26');
    expect(r.blocks[0]).toEqual(textBlock('머리글2026-07-26', 'justify'));
    expect(r.blocks[0].align).toBe('justify');
  });

  it('does not add a spurious align key to an unaligned line', () => {
    const r = insertDateAtCaret([textBlock('머리글')], { lineIndex: 0, offset: 3 }, '2026-07-26');
    expect(r.blocks[0].text).toBe('머리글2026-07-26');
    expect('align' in r.blocks[0]).toBe(false);
  });

  it('does not add align to a newly created text block (embed-only fallback)', () => {
    const r = insertDateAtCaret([embedBlock({ embedType: 'image', src: 'x' })], null, '2026-07-26');
    const created = r.blocks.find((b) => b.type === 'text');
    expect(created.text).toBe('2026-07-26');
    expect('align' in created).toBe(false);
  });
});
