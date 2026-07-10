# Step 3: edit-ops-pure — 문서/문단 정렬 · 단어 삭제 순수 함수

## 이 step의 목표

편집 메뉴의 **문서 정렬(`edit.sortDocument`) · 문단 정렬(`edit.sortParagraph`) · 단어 지우기(`edit.deleteWord`)** 를 계산하는 순수 함수를 신설한다(블록 배열 in → 블록 배열 out, DOM/transport 비의존 — `editorShortcuts.js`의 `transformTextLine`/`deleteLineAt`와 동일 계층). **한줄 지우기(`edit.deleteLine`)는 새 헬퍼를 만들지 않는다** — 기존 `deleteLineAt`(Ctrl+D 단일 출처)를 step 4에서 재사용한다.

이 step은 결선하지 않는다(헬퍼 + 단위 테스트만).

## "(끝)" 마커 · 임베드 정책 (반드시 코드에 박아라)

형제 텍스트 도구(abbrevConvert·simpTradConvert·editorGlyph·editorDate·editorFind[phase 27])는 모두 `String(block.text).trim() === END_MARKER`인 텍스트 블록을 건드리지 않는다. 이 phase의 정렬/삭제도 **동일 가문 규칙**을 따르되, 연산 성격에 맞춰 아래처럼 확정한다:

- **정렬(sortDocument / sortParagraph)** — "(끝)" 마커는 정렬 대상에서 **제외**하고 항상 최종 블록으로 둔다(`insertContinueMarker`/`insertEmbedAfterLine`이 마커를 최종으로 재정규화하는 것과 동형). 이유: 정렬이 마커를 문서 중간으로 이동시키면 "(끝) = 최종 블록" 불변식이 깨져 송고 자격/직렬화가 흔들린다.
- **정렬의 임베드 정책** — 임베드 블록은 정렬 대상이 **아니며 자리를 옮기지 않는다**(제자리 유지). 정렬은 **텍스트 블록의 문자열 값만** 정렬해 원래 텍스트-블록 슬롯에 순서대로 되쓴다. 이유: news.md L161·167 "임베드는 커서/DOM 순서 보존" 불변식. (트레이드오프: 임베드 앞뒤 텍스트가 재정렬되면 임베드는 새 이웃과 남는다 — 결정적·비파괴이므로 수용.)
- **단어 지우기(deleteWord)** — 캐럿 줄이 "(끝)" 마커 줄이면 **no-op**(마커 보존). 이유: 단어 삭제는 줄의 일부만 지우므로 마커를 `끝)` 같은 **손상된 조각**으로 만들어 송고 자격을 조용히 깬다(phase 27 find/replace 마커 손상과 동형). 임베드는 한 텍스트 줄 문자열만 편집하므로 자연히 무관(불변).
- (참고 — step 4용) **한줄 지우기(deleteLine)** 는 `deleteLineAt`을 그대로 재사용하며 마커 줄 **통째 삭제는 허용**된다(news.md L167 "(끝)을 지우면 입력이 재개된다" — 의도된 완전 삭제). 정렬/단어삭제와 달리 별도 마커 가드를 두지 않는 이유는 이 문서에 기록만 하고 구현은 step 4에서 한다.

## 읽어야 할 파일

먼저 아래를 읽고 설계 의도를 파악하라:

- `/CLAUDE.md`, `/docs/ARCHITECTURE.md`, `/docs/ADR.md` — 순수 view 로직, zero-dep, TDD, DB 비파괴.
- `/docs/news.md` — L161·L165~169(임베드/"(끝)" 규칙), L178(편집 메뉴 정렬/삭제).
- **이전 step 산출물(반드시 읽기):** `web/src/view/editorRange.js` (step 0) — `paragraphBoundsAt(linesArr, lineIndex)`(문단 줄 범위). sortParagraph가 이걸 쓴다. (`wordBoundsAt`는 deleteWord가 쓴다.)
- `web/src/view/editorContent.js` — `END_MARKER`, `textBlock`, `normalizeBlocks`, `blocksToText`, `isTextBlock`, `isEmbedBlock`. import 단일 출처.
- `web/src/view/editorShortcuts.js` — **핵심 선례**. `transformTextLine(blocks, textLineIndex, fn)`(텍스트-줄 단위 편집, 임베드 제외 카운팅), `deleteLineAt(blocks, index)`(줄 삭제 + 동반 임베드 1개), `insertContinueMarker`(마커 최종 재정규화 로직). 이 스타일·불변(입력 blocks 미변형)을 따른다.
- `web/src/view/writerBody.js` — `textLineToBlockIndex(blocks, textLineIndex)`(텍스트-줄 인덱스 → 블록 배열 인덱스, 텍스트 블록만 0-base 카운트). deleteWord/sortParagraph의 줄↔블록 매핑에 쓴다.
- `web/src/view/abbrevConvert.js`(약 62행)·`web/src/view/editorFind.js`(phase 27 마커 가드) — 마커 스킵 선례(`String(b.text).trim() === END_MARKER` 비교) 동형 확인.
- `web/src/view/editorShortcuts.test.js` — 순수 함수 vitest 스타일.

## 작업 (TDD — 테스트 먼저)

신규 파일 `web/src/view/editorEditOps.js` + `web/src/view/editorEditOps.test.js`. 시그니처는 아래, 구현 재량, 계약 준수.

```js
// 문서 전체 텍스트 줄 값을 정렬한다. "(끝)" 마커·임베드 제외, 마커는 최종 블록으로 유지.
// 반환 { blocks, changed }.
export function sortDocument(blocks) { ... }

// caretLineIndex(텍스트-줄 인덱스)가 속한 문단 내부 텍스트 줄 값만 정렬한다. 마커 제외, 임베드 무관.
// 반환 { blocks, changed }.
export function sortParagraph(blocks, caretLineIndex) { ... }

// caretLineIndex 텍스트 줄의 column(줄-로컬) 위치 단어를 삭제한다. 마커 줄이면 no-op.
// 반환 { blocks, changed, caretColumn }. caretColumn = 삭제 후 캐럿을 둘 줄-로컬 위치(보통 단어 start).
export function deleteWordAt(blocks, caretLineIndex, column) { ... }
```

### 계약 / 엣지 (반드시 준수)

**공통**: `normalizeBlocks`로 정규화 후 새 배열을 반환(입력 blocks 미변형). `END_MARKER`는 `editorContent.js`에서 import(하드코딩 금지). 변경이 없으면 `changed:false`로 no-op 신호(상위가 불필요한 dirty/remount 회피).

**sortDocument**
- 정렬 대상 = 텍스트 블록 중 `trim() !== END_MARKER`인 것들의 `.text` 값. 임베드·마커 제외.
- 정렬 순서: `localeCompare` **오름차순**(결정적, 한글/혼합 처리). 빈 줄(`''`)은 값 `''`로 함께 정렬. JS `Array.prototype.sort`는 안정 정렬이라 동일 값 상대 순서 보존.
- 되쓰기: 정렬된 값을 **원래 텍스트-블록 슬롯**(마커·임베드 슬롯 제외)에 순서대로 대입. 임베드는 제자리 유지.
- 마커 최종화: 결과에서 마커 블록을 제거해 맨 끝에 다시 push(입력이 malformed로 마커가 중간에 있어도 최종 보장 — `insertContinueMarker` 규칙 동형).
- 정렬 결과가 원문과 동일하면 `changed:false`.

**sortParagraph**
- `linesArr = blocksToText(list).split('\n')`; `{ startLine, endLine } = paragraphBoundsAt(linesArr, caretLineIndex)`.
- `startLine..endLine`(포함)의 텍스트-줄 값만 `localeCompare` 오름차순 정렬해 그 슬롯들에 되쓴다. 그 범위 안에 마커 줄이 있으면 정렬 대상에서 제외하고 위치 보존(정상 문서에선 문단과 마커가 겹치지 않지만 방어).
- 줄↔블록 매핑은 `textLineToBlockIndex` 사용. 임베드는 blocksToText에서 이미 빠져 문단 계산·정렬에 무관(불변).
- 단일 줄 문단/빈 줄이면 정렬 대상 1개 이하 → `changed:false`.

**deleteWordAt**
- `blockIndex = textLineToBlockIndex(list, caretLineIndex)`; `< 0`이면 no-op(`changed:false`).
- 대상 블록 텍스트 `trim() === END_MARKER`면 **no-op**(마커 보존).
- `lineText = list[blockIndex].text`; `{ start, end } = wordBoundsAt(lineText, column)`(step 0). `start === end`(단어 없음/공백 위)면 no-op.
- `newText = lineText.slice(0, start) + lineText.slice(end)`(주변 공백은 병합/삭제하지 않음). 그 블록만 `textBlock(newText)`로 교체. `caretColumn = start`.

### 테스트(먼저 작성) — 최소 케이스

- sortDocument: 여러 줄 오름차순 정렬 / "(끝)" 마커가 최종 유지 & 미정렬 / 임베드 제자리 유지(임베드 앞뒤 텍스트가 정렬돼도 임베드 index 불변) / 이미 정렬됨 → `changed:false` / 한글·혼합 정렬 1케이스.
- sortParagraph: 빈 줄로 나뉜 2문단에서 한 문단만 정렬되고 다른 문단·빈 줄 불변 / 마커 줄이 문단 밖이면 불변 / 단일 줄 문단 → `changed:false`.
- deleteWordAt: 단어 중간 삭제(그 단어만 제거, 주변 공백 유지) / 마커 줄이면 no-op(`changed:false`) / 공백 위 no-op / 첫 줄 단어 삭제로 첫 줄 텍스트 변경(제목 재동기화는 step 4가 처리) / 임베드 블록 개수/위치 불변.
- 모든 함수: 입력 blocks 배열이 변형되지 않음(불변) 단언.

## Acceptance Criteria

```bash
npm run test:web    # editorEditOps 신규 테스트 + 기존 web 회귀 통과 (vitest)
npm run build
npm run lint
```

UTF-8 저장(마커 "(끝)"·한글 포함).

## 검증 절차

1. 위 AC 커맨드 실행.
2. 아키텍처 체크리스트: 순수 함수(DOM/transport 비의존)? `END_MARKER` 단일 출처 import? 마커 최종화·임베드 제자리·마커 줄 스킵 정책이 코드에 반영? 입력 blocks 불변? zero-dep·DB 비파괴?
3. `phases/29-editor-edit-menu/index.json`의 step 3 업데이트(성공 completed·3회 실패 error·개입 blocked).

## 금지사항

- `Editor.jsx`·`WriterPage.jsx`·`editorSelect.js`를 수정하지 마라. 이유: 이 step은 순수 계산만. 결선은 step 4에서 격리 처리한다.
- `END_MARKER` 문자열(`'(끝)'`)을 이 파일에 하드코딩하지 마라. 이유: 형제 도구/`editorContent.js`와 출처가 갈라지면 마커 정의 변경 시 불일치가 생긴다 — import한다.
- 정렬이 "(끝)" 마커를 문서 중간으로 이동시키거나 정렬 대상에 포함하지 마라. 이유: "(끝) = 최종 블록" 불변식이 깨져 송고 자격/직렬화가 흔들린다(phase 27 마커 보호와 동일 취지).
- 정렬이 임베드 블록을 이동/삭제하게 하지 마라. 이유: news.md L161·167 "임베드 위치 보존" 불변식 위반.
- deleteWord가 마커 줄에서 부분 삭제하게 하지 마라. 이유: `끝)` 등 손상 조각이 되어 송고 자격이 조용히 깨진다.
- `deleteLine`용 새 헬퍼를 만들지 마라. 이유: `deleteLineAt`(Ctrl+D)이 단일 출처다 — 삭제 의미가 갈라지면 회귀 위험.
- 새 npm 의존성 추가·DB/서버 수정·기존 테스트 파괴 금지.
