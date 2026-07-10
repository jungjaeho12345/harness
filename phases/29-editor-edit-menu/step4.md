# Step 4: edit-ops-wire — 문서/문단 정렬 · 한줄/단어 지우기 메뉴 결선

## 이 step의 목표

편집 메뉴의 **문서 정렬(`edit.sortDocument`) · 문단 정렬(`edit.sortParagraph`) · 한줄 지우기(`edit.deleteLine`) · 단어 지우기(`edit.deleteWord`)** 4개를 WriterPage에 결선한다. 이들은 **본문 텍스트를 바꾼다** → 기존 대소문자 변환·`edit.insertContinue`와 동일하게 **매핑 가드 뒤**에서 처리하고, `updateField('body', serialize(...))` 안전 경로만 쓴다(Editor.jsx 미접촉·DOM 직접 조작 금지). 본문 변경 후 **제목(title)을 중앙 파생 경로로 재동기화**한다.

## 읽어야 할 파일

먼저 아래를 읽고 설계 의도를 파악하라:

- `/CLAUDE.md`, `/docs/ARCHITECTURE.md`, `/docs/ADR.md` — 프론트 MVC, View 결선(ADR-003), TDD, DB 비파괴.
- `/docs/news.md` — L161·L165~169(임베드/"(끝)"), L178(편집 메뉴 정렬/삭제).
- **phase 28 산출물(반드시 읽기 — 제목 재동기화 중앙 경로):** `phases/28-audit-stabilization/index.json` 및 그 step 파일들. phase 28이 **제목 파생 로직을 중앙화**한다(28이 이 phase보다 먼저 실행됨). 28이 노출한 중앙 헬퍼(예상 이름 `commitBody`류, 또는 body+title 통합 갱신 경로)를 찾아 **재사용**하라. 28의 실제 함수명·위치를 확인하고 그것을 호출한다.
  - **선행 가정 이중화(엄수)**: phase 28의 중앙 헬퍼(`commitBody` 등)가 **실존하면 그것을 사용**한다. **실존하지 않으면** `writerBody.js`의 `bodyTitle` 폴백만 쓴다 — **없다고 이 step에서 새 중앙 헬퍼를 만들지 마라**(제목 파생 중앙화는 phase 28의 몫이며, 여기서 만들면 28과 출처가 갈라진다).
- **이전 step 산출물(반드시 읽기):** `web/src/view/editorEditOps.js` (step 3) — `sortDocument(blocks)`, `sortParagraph(blocks, caretLineIndex)`, `deleteWordAt(blocks, caretLineIndex, column)`.
- `web/src/view/editorShortcuts.js` — `deleteLineAt(blocks, index)`(Ctrl+D 단일 출처 — `edit.deleteLine`이 재사용).
- `web/src/view/writerBody.js` — `textLineToBlockIndex(blocks, textLineIndex)`(줄→블록 인덱스), `bodyTitle(body)`(본문 첫 줄 제목 파생 — **phase 28 중앙 헬퍼가 없을 때의 폴백 단일 출처**).
- `web/src/view/WriterPage.jsx` — **수정 대상**. 핵심 참조점:
  - `MENU_ENABLED`(약 80행) — step 2에서 선택 3개가 이미 추가돼 있을 수 있다. 여기에 정렬/삭제 4개를 **추가(append)** 한다(기존 항목 제거/재배치 금지).
  - `onMenuSelect(id)`(약 415행)와 `if (isMapping) return;`(약 434행) — 정렬/삭제 4개는 **이 매핑 가드 뒤**에 둔다(본문 변경 → 매핑 차단). 대소문자 변환(약 462행 `VIEW_TRANSFORMS`)·`edit.insertContinue`(약 461행)와 같은 구역.
  - 기존 본문 변경 안전 경로: 대소문자 변환(약 467행: `transformTextLine` → `updateField('body', serialize(r.blocks))` + `setPendingCaretLine`), `insertContinue`(약 255행), `convertAbbrev`(전체 본문 transform은 `setPendingCaretLine` 미호출).
  - `onKeyDown`의 Ctrl+D 라인삭제(약 574~589행: `textLineToBlockIndex` → `deleteLineAt` → `updateField('body', serialize(...))`) — `edit.deleteLine`이 **본문 변이 코어만 공용화**해 재사용한다(복붙 금지). **추출 경계(엄수)**: 공용 함수는 `blockIndex`를 받아 `deleteLineAt` → `updateField('body', serialize(...))` **까지만** 담는다. (a) `setPendingCaretLine`은 공용에 넣지 말고 `edit.deleteLine` 결선에서만 호출한다(기존 Ctrl+D는 setPendingCaretLine을 부르지 않으므로 — Editor의 refocusRef 복원에 맡긴다 — 공용에 넣으면 Ctrl+D 동작이 바뀐다). (b) `onKeyDown`의 Backspace/Delete 빈 줄 가드(약 584행 `text.split('\n')[textLineIndex] !== ''` 조기 return)와 `readCaret`/`lineAtOffset` 계산은 **추출 대상이 아니다**(키다운 전용 — 그대로 둔다). (c) 제목 재동기화도 공용이 아니라 각 결선부에서 호출한다(기존 Ctrl+D는 제목 동기화를 하지 않으므로 회귀 방지).
  - `onTextChange`(약 241행)가 타이핑 시 제목을 동기화하는 현재 방식(`updateField('title', text.split('\n')[0]...)`)을 확인하라 — 이 인라인 파생은 **phase 28이 중앙화 대상**이다. 정렬/삭제 결선에서 이 인라인 문자열 분해를 **복제하지 말고 중앙 경로/`bodyTitle`을 쓴다**.
  - `lastCaretRef`(약 188행) `{ lineIndex, offset }`, `bodyText`(약 201행) `= blocksToText(blocks)`, `lineAtOffset`(import 약 46행) — deleteWord의 컬럼 계산에 쓴다.
- `web/src/view/WriterPage.test.jsx` — **수정 대상**. `focusCaretAtLine`/`caretAtLine` 헬퍼로 정렬/삭제·제목 재동기화 단언 추가.

## 작업 (TDD — 테스트 먼저)

### 1. MENU_ENABLED 확장

- `'edit.sortDocument'`, `'edit.sortParagraph'`, `'edit.deleteLine'`, `'edit.deleteWord'`를 **추가**한다(순수 append).

### 2. onMenuSelect 라우팅 (매핑 가드 **뒤**)

공통: `const caret = lastCaretRef.current;`. 본문 변경은 `updateField('body', serialize(next))` + **제목 재동기화**(아래 3번) 로만. 변경 결과가 `changed:false`(또는 blockIndex<0)면 no-op.

- `edit.deleteLine` →
  - `const caretLine = caret ? caret.lineIndex : null;` `caretLine==null`이면 no-op.
  - `const blockIndex = textLineToBlockIndex(blocks, caretLine);` `<0`이면 no-op.
  - **기존 Ctrl+D 라인삭제 로직을 공용 핸들러로 추출해 재사용**: 공용 함수(예: `deleteLineByBlockIndex(blockIndex)`)는 `deleteLineAt(blocks, blockIndex)` → `updateField('body', serialize(r.blocks))` **만** 담는다(onKeyDown Ctrl+D와 단일 소스 — 복붙 금지, 동반 임베드 1개 삭제 승계). 위 "읽어야 할 파일"의 **추출 경계** 3항목을 지켜라(setPendingCaretLine·제목 재동기화·Backspace 빈줄 가드는 공용에 넣지 않음).
  - 공용 호출 **후 이 결선부에서만** 제목 재동기화(아래 3번) + `setPendingCaretLine(caretLine)`(삭제 후 그 자리 줄로 포커스)를 호출한다 — Ctrl+D 경로는 이 둘을 부르지 않으므로 기존 동작 불변.
- `edit.deleteWord` →
  - `caretLine`(위와 동일) 없으면 no-op.
  - 컬럼: `const { start } = lineAtOffset(bodyText, caret.offset); const column = caret.offset - start;`
  - `const r = deleteWordAt(blocks, caretLine, column);` `r.changed`면 `updateField('body', serialize(r.blocks))` + 제목 재동기화 + `setPendingCaretLine(caretLine)`.
- `edit.sortDocument` →
  - `const r = sortDocument(blocks);` `r.changed`면 `updateField('body', serialize(r.blocks))` + 제목 재동기화. (전체 본문 transform → `convertAbbrev`처럼 `setPendingCaretLine` **미호출** — 오프셋 대량 변동, 포커스 유지가 안전.)
- `edit.sortParagraph` →
  - `caretLine` 없으면 no-op. `const r = sortParagraph(blocks, caretLine);` `r.changed`면 `updateField('body', serialize(r.blocks))` + 제목 재동기화. (문단 정렬도 줄 순서가 바뀌므로 `setPendingCaretLine` 미호출 — sortDocument와 동일.)

### 3. 제목 재동기화 (핵심)

정렬/삭제는 본문 첫 줄(=제목)을 바꿀 수 있다(특히 sortDocument는 첫 줄이 거의 항상 바뀐다). 본문 변경 직후 제목을 **새 본문에서 재파생**해 `updateField('title', ...)`한다.

- **1순위**: phase 28이 중앙화한 제목 파생/동기화 헬퍼를 호출한다(위 "읽어야 할 파일"에서 확인한 실제 함수). body+title을 함께 갱신하는 중앙 경로가 있으면 그것을 쓴다.
- **폴백**: 28의 중앙 헬퍼가 없으면 `writerBody.js`의 `bodyTitle(nextBody)`(첫 줄 파생 단일 출처)로 `updateField('title', bodyTitle(nextBody))`. 여기서 `nextBody = serialize(r.blocks)`.
- **금지**: `text.split('\n')[0]` 같은 인라인 파생을 새로 복붙하지 마라(onTextChange의 것을 복제 금지 — 중앙 경로/`bodyTitle` 재사용).

## 핵심 규칙 (반드시 준수 — 위반 시 반려)

1. **매핑 가드 뒤**: 정렬/삭제 4개는 `if (isMapping) return;` 뒤에 둔다(본문 변경 → 매핑 차단, 본문-only 불변식).
2. **안전 경로만**: 본문 변경은 `updateField('body', serialize(...))`로만. contentEditable/DOM/selection 직접 조작 금지. `Editor.jsx` 미접촉.
3. **단일 소스**: `edit.deleteLine`은 onKeyDown Ctrl+D 라인삭제와 **같은 공용 핸들러**를 쓴다(두 곳에 `deleteLineAt` 호출을 복붙하지 마라).
4. **제목 재동기화**: 4개 모두 본문 변경 후 제목을 중앙 경로/`bodyTitle`로 재동기화(인라인 파생 복제 금지).
5. **no-op 존중**: `changed:false`/캐럿 없음/blockIndex<0이면 `updateField` 미호출(불필요한 dirty/remount 회피).
6. **경계·정렬·삭제 계산 재사용**: 정렬/단어삭제 계산은 `editorEditOps`(step 3)·`editorRange`(step 0)만 쓴다. WriterPage에서 재구현 금지.

## Acceptance Criteria

```bash
npm run test:web    # 정렬/삭제 결선 + 제목 재동기화 + 매핑 차단 단언 + 기존 회귀(Ctrl+D·대소문자·타이핑) 통과 (vitest)
npm run build
npm run lint
```

추가 단언(vitest, WriterPage.test.jsx):
- `MENU_ENABLED` 확장으로 편집>'문서 정렬'/'문단 정렬'/'한줄 지우기'/'단어 지우기'가 **활성**이다.
- 여러 줄 본문에서 '문서 정렬' 클릭 시 본문(`updateField('body', …)`)이 정렬되고 **"(끝)" 마커가 최종 유지**, 첫 줄 변경 시 **제목(`updateField('title', …)`)이 새 첫 줄로 재동기화**된다.
- 캐럿을 특정 문단에 두고 '문단 정렬' 시 그 문단만 정렬되고 다른 문단 불변.
- 캐럿 줄에서 '한줄 지우기' 시 그 줄이 삭제된다(기존 Ctrl+D와 동일 결과 — 단일 소스 회귀). 마커 줄에서 실행 시 마커 줄 통째 삭제 허용(news.md L167).
- 캐럿 단어에서 '단어 지우기' 시 그 단어만 삭제; 마커 줄에서는 no-op(본문 불변).
- **매핑 모드**: 정렬/삭제 4개 클릭 시 `updateField('body', …)`가 호출되지 않는다(텍스트 잠금 가드).
- 기존 Ctrl+D/Backspace/Delete 라인삭제·대소문자 변환·`edit.insertContinue`·선택 항목(step 2)·타이핑·메뉴 열고닫기 불변.

## 검증 절차

1. 위 AC 커맨드 실행.
2. 아키텍처 체크리스트: View 결선(ADR-003)·매핑 가드 뒤·안전 경로만·Editor 미접촉·deleteLine 단일 소스·제목 중앙 경로 재사용·정렬 마커 최종/임베드 보존·회귀 없음.
3. `phases/29-editor-edit-menu/index.json`의 step 4 업데이트(성공 completed·3회 실패 error·개입 blocked). 성공 시 `summary`에 결선 4항목·제목 재동기화 경로·매핑 차단을 한 줄로 남긴다.

## 금지사항

- 정렬/삭제 4개를 매핑 가드 앞에 두지 마라. 이유: 본문을 바꾸므로 매핑(텍스트 잠금)에서 차단돼야 한다 — 앞에 두면 본문-only 불변식 위반.
- `Editor.jsx`를 수정하거나 contentEditable/DOM/selection을 직접 조작하지 마라. 이유: phase 5/8/20 타이핑·remount·캐럿 불변식. 본문 변경은 `updateField('body', serialize(...))`로만.
- `edit.deleteLine`에 `deleteLineAt` 호출을 새로 복붙하지 마라. 이유: Ctrl+D와 삭제 의미가 갈라지면 회귀. 공용 핸들러로 단일화한다.
- 제목 파생을 `split('\n')[0]`로 인라인 복제하지 마라. 이유: phase 28이 중앙화한 로직·`bodyTitle`과 출처가 갈라져 stale 제목/불일치가 생긴다.
- 정렬 헬퍼가 마커를 이동시키거나 임베드를 재배치하도록 결선 측에서 우회하지 마라(정렬 계산은 step 3에서 이미 보호 — 결선은 그대로 사용). 이유: 송고 자격/임베드 위치 불변식.
- `MENU_ENABLED` 기존 항목(선택 3개 포함)을 지우거나 순서를 바꾸지 마라. 이유: step 2·기존 결선 회귀.
- undo/redo·cut/copy/paste 등 DEFER 항목을 결선하지 마라(별도 phase). 새 npm 의존성·DB/서버 수정·기존 테스트 파괴 금지.
