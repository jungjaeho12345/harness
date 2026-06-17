import { describe, it, expect } from 'vitest';
import {
  appendEndMarker, hasEndMarker, isInputBlocked, insertTextIntoBlocks,
} from './editorNewline.js';
import {
  textBlock, embedBlock, blocksToText, isTextBlock,
} from './editorContent.js';

describe('editorNewline — "(끝)" placement & input blocking', () => {
  it('appends "(끝)" on its own line after the body', () => {
    expect(appendEndMarker('본문')).toBe('본문\n(끝)');
  });

  it('does not add a double newline when body already ends with newline or is empty', () => {
    expect(appendEndMarker('본문\n')).toBe('본문\n(끝)');
    expect(appendEndMarker('')).toBe('(끝)');
  });

  it('does not insert "(끝)" again if it already exists (no duplicate)', () => {
    expect(appendEndMarker('본문\n(끝)')).toBe('본문\n(끝)');
  });

  it('hasEndMarker reflects presence', () => {
    expect(hasEndMarker('본문\n(끝)')).toBe(true);
    expect(hasEndMarker('본문')).toBe(false);
  });

  it('blocks input at or after the marker, allows input before it', () => {
    const text = '본문\n(끝)';
    const markerStart = text.indexOf('(끝)');
    expect(isInputBlocked(text, markerStart)).toBe(true); // 마커 시작
    expect(isInputBlocked(text, text.length)).toBe(true); // 마커 뒤
    expect(isInputBlocked(text, markerStart - 1)).toBe(false); // 앞 줄(개행 위치)
    expect(isInputBlocked(text, 0)).toBe(false);
  });

  it('never blocks when there is no marker', () => {
    expect(isInputBlocked('본문', 0)).toBe(false);
    expect(isInputBlocked('본문', 2)).toBe(false);
  });
});

describe('editorNewline — insertTextIntoBlocks (Enter 분할 / 여러 줄 삽입)', () => {
  // 텍스트-only 기준 캐럿: lineIndex번째 텍스트 블록의 줄 안 offset(절대 텍스트 오프셋)으로 환산.
  const caretAt = (blocks, lineIndex, inLine) => {
    const textBlocks = blocks.filter(isTextBlock);
    let off = 0;
    for (let i = 0; i < lineIndex; i += 1) off += textBlocks[i].text.length + 1;
    return { lineIndex, offset: off + inLine };
  };

  it('Enter("\\n")는 캐럿이 속한 줄을 head/tail 두 줄로 분할한다', () => {
    const blocks = [textBlock('AB CD')];
    const r = insertTextIntoBlocks(blocks, caretAt(blocks, 0, 2), '\n');
    expect(blocksToText(r.blocks)).toBe('AB\n CD');
    expect(r.caretLineIndex).toBe(1); // 새 줄(tail)에 캐럿
  });

  it('줄 끝에서 Enter는 뒤에 빈 줄을 추가한다', () => {
    const blocks = [textBlock('줄1'), textBlock('줄2')];
    const r = insertTextIntoBlocks(blocks, caretAt(blocks, 1, 2), '\n'); // 줄2 끝
    expect(blocksToText(r.blocks)).toBe('줄1\n줄2\n');
    expect(r.caretLineIndex).toBe(2);
  });

  it('캐럿이 null이면(라인 래퍼 없음) 마지막 텍스트 줄 끝에 빈 줄을 붙인다', () => {
    const r = insertTextIntoBlocks([textBlock('줄1')], null, '\n');
    expect(blocksToText(r.blocks)).toBe('줄1\n');
    expect(r.caretLineIndex).toBe(1);
  });

  it('완전히 빈 본문([])에서 Enter는 빈 줄 두 개가 된다', () => {
    const r = insertTextIntoBlocks([], null, '\n');
    expect(blocksToText(r.blocks)).toBe('\n');
    expect(r.caretLineIndex).toBe(1);
  });

  it('여러 줄 텍스트 삽입은 head+첫줄 … 끝줄+tail로 개행을 보존한다', () => {
    const blocks = [textBlock('AB CD')];
    const r = insertTextIntoBlocks(blocks, caretAt(blocks, 0, 2), 'x\ny');
    expect(blocksToText(r.blocks)).toBe('ABx\ny CD');
    expect(r.caretLineIndex).toBe(1);
  });

  it('임베드는 위치를 보존하고 텍스트 블록만 분할한다', () => {
    const blocks = [textBlock('제목'), embedBlock({ embedType: 'image', src: 'x.png' }), textBlock('본문')];
    // 두 번째 텍스트 블록(본문, lineIndex 1) 끝에서 Enter.
    const r = insertTextIntoBlocks(blocks, caretAt(blocks, 1, 2), '\n');
    expect(r.blocks.map((b) => b.type)).toEqual(['text', 'embed', 'text', 'text']);
    expect(blocksToText(r.blocks)).toBe('제목\n본문\n');
    expect(r.caretLineIndex).toBe(2);
  });
});
