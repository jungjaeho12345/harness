# Step 1: language-label-model

환경설정 편집 탭의 **언어(9종)** 설정을 상태표시줄 라벨과 Editor `lang` 속성에 반영하기 위한 **순수 모델**을 만든다. 언어 코드→한국어 라벨 매핑의 **단일 출처 상수**와, 코드 정규화 함수를 만든다. 상태표시줄·Editor 결선은 이후 step(2·3)이다.

## 읽어야 할 파일

먼저 아래 파일들을 읽고 설계 의도를 파악하라:

- `docs/ARCHITECTURE.md`, `docs/ADR.md` — ADR 철학(zero-dep·표준 우선·TDD).
- `docs/news.md` L160(상태표시줄 항목 '언어'), L196(환경설정 편집 탭 언어 9종: 한글/영어/일어/중국어/스페인/프랑스/아랍어/베트남/러시아어), L171(Alt+Y — spellcheck=true·lang. lang 속성이 prefs 언어를 따르되 기본 ko).
- `web/src/view/editorPrefs.js` L18~20 — `edit.language` 기본 `'ko'`, 허용 9종 코드 `ko/en/ja/zh/es/fr/ar/vi/ru`. **이 shape/기본값은 이 phase에서 변경하지 않는다**(레거시 호환).
- `web/src/view/EditorPrefsDialog.jsx` L36~47 — 편집 탭 select의 `EDIT_LANGUAGES`(설정 입력 측 코드→라벨 목록). **이 파일은 이 phase에서 변경하지 않는다**(UI 확인만). 아래 신규 상수의 라벨은 이 목록·news.md L196과 **정확히 동일**해야 한다.

## 배경 (자기완결)

`edit.language`는 phase 16에서 저장만 되어 있고 소비처가 없다. 상태표시줄은 언어를 placeholder `'한국어'`로 고정 표시하고, Editor 편집 div는 `lang="ko"`로 하드코딩돼 있다. 이 phase는 저장된 언어 코드를 (a) 상태표시줄 라벨(예: `'ko' → '한글'`)과 (b) Editor `lang` 속성 코드로 연결한다. 이 step은 그 **표시 측 단일 출처 모델**만 만든다.

`EditorPrefsDialog`의 `EDIT_LANGUAGES`는 **설정 입력 측** 목록이고, 이 신규 모듈은 **표시·소비 측** 단일 출처다. 둘 다 news.md L196의 9종 라벨에 정합해야 하며, 이 step은 다이얼로그를 건드리지 않는다(설정 입력과 표시 소비의 레이어 분리 — 다이얼로그 리팩터는 범위 밖). 라벨은 테스트로 news.md L196에 잠근다.

### 신규 파일: `web/src/view/editorLanguage.js`

zero-dep 순수 모듈. export는 아래 3개다.

```js
// 코드→라벨 단일 출처(news.md L196 순서·표기 그대로). 순서 있는 배열(코드/라벨 쌍)로 두어 목록·매핑을 한 곳에서 파생.
export const LANGUAGE_LABELS // [{ code: 'ko', label: '한글' }, ...] 9종, Object.freeze 권장

// 코드→한국어 라벨. 미지원/undefined 코드는 'ko' 라벨('한글')로 폴백.
export function languageLabel(code) // → string

// 코드 정규화 — 허용 9종이면 그대로, 그 외(구값·undefined·대문자 등 미지원)는 'ko'.
export function normalizeLanguage(code) // → 'ko'|'en'|'ja'|'zh'|'es'|'fr'|'ar'|'vi'|'ru'
```

### `LANGUAGE_LABELS` 값 (못박음 — news.md L196·다이얼로그와 정확히 동일)

| code | label |
|------|-------|
| `ko` | `한글` |
| `en` | `영어` |
| `ja` | `일어` |
| `zh` | `중국어` |
| `es` | `스페인` |
| `fr` | `프랑스` |
| `ar` | `아랍어` |
| `vi` | `베트남` |
| `ru` | `러시아어` |

주의: 상태표시줄의 한국어 라벨은 `'한글'`이다(현행 placeholder `'한국어'`가 아님). 이 라벨 표기를 임의로 바꾸지 마라 — news.md L196·다이얼로그의 단일 표기다.

`languageLabel`/`normalizeLanguage`는 `LANGUAGE_LABELS`에서 파생하라(라벨/코드 목록을 함수 안에 별도 하드코딩해 이중 정의하지 마라 — 단일 출처).

## 작업 (TDD — 실패하는 테스트부터)

1. `web/src/view/editorLanguage.test.js`(vitest)를 먼저 작성한다:
   - `LANGUAGE_LABELS`가 위 9종을 그 순서·표기로 담는다(코드 배열 `['ko','en','ja','zh','es','fr','ar','vi','ru']`·라벨 배열 `['한글','영어','일어','중국어','스페인','프랑스','아랍어','베트남','러시아어']` 단언 — news.md L196 잠금).
   - `languageLabel('ko')` → `'한글'`, `languageLabel('en')` → `'영어'`, `languageLabel('ru')` → `'러시아어'`.
   - `languageLabel('xx')`/`languageLabel(undefined)` → `'한글'`(폴백).
   - `normalizeLanguage('ja')` → `'ja'`; `normalizeLanguage('xx')`/`normalizeLanguage(undefined)`/`normalizeLanguage('KO')` → `'ko'`.
2. `web/src/view/editorLanguage.js`를 구현해 통과시킨다. 순수(입력 비파괴)·zero-dep(다른 모듈 import 금지).

## Acceptance Criteria

```bash
npm run lint
npm run build
npm run test:web
```

(client 전용 — 백엔드 `npm test`는 실행 불필요.)

## 검증 절차

1. 위 AC 커맨드를 실행한다(전부 green).
2. 아키텍처 체크리스트:
   - `editorLanguage.js`가 zero-dep 순수 모듈인가?(import 0·입력 비파괴)
   - `EditorPrefsDialog.jsx`·`editorPrefs.js`·`StatusBar.jsx`·`Editor.jsx`가 diff에 **없는가**?(이 step은 신규 모듈 + 신규 테스트뿐)
   - 라벨 9종이 news.md L196·`EDIT_LANGUAGES`와 문자 단위로 동일한가?
3. 결과에 따라 `phases/40-editor-lang-inputmode/index.json`의 step1을 업데이트한다:
   - 성공 → `"status": "completed"`, `"summary"`에 (신규 `editorLanguage.js`·`LANGUAGE_LABELS` 9종 단일출처·`languageLabel`/`normalizeLanguage` 폴백 ko·ko 라벨 '한글')를 한 줄 요약.
   - 3회 수정 후에도 실패 → `"status": "error"`, `"error_message"`.
   - 사용자 개입 필요 → `"status": "blocked"`, `"blocked_reason"` 후 즉시 중단.
4. top-level `phases/index.json`의 40 항목 상태는 execute.py가 관리한다(직접 건드리지 마라).

## 금지사항

- `web/src/view/editorPrefs.js`의 `edit.language` 기본값·허용 코드 집합을 바꾸지 마라. 이유: 저장 shape은 레거시 호환이며 이 phase는 소비 측만 결선한다.
- `web/src/view/EditorPrefsDialog.jsx`를 리팩터하지 마라(EDIT_LANGUAGES를 이 모듈로 대체하는 것 포함). 이유: 설정 입력 UI는 이미 동작·테스트되어 있고, 이 step의 레이어는 표시 소비 모델뿐이다 — 다이얼로그를 함께 바꾸면 scope가 두 모듈로 번지고 회귀 표면이 커진다.
- ko 라벨을 `'한국어'`로 두지 마라. 이유: news.md L196·다이얼로그의 단일 표기는 `'한글'`이며, 상태표시줄이 설정 UI와 다른 라벨을 쓰면 사용자 혼란·표기 드리프트가 생긴다.
- 라벨/코드 목록을 함수마다 재하드코딩하지 마라. 이유: `LANGUAGE_LABELS` 단일 출처에서 파생해야 표기 드리프트가 원천 차단된다.
- 기존 테스트를 깨뜨리지 마라.
