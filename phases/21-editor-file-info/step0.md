# Step 0: file-info-stats-dialog — 통계 순수 함수 보강 + 파일 정보 다이얼로그 컴포넌트

## 배경 / 요구사항

도구 메뉴 **'파일 정보'**(`tools.fileInfo`, label '파일 정보' — news.md L180)는 현재 `web/src/view/EditorMenuBar.jsx`에 **disabled placeholder로 실존**하나 결선돼 있지 않다. 이 phase의 목표는 이를 결선해, 현재 기사 본문의 **통계를 보여주는 읽기전용 다이얼로그**를 띄우는 것이다. news.md에는 도구 메뉴 목록에 한 줄만 있고 세부 동작 명세는 없으므로 — 합리적 통계 항목은 구현자 재량으로 결정하되 **이미 존재하는 순수 통계 함수(`editorStats.js`)를 우선 재사용**한다.

이 step은 두 가지를 만든다(둘 다 순수, DOM 비의존, 결선은 Step 1):
1. **`editorStats.js` 보강** — 표시할 통계 중 기존에 없는 항목(글자수·줄 수)을 **순수 함수로 최소 추가**한다.
2. **`web/src/view/FileInfoDialog.jsx`** — 통계를 **props로만** 받아 표시하는 **읽기전용** 다이얼로그 컴포넌트(입력 폼·onSubmit 없음).

**표시할 통계(최종 6항목)** — Step 1이 본문에서 계산해 props로 주입한다:
- **글자수**(`charCount`, 개행 제외) — editorStats **신규**
- **단어수**(`wordCount`) — editorStats 기존 재사용
- **UTF-8 바이트**(`byteLength`) — editorStats 기존 재사용
- **줄 수**(`lineCount`) — editorStats **신규**
- **캐럿 위치**(`caretPosition` → 단락/행/열) — editorStats 기존 재사용
- **임베드 개수** — 블록 레벨 수치라 editorStats(텍스트 입력) 대상이 아니다. **Step 1이 `blocks.filter(isEmbedBlock).length`로 계산해 숫자 prop으로 주입**한다(이 step은 그 숫자를 표시만).

> 과한 통계 금지 — 위 6항목으로 한정한다. 새 통계 함수는 `charCount`·`lineCount` **두 개만** 추가한다.

## 읽어야 할 파일

- `/CLAUDE.md`, `/docs/ARCHITECTURE.md` — 프론트 MVC(View=순수), 명령어(`npm run test`/`build`/`lint`).
- `/docs/ADR.md` — **ADR-003**(순수 표시 컴포넌트, transport 비의존, props 주입).
- `/docs/news.md` — L180(도구 메뉴 '파일 정보').
- `web/src/view/editorStats.js` — **실측 기준**: 이미 `wordCount(text)`·`byteLength(text)`·`caretPosition(text, caret)`를 export(모두 순수, 입력은 text 문자열 + caret). 신규 `charCount`/`lineCount`도 **동일한 "text 문자열 입력" 시그니처**로 추가한다. `lines(text)`는 `./editorCaret.js`에서 import해 재사용한다(이미 caretPosition이 사용 중).
- `web/src/view/editorStats.test.js` — **테스트 컨벤션**(describe/it, 한글 케이스명, null/undefined·빈 문자열·개행 경계 단언). 신규 함수 테스트를 같은 스타일로 추가한다.
- `web/src/view/editorCaret.js` — `lines(text)`(개행 split) 시그니처 확인(줄 수 계산 기준).
- `web/src/view/GlyphInputDialog.jsx` — **다이얼로그 직접 템플릿**: `open` false→`null`, `role="dialog"`+`aria-label`, 전용 className(`yh-glyph-input`)·testid(`glyph-input`), Esc 닫기(`handleKeyDown`), 닫기 버튼(`onClose`). **단 이 컴포넌트는 읽기전용** — favorites/keymap 입력·`onPick`·onSubmit 같은 입력 콜백은 두지 않고 통계 표시만 한다.
- `web/src/view/GlyphInputDialog.test.jsx` — 다이얼로그 테스트 컨벤션(open 토글로 null, `getByRole('dialog', { name })`, Esc/닫기 콜백 mock, 미전달 콜백 graceful).
- `web/src/view/UrlEmbedDialog.jsx` — 또 다른 다이얼로그 패턴 참고(전용 className/testid 분리 규칙). **단 입력 필드/onSubmit은 읽기전용이라 가져오지 않는다.**
- `web/src/index.css` 또는 `web/src/styles/yonhap.css`(`yh-glyph-input`/`yh-url-embed` 스타일이 정의된 CSS 파일) — 다이얼로그 스타일 추가 위치.

## 작업

TDD로 진행한다(vitest). **테스트 먼저** 작성하고 통과하는 구현을 만든다.

### 1) editorStats.js — 순수 함수 2개 추가 (테스트 먼저)

`web/src/view/editorStats.test.js`에 케이스를 추가한 뒤 `web/src/view/editorStats.js`에 구현한다. 기존 export(`wordCount`/`byteLength`/`caretPosition`)는 **건드리지 않는다**.

```js
// 개행을 제외한 글자 수(코드포인트 기준이면 [...text].length, 단순 길이면 String.length — 택1하되 주석으로 명시).
// 개행 문자('\n')는 글자로 세지 않는다. null/undefined → 0.
export function charCount(text) { ... }

// 줄 수 — lines(text).length 기준(빈 문자열도 1줄). null/undefined → lines('')와 동일(1).
export function lineCount(text) { ... }
```

요구사항:
- 두 함수 모두 **순수**(DOM/`Date`/`window`/`document` 비의존). 입력은 text 문자열 하나.
- `charCount`: 개행(`\n`)은 제외하고 센다(예: `'가\n나'` → 2). `null`/`undefined`/`''` → 0. 코드포인트 처리 방식(이모지·서러게이트)은 구현자 재량이되 주석으로 명시.
- `lineCount`: `lines(text).length`(editorCaret의 `lines`로 split한 결과 길이). `''` → 1(`['']`), `'가\n나'` → 2, `null`/`undefined` → 1. 빈 문자열도 1줄로 센다는 점을 주석으로 명시.

### 2) FileInfoDialog.jsx — 읽기전용 표시 다이얼로그 (테스트 먼저)

`web/src/view/FileInfoDialog.test.jsx`를 먼저 작성하고 통과하는 `web/src/view/FileInfoDialog.jsx`를 만든다.

```jsx
// 파일 정보 다이얼로그 — 순수 표시(읽기전용) 컴포넌트(ADR-003).
// 현재 기사 본문의 통계를 props로만 받아 표시한다. 입력 폼·onSubmit 없음(읽기전용).
// 통계 계산(editorStats/blocks)은 부모(Step 1 WriterPage)가 열 때 수행해 props로 주입한다.
// model/fetch/localStorage/window/document·editorStats import 없음(계산을 여기서 하지 않는다).
export function FileInfoDialog({
  open,
  stats,        // { chars, words, bytes, lines, embeds, paragraph, row, column } — 부모가 계산해 주입
  onClose,      // () => void
}) { ... }
```

요구사항:
- `open`이 false면 `null` 반환.
- `role="dialog"`, `aria-label`(예 '파일 정보'), **전용 className(예 `yh-file-info`)·전용 testid(예 `file-info`)**. 기존 `yh-glyph-input`/`yh-url-embed`/`yh-find-replace`/`yh-editor-glyphbar`와 충돌 금지.
- 각 통계 항목을 라벨+값 행으로 표시한다. 각 값에 **전용 testid**를 부여한다(예 `file-info-chars`·`file-info-words`·`file-info-bytes`·`file-info-lines`·`file-info-embeds`·`file-info-caret`). 캐럿은 `{paragraph}단락 {row}행 {column}열` 형태(StatusBar 표기와 일치 — `web/src/view/StatusBar.jsx` 참조).
- `stats`가 `undefined`/누락 필드여도 예외 없이 렌더(누락 값은 `0` 또는 빈값으로 안전 폴백 — 구현자 재량, 주석 명시). 이유: 부모가 통계 미주입 상태로 열어도 죽지 않게.
- **'닫기' 버튼**(예 testid `file-info-close`) + **Esc** → `onClose`. `onClose` 미전달 시 가드.
- **입력 폼·`onSubmit`·`onPick` 같은 입력 콜백을 두지 마라**(읽기전용). 본문/캐럿을 바꾸는 어떤 콜백도 없다.
- CSS: `yh-file-info` 떠있는 패널 스타일을 `yh-glyph-input`/`yh-url-embed` 인근에 추가한다. 기존 스타일을 깨지 않는다.

## 핵심 규칙 (반드시 준수 — 위반 시 반려)

1. **순수성(ADR-003)**: `editorStats`의 신규 2함수와 `FileInfoDialog` 모두 model/fetch/transport/localStorage/`window`/`document`/`Date` 호출 금지. `FileInfoDialog`는 통계를 **props로만** 받고 내부에서 계산하지 않는다(editorStats import 금지). 이유: 계층 분리·테스트 가능성·비결정성 제거.
2. **읽기전용**: `FileInfoDialog`는 본문/캐럿/임베드를 변경하는 콜백을 두지 않는다(`onClose`만). 입력 `<input>`/`<textarea>`·`onSubmit`·`onPick` 금지. 이유: 파일 정보는 표시 전용 — 본문 무변경(매핑 모드에서도 안전).
3. **기존 editorStats export 불변**: `wordCount`/`byteLength`/`caretPosition`의 시그니처·동작을 바꾸지 마라(StatusBar가 의존). additive로만 추가한다. 이유: 회귀 방지.
4. **전용 className/testid**: `yh-file-info`/`file-info`(또는 동급 전용 이름). 약물입력(`yh-glyph-input`)·URL임베드(`yh-url-embed`)·찾기(`yh-find-replace`)·약물바(`yh-editor-glyphbar`)와 겹치지 마라. 이유: 회귀·스타일 충돌 방지.
5. **임베드 개수는 props 숫자**: `FileInfoDialog`는 `blocks`/`isEmbedBlock`을 import하지 않는다 — 임베드 개수는 부모가 계산한 `stats.embeds` 숫자를 표시만 한다. 이유: Scope 최소화 — 블록 의존은 결선 레이어(Step 1).

## Acceptance Criteria

```bash
cd web && npm run test -- editorStats     # 신규 charCount/lineCount 케이스 통과
cd web && npm run test -- FileInfoDialog   # 신규 FileInfoDialog.test.jsx 통과
cd .. && npm run test:web                   # web 전체 회귀 통과
npm run build
npm run lint
```

추가 단언(vitest):

`editorStats.test.js`:
- `charCount('가\n나')` 가 2(개행 제외). `charCount('')`·`charCount(null)`·`charCount(undefined)` 가 0.
- `charCount('abc')` 가 3.
- `lineCount('')` 가 1. `lineCount('가\n나')` 가 2. `lineCount('가\n\n다')` 가 3. `lineCount(null)`·`lineCount(undefined)` 가 1.

`FileInfoDialog.test.jsx`:
- `open={false}`면 아무것도 렌더되지 않는다(container.firstChild === null).
- `open` + 통계 props 주입 시 `role="dialog"`('파일 정보')와 testid `file-info`가 보인다.
- 주입한 통계가 각 testid에 표시된다(예 `file-info-chars`=글자수, `file-info-words`=단어수, `file-info-bytes`=바이트, `file-info-lines`=줄수, `file-info-embeds`=임베드수, `file-info-caret`=`{paragraph}단락 {row}행 {column}열`).
- `stats` 미주입/일부 누락이어도 예외 없이 렌더된다(안전 폴백).
- '닫기' 버튼 클릭 시 `onClose` 호출. Esc 키에서도 `onClose` 호출.
- `onClose` 미전달 시 닫기/Esc가 예외를 던지지 않는다.
- 입력 폼이 없다(읽기전용) — `<input>`/`<textarea>`가 다이얼로그 안에 없음을 단언(예 `container.querySelector('input')` 가 null).

## 검증 절차

1. 위 AC 커맨드를 실행한다(필요 시 환경변수 `PYTHONUTF8=1` 또는 UTF-8 콘솔).
2. 아키텍처 체크리스트: editorStats 신규 함수 순수성(text-in, DOM/Date 없음)·기존 export 불변, FileInfoDialog 읽기전용(입력/onSubmit 없음)·editorStats/blocks 미import·전용 className/testid.
3. 결과에 따라 `phases/21-editor-file-info/index.json`의 step 0을 갱신(completed+summary / error / blocked).

## 금지사항

- `FileInfoDialog`에서 `editorStats`(wordCount/byteLength/caretPosition/charCount/lineCount)나 `editorContent`(blocks/isEmbedBlock)를 import·호출하지 마라. 이유: 통계 계산은 결선 레이어(Step 1) — 이 컴포넌트는 props 표시만(ADR-003 순수성·Scope 최소화).
- `FileInfoDialog`에 입력 `<input>`/`<textarea>`·`onSubmit`·`onPick`·본문 변경 콜백을 넣지 마라. 이유: 파일 정보는 읽기전용 — 본문/캐럿 무변경.
- `editorStats`의 기존 export(`wordCount`/`byteLength`/`caretPosition`) 시그니처·동작을 바꾸지 마라. 이유: StatusBar가 의존(회귀).
- 새 통계 함수를 `charCount`/`lineCount` 외에 더 추가하지 마라(과한 통계). 이유: 명세 없음 — 합리적 최소 항목으로 한정.
- 약물입력/URL임베드/찾기/약물바와 같은 className/testid를 재사용하지 마라. 이유: 회귀·스타일 충돌.
- model/fetch/localStorage/`window`/`document`/`Date`를 호출하지 마라(양쪽 산출물 모두). 이유: ADR-003 순수성·비결정성 제거(테스트 가능).
- `Editor.jsx`·`WriterPage.jsx`·`StatusBar.jsx`·`EditorMenuBar.jsx`·`server/`를 수정하지 마라(이 step은 editorStats 보강 + 신규 컴포넌트 + 테스트 + CSS만). 이유: 결선은 Step 1.
