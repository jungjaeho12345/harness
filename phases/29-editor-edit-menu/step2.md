# Step 2: selection-wire — 문단/한줄/단어 선택 메뉴 결선

## 이 step의 목표

편집 메뉴의 **문단 선택(`edit.selectParagraph`) · 한줄 선택(`edit.selectLine`) · 단어 선택(`edit.selectWord`)** 3개를 WriterPage에 결선한다. 이들은 **선택(selection) 연산이라 본문을 바꾸지 않는다**. 그러나 같은 편집 메뉴의 형제 `edit.selectAll`이 **매핑 가드 뒤**에 있어 매핑 모드에서 no-op이므로, 신규 3종도 **매핑 가드 뒤**에 배치해 **매핑 모드에서 no-op**으로 맞춘다(메뉴 내 일관성·기존 selectAll 동작 무변경). 마지막 캐럿(`lastCaretRef`)이 없으면 no-op한다. 경계 계산은 step 0(`editorRange`), 실제 선택은 step 1(`editorSelect`)을 호출한다.

> 참고(범위 밖): 메뉴바 `edit.selectAll`(매핑 가드 뒤 → 매핑에서 no-op)과 우클릭 `ctx.selectAll`(가드 없음 → 매핑에서도 선택)의 기존 불일치는 이 phase 범위 밖이다. 신규 3종은 메뉴바 형제(`edit.selectAll`)와만 일관을 맞춘다.

## 읽어야 할 파일

먼저 아래를 읽고 설계 의도를 파악하라:

- `/CLAUDE.md`, `/docs/ARCHITECTURE.md`, `/docs/ADR.md` — 프론트 MVC, View 결선(ADR-003), TDD.
- `/docs/news.md` — L167("이동/선택은 항상 가능"), L178(편집 메뉴 문단/한줄/단어 선택).
- **이전 step 산출물(반드시 읽기):**
  - `web/src/view/editorRange.js` (step 0) — `wordBoundsAt(lineText, column)`, `paragraphBoundsAt(linesArr, lineIndex)`.
  - `web/src/view/editorSelect.js` (step 1) — `selectAllInEditor`, `selectLineInEditor(root, lineIndex)`, `selectWordInEditor(root, lineIndex, colStart, colEnd)`, `selectParagraphInEditor(root, startLine, endLine)`.
- `web/src/view/WriterPage.jsx` — **수정 대상**. 핵심 참조점:
  - `MENU_ENABLED`(약 80행) — 결선된 메뉴 id 배열. `edit.selectAll`이 이미 들어 있다. 여기에 3개를 **추가(append)** 한다.
  - `onMenuSelect(id)`(약 423행) — 라우팅 핸들러. `edit.selectAll` 분기(약 467행)가 **`if (isMapping) return;`(약 442행) 뒤**에 있음을 확인하라: `selectAllInEditor(document.querySelector('.yh-editor'))` — 즉 selectAll은 매핑 모드에서 no-op이다. 신규 3개도 **매핑 가드 뒤**(selectAll과 같은 위치, 매핑에서 no-op)에 둔다.
  - `lastCaretRef`(약 188행) — Editor `onCaretChange`로 갱신되는 마지막 캐럿 `{ lineIndex, offset }`(offset은 `blocksToText` 전역 오프셋). 메뉴 클릭은 에디터 포커스가 빠지므로 라이브 캐럿 대신 이 ref를 쓴다(기존 결선 규약).
  - `bodyText`(약 201행) = `blocksToText(blocks)` — 문단/단어 계산의 기준 텍스트.
  - `lineAtOffset`(import 약 46행, editorCaret.js) — `lineAtOffset(bodyText, offset)` → `{ lineIndex, start, end }`. 컬럼 = `offset - start`.
  - `focusMatchLine`/`insertEmbedAtLine` 등 기존 캐럿·본문 결선 관례.
- `web/src/view/WriterPage.test.jsx` — **수정 대상**. `focusCaretAtLine`(약 2192행: 캐럿을 줄에 두고 `keyUp`으로 `lastCaretRef` 갱신)·`caretAtLine` 헬퍼로 선택 단언을 추가한다.
- `web/src/view/EditorMenuBar.jsx` — `EDITOR_MENUS`의 `edit.selectParagraph`(L35)·`edit.selectLine`(L36)·`edit.selectWord`(L37) id 확인(새 id 부여 금지 — 기존 id 재사용).

## 작업 (TDD — 테스트 먼저)

### 1. MENU_ENABLED 확장

- `MENU_ENABLED`에 `'edit.selectParagraph'`, `'edit.selectLine'`, `'edit.selectWord'`를 **추가**한다(기존 항목 제거/재배치 금지 — 순수 append).

### 2. onMenuSelect 라우팅 (매핑 가드 뒤, selectAll과 동일 위치)

각 항목의 캐럿 소스는 `const caret = lastCaretRef.current;`. `caret`이 없으면 **no-op**(리턴). `const root = document.querySelector('.yh-editor');`.

- `edit.selectLine` → `selectLineInEditor(root, caret.lineIndex)`.
- `edit.selectWord` →
  - 컬럼 계산: `const { start } = lineAtOffset(bodyText, caret.offset); const column = caret.offset - start;`
  - 대상 줄 문자열: `const lineText = bodyText.split('\n')[caret.lineIndex] ?? '';`
  - 단어 범위: `const { start: colStart, end: colEnd } = wordBoundsAt(lineText, column);`
  - `selectWordInEditor(root, caret.lineIndex, colStart, colEnd);`(빈 범위면 step 1 헬퍼가 no-op).
- `edit.selectParagraph` →
  - `const { startLine, endLine } = paragraphBoundsAt(bodyText.split('\n'), caret.lineIndex);`
  - `selectParagraphInEditor(root, startLine, endLine);`
- **위치 규칙**: 반드시 `if (isMapping) return;`(약 442행) **뒤**, `edit.selectAll` 분기 근처에 둔다. 이유: 같은 편집 메뉴 형제 `edit.selectAll`이 가드 뒤(매핑에서 no-op)이므로 메뉴 내 일관성을 맞춘다(매핑 모드에서 신규 3종도 no-op). 선택이 본문을 안 바꿔도 위치는 selectAll과 동일하게 둔다 — 기존 selectAll 동작을 바꾸지 않는 최소 변경.

## 핵심 규칙 (반드시 준수 — 위반 시 반려)

1. **본문 무변경**: 이 3개 분기는 `updateField`/`serialize`/`setPendingCaretLine`을 **절대 호출하지 않는다**(순수 선택). 호출하면 본문-only 불변식과 선택 의미가 깨진다.
2. **매핑 가드 뒤**: selectAll과 동일하게 매핑 모드에서 no-op이다. 매핑 가드 앞에 두지 마라(메뉴 형제 selectAll과 비일관 발생).
3. **캐럿 소스**: 라이브 `readCaret`가 아니라 `lastCaretRef.current`를 쓴다(메뉴 클릭으로 포커스가 빠짐 — 기존 규약).
4. **경계 계산 재사용**: 단어·문단 경계는 `editorRange`(step 0)만 쓴다. WriterPage에서 `split`/정규식으로 직접 경계를 계산하지 마라(단일 출처).
5. **Editor.jsx 미접촉**.

## Acceptance Criteria

```bash
npm run test:web    # 선택 결선 단언 + 기존 회귀(selectAll·메뉴 열고닫기·타이핑) 통과 (vitest)
npm run build
npm run lint
```

추가 단언(vitest, WriterPage.test.jsx):
- `MENU_ENABLED` 확장으로 편집>'한줄 선택'/'단어 선택'/'문단 선택'이 **활성**이다(disabled 아님).
- 캐럿을 특정 줄/컬럼에 두고(`focusCaretAtLine` 등으로 `lastCaretRef` 갱신) 각 항목 클릭 시 `window.getSelection().toString()`이 기대 텍스트(그 줄 / 그 단어 / 그 문단)를 담는다. **본문(`updateField('body', …)`)은 호출되지 않는다**(선택-only 단언).
- 캐럿이 없을 때 클릭하면 예외 없이 no-op(본문·선택 무변경).
- **매핑 모드에서 선택 3종은 no-op**(매핑 가드 뒤, `edit.selectAll` parity) — 클릭해도 `window.getSelection()`·본문 무변경.
- 기존 `edit.selectAll`·다른 활성 항목·비활성 항목 상태 불변.

## 검증 절차

1. 위 AC 커맨드를 실행한다.
2. 아키텍처 체크리스트: View 결선(ADR-003)·본문 무변경·경계 계산 단일 출처(editorRange)·Editor 미접촉·회귀 없음.
3. 결과에 따라 `phases/29-editor-edit-menu/index.json`의 step 2를 업데이트(성공 completed·3회 실패 error·개입 blocked).

## 금지사항

- 이 3개 분기에서 `updateField`/`serialize`/`setPendingCaretLine`을 호출하지 마라. 이유: 선택 연산은 본문/캐럿 상태를 바꾸지 않는다 — 호출하면 매핑에서 본문 변경·불필요한 remount·dirty가 발생한다.
- 매핑 가드 앞에 두지 마라. 이유: 같은 편집 메뉴 형제 `edit.selectAll`이 가드 뒤(매핑에서 no-op)라 앞에 두면 메뉴 내 동작이 갈린다. 신규 3종은 selectAll과 동일하게 가드 뒤에 둔다(매핑 no-op). 메뉴바 vs 우클릭 ctx.selectAll의 기존 불일치는 이 phase 범위 밖이다.
- `Editor.jsx`·`editorSelect.js`·`editorRange.js`를 수정하지 마라. 이유: 이 step은 결선만이다. 헬퍼 결함이면 해당 step으로 되돌아가 고친다(레이어 격리).
- 단어/문단 경계를 WriterPage에서 직접 계산(정규식/수동 split 스캔)하지 마라. 이유: step 0과 정의가 갈라져 상태표시줄 단락번호·정렬과 불일치한다.
- `MENU_ENABLED` 기존 항목을 지우거나 순서를 바꾸지 마라. 이유: 다른 결선 회귀.
- 새 npm 의존성 추가·기존 테스트 파괴 금지.
