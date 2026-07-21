# Step 3: writer-editor-wiring

`WriterPage`가 저장된 **언어·입력모드** 설정을 읽어 상태표시줄(step2)과 Editor의 `lang` 속성에 주입하도록 결선한다. 결선 방식은 이미 검증된 **columnLimit/lineSpacing prefs 게이트의 직계 패턴**(state + 마운트 `loadEditorPrefs` + `onPrefsClose(applied)` 갱신, 취소 시 불변)이다. Editor는 **`lang` 속성의 prop화**(표시 전용, `spellcheck` prop 동형) 한 줄만 바꾼다.

이 step은 `WriterPage.jsx`(결선)와 `Editor.jsx`(lang prop 1개)를 함께 다룬다. Editor 변경은 값을 공급하는 WriterPage 배선과 불가분한 표시 전용 속성 주입뿐이라 같은 step에 둔다(로직 추가 없음 — 금지사항 참조).

## 읽어야 할 파일

먼저 아래 파일들을 읽고 설계 의도를 파악하라:

- `docs/ARCHITECTURE.md`, `docs/ADR.md`(ADR-003 — 프론트 MVC: View←Controller(훅)).
- `docs/news.md` L160(상태표시줄 언어), L171(Alt+Y — spellcheck=true·lang: 네이티브 사전이 문서 언어를 따르되 기본 ko), L196(언어 9종), L198(입력모드).
- `web/src/view/WriterPage.jsx`:
  - L199~207 — prefs 게이트 state(`editorBg`/`columnLimit`/`lineSpacing`/`autosaveCfg`)의 lazy `useState`. **여기에 `language`·`inputMode`를 나란히 추가**.
  - L214~220 — 마운트 effect(저장값 재동기화). **여기에 `setLanguage`/`setInputMode` 추가**.
  - L224~234 — `onPrefsClose(applied)`의 `applied` 분기(적용 시 재동기화, 취소 시 불변). **여기에 추가**.
  - L1354~1370 — `<Editor ... spellcheck={spell} spellHighlights=... />` 결선부. **`lang` prop 추가**.
  - L1373 — `<StatusBar text={blocksToText(blocks)} caret={statusCaret} />`. **`language`·`inputMode` prop 추가**.
  - L42 — `import { loadEditorPrefs, normalizeLineSpacing } from './editorPrefs.js';`(import 지점 참고).
- `web/src/view/Editor.jsx`:
  - props 구조분해(약 L300~316, `spellcheck`/`spellHighlights = []`/`spellHighlightStyle = 'bold'` 근처). **`lang = 'ko'` 추가**.
  - 편집 div의 `lang="ko"`(약 L560, `spellCheck={spellcheck}` 바로 아래). **`lang={lang}`로 교체**.
- `web/src/view/editorLanguage.js` — **step1 산출물**: `normalizeLanguage(code)`(폴백 'ko').
- `web/src/view/StatusBar.jsx` — **step2 산출물**: `language`(코드), `inputMode` prop을 받아 라벨/바이트를 표시.
- `web/src/view/WriterPage.test.jsx` — `setup`/`openTopMenu` 헬퍼, `saveEditorPrefs`/`loadEditorPrefs` 사용 패턴, 그리고 **columnLimit·줄간격 게이트 describe 블록**(환경설정 열기→편집 탭 select→'적용' 라이브 반영 테스트의 동형 템플릿).

step1·step2 요약이 프롬프트에 함께 전달된다. `normalizeLanguage`와 갱신된 `StatusBar` 계약을 먼저 확인하라.

## 배경 (자기완결)

`edit.language`·`edit.inputMode`는 저장만 되어 있고 소비처가 없다. `columnLimit`/`lineSpacing`은 `WriterPage`가 `loadEditorPrefs()`로 읽어 state에 담고, 마운트·`onPrefsClose(적용)` 시 재동기화하며 취소 시 불변이다(raw 저장값 보관, 정규화는 소비 시점). 언어·입력모드도 **같은 게이트**에 얹는다.

### `WriterPage.jsx` 결선 (columnLimit/lineSpacing 게이트에 나란히 추가)

1. state 추가(L207 `lineSpacing` 옆):
   ```jsx
   const [language, setLanguage] = useState(() => loadEditorPrefs().edit.language);   // raw 코드 보관
   const [inputMode, setInputMode] = useState(() => loadEditorPrefs().edit.inputMode); // raw 보관
   ```
2. 마운트 effect(L218~219 옆)에 `setLanguage(loadEditorPrefs().edit.language); setInputMode(loadEditorPrefs().edit.inputMode);` 추가(새로고침 후에도 반영).
3. `onPrefsClose`의 `applied` 분기(L228~231 옆)에 동일 두 `set*` 추가. **취소(applied=false) 시 불변** — 동일 게이트.
4. `<StatusBar>`(L1373)에 prop 주입 — **raw 그대로**(StatusBar가 내부에서 `languageLabel`/`normalizeInputMode`로 폴백·정규화):
   ```jsx
   <StatusBar text={blocksToText(blocks)} caret={statusCaret} language={language} inputMode={inputMode} />
   ```
5. `<Editor>`(L1354~)에 `lang` prop 주입 — **정규화한 코드**(HTML `lang` 속성엔 유효 코드만):
   ```jsx
   lang={normalizeLanguage(language)}
   ```
   `normalizeLanguage`를 `./editorLanguage.js`에서 import한다. `language`(9종 코드 `ko/en/…/ru`)는 BCP-47 primary subtag와 동일하므로 별도 매핑 없이 그대로 `lang` 속성값이 된다.

### `Editor.jsx` 결선 (lang 속성 prop화 — 표시 전용, 한 줄)

- props 구조분해에 `lang = 'ko'`를 추가한다(기본값 `'ko'` — prop 미주입 경로에서 현행과 동일).
- 편집 div의 `lang="ko"`를 `lang={lang}`로 바꾼다. **그 외 어떤 변경도 하지 않는다**(아래 안전 근거·금지사항).

### 안전 근거 (못박음)

- **캐럿/IME 불변**: `lang`은 편집 div의 HTML 속성일 뿐이다(브라우저 네이티브 맞춤법 사전 힌트 — `spellCheck` 속성과 동형). `renderTick`/`key`를 바꾸지 않으므로 언어 변경 시 Editor는 **remount 없이 속성만 in-place 패치**된다. DOM 구조·텍스트 노드·줄 요소가 그대로라 `readCaret`·echo·IME 조합에 영향이 없다.
- **변경 시점**: 언어/입력모드는 환경설정 다이얼로그(`onPrefsClose(적용)`)에서만 바뀌며, 그 동안 편집 div는 포커스를 잃은 상태다 — 조합(IME) 중 속성 스래싱이 발생하지 않는다.
- **Alt+Y 정합**: Alt+Y는 `spellcheck=true`를 켜고, `lang`이 문서 언어(기본 ko)를 지정하면 네이티브 사전이 그 언어를 따른다(news.md L171 해석). `lang` prop화는 이 정합을 완성할 뿐 Alt+Y 로직을 건드리지 않는다.

## 작업 (TDD — 실패하는 테스트부터)

### `web/src/view/WriterPage.test.jsx` (신규 describe — columnLimit/줄간격 게이트를 동형 템플릿으로)

`beforeEach`에서 `localStorage.clear()`. 헬퍼 예: `const saveEdit = (patch) => saveEditorPrefs({ ...loadEditorPrefs(), edit: { ...loadEditorPrefs().edit, ...patch } });`

- (a) 미저장(기본) 렌더 → `stat-language` `'한글'`(ko 기본), 편집 div(`role="textbox"` 본문)의 `lang` 속성 `'ko'`.
- (b) `saveEdit({ language: 'en' })` 렌더 → `stat-language` `'영어'`, 편집 div `lang` `'en'`.
- (c) 미지원 저장 `saveEdit({ language: 'xx' })` 렌더 → `stat-language` `'한글'`(폴백), 편집 div `lang` `'ko'`(`normalizeLanguage` 폴백) — **핵심 회귀 가드**.
- (d) `saveEdit({ inputMode: 'ksc5601' })` + 본문에 한글이 있는 상태 렌더 → `stat-bytes`가 EUC-KR 값(예: 본문 `'한글'`이면 `'4'` 포함). 기본(unicode) 렌더는 UTF-8 값.
- (e) 라이브 게이트: `openTopMenu('도움말')` → 환경설정 열기 → 편집 탭에서 언어 select(`pref-edit-language`)를 `'en'`로, 입력모드 select(`pref-edit-inputMode`)를 `'ksc5601'`로 바꾸고 '적용' → `stat-language` `'영어'`, 편집 div `lang` `'en'`, `stat-bytes` EUC-KR 값으로 반영.
- (f) '취소' → 위 값 **불변**(게이트 취소 시 미반영).

편집 div `lang` 단언은 `getByRole('textbox', { name: '본문' }).getAttribute('lang')` 또는 동등한 방식으로 한다.

### `web/src/view/Editor.test.jsx` (신규 케이스)

- `lang` prop 미지정 렌더 → 편집 div `lang` 속성 `'ko'`(기본값).
- `lang="en"` 렌더 → 편집 div `lang` 속성 `'en'`.
- (선택) `lang` 변경이 캐럿/텍스트에 영향 없음을 기존 echo/캐럿 테스트로 커버(신규 회귀 테스트는 필수 아님 — 속성 in-place 패치라 구조 불변).

### 구현

위 배경대로 `WriterPage.jsx`·`Editor.jsx`를 최소 변경한다. 테스트를 먼저 red로 만든 뒤 통과시킨다.

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
   - `Editor.jsx` diff가 **오직** props에 `lang = 'ko'` 추가 + `lang="ko"`→`lang={lang}` 두 곳뿐인가?(로직·effect·ref·핸들러 무변경)
   - `WriterPage`가 columnLimit/lineSpacing과 **동일 게이트**로 언어·입력모드를 다루는가?(취소 시 불변)
   - StatusBar엔 raw, Editor엔 `normalizeLanguage` 결과가 가는가?
   - columnLimit·줄간격·맞춤법 하이라이트(step39)·색상 등 기존 게이트/결선 테스트가 green인가?
   - ADR-003·CLAUDE.md(client 전용·server/DB 무관·UTF-8) 준수?
3. 결과에 따라 `phases/40-editor-lang-inputmode/index.json`의 step3을 업데이트한다:
   - 성공 → `"status": "completed"`, `"summary"`에 (WriterPage language/inputMode 게이트 추가·StatusBar raw 주입·Editor lang={normalizeLanguage} prop화·취소 불변·테스트 추가)를 한 줄 요약.
   - 3회 수정 후에도 실패 → `"status": "error"`, `"error_message"`.
   - 사용자 개입 필요 → `"status": "blocked"`, `"blocked_reason"` 후 즉시 중단.
4. top-level `phases/index.json`의 40 항목 상태는 execute.py가 관리한다(직접 건드리지 마라).

## 금지사항

- `Editor.jsx`에 `lang` 속성 prop화 외 어떤 변경도 하지 마라(핸들러·effect·ref·keydown·조합 로직 등). 이유: Editor는 캐럿/echo/IME 불변식이 극도로 민감한 모듈(phase 39 위험등록부)이며, 이 phase의 언어 기능은 표시용 HTML 속성 주입만으로 충족된다 — 로직을 더하면 회귀 위험만 커진다.
- 언어/입력모드를 columnLimit/lineSpacing과 **다른 게이트**(별도 effect·구독·라이브 리스너)로 다루지 마라. 이유: 검증된 단일 게이트(마운트+onPrefsClose(적용), 취소 불변)를 벗어나면 취소 시 반영·이중 소스 등 회귀가 생긴다.
- StatusBar에 이미 정규화한 라벨을 넘기지 마라(raw 코드/모드를 넘겨라). 이유: 표시 정규화·폴백은 StatusBar가 순수 함수로 소유한다(단일 지점) — WriterPage에서 라벨을 만들면 표시 로직이 두 곳으로 흩어진다.
- `edit.language`/`edit.inputMode` 저장값을 마운트/적용 시 정규화해 **되쓰지** 마라(raw 유지). 이유: lineSpacing 선례처럼 저장은 raw, 정규화는 소비 시점에만 — 저장값을 덮으면 레거시 호환·사용자 설정이 훼손된다.
- 입력모드에 따라 keydown/입력을 차단하거나 인터셉트하지 마라. 이유: 입력모드는 **표시 전용**(바이트 계산 전환)이다 — 입력 개입은 사용자가 명시 배제했고 Editor keydown 리스크가 크다.
- 기존 테스트를 깨뜨리지 마라.
