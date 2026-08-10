import { describe, it, expect, beforeEach } from 'vitest';
import {
  COLUMNS, DEFAULT_GAP, defaultColumnConfig, loadColumnConfig, saveColumnConfig,
  toggleColumn, setGap, visibleColumns,
} from './columnConfig.js';

describe('columnConfig — list columns', () => {
  beforeEach(() => { localStorage.clear(); });

  it('defines the common columns incl. department/departmentCode — distributedAt은 sentAt 바로 뒤(시간 컬럼 묶음)', () => {
    expect(COLUMNS.map((c) => c.key)).toEqual([
      'articleId', 'title', 'author', 'modifier', 'department', 'departmentCode',
      'createdAt', 'editedAt', 'sentAt', 'distributedAt', 'status', 'lockYN',
    ]);
  });

  it('distributedAt 라벨은 배부시간이다', () => {
    expect(COLUMNS.find((c) => c.key === 'distributedAt').label).toBe('배부시간');
  });

  // news.md 100행 기본 컬럼 스펙 — 신규 distributedAt만 기본 숨김이고 나머지는 전부 표시다.
  it('default config hides only distributedAt (every other column visible) with the default gap', () => {
    const cfg = defaultColumnConfig();
    expect(cfg.visible.distributedAt).toBe(false);
    for (const c of COLUMNS) {
      if (c.key !== 'distributedAt') expect(cfg.visible[c.key]).toBe(true);
    }
    expect(cfg.gap).toBe(DEFAULT_GAP);
    expect(visibleColumns(cfg)).toHaveLength(COLUMNS.length - 1);
    expect(visibleColumns(cfg).find((c) => c.key === 'distributedAt')).toBeUndefined();
  });

  it('distributedAt을 켜면 visibleColumns의 카탈로그 순서 위치(sentAt 뒤)로 들어간다', () => {
    const cfg = toggleColumn(defaultColumnConfig(), 'distributedAt');
    const keys = visibleColumns(cfg).map((c) => c.key);
    expect(keys.indexOf('distributedAt')).toBe(keys.indexOf('sentAt') + 1);
    expect(keys.indexOf('distributedAt')).toBe(keys.indexOf('status') - 1);
  });

  // 영속 회귀 — distributedAt 키가 없는 기존 저장값을 로드하면 기본값(false)이 되고 다른 설정은 보존된다.
  it('legacy saved config without distributedAt loads it as hidden and keeps other settings', () => {
    const legacy = defaultColumnConfig();
    delete legacy.visible.distributedAt;
    legacy.visible.modifier = false;
    saveColumnConfig('deskUnsent', setGap(legacy, 12));

    const loaded = loadColumnConfig('deskUnsent');
    expect(loaded.visible.distributedAt).toBe(false);
    expect(loaded.visible.modifier).toBe(false);
    expect(loaded.gap).toBe(12);
  });

  it('distributedAt을 켠 저장값은 로드 시 유지된다(저장값이 기본값을 이긴다)', () => {
    saveColumnConfig('deptSend', toggleColumn(defaultColumnConfig(), 'distributedAt'));
    expect(loadColumnConfig('deptSend').visible.distributedAt).toBe(true);
    // 다른 메뉴는 영향 없음 — 기본 숨김 그대로.
    expect(loadColumnConfig('personal').visible.distributedAt).toBe(false);
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
