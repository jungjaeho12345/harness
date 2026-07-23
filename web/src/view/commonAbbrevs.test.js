import { describe, it, expect } from 'vitest';
import { COMMON_ABBREVS, mergeAbbrevs } from './commonAbbrevs.js';
import { expandAbbrevInBlocks } from './abbrevConvert.js';
import { textBlock } from './editorContent.js';

// 공용약어 번들 + 병합 헬퍼(순수). DOM/localStorage 비의존.
describe('COMMON_ABBREVS — 번들 정적 목록', () => {
  it('30개 이상이며 모든 원소가 비어 있지 않은 { short, long }이다', () => {
    expect(COMMON_ABBREVS.length).toBeGreaterThanOrEqual(30);
    for (const p of COMMON_ABBREVS) {
      expect(typeof p.short).toBe('string');
      expect(typeof p.long).toBe('string');
      expect(p.short.length).toBeGreaterThan(0);
      expect(p.long.length).toBeGreaterThan(0);
      expect(p.short).not.toBe(p.long); // 축약형이므로 short≠long
    }
  });

  it('short 중복이 없다', () => {
    const shorts = COMMON_ABBREVS.map((p) => p.short);
    expect(new Set(shorts).size).toBe(shorts.length);
  });

  it('AC 고정 쌍이 존재한다(기재부/한전/WHO)', () => {
    const find = (s) => COMMON_ABBREVS.find((p) => p.short === s);
    expect(find('기재부')).toMatchObject({ long: '기획재정부' });
    expect(find('한전')).toMatchObject({ long: '한국전력공사' });
    expect(find('WHO')).toMatchObject({ long: '세계보건기구' });
  });
});

describe('mergeAbbrevs — 사용자+공용 병합', () => {
  it('includeCommon 기본(true)은 공용약어를 포함한다', () => {
    const merged = mergeAbbrevs([], {});
    expect(merged.some((p) => p.short === 'WHO')).toBe(true);
    expect(merged.length).toBeGreaterThanOrEqual(COMMON_ABBREVS.length);
  });

  it('includeCommon=false면 사용자 약어만 반환한다(공용 제외)', () => {
    const merged = mergeAbbrevs([{ short: 'X', long: 'Y' }], { includeCommon: false });
    expect(merged).toEqual([{ short: 'X', long: 'Y' }]);
    expect(merged.some((p) => p.short === 'WHO')).toBe(false);
  });

  it('같은 short는 사용자 우선(공용값 제외)', () => {
    const merged = mergeAbbrevs([{ short: '한전', long: '우리회사' }], {});
    const 한전 = merged.filter((p) => p.short === '한전');
    expect(한전).toHaveLength(1);
    expect(한전[0].long).toBe('우리회사'); // 사용자 값 승리
  });

  it('사용자 약어가 앞, 공용이 뒤에 온다', () => {
    const merged = mergeAbbrevs([{ short: 'AAA', long: 'bbb' }], {});
    expect(merged[0]).toEqual({ short: 'AAA', long: 'bbb' });
  });

  it('배열 아님/빈 값에도 죽지 않는다(방어)', () => {
    expect(() => mergeAbbrevs(undefined, {})).not.toThrow();
    expect(mergeAbbrevs(null, { includeCommon: false })).toEqual([]);
  });

  it('엔진 통합: 병합 결과로 공용약어가 실제 확장된다', () => {
    const { blocks, changed } = expandAbbrevInBlocks([textBlock('WHO 발표')], mergeAbbrevs([], {}));
    expect(changed).toBe(true);
    expect(blocks[0].text).toBe('세계보건기구 발표');
  });

  it('noCommonAbbr 시나리오: includeCommon=false면 공용약어는 확장되지 않는다', () => {
    const { changed } = expandAbbrevInBlocks([textBlock('WHO 발표')], mergeAbbrevs([], { includeCommon: false }));
    expect(changed).toBe(false);
  });
});
