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
  it('EEK는 슬레이트(KILL 족), EEH는 앰버(보류 족) — 폴백 아님', () => {
    expect(statusBadge('EEK')).toEqual({ label: 'EEK', bg: '#374151', fg: '#fff' });
    expect(statusBadge('EEH')).toEqual({ label: 'EEH', bg: '#d97706', fg: '#fff' });
  });
  it('EPS는 인디고(엠바고 송고 대기) — 폴백 아님', () => {
    expect(statusBadge('EPS')).toEqual({ label: 'EPS', bg: '#4f46e5', fg: '#fff' });
    expect(statusBadge('EPS').bg).not.toBe('#e8e8e8'); // 회색 폴백이 아님
  });
  it('알 수 없는 상태는 회색 폴백', () => {
    expect(statusBadge('???')).toEqual({ label: '???', bg: '#e8e8e8', fg: '#555' });
  });
});
