// 에디터 색상 규칙 (news.md 기사 에디터 / UI_GUIDE).
// 구조: 첫 줄=제목, 2~5줄=부제 — 단 부제 구간(2~5줄)에 빈 줄(개행 2회 이상)이 있으면 2번째 줄부터 본문.
// 색: 제목=파랑 #0a4da6 / 부제=빨강 #c8102e / 본문=검정(잉크 #1a1a1a) / "(끝)"=골드 #d4af37.
// IME 조합 중에는 재색칠하지 않는다. 재색칠은 조합 완료/포커스 이탈/로드 시점에만 적용한다.

import { END_MARKER } from './editorContent.js';

export const COLORS = Object.freeze({
  title: '#0a4da6', // --yh-blue
  subtitle: '#c8102e', // --yh-red
  body: '#1a1a1a', // --yh-ink (검정)
  end: '#d4af37', // --yh-gold "(끝)"
});

export const ROLES = Object.freeze(['title', 'subtitle', 'body', 'end']);

function isEndLine(line) {
  return String(line).trim() === END_MARKER;
}

// 라인 배열 → 라인별 역할('title'|'subtitle'|'body'|'end').
export function classifyLines(lines) {
  const arr = Array.isArray(lines) ? lines : [];
  // 부제 구간(인덱스 1~4)에 빈 줄이 있으면(개행 2회 이상) 부제 없이 2번째 줄부터 본문.
  const blankInSubtitle = arr.slice(1, 5).some((l) => l === '');
  return arr.map((line, i) => {
    if (isEndLine(line)) return 'end';
    if (i === 0) return 'title';
    if (blankInSubtitle) return 'body';
    return i <= 4 ? 'subtitle' : 'body';
  });
}

export function colorForRole(role) {
  return COLORS[role] ?? COLORS.body;
}

// 본문 텍스트 → 라인별 {text, role, color}. 컴포넌트가 라인 span 색을 칠하는 데 쓴다.
export function colorLines(text) {
  const lines = String(text ?? '').split('\n');
  const roles = classifyLines(lines);
  return lines.map((line, i) => ({ text: line, role: roles[i], color: colorForRole(roles[i]) }));
}

// 재색칠 시점 — IME 조합 중에는 금지(news.md). 조합 완료/포커스 이탈/로드 시에만 true.
export const RECOLOR_TRIGGERS = Object.freeze(['compositionend', 'blur', 'load']);

export function shouldRecolor(trigger, { composing = false } = {}) {
  if (composing) return false;
  return RECOLOR_TRIGGERS.includes(trigger);
}
