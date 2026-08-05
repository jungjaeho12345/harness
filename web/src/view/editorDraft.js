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

// 브라우저 탭 스코프 id — sessionStorage에 1회 만들어 보관한다(창/탭마다 다르고 F5에는 유지된다).
// 왜 필요한가: 초안 저장소(localStorage)는 같은 출처의 모든 창이 공유하므로 신규 탭 키(tab-1…)가 창 사이에서
// 충돌한다(서로 덮어쓰기·다른 문서 오복구·남의 초안 삭제). 스코프는 절대 localStorage에 두지 않는다(다시 공유돼 무의미).
const SCOPE_KEY = 'yh.draftScope';
let scopeSeq = 0;
let memoScope = null; // sessionStorage 불가 시 폴백 — 이 페이지 로드 동안만 안정(F5 후 그 초안은 복구되지 않을 수 있다).

// 스코프 id 생성 — useWriteController.newClientId 관례(crypto.randomUUID 우선, 없으면 시간+카운터).
// 여기의 Date.now()는 id 생성 전용이다 — savedAt 등 저장 데이터의 시각은 여전히 호출자가 주입한다.
function newScopeId() {
  try {
    const uuid = globalThis.crypto?.randomUUID?.();
    if (uuid) return `w-${uuid}`;
  } catch { /* crypto 불가 — 폴백 */ }
  scopeSeq += 1;
  return `w-${Date.now().toString(36)}-${scopeSeq}`;
}

export function draftScopeId() {
  try {
    const store = globalThis.sessionStorage;
    if (store) {
      const saved = store.getItem(SCOPE_KEY);
      if (saved) return saved;
      const next = newScopeId();
      store.setItem(SCOPE_KEY, next);
      return next;
    }
  } catch { /* sessionStorage 접근 불가/throw — 아래 메모리 폴백(readAll/writeAll과 같은 graceful 규율) */ }
  if (!memoScope) memoScope = newScopeId();
  return memoScope;
}

// 초안 키 단일 출처 — 기존 기사는 articleId 그대로(전역 고유라 창을 옮겨도 같은 초안을 찾는다),
// 신규 탭은 '<스코프>:<탭id>'. 옛 'tab-N' 초안은 마이그레이션하지 않는다(expireDrafts가 자연 정리).
export function draftKeyFor(articleId, tabId) {
  if (typeof articleId === 'string' && articleId !== '') return articleId;
  return `${draftScopeId()}:${tabId}`;
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
