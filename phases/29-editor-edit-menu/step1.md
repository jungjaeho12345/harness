# Step 1: selection-appliers — 줄/단어/문단 선택 DOM 헬퍼

## 이 step의 목표

에디터 본문의 **줄/단어/문단 선택**을 실제 DOM Selection으로 잡는 얇은 view 헬퍼 3개를 `editorSelect.js`에 추가한다. 기존 `selectAllInEditor(root)`의 **선례를 그대로 확장**한다 — `.yh-editor` 루트 element를 받아 `window.getSelection` + `Range`만으로 선택하고, **본문 텍스트/DOM 구조는 절대 바꾸지 않는다**. Editor.jsx는 접촉하지 않는다(선택은 컴포넌트 외부에서 공개 DOM(`.yh-editor__line`)만으로 가능 — `selectAllInEditor`가 이미 그렇게 한다).

이 헬퍼들은 **경계 계산을 하지 않는다.** 호출부(step 2 WriterPage)가 `editorRange`(step 0)로 계산한 구체 좌표(줄 인덱스·컬럼·줄 범위)를 넘긴다. 이 파일은 그 좌표로 Range만 세팅하는 "덤(dumb) 적용기"다.

## 읽어야 할 파일

먼저 아래를 읽고 설계 의도를 파악하라:

- `/CLAUDE.md`, `/docs/ARCHITECTURE.md`, `/docs/ADR.md` — 순수 view 로직, zero-dep, TDD.
- `/docs/news.md` — L167("삭제/이동/선택은 항상 가능"), L175(우클릭 '전체 선택' 등), L178(편집 메뉴: 문단/한줄/단어 선택).
- `web/src/view/editorSelect.js` — **수정 대상 · 선례**. `selectAllInEditor(root)`(전체 선택: `root.focus()` → `document.createRange()` → `range.selectNodeContents(root)` → `sel.removeAllRanges(); sel.addRange(range)`). 신규 3함수는 이 패턴을 따르되 선택 범위만 좁힌다.
- `web/src/view/editorSelect.test.js` — **수정 대상 · 테스트 선례**. jsdom에서 `sel.rangeCount`·`sel.toString()`·`root.innerHTML` 불변으로 검증하는 방식. 신규 함수 테스트를 여기(또는 동일 스타일 신규 파일)에 추가한다.
- `web/src/view/Editor.jsx` — **읽기 전용(수정 금지)**. 본문이 `<div class="yh-editor__line">{block.text}</div>` 구조(1 텍스트 블록 = 1 `.yh-editor__line`, 텍스트는 그 div의 첫 텍스트 노드)로 렌더됨을 확인하라. `readCaret`(약 105행)이 `.yh-editor__line` 순서를 lineIndex 기준으로 쓰는 것과 동일한 공개 구조다.
- `web/src/view/WriterPage.test.jsx` — `caretAtLine`/`focusCaretAtLine` 헬퍼(약 405·2192행)에서 `.yh-editor__line`에 Range를 setStart/selectNodeContents로 거는 jsdom 패턴(테스트 작성 참고).

## 작업 (TDD — 테스트 먼저)

`web/src/view/editorSelect.js`에 아래 시그니처로 3함수를 추가한다(default export는 기존대로 유지). 구현은 재량, 계약·엣지는 반드시 만족.

```js
// 지정 텍스트-줄(.yh-editor__line[lineIndex]) 내용 전체를 선택한다.
export function selectLineInEditor(root, lineIndex) { ... }

// 지정 텍스트-줄의 [colStart, colEnd) 문자 범위(줄-로컬 char 오프셋)를 선택한다.
// colStart === colEnd(빈 범위)면 선택하지 않는다(no-op — 단어 없음 신호).
export function selectWordInEditor(root, lineIndex, colStart, colEnd) { ... }

// startLine..endLine(포함)의 텍스트-줄들을 하나의 범위로 선택한다.
export function selectParagraphInEditor(root, startLine, endLine) { ... }
```

### 계약 / 엣지 (반드시 준수)

- **본문/DOM 무변경**: `selectAllInEditor`와 동일하게 selection API만 쓴다. `document.execCommand`·textContent/innerHTML 대입·노드 추가/삭제 금지.
- **포커스**: 각 함수는 시작에서 `root.focus()`(있으면)를 호출해 메뉴 클릭으로 빠진 포커스를 되돌린다(선택 가시화 — `selectAllInEditor`와 동일).
- **방어적 no-op(예외 금지)**: `root`가 null/`.yh-editor__line` 없음/`lineIndex` 범위 밖/텍스트 노드 없음(빈 줄)일 때 조용히 return(throw 금지). `lineIndex`·`startLine`·`endLine`은 존재하는 줄 개수로 clamp한다.
- **줄 선택**: `lineEls[lineIndex]`에 `range.selectNodeContents(lineEl)`.
- **단어 선택**: 대상 줄의 첫 텍스트 노드(`lineEl.firstChild`, nodeType 3)에 `range.setStart(tnode, colStart)` / `range.setEnd(tnode, colEnd)`. 텍스트 노드가 없거나(빈 줄) `colStart===colEnd`면 no-op. `colStart/colEnd`는 텍스트 노드 길이로 clamp.
- **문단 선택**: `startLine`~`endLine` 스팬. `range.setStartBefore(lineEls[startLine])` / `range.setEndAfter(lineEls[endLine])`(또는 동등한 setStart/ setEnd). `startLine > endLine`이면 swap 또는 no-op.
- 순수 selection 조작이라 매핑/읽기전용과 무관하다(호출부가 게이트를 판단 — 이 파일은 게이트를 두지 않는다).

### 테스트(먼저 작성) — 최소 케이스 (editorSelect.test.js 스타일)

- `beforeEach`로 `.yh-editor` + 여러 `.yh-editor__line` div를 DOM에 심는다(기존 테스트와 동일).
- selectLineInEditor: 지정 줄 텍스트가 `sel.toString()`에 잡히고 **다른 줄은 안 잡힘**; `root.innerHTML` 불변.
- selectWordInEditor: 한 줄 `'hello world'`에서 컬럼 2(colStart=0,colEnd=5) 선택 시 `sel.toString() === 'hello'`; 빈 범위(colStart===colEnd)면 선택 없음(`rangeCount` 무변 또는 collapsed).
- selectParagraphInEditor: 연속 2줄을 startLine..endLine로 선택 시 두 줄 텍스트 모두 `sel.toString()`에 포함; DOM 불변.
- null root / 범위 밖 lineIndex → throw 없음, DOM/선택 무변경.
- 한글 줄(예: `'첫째 줄'`) 케이스 1개 포함(UTF-8).

## Acceptance Criteria

```bash
npm run test:web    # editorSelect 신규 3함수 테스트 + 기존 selectAll 회귀 통과 (vitest)
npm run build
npm run lint
```

## 검증 절차

1. 위 AC 커맨드를 실행한다.
2. 아키텍처 체크리스트: selection API만 사용(DOM 텍스트/구조 무변경) 확인? `selectAllInEditor` 선례와 동형? `Editor.jsx` 미접촉? zero-dep·DB 비파괴?
3. 결과에 따라 `phases/29-editor-edit-menu/index.json`의 step 1을 업데이트:
   - 성공 → `"status": "completed"`, `"summary": "요약"`
   - 3회 실패 → `"status": "error"`, `"error_message"`
   - 개입 필요 → `"status": "blocked"`, `"blocked_reason"` 후 중단

## 금지사항

- `Editor.jsx`를 수정하지 마라. 이유: 선택은 공개 DOM(`.yh-editor__line`)만으로 컴포넌트 외부에서 가능하며(`selectAllInEditor` 선례), Editor 내부를 건드리면 phase 5/8/20 타이핑·remount 불변식이 깨진다.
- `document.execCommand`·contentEditable 텍스트 조작·innerHTML/textContent 대입을 하지 마라. 이유: 본문/DOM을 바꾸면 선택 연산이 아니라 편집이 되어 타이핑·직렬화 경로와 충돌한다.
- 경계(단어/문단) 계산을 이 파일에서 다시 구현하지 마라. 이유: 계산은 `editorRange`(step 0) 단일 출처다. 이 파일은 좌표를 받아 Range만 건다 — 중복 로직은 step 3(삭제/정렬)와 정의가 갈라진다.
- 매핑/권한 게이트를 이 파일에 넣지 마라. 이유: 게이트 판단은 호출부(WriterPage)다. 헬퍼는 순수 적용기로 유지한다.
- 새 npm 의존성 추가·기존 테스트 파괴 금지.
