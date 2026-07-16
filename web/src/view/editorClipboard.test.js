import { describe, it, expect } from 'vitest';
import { insertPasteTextAtCaret } from './editorClipboard.js';
import {
  textBlock, embedBlock, blocksToText, END_MARKER,
} from './editorContent.js';

// 텍스트-only 기준 캐럿: lineIndex번째 텍스트 블록의 줄 안 offset(절대 텍스트 오프셋)으로 환산.
const caretAt = (blocks, lineIndex, inLine) => {
  const textBlocks = blocks.filter((b) => b.type === 'text');
  let off = 0;
  for (let i = 0; i < lineIndex; i += 1) off += textBlocks[i].text.length + 1;
  return { lineIndex, offset: off + inLine };
};

describe('editorClipboard — insertPasteTextAtCaret (마커-안전 텍스트 삽입)', () => {
  it('단일 줄을 캐럿 줄 안 컬럼에 삽입한다(changed:true, caretLineIndex 정확)', () => {
    const blocks = [textBlock('AB CD')];
    const r = insertPasteTextAtCaret(blocks, caretAt(blocks, 0, 2), 'X');
    expect(blocksToText(r.blocks)).toBe('ABX CD');
    expect(r.changed).toBe(true);
    expect(r.caretLineIndex).toBe(0);
  });

  it('다른 줄과 임베드는 단일 줄 삽입 시 불변', () => {
    const blocks = [
      textBlock('제목'),
      embedBlock({ embedType: 'image', src: 'x.png' }),
      textBlock('본문'),
    ];
    // text-line 1 = '본문' 끝(offset 5)에 삽입.
    const r = insertPasteTextAtCaret(blocks, caretAt(blocks, 1, 2), 'X');
    expect(r.blocks.map((b) => b.type)).toEqual(['text', 'embed', 'text']);
    expect(blocksToText(r.blocks)).toBe('제목\n본문X');
    expect(r.changed).toBe(true);
    expect(r.caretLineIndex).toBe(1);
  });

  it("다중 줄 'a\\nb\\nc'가 캐럿 위치에서 3개 텍스트 블록으로 분할된다", () => {
    const blocks = [textBlock('AB CD')];
    const r = insertPasteTextAtCaret(blocks, caretAt(blocks, 0, 2), 'a\nb\nc');
    // head='AB', tail=' CD' → ['ABa','b','c CD']
    expect(blocksToText(r.blocks)).toBe('ABa\nb\nc CD');
    expect(r.changed).toBe(true);
    expect(r.caretLineIndex).toBe(2);
  });

  it('다중 줄 삽입 시 임베드 위치가 보존된다', () => {
    const blocks = [
      textBlock('제목'),
      embedBlock({ embedType: 'image', src: 'x.png' }),
      textBlock('본문'),
    ];
    const r = insertPasteTextAtCaret(blocks, caretAt(blocks, 1, 2), 'a\nb');
    expect(r.blocks.map((b) => b.type)).toEqual(['text', 'embed', 'text', 'text']);
    expect(blocksToText(r.blocks)).toBe('제목\n본문a\nb');
    expect(r.caretLineIndex).toBe(2);
  });

  it('마커 가드: 캐럿이 "(끝)" 줄 시작이면 no-op(changed:false, 마커 불변)', () => {
    const blocks = [textBlock('본문'), textBlock(END_MARKER)];
    // full = '본문\n(끝)', markerStart = 3 → 캐럿 offset 3(마커 시작).
    const r = insertPasteTextAtCaret(blocks, { lineIndex: 1, offset: 3 }, 'X');
    expect(r.changed).toBe(false);
    expect(r.caretLineIndex).toBe(null);
    expect(blocksToText(r.blocks)).toBe('본문\n(끝)');
  });

  it('마커 가드: 캐럿이 "(끝)" 뒤면 no-op', () => {
    const blocks = [textBlock('본문'), textBlock(END_MARKER)];
    // full = '본문\n(끝)', length = 6 → 캐럿 offset 5(마커 뒤).
    const r = insertPasteTextAtCaret(blocks, { lineIndex: 1, offset: 5 }, 'X');
    expect(r.changed).toBe(false);
    expect(blocksToText(r.blocks)).toBe('본문\n(끝)');
  });

  it('마커 앞(offset < 마커 시작)에는 정상 삽입된다', () => {
    const blocks = [textBlock('본문'), textBlock(END_MARKER)];
    // offset 2 = '본문' 끝, markerStart 3 → 허용.
    const r = insertPasteTextAtCaret(blocks, { lineIndex: 0, offset: 2 }, 'X');
    expect(blocksToText(r.blocks)).toBe('본문X\n(끝)');
    expect(r.changed).toBe(true);
    expect(r.caretLineIndex).toBe(0);
  });

  it('캐럿 null + 마커 있음 → no-op(폴백이 마커 줄을 오염시키지 않도록)', () => {
    const blocks = [textBlock('본문'), textBlock(END_MARKER)];
    const r = insertPasteTextAtCaret(blocks, null, 'X');
    expect(r.changed).toBe(false);
    expect(blocksToText(r.blocks)).toBe('본문\n(끝)');
  });

  it('캐럿 null + 마커 없음 → 마지막 텍스트 줄 끝에 폴백 삽입', () => {
    const blocks = [textBlock('첫줄'), textBlock('둘째줄')];
    const r = insertPasteTextAtCaret(blocks, null, 'X');
    expect(blocksToText(r.blocks)).toBe('첫줄\n둘째줄X');
    expect(r.changed).toBe(true);
    expect(r.caretLineIndex).toBe(1);
  });

  it('빈 텍스트 → no-op(changed:false, caretLineIndex null)', () => {
    const r = insertPasteTextAtCaret([textBlock('가나다')], { lineIndex: 0, offset: 1 }, '');
    expect(r.changed).toBe(false);
    expect(r.caretLineIndex).toBe(null);
    expect(blocksToText(r.blocks)).toBe('가나다');
  });

  it('null/undefined 텍스트 → no-op', () => {
    const caret = { lineIndex: 0, offset: 1 };
    expect(insertPasteTextAtCaret([textBlock('가나다')], caret, null).changed).toBe(false);
    expect(insertPasteTextAtCaret([textBlock('가나다')], caret, undefined).changed).toBe(false);
  });

  it('임베드 섞인 본문에서 텍스트-줄 인덱스가 정확하다(임베드 제외 카운팅)', () => {
    const blocks = [
      textBlock('제목'),
      embedBlock({ embedType: 'video', videoId: 'a' }),
      textBlock('본문'),
    ];
    // text-line 1 = '본문' 끝에서 2줄 삽입 → caretLineIndex = 1 + 1 = 2.
    const r = insertPasteTextAtCaret(blocks, caretAt(blocks, 1, 2), 'x\ny');
    expect(blocksToText(r.blocks)).toBe('제목\n본문x\ny');
    expect(r.blocks.map((b) => b.type)).toEqual(['text', 'embed', 'text', 'text']);
    expect(r.caretLineIndex).toBe(2);
  });

  it('텍스트를 원본 그대로 삽입한다(앞뒤 공백 보존 — 트림 금지)', () => {
    const blocks = [textBlock('AB')];
    const r = insertPasteTextAtCaret(blocks, caretAt(blocks, 0, 2), '  공백  ');
    expect(blocksToText(r.blocks)).toBe('AB  공백  ');
  });

  it('\\r\\n·\\r 개행을 \\n으로 통일해 줄을 일관되게 분할한다', () => {
    const blocks = [textBlock('')];
    const r = insertPasteTextAtCaret(blocks, caretAt(blocks, 0, 0), 'a\r\nb\rc');
    expect(blocksToText(r.blocks)).toBe('a\nb\nc');
  });

  it('입력 blocks 배열/요소를 변형하지 않는다(새 배열)', () => {
    const input = [
      textBlock('가나다'),
      embedBlock({ embedType: 'video', videoId: 'a' }),
    ];
    const snapshot = JSON.parse(JSON.stringify(input));
    const r = insertPasteTextAtCaret(input, { lineIndex: 0, offset: 1 }, 'X');
    expect(input).toEqual(snapshot);
    expect(r.blocks).not.toBe(input);
  });

  it('no-op 시에도 정규화된 blocks를 돌려준다(알 수 없는 블록 타입 제거)', () => {
    const input = [textBlock('x'), { type: 'bogus' }];
    const r = insertPasteTextAtCaret(input, { lineIndex: 0, offset: 0 }, '');
    expect(r.blocks).toEqual([textBlock('x')]);
    expect(r.changed).toBe(false);
  });
});
