# Step 2: ime-composition-guard

한글(IME) 조합 중에 Backspace/Delete/Ctrl+D를 누르면 `WriterPage.jsx`의 `onKeyDown`이 커스텀 줄삭제 로직을 실행해 **조합이 깨진다**(조합 중인 글자가 소실되거나 예기치 않게 줄이 지워짐). `onKeyDown`에 IME 조합 가드(`isComposing`)가 없다. 조합 중에는 커스텀 삭제 처리를 하지 않고 IME/브라우저에 맡긴다.

## 읽어야 할 파일

먼저 아래 파일들을 읽고 프로젝트의 아키텍처와 설계 의도를 파악하라:

- `/CLAUDE.md` — 프로젝트 규칙(DB 비파괴·TDD·conventional commits).
- `/docs/ARCHITECTURE.md` — 프론트 MVC, View 순수성(ADR-003).
- `/docs/ADR.md` — zero-dep·TDD.
- `/docs/news.md` — 한글 입력(IME) 조합 중 색상 미재적용(173행 — 조합 중에는 개입하지 않는다는 기존 원칙), Ctrl+D 줄삭제(169행)·Backspace/Delete 줄삭제 시 임베드 동반 삭제(170행), "(끝)" 마커 뒤 IME 차단(167행).
- `/web/src/view/WriterPage.jsx` — **수정 대상**. `onKeyDown`(약 542~590행). 반드시 **현재 파일을 처음부터 정독**하라(step1이 이 파일의 본문변경 경로를 이미 손댔을 수 있으니 최신 상태 확인). 구조:
  - 상단: Ctrl+F(`isFindReplace`)·Alt+O(`isGlyphInput`)·Alt+V(`isPasteOriginal`)·Alt+Y(`isInsertEndMarker`)·Ctrl+Y(`isInsertContinueMarker`) 분기.
  - `const ctrlD = isDeleteLine(e);`(약 574행) 이후: `if (!ctrlD && e.key !== 'Backspace' && e.key !== 'Delete') return;` → **여기부터가 파괴적 줄삭제 경로**(빈 줄이면 라인 삭제, 임베드 동반 삭제, `commitBody`/`updateField('body', ...)`로 반영).
  - `readCaret(e.currentTarget)`로 캐럿을 읽고 `blocksToText`/`lineAtOffset`으로 삭제할 줄을 정한다.
- `/web/src/view/editorShortcuts.js` — 참고. `isDeleteLine`(Ctrl+D 판정)·`deleteLineAt`(줄+동반 임베드 삭제) 계약. 이 step은 이 파일을 **수정하지 않는다**(가드는 WriterPage onKeyDown에만).
- `/web/src/view/Editor.jsx` — 참고. `readCaret` 및 contentEditable/조합 처리 맥락(조합 중 색상 미재적용 등 기존 IME 처리 위치 확인).
- `/web/src/view/WriterPage.test.jsx` — **수정 대상(테스트 추가)**. `fireEvent.keyDown(container.querySelector('.yh-editor'), { key:'d', ctrlKey:true })`(약 439행)·`{ key:'Backspace' }`(약 452행) 패턴을 그대로 활용한다.

이전 step에서 만들어진 코드를 꼼꼼히 읽고, 설계 의도를 이해한 뒤 작업하라.

## 배경(결함 상세)

- 브라우저 IME 조합 중에는 `KeyboardEvent.isComposing === true`(레거시로는 `keyCode === 229`)다. React 합성 이벤트에서는 `e.nativeEvent.isComposing`로 읽는다.
- 조합 중 Backspace는 IME가 **조합 중인 자모를 되돌리는** 동작이어야 하는데, `onKeyDown`이 이를 가로채 "빈 줄이면 라인 삭제" 경로로 처리하거나 `preventDefault`해 조합을 깨뜨린다. Ctrl+D도 조합을 끊고 줄을 지운다.
- news.md 173행은 이미 "조합 중에는 (색을) 다시 칠하지 않는다"며 **조합 중 개입 금지** 원칙을 명시한다. 삭제 키 처리도 같은 원칙을 따라야 한다.

## 작업 (TDD — 테스트 먼저)

### 1) 테스트 먼저 작성 — `/web/src/view/WriterPage.test.jsx`

편집 탭을 열고 `.yh-editor`에서 조합 중 키 이벤트를 발생시켜 **본문이 변하지 않음**을 단언한다:

- **조합 중 Ctrl+D 무개입**: 여러 줄 본문(예: `헤드\n둘째\n셋째`)을 seed한 편집 탭에서 `fireEvent.keyDown(editor, { key:'d', ctrlKey:true, isComposing:true })` → 줄 개수/본문이 **그대로**임을 단언한다(줄이 삭제되지 않음).
- **조합 중 Backspace 무개입**: 빈 줄이 있는 본문에서 `fireEvent.keyDown(editor, { key:'Backspace', isComposing:true })` → 줄 삭제가 일어나지 않음을 단언한다.
- **회귀 가드(조합 아님)**: `isComposing` 없이(또는 `false`) 같은 Ctrl+D/Backspace를 발생시키면 **기존대로 줄이 삭제**됨을 단언한다(기존 삭제 동작 무회귀).
- 참고: RTL `fireEvent.keyDown(el, { key, isComposing:true })`는 네이티브 `KeyboardEvent`에 `isComposing`을 실어 주며, React는 `e.nativeEvent.isComposing`로 읽는다. 구현이 `e.nativeEvent?.isComposing`(또는 `e.keyCode === 229`)를 보게 하면 이 단언이 통과한다.

### 2) 구현 — `/web/src/view/WriterPage.jsx` (`onKeyDown`)

- IME 조합 가드를 추가한다. **파괴적 삭제 경로가 실행되기 전에** 조합 중이면 커스텀 처리를 하지 않는다(early return, `preventDefault`도 하지 않아 IME/브라우저 기본 동작을 보존).
- **권장 위치**: `onKeyDown` 최상단(`isFindReplace` 분기보다 위)에 한 줄로 둔다 —
  ```js
  if (e.nativeEvent && e.nativeEvent.isComposing) return; // IME 조합 중에는 어떤 에디터 단축키도 가로채지 않는다
  ```
  이유: 조합 중에는 Backspace/Delete/Ctrl+D뿐 아니라 다른 단축키도 조합을 방해하면 안 되므로 최상단 일괄 가드가 가장 안전하다. (조합 중 Ctrl+F 등은 극히 드물고, 가로채지 않아도 브라우저 기본으로 동작한다.)
- 최소 요구 불변식은 **"조합 중 Backspace/Delete/Ctrl+D가 커스텀 줄삭제 로직을 실행하지 않는다"** 이다. 최상단 일괄 가드 대신 삭제 경로 직전(`const ctrlD = isDeleteLine(e);` 위)에 가드를 둬도 이 불변식을 만족하면 허용한다. 단, **가드가 없던 기존 동작(조합 아닐 때)은 100% 보존**해야 한다.

### 핵심 불변식(반드시 준수)

- `e.nativeEvent.isComposing`(또는 `keyCode 229`)가 참이면 `onKeyDown`은 **줄삭제/임베드 삭제/`preventDefault`를 하지 않고** 그대로 반환한다.
- 조합이 아닐 때(`isComposing` false)의 Ctrl+F/Alt+O/Alt+V/Alt+Y/Ctrl+Y/Ctrl+D/Backspace/Delete 동작은 **기존과 완전히 동일**하다.
- `editorShortcuts.js`·`Editor.jsx`·컨트롤러·서버를 수정하지 않는다(가드는 WriterPage `onKeyDown` 내부에서만).
- View는 transport 비의존을 유지한다(ADR-003).

## Acceptance Criteria

```bash
npm run test:web   # 신규 IME 가드 테스트 + 전체 회귀 통과 (vitest, web 루트)
npm run build      # vite 프로덕션 빌드 에러 없음
npm run lint       # ESLint 위반 없음
```

모든 신규/수정 텍스트는 UTF-8로 저장하라.

## 검증 절차

1. 위 AC 커맨드를 실행한다.
2. 아키텍처 체크리스트를 확인한다:
   - 가드가 파괴적 줄삭제 경로 **이전**에 걸리는가(조합 중 삭제/preventDefault 없음)?
   - 조합이 아닐 때의 기존 단축키 동작을 하나도 바꾸지 않았는가(회귀 테스트 통과)?
   - WriterPage `onKeyDown` 외 파일(editorShortcuts/Editor/컨트롤러/서버)을 건드리지 않았는가?
3. 결과에 따라 `phases/28-audit-stabilization/index.json`의 step 2를 업데이트한다:
   - 성공 → `"status": "completed"`, `"summary": "산출물 한 줄 요약"`
   - 수정 3회 시도 후에도 실패 → `"status": "error"`, `"error_message": "구체적 에러 내용"`
   - 사용자 개입 필요 → `"status": "blocked"`, `"blocked_reason": "구체적 사유"` 후 즉시 중단

## 금지사항

- 조합이 아닐 때의 삭제/단축키 동작을 바꾸지 마라. 이유: 이 step은 조합 중 무개입만 추가한다 — 기존 줄삭제/임베드 동반 삭제(news.md 169~170행)는 그대로 유지한다.
- `editorShortcuts.js`(`isDeleteLine`/`deleteLineAt`)를 수정하지 마라. 이유: 결함은 WriterPage `onKeyDown`의 가드 누락이지 순수 헬퍼 로직이 아니다 — 다른 step과 파일 겹침을 만들지 않는다.
- 조합 판정을 `e.key`/`e.keyCode`만으로 추정하지 마라(예: 특정 key 하드코딩). 이유: 조합 상태는 `isComposing`(또는 keyCode 229)이 표준 신호다 — 그것을 읽어라.
- 서버/DB 스키마를 수정하지 마라. 이유: 순수 클라이언트 입력 처리 결함이며 DB 비파괴 원칙을 지킨다.
- 새 npm 의존성을 추가하지 마라(zero-dep).
- 기존 테스트를 깨뜨리지 마라(특히 Ctrl+D/Backspace 줄삭제 테스트). 이유: 회귀 스위트가 하류 단계의 안전망이다.
