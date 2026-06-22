// 에디터 환경설정 영속 모듈 (news.md "# 에디터 환경설정").
// 편집/자동저장/색상/바이라인/날짜형식 등 설정을 세션을 넘어 유지한다 — 클라이언트 localStorage 전용(서버 무관).
// columnConfig.js와 동일 패턴·동일 견고성(localStorage 불가 시 graceful). 색상 기본값은 editorColoring.COLORS와 일치(+background).
// 이 모듈은 store 기반만 — 각 설정의 UI/적용(색상 반영·자동저장 타이머 등)은 후속 phase.

const STORAGE_KEY = 'yh.editorPrefs';

export const DEFAULT_EDITOR_PREFS = Object.freeze({
  colors: { title: '#0a4da6', subtitle: '#c8102e', body: '#1a1a1a', end: '#d4af37', background: '#ffffff' },
  autosave: { enabled: false, intervalSec: 60, retentionDays: 1 },
  byline: {
    email: false, emailValue: '', blog: false, blogValue: '',
  },
  dateFormat: 'YYYY-MM-DD HH:mm',
});

function readAll() {
  try {
    const parsed = JSON.parse(globalThis.localStorage?.getItem(STORAGE_KEY));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

// 저장값을 기본값 위에 "한 단계 깊이" 병합해 반환(부분 저장도 안전, 새로 추가된 키도 기본값 노출).
export function loadEditorPrefs() {
  const saved = readAll();
  return {
    colors: { ...DEFAULT_EDITOR_PREFS.colors, ...(saved.colors || {}) },
    autosave: { ...DEFAULT_EDITOR_PREFS.autosave, ...(saved.autosave || {}) },
    byline: { ...DEFAULT_EDITOR_PREFS.byline, ...(saved.byline || {}) },
    dateFormat: typeof saved.dateFormat === 'string' ? saved.dateFormat : DEFAULT_EDITOR_PREFS.dateFormat,
  };
}

export function saveEditorPrefs(prefs) {
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(prefs));
  } catch {
    // localStorage 불가 — 이번 세션은 저장 없이 진행.
  }
  return prefs;
}

// 순수: 해당 category 객체를 patch로 얕은 병합한 새 prefs 반환(입력 mutate 금지). 알 수 없는 category면 그대로 반환.
export function setEditorPref(prefs, category, patch) {
  const current = prefs[category];
  if (!current || typeof current !== 'object') return prefs;
  return { ...prefs, [category]: { ...current, ...patch } };
}
