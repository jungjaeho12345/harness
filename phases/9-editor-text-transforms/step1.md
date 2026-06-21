# Step 1: text-transform-wiring — (계속)/대소문자/(끝) 메뉴·단축키 결선

## 배경 / 요구사항

Step 0에서 만든 순수 변환((계속) 마커·대소문자 4종)과 **기존 (끝)삽입**을 WriterPage의 키보드와 EditorMenuBar 항목에 결선해 실제로 동작하게 한다. phase 8의 메뉴 항목은 전부 비활성이었는데, 이 step에서 **결선 가능한 항목만 활성화**한다(나머지는 계속 비활성).

활성화 대상:
- 편집 > **(끝)삽입 (Alt+Y)** — 기존 `insertEndMarker` 결선(이미 키보드 Alt+Y로 동작 — 메뉴에서도 호출).
- 편집 > **(계속)삽입 (Ctrl+Y)** — Step 0 `insertContinueMarker`.
- 보기 > **대문자로 바꾸기 / 소문자로 바꾸기 / 첫글자 대문자로 / 대·소문자 전환** — Step 0 `transformTextLine` + 4 함수.

## 읽어야 할 파일

- `/CLAUDE.md`, `/docs/ARCHITECTURE.md`, `/docs/ADR.md` — view, ADR-003
- `/docs/news.md` — "## 기사 상단 메뉴바"(편집/보기 항목)
- `web/src/view/editorShortcuts.js` — **Step 0 결과**: `insertEndMarker`, `isInsertEndMarker`, `CONTINUE_MARKER`, `isInsertContinueMarker`, `insertContinueMarker`, `transformTextLine`, `toUpper/toLower/capitalizeFirst/toggleCase`.
- `web/src/view/WriterPage.jsx` — `onKeyDown`(약 **L87~111**: 기존 Alt+Y→`insertEndMarker`, Ctrl+D/Backspace/Delete 라인삭제), `blocks`(**L67**), `body`(**L66**), `updateField`, `setSpell`(L54), `pendingCaretLine`/`setPendingCaretLine`(**L72**), `lastCaretRef`(**L70**, Editor `onCaretChange`로 갱신되는 마지막 캐럿 `{lineIndex, offset}`), `<EditorMenuBar />` 배치(phase 8, 좌측 에디터 영역). Alt+Y 처리는 `updateField('body', serialize(...))`로 blocks를 갱신 + `setSpell(true)`로 맞춤법 on(Editor가 그 상태 변화로 재렌더되어 색칠) — 이 패턴을 그대로 따른다.
- `web/src/view/EditorMenuBar.jsx` — **phase 8 결과**. 항목이 어떻게 정의/렌더되는지(현재 전부 disabled) 읽고, 항목별 **안정적 id + 활성화 + onSelect** 결선을 추가한다.
- `web/src/view/EditorMenuBar.test.jsx`, `web/src/view/WriterPage.test.jsx` — 기존 테스트(회귀 기준) + 신규 단언 추가 위치.
- `web/src/view/editorCaret.js` — `lineAtOffset` 등(현재 캐럿 텍스트-줄 산출 참고).

## 작업

TDD로 진행한다(vitest).

### 1. EditorMenuBar 항목 활성화 (`web/src/view/EditorMenuBar.jsx`)

- **기존 `EDITOR_MENUS`의 항목 id를 그대로 쓴다 — 새 id를 부여하거나 config를 변형하지 마라.** 실제 id(namespaced)는: `edit.insertEnd`(L42, '(끝)삽입'), `edit.insertContinue`(L43, '(계속)삽입'), `view.toUpper`(L49), `view.toLower`(L50), `view.capitalize`(L51), `view.toggleCase`(L52).
- id↔onSelect 라우팅(`key={item.id}` L150, `onSelect(item.id)` L158)과 `onSelect` prop(L114)은 **phase 8에 이미 존재**한다. 필요한 변경은 **무조건 `disabled` 하드코딩(L156)을 조건부로 바꾸는 것뿐**이다:
  - 시그니처에 `enabledIds`만 추가: `EditorMenuBar({ onSelect, enabledIds })`. 컴포넌트 내부에서 배열/Set 모두 허용하도록 `const enabledSet = enabledIds instanceof Set ? enabledIds : new Set(enabledIds || []);`로 정규화.
  - L156을 `disabled={!enabledSet.has(item.id)}`로 교체. onClick은 활성일 때만 `onSelect(item.id)` 호출.
  - **`enabledIds` 미전달(undefined) 시 `enabledSet`이 비어 전 항목 disabled가 유지**된다(phase 8 하위호환 — 기존 `EditorMenuBar.test.jsx`의 '전부 disabled'·'onSelect 미호출' 단언 불변).
- 드롭다운 열고닫기 동작은 phase 8 그대로. 활성 6개 외 항목은 계속 비활성.

### 2. WriterPage 결선 (`web/src/view/WriterPage.jsx`)

- `<EditorMenuBar onSelect={onMenuSelect} enabledIds={MENU_ENABLED} />`로 배치를 갱신한다.
  `const MENU_ENABLED = ['edit.insertEnd','edit.insertContinue','view.toUpper','view.toLower','view.capitalize','view.toggleCase'];`
- **id→동작 매핑**: `view.toUpper`→`toUpper`, `view.toLower`→`toLower`, `view.capitalize`→`capitalizeFirst`, `view.toggleCase`→`toggleCase`, `edit.insertEnd`→insertEnd 핸들러, `edit.insertContinue`→insertContinue 핸들러.
- `onMenuSelect(id)` 핸들러:
  - **매핑 가드 먼저**: `if (isMapping) return;`(매핑 탭에서 메뉴 클릭으로 본문이 바뀌지 않게 — 텍스트 잠금 불변식). (대안: 매핑 시 `enabledIds`를 빈 배열로 넘겨 항목 전체 비활성. 둘 중 하나로 본문 변경을 확실히 차단하라.)
  - 현재 캐럿 텍스트-줄: `const caretLine = lastCaretRef.current ? lastCaretRef.current.lineIndex : null;` — **`lastCaretRef.current.lineIndex`는 이미 텍스트-줄(임베드 제외) 인덱스**이며 `insertEmbedAfterLine`과 동일 기준이다(블록 절대 인덱스로 변환하지 마라).
  - `edit.insertEnd` → **기존 Alt+Y onKeyDown 로직을 공용 핸들러로 추출해 재사용**(중복 금지): `insertEndMarker(blocks)` → `updateField('body', serialize(r.blocks))` + **`setSpell(true)`**(맞춤법 on — 메뉴 경로에서도 동일 부수효과 보장).
  - `edit.insertContinue` → `insertContinueMarker(blocks, caretLine)` → `updateField('body', serialize(r.blocks))`; `typeof r.caretTextLine==='number'`면 `setPendingCaretLine(r.caretTextLine)`.
  - 대소문자(`view.*`) → `caretLine==null`이면 no-op; 아니면 `transformTextLine(blocks, caretLine, fn)` → `updateField('body', serialize(r.blocks))` + `setPendingCaretLine(caretLine)`(같은 줄 유지). 변환 결과가 원문과 동일(이미 대문자 등)하면 본문 무변경 → remount/캐럿이동 없음(no-op 허용).
- `onKeyDown` **Ctrl+Y** 분기: `isInsertContinueMarker(e)`면 `e.preventDefault()`(브라우저 redo 가로채기) 후 insertContinue 핸들러 호출. **반드시 Alt+Y 분기와 같은 상단(라인삭제 조기 return `if(!ctrlD && key!==Backspace && key!==Delete) return;` 이전)에 둔다** — 그 return 아래에 두면 Ctrl+Y가 걸러져 안 탄다. 기존 Alt+Y·Ctrl+D·Backspace/Delete 분기는 불변(`isInsertEndMarker`는 `!ctrlKey` 가드라 Ctrl+Y를 Alt+Y로 오인하지 않음).
- 참고(메커니즘): 메뉴 클릭은 에디터 포커스가 빠지므로 `setPendingCaretLine`이 임베드 삽입과 동일하게 포커스를 가로채 해당 줄로 캐럿을 옮긴다(의도된 동작). 본문 갱신은 `updateField('body', serialize)`로 blocks를 바꾸고, (끝)삽입은 `setSpell` 상태 변화로 Editor가 재렌더되어 색이 칠해진다.

## 핵심 규칙 (반드시 준수 — 위반 시 반려)

1. **에디터 불변식**: `Editor.jsx`를 수정하지 마라. 변환은 모두 `updateField('body', serialize(...))` + (필요 시) `setPendingCaretLine`의 **기존 안전 경로**(Alt+Y/임베드 삽입과 동일)로만 본문을 바꾼다 — contentEditable/DOM을 직접 조작하지 마라.
2. **중복 금지(단일 소스)**: 기존 Alt+Y onKeyDown 로직과 메뉴 'insertEnd'가 같은 공용 핸들러를 쓰게 하라(두 곳에 insertEndMarker 호출을 복붙하지 마라).
3. **Ctrl+Y preventDefault**: (계속)삽입은 브라우저 redo와 충돌하므로 반드시 preventDefault. 단 Ctrl+Z 등 다른 단축키는 건드리지 마라(undo/redo는 이 phase 범위 아님).
4. **하위호환**: `EditorMenuBar`에 `enabledIds` 미전달 시 전부 비활성(phase 8 테스트 불변). 보기/편집의 **활성 6개 외 항목은 계속 비활성**.
5. **매핑 보호**: 매핑 모드에서 텍스트 변환/마커 삽입 불가(본문-only 불변식).
6. **회귀 금지**: 기존 onKeyDown(Alt+Y/Ctrl+D/Backspace/Delete)·임베드 삽입·타이핑·메뉴 열고닫기 불변.

## Acceptance Criteria

```bash
npm run test:web    # web 전체 통과 (메뉴 결선·Ctrl+Y·대소문자 단언 + 기존 회귀)
npm run build
npm run lint
```

추가 단언(vitest):
- EditorMenuBar: `enabledIds` 미전달 시 모든 항목 비활성(기존 phase 8 테스트 불변); `enabledIds=['edit.insertContinue']` 전달 시 그 항목만 활성·클릭하면 `onSelect('edit.insertContinue')` 호출.
- WriterPage: 보기>'대문자로 바꾸기'(`view.toUpper`) 클릭 시 캐럿 줄 텍스트가 대문자로 바뀐다(`updateField('body', …)` 갱신으로 검증 — 캐럿 위치는 jsdom 검증 곤란하므로 단언 제외).
- WriterPage: Ctrl+Y keydown 시 본문에 '(계속)' 삽입 + `preventDefault` 호출. 기존 Alt+Y로 '(끝)' 삽입, **Ctrl+D/Backspace/Delete 라인삭제는 불변**(Ctrl+Y 분기 추가가 회귀 없음).
- WriterPage(매핑 모드): 매핑 탭에서 메뉴 항목 클릭 시 `updateField('body', …)`가 호출되지 않는다(텍스트 잠금 가드).
- 활성 6개 외 항목(예: `table.insert`, `edit.findReplace`)은 여전히 비활성.

## 검증 절차

1. 위 AC 커맨드를 실행한다.
2. 아키텍처 체크리스트: view 결선(ADR-003), 에디터 무변경, 기존 안전 경로 재사용, 회귀 없음, 범위 준수.
3. 결과에 따라 `phases/9-editor-text-transforms/index.json`의 step 1을 업데이트:
   - 성공 → `"status": "completed"`, `"summary": "EditorMenuBar enabledIds/onSelect·WriterPage 핸들러((끝)/(계속)/대소문자)·Ctrl+Y 결선 요약"`
   - 3회 실패 → `"status": "error"`, `"error_message"`
   - 사용자 개입 필요 → `"status": "blocked"`, `"blocked_reason"` 후 중단

## 금지사항

- `Editor.jsx`를 수정하지 마라. 이유: phase 5/8 불변식. 변환은 body 직렬화 경로로만.
- contentEditable/DOM/selection을 직접 조작하지 마라. 이유: 타이핑/캐럿 회귀.
- undo/redo·정렬·선택연산을 결선/구현하지 마라(별도 phase).
- 활성 6개 외 메뉴 항목을 활성화하지 마라(미구현 액션). 이유: 동작 없는 항목이 활성으로 보이면 오작동.
- 기존 테스트(특히 phase 8 EditorMenuBar 전부-비활성, onKeyDown 회귀)를 깨뜨리지 마라.
