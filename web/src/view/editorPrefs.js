// 에디터 환경설정 영속 모듈 (news.md "# 에디터 환경설정").
// 편집/자동저장/색상/바이라인/날짜형식 등 설정을 세션을 넘어 유지한다 — 클라이언트 localStorage 전용(서버 무관).
// columnConfig.js와 동일 패턴·동일 견고성(localStorage 불가 시 graceful). 색상 기본값은 editorColoring.COLORS와 일치(+background).
// 이 모듈은 store 기반만 — 각 설정의 UI/적용(색상 반영·자동저장 타이머 등)은 후속 phase.

const STORAGE_KEY = 'yh.editorPrefs';

// 줄간격(edit.lineSpacing) base(기본이자 정규화 기준값). CSS line-height 직접값(unitless)이며
// 에디터 줄의 현재 CSS(line-height 1.8)와 일치한다 — 손대지 않은 기본 상태의 시각 회귀를 막는 단일 출처.
const BASE_LINE_HEIGHT = 1.8;

export const DEFAULT_EDITOR_PREFS = Object.freeze({
  colors: { title: '#0a4da6', subtitle: '#c8102e', body: '#1a1a1a', end: '#d4af37', background: '#ffffff' },
  autosave: { enabled: false, intervalSec: 60, retentionDays: 1 },
  byline: {
    email: false, emailValue: '', blog: false, blogValue: '',
  },
  // 편집(edit): columnLimit effect는 step4(래퍼 margin). language 허용 9종 ko/en/ja/zh/es/fr/ar/vi/ru.
  edit: {
    columnLimit: false, dragDrop: true, noCommonAbbr: false, companyCode: 'manual', language: 'ko', lineSpacing: BASE_LINE_HEIGHT, inputMode: 'unicode',
  },
  // 맞춤법(spellcheck): checkOption 단일 enum, errorTypes 다중 bool 6종, errorStyle bold/underline.
  spellcheck: {
    checkOption: 'spacing',
    errorTypes: {
      misuse: false, multiWord: false, semantic: false, circular: false, statSpacing: false, others: false,
    },
    errorStyle: 'bold',
  },
  glyphFavorites: { items: [] }, // 자주쓰는 약물: items string[]
  glyphKeymap: { items: [] }, // 사용자 키보드 약물: items { keys, glyph }[]
  // UI 언어(ko/en): 에디터 크롬 표시 언어. 문서/입력 언어(edit.language 9종)와 별개 카테고리다.
  ui: { language: 'ko' },
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

// autosave 정규화 — 손상된 localStorage 값(0·음수·NaN·문자열)이 WriterPage의 setInterval(fn, intervalSec*1000)
// 타이트 루프나 expireDrafts 즉시 만료를 일으키지 않게, 병합 결과를 안전 타입·범위로 강제한다.
// dateFormat의 typeof 검증과 동형의 부분 검증 — 정상값은 그대로 통과(사용자 설정 불훼손), 저장 데이터는 건드리지 않는다(읽기 시 정규화만).
function normalizeAutosave(savedAutosave) {
  const merged = { ...DEFAULT_EDITOR_PREFS.autosave, ...(savedAutosave || {}) };
  const finitePositive = (n, fallback) => (Number.isFinite(n) && n > 0 ? n : fallback);
  return {
    ...merged,
    enabled: merged.enabled === true,
    intervalSec: finitePositive(merged.intervalSec, DEFAULT_EDITOR_PREFS.autosave.intervalSec),
    retentionDays: finitePositive(merged.retentionDays, DEFAULT_EDITOR_PREFS.autosave.retentionDays),
  };
}

// 저장값을 기본값 위에 "한 단계 깊이" 병합해 반환(부분 저장도 안전, 새로 추가된 키도 기본값 노출).
export function loadEditorPrefs() {
  const saved = readAll();
  return {
    colors: { ...DEFAULT_EDITOR_PREFS.colors, ...(saved.colors || {}) },
    autosave: normalizeAutosave(saved.autosave),
    byline: { ...DEFAULT_EDITOR_PREFS.byline, ...(saved.byline || {}) },
    edit: { ...DEFAULT_EDITOR_PREFS.edit, ...(saved.edit || {}) },
    spellcheck: { ...DEFAULT_EDITOR_PREFS.spellcheck, ...(saved.spellcheck || {}) },
    glyphFavorites: { ...DEFAULT_EDITOR_PREFS.glyphFavorites, ...(saved.glyphFavorites || {}) },
    glyphKeymap: { ...DEFAULT_EDITOR_PREFS.glyphKeymap, ...(saved.glyphKeymap || {}) },
    ui: { ...DEFAULT_EDITOR_PREFS.ui, ...(saved.ui || {}) },
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

// 저장된 줄간격을 실제 CSS line-height(unitless number)로 정규화한다.
// 레거시 기본 sentinel(1.0)과 무효값(비유한·≤1.0)은 base(1.8)로, 유효 선택값(1.2/1.5/1.8/2.0)은 Number로 통과.
// dialog select의 onChange가 문자열('1.5')을 저장하므로 문자열 입력도 Number()로 받아 처리한다.
// 정규화는 소비 시점(WriterPage·dialog 표시)에서만 — loadEditorPrefs 병합은 raw를 유지한다.
export function normalizeLineSpacing(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 1.0) return BASE_LINE_HEIGHT;
  return n;
}

// 순수: 해당 category 객체를 patch로 얕은 병합한 새 prefs 반환(입력 mutate 금지). 알 수 없는 category면 그대로 반환.
export function setEditorPref(prefs, category, patch) {
  const current = prefs[category];
  if (!current || typeof current !== 'object') return prefs;
  return { ...prefs, [category]: { ...current, ...patch } };
}
