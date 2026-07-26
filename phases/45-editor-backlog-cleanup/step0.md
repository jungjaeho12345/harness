# Step 0: editop-align-inherit

## 목표

편집 op가 **제자리(in-place)에서 텍스트 블록을 재생성**할 때 그 줄의 `align` 필드(보기>정렬로 설정된 left/center/right/justify)를 **유실하는** 결함을 수정한다. 원인은 네 곳의 순수 헬퍼가 `textBlock(newText)`(single-arg)로 블록을 새로 만들어 기존 블록의 선택적 `align` 필드를 떨어뜨리는 것이다. 수정 = 그 줄이 원래 갖던 align을 `textBlock(newText, oldAlign)` 2번째 인자로 **승계**한다.

이 step은 **순수 뷰 헬퍼(web/src/view/editor*.js)만** 다룬다 — DOM/컨트롤러/DB/서버 무접촉. 네 파일 모두 같은 계층·같은 기계적 변경(2번째 인자 승계)이라 하나의 응집된 관심사(align 보존)로 묶는다(phase 44 step0가 계약+컨트롤 2파일을 한 관심사로 묶은 선례).

## 읽어야 할 파일

라인 번호는 실측 힌트 — 반드시 심볼명으로 재확인하라.

- `docs/ARCHITECTURE.md`, `docs/ADR.md`(ADR-003: view의 순수 헬퍼는 DOM/transport 비의존). `docs/news.md`(보기 정렬 — 텍스트 줄 단위 align).
- `web/src/view/editorContent.js` — **전체**. `textBlock(text = '', align)`(L18~22): `isValidAlign(align)`이면 `block.align = align`, 아니면 **키 자체 생략**(무효/undefined는 무해). `normalizeBlocks`(L37~48): 유효 align만 보존. **이 계약이 승계의 안전판** — `list[bi].align`이 undefined면 2번째 인자로 넘겨도 키가 안 생긴다(스퍼리어스 align 없음).
- `web/src/view/editorShortcuts.js` — **`transformTextLine(blocks, textLineIndex, fn)`(L117~124)**. L122 `next[blockIndex] = textBlock(fn(next[blockIndex].text));` ← **수정 대상 1**(대소문자 변환). `deleteLineAt`/`insertContinueMarker` 등 다른 함수는 블록을 재생성하지 않거나(삭제/이동) align 무관 — **건드리지 마라**.
- `web/src/view/editorGlyph.js` — **`insertGlyphAtCaret(blocks, caret, glyph)`(L55~90)**. L88 `next[blockIndex] = textBlock(old.slice(0, col) + g + old.slice(col));` ← **수정 대상 2**(약물 삽입). 단 L79 `[textBlock(g), ...list]`(텍스트 블록이 전혀 없어 **새 줄 생성**)는 승계할 align이 없으므로 **single-arg 유지**.
- `web/src/view/editorDate.js` — **`insertDateAtCaret(blocks, caret, dateString)`(L57~92)**. L90 `next[blockIndex] = textBlock(old.slice(0, col) + d + old.slice(col));` ← **수정 대상 3**(날짜 삽입). L81 새 줄 생성 분기는 single-arg 유지(글자 삽입과 동형).
- `web/src/view/editorEditOps.js` — **`deleteWordAt(blocks, caretLineIndex, column)`(L88~99)**. L97 `next[blockIndex] = textBlock(lineText.slice(0, start) + lineText.slice(end));` ← **수정 대상 4**(단어 지우기).
- 각 대응 테스트 파일(`editorShortcuts.test.js`, `editorGlyph.test.js`, `editorDate.test.js`, `editorEditOps.test.js`) — 기존 테스트 스타일(입력 blocks → 출력 blocks 단언)을 그대로 따라 align 보존 테스트를 동형으로 추가.

## 배경 (자기완결)

`align`은 텍스트 블록의 **선택적 필드**다(`{type:'text', text, align?}`). 보기>정렬(phase 35)이 `setLineAlign`으로 이 필드를 설정한다. 그런데 위 네 op는 그 줄의 **텍스트만** 바꾸면서 블록을 통째로 새로 만드는데, `textBlock(newText)`는 align을 안 받으므로 결과 블록에 align이 없다. 결과: **정렬한 줄에 대소문자변환/약물삽입/날짜삽입/단어지우기를 하면 그 줄의 정렬이 조용히 풀린다**. 되돌리기는 있으나(전체 undo), 사용자가 인지 못 하면 잘못 정렬된 채 송고될 수 있다.

수정 원리: 각 op는 이미 `list = normalizeBlocks(blocks)`로 정규화된 리스트를 갖고, 바꾸려는 블록 인덱스(`blockIndex`)를 안다. `list[blockIndex].align`을 `textBlock`의 2번째 인자로 넘기면 된다. `isValidAlign` 게이트 덕에 원래 align이 없던 줄은 `undefined`가 넘어가 **키가 안 생긴다**(직렬화 바이트 안정 — 미정렬 줄 회귀 없음).

**sortDocument/sortParagraph는 이 수정에서 의도적으로 제외한다.** 이유: 정렬은 줄 **값을 슬롯 사이에서 재배치**하므로 "align이 값을 따라가야 하나 슬롯에 남아야 하나"가 의미론적으로 모호하다(예: `left "zebra"`/`right "apple"` 정렬 후 slot0="apple"). 이는 nit이 아니라 별도 설계 결정 사안이라 이 백로그 정리 범위 밖이다(후보 3 원문도 sort를 나열하지 않음).

## TDD — 테스트 먼저

각 대응 테스트 파일에 align 보존 케이스를 red→green으로 추가한다. **정렬 op 자체가 아니라 형제 op가 align을 승계하는지**가 대상이다.

`editorShortcuts.test.js`(transformTextLine):
- `transformTextLine([textBlock('hello', 'center')], 0, toUpper).blocks[0]` → `text: 'HELLO'`이고 **`align: 'center'` 유지**.
- 미정렬 줄: `transformTextLine([textBlock('hello')], 0, toUpper).blocks[0]`에 `align` 키가 **없다**(`'align' in block === false` — 스퍼리어스 align 금지).

`editorGlyph.test.js`(insertGlyphAtCaret):
- `insertGlyphAtCaret([textBlock('가나', 'right')], { lineIndex: 0, offset: 1 }, '§').blocks[0]`이 삽입 결과 텍스트 + **`align: 'right'` 유지**.
- 새 줄 생성 폴백(텍스트 블록 없음 — 임베드만/빈 배열)에서 생성된 블록엔 align 키가 없다(회귀 가드).

`editorDate.test.js`(insertDateAtCaret):
- `insertDateAtCaret([textBlock('머리글', 'justify')], { lineIndex: 0, offset: 3 }, '2026-07-26').blocks[0]`에 **`align: 'justify'` 유지**.

`editorEditOps.test.js`(deleteWordAt):
- `deleteWordAt([textBlock('hello world', 'center')], 0, 0)`(첫 단어 삭제) → `changed: true`, 결과 블록에 **`align: 'center'` 유지**.
- 미정렬 줄 단어 삭제 결과엔 align 키 없음.

기존 테스트(정렬 없는 입력)는 그대로 통과해야 한다 — 승계 인자는 미정렬 줄에 무해하므로 회귀 없음.

## 작업 (구현 상세 — 시그니처 불변, 내부만 수정)

네 곳 모두 **동일 패턴**: 재생성하는 `textBlock(...)` 호출에 그 블록의 기존 align을 2번째 인자로 추가한다. align 소스는 반드시 **정규화된 리스트의 해당 블록**(`list[blockIndex].align`)이다.

1. `web/src/view/editorShortcuts.js` `transformTextLine` L122:
   `next[blockIndex] = textBlock(fn(next[blockIndex].text), next[blockIndex].align);`
2. `web/src/view/editorGlyph.js` `insertGlyphAtCaret` L88(정확 삽입/폴백 공용 in-place 경로):
   `next[blockIndex] = textBlock(old.slice(0, col) + g + old.slice(col), list[blockIndex].align);`
   — L79 `[textBlock(g), ...list]`(새 줄 생성)는 **그대로**(승계할 원본 없음).
3. `web/src/view/editorDate.js` `insertDateAtCaret` L90:
   `next[blockIndex] = textBlock(old.slice(0, col) + d + old.slice(col), list[blockIndex].align);`
   — L81 새 줄 생성 분기는 **그대로**.
4. `web/src/view/editorEditOps.js` `deleteWordAt` L97:
   `next[blockIndex] = textBlock(lineText.slice(0, start) + lineText.slice(end), list[blockIndex].align);`

각 파일 상단의 함수 주석에 "정렬(align) 필드는 승계한다" 한 줄만 정확히 반영하라(불필요한 재작성 금지).

## Acceptance Criteria

```bash
npm run lint
npm run build
npm run test:web
```

(순수 client 헬퍼 — 백엔드 무관. `npm test`(node --test) 불필요.)

## 회귀 가드 / 불변식

- **미정렬 줄 바이트 안정**: align 없던 줄은 결과에도 align 키가 없어야 한다(`isValidAlign(undefined)===false` 의존). 직렬화 바이트가 바뀌면 회귀.
- **정렬 줄 승계**: 정렬된 줄에 네 op 적용 후 align 필드가 보존돼야 한다.
- **범위 최소**: 각 함수의 시그니처·반환 shape·다른 분기(새 줄 생성 폴백, no-op, 마커/임베드 불변)는 **불변**. align 승계 인자 추가 외 변경 금지.
- **sort 미접촉**: `sortDocument`/`sortParagraph`(editorEditOps.js)는 이 step에서 건드리지 않는다.
- 기존 4개 테스트 파일의 모든 케이스 그린 유지.

## 커밋 계획

- **fix**: `fix(45-editor-backlog-cleanup): step0 — 편집 op 형제 align 미승계 수정(transformTextLine/insertGlyphAtCaret/insertDateAtCaret/deleteWordAt textBlock align 승계)` — 4개 소스 + 4개 테스트 파일.
- **chore**: `chore(45-editor-backlog-cleanup): step0 status — completed` — index.json step0. 코드/테스트와 분리 커밋.

## 금지사항

- 새 줄을 **생성**하는 폴백 분기(editorGlyph L79·editorDate L81)에 align을 억지로 넣지 마라. 이유: 승계할 원본 블록이 없다 — 임의 align 주입은 스퍼리어스 정렬을 만든다.
- `sortDocument`/`sortParagraph`에 align 승계를 추가하지 마라. 이유: 정렬은 값을 슬롯 사이 재배치하므로 align-follow 의미가 모호하다 — 별도 설계 결정 사안(이 step 범위 밖).
- align 소스로 `next[blockIndex]`(교체 후 값)를 쓰지 마라 — 반드시 교체 **전** 원본(`list[blockIndex].align` 또는 교체 직전의 `next[blockIndex].align`)을 읽어라. 이유: 이미 새 블록으로 덮어쓴 뒤 읽으면 승계가 무효화된다.
- `textBlock`/`isValidAlign`/`normalizeBlocks`(editorContent.js)를 수정하지 마라. 이유: 계약이 이미 옳다 — 소비 측 4곳만 승계 인자를 넘기면 된다.
- 기존 테스트를 깨뜨리지 마라(기준: backend 427·web 1871·lint/build clean).
