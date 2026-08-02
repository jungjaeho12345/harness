import { describe, it, expect } from 'vitest';
import { expandAbbrev, expandAbbrevInBlocks } from './abbrevConvert.js';
import { textBlock, embedBlock } from './editorContent.js';

// 약어 치환 순수 계산 — "단어경계 가드 + 최장일치 우선 + 단일 좌→우 스캔 + case-sensitive" 의미론.
// CRITICAL: 부분문자열 오확장 금지 / 확장형 재확장 금지. DOM/localStorage 비의존.
describe('expandAbbrev — 문자열 약어 치환', () => {
  it('빈 목록/undefined면 원문 그대로 반환한다', () => {
    expect(expandAbbrev('x', [])).toBe('x');
    expect(expandAbbrev('x', undefined)).toBe('x');
  });

  it('기본 확장: 등록된 약어를 확장형으로 바꾼다', () => {
    expect(expandAbbrev('정부 발표', [{ short: '정부', long: '대한민국 정부' }])).toBe('대한민국 정부 발표');
  });

  it('재확장 금지(anti-cascade): 확장형 안에 short가 있어도 다시 확장하지 않는다', () => {
    // long '대한민국 정부' 안에 '정부'가 있어도 한 번만 확장된다.
    expect(expandAbbrev('정부 발표', [{ short: '정부', long: '대한민국 정부' }])).toBe('대한민국 정부 발표');
  });

  it('부분문자열 오확장 차단(왼쪽 단어문자): 행정부 안의 정부는 확장 안 함', () => {
    expect(expandAbbrev('행정부 개편', [{ short: '정부', long: 'X' }])).toBe('행정부 개편');
  });

  it('보수적 미확장(오른쪽 조사): 정부가는 확장하지 않는다(의도된 보수성)', () => {
    expect(expandAbbrev('정부가', [{ short: '정부', long: 'X' }])).toBe('정부가');
  });

  it('부분문자열 오확장 차단(오른쪽 단어문자): 정부처 안의 정부는 확장 안 함(AC-named 접두 케이스)', () => {
    // '정부'가 더 긴 실제 단어 '정부처'의 접두일 때, 뒤가 단어문자라 미확장(행정부의 좌측 대칭).
    expect(expandAbbrev('정부처 신설', [{ short: '정부', long: 'X' }])).toBe('정부처 신설');
  });

  it('구두점 경계에서는 확장한다: (정부) → (X)', () => {
    expect(expandAbbrev('(정부)', [{ short: '정부', long: 'X' }])).toBe('(X)');
  });

  it('최장일치 우선: USA가 US보다 먼저 매치된다', () => {
    expect(expandAbbrev('USA 발표', [
      { short: 'US', long: 'United States' },
      { short: 'USA', long: '미국' },
    ])).toBe('미국 발표');
  });

  it('양쪽 독립 확장: US와 USA가 각각 확장된다', () => {
    expect(expandAbbrev('US and USA', [
      { short: 'US', long: 'United States' },
      { short: 'USA', long: '미국' },
    ])).toBe('United States and 미국');
  });

  it('최장일치 우선(정렬 회귀 가드): 겹치는 접두를 긴 후보가 선점한다', () => {
    // CRITICAL: 'US'/'USA'는 단어경계 가드만으로도 통과하므로(짧은 후보가 어차피 우측 단어문자로 막힘)
    // 최장일치 "정렬"을 실제로 검증하지 못한다. 여기서는 짧은 후보가 유효 경계에서 매치될 수 있는
    // 구두점 종단 케이스로 정렬 자체를 가드한다 — 정렬 제거 시 'Carbon#'이 되어 실패한다.
    expect(expandAbbrev('C#', [
      { short: 'C', long: 'Carbon' },   // 원순서상 먼저지만 짧다 — 최장일치면 밀려야 한다.
      { short: 'C#', long: 'CSharp' },
    ])).toBe('CSharp');
    // AC-named 한국어 겹침(정 vs 정부): 긴 것이 우선 — 정렬+경계 조합의 의도 문서화.
    expect(expandAbbrev('정부', [
      { short: '정', long: 'A' },
      { short: '정부', long: 'B' },
    ])).toBe('B');
  });

  it('case-sensitive: us는 US로 확장되지 않는다', () => {
    expect(expandAbbrev('us', [{ short: 'US', long: 'X' }])).toBe('us');
  });

  it('순서 독립·단일 스캔: A→B 결과가 다시 B→C로 이어지지 않는다', () => {
    expect(expandAbbrev('A B', [{ short: 'A', long: 'B' }, { short: 'B', long: 'C' }])).toBe('B C');
  });

  it('다중 발생: 같은 약어가 여러 번 나오면 모두 확장한다', () => {
    expect(expandAbbrev('정부 정부', [{ short: '정부', long: 'X' }])).toBe('X X');
  });

  it('text가 null/숫자여도 문자열로 강제한다', () => {
    expect(expandAbbrev(null, [{ short: 'X', long: 'Y' }])).toBe('');
    expect(expandAbbrev(123, [])).toBe('123');
  });

  it('빈 short 항목은 방어적으로 무시한다(무한/오확장 방지)', () => {
    expect(expandAbbrev('정부', [{ short: '', long: 'X' }, { short: '정부', long: 'Y' }])).toBe('Y');
  });
});

describe('expandAbbrevInBlocks — 블록 단위 약어 치환', () => {
  it('텍스트 블록만 변환하고 임베드 블록은 참조/내용 보존, changed=true', () => {
    const embed = embedBlock({ embedType: 'image', src: 'http://x/y.png' });
    const blocks = [textBlock('정부'), embed, textBlock('정부')];
    const { blocks: out, changed } = expandAbbrevInBlocks(blocks, [{ short: '정부', long: 'X' }]);
    expect(changed).toBe(true);
    expect(out[0]).toEqual(textBlock('X'));
    expect(out[2]).toEqual(textBlock('X'));
    // 임베드 블록 내용 보존.
    expect(out[1]).toEqual({ ...embed, type: 'embed' });
    expect(out[1].embedType).toBe('image');
    expect(out[1].src).toBe('http://x/y.png');
  });

  it('"(끝)" 블록은 불변: 텍스트만 변환하고 (끝)은 통과', () => {
    const { blocks: out, changed } = expandAbbrevInBlocks(
      [textBlock('정부'), textBlock('(끝)')],
      [{ short: '정부', long: 'X' }],
    );
    expect(out[0]).toEqual(textBlock('X'));
    expect(out[1]).toEqual(textBlock('(끝)'));
    expect(changed).toBe(true);
  });

  it('short가 "끝"이어도 "(끝)" 블록은 바뀌지 않는다', () => {
    const { blocks: out, changed } = expandAbbrevInBlocks(
      [textBlock('(끝)')],
      [{ short: '끝', long: 'Z' }],
    );
    expect(out[0]).toEqual(textBlock('(끝)'));
    expect(changed).toBe(false);
  });

  it('빈 목록이면 changed=false', () => {
    const { changed } = expandAbbrevInBlocks([textBlock('정부')], []);
    expect(changed).toBe(false);
  });

  it('텍스트 블록이 없으면(임베드만) changed=false', () => {
    const embed = embedBlock({ embedType: 'youtube', videoId: 'abc' });
    const { changed } = expandAbbrevInBlocks([embed], [{ short: '정부', long: 'X' }]);
    expect(changed).toBe(false);
  });

  it('입력 blocks를 mutate 하지 않는다(원본 배열/객체 불변)', () => {
    const original = [textBlock('정부'), textBlock('발표')];
    const snapshot = JSON.parse(JSON.stringify(original));
    const { blocks: out } = expandAbbrevInBlocks(original, [{ short: '정부', long: 'X' }]);
    expect(original).toEqual(snapshot);
    expect(out).not.toBe(original);
    expect(out[0]).not.toBe(original[0]);
  });
});

describe('expandAbbrevInBlocks — 정렬(align) 승계', () => {
  it('정렬된 줄의 약어 확장 후 align을 유지한다', () => {
    const { blocks, changed } = expandAbbrevInBlocks(
      [textBlock('정부 발표', 'right')],
      [{ short: '정부', long: 'X' }],
    );
    expect(changed).toBe(true);
    expect(blocks[0].text).toBe('X 발표');
    expect(blocks[0].align).toBe('right');
  });

  it('미정렬 줄 확장 결과에는 align 키가 생기지 않는다(스퍼리어스 금지)', () => {
    const { blocks } = expandAbbrevInBlocks([textBlock('정부 발표')], [{ short: '정부', long: 'X' }]);
    expect(blocks[0].text).toBe('X 발표');
    expect('align' in blocks[0]).toBe(false);
  });

  it('확장이 일어나지 않은 정렬 줄은 원본 그대로 유지된다(align 포함)', () => {
    const { blocks, changed } = expandAbbrevInBlocks(
      [textBlock('일반 문장', 'center')],
      [{ short: '정부', long: 'X' }],
    );
    expect(changed).toBe(false);
    expect(blocks[0]).toEqual(textBlock('일반 문장', 'center'));
  });
});
