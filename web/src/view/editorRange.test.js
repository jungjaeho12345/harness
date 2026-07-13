import { describe, it, expect } from 'vitest';
import { wordBoundsAt, paragraphBoundsAt } from './editorRange.js';

describe('editorRange — wordBoundsAt', () => {
  it('단어 중간이면 그 단어 전체 범위를 반환한다', () => {
    expect(wordBoundsAt('foo bar', 1)).toEqual({ start: 0, end: 3 });
  });

  it('단어 시작 경계면 그 단어를 반환한다', () => {
    expect(wordBoundsAt('foo bar', 4)).toEqual({ start: 4, end: 7 });
  });

  it('단어 끝 경계(오른쪽이 공백)면 그 단어를 반환한다', () => {
    expect(wordBoundsAt('foo bar', 3)).toEqual({ start: 0, end: 3 });
  });

  it('두 단어 사이 공백 위면 캐럿 왼쪽 단어를 반환한다', () => {
    expect(wordBoundsAt('foo   bar', 5)).toEqual({ start: 0, end: 3 });
  });

  it('선행 공백 위(왼쪽에 단어 없음)면 오른쪽 단어를 반환한다', () => {
    expect(wordBoundsAt('   foo', 1)).toEqual({ start: 3, end: 6 });
  });

  it('전부 공백인 줄이면 빈 범위(start === end)를 반환한다', () => {
    expect(wordBoundsAt('    ', 2)).toEqual({ start: 2, end: 2 });
  });

  it('빈 문자열이면 빈 범위를 반환한다', () => {
    expect(wordBoundsAt('', 0)).toEqual({ start: 0, end: 0 });
  });

  it('column을 [0, length]로 clamp한다', () => {
    expect(wordBoundsAt('foo', 999)).toEqual({ start: 0, end: 3 });
    expect(wordBoundsAt('foo', -5)).toEqual({ start: 0, end: 3 });
  });

  it('한글/혼합 텍스트에서도 \\S 런 단위로 잡는다', () => {
    expect(wordBoundsAt('안녕하세요 세계', 2)).toEqual({ start: 0, end: 5 });
    expect(wordBoundsAt('한글 English 혼합', 7)).toEqual({ start: 3, end: 10 });
  });
});

describe('editorRange — paragraphBoundsAt', () => {
  it('단일 문단이면 전체 줄 범위를 반환한다', () => {
    expect(paragraphBoundsAt(['a', 'b', 'c'], 1)).toEqual({ startLine: 0, endLine: 2 });
  });

  it('빈 줄로 나뉜 2문단에서 지정한 줄의 문단만 반환한다', () => {
    const arr = ['a', 'b', '', 'c', 'd'];
    expect(paragraphBoundsAt(arr, 0)).toEqual({ startLine: 0, endLine: 1 });
    expect(paragraphBoundsAt(arr, 3)).toEqual({ startLine: 3, endLine: 4 });
  });

  it('빈 줄을 지정하면 그 빈 줄 하나만 반환한다', () => {
    expect(paragraphBoundsAt(['a', 'b', '', 'c'], 2)).toEqual({ startLine: 2, endLine: 2 });
  });

  it('연속 빈 줄은 각각 자기 자신만 반환한다', () => {
    const arr = ['a', '', '', 'b'];
    expect(paragraphBoundsAt(arr, 1)).toEqual({ startLine: 1, endLine: 1 });
    expect(paragraphBoundsAt(arr, 2)).toEqual({ startLine: 2, endLine: 2 });
  });

  it('공백만 있는 줄은 비-빈 줄로 취급한다 (editorStats.paragraphIndex와 동일 정의)', () => {
    expect(paragraphBoundsAt(['a', ' ', 'b'], 0)).toEqual({ startLine: 0, endLine: 2 });
  });

  it('lineIndex가 범위 밖이면 clamp한다', () => {
    const arr = ['a', 'b', '', 'c'];
    expect(paragraphBoundsAt(arr, -5)).toEqual({ startLine: 0, endLine: 1 });
    expect(paragraphBoundsAt(arr, 999)).toEqual({ startLine: 3, endLine: 3 });
  });

  it('한글 문단에서도 동일하게 동작한다', () => {
    const arr = ['제목입니다', '부제목', '', '본문 내용입니다'];
    expect(paragraphBoundsAt(arr, 1)).toEqual({ startLine: 0, endLine: 1 });
    expect(paragraphBoundsAt(arr, 3)).toEqual({ startLine: 3, endLine: 3 });
  });

  it('입력 배열을 변형하지 않는다', () => {
    const arr = ['a', '', 'b'];
    paragraphBoundsAt(arr, 2);
    expect(arr).toEqual(['a', '', 'b']);
  });
});
