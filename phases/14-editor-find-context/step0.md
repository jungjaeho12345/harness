# Step 0: find-engine-pure — 찾기/바꾸기 순수 엔진

## 배경 / 요구사항

`docs/news.md` "기사 에디터"/"기사 상단 메뉴바"의 신규 액션:

> 편집: … 찾기/바꾸기, 전체 선택 …
> 툴바(L155): … 찾기/바꾸기 …
> 우클릭(L173): … 찾기/바꾸기 Ctrl+F …

이 step은 찾기/바꾸기의 **순수 계산 엔진**만 만든다 — UI 다이얼로그는 Step 1, WriterPage/메뉴/단축키 결선은 Step 2다. 이 step은 **순수 함수 + vitest 단위 테스트만**(에디터/WriterPage/컴포넌트 무변경).

찾기/바꾸기는 본문 **텍스트**(임베드 제외)에서 동작한다. 본문은 블록 모델(markupVersion)이므로 검색 좌표는 `blocksToText(blocks)` 기준 평문 텍스트의 절대 오프셋으로 다루고, "바꾸기"는 텍스트 블록만 수정한 **새 블록 배열**을 돌려준다(임베드·"(끝)" 불변). 실제 본문 갱신(`updateField`/`serialize`)·캐럿 이동은 이 step이 하지 않는다(Step 2).

## 읽어야 할 파일

먼저 아래를 읽고 설계 의도를 파악하라(프로젝트 루트 기준):

- `/CLAUDE.md`, `/docs/ARCHITECTURE.md`, `/docs/ADR.md` — view 레이어, 단순화 원칙, ADR-003
- `/docs/news.md` — "기사 에디터"(L152~L173), "## 기사 상단 메뉴바"(편집>찾기/바꾸기·전체 선택)
- `web/src/view/editorShortcuts.js` — **이 step의 본보기**. 키 인식(`isInsertContinueMarker`=Ctrl+Y), 블록 순수함수(`transformTextLine`, `insertContinueMarker`) 패턴·주석 스타일을 그대로 따른다. 단 찾기/바꾸기는 분량이 커지므로 **새 모듈 `web/src/view/editorFind.js`** 에 둔다(editorShortcuts에 욱여넣지 마라).
- `web/src/view/editorContent.js` — `textBlock`/`isTextBlock`/`isEmbedBlock`/`blocksToText`/`normalizeBlocks`/`END_MARKER`. 텍스트 블록은 `{type:'text',text}`. `blocksToText`는 텍스트 블록만 개행으로 잇는다(임베드 제외) — 검색 좌표의 기준 텍스트.
- `web/src/view/writerBody.js` — `textLineToBlockIndex(blocks, textLineIndex)`(텍스트-줄 0-base → 블록 배열 인덱스). 바꾸기에서 텍스트-줄→블록 매핑에 **재사용**한다(중복 로직 금지).
- `web/src/view/editorCaret.js` — `lineAtOffset(text, offset) -> {lineIndex, start, end}`(절대 오프셋이 속한 텍스트-줄/줄 경계). 매치 오프셋 → 텍스트-줄·줄안 컬럼 환산에 참고/재사용.
- `web/src/view/editorShortcuts.test.js` — 순수 함수 vitest 단위 테스트 패턴(`describe`/`it`/`expect`).

## 작업

TDD로 진행한다(테스트 먼저). **web 테스트는 vitest(`describe`/`it`/`expect`)** — `test/`의 node:test 아님. 새 테스트 파일 `web/src/view/editorFind.test.js`.

### 1. 키 인식 (`web/src/view/editorFind.js`)

```js
export function isFindReplace(e) // Ctrl+F (ctrlKey && !altKey && (key==='f'|'F' || code==='KeyF'))
```

- `editorShortcuts.isInsertContinueMarker`(Ctrl+Y)의 패턴을 그대로 따른다 — 레이아웃 무관하게 `code==='KeyF'`도 본다. `e.metaKey`는 보지 않는다(기존 키 함수들과 동일 단순화).

### 2. 찾기 엔진 (`web/src/view/editorFind.js`)

`text`는 본문 평문(`blocksToText(blocks)` 결과)이라고 가정한다(이 모듈은 blocks를 모른다 — 찾기는 텍스트만 다룬다).

```js
export function findMatches(text, query, { caseSensitive = false } = {})
//   → [{ start, end }]  // text 절대 오프셋(end = start + query.length). 비중첩(non-overlapping) 순차 스캔. query 빈문자/null → []
export function nextMatchIndex(matches, fromOffset, { forward = true } = {})
//   → number  // fromOffset "다음/이전" 매치의 matches 배열 인덱스. 끝이면 wrap-around. matches 비면 -1
```

- `findMatches`: `query`가 빈 문자열/`null`/`undefined`면 `[]`. 대소문자 무시(`caseSensitive=false`)가 기본. **정규식이 아니라 리터럴 부분문자열** 검색이다(정규식 메타문자 이스케이프 불필요 — query를 리터럴로 취급). 매치는 겹치지 않게 순차 스캔(`indexOf` 기반, 매치 끝 다음부터 재탐색).
- `nextMatchIndex`: `fromOffset` 이후(또는 이전) 첫 매치의 인덱스. `forward=true`면 `start >= fromOffset`(없으면 0으로 wrap), `forward=false`면 `start < fromOffset` 중 가장 큰 것(없으면 마지막으로 wrap). 순환 탐색을 위한 헬퍼다(다이얼로그 "다음 찾기"/"이전 찾기"가 쓴다).

### 3. 바꾸기 엔진 (`web/src/view/editorFind.js`)

바꾸기는 **블록 배열**을 입력/출력으로 다룬다(텍스트 블록만 수정, 임베드·구조 불변).

```js
export function replaceOne(blocks, query, replacement, { caseSensitive = false, fromOffset = 0 } = {})
//   → { blocks, replaced: boolean, matchStart: number|null, caretOffset: number|null }
export function replaceAll(blocks, query, replacement, { caseSensitive = false } = {})
//   → { blocks, count: number }
```

- 좌표 기준은 `blocksToText(blocks)`(텍스트 블록만, 임베드 제외)의 절대 오프셋이다. 매치를 텍스트로 찾은 뒤, 그 매치가 속한 **텍스트-줄**과 줄 안 컬럼을 `editorCaret.lineAtOffset`로 환산하고, `writerBody.textLineToBlockIndex`로 블록 인덱스를 구해 그 텍스트 블록의 `text`에서만 치환한다.
- `replaceOne`: `fromOffset` 이후 첫 매치(없으면 wrap해 첫 매치) 하나만 바꾼다. 매치가 없으면 `{ blocks: <원본 정규화>, replaced:false, matchStart:null, caretOffset:null }`. 바꿨으면 `replaced:true`, `matchStart`=치환 전 매치 시작 오프셋, `caretOffset`=치환 후 새 텍스트에서 치환 결과 끝 오프셋(다이얼로그가 다음 탐색 시작점으로 쓴다).
- `replaceAll`: 모든 매치를 치환한 새 블록 배열 + `count`(치환 개수). 한 줄(텍스트 블록) 안에 여러 매치가 있으면 모두 치환한다. 매치 0개면 `{ blocks: <원본 정규화>, count:0 }`.
- **"(끝)" 보존 규칙**: 치환이 텍스트 블록 text를 바꿔 결과가 우연히 `(끝)`이 되거나 `(끝)`을 깨도 **블록 구조·순서는 절대 재배치하지 마라**(이 엔진은 텍스트 치환만; 마커 정규화는 Step 2의 `serialize` 경로가 담당). 단 query가 빈 문자열/null이면 무조건 `count:0`·`replaced:false`로 no-op.
- 입력 `blocks`를 **mutate 하지 마라** — 새 배열을 반환한다(순수). 임베드 블록은 그대로 복사·순서 보존.

## 핵심 규칙 (반드시 준수 — 위반 시 반려)

1. **순수성**: 모든 함수는 DOM/transport 비의존 순수 함수다. 부수효과·`window`/`document` 접근 금지. 입력 blocks를 변형하지 말고 새 배열 반환.
2. **에디터/WriterPage/컴포넌트 무변경**: `Editor.jsx`·`WriterPage.jsx`·기존 컴포넌트를 이 step에서 수정하지 마라. 이유: 결선은 Step 2, 에디터 내부 불변식(타이핑/IME/캐럿/remount) 보호.
3. **텍스트-줄 인덱스 일관**: 블록 매핑은 `writerBody.textLineToBlockIndex`(텍스트 블록만 0-base) 재사용 — 임베드 포함 절대 인덱스와 혼동하지 마라(중복 매핑 로직 금지).
4. **임베드/구조 불변**: 바꾸기는 텍스트 블록의 `text`만 바꾼다. 임베드 블록·블록 개수·순서를 절대 바꾸지 마라.
5. **리터럴 검색**: query는 정규식이 아니라 리터럴 부분문자열이다(정규식 컴파일/메타문자 처리를 넣지 마라 — 단순화·안전).

## Acceptance Criteria

```bash
npm run test:web    # web 전체 통과 (editorFind 단위 테스트 포함)
npm run build       # vite build 성공
npm run lint        # ESLint 0
```

추가 단언(vitest):
- `isFindReplace({ ctrlKey:true, key:'f' }) === true`, `isFindReplace({ altKey:true, key:'f' }) === false`, `isFindReplace({ ctrlKey:true, code:'KeyF' }) === true`
- `findMatches('abcabc', 'bc')` → `[{start:1,end:3},{start:4,end:6}]`
- `findMatches('AbAb', 'ab')` → 대소문자 무시(기본) 2개; `findMatches('AbAb','ab',{caseSensitive:true})` → 0개
- `findMatches('x', '')` → `[]`, `findMatches('x', null)` → `[]`
- `findMatches('aaaa','aa')` → 비중첩 2개 `[{start:0,end:2},{start:2,end:4}]`
- `nextMatchIndex([{start:1,end:3},{start:4,end:6}], 2)` → 1(다음 매치), `nextMatchIndex([...], 6)` → 0(wrap)
- `replaceOne([textBlock('foo bar foo'), textBlock('(끝)')], 'foo', 'X')` → 첫 'foo'만 'X bar foo', 둘째 블록 '(끝)' 불변, `replaced:true`
- `replaceAll([textBlock('foo'), embedBlock({embedType:'image'}), textBlock('foo')], 'foo', 'X')` → 두 텍스트 블록 'X', 임베드 블록 위치·내용 불변, `count:2`
- `replaceAll([textBlock('abc')], '', 'X')` → `{ count:0 }`(빈 query no-op)
- 바꾸기가 입력 blocks 배열/요소를 mutate하지 않음(원본 배열 동등성 검증)

## 검증 절차

1. 위 AC 커맨드를 실행한다.
2. 아키텍처 체크리스트: view 레이어 순수 모듈, ADR-003 위반 없음, CLAUDE.md(TDD) 준수, 에디터/WriterPage/컴포넌트 무변경, 임베드/구조 불변.
3. 결과에 따라 `phases/14-editor-find-context/index.json`의 step 0을 업데이트:
   - 성공 → `"status": "completed"`, `"summary"`(isFindReplace·findMatches·nextMatchIndex·replaceOne·replaceAll 요약)
   - 3회 실패 → `"status": "error"`, `"error_message"`
   - 사용자 개입 필요 → `"status": "blocked"`, `"blocked_reason"` 후 중단

## 금지사항

- `Editor.jsx`/`WriterPage.jsx`/기존 컴포넌트를 수정하지 마라. 이유: phase 5/8/9 불변식 보호, 결선은 Step 2.
- query를 정규식으로 컴파일하지 마라(리터럴 부분문자열만). 이유: 단순화·ReDoS 방지.
- 바꾸기에서 임베드 블록·블록 순서·개수를 바꾸지 마라. 이유: news.md 156·167행(블록 순서 보존) 불변식.
- 입력 blocks를 mutate하지 마라(순수 — 새 배열 반환).
- 기존 테스트를 깨뜨리지 마라.
