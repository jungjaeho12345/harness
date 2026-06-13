// 기사 목록(list.do) 컬럼 표시/숨김 + 컬럼 간격 설정 — 메뉴별로 저장 (news.md 기사 조회페이지).
// 4개 메뉴 공통 컬럼: 기사아이디·제목·작성자·수정자·작성시간·수정시간·기사상태·LockYN.
// 설정은 메뉴별로 지속(localStorage) — UI 환경설정이므로 세션을 넘어 유지한다.

export const COLUMNS = Object.freeze([
  { key: 'articleId', label: '기사아이디' },
  { key: 'title', label: '제목' },
  { key: 'author', label: '작성자' },
  { key: 'modifier', label: '수정자' },
  { key: 'createdAt', label: '작성시간' },
  { key: 'editedAt', label: '수정시간' },
  { key: 'status', label: '기사상태' },
  { key: 'lockYN', label: 'LockYN' },
]);

export const DEFAULT_GAP = 8; // px

const STORAGE_KEY = 'yh.columnConfig';

export function defaultColumnConfig() {
  const visible = {};
  for (const c of COLUMNS) visible[c.key] = true;
  return { visible, gap: DEFAULT_GAP };
}

function readAll() {
  try {
    const parsed = JSON.parse(globalThis.localStorage?.getItem(STORAGE_KEY));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

// 메뉴별 컬럼 설정 로드(없으면 기본값). 저장된 visible은 기본값 위에 병합해 새 컬럼도 보이게 한다.
export function loadColumnConfig(menu) {
  const base = defaultColumnConfig();
  const saved = readAll()[menu];
  if (!saved || typeof saved !== 'object') return base;
  return {
    visible: { ...base.visible, ...(saved.visible || {}) },
    gap: Number.isFinite(saved.gap) ? saved.gap : base.gap,
  };
}

export function saveColumnConfig(menu, config) {
  const all = readAll();
  all[menu] = { visible: { ...config.visible }, gap: config.gap };
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(all));
  } catch {
    // localStorage 불가 — 이번 세션은 저장 없이 진행.
  }
  return config;
}

export function toggleColumn(config, key) {
  return { ...config, visible: { ...config.visible, [key]: !config.visible[key] } };
}

export function setGap(config, gap) {
  return { ...config, gap: Math.max(0, Number(gap) || 0) };
}

// 현재 설정에서 표시할 컬럼 목록(정의 순서 유지).
export function visibleColumns(config) {
  return COLUMNS.filter((c) => config.visible[c.key]);
}
