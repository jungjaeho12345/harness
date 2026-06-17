import { describe, it, expect } from 'vitest';
import { formatDateTime, formatCell } from './listFormat.js';

describe('formatDateTime — YYYY-MM-DD HH:mm', () => {
  it('ISO-8601 UTC 문자열을 분 단위까지 자른다(타임존 이동 없음)', () => {
    expect(formatDateTime('2026-06-14T03:09:06Z')).toBe('2026-06-14 03:09');
    expect(formatDateTime('2026-01-02T01:00:00.123Z')).toBe('2026-01-02 01:00');
  });
  it('빈 값은 빈 문자열', () => {
    expect(formatDateTime('')).toBe('');
    expect(formatDateTime(null)).toBe('');
    expect(formatDateTime(undefined)).toBe('');
  });
  it('형식에 맞지 않으면 원본 그대로', () => {
    expect(formatDateTime('not-a-date')).toBe('not-a-date');
  });
});

describe('formatCell', () => {
  it('시간 컬럼만 포맷한다', () => {
    expect(formatCell('createdAt', '2026-06-14T03:09:06Z')).toBe('2026-06-14 03:09');
    expect(formatCell('editedAt', '2026-06-14T03:09:06Z')).toBe('2026-06-14 03:09');
    expect(formatCell('sentAt', '2026-06-14T03:09:06Z')).toBe('2026-06-14 03:09');
    expect(formatCell('title', '제목')).toBe('제목');
    expect(formatCell('lockYN', 'Y')).toBe('Y');
  });
});
