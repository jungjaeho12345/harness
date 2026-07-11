// 에디터 맞춤법 검사 순수 계산 엔진 — 본문 텍스트를 규칙 기반으로 스캔해 오류 후보를 탐지한다.
// 좌표는 blocksToText(blocks)(텍스트 블록만 개행으로 이은 평문)의 절대 오프셋 기준이다.
// 순수·결정적 함수, DOM/transport/Date/랜덤 비의존. 탐지(오프셋+제안)만 하고 본문은 절대 수정하지 않는다
// (자동 일괄교체 금지 — 교정 반영은 Step 1/2의 "제안 표시"까지). editorFind.js 패턴을 따른다.

import { lines, lineAtOffset } from './editorCaret.js';

// 규칙군 키(안정 상수). 그룹별 스캔·정렬 tie-break가 이 순서를 따른다.
export const RULE_GROUPS = Object.freeze(['misuse', 'dupWord', 'punctuation', 'loanword', 'spacing', 'misc']);

// errorTypes(store 6키 bool) → 규칙군 키. Step 2가 참조하는 계약 — freeze.
export const ERROR_TYPE_RULE_GROUP = Object.freeze({
  misuse: 'misuse', // 오용어
  multiWord: 'dupWord', // 다수어절
  semantic: 'punctuation', // 의미문체
  circular: 'loanword', // 순환용어
  statSpacing: 'spacing', // 통계붙여쓰기
  others: 'misc', // 그외
});

// checkOption(store 단일 enum) → 강제 포함 규칙군 키(또는 null). Step 2가 참조하는 계약 — freeze.
export const CHECK_OPTION_RULE_GROUP = Object.freeze({
  procedure: null, // 절차오류
  spacing: 'spacing', // 띄어쓰기
  joining: 'spacing', // 붙여쓰기
  spacingJoining: 'spacing', // 띄어쓰기+붙여쓰기
  circularLoan: 'loanword', // 순환용어·외래어
});

// 사전 규칙 항목 — { bad, good }. 대표 오탈자/외래어 표기(소규모 MVP 사전, 결정적 리터럴 매치).
const MISUSE_DICT = Object.freeze([
  { bad: '됫다', good: '됐다' },
  { bad: '왠만', good: '웬만' },
  { bad: '역활', good: '역할' },
  { bad: '금새', good: '금세' },
  { bad: '어떻해', good: '어떡해' },
]);

const LOANWORD_DICT = Object.freeze([
  { bad: '메세지', good: '메시지' },
  { bad: '쥬스', good: '주스' },
  { bad: '악세사리', good: '액세서리' },
  { bad: '컨텐츠', good: '콘텐츠' },
  { bad: '리더쉽', good: '리더십' },
]);

// spellcheck prefs({checkOption, errorTypes}) → 활성 규칙군 키 배열(RULE_GROUPS 순서, 중복 제거).
// errorTypes에서 true인 키의 규칙군 + checkOption의 강제 포함 규칙군을 합집합.
// 합집합이 비면(모든 errorTypes false + checkOption procedure) RULE_GROUPS 전체로 폴백한다
// — "아무것도 안 걸림"으로 보이는 조합을 막는 사용가능 기본값.
export function activeRuleGroups(spellcheckPrefs) {
  const prefs = spellcheckPrefs || {};
  const errorTypes = prefs.errorTypes || {};
  const selected = new Set();
  for (const key of Object.keys(ERROR_TYPE_RULE_GROUP)) {
    if (errorTypes[key]) selected.add(ERROR_TYPE_RULE_GROUP[key]);
  }
  const forced = CHECK_OPTION_RULE_GROUP[prefs.checkOption] || null;
  if (forced) selected.add(forced);
  if (selected.size === 0) return RULE_GROUPS.slice();
  return RULE_GROUPS.filter((g) => selected.has(g));
}

// 검사 범위 슬라이스. scope ∈ 'all' | 'paragraph' | 'toCaret' | 'fromCaret' (알 수 없는 scope는 all).
// paragraph는 caretOffset이 속한, 빈 줄로 구분된 연속 비어있지 않은 줄 그룹(캐럿 줄이 빈 줄이면 그 빈 줄 하나).
// caretOffset은 Number 강제 + [0, text.length] clamp.
export function spellRange(text, scope, caretOffset) {
  const s = String(text ?? '');
  const clamped = Math.max(0, Math.min(Number(caretOffset) || 0, s.length));
  if (scope === 'toCaret') return { start: 0, end: clamped };
  if (scope === 'fromCaret') return { start: clamped, end: s.length };
  if (scope === 'paragraph') {
    const arr = lines(s);
    const { lineIndex } = lineAtOffset(s, clamped);
    // 각 줄의 시작 오프셋(줄 길이 + 개행 1 누적).
    const starts = [];
    let acc = 0;
    for (const line of arr) {
      starts.push(acc);
      acc += line.length + 1;
    }
    if (arr[lineIndex] === '') return { start: starts[lineIndex], end: starts[lineIndex] };
    let first = lineIndex;
    while (first > 0 && arr[first - 1] !== '') first -= 1;
    let last = lineIndex;
    while (last < arr.length - 1 && arr[last + 1] !== '') last += 1;
    return { start: starts[first], end: starts[last] + arr[last].length };
  }
  return { start: 0, end: s.length }; // 'all'
}

function issue(start, end, group, message, suggestion = null) {
  return { start, end, group, message, suggestion };
}

// needle의 비중첩 리터럴 매치 스팬 — 매치 끝 다음부터 재탐색(editorFind.findMatches 방식).
function scanLiteral(text, needle) {
  const spans = [];
  let from = 0;
  while (from <= text.length) {
    const idx = text.indexOf(needle, from);
    if (idx === -1) break;
    spans.push({ start: idx, end: idx + needle.length });
    from = idx + needle.length;
  }
  return spans;
}

function scanDict(text, dict, group, message) {
  const issues = [];
  for (const { bad, good } of dict) {
    for (const span of scanLiteral(text, bad)) {
      issues.push(issue(span.start, span.end, group, message, good));
    }
  }
  return issues;
}

// dupWord — 같은 줄에서 공백만으로 이어진 동일 어절 반복. 이슈는 반복된(두 번째) 어절을 가리킨다.
// 지적한 어절은 다음 비교의 기준으로 쓰지 않는다(비중첩 — 'a a a'는 1건).
function scanDupWord(text) {
  const issues = [];
  const tokenRe = /\S+/g;
  let prev = null; // { word, end }
  let m;
  while ((m = tokenRe.exec(text)) !== null) {
    const word = m[0];
    if (prev !== null && word === prev.word && !text.slice(prev.end, m.index).includes('\n')) {
      issues.push(issue(m.index, m.index + word.length, 'dupWord', '중복된 어절'));
      prev = null;
      continue;
    }
    prev = { word, end: m.index + word.length };
  }
  return issues;
}

// punctuation — 문장부호 문체.
// (a) 마침표/쉼표 뒤 공백 누락: 뒤가 공백(NBSP 포함)/개행/끝/닫는 부호가 아니면 이슈.
//     숫자 사이의 . , (소수점·천단위)와 라틴 문자·숫자 사이의 . (이메일/URL 도메인 — 기사 관행 표기)는 제외한다.
// (b) !·? 3연속 이상: 연속 구간 전체를 이슈로, 첫 부호 하나로 정규화 제안.
// 닫는 부호에는 워드프로세서 자동 변환 타이포그래픽 인용부호(U+201D/U+2019)를 포함한다.
const PUNCT_CLOSERS = new Set(['.', ',', '!', '?', '…', ')', ']', '}', '』', '」', '》', '"', "'", '”', '’']);

// 라틴 문자/숫자 — 이메일·URL·파일명 등 단어 내부 '.' 판정용.
function isLatinAlnum(ch) {
  return ch !== undefined
    && ((ch >= '0' && ch <= '9') || (ch >= 'A' && ch <= 'Z') || (ch >= 'a' && ch <= 'z'));
}

function scanPunctuation(text) {
  const issues = [];
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch !== '.' && ch !== ',') continue;
    const next = text[i + 1];
    if (next === undefined || next === ' ' || next === '\n' || next === '\t' || next === ' ') continue;
    if (PUNCT_CLOSERS.has(next)) continue;
    const prev = text[i - 1];
    if (prev >= '0' && prev <= '9' && next >= '0' && next <= '9') continue;
    if (ch === '.' && isLatinAlnum(prev) && isLatinAlnum(next)) continue;
    issues.push(issue(i, i + 1, 'punctuation', '문장부호 뒤 공백 누락', `${ch} `));
  }
  const runRe = /[!?]{3,}/g;
  let m;
  while ((m = runRe.exec(text)) !== null) {
    issues.push(issue(m.index, m.index + m[0].length, 'punctuation', '문장부호 연속 사용', m[0][0]));
  }
  return issues;
}

// spacing — 공백 오류. (a) 스페이스 2칸 이상 연속, (b) 문장부호 앞 공백(스팬은 공백+부호, 제안은 부호만).
function scanSpacing(text) {
  const issues = [];
  const dupRe = / {2,}/g;
  let m;
  while ((m = dupRe.exec(text)) !== null) {
    issues.push(issue(m.index, m.index + m[0].length, 'spacing', '중복 공백', ' '));
  }
  const beforeRe = / +([.,!?])/g;
  while ((m = beforeRe.exec(text)) !== null) {
    issues.push(issue(m.index, m.index + m[0].length, 'spacing', '문장부호 앞 공백', m[1]));
  }
  return issues;
}

// misc — 그외. (a) 줄 끝 공백(제거 제안 = 빈 문자열), (b) 탭 문자(스페이스 1칸 제안).
function scanMisc(text) {
  const issues = [];
  const trailRe = /[ \t]+$/gm;
  let m;
  while ((m = trailRe.exec(text)) !== null) {
    issues.push(issue(m.index, m.index + m[0].length, 'misc', '줄 끝 공백', ''));
  }
  const tabRe = /\t+/g;
  while ((m = tabRe.exec(text)) !== null) {
    issues.push(issue(m.index, m.index + m[0].length, 'misc', '탭 문자', ' '));
  }
  return issues;
}

// 규칙군 키 → 스캔 함수. 한 규칙(사전 항목·정규식) 안의 매치는 비중첩 순차 스캔이며,
// 서로 다른 규칙끼리는 겹칠 수 있다(중복 제거는 같은 {start,end,group}만).
const RULES = Object.freeze({
  misuse: (t) => scanDict(t, MISUSE_DICT, 'misuse', '오탈자 의심'),
  dupWord: scanDupWord,
  punctuation: scanPunctuation,
  loanword: (t) => scanDict(t, LOANWORD_DICT, 'loanword', '외래어 표기 오류'),
  spacing: scanSpacing,
  misc: scanMisc,
});

// 핵심 스캔. groups=활성 규칙군 키 배열(기본 전체). range={start,end}가 있으면 그 구간과
// 겹치는 이슈만 남긴다 — 남는 이슈의 start/end는 원본 text 기준 절대 오프셋 그대로다
// (Step 2가 이 오프셋으로 캐럿을 이동한다). 반환: [{ start, end, group, message, suggestion }]
// start 오름차순(동률은 end → RULE_GROUPS 순). 본문을 반환/수정하지 않는다 — 이슈 목록만.
export function checkSpelling(text, { groups = RULE_GROUPS, range } = {}) {
  const s = String(text ?? '');
  if (s === '') return [];
  const active = Array.isArray(groups) ? groups : RULE_GROUPS;
  let issues = [];
  for (const group of RULE_GROUPS) {
    if (!active.includes(group)) continue;
    issues = issues.concat(RULES[group](s));
  }
  if (range && Number.isFinite(range.start) && Number.isFinite(range.end)) {
    issues = issues.filter((i) => i.start < range.end && i.end > range.start);
  }
  issues.sort((a, b) => a.start - b.start || a.end - b.end
    || RULE_GROUPS.indexOf(a.group) - RULE_GROUPS.indexOf(b.group));
  const seen = new Set();
  return issues.filter((i) => {
    const key = `${i.start}:${i.end}:${i.group}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
