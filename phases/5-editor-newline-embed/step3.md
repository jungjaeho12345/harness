# Step 3: writerpage-embed-wiring — 검색패널·붙여넣기 임베드 커서 삽입 + 개행 + 커서 이동

## 읽어야 할 파일

먼저 아래 파일들을 읽고 설계 의도를 파악하라:

- `/docs/news.md`(## 기사 에디터: "본문 커서 위치에 임베딩"), `/docs/ARCHITECTURE.md`, `/docs/ADR.md`(ADR-003 transport 경유), `/CLAUDE.md`
- `web/src/view/WriterPage.jsx` — `insertEmbed`(검색패널 픽 → 현재 `appendEmbedToBody`), `pasteEmbedAtCaret`, `onKeyDown`, `textLineToBlockIndex`, `<Editor … />` 결선, 매핑(`isMapping`).
  - **호출부 주의**: `insertEmbed`는 `SearchPanel`의 `onPick` 인라인 결선 3곳(이미지/영상/글기사)에서 `makeXxxEmbed(...)`를 먼저 호출한 뒤 `insertEmbed(embed)`로 들어온다. 즉 단일 `insertEmbed`만 고치면 세 탭 모두 커버된다.
  - `makeVideoEmbed`는 유튜브 URL이 아니면 `null`을 반환한다(`clipboardEmbed.js`). 따라서 `embed`가 falsy면 기존처럼 **no-op**(현 `insertEmbed`의 falsy 가드 보존 또는 `insertEmbedAfterLine`이 falsy를 그대로 통과).
- `web/src/view/WriterPage.test.jsx` — 붙여넣기 커서 삽입 테스트(`['text','embed','text']`), 매핑 검색 삽입(blocksToText 불변), 글기사/이미지 삽입.
- **Step 1 산출물**: `web/src/view/writerBody.js`의 `insertEmbedAfterLine(currentBody, embed, textLineIndex) -> { body, caretTextLine }`.
- **Step 2 산출물**: `web/src/view/Editor.jsx`의 `onCaretChange({lineIndex})` / `pendingCaretLine` prop.
- `web/src/view/clipboardEmbed.js`(`makeImageEmbed`/`makeVideoEmbed`/`makeArticleEmbed`), `editorContent.js`.

이전 step에서 만든 헬퍼/프롭을 정독하고 시그니처를 그대로 사용하라.

## 작업

WriterPage에서:

1. **마지막 에디터 캐럿 보관**: `lastCaretRef = useRef(null)`. `<Editor onCaretChange={(c) => { lastCaretRef.current = c; }} pendingCaretLine={pendingCaretLine} />`로 결선. `pendingCaretLine`은 state로 관리.
2. **검색패널 픽(`insertEmbed`)과 붙여넣기(`pasteEmbedAtCaret`)를 동일 동작으로 통일**:
   - 캐럿 텍스트-줄이 있으면(edit 모드, 에디터가 포커스된 적 있음):
     - `const r = insertEmbedAfterLine(body, embed, caretLine)` → `updateField('body', r.body)` → `setPendingCaretLine(r.caretTextLine)`(새 빈 줄로 커서 이동).
     - 붙여넣기는 동기 캐럿(`pasteEmbedAtCaret(embed, caret)`의 `caret.lineIndex`)을 사용.
     - 검색패널 픽은 `lastCaretRef.current?.lineIndex`를 사용(라이브 `readCaret` 금지 — 클릭 시 포커스 빠짐).
   - **캐럿이 없거나(한 번도 포커스 안 함) 매핑 모드(`isMapping`/textLocked)** → 기존 `appendEmbedToBody(body, embed)`로 끝("(끝)" 앞)에만 추가(**빈 줄/커서 이동 없음**).
   - **두 폴백 함수 구분(중요)**: `insertEmbedAfterLine`의 append 폴백은 **빈 줄을 생성**하지만, `appendEmbedToBody`(writerBody.js)는 **빈 줄을 추가하지 않는다**. 캐럿 부재/매핑일 때만 후자(`appendEmbedToBody`)를 쓴다 — 이것이 매핑 `blocksToText` 불변 회귀를 지킨다.
3. **`pendingCaretLine` 리셋**: 소비(Editor focus) **직후 `setPendingCaretLine(null)`**으로 명시적으로 비운다(별도 콜백/effect). 이유: 동일 줄(같은 number)로 연속 삽입 시 React가 동일 값으로 보고 effect를 재실행하지 않아, null 리셋이 없으면 두 번째 같은-줄 삽입에서 커서 이동이 안 된다.
4. **echo 안정성(불변식)**: paste/검색 삽입으로 추가된 빈 줄은 이후 input echo(`handleInput`→`readEditorBlocks`가 빈 `.yh-editor__line`을 `textBlock('')`로 재구성)에서도 **중복 누적되지 않고**, 첫 줄 제목 동기화(`onTextChange`의 `split('\n')[0]`)를 깨지 않는다.

## Acceptance Criteria

```bash
npm run lint
npm run test:web
npm run build
```

## 검증 절차

1. AC 실행(통과).
2. `WriterPage.test.jsx` 테스트:
   - **신규(edit 모드)**: 에디터 줄 N에 캐럿 → 검색패널 이미지/영상/글기사 "삽입" → 블록이 `[… 줄N, embed, 빈 줄, …]`이고 빈 줄로 커서 이동(`pendingCaretLine`/Editor focus 검증).
   - **신규**: 같은 줄로 **연속 2회** 삽입 시 2회 모두 커서가 새 빈 줄로 이동한다(`pendingCaretLine` null 리셋 검증).
   - **갱신(구체)**: 기존 붙여넣기 테스트의 `['text','embed','text']` 단언을 **모두** `['text','embed','text','text']`(제목 → 임베드 → 빈 줄 → 본문)로 갱신한다. 대상은 두 테스트의 세 단언 — `WriterPage.test.jsx`의 `:478`(첫 테스트), 그리고 input-preservation 테스트의 `:486`·`:490`(둘 다). 둘째 테스트는 빈 줄을 포함한 임베드가 끝으로 밀리지 않고 위치를 유지함을 검증하도록 의도를 박는다.
   - **회귀 유지**: 매핑 모드 이미지 삽입 시 `blocksToText`가 `헤드라인\n본문내용\n(끝)`로 불변(빈 줄 미추가), 임베드만 추가. 글기사 삽입 회귀.
3. 아키텍처 체크리스트:
   - transport 직접 호출 금지(ADR-003) — 데이터는 컨트롤러/모델 경유 유지.
   - 매핑 본문-불변식(텍스트/구조 불변, 임베드만) 유지.
4. `phases/5-editor-newline-embed/index.json`의 step 3 업데이트(step0과 동일 규칙).

## 금지사항

- 매핑 모드에서 본문 텍스트/구조(빈 줄 등)를 추가하지 마라. 임베드 추가/삭제만. 이유: 매핑 본문-불변식(step11) 및 `blocksToText` 불변 회귀 테스트.
- 검색패널 픽에서 라이브 `readCaret`를 호출하지 마라(클릭 시 에디터 포커스가 빠져 null). 반드시 `lastCaretRef`(Step 2 `onCaretChange`) 사용.
- transport를 view에서 직접 호출하지 마라(ADR-003).
- 명시적으로 갱신하라고 한 붙여넣기 테스트 외에 기존 테스트를 깨뜨리지 마라.
