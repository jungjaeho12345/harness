# Step 3: writerpage-chrome-integration — 메뉴바/툴바/상태표시줄 배치 + 캐럿 결선

## 배경 / 요구사항

**선행조건**: Step 0~2가 완료되어 `web/src/view/StatusBar.jsx`·`EditorMenuBar.jsx`·`EditorToolBar.jsx`·`editorStats.js`가 존재해야 한다(이 step은 그것들을 import해 배치한다). 없으면 import 실패로 build/test가 깨지므로 `blocked` 처리하라.

Step 0~2에서 만든 `StatusBar`·`EditorMenuBar`·`EditorToolBar`를 `WriterPage`의 좌측 에디터 영역에 **배치**하고, 상태표시줄을 **본문 텍스트 + 캐럿**에 결선한다. 또한 메뉴바/툴바 **보이기 토글**을 추가한다.

**CRITICAL**: 에디터 내부(타이핑/IME/캐럿/remount/개행) 로직은 절대 바꾸지 않는다. `Editor.jsx`에 대한 유일한 허용 변경은 **`onCaretChange` 페이로드에 이미 계산된 `offset`을 추가**하는 것뿐이다(상태표시줄의 '열' 표시용).

## 읽어야 할 파일

먼저 아래를 정독하고 에디터 불변식을 이해한 뒤 작업하라(프로젝트 루트 기준):

- `/CLAUDE.md`, `/docs/ARCHITECTURE.md`, `/docs/ADR.md` — view, ADR-003
- `/docs/news.md` — "기사 에디터"(상단 메뉴바/툴바/상태표시 배치), 우클릭 "메뉴바 보이기/툴바 보이기" 토글 언급.
- `web/src/view/WriterPage.jsx` — 좌측 `<section className="yh-writer__editor">`(L176~189)에 `<Editor .../>`가 있다. `body`=L56, `blocks`=L57(=`deserialize(body)`), `blocksToText`는 editorContent.js에서 import(L12), `lastCaretRef`=L60, `onCaretChange={(c) => { lastCaretRef.current = c; }}`=L186. 여기에 chrome을 배치하고 캐럿 state를 추가한다.
- `web/src/view/Editor.jsx` — `onCaretChange`가 `{ lineIndex: caret.lineIndex }`만 보고하는 지점은 공용 함수 **`reportCaret`(L330~335)** 내 L334다(`handleCaretEvent` L336은 그 래퍼). `readCaret`은 `{ lineIndex, offset }`을 이미 계산한다(함수 L106~122, return L121). **이 한 줄만** offset을 추가한다.
- `web/src/view/Editor.test.jsx` — `onCaretChange` 보고 단언(캐럿 보고 케이스). offset 추가로 strict 비교가 깨지는지 확인하고, 그렇다면 기대값에 offset을 포함하거나 `objectContaining`으로 갱신한다.
- `web/src/view/WriterPage.test.jsx` — 기존 작성페이지 테스트(액션바·메타탭·임베드 삽입). chrome 추가가 이들을 깨지 않아야 한다.
- Step 0~2 산출물: `web/src/view/StatusBar.jsx`, `EditorMenuBar.jsx`, `EditorToolBar.jsx`, `editorStats.js`.
- `web/src/styles/yonhap.css` — 배치 스타일(`yh-writer__editor` 내부에 chrome을 쌓는 레이아웃).

## 작업

TDD로 진행한다(vitest).

### 1. chrome 배치 (`web/src/view/WriterPage.jsx`)

- 좌측 `<section className="yh-writer__editor">` 안에서 위→아래 순서로 배치:
  1. `{showMenuBar && <EditorMenuBar />}` (onSelect는 이번 phase 미사용 — 항목 비활성이라 no-op/생략)
  2. `{showToolBar && <EditorToolBar />}`
  3. 기존 `<Editor ... />` (그대로)
  4. `<StatusBar text={blocksToText(blocks)} caret={statusCaret} />` — **text/caret만 결선**, `overwrite`/`language`는 기본값(placeholder) 유지. `text`(blocksToText, 임베드 제외)와 `caret.lineIndex/offset`은 같은 텍스트-줄 좌표계(readCaret 기준)라 정합.
- 상태 추가:
  ```js
  const [statusCaret, setStatusCaret] = useState(null);
  const [showMenuBar, setShowMenuBar] = useState(true);
  const [showToolBar, setShowToolBar] = useState(true);
  ```
- `onCaretChange`를 **가산적으로** 확장: 기존 `lastCaretRef.current = c`는 유지하고 `setStatusCaret(c)`를 추가한다.
  ```jsx
  onCaretChange={(c) => { lastCaretRef.current = c; setStatusCaret(c); }}
  ```
  (Editor가 c에 offset을 포함해 보고하므로 StatusBar가 '열'을 계산할 수 있다.)

### 2. 메뉴바/툴바 보이기 토글

- 메뉴바/툴바 표시를 켜고 끄는 **기능하는 토글**을 추가한다(layout 토글이므로 placeholder 아님).
- **배치를 못박는다**: chrome 영역(예: 상태표시줄 또는 toolbar 옆)에 **전용 토글 버튼 2개**(`data-testid=toggle-menubar`, `toggle-toolbar`)로 구현하라. **EditorMenuBar의 '보기' 메뉴 항목으로 결선하지 마라** — 이유: Step 1이 드롭다운 항목을 전부 비활성(disabled)으로 강제하므로 메뉴 항목 토글은 그 불변식과 충돌한다.
- (news.md L173은 이 토글을 우클릭 컨텍스트 메뉴 항목으로도 규정하지만, ContextMenu 이동은 **후속 phase로 연기**한다 — 이번엔 전용 버튼만. 주석으로 남길 것.)
- (약물바 토글은 약물바 컴포넌트가 아직 없으므로 이번 phase 제외 — 추가하지 마라.)

### 3. Editor onCaretChange offset 추가 (`web/src/view/Editor.jsx`) — **유일한 Editor 변경**

- 변경 대상은 **공용 보고 함수 `reportCaret`(L330~335)** 안의 `onCaretChange` 호출(L334)이다(그 위 `handleCaretEvent`(L336)는 reportCaret을 부르는 래퍼일 뿐 — 거기엔 고칠 줄이 없다). 정확히:
  - `onCaretChange({ lineIndex: caret.lineIndex })` → `onCaretChange({ lineIndex: caret.lineIndex, offset: caret.offset })` **한 줄만**.
- **파급 인지**: `reportCaret`은 keyUp/mouseUp/onSelect(`handleCaretEvent`, L446~448), `handleInput`(L401, 타이핑 후), `handleBlur`(L419, blur 계약) **세 경로의 공용 보고 함수**다. 따라서 이 한 줄로 세 경로의 보고 payload가 모두 `{ lineIndex, offset }`로 바뀐다 — 단, 캐럿을 "언제 보고/미보고"하는 계약(에디터 밖이면 null이라 미보고 등, L328·L418)은 **불변**이며, 그 외 `Editor.jsx`의 어떤 줄도 바꾸지 마라.
- **테스트 영향(확정)**: `Editor.test.jsx`의 strict 객체 비교 단언 **정확히 3곳이 반드시 깨진다** — `L483 toHaveBeenCalledWith({ lineIndex: 2 })`(keyUp), `L494 ({ lineIndex: 1 })`(mouseUp), `L506 ({ lineIndex: 1 })`(**blur**). 각각 `expect.objectContaining({ lineIndex: N })`로 갱신하라(offset 실제값 자체는 단언하지 마라 — offset은 readCaret 책임). **미보고 단언(`not.toHaveBeenCalled`, 약 L509~527)은 절대 수정하지 마라**(보고 시점/조건 불변).

## 핵심 규칙 (반드시 준수 — 위반 시 반려)

1. **CRITICAL — 에디터 불변식**: `Editor.jsx`는 onCaretChange 페이로드에 offset 추가 **단 한 줄**만 바꾼다. 타이핑/IME/remount/캐럿복원/개행/임베드 로직(phase 5 불변식)은 절대 건드리지 마라. 이유: 본문 개행·캐럿·IME 회귀는 치명적이며 phase 5에서 어렵게 안정화됐다.
2. **가산적 결선**: `lastCaretRef.current = c`(검색패널 임베드 삽입 위치 의존)를 유지한 채 `setStatusCaret(c)`만 추가하라. 이유: lastCaretRef를 없애면 임베드 삽입 위치가 깨진다.
3. **회귀 금지(WriterPage)**: 액션바(송고/보류/KILL)·메타 4탭·임베드 삽입·매핑 모드·탭 동작은 불변. chrome은 추가만 한다.
4. **리렌더 안전성(중요)**: `setStatusCaret(c)`로 캐럿 이동마다 WriterPage가 리렌더되고 `blocks = deserialize(body)`가 매번 새 배열 참조를 만든다. 그래도 **본문 내용이 같으면 Editor가 echo로 판정해 remount하지 않는다**(Editor.jsx 약 L272 early-return — phase 5 불변식). 이 echo 불변식에 전적으로 의존하므로, `blocks`/`onCaretChange` 계산 방식을 바꾸거나 `useMemo`/`useCallback` 등 최적화를 새로 추가하지 마라(echo 판정을 어긋나게 해 remount/IME 회귀를 유발할 수 있다). 상태표시줄 텍스트는 이미 계산된 `blocks`에서 얻는다.
5. **ADR-003**: chrome 컴포넌트는 순수 UI — `model`/fetch를 부르지 마라.
6. **테스트 조회 스코핑**: 메뉴바/툴바 항목 라벨이 기존 WriterPage 테스트의 `getByRole('button', { name })`(액션바 '송고'/'보류'/'KILL', 검색 '검색'/'삽입', 메타탭 '이미지'/'영상'/'글기사' 등)과 충돌할 수 있다. chrome 항목은 `data-testid` 또는 `within(menubar/toolbar)` 스코프로 조회해 기존 조회와 겹치지 않게 하라.

## Acceptance Criteria

```bash
npm run test:web    # web 전체 통과 (기존 Editor/WriterPage 테스트 불변 + chrome 결선·토글 단언)
npm run build       # vite build 성공
npm run lint        # ESLint 0
```

추가 단언(vitest):
- WriterPage 렌더 시 메뉴바·툴바·상태표시줄이 보인다(에디터 위/아래).
- 본문에 텍스트가 있을 때 상태표시줄 단어수/Byte가 반영된다.
- `toggle-menubar`/`toggle-toolbar`로 메뉴바/툴바를 숨기고 다시 보일 수 있다.
- 기존 Editor 캐럿 보고 테스트가 (L483·L494·L506을 objectContaining으로 갱신한 채) 통과하고, 미보고 단언(L509~527)은 불변으로 통과한다.
- 기존 WriterPage 테스트(액션바·메타탭·**검색패널 임베드 삽입 3종·Ctrl+V 붙여넣기**)가 불변으로 통과한다 — setStatusCaret 추가가 임베드 삽입 위치(lastCaretRef)·붙여넣기 회귀를 일으키지 않음.
- 캐럿 이동(keyUp) 후 Editor가 remount되지 않는다(echo no-remount 불변식 보존 — 가능하면 단언, 어려우면 임베드/타이핑 회귀 테스트 통과로 갈음).

## 검증 절차

1. 위 AC 커맨드를 실행한다.
2. 아키텍처 체크리스트: view 결선, ADR-003, **에디터 불변식 보존**(Editor.jsx 1줄만 변경), 회귀 없음.
3. 결과에 따라 `phases/8-editor-chrome-shell/index.json`의 step 3을 업데이트:
   - 성공 → `"status": "completed"`, `"summary": "WriterPage chrome 배치·StatusBar 캐럿결선·메뉴바/툴바 토글·Editor onCaretChange offset 추가 요약"`
   - 3회 실패 → `"status": "error"`, `"error_message"`
   - 사용자 개입 필요 → `"status": "blocked"`, `"blocked_reason"` 후 중단

## 금지사항

- `Editor.jsx`를 onCaretChange offset 추가 외에 수정하지 마라. 이유: phase 5 타이핑/IME/캐럿/개행 불변식 회귀는 치명적.
- `lastCaretRef` 결선을 제거/대체하지 마라. 이유: 검색패널 임베드 삽입 위치가 lastCaretRef에 의존한다.
- 메뉴바/툴바 항목(드롭다운/버튼)에 편집 액션을 결선하지 마라(메뉴바/툴바 보이기 토글만 기능). 이유: 액션 결선은 후속 phase.
- 약물바를 추가하지 마라. 이유: 약물바 컴포넌트가 없고 범위 밖.
- 기존 Editor/WriterPage 테스트의 동작 의도를 바꾸지 마라(offset 포함 갱신만 허용).
