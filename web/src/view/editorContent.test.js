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

// 전량 드롭 폴백 계약 — JSON 파싱엔 성공했지만 정규화가 원소를 전부 버리는 문자열은
// 평문 폴백으로 원문 텍스트를 보존한다(저장 왕복 시 원본 영구 소실 방지).
// 예외(폴백 금지): 의도된 빈 문서 · 부분 드롭(정상 블록이 하나라도 남는 경우).
describe('editorContent — deserialize 전량 드롭 폴백 (원문 보존)', () => {
  it('falls back to plain text for a JSON string array (블록 스키마 아님)', () => {
    const raw = JSON.stringify(['첫 줄 원문', '둘째 줄 원문', '셋째 줄 원문']);
    const blocks = deserialize(raw);
    expect(blocks.length).toBeGreaterThan(0);
    expect(blocks.every(isTextBlock)).toBe(true);
    expect(blocks.map((b) => b.text).join('\n')).toBe(raw);
  });

  it('falls back preserving each line for pretty-printed non-block JSON (여러 줄)', () => {
    const raw = JSON.stringify(['원문 가', '원문 나'], null, 2);
    const blocks = deserialize(raw);
    expect(blocks.length).toBeGreaterThan(1);
    expect(blocks.map((b) => b.text).join('\n')).toBe(raw);
  });

  it('falls back for an array of foreign-schema objects', () => {
    const raw = JSON.stringify([{ paragraph: '원본 문단 하나' }, { paragraph: '원본 문단 둘' }]);
    const blocks = deserialize(raw);
    expect(blocks.length).toBeGreaterThan(0);
    expect(blocks.every(isTextBlock)).toBe(true);
    expect(blocks.map((b) => b.text).join('\n')).toBe(raw);
  });

  it('falls back for a doc object whose blocks are all unknown types (배열 분기와 대칭)', () => {
    const raw = JSON.stringify({ format: 'other-editor', blocks: [{ kind: 'p', body: '살릴 원문' }] });
    const blocks = deserialize(raw);
    expect(blocks.length).toBeGreaterThan(0);
    expect(blocks.every(isTextBlock)).toBe(true);
    expect(blocks.map((b) => b.text).join('\n')).toBe(raw);
  });

  it('keeps intentionally empty documents empty (폴백 금지 — 회귀 잠금)', () => {
    expect(deserialize('[]')).toEqual([]);
    expect(deserialize(serialize([]))).toEqual([]);
    expect(deserialize(JSON.stringify({ format: EDITOR_FORMAT, version: EDITOR_VERSION, blocks: [] }))).toEqual([]);
  });

  it('keeps partial-drop behavior: 정상 블록이 남으면 폴백하지 않는다 (경계 잠금)', () => {
    expect(deserialize(JSON.stringify([{ type: 'text', text: '정상 블록' }, { kind: 'bogus' }])))
      .toEqual([{ type: 'text', text: '정상 블록' }]);
    expect(deserialize(JSON.stringify({ blocks: [{ type: 'text', text: '정상 블록' }, { kind: 'bogus' }] })))
      .toEqual([{ type: 'text', text: '정상 블록' }]);
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
