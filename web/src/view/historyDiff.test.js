import { describe, it, expect } from 'vitest';
import { diffLines } from './historyDiff.js';

// 기사 이력 비교(도구>기사이력비교)의 라인 diff 순수 함수 — LCS 직접 구현(외부 의존성 0).
// 반환은 순서 보존 세그먼트 배열 [{ type: 'equal'|'del'|'add', text, aIndex?, bIndex? }].
describe('diffLines — LCS 라인 diff(순수·결정적)', () => {
  it('동일 텍스트 → 전 세그먼트 equal', () => {
    const segs = diffLines('제목\n부제목\n본문', '제목\n부제목\n본문');
    expect(segs).toHaveLength(3);
    expect(segs.every((s) => s.type === 'equal')).toBe(true);
    expect(segs.map((s) => s.text)).toEqual(['제목', '부제목', '본문']);
  });

  it('한 라인 추가 → 그 라인만 add, 나머지 equal(LCS로 공통 라인 유지)', () => {
    const segs = diffLines('첫줄\n셋째줄', '첫줄\n둘째줄\n셋째줄');
    expect(segs.map((s) => s.type)).toEqual(['equal', 'add', 'equal']);
    expect(segs[1].text).toBe('둘째줄');
  });

  it('한 라인 삭제 → 그 라인만 del, 나머지 equal', () => {
    const segs = diffLines('첫줄\n둘째줄\n셋째줄', '첫줄\n셋째줄');
    expect(segs.map((s) => s.type)).toEqual(['equal', 'del', 'equal']);
    expect(segs[1].text).toBe('둘째줄');
  });

  it('라인 수정 → 그 라인은 del + add 쌍, 나머지 equal', () => {
    const segs = diffLines('a\nb\nc', 'a\nX\nc');
    expect(segs.map((s) => s.type)).toEqual(['equal', 'del', 'add', 'equal']);
    expect(segs[1].text).toBe('b');
    expect(segs[2].text).toBe('X');
  });

  it('완전 상이 → 왼쪽 라인들 del + 오른쪽 라인들 add', () => {
    const segs = diffLines('a\nb', 'x\ny');
    expect(segs.map((s) => s.type)).toEqual(['del', 'del', 'add', 'add']);
    expect(segs.map((s) => s.text)).toEqual(['a', 'b', 'x', 'y']);
  });

  it('빈 문자열 둘 → 빈 배열(throw 없음)', () => {
    expect(diffLines('', '')).toEqual([]);
  });

  it('한쪽만 빈 경우 — 왼쪽 빈 → 전부 add, 오른쪽 빈 → 전부 del', () => {
    expect(diffLines('', 'a\nb').map((s) => s.type)).toEqual(['add', 'add']);
    expect(diffLines('a\nb', '').map((s) => s.type)).toEqual(['del', 'del']);
  });

  it('null/undefined 입력도 빈 텍스트로 안전 처리(throw 없음)', () => {
    expect(diffLines(null, undefined)).toEqual([]);
    expect(diffLines(undefined, 'a').map((s) => s.type)).toEqual(['add']);
  });

  it('세그먼트에 라인 번호가 붙는다 — equal은 aIndex+bIndex, del은 aIndex, add는 bIndex', () => {
    const segs = diffLines('a\nb\nc', 'a\nc\nd');
    // equal(a: a0/b0) → del(b: a1) → equal(c: a2/b1) → add(d: b2)
    expect(segs[0]).toMatchObject({ type: 'equal', aIndex: 0, bIndex: 0 });
    expect(segs[1]).toMatchObject({ type: 'del', text: 'b', aIndex: 1 });
    expect(segs[2]).toMatchObject({ type: 'equal', aIndex: 2, bIndex: 1 });
    expect(segs[3]).toMatchObject({ type: 'add', text: 'd', bIndex: 2 });
  });

  it('순수·결정적 — 같은 입력 2회 호출 시 동일 결과, 입력 문자열은 변형되지 않는다', () => {
    const a = '제목\n본문 첫 줄\n(끝)';
    const b = '제목 고침\n본문 첫 줄\n추가 문단\n(끝)';
    const first = diffLines(a, b);
    const second = diffLines(a, b);
    expect(second).toEqual(first);
  });
});
