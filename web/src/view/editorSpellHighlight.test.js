import { describe, it, expect } from 'vitest';
import { buildLineHighlights } from './editorSpellHighlight.js';
import { checkSpelling } from './editorSpell.js';

// 각 줄 세그먼트의 text를 순서대로 이어붙인다 — 불변식(원문 손실/추가 없음) 검증용.
const joined = (segs) => segs.map((s) => s.text).join('');

describe('editorSpellHighlight — 단일 줄 세그먼트', () => {
  it('줄 중간 span → [before, hl, after] 3세그먼트, 이어붙이면 원문', () => {
    const text = 'abcdef';
    const out = buildLineHighlights(text, [{ start: 2, end: 4 }]);
    expect(out).toEqual([[
      { text: 'ab', hl: false },
      { text: 'cd', hl: true },
      { text: 'ef', hl: false },
    ]]);
    expect(joined(out[0])).toBe(text);
  });

  it('줄 시작 span → 앞 비-hl 세그먼트 없음', () => {
    expect(buildLineHighlights('abcd', [{ start: 0, end: 2 }])).toEqual([[
      { text: 'ab', hl: true },
      { text: 'cd', hl: false },
    ]]);
  });

  it('줄 끝까지 span → 뒤 비-hl 세그먼트 없음', () => {
    expect(buildLineHighlights('abcd', [{ start: 2, end: 4 }])).toEqual([[
      { text: 'ab', hl: false },
      { text: 'cd', hl: true },
    ]]);
  });

  it('줄 전체 span → [hl] 1세그먼트', () => {
    expect(buildLineHighlights('abcd', [{ start: 0, end: 4 }])).toEqual([[
      { text: 'abcd', hl: true },
    ]]);
  });

  it('한 줄 안의 여러 span은 문서 순서대로 번갈아 나온다', () => {
    expect(buildLineHighlights('abcdefgh', [{ start: 4, end: 6 }, { start: 1, end: 2 }])).toEqual([[
      { text: 'a', hl: false },
      { text: 'b', hl: true },
      { text: 'cd', hl: false },
      { text: 'ef', hl: true },
      { text: 'gh', hl: false },
    ]]);
  });
});

describe('editorSpellHighlight — span 병합(합집합)', () => {
  it('겹치는 span {0,3},{2,5} → 병합 {0,5} 단일 hl', () => {
    expect(buildLineHighlights('abcdef', [{ start: 0, end: 3 }, { start: 2, end: 5 }])).toEqual([[
      { text: 'abcde', hl: true },
      { text: 'f', hl: false },
    ]]);
  });

  it('맞닿은 span {0,2},{2,4} → 병합 {0,4} 단일 hl', () => {
    expect(buildLineHighlights('abcde', [{ start: 0, end: 2 }, { start: 2, end: 4 }])).toEqual([[
      { text: 'abcd', hl: true },
      { text: 'e', hl: false },
    ]]);
  });

  it('입력 순서와 무관하게 병합한다(정렬 후 병합)', () => {
    expect(buildLineHighlights('abcdef', [{ start: 2, end: 5 }, { start: 0, end: 3 }])).toEqual([[
      { text: 'abcde', hl: true },
      { text: 'f', hl: false },
    ]]);
  });

  it('포함 관계 span({0,6} 안의 {2,3})도 하나로 병합한다', () => {
    expect(buildLineHighlights('abcdef', [{ start: 0, end: 6 }, { start: 2, end: 3 }])).toEqual([[
      { text: 'abcdef', hl: true },
    ]]);
  });
});

describe('editorSpellHighlight — 멀티라인', () => {
  it('여러 줄에 걸친 span은 각 줄의 걸친 부분만 hl한다(\\n 미포함)', () => {
    // 'ab\ncd\nef' — 오프셋: a0 b1 \n2 c3 d4 \n5 e6 f7. span {1,7} = b~e.
    const text = 'ab\ncd\nef';
    const out = buildLineHighlights(text, [{ start: 1, end: 7 }]);
    expect(out).toEqual([
      [{ text: 'a', hl: false }, { text: 'b', hl: true }],
      [{ text: 'cd', hl: true }],
      [{ text: 'e', hl: true }, { text: 'f', hl: false }],
    ]);
    text.split('\n').forEach((line, i) => expect(joined(out[i])).toBe(line));
  });

  it('\\n만 덮는 span은 어느 줄도 하이라이트하지 않는다', () => {
    expect(buildLineHighlights('ab\ncd', [{ start: 2, end: 3 }])).toEqual([
      [{ text: 'ab', hl: false }],
      [{ text: 'cd', hl: false }],
    ]);
  });
});

describe('editorSpellHighlight — 무효 span·경계 clamp', () => {
  it('범위 밖/빈/역전/비유한 span은 무시한다(무-하이라이트)', () => {
    const out = buildLineHighlights('abc', [
      { start: 10, end: 20 },
      { start: 2, end: 2 },
      { start: 3, end: 1 },
      { start: NaN, end: 2 },
      { start: 0, end: Infinity },
    ]);
    expect(out).toEqual([[{ text: 'abc', hl: false }]]);
  });

  it('부분적으로 범위 밖인 span은 [0, text.length]로 clamp된다', () => {
    expect(buildLineHighlights('abc', [{ start: -2, end: 2 }])).toEqual([[
      { text: 'ab', hl: true },
      { text: 'c', hl: false },
    ]]);
    expect(buildLineHighlights('abc', [{ start: 1, end: 99 }])).toEqual([[
      { text: 'a', hl: false },
      { text: 'bc', hl: true },
    ]]);
  });

  it('하이라이트 없는 줄은 단일 비-hl 세그먼트, 빈 줄은 {text:"", hl:false}', () => {
    expect(buildLineHighlights('가나\n\n다라', [])).toEqual([
      [{ text: '가나', hl: false }],
      [{ text: '', hl: false }],
      [{ text: '다라', hl: false }],
    ]);
  });

  it('빈 text → [[{text:"", hl:false}]]', () => {
    expect(buildLineHighlights('', [])).toEqual([[{ text: '', hl: false }]]);
    expect(buildLineHighlights('', [{ start: 0, end: 3 }])).toEqual([[{ text: '', hl: false }]]);
  });
});

describe('editorSpellHighlight — 한글·issue 객체 통합', () => {
  it('한글 오탈자 span은 정확히 그 글자만 hl한다', () => {
    // '기사가 됫다\n본문' — 됫=4, 다=5 → span {4,6}.
    expect(buildLineHighlights('기사가 됫다\n본문', [{ start: 4, end: 6 }])).toEqual([
      [{ text: '기사가 ', hl: false }, { text: '됫다', hl: true }],
      [{ text: '본문', hl: false }],
    ]);
  });

  it('checkSpelling issue 객체(group/message 포함)를 그대로 넣어도 start/end만 읽어 동작한다', () => {
    const text = '오늘 회의가 됫다';
    const issues = checkSpelling(text, { groups: ['misuse'] });
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ group: 'misuse', suggestion: '됐다' });
    expect(buildLineHighlights(text, issues)).toEqual([[
      { text: '오늘 회의가 ', hl: false },
      { text: '됫다', hl: true },
    ]]);
  });
});

describe('editorSpellHighlight — 순수·불변', () => {
  it('입력 text/spans를 mutate하지 않고 같은 입력에 같은 출력을 낸다(결정적)', () => {
    const spans = [{ start: 2, end: 5, group: 'misuse' }, { start: 0, end: 3 }];
    const copy = JSON.parse(JSON.stringify(spans));
    const a = buildLineHighlights('abcdef', spans);
    const b = buildLineHighlights('abcdef', spans);
    expect(spans).toEqual(copy);
    expect(a).toEqual(b);
  });

  it('공백을 접거나 정규화하지 않는다(공백-전용 hl 세그먼트 보존)', () => {
    // '가  나' — 중복 공백 구간 span {1,3}(spacing 이슈 상정).
    expect(buildLineHighlights('가  나', [{ start: 1, end: 3 }])).toEqual([[
      { text: '가', hl: false },
      { text: '  ', hl: true },
      { text: '나', hl: false },
    ]]);
  });
});
