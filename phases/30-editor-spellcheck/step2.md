# Step 2: spell-wiring — WriterPage 결선(맞춤법 메뉴 5종 + 환경설정 effect)

## 배경 / 요구사항

Step 0 엔진(`editorSpell.js`)과 Step 1 다이얼로그(`SpellCheckDialog.jsx`)를 `WriterPage.jsx`에 결선한다. 에디터 "맞춤법" 메뉴 5종을 활성화하고, 환경설정 맞춤법 탭(`checkOption`/`errorTypes`/`errorStyle`)이 검사 동작에 실제로 반영되게 한다. 본문은 **안전 경로 외 조작 없음**(검사는 읽기전용 — 본문/캐럿/임베드를 바꾸지 않고, 항목 클릭 시 캐럿 이동만).

메뉴 5종(EditorMenuBar `spell.*` id) → 검사 범위(scope) 매핑:

| 메뉴 id | 라벨(news.md) | scope | 동작 |
|---|---|---|---|
| `spell.checkAll` | 통합 맞춤법 검사 | `'all'` | 전체 본문 검사 → 결과 다이얼로그 |
| `spell.checkParagraph` | 문단식 검사 | `'paragraph'` | 캐럿 문단만 검사 |
| `spell.checkToCaret` | 현재위치까지 검사 | `'toCaret'` | 본문 시작~캐럿 검사 |
| `spell.checkFromCaret` | 현재위치부터 검사 | `'fromCaret'` | 캐럿~본문 끝 검사 |
| `spell.checkOff` | 통합 맞춤법 검사 안함 | — | 검사 해제(결과 비우고 다이얼로그 닫기) |

환경설정 반영: 검사 실행 시점에 `loadEditorPrefs().spellcheck`를 읽어 `activeRuleGroups(prefs)`로 활성 규칙군을 정하고(`checkOption`+`errorTypes` 합집합), `errorStyle`을 다이얼로그에 넘겨 오류 조각 스타일에 반영한다.

## 읽어야 할 파일

- `/CLAUDE.md`, `/docs/ARCHITECTURE.md`, `/docs/ADR.md` — 프론트 MVC, ADR-003(view는 transport 직접 호출 금지 — 단 editorPrefs/editorSpell은 view 모듈이라 직접 호출 무방).
- `/docs/news.md` L180(맞춤법 메뉴), L212~213(오류 유형/표현).
- `web/src/view/WriterPage.jsx` — **결선 대상**. 아래 기존 지점을 반드시 파악:
  - `MENU_ENABLED` 상수(L80) — 결선된 메뉴 항목 배열(여기에 `spell.*` 5종 추가).
  - `onMenuSelect(id)`(L415~) — 메뉴 라우팅. **매핑 가드(`if (isMapping) return;`, L434) 앞의 읽기전용 항목들**(fileInfo/memo/historyCompare)이 어떻게 배치됐는지 — 맞춤법도 읽기전용이라 같은 위치(매핑 가드 앞)에 둔다.
  - `focusMatchLine(offset)`(L371~) — `lineAtOffset(bodyText, offset)` → `setPendingCaretLine(lineIndex)`. **항목 클릭 캐럿 이동에 그대로 재사용**한다(찾기 선례).
  - `bodyText`(L201, `blocksToText(blocks)`) — 엔진에 넘길 본문 텍스트.
  - `lastCaretRef`(L188) / `statusCaret`(L105) — 캐럿 offset 소스(scoped 검사용). `lastCaretRef.current`는 `{lineIndex, offset}` 또는 null.
  - 다이얼로그 렌더 영역(L861~963, `EditorPrefsDialog`~`EditorContextMenu`)과 표시 state 패턴(`showFileInfo`/`fileInfoStats` 등) — 여기 옆에 `SpellCheckDialog`를 추가.
  - `onPrefsClose`(L170~) — 환경설정 적용 게이트(참고만; 맞춤법은 검사 실행 시점에 `loadEditorPrefs`를 읽으므로 별도 state 동기화 불필요).
- `web/src/view/editorSpell.js` — Step 0 산출물. `activeRuleGroups`/`spellRange`/`checkSpelling` 시그니처.
- `web/src/view/SpellCheckDialog.jsx` — Step 1 산출물. props 계약(`open`/`issues`/`errorStyle`/`onSelect`/`onClose`).
- `web/src/view/editorPrefs.js` — `loadEditorPrefs().spellcheck` shape.
- `web/src/view/EditorMenuBar.jsx` — `spell.*` 5개 id 확인(L60~68).
- `web/src/view/WriterPage.test.jsx` — **결선 테스트 본보기**. `setup()`/`createFakeModel`, `openTopMenu(name)` 헬퍼(메뉴바 숨김 → 우클릭 '메뉴바 보이기' → 상단 메뉴 클릭), `saveEditorPrefs`로 prefs 주입, `openWith(blocks)`로 편집 진입. 맞춤법 테스트도 이 헬퍼들을 쓴다.

## 작업

TDD로 진행한다(vitest+RTL, 테스트 먼저 — `WriterPage.test.jsx`에 맞춤법 describe 추가). `WriterPage.jsx`만 수정(+ 필요 시 import).

### 1) 메뉴 활성화

`MENU_ENABLED`에 `'spell.checkAll'`, `'spell.checkParagraph'`, `'spell.checkToCaret'`, `'spell.checkFromCaret'`, `'spell.checkOff'` 5종을 추가한다.

### 2) 표시 state + 검사 실행 핸들러

- state: `showSpell`(bool), `spellIssues`(배열), `spellStyle`(`'bold'|'underline'`) — `showFileInfo`/`fileInfoStats` 패턴.
- 검사 실행 헬퍼(예: `runSpellCheck(scope)`):
  1. `const prefs = loadEditorPrefs().spellcheck;`
  2. `const groups = activeRuleGroups(prefs);`
  3. 캐럿 offset = `lastCaretRef.current ? lastCaretRef.current.offset : (statusCaret ? statusCaret.offset : 0)`.
  4. `const range = spellRange(bodyText, scope, caretOffset);`
  5. `const raw = checkSpelling(bodyText, { groups, range });`
  6. 각 이슈에 `snippet: bodyText.slice(issue.start, issue.end)`를 붙여 `spellIssues`로 세팅(Step 1이 snippet을 렌더).
  7. `setSpellStyle(prefs.errorStyle); setShowSpell(true);`
- 검사 해제 헬퍼(`spell.checkOff`): `setSpellIssues([]); setShowSpell(false);`

### 3) onMenuSelect 라우팅 (매핑 가드 **앞** — 읽기전용)

`onMenuSelect`에서 fileInfo/memo/historyCompare와 같은 위치(매핑 가드 `if (isMapping) return;` **앞**)에 분기 추가:
- `spell.checkAll` → `runSpellCheck('all')`
- `spell.checkParagraph` → `runSpellCheck('paragraph')`
- `spell.checkToCaret` → `runSpellCheck('toCaret')`
- `spell.checkFromCaret` → `runSpellCheck('fromCaret')`
- `spell.checkOff` → 검사 해제

이유: 맞춤법 검사는 본문/캐럿/임베드를 바꾸지 않는 읽기전용이라 매핑 모드에서도 동작해야 한다(죽은 버튼 방지 — fileInfo와 동일 정책).

### 4) 항목 클릭 → 캐럿 이동

`onSpellSelect(issue)`: `if (typeof issue.start === 'number') focusMatchLine(issue.start);` — 다이얼로그는 열린 채 유지(찾기 선례: 이동 후에도 패널 유지). 본문/직렬화 미호출.

### 5) 다이얼로그 렌더

다이얼로그 영역(예: `EditorContextMenu` 앞/뒤)에 추가:
```jsx
<SpellCheckDialog
  open={showSpell}
  issues={spellIssues}
  errorStyle={spellStyle}
  onSelect={onSpellSelect}
  onClose={() => setShowSpell(false)}
/>
```

## 핵심 규칙 (반드시 준수 — 위반 시 반려)

1. **Editor.jsx 미접촉**: `<Editor>` prop을 추가하거나 `Editor.jsx`를 수정하지 마라. 맞춤법 표시는 결과 다이얼로그로만 한다(인라인 하이라이트 금지 — contentEditable 타이핑 안정성/블록 불변식 보호). 이유: 모든 에디터 phase가 지켜온 Editor 미접촉 원칙.
2. **본문 불변(읽기전용 검사)**: 검사·항목 클릭 어느 경로도 `updateField('body', ...)`/`serialize`를 호출하지 마라. 캐럿 이동은 `focusMatchLine`(=`setPendingCaretLine`)만 쓴다. 이유: news.md 확정 정책(본문 자동 수정 금지) + 본문-only 불변식.
3. **매핑 가드 앞 배치**: `spell.*`는 `if (isMapping) return;` **앞**에 둔다(읽기전용이라 매핑에서도 열림). 이유: fileInfo/historyCompare와 동일 — 매핑 모드 죽은 버튼 방지.
4. **prefs는 실행 시점에 로드**: `runSpellCheck`에서 `loadEditorPrefs().spellcheck`를 읽는다(별도 state 미러/effect 불필요 — `insertDate`가 `loadEditorPrefs().dateFormat`을 실행 시점에 읽는 것과 동형). 이유: 환경설정 적용 즉시 다음 검사에 반영되고, 불필요한 구독/effect를 늘리지 않는다.
5. **네이티브 `spell` state와 혼동 금지**: 기존 `spell` state(L99)/`Editor`의 `spellcheck` prop(L779)은 **브라우저 네이티브 `spellCheck` 속성**(빨간 물결)이며 이 phase의 규칙 기반 검사와 무관하다. 이 값을 재사용하거나 바꾸지 마라. 이유: 서로 다른 기능 — 뒤섞으면 회귀.

## Acceptance Criteria

```bash
npm run test:web
npm run build
npm run lint
```

추가 단언(WriterPage.test.jsx, `openTopMenu`/`saveEditorPrefs` 사용 — 최소):
- 맞춤법 메뉴 5종이 활성(클릭 가능)이다(`spell.checkAll` 등 disabled 아님).
- `errorTypes.multiWord:true` prefs 저장 후, `'먹었다 먹었다'` 본문에서 `통합 맞춤법 검사` 클릭 → `spellcheck` 다이얼로그가 뜨고 중복 어절 이슈가 목록에 보인다.
- `errorStyle:'underline'` prefs 저장 후 검사 → 오류 조각이 밑줄(`data-style="underline"`)로 렌더된다.
- 오류가 없는 본문에서 검사 → `spellcheck-empty` 빈 상태가 보인다.
- `통합 맞춤법 검사 안함` 클릭 → 다이얼로그가 닫힌다(결과 비움).
- 결과 항목 클릭 → 본문/직렬화 변경 없이 캐럿만 이동한다(예: `updateField('body', ...)`가 호출되지 않음 — 본문 markupVersion 불변 확인).
- 매핑 모드(mode: 'mapping') 진입 시에도 `통합 맞춤법 검사`가 활성이고 다이얼로그가 열린다.

## 검증 절차

1. 위 AC 커맨드를 실행한다.
2. 아키텍처 체크: `Editor.jsx` 무변경(diff에 없음), 검사/항목클릭 경로에 `updateField('body')`/`serialize` 없음, `spell.*`가 매핑 가드 앞, prefs를 실행 시점 로드, 네이티브 `spell` state 미변경.
3. 회귀 체크: 기존 메뉴(찾기/전체선택/대소문자/약물/삽입 등)·매핑·자동저장·컬럼제한 테스트가 여전히 green.
4. 결과에 따라 `phases/30-editor-spellcheck/index.json`의 step 2를 업데이트(성공 → completed + summary / 3회 실패 → error / 개입 필요 → blocked).

## 금지사항

- `Editor.jsx`를 수정하거나 `<Editor>`에 prop을 추가하지 마라. 이유: 인라인 하이라이트는 contentEditable 타이핑 안정성·블록 불변식을 깬다 — 결과 다이얼로그로만 표시.
- 검사/항목 클릭에서 본문을 바꾸지 마라(`updateField('body')`/`serialize`/자동교체 금지). 이유: news.md 확정 정책(자동 수정 금지) + 본문-only 불변식. 캐럿 이동만 허용.
- `spell.*`를 매핑 가드(`if (isMapping) return;`) 뒤에 두지 마라. 이유: 읽기전용 검사가 매핑에서 죽은 버튼이 된다(fileInfo와 불일치).
- 기존 `spell` state / `Editor` `spellcheck` prop(브라우저 네이티브)을 재사용·변경하지 마라. 이유: 별개 기능 혼동 — 회귀.
- `top-level phases/index.json`을 수정하지 마라. 이유: 병렬 planner 충돌 — 오케스트레이터가 일괄 갱신한다.
- 기존 테스트를 깨뜨리지 마라.
