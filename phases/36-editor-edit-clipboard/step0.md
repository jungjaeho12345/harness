# Step 0: paste-text-model

편집 메뉴 '텍스트 붙여넣기'/'붙여넣기'가 쓸 **마커-안전 텍스트 삽입 순수 헬퍼**를 만든다. 클립보드에서 읽은 (여러 줄일 수 있는) 평문을 캐럿 위치에 삽입하되, "(끝)" 마커의 무결성을 지킨다. 이 step은 **순수 로직만** — React/DOM/clipboard API 미접촉(비동기 클립보드 읽기·결선은 step1 WriterPage).

## 읽어야 할 파일

먼저 아래 파일들을 읽고 설계 의도를 파악하라:

- `docs/ARCHITECTURE.md`, `docs/ADR.md`(ADR-003 — view 순수 모듈 규칙).
- `docs/news.md` L170(**"(끝)" 마커 뒤에는 어떤 입력도 할 수 없다 — 타이핑/Enter/붙여넣기/IME 모두 차단. 마커 앞 편집은 허용**), L182(편집 메뉴 — 붙여넣기/텍스트 붙여넣기), L175(본문=텍스트/임베드 블록 구조).
- `web/src/view/editorNewline.js` — **재사용 핵심.** `insertTextIntoBlocks(blocks, caret, text) → {blocks, caretLineIndex}`(L36~80: 캐럿 위치에 개행 포함 텍스트를 삽입, 캐럿 텍스트 블록을 head/tail로 나눠 "1줄=1 텍스트 블록" 유지, 임베드 위치 보존, 캐럿 null/범위밖이면 마지막 텍스트 줄 끝 폴백) · `isInputBlocked(text, caretOffset)`(L24~29: `blocksToText` 기준 절대 오프셋이 "(끝)" 마커 시작과 같거나 뒤면 true) · `hasEndMarker`.
- `web/src/view/editorContent.js` — `blocksToText(blocks)`(텍스트 블록만 개행으로 이은 평문 — 캐럿 오프셋 좌표계) · `normalizeBlocks` · `textBlock` · `END_MARKER`.
- `web/src/view/editorGlyph.js` — 캐럿 삽입 순수 헬퍼의 패턴/반환형/테스트 스타일 참조(insertGlyphAtCaret는 한 줄 안 삽입이라 다중 줄엔 부적합 — 이 step은 다중 줄용 insertTextIntoBlocks를 쓴다).

## 배경 (자기완결)

'텍스트 붙여넣기'(text-only)와 '붙여넣기'(텍스트 분기)는 클립보드 평문을 캐럿에 삽입한다. 이미 `insertTextIntoBlocks`가 다중 줄 텍스트를 1줄=1블록으로 분할 삽입하고 임베드를 보존한다(네이티브 Ctrl+V 여러 줄 붙여넣기와 Enter 분할이 쓰는 그 함수). **그러나 `insertTextIntoBlocks`는 "(끝)" 마커를 검사하지 않아** 마커 위치/뒤에 삽입하면 마커 무결성이 깨진다(네이티브 Ctrl+V는 Editor가 `isInputBlocked`로 막지만, 메뉴 경로는 그 방어가 없다). 따라서 이 헬퍼가 마커 가드를 씌운다.

## 작업 (TDD — 실패하는 테스트부터 작성한 뒤 구현)

### 신규 `web/src/view/editorClipboard.js` — 마커-안전 텍스트 삽입

```js
// 클립보드 평문(여러 줄 가능)을 캐럿에 삽입한 새 블록 배열을 돌려준다. "(끝)" 마커 무결성 보존.
// 반환: { blocks, caretLineIndex, changed }
//   - changed:false 이면 blocks는 normalizeBlocks(입력)과 동등(호출부가 커밋을 건너뛴다).
export function insertPasteTextAtCaret(blocks, caret, text) { /* ... */ }
```

구현 지침(순수):
1. `const list = normalizeBlocks(blocks);`
2. **빈 텍스트 no-op**: `String(text ?? '') === ''` → `{ blocks: list, caretLineIndex: null, changed: false }`.
3. **마커 가드**: `const full = blocksToText(list);` 계산 후,
   - 캐럿이 유효(정수 offset)하면 `isInputBlocked(full, caret.offset)`가 true일 때 no-op(`changed:false`).
   - 캐럿이 null/무효인데 본문에 "(끝)"이 있으면(`hasEndMarker(full)`) no-op — 이유: `insertTextIntoBlocks`의 폴백(마지막 텍스트 줄 끝)이 마커 줄에 붙어 마커를 오염시킬 수 있다. 마커 없는 본문에서만 폴백 삽입을 허용한다.
4. 그 외 → `const r = insertTextIntoBlocks(list, caret, text);` → `{ blocks: r.blocks, caretLineIndex: r.caretLineIndex, changed: true }`.

**못박음**:
- "(끝)" 마커 텍스트는 어떤 경로로도 오염되지 않는다. 마커와 같은 줄/뒤 오프셋 삽입은 반드시 no-op. (news.md L170)
- 텍스트는 **원본 그대로** 삽입한다(트림/정규화/개행 변환 금지 — 붙여넣기는 사용자 클립보드 원문 보존). 단 `\r\n`/`\r`를 `\n`으로 통일하는 개행 정규화는 허용(줄 분할 일관성 — 선택).
- 입력 `blocks`를 변형(mutate)하지 마라 — 새 배열/새 textBlock만.

### 테스트 — `web/src/view/editorClipboard.test.js`

- 단일 줄 삽입: 캐럿 줄 안 컬럼에 문자열 삽입, 다른 줄·임베드 불변, `changed:true`, `caretLineIndex` 정확.
- 다중 줄 삽입: `'a\nb\nc'`가 캐럿 위치에서 3개 텍스트 블록으로 분할, 임베드 위치 보존.
- 마커 가드: 캐럿이 "(끝)" 줄/뒤 → no-op(`changed:false`), 마커 불변.
- 캐럿 null + 마커 있음 → no-op. 캐럿 null + 마커 없음 → 마지막 줄 끝 폴백 삽입.
- 빈 텍스트 → no-op.
- 임베드 섞인 본문에서 텍스트-줄 인덱스 정확(임베드 제외 카운팅은 insertTextIntoBlocks에 위임).

## Acceptance Criteria

```bash
npm run lint
npm run build
npm run test:web
```

(순수 클라이언트 로직 — 백엔드 무관. `npm test` 불필요.)

## 검증 절차

1. 위 AC 커맨드를 실행한다.
2. 아키텍처 체크리스트:
   - `editorClipboard.js`가 순수 함수만 담고 React/DOM/clipboard/transport에 의존하지 않는가?(ADR-003)
   - `insertTextIntoBlocks`·`isInputBlocked`를 재구현하지 않고 재사용하는가?(단일 출처)
   - CLAUDE.md(DB 무관·client 전용·UTF-8)?
3. 결과에 따라 `phases/36-editor-edit-clipboard/index.json`의 step0을 업데이트한다:
   - 성공 → `"status": "completed"`, `"summary"`에 (모듈 경로 `web/src/view/editorClipboard.js`·`insertPasteTextAtCaret(blocks,caret,text)→{blocks,caretLineIndex,changed}` 시그니처·마커 가드·빈텍스트/캐럿null 규칙·테스트 수)를 한 줄 요약. **step1이 import 경로·시그니처를 알 수 있게 담아라.**
   - 3회 수정 후에도 실패 → `"status": "error"`, `"error_message"`.
   - 사용자 개입 필요 → `"status": "blocked"`, `"blocked_reason"` 후 즉시 중단.
4. top-level `phases/index.json`의 36 항목 상태는 execute.py가 관리한다(직접 건드리지 마라).

## 금지사항

- `insertTextIntoBlocks`/`isInputBlocked`를 새로 구현하지 마라. 이유: 이미 검증된 단일 출처를 재사용해야 네이티브 붙여넣기와 동작이 일치하고 회귀가 없다.
- 마커 가드를 생략하지 마라. 이유: "(끝)" 뒤 붙여넣기 차단은 스펙(news.md L170)이며, 빠지면 마커 무결성이 깨진다.
- 텍스트를 트림하거나 앞뒤 공백을 제거하지 마라. 이유: 붙여넣기는 클립보드 원문을 보존해야 한다(사용자가 복사한 그대로).
- WriterPage.jsx·Editor.jsx·editorNewline.js를 이 step에서 수정하지 마라. 이유: 이 step은 순수 헬퍼 신설만 — 결선·비동기 클립보드는 step1.
- 기존 테스트를 깨뜨리지 마라.
