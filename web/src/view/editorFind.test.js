import { describe, it, expect } from 'vitest';
import {
  isFindReplace, findMatches, nextMatchIndex, replaceOne, replaceAll,
} from './editorFind.js';
import { textBlock, embedBlock, END_MARKER } from './editorContent.js';

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

describe('editorFind — "(끝)" 종료 마커 보존 (매치가 마커 블록 안에 있는 경우)', () => {
  // 배경: 기존 마커 테스트는 매치가 마커 밖에 있어 우연히 통과했다. 여기서는 query가
  // 마커 텍스트 자체('끝'·'(')와 겹치는 케이스로, 치환이 마커를 훼손하지 않음을 단언한다.
  // (형제 도구 abbrevConvert/simpTradConvert/editorGlyph/editorDate와 동일 가드 — 송고 마커 무결성.)

  it('replaceAll: 마커 블록 안의 매치는 치환·카운트하지 않는다 (끝→끗)', () => {
    const input = [textBlock('한국은 끝났다'), textBlock(END_MARKER)];
    const r = replaceAll(input, '끝', '끗');
    expect(r.blocks).toEqual([textBlock('한국은 끗났다'), textBlock(END_MARKER)]);
    expect(r.count).toBe(1); // 마커 안 매치('(끝)'의 '끝')는 세지 않는다.
  });

  it('replaceAll: query가 괄호여도 "(끝)" 블록은 그대로 유지된다 ((→[)', () => {
    const input = [textBlock('본문 (참고) 텍스트'), textBlock(END_MARKER)];
    const r = replaceAll(input, '(', '[');
    expect(r.blocks).toEqual([textBlock('본문 [참고) 텍스트'), textBlock(END_MARKER)]);
    expect(r.count).toBe(1); // 마커의 '('는 카운트 제외.
  });

  it('replaceOne: fromOffset이 마커 블록의 매치를 가리켜도 마커는 치환되지 않는다', () => {
    // blocksToText = '끝내주는 기사\n(끝)' — '끝' 매치는 offset 0(본문)과 9(마커 안).
    const input = [textBlock('끝내주는 기사'), textBlock(END_MARKER)];
    const r = replaceOne(input, '끝', '끗', { fromOffset: 9 });
    expect(r.replaced).toBe(false); // 마커 매치의 바꾸기는 no-op(의도된 안전 동작).
    expect(r.blocks).toEqual([textBlock('끝내주는 기사'), textBlock(END_MARKER)]);
  });

  it('replaceOne: 마커 밖 매치는 기존과 동일하게 치환된다 (마커 블록 불변)', () => {
    const input = [textBlock('끝내주는 기사'), textBlock(END_MARKER)];
    const r = replaceOne(input, '끝', '끗', { fromOffset: 0 });
    expect(r.replaced).toBe(true);
    expect(r.matchStart).toBe(0);
    expect(r.blocks).toEqual([textBlock('끗내주는 기사'), textBlock(END_MARKER)]);
  });

  it('replaceOne: 유일한 매치가 마커 안이면 no-op이고 입력은 훼손되지 않는다', () => {
    const input = [textBlock('본문'), textBlock(END_MARKER)];
    const snapshot = JSON.parse(JSON.stringify(input));
    const r = replaceOne(input, END_MARKER, 'X');
    expect(r.replaced).toBe(false);
    expect(r.blocks).toEqual(snapshot);
    expect(input).toEqual(snapshot); // 입력 불변
  });
});

describe('editorFind — plan-reviewer edge cases', () => {
  // (a) 첫 Ctrl+F 직후 빈 query 상태에서 매치 0개 — 다이얼로그 초기 상태(query='')에서 카운트/하이라이트가 비어야 한다.
  it('yields zero matches for an initial empty query state (just after Ctrl+F)', () => {
    expect(isFindReplace({ ctrlKey: true, key: 'f' })).toBe(true); // Ctrl+F가 다이얼로그를 연다
    // 다이얼로그가 막 열린 상태: query는 빈 문자열 — findMatches/nextMatchIndex 모두 비어야 한다.
    const matches = findMatches('아무 본문 텍스트', '');
    expect(matches).toEqual([]);
    expect(nextMatchIndex(matches, 0)).toBe(-1);
    // 바꾸기도 빈 query면 no-op이어야 한다.
    expect(replaceOne([textBlock('아무 본문 텍스트')], '', 'X').replaced).toBe(false);
    expect(replaceAll([textBlock('아무 본문 텍스트')], '', 'X').count).toBe(0);
  });

  // (b) replacement가 query를 다시 포함('foo'→'xfoox')해도, caretOffset를 다음 fromOffset으로 피드백하는
  //     "바꾸고 계속" 루프가 같은 자리를 무한 재매치하지 않도록 caretOffset/matchStart 진행이 단조 증가해야 한다.
  it('advances caretOffset monotonically when the replacement re-contains the query', () => {
    let blocks = [textBlock('foo')];
    let fromOffset = 0;
    let prevCaret = -1;
    let prevMatchStart = -1;
    for (let i = 0; i < 4; i += 1) {
      const r = replaceOne(blocks, 'foo', 'xfoox', { fromOffset });
      expect(r.replaced).toBe(true);
      // 진행 단조성: 매번 매치 시작/캐럿이 직전보다 엄격히 커야 한다(같은 자리 정체 금지).
      expect(r.matchStart).toBeGreaterThan(prevMatchStart);
      expect(r.caretOffset).toBeGreaterThan(prevCaret);
      // caretOffset은 항상 방금 삽입한 replacement 끝 = matchStart + 'xfoox'.length.
      expect(r.caretOffset).toBe(r.matchStart + 'xfoox'.length);
      prevMatchStart = r.matchStart;
      prevCaret = r.caretOffset;
      blocks = r.blocks;
      fromOffset = r.caretOffset; // 다이얼로그가 다음 탐색 시작점으로 caretOffset를 쓴다.
    }
  });
});
