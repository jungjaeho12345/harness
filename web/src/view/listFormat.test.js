import { describe, it, expect, afterEach } from 'vitest';
import {
  formatDateTime,
  formatCell,
  applyDateFormat,
  setDateFormat,
  DATE_FORMATS,
  DEFAULT_DATE_FORMAT,
} from './listFormat.js';

// module-level currentFormat 누수 방지 — 각 테스트 후 기본 형식으로 격리.
afterEach(() => setDateFormat(DEFAULT_DATE_FORMAT));

describe('formatDateTime — YYYY-MM-DD HH:mm (기본 불변)', () => {
  it('ISO-8601 UTC 문자열을 분 단위까지 자른다(타임존 이동 없음)', () => {
    expect(formatDateTime('2026-06-14T03:09:06Z')).toBe('2026-06-14 03:09');
    expect(formatDateTime('2026-01-02T01:00:00.123Z')).toBe('2026-01-02 01:00');
    expect(formatDateTime('2026-06-21T09:05:00Z')).toBe('2026-06-21 09:05');
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

describe('DATE_FORMATS / DEFAULT_DATE_FORMAT', () => {
  it('9종 날짜형식이고 frozen이다', () => {
    expect(DATE_FORMATS).toHaveLength(9);
    expect(Object.isFrozen(DATE_FORMATS)).toBe(true);
    expect(DATE_FORMATS).toContain('YYYY-MM-DD HH:mm');
  });
  it('기본 형식은 현행 YYYY-MM-DD HH:mm이고 화이트리스트에 있다', () => {
    expect(DEFAULT_DATE_FORMAT).toBe('YYYY-MM-DD HH:mm');
    expect(DATE_FORMATS).toContain(DEFAULT_DATE_FORMAT);
  });
});

describe('applyDateFormat — 순수 토큰 치환(Date 비사용)', () => {
  it('9종 형식 모두 토큰을 치환한다', () => {
    const iso = '2026-06-21T09:05:00Z';
    expect(applyDateFormat(iso, 'YYYY-MM-DD HH:mm')).toBe('2026-06-21 09:05');
    expect(applyDateFormat(iso, 'YYYY-MM-DD')).toBe('2026-06-21');
    expect(applyDateFormat(iso, 'YYYY.MM.DD HH:mm')).toBe('2026.06.21 09:05');
    expect(applyDateFormat(iso, 'YYYY.MM.DD')).toBe('2026.06.21');
    expect(applyDateFormat(iso, 'YYYY/MM/DD HH:mm')).toBe('2026/06/21 09:05');
    expect(applyDateFormat(iso, 'YYYY년 MM월 DD일 HH:mm')).toBe('2026년 06월 21일 09:05');
    expect(applyDateFormat(iso, 'YYYY년 MM월 DD일')).toBe('2026년 06월 21일');
    expect(applyDateFormat(iso, 'MM-DD HH:mm')).toBe('06-21 09:05');
    expect(applyDateFormat(iso, 'MM/DD/YYYY')).toBe('06/21/2026');
  });
  it('MM(월)과 mm(분)을 구분해 치환한다', () => {
    expect(applyDateFormat('2026-06-21T09:05Z', 'YYYY년 MM월 DD일')).toBe('2026년 06월 21일');
    expect(applyDateFormat('2026-06-21T09:05Z', 'MM/DD/YYYY')).toBe('06/21/2026');
  });
  it('빈 iso는 빈 문자열, 미매치는 원본(폴백)', () => {
    expect(applyDateFormat('', 'YYYY-MM-DD HH:mm')).toBe('');
    expect(applyDateFormat(null, 'YYYY-MM-DD')).toBe('');
    expect(applyDateFormat('not-a-date', 'YYYY-MM-DD')).toBe('not-a-date');
  });
});

describe('setDateFormat — 화이트리스트 적용 + formatDateTime 반영', () => {
  it('DATE_FORMATS 값이면 formatDateTime이 그 형식으로 포맷한다', () => {
    setDateFormat('YYYY.MM.DD');
    expect(formatDateTime('2026-06-21T09:05Z')).toBe('2026.06.21');
    setDateFormat('YYYY년 MM월 DD일 HH:mm');
    expect(formatDateTime('2026-06-21T09:05Z')).toBe('2026년 06월 21일 09:05');
  });
  it('화이트리스트에 없는 형식은 무시(기본 유지)', () => {
    setDateFormat('잘못된형식');
    expect(formatDateTime('2026-06-21T09:05Z')).toBe('2026-06-21 09:05');
    setDateFormat(null);
    expect(formatDateTime('2026-06-21T09:05Z')).toBe('2026-06-21 09:05');
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
