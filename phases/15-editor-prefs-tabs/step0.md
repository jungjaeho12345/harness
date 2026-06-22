# Step 0: prefs-store-categories — 환경설정 store에 신규 카테고리 5종 확장

## 배경 / 요구사항

`docs/news.md`(L183~213) 에디터 환경설정에는 색상/자동저장/날짜형식 외에 **편집·바이라인·자주쓰는 약물·사용자 키보드 약물·맞춤법** 서브메뉴가 더 있다. 현재 `web/src/view/editorPrefs.js`의 `DEFAULT_EDITOR_PREFS`에는 `colors`/`autosave`/`byline`/`dateFormat`만 있다(byline은 `{ email, emailValue, blog, blogValue }`).

이 step은 **UI를 만들지 않는다**. 오직 **store(localStorage) 계층에 신규 카테고리 키 5종의 DEFAULT를 추가하고 `loadEditorPrefs` 병합에 끼워 넣은 뒤 단위테스트로 못박는다.** 이후 step1~3이 이 안정된 store 위에 탭 UI만 붙인다(phase 10~13 패턴과 동일 — store 먼저, UI 나중).

신규 카테고리 5종(키 이름은 이 파일이 단일 출처 — 이후 step들이 그대로 참조):

1. **`edit`** (편집): `{ columnLimit: false, dragDrop: false, noCommonAbbr: false, companyCode: 'manual', language: 'ko', lineSpacing: 1.0, inputMode: 'unicode' }`
   - `columnLimit`(bool): 컬럼제한(좌우 여백 10% 축소 — effect는 step4).
   - `dragDrop`(bool, 기본 off): 이미지 드래그앤드롭 허용. **기본값 false 못박음**(news.md L186 "기본값은 안된다").
   - `noCommonAbbr`(bool): 공용약어 사용안함.
   - `companyCode`(enum `'manual'|'auto'`): 기업코드 변환 방식(수동/자동).
   - `language`(enum): 입력 언어. 허용값 9종 `'ko'|'en'|'ja'|'zh'|'es'|'fr'|'ar'|'vi'|'ru'`(한·영·일·중·스페인·프랑스·아랍·베트남·러시아). 기본 `'ko'`.
   - `lineSpacing`(number): 줄간격. 기본 `1.0`.
   - `inputMode`(enum `'ksc5601'|'unicode'`): 입력모드(KSC-5601/Unicode). 기본 `'unicode'`.
2. **`byline`** (바이라인): **이미 존재** — `{ email: false, emailValue: '', blog: false, blogValue: '' }`. **변경하지 마라.** (UI는 step1이 추가한다.)
3. **`glyphFavorites`** (자주쓰는 약물): `{ items: [] }` — 즐겨찾는 약물 문자열 목록.
4. **`glyphKeymap`** (사용자 키보드 약물): `{ items: [] }` — `{ keys: '<키조합 문자열>', glyph: '<약물 문자열>' }` 매핑 목록.
5. **`spellcheck`** (맞춤법): `{ checkOption: 'spacing', errorTypes: { misuse: false, multiWord: false, semantic: false, circular: false, statSpacing: false, others: false }, errorStyle: 'bold' }`
   - `checkOption`(enum): 검사옵션. 허용값 `'procedure'|'spacing'|'joining'|'spacingJoining'|'circularLoan'`(절차오류/띄어쓰기/붙여쓰기/띄어쓰기+붙여쓰기/순환용어·외래어). 기본 `'spacing'`.
   - `errorTypes`(다중 bool): 오류유형 6종(오용어/다수어절/의미문체/순환용어/통계붙여쓰기/그외). 전부 기본 false.
   - `errorStyle`(enum `'bold'|'underline'`): 오류표현(굵게/밑줄). 기본 `'bold'`.

## 읽어야 할 파일

- `/CLAUDE.md`, `/docs/ARCHITECTURE.md`, `/docs/ADR.md` — view 모듈, 클라이언트 localStorage 전용(서버 무관), TDD.
- `/docs/news.md` L183~213 — 에디터 환경설정 서브메뉴 전체 명세(편집/바이라인/약물/맞춤법 필드 출처).
- `web/src/view/editorPrefs.js` — **변경 대상**. `STORAGE_KEY='yh.editorPrefs'`, `DEFAULT_EDITOR_PREFS`(Object.freeze), `readAll()`(try/catch graceful), `loadEditorPrefs()`(카테고리별 **한 단계 깊이 병합**), `saveEditorPrefs(prefs)`(graceful), `setEditorPref(prefs, category, patch)`(순수·비-mutate 얕은 병합). **이 패턴을 그대로 따른다.**
- `web/src/view/editorPrefs.test.js` — **변경 대상**(신규 단언 추가). 기존 회귀 테스트 패턴(`localStorage.clear()` beforeEach, 기본값/부분병합/round-trip/graceful) 미러링.

## 작업

TDD로 진행한다(vitest). **테스트를 먼저 쓰고 통과시킨다.**

### 1. `DEFAULT_EDITOR_PREFS` 확장 (`editorPrefs.js`)

`Object.freeze({...})` 안에 위 배경의 5종 중 신규 4종(`edit`/`glyphFavorites`/`glyphKeymap`/`spellcheck`)을 추가한다. `byline`은 그대로 둔다. 예(중첩 객체도 freeze 불필요 — 기존 colors/autosave도 평면 freeze만 적용됨, 동일 패턴 유지):

```js
export const DEFAULT_EDITOR_PREFS = Object.freeze({
  colors: { ... },        // 기존 — 변경 금지
  autosave: { ... },      // 기존 — 변경 금지
  byline: { email: false, emailValue: '', blog: false, blogValue: '' }, // 기존 — 변경 금지
  edit: { columnLimit: false, dragDrop: false, noCommonAbbr: false, companyCode: 'manual', language: 'ko', lineSpacing: 1.0, inputMode: 'unicode' },
  glyphFavorites: { items: [] },
  glyphKeymap: { items: [] },
  spellcheck: { checkOption: 'spacing', errorTypes: { misuse: false, multiWord: false, semantic: false, circular: false, statSpacing: false, others: false }, errorStyle: 'bold' },
  dateFormat: 'YYYY-MM-DD HH:mm', // 기존 — 변경 금지
});
```

### 2. `loadEditorPrefs` 병합 확장 (`editorPrefs.js`)

기존은 카테고리별로 `{ ...DEFAULT.X, ...(saved.X || {}) }` 한 단계 병합을 한다. **신규 4종도 동일하게 한 단계 병합으로 추가**한다:

```js
return {
  colors: { ...DEFAULT_EDITOR_PREFS.colors, ...(saved.colors || {}) },
  autosave: { ...DEFAULT_EDITOR_PREFS.autosave, ...(saved.autosave || {}) },
  byline: { ...DEFAULT_EDITOR_PREFS.byline, ...(saved.byline || {}) },
  edit: { ...DEFAULT_EDITOR_PREFS.edit, ...(saved.edit || {}) },
  glyphFavorites: { ...DEFAULT_EDITOR_PREFS.glyphFavorites, ...(saved.glyphFavorites || {}) },
  glyphKeymap: { ...DEFAULT_EDITOR_PREFS.glyphKeymap, ...(saved.glyphKeymap || {}) },
  spellcheck: { ...DEFAULT_EDITOR_PREFS.spellcheck, ...(saved.spellcheck || {}) },
  dateFormat: typeof saved.dateFormat === 'string' ? saved.dateFormat : DEFAULT_EDITOR_PREFS.dateFormat,
};
```

**주의(한 단계 병합의 한계 — 의도된 설계):** `spellcheck.errorTypes`와 `glyphFavorites.items`/`glyphKeymap.items`는 **중첩 객체/배열**이다. 한 단계 병합은 저장된 `errorTypes`가 있으면 그 객체로 통째로 대체한다(깊은 병합 아님). 이는 기존 `colors`/`autosave`와 동일한 동작이며 **이대로 둔다**(깊은 병합을 도입하지 마라 — 기존 store 계약·다른 카테고리 동작과 어긋난다). 단, step2/step3가 저장 시 `errorTypes`/`items` 전체를 항상 함께 넣으므로 부분 손실은 없다.

### 3. `saveEditorPrefs` / `setEditorPref` — **변경 금지**

이 두 함수는 카테고리를 일반화해 다루므로 신규 카테고리에도 그대로 작동한다(`setEditorPref(prefs, 'edit', {...})` 등). 시그니처·로직을 건드리지 마라.

## 핵심 규칙 (반드시 준수 — 위반 시 반려)

1. **기존 카테고리 불변**: `colors`/`autosave`/`byline`/`dateFormat`의 기본값·병합 로직을 바꾸지 마라. 특히 색상 부제목 기본값 `#c8102e`(빨강), 색상 기본값이 `editorColoring.COLORS`와 일치하는 기존 단언이 그대로 통과해야 한다.
2. **graceful 영속 유지**: `readAll`의 try/catch·localStorage 불가 시 기본값 반환 동작을 보존한다.
3. **한 단계 병합 유지**: 신규 카테고리도 기존과 동일하게 한 단계 얕은 병합. **깊은 병합을 새로 도입하지 마라.**
4. **`setEditorPref`/`saveEditorPrefs` 시그니처 불변.**
5. **UI 금지**: 이 step은 store만. `EditorPrefsDialog.jsx`를 건드리지 마라(탭 UI는 step1~3).
6. **Editor.jsx 무변경**: 이 step은 editorPrefs.js와 그 테스트만 만진다.

## Acceptance Criteria

```bash
npm run test:web && npm run build && npm run lint
```

추가 단언(`editorPrefs.test.js`, vitest):
- `loadEditorPrefs()`가 저장값 없을 때 `edit`/`glyphFavorites`/`glyphKeymap`/`spellcheck`를 각 DEFAULT로 반환한다(예: `edit.dragDrop === false`, `edit.companyCode === 'manual'`, `edit.language === 'ko'`, `edit.inputMode === 'unicode'`, `spellcheck.checkOption === 'spacing'`, `spellcheck.errorStyle === 'bold'`, `spellcheck.errorTypes.misuse === false`, `glyphFavorites.items` 가 빈 배열, `glyphKeymap.items` 가 빈 배열).
- 부분 저장 병합: `localStorage.setItem('yh.editorPrefs', JSON.stringify({ edit: { columnLimit: true } }))` 후 `loadEditorPrefs().edit.columnLimit === true`이고 나머지 edit 키는 DEFAULT 유지(`dragDrop === false` 등). 저장 안 한 다른 카테고리(`colors` 등)도 DEFAULT 유지.
- round-trip: `setEditorPref(loadEditorPrefs(), 'edit', { language: 'ja', lineSpacing: 1.5 })`를 `saveEditorPrefs` 후 `loadEditorPrefs().edit.language === 'ja'`, `lineSpacing === 1.5`.
- `setEditorPref(prefs, 'spellcheck', { errorStyle: 'underline' })`가 새 객체를 반환하고 입력을 mutate하지 않는다.
- graceful: localStorage가 throw해도 `loadEditorPrefs().edit`가 예외 없이 DEFAULT를 반환한다.
- **회귀**: 기존 색상/autosave/byline/dateFormat 단언이 전부 통과(부제목 기본 `#c8102e` 포함).

## 검증 절차

1. 위 AC 커맨드를 실행한다.
2. 아키텍처 체크: editorPrefs는 view 모듈(서버 호출 없음 — ADR-003 위반 아님) / DB 비파괴(CLAUDE.md — 클라 localStorage 전용, 무관) / 기존 카테고리·graceful 회귀 없음.
3. `phases/15-editor-prefs-tabs/index.json`의 step 0을 갱신한다(성공 → `completed` + `summary` 한 줄 / 3회 실패 → `error` + `error_message` / 개입 필요 → `blocked` + `blocked_reason`).

## DEFERRED EFFECTS

이 step은 **값의 저장 형태(store)만** 정의한다. 각 설정의 실제 동작(드래그앤드롭 허용·언어 전환·줄간격·입력모드·맞춤법 검사 실행·약물 입력 등)은 결선하지 않는다. effect 결선은 step4(컬럼제한만 — 래퍼 레벨) 및 후속 phase(나머지 — Editor.jsx 내부/IME/aux-tools 소관)로 명확히 연기한다.

## 금지사항

- `EditorPrefsDialog.jsx`를 수정하지 마라. 이유: 이 step은 store 전용이고, 탭 UI는 step1~3이 안정된 store 위에서 붙인다(범위 격리 — 실패 원인 분리).
- `loadEditorPrefs`에 **깊은(재귀) 병합**을 도입하지 마라. 이유: 기존 colors/autosave/byline과 병합 동작이 달라져 store 계약이 불일치한다.
- `colors`/`autosave`/`byline`/`dateFormat`의 기본값·병합을 바꾸지 마라. 이유: 색상/자동저장/날짜형식 phase의 회귀 테스트가 깨진다.
- `Editor.jsx`·`WriterPage.jsx`를 건드리지 마라(이 step은 store + 테스트만).
- 서버/model/fetch를 호출하지 마라(클라 localStorage 전용).
