# Step 2: glyph-bar-wiring — 약물바 결선 + 표시/숨김 토글 실동작 (WriterPage)

## 배경 / 요구사항

Step 0 순수 헬퍼(`editorGlyph.insertGlyphAtCaret`)와 Step 1 표시 컴포넌트(`EditorGlyphBar`)를 WriterPage에 결선해 약물바를 **실제로 동작**하게 한다.

- 약물바는 자주쓰는 약물(`loadEditorPrefs().glyphFavorites.items`)을 버튼으로 렌더한다.
- 약물 버튼 클릭 → 현재 캐럿 위치(`statusCaret`/`lastCaretRef` `{lineIndex, offset}`)에 약물을 삽입한다(**기존 안전 경로**: `updateField('body', serialize(...))` + `setPendingCaretLine`).
- 약물바 표시/숨김 토글을 **실동작화**한다. 현재 WriterPage의 `showGlyphBar`는 placeholder(우클릭 `ctx.showGlyphBar` 토글만 동작, 실제 바 미렌더 — L86~88, L307 주석 "범위 밖")다. 이번 step에서 `showGlyphBar && <EditorGlyphBar .../>`로 실제 바를 렌더하고, phase14에서 만든 우클릭 '약물바 보이기'(`ctx.showGlyphBar`) 토글이 이 바를 켜고 끄게 한다.

WriterPage는 **공유 파일**이다 — Step 4와 순차 실행 전제(이 step 먼저). phase14의 메뉴바/툴바 토글(`showMenuBar`/`showToolBar` + `EditorMenuBar`/`EditorToolBar` 렌더)·검색 임베드 삽입(`insertEmbed`)·찾기 결선(`focusMatchLine`)과 **동일한 결선 패턴**을 확장한다.

## 읽어야 할 파일

- `/CLAUDE.md`, `/docs/ARCHITECTURE.md`, `/docs/ADR.md` — view 결선, ADR-003, 계층 분리.
- `/docs/news.md` — L173("약물바 보이기"), L206~209(자주쓰는 약물).
- `web/src/view/editorGlyph.js` — **Step 0 결과**: `insertGlyphAtCaret(blocks, caret, glyph)` → `{ blocks, caretTextLine }`. 삽입 계산은 전부 이 함수로.
- `web/src/view/EditorGlyphBar.jsx` — **Step 1 결과**: props 계약 `{ items, onPick }`, `data-testid="glyph-bar"`.
- `web/src/view/WriterPage.jsx` — 결선 지점(현재 상태):
  - `showGlyphBar`/`setShowGlyphBar` state(L88, 현재 placeholder — 주석 "실제 바는 렌더하지 않는다").
  - `ctx.showGlyphBar` 토글: `ctxEnabledIds`(L287)에 이미 포함, `ctxCheckedIds`(L292)에 `showGlyphBar` 반영됨, `onCtxSelect`의 `case 'ctx.showGlyphBar': setShowGlyphBar((v) => !v); break;`(L308) — 토글 자체는 이미 동작. 이 step은 **실제 바 렌더만 추가**.
  - `statusCaret` state(L83) + `lastCaretRef`(L130) — 캐럿 `{lineIndex, offset}` 소스. `onCaretChange={(c) => { lastCaretRef.current = c; setStatusCaret(c); }}`(L489).
  - `insertEmbed`/`insertEmbedAtLine`(L373~385) — **참고 패턴**: 마지막 캐럿 줄에 삽입 + `setPendingCaretLine`. 약물 삽입도 동일한 캐럿 소스(`lastCaretRef.current`)를 쓴다.
  - `blocks`(L126), `body`(L126), `updateField`, `setPendingCaretLine`(L132), `isMapping`(L124).
  - 에디터 크롬 배치(L441~466): `{showMenuBar && <EditorMenuBar .../>}`, `{showToolBar && <EditorToolBar />}` — 같은 자리(툴바 아래, 캔버스 위)에 `{showGlyphBar && <EditorGlyphBar .../>}`를 둔다.
  - `loadEditorPrefs`(import L21) — `loadEditorPrefs().glyphFavorites.items`로 자주쓰는 약물을 읽는다.
- `web/src/view/editorContent.js` — `serialize`, `deserialize`, `blocksToText`.
- `web/src/view/WriterPage.test.jsx` — 기존 회귀 기준 + 신규 단언 위치(`setup`/`openWith` 헬퍼, `saveEditorPrefs`로 prefs 시드, `fireEvent`/`userEvent`). 특히 phase8/14 토글 테스트(`toggle-menubar`)·우클릭 컨텍스트 메뉴 테스트(`editor-context-menu`) 패턴.

## 작업

TDD로 진행한다(vitest). **`Editor.jsx`는 절대 수정하지 마라** — 약물 삽입은 WriterPage의 기존 안전 경로(`updateField('body', serialize(...))` + `setPendingCaretLine`)로만. `<Editor>`에 신규 prop을 추가하지 마라.

### 1. 약물바 렌더 + 토글 실동작 (`WriterPage.jsx`)

- 자주쓰는 약물을 읽어 약물바에 주입한다. 색상 prefs(`editorBg`/`columnLimit`/`autosaveCfg`)와 동일 게이트 패턴으로:
  - **초기값은 `useState` lazy 초기화로만 읽는다**: `const [glyphFavorites, setGlyphFavorites] = useState(() => loadEditorPrefs().glyphFavorites.items);`. **마운트용 useEffect를 새로 추가하지 마라** — lazy 초기화로 충분하다(`autosaveCfg` state와 동일 패턴).
  - 갱신은 **기존 `onPrefsClose(applied)` 분기에 `setGlyphFavorites(loadEditorPrefs().glyphFavorites.items)` 한 줄만 추가**한다(색상/autosave prefs 재로딩 `setAutosaveCfg(loadEditorPrefs().autosave)`와 **동일 위치·동일 패턴**). 환경설정에서 약물 등록 후 즉시 바에 반영하기 위함. 별도 effect/구독을 만들지 마라.
- 크롬 배치(툴바 아래, 캔버스 위)에 약물바를 추가한다. 매핑 가드(§2 이중 방어)를 포함한 권장 형태: `{showGlyphBar && !isMapping && <EditorGlyphBar items={glyphFavorites} onPick={onGlyphPick} />}`(매핑 모드에서는 바 미렌더).
- `showGlyphBar`의 placeholder 주석(L86~88, L307)을 실동작 주석으로 갱신한다(더 이상 "범위 밖"/"미렌더" 아님 — `showMenuBar`/`showToolBar`와 동일하게 레이아웃 토글).

### 2. 약물 삽입 핸들러 (`WriterPage.jsx`)

```js
// 약물바 약물 클릭 → 마지막 캐럿 위치에 약물 삽입(검색 임베드 insertEmbed와 동일 캐럿 소스).
const onGlyphPick = (glyph) => {
  if (isMapping) return;                       // 매핑 모드(텍스트 잠금)에서는 본문 변경 금지 — no-op.
  const caret = lastCaretRef.current;          // {lineIndex, offset} 또는 null
  const r = insertGlyphAtCaret(blocks, caret, glyph);
  updateField('body', serialize(r.blocks));
  if (typeof r.caretTextLine === 'number') setPendingCaretLine(r.caretTextLine);
};
```

- 캐럿 소스는 `lastCaretRef.current`(검색 임베드 삽입과 동일 — 약물바 버튼 클릭으로 에디터 포커스가 빠지므로 라이브 `readCaret` 대신 보관된 캐럿을 쓴다). caret이 null이면 Step 0 헬퍼가 폴백(줄 끝)으로 처리한다.
- 본문 변경은 전부 `updateField('body', serialize(...))`. 캐럿 이동은 `setPendingCaretLine`(임베드/마커 삽입과 동일 포커스 경로). **contentEditable/DOM 직접 조작 금지.**
- **매핑 가드(이중 방어 권장)**: `isMapping`이면 약물 삽입이 본문을 바꾸지 못하게 한다(본문-only 불변식 — 매핑은 임베드만 변경). **두 가드를 둘 다** 적용하는 것을 권장한다:
  1. 약물바 숨김: `{showGlyphBar && !isMapping && <EditorGlyphBar items={glyphFavorites} onPick={onGlyphPick} />}` — 매핑 모드에서는 바 자체를 렌더하지 않는다.
  2. 핸들러 no-op: `onGlyphPick` 첫 줄 `if (isMapping) return;` — 바가 어떤 이유로든 렌더돼도 본문 변경을 차단(방어적 중복).
  이중 방어가 부담되면 둘 중 하나만 적용해도 불변식은 만족하나, 권장은 둘 다이다. 어느 쪽이든 주석으로 이유를 남겨라. 블로커는 아니다.

## 핵심 규칙 (반드시 준수 — 위반 시 반려)

1. **에디터 불변식**: `Editor.jsx`를 수정하지 마라(phase 5/8/9/14). `<Editor>`에 신규 입력/키 prop을 추가하지 마라. 약물 삽입은 `updateField('body', serialize(...))` + `setPendingCaretLine` 안전 경로로만 — contentEditable 텍스트/DOM을 직접 조작하지 마라. 이유: 타이핑/IME/캐럿/remount 회귀.
2. **안전 삽입 경로 재사용**: 새 삽입 메커니즘을 만들지 마라. Step 0 `insertGlyphAtCaret`로 블록을 계산하고 기존 `updateField`+`setPendingCaretLine`만 쓴다(phase9 (계속)·phase14 바꾸기와 동일). 이유: 검증된 경로만 사용.
3. **매핑 보호**: 매핑 모드에서 약물 삽입으로 본문이 바뀌지 않게 한다(본문-only 불변식). 이유: 매핑은 임베드만 변경.
4. **editorPrefs 읽기 전용**: `loadEditorPrefs().glyphFavorites.items`를 **읽기만** 한다. glyphFavorites/glyphKeymap 구조·기본값·loadEditorPrefs 병합을 수정하지 마라(스키마 변경 불필요). 이유: phase16 스키마 그대로.
5. **client 전용**: `server/` 디렉터리를 건드리지 마라(DB 비파괴, 약물은 client localStorage 전용). 이유: 이 phase는 client만.
6. **회귀 금지**: 기존 토글(`showMenuBar`/`showToolBar`)·우클릭 컨텍스트 메뉴·찾기/바꾸기·검색 임베드 삽입·타이핑·Alt+Y/Ctrl+Y/Ctrl+D 불변. `ctx.showGlyphBar` 토글의 기존 테스트를 깨지 마라(이제 실제 바가 렌더된다는 점만 반영).
   - **stale testid 교정(반드시 반영)**: `WriterPage.test.jsx`의 기존 '약물바 보이기' 토글 테스트(현재 L1770~1785, 테스트명 "…실제 바 없음…", L1784에서 `container.querySelector('[data-testid="glyphbar"]')`(하이픈 **없음**)가 `toBeNull()`임을 단언)는 **잘못된 셀렉터로 거짓 통과**한다 — step1 실제 컴포넌트(`EditorGlyphBar.jsx`)의 testid는 `glyph-bar`(하이픈 **있음**)이므로, step2가 바를 렌더해도 `glyphbar`(하이픈 없음) 셀렉터는 항상 `null`이라 단언이 거짓으로 통과해 회귀를 못 잡는다. 이 테스트를 **갱신**한다: ⓐ 잘못된 `[data-testid="glyphbar"]`(하이픈 없음) 셀렉터 단언을 제거하고, ⓑ 토글 ON 시 `getByTestId('glyph-bar')`(하이픈 **있음**)로 **약물바가 렌더됨**을 단언, ⓒ 다시 OFF 시 약물바가 사라짐을 단언한다. 기존 `aria-checked` 토글 상태 단언(L1776/L1783)은 **유지**한다. 테스트명·주석의 "실제 바 없음/미렌더"도 "실제 바 렌더/숨김"으로 갱신한다.
   - 근거(한 줄): 이는 "기존 테스트를 깨는 것"이 아니라 **stale testid(`glyphbar`)로 거짓 통과하던 단언을 올바른 testid(`glyph-bar`)로 교정**하고 단언 방향을 step2 동작(바 렌더)에 맞게 뒤집는 것이다.

## Acceptance Criteria

```bash
npm run test:web    # web 전체 통과 (약물바 결선 + 기존 회귀)
npm run build
npm run lint
```

추가 단언(vitest, `WriterPage.test.jsx`):
- **기존 '약물바 보이기' 토글 테스트 갱신(반드시 — stale testid 교정)**: 현재 L1770~1785의 테스트(테스트명 "…실제 바 없음…")에서 L1784의 잘못된 `container.querySelector('[data-testid="glyphbar"]')`(하이픈 **없음**) `toBeNull()` 단언을 **제거**하고, 토글 ON 시 `getByTestId('glyph-bar')`(하이픈 **있음**)로 **약물바가 렌더됨**을, 다시 OFF 시 약물바가 사라짐(`queryByTestId('glyph-bar')` → `toBeNull()`)을 단언한다. 기존 `aria-checked` 토글 상태 단언(off→`false`, 재오픈 시 on→`true`)은 **유지**한다. 테스트명·주석의 "실제 바 없음/미렌더" 문구도 "실제 바 렌더/숨김"으로 갱신한다. (근거: stale testid `glyphbar`로 거짓 통과하던 단언을 올바른 testid `glyph-bar`로 교정하고 step2 동작에 맞게 방향을 뒤집는 것 — §6 참조.)
- 자주쓰는 약물 prefs(`saveEditorPrefs`로 `glyphFavorites.items: ['※','◇']` 시드)로 진입 후 우클릭 '약물바 보이기'(`ctx.showGlyphBar`)를 켜면 약물바(`data-testid="glyph-bar"`, 하이픈)가 보이고 약물 버튼 2개가 나타난다. 다시 끄면 사라진다.
- 본문 블록을 가진 기사로 진입 → 에디터에 캐럿을 두고(또는 `onCaretChange`로 `lastCaretRef` 세팅) 약물바의 '※' 버튼 클릭 시, `updateField('body', …)`로 직렬화된 본문에 '※'가 삽입된다(Step 0 헬퍼 좌표 기준). 임베드 블록 위치·내용 불변.
- 매핑 모드(`mode:'mapping'`)에서는 약물 클릭이 본문을 바꾸지 않는다(`updateField('body', …)` 미호출 또는 약물바 미표시).
- 등록된 약물이 없을 때(`glyphFavorites.items: []`) 약물바를 켜면 버튼 0개로 graceful.
- 회귀: `toggle-menubar`/`toggle-toolbar` 토글, 우클릭 컨텍스트 메뉴 항목, 찾기/바꾸기, 검색 임베드 삽입, Alt+Y/Ctrl+Y/Ctrl+D 불변.

## 검증 절차

1. 위 AC 커맨드를 실행한다(필요 시 `PYTHONUTF8=1`).
2. 아키텍처 체크리스트: 에디터 무변경(안전 경로), 매핑 보호, editorPrefs 읽기 전용, server 무변경, 회귀 없음.
3. `git status`로 `server/` 변경이 없음을 확인한다(client 전용).
4. 결과에 따라 `phases/17-editor-glyph-tools/index.json`의 step 2를 갱신(completed+summary / error / blocked).

## 금지사항

- `Editor.jsx`를 수정하거나 `<Editor>`에 신규 prop을 추가하지 마라. 이유: 타이핑/IME/캐럿/remount 불변식.
- contentEditable 텍스트/DOM/블록을 직접 조작하지 마라. 이유: 안전 경로(updateField+serialize+setPendingCaretLine)만 사용.
- 매핑 모드에서 본문을 바꾸지 마라. 이유: 본문-only 불변식.
- editorPrefs.js의 glyphFavorites/glyphKeymap 구조·기본값·병합을 수정하지 마라. 이유: phase16 스키마 그대로 읽기만.
- `server/` 디렉터리를 수정하지 마라. 이유: 약물은 client localStorage 전용, DB 비파괴.
- 키조합 인터셉트(타이핑 중 keys → glyph 자동치환)를 구현하지 마라. 이유: Editor 키 핸들러 변경 필요 → 이번 phase 명시적 DEFER.
