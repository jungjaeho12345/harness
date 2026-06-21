// 에디터 색상 규칙 (news.md 기사 에디터 / UI_GUIDE).
// 구조: 첫 줄=제목, 2~5줄=부제 — 단 부제 구간(2~5줄)에 빈 줄(개행 2회 이상)이 있으면 2번째 줄부터 본문.
// 색: 제목=파랑 #0a4da6 / 부제=빨강 #c8102e / 본문=검정(잉크 #1a1a1a) / "(끝)"=골드 #d4af37.
// IME 조합 중에는 재색칠하지 않는다. 재색칠은 조합 완료/포커스 이탈/로드 시점에만 적용한다.

import { END_MARKER } from './editorContent.js';

// 기본 색(불변 — 리셋/폴백 기준). Object.freeze라 직접 mutate 불가.
export const COLORS = Object.freeze({
  title: '#0a4da6', // --yh-blue
  subtitle: '#c8102e', // --yh-red
  body: '#1a1a1a', // --yh-ink (검정)
  end: '#d4af37', // --yh-gold "(끝)"
});

// 사용자 설정 대상 텍스트 색 화이트리스트(news.md 색상 = 제목/부제목/본문).
// 바탕색(background)은 텍스트 색이 아니라 WriterPage가 적용(Step 1), "(끝)" 골드(end)는 사용자 설정 대상이 아님.
const TEXT_COLOR_KEYS = ['title', 'subtitle', 'body'];

// 현재 적용 색(module-level 가변 사본, 기본 {...COLORS}). setEditorColors로만 바뀐다.
let activeColors = { ...COLORS };

// 화이트리스트 텍스트 색 키만 현재 적용 색 위에 병합한다. 그 외(background/end/unknown)는 무시.
export function setEditorColors(colors) {
  if (!colors || typeof colors !== 'object') return;
  for (const key of TEXT_COLOR_KEYS) {
    if (typeof colors[key] === 'string') activeColors[key] = colors[key];
  }
}

// 현재 적용 색을 기본 COLORS로 되돌린다.
export function resetEditorColors() {
  activeColors = { ...COLORS };
}

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

// 현재 적용 색에서 role 색을 반환(없으면 body). 시그니처·호출부는 기존과 동일(인자 1개) — Editor.jsx 무변경.
export function colorForRole(role) {
  return activeColors[role] ?? activeColors.body;
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
