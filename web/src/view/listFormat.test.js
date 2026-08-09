import { describe, it, expect, afterEach } from 'vitest';
import {
  formatDateTime,
  formatCell,
  applyDateFormat,
  setDateFormat,
  rangeInstant,
  DATE_FORMATS,
  DEFAULT_DATE_FORMAT,
  KST_OFFSET_MS,
  kstIsoString,
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

describe('kstIsoString — epoch ms → KST 벽시계 ISO 문자열(순수·결정적)', () => {
  it('KST_OFFSET_MS는 +9시간 고정(DST 없음)', () => {
    expect(KST_OFFSET_MS).toBe(9 * 60 * 60 * 1000);
  });
  it('UTC 자정 입력 → KST 벽시계 09:00 (+9h)', () => {
    const ms = Date.parse('2026-07-10T00:00:00Z');
    expect(kstIsoString(ms)).toBe('2026-07-10T09:00:00.000Z');
  });
  it('UTC 20:00 입력 → KST 날짜가 다음 날 05:00으로 넘어간다', () => {
    const ms = Date.parse('2026-07-09T20:00:00Z');
    expect(kstIsoString(ms)).toBe('2026-07-10T05:00:00.000Z');
  });
  it('같은 epochMs면 항상 같은 출력(결정적)', () => {
    const ms = Date.parse('2026-07-10T06:30:00Z');
    expect(kstIsoString(ms)).toBe(kstIsoString(ms));
  });
  it('삽입 파이프라인 전체 — applyDateFormat(kstIsoString(ms), fmt)가 KST 문자열을 만든다', () => {
    const ms = Date.parse('2026-07-10T00:00:00Z');
    expect(applyDateFormat(kstIsoString(ms), 'YYYY-MM-DD HH:mm')).toBe('2026-07-10 09:00');
    expect(applyDateFormat(kstIsoString(Date.parse('2026-07-10T06:30:00Z')), 'YYYY-MM-DD HH:mm'))
      .toBe('2026-07-10 15:30');
    expect(applyDateFormat(kstIsoString(Date.parse('2026-07-09T20:00:00Z')), 'YYYY년 MM월 DD일 HH:mm'))
      .toBe('2026년 07월 10일 05:00');
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

  it('distributedAt도 시간 컬럼으로 포맷한다(createdAt과 동일 결과)', () => {
    expect(formatCell('distributedAt', '2026-08-06T09:30:00.000Z'))
      .toBe(formatCell('createdAt', '2026-08-06T09:30:00.000Z'));
    expect(formatCell('distributedAt', '2026-08-06T09:30:00.000Z')).toBe('2026-08-06 09:30');
  });

  it('distributedAt 빈 값은 빈 문자열이다(기존 시간 컬럼과 동형)', () => {
    expect(formatCell('distributedAt', null)).toBe('');
    expect(formatCell('distributedAt', undefined)).toBe('');
    expect(formatCell('distributedAt', '')).toBe('');
  });
});

describe('rangeInstant — 조회조건(datetime-local) → 서버 필터용 ISO-8601 UTC 문자열(순수)', () => {
  it("from은 ':00.000Z'로 분의 시작을 만든다", () => {
    expect(rangeInstant('2026-08-06T09:30', 'from')).toBe('2026-08-06T09:30:00.000Z');
  });

  it("to는 ':59.999Z'로 선택한 분의 끝까지 포함한다", () => {
    expect(rangeInstant('2026-08-06T09:30', 'to')).toBe('2026-08-06T09:30:59.999Z');
  });

  it('값이 없거나 비문자열이면 undefined(조건 미포함 — null·빈 문자열이 아니다)', () => {
    expect(rangeInstant('', 'from')).toBeUndefined();
    expect(rangeInstant(undefined, 'to')).toBeUndefined();
    expect(rangeInstant(null, 'from')).toBeUndefined();
    expect(rangeInstant(42, 'to')).toBeUndefined();
  });

  // 초까지 들어온 값은 분 단위로 정규화한다 — from/to 순서 규약(to >= from)이 유지된다.
  it('초가 있는 값은 분 단위로 정규화한다(유효한 ISO·to >= from 유지)', () => {
    expect(rangeInstant('2026-08-06T09:30:15', 'from')).toBe('2026-08-06T09:30:00.000Z');
    expect(rangeInstant('2026-08-06T09:30:15', 'to')).toBe('2026-08-06T09:30:59.999Z');
  });

  it('잘못된 형식은 undefined(서버에 쓰레기 필터를 보내지 않는다)', () => {
    expect(rangeInstant('2026-13-99', 'from')).toBeUndefined();
    expect(rangeInstant('abc', 'to')).toBeUndefined();
    expect(rangeInstant('2026-13-01T09:30', 'from')).toBeUndefined(); // 13월
    expect(rangeInstant('2026-08-06T25:30', 'to')).toBeUndefined(); // 25시
  });

  it("edge가 'from'/'to' 외의 값이면 undefined(안전 기본값)", () => {
    expect(rangeInstant('2026-08-06T09:30')).toBeUndefined();
    expect(rangeInstant('2026-08-06T09:30', 'between')).toBeUndefined();
  });

  it('순수성 — 같은 입력이면 항상 같은 출력이고 날짜형식 설정과 무관하다', () => {
    const before = rangeInstant('2026-08-06T09:30', 'from');
    setDateFormat('YYYY년 MM월 DD일 HH:mm'); // module-scope currentFormat 변경 — 결과 불변이어야 한다.
    expect(rangeInstant('2026-08-06T09:30', 'from')).toBe(before);
  });
});
