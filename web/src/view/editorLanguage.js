// 에디터 언어(9종) 표시·소비 측 단일 출처 모델 — 상태표시줄 '언어' 라벨·Editor lang 속성용
// 순수(zero-dep·입력 비파괴). 코드/라벨은 news.md L196(한글/영어/일어/중국어/스페인/프랑스/
// 아랍어/베트남/러시아어)·EditorPrefsDialog EDIT_LANGUAGES(설정 입력 측)와 문자 단위로 동일해야
// 한다. ko 라벨은 '한국어'가 아닌 '한글' — 설정 UI와 표시가 다르면 표기 드리프트가 생긴다.
// editorPrefs.js edit.language 저장 shape(기본 'ko'·허용 9종)은 이 phase에서 불변(레거시 호환).

// 코드→라벨 단일 출처(news.md L196 순서·표기 그대로). 순서 있는 배열로 두어 목록·매핑을 한 곳에서 파생.
export const LANGUAGE_LABELS = Object.freeze([
  Object.freeze({ code: 'ko', label: '한글' }),
  Object.freeze({ code: 'en', label: '영어' }),
  Object.freeze({ code: 'ja', label: '일어' }),
  Object.freeze({ code: 'zh', label: '중국어' }),
  Object.freeze({ code: 'es', label: '스페인' }),
  Object.freeze({ code: 'fr', label: '프랑스' }),
  Object.freeze({ code: 'ar', label: '아랍어' }),
  Object.freeze({ code: 'vi', label: '베트남' }),
  Object.freeze({ code: 'ru', label: '러시아어' }),
]);

// 언어 코드 정규화 — 허용 9종이면 그대로, 그 외(구값·undefined·대문자 등 미지원)는 'ko'.
export function normalizeLanguage(code) {
  return LANGUAGE_LABELS.some((entry) => entry.code === code) ? code : 'ko';
}

// 코드→한국어 라벨. 미지원/undefined 코드는 'ko' 라벨('한글')로 폴백.
export function languageLabel(code) {
  const normalized = normalizeLanguage(code);
  return LANGUAGE_LABELS.find((entry) => entry.code === normalized).label;
}
