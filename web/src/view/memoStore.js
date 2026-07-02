// 전역 메모(스크래치패드) 영속 — client localStorage 전용(서버 무관, 기사와 무관한 단일 전역 메모 1개).
// editorDraft/editorPrefs와 동일한 graceful 패턴(접근 불가/parse 실패 → 안전 폴백). DOM/React 비의존.
// 기사 본문(markupVersion)·탭·articleId와 완전히 독립한 전용 키를 쓴다(기존 설정/초안 오염 방지).

const STORAGE_KEY = 'yh.editorMemo';

// 저장된 메모 문자열 반환. 부재/파싱 실패/비문자열이면 '' 폴백(throw 금지).
export function loadMemo() {
  try {
    const parsed = JSON.parse(globalThis.localStorage?.getItem(STORAGE_KEY));
    return typeof parsed === 'string' ? parsed : '';
  } catch {
    return '';
  }
}

// 메모 문자열 저장(JSON.stringify). 비문자열이면 ''로 취급. localStorage 불가 시 no-op. 반환: 저장한 문자열.
export function saveMemo(text) {
  const value = typeof text === 'string' ? text : '';
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(value));
  } catch {
    // localStorage 불가 — 이번 세션은 저장 없이 진행(no-op).
  }
  return value;
}
