import { describe, it, expect } from 'vitest';
import { convertSimpTrad, convertSimpTradInBlocks, DIRECTIONS } from './simpTradConvert.js';
import { textBlock, embedBlock } from './editorContent.js';

// 간↔번 변환 순수 계산 — 문자단위 1:1 치환, 미매핑 pass-through, 방향 방어. DOM/localStorage 비의존.
// CRITICAL: 오변환(false conversion)은 발행 기사 무결성 사고 — 미변환이 오변환보다 안전(약어 '미확장'과 동일 철학).
describe('convertSimpTrad — 문자열 간↔번 치환', () => {
  it('빈/방어: 빈 문자열·잘못된 방향·null을 안전하게 처리한다', () => {
    expect(convertSimpTrad('', 'toTrad')).toBe('');
    expect(convertSimpTrad('abc', 'toTrad')).toBe('abc'); // 라틴 pass-through
    expect(convertSimpTrad('国', 'bogus')).toBe('国'); // 잘못된 방향 → 원문
    expect(convertSimpTrad(null, 'toTrad')).toBe('');
    expect(convertSimpTrad(123, 'toTrad')).toBe('123');
  });

  it('간체→번체: 등록 문자를 번체로 바꾼다', () => {
    expect(convertSimpTrad('国', 'toTrad')).toBe('國');
    expect(convertSimpTrad('学习', 'toTrad')).toBe('學習');
    expect(convertSimpTrad('电车', 'toTrad')).toBe('電車');
  });

  it('번체→간체(역방향): 등록 문자를 간체로 바꾼다', () => {
    expect(convertSimpTrad('國', 'toSimp')).toBe('国');
    expect(convertSimpTrad('電車', 'toSimp')).toBe('电车');
    expect(convertSimpTrad('學', 'toSimp')).toBe('学');
  });

  it('DIRECTIONS 상수로도 방향을 지정할 수 있다', () => {
    expect(convertSimpTrad('国', DIRECTIONS.TO_TRAD)).toBe('國');
    expect(convertSimpTrad('國', DIRECTIONS.TO_SIMP)).toBe('国');
  });

  it('미매핑 pass-through(혼합): 중국어만 변환, 한글/라틴/숫자/공백 불변', () => {
    expect(convertSimpTrad('한글 abc 国 123', 'toTrad')).toBe('한글 abc 國 123');
  });

  it('1:多 간체는 최빈(먼저 나열된) 번체로 변환한다(first-wins)', () => {
    expect(convertSimpTrad('发', 'toTrad')).toBe('發'); // 發 우선(髮 아님)
    expect(convertSimpTrad('复', 'toTrad')).toBe('復'); // 復 우선(複/覆 아님)
    // 역방향은 결정적: 여러 번체가 같은 간체로 복귀.
    expect(convertSimpTrad('發', 'toSimp')).toBe('发');
    expect(convertSimpTrad('髮', 'toSimp')).toBe('发');
    expect(convertSimpTrad('複', 'toSimp')).toBe('复');
    expect(convertSimpTrad('覆', 'toSimp')).toBe('复');
  });

  it('왕복(round-trip): 결정적 1:1 쌍은 간→번→간이 원문으로 복귀한다', () => {
    const simp = '国学电车门时语汉华马见长东说会';
    expect(convertSimpTrad(convertSimpTrad(simp, 'toTrad'), 'toSimp')).toBe(simp);
  });

  it('1:多 왕복은 비가역(최빈 수렴): 髮/複/覆는 번→간→번에서 發/復으로 붕괴한다(first-wins 표순서 가드)', () => {
    // 번체 '髮'→간체 '发'→다시 번체는 최빈 '發'으로 수렴해 원래 髮로 복귀하지 못한다(문맥 없는 1:多의 본질적 한계).
    // 표(simpTradTable) 나열 순서가 바뀌면 이 수렴값이 달라지므로, 예상되는 무손실 붕괴를 못박아 회귀를 잡는다.
    expect(convertSimpTrad(convertSimpTrad('髮', 'toSimp'), 'toTrad')).toBe('發');
    expect(convertSimpTrad(convertSimpTrad('複', 'toSimp'), 'toTrad')).toBe('復');
    expect(convertSimpTrad(convertSimpTrad('覆', 'toSimp'), 'toTrad')).toBe('復');
  });

  it('CJK 문장부호·개행 pass-through: 중국어만 변환하고 。，·개행은 원문 유지', () => {
    // 문장부호(。U+3002 / ，U+FF0C)와 개행은 매핑표에 없어 그대로 통과 — 실기사 혼합문에서 서식이 깨지지 않는다.
    expect(convertSimpTrad('国。学，电', 'toTrad')).toBe('國。學，電');
    expect(convertSimpTrad('国\n电车', 'toTrad')).toBe('國\n電車');
  });

  it('길이 보존: 문자단위 1:1이라 코드포인트 수가 불변한다', () => {
    const s = '国学电车门时语汉华马 abc 한글';
    expect(Array.from(convertSimpTrad(s, 'toTrad')).length).toBe(Array.from(s).length);
  });

  it('다중 발생: 같은 문자가 여러 번 나와도 모두 변환한다', () => {
    expect(convertSimpTrad('国国国', 'toTrad')).toBe('國國國');
  });

  it('surrogate(보충면) 문자를 쪼개지 않는다', () => {
    // 이모지(surrogate pair)는 그대로 통과하고, 매핑 대상만 변환한다.
    expect(convertSimpTrad('国😀学', 'toTrad')).toBe('國😀學');
  });
});

describe('convertSimpTradInBlocks — 블록 단위 간↔번 치환', () => {
  it('텍스트 블록만 변환하고 임베드 블록은 참조/내용 보존, changed=true', () => {
    const embed = embedBlock({ embedType: 'image', src: 'http://x/y.png' });
    const blocks = [textBlock('国'), embed, textBlock('学')];
    const { blocks: out, changed } = convertSimpTradInBlocks(blocks, 'toTrad');
    expect(changed).toBe(true);
    expect(out[0]).toEqual(textBlock('國'));
    expect(out[2]).toEqual(textBlock('學'));
    // 임베드 블록 내용 보존.
    expect(out[1]).toEqual({ ...embed, type: 'embed' });
    expect(out[1].embedType).toBe('image');
    expect(out[1].src).toBe('http://x/y.png');
  });

  it('"(끝)" 블록은 불변: 텍스트만 변환하고 (끝)은 통과', () => {
    const { blocks: out, changed } = convertSimpTradInBlocks(
      [textBlock('国'), textBlock('(끝)')],
      'toTrad',
    );
    expect(out[0]).toEqual(textBlock('國'));
    expect(out[1]).toEqual(textBlock('(끝)'));
    expect(changed).toBe(true);
  });

  it('변환 대상 없음이면 changed=false(한글/라틴뿐)', () => {
    const { changed } = convertSimpTradInBlocks([textBlock('한글 abc')], 'toTrad');
    expect(changed).toBe(false);
  });

  it('잘못된 방향이면 changed=false(원문 그대로)', () => {
    const { blocks: out, changed } = convertSimpTradInBlocks([textBlock('国')], 'bogus');
    expect(changed).toBe(false);
    expect(out[0]).toEqual(textBlock('国'));
  });

  it('텍스트 블록이 없으면(임베드만) changed=false', () => {
    const embed = embedBlock({ embedType: 'youtube', videoId: 'abc' });
    const { changed } = convertSimpTradInBlocks([embed], 'toTrad');
    expect(changed).toBe(false);
  });

  it('입력 blocks를 mutate 하지 않는다(원본 배열/객체 불변)', () => {
    const original = [textBlock('国'), textBlock('学')];
    const snapshot = JSON.parse(JSON.stringify(original));
    const { blocks: out } = convertSimpTradInBlocks(original, 'toTrad');
    expect(original).toEqual(snapshot);
    expect(out).not.toBe(original);
    expect(out[0]).not.toBe(original[0]);
  });
});
