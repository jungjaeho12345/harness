# Step 0: text-transform-pure — (계속) 마커 + 대소문자 변환 순수 함수

## 배경 / 요구사항

`docs/news.md` "## 기사 상단 메뉴바"의 신규 액션:

> 편집: … (계속)삽입 Ctrl+Y
> 보기: 대문자로 바꾸기, 소문자로 바꾸기, 첫글자 대문자로, 대/소문자 전환, …

이 step은 그 액션들의 **순수 블록 변환 함수**를 `editorShortcuts.js`에 추가한다(기존 `insertEndMarker`/`deleteLineAt`과 같은 자리·같은 스타일). WriterPage/메뉴 결선은 Step 1. 이 step은 **순수 함수 + 단위 테스트만**(에디터/WriterPage 무변경).

**범위 밖(이 phase 제외 — 구현하지 마라)**: 정렬(양쪽/좌/우/가운데), undo/redo, 문서/문단/한줄/단어 선택·지우기. 이유: 정렬은 블록 모델+Editor 렌더 변경, undo/redo는 별도 스냅샷 설계가 필요해 별도 phase다.

## 읽어야 할 파일

- `/CLAUDE.md`, `/docs/ARCHITECTURE.md`, `/docs/ADR.md` — view 레이어, 단순화
- `/docs/news.md` — "## 기사 상단 메뉴바"(편집>(계속)삽입, 보기>대소문자), "기사 에디터"
- `web/src/view/editorShortcuts.js` — **여기에 추가**. 기존 `END_MARKER`, `isInsertEndMarker`(Alt+Y), `insertEndMarker`, `isDeleteLine`, `deleteLineAt`. 키 인식(`e.altKey`/`e.ctrlKey`/`e.code`) 패턴, 블록 순수함수 패턴을 그대로 따른다.
- `web/src/view/editorContent.js` — `textBlock`/`isTextBlock`/`isEmbedBlock`/`blocksToText`/`normalizeBlocks`/`END_MARKER`. 텍스트 블록은 `{type:'text', text}`이고 `normalizeBlocks`는 text/embed만 보존한다.
- `web/src/view/editorShortcuts.test.js`(있으면) 또는 `web/src/view/editorContent.test.js` — 순수 함수 단위 테스트(vitest) 패턴.
- `web/src/view/writerBody.js` — `insertEmbedAfterLine(currentBody, embed, textLineIndex) -> {body, caretTextLine}`(텍스트-줄 인덱스 기준 삽입의 기존 규칙 — "(끝)"은 항상 최종 블록 유지, 빈 줄은 "(끝)" 앞). (계속) 삽입도 이 규칙과 정합하게 한다(텍스트-줄 인덱스 의미·"(끝)" 보존).

## 작업

TDD로 진행한다(vitest). **web 테스트는 vitest(`describe`/`it`/`expect`)** — `test/`의 node:test 아님.

### 1. (계속) 마커 (`editorShortcuts.js`)

```js
export const CONTINUE_MARKER = '(계속)';
export function isInsertContinueMarker(e)  // Ctrl+Y (ctrlKey && !altKey && (key==='y'|'Y' || code==='KeyY'))
export function insertContinueMarker(blocks, textLineIndex) // → { blocks, caretTextLine }
```

- `isInsertContinueMarker`: `insertEndMarker`의 Alt+Y 패턴을 본떠 **Ctrl+Y**를 인식한다(레이아웃 무관 `code==='KeyY'`도 본다).
- `insertContinueMarker(blocks, textLineIndex)`: 주어진 **텍스트-줄 인덱스 다음**에 `textBlock('(계속)')`를 삽입한다. 임베드 삽입과 달리 **빈 줄을 만들지 않는다**(마커 한 줄만 추가). 반환:
  - `blocks`: **블록 배열**을 반환한다(직렬화 문자열이 아님 — WriterPage가 `serialize(r.blocks)`로 직렬화). 참고: `writerBody.insertEmbedAfterLine`은 `{body}`(문자열)를 돌려주지만 이 함수는 `{blocks}`(배열)다.
  - `caretTextLine`: **삽입된 '(계속)' 텍스트-줄의 인덱스**(그 줄 자체 — 정규화/"(끝)" 재배치 반영해 재계산). 예: `[a, b]`의 줄 0 뒤 삽입이면 결과 텍스트 `['a','(계속)','b']`에서 `caretTextLine===1`.
  - `textLineIndex`가 null/음수/범위밖이면 끝에 삽입하되 **"(끝)"이 있으면 그 앞**에 둔다("(끝)"은 항상 최종 텍스트 블록 — `insertEmbedAfterLine`과 동일 규칙). 이때 `caretTextLine`은 삽입된 '(계속)' 줄 인덱스다.
  - 텍스트-줄→블록 인덱스 변환은 `writerBody.js`의 기존 `textLineToBlockIndex`(이미 export·테스트됨, 동일 규칙)를 재사용하라(중복 로직 금지).
  - (끝)과 달리 **멱등일 필요 없다**(여러 번 삽입 가능). 임베드 블록 순서는 보존한다.

### 2. 대소문자 변환 (`editorShortcuts.js`)

```js
export function transformTextLine(blocks, textLineIndex, fn) // → { blocks } : 텍스트-줄 인덱스의 텍스트 블록 text에 fn 적용
```

- `transformTextLine`: 텍스트-줄 인덱스(텍스트 블록만 0-base로 센 순번 — `blocksToText`/`writerBody`와 동일 기준)에 해당하는 텍스트 블록의 `text`에 `fn(text)`를 적용한 새 블록 배열을 돌려준다. 임베드/다른 줄/"(끝)"은 불변. 범위 밖이면 변경 없이 그대로 반환.
- 문자열 변환 함수 4종도 export(순수):
  - `toUpper(s)` = `s.toUpperCase()`
  - `toLower(s)` = `s.toLowerCase()`
  - `capitalizeFirst(s)` = 첫 글자만 대문자, 나머지 소문자 (예: 'aBC'→'Abc')
  - `toggleCase(s)` = 글자별 대↔소 반전 (예: 'aBc'→'AbC')

## 핵심 규칙 (반드시 준수 — 위반 시 반려)

1. **순수성**: 모든 함수는 DOM/transport 비의존 순수 함수다(`editorShortcuts.js` 상단 주석대로). 입력 blocks를 변형(mutate)하지 말고 새 배열을 반환하라.
2. **에디터/WriterPage 무변경**: `Editor.jsx`·`WriterPage.jsx`를 수정하지 마라(결선은 Step 1).
3. **"(끝)" 보존**: (계속) 삽입이 "(끝)" 최종 블록 규칙을 깨지 않게 하라(있으면 그 앞에).
4. **텍스트-줄 인덱스 일관**: `transformTextLine`/`insertContinueMarker`의 인덱스는 텍스트 블록만 센 순번(`blocksToText` 줄 기준)이다 — 임베드 포함 절대 인덱스와 혼동하지 마라.
5. **범위 밖 미구현**: 정렬·undo/redo·선택연산을 추가하지 마라(별도 phase).

## Acceptance Criteria

```bash
npm run test:web    # web 전체 통과 (신규 순수 함수 단위 테스트 포함)
npm run build
npm run lint
```

추가 단언(vitest):
- `isInsertContinueMarker({ ctrlKey:true, key:'y' }) === true`, `isInsertContinueMarker({ altKey:true, key:'y' }) === false`
- `insertContinueMarker([textBlock('a'), textBlock('b')], 0)` → blocks 텍스트 `['a','(계속)','b']`, **`caretTextLine===1`**
- `insertContinueMarker([textBlock('a'), textBlock('(끝)')], null)` → `['a','(계속)','(끝)']`("(끝)" 앞 보존), `caretTextLine===1`
- `transformTextLine([textBlock('abc'), textBlock('def')], 1, toUpper)` → 둘째 줄 'DEF', 첫째 줄 'abc' 불변
- `toUpper('aB')==='AB'`, `toLower('aB')==='ab'`, `capitalizeFirst('aBC')==='Abc'`, `toggleCase('aBc')==='AbC'`

## 검증 절차

1. 위 AC 커맨드를 실행한다.
2. 아키텍처 체크리스트: 순수 함수(view), ADR 위반 없음, 에디터 무변경, 범위 준수.
3. 결과에 따라 `phases/9-editor-text-transforms/index.json`의 step 0을 업데이트:
   - 성공 → `"status": "completed"`, `"summary": "CONTINUE_MARKER·isInsertContinueMarker(Ctrl+Y)·insertContinueMarker·transformTextLine·대소문자 4종 요약"`
   - 3회 실패 → `"status": "error"`, `"error_message"`
   - 사용자 개입 필요 → `"status": "blocked"`, `"blocked_reason"` 후 중단

## 금지사항

- `Editor.jsx`/`WriterPage.jsx`를 수정하지 마라(결선은 Step 1).
- 정렬/undo·redo/선택연산을 구현하지 마라(별도 phase — 정렬은 블록모델+렌더 변경, undo/redo는 스냅샷 설계 필요).
- 입력 blocks 배열을 mutate하지 마라(순수 — 새 배열 반환).
- 기존 테스트를 깨뜨리지 마라.
