# Step 1: toolbar-font-effect

## 목표

step0에서 정한 툴바 폰트 계약(신규 키 `edit.editorFont`/`edit.editorFontSize` 기본 `'기본'` + 순수 매핑 `fontFamilyCss`/`fontSizeCss`, `'기본'→null`)을 **실제 에디터 폰트에 반영(effect)**한다. 방식은 **phase 33 줄간격 effect(step1)의 직계 패턴** — WriterPage가 툴바 선택값을 state로 들고, 캔버스 래퍼(`editor-canvas`) style에 CSS 변수(`--yh-editor-font-family`/`--yh-editor-font-size`)를 **조건부 주입**하며, `yonhap.css`의 `.yh-editor` 폰트 속성을 `var(--x, 현재값)`으로 변수화한다. **`Editor.jsx` 내부는 미접촉**(래퍼-레벨 effect + CSS 변수 상속).

## 읽어야 할 파일

- `docs/ARCHITECTURE.md`, `docs/ADR.md`(ADR-003 — view 모듈, 서버 호출만 controller 경유).
- **`phases/33-editor-linespacing-effect/step1.md`** — 이 step이 그대로 모방할 권위 출처. 특히 "캔버스 래퍼 style에 CSS 변수 주입 → 자식 `.yh-editor`가 상속", "yonhap.css를 `var(--x, fallback)`으로 변수화하되 하드코딩 fallback을 삭제하지 말고 보존", "jsdom은 실제 계산 스타일을 신뢰할 수 없어 CSS 변수 주입 여부만 단언".
- `web/src/view/editorPrefs.js` — **step0에서 추가된** `edit.editorFont`/`edit.editorFontSize`(기본 `'기본'`), `fontFamilyCss`/`fontSizeCss`(`'기본'`/무효→`null`). step0 요약이 프롬프트에 함께 온다.
- `web/src/view/EditorToolBar.jsx` — **step0에서 controlled**(`font`/`fontSize`/`onFontChange`/`onFontSizeChange`). 이 step이 WriterPage에서 props를 주입한다.
- `web/src/view/WriterPage.jsx` — 특히:
  - L143 `const [showToolBar, setShowToolBar] = useState(false);` 근처(툴바 토글 state).
  - L213~221(prefs state/게이트 본: `editorBg`·`columnLimit`·`lineSpacing`의 `useState(() => loadEditorPrefs()...)`).
  - L240~249(마운트 effect — `setColumnLimit`/`setLineSpacing` 등 새로고침 복원). **여기에 폰트 복원을 나란히 추가**.
  - L254~265(`onPrefsClose(applied)` — editorBg/columnLimit/lineSpacing 재동기화). **폰트는 툴바 직접-저장이라 여기 넣을 필요 없음**(아래 §직접-저장 패턴 근거).
  - L505 근처 `saveEditorPrefs(setEditorPref(loadEditorPrefs(), 'ui', { language: lang }))`(uiLanguage **직접-저장** 패턴 — 툴바 폰트 핸들러의 본).
  - **L1418 `{showToolBar && <EditorToolBar />}`** — props 주입 지점.
  - **L1424~1434 캔버스 래퍼**(`className="yh-writer__canvas"`, `data-testid="editor-canvas"`, style에 `backgroundColor`·조건부 `columnLimit` padding·`'--yh-editor-line-height'`). **여기에 폰트 CSS 변수 조건부 추가**.
- `web/src/view/WriterPage.test.jsx` — L1~40 setup/`openTopMenu` 헬퍼, editorBg 스타일 단언, **phase 33 줄간격 describe 블록('편집>줄간격 …')** — 이 블록을 동형 템플릿으로 삼아라. 우클릭 컨텍스트 메뉴로 툴바를 여는 기존 테스트(`ctx.showToolBar`)가 있으면 그 헬퍼를 재사용하라.
- `web/src/styles/yonhap.css` — L497~510(`.yh-editor` — L506 `font-size: 0.95rem`, `font-family` 미선언), L507/L517(줄간격 변수화 선례), L34~35(`--yh-serif`/`--yh-sans`), L63~70(body `font-family: var(--yh-sans)`).

## 배경 (자기완결)

`editorBg`/`columnLimit`/`lineSpacing`은 `WriterPage`가 `loadEditorPrefs()`로 읽어 캔버스 래퍼 style에 반영하고, 마운트·`onPrefsClose(applied)`에서 재동기화한다. **줄간격은 항상 주입**(정규화값이 항상 유효)하지만, **폰트는 `'기본'`일 때 `fontFamilyCss`/`fontSizeCss`가 `null`을 반환하므로 columnLimit padding처럼 조건부 주입**한다(주입 없으면 CSS fallback=현재값 → 바이트 동일).

### §직접-저장 패턴 (못박음 — 근거)

줄간격은 **환경설정 다이얼로그(apply/cancel 모달)**로 바뀌므로 `onPrefsClose(applied)` 게이트를 탔다. 그러나 폰트는 **툴바 셀렉트(즉시 반영 컨트롤)**로 바뀐다 — apply/cancel이 없다. 따라서 uiLanguage 직접-저장(L505)과 동형으로: **툴바 onChange 시 즉시 `saveEditorPrefs(setEditorPref(...))`로 영속 + setState**한다. `onPrefsClose`에는 폰트를 넣지 않는다(다이얼로그에 폰트 컨트롤이 없어 재동기화 불필요). 마운트 effect에서만 새로고침 복원을 추가한다.

### 메커니즘 (못박음 — phase 33 동형)

1. `yonhap.css` `.yh-editor`(L506·L497 블록)를 CSS 변수 + fallback으로 바꾼다(하드코딩/상속값을 삭제하지 말고 fallback으로 보존):
   - `font-size: var(--yh-editor-font-size, 0.95rem);`(L506 대체)
   - `font-family: var(--yh-editor-font-family, var(--yh-sans));`(신규 선언 — 현재 `.yh-editor`는 font-family 미선언·body에서 `var(--yh-sans)` 상속이므로 fallback을 `var(--yh-sans)`로 두면 기본 상태 렌더가 바이트 동일). **구현 전 `.yh-editor`의 실제 상속 font-family가 `var(--yh-sans)`인지(중간 셀렉터 override 없는지) 확인하고 fallback을 그 값으로 맞춰라.**
2. `WriterPage`가 캔버스 래퍼 style에 CSS 변수를 **조건부 주입**한다. custom property는 상속되므로 자식 `.yh-editor`의 `var()`가 이를 사용한다. 주입이 없으면(`'기본'`) fallback(현재값)이 적용된다.

## TDD — 테스트 먼저 (`web/src/view/WriterPage.test.jsx`)

phase 33 줄간격 describe를 동형 템플릿으로 신규 describe(예: `WriterPage — 툴바 글꼴/크기(editor-canvas 폰트 변수) 적용`)를 추가하라. `beforeEach`에서 `localStorage.clear()`.

- 헬퍼: `const savePref = (patch) => saveEditorPrefs(setEditorPref(loadEditorPrefs(), 'edit', patch));`
- 단언 방식: `getByTestId('editor-canvas').style.getPropertyValue('--yh-editor-font-family')` / `'--yh-editor-font-size'` 문자열 비교(jsdom 실제 폰트 계산은 신뢰 불가 — 변수 주입 여부만 잠근다).
- (a) 미저장(기본 `'기본'`) 렌더 → 두 변수 모두 **미주입**(`getPropertyValue`가 `''`). **← 바이트 동일 회귀 가드(핵심 단언)**.
- (b) `savePref({ editorFont: '바탕' })` 렌더 → `--yh-editor-font-family` === `fontFamilyCss('바탕')`, `--yh-editor-font-size`는 여전히 미주입(`''`).
- (c) `savePref({ editorFontSize: '16' })` 렌더 → `--yh-editor-font-size` === `'16px'`.
- (d) editorBg + columnLimit + lineSpacing + editorFont + editorFontSize를 함께 저장하고 렌더 → 캔버스에 `backgroundColor`·`paddingLeft: '10%'`·`--yh-editor-line-height`·폰트 두 변수가 **모두 공존**(공존 회귀).
- (e) 라이브 컨트롤: 우클릭 컨텍스트 메뉴로 툴바를 켜고(`ctx.showToolBar`) `tool-font`에서 `'돋움'` 선택 → `--yh-editor-font-family` === `fontFamilyCss('돋움')`; 이후 `loadEditorPrefs().edit.editorFont === '돋움'`(직접-저장 영속 확인).
- (f) 새로고침 복원: `savePref({ editorFont: '굴림' })` 후 마운트 → 변수 === `fontFamilyCss('굴림')`(마운트 effect 복원).

## 작업 (구현 상세)

### `web/src/view/WriterPage.jsx`
1. state 2개 추가(`lineSpacing` 옆): `const [editorFont, setEditorFont] = useState(() => loadEditorPrefs().edit.editorFont);` + `editorFontSize` 동형. **raw 저장값 보관**(매핑은 주입 시점).
2. 마운트 effect(L240~249)에 `setEditorFont(loadEditorPrefs().edit.editorFont);` + size 추가.
3. 툴바 직접-저장 핸들러 2개(uiLanguage L505 패턴):
   ```js
   const onToolbarFont = (v) => { saveEditorPrefs(setEditorPref(loadEditorPrefs(), 'edit', { editorFont: v })); setEditorFont(v); };
   const onToolbarFontSize = (v) => { saveEditorPrefs(setEditorPref(loadEditorPrefs(), 'edit', { editorFontSize: v })); setEditorFontSize(v); };
   ```
4. L1418 툴바 렌더에 props 주입: `<EditorToolBar font={editorFont} fontSize={editorFontSize} onFontChange={onToolbarFont} onFontSizeChange={onToolbarFontSize} />`.
5. 캔버스 래퍼 style(L1427~1434)에 조건부 CSS 변수 추가(`columnLimit` padding과 동형 조건부 spread):
   ```jsx
   ...(fontFamilyCss(editorFont) ? { '--yh-editor-font-family': fontFamilyCss(editorFont) } : null),
   ...(fontSizeCss(editorFontSize) ? { '--yh-editor-font-size': fontSizeCss(editorFontSize) } : null),
   ```
   `fontFamilyCss`/`fontSizeCss`를 `./editorPrefs.js`에서 import. `backgroundColor`·`columnLimit` padding·`--yh-editor-line-height`와 **공존**(별도 키라 무간섭).

### `web/src/styles/yonhap.css`
위 §메커니즘대로 L506·`.yh-editor` 블록 **두 속성만** 변수화. `articleDetail.js`·다른 규칙의 font-family/size는 건드리지 마라.

## Acceptance Criteria

```bash
npm run lint
npm run build
npm run test:web
```

(백엔드 무관 — `npm test` 불필요.)

## 회귀 가드 / 불변식

- **기본 상태 바이트 동일**: `'기본'`이면 캔버스에 폰트 변수 미주입 → `.yh-editor`가 fallback(`var(--yh-sans)`/`0.95rem`) 렌더. jsdom 단언은 변수 미주입(`''`)으로 잠근다.
- **`Editor.jsx` diff 없음**: 래퍼-레벨 effect + CSS 변수 상속만(내부 DOM/캐럿 로직 미접촉).
- **공존**: editorBg·columnLimit·lineSpacing 기존 테스트가 그린(폰트 변수는 별도 키라 무간섭).
- **fallback 보존**: yonhap.css 하드코딩 `0.95rem`·상속 `var(--yh-sans)`를 삭제하지 말고 `var(--x, ...)` fallback으로 보존.
- **본문/발행 무접촉**: markupVersion·`articleDetail.js` 미변경.

## 커밋 계획

- **feat**: `feat(44-editor-gap-closeout): step1 — 툴바 폰트 effect 배선(WriterPage canvas CSS 변수 --yh-editor-font-family/size 조건부 주입 + yonhap.css 변수화)` — `WriterPage.jsx`·`yonhap.css` + `WriterPage.test.jsx`.
- **chore**: `chore(44-editor-gap-closeout): step1 status — completed` — index.json step1.

## 금지사항

- `Editor.jsx`를 건드리지 마라. 이유: 검증된 래퍼-레벨 effect + CSS 변수 상속을 유지한다(내부 변경은 캐럿/크래시 회귀 위험).
- yonhap.css 하드코딩 `0.95rem`·상속 `var(--yh-sans)`를 그냥 삭제하지 마라. 반드시 `var(--yh-editor-font-size, 0.95rem)`·`var(--yh-editor-font-family, var(--yh-sans))` fallback으로 보존. 이유: 변수 미주입 경로(`'기본'`)에서 현재 렌더를 지켜 회귀를 막는다.
- 폰트를 `'기본'`에도 무조건 주입하지 마라(조건부 주입). 이유: `fontFamilyCss('기본')===null`이며, 무조건 주입하면 빈/무효 변수 엣지가 생기고 fallback 경로가 죽는다.
- 폰트를 `onPrefsClose` 게이트에 얹지 마라. 이유: 폰트는 툴바 즉시-반영 컨트롤이라 uiLanguage 직접-저장이 맞다 — 다이얼로그에 폰트 컨트롤이 없어 재동기화가 불필요하고 이원화만 생긴다.
- `articleDetail.js` 등 다른 폰트를 변수화하지 마라. 이유: 범위는 에디터 표시 폰트뿐 — 발행 렌더까지 바꾸면 회귀 표면이 커진다.
- 기존 테스트를 깨뜨리지 마라.
