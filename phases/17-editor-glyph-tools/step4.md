# Step 4: glyph-input-wiring — 약물입력(Alt+O) 다이얼로그 결선 (WriterPage)

## 배경 / 요구사항

Step 3 다이얼로그(`GlyphInputDialog`)를 WriterPage에 결선해 **메뉴/우클릭/단축키(Alt+O)로 약물입력을 열고**, 약물 선택 시 캐럿 위치에 삽입(Step 0 `insertGlyphAtCaret` + 안전 경로)되게 한다. 약물바(Step 2)와 약물 삽입 핸들러를 공유한다.

결선해야 할 진입점(news.md):
- **Alt+O**(L173 우클릭 '약물입력 Alt+O') → 약물입력 다이얼로그 열기(키 핸들러).
- **도구 메뉴 > 약물 입력**(`tools.symbolInput`, EditorMenuBar) → 다이얼로그 열기.
- **우클릭 컨텍스트 메뉴 > 약물입력**(`ctx.symbolInput`, EditorContextMenu) → 다이얼로그 열기.
- (선택) 툴바 '약물입력'(`tool.symbolInput`, EditorToolBar) — 툴바는 현재 전부 비활성 쉘이다. 툴바 결선은 **범위 밖**으로 두고(쉘 유지), 메뉴·우클릭·Alt+O만 결선한다. 약물바 토글(Step 2)·툴바 '약물입력'의 정합은 "약물입력 다이얼로그 = 약물바와 동일 약물 소스(glyphFavorites)"로 충족된다.

WriterPage는 **공유 파일**이다 — Step 2 다음 순차 실행 전제. Step 2에서 만든 약물 삽입 핸들러(`onGlyphPick`)와 자주쓰는 약물 state를 재사용한다. phase14의 찾기 다이얼로그 결선(`showFind`/`openFind`, `onKeyDown` 상단 `isFindReplace` 분기, `onMenuSelect`/`onCtxSelect` 라우팅)과 **동일한 패턴**을 확장한다.

## 읽어야 할 파일

- `/CLAUDE.md`, `/docs/ARCHITECTURE.md`, `/docs/ADR.md` — view 결선, ADR-003.
- `/docs/news.md` — L155·L173·L180(약물입력 진입점), L206~209.
- `web/src/view/editorGlyph.js` — **Step 0**: `insertGlyphAtCaret(blocks, caret, glyph)`.
- `web/src/view/GlyphInputDialog.jsx` — **Step 3**: props 계약 `{ open, favorites, keymap, onPick, onClose }`, `data-testid="glyph-input"`.
- `web/src/view/WriterPage.jsx` — 결선 지점(Step 2 적용 후 상태):
  - **Step 2에서 추가된** `onGlyphPick(glyph)` 핸들러 + `glyphFavorites` state(자주쓰는 약물) — 재사용. `glyphKeymap`도 필요하면 동일 패턴으로 읽는다(`loadEditorPrefs().glyphKeymap.items`, 마운트 + `onPrefsClose(applied)` 갱신).
  - `MENU_ENABLED`(L59, 결선 메뉴 id 배열) — `'tools.symbolInput'` 추가(EditorMenuBar 도구>약물 입력 활성화).
  - `onMenuSelect(id)`(L250~280) — 매핑 가드 위치 고려해 `id === 'tools.symbolInput'` → 다이얼로그 열기 분기 추가. 찾기(`edit.findReplace`)와 동일하게 **매핑에서는 열지 않는다**(약물 삽입은 본문 변경 → 매핑 본문-only 불변식). `help.preferences`처럼 매핑 가드 앞이 아니라 **뒤**에 둔다.
  - `ctxEnabledIds`(L287) — 현재 `ctx.symbolInput`은 aux placeholder(항상 비활성, L286·L321 주석). 비매핑일 때 활성화하도록 `...(isMapping ? [] : ['ctx.symbolInput'])`(또는 기존 cut/copy/paste 배열에 합류) 추가. 매핑에서는 비활성 유지.
  - `onCtxSelect(id)`(L299~324) — `case 'ctx.symbolInput': if (!isMapping) <다이얼로그 열기>; break;` 추가(찾기 `ctx.findReplace`와 동일 가드).
  - `onKeyDown(e)`(L328~362) — `isFindReplace`(Ctrl+F) 분기와 같은 **상단**(라인삭제 조기 return 이전)에 Alt+O 분기 추가: `e.preventDefault()` 후 비매핑이면 다이얼로그 열기. (Alt+O 인식 함수는 아래 4번 참조.)
  - `showFind`/`openFind`/`<FindReplaceDialog .../>`(L139·154·568) — **참고 패턴**: `showGlyphInput` state + `<GlyphInputDialog .../>`를 같은 자리(FindReplaceDialog 옆)에 둔다.
  - `lastCaretRef`(L130), `setPendingCaretLine`(L132), `isMapping`(L124), `blocks`/`body`/`updateField`.
- `web/src/view/EditorMenuBar.jsx` — `tools.symbolInput`(도구>약물 입력) id 확인(L89). 새 id 만들지 말 것.
- `web/src/view/EditorContextMenu.jsx` — `ctx.symbolInput`(약물입력 Alt+O) id 확인(L18). 새 id 만들지 말 것.
- `web/src/view/editorShortcuts.js` / `web/src/view/editorFind.js` — **참고 패턴**: 키 인식 함수(`isInsertEndMarker`·`isFindReplace` — `e.altKey`/`e.code` 함께 봄). Alt+O 인식 함수를 같은 컨벤션으로 만든다.
- `web/src/view/WriterPage.test.jsx` — 기존 회귀 기준 + 신규 단언 위치(phase14 Ctrl+F/메뉴/우클릭 결선 테스트 패턴).

## 작업

TDD로 진행한다(vitest). **`Editor.jsx`는 절대 수정하지 마라** — `<Editor>`에 신규 입력/키 prop 추가 금지. 약물 삽입은 Step 2의 안전 경로(`onGlyphPick` → `updateField`+`setPendingCaretLine`)로만.

### 1. Alt+O 키 인식 함수

`editorGlyph.js`(Step 0 모듈)에 키 인식 함수를 추가하거나, 그게 부적절하면 작은 view 헬퍼로 둔다(`editorShortcuts.js`의 `isInsertEndMarker` 컨벤션 따름 — 순수 함수, DOM 비의존):

```js
// Alt+O — 약물입력. 레이아웃 무관하게 code(KeyO)도 본다. ctrl/meta 없이 alt만.
export function isGlyphInput(e) {
  return !!(e && e.altKey && !e.ctrlKey && (e.key === 'o' || e.key === 'O' || e.code === 'KeyO'));
}
```

(Alt+Y `isInsertEndMarker`와 충돌하지 않는다 — key가 다름.)

### 2. 다이얼로그 상태 + 진입점 결선 (`WriterPage.jsx`)

- 상태 추가: `const [showGlyphInput, setShowGlyphInput] = useState(false);` + 열기 헬퍼(예: `openGlyphInput`).
- `MENU_ENABLED`에 `'tools.symbolInput'` 추가.
- `onMenuSelect`에 분기(매핑 가드 **뒤**): `if (id === 'tools.symbolInput') { setShowGlyphInput(true); return; }`.
- `ctxEnabledIds`에 비매핑 시 `'ctx.symbolInput'` 추가. `onCtxSelect`에 `case 'ctx.symbolInput': if (!isMapping) setShowGlyphInput(true); break;` 추가.
- `onKeyDown` 상단(`isFindReplace` 분기와 같은 위치)에: `if (isGlyphInput(e)) { e.preventDefault(); if (!isMapping) setShowGlyphInput(true); return; }`.
- `<GlyphInputDialog>` 배치(FindReplaceDialog 옆):
  ```jsx
  <GlyphInputDialog
    open={showGlyphInput}
    favorites={glyphFavorites}
    keymap={glyphKeymap}
    onPick={(glyph) => { onGlyphPick(glyph); /* 닫기 정책은 Step 3 컴포넌트 주석과 일치시킨다 */ }}
    onClose={() => setShowGlyphInput(false)}
  />
  ```
- 약물 선택 시 삽입은 **Step 2의 `onGlyphPick`을 재사용**한다(중복 핸들러 만들지 말 것). 다이얼로그를 약물 선택 후 닫을지(`setShowGlyphInput(false)`)는 Step 3 컴포넌트의 닫기 정책과 일치시킨다.

### 3. 약물 데이터 주입

- `favorites`는 Step 2의 `glyphFavorites` state(자주쓰는 약물) 재사용. `keymap`은 `glyphKeymap` state(`loadEditorPrefs().glyphKeymap.items`, 마운트 + `onPrefsClose(applied)` 갱신 — `glyphFavorites`와 동일 게이트). keymap은 **참조 표시용**(Step 3에서 표시만).

## 핵심 규칙 (반드시 준수 — 위반 시 반려)

1. **에디터 불변식**: `Editor.jsx`를 수정하거나 `<Editor>`에 신규 prop을 추가하지 마라(phase 5/8/9/14). 약물 삽입은 Step 2 안전 경로(`onGlyphPick`)로만 — contentEditable/DOM 직접 조작 금지. 이유: 타이핑/IME/캐럿/remount 회귀.
2. **id 일관(namespaced)**: 기존 id(`tools.symbolInput`, `ctx.symbolInput`)를 그대로 쓴다. 새 id를 만들거나 라벨로 매칭하지 마라. 이유: 과거 검수에서 id 불일치가 BLOCKER였다.
3. **Alt+O preventDefault**: 키 분기에서 `e.preventDefault()`. 기존 onKeyDown 분기(`isFindReplace`/Alt+Y/Ctrl+Y/Ctrl+D/Backspace/Delete)는 불변 — Alt+O는 그 위(라인삭제 조기 return 이전)에 둔다. `isGlyphInput`은 `!ctrlKey`라 다른 조합을 오인하지 않는다. 이유: Alt+O가 라인삭제 분기에 삼켜지지 않게.
4. **매핑 보호**: 매핑 모드에서 약물입력 다이얼로그를 열지 않고(찾기와 동일), 열려도 `onGlyphPick`이 매핑에서 no-op이다(Step 2 가드). 이유: 본문-only 불변식.
5. **키조합 인터셉트 금지**: keymap은 다이얼로그에 참조 표시만. 타이핑 중 keys를 가로채 glyph로 치환하는 로직을 만들지 마라(Editor 키 핸들러 미접촉). 이유: 이번 phase 명시적 DEFER.
6. **client 전용 + editorPrefs 읽기 전용**: `server/`를 건드리지 말고 glyphFavorites/glyphKeymap은 읽기만. 이유: DB 비파괴, phase16 스키마 그대로.
7. **회귀 금지**: 찾기/바꾸기(Ctrl+F·메뉴·우클릭)·전체 선택·약물바(Step 2)·검색 임베드·타이핑·Alt+Y/Ctrl+Y/Ctrl+D·복구/환경설정 결선 불변. 비결선 메뉴/툴바 항목은 계속 비활성(`edit.cut`/`table.insert`/툴바 `tool.symbolInput` 등).

## Acceptance Criteria

```bash
npm run test:web    # web 전체 통과 (약물입력 결선 + 기존 회귀)
npm run build
npm run lint
```

추가 단언(vitest, `WriterPage.test.jsx`):
- Alt+O keydown 시 약물입력 다이얼로그(`role="dialog"` '약물 입력', `data-testid="glyph-input"`)가 열리고 `preventDefault`가 호출된다.
- 도구 메뉴 '약물 입력'(`tools.symbolInput`) 클릭 시 다이얼로그가 열린다(`EditorMenuBar` enabledIds 활성 단언).
- 우클릭 컨텍스트 메뉴 '약물입력'(`ctx.symbolInput`)이 비매핑에서 활성이고 클릭 시 다이얼로그가 열린다(매핑에서는 비활성).
- 자주쓰는 약물 prefs(`glyphFavorites.items: ['※']`) 시드 후 다이얼로그에서 '※' 클릭 시 본문에 '※'가 삽입된다(`updateField('body', …)` 직렬화 검증, Step 0 좌표). 임베드 위치 불변.
- 사용자 키보드 약물(`glyphKeymap.items: [{keys:'Ctrl+1', glyph:'★'}]`)이 다이얼로그에 참조 표시된다(`Ctrl+1 → ★`).
- 매핑 모드: Alt+O·메뉴 '약물 입력'이 다이얼로그를 열지 않고(또는 비활성) `updateField('body', …)`가 호출되지 않는다.
- 회귀: 찾기/바꾸기(Ctrl+F·메뉴·우클릭), 전체 선택, 약물바 토글/삽입(Step 2), 검색 임베드, Alt+Y/Ctrl+Y/Ctrl+D 불변. `edit.cut`/`table.insert`/툴바 비활성 유지.

## 검증 절차

1. 위 AC 커맨드를 실행한다(필요 시 `PYTHONUTF8=1`).
2. 아키텍처 체크리스트: 에디터 무변경(안전 경로), id 일관, 매핑 보호, 키조합 인터셉트 부재, server 무변경, editorPrefs 읽기 전용, 회귀 없음.
3. `git status`로 `server/` 변경이 없음을 확인한다.
4. 결과에 따라 `phases/17-editor-glyph-tools/index.json`의 step 4를 갱신(completed+summary / error / blocked).

## 금지사항

- `Editor.jsx`를 수정하거나 `<Editor>`에 신규 prop을 추가하지 마라. 이유: 타이핑/IME/캐럿/remount 불변식.
- 새 메뉴/우클릭 id를 만들거나 라벨로 매칭하지 마라. 이유: id 불일치 BLOCKER 전력.
- 매핑 모드에서 약물입력으로 본문을 바꾸지 마라(다이얼로그도 열지 마라). 이유: 본문-only 불변식.
- 타이핑 중 keymap keys를 가로채 glyph로 치환하는 로직을 만들지 마라. 이유: 키조합 인터셉트는 명시적 DEFER.
- `server/` 디렉터리를 수정하지 마라. 이유: 약물은 client localStorage 전용, DB 비파괴.
- 툴바(EditorToolBar)를 활성화하거나 다른 비결선 메뉴를 활성화하지 마라. 이유: 쉘 유지, 미구현 액션은 비활성(회귀 금지).
