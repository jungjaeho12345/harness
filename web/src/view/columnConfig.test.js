import { describe, it, expect, beforeEach } from 'vitest';
import {
  COLUMNS, DEFAULT_GAP, defaultColumnConfig, loadColumnConfig, saveColumnConfig,
  toggleColumn, setGap, visibleColumns,
} from './columnConfig.js';

describe('columnConfig — list columns', () => {
  beforeEach(() => { localStorage.clear(); });

  it('defines the 8 common columns', () => {
    expect(COLUMNS.map((c) => c.key)).toEqual([
      'articleId', 'title', 'author', 'modifier', 'createdAt', 'editedAt', 'status', 'lockYN',
    ]);
  });

  it('default config shows every column with the default gap', () => {
    const cfg = defaultColumnConfig();
    expect(Object.values(cfg.visible).every(Boolean)).toBe(true);
    expect(cfg.gap).toBe(DEFAULT_GAP);
    expect(visibleColumns(cfg)).toHaveLength(COLUMNS.length);
  });

  it('toggleColumn hides/shows a column; visibleColumns reflects it', () => {
    let cfg = defaultColumnConfig();
    cfg = toggleColumn(cfg, 'lockYN');
    expect(cfg.visible.lockYN).toBe(false);
    expect(visibleColumns(cfg).find((c) => c.key === 'lockYN')).toBeUndefined();
  });

  it('setGap clamps to >= 0', () => {
    expect(setGap(defaultColumnConfig(), 20).gap).toBe(20);
    expect(setGap(defaultColumnConfig(), -5).gap).toBe(0);
  });

  it('saves and loads per menu independently', () => {
    saveColumnConfig('deskUnsent', setGap(toggleColumn(defaultColumnConfig(), 'modifier'), 16));
    saveColumnConfig('deptSend', defaultColumnConfig());

    const desk = loadColumnConfig('deskUnsent');
    expect(desk.visible.modifier).toBe(false);
    expect(desk.gap).toBe(16);

    const send = loadColumnConfig('deptSend');
    expect(send.visible.modifier).toBe(true); // 다른 메뉴는 영향 없음
  });

  it('returns defaults for an unsaved menu', () => {
    expect(loadColumnConfig('personal')).toEqual(defaultColumnConfig());
  });
});
