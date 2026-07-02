// 메모장 영속 모듈 (에디터 도구 '메모장' — news.md 도구 메뉴 L182·툴바 L157).
// 본문(blocks/serialize)을 건드리지 않는 client 스크래치패드 텍스트를 세션을 넘어 유지한다.
// editorDraft/editorPrefs와 동일한 graceful localStorage 패턴(접근 불가/throw 시 기본/no-op). 클라이언트 전용 — 서버 무관.
// editorPrefs가 아닌 전용 키(yh.editorMemo)로 분리한다 — 메모는 매 타이핑마다 바뀌는 자유 텍스트라
//   환경설정 적용/취소 게이트(onPrefsClose)와 결합하거나 매 키 입력마다 prefs 전체를 재직렬화하면 안 된다.
// 저장 형식은 { text } JSON — loadMemo/saveMemo가 왕복 일관성을 갖는다.

const STORAGE_KEY = 'yh.editorMemo';

// 저장된 메모 텍스트를 반환. 없거나 파싱 불가면 ''.
export function loadMemo() {
  try {
    const parsed = JSON.parse(globalThis.localStorage?.getItem(STORAGE_KEY));
    return parsed && typeof parsed === 'object' && typeof parsed.text === 'string' ? parsed.text : '';
  } catch {
    return '';
  }
}

// 메모 텍스트를 저장하고 그 text를 반환. localStorage 불가 시 graceful no-op(throw 없음).
export function saveMemo(text) {
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify({ text }));
  } catch {
    // localStorage 불가 — 이번 세션은 저장 없이 진행(no-op).
  }
  return text;
}
