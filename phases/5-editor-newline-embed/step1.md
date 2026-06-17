# Step 1: writerbody-embed-newline — 임베드 커서-줄 뒤 삽입 + 빈 줄 헬퍼

## 읽어야 할 파일

먼저 아래 파일들을 읽고 설계 의도를 파악하라:

- `/docs/news.md` — `## 기사 에디터`("본문 **커서 위치**에 임베딩", 156·167행 커서/블록 순서 보존), `/docs/ARCHITECTURE.md`, `/CLAUDE.md`
- `web/src/view/writerBody.js` — `serializeBodyFromBlocks`, `insertEmbedIntoBody`, `appendEmbedToBody`, `bodyTitle`.
- `web/src/view/writerBody.test.js` — 기존 계약(임베드 위치 보존, "(끝)" 최종 유지, blockIndex 삽입/폴백).
- `web/src/view/editorContent.js` — `deserialize`/`serialize`/`textBlock`/`isEmbedBlock`/`blocksToText`/`END_MARKER`.

이 step은 **순수 함수 레이어**만 다룬다. DOM/React/transport를 import하지 마라.

## 작업

`writerBody.js`에 헬퍼를 추가한다(이름 예시, 시그니처는 준수):

```js
// 임베드를 textLineIndex 텍스트 줄의 블록 "뒤"에 삽입하고, 임베드 뒤에 빈 텍스트 줄을 넣는다.
// 반환: { body: <직렬화 문자열>, caretTextLine: <새 빈 줄의 텍스트-줄 인덱스 | null> }
insertEmbedAfterLine(currentBody, embed, textLineIndex)
```

규칙:

- `embed`가 falsy면 `{ body: currentBody, caretTextLine: null }`.
- `textLineIndex`(0-base 텍스트 줄 인덱스)에 해당하는 블록을 찾아(텍스트 블록만 0-base로 세어 N번째 텍스트 줄의 배열 인덱스를 구함 — Editor의 textLine 카운팅·WriterPage `textLineToBlockIndex`와 **동일 동작**) 그 블록 **다음**에 `embed`를 삽입하고, 이어서 빈 `textBlock('')`을 삽입한다.
  - **주의**: `textLineToBlockIndex`는 `WriterPage.jsx`의 **비-export 내부 함수**다(import 불가, 이 step은 DOM/React/transport import 금지). 동등한 "텍스트 블록만 세는" 로직을 `writerBody.js` 안에 자체 구현하라.
- `caretTextLine` = 삽입된 빈 줄의 텍스트-줄 인덱스(임베드는 텍스트 줄로 세지 않으므로 보통 `textLineIndex + 1`).
- `textLineIndex`가 `null`/음수/범위 밖이면 → 끝("(끝)" 앞)에 임베드 + 빈 줄을 추가(append 폴백). 이때 `caretTextLine`은 **반환 body를 기준으로 텍스트 블록만 0-base로 센 그 빈 줄의 인덱스**로 계산한다(`blocksToText`는 텍스트 블록만 카운트 — editorContent.js). 텍스트 줄이 0개인 embed-only 본문에서는 새 빈 줄이 유일한 텍스트 줄이므로 `caretTextLine = 0`.
- **"(끝)" 마커는 항상 최종 블록으로 유지**한다(`serializeBodyFromBlocks` 재사용). 빈 줄은 "(끝)" **앞**에 위치한다.
- 기존 임베드/텍스트 블록 순서는 재배치하지 않는다(끝 마커만 최종으로).

기존 `insertEmbedIntoBody`/`appendEmbedToBody`는 유지하되, 새 헬퍼가 이를 조합/확장해도 된다.

## Acceptance Criteria

```bash
npm run lint
npm run test:web
```

## 검증 절차

1. AC 실행(통과).
2. `writerBody.test.js`에 테스트 추가:
   - 지정 줄(예: 0) 뒤에 임베드 + 빈 줄 → 블록 타입 `['text','embed','text', ...]`, 빈 줄의 text가 `''`, `caretTextLine`이 그 빈 줄 인덱스와 일치.
   - "(끝)"이 있을 때 삽입해도 마지막이 "(끝)"이고 임베드 1개·빈 줄은 "(끝)" 앞.
   - `textLineIndex` 범위 밖 → 끝에 임베드+빈 줄, `caretTextLine` 정확.
   - **embed-only 본문(텍스트 줄 0개)**에 삽입(폴백) → 새 빈 줄이 유일한 텍스트 줄, `caretTextLine === 0`.
   - 임베드가 텍스트 줄 사이에 있는 본문에서 `textLineIndex`가 텍스트 줄만 세어 올바른 배열 인덱스로 환산되는지(임베드를 건너뛰는지) 확인.
   - `embed`가 없으면 본문 불변(`caretTextLine: null`).
3. 아키텍처 체크리스트:
   - 저장 포맷 `{format:'yh-editor',version:1,blocks}` 불변(백엔드 동일).
   - 순수 함수 — DOM/transport 비의존.
4. `phases/5-editor-newline-embed/index.json`의 step 1 업데이트(completed/summary | error/error_message | blocked/blocked_reason — step0과 동일 규칙).

## 금지사항

- 임베드/텍스트 블록의 기존 순서를 바꾸지 마라(끝 마커만 최종). 이유: 커서 위치/블록 순서 보존 명세(news.md 156·167행).
- `serialize`/`deserialize` 포맷을 바꾸지 마라. 이유: 백엔드 저장 포맷과 일치해야 한다.
- 기존 `writerBody.test.js` 테스트를 깨뜨리지 마라.
