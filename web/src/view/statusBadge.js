// 기사 상태 배지 색 (UI_GUIDE 상태 배지 토큰). 임의로 바꾸지 않는다.
// RDS=회색 / DPS=레드 / 보류(RRH·DDH·EEH)=앰버 / KILL(RRK·DDK·EEK)=슬레이트. DPD(삭제 승인)는 슬레이트 계열.
// EPS(엠바고 송고 대기)는 다른 족보와 구분되는 인디고 — news.md 배지 규칙 동기화(step2).
// DES(엠바고 배부 전 대기)는 EPS(배부 진행 — 첫 배부 후)와 같은 엠바고 족보(news.md `RDS->DES->EPS`)라
// 인디고 계열의 밝은 톤으로 둔다(phase48 step5). 회색 폴백으로 떨어지면 안 된다.

export const STATUS_BADGES = Object.freeze({
  RDS: { label: 'RDS', bg: '#e8e8e8', fg: '#555' }, // 회색
  DPS: { label: 'DPS', bg: '#c8102e', fg: '#fff' }, // 레드
  RRH: { label: 'RRH', bg: '#d97706', fg: '#fff' }, // 앰버
  DDH: { label: 'DDH', bg: '#d97706', fg: '#fff' }, // 앰버
  EEH: { label: 'EEH', bg: '#d97706', fg: '#fff' }, // 앰버 — 보류 족(엠바고 보류)
  RRK: { label: 'RRK', bg: '#374151', fg: '#fff' }, // 슬레이트
  DDK: { label: 'DDK', bg: '#374151', fg: '#fff' }, // 슬레이트
  EEK: { label: 'EEK', bg: '#374151', fg: '#fff' }, // 슬레이트 — KILL 족(엠바고 KILL)
  DPD: { label: 'DPD', bg: '#374151', fg: '#fff' }, // 삭제 승인 — 슬레이트
  EPS: { label: 'EPS', bg: '#4f46e5', fg: '#fff' }, // 인디고 — 엠바고 송고 대기(배부 진행)
  DES: { label: 'DES', bg: '#6366f1', fg: '#fff' }, // 인디고 밝은 톤 — 엠바고 배부 전 대기(EPS 계열)
});

const FALLBACK = { label: '', bg: '#e8e8e8', fg: '#555' };

export function statusBadge(status) {
  const b = STATUS_BADGES[status];
  if (b) return b;
  return { ...FALLBACK, label: status ?? '' };
}
