# Step 2: find-replace-wiring — 찾기/바꾸기 + 전체 선택 결선 (WriterPage)

## 배경 / 요구사항

Step 0 엔진(`editorFind`)과 Step 1 다이얼로그(`FindReplaceDialog`)를 WriterPage에 결선해 실제로 동작하게 한다.

- **Ctrl+F**(`isFindReplace`) → 찾기/바꾸기 다이얼로그 열기(브라우저 기본 찾기 가로채기).
- **편집 메뉴 > 찾기/바꾸기**(`edit.findReplace`) → 다이얼로그 열기.
- **편집 메뉴 > 전체 선택**(`edit.selectAll`, Ctrl+A) → 에디터 본문 전체 선택.
- 다이얼로그 콜백을 Step 0 엔진 + **기존 안전 본문 경로**(`updateField('body', serialize(...))` + `setPendingCaretLine`)에 연결한다.

phase 8/9의 메뉴 결선 패턴(`MENU_ENABLED` enabledIds, `onMenuSelect` 라우팅)을 **그대로 확장**한다 — 새 결선 항목 id를 `MENU_ENABLED`에 추가하고 `onMenuSelect`에 분기를 추가한다.

## 읽어야 할 파일

- `/CLAUDE.md`, `/docs/ARCHITECTURE.md`, `/docs/ADR.md` — view 결선, ADR-003
- `/docs/news.md` — "기사 에디터"(찾기/바꾸기·Ctrl+F), "## 기사 상단 메뉴바"(편집>찾기/바꾸기·전체 선택)
- `web/src/view/editorFind.js` — **Step 0 결과**: `isFindReplace`(Ctrl+F), `findMatches`, `nextMatchIndex`, `replaceOne`, `replaceAll`.
- `web/src/view/FindReplaceDialog.jsx` — **Step 1 결과**: props 계약(`open`/`matchCount`/`activeIndex`/`onQueryChange`/`onFindNext`/`onFindPrev`/`onReplaceOne`/`onReplaceAll`/`onClose`).
- `web/src/view/WriterPage.jsx` — 결선 지점:
  - `MENU_ENABLED`(L53, 현재 결선 8항목 배열) — 여기에 `'edit.findReplace'`, `'edit.selectAll'` 추가.
  - `onMenuSelect(id)`(L166~191) — `if (isMapping) return;` 가드 뒤에 `edit.findReplace`/`edit.selectAll` 분기 추가(기존 (끝)/(계속)/대소문자 분기 패턴 따름). 단 **찾기 다이얼로그 열기는 매핑 모드에서도 허용**할지 결정: 매핑은 텍스트 잠금이므로 찾기(읽기)는 무해하나 바꾸기는 본문 변경 → **매핑 모드에서는 다이얼로그를 열지 않는다**(혼란 방지·단순화. `help.preferences`처럼 매핑 가드 앞에 두지 말고 가드 뒤에 둔다).
  - `onKeyDown(e)`(L195~222) — Alt+Y/Ctrl+Y 분기와 같은 **상단**(라인삭제 조기 return L207 이전)에 `isFindReplace(e)` 분기 추가: `e.preventDefault()`(브라우저 Ctrl+F 가로채기) 후 다이얼로그 열기.
  - `blocks`(L110), `body`(L109), `updateField`, `setSpell`, `lastCaretRef`(L113), `setPendingCaretLine`(L115), `isMapping`(L107).
  - `<EditorPrefsDialog open={showPrefs} .../>`(L415) 배치 — 같은 자리에 `<FindReplaceDialog .../>`를 둔다.
  - `Editor`(L329~341) — `<Editor>`에 `onKeyDown`/`pendingCaretLine`이 어떻게 전달되는지 확인(추가 prop 불필요).
- `web/src/view/editorContent.js` — `blocksToText`(검색 기준 텍스트), `serialize`(본문 직렬화), `deserialize`.
- `web/src/view/editorCaret.js` — `lineAtOffset`(매치 오프셋 → 텍스트-줄 환산, 캐럿 이동용).
- `web/src/view/WriterPage.test.jsx` — 기존 회귀 기준 + 신규 단언 위치(setup/openWith 헬퍼·fakeModel 사용 패턴).
- `web/src/view/EditorMenuBar.test.jsx` — `enabledIds` 활성/비활성 단언 패턴(회귀 기준).

## 작업

TDD로 진행한다(vitest). **`Editor.jsx`는 절대 수정하지 마라** — 모든 본문 변경은 WriterPage의 기존 안전 경로(`updateField('body', serialize(...))` + 필요 시 `setPendingCaretLine`)로만 한다.

### 1. 다이얼로그 상태 + 결선 (`WriterPage.jsx`)

- 상태 추가: `const [showFind, setShowFind] = useState(false);` + 찾기 컨트롤 상태(`findQuery`/`findCase`/`activeIndex`). 매치는 `findMatches(blocksToText(blocks), findQuery, { caseSensitive: findCase })`로 렌더 중 파생 계산(메모이즈 권장, 단 effect/타이머 금지).
- `MENU_ENABLED`에 `'edit.findReplace'`, `'edit.selectAll'` 추가.
- `onMenuSelect`에 분기 추가(매핑 가드 `if (isMapping) return;` **뒤**):
  - `id==='edit.findReplace'` → `setShowFind(true)`.
  - `id==='edit.selectAll'` → 전체 선택(아래 2번).
- `onKeyDown` 상단(Alt+Y/Ctrl+Y 분기와 같은 위치)에:
  - `if (isFindReplace(e)) { e.preventDefault(); if (!isMapping) setShowFind(true); return; }` — 매핑이어도 브라우저 Ctrl+F는 막되(preventDefault) 다이얼로그는 안 연다.
- `<FindReplaceDialog>` 배치(EditorPrefsDialog 옆):
  ```jsx
  <FindReplaceDialog
    open={showFind}
    matchCount={matches.length}
    activeIndex={activeIndex}
    onQueryChange={(q, { caseSensitive }) => { setFindQuery(q); setFindCase(caseSensitive); setActiveIndex(matchesFor(q, caseSensitive).length ? 0 : -1); }}
    onFindNext={...}
    onFindPrev={...}
    onReplaceOne={(rep) => onReplaceOne(rep)}
    onReplaceAll={(rep) => onReplaceAll(rep)}
    onClose={() => setShowFind(false)}
  />
  ```

### 2. 찾기/바꾸기 동작 핸들러 (`WriterPage.jsx`)

- **다음/이전 찾기**: `nextMatchIndex(matches, fromOffset, { forward })`로 다음 활성 인덱스를 구해 `setActiveIndex`하고, 그 매치 `start` 오프셋이 속한 텍스트-줄을 `lineAtOffset(blocksToText(blocks), match.start).lineIndex`로 구해 `setPendingCaretLine(textLine)`으로 그 줄에 캐럿을 옮긴다(기존 임베드/마커 삽입과 동일한 포커스 가로채기 경로). 줄 안 정확 컬럼 선택까지는 이번 범위 밖(줄 시작 캐럿 — `focusLineStart` 한계, 단순화). `fromOffset`은 현재 활성 매치 끝(없으면 `lastCaretRef.current ? lastCaretRef.current.offset : 0`).
- **바꾸기(replaceOne)**: `replaceOne(blocks, findQuery, replacement, { caseSensitive: findCase, fromOffset })` → `r.replaced`면 `updateField('body', serialize(r.blocks))` + `typeof r.caretOffset==='number'`면 그 오프셋의 텍스트-줄로 `setPendingCaretLine`. 매치 없으면 no-op.
- **모두 바꾸기(replaceAll)**: `replaceAll(blocks, findQuery, replacement, { caseSensitive: findCase })` → `r.count>0`면 `updateField('body', serialize(r.blocks))`. 다이얼로그는 열린 채 유지(현황 갱신). `setActiveIndex(-1)`로 리셋(텍스트가 바뀌어 기존 매치 무효).
- **빈 query no-op**: `findQuery`가 빈 문자열이면 다음/이전/바꾸기 모두 no-op(엔진이 보장하지만 핸들러에서도 일찍 return 권장).
- **매핑 가드**: 바꾸기·모두 바꾸기는 `if (isMapping) return;`로 본문 변경을 차단한다(텍스트 잠금 불변식 — 다이얼로그가 매핑에서 안 열리지만 방어).

### 3. 전체 선택 (`WriterPage.jsx`)

전체 선택(`edit.selectAll`, Ctrl+A)은 본문을 바꾸지 않는 **선택 연산**이다. 두 경로 중 하나를 택하라(둘 다 Editor.jsx 무변경):

- (선호) **Ctrl+A는 브라우저 기본 동작에 위임**한다 — 에디터가 포커스된 상태에서 Ctrl+A는 브라우저가 contentEditable 전체를 선택한다. 따라서 `onKeyDown`에서 Ctrl+A를 **가로채지 마라**(추가 분기 없음 — 기존 라인삭제 조기 return이 Ctrl+A를 그냥 통과시킴). 메뉴 `edit.selectAll`은 에디터 포커스가 빠진 상태라 브라우저 기본이 안 먹으므로, 메뉴 클릭 시에는 에디터 root를 찾아(rootRef 없음 → `document.querySelector('.yh-editor')`) `el.focus()` 후 `document.execCommand('selectAll')` 또는 `Range`로 전체 선택한다. 이는 **선택만** 바꿀 뿐 본문/DOM 구조를 바꾸지 않으므로 Editor 불변식과 무관하다(contentEditable 텍스트 변경 아님).
  - selectAll 동작은 작은 view 헬퍼(예: `web/src/view/editorSelect.js`의 `selectAllInEditor(root)`)로 분리해 단위 테스트하라(jsdom에서 selection API 검증). 직접 DOM 텍스트를 바꾸지 말 것.

핸들러 선택의 트레이드오프를 step 구현 시 주석으로 남겨라(왜 브라우저 위임 + 메뉴는 명시 selectAll인지).

## 핵심 규칙 (반드시 준수 — 위반 시 반려)

1. **에디터 불변식**: `Editor.jsx`를 수정하지 마라(phase 5/8/9). 본문 변경(바꾸기)은 전부 `updateField('body', serialize(...))` + `setPendingCaretLine`의 **기존 안전 경로**로만 — contentEditable 텍스트/DOM을 직접 조작하지 마라. (전체 선택은 *선택만* 바꾸는 예외 — 본문 텍스트/블록을 바꾸지 않으므로 허용.)
2. **id 일관(namespaced)**: 기존 `EDITOR_MENUS`의 id(`edit.findReplace`, `edit.selectAll`)를 그대로 쓴다. 새 id를 만들거나 라벨로 매칭하지 마라 — 과거 검수에서 id 불일치가 BLOCKER였다.
3. **Ctrl+F preventDefault**: 브라우저 기본 찾기와 충돌하므로 반드시 `e.preventDefault()`. Alt+Y/Ctrl+Y/Ctrl+D/Backspace/Delete 기존 분기는 불변. `isFindReplace`는 `!altKey`라 Alt 조합을 오인하지 않는다.
4. **매핑 보호**: 매핑 모드에서 바꾸기/모두 바꾸기로 본문이 바뀌지 않게 한다(본문-only 불변식). 다이얼로그도 매핑에서 열지 않는다.
5. **하위호환**: `EditorMenuBar`에 `enabledIds` 계약(미전달 시 전부 비활성)은 불변. 활성 항목 외(예: `edit.cut`, `table.insert`)는 계속 비활성.
6. **회귀 금지**: 기존 onKeyDown(Alt+Y/Ctrl+Y/Ctrl+D/Backspace/Delete)·임베드 삽입·타이핑·메뉴 열고닫기·(끝)/(계속)/대소문자/복구/환경설정 결선 불변.

## Acceptance Criteria

```bash
npm run test:web    # web 전체 통과 (찾기/바꾸기/전체선택 결선 + 기존 회귀)
npm run build
npm run lint
```

추가 단언(vitest):
- WriterPage: Ctrl+F keydown 시 다이얼로그(`role="dialog"` '찾기/바꾸기')가 열리고 `preventDefault`가 호출된다.
- WriterPage: 편집 메뉴 '찾기/바꾸기'(`edit.findReplace`) 클릭 시 다이얼로그가 열린다. 편집 메뉴 '전체 선택'(`edit.selectAll`)은 활성이다(`EditorMenuBar` enabledIds 단언).
- WriterPage: 다이얼로그에서 find-query='foo' 입력 후 '모두 바꾸기'(replacement='X') 클릭 시 본문의 모든 'foo'가 'X'로 바뀐다(`updateField('body', …)` 직렬화 본문 검증). 임베드 블록 위치·내용 불변.
- WriterPage: '바꾸기'(replaceOne) 클릭 시 첫 매치만 치환된다.
- WriterPage(매핑 모드): 매핑 탭에서 Ctrl+F는 다이얼로그를 열지 않고(`preventDefault`만), 메뉴 '찾기/바꾸기' 클릭도 다이얼로그를 열지 않으며 `updateField('body', …)`가 호출되지 않는다.
- WriterPage: 빈 query로 바꾸기/모두 바꾸기 클릭 시 본문 무변경(`updateField('body', …)` 미호출).
- editorSelect(있으면): `selectAllInEditor(root)`가 jsdom에서 root 내용을 selection으로 잡는다(본문 텍스트 무변경).
- 회귀: Alt+Y '(끝)', Ctrl+Y '(계속)', Ctrl+D/Backspace/Delete 라인삭제, 대소문자 변환, 복구/환경설정 결선 불변. `edit.cut`/`table.insert`는 여전히 비활성.

## 검증 절차

1. 위 AC 커맨드를 실행한다.
2. 아키텍처 체크리스트: view 결선(ADR-003), 에디터 무변경(본문은 안전 경로), id 일관, 매핑 보호, 회귀 없음.
3. 결과에 따라 `phases/14-editor-find-context/index.json`의 step 2를 업데이트(성공 → completed + summary / 3회 실패 → error / 개입 필요 → blocked).

## 금지사항

- `Editor.jsx`를 수정하지 마라. 이유: phase 5/8/9 타이핑/IME/캐럿/remount 불변식. 바꾸기는 body 직렬화 경로로만.
- contentEditable 텍스트/DOM/블록을 직접 조작하지 마라(바꾸기). 이유: 타이핑/캐럿 회귀. (전체 선택의 selection 조작은 본문 텍스트 무변경이므로 예외 — 단 본문을 바꾸지 마라.)
- 새 메뉴 id를 만들거나 라벨 문자열로 매칭하지 마라. 이유: id 불일치 BLOCKER 전력.
- 매핑 모드에서 본문을 바꾸지 마라. 이유: 본문-only 불변식.
- 활성 항목 외 메뉴를 활성화하지 마라(미구현 액션). 기존 테스트(phase 8/9 회귀)를 깨뜨리지 마라.
