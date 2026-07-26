import { describe, it, expect } from 'vitest';
import {
  parseTokens,
  joinTokens,
  REGION_MAX,
  CATEGORY_MAX,
  ATTRIBUTE_MAX,
  REGION_GROUPS,
  CATEGORY_GROUPS,
  ATTRIBUTES,
  metaFieldConfig,
} from './metaTaxonomy.js';

// 지역/내용/속성 택소노미 순수 데이터 + 콤마 토큰 헬퍼 — Meta.md 전사(원문 표기 보존).
// 2026-07-24 스펙 교정(Meta.md 오타 수정) 반영: 봉화/상주·영양/영주·칠곡/포항·라오스/마카오·이집트/잠비아 분리,
// 상임위·함남·니카라과·볼리비아·바누아투·솔로몬·통가·파푸아 표기 교정.
// CRITICAL: 파싱은 콤마 기준이다 — 공백 포함 토큰('PR Newswire' 등 속성, 그리고 '봉화 상주' 같은
// 교정 전 레거시 저장값)이 있어 공백 split은 데이터 파손.
describe('parseTokens — 콤마 문자열 → 토큰 배열(관대한 파싱)', () => {
  it('콤마로 쪼개고 trim하며 빈 토큰을 버린다', () => {
    expect(parseTokens('서울, 대전 ,')).toEqual(['서울', '대전']);
    expect(parseTokens('서울,대전,부산')).toEqual(['서울', '대전', '부산']);
  });

  it("빈/없음 방어: ''·null·undefined → []", () => {
    expect(parseTokens('')).toEqual([]);
    expect(parseTokens(null)).toEqual([]);
    expect(parseTokens(undefined)).toEqual([]);
    expect(parseTokens(' , ,, ')).toEqual([]);
  });

  it('공백 포함 토큰은 쪼개지 않고 보존한다(콤마 기준 파싱)', () => {
    expect(parseTokens('PR Newswire, 게시판')).toEqual(['PR Newswire', '게시판']);
    expect(parseTokens('봉화 상주')).toEqual(['봉화 상주']); // 교정 전 레거시 저장값 — 분리하면 파손
    expect(parseTokens('N.K Photo, Web Service')).toEqual(['N.K Photo', 'Web Service']);
  });

  it('중복은 제거하지 않는다(원본 보존 — 중복 처리는 소비 측 책임)', () => {
    expect(parseTokens('서울,서울')).toEqual(['서울', '서울']);
  });
});

describe('joinTokens — 토큰 배열 → 콤마 문자열', () => {
  it("', ' 구분자로 조인하고 빈 배열은 ''이다", () => {
    expect(joinTokens(['서울', '대전'])).toBe('서울, 대전');
    expect(joinTokens([])).toBe('');
  });

  it('라운드트립 시 토큰 값이 보존된다(공백 포함 토큰 포함)', () => {
    const tokens = ['PR Newswire', '봉화 상주', '게시판'];
    expect(parseTokens(joinTokens(tokens))).toEqual(tokens);
  });
});

describe('한도 상수 — news.md L65 단일 출처', () => {
  it('지역 5 / 내용 5 / 속성 3', () => {
    expect(REGION_MAX).toBe(5);
    expect(CATEGORY_MAX).toBe(5);
    expect(ATTRIBUTE_MAX).toBe(3);
  });
});

describe('metaFieldConfig — 필드 키 → { title, groups, limit }', () => {
  it("'region' → 지역/REGION_GROUPS/5", () => {
    const cfg = metaFieldConfig('region');
    expect(cfg.title).toBe('지역');
    expect(cfg.groups).toBe(REGION_GROUPS);
    expect(cfg.limit).toBe(5);
  });

  it("'category' → 내용/CATEGORY_GROUPS/5", () => {
    const cfg = metaFieldConfig('category');
    expect(cfg.title).toBe('내용');
    expect(cfg.groups).toBe(CATEGORY_GROUPS);
    expect(cfg.limit).toBe(5);
  });

  it("'attribute' → 속성/단일 그룹 래핑/3 (팝업이 한 가지 렌더 경로로 다루도록)", () => {
    const cfg = metaFieldConfig('attribute');
    expect(cfg.title).toBe('속성');
    expect(cfg.limit).toBe(3);
    expect(cfg.groups.length).toBe(1);
    expect(cfg.groups[0].label).toBe('속성');
    expect(cfg.groups[0].items.length).toBe(ATTRIBUTES.length);
  });

  it('미지원 키 → null', () => {
    expect(metaFieldConfig('zzz')).toBe(null);
    expect(metaFieldConfig('bad')).toBe(null);
    expect(metaFieldConfig('')).toBe(null);
    expect(metaFieldConfig(undefined)).toBe(null);
  });
});

// ── 데이터 무결성(전사 회귀 잠금) ─────────────────────────────────────────────
const allLeaves = (groups) => groups.flatMap((g) => g.items);

describe('택소노미 데이터 무결성 — Meta.md 전사 잠금', () => {
  it('모든 그룹: label은 비공백 문자열, items는 비어 있지 않고 전부 trim된 비공백 문자열', () => {
    for (const groups of [REGION_GROUPS, CATEGORY_GROUPS]) {
      for (const g of groups) {
        expect(typeof g.label).toBe('string');
        expect(g.label.trim()).toBe(g.label);
        expect(g.label.length).toBeGreaterThan(0);
        expect(Array.isArray(g.items)).toBe(true);
        expect(g.items.length).toBeGreaterThan(0);
        for (const item of g.items) {
          expect(typeof item).toBe('string');
          expect(item.trim()).toBe(item);
          expect(item.length).toBeGreaterThan(0);
        }
      }
    }
    for (const item of ATTRIBUTES) {
      expect(typeof item).toBe('string');
      expect(item.trim()).toBe(item);
      expect(item.length).toBeGreaterThan(0);
    }
  });

  it('전체 개수: 지역 그룹 34·leaf 401, 내용 그룹 6·leaf 57, 속성 96', () => {
    expect(REGION_GROUPS.length).toBe(34);
    expect(allLeaves(REGION_GROUPS).length).toBe(401); // 2026-07-24 교정: 콤마 누락 5쌍 분리로 396→401
    expect(CATEGORY_GROUPS.length).toBe(6);
    expect(allLeaves(CATEGORY_GROUPS).length).toBe(57);
    expect(ATTRIBUTES.length).toBe(96);
  });

  it('전 항목 1회 등장: 각 택소노미 안에서 leaf 중복 없음', () => {
    for (const leaves of [allLeaves(REGION_GROUPS), allLeaves(CATEGORY_GROUPS), ATTRIBUTES]) {
      expect(new Set(leaves).size).toBe(leaves.length);
    }
  });

  it('스팟 체크: 대표 항목이 leaf로 존재한다', () => {
    const regionLeaves = allLeaves(REGION_GROUPS);
    for (const leaf of ['전국종합', '서울', '평양', '봉화', '상주', '세종', '타히티', '독도']) {
      expect(regionLeaves).toContain(leaf);
    }
    const categoryLeaves = allLeaves(CATEGORY_GROUPS);
    for (const leaf of ['대통령', '경제일반', '탄핵', '정책한류']) {
      expect(categoryLeaves).toContain(leaf);
    }
    for (const leaf of ['게시판', '포털제외', 'PR Newswire', 'N.K Photo', 'Web Service', '2024한아프리카정상']) {
      expect(ATTRIBUTES).toContain(leaf);
    }
  });

  it('그룹 구조 스팟 체크: 하위그룹 label과 items가 원문 순서와 일치한다', () => {
    const byLabel = (groups, label) => groups.find((g) => g.label === label);
    expect(byLabel(REGION_GROUPS, '광역시').items).toEqual(['광주', '대구', '대전', '부산', '울산', '인천']);
    expect(byLabel(REGION_GROUPS, '전국종합').items).toEqual(['전국종합']); // 괄호 없는 낱개 → 자기 자신 그룹
    expect(byLabel(REGION_GROUPS, '평양직할시').items).toEqual(['평양']);
    expect(byLabel(REGION_GROUPS, '북미').items).toEqual(['북미', '멕시코', '미국', '캐나다']);
    expect(byLabel(CATEGORY_GROUPS, '청와대').items).toEqual(['청와일반', '대통령']);
    expect(byLabel(CATEGORY_GROUPS, '선거').items).toEqual(['선거일반', '대선', '총선', '지방선거', '재보선', '선거여론', '인수위']);
  });

  it('콤마 누락 교정(2026-07-24): 공백 결합 5쌍이 별도 leaf로 분리됐다', () => {
    const regionLeaves = allLeaves(REGION_GROUPS);
    for (const split of ['봉화', '상주', '영양', '영주', '칠곡', '포항', '라오스', '마카오', '이집트', '잠비아']) {
      expect(regionLeaves).toContain(split);
    }
    for (const legacy of ['봉화 상주', '영양 영주', '칠곡 포항', '라오스 마카오', '이집트 잠비아']) {
      expect(regionLeaves).not.toContain(legacy);
    }
    expect(regionLeaves).toContain('차드');
    expect(regionLeaves).toContain('카메룬');
  });

  it('오타 교정(2026-07-24): 상임위·함남 및 국명 표기', () => {
    expect(allLeaves(CATEGORY_GROUPS)).toContain('상임위'); // 舊 '상임이ㅜ'
    expect(allLeaves(CATEGORY_GROUPS)).not.toContain('상임이ㅜ');
    expect(allLeaves(CATEGORY_GROUPS)).toContain('국민연금'); // 舊 '국민영화' (2026-07-26 사용자 확정)
    expect(allLeaves(CATEGORY_GROUPS)).not.toContain('국민영화');
    expect(allLeaves(REGION_GROUPS)).toContain('함남'); // 함경남도 — 舊 '항남'
    expect(allLeaves(REGION_GROUPS)).not.toContain('항남');
    expect(allLeaves(REGION_GROUPS)).not.toContain('상임위'); // 상임위는 내용(분류) 소속
    const regionLeaves = allLeaves(REGION_GROUPS);
    for (const [fixed, old] of [
      ['니카라과', '나카라과'], ['볼리비아', '볼리아'], ['바누아투', '비누아투'],
      ['솔로몬', '슬로몬'], ['통가', '퉁가'], ['파푸아', '파부아'],
    ]) {
      expect(regionLeaves).toContain(fixed);
      expect(regionLeaves).not.toContain(old);
    }
  });
});
