# Step 4: edit-ops-wire — 문서/문단 정렬 · 한줄/단어 지우기 메뉴 결선

## 이 step의 목표

편집 메뉴의 **문서 정렬(`edit.sortDocument`) · 문단 정렬(`edit.sortParagraph`) · 한줄 지우기(`edit.deleteLine`) · 단어 지우기(`edit.deleteWord`)** 4개를 WriterPage에 결선한다. 이들은 **본문 텍스트를 바꾼다** → 기존 대소문자 변환·`edit.insertContinue`와 동일하게 **매핑 가드 뒤**에서 처리하고, 본문 변경은 **`commitBody(serialize(...))` 단일 choke point**만 쓴다. `commitBody`가 body 갱신과 제목(본문 첫 줄) 재동기화를 **한 함수로** 처리하므로 **별도 제목 재동기화 단계는 두지 않는다**(phase 28 불변식). Editor.jsx 미접촉·DOM 직접 조작 금지.

## 읽어야 할 파일

먼저 아래를 읽고 설계 의도를 파악하라:

- `/CLAUDE.md`, `/docs/ARCHITECTURE.md`, `/docs/ADR.md` — 프론트 MVC, View 결선(ADR-003), TDD, DB 비파괴.
- `/docs/news.md` — L161·L165~169(임베드/"(끝)"), L178(편집 메뉴 정렬/삭제).
- **phase 28 산출물(참조 — 본문/제목 단일 choke point):** phase 28 step1(title-derivation-central)이 이미 실행돼 WriterPage.jsx에 `commitBody(nextBody)`(WriterPage.jsx:244~247)를 도입했다 — 내부는 `updateField('body', nextBody)` + `updateField('title', bodyTitle(nextBody))`로 **body 갱신과 제목 재동기화를 한 함수에 묶는다**. 본문을 바꾸는 모든 핸들러(약어변환·간체번체·바꾸기·대소문자·줄삭제·마커/약물/날짜 삽입·임베드)가 이 함수를 지나며, `updateField('body')` 직접 호출은 commitBody 내부(:245) **단 하나뿐**이다. **정렬/삭제 4개도 반드시 `commitBody`를 재사용한다.**
  - **phase 28 불변식(엄수)**: 이 step에서 새 제목 파생 헬퍼를 만들거나 `updateField('body')`/`updateField('title')`를 결선부에서 직접 호출하지 마라 — `commitBody` 단일 choke point만 지난다. 직접 `updateField` 재도입은 phase 28이 없앤 "제목 stale"(옛 제목이 DB에 남는) 결함을 되살린다. 제목 파생은 commitBody가 내부에서 `writerBody.bodyTitle`을 부르는 것으로 끝난다(결선부에서 `bodyTitle` 직접 호출도 불필요).
- **이전 step 산출물(반드시 읽기):** `web/src/view/editorEditOps.js` (step 3) — `sortDocument(blocks)`, `sortParagraph(blocks, caretLineIndex)`, `deleteWordAt(blocks, caretLineIndex, column)`.
- `web/src/view/editorShortcuts.js` — `deleteLineAt(blocks, index)`(Ctrl+D 단일 출처 — `edit.deleteLine`이 재사용).
- `web/src/view/writerBody.js` — `textLineToBlockIndex(blocks, textLineIndex)`(줄→블록 인덱스), `bodyTitle(body)`(본문 첫 줄 제목 파생 — **commitBody가 내부에서 쓰는 단일 출처. 결선부에서 직접 호출하지 마라**).
- `web/src/view/WriterPage.jsx` — **수정 대상**. 핵심 참조점:
  - `MENU_ENABLED`(약 80행) — step 2에서 선택 3개가 이미 추가돼 있을 수 있다. 여기에 정렬/삭제 4개를 **추가(append)** 한다(기존 항목 제거/재배치 금지).
  - `onMenuSelect(id)`(약 423행)와 `if (isMapping) return;`(약 442행) — 정렬/삭제 4개는 **이 매핑 가드 뒤**에 둔다(본문 변경 → 매핑 차단). 대소문자 변환(약 470행 `const fn = VIEW_TRANSFORMS[id];`)·`edit.insertContinue`(약 469행)와 같은 구역.
  - `commitBody(nextBody)`(약 244~247행) — **본문 변경 단일 경로**. `updateField('body', nextBody)` + `updateField('title', bodyTitle(nextBody))`. 정렬/삭제도 이 함수만 호출한다.
  - 기존 본문 변경 선례(모두 `commitBody`를 지나 제목 자동 재동기화): 대소문자 변환(약 475~477행: `transformTextLine` → `commitBody(serialize(r.blocks))` + `setPendingCaretLine`), `insertContinue`(약 263행: `commitBody(serialize(r.blocks))` + `setPendingCaretLine`), `convertAbbrev`(전체 본문 transform은 `setPendingCaretLine` 미호출).
  - `onKeyDown`의 Ctrl+D 라인삭제(약 585~600행: `isDeleteLine` → Backspace/Delete 빈줄 가드(595) → `textLineToBlockIndex`(597) → `commitBody(serialize(deleteLineAt(blocks, blockIndex).blocks))`(600)) — `edit.deleteLine`이 **본문 변이 코어를 공용화**해 재사용한다(복붙 금지). **추출 경계(엄수)**: 공용 함수는 `blockIndex`를 받아 `commitBody(serialize(deleteLineAt(blocks, blockIndex).blocks))`(현재 :600과 **동일**)만 담는다. Ctrl+D와 `edit.deleteLine` 양쪽이 이 **단일 소스**를 쓰고, 제목 재동기화는 `commitBody`가 자동 처리한다(별도 단계 없음).
    - (a) `setPendingCaretLine`은 공용에 넣지 말고 `edit.deleteLine` 결선에서만 호출한다(기존 Ctrl+D는 setPendingCaretLine을 부르지 않으므로 — Editor의 refocusRef 복원에 맡긴다 — 공용에 넣으면 Ctrl+D 동작이 바뀐다).
    - (b) `onKeyDown`의 Backspace/Delete 빈 줄 가드(약 595행 `(text.split('\n')[textLineIndex] ?? '') !== ''` 조기 return)와 `readCaret`/`lineAtOffset` 계산은 **추출 대상이 아니다**(키다운 전용 — 그대로 둔다).
    - (c) **제목 재동기화는 별도 단계가 없다** — 공용 코어의 `commitBody`가 body+title을 함께 갱신하므로 Ctrl+D·`edit.deleteLine` 양쪽 모두 제목이 자동 재동기화된다(phase 28 회귀 보존).
  - `onTextChange`(약 251~253행)는 현재 `commitBody(serializeBodyFromBlocks(editedBlocks))` **한 줄뿐**이다 — 타이핑 시 제목 동기화도 `commitBody`가 처리한다(인라인 `split('\n')[0]` 첫 줄 파생은 phase 28이 제거). 정렬/삭제 결선도 동일하게 **인라인 파생을 복제하지 말고 `commitBody` 중앙 경로를 쓴다**.
  - `lastCaretRef`(약 188행) `{ lineIndex, offset }`, `bodyText`(약 201행) `= blocksToText(blocks)`, `lineAtOffset`(import 약 46행) — deleteWord의 컬럼 계산에 쓴다.
- `web/src/view/WriterPage.test.jsx` — **수정 대상**. `focusCaretAtLine`/`caretAtLine` 헬퍼로 정렬/삭제·제목 재동기화 단언 추가.

## 작업 (TDD — 테스트 먼저)

### 1. MENU_ENABLED 확장

- `'edit.sortDocument'`, `'edit.sortParagraph'`, `'edit.deleteLine'`, `'edit.deleteWord'`를 **추가**한다(순수 append).

### 2. onMenuSelect 라우팅 (매핑 가드 **뒤**)

공통: `const caret = lastCaretRef.current;`. 본문 변경은 `commitBody(serialize(next))` **단일 호출**로만 한다(commitBody가 body+title을 함께 갱신 — 결선부에 제목 재동기화 단계를 따로 두지 않는다). 변경 결과가 `changed:false`(또는 blockIndex<0)면 no-op.

- `edit.deleteLine` →
  - `const caretLine = caret ? caret.lineIndex : null;` `caretLine==null`이면 no-op.
  - `const blockIndex = textLineToBlockIndex(blocks, caretLine);` `<0`이면 no-op.
  - **기존 Ctrl+D 라인삭제 코어를 공용 핸들러로 추출해 재사용**: 공용 함수(예: `deleteLineByBlockIndex(blockIndex)`)는 `commitBody(serialize(deleteLineAt(blocks, blockIndex).blocks))` **만** 담는다(현재 WriterPage.jsx:600과 동일 — onKeyDown Ctrl+D와 단일 소스, 복붙 금지, 동반 임베드 1개 삭제 승계). `commitBody`가 제목까지 재동기화하므로 별도 제목 단계는 없다. 위 "읽어야 할 파일"의 **추출 경계** (a)(b)를 지켜라(`setPendingCaretLine`·Backspace 빈줄 가드는 공용에 넣지 않음).
  - 공용 호출 **후 이 결선부에서만** `setPendingCaretLine(caretLine)`(삭제 후 그 자리 줄로 포커스)를 추가한다 — Ctrl+D 경로는 `setPendingCaretLine`을 부르지 않으므로 기존 동작 불변(제목 재동기화는 공용 코어의 `commitBody`가 양쪽 모두 처리).
- `edit.deleteWord` →
  - `caretLine`(위와 동일) 없으면 no-op.
  - 컬럼: `const { start } = lineAtOffset(bodyText, caret.offset); const column = caret.offset - start;`
  - `const r = deleteWordAt(blocks, caretLine, column);` `r.changed`면 `commitBody(serialize(r.blocks))` + `setPendingCaretLine(caretLine)`.
- `edit.sortDocument` →
  - `const r = sortDocument(blocks);` `r.changed`면 `commitBody(serialize(r.blocks))`. (전체 본문 transform → `convertAbbrev`처럼 `setPendingCaretLine` **미호출** — 오프셋 대량 변동, 포커스 유지가 안전.)
- `edit.sortParagraph` →
  - `caretLine` 없으면 no-op. `const r = sortParagraph(blocks, caretLine);` `r.changed`면 `commitBody(serialize(r.blocks))`. (문단 정렬도 줄 순서가 바뀌므로 `setPendingCaretLine` 미호출 — sortDocument와 동일.)

### 3. 제목 동기화 — commitBody가 자동 처리 (별도 단계 없음)

정렬/삭제는 본문 첫 줄(=제목)을 바꿀 수 있다(특히 sortDocument는 첫 줄이 거의 항상 바뀐다). 그러나 **결선부에 별도 제목 재동기화 단계를 두지 마라** — 위 4개 op 모두 `commitBody(serialize(next))` 단일 호출을 지나고, `commitBody`가 `updateField('body', ...)` + `updateField('title', bodyTitle(...))`로 body와 title을 **함께** 갱신한다(WriterPage.jsx:244~247, phase 28 불변식).

- **유일 경로**: 모든 본문 변경 op는 `commitBody`만 호출한다. `updateField('body', ...)`를 직접 부르거나 `updateField('title', bodyTitle(...))`를 결선부에 따로 추가하지 마라 — 직접 `updateField` 재도입은 phase 28이 없앤 제목 stale 결함을 되살린다.
- **인라인 파생 금지**: `text.split('\n')[0]` 같은 첫 줄 분해를 복제하지 마라(`bodyTitle` 단일 출처는 commitBody 내부에서만 쓰인다).

## 핵심 규칙 (반드시 준수 — 위반 시 반려)

1. **매핑 가드 뒤**: 정렬/삭제 4개는 `if (isMapping) return;` 뒤에 둔다(본문 변경 → 매핑 차단, 본문-only 불변식).
2. **단일 choke point**: 본문 변경은 `commitBody(serialize(...))`로만. contentEditable/DOM/selection 직접 조작 금지. `Editor.jsx` 미접촉.
3. **단일 소스**: `edit.deleteLine`은 onKeyDown Ctrl+D 라인삭제와 **같은 공용 코어**(`commitBody(serialize(deleteLineAt(...).blocks))`)를 쓴다(두 곳에 `deleteLineAt` 호출을 복붙하지 마라).
4. **제목 자동 동기화**: `commitBody`가 body+title을 함께 갱신하므로 결선부에 제목 재동기화 단계를 따로 두지 않는다. `updateField('body'/'title')` 직접 호출·인라인 `split('\n')[0]` 파생 금지(phase 28 불변식).
5. **no-op 존중**: `changed:false`/캐럿 없음/blockIndex<0이면 `commitBody` 미호출(불필요한 dirty/remount 회피).
6. **경계·정렬·삭제 계산 재사용**: 정렬/단어삭제 계산은 `editorEditOps`(step 3)·`editorRange`(step 0)만 쓴다. WriterPage에서 재구현 금지.

## Acceptance Criteria

```bash
npm run test:web    # 정렬/삭제 결선 + 제목 자동 동기화 + 매핑 차단 단언 + 기존 회귀(Ctrl+D·대소문자·타이핑) 통과 (vitest)
npm run build
npm run lint
```

추가 단언(vitest, WriterPage.test.jsx):
- `MENU_ENABLED` 확장으로 편집>'문서 정렬'/'문단 정렬'/'한줄 지우기'/'단어 지우기'가 **활성**이다.
- 여러 줄 본문에서 '문서 정렬' 클릭 시 본문(`updateField('body', …)`)이 정렬되고 **"(끝)" 마커가 최종 유지**, 첫 줄 변경 시 **제목(`updateField('title', …)`)이 새 첫 줄로 재동기화**된다(commitBody 경로 — 결선부 별도 title 호출 없음).
- 캐럿을 특정 문단에 두고 '문단 정렬' 시 그 문단만 정렬되고 다른 문단 불변.
- 캐럿 줄에서 '한줄 지우기' 시 그 줄이 삭제된다(기존 Ctrl+D와 동일 결과 — 단일 소스 회귀). 마커 줄에서 실행 시 마커 줄 통째 삭제 허용(news.md L167).
- 캐럿 단어에서 '단어 지우기' 시 그 단어만 삭제; 마커 줄에서는 no-op(본문 불변).
- **매핑 모드**: 정렬/삭제 4개 클릭 시 `updateField('body', …)`가 호출되지 않는다(텍스트 잠금 가드).
- **Ctrl+D 제목 회귀(phase 28 보존)**: 여러 줄 본문 첫 줄에 캐럿을 두고 Ctrl+D로 첫 줄을 삭제하면 `updateField('title', …)`가 새 첫 줄로 재동기화된다 — Ctrl+D·`edit.deleteLine` 공용 코어가 `commitBody`를 지나므로 제목이 자동 갱신됨을 단언한다.
- 기존 Ctrl+D/Backspace/Delete 라인삭제·대소문자 변환·`edit.insertContinue`·선택 항목(step 2)·타이핑·메뉴 열고닫기 불변.

## 검증 절차

1. 위 AC 커맨드 실행.
2. 아키텍처 체크리스트: View 결선(ADR-003)·매핑 가드 뒤·`commitBody` 단일 choke point만·Editor 미접촉·deleteLine 단일 소스·제목 commitBody 자동 동기화(결선부 별도 title 호출 없음)·정렬 마커 최종/임베드 보존·회귀 없음.
3. `phases/29-editor-edit-menu/index.json`의 step 4 업데이트(성공 completed·3회 실패 error·개입 blocked). 성공 시 `summary`에 결선 4항목·commitBody 단일 경로·매핑 차단을 한 줄로 남긴다.

## 금지사항

- 정렬/삭제 4개를 매핑 가드 앞에 두지 마라. 이유: 본문을 바꾸므로 매핑(텍스트 잠금)에서 차단돼야 한다 — 앞에 두면 본문-only 불변식 위반.
- `updateField('body')`를 직접 호출하지 마라 — `commitBody` 단일 choke point만 지난다(phase 28 불변식). 이유: 직접 호출은 제목 재동기화를 건너뛰어 옛 제목이 DB에 남는 stale 결함을 되살린다.
- `updateField('title', ...)`를 결선부에 따로 추가하지 마라. 이유: `commitBody`가 이미 제목을 재동기화하므로 중복이고, 제목 파생 출처가 갈라진다.
- `Editor.jsx`를 수정하거나 contentEditable/DOM/selection을 직접 조작하지 마라. 이유: phase 5/8/20 타이핑·remount·캐럿 불변식. 본문 변경은 `commitBody(serialize(...))`로만.
- `edit.deleteLine`에 `deleteLineAt` 호출을 새로 복붙하지 마라. 이유: Ctrl+D와 삭제 의미가 갈라지면 회귀. 공용 코어(`commitBody(serialize(deleteLineAt(...).blocks))`)로 단일화한다.
- 제목 파생을 `split('\n')[0]`로 인라인 복제하지 마라. 이유: phase 28이 중앙화한 `commitBody`/`bodyTitle`과 출처가 갈라져 stale 제목/불일치가 생긴다.
- 정렬 헬퍼가 마커를 이동시키거나 임베드를 재배치하도록 결선 측에서 우회하지 마라(정렬 계산은 step 3에서 이미 보호 — 결선은 그대로 사용). 이유: 송고 자격/임베드 위치 불변식.
- `MENU_ENABLED` 기존 항목(선택 3개 포함)을 지우거나 순서를 바꾸지 마라. 이유: step 2·기존 결선 회귀.
- undo/redo·cut/copy/paste 등 DEFER 항목을 결선하지 마라(별도 phase). 새 npm 의존성·DB/서버 수정·기존 테스트 파괴 금지.
