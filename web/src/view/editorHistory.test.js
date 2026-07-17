import { describe, it, expect } from 'vitest';
import {
  createHistory, pushHistory, undo, redo, canUndo, canRedo,
} from './editorHistory.js';

describe('editorHistory — createHistory (베이스라인)', () => {
  it('creates a single-entry baseline history (undo/redo 모두 불가)', () => {
    const h = createHistory('A');
    expect(h.entries).toEqual(['A']);
    expect(h.index).toBe(0);
    expect(canUndo(h)).toBe(false);
    expect(canRedo(h)).toBe(false);
  });

  it('coerces null/undefined initial body to empty string', () => {
    expect(createHistory(null).entries).toEqual(['']);
    expect(createHistory(undefined).entries).toEqual(['']);
  });
});

describe('editorHistory — push/undo/redo 왕복', () => {
  it('walks back to the baseline and forward to the top', () => {
    let h = createHistory('A');
    h = pushHistory(h, 'B');
    h = pushHistory(h, 'C');
    expect(canUndo(h)).toBe(true);
    expect(canRedo(h)).toBe(false);

    let r = undo(h);
    expect(r.changed).toBe(true);
    expect(r.body).toBe('B');
    r = undo(r.history);
    expect(r.changed).toBe(true);
    expect(r.body).toBe('A'); // 베이스라인 도달
    expect(canUndo(r.history)).toBe(false);

    const blocked = undo(r.history);
    expect(blocked.changed).toBe(false);
    expect(blocked.body).toBe(null);
    expect(blocked.history).toBe(r.history);

    r = redo(r.history);
    expect(r.changed).toBe(true);
    expect(r.body).toBe('B');
    r = redo(r.history);
    expect(r.changed).toBe(true);
    expect(r.body).toBe('C');
    expect(canRedo(r.history)).toBe(false);

    const top = redo(r.history);
    expect(top.changed).toBe(false);
    expect(top.body).toBe(null);
    expect(top.history).toBe(r.history);
  });
});

describe('editorHistory — redo 분기 절단', () => {
  it('drops the future branch when pushing after undo', () => {
    let h = createHistory('A');
    h = pushHistory(h, 'B');
    h = pushHistory(h, 'C');
    const back = undo(h); // → 'B'
    h = pushHistory(back.history, 'D'); // C 절단, 경로 A,B,D
    expect(canRedo(h)).toBe(false);
    expect(h.entries).toEqual(['A', 'B', 'D']);

    let r = undo(h);
    expect(r.body).toBe('B');
    r = undo(r.history);
    expect(r.body).toBe('A');
    expect(canUndo(r.history)).toBe(false);
  });

  it('cuts the redo branch even with coalesce:true when not at top (교체가 아니라 push)', () => {
    let h = createHistory('A');
    h = pushHistory(h, 'B');
    h = pushHistory(h, 'C');
    const back = undo(h); // 현재 'B' (top 아님)
    h = pushHistory(back.history, 'D', { coalesce: true });
    expect(h.entries).toEqual(['A', 'B', 'D']);
    expect(canRedo(h)).toBe(false);
  });
});

describe('editorHistory — 동일 body no-op', () => {
  it('returns the same history when pushing the current body', () => {
    let h = createHistory('A');
    h = pushHistory(h, 'B');
    const same = pushHistory(h, 'B');
    expect(same).toBe(h);
    expect(same.entries.length).toBe(2);
    expect(same.index).toBe(1);
  });

  it('is a no-op even with coalesce:true (StrictMode 이중 호출 방어)', () => {
    let h = createHistory('A');
    h = pushHistory(h, 'B');
    const same = pushHistory(h, 'B', { coalesce: true });
    expect(same).toBe(h);
  });
});

describe('editorHistory — 코얼레싱 (타이핑 연타)', () => {
  it('first typed snapshot after baseline is a push, later coalesced captures replace the top', () => {
    let h = createHistory('');
    h = pushHistory(h, 'a', { coalesce: true }); // 베이스라인 다음 첫 타이핑 → push
    expect(h.entries).toEqual(['', 'a']);
    h = pushHistory(h, 'ab', { coalesce: true }); // top 교체
    h = pushHistory(h, 'abc', { coalesce: true }); // top 교체
    expect(h.entries).toEqual(['', 'abc']);
    expect(h.index).toBe(1);

    const r = undo(h);
    expect(r.body).toBe(''); // 베이스라인 보존
    expect(canUndo(r.history)).toBe(false);
  });

  it('never replaces the baseline (베이스라인 불멸)', () => {
    const base = createHistory('base');
    const h = pushHistory(base, 'x', { coalesce: true });
    expect(h.entries).toEqual(['base', 'x']);
    expect(h.index).toBe(1);
    const r = undo(h);
    expect(r.body).toBe('base');
  });
});

describe('editorHistory — 상한(limit)', () => {
  it('drops the oldest entries beyond the limit and keeps index consistent', () => {
    let h = createHistory('A');
    h = pushHistory(h, 'B', { limit: 3 });
    h = pushHistory(h, 'C', { limit: 3 });
    h = pushHistory(h, 'D', { limit: 3 }); // A 탈락
    expect(h.entries).toEqual(['B', 'C', 'D']);
    expect(h.index).toBe(2);
    expect(canRedo(h)).toBe(false);
    expect(canUndo(h)).toBe(true);

    h = pushHistory(h, 'E', { limit: 3 }); // B 탈락
    expect(h.entries).toEqual(['C', 'D', 'E']);
    expect(h.index).toBe(2);

    let r = undo(h);
    expect(r.body).toBe('D');
    r = undo(r.history);
    expect(r.body).toBe('C');
    expect(canUndo(r.history)).toBe(false); // 절단 후 남은 범위까지만 undo
  });
});

describe('editorHistory — 입력 불변 (mutate 금지)', () => {
  it('pushHistory does not mutate the input history', () => {
    const h = createHistory('A');
    const entriesRef = h.entries;
    pushHistory(h, 'B');
    pushHistory(h, 'C', { coalesce: true, limit: 2 });
    expect(h.entries).toBe(entriesRef);
    expect(h.entries).toEqual(['A']);
    expect(h.index).toBe(0);
  });

  it('coalescing replace does not mutate the input entries', () => {
    let h = createHistory('');
    h = pushHistory(h, 'a', { coalesce: true });
    const before = h;
    const beforeEntries = h.entries.slice();
    const next = pushHistory(h, 'ab', { coalesce: true });
    expect(before.entries).toEqual(beforeEntries);
    expect(before.index).toBe(1);
    expect(next).not.toBe(before);
  });

  it('undo/redo do not mutate the input history', () => {
    let h = createHistory('A');
    h = pushHistory(h, 'B');
    const r = undo(h);
    expect(h.entries).toEqual(['A', 'B']);
    expect(h.index).toBe(1);
    expect(r.history).not.toBe(h);
    const rr = redo(r.history);
    expect(r.history.index).toBe(0);
    expect(rr.history.index).toBe(1);
  });
});

describe('editorHistory — body는 불투명 문자열', () => {
  it('treats non-string bodies via String coercion and never parses content', () => {
    let h = createHistory('{"format":"yh-editor"}');
    // JSON처럼 보여도 파싱/정규화 없이 문자 그대로 비교·보관한다.
    const sameJson = pushHistory(h, '{"format":"yh-editor"}');
    expect(sameJson).toBe(h);
    h = pushHistory(h, '{"format":"yh-editor","version":1}');
    expect(h.entries[1]).toBe('{"format":"yh-editor","version":1}');
    const nulled = pushHistory(h, null); // → '' push
    expect(nulled.entries[nulled.index]).toBe('');
  });
});
