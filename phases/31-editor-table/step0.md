# Step 0: table-model — 표 임베드 데이터 모델·팩토리·순수 그리드 변환(단일 출처)

## 배경 / 요구사항

에디터 상단 '표' 메뉴 10종(`table.insert`/`delete`/`copy`/`cut`/`deleteRow`/`deleteCol`/`addRowAbove`/`addRowBelow`/`addColLeft`/`addColRight`, news.md L181)이 현재 전부 placeholder다(`EditorMenuBar.jsx` L69~83). 이 phase가 이를 결선한다. 핵심 기술 결정은 **기존 임베드 블록 모델 확장**이다 — 표를 `embedType:'table'` 임베드 블록으로 표현한다:

```
{ type: 'embed', embedType: 'table', rows: [ ["a","b","c"], ["d","e","f"] ] }
```

`rows`는 **2차원 문자열 배열**(행 × 셀)이다. 직렬화는 **기존 markupVersion 임베드 마커 방식을 그대로 재사용**한다 — `web/src/view/editorContent.js`의 `normalizeBlocks`(L27~35)가 임베드 블록을 `{ ...b, type:'embed' }`로 **모든 필드를 보존**하며 통과시키므로(알 수 없는 `embedType`도 버리지 않는다), `rows`를 포함한 table 임베드가 `serialize`/`deserialize` 왕복에서 그대로 살아남는다. **따라서 `editorContent.js`는 수정하지 않는다**(하위호환·비파괴). 이 step은 그 round-trip 보존을 테스트로 못 박고, 표 전용 순수 로직(팩토리·그리드 변환·정규화·타겟 탐색)을 **새 모듈 `web/src/view/tableModel.js`** 한 곳에 둔다.

이 step(step0)은 **순수 데이터/헬퍼 레이어만** 다룬다. **렌더(InlineEmbed/articleDetail)·다이얼로그·WriterPage 결선은 없다**(step1·2·3 담당). 임베드 객체와 2차원 배열을 직접 만들어 검증하는 자기완결 TDD가 가능하다.

## 읽어야 할 파일

- `/CLAUDE.md`, `/docs/ARCHITECTURE.md`(계층 분리·신뢰 경계·DB 비파괴), `/docs/ADR.md`(ADR-003 순수 로직 격리).
- `/docs/news.md` — L181(표 메뉴 10종), L156~172(에디터 임베드·블록 모델·크기 규칙 — 참고).
- `web/src/view/editorContent.js` — **수정 금지, 재사용 대상**. `embedBlock(embed)`(L14~16: `{ ...embed, type:'embed' }`), `isEmbedBlock`(L22~24), `normalizeBlocks`(L27~35: 임베드는 모든 필드 보존해 통과 — table 임베드가 round-trip에 살아남는 근거), `serialize`/`deserialize`(L38~59), `END_MARKER`. **`makeTableEmbed`는 반드시 `embedBlock(...)`을 통해 만든다**(다른 팩토리와 동형).
- `web/src/view/editorContent.test.js` — round-trip/normalize 테스트 컨벤션(vitest, `import { serialize, deserialize } from './editorContent.js'`).
- `web/src/view/clipboardEmbed.js` — **직접 템플릿(팩토리 패턴)**. `makeImageEmbed`/`makeVideoEmbed`/`makeArticleEmbed`/`makeAudioEmbed`/`makeLinkEmbed`/`makeLocalVideoEmbed`(L75~146)가 모두 `embedBlock({ embedType, ...필드 })`를 반환하고, **빈/부적격 입력 시 `null`을 반환**(예 L114~117: 트림 후 빈 src면 null → `insertEmbed` no-op)하는 규칙. `makeTableEmbed`도 동일 규칙(빈 표는 null).
- `web/src/view/clipboardEmbed.test.js` — 팩토리 단위 테스트 컨벤션.
- `web/src/view/writerBody.js` — `textLineToBlockIndex(blocks, textLineIndex)`(L30~39: 텍스트 줄 인덱스 → blocks 배열 인덱스, 텍스트 블록만 카운트). **읽기 참조만(import 아님)** — `findTargetTableIndex`는 이 헬퍼가 산출하는 **블록 인덱스**를 입력으로 받는 좌표 계약만 공유한다. 변환(텍스트-줄→블록 인덱스)은 Step 3(WriterPage)의 책임이고, tableModel 안에서는 이 함수를 호출할 곳이 없다(import하면 no-unused-vars로 lint 실패).

## 작업

TDD로 진행한다(vitest). 먼저 `web/src/view/tableModel.test.js`를 작성하고, 통과하는 `web/src/view/tableModel.js`를 만든다. **모든 함수는 순수 함수**다(입력을 변형하지 않고 새 배열/객체 반환 — model/fetch/window/document/localStorage 미사용).

### 시그니처 (수준 지시 — 구현은 재량, 규칙은 준수)

```js
// web/src/view/tableModel.js — 표(table) 임베드 순수 데이터 모델·그리드 변환(단일 출처).
// 표는 embedType:'table' 임베드 블록으로, payload는 2차원 문자열 배열(rows[행][셀])이다.
// 직렬화는 editorContent(embedBlock/serialize/deserialize)를 그대로 재사용한다 — 이 모듈은 순수 로직만.
import { embedBlock, isEmbedBlock } from './editorContent.js';

export const TABLE_EMBED_TYPE = 'table';

// rows를 '직사각형 2차원 문자열 배열'로 정규화한다(방어적 단일 출처).
//  - 배열 아님/빈 배열 → []. 각 행이 배열 아니면 빈 행으로. 셀은 String(...)으로 강제(문자열 아님/null → '').
//  - 열 수를 최대 열 수로 맞춰 패딩('')한다(ragged 행 방지 — 렌더/변환이 항상 직사각형 가정 가능).
export function normalizeTableRows(rows) { /* → string[][] */ }

// r행 × c열의 빈 문자열 그리드를 만든다(표 삽입 기본 그리드). r,c는 1 이상으로 클램프.
export function makeEmptyTableRows(r, c) { /* → string[][] */ }

// 표 임베드 팩토리 — 다른 make*Embed와 동형. rows를 정규화해 embedBlock으로 감싼다.
// 정규화 결과가 비어 있으면(행 0 또는 열 0) null 반환(insertEmbed no-op — clipboardEmbed 팩토리 규칙과 동일).
export function makeTableEmbed(rows) { /* → {type:'embed',embedType:'table',rows} | null */ }

// 표 임베드 여부(embedType === 'table'). isEmbedBlock 가드 후 판정.
export function isTableEmbed(block) { /* → boolean */ }

// 그리드 순수 변환 — 입력 rows를 변형하지 않고 새 2차원 배열 반환. 항상 normalizeTableRows를 먼저 적용해 직사각형 보장.
//  index는 0-base. 범위 밖 index는 클램프(예: index<0 → 0, index>len → len). 빈 표에서의 delete는 원본 그대로.
export function insertRow(rows, index) { /* index 위치에 빈 행 삽입(열 수는 기존 열 수, 표가 비면 1열) */ }
export function insertCol(rows, index) { /* 모든 행의 index 위치에 빈 셀 삽입 */ }
export function deleteRow(rows, index) { /* index 행 삭제. 행이 1개뿐이면 삭제하지 않고 원본 반환(최소 1행 유지) */ }
export function deleteCol(rows, index) { /* 모든 행의 index 열 삭제. 열이 1개뿐이면 원본 반환(최소 1열 유지) */ }
export function setCell(rows, r, c, value) { /* (r,c) 셀을 String(value)로 교체. 범위 밖이면 원본 반환 */ }

// 표 → 탭 구분 텍스트(TSV) — 표 복사/잘라내기가 시스템 클립보드에 쓸 표현. 행은 '\n', 셀은 '\t'로 잇는다.
// 셀 안의 개행/탭은 공백으로 치환(구분자 파괴 방지). 순수 문자열 변환일 뿐(클립보드 접근은 WriterPage step3).
export function tableToTsv(rows) { /* → string */ }

// 메뉴 표 연산(행/열 추가·삭제·복사·잘라내기·삭제)의 '대상 표' 블록 인덱스를 캐럿 인접으로 도출한다.
//  fromBlockIndex: 현재 캐럿의 blocks 배열 인덱스(WriterPage가 textLineToBlockIndex로 계산해 전달). null 허용.
//  규칙: fromBlockIndex부터 (1) 뒤로(다음 블록들) 가장 가까운 table 임베드, 없으면 (2) 앞으로 가장 가까운 table 임베드.
//        fromBlockIndex가 null/범위 밖이면 (3) blocks 중 마지막 table 임베드. table 임베드가 하나도 없으면 -1.
export function findTargetTableIndex(blocks, fromBlockIndex) { /* → number(블록 인덱스) | -1 */ }
```

### round-trip 하위호환 보증(테스트로 못 박기)

`tableModel.test.js`에 **editorContent를 통한 왕복 보존** 단언을 넣는다(하위호환 회귀 방지):

- `makeTableEmbed([["가","나"],["다","라"]])` → `serialize([embed])` → `deserialize(...)`의 결과 블록에 `rows`가 **정확히 보존**된다(2차원 문자열 배열 동일).
- 텍스트 블록과 table 임베드가 섞인 블록 배열도 순서·`rows` 보존(예: `[textBlock('제목'), tableEmbed, textBlock('본문')]`).
- `normalizeBlocks`/`serialize`가 table 임베드를 버리지 않는다(알 수 없는 kind로 취급해 드롭하지 않음).

## 핵심 규칙 (반드시 준수 — 위반 시 반려)

1. **`editorContent.js` 수정 금지**: table 임베드는 기존 `normalizeBlocks`가 이미 보존한다. `editorContent.js`에 table 전용 분기를 추가하지 마라. 이유: 임베드 모델은 kind-agnostic이어야 하고, 기존 기사(표 없는)·타 임베드와의 하위호환·비파괴를 깬다.
2. **순수 함수·불변**: 모든 변환은 입력 `rows`/`blocks`를 **변형(mutate)하지 않고** 새 배열을 반환한다. `model`/`fetch`/`window`/`document`/`localStorage`/`navigator` 접근 금지. 이유: 계층 분리(ADR-003)·테스트 격리·React state 오염 방지.
3. **직사각형·문자열 강제**: `rows`는 항상 `normalizeTableRows`로 직사각형(모든 행 동일 열 수)·전 셀 문자열이 되게 한다. 셀은 `String(...)`로 강제하고 `null`/`undefined`/숫자/객체가 그대로 렌더 경로로 새지 않게 한다. 이유: 렌더(step1)·다이얼로그(step2)가 직사각형·문자열을 가정하므로 여기서 단일 출처로 보증. **셀 값에 대한 HTML 이스케이프/innerHTML은 여기서 하지 않는다**(렌더 레이어 책임 — step1).
4. **최소 크기 불변식**: `deleteRow`는 최소 1행, `deleteCol`은 최소 1열을 남긴다(0×N/N×0 표 방지 — 렌더가 빈 표를 그리지 않게). `makeTableEmbed`는 빈 표(행/열 0)면 null. 이유: 빈 표는 의미 없고 렌더/타겟 탐색에서 엣지 케이스를 늘린다.
5. **좌표계 일치**: `findTargetTableIndex`의 `fromBlockIndex`는 **blocks 배열 인덱스**다(`writerBody.textLineToBlockIndex`가 산출하는 값과 같은 좌표계 — 문서 계약). 이 함수는 좌표 변환을 하지 않는다 — 텍스트-줄→블록 인덱스 변환은 Step 3(WriterPage)의 책임이고, `writerBody`를 import하지 마라(호출할 곳이 없어 no-unused-vars lint 실패 + 입력을 텍스트-줄 인덱스로 바꾸면 Step 3와 좌표계가 어긋나 오대상 버그). 이유: WriterPage가 변환한 블록 인덱스를 그대로 넘길 수 있어야 한다.
6. **팩토리 위치**: `makeTableEmbed`는 `clipboardEmbed.js`가 아니라 `tableModel.js`에 둔다(표 전용 로직 응집). 단 반드시 `editorContent.embedBlock`으로 생성해 다른 임베드와 직렬화 동형을 유지한다. 이유: 표는 팩토리 외에 그리드 변환·정규화·타겟 탐색이 함께 있어 한 모듈로 묶는 게 응집도가 높다(clipboardEmbed는 미디어/링크 전용 유지).

## Acceptance Criteria

```bash
npm run test:web -- tableModel        # 신규 tableModel.test.js 통과(vitest 파일 필터)
npm run test:web -- editorContent     # 기존 회귀(임베드 보존) 통과
npm run test:web                      # web 전체 회귀 통과
npm run build
npm run lint
```

추가 단언(vitest, `tableModel.test.js`):

- `normalizeTableRows([["a"],["b","c"]])` → 직사각형(`[["a",""],["b","c"]]`), `normalizeTableRows(null)` → `[]`, `normalizeTableRows([[1,null]])` → `[["1",""]]`(문자열 강제).
- `makeEmptyTableRows(2,3)` → 2행 3열 전부 `''`. `makeEmptyTableRows(0,0)` → 최소 1×1.
- `makeTableEmbed([["가","나"]])` → `{type:'embed',embedType:'table',rows:[["가","나"]]}`; `makeTableEmbed([])` === `null`; `makeTableEmbed(null)` === `null`.
- `isTableEmbed({type:'embed',embedType:'table',rows:[]})` === true; `isTableEmbed({type:'embed',embedType:'image'})` === false; `isTableEmbed({type:'text'})` === false.
- `insertRow`/`insertCol`이 지정 index에 빈 행/열을 넣고 직사각형을 유지하며 **원본을 변형하지 않는다**(원본 `rows` 참조가 그대로).
- `deleteRow([["a"],["b"]],0)` → `[["b"]]`; `deleteRow([["a"]],0)` → `[["a"]]`(최소 1행 유지). `deleteCol` 동형(최소 1열).
- `setCell([["a","b"]],0,1,'x')` → `[["a","x"]]`; 범위 밖 `setCell(...,5,5,'x')` → 원본 동일.
- `tableToTsv([["a","b"],["c","d"]])` === `"a\tb\nc\td"`; 셀 안 `"x\ty"`는 구분자 파괴 없이 공백 등으로 치환됨.
- `findTargetTableIndex([text, table, text], 0)` → `1`(뒤쪽 표); `findTargetTableIndex([text, table, text], 2)` → `1`(앞쪽 폴백); table 없으면 `-1`; 여러 표에서 캐럿 뒤 가장 가까운 표를 고른다.
- **round-trip**: `deserialize(serialize([makeTableEmbed([["가","나"],["다","라"]])]))[0].rows` deep-equals `[["가","나"],["다","라"]]`.

## 검증 절차

1. 위 AC 커맨드를 실행한다(Windows에서 한글 깨지면 `PYTHONUTF8=1` 등 UTF-8 로케일 확인).
2. 아키텍처 체크리스트:
   - `tableModel.js`는 순수(`grep`으로 `fetch`/`window`/`document`/`localStorage`/`navigator` 미사용 확인).
   - `editorContent.js` diff 없음(round-trip은 기존 `normalizeBlocks`로만 성립).
   - `findTargetTableIndex`가 블록 인덱스를 입력으로 받고(좌표 변환 없음), `tableModel.js`에 `writerBody` import가 **없음**(미사용 import는 lint 실패).
   - 모든 변환이 입력을 변형하지 않음(원본 참조 불변 단언 green).
3. 결과에 따라 `phases/31-editor-table/index.json`의 step 0을 갱신(completed+summary / error / blocked).

## 금지사항

- `editorContent.js`를 수정하지 마라(table 전용 분기 추가 포함). 이유: 임베드 모델은 kind-agnostic — 기존 기사·타 임베드 하위호환/비파괴를 깬다. 이미 `normalizeBlocks`가 보존한다.
- 렌더(`InlineEmbed`/`articleDetail`)·다이얼로그(`TableEditDialog`)·`WriterPage` 결선을 이 step에서 만들지 마라. 이유: Scope 최소화 — step1·2·3 담당.
- 셀 값을 HTML로 이스케이프하거나 innerHTML용 문자열을 만들지 마라. 이유: XSS 방어는 렌더 레이어(step1)의 텍스트-only 렌더로 하며, 데이터 모델은 원본 문자열만 보관한다(이중 이스케이프·데이터 오염 방지).
- 입력 `rows`/`blocks` 배열을 직접 `push`/`splice`로 변형하지 마라. 이유: React state 참조 공유 시 stale/오작동 — 순수 함수 계약 위반.
- `clipboardEmbed.js`에 `makeTableEmbed`를 넣지 마라. 이유: 표 전용 로직은 `tableModel.js`에 응집(clipboardEmbed는 미디어/링크 전용).
- `navigator.clipboard` 등 클립보드 실접근을 이 모듈에 넣지 마라. 이유: `tableToTsv`는 순수 문자열 변환까지만 — 클립보드 I/O는 WriterPage(step3) 책임(순수성·테스트 격리).
