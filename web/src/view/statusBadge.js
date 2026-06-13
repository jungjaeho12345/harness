// 기사 상태 배지 색 (UI_GUIDE 상태 배지 토큰). 임의로 바꾸지 않는다.
// RDS=회색 / DPS=레드 / 보류(RRH·DDH)=앰버 / KILL(RRK·DDK)=슬레이트. DPD(삭제 승인)는 슬레이트 계열.

export const STATUS_BADGES = Object.freeze({
  RDS: { label: 'RDS', bg: '#e8e8e8', fg: '#555' }, // 회색
  DPS: { label: 'DPS', bg: '#c8102e', fg: '#fff' }, // 레드
  RRH: { label: 'RRH', bg: '#d97706', fg: '#fff' }, // 앰버
  DDH: { label: 'DDH', bg: '#d97706', fg: '#fff' }, // 앰버
  RRK: { label: 'RRK', bg: '#374151', fg: '#fff' }, // 슬레이트
  DDK: { label: 'DDK', bg: '#374151', fg: '#fff' }, // 슬레이트
  DPD: { label: 'DPD', bg: '#374151', fg: '#fff' }, // 삭제 승인 — 슬레이트
});

const FALLBACK = { label: '', bg: '#e8e8e8', fg: '#555' };

export function statusBadge(status) {
  const b = STATUS_BADGES[status];
  if (b) return b;
  return { ...FALLBACK, label: status ?? '' };
}
