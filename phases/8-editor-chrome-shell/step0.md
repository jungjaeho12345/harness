# Step 0: editor-statusbar — 에디터 상태표시줄 (워드수·Byte·단락·행·열)

## 배경 / 요구사항

`docs/news.md` "기사 에디터"의 신규 스펙:

> 상단 메뉴바 옆에는 에디터 상태표시가 있는데 **워드수, Byte/ N단락 N행 N열, 삽입/수정, 언어**

이 step은 그 상태표시줄을 **순수 계산 모듈 + 표시 컴포넌트**로 구현한다. WriterPage 결선(실제 본문·캐럿 주입)은 Step 3에서 한다. 따라서 이 step은 **순수 함수 + props로 렌더되는 컴포넌트**만 만들고, 단위 테스트로 검증한다(에디터/WriterPage는 건드리지 않는다).

## 읽어야 할 파일

먼저 아래 파일들을 읽고 설계 의도를 파악하라(프로젝트 루트 기준):

- `/CLAUDE.md`, `/docs/ARCHITECTURE.md`, `/docs/ADR.md` — 레이어(view), 단순화 원칙
- `/docs/news.md` — "기사 에디터" 절(상태표시 항목)
- `web/src/view/editorContent.js` — `blocksToText(blocks)`(블록→텍스트), `textBlock`/`isTextBlock`/`END_MARKER`. 본문 텍스트는 여기서 얻는다.
- `web/src/view/editorCaret.js` — `lineAtOffset(text, offset)` 등 캐럿 좌표 헬퍼(행/열 계산에 참고).
- `web/src/view/Editor.jsx` — `readCaret`가 `{ lineIndex, offset }`을 돌려주는 계약(함수 L106~122, return L121; L104~105는 JSDoc). 상태표시줄은 이 캐럿 shape을 입력으로 받는다(Step 3에서 주입). **row는 `lineIndex`만, column은 `offset`만 사용**한다(두 값은 같은 caret에서 와야 정합).
- `web/src/view/statusBadge.js` 또는 `web/src/view/listFormat.js` — 작은 순수 모듈 + 단위 테스트(vitest)의 기존 패턴 참고.
- `web/src/styles/yonhap.css` — `yh-*` 클래스 스타일 컨벤션(상태표시줄 클래스 추가 위치).

## 작업

TDD로 진행한다(테스트 먼저). **web 테스트는 vitest(`describe`/`it`/`expect`)로 작성한다 — `test/`의 `node:test`가 아니다.**

### 1. 순수 계산 모듈 `web/src/view/editorStats.js`

아래 순수 함수들을 만든다(시그니처만 제시 — 구현은 재량, 단 정의는 명확히 지킬 것):

```js
export function wordCount(text)        // = text.trim().split(/\s+/).filter(Boolean).length (공백류=\s, 빈/공백뿐=0)
export function byteLength(text)       // UTF-8 바이트 길이 (TextEncoder 또는 동등).
export function caretPosition(text, caret) // → { paragraph, row, column } (모두 1-based)
```

- `caret`은 `{ lineIndex, offset }`(Editor.readCaret 계약). `caret`이 null/undefined면 `{ paragraph:1, row:1, column:1 }`을 반환한다(포커스 전 기본값).
- **row** = `lineIndex + 1`(1-based 텍스트 줄).
- **column** = 현재 줄 안에서의 캐럿 위치 + 1 = `offset - (현재 줄 시작 오프셋) + 1`. (현재 줄 시작 오프셋 = 앞선 줄들의 길이 합 + 개행 수. `editorCaret.lineAtOffset`을 활용해도 된다.)
- **paragraph** = 현재 줄이 속한 단락의 1-based 인덱스. 단락은 빈 줄(`''`)로 구분되는 연속 비빈 줄의 묶음으로 정의한다(연속된 빈 줄은 단락 경계 1개로 본다). 즉 캐럿 줄까지의 "비빈 줄 그룹" 개수.
- 텍스트 카운트(word/byte)는 본문 전체 텍스트 기준이다. `END_MARKER`("(끝)")를 특별 취급하지 마라(텍스트에 있으면 그대로 카운트 — 단순화).

### 2. 표시 컴포넌트 `web/src/view/StatusBar.jsx`

```jsx
export function StatusBar({ text = '', caret = null, language = '한국어', overwrite = false })
```

- `editorStats`로 계산한 값을 표시한다: `{wordCount}단어 · {byteLength}B · {paragraph}단락 {row}행 {column}열 · {overwrite ? '수정' : '삽입'} · {language}`.
- **삽입/수정**(overwrite)과 **언어**(language)는 이번 phase에서 동작하지 않는다 — props로 받아 표시만 하고 기본값(삽입/한국어)을 둔다(placeholder).
- `yh-editor-statusbar` 등 `yh-*` 클래스를 쓰고 `yonhap.css`에 스타일을 추가한다. 각 항목에 `data-testid`(예: `stat-words`, `stat-bytes`, `stat-caret`)를 부여해 테스트가 값을 검증할 수 있게 한다.
- 순수 표시 컴포넌트다 — 내부 상태/effect/타이머를 두지 마라(props만으로 렌더).

## 핵심 규칙 (반드시 준수 — 위반 시 반려)

1. **에디터 무변경**: `Editor.jsx`·`WriterPage.jsx`를 이 step에서 수정하지 마라. 이유: 결선은 Step 3 범위이고, 에디터 내부 불변식(타이핑/IME/캐럿)을 건드릴 위험을 차단한다.
2. **순수성**: `editorStats.js`는 순수 함수(부수효과·DOM 접근 없음). `StatusBar`는 props만으로 렌더(상태/effect 없음). 이유: 테스트 용이성·재사용성.
3. **caret 계약 일치**: 입력 caret은 `{ lineIndex, offset }`(Editor.readCaret과 동일). 다른 shape을 가정하지 마라.
4. **정의 준수**: row/column/paragraph는 위 정의(1-based, 단락=비빈 줄 그룹)를 정확히 따르고 테스트로 고정하라.

## Acceptance Criteria

```bash
npm run test:web    # web 전체 통과 (editorStats·StatusBar 단위 테스트 포함)
npm run build       # vite build 성공
npm run lint        # ESLint 0
```

추가 단언(vitest):
- `wordCount('가 나  다') === 3`, `wordCount('') === 0`, `wordCount('   ') === 0`
- `byteLength('한글') === 6`, `byteLength('ab') === 2`
- `caretPosition('가나\n다라', { lineIndex:1, offset:4 })` → `{ paragraph:1, row:2, column:2 }` (line idx1 시작 오프셋=len('가나')+1=3, offset 4 → '다' 뒤 = 2칸)
- `caretPosition('가\n\n다', { lineIndex:2, offset:3 })` → `{ paragraph:2, row:3, column:1 }`(빈 줄로 단락 분리)
- `caretPosition('가나', null)` → `{ paragraph:1, row:1, column:1 }`
- `<StatusBar text="가 나" caret={{lineIndex:0,offset:1}} />` 렌더 시 단어수 2·행 1·열 2가 표시됨(testid로 검증)

## 검증 절차

1. 위 AC 커맨드를 실행한다.
2. 아키텍처 체크리스트: view 레이어 순수 모듈/표시 컴포넌트, ADR 위반 없음, CLAUDE.md(TDD) 준수, 에디터 무변경.
3. 결과에 따라 `phases/8-editor-chrome-shell/index.json`의 step 0을 업데이트:
   - 성공 → `"status": "completed"`, `"summary": "editorStats(wordCount/byteLength/caretPosition 정의)·StatusBar(props·testid) 요약"`
   - 3회 실패 → `"status": "error"`, `"error_message"`
   - 사용자 개입 필요 → `"status": "blocked"`, `"blocked_reason"` 후 중단

## 금지사항

- `Editor.jsx`/`WriterPage.jsx`를 수정하지 마라. 이유: 결선은 Step 3, 에디터 불변식 보호.
- `StatusBar`에 자체 상태/effect/타이머를 넣지 마라. 이유: 순수 표시 컴포넌트여야 Step 3에서 본문·캐럿을 주입해 재사용·테스트할 수 있다.
- 삽입/수정·언어에 실제 동작을 구현하지 마라(placeholder). 이유: 이번 phase는 쉘만이며 입력모드/언어 기능은 범위 밖.
- 기존 테스트를 깨뜨리지 마라.
