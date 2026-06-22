import { describe, it, expect } from 'vitest';
import {
  isFindReplace, findMatches, nextMatchIndex, replaceOne, replaceAll,
} from './editorFind.js';
import { textBlock, embedBlock } from './editorContent.js';

describe('editorFind — key recognition (Ctrl+F)', () => {
  it('recognizes Ctrl+F, and not Alt+F', () => {
    expect(isFindReplace({ ctrlKey: true, key: 'f' })).toBe(true);
    expect(isFindReplace({ ctrlKey: true, key: 'F' })).toBe(true);
    expect(isFindReplace({ ctrlKey: true, code: 'KeyF' })).toBe(true);
    expect(isFindReplace({ altKey: true, key: 'f' })).toBe(false);
    expect(isFindReplace({ ctrlKey: true, altKey: true, key: 'f' })).toBe(false);
    expect(isFindReplace({ key: 'f' })).toBe(false);
  });
});

describe('editorFind — findMatches', () => {
  it('finds non-overlapping literal substrings (absolute offsets)', () => {
    expect(findMatches('abcabc', 'bc')).toEqual([{ start: 1, end: 3 }, { start: 4, end: 6 }]);
  });

  it('is case-insensitive by default, case-sensitive on request', () => {
    expect(findMatches('AbAb', 'ab')).toEqual([{ start: 0, end: 2 }, { start: 2, end: 4 }]);
    expect(findMatches('AbAb', 'ab', { caseSensitive: true })).toEqual([]);
  });

  it('returns [] for empty/null query', () => {
    expect(findMatches('x', '')).toEqual([]);
    expect(findMatches('x', null)).toEqual([]);
    expect(findMatches('x', undefined)).toEqual([]);
  });

  it('scans non-overlapping (aaaa / aa → 2)', () => {
    expect(findMatches('aaaa', 'aa')).toEqual([{ start: 0, end: 2 }, { start: 2, end: 4 }]);
  });

  it('treats the query as a literal (regex metachars are not special)', () => {
    expect(findMatches('a.b.c', '.')).toEqual([{ start: 1, end: 2 }, { start: 3, end: 4 }]);
    expect(findMatches('a+b', '.')).toEqual([]);
  });

  it('finds across newlines in the source text by absolute offset', () => {
    // 'ab\nab' → second 'ab' starts at offset 3
    expect(findMatches('ab\nab', 'ab')).toEqual([{ start: 0, end: 2 }, { start: 3, end: 5 }]);
  });
});

describe('editorFind — nextMatchIndex', () => {
  const matches = [{ start: 1, end: 3 }, { start: 4, end: 6 }];

  it('returns the index of the next match forward, wrapping at the end', () => {
    expect(nextMatchIndex(matches, 2)).toBe(1);
    expect(nextMatchIndex(matches, 0)).toBe(0);
    expect(nextMatchIndex(matches, 6)).toBe(0); // wrap
  });

  it('returns the index of the previous match backward, wrapping at the start', () => {
    expect(nextMatchIndex(matches, 4, { forward: false })).toBe(0);
    expect(nextMatchIndex(matches, 5, { forward: false })).toBe(1);
    expect(nextMatchIndex(matches, 0, { forward: false })).toBe(1); // wrap to last
  });

  it('returns -1 for an empty match list', () => {
    expect(nextMatchIndex([], 0)).toBe(-1);
    expect(nextMatchIndex([], 3, { forward: false })).toBe(-1);
  });
});

describe('editorFind — replaceOne', () => {
  it('replaces only the first match (from fromOffset), keeps "(끝)" block intact', () => {
    const input = [textBlock('foo bar foo'), textBlock('(끝)')];
    const r = replaceOne(input, 'foo', 'X');
    expect(r.replaced).toBe(true);
    expect(r.matchStart).toBe(0);
    expect(r.caretOffset).toBe(1); // matchStart + 'X'.length
    expect(r.blocks).toEqual([textBlock('X bar foo'), textBlock('(끝)')]);
  });

  it('respects fromOffset (replaces the next match after it)', () => {
    const r = replaceOne([textBlock('foo bar foo')], 'foo', 'X', { fromOffset: 1 });
    expect(r.matchStart).toBe(8); // second 'foo'
    expect(r.blocks).toEqual([textBlock('foo bar X')]);
  });

  it('wraps to the first match when fromOffset is past the last match', () => {
    const r = replaceOne([textBlock('foo bar foo')], 'foo', 'X', { fromOffset: 100 });
    expect(r.matchStart).toBe(0);
    expect(r.blocks).toEqual([textBlock('X bar foo')]);
  });

  it('replaces within the correct text line, ignoring embeds', () => {
    const input = [textBlock('aaa'), embedBlock({ embedType: 'image', src: 'x' }), textBlock('aaa')];
    const r = replaceOne(input, 'aaa', 'Z', { fromOffset: 1 });
    // blocksToText = 'aaa\naaa'; second match at offset 4
    expect(r.matchStart).toBe(4);
    expect(r.blocks).toEqual([
      textBlock('aaa'), embedBlock({ embedType: 'image', src: 'x' }), textBlock('Z'),
    ]);
  });

  it('is a no-op when there is no match', () => {
    const r = replaceOne([textBlock('abc')], 'zzz', 'X');
    expect(r).toEqual({
      blocks: [textBlock('abc')], replaced: false, matchStart: null, caretOffset: null,
    });
  });

  it('is a no-op for an empty query', () => {
    const r = replaceOne([textBlock('abc')], '', 'X');
    expect(r.replaced).toBe(false);
    expect(r.blocks).toEqual([textBlock('abc')]);
  });

  it('does not mutate the input blocks', () => {
    const input = [textBlock('foo'), embedBlock({ embedType: 'image', src: 'x' })];
    const snapshot = JSON.parse(JSON.stringify(input));
    replaceOne(input, 'foo', 'X');
    expect(input).toEqual(snapshot);
  });
});

describe('editorFind — replaceAll', () => {
  it('replaces every match across text blocks, leaving embeds untouched', () => {
    const input = [textBlock('foo'), embedBlock({ embedType: 'image', src: 'x' }), textBlock('foo')];
    const r = replaceAll(input, 'foo', 'X');
    expect(r.count).toBe(2);
    expect(r.blocks).toEqual([
      textBlock('X'), embedBlock({ embedType: 'image', src: 'x' }), textBlock('X'),
    ]);
  });

  it('replaces multiple matches within one text block', () => {
    const r = replaceAll([textBlock('foo foo foo')], 'foo', 'X');
    expect(r.count).toBe(3);
    expect(r.blocks).toEqual([textBlock('X X X')]);
  });

  it('is case-insensitive by default', () => {
    const r = replaceAll([textBlock('Foo foo FOO')], 'foo', 'X');
    expect(r.count).toBe(3);
    expect(r.blocks).toEqual([textBlock('X X X')]);
  });

  it('is a no-op for an empty query', () => {
    const r = replaceAll([textBlock('abc')], '', 'X');
    expect(r).toEqual({ blocks: [textBlock('abc')], count: 0 });
  });

  it('keeps block order/count and does not mutate input', () => {
    const input = [textBlock('foo'), embedBlock({ embedType: 'video', videoId: 'a' }), textBlock('bar foo')];
    const snapshot = JSON.parse(JSON.stringify(input));
    const r = replaceAll(input, 'foo', 'X');
    expect(r.blocks.length).toBe(3);
    expect(r.blocks[1]).toEqual(embedBlock({ embedType: 'video', videoId: 'a' }));
    expect(input).toEqual(snapshot); // 입력 불변
  });
});
