import { describe, it, expect } from 'vitest';
import {
  RULE_GROUPS, ERROR_TYPE_RULE_GROUP, CHECK_OPTION_RULE_GROUP,
  activeRuleGroups, spellRange, checkSpelling,
} from './editorSpell.js';

describe('editorSpell — 매핑 상수', () => {
  it('RULE_GROUPS는 규칙군 6개의 안정 상수다', () => {
    expect(RULE_GROUPS).toEqual(['misuse', 'dupWord', 'punctuation', 'loanword', 'spacing', 'misc']);
  });

  it('ERROR_TYPE_RULE_GROUP은 store 6키를 규칙군에 매핑하고 frozen이다', () => {
    expect(ERROR_TYPE_RULE_GROUP).toEqual({
      misuse: 'misuse',
      multiWord: 'dupWord',
      semantic: 'punctuation',
      circular: 'loanword',
      statSpacing: 'spacing',
      others: 'misc',
    });
    expect(Object.isFrozen(ERROR_TYPE_RULE_GROUP)).toBe(true);
  });

  it('CHECK_OPTION_RULE_GROUP은 enum 5종을 강제 포함 규칙군에 매핑하고 frozen이다', () => {
    expect(CHECK_OPTION_RULE_GROUP).toEqual({
      procedure: null,
      spacing: 'spacing',
      joining: 'spacing',
      spacingJoining: 'spacing',
      circularLoan: 'loanword',
    });
    expect(Object.isFrozen(CHECK_OPTION_RULE_GROUP)).toBe(true);
  });
});

describe('editorSpell — activeRuleGroups', () => {
  it('errorTypes 전부 false + checkOption procedure → 전체 규칙군 폴백', () => {
    const prefs = {
      checkOption: 'procedure',
      errorTypes: {
        misuse: false, multiWord: false, semantic: false, circular: false, statSpacing: false, others: false,
      },
    };
    expect(activeRuleGroups(prefs)).toEqual(RULE_GROUPS);
  });

  it('errorTypes {misuse:true} + checkOption procedure → [misuse]', () => {
    const prefs = { checkOption: 'procedure', errorTypes: { misuse: true } };
    expect(activeRuleGroups(prefs)).toEqual(['misuse']);
  });

  it('checkOption spacing은 spacing 규칙군을 강제 포함한다(합집합·중복 없음)', () => {
    // statSpacing:true도 spacing 규칙군 — 강제 포함과 합쳐도 1개만 남아야 한다.
    const dup = activeRuleGroups({ checkOption: 'spacing', errorTypes: { statSpacing: true } });
    expect(dup).toEqual(['spacing']);
    // 다른 errorTypes와의 합집합.
    const union = activeRuleGroups({ checkOption: 'spacing', errorTypes: { misuse: true } });
    expect(union).toEqual(['misuse', 'spacing']);
  });

  it('joining/spacingJoining도 spacing을, circularLoan은 loanword를 강제 포함한다', () => {
    expect(activeRuleGroups({ checkOption: 'joining', errorTypes: {} })).toEqual(['spacing']);
    expect(activeRuleGroups({ checkOption: 'spacingJoining', errorTypes: {} })).toEqual(['spacing']);
    expect(activeRuleGroups({ checkOption: 'circularLoan', errorTypes: {} })).toEqual(['loanword']);
  });

  it('prefs가 비거나 없어도 안전하게 폴백한다', () => {
    expect(activeRuleGroups(undefined)).toEqual(RULE_GROUPS);
    expect(activeRuleGroups({})).toEqual(RULE_GROUPS);
  });
});

describe('editorSpell — spellRange', () => {
  // '가나\n다라\n\n마바' — 줄 시작 오프셋: 가나=0, 다라=3, (빈 줄)=6, 마바=7. 길이 9.
  const text = '가나\n다라\n\n마바';

  it('all은 전체 범위다', () => {
    expect(spellRange(text, 'all', 4)).toEqual({ start: 0, end: text.length });
  });

  it('toCaret/fromCaret은 캐럿 기준 경계다', () => {
    expect(spellRange(text, 'toCaret', 4)).toEqual({ start: 0, end: 4 });
    expect(spellRange(text, 'fromCaret', 4)).toEqual({ start: 4, end: text.length });
  });

  it('caretOffset 음수/초과는 clamp된다', () => {
    expect(spellRange('abc', 'toCaret', -5)).toEqual({ start: 0, end: 0 });
    expect(spellRange('abc', 'toCaret', 99)).toEqual({ start: 0, end: 3 });
    expect(spellRange('abc', 'fromCaret', -5)).toEqual({ start: 0, end: 3 });
    expect(spellRange('abc', 'fromCaret', 99)).toEqual({ start: 3, end: 3 });
  });

  it('paragraph는 빈 줄로 구분된 문단 경계다', () => {
    expect(spellRange(text, 'paragraph', 4)).toEqual({ start: 0, end: 5 }); // 가나\n다라
    expect(spellRange(text, 'paragraph', 8)).toEqual({ start: 7, end: 9 }); // 마바
  });

  it('paragraph에서 캐럿 줄이 빈 줄이면 그 빈 줄 하나가 문단이다', () => {
    expect(spellRange(text, 'paragraph', 6)).toEqual({ start: 6, end: 6 });
  });

  it('빈 텍스트도 안전하다', () => {
    expect(spellRange('', 'all', 0)).toEqual({ start: 0, end: 0 });
    expect(spellRange('', 'paragraph', 0)).toEqual({ start: 0, end: 0 });
  });
});

describe('editorSpell — checkSpelling 규칙군별 탐지', () => {
  it('빈 입력은 no-op이다', () => {
    expect(checkSpelling('', {})).toEqual([]);
    expect(checkSpelling(null)).toEqual([]);
    expect(checkSpelling(undefined)).toEqual([]);
  });

  it('dupWord: 연속 중복 어절에서 두 번째 어절을 가리키는 이슈 1개', () => {
    const issues = checkSpelling('먹었다 먹었다', { groups: ['dupWord'] });
    expect(issues).toHaveLength(1);
    expect(issues[0].group).toBe('dupWord');
    expect(issues[0].start).toBe(4); // 두 번째 '먹었다' 시작
    expect(issues[0].end).toBe(7);
    expect(issues[0].message).toBe('중복된 어절');
    expect(issues[0].suggestion).toBe(null);
  });

  it('dupWord: 줄 경계를 넘는 반복은 중복으로 보지 않는다', () => {
    expect(checkSpelling('먹었다\n먹었다', { groups: ['dupWord'] })).toEqual([]);
  });

  it('misuse 사전: 역활 → suggestion 역할', () => {
    const issues = checkSpelling('그건 역활이다', { groups: ['misuse'] });
    expect(issues).toHaveLength(1);
    expect(issues[0]).toEqual({
      start: 3, end: 5, group: 'misuse', message: '오탈자 의심', suggestion: '역할',
    });
  });

  it('loanword 사전: 메세지 → suggestion 메시지', () => {
    const issues = checkSpelling('메세지 도착', { groups: ['loanword'] });
    expect(issues).toHaveLength(1);
    expect(issues[0]).toEqual({
      start: 0, end: 3, group: 'loanword', message: '외래어 표기 오류', suggestion: '메시지',
    });
  });

  it('spacing: 중복 공백(2칸 이상)에서 이슈', () => {
    const issues = checkSpelling('가  나', { groups: ['spacing'] });
    expect(issues).toHaveLength(1);
    expect(issues[0]).toEqual({
      start: 1, end: 3, group: 'spacing', message: '중복 공백', suggestion: ' ',
    });
  });

  it('spacing: 문장부호 앞 공백에서 이슈', () => {
    const issues = checkSpelling('안녕 ,', { groups: ['spacing'] });
    expect(issues).toHaveLength(1);
    expect(issues[0]).toEqual({
      start: 2, end: 4, group: 'spacing', message: '문장부호 앞 공백', suggestion: ',',
    });
  });

  it('punctuation: 문장부호 3연속 이상에서 이슈', () => {
    const issues = checkSpelling('정말!!!', { groups: ['punctuation'] });
    expect(issues).toHaveLength(1);
    expect(issues[0]).toEqual({
      start: 2, end: 5, group: 'punctuation', message: '문장부호 연속 사용', suggestion: '!',
    });
    // 2연속은 이슈가 아니다.
    expect(checkSpelling('뭐라고??', { groups: ['punctuation'] })).toEqual([]);
  });

  it('punctuation: 마침표/쉼표 뒤 공백 누락에서 이슈 (숫자 사이 소수점·천단위는 제외)', () => {
    const issues = checkSpelling('안녕,하세요', { groups: ['punctuation'] });
    expect(issues).toHaveLength(1);
    expect(issues[0]).toEqual({
      start: 2, end: 3, group: 'punctuation', message: '문장부호 뒤 공백 누락', suggestion: ', ',
    });
    expect(checkSpelling('3.5% 상승, 1,000명', { groups: ['punctuation'] })).toEqual([]);
  });

  it('misc: 줄 끝 공백과 탭 문자에서 이슈', () => {
    const trail = checkSpelling('가 \n나', { groups: ['misc'] });
    expect(trail).toHaveLength(1);
    expect(trail[0]).toEqual({
      start: 1, end: 2, group: 'misc', message: '줄 끝 공백', suggestion: '',
    });
    const tab = checkSpelling('가\t나', { groups: ['misc'] });
    expect(tab).toHaveLength(1);
    expect(tab[0]).toEqual({
      start: 1, end: 2, group: 'misc', message: '탭 문자', suggestion: ' ',
    });
  });
});

describe('editorSpell — checkSpelling 계약(정렬·중복 제거·range·불변)', () => {
  it('기본 groups는 전체 규칙군이고 start 오름차순으로 정렬된다', () => {
    // '메세지  왔다' — loanword(0-3) + 중복 공백(3-5).
    const issues = checkSpelling('메세지  왔다');
    expect(issues.map((i) => [i.group, i.start])).toEqual([['loanword', 0], ['spacing', 3]]);
  });

  it('groups로 규칙군을 좁힐 수 있다 (빈 배열이면 이슈 없음)', () => {
    expect(checkSpelling('메세지  왔다', { groups: ['spacing'] }).map((i) => i.group)).toEqual(['spacing']);
    expect(checkSpelling('메세지  왔다', { groups: [] })).toEqual([]);
  });

  it('같은 {start,end,group} 이슈는 1개로 중복 제거된다', () => {
    // '가\t' — 줄 끝 공백 규칙과 탭 문자 규칙이 같은 misc 스팬(1-2)을 낸다 → 1개만.
    const issues = checkSpelling('가\t', { groups: ['misc'] });
    expect(issues).toHaveLength(1);
    expect(issues[0].start).toBe(1);
    expect(issues[0].end).toBe(2);
  });

  it('range 밖 이슈는 제외하되 남은 이슈의 오프셋은 절대값을 유지한다', () => {
    const text = '메세지  왔다';
    const issues = checkSpelling(text, { range: { start: 3, end: 5 } });
    expect(issues).toHaveLength(1);
    expect(issues[0].group).toBe('spacing');
    expect(issues[0].start).toBe(3); // 구간 시작을 빼지 않은 절대 오프셋
    expect(issues[0].end).toBe(5);
    // loanword(0-3)는 range와 겹치지 않아 제외된다(end가 range.start와 맞닿는 것은 겹침 아님).
  });

  it('range가 이슈 중간과 겹치면 포함된다', () => {
    const issues = checkSpelling('메세지 도착', { range: { start: 2, end: 4 } });
    expect(issues.map((i) => i.group)).toEqual(['loanword']);
    expect(issues[0].start).toBe(0);
  });

  it('입력 text를 변형하지 않으며 같은 문자열 재호출 결과가 동일하다(결정적)', () => {
    const text = '왠만하면 메세지를  보내라 보내라!!!';
    const a = checkSpelling(text);
    const b = checkSpelling(text);
    expect(a).toEqual(b);
    expect(text).toBe('왠만하면 메세지를  보내라 보내라!!!');
    // 반환된 이슈에는 치환된 본문이 없다 — 오프셋/메타만.
    for (const issue of a) {
      expect(Object.keys(issue).sort()).toEqual(['end', 'group', 'message', 'start', 'suggestion']);
    }
  });
});
