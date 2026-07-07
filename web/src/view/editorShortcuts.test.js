import { describe, it, expect } from 'vitest';
import {
  isInsertEndMarker, isDeleteLine, insertEndMarker, deleteLineAt,
  CONTINUE_MARKER, isInsertContinueMarker, insertContinueMarker,
  transformTextLine, toUpper, toLower, capitalizeFirst, toggleCase,
  isGlyphInput, isPasteOriginal,
} from './editorShortcuts.js';
import { textBlock, embedBlock, END_MARKER, blocksToText } from './editorContent.js';

describe('editorShortcuts — key recognition', () => {
  it('recognizes Alt+Y (insert end marker)', () => {
    expect(isInsertEndMarker({ altKey: true, key: 'y' })).toBe(true);
    expect(isInsertEndMarker({ altKey: true, code: 'KeyY' })).toBe(true);
    expect(isInsertEndMarker({ altKey: true, ctrlKey: true, key: 'y' })).toBe(false);
    expect(isInsertEndMarker({ key: 'y' })).toBe(false);
  });

  it('recognizes Ctrl+D (delete line)', () => {
    expect(isDeleteLine({ ctrlKey: true, key: 'd' })).toBe(true);
    expect(isDeleteLine({ ctrlKey: true, code: 'KeyD' })).toBe(true);
    expect(isDeleteLine({ key: 'd' })).toBe(false);
  });

  it('recognizes Alt+O (glyph input), and not Alt+Y / Ctrl+O', () => {
    expect(isGlyphInput({ altKey: true, key: 'o' })).toBe(true);
    expect(isGlyphInput({ altKey: true, key: 'O' })).toBe(true);
    expect(isGlyphInput({ altKey: true, code: 'KeyO' })).toBe(true);
    // ctrl 동반은 인식하지 않는다(다른 조합 오인 방지).
    expect(isGlyphInput({ altKey: true, ctrlKey: true, key: 'o' })).toBe(false);
    // alt 없는 'o'(타이핑)나 Alt+Y는 인식하지 않는다.
    expect(isGlyphInput({ key: 'o' })).toBe(false);
    expect(isGlyphInput({ altKey: true, key: 'y' })).toBe(false);
    expect(isGlyphInput(null)).toBe(false);
  });

  it('recognizes Alt+V (원본 붙여넣기), and not Ctrl+V / plain v', () => {
    expect(isPasteOriginal({ altKey: true, key: 'v' })).toBe(true);
    expect(isPasteOriginal({ altKey: true, key: 'V' })).toBe(true);
    expect(isPasteOriginal({ altKey: true, code: 'KeyV' })).toBe(true);
    // Ctrl+V(브라우저 기본 붙여넣기)·Ctrl 동반 조합은 오인하지 않는다.
    expect(isPasteOriginal({ ctrlKey: true, key: 'v' })).toBe(false);
    expect(isPasteOriginal({ altKey: true, ctrlKey: true, key: 'v' })).toBe(false);
    expect(isPasteOriginal({ key: 'v' })).toBe(false);
    expect(isPasteOriginal(null)).toBe(false);
  });
});

describe('editorShortcuts — insert "(끝)" (Alt+Y)', () => {
  it('appends "(끝)" as the final block after embeds, and turns spellcheck on', () => {
    const blocks = [textBlock('본문'), embedBlock({ embedType: 'image', src: 'x' })];
    const r = insertEndMarker(blocks);
    expect(r.inserted).toBe(true);
    expect(r.spellcheck).toBe(true);
    expect(r.blocks[r.blocks.length - 1]).toEqual(textBlock(END_MARKER));
  });

  it('does not insert a duplicate "(끝)"', () => {
    const blocks = [textBlock('본문'), textBlock(END_MARKER)];
    const r = insertEndMarker(blocks);
    expect(r.inserted).toBe(false);
    expect(r.blocks).toEqual(blocks);
    expect(r.spellcheck).toBe(true);
  });
});

describe('editorShortcuts — delete line (Ctrl+D / Backspace / Delete)', () => {
  it('removes the text line and its companion embed (one at a time)', () => {
    const blocks = [
      textBlock('제목'),
      textBlock('본문'),
      embedBlock({ embedType: 'image', src: 'x' }),
      textBlock('다음'),
    ];
    const r = deleteLineAt(blocks, 1); // "본문" 라인 + 바로 뒤 임베드 동반 삭제
    expect(r.removedEmbed).toBe(true);
    expect(r.blocks).toEqual([textBlock('제목'), textBlock('다음')]);
  });

  it('removes only the line when it has no companion embed', () => {
    const blocks = [textBlock('제목'), textBlock('본문')];
    const r = deleteLineAt(blocks, 0);
    expect(r.removedEmbed).toBe(false);
    expect(r.blocks).toEqual([textBlock('본문')]);
  });

  it('removes a single embed when the embed line itself is targeted', () => {
    const blocks = [textBlock('제목'), embedBlock({ embedType: 'video', videoId: 'a' }), textBlock('끝줄')];
    const r = deleteLineAt(blocks, 1);
    expect(r.removedEmbed).toBe(false);
    expect(r.blocks).toEqual([textBlock('제목'), textBlock('끝줄')]);
  });

  it('is a no-op for out-of-range indexes', () => {
    const blocks = [textBlock('x')];
    expect(deleteLineAt(blocks, 5)).toEqual({ blocks, removed: null, removedEmbed: false });
  });
});

describe('editorShortcuts — insert "(계속)" (Ctrl+Y)', () => {
  it('recognizes Ctrl+Y, and not Alt+Y', () => {
    expect(isInsertContinueMarker({ ctrlKey: true, key: 'y' })).toBe(true);
    expect(isInsertContinueMarker({ ctrlKey: true, code: 'KeyY' })).toBe(true);
    expect(isInsertContinueMarker({ altKey: true, key: 'y' })).toBe(false);
    expect(isInsertContinueMarker({ ctrlKey: true, altKey: true, key: 'y' })).toBe(false);
    expect(isInsertContinueMarker({ key: 'y' })).toBe(false);
    expect(CONTINUE_MARKER).toBe('(계속)');
  });

  it('inserts "(계속)" after the given text line (no blank line), caret on it', () => {
    const r = insertContinueMarker([textBlock('a'), textBlock('b')], 0);
    expect(blocksToText(r.blocks).split('\n')).toEqual(['a', '(계속)', 'b']);
    expect(r.caretTextLine).toBe(1);
  });

  it('keeps "(끝)" as the final block when textLineIndex is null (fallback)', () => {
    const r = insertContinueMarker([textBlock('a'), textBlock(END_MARKER)], null);
    expect(blocksToText(r.blocks).split('\n')).toEqual(['a', '(계속)', '(끝)']);
    expect(r.caretTextLine).toBe(1);
  });

  it('preserves embed order and does not mutate the input', () => {
    const input = [textBlock('a'), embedBlock({ embedType: 'image', src: 'x' }), textBlock('b')];
    const snapshot = JSON.parse(JSON.stringify(input));
    const r = insertContinueMarker(input, 0); // 텍스트-줄 0('a') 다음 → 'a', '(계속)', embed, 'b'
    expect(r.blocks).toEqual([
      textBlock('a'), textBlock(CONTINUE_MARKER),
      embedBlock({ embedType: 'image', src: 'x' }), textBlock('b'),
    ]);
    expect(blocksToText(r.blocks).split('\n')).toEqual(['a', '(계속)', 'b']);
    expect(input).toEqual(snapshot); // 입력 불변
  });

  it('is not idempotent — inserting twice yields two markers', () => {
    const once = insertContinueMarker([textBlock('a')], 0);
    const twice = insertContinueMarker(once.blocks, 0);
    expect(blocksToText(twice.blocks).split('\n')).toEqual(['a', '(계속)', '(계속)']);
  });
});

describe('editorShortcuts — case transforms (보기 메뉴)', () => {
  it('string transforms are pure', () => {
    expect(toUpper('aB')).toBe('AB');
    expect(toLower('aB')).toBe('ab');
    expect(capitalizeFirst('aBC')).toBe('Abc');
    expect(toggleCase('aBc')).toBe('AbC');
  });

  it('transformTextLine applies fn to the targeted text line only', () => {
    const r = transformTextLine([textBlock('abc'), textBlock('def')], 1, toUpper);
    expect(blocksToText(r.blocks).split('\n')).toEqual(['abc', 'DEF']);
  });

  it('leaves embeds and other lines untouched (text-line index, not absolute)', () => {
    const blocks = [textBlock('a'), embedBlock({ embedType: 'image', src: 'x' }), textBlock('b')];
    const r = transformTextLine(blocks, 1, toUpper); // 텍스트-줄 1 = 'b'
    expect(r.blocks[1]).toEqual(embedBlock({ embedType: 'image', src: 'x' }));
    expect(blocksToText(r.blocks).split('\n')).toEqual(['a', 'B']);
  });

  it('is a no-op for out-of-range text-line index', () => {
    const blocks = [textBlock('a')];
    expect(transformTextLine(blocks, 5, toUpper).blocks).toEqual(blocks);
  });
});
