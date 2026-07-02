// 사용자 등록 약어(짧은형→확장형) 영속 — client localStorage 전용(서버 무관). editorDraft/editorPrefs/memoStore와 동일한
// graceful 패턴(접근 불가/parse 실패/형식오류 → 빈 목록/no-op). DOM/React 비의존. 기사 본문(markupVersion)과 무관하다.
// memoStore는 단일 문자열이지만 abbrevStore는 { short, long }[] 배열 + normalize가 추가된다.
// 기존 설정/초안/메모와 겹치지 않는 전용 키를 쓴다(DB 비파괴 정신을 클라이언트 저장소에도 적용).

const STORAGE_KEY = 'yh.editorAbbrevs';

// 목록을 { short, long }[] 로 정규화(순수). 비배열 → []. 각 항목: short/long을 String 트림해 둘 다 비지 않을 때만 채택.
// 빈 short/빈 long(트림 후 '')·비객체·누락은 버린다(빈 확장형은 무의미·오삭제 위험). 입력 배열/원소를 mutate 하지 않는다.
export function normalizeAbbrevs(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const short = String(item.short ?? '').trim();
    const long = String(item.long ?? '').trim();
    if (short !== '' && long !== '') out.push({ short, long });
  }
  return out;
}

// 저장된 약어 목록을 { short, long }[] 로 반환. 부재/파싱 실패/형식오류 → []. throw 금지.
export function loadAbbrevs() {
  try {
    return normalizeAbbrevs(JSON.parse(globalThis.localStorage?.getItem(STORAGE_KEY)));
  } catch {
    return [];
  }
}

// 목록을 normalize 후 JSON.stringify 해 저장. localStorage 불가 시 no-op(throw 금지). 반환: 저장한 정규화 목록.
export function saveAbbrevs(list) {
  const normalized = normalizeAbbrevs(list);
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(normalized));
  } catch {
    // localStorage 불가 — 이번 세션은 저장 없이 진행(no-op).
  }
  return normalized;
}
