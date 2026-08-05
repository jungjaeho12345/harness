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
// 신규 탭은 '<스코프>:<탭id>'. 저장(쓰기)은 언제나 이 키만 쓴다 — 옛 'tab-N' 키로 다시 쓰면 창 간 충돌이 재발한다.
export function draftKeyFor(articleId, tabId) {
  if (typeof articleId === 'string' && articleId !== '') return articleId;
  return `${draftScopeId()}:${tabId}`;
}

// 파일>복구 전용 조회 — 새 키(draftKeyFor)를 먼저 보고, 없으면 '옛 키'를 한 번 더 본다.
// 왜 폴백인가: 스코프 접두사가 도입되기 전(54-5 이전)의 신규 탭 초안은 키가 스코프 없는 'tab-N'이라
// 새 키로만 조회하면 영영 도달하지 못한다(복구가 "없습니다"만 낸다). 초안은 사용자가 아직 저장하지 않은
// 본문이고 파일>저장은 "파일>복구로 되살릴 수 있습니다"를 약속하므로 조용한 유실을 두지 않는다.
// 마이그레이션(옛 키 → 새 키 재기록)은 하지 않는다 — 이 함수는 읽기만 하고, 쓰기는 항상 draftKeyFor 키로 한다.
// 기존 기사(articleId)에는 폴백하지 않는다 — 키가 예나 지금이나 같아 필요 없고, 폴백하면 'AKR1' 탭이
// 같은 탭 슬롯의 'tab-N' 초안(다른 문서)을 되살리는 오복구가 된다. 판정은 draftKeyFor 결과로만 한다(규칙 복제 금지).
// 반환 { key, data } — key는 실제로 찾은 키다(호출자가 복구 후 그 키를 clearDraft해 재부활을 막는다). 없으면 null.
export function loadDraftForRecover(articleId, tabId) {
  const key = draftKeyFor(articleId, tabId);
  const data = loadDraft(key);
  if (data) return { key, data };
  if (key === articleId) return null; // 기존 기사 키 = 폴백 없음
  const legacy = loadDraft(tabId);
  return legacy ? { key: tabId, data: legacy } : null;
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
