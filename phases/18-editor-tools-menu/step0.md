# Step 0: insert-date-pure — 날짜 문자열 캐럿 삽입 순수 헬퍼

## 배경 / 요구사항

도구 메뉴 '날짜 삽입'(`tools.insertDate`, news.md L180)은 현재 날짜/시각을 날짜형식 prefs(`dateFormat`, 9종)대로 포맷해 본문 캐럿 위치에 **텍스트로** 삽입한다. 약물입력(phase17)과 동일하게 "텍스트 줄 안 컬럼에 짧은 문자열을 끼워넣는" 연산이다.

**현재 날짜는 비결정적**이다(`new Date()`). 테스트 가능성을 위해 이 step의 순수 헬퍼는 **이미 포맷된 날짜 문자열을 인자로 받는다**(`dateString`). `new Date()` 호출과 포맷팅(`applyDateFormat`)은 Step 1 WriterPage에서만 한다.

이 step은 그 **순수 계산 헬퍼**만 만든다(결선은 Step 1). 약물 삽입 헬퍼 `web/src/view/editorGlyph.js`의 `insertGlyphAtCaret(blocks, caret, glyph)`와 **동일한 좌표계·동일한 폴백·동일한 불변식**을 따른다 — 사실상 "삽입할 문자열이 약물이냐 날짜냐"만 다르다.

## 읽어야 할 파일

- `/CLAUDE.md`, `/docs/ARCHITECTURE.md`, `/docs/ADR.md` — ADR-003(순수 함수, transport 비의존), DB 비파괴·TDD.
- `/docs/news.md` — L180(도구 메뉴 '날짜 삽입'), L204~205(환경설정 날짜형식 9종), L156~171(본문 블록 구조·임베드·"(끝)" 불변).
- `web/src/view/editorGlyph.js` — **이 step의 직접 템플릿**. `insertGlyphAtCaret(blocks, caret, glyph) → { blocks, caretTextLine }`, `normalizeGlyph`, `lastEditableTextBlockIndex`, `blockIndexToTextLine`. 좌표(blocksToText 절대 오프셋)·캐럿 유효성 판정("(끝)" 블록 제외)·폴백(마지막 편집가능 텍스트 줄 끝, 텍스트 블록 없으면 첫 블록 생성)·입력 mutate 금지 패턴을 그대로 가져온다.
- `web/src/view/editorGlyph.test.js` — 테스트 컨벤션(17 케이스): no-op·정확 컬럼·폴백·"(끝)" 보존·임베드 불변·입력 불변. 같은 구조로 작성한다.
- `web/src/view/editorContent.js` — `textBlock`/`blocksToText`/`normalizeBlocks`/`END_MARKER`/`serialize`(직접 쓰진 않음 — 구조 파악).
- `web/src/view/editorCaret.js` — `lineAtOffset(text, offset) → { lineIndex, start }`(줄 시작 오프셋).
- `web/src/view/writerBody.js` — `textLineToBlockIndex(blocks, textLineIndex)`(텍스트-줄 → blocks 인덱스).
- `web/src/view/listFormat.js` — `applyDateFormat(iso, format)`(참고만 — 이 step에서 호출하지 않는다; Step 1이 날짜 문자열을 만들 때 쓴다). 날짜 문자열은 이미 완성된 평문이라는 점만 확인.

## 작업

TDD로 진행한다(vitest). 먼저 `web/src/view/editorDate.js`의 테스트 `web/src/view/editorDate.test.js`를 작성하고, 통과하는 `web/src/view/editorDate.js`를 만든다.

### 헬퍼 계약 (시그니처 수준)

```js
// 날짜(이미 포맷된 문자열)를 캐럿 {lineIndex, offset}의 텍스트 줄 안 컬럼에 삽입한 새 블록 배열을 돌려준다.
// 좌표/폴백/불변식은 editorGlyph.insertGlyphAtCaret와 동일하다. 비결정 시각(new Date)은 호출자(Step 1)가 주입한다.
// 반환: { blocks, caretTextLine }  — blocks: 새 배열(입력 mutate 금지), caretTextLine: 삽입 줄 텍스트-줄 인덱스 또는 null.
export function insertDateAtCaret(blocks, caret, dateString) { ... }

// (선택) 날짜 문자열 정규화 — null/undefined→'' , 트림. normalizeGlyph와 동형.
export function normalizeDateString(dateString) { ... }
```

요구사항:
- `dateString`이 빈값/공백뿐이면 **no-op**: `{ blocks: normalizeBlocks(blocks), caretTextLine: null }`.
- `caret`이 유효하면(텍스트 블록 범위 안 + "(끝)" 블록 아님) `lineAtOffset`으로 줄 시작을 구하고 `col = caret.offset - start`로 줄 안 컬럼에 `slice` 삽입한다.
- `caret`이 null/범위 밖/"(끝)" 줄을 가리키면 **폴백**: "(끝)"이 아닌 마지막 텍스트 줄 끝에 삽입(텍스트 블록이 전혀 없으면 첫 텍스트 블록을 만들어 날짜만 담고 임베드는 보존·맨 앞).
- 임베드·"(끝)"·블록 순서·개수 **불변**. 입력 `blocks`를 **mutate하지 않는다**(새 배열/새 textBlock만).
- 날짜 문자열은 **이미 완성된 평문**이다 — 이 헬퍼는 포맷팅/`Date`/타임존을 다루지 않는다(개행을 포함하지 않는 한 줄 문자열로 가정하되, 멀티라인이 들어와도 약물처럼 그대로 한 텍스트 블록 안에 끼워넣는다 — 줄 분할은 하지 않는다).

구현 메모: `editorGlyph.js`를 거의 그대로 복제하되 변수명만 날짜로 바꾸면 된다. **단, `editorGlyph.js`를 수정하거나 거기서 export를 빼오지 마라**(중복처럼 보여도 "약물"과 "날짜"는 별개 관심사 — 한쪽 변경이 다른 쪽을 깨면 안 된다). 공통화하고 싶더라도 이번 step에서는 하지 않는다(Scope 최소화 — 리팩터링은 별도).

## 핵심 규칙 (반드시 준수 — 위반 시 반려)

1. **순수 함수(ADR-003)**: model/fetch/transport/localStorage/window/document/React 호출 금지. `new Date()`·`Date.now()` 호출 금지(비결정성은 호출자 주입). 이유: 테스트 가능성·계층 분리.
2. **DB·"(끝)"·임베드 불변**: "(끝)" 텍스트 블록을 건드리지 마라(약물 헬퍼와 동일 — `END_MARKER` 줄은 삽입 대상에서 제외하고 폴백한다). 임베드 블록의 순서·개수·내용을 바꾸지 마라. 이유: 본문 불변식·DB 비파괴.
3. **입력 mutate 금지**: 인자 `blocks`를 in-place 변경하지 마라(`.slice()` + 새 `textBlock`). 이유: 순수성 — 호출자가 이전 상태를 신뢰.
4. **editorGlyph.js 미접촉**: `editorGlyph.js`를 import/수정/공통화하지 마라. 이유: 관심사 분리(약물 헬퍼 회귀 차단).
5. **줄 분할 금지**: 날짜 문자열을 줄로 쪼개 새 텍스트 블록을 만들지 마라(약물과 동일 — 한 텍스트 블록의 text만 바꾼다). 이유: 블록 개수 불변식.

## Acceptance Criteria

```bash
cd web && npm run test -- editorDate    # 신규 editorDate.test.js 통과
cd .. && npm run test:web               # web 전체 회귀 통과(편집 헬퍼 회귀 없음)
npm run build
npm run lint
```

추가 단언(vitest, `editorDate.test.js` — `editorGlyph.test.js` 케이스를 날짜로 미러):
- `insertDateAtCaret([textBlock('가나다')], { lineIndex: 0, offset: 2 }, '2026-06-24')` → 0번 텍스트 블록이 `'가나2026-06-24다'`, `caretTextLine === 0`.
- 빈/공백 `dateString`(`''`, `'   '`)이면 no-op(`caretTextLine === null`, 본문 텍스트 불변).
- `caret`이 null이면 "(끝)"이 아닌 마지막 텍스트 줄 끝에 삽입된다.
- 캐럿이 "(끝)" 줄을 가리키면 "(끝)"은 불변이고 폴백(이전 편집가능 줄 끝)에 삽입된다.
- 임베드가 섞인 블록 배열에서 임베드의 순서·개수·`embedType`이 불변이다(텍스트 블록만 바뀜).
- 텍스트 블록이 전혀 없고 임베드만 있는 배열 + `caret=null` → 첫 텍스트 블록이 생기고 임베드는 보존된다.
- 호출 후 입력 `blocks` 배열·요소가 변형되지 않는다(`toEqual` 스냅샷 비교).

## 검증 절차

1. 위 AC 커맨드를 실행한다(필요 시 `PYTHONUTF8=1`).
2. 아키텍처 체크리스트: 순수 함수(Date/transport/DOM 없음), "(끝)"·임베드 불변, 입력 mutate 없음, `editorGlyph.js` 미접촉.
3. 결과에 따라 `phases/18-editor-tools-menu/index.json`의 step 0을 갱신(completed+summary / error / blocked).

## 금지사항

- `new Date()`·`Date.now()`·`applyDateFormat` 등 시각/포맷팅을 이 헬퍼 안에서 호출하지 마라. 이유: 비결정성은 Step 1 호출자 주입 — 순수 헬퍼는 테스트 가능해야 한다.
- `editorGlyph.js`를 수정하거나 거기 export를 재사용해 약물/날짜를 한 함수로 합치지 마라. 이유: 관심사 분리 — 약물 헬퍼 회귀를 차단한다.
- "(끝)" 블록의 text를 바꾸거나 임베드 순서를 재배치하지 마라. 이유: 본문 불변식·DB 비파괴.
- 날짜 문자열을 줄(`\n`)로 분할해 블록을 추가하지 마라. 이유: 블록 개수 불변식(약물 헬퍼와 동일).
- `Editor.jsx`/`WriterPage.jsx`/`server/`를 수정하지 마라(이 step은 신규 헬퍼+테스트만). 이유: 결선은 Step 1.
