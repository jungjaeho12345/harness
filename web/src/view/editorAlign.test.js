import { describe, it, expect } from 'vitest';
import { ALIGN_BY_MENU, setLineAlign } from './editorAlign.js';
import { textBlock, embedBlock, END_MARKER } from './editorContent.js';

describe('editorAlign — ALIGN_BY_MENU (메뉴 id → 정렬값)', () => {
  it('maps the 4 보기 정렬 menu ids to align values', () => {
    expect(ALIGN_BY_MENU).toEqual({
      'view.justify': 'justify',
      'view.alignLeft': 'left',
      'view.alignCenter': 'center',
      'view.alignRight': 'right',
    });
  });
});

describe('editorAlign — setLineAlign (캐럿 줄 정렬 설정)', () => {
  it('sets align on the target text line only, leaving embeds/other lines untouched', () => {
    const embed = embedBlock({ embedType: 'image', src: 'x' });
    // 텍스트 줄: 0='가', 1='나', 2='다' (임베드는 텍스트 줄 카운트에서 제외)
    const blocks = [textBlock('가'), embed, textBlock('나'), textBlock('다')];
    const r = setLineAlign(blocks, 2, 'center');
    expect(r.changed).toBe(true);
    expect(r.blocks).toEqual([
      textBlock('가'),
      { ...embed },
      textBlock('나'),
      textBlock('다', 'center'),
    ]);
  });

  it('no-ops (changed:false) when the text line index is out of range', () => {
    const blocks = [textBlock('가'), textBlock('나')];
    const r = setLineAlign(blocks, 5, 'center');
    expect(r.changed).toBe(false);
    expect(r.blocks).toEqual([textBlock('가'), textBlock('나')]);
  });

  it('no-ops when the line already has the requested align (불필요 dirty 방지)', () => {
    const blocks = [textBlock('가', 'center'), textBlock('나')];
    const r = setLineAlign(blocks, 0, 'center');
    expect(r.changed).toBe(false);
    expect(r.blocks).toEqual([textBlock('가', 'center'), textBlock('나')]);
  });

  it('no-ops for an invalid align value', () => {
    const blocks = [textBlock('가'), textBlock('나')];
    const r = setLineAlign(blocks, 0, 'bad');
    expect(r.changed).toBe(false);
    expect(r.blocks).toEqual([textBlock('가'), textBlock('나')]);
  });

  it("'left' is a valid align — setting it on an un-aligned line marks changed", () => {
    const blocks = [textBlock('가'), textBlock('나')];
    const r = setLineAlign(blocks, 0, 'left');
    expect(r.changed).toBe(true);
    expect(r.blocks).toEqual([textBlock('가', 'left'), textBlock('나')]);
  });

  it('never touches the "(끝)" marker or reorders blocks', () => {
    const blocks = [textBlock('가'), textBlock('나'), textBlock(END_MARKER)];
    const r = setLineAlign(blocks, 1, 'right');
    expect(r.changed).toBe(true);
    expect(r.blocks).toEqual([textBlock('가'), textBlock('나', 'right'), textBlock(END_MARKER)]);
  });

  it('returns a normalized copy on no-op (out-of-range) rather than the raw input', () => {
    const blocks = [{ type: 'text', text: 1 }, { type: 'bogus' }];
    const r = setLineAlign(blocks, 9, 'center');
    expect(r.changed).toBe(false);
    expect(r.blocks).toEqual([{ type: 'text', text: '1' }]);
  });
});
