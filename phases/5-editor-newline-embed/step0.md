# Step 0: editor-newline-restore — 본문 개행 직렬화 버그 수정

## 배경 / 버그

기사 작성 에디터(`writer.do`)에서 본문을 여러 줄 입력한 뒤 Alt+Y("(끝)" 삽입)를 누르면 본문 텍스트가 **한 줄로 합쳐져** 보인다. 특히 빈 새 기사에서 시작하면 확실히 재현된다. blur(포커스 이탈) 재색칠 시점에도 동일하게 합쳐질 수 있다.

## 읽어야 할 파일

먼저 아래 파일들을 읽고 프로젝트의 아키텍처와 설계 의도를 파악하라:

- `/docs/ARCHITECTURE.md`, `/docs/ADR.md`, `/CLAUDE.md`
- `/docs/news.md` — `## 기사 에디터` 절(개행/"(끝)"/색상/IME 규칙)
- `web/src/view/Editor.jsx` — 에디터 컴포넌트(contentEditable, DOM 읽기/캐럿/키처리). 특히 `readEditorText`, `readEditorBlocks`, `readCaret`, `handleInput`, `handleKeyDown`, 그리고 remount/refocus 메커니즘(`useEffect`/`useLayoutEffect`, `snapRef`/`lastEmittedRef`/`refocusRef`/`renderTick`/`rootRef`).
- `web/src/view/Editor.test.jsx` — 기존 동작 계약(캐럿 보존/echo no-remount/"(끝)" 차단/임베드 위치 보존/이미지 붙여넣기).
- `web/src/view/editorContent.js` — 블록 모델(`textBlock`/`isTextBlock`/`isEmbedBlock`/`blocksToText`/`END_MARKER`).
- `web/src/view/editorCaret.js`, `web/src/view/editorNewline.js` — 순수 캐럿/마커 헬퍼.
- `web/src/view/editorColoring.js` — `classifyLines`/`colorForRole`(제목/부제/본문/"(끝)" 색 역할). Editor.jsx가 `classifyLines(blocksToText(renderBlocks).split('\n'))`로 역할을 매핑하고 텍스트 줄을 `textLine` 인덱스로 색칠한다.
- `web/src/view/WriterPage.jsx` — `onKeyDown`의 Alt+Y 경로(`serialize(insertEndMarker(blocks).blocks)`로 body 갱신 → Editor remount).

이전 코드를 정독하고 **"문자 타이핑 echo는 remount하지 않고(캐럿/IME 보존), 구조 변경(로드·Ctrl+D·임베드·Alt+Y·blur 재색칠) 시에만 remount + 캐럿 복원"** 불변식을 이해한 뒤 작업하라.

## 근본 원인

- Editor는 본문 줄을 `.yh-editor__line` div 단위로 렌더하고, `readEditorText`/`readEditorBlocks`는 각 줄을 `el.textContent`로 읽어 `\n`으로 잇는다.
- 브라우저는 Enter/붙여넣기로 `<br>`, 중첩 div, 클래스 없는 div, 맨 앞 bare 텍스트노드를 만든다. 이들은 `.yh-editor__line`이 없거나 `textContent`가 `<br>`/블록 경계 개행을 보존하지 않아 **여러 줄이 한 블록으로 합쳐진 채 `onTextChange` → `body` state에 저장**된다.
- 빈 본문은 `.yh-editor__line`이 0개 → `readEditorBlocks`가 `root.textContent` 폴백 → 개행 전부 소실.
- Alt+Y가 `updateField('body', …)`로 remount를 강제하는 순간 화면이 그 한 줄 상태로 재구성되어 사용자에게 보인다.

## 작업

### 불변식 (반드시 지킬 것)

1. 타이핑/Enter/붙여넣기 어떤 경로로도 본문 개행이 한 줄로 합쳐지지 않는다(입력 직후 `onTextChange`가 올바른 다중 텍스트 블록을 emit하고, blur/Alt+Y remount 후에도 줄 수가 보존된다).
2. `readEditorBlocks`가 내보내는 텍스트 줄 순서/내용과 `readCaret`의 `lineIndex`/`offset`은 **같은 기준**으로 일치한다.
3. 문자 타이핑(비-Enter) echo는 remount하지 않는다(캐럿/IME 보존 — 기존 불변식 유지).
4. **CRITICAL — `readCaret` 계약 고정**: `readCaret(root)`의 반환 시그니처 `{ lineIndex, offset }`와 의미(`lineIndex` = 렌더된 `.yh-editor__line` div들 중 `indexOf` = 텍스트 블록 순번, offset = `blocksToText` 기준 텍스트 오프셋)를 **바꾸지 마라**. `readCaret`은 export되어 `WriterPage.jsx`에서 직접 쓰이고, Step 2(`onCaretChange`)·Step 3(`pasteEmbedAtCaret`)가 이 `lineIndex`에 의존한다.
5. 빈 줄 시드/Enter 분할/붙여넣기 분할 후에도 색상 매핑(`classifyLines`의 `textLine`↔역할 인덱싱, `editorColoring.js`)과 각 텍스트 줄 색상이 보존된다. 시드한 빈 줄이 `renderBlocks` 배열에 들어가는지 JSX-only인지에 따라 색 인덱싱이 어긋나지 않게 하라.

### 권장 메커니즘 (방향 권장 — 내부 구현은 재량)

- **빈 본문 시드**: `renderBlocks`에 렌더 가능한 줄이 없을 때 빈 `.yh-editor__line` 1개를 렌더해 contentEditable이 항상 줄 래퍼를 갖게 한다. **블록이 1개 이상이면(임베드만 있어도) 시드하지 않는다.**
- **Enter 제어**: `textLocked`도 아니고 "(끝)" 차단(`caretBlocked`)도 아니면 Enter에서 `e.preventDefault()` 후, 현재 캐럿(`readCaret`)이 속한 텍스트 블록을 캐럿 오프셋 기준 두 블록으로 분할(줄 끝이면 뒤에 빈 텍스트 블록 추가)하여 블록 모델로 내보내 remount + 새 줄 시작에 캐럿 복원(`refocusRef` 메커니즘 재사용). → 브라우저가 `<br>`/미래핑 노드를 만들지 못해 "1줄 = 1 `.yh-editor__line` = 1 텍스트 블록" 불변식이 유지된다.
- **여러 줄 텍스트 붙여넣기**: `handlePaste`에서 이미지가 아닌 `text/plain`이고 `\n`을 포함하면 `preventDefault` 후 캐럿 위치에 줄들을 텍스트 블록으로 삽입(개행 보존). (이미지 붙여넣기·한 줄 텍스트 붙여넣기 기존 동작은 유지.)
- **대안(재량)**: Enter 제어 대신 `readEditorBlocks`/`readCaret`를 DOM 워크로 재작성해 `<br>`·중첩/미래핑 블록·bare 노드에서 개행을 복원해도 된다. 단 어느 경로를 택하든 **불변식 4(`readCaret`의 `{lineIndex, offset}` 시그니처·의미 고정)를 절대 위반하지 말 것** — 위반 시 Step 2/3 전제가 무너진다. 두 함수의 줄 기준을 일치(불변식 2)시키고 기존 테스트를 통과시켜라.

## Acceptance Criteria

```bash
npm run lint
npm run test:web
npm run build
```

## 검증 절차

1. 위 AC 커맨드를 실행한다(모두 통과).
2. 아래 신규/회귀 테스트가 통과하는지 확인:
   - 신규: 빈 본문 에디터에 "줄1 ⏎ 줄2 ⏎ 줄3"를 입력하는 시나리오(jsdom에서 Enter keydown + 줄 DOM 구성) 후 Alt+Y → 본문 텍스트가 `줄1\n줄2\n줄3\n(끝)`로 보존(한 줄로 합쳐지지 않음).
   - 신규: `<br>` 또는 클래스 없는 중첩 div로 두 줄이 표현된 DOM에서 `input` 발생 시 `onTextChange`가 두 개의 텍스트 블록을 emit(개행 보존).
   - 회귀: 기존 `Editor.test.jsx` / `WriterPage.test.jsx` 전부 통과(echo no-remount, "(끝)" 차단, 임베드 위치 보존, Ctrl+D/Backspace 라인삭제, 이미지 붙여넣기 캐럿).
   - 회귀: 빈 신규 본문에서 입력 없이 blur/remount만 발생해도 body가 유효 빈 본문(빈 블록 또는 `[textBlock('')]`)으로 안정되고, 기존 "신규(빈 탭) 송고/보류 가드" 테스트(WriterPage.test.jsx)가 통과한다(빈 줄 시드가 제목/가드 판정을 깨지 않음).
3. 아키텍처 체크리스트:
   - ARCHITECTURE.md 디렉토리 구조 준수(뷰 로직은 `web/src/view/`).
   - ADR 기술 스택(React + Vitest) 유지.
   - CLAUDE.md CRITICAL 위반 없음(이 step은 순수 클라이언트 DOM 처리 — 외부 API/transport 호출 없음).
4. 결과에 따라 `phases/5-editor-newline-embed/index.json`의 step 0을 업데이트:
   - 성공 → `"status":"completed"`, `"summary":"산출물·핵심 결정 한 줄 요약"`.
   - 수정 3회 시도 후에도 실패 → `"status":"error"`, `"error_message":"구체적 에러 내용"`.
   - 사용자 개입 필요 → `"status":"blocked"`, `"blocked_reason":"구체적 사유"` 후 즉시 중단.

## 금지사항

- 문자 타이핑(비-Enter) 매 입력마다 remount/재색칠 하지 마라. 이유: 브라우저 캐럿 초기화·한글 IME 조합 깨짐·removeChild 크래시(Editor.jsx 상단 CRITICAL 주석).
- 빈 본문이 아닌데(블록 ≥ 1) 빈 줄을 시드하지 마라. 이유: embed-only 본문에 텍스트 줄이 생겨 "삭제할 라인 없을 때 Ctrl+D 북마크 차단" 회귀 테스트가 깨진다.
- `onTextChange` 2번째 인자(인터리브 블록)·"(끝)" 뒤 입력 차단·임베드 `data-embed-key` 매칭 계약을 바꾸지 마라.
- DB/transport를 건드리지 마라(이 step은 뷰 전용).
- 기존 테스트를 깨뜨리지 마라.
