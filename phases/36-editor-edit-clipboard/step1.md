# Step 1: clipboard-dispatch

step0의 `insertPasteTextAtCaret`와 기존 안전 경로들을 **편집 메뉴 클립보드 5종**에 결선한다: 잘라내기·복사(execCommand 재사용) · 붙여넣기·텍스트 붙여넣기(신규 async 핸들러) · 원본 붙여넣기(기존 핸들러 재사용). 이 step은 **`web/src/view/WriterPage.jsx`(+테스트) 한 모듈만** 변경한다.

## 읽어야 할 파일

먼저 아래 파일들을 읽고 설계 의도를 파악하라:

- `docs/ARCHITECTURE.md`, `docs/ADR.md`(ADR-003 — view는 서버 호출만 controller 경유).
- `docs/news.md` L178(우클릭 메뉴 — 잘라내기 Ctrl+X/복사 Ctrl+C/붙여넣기 Ctrl+V/원본 붙여넣기 Alt+V/텍스트 붙여넣기), L182(편집 메뉴 클립보드 항목), L170("(끝)" 뒤 붙여넣기 차단).
- `web/src/view/editorClipboard.js` — **step0 신설.** `insertPasteTextAtCaret(blocks, caret, text) → {blocks, caretLineIndex, changed}`(마커-안전 평문 삽입). (step0 요약이 프롬프트에 함께 전달된다.)
- `web/src/view/WriterPage.jsx` — **변경 대상.** (아래 라인 번호는 대략치 — 반드시 **심볼명으로 grep**해 정확 위치를 확정하라.) 특히:
  - import 블록(L52~69) — `serialize` from `./editorContent.js`, editor 헬퍼들. **여기에 `insertPasteTextAtCaret` import 추가.**
  - `MENU_ENABLED`(L95) — 편집 메뉴 5종 추가 대상.
  - `commitBody`(L303~306)·`lastCaretRef`·`setPendingCaretLine`·`isMapping`·`blocks`.
  - `pasteImageAtCaret(file, caret)`(L949~979, async 업로드→경로 임베드) · `pasteOriginalAtCaret()`(L986~1014, 클립보드 이미지 읽어 pasteImageAtCaret 재사용, clipboard 미지원/권한거부/이미지없음 alert).
  - `ctxEnabledIds`(L788~791) — 우클릭 활성 id(비매핑 분기에 클립보드 항목). `ctxCheckedIds`.
  - `onCtxSelect`(L818~847) — 우클릭 라우팅. **cut/copy/paste가 `document.execCommand`로 위임(L835~843)** — 에디터 포커스 후 execCommand, jsdom 미지원은 try/catch no-op. `ctx.pasteOriginal`→`pasteOriginalAtCaret`(L846). `ctx.pasteText`는 현재 미처리(placeholder).
  - `onMenuSelect` 편집 dispatch 구역(L700~779) — 선택/정렬/지우기/(끝)·(계속)/VIEW_TRANSFORMS. **여기에 클립보드 dispatch 추가.**
- `web/src/view/WriterPage.test.jsx` — 갱신 대상 테스트: **L1420~1430**(활성 항목 외 '되돌리기'·'잘라내기' 비활성 단언 — `잘라내기`=edit.cut이 결선되면 깨짐), **L2766~2774**(우클릭 aux '기업코드변환'/'텍스트 붙여넣기' 비활성 — ctx.pasteText 결선되면 깨짐), **L2776~2784**(우클릭 비매핑 활성 목록), **L2786~2800**(매핑 잘라내기/붙여넣기 비활성). 헬퍼 `openTopMenu`/`focusCaretAtLine`/`rightClickCanvas`/`ctxItem`/`ctxMenu`.

## 배경 (자기완결)

편집 메뉴 5종은 `EditorMenuBar.jsx`에 항목만 있고 `MENU_ENABLED`에 없어 비활성이다. 우클릭 컨텍스트 메뉴는 이미 잘라내기/복사/붙여넣기(execCommand)·원본 붙여넣기(pasteOriginalAtCaret)를 결선했다. 편집 메뉴는 **같은 안전 경로를 재사용**하고, 미구현이던 '텍스트 붙여넣기'만 신규 async 핸들러로 채운다. 메뉴 클릭은 포커스가 빠져 동기 클립보드 접근이 안 되므로 붙여넣기류는 비동기 `navigator.clipboard`를 쓴다(pasteOriginalAtCaret 선례).

## 작업 (TDD — 실패하는 테스트부터 작성한 뒤 구현)

### 1) import + MENU_ENABLED

- `import { insertPasteTextAtCaret } from './editorClipboard.js';`
- `MENU_ENABLED`(L95)에 `'edit.cut', 'edit.copy', 'edit.paste', 'edit.pasteOriginal', 'edit.pasteText'` 추가.

### 2) 공용 execCommand 헬퍼 (잘라내기/복사)

`onCtxSelect`의 cut/copy/paste execCommand 블록(L835~843)을 함수로 추출해 ctx와 메뉴가 공유한다:

```js
// 에디터에 포커스 후 표준 클립보드 커맨드 위임(브라우저 기본 동작). jsdom 미지원 no-op.
const runEditorClipboardCommand = (cmd) => {
  const root = document.querySelector('.yh-editor');
  if (root && typeof root.focus === 'function') root.focus();
  try { if (typeof document.execCommand === 'function') document.execCommand(cmd); } catch { /* jsdom no-op */ }
};
```

`onCtxSelect`의 ctx.cut/copy/paste가 이 헬퍼를 쓰도록 바꾼다(동작 동일 — 리팩터만).

### 3) 신규 async 핸들러 (텍스트 붙여넣기 / 붙여넣기)

```js
// 편집/우클릭 '텍스트 붙여넣기' — 클립보드 평문을 캐럿에 삽입(마커 가드·평문 only, 이미지 무시).
const pasteTextAtCaret = async () => {
  if (isMapping) return;                                   // 매핑=본문-only 불변식
  const clip = typeof navigator !== 'undefined' ? navigator.clipboard : null;
  if (!clip || typeof clip.readText !== 'function') { window.alert('이 브라우저에서는 텍스트 붙여넣기를 지원하지 않습니다. Ctrl+V를 사용하세요.'); return; }
  let text = '';
  try { text = await clip.readText(); }
  catch { window.alert('클립보드 읽기 권한이 거부되어 붙여넣기를 할 수 없습니다.'); return; }
  const r = insertPasteTextAtCaret(blocks, lastCaretRef.current, text);
  if (!r.changed) return;                                  // 빈 클립보드/마커 차단 no-op
  commitBody(serialize(r.blocks));                         // 안전 경로 단일 choke point(제목 재동기화)
  if (typeof r.caretLineIndex === 'number') setPendingCaretLine(r.caretLineIndex);
};

// 편집/우클릭 '붙여넣기' — 클립보드에 이미지면 pasteImageAtCaret(원본 붙여넣기와 동일), 아니면 평문(Ctrl+V 미러).
const pasteAtCaret = async () => {
  if (isMapping) return;
  // 이미지 우선 탐색(pasteOriginalAtCaret의 read()-이미지 루프 재사용/추출) → 있으면 pasteImageAtCaret(file, lastCaretRef.current).
  // 이미지가 없으면 pasteTextAtCaret와 동일 텍스트 경로(readText→insertPasteTextAtCaret).
  // clipboard 미지원/권한거부는 alert(pasteOriginalAtCaret/pasteTextAtCaret와 동일 정책).
};
```

**구현 재량**: `pasteAtCaret`의 이미지 탐색은 `pasteOriginalAtCaret`(L986~1014)의 `clip.read()` 이미지 루프와 동일하다 — 중복을 피하려면 이미지 File을 찾는 순수/헬퍼(`readClipboardImageFile()`)로 추출해 `pasteOriginalAtCaret`와 `pasteAtCaret`가 공유해도 좋다. 텍스트 경로는 `pasteTextAtCaret`와 공유. **DOM 직접 조작 금지 — 본문 반영은 `commitBody(serialize(...))`, 이미지는 `pasteImageAtCaret` 안전 경로만.**

**못박음 — 탭-stale 가드(텍스트 경로)**: `pasteTextAtCaret`/`pasteAtCaret`는 `await clip.readText()/read()` **이후** 렌더 클로저의 `blocks`/`lastCaretRef.current`로 `insertPasteTextAtCaret`→`commitBody`를 수행한다. `await` 사이 탭이 전환되면 다른 기사 본문에 쓰일 수 있다(과거 phase 20/29/31/32의 탭-전환 stale-write 계열). 클립보드 읽기는 네트워크 없이 즉시 resolve돼 실무 창이 극히 좁지만, **이미지 경로(`pasteImageAtCaret` L949~979: 시작 시 `tabId` 캡처 → 쓰기 전 `activeTabRef`와 동일할 때만 반영)와 동일한 탭 고정 가드를 텍스트 커밋에도 적용**하라(await 전 tabId 캡처, commit 직전 `activeTabRef.current === tabId` 재확인, 다르면 폐기). 회귀 테스트 1건(await 사이 탭 전환 시 원 탭에만 반영/타 탭 불변)을 포함하라.

### 4) onMenuSelect 편집 dispatch (편집 구역 L700~779에 추가)

```js
if (id === 'edit.cut') { if (!isMapping) runEditorClipboardCommand('cut'); return; }
if (id === 'edit.copy') { if (!isMapping) runEditorClipboardCommand('copy'); return; }
if (id === 'edit.paste') { pasteAtCaret(); return; }        // 내부 isMapping 가드
if (id === 'edit.pasteText') { pasteTextAtCaret(); return; }// 내부 isMapping 가드
if (id === 'edit.pasteOriginal') { pasteOriginalAtCaret(); return; } // 기존 핸들러(내부에 매핑 가드 없음 → 여기서 감쌀지 판단)
```

**못박음 — 매핑 가드**: 잘라내기/붙여넣기/텍스트·원본 붙여넣기는 본문 변경이므로 매핑에서 **반드시 no-op**. 복사도 매핑에서 no-op(기존 ctxEnabledIds가 매핑서 복사까지 비활성화한 것과 일관 — L790). `edit.pasteOriginal`은 기존 `pasteOriginalAtCaret`에 자체 매핑 가드가 없으므로 호출부에서 `if (!isMapping)`로 감싼다(ctx.pasteOriginal이 enabledIds로만 막던 것과 달리 메뉴는 정적이므로 핸들러 가드 필수).

### 5) 우클릭 ctx.pasteText 활성화

- `ctxEnabledIds`(L788~791)의 **비매핑 분기**에 `'ctx.pasteText'` 추가(잘라내기/복사/붙여넣기/원본과 함께 — 매핑에선 비활성).
- `onCtxSelect`에 `case 'ctx.pasteText': pasteTextAtCaret(); break;` 추가.

### 6) 기존 테스트 갱신 (WriterPage.test.jsx)

**먼저 방어적으로 전수 확인하라** — 구현 전에 `잘라내기` + `toBeDisabled`(편집 메뉴 비활성 단언)와 `텍스트 붙여넣기` + `toBeDisabled`(ctx 비활성 단언)를 **grep으로 모두 찾아** 아래 목록 외 누락이 없는지 확인한다(near-duplicate 테스트가 여럿 있다). `edit.cut`/`ctx.pasteText` 결선 시 이 단언들이 거짓이 되어 `test:web`(AC)이 깨진다.

편집 메뉴 '잘라내기'(edit.cut) 비활성 단언 — **결선 후 모두 미결선 id로 교체**(비활성 예시는 `'되돌리기'`(edit.undo)·`'다시실행'`(edit.redo)로, undo/redo는 이 phase 후에도 미결선 유지):
- **L1420~1430** `it('활성 항목 외(되돌리기·잘라내기)는 여전히 비활성이다')` — `잘라내기`→`다시실행`, 주석 근거 갱신.
- **L2482~2489** `it('활성 항목 외(잘라내기·되돌리기)는 여전히 비활성이다(회귀)')` — L1420과 어순만 다른 **near-duplicate**. 동일 교체.
- **L4948~4960** `it("편집 메뉴 '문서 정렬'/… 기존 항목 상태는 불변이다")` — L4959 `editMenuItem('잘라내기')…toBeDisabled()`(`editMenuItem`=within(menu-편집)). 동일 교체.

우클릭 ctx 클립보드:
- **L2766~2774**: aux 비활성 루프에서 `'텍스트 붙여넣기'` 제거 → **`'기업코드변환'`만** 잔존(ctx.pasteText 결선됨).
- **L2776~2784**: 우클릭 비매핑 활성 목록에 `'텍스트 붙여넣기'` 추가.
- **L2786~2800**: 매핑 비활성 단언은 유지(잘라내기/붙여넣기). 원하면 '텍스트 붙여넣기'도 매핑 비활성 단언에 추가(일관).

(라인 번호는 대략치다 — 반드시 **심볼/문자열 grep**으로 정확 위치를 확정하고, 위에 없는 추가 비활성 단언이 있으면 같은 원칙으로 함께 갱신하라.)

### 7) 신규 테스트

- 편집 메뉴 '잘라내기'/'복사' 클릭 → `document.execCommand` 호출됨(spy)·에디터 focus. 매핑 모드 → execCommand 미호출.
- 편집 메뉴 '텍스트 붙여넣기' 클릭 → `navigator.clipboard.readText` 모킹 값이 캐럿 줄에 삽입(본문 커밋 확인)·다중 줄 분할·임베드 보존. 매핑 no-op. 마커 뒤 캐럿 no-op. 미지원/거부 alert.
- 편집 메뉴 '붙여넣기' 클릭 → 클립보드 이미지 모킹이면 업로드 경로 임베드, 텍스트면 텍스트 삽입.
- 편집 메뉴 '원본 붙여넣기'가 활성이고 클릭 시 pasteOriginal 경로(기존 테스트 있으면 재사용).

**테스트 팁**: `navigator.clipboard`는 `vi.stubGlobal`/`Object.defineProperty`로 `readText`/`read` 모킹(pasteOriginalAtCaret 기존 테스트가 있으면 그 모킹 패턴 재사용). `document.execCommand`는 `vi.fn()`으로 스텁.

## Acceptance Criteria

```bash
npm run lint
npm run build
npm run test:web
```

(백엔드 무관 — `npm test` 불필요.)

## 검증 절차

1. 위 AC 커맨드를 실행한다.
2. 아키텍처 체크리스트:
   - 변경이 `web/src/view/WriterPage.jsx`(+테스트)에 국한되는가? editorClipboard.js·Editor.jsx가 diff에 없는가?
   - 본문 반영이 `commitBody(serialize(...))` 단일 경로만 지나는가? DOM 직접 조작이 없는가?(이미지=pasteImageAtCaret, 텍스트=insertPasteTextAtCaret)
   - 매핑 모드에서 5종 전부 본문/DOM을 바꾸지 않는가?
   - 갱신한 기존 테스트가 그린이고, 우클릭 클립보드 기존 동작이 회귀 없는가?
   - ADR-003(서버 호출 미추가)·CLAUDE.md(DB 무관·client 전용·UTF-8)?
3. 결과에 따라 `phases/36-editor-edit-clipboard/index.json`의 step1을 업데이트한다:
   - 성공 → `"status": "completed"`, `"summary"`에 (MENU_ENABLED 5종·runEditorClipboardCommand 공유·pasteTextAtCaret/pasteAtCaret·ctx.pasteText 활성·매핑 가드·갱신 테스트·신규 테스트)를 한 줄 요약. **phase 마지막 step이므로 phase 전체 산출물을 요약에 담아라.**
   - 3회 수정 후에도 실패 → `"status": "error"`, `"error_message"`.
   - 사용자 개입 필요 → `"status": "blocked"`, `"blocked_reason"` 후 즉시 중단.
4. top-level `phases/index.json`의 36 항목 상태는 execute.py가 관리한다(직접 건드리지 마라).

## 금지사항

- 붙여넣기류에서 contentEditable/DOM을 직접 조작하지 마라. 이유: 본문 반영은 `commitBody(serialize(...))` 단일 choke point(제목 재동기화·마커 무결성)여야 하고, 이미지·텍스트는 검증된 안전 경로(pasteImageAtCaret/insertPasteTextAtCaret)만 쓴다.
- 매핑 가드를 빼지 마라. 이유: 매핑(편집 진입)은 본문-only 불변식 — 잘라내기/붙여넣기류가 잠긴 기사 본문을 바꾸면 데이터 무결성이 깨진다. `edit.pasteOriginal`은 기존 핸들러에 가드가 없으니 호출부에서 감싸라.
- `insertPasteTextAtCaret`(step0)의 마커 가드를 우회하는 별도 삽입 경로를 만들지 마라. 이유: "(끝)" 뒤 붙여넣기 차단(news.md L170)은 단일 출처로 강제한다.
- undo/redo·기업코드변환을 이 phase에서 결선하지 마라. 이유: 범위 밖(별도 phase) — undo/redo는 히스토리 스택 신설이 필요하고, 여기 섞으면 scope가 넘친다.
- 갱신 대상 기존 테스트를 일부만 고치고 나머지를 방치해 깨진 채 두지 마라. 이유: `edit.cut` 비활성 단언은 **최소 3곳**(L1420·L2482·L4948 — near-duplicate 포함), `ctx.pasteText` 비활성 단언은 L2766에 있어 결선 시 전부 거짓이 된다. §6대로 `잘라내기`+`toBeDisabled`/`텍스트 붙여넣기`+`toBeDisabled`를 grep 전수 확인해 **빠짐없이** 미결선 id(edit.undo/edit.redo)로 교체하고, AC(`test:web`)가 그린인지 확인하라.
- 기존 테스트를 깨뜨리지 마라.
