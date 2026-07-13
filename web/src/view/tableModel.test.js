import { describe, it, expect } from 'vitest';
import { serialize, deserialize, textBlock, normalizeBlocks, embedBlock } from './editorContent.js';
import {
  TABLE_EMBED_TYPE, normalizeTableRows, makeEmptyTableRows, makeTableEmbed, isTableEmbed,
  insertRow, insertCol, deleteRow, deleteCol, setCell, tableToTsv, findTargetTableIndex,
} from './tableModel.js';

describe('tableModel — normalizeTableRows', () => {
  it('pads ragged rows to a rectangle with empty-string cells', () => {
    expect(normalizeTableRows([['a'], ['b', 'c']])).toEqual([['a', ''], ['b', 'c']]);
  });

  it('returns [] for non-array/empty input', () => {
    expect(normalizeTableRows(null)).toEqual([]);
    expect(normalizeTableRows(undefined)).toEqual([]);
    expect(normalizeTableRows('rows')).toEqual([]);
    expect(normalizeTableRows([])).toEqual([]);
  });

  it('coerces non-string cells to strings (null/undefined → empty string)', () => {
    expect(normalizeTableRows([[1, null]])).toEqual([['1', '']]);
    expect(normalizeTableRows([[undefined, true]])).toEqual([['', 'true']]);
  });

  it('turns a non-array row into an empty (padded) row', () => {
    expect(normalizeTableRows([['a', 'b'], 'x'])).toEqual([['a', 'b'], ['', '']]);
  });

  it('does not mutate the input rows', () => {
    const input = [['a'], ['b', 'c']];
    const snapshot = JSON.parse(JSON.stringify(input));
    normalizeTableRows(input);
    expect(input).toEqual(snapshot);
  });
});

describe('tableModel — makeEmptyTableRows', () => {
  it('builds an r×c grid of empty strings', () => {
    expect(makeEmptyTableRows(2, 3)).toEqual([['', '', ''], ['', '', '']]);
  });

  it('clamps r/c to at least 1', () => {
    expect(makeEmptyTableRows(0, 0)).toEqual([['']]);
    expect(makeEmptyTableRows(-2, -5)).toEqual([['']]);
  });
});

describe('tableModel — makeTableEmbed / isTableEmbed', () => {
  it('wraps normalized rows in an embed block (embedType table)', () => {
    expect(makeTableEmbed([['가', '나']])).toEqual({
      type: 'embed', embedType: TABLE_EMBED_TYPE, rows: [['가', '나']],
    });
  });

  it('returns null for an empty table (factory rule — insertEmbed no-op)', () => {
    expect(makeTableEmbed([])).toBeNull();
    expect(makeTableEmbed(null)).toBeNull();
    expect(makeTableEmbed([[]])).toBeNull();
  });

  it('normalizes ragged/non-string rows on creation', () => {
    expect(makeTableEmbed([['a'], [1, null]]).rows).toEqual([['a', ''], ['1', '']]);
  });

  it('isTableEmbed guards on embed block shape and embedType', () => {
    expect(isTableEmbed({ type: 'embed', embedType: 'table', rows: [] })).toBe(true);
    expect(isTableEmbed({ type: 'embed', embedType: 'image' })).toBe(false);
    expect(isTableEmbed({ type: 'text' })).toBe(false);
    expect(isTableEmbed(null)).toBe(false);
  });
});

describe('tableModel — grid transforms (pure, immutable)', () => {
  it('insertRow inserts an empty row at index keeping column count', () => {
    expect(insertRow([['a', 'b']], 0)).toEqual([['', ''], ['a', 'b']]);
    expect(insertRow([['a', 'b']], 1)).toEqual([['a', 'b'], ['', '']]);
  });

  it('insertRow clamps out-of-range index and defaults empty table to 1 column', () => {
    expect(insertRow([['a']], -3)).toEqual([[''], ['a']]);
    expect(insertRow([['a']], 9)).toEqual([['a'], ['']]);
    expect(insertRow([], 0)).toEqual([['']]);
  });

  it('insertCol inserts an empty cell at index in every row', () => {
    expect(insertCol([['a', 'b'], ['c', 'd']], 1)).toEqual([['a', '', 'b'], ['c', '', 'd']]);
    expect(insertCol([['a']], 9)).toEqual([['a', '']]);
  });

  it('deleteRow removes the row but keeps at least 1 row', () => {
    expect(deleteRow([['a'], ['b']], 0)).toEqual([['b']]);
    expect(deleteRow([['a']], 0)).toEqual([['a']]);
  });

  it('deleteCol removes the column in every row but keeps at least 1 column', () => {
    expect(deleteCol([['a', 'b'], ['c', 'd']], 1)).toEqual([['a'], ['c']]);
    expect(deleteCol([['a'], ['b']], 0)).toEqual([['a'], ['b']]);
  });

  it('delete on an empty table returns the original as-is', () => {
    const empty = [];
    expect(deleteRow(empty, 0)).toBe(empty);
    expect(deleteCol(empty, 0)).toBe(empty);
  });

  it('setCell replaces one cell and returns the original for out-of-range coords', () => {
    expect(setCell([['a', 'b']], 0, 1, 'x')).toEqual([['a', 'x']]);
    const rows = [['a', 'b']];
    expect(setCell(rows, 5, 5, 'x')).toBe(rows);
    expect(setCell(rows, -1, 0, 'x')).toBe(rows);
  });

  it('never mutates the input rows (new arrays are returned)', () => {
    const input = [['a', 'b'], ['c', 'd']];
    const snapshot = JSON.parse(JSON.stringify(input));
    const results = [
      insertRow(input, 1), insertCol(input, 1),
      deleteRow(input, 0), deleteCol(input, 0),
      setCell(input, 0, 0, 'x'),
    ];
    expect(input).toEqual(snapshot);
    for (const out of results) {
      expect(out).not.toBe(input);
      expect(out[0]).not.toBe(input[0]);
    }
  });
});

describe('tableModel — tableToTsv', () => {
  it('joins cells with tab and rows with newline', () => {
    expect(tableToTsv([['a', 'b'], ['c', 'd']])).toBe('a\tb\nc\td');
  });

  it('replaces separator characters inside cells with spaces', () => {
    const tsv = tableToTsv([['x\ty', 'p\nq']]);
    expect(tsv.split('\n')).toHaveLength(1);
    expect(tsv.split('\t')).toHaveLength(2);
    expect(tsv).toBe('x y\tp q');
  });
});

describe('tableModel — findTargetTableIndex (block-index contract)', () => {
  const text = () => textBlock('t');
  const table = () => makeTableEmbed([['a']]);

  it('picks the nearest table at/after the caret block index', () => {
    expect(findTargetTableIndex([text(), table(), text()], 0)).toBe(1);
    expect(findTargetTableIndex([text(), table(), text(), table()], 2)).toBe(3);
  });

  it('falls back to the nearest table before the caret', () => {
    expect(findTargetTableIndex([text(), table(), text()], 2)).toBe(1);
  });

  it('returns the last table for null/out-of-range fromBlockIndex (계약 (3))', () => {
    expect(findTargetTableIndex([text(), table(), text()], -1)).toBe(1);
    expect(findTargetTableIndex([table(), text(), table()], null)).toBe(2);
    expect(findTargetTableIndex([table(), text(), table()], 99)).toBe(2);
  });

  it('returns -1 when there is no table embed', () => {
    expect(findTargetTableIndex([text(), text()], 0)).toBe(-1);
    expect(findTargetTableIndex([], null)).toBe(-1);
  });

  it('ignores non-table embeds', () => {
    const image = embedBlock({ embedType: 'image', src: 'x.png' });
    expect(findTargetTableIndex([image, text()], 0)).toBe(-1);
    expect(findTargetTableIndex([image, table()], 0)).toBe(1);
  });
});

// 31-step0 핵심 보증: table 임베드가 기존 editorContent 직렬화(수정 없이)를 그대로 통과한다.
describe('tableModel — editorContent round-trip 하위호환', () => {
  it('serialize→deserialize preserves rows exactly', () => {
    const embed = makeTableEmbed([['가', '나'], ['다', '라']]);
    const restored = deserialize(serialize([embed]));
    expect(restored).toHaveLength(1);
    expect(restored[0].rows).toEqual([['가', '나'], ['다', '라']]);
    expect(isTableEmbed(restored[0])).toBe(true);
  });

  it('preserves order and rows when mixed with text blocks', () => {
    const blocks = [textBlock('제목'), makeTableEmbed([['a', 'b']]), textBlock('본문')];
    const restored = deserialize(serialize(blocks));
    expect(restored).toEqual(blocks);
  });

  it('normalizeBlocks does not drop table embeds (kind-agnostic pass-through)', () => {
    const embed = makeTableEmbed([['a']]);
    expect(normalizeBlocks([embed])).toEqual([embed]);
  });
});
