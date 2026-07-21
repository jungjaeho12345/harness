# Step 2: writer-spell-highlight-wiring

step0(세그먼트 모델)·step1(Editor 하이라이트 렌더 + 안전 캐럿/echo)을 `WriterPage.jsx`에 결선한다. **맞춤법 검사 실행 시 규칙엔진 이슈를 본문 하이라이트로 켜고, 편집/탭 전환/검사 해제 시 끈다.** 이 step은 `WriterPage.jsx` 한 모듈만 바꾼다(+ import). 하이라이트는 **표시 전용 state**이며 `commitBody`/직렬화/undo 경로를 절대 타지 않는다.

## 읽어야 할 파일

- `/CLAUDE.md`, `/docs/ARCHITECTURE.md`, `/docs/ADR.md`.
- `/docs/news.md` L184(맞춤법 메뉴 5종), L216~219(오류 표현 굵게/밑줄).
- `web/src/view/WriterPage.jsx` — **결선 대상**. 아래 기존 지점을 반드시 파악:
  - L183~188 맞춤법 표시 state(`showSpell`/`spellIssues`/`spellStyle`) — **여기 옆에 `spellHighlights` state 추가**. `spellStyle`(prefs.errorStyle)을 하이라이트 스타일로 **재사용**(단일 출처).
  - L243~258 **탭 전환 리셋 블록**(렌더 중 조정 — `lastCaretRef`/`statusCaret`/`showSpell`/`spellIssues`/`tableDialog`/`metaDialog` 비움). **여기에 `setSpellHighlights([])` 추가**(문서-로컬 좌표 이월 금지 — p30 spellIssues 계열).
  - L343~359 `commitBody(nextBody, {coalesce})` — **모든 본문 변경의 단일 choke point**(타이핑=onTextChange뿐 아니라 Ctrl+D·undo/redo·약물/날짜/임베드 삽입·대소문자/정렬/약어/표 변환이 전부 여기를 지난다). L234 `const body = activeTab.fields.body`(현재 렌더 body — 변경 전 값)가 클로저에 있어 `nextBody !== body`로 **실제 본문 변경**을 판별할 수 있다. **여기서 하이라이트를 클리어**한다(아래 §4).
  - L530~548 `runSpellCheck(scope)` — 검사 실행. `raw = checkSpelling(...)` 결과로 `spellIssues`(+snippet)·`spellStyle`을 세팅. **여기서 `spellHighlights`도 세팅**(raw의 start/end span).
  - L710~718 `spell.*` 메뉴 라우팅(매핑 가드 앞). L718 `spell.checkOff` — **여기서 하이라이트도 클리어**.
  - L1339~1351 `<Editor>` — **여기에 `spellHighlights`/`spellHighlightStyle` prop 추가**.
  - L10 `import { Editor, readCaret } from './Editor.jsx'`(이미 readCaret import — step1 span-aware 개선이 자동 반영).
- `web/src/view/Editor.jsx` — **step1 신규 props**(`spellHighlights`/`spellHighlightStyle`)와 표시전용 계약. (step1 요약이 프롬프트에 함께 전달된다.)
- `web/src/view/editorSpell.js` — `checkSpelling` 반환 `{start,end,...}`(하이라이트 span의 출처).
- `web/src/view/editorPrefs.js` — `spellcheck.errorStyle`('bold'|'underline') shape(레거시 그대로 소비).
- `web/src/view/WriterPage.test.jsx` — 결선 테스트 본보기: `setup()`/`createFakeModel`, `openTopMenu('맞춤법')`(메뉴바 숨김 → 우클릭 '메뉴바 보이기' → 상단 메뉴), `saveEditorPrefs`/`loadEditorPrefs`로 prefs 주입, 기존 phase 30 맞춤법 describe(오류 유형·errorStyle·checkOff·매핑) — 그 헬퍼/패턴을 그대로 쓴다.

## 배경 (자기완결)

phase 30이 이미 결선한 것(**건드리지 마라**): `runSpellCheck`가 `activeRuleGroups(prefs)`로 규칙군을 정하고 `checkSpelling`으로 이슈를 얻어 `SpellCheckDialog`에 `spellIssues`(+snippet)·`spellStyle`(errorStyle)을 넘겨 **결과 다이얼로그 조각을 굵게/밑줄로** 표시한다. 이 step은 그 **동일 이슈를 본문에도 하이라이트**로 추가한다 — 오프셋 span만 `Editor`에 넘기면 step1이 렌더한다. 검사 실행 시점에 `loadEditorPrefs().spellcheck`를 읽는 기존 방식(실행 시 로드)을 유지한다.

하이라이트는 **검사 시점 스냅샷**이므로 본문이 바뀌면 좌표가 무효다 → **실편집·탭 전환·검사 해제 시 비운다**(step1이 이 비움을 열-정확 복원 remount로 안전 처리). 클리어는 **본문 변경 choke point인 `commitBody`에서 `nextBody !== body`일 때만** 발동한다 — 이 한 지점이 타이핑/Enter/붙여넣기뿐 아니라 Ctrl+D·undo/redo·삽입 등 **모든 편집 경로**를 덮고, blur 재색칠(무편집·`nextBody===body`)은 통과시켜 하이라이트를 보존한다([low-1]). **IME 불변식**: `handleInput`의 `composingRef` 가드로 조합 중에는 `onTextChange→commitBody`가 발화하지 않으므로 클리어-remount는 `compositionend` 이후에만 일어난다(step1 "배경 — 안전 불변식" #5와 정합 — 조합 중 클리어 금지). 다이얼로그(`spellIssues`/`showSpell`)의 수명·초기화는 **phase 30 계약 그대로** 두고, 하이라이트만 별도 state로 얹는다.

## 작업 (TDD — 실패하는 테스트부터 작성한 뒤 구현)

`WriterPage.jsx`만 수정(+ 필요 시 import). 순수 state 추가 + 기존 4지점(runSpellCheck 세팅 / checkOff·commitBody·탭리셋 클리어)에 결선 + Editor prop 2개.

### 1) state

`spellIssues`(L187) 옆에: `const [spellHighlights, setSpellHighlights] = useState([]);` — `[{start,end}]`(표시 전용 span; 다이얼로그용 `spellIssues`와 별개 — 그쪽은 snippet/message 보유).

### 2) `runSpellCheck` — 하이라이트 켜기 (L535~548)

`raw = checkSpelling(...)` 뒤, 기존 `setSpellIssues`/`setSpellStyle` 옆에 추가:
```js
setSpellHighlights(raw.map((i) => ({ start: i.start, end: i.end })));
```
(범위검사(paragraph/toCaret/fromCaret)는 그 범위 이슈만 raw에 담기므로 하이라이트도 자동으로 그 범위만. `spellStyle`은 이미 `prefs.errorStyle`로 세팅됨 — 하이라이트 스타일로 그대로 재사용.)

### 3) `spell.checkOff` — 하이라이트 끄기 (L718)

기존 `setSpellIssues([]); setShowSpell(false);` 옆에 `setSpellHighlights([]);` 추가.

### 4) `commitBody` — 실편집 시 클리어 (L343~359)

`onTextChange`가 아니라 **본문 변경 choke point `commitBody`**에서 클리어한다(타이핑만 도는 onTextChange는 Ctrl+D·undo·삽입 등 비-onTextChange 편집을 놓쳐 stale 하이라이트가 남는다 — choke point가 모든 경로를 덮는다):

```js
const commitBody = (nextBody, { coalesce = false } = {}) => {
  updateField('body', nextBody);
  updateField('title', bodyTitle(nextBody));
  if (spellHighlights.length && nextBody !== body) setSpellHighlights([]); // 실편집 시 검사 스냅샷 무효화
  if (applyingHistoryRef.current) return;
  // …기존 히스토리 캡처 로직 불변…
};
```

- **`nextBody !== body` 게이트**(L234 현재 렌더 body): blur 재색칠 등 **무편집 커밋(nextBody===body)은 클리어를 통과**시켜 하이라이트를 보존한다([low-1] — 포커스만 이탈해도 사라지지 않음). `spellHighlights.length` 가드로 이미 빈 상태의 불필요 재렌더도 막는다.
- **위치**: `applyingHistoryRef` early-return **앞**에 둔다 → undo/redo 적용(본문 변경)도 클리어한다(옛 오프셋 무효).
- **불변식(undo 무접촉)**: `setSpellHighlights`는 표시 state — `commitBody`의 히스토리 캡처(`pushHistory`)/`updateField` 경로·인자를 **바꾸지 않는다**. 클리어 한 줄만 추가한다.
- **onTextChange는 불변**: `onTextChange(text, editedBlocks) → commitBody(serializeBodyFromBlocks(editedBlocks), { coalesce: true })` 그대로(별도 클리어 추가 없음 — commitBody가 담당).

### 5) 탭 전환 리셋 (L243~258)

`setSpellIssues([]);` 옆에 `setSpellHighlights([]);` 추가(문서-로컬 좌표 이월 금지).

### 6) `<Editor>` prop (L1339~1351)

```jsx
<Editor
  ...
  spellHighlights={spellHighlights}
  spellHighlightStyle={spellStyle}
/>
```
매핑/편집 양쪽에서 Editor가 렌더되며 하이라이트는 표시 전용이라 양쪽 무해(매핑은 `onTextChange=undefined`라 타이핑 클리어는 없지만 텍스트 편집 자체가 불가 — 탭 전환/재검사/checkOff로 클리어).

## Acceptance Criteria

```bash
npm run lint
npm run build
npm run test:web
```

(백엔드 무관 — `npm test`는 실행 불필요.)

## 검증 절차

1. 위 AC 커맨드를 실행한다.
2. `WriterPage.test.jsx`에 아래를 **TDD로** 추가(`openTopMenu('맞춤법')`/`saveEditorPrefs` 사용):
   - `errorStyle:'bold'`(기본)로 오탈자 포함 본문에서 `통합 맞춤법 검사` → 본문에 `.yh-editor__spell--bold` 하이라이트가 오류 텍스트에 보인다(+ 기존대로 다이얼로그도 뜬다).
   - `errorStyle:'underline'` prefs → 하이라이트가 underline 클래스.
   - `통합 맞춤법 검사 안함`(checkOff) → 본문 하이라이트 제거(`.yh-editor__spell` 0개).
   - **실편집 클리어(타이핑)**: 검사 후 본문 타이핑(onInput 시뮬레이션 → onTextChange → commitBody) → 하이라이트 제거 + 본문 텍스트 갱신. (jsdom 캐럿 단언은 step1에서 커버.)
   - **실편집 클리어(비-onTextChange 경로)**: 검사 후 Ctrl+D(줄 삭제 — commitBody 직접 경로) → 하이라이트 제거. (onTextChange만 클리어했다면 남았을 stale 하이라이트가 없음을 잠근다.)
   - **[low-1] blur 무편집 보존**: 검사 후 에디터 포커스 → **편집 없이** blur(`fireEvent.blur`) → 하이라이트 **유지**(`.yh-editor__spell` 존재; `nextBody===body`라 클리어 통과).
   - **탭 전환 클리어**: 검사 후 다른 탭으로 전환 → 새 탭에 하이라이트 없음(이월 없음).
   - **매핑 모드**: `mode:'mapping'` 진입 후 `통합 맞춤법 검사` → 하이라이트 표시(읽기전용), 크래시 없음.
   - **undo/markupVersion 무접촉(핵심 가드)**: 검사만 하고(편집 없음) 본문 직렬화/undo 스택이 **불변**임을 단언(예: `model.updateArticle`/저장 미호출, 또는 검사 전후 body 직렬화 동일 — 하이라이트가 `commitBody`의 히스토리 캡처를 유발하지 않음).
   - **phase 30 회귀**: 기존 맞춤법 다이얼로그 테스트(이슈 목록·snippet·errorStyle 조각·checkOff·매핑·항목 클릭 캐럿 이동) 전부 green. 타이핑/자동저장/컬럼제한/줄간격 테스트 green.
3. 아키텍처 체크: 하이라이트 **데이터**가 body/직렬화/히스토리 캡처를 타지 않음(`commitBody` 내 `setSpellHighlights([])` 표시-state 클리어 한 줄만 예외 — 히스토리/updateField 미변경). `spellIssues`/`spellStyle`/`SpellCheckDialog` 결선(phase 30) 불변. `errorStyle` prefs shape 미변경. `runSpellCheck`에서만 하이라이트 세팅(렌더마다 재계산 없음). ADR-003·CLAUDE.md(DB 무관·client 전용·UTF-8).
4. 결과에 따라 `phases/39-editor-spell-highlight/index.json`의 step2를 업데이트(성공 → completed + summary / 3회 실패 → error / 개입 필요 → blocked).

## 금지사항

- 하이라이트 데이터를 본문에 직렬화하거나(`serialize`/`updateField('body')`) `commitBody`의 히스토리 캡처(`pushHistory`)·인자에 반영하지 마라. 이유: 표시 전용 — undo 히스토리·markupVersion 오염 금지(guard 2a/#6). (단 `commitBody` 안의 `setSpellHighlights([])` **표시-state 클리어 한 줄**은 허용 — 이건 본문/히스토리를 건드리지 않는다.)
- `spellIssues`/`spellStyle`/`SpellCheckDialog` 결선(phase 30 완료분)을 바꾸지 마라. 이유: 결과 다이얼로그·조각 스타일은 완료 계약 — 회귀 금지. 하이라이트는 얹기만.
- `commitBody`(실편집)·탭 전환/리셋·checkOff에서 하이라이트 클리어를 빠뜨리지 마라. 이유: guard 2c/#3 — 편집·탭 전환 후 stale 좌표가 엉뚱한 텍스트를 하이라이트(p29~32 문서-로컬 stale 계열 재현).
- `compositionstart`나 조합 중 임의 경로에 별도 하이라이트 클리어 훅을 추가하지 마라. 이유: 조합 중 remount는 진행 중 글자를 유실/이중입력시킨다 — 클리어는 `commitBody`(composingRef 가드 통과 → `compositionend` 이후) 경로로만(step1 "배경 — 안전 불변식" #5 정합).
- 하이라이트를 렌더마다/매 상태변화마다 재계산하지 마라(오직 `runSpellCheck`에서 세팅). 이유: 성능(guard 5).
- `errorStyle` prefs 형식을 바꾸거나 파괴적으로 정규화하지 마라. 이유: 레거시 호환(guard 4) — 소비 시점 그대로(`spellStyle` 재사용).
- `spell.*` 라우팅을 매핑 가드 뒤로 옮기지 마라(phase 30 배치 유지). 이유: 읽기전용 검사가 매핑에서 죽은 버튼이 된다.
- `phases/index.json`(top-level)을 수정하지 마라. 이유: 오케스트레이터 담당.
- 기존 테스트를 깨뜨리지 마라.
