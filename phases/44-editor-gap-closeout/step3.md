# Step 3: overwrite-typing

## 목표

step2에서 만든 overwrite(수정) 모드에서 **실제로 캐럿 뒤 글자를 덮어쓰는 타이핑**을 구현한다. 방식: overwrite 모드에서 문자 키 입력 시 `WriterPage.onKeyDown`이 **캐럿 뒤 1글자를 선택(selection extend)한 뒤 `preventDefault` 없이 통과**시켜, 네이티브 입력이 그 선택을 대체하게 한다. 결과 텍스트 변경은 **기존 타이핑 에코 경로(`onTextChange` → `commitBody(coalesce)`)로 반영**된다 → undo 히스토리·색상 재칠 계약을 그대로 상속하고, **`Editor.jsx`를 건드리지 않는다**. 변경 대상: `editorNewline.js`(순수 판정 헬퍼) + `WriterPage.jsx`(onKeyDown 덮어쓰기 분기).

## 읽어야 할 파일

- `docs/ARCHITECTURE.md`, `docs/ADR.md`(ADR-003). `docs/news.md` — IME 조합 중 무개입, "(끝)" 마커 뒤 입력 차단, 삭제/이동/선택 키는 항상 허용.
- `phases/44-editor-gap-closeout/step2.md` — overwrite state(전역 단일)·Insert 토글. step2 요약이 프롬프트에 함께 온다.
- `web/src/view/editorNewline.js` — 전체. **L22~29 `isInputBlocked(text, caretOffset)`**("(끝)" 마커 시작 이상이면 차단 — 신규 헬퍼가 재사용). L31~80 `insertTextIntoBlocks`(참고 — blocksToText 좌표 관례).
- `web/src/view/editorContent.js` — `blocksToText`(텍스트 블록만 `\n`으로 조인, 임베드 제외 — 신규 헬퍼가 이 텍스트 좌표에서 판정). grep으로 시그니처 확인.
- `web/src/view/editorNewline.test.js` — `isInputBlocked` 테스트 스타일(신규 헬퍼 테스트를 동형으로 추가).
- `web/src/view/Editor.jsx` — **수정 안 함. 확인만**:
  - `readCaret(root)`(L130~154, export) — `{ lineIndex, offset, col }` 반환. WriterPage가 이미 import·사용(onKeyDown Ctrl+D 경로 `readCaret(e.currentTarget)`).
  - `handleKeyDown`(L457~469) — `onKeyDown(e)`를 먼저 호출 → `if (e.defaultPrevented) return;` → Enter/`isInsertionKey && caretBlocked` 처리. **우리는 preventDefault 안 하므로** Editor가 네이티브 입력을 이어간다.
  - `handleInput`(L514~522) — 네이티브 입력 후 DOM을 되읽어 `onTextChange(text, editBlocks)` emit(에코 경로). 이게 덮어쓰기 결과를 반영하는 경로다.
- `web/src/view/WriterPage.jsx` — 특히:
  - **L1068~1149 `onKeyDown`** — L1071 IME 가드, step2에서 추가된 Insert 토글, L1123~1132 keymapGlyph, **L1133 `const ctrlD = isDeleteLine(e);`** + L1134 바일아웃. **덮어쓰기 분기 배치 = keymapGlyph 블록(L1132) 뒤, `const ctrlD`(L1133) 앞.**
  - L1139~1140(`const text = blocksToText(blocks);` `const caret = readCaret(e.currentTarget);` — 좌표/캐럿 읽기 관례).
  - `onTextChange`(L411~415 근처 — `commitBody(serializeBodyFromBlocks(editedBlocks), { coalesce: true })`) 및 L1457 `onTextChange={isMapping ? undefined : onTextChange}`(매핑 시 미부착).
  - `isMapping`·`blocks`·`overwrite`(step2) state.
- `web/src/view/WriterPage.test.jsx` — 키다운 시뮬레이션·캐럿 배치 헬퍼(`focusCaretAtLine` 등)·selection 조작 관례.

## 배경 (자기완결) — 반드시 숙지할 아키텍처 사실

1. **에코 경로가 이미 commitBody를 탄다.** 네이티브 문자 입력 → `Editor.handleInput` → `onTextChange(text, blocks)` → WriterPage `onTextChange`가 `commitBody(serialize, { coalesce: true })`. 즉 **일반 타이핑과 동일 경로**. 덮어쓰기는 "삽입"을 "대체"로 바꿀 뿐 — 결과 반영 경로는 그대로다. → undo(타이핑 coalesce 1단계)·색상 재칠 계약 자동 상속.
2. **덮어쓰기 = 캐럿 뒤 1글자 선택 후 네이티브 입력.** overwrite 모드에서 문자 키 keydown 시, 캐럿이 (a)줄 끝이 아니고 (b)"(끝)" 마커 영역이 아니면, collapsed 캐럿을 **줄 안에서 앞으로 1글자 확장**한다. `preventDefault`하지 않으므로 네이티브 입력이 확장 선택을 대체한다. 확장 안 하면(줄 끝/임베드 앞/마커/무효) 그냥 네이티브 삽입(=삽입 폴백).
3. **경계는 순수 판정으로 결정한다.** `blocksToText(blocks)`의 절대 오프셋 `text[offset]`가 캐럿 바로 뒤 글자다: `'\n'`이면 줄 끝(다음 줄 침범 금지·임베드 앞), 문서 끝 초과면 끝, 마커 영역이면 차단. 이 판정을 **순수 함수**로 분리해 결정적으로 테스트한다. selection 확장(DOM)은 그 판정이 true일 때만 하는 얇은 조작이다.
4. **IME 보류.** L1071 IME 가드(`isComposing`/`keyCode===229`)가 조합 중 keydown을 먼저 걸러낸다 → 덮어쓰기 분기는 그 뒤라 조합 중엔 도달하지 않는다(news.md 무개입, "조합 완료 후 일반 입력부터 적용" = 안전측).
5. **매핑 무개입.** 매핑 모드에선 `onKeyDown`이 Editor에 미부착(L1456 `isMapping ? undefined`)이고 `onTextChange`도 미부착(L1457) → 덮어쓰기 분기 도달·반영 모두 불가(이중 방어).

## 설계 결정 (범위 — 못박음)

- **덮어쓰기 반영 = 에코 경로 재사용(`Editor.jsx` 미접touch).** 모델 preventDefault+commitBody+캐럿복원 방식은 remount 후 **열(col) 정밀 캐럿 복원**이 필요해 캐럿-stale 회귀 위험이 크다(memory: 캐럿 stale이 이 프로젝트의 최다 실패 계열). selection-extend + 네이티브 입력은 remount가 없어(에코 판정) 캐럿이 네이티브로 보존된다 — 가장 안전.
- **판정은 순수, DOM 조작은 얇게.** 순수 `shouldOverwriteNextChar(text, offset)`가 경계 전부를 담당(단위 테스트). WriterPage는 그 결과가 true일 때만 selection을 1글자 확장.
- **selection 확장 실패 시 삽입 폴백(안전 저하).** anchor가 텍스트 노드 끝(다음 글자가 형제 span에 있는 하이라이트 경계 등)이라 줄-안 1글자 확장을 깔끔히 못 하면 **확장하지 않는다**(그 키는 삽입으로 동작). 절대 오손 없음 — 하이라이트 경계에서 덮어쓰기가 삽입으로 저하될 뿐(문서화된 한계).
- **범위 밖**: 선택영역 서식·모델 기반 덮어쓰기·Editor.jsx 변경·열 정밀 캐럿 복원 신규 배선.

## TDD — 테스트 먼저

`web/src/view/editorNewline.test.js`(순수 판정 — 결정적):
- `shouldOverwriteNextChar('abc', 0) === true`(뒤에 'b'), `('abc', 1) === true`, `('abc', 2) === true`(뒤에 'c').
- `('abc', 3) === false`(문서 끝 → 삽입), `('abc', 99) === false`(범위 밖).
- `('ab\ncd', 2) === false`(캐럿 뒤가 `'\n'` = 줄 끝 → 삽입, 다음 줄 침범 금지), `('ab\ncd', 3) === true`(다음 줄 'c').
- 마커: `('본문\n(끝)', <'(끝)' 시작 오프셋>) === false`, 그 이상 오프셋 전부 false(`isInputBlocked` 재사용). 마커 앞 본문 오프셋은 정상 판정.
- `(text, null)`·`(text, -1)`·비정수 → false.

`web/src/view/WriterPage.test.jsx`(신규 describe '수정(overwrite) 모드 타이핑'):
- **모드 오프(삽입 기본)**: overwrite 미토글 상태에서 문자 keydown → selection 확장 없음(일반 삽입). (기존 타이핑 테스트가 회귀 없이 통과하는지 확인.)
- **모드 온 + 줄 중간**: Insert로 수정 모드 켜고, 캐럿을 줄 중간에 두고 문자 keydown → **selection이 앞으로 1글자 확장됨**(확장 여부/범위를 `window.getSelection()`로 단언). preventDefault는 호출하지 않음(기본 삽입 억제 아님).
- **모드 온 + 줄 끝**: 캐럿을 줄 끝에 두고 문자 keydown → 확장 없음(삽입 폴백 — `shouldOverwriteNextChar` false).
- **모드 온 + 마커 영역/임베드 앞**: 확장 없음.
- **IME 조합 중**: overwrite 온에서 `{ ... , isComposing: true }`(또는 keyCode 229) keydown → 확장 없음(L1071 가드 먼저 return).
- **비문자 키**: overwrite 온에서 Enter/Backspace/Delete/방향키 → 확장 없음(문자 키만 트리거).

> **jsdom 한계 명시**: jsdom은 contentEditable 네이티브 입력/문자 대체를 실행하지 않는다. 따라서 "글자가 실제로 대체됐다"는 end-to-end 단언은 불가하다. 테스트 경계는 **(A) 순수 판정 함수의 결정 로직 전수**(핵심 TDD 대상) + **(B) overwrite 모드 문자 keydown 시 selection이 조건대로 확장/미확장되는지**다. `window.getSelection().extend`가 jsdom에서 불안정하면 (B)는 확장 헬퍼 호출 여부(스파이)로 대체 단언하라(정확한 단언 방식은 구현자 재량 — 결정 로직은 (A)로 잠근다).

## 작업 (구현 상세)

### 1. `web/src/view/editorNewline.js` — 순수 판정 헬퍼
```js
// 덮어쓰기(수정 모드) 대상 여부 — 캐럿 바로 뒤(text[offset])에 같은 줄 글자가 있고 마커 영역이 아니면 true.
// text = blocksToText(blocks)(임베드 제외 텍스트 좌표). offset = readCaret().offset.
// '\n'(줄 끝·임베드 앞)·문서 끝·"(끝)" 마커 영역·무효 오프셋이면 false(삽입 폴백).
export function shouldOverwriteNextChar(text, offset) {
  const s = String(text ?? '');
  const i = Number(offset);
  if (!Number.isInteger(i) || i < 0 || i >= s.length) return false;
  if (s[i] === '\n') return false;
  if (isInputBlocked(s, i)) return false;
  return true;
}
```
(`isInputBlocked`는 같은 파일에 있음 — cross-import 불필요.)

### 2. `web/src/view/WriterPage.jsx` — onKeyDown 덮어쓰기 분기
- import에 `shouldOverwriteNextChar` 추가(`editorNewline` import에 병합).
- keymapGlyph 블록(L1132) **뒤**, `const ctrlD = isDeleteLine(e);`(L1133) **앞**에 삽입:
  ```js
  // 수정(overwrite) 모드 문자 입력 — 캐럿 뒤 1글자를 선택 확장한 뒤 preventDefault 없이 통과 → 네이티브 입력이 대체.
  // 결과는 에코 경로(onTextChange → commitBody coalesce)로 반영(undo/색상 계약 상속). Editor.jsx 미접촉.
  // 문자 키만(e.key.length===1 && 수식어 없음). 확장 조건 불충족(줄 끝/임베드 앞/마커/무효)이면 확장 안 함 = 삽입 폴백.
  if (overwrite && !isMapping && e.key && e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
    const root = e.currentTarget;
    const caret = readCaret(root);
    if (caret && shouldOverwriteNextChar(blocksToText(blocks), caret.offset)) {
      // collapsed 캐럿을 줄 안에서 앞으로 1글자 확장. 텍스트 노드 끝 경계 등 깔끔히 못 하면 확장 생략(삽입 폴백).
      extendSelectionForOverwrite(root);
    }
    // preventDefault/return 하지 않는다 — 아래 바일아웃(L1134)으로 자연 종료, 네이티브 입력이 이어진다.
  }
  ```
  - `extendSelectionForOverwrite(root)`(WriterPage 내부 헬퍼 또는 얇은 인라인): `window.getSelection()`을 읽어 collapsed이고 `anchorNode`가 텍스트 노드이며 `anchorOffset < anchorNode.textContent.length`면 `sel.extend(anchorNode, anchorOffset + 1)`. 아니면 no-op(삽입 폴백). **정확한 확장 구현은 재량**이되, (a)줄 경계를 넘지 않고 (b)실패 시 안전 폴백해야 한다.
- **배치 근거(load-bearing)**: keymapGlyph 뒤 → 예약/약물 조합이 먼저 처리된 뒤 순수 문자만 도달. `const ctrlD`/L1134 바일아웃 앞이지만 **return하지 않으므로** 문자 키는 확장 후 L1134에서 자연 return된다(Ctrl+D/Backspace/Delete 경로 무영향).

## Acceptance Criteria

```bash
npm run lint
npm run build
npm run test:web
```

(client 전용. `npm test` 불필요.)

## 회귀 가드 / 불변식

- **`Editor.jsx` diff 없음**: 덮어쓰기는 WriterPage.onKeyDown의 selection 조작 + 에코 경로만. Editor 내부 미접촉.
- **경계**: 줄 끝(`'\n'`)·임베드 앞·"(끝)" 마커·문서 끝에서는 삽입으로 동작(`shouldOverwriteNextChar` false → 확장 없음). 다음 줄/마커/임베드 절대 침범 금지.
- **IME**: 조합 중(L1071 가드)에는 덮어쓰기 미개입.
- **매핑**: 매핑 모드에서 확장/반영 없음(`!isMapping` 가드 + onKeyDown/onTextChange 미부착).
- **비문자 키**: Enter/Backspace/Delete/방향키/수식어 조합은 기존 동작 그대로(문자 키만 트리거).
- **undo/색상 상속**: 반영이 에코(`onTextChange` → `commitBody` coalesce)를 타므로 일반 타이핑과 동일한 undo 1단계·재색칠.
- 기존 타이핑/캐럿/마커 테스트 그린 유지.

## 커밋 계획

- **feat**: `feat(44-editor-gap-closeout): step3 — 수정(overwrite) 모드 덮어쓰기 입력(editorNewline shouldOverwriteNextChar + WriterPage selection-extend 에코 경로)` — `editorNewline.js`·`WriterPage.jsx` + `editorNewline.test.js`·`WriterPage.test.jsx`.
- **chore**: `chore(44-editor-gap-closeout): step3 status — completed` — index.json step3(phase ② 완결 — 표시+토글+덮어쓰기).

## 금지사항

- `Editor.jsx`를 건드리지 마라. 이유: 모델-기반 덮어쓰기는 remount 후 열 정밀 캐럿 복원이 필요해 캐럿-stale 회귀(이 프로젝트 최다 실패 계열)를 부른다 — selection-extend + 에코가 remount 없이 캐럿을 네이티브로 보존한다.
- 덮어쓰기 분기에서 `preventDefault`하지 마라(문자 키). 이유: 네이티브 입력이 확장 선택을 대체해야 한다 — preventDefault하면 대체가 일어나지 않는다.
- 줄 끝/임베드 앞/"(끝)" 마커/문서 끝에서 확장하지 마라. 이유: 다음 줄·임베드·마커를 침범하면 news.md 입력 차단 계약과 블록 무결성이 깨진다. `shouldOverwriteNextChar`가 이를 전부 false로 막는다.
- IME 가드(L1071)를 옮기거나 그 위로 덮어쓰기 분기를 올리지 마라. 이유: 조합 중 selection을 확장하면 한글 입력이 깨진다(news.md 무개입).
- 반영을 `commitBody`가 아닌 DOM/contentEditable 직접 조작으로 하지 마라. 이유: 에코 경로(onTextChange → commitBody coalesce)를 벗어나면 undo 결합·색상 재칠·제목 재동기화 계약이 깨진다.
- selection 확장이 애매한 경계(하이라이트 span 등)에서 억지로 확장하지 마라 — 삽입 폴백하라. 이유: 잘못된 cross-node 선택은 오손 위험 — 안전 저하가 낫다.
- overwrite state를 새로 만들지 마라(step2에서 존재). 이유: 중복 state는 토글/표시와 이원화된다.
- 기존 테스트를 깨뜨리지 마라.
