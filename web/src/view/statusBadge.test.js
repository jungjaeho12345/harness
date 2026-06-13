import { describe, it, expect } from 'vitest';
import { statusBadge } from './statusBadge.js';

describe('statusBadge — UI_GUIDE 상태 배지 색', () => {
  it('RDS는 회색', () => {
    expect(statusBadge('RDS')).toEqual({ label: 'RDS', bg: '#e8e8e8', fg: '#555' });
  });
  it('DPS는 레드', () => {
    expect(statusBadge('DPS')).toEqual({ label: 'DPS', bg: '#c8102e', fg: '#fff' });
  });
  it('보류(RRH·DDH)는 앰버', () => {
    expect(statusBadge('RRH').bg).toBe('#d97706');
    expect(statusBadge('DDH').bg).toBe('#d97706');
  });
  it('KILL(RRK·DDK)는 슬레이트', () => {
    expect(statusBadge('RRK').bg).toBe('#374151');
    expect(statusBadge('DDK').bg).toBe('#374151');
  });
  it('알 수 없는 상태는 회색 폴백', () => {
    expect(statusBadge('???')).toEqual({ label: '???', bg: '#e8e8e8', fg: '#555' });
  });
});
