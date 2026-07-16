import { describe, it, expect } from 'vitest';
import {
  EDITOR_FORMAT, EDITOR_VERSION, END_MARKER,
  ALIGN_VALUES, isValidAlign,
  textBlock, embedBlock, isTextBlock, isEmbedBlock, normalizeBlocks,
  serialize, deserialize, blocksToText, textToBlocks, hasEndMarker,
} from './editorContent.js';

describe('editorContent — block model', () => {
  it('serialize wraps blocks in the yh-editor document shape', () => {
    const doc = JSON.parse(serialize([textBlock('제목'), textBlock('본문')]));
    expect(doc).toEqual({
      format: EDITOR_FORMAT,
      version: EDITOR_VERSION,
      blocks: [{ type: 'text', text: '제목' }, { type: 'text', text: '본문' }],
    });
  });

  it('round-trips text + embed blocks preserving order', () => {
    const blocks = [
      textBlock('제목'),
      textBlock('본문 한 줄'),
      embedBlock({ embedType: 'image', src: 'x.png' }),
      textBlock('더 본문'),
    ];
    const restored = deserialize(serialize(blocks));
    expect(restored).toEqual(blocks);
  });

  it('deserialize loads legacy plain text into one text block per line', () => {
    expect(deserialize('제목\n부제\n본문')).toEqual([
      { type: 'text', text: '제목' },
      { type: 'text', text: '부제' },
      { type: 'text', text: '본문' },
    ]);
  });

  it('deserialize accepts a blocks array or a doc object', () => {
    expect(deserialize([textBlock('a')])).toEqual([{ type: 'text', text: 'a' }]);
    expect(deserialize({ blocks: [textBlock('b')] })).toEqual([{ type: 'text', text: 'b' }]);
  });

  it('deserialize returns [] for empty/null', () => {
    expect(deserialize('')).toEqual([]);
    expect(deserialize(null)).toEqual([]);
    expect(deserialize(undefined)).toEqual([]);
  });

  it('normalizeBlocks drops unknown blocks and coerces text', () => {
    expect(normalizeBlocks([{ type: 'text', text: 1 }, { type: 'bogus' }, embedBlock({ embedType: 'video' })]))
      .toEqual([{ type: 'text', text: '1' }, { type: 'embed', embedType: 'video' }]);
  });

  it('isTextBlock / isEmbedBlock distinguish block types', () => {
    expect(isTextBlock(textBlock('x'))).toBe(true);
    expect(isEmbedBlock(textBlock('x'))).toBe(false);
    expect(isEmbedBlock(embedBlock({ embedType: 'image' }))).toBe(true);
  });

  it('blocksToText joins only text blocks (embeds excluded)', () => {
    const blocks = [textBlock('제목'), embedBlock({ embedType: 'image' }), textBlock('본문')];
    expect(blocksToText(blocks)).toBe('제목\n본문');
  });

  it('textToBlocks splits lines into text blocks', () => {
    expect(textToBlocks('a\nb')).toEqual([{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }]);
  });

  it('hasEndMarker detects the "(끝)" marker in text blocks', () => {
    expect(hasEndMarker([textBlock('본문'), textBlock(END_MARKER)])).toBe(true);
    expect(hasEndMarker([textBlock('본문')])).toBe(false);
  });
});

describe('editorContent — align 필드 (보기 정렬)', () => {
  it('ALIGN_VALUES / isValidAlign whitelist the 4 alignments', () => {
    expect(ALIGN_VALUES).toEqual(['left', 'center', 'right', 'justify']);
    for (const v of ALIGN_VALUES) expect(isValidAlign(v)).toBe(true);
    expect(isValidAlign('bogus')).toBe(false);
    expect(isValidAlign(undefined)).toBe(false);
    expect(isValidAlign(null)).toBe(false);
  });

  it('textBlock attaches only a valid align, omitting the key otherwise', () => {
    expect(textBlock('x', 'right')).toEqual({ type: 'text', text: 'x', align: 'right' });
    expect(textBlock('x')).toEqual({ type: 'text', text: 'x' });
    expect(textBlock('x', 'bad')).toEqual({ type: 'text', text: 'x' });
    expect('align' in textBlock('x')).toBe(false);
    expect('align' in textBlock('x', 'bad')).toBe(false);
  });

  it('normalizeBlocks preserves a valid align and drops an invalid/absent one', () => {
    expect(normalizeBlocks([{ type: 'text', text: 'a', align: 'center' }]))
      .toEqual([{ type: 'text', text: 'a', align: 'center' }]);
    expect(normalizeBlocks([{ type: 'text', text: 'a', align: 'bogus' }]))
      .toEqual([{ type: 'text', text: 'a' }]);
    expect(normalizeBlocks([{ type: 'text', text: 'a' }]))
      .toEqual([{ type: 'text', text: 'a' }]);
  });

  it('normalizeBlocks leaves embed blocks untouched (align only affects text)', () => {
    const embed = embedBlock({ embedType: 'image', src: 'x', align: 'center' });
    expect(normalizeBlocks([embed])).toEqual([{ type: 'embed', embedType: 'image', src: 'x', align: 'center' }]);
  });

  it('serialize→deserialize round-trips align on text blocks', () => {
    const blocks = [textBlock('제목', 'center'), textBlock('본문')];
    expect(deserialize(serialize(blocks))).toEqual(blocks);
  });

  it('un-aligned block serialization has no align key (byte-stable 하위호환)', () => {
    const json = serialize([textBlock('본문')]);
    expect(json).not.toContain('align');
    expect(JSON.parse(json).blocks[0]).toEqual({ type: 'text', text: '본문' });
  });
});
