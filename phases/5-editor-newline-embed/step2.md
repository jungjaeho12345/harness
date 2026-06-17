# Step 2: editor-caret-bridge — 캐럿 보고 + 지정 줄 포커스

## 읽어야 할 파일

먼저 아래 파일들을 읽고 설계 의도를 파악하라:

- `/docs/ARCHITECTURE.md`, `/docs/news.md`(## 기사 에디터), `/CLAUDE.md`
- `web/src/view/Editor.jsx` — 특히 `readCaret`(export), remount/refocus 메커니즘(`useEffect`/`useLayoutEffect`, `refocusRef`/`renderTick`/`rootRef`), `handleInput`/`handleBlur`/`handleKeyDown`. **Step 0에서 이미 수정된 상태**일 수 있으니 현재 코드를 정독하라.
- `web/src/view/Editor.test.jsx` — remount-refocus 테스트 패턴(`caretAtLine`, focus spy), echo no-remount 계약.
- `web/src/view/editorContent.js`, `web/src/view/editorCaret.js`.

이전 step(특히 Step 0)에서 만들어진 코드를 꼼꼼히 읽고, 캐럿/remount 불변식을 이해한 뒤 작업하라.

## 작업

`Editor.jsx`에 두 가지를 추가한다:

1. **캐럿 보고 콜백** `onCaretChange({ lineIndex })` (prop, optional)
   - 캐럿이 에디터 안에서 이동하는 이벤트(예: `onKeyUp`/`onMouseUp`/`onSelect`/`input`/`blur`)에서 `readCaret(root)`로 현재 텍스트-줄 인덱스를 읽어 호출한다.
   - **blur 계약(명문화)**: blur 시점에 `readCaret(root)`가 **null이 아니면** 마지막 캐럿으로 `onCaretChange`를 호출한다. **null이면**(검색패널 클릭 등으로 selection이 에디터 밖으로 빠짐 — `readCaret`은 anchorNode가 root 밖이면 null 반환) **호출하지 않는다.** → 부모는 직전 이벤트가 보고한 lastCaret 값을 그대로 유지한다. **blur에서 null을 강제 보고하지 마라**(그러면 부모의 마지막 캐럿이 지워져 Step 3 검색 삽입이 조용히 append 폴백으로 빠진다).
   - 캐럿을 못 읽으면(`readCaret`이 null) 호출하지 않는다.
   - IME 조합 중(`handleInput`이 composing이면 early-return)에는 캐럿 보고가 발생하지 않아도 된다(허용).

2. **지정 줄 포커스** prop `pendingCaretLine` (number | null)
   - 값이 새 number로 바뀌면(렌더/remount 직후) 에디터에 `focus()` 하고 해당 텍스트-줄(`.yh-editor__line`) 시작에 캐럿을 둔다.
   - **소비 시점/우선순위**: `pendingCaretLine`은 Step 3에서 body 변경(remount)과 **같은 렌더**에 함께 전달된다. remount 후 캐럿 복원(`useLayoutEffect([renderTick, …])` 단일 경로)에서 `pendingCaretLine`이 number면 기존 `refocusRef`(wasFocused) 복원보다 **먼저/우선** 그 줄에 focus+caret을 둔다.
   - 이전 포커스 여부와 무관하게 동작한다.
   - `textLocked`(readOnly 또는 매핑)면 무시한다.
   - `onCaretChange`는 이벤트 핸들러/effect에서만 호출한다(렌더 본문 동기 호출 금지 — 무한 렌더 방지).

## Acceptance Criteria

```bash
npm run lint
npm run test:web
```

## 검증 절차

1. AC 실행(통과).
2. `Editor.test.jsx`에 테스트 추가:
   - selection을 특정 줄에 두고 해당 이벤트 발생 → `onCaretChange`가 `{ lineIndex }`(해당 인덱스)로 호출된다.
   - **blur 후 `onCaretChange`가 마지막 lineIndex로 호출됨**(selection이 에디터 안일 때). selection이 에디터 밖(root 미포함)으로 빠진 채 blur면 호출되지 않는다.
   - `pendingCaretLine`을 number로 rerender → `focus()` 호출 + 해당 줄에 캐럿(range) 설정(기존 remount-refocus 테스트 패턴 재사용). `textLocked`면 `focus()` 미호출.
   - 회귀: echo no-remount / 기존 refocus(wasFocused) 동작 유지.
3. 아키텍처 체크리스트:
   - 뷰 로직은 `web/src/view/`, transport 비의존(콜백/prop만).
4. `phases/5-editor-newline-embed/index.json`의 step 2 업데이트(step0과 동일 규칙).

## 금지사항

- `onCaretChange`를 렌더 함수 본문에서 동기 호출하지 마라(이벤트 핸들러/effect에서만). 이유: 부모 setState 유발 시 무한 렌더.
- `textLocked`(매핑/readOnly)에서 `pendingCaretLine`으로 포커스를 강제하지 마라. 이유: 읽기전용 본문 포커스 가로채기 금지.
- 문자 타이핑 echo remount 금지 불변식을 깨지 마라(Step 0과 동일).
- 기존 테스트를 깨뜨리지 마라.
