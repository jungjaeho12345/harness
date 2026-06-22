// 초안 자동저장 저장소 — 편집 중 내용을 key별로 localStorage에 초안으로 보존한다(news.md "# 에디터 환경설정 > 자동저장", "파일 > 복구").
// editorPrefs/columnConfig와 동일한 graceful localStorage 패턴(접근 불가/throw 시 기본/no-op). 클라이언트 전용 — 서버 무관.
// 시간은 인자(nowMs)로 받는다 — 모듈 내부에서 Date.now()를 부르지 않는다(테스트 결정성·순수성). 호출자(Step 1)가 넘긴다.
// key는 불투명 문자열(호출자가 articleId 또는 탭 식별자로 정함), data는 직렬화 가능한 객체(구조는 호출자 책임).
// 타이머 스냅샷·복구 결선은 Step 1.

const STORAGE_KEY = 'yh.editorDrafts'; // { [key]: { data, savedAt(ms) } }

function readAll() {
  try {
    const parsed = JSON.parse(globalThis.localStorage?.getItem(STORAGE_KEY));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function writeAll(all) {
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(all));
  } catch {
    // localStorage 불가 — 이번 세션은 저장 없이 진행(no-op).
  }
}

// key별 초안 저장({ data, savedAt:nowMs }). 같은 key면 덮어쓴다.
export function saveDraft(key, data, nowMs) {
  const all = readAll();
  all[key] = { data, savedAt: nowMs };
  writeAll(all);
}

// key의 초안 data 반환(없으면 null).
export function loadDraft(key) {
  const entry = readAll()[key];
  return entry && typeof entry === 'object' && 'data' in entry ? entry.data : null;
}

// key 초안 삭제(다른 key는 보존). 이 키(yh.editorDrafts)에 한정.
export function clearDraft(key) {
  const all = readAll();
  if (key in all) {
    delete all[key];
    writeAll(all);
  }
}

// savedAt이 retentionDays(일)보다 오래된 항목 제거 후 저장(savedAt < nowMs - retentionDays*86400000).
export function expireDrafts(retentionDays, nowMs) {
  const all = readAll();
  const cutoff = nowMs - retentionDays * 86400000;
  let changed = false;
  for (const key of Object.keys(all)) {
    const entry = all[key];
    if (entry && typeof entry === 'object' && entry.savedAt < cutoff) {
      delete all[key];
      changed = true;
    }
  }
  if (changed) writeAll(all);
}
