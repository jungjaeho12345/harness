# Step 0: i18n-catalog

## 목표
에디터 UI 언어(ko/en) 전환의 **데이터·영속 인프라**를 만든다. 컴포넌트는 건드리지 않는다.
1. 문자열 카탈로그 + 번역 헬퍼 순수 모듈 `web/src/view/i18n.js` 신규.
2. UI 언어 설정을 담을 `ui.language` 환경설정 항목을 `web/src/view/editorPrefs.js`에 **가산적으로(additive)** 추가.

이 step은 순수 모듈 2개(+테스트)만 만든다. `WriterPage`/`EditorMenuBar` 등 어떤 컴포넌트도 이 step에서 수정하지 않는다.

## 배경 / 설계 의도
- news.md L186 도구 메뉴 마지막 항목 "UI 언어 설정". 이 phase 완료 시 도구 메뉴 전 항목 결선이 완결된다.
- **지원 언어는 ko/en 2종뿐이다.** news.md L196의 9개 언어 목록(환경설정 > 언어)은 **문서/입력 언어**(`editorPrefs.edit.language`)이며 이 phase와 무관하다. UI 언어(`ui.language`)와 절대 혼동하지 마라 — 별개의 새 키다.
- **ko 기본값일 때 기존 DOM이 한 글자도 변하면 안 된다.** 그래서 카탈로그의 `ko` 값은 현재 하드코딩된 크롬 문자열과 **바이트 단위로 100% 동일**해야 하고, 번역 실패/미등록 키는 항상 ko(원문)로 폴백해야 한다. 이것이 이 phase의 최상위 불변식이다.
- 카탈로그 **키 = 이미 존재하는 안정 id**를 재사용한다. `EditorMenuBar.jsx`의 `EDITOR_MENUS`는 각 메뉴/항목에 `id`(예: `'file'`, `'file.new'`, `'tools.uiLanguage'`)를 이미 가진다. 이 id를 그대로 i18n 키로 쓰면 Step 2에서 `t(item.id, item.label)` 한 줄로 결선되고, 폴백(`item.label`=ko 원문)이 ko 불변식을 이중으로 보장한다.
- UI 언어는 **클라이언트 localStorage(editorPrefs) 재사용**으로 영속한다(서버/DB 무관). 기존 `columnLimit`/`edit.language`/`autosave`와 동일 저장 경로다. 신규 테이블·서버 라우트를 만들지 마라(DB 비파괴·범위 최소화). 따라서 이 phase는 서버·model 계약·인가와 무관하다.

## 읽어야 할 파일
- `docs/news.md` L160·L180-187(상단 메뉴바 라벨 — ko 원문 출처), L196(환경설정>언어 = 문서 언어, **이 phase 아님**)
- `docs/ARCHITECTURE.md`(프론트 MVC: View←Controller←Model), `docs/ADR.md`(ADR-003 주입형 계약)
- `web/src/view/editorPrefs.js`(전체 — `DEFAULT_EDITOR_PREFS`, `loadEditorPrefs`, `saveEditorPrefs`, `setEditorPref` 패턴을 그대로 따를 것)
- `web/src/view/editorPrefs.test.js`(테스트 스타일 참고)
- `web/src/view/EditorMenuBar.jsx` L9-112 (`EDITOR_MENUS` — 각 메뉴/항목의 id와 ko 라벨 문자열. 카탈로그 ko 값의 정답지)

## 작업 (테스트 먼저 — TDD)

### 1) `web/src/view/i18n.js` — 카탈로그 + 번역 헬퍼 (순수)
먼저 `web/src/view/i18n.test.js`를 작성하고(아래 AC 참조), 통과하는 최소 구현을 만든다. 공개 인터페이스(시그니처만 고정, 구현은 재량):
- `export const UI_LANGUAGES` — `['ko', 'en']` (freeze). 지원 UI 언어 목록.
- `export const MESSAGES` — `{ ko: { [key]: string }, en: { [key]: string } }` (freeze). 키는 `EDITOR_MENUS`의 메뉴/항목 id 전체(7개 메뉴 id + 모든 item id) + UI 언어 다이얼로그 전용 키(예: `'ui.dialog.title'`, `'ui.dialog.langLabel'`, `'ui.dialog.ko'`, `'ui.dialog.en'`, `'common.save'`, `'common.close'`). `ko` 값은 `EDITOR_MENUS`의 라벨과 **바이트 동일**, `en` 값은 대응 영문.
- `export function createTranslator(lang)` → `(key, fallback?) => string` 반환.
  - **핵심 규칙(반드시 준수)**: `lang`이 `MESSAGES`에 없으면 `ko` 테이블 사용. 키가 현재 테이블에 있으면 그 값, 없으면 `fallback`, 그것도 없으면 `MESSAGES.ko[key]`, 그것도 없으면 `key` 자체를 반환한다. → `lang='ko'`면 항상 원문, 미등록 키·미지원 언어는 원문/폴백으로 안전 저하.

### 2) `web/src/view/editorPrefs.js` — `ui.language` 항목 additive 추가
`editorPrefs.test.js`에 케이스를 먼저 추가하고 구현한다.
- `DEFAULT_EDITOR_PREFS`에 새 카테고리 `ui: { language: 'ko' }`를 **추가**한다. 기존 카테고리(`colors`/`autosave`/`byline`/`edit`/`spellcheck`/…)는 한 글자도 바꾸지 마라. `edit.language`(문서 언어 9종)와 **별도 카테고리**로 둔다.
- `loadEditorPrefs`의 반환 객체에 `ui: { ...DEFAULT_EDITOR_PREFS.ui, ...(saved.ui || {}) }` 한 줄을 **추가**한다(다른 카테고리의 한 단계 깊이 병합 패턴과 동형). 저장값이 없으면 `ui.language === 'ko'`.
- 저장은 기존 `saveEditorPrefs`/`setEditorPref`를 그대로 재사용한다(신규 저장 함수 만들지 마라). `setEditorPref(prefs, 'ui', { language })`가 동작해야 한다(`setEditorPref`는 임의 카테고리 병합이라 수정 불필요 — 테스트로만 확인).

## Acceptance Criteria
```
cd D:/agents/harness && npm run test -- web/src/view/i18n.test.js web/src/view/editorPrefs.test.js
cd D:/agents/harness && npm run test
cd D:/agents/harness && npm run lint
cd D:/agents/harness && npm run build
```
테스트가 반드시 커버할 것:
- `i18n.test.js`: (a) **ko 바이트 동일** — `EDITOR_MENUS`를 import해 모든 메뉴/항목 id에 대해 `MESSAGES.ko[id] === label` 단언(하나라도 다르면 실패). (b) `en`에 동일 키 집합이 모두 존재(누락 키 없음). (c) `createTranslator('ko')(id)`가 ko 원문 반환. (d) `createTranslator('en')(id)`가 영문 반환. (e) 미지원 언어(`createTranslator('ja')`)·미등록 키는 ko/폴백으로 저하(`createTranslator('en')('없는키','원문') === '원문'`, `createTranslator('en')('없는키') === '없는키'`).
- `editorPrefs.test.js`: 저장값 없을 때 `loadEditorPrefs().ui.language === 'ko'`; `saveEditorPrefs(setEditorPref(loadEditorPrefs(),'ui',{language:'en'}))` 후 재로드 시 `'en'` 유지; 기존 카테고리 기본값 회귀 없음(부분 저장 병합 케이스 1개).
- **전체 스위트가 회귀 없이 통과**(`npm run test`) — ko 불변식의 실제 증거.

## 검증 절차
1. `MESSAGES.ko` 각 값이 `EDITOR_MENUS`의 대응 라벨과 바이트 동일한가(테스트가 강제)? 수기로도 도구 메뉴 15개 항목을 대조.
2. `createTranslator`의 폴백 사슬(현재테이블→fallback→ko→key)이 미등록 키에서 원문/키로 안전 저하하는가?
3. `loadEditorPrefs().ui.language` 기본값이 정확히 `'ko'`인가? 기존 카테고리 반환 shape이 하나도 안 바뀌었는가?
4. 컴포넌트 파일(`WriterPage.jsx`/`EditorMenuBar.jsx` 등)이 이 step에서 **전혀 수정되지 않았는가**(git diff로 확인)?

## 금지사항
- `MESSAGES.ko` 값을 원문과 다르게(오탈자·공백·기호 포함) 쓰지 마라. 이유: ko 기본값에서 기존 DOM/스냅샷 테스트가 깨진다 — 이 phase의 최상위 불변식 위반.
- `editorPrefs.edit.language`(문서 언어 9종)를 UI 언어로 재활용하거나 수정하지 마라. 이유: 별개 개념이며(스펙 명시), 상태표시줄·Editor lang 속성 회귀를 유발한다.
- 기존 `editorPrefs` 카테고리·`loadEditorPrefs` 반환 shape을 변경·제거하지 마라(순수 additive만). 이유: phase 10~40의 색상/자동저장/줄간격/글리프 등 전부 이 store에 의존한다.
- 이 step에서 컴포넌트(View)·컨트롤러(WriterPage)·서버·model 계약을 건드리지 마라. 이유: Scope 최소화 — 인프라 레이어만.
- 서버 저장/신규 DB 테이블/라우트를 만들지 마라. 이유: UI 언어는 클라이언트 localStorage 재사용이 정책이며 DB 비파괴·범위 최소화.
