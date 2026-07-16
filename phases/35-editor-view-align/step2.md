# Step 2: writer-dispatch

step0(모델·`setLineAlign`)과 step1(에디터 렌더·라운드트립)을 **보기 메뉴에 결선**한다. 정렬 4종을 활성화하고, 클릭 시 마지막 캐럿 줄에 정렬을 적용한다 — 대소문자 변환(`VIEW_TRANSFORMS`)과 **동형 dispatch**. 이 step은 **`web/src/view/WriterPage.jsx` 한 모듈만** 변경한다.

## 읽어야 할 파일

먼저 아래 파일들을 읽고 설계 의도를 파악하라:

- `docs/ARCHITECTURE.md`, `docs/ADR.md`(ADR-003 — view는 서버 호출만 controller 경유).
- `docs/news.md` L183(보기 메뉴 항목), L165·L175(본문 임베딩/블록 순서 보존), L250~252(매핑 = 편집 진입 시 본문/필드 로드).
- `web/src/view/editorAlign.js` — **step0에서 추가된** `ALIGN_BY_MENU`(메뉴 id→정렬값)·`setLineAlign(blocks, textLineIndex, align) → {blocks, changed}`. (step0 요약이 프롬프트에 함께 전달된다.)
- `web/src/view/WriterPage.jsx` — **이 step에서 변경할 대상.** 특히:
  - import 블록(L52~69) — `transformTextLine` 등 editor 헬퍼, `serialize` from `./editorContent.js`, writerBody 헬퍼. **여기에 `editorAlign` import를 추가**한다.
  - `MENU_ENABLED`(L95) — EditorMenuBar에 넘기는 활성 id 배열. **여기에 정렬 4종 id를 추가**한다.
  - `VIEW_TRANSFORMS`(L97~102) — 보기 대소문자 id→변환함수 맵.
  - `commitBody(nextBody)`(L303~306) — `updateField('body', ...)` + `updateField('title', bodyTitle(...))` 단일 경로(제목 재동기화). 매핑 모드에선 컨트롤러가 title/body 쓰기를 거부.
  - `lastCaretRef`·`setPendingCaretLine` — 마지막 캐럿 텍스트-줄 소스와 remount 후 캐럿 복원 지정.
  - `isMapping` — 편집 진입(매핑) 모드 여부. `insertDate`(L341~349)·`onGlyphPick`(L330~336)·`convertAbbrev`·`applySimpTrad` 등 **본문 변경 도구가 전부 `if (isMapping) return` 가드**를 둔다.
  - `onMenuSelect` 상단 메뉴 라우팅 — 특히 보기 변환 dispatch(L771~778): `const fn = VIEW_TRANSFORMS[id]; if (!fn) return; const caretLine = lastCaretRef.current ? lastCaretRef.current.lineIndex : null; if (caretLine == null) return; const r = transformTextLine(blocks, caretLine, fn); commitBody(serialize(r.blocks)); setPendingCaretLine(caretLine);`.
- `web/src/view/WriterPage.test.jsx` — L1~40(`setup`/`openTopMenu` 헬퍼), 보기 대소문자 변환 테스트 블록(있으면 동형 템플릿으로 삼아라), 매핑 모드 렌더 헬퍼.

## 배경 (자기완결)

`view.justify`/`view.alignLeft`/`view.alignCenter`/`view.alignRight`는 `EditorMenuBar.jsx`에 이미 항목으로 존재하지만 `MENU_ENABLED`에 없어 **비활성**이다. 대소문자 변환은 `lastCaretRef`의 줄에 `transformTextLine`을 적용하고 `commitBody`로 반영 후 `setPendingCaretLine`으로 같은 줄에 캐럿을 되돌린다. 정렬도 **같은 캐럿 소스·같은 반영 경로**를 쓰되, `transformTextLine`(텍스트 내용 변경) 대신 `setLineAlign`(정렬 필드 설정)을 쓴다.

## 작업 (TDD — 실패하는 테스트부터 작성한 뒤 구현)

### 1) import 추가 (L52~69 근처)

```js
import { ALIGN_BY_MENU, setLineAlign } from './editorAlign.js';
```

### 2) `MENU_ENABLED`(L95)에 정렬 4종 추가

배열에 `'view.justify', 'view.alignLeft', 'view.alignCenter', 'view.alignRight'`를 더한다(순서는 무관, 보기 항목들 근처 권장).

### 3) `onMenuSelect`에 정렬 dispatch 추가 — `VIEW_TRANSFORMS` 조회 **앞에**

L771 `const fn = VIEW_TRANSFORMS[id];` **바로 위**에 아래 분기를 넣는다(정렬 id는 `VIEW_TRANSFORMS`에 없어 `if (!fn) return`에 먼저 걸려버리므로, 반드시 그 앞에서 처리):

```js
const alignValue = ALIGN_BY_MENU[id];
if (alignValue) {
  if (isMapping) return;                       // 매핑=본문-only 불변식(insertDate/glyph/abbrev 동일 가드)
  const caretLine = lastCaretRef.current ? lastCaretRef.current.lineIndex : null;
  if (caretLine == null) return;               // 캐럿 없으면 no-op(대소문자 변환과 동일)
  const r = setLineAlign(blocks, caretLine, alignValue);
  if (!r.changed) return;                      // 동일값/범위밖 → no-op(불필요 dirty 방지)
  commitBody(serialize(r.blocks));
  setPendingCaretLine(caretLine);              // 같은 줄 유지(대소문자 변환과 동일)
  return;
}
```

### 테스트 — `web/src/view/WriterPage.test.jsx`

보기 대소문자 변환 테스트를 동형 템플릿으로 신규 describe를 추가한다:

- 캐럿을 텍스트 줄 N에 둔 상태(테스트 헬퍼로 `lastCaretRef` 경로를 태움 — 기존 대소문자/약물 테스트가 캐럿을 세팅하는 방식을 그대로 사용)에서 `openTopMenu('보기')` → '가운데로 정렬' 클릭 → 본문(`updateField('body', ...)`로 커밋된 markupVersion 또는 에디터 DOM `.yh-editor__line[data-align]`)에서 **줄 N만 align='center'**, 다른 줄·임베드 무변경.
- 4종 각각 매핑: 양쪽→justify, 왼쪽→left, 가운데→center, 오른쪽→right.
- **매핑 모드**: 편집 진입(매핑) 렌더에서 정렬 클릭 → 본문 무변경(no-op).
- **캐럿 없음**: 캐럿 미설정 상태에서 정렬 클릭 → 본문 무변경(no-op).
- 이미 그 정렬인 줄에 같은 정렬 재클릭 → 커밋 없음(no-op).

## Acceptance Criteria

```bash
npm run lint
npm run build
npm run test:web
```

(백엔드 무관 — `npm test`는 실행 불필요.)

## 검증 절차

1. 위 AC 커맨드를 실행한다.
2. 아키텍처 체크리스트:
   - 변경이 `web/src/view/WriterPage.jsx`(+테스트)에 국한되는가? editorAlign.js·Editor.jsx·editorContent.js가 diff에 없는가?(그 계약은 step0/1 산출물 — 재수정 금지)
   - 본문 반영이 `commitBody(serialize(...))` **단일 경로**만 지나는가?(제목 재동기화 불변식 — DOM/Editor 직접 조작 없음)
   - 기존 보기 대소문자·(끝)삽입·약물·매핑 테스트가 그린인가?
   - ADR-003(서버 호출 미추가)·CLAUDE.md(DB 무관·client 전용·UTF-8)?
3. 결과에 따라 `phases/35-editor-view-align/index.json`의 step2를 업데이트한다:
   - 성공 → `"status": "completed"`, `"summary"`에 (MENU_ENABLED 4종·onMenuSelect align dispatch·isMapping/캐럿/changed 가드·setPendingCaretLine·추가 테스트)를 한 줄 요약.
   - 3회 수정 후에도 실패 → `"status": "error"`, `"error_message"`.
   - 사용자 개입 필요 → `"status": "blocked"`, `"blocked_reason"` 후 즉시 중단.
4. top-level `phases/index.json`의 35 항목 상태는 execute.py가 관리한다(직접 건드리지 마라).

## 금지사항

- 정렬 dispatch를 `const fn = VIEW_TRANSFORMS[id]; if (!fn) return;` **뒤에** 두지 마라. 이유: 정렬 id는 `VIEW_TRANSFORMS`에 없어 `if (!fn) return`에서 조기 반환돼 절대 도달하지 못한다.
- `isMapping` 가드를 빼지 마라. 이유: 매핑(편집 진입)은 본문-only 불변식 — 정렬은 본문 블록 변경이므로 insertDate/glyph/abbrev와 동일하게 매핑에서 차단해야 잠긴 기사 본문을 오염시키지 않는다.
- `commitBody`를 우회해 `updateField('body', ...)`만 호출하거나 DOM을 직접 조작하지 마라. 이유: 제목 재동기화(제목 stale 방지)·직렬화 안전 경로가 단일 choke point여야 한다.
- `setLineAlign`이 `changed:false`인데 `commitBody`를 호출하지 마라. 이유: 불필요한 dirty/재렌더를 만든다.
- editorAlign.js/Editor.jsx/editorContent.js를 이 step에서 수정하지 마라. 이유: 이 step은 결선(controller) 레이어만 — 모델/에디터 계약은 step0/1에서 확정됐다.
- 기존 테스트를 깨뜨리지 마라.
