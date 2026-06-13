import { describe, it, expect } from 'vitest';
import {
  isInsertEndMarker, isDeleteLine, insertEndMarker, deleteLineAt,
} from './editorShortcuts.js';
import { textBlock, embedBlock, END_MARKER } from './editorContent.js';

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
