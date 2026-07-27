import { describe, it, expect } from 'vitest';
import { sortDocument, sortParagraph, deleteWordAt } from './editorEditOps.js';
import { textBlock, embedBlock, END_MARKER } from './editorContent.js';

describe('editorEditOps — sortDocument (문서 정렬)', () => {
  it('sorts text lines ascending (빈 줄도 값 \'\'로 함께 정렬)', () => {
    const blocks = [textBlock('다'), textBlock(''), textBlock('가'), textBlock('나')];
    const r = sortDocument(blocks);
    expect(r.changed).toBe(true);
    expect(r.blocks).toEqual([textBlock(''), textBlock('가'), textBlock('나'), textBlock('다')]);
  });

  it('keeps "(끝)" marker as the final block and out of the sort', () => {
    const blocks = [textBlock('나'), textBlock('가'), textBlock(END_MARKER)];
    const r = sortDocument(blocks);
    expect(r.changed).toBe(true);
    expect(r.blocks).toEqual([textBlock('가'), textBlock('나'), textBlock(END_MARKER)]);
  });

  it('re-normalizes a mid-document marker to final (malformed input 방어)', () => {
    const blocks = [textBlock('나'), textBlock(END_MARKER), textBlock('가')];
    const r = sortDocument(blocks);
    expect(r.changed).toBe(true);
    expect(r.blocks).toEqual([textBlock('가'), textBlock('나'), textBlock(END_MARKER)]);
  });

  it('keeps embed blocks in place — only text values move between text slots', () => {
    const embed = embedBlock({ embedType: 'image', src: 'x' });
    const blocks = [textBlock('다'), embed, textBlock('가')];
    const r = sortDocument(blocks);
    expect(r.changed).toBe(true);
    expect(r.blocks[0]).toEqual(textBlock('가'));
    expect(r.blocks[1]).toEqual({ ...embed });
    expect(r.blocks[2]).toEqual(textBlock('다'));
  });

  it('returns changed:false when already sorted', () => {
    const blocks = [textBlock('가'), textBlock('나'), textBlock(END_MARKER)];
    const r = sortDocument(blocks);
    expect(r.changed).toBe(false);
    expect(r.blocks).toEqual(blocks);
  });

  it('sorts mixed korean/latin lines by localeCompare (환경 콜레이션 독립)', () => {
    const values = ['나비', 'apple', '가나'];
    const blocks = values.map((v) => textBlock(v));
    const r = sortDocument(blocks);
    // 계약은 localeCompare 오름차순 — 한글/라틴 상대 순서는 런타임 콜레이션에 위임한다(어느 쪽이든 입력과 다른 결정적 순서).
    const expected = values.slice().sort((a, b) => a.localeCompare(b));
    expect(r.changed).toBe(true);
    expect(r.blocks.map((b) => b.text)).toEqual(expected);
  });
});

describe('editorEditOps — sortParagraph (문단 정렬)', () => {
  it('sorts only the caret paragraph — other paragraph and blank separator stay', () => {
    const blocks = [
      textBlock('나'), textBlock('가'), textBlock(''), textBlock('다'), textBlock('나'),
    ];
    const r = sortParagraph(blocks, 1);
    expect(r.changed).toBe(true);
    expect(r.blocks).toEqual([
      textBlock('가'), textBlock('나'), textBlock(''), textBlock('다'), textBlock('나'),
    ]);
  });

  it('leaves a "(끝)" marker outside the paragraph untouched', () => {
    const blocks = [textBlock('나'), textBlock('가'), textBlock(''), textBlock(END_MARKER)];
    const r = sortParagraph(blocks, 0);
    expect(r.changed).toBe(true);
    expect(r.blocks).toEqual([textBlock('가'), textBlock('나'), textBlock(''), textBlock(END_MARKER)]);
  });

  it('excludes a "(끝)" marker line inside the paragraph range and keeps its position', () => {
    // 정상 문서에서 마커는 본문 마지막 줄 바로 다음(같은 문단)에 올 수 있다 — 방어 가드.
    const blocks = [textBlock('나'), textBlock('가'), textBlock(END_MARKER)];
    const r = sortParagraph(blocks, 0);
    expect(r.blocks).toEqual([textBlock('가'), textBlock('나'), textBlock(END_MARKER)]);
  });

  it('returns changed:false for a single-line paragraph', () => {
    const blocks = [textBlock('나'), textBlock(''), textBlock('가')];
    const r = sortParagraph(blocks, 0);
    expect(r.changed).toBe(false);
    expect(r.blocks).toEqual(blocks);
  });

  it('sorts across an embed — embed keeps its slot, text line values sort', () => {
    const embed = embedBlock({ embedType: 'youtube', id: 'v1' });
    const blocks = [textBlock('나'), embed, textBlock('가')];
    const r = sortParagraph(blocks, 0);
    expect(r.changed).toBe(true);
    expect(r.blocks[0]).toEqual(textBlock('가'));
    expect(r.blocks[1]).toEqual({ ...embed });
    expect(r.blocks[2]).toEqual(textBlock('나'));
  });
});

describe('editorEditOps — deleteWordAt (단어 지우기)', () => {
  it('deletes only the word at the caret column (주변 공백 유지)', () => {
    const blocks = [textBlock('안녕 세상 테스트'), textBlock('둘째')];
    const r = deleteWordAt(blocks, 0, 4);
    expect(r.changed).toBe(true);
    expect(r.blocks[0]).toEqual(textBlock('안녕  테스트'));
    expect(r.blocks[1]).toEqual(textBlock('둘째'));
    expect(r.caretColumn).toBe(3);
  });

  it('is a no-op on the "(끝)" marker line (마커 보존)', () => {
    const blocks = [textBlock('본문'), textBlock(END_MARKER)];
    const r = deleteWordAt(blocks, 1, 1);
    expect(r.changed).toBe(false);
    expect(r.blocks).toEqual(blocks);
  });

  it('is a no-op when the line has no word (공백만)', () => {
    const blocks = [textBlock('   ')];
    const r = deleteWordAt(blocks, 0, 1);
    expect(r.changed).toBe(false);
    expect(r.blocks).toEqual(blocks);
  });

  it('deletes a word on the first line (제목 줄 텍스트 변경 — 재동기화는 step 4)', () => {
    const blocks = [textBlock('제목 기사'), textBlock('본문')];
    const r = deleteWordAt(blocks, 0, 0);
    expect(r.changed).toBe(true);
    expect(r.blocks[0]).toEqual(textBlock(' 기사'));
    expect(r.caretColumn).toBe(0);
  });

  it('keeps embed count/position unchanged', () => {
    const embed = embedBlock({ embedType: 'image', src: 'x' });
    const blocks = [textBlock('가나 다라'), embed, textBlock('마바 사아')];
    const r = deleteWordAt(blocks, 1, 0); // 텍스트-줄 1 = 블록 인덱스 2
    expect(r.blocks).toHaveLength(3);
    expect(r.blocks[1]).toEqual({ ...embed });
    expect(r.blocks[2]).toEqual(textBlock(' 사아'));
  });

  it('is a no-op for an out-of-range text line index', () => {
    const blocks = [textBlock('가')];
    const r = deleteWordAt(blocks, 5, 0);
    expect(r.changed).toBe(false);
    expect(r.blocks).toEqual(blocks);
  });

  it('preserves the align field of the line a word is deleted from (승계)', () => {
    const r = deleteWordAt([textBlock('hello world', 'center')], 0, 0);
    expect(r.changed).toBe(true);
    expect(r.blocks[0]).toEqual(textBlock(' world', 'center'));
    expect(r.blocks[0].align).toBe('center');
  });

  it('does not add a spurious align key to an unaligned line', () => {
    const r = deleteWordAt([textBlock('hello world')], 0, 0);
    expect(r.changed).toBe(true);
    expect(r.blocks[0].text).toBe(' world');
    expect('align' in r.blocks[0]).toBe(false);
  });
});

describe('editorEditOps — input immutability (입력 blocks 불변)', () => {
  it('does not mutate the input blocks array in any function', () => {
    const make = () => [
      textBlock('나'), embedBlock({ embedType: 'image', src: 'x' }), textBlock('가'), textBlock(END_MARKER),
    ];
    const b1 = make();
    sortDocument(b1);
    expect(b1).toEqual(make());
    const b2 = make();
    sortParagraph(b2, 0);
    expect(b2).toEqual(make());
    const b3 = make();
    deleteWordAt(b3, 0, 0);
    expect(b3).toEqual(make());
  });
});
