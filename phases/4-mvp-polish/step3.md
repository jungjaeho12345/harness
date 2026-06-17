# Step 3: writer-editor-ux

작성 화면(`WriterPage`)의 레이아웃·문서 탭 디자인과 본문 에디터(`Editor`)의 입력 안정성·붙여넣기·공통정보/파일첨부를 한꺼번에 정리하는 step이다. 다섯 갈래로 묶인다: (A) 송고/보류 제목 가드 + Ctrl+V 이미지 붙여넣기(200×200) + 공통정보 확장 필드/파일 업로드, (B) 작성 화면 2열 레이아웃·문서 탭 스타일, (C) 타이핑 캐럿 튐·Ctrl+D 크래시(화면 하얘짐) 수정, (D) Ctrl+D 북마크 차단 + 이미지 붙여넣기 커서 위치 보존, (E) Ctrl+D 라인삭제 후 편집 포커스/캐럿 복원.

## 읽어야 할 파일

먼저 아래 파일들을 읽고 프로젝트의 아키텍처와 설계 의도를 파악하라:

- `/docs/ADR.md` — ADR-003(View는 Controller/Model 경유, 직접 fetch 금지), ADR-004(권한/잠금은 서버 강제), ADR-006(얇은 transport·세션에서만 신원 도출). 외부 npm 의존 추가 금지(최소 의존성) 원칙.
- `/docs/news.md` — line 49(공통정보 필드: 공동작성/지역/속성/키워드/내부·외부코멘트/첨부파일/자료파일), line 156·167(임베드는 커서 위치에 삽입·위치 보존), line 159(`"(끝)"`은 항상 최종 블록), line 162·168(`"(끝)"` 뒤 입력 차단·IME 조합 중 재색칠 금지).
- `/docs/SCHEMA.md` — `Contents.attachmentFile` / `referenceFile`(VARCHAR — path 문자열 보관).
- `/web/src/view/Editor.jsx` — **이 step의 핵심 수정 파일.** contentEditable 본문 에디터. `handleInput`/`handleCompositionEnd`/`handleBlur`/`handlePaste`/`handleKeyDown`, `readEditorText`/`readCaret`, IME `composingRef`, `editorColoring`(제목 파랑/부제 빨강/본문 검정/`"(끝)"` 골드).
- `/web/src/view/WriterPage.jsx` — 탭 스트립·좌 에디터/우 메타 2열·`CommonInfo`·`onAction`(송고/보류 가드)·`onKeyDown`(Alt+Y/Ctrl+D/라인삭제)·`onTextChange`·임베드 추가(`insertEmbed`).
- `/web/src/view/writerBody.js` — `bodyTitle`/`appendEmbedToBody`(+이 step에서 추가할 `serializeBodyFromBlocks`/`insertEmbedIntoBody`).
- `/web/src/view/InlineEmbed.jsx` — 임베드 figure 렌더(scheme allowlist·no-referrer 유지).
- `/web/src/model/httpModel.js`·`/web/src/model/contract.js` — Model 계약(`MODEL_KEYS`)·HTTP 어댑터. 신규 `uploadFile` 키.
- `/web/src/controller/useWriteController.js` — `EDITABLE_FIELDS`/`tabFromArticle`/`tabFromSource`/`blankTab`/`toSaveDto`.
- `/server/index.js` — 라우트 핸들러(세션 게이트 `sessionOf`·`UNAUTH`). 신규 `POST /api/upload`.
- `/web/src/styles/yonhap.css` — 작성 화면/탭 스타일.

이전에 만들어진 코드를 꼼꼼히 읽고 설계 의도를 이해한 뒤 작업하라.

## 작업

TDD: **테스트를 먼저 작성**한 뒤 통과하는 구현을 작성한다. 모든 텍스트는 UTF-8.

**[A] 제목 가드 + 이미지 붙여넣기 + 공통정보/파일 업로드 (`dbf1339`)**
- `WriterPage.onAction`의 송고/보류 제목 가드를 `bodyTitle(body)` 단독에서 `bodyTitle(body) || (activeTab.fields.title || '').trim()`로 바꾼다 — 제목 FIELD만 있고 본문 첫 줄이 비어도 송고/보류가 진행돼야 한다(기존엔 둘 다 본문 첫 줄만 봐서 차단됐다). 송고 전용 `"(끝)"` 가드는 유지.
- `Editor.handlePaste`에서 클립보드 이미지 item → `FileReader` data URL → `embedFromPaste` → `onPasteEmbed`로 결선. 일반 텍스트 붙여넣기와 `"(끝)"` 뒤 차단(`caretBlocked`)은 보존. `InlineEmbed`는 모든 이미지 임베드를 비율 유지하며 max 200×200 박스로 렌더(scheme allowlist·no-referrer 유지).
- 공통정보 확장: `useWriteController`의 `EDITABLE_FIELDS`에 `coAuthor/region/attribute/keyword/internalComment/externalComment/attachmentFile/referenceFile` 추가. 단일 출처를 `blankFields()`/`fieldsFromArticle(article, fallbackAuthor)`로 묶어 `blankTab`/`tabFromArticle`/`tabFromSource`가 모두 동일 시드를 쓰게 한다(본문은 `markupVersion` 우선). `CommonInfo`에 텍스트 입력(공동작성/지역/속성/키워드)·textarea(내부/외부코멘트)·파일 입력(첨부/자료) 추가. **내용(content) 입력란은 추가하지 않는다 — 본문 에디터가 곧 내용.** 매핑 모드(`readOnly`)에서는 공통정보·파일 입력 모두 잠근다(본문 불변 invariant 확장).
- 파일 업로드: `server/index.js`에 세션 게이트 `POST /api/upload` 추가(ADR-006 얇은 transport). 전역 `express.json`을 건너뛰고 라우트 자체 파서(`limit: '10mb'`)로 base64 본문을 받는다(전역 limit 미상향). 검증 순서: 세션(`me` 없으면 401 `UNAUTH`) → `filename/contentBase64` 타입(400 `invalid-file`) → 확장자 화이트리스트 `UPLOAD_EXT_ALLOWLIST`(소문자 비교, 미허용 400) → 디코드 후 바이트 상한 `UPLOAD_MAX_BYTES`(5MB, 초과 400 `too-large`). 저장명은 `crypto.randomBytes(16).toString('hex') + '.' + ext`(사용자 filename 미사용 → 경로 탐색 차단), `flag: 'wx'`로 덮어쓰기 금지, `uploadDir`(기본 `'uploads'`) lazy 생성. `/uploads`는 `express.static`으로 서빙. 응답 `{ ok, path: '/uploads/<name>', filename }`. **DB·기존 파일 비파괴** — path 문자열만 `attachmentFile/referenceFile`에 보관. 외부 npm 의존 없이 Node 내장 `fs/path/crypto`만 사용.
- Model 계약: `contract.js`의 `MODEL_KEYS`에 `uploadFile` 추가, `httpModel.js`에 `uploadFile(file)` 구현(File → data URL → prefix 제거 → raw base64 POST). View는 `model.uploadFile` 경유(ADR-003, 직접 fetch 금지).

**[B] 작성 화면 레이아웃·문서 탭 디자인 (`9f39687`)**
- 작성 페이지를 뷰포트 높이에 맞춘 좌 에디터(`yh-writer__editor`)/우 메타(`yh-writer__meta`) 2열·동일 높이·각 열 내부 스크롤로 정리(메타 필드가 길어도 에디터와 높이 어긋남 해소).
- `CommonInfo`를 `yh-meta-grid` 2열 그리드로(코멘트·파일·읽기전용은 `yh-field--wide` 전체폭), 메타 패널 카드화(`yh-meta-panel`).
- 탭 스트립을 파일 탭 스타일로(활성 흰 탭+상단 블루 액센트·닫기 hover 레드·`＋` 고스트 버튼). 작성 탭에만 `yh-tabs--docs`를 한정해 메타 탭은 영향받지 않게 한다. 마크업: `yh-tab__close`/`yh-tab__add` 클래스 부여.

**[C] 타이핑 캐럿 튐·Ctrl+D 크래시 수정 (`0d20972`)**
- 원인: contentEditable을 매 입력마다 `body` state로 재렌더 → 브라우저 캐럿 초기화, 브라우저가 바꾼 DOM을 React가 재조정하다 `removeChild` 크래시(화면 하얘짐).
- 수정: `Editor`에 `snapRef`(DOM 렌더 소스 스냅샷)·`lastEmittedRef`(마지막 emit 텍스트, echo 판별)·`forceRecolorRef`·`renderTick`(`useState`) 도입. `blocks` prop 변경 시 `useEffect`로 "타이핑 echo(텍스트·임베드 동일)"면 무시(편집 div를 다시 그리지 않음 → 캐럿 보존), "외부/구조 변경(로드·Ctrl+D·임베드 추가삭제·Alt+Y·blur 재색칠)"일 때만 `snapRef` 갱신 + `setRenderTick`. 렌더 소스를 `renderBlocks = snapRef.current`로, 편집 div에 `key={renderTick}`을 주어 구조 변경 시 깨끗이 remount(diff 크래시 회피). `embedSig()`로 임베드 구조 변화만 따로 감지. `handleCompositionEnd`는 동기화만 하고 remount 안 함(조합마다 remount 시 한글 캐럿 튐). `handleBlur`는 `forceRecolorRef`로 한 번 재색칠 강제.

**[D] Ctrl+D 북마크 차단 + 이미지 붙여넣기 커서 위치 보존 (`9a8d026`)**
- `WriterPage.onKeyDown`: Ctrl+D는 삭제 가능 여부와 무관하게 **항상 `e.preventDefault()`**(삭제할 라인이 없을 때 preventDefault 누락 → 두 번째 Ctrl+D에서 브라우저 북마크 창). Backspace/Delete는 실제 라인 삭제 확정 시(`blockIndex >= 0`)에만 차단(기존 동작 유지).
- 붙여넣기 커서 위치 보존: `Editor.handlePaste`에서 비동기 FileReader 전에 `readCaret`로 캐럿을 **동기 확보** → `onPasteEmbed(embed, caret)`. `WriterPage.pasteEmbedAtCaret(embed, caret)`이 캐럿 라인 블록 바로 뒤(`+1`)에 임베드 삽입(못 읽으면 끝에 덧붙임).
- 직렬화 교체: `writerBody.js`에서 `mergeTextIntoBody` 제거, `serializeBodyFromBlocks(blocks)`(임베드 위치 보존, `"(끝)"`만 최종 블록)·`insertEmbedIntoBody(currentBody, embed, blockIndex)`(범위 밖이면 `appendEmbedToBody` 폴백) 신설. `Editor`에 `readEditorBlocks(root, snapshotBlocks)` 추가 — 라인 div와 임베드 figure를 DOM 순서대로 읽어 텍스트+임베드 인터리브 블록 배열로 재구성. `InlineEmbed`에 `blockIndex` prop → figure `data-embed-key`로 박아 **등장 순서가 아닌 안정적 키**로 매칭(인라인 삭제 시 남은 임베드 데이터 뒤바뀜 방지). `handleInput`/`handleCompositionEnd`/`handleBlur`가 `onTextChange(text, editedBlocks)`로 블록을 함께 전달, `WriterPage.onTextChange`는 `serializeBodyFromBlocks(editedBlocks)`로 본문 재구성하고 제목은 emit 텍스트 첫 줄로 동기화.

**[E] Ctrl+D 라인삭제 후 포커스/캐럿 복원 (`dae8c59`)**
- 문제: 구조 변경으로 Editor가 `key=renderTick`로 remount되면 contentEditable 포커스가 빠져, 다음 Ctrl+D가 에디터 핸들러에 안 잡히고 브라우저 기본동작(북마크)으로 샌다([D]의 preventDefault는 에디터가 포커스를 가진 동안에만 유효).
- 수정: `Editor`에 `rootRef`(편집 div DOM)·`refocusRef`(복원 대상 `{ lineIndex }` 또는 null) 추가. 구조 변경 effect에서 remount 직전 편집 중(`document.activeElement === rootRef.current`)이면 현재 캐럿 라인을 `refocusRef`에 기록. remount 후 `useLayoutEffect([renderTick, textLocked])`로 편집 div에 `focus()` + 캐럿을 삭제 위치 라인 시작(`range.collapse(true)`)에 복원. **포커스가 에디터 밖(blur 재색칠·외부 로드·검색 임베드 삽입)이면 복원하지 않는다(포커스 가로채기 금지).**

## Acceptance Criteria

```bash
npm run lint
npm run build
npm test
npm run test:web
```

## 검증 절차

1. 위 AC 커맨드를 실행한다. 기존 테스트 + 신규 테스트가 모두 통과해야 한다(무회귀).
2. 아키텍처 체크리스트(ARCHITECTURE.md 디렉토리 구조·ADR 기술스택·CLAUDE.md CRITICAL):
   - 업로드 로직이 `server/index.js` 라우트 핸들러에서만 처리되는가(CLAUDE.md CRITICAL)? 세션에서만 신원 도출(ADR-004/006)?
   - View가 Controller/Model 경유만 하는가 — 업로드도 `model.uploadFile` 경유, 직접 fetch 없음(ADR-003)?
   - 업로드가 DB·기존 파일을 건드리지 않고 path 문자열만 보관하는가(DB 비파괴)? 저장명이 random-hex라 경로 탐색이 차단되는가?
   - 외부 npm 의존 추가 없이 Node 내장 모듈만 썼는가(ADR 최소 의존성)?
   - 매핑 모드에서 본문·공통정보·파일 입력이 모두 readOnly로 잠겨 본문 불변 invariant가 유지되는가?
   - `"(끝)"`은 항상 최종 블록이고 임베드는 커서 위치에 보존되는가(news.md 156·159·167)?
3. 결과에 따라 `phases/4-mvp-polish/index.json`의 step 3 status를 갱신(completed + summary). 실패 시 error, 개입 필요 시 blocked.

## 금지사항

- 송고/보류 제목 가드에서 본문 첫 줄만 보지 마라. 이유: 제목 FIELD만 채운 경우 정상 기사인데도 송고/보류가 차단된다(이 step이 고친 버그).
- 송고 전용 `"(끝)"` 가드를 제거하거나 보류에 붙이지 마라. 이유: `"(끝)"`은 송고에만 요구된다(기존 contract).
- contentEditable 본문 에디터를 매 입력마다 state로 재렌더하지 마라. 이유: 브라우저 캐럿이 초기화되고 React 재조정이 `removeChild`로 크래시한다(화면 하얘짐). 타이핑 echo는 remount 없이 무시할 것.
- Ctrl+D에서 `preventDefault`를 조건부로 빼지 마라. 이유: 삭제할 라인이 없을 때 브라우저 북마크 창이 뜬다. Ctrl+D는 항상 차단, Backspace/Delete는 실제 삭제 확정 시에만 차단.
- remount 후 포커스를 무조건 빼앗지 마라. 이유: blur 재색칠·외부 로드·검색 임베드 삽입처럼 에디터 밖에 포커스가 있을 땐 복원하면 사용자 포커스를 가로챈다. 직전 편집 중이었을 때만 복원할 것.
- 붙여넣기/타이핑 시 임베드를 본문 끝으로 옮기지 마라. 이유: 임베드는 커서 위치/DOM 순서를 보존해야 한다(news.md 156·167). 임베드 매칭은 등장 순서가 아닌 `data-embed-key`(안정적 키)로 할 것.
- 업로드에서 사용자 filename으로 디스크 경로를 만들지 마라. 이유: 경로 탐색(`../`)에 노출된다. 저장명은 random-hex + 검증된 확장자만 사용하고 기존 파일을 덮어쓰지 말 것(`wx`).
- 업로드에 외부 multipart/npm 의존을 추가하지 마라. 이유: 최소 의존성 원칙 — Node 내장 `fs/path/crypto` + base64-JSON로 처리한다.
- DB 내용을 삭제·덮어쓰지 마라(CLAUDE.md). 업로드는 path 문자열 저장만, 본문 텍스트 블록은 비파괴 유지.
- 기존 테스트/기능(IME 조합·`"(끝)"` 차단·메타 탭 임베드 추가·매핑 readOnly)을 깨뜨리지 마라.
