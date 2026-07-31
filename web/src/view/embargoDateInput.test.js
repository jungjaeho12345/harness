import { describe, it, expect } from 'vitest';
import { isoToLocalInput, localInputToIso } from './embargoDateInput.js';

// 엠바고 datetime-local 표시 변환 — 순수 함수 단위 테스트.
// 계약: 필드 상태(f.embargoAt)는 항상 ISO-8601 UTC 문자열(SCHEMA.md:48 — phase 48 tick의 시각 비교가 의존).
// 변환은 표시 계층 전용: ISO UTC ↔ 로컬 "YYYY-MM-DDTHH:mm"(datetime-local value).
// 테스트는 로컬 Date 생성자로 기대값을 만들어 실행 타임존에 무관하게 성립한다.
describe('embargoDateInput — isoToLocalInput(ISO UTC → datetime-local 로컬 표시)', () => {
  it("빈 값(''/null/undefined/공백) → '' (피커 빈 표시)", () => {
    expect(isoToLocalInput('')).toBe('');
    expect(isoToLocalInput(null)).toBe('');
    expect(isoToLocalInput(undefined)).toBe('');
    expect(isoToLocalInput('   ')).toBe('');
  });

  it("파싱 불가 레거시 자유 텍스트 → '' (피커 빈 표시 — 원값 파괴는 하지 않는 게 호출측 계약)", () => {
    expect(isoToLocalInput('오후 3시 엠바고')).toBe('');
    expect(isoToLocalInput('not-a-date')).toBe('');
  });

  it('유효한 ISO UTC → 로컬 "YYYY-MM-DDTHH:mm" (제로패딩 포함)', () => {
    // 로컬 2026-01-05 09:07 시각의 ISO UTC 문자열 → 로컬 표시로 되돌아온다(타임존 무관).
    const iso = new Date(2026, 0, 5, 9, 7).toISOString();
    expect(isoToLocalInput(iso)).toBe('2026-01-05T09:07');
  });

  it('초 단위는 분으로 절삭한다(datetime-local 기본 정밀도)', () => {
    const iso = new Date(2026, 3, 2, 10, 30, 45).toISOString();
    expect(isoToLocalInput(iso)).toBe('2026-04-02T10:30');
  });
});

describe('embargoDateInput — localInputToIso(datetime-local 로컬 → ISO UTC 저장값)', () => {
  it("빈 값(''/null/undefined) → '' (엠바고 해제 — 기존 계약 유지)", () => {
    expect(localInputToIso('')).toBe('');
    expect(localInputToIso(null)).toBe('');
    expect(localInputToIso(undefined)).toBe('');
  });

  it('로컬 "YYYY-MM-DDTHH:mm" → 같은 순간의 ISO UTC 문자열(Z 접미)', () => {
    const expected = new Date(2026, 6, 31, 14, 30).toISOString();
    const got = localInputToIso('2026-07-31T14:30');
    expect(got).toBe(expected);
    expect(got.endsWith('Z')).toBe(true);
  });

  it('초 포함 "YYYY-MM-DDTHH:mm:ss"도 수용한다(브라우저 step 설정 대비)', () => {
    const expected = new Date(2026, 6, 31, 14, 30, 15).toISOString();
    expect(localInputToIso('2026-07-31T14:30:15')).toBe(expected);
  });

  it("포맷 불일치/달력에 없는 날짜 → '' (브라우저는 유효값만 내보내지만 방어)", () => {
    expect(localInputToIso('2026-07-31')).toBe(''); // 시간 누락
    expect(localInputToIso('garbage')).toBe('');
    expect(localInputToIso('2026-02-31T10:00')).toBe(''); // 2월 31일 — 롤오버 거부
  });

  it('ISO 라운드트립 — 분 정밀 ISO UTC는 표시↔저장 왕복 후 동일 순간을 보존한다', () => {
    const iso = new Date(2026, 11, 25, 23, 59).toISOString();
    expect(localInputToIso(isoToLocalInput(iso))).toBe(iso);
  });
});
