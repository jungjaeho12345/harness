# Step 15: editor-wiring

이미 구현·단위테스트까지 끝났지만 **어떤 컴포넌트에서도 결선(import·호출)되지 않은 에디터 헬퍼들**을 실제 에디터 UI에 연결한다. 결과적으로 news.md가 요구하는 (1) "(끝)" 마커 뒤 입력 차단, (2) Ctrl+D/Backspace/Delete 라인 삭제 + 임베드 동반 삭제, (3) IME 조합 중 재색칠 금지가 실제로 동작하게 되고, 데드코드(미결선 모듈/미사용 export)가 자연 해소된다. **이 step은 에디터 키 입력 상호작용 결선 한 가지 관심사만 다룬다. 본문 contract(markupVersion 전송)는 step14, 임베드 src 보안은 step16 소관이므로 건드리지 마라.**

## 근본 원인 (이 step에서 고치는 것)

모든 로직은 이미 존재하고 자기 `*.test.js`로 테스트까지 됐으나, **JSX/컴포넌트가 import해서 호출하지 않아 죽어 있다(degraded):**

### 15-A [High] "(끝)" 마커 뒤 입력 차단 미결선
- news.md 162행: "(끝)" 마커 뒤에는 어떤 입력도 할 수 없다(타이핑/Enter/붙여넣기/IME). 마커 앞 줄 편집·삭제는 허용. "(끝)"을 지우면 입력이 모든 위치에서 재개.
- `web/src/view/editorNewline.js`의 `isInputBlocked(text, caretOffset)`(L22-27)가 이 검사를 구현했다(caret이 마커 시작 이상이면 차단). 그러나 `web/src/view/Editor.jsx`의 `onInput`(L42)은 가드 없이 `onTextChange`만 호출하고, `WriterPage.jsx`의 `onKeyDown`(L61-68)은 Alt+Y만 처리한다. 즉 `isInputBlocked`를 부르는 곳이 없다.
- 유일한 완화책인 `writerBody.js`의 `mergeTextIntoBody`(L18-27)는 "(끝)"을 마지막으로 재정렬할 뿐 입력 차단이 아니다.

### 15-B [Medium] Ctrl+D 라인 삭제 / 임베드 동반 삭제 미결선
- news.md 164-165행: Ctrl+D로 해당 라인 제거, 라인 삭제 시 그 라인의 임베드 1개 동반 삭제.
- `web/src/view/editorShortcuts.js`의 `isDeleteLine(e)`(L13-15)·`deleteLineAt(blocks, index)`(L28-43)와 `web/src/view/editorCaret.js`의 `lineAtOffset`(L9-18)·`removeLineFromText`(L21-38)가 구현·테스트됐으나, `WriterPage.jsx` `onKeyDown`(L61-68)이 Alt+Y만 보고 Ctrl+D를 처리하지 않아 **브라우저 기본 동작으로 빠진다**(임베드는 × 버튼으로만 제거 가능 — degraded).

### 15-C [Low][correctness] IME 조합 중 재색칠 가드 미결선
- news.md 168행: 한글 IME 조합 중에는 재색칠 금지. 색 적용은 조합 완료(compositionend)/포커스 이탈(blur)/불러오기(load) 시점에만.
- `web/src/view/editorColoring.js`의 `shouldRecolor(trigger, {composing})`(L48-51)·`RECOLOR_TRIGGERS`(L46)가 구현·테스트됐으나, `Editor.jsx`(L27)는 매 렌더 `classifyLines`로 색을 칠하고 `onInput`(L42)이 조합 중에도 `onTextChange` → 재직렬화 → 재렌더로 조합 중 재색칠을 유발한다. `compositionstart`/`compositionend` 추적이 없다.

### 15-D [Low][유지보수] 데드코드(미결선 모듈/미사용 export)
- `web/src/view/editorNewline.js`(`appendEndMarker`/`hasEndMarker`/`isInputBlocked`), `web/src/view/editorCaret.js`(`lines`/`lineAtOffset`/`removeLineFromText`)는 자기 테스트만 import한다.
- `web/src/view/editorShortcuts.js`의 `isDeleteLine`/`deleteLineAt`, `web/src/view/editorColoring.js`의 `colorLines`/`shouldRecolor`/`RECOLOR_TRIGGERS`도 프로덕션 미참조.
- **위 15-A/B/C를 결선하면 대부분 자연 해소된다.** 결선 후에도 남는 *진짜* 미사용 export만 제거하라(아래 작업 4 참조). ROLES·TopBar right prop 제거는 step16 소관이니 건드리지 마라.

## 읽어야 할 파일

먼저 아래를 읽고 에디터의 블록 모델·색상·캐럿 규칙을 파악하라. **본문은 항상 블록 markupVersion으로 다룬다**는 것을 이해하고, 라이브 캐럿 오프셋을 `blocksToText` 기준 텍스트 오프셋과 어떻게 맞출지 설계하라:

- `/docs/news.md` — 기사 에디터 절(152-168행). 특히 159-165행("(끝)"·Alt+Y·입력차단·Ctrl+D·임베드 동반삭제)과 168행(IME 재색칠 금지).
- `/docs/ARCHITECTURE.md`(프론트엔드 MVC: View 순수/컴포넌트 ← Controller ← Model), `/docs/ADR.md`(ADR-003 transport 격리).
- `web/src/view/Editor.jsx`(현재 onInput/onKeyDown 결선 상태), `web/src/view/WriterPage.jsx`(onKeyDown L61-68·onTextChange L54-58·onRemoveEmbed L70-75·blocks L52).
- 결선 대상 헬퍼: `web/src/view/editorNewline.js`, `web/src/view/editorCaret.js`, `web/src/view/editorShortcuts.js`, `web/src/view/editorColoring.js`, `web/src/view/editorContent.js`(blocksToText/serialize/deserialize/textBlock).
- 본문 헬퍼: `web/src/view/writerBody.js`(mergeTextIntoBody/appendEmbedToBody/bodyTitle).
- 테스트 패턴: `web/src/view/editorNewline.test.js`, `web/src/view/editorShortcuts.test.js`, `web/src/view/editorColoring.test.js`(순수 함수 테스트), `web/src/view/Editor.test.jsx`(있다면)·`web/src/view/WriterPage.test.jsx`(컴포넌트 테스트 — @testing-library/react + userEvent), `web/src/test/setup.js`.

이전 step에서 만들어진 코드(특히 헬퍼 시그니처)를 꼼꼼히 읽고, **로직을 재구현하지 말고 결선만** 하라.

## 작업

### TDD 순서: 결선의 관찰 가능한 동작에 대한 실패 테스트를 먼저

각 기능마다 컴포넌트 레벨(@testing-library/react)에서 "결선됐다"를 검증하는 테스트를 먼저 쓰고 통과시켜라. DOM 캐럿 시뮬레이션이 jsdom에서 까다로우면, 핸들러가 헬퍼를 호출하는지(spy)나 결과 상태(직렬화된 본문)로 검증해도 된다. 순수 헬퍼는 이미 테스트됐으니 **결선부**만 검증하라.

### 구현 15-A: "(끝)" 마커 뒤 입력 차단 결선

`Editor.jsx`(또는 `WriterPage.jsx`의 onKeyDown)에 `isInputBlocked`를 결선하라:
- 라이브 캐럿 오프셋을 `blocksToText(blocks)` 기준 텍스트 오프셋으로 환산해(현재 활성 라인 div + 라인 내 offset 누적, `Editor.jsx`의 `readEditorText`/`.yh-editor__line` 구조 활용), `isInputBlocked(blocksToText(blocks), caretOffset)`가 true면 입력성 이벤트를 차단한다.
- 차단 대상: `beforeinput`/`keydown`(문자·Enter)/`paste`/`compositionstart`(IME 시작) 중 캐럿이 마커 시작 이상일 때. 차단 시 `e.preventDefault()`.
- 허용: 마커 앞(위 줄들) 편집, 그리고 **삭제/이동/선택은 항상 허용**(Backspace/Delete/방향키/Ctrl+A 등은 차단하지 않는다 — news.md 162행). 즉 차단은 "삽입"성 입력에만 적용한다.
- "(끝)"을 지우면(마커가 사라지면) `isInputBlocked`가 `idx === -1`로 false를 반환하므로 입력이 자동 재개된다(추가 로직 불필요 — 동작 확인만).

### 구현 15-B: Ctrl+D / Backspace / Delete 라인 삭제 + 임베드 동반 삭제 결선

`WriterPage.jsx`의 `onKeyDown`(L61-68)에 분기를 추가하라(기존 Alt+Y 분기 유지):
- `isDeleteLine(e)`(Ctrl+D)가 true면 `e.preventDefault()` 후, 현재 캐럿 기준 **활성 라인의 블록 인덱스**를 구해 `deleteLineAt(blocks, index)`를 적용하고 결과를 `serialize`해서 `updateField('body', ...)`로 반영한다. `deleteLineAt`은 텍스트 라인 삭제 시 바로 뒤 임베드 1개를 동반 삭제한다(이미 구현됨, editorShortcuts.js L28-43).
- 캐럿 → 블록 인덱스 매핑: `editorCaret.js`의 `lineAtOffset(text, caretOffset)`로 텍스트 라인 인덱스를 구한 뒤, 텍스트 블록만 세는 순서(Editor.jsx의 `textLine` 카운팅과 동일 규칙)로 실제 blocks 배열 인덱스로 환산하라. jsdom에서 정밀한 DOM 캐럿이 어려우면, 활성 라인 div(`.yh-editor__line`)에서 인덱스를 얻는 방식을 쓰되 테스트에서 재현 가능한 경로로 구현하라.
- 라인 삭제형 Backspace/Delete(빈 줄에서 라인 병합·삭제로 임베드가 함께 지워져야 하는 경우)도 같은 `deleteLineAt` 경로로 임베드 동반 삭제를 보장하라(news.md 165행). 단순 문자 삭제(Backspace로 글자 하나)는 기본 동작을 막지 마라 — **삭제는 항상 허용**(15-A와 충돌 금지).

### 구현 15-C: IME 조합 중 재색칠 금지 결선

`Editor.jsx`에 IME 조합 상태를 추적하고 `shouldRecolor`로 재색칠을 게이트하라:
- `onCompositionStart`/`onCompositionEnd` 핸들러로 `composing` 상태(ref/state)를 추적한다.
- 조합 중(`composing === true`)에는 `onTextChange`로 인한 재직렬화·재색칠을 하지 않거나, 색 적용(`classifyLines`/`colorForRole`)을 미룬다. `shouldRecolor(trigger, { composing })`가 false면 색을 다시 칠하지 않는다.
- `compositionend`/`blur`/`load`(`RECOLOR_TRIGGERS`) 시점에 재색칠을 적용한다.
- **주의:** 조합 중 입력 자체를 잃어버리면 안 된다 — 색칠만 미루고, 텍스트 반영은 조합 완료 시 정상 처리한다. `onTextChange` 경로가 조합 완료 후 본문을 올바르게 직렬화하도록 보장하라.

### 작업 4: 결선 후 남는 진짜 데드코드 정리(보수적으로)

15-A/B/C 결선을 마친 뒤, `editorNewline.js`/`editorCaret.js`/`editorShortcuts.js`/`editorColoring.js`에서 **여전히 프로덕션·테스트 양쪽 어디서도 참조되지 않는** export만 제거하라. 결선으로 사용되게 된 export(`isInputBlocked`/`deleteLineAt`/`isDeleteLine`/`lineAtOffset`/`shouldRecolor`/`RECOLOR_TRIGGERS` 등)는 **남겨둔다**. 제거 전 반드시 `grep`으로 참조를 확인하라("미사용처럼 보이지만 테스트가 import"하는 경우가 있다). `editorColoring.js`의 `ROLES`(L15)와 `TopBar.jsx`의 `right` prop은 **이 step에서 건드리지 마라**(step16 소관).

## Acceptance Criteria

```bash
npm run lint                              # ESLint 통과 (미사용 import 없음)
npm run build                             # 프론트 빌드 에러 없음
npm test                                  # 백엔드 node --test 전부 통과(변동 없어야 정상)
npm run test:web                          # Vitest 전부 통과(신규 결선 테스트 포함)
```

기존 프론트 188 + 백엔드 175 테스트(이 step 시작 시점의 전체)를 깨뜨리지 마라. 백엔드 테스트는 이 step에서 손대지 않으므로 그대로 통과해야 한다.

## 검증 절차

1. 위 AC 커맨드를 전부 실행한다.
2. 아키텍처 체크리스트:
   - 에디터 헬퍼 로직을 **재구현하지 않고 결선만** 했는가? (View 컴포넌트가 순수 헬퍼를 import해 호출)
   - 차단 규칙이 news.md를 정확히 따르는가? "(끝)" 뒤 **삽입만** 차단하고 삭제/이동/선택은 허용하는가? (162행)
   - IME 조합 중 재색칠을 막되 입력 텍스트는 유실하지 않는가? (168행)
   - transport 직접 호출이 없는가? (ADR-003 — 이 step은 순수 뷰 결선이라 Model을 거의 안 쓰지만, 본문 반영은 컨트롤러 `updateField` 경유)
   - 미사용 import/export가 lint 통과 수준으로 정리됐는가?
3. 결과에 따라 `phases/0-mvp/index.json`의 step 15를 업데이트한다:
   - 성공 → `"status": "completed"`, `"summary": "산출물 한 줄 요약"`
   - 수정 3회 실패 → `"status": "error"`, `"error_message": "구체적 에러"`
   - 사용자 개입 필요 → `"status": "blocked"`, `"blocked_reason": "사유"` 후 중단

## 금지사항

- "(끝)" 뒤 차단을 삭제/이동/선택까지 막도록 구현하지 마라. 이유: news.md 162행은 "삭제/이동/선택은 항상 가능"을 명시한다. 차단은 삽입성 입력(타이핑/Enter/붙여넣기/IME 시작)에만 적용한다. 과차단은 사용자가 "(끝)"을 지우지 못하게 만들어 입력 재개 자체를 막는다.
- 에디터 헬퍼 로직(isInputBlocked/deleteLineAt/shouldRecolor 등)을 컴포넌트 안에서 다시 구현하지 마라. 이유: 이미 구현·단위테스트된 순수 함수다. 재구현하면 두 버전이 갈라져 회귀가 생긴다 — import해서 호출만 하라.
- 데드코드를 grep 확인 없이 지우지 마라. 이유: 테스트가 import하는 export를 지우면 그 테스트가 깨진다. 결선으로 사용되게 된 export는 반드시 남긴다.
- `editorColoring.js`의 `ROLES`, `TopBar.jsx`의 `right` prop, 임베드 src 검증/sandbox를 건드리지 마라. 이유: step16의 응집 단위다. 범위를 섞으면 실패 격리가 불가능하다.
- 본문을 `markupVersion` 키로 보내는 contract 변경(step14)을 건드리지 마라. 이유: step14 소관이며, 이 step은 키 입력 상호작용 결선만 한다.
- IME 조합 중 입력 텍스트를 버리지 마라. 이유: 색칠만 미루는 것이 목표다. 조합 완료 시 본문에 정상 반영돼야 한다.
- 기존 테스트를 깨뜨리지 마라.
