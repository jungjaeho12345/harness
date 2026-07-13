# Step 0: edit-range-helpers — 단어/문단 경계 순수 헬퍼

## 이 phase의 범위 (반드시 먼저 읽어라)

이 phase(29-editor-edit-menu)는 에디터 **편집(edit) 메뉴**의 미결선 항목 중 **자기완결 텍스트 조작**만 결선한다. 대상 7개:

- `edit.selectParagraph`(문단 선택) · `edit.selectLine`(한줄 선택) · `edit.selectWord`(단어 선택) — 선택(selection) 연산, 본문 무변경.
- `edit.sortDocument`(문서 정렬) · `edit.sortParagraph`(문단 정렬) — 본문 텍스트 재정렬.
- `edit.deleteLine`(한줄 지우기) · `edit.deleteWord`(단어 지우기) — 본문 텍스트 삭제.

### 범위 밖 (DEFER — 이 phase에서 손대지 마라)

- `edit.undo` / `edit.redo` / `edit.cut` / `edit.copy` / `edit.paste` / `edit.pasteOriginal` / `edit.pasteText` — 브라우저 클립보드 권한·편집 히스토리 통합이 필요해 별도 phase다.
  - **중복 확인 결과(기록용):** 우클릭 컨텍스트 메뉴(`ctx.cut/copy/paste`)는 이미 브라우저 기본 동작에 위임돼 있고, `ctx.pasteOriginal`(Alt+V, 클립보드 이미지)은 `pasteOriginalAtCaret`로 동작한다. 그러나 **상단 편집 메뉴의 `edit.*` 붙여넣기 항목은 아직 미결선**이며, 이 phase에서 결선하지 않는다(위 DEFER 유지).
- 파일(file) 메뉴 — 탭 모델과 의미 중복 논의가 필요해 제외.

## 이 step의 목표

`edit.selectWord`/`edit.deleteWord`가 공유할 **단어 경계 계산**과, `edit.selectParagraph`/`edit.sortParagraph`가 공유할 **문단(줄 범위) 계산**을 순수 함수로 신설한다. DOM/transport 비의존 — 문자열/줄 배열만 다룬다(editorCaret.js·editorStats.js와 동일한 순수 계층). 이 step은 결선하지 않는다(헬퍼 + 단위 테스트만).

## 읽어야 할 파일

먼저 아래를 읽고 프로젝트 아키텍처·설계 의도를 파악하라:

- `/CLAUDE.md` — 프로젝트 규칙(DB 비파괴·TDD·conventional commits·UTF-8).
- `/docs/ARCHITECTURE.md` — 프론트 MVC, 순수 view 로직 계층(View는 transport 비의존).
- `/docs/ADR.md` — zero-dep 철학, TDD.
- `/docs/news.md` — L178 편집 메뉴 항목 목록, L165~169 "(끝)" 마커 규칙.
- `web/src/view/editorCaret.js` — **선례**. `lines(text)`(개행 분리), `lineAtOffset(text, caretOffset)`(캐럿 오프셋 → `{lineIndex, start, end}`). 순수 함수 스타일을 그대로 따른다.
- `web/src/view/editorStats.js` — **선례**. `paragraphIndex(linesArr, lineIndex)`(약 32~47행): "문단 = 빈 줄로 분리된 비-빈 줄 그룹" 정의. 이 phase의 문단 정의는 **반드시 이 정의와 동일**해야 한다(두 곳이 어긋나면 상태표시줄 단락번호와 문단 선택/정렬이 불일치).
- `web/src/view/editorContent.js` — `blocksToText(blocks)`(텍스트 블록만 개행으로 이음 — 임베드 제외). 문단/줄 계산의 기준 텍스트가 이 함수 결과임을 이해하라(이 step은 문자열/줄 배열만 받으므로 blocksToText를 직접 부르진 않는다).
- `web/src/view/editorShortcuts.test.js`, `web/src/view/editorCaret.test.js`(있으면) — 순수 함수 단위 테스트 스타일(vitest) 참고.

## 작업 (TDD — 테스트 먼저)

신규 파일 `web/src/view/editorRange.js` 와 `web/src/view/editorRange.test.js` 를 만든다. vitest로 진행한다.

### 시그니처 (구현은 재량, 아래 계약·엣지는 반드시 만족)

```js
// 한 줄 문자열에서 column(0-base, 줄-로컬) 위치의 "단어"(연속 비-공백 \S 런) 경계.
// 반환 { start, end } (줄-로컬 char 오프셋, end 배타적). 단어가 없으면 start === end(빈 범위 = no-op 신호).
export function wordBoundsAt(lineText, column) { ... }

// 줄 배열에서 lineIndex가 속한 "문단"의 줄 인덱스 범위(포함).
// 문단 = 빈 줄로 분리된 비-빈 줄의 연속 그룹(editorStats.paragraphIndex와 동일 정의).
// 반환 { startLine, endLine } (둘 다 포함). lineIndex가 빈 줄이면 그 빈 줄 하나 { startLine:i, endLine:i }.
export function paragraphBoundsAt(linesArr, lineIndex) { ... }
```

### wordBoundsAt 계약 / 엣지

- `column`이 어떤 단어의 내부(양 끝 포함)면 그 단어 전체 범위를 반환한다.
- `column`이 두 단어 사이 공백 위면 **캐럿 왼쪽 단어**(바로 앞 \S 런)를 반환한다. 왼쪽이 공백/줄시작이면 **오른쪽 단어**를 반환한다.
- 줄 전체가 공백/빈 줄이거나 좌우 어느 쪽에도 단어가 없으면 `start === end`(빈 범위)로 no-op 신호를 준다.
- `column`은 `0 <= column <= lineText.length`로 clamp한다(범위 밖 방어).
- 공백은 그대로 둔다(단어만 잡고 주변 공백은 병합/삭제하지 않는다 — 삭제/선택 소비 측이 이 범위만 쓴다).
- 순수·불변: 입력 문자열을 변형하지 않는다.

### paragraphBoundsAt 계약 / 엣지

- `editorStats.paragraphIndex`와 **동일한 문단 정의**(빈 줄 `''` 이 경계, 연속 빈 줄은 경계 1개)를 쓴다.
- `lineIndex`가 비-빈 줄이면, 위/아래로 연속된 비-빈 줄까지 확장한 `{ startLine, endLine }`.
- `lineIndex`가 빈 줄이면 `{ startLine: lineIndex, endLine: lineIndex }`(그 빈 줄 하나 — 소비 측에서 선택은 빈 선택, 정렬은 1개 no-op).
- `lineIndex`가 음수/범위 밖이면 `Math.max/min`으로 clamp한 뒤 계산한다(예외 금지).
- 순수·불변: 입력 배열을 변형하지 않는다.

### 테스트(먼저 작성) — 최소 케이스

- wordBoundsAt: 단어 중간 / 단어 시작 / 단어 끝(오른쪽 공백) / 단어 사이 공백(왼쪽 단어 선택) / 선행 공백 뒤 단어(오른쪽 단어) / 전부 공백(빈 범위) / 빈 문자열(빈 범위) / column clamp.
- paragraphBoundsAt: 단일 문단 / 빈 줄로 나뉜 2문단에서 중간 줄 지정 시 그 문단만 / 빈 줄 지정 시 그 줄만 / 연속 빈 줄 / lineIndex 범위 밖 clamp.
- 한글·혼합 텍스트를 최소 1케이스 포함하라(UTF-8).

## Acceptance Criteria

```bash
npm run test:web    # editorRange 신규 단위 테스트 + 기존 web 회귀 전부 통과 (vitest, web 루트)
npm run build       # vite 프로덕션 빌드 에러 없음
npm run lint        # ESLint 위반 없음
```

모든 신규/수정 텍스트는 UTF-8로 저장하라(한글 포함).

## 검증 절차

1. 위 AC 커맨드를 실행한다.
2. 아키텍처 체크리스트: `editorRange.js`가 순수 함수(DOM/transport 비의존)인가? 문단 정의가 `editorStats.paragraphIndex`와 일치하는가? zero-dep·DB 비파괴를 지켰는가?
3. 결과에 따라 `phases/29-editor-edit-menu/index.json`의 step 0을 업데이트한다:
   - 성공 → `"status": "completed"`, `"summary": "산출물 한 줄 요약"`
   - 수정 3회 후에도 실패 → `"status": "error"`, `"error_message": "구체적 에러"`
   - 사용자 개입 필요 → `"status": "blocked"`, `"blocked_reason": "구체적 사유"` 후 즉시 중단

## 금지사항

- `Editor.jsx`·`WriterPage.jsx`·`editorSelect.js`를 수정하지 마라. 이유: 이 step은 순수 계산 계층만 만든다. 결선/DOM은 step 1·2·4에서 격리 처리한다 — 파일 겹침을 만들면 자가교정 범위가 넓어진다.
- 문단 정의를 `editorStats.paragraphIndex`와 다르게 만들지 마라. 이유: 상태표시줄 단락번호와 문단 선택/정렬이 어긋나 사용자 혼란·회귀가 생긴다.
- DOM(`window.getSelection`/`document`)·`blocksToText`·`serialize`를 이 파일에서 부르지 마라. 이유: 순수·재사용 계층 유지(소비 측이 문자열/줄을 넘긴다). 순수해야 step 2(선택)와 step 3(삭제/정렬) 양쪽에서 안전하게 공유된다.
- 새 npm 의존성을 추가하지 마라(zero-dep).
- 기존 테스트를 깨뜨리지 마라.
