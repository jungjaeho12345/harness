import { describe, it, expect } from 'vitest';
import { convertCompanyCode, convertCompanyCodeInBlocks } from './companyCodeConvert.js';
import { textBlock, embedBlock } from './editorContent.js';

// 기업코드 변환 순수 엔진 — 최장일치·멱등 lookahead·anti-cascade·미등록 pass-through.
describe('convertCompanyCode — 문자열 태깅', () => {
  it('종목명을 "종목명(코드)"로 태깅한다', () => {
    expect(convertCompanyCode('삼성전자가 발표했다')).toBe('삼성전자(005930)가 발표했다');
  });

  it('여러 종목을 모두 태깅한다', () => {
    expect(convertCompanyCode('삼성전자와 카카오')).toBe('삼성전자(005930)와 카카오(035720)');
  });

  it('미등록 종목명은 변환하지 않는다(pass-through)', () => {
    expect(convertCompanyCode('없는회사가 발표')).toBe('없는회사가 발표');
  });

  it('멱등(핵심): 이미 태깅된 종목명은 다시 감싸지 않는다', () => {
    expect(convertCompanyCode('삼성전자(005930)')).toBe('삼성전자(005930)');
  });

  it('멱등(핵심): 두 번 적용해도 결과가 같다', () => {
    const once = convertCompanyCode('삼성전자와 카카오가 만났다');
    expect(convertCompanyCode(once)).toBe(once);
  });

  it('최장일치 우선: 접두 관계 종목은 더 긴 이름이 우선 매칭된다', () => {
    // 현대차(005380)는 현대차증권(001500)의 접두 — 더 긴 이름이 우선.
    expect(convertCompanyCode('현대차증권 실적')).toBe('현대차증권(001500) 실적');
    expect(convertCompanyCode('현대차 실적')).toBe('현대차(005380) 실적');
  });

  it('빈/undefined 입력에도 죽지 않는다', () => {
    expect(convertCompanyCode('')).toBe('');
    expect(convertCompanyCode(undefined)).toBe('');
  });

  it('태깅 직후 원문 뒷부분을 이어서 스캔한다(anti-cascade)', () => {
    // 주입한 (005930)를 재스캔하지 않으므로 뒤 문자 '다'가 보존된다.
    expect(convertCompanyCode('삼성전자다')).toBe('삼성전자(005930)다');
  });
});

describe('convertCompanyCodeInBlocks — 블록 변환', () => {
  it('텍스트 블록만 변환하고 changed를 알린다', () => {
    const { blocks, changed } = convertCompanyCodeInBlocks([textBlock('카카오 뉴스')]);
    expect(changed).toBe(true);
    expect(blocks[0].text).toBe('카카오(035720) 뉴스');
  });

  it('임베드 블록은 불변', () => {
    const embed = embedBlock({ type: 'image', src: 'x' });
    const { blocks } = convertCompanyCodeInBlocks([textBlock('삼성전자'), embed]);
    expect(blocks[1]).toEqual(embed);
  });

  it('"(끝)" 블록은 불변', () => {
    const { blocks } = convertCompanyCodeInBlocks([textBlock('삼성전자'), textBlock('(끝)')]);
    expect(blocks[1].text).toBe('(끝)');
  });

  it('멱등: 두 번째 적용은 changed=false, 블록 동일', () => {
    const first = convertCompanyCodeInBlocks([textBlock('삼성전자와 카카오')]);
    const second = convertCompanyCodeInBlocks(first.blocks);
    expect(second.changed).toBe(false);
    expect(second.blocks[0].text).toBe(first.blocks[0].text);
  });

  it('매칭 없으면 changed=false(no-op)', () => {
    const { changed } = convertCompanyCodeInBlocks([textBlock('일반 텍스트')]);
    expect(changed).toBe(false);
  });
});
