import { describe, it, expect } from 'vitest';
import { COMPANY_CODES } from './companyCodeTable.js';

// 기업코드 번들 정적 표. 오프라인·의존성 0.
describe('COMPANY_CODES — 번들 정적 종목표', () => {
  it('100개 이상이다', () => {
    expect(COMPANY_CODES.length).toBeGreaterThanOrEqual(100);
  });

  it('모든 code가 6자리 숫자 문자열이고 name이 비어 있지 않다', () => {
    for (const c of COMPANY_CODES) {
      expect(typeof c.name).toBe('string');
      expect(c.name.length).toBeGreaterThan(0);
      expect(c.code).toMatch(/^\d{6}$/);
    }
  });

  it('name 중복이 없다', () => {
    const names = COMPANY_CODES.map((c) => c.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('AC 고정 쌍이 정확한 코드로 존재한다', () => {
    const find = (n) => COMPANY_CODES.find((c) => c.name === n);
    expect(find('삼성전자')).toMatchObject({ code: '005930' });
    expect(find('SK하이닉스')).toMatchObject({ code: '000660' });
    expect(find('NAVER')).toMatchObject({ code: '035420' });
    expect(find('카카오')).toMatchObject({ code: '035720' });
    expect(find('현대차')).toMatchObject({ code: '005380' });
    expect(find('LG에너지솔루션')).toMatchObject({ code: '373220' });
    expect(find('셀트리온')).toMatchObject({ code: '068270' });
    expect(find('삼성바이오로직스')).toMatchObject({ code: '207940' });
  });
});
