# Step 1: writer-page-wiring — 도구>약어관리/약어변환 결선(목록 state + 다이얼로그 + 본문 transform)

## 배경 / 요구사항

Step 0이 순수 모듈 3개를 만들었다:
- `abbrevStore.js` — `loadAbbrevs()`/`saveAbbrevs(list)`/`normalizeAbbrevs(list)`(전용 키 `yh.editorAbbrevs`, graceful).
- `abbrevConvert.js` — `expandAbbrev(text, pairs)`/`expandAbbrevInBlocks(blocks, pairs) -> { blocks, changed }`(임베드·"(끝)" 불변).
- `AbbrevManageDialog.jsx` — controlled 목록 CRUD 다이얼로그(`open`/`items`/`onAdd`/`onRemove`/`onClose`).

이 step은 `web/src/view/WriterPage.jsx`에서 도구 메뉴 **'약어관리'(`tools.abbrManage`)·'약어변환'(`tools.abbrConvert`)**를 결선한다.

**동작 모델 — 반드시 이대로 구현한다:**

1. **약어관리(`tools.abbrManage`)** — 다이얼로그를 **열기만** 한다(본문 무변경). 부모(WriterPage)가 커밋된 약어 목록 state(`abbrevs`)를 소유하고, 다이얼로그의 `onAdd`/`onRemove`는 목록을 갱신하며 **즉시 `saveAbbrevs`로 localStorage 영속**한다(약어사전은 각 추가/삭제가 확정 동작 — 별도 '저장' 버튼 없음). 본문/캐럿/임베드를 건드리지 않으므로 **매핑 모드에서도 열려야 한다**(파일정보/메모와 동일 정책 — **매핑 가드 앞** 결선).
2. **약어변환(`tools.abbrConvert`)** — 등록된 약어를 **현재 기사 본문 텍스트 블록에서 확장**한다. `expandAbbrevInBlocks(blocks, abbrevs)`로 새 블록을 만들고 **안전 경로 `updateField('body', serialize(...))`**로만 반영한다(날짜삽입/대소문자변환과 동일 경로 — `Editor.jsx`/DOM 직접 조작 금지). 본문을 바꾸므로 **매핑 모드에서는 no-op**이어야 한다(**매핑 가드 뒤** 결선 — 날짜삽입/찾기와 동일).

기존 결선 패턴을 그대로 따른다(`web/src/view/WriterPage.jsx`):
- 메뉴 활성: `MENU_ENABLED` 배열에 두 id 추가.
- 라우팅: `onMenuSelect(id)`에 분기 추가(**약어관리=매핑 가드 앞, 약어변환=매핑 가드 뒤**).
- 목록 state: `glyphFavorites`처럼 마운트 lazy-init(`useState(() => loadAbbrevs())`).
- 표시 토글 state: `showFileInfo`/`showMemo`와 동일한 boolean(`showAbbrevManage`).
- 다이얼로그 배치: `<MemoDialog>` 옆에 `<AbbrevManageDialog>` 추가.

## 읽어야 할 파일

- `/CLAUDE.md`, `/docs/ARCHITECTURE.md` — 프론트 MVC, DB 비파괴, 명령어(`npm run test:web`/`build`/`lint`).
- `/docs/ADR.md` — ADR-003(View 순수·transport 비의존). 매핑 모드의 본문 불변식(markupVersion 불변)은 `docs/ARCHITECTURE.md`/코드의 markupVersion 규칙에서 온다 — **약어변환은 본문을 바꾸므로 매핑에서 차단**, 약어관리는 본문 무관이라 매핑에서 허용.
- `/docs/news.md` — L182(도구 메뉴 '약어변환'/'약어관리').
- `web/src/view/WriterPage.jsx` — **결선 지점(실측; 라인은 근사, 반드시 파일에서 재확인)**:
  - `import { MemoDialog } ...`(L20)·`import { loadMemo, saveMemo } ...`(L21) 인접에 `import { AbbrevManageDialog } from './AbbrevManageDialog.jsx';`·`import { loadAbbrevs, saveAbbrevs } from './abbrevStore.js';`·`import { expandAbbrevInBlocks } from './abbrevConvert.js';` 추가.
  - `MENU_ENABLED` 배열(L74) — `'tools.abbrManage'`·`'tools.abbrConvert'` 추가(다른 미결선 항목은 추가 금지).
  - state 선언부 — `showMemo`(L116)·`memoText`(L119, `useState(() => loadMemo())`)·`glyphFavorites`(L106) 패턴을 따라 `showAbbrevManage`·`abbrevs`를 추가.
  - `onMenuSelect(id)`(L305~) — **매핑 가드 `if (isMapping) return;`(L320)** 기준으로: `tools.abbrManage`는 **가드 앞**(`tools.fileInfo`(L317)/`tools.memo`(L319) 인근), `tools.abbrConvert`는 **가드 뒤**(`tools.insertDate`(L337) 인근).
  - `insertDate`(L249~)·`onGlyphPick`(L238~) — **본문 변경 안전 경로 실측 기준**: `updateField('body', serialize(r.blocks))`. 약어변환도 같은 경로. (약어변환은 전체 본문 transform이라 `setPendingCaretLine`은 호출하지 않는다 — 아래 핵심 규칙 4.)
  - 다이얼로그 렌더 블록(L735~768 — `<GlyphInputDialog>`/`<UrlEmbedDialog>`/`<FileInfoDialog>`/`<MemoDialog>`) — 여기에 `<AbbrevManageDialog>`를 추가.
- `web/src/view/AbbrevManageDialog.jsx`(Step 0) — props 계약: `open`·`items`·`onAdd(short, long)`·`onRemove(index)`·`onClose()`.
- `web/src/view/abbrevStore.js`(Step 0) — `loadAbbrevs()`(→`{short,long}[]`)·`saveAbbrevs(list)`(→정규화 목록, 영속).
- `web/src/view/abbrevConvert.js`(Step 0) — `expandAbbrevInBlocks(blocks, pairs)`(→`{blocks, changed}`).
- `web/src/view/EditorMenuBar.jsx`(L87~88) — `tools.abbrConvert`(라벨 '약어변환')·`tools.abbrManage`(라벨 '약어관리') id 확인. **이 id를 그대로 결선**(새 id 금지).
- `web/src/view/WriterPage.test.jsx` — **테스트 컨벤션**: fakeModel/렌더, 메뉴 열기→항목 클릭, 다이얼로그 오픈/닫기, 메뉴 활성/비활성 단언, 매핑 탭 렌더, 저장(PUT) `markupVersion` 단언(날짜삽입 describe L2449~/파일정보 L2857~/메모 L2993~가 실측 기준). `beforeEach`에서 `localStorage.clear()`로 약어 격리.
  - **⚠️ 필수 회귀 수정**: L2599~2606의 테스트 `'다른 비결선 도구 항목(tools.abbrConvert)은 여전히 비활성이다(회귀 없음)'`는 **약어변환('약어변환')이 disabled임을 단언**한다. 이번 phase가 약어변환을 결선하면 이 단언이 깨진다 → **가드 대상을 아직 미결선인 항목으로 교체**한다(예 `'사진발행/DB등록'`(`tools.publishPhoto`) — `tools.historyCompare`/`tools.simpTradConvert`/`tools.uiLanguage`도 여전히 미결선). 주석의 설명도 함께 갱신한다.

## 작업

TDD로 진행한다(vitest). **`WriterPage.test.jsx`에 단언을 먼저 추가**(및 위 회귀 테스트 수정)하고 통과하는 결선을 만든다.

### 결선 (시그니처/배치 수준 — 구현 재량)

1. **import**(상단):
   ```js
   import { AbbrevManageDialog } from './AbbrevManageDialog.jsx';
   import { loadAbbrevs, saveAbbrevs } from './abbrevStore.js';
   import { expandAbbrevInBlocks } from './abbrevConvert.js';
   ```

2. **state**:
   ```js
   const [showAbbrevManage, setShowAbbrevManage] = useState(false);  // showFileInfo/showMemo 패턴
   const [abbrevs, setAbbrevs] = useState(() => loadAbbrevs());       // glyphFavorites 패턴(마운트 lazy-init)
   ```

3. **관리 CRUD 핸들러**(즉시 영속 — `saveAbbrevs`가 정규화 목록을 돌려주므로 state를 그 반환값으로 세팅):
   ```js
   const addAbbrev = (short, long) => {
     const s = String(short ?? '').trim();
     const l = String(long ?? '').trim();
     if (!s || !l) return;                                   // 빈 입력 no-op(다이얼로그도 가드하지만 이중 방어)
     setAbbrevs((list) => saveAbbrevs([...list, { short: s, long: l }]));
   };
   const removeAbbrev = (index) => {
     setAbbrevs((list) => saveAbbrevs(list.filter((_, i) => i !== index)));
   };
   ```

4. **약어변환 핸들러**(본문 transform — 매핑 가드 뒤에서만 호출):
   ```js
   const convertAbbrev = () => {
     const r = expandAbbrevInBlocks(blocks, abbrevs);        // abbrevs = 세션 state(마운트 lazy-init + CRUD로 동기)
     if (!r.changed) return;                                 // 등록 약어 없음/매치 없음 → no-op(불필요한 dirty 방지)
     updateField('body', serialize(r.blocks));               // 안전 경로만 — DOM/Editor 직접 조작 금지
   };
   ```

5. **라우팅**(`onMenuSelect`):
   - **약어관리 = 매핑 가드 앞**(본문 무관 → 매핑에서도 열림, `tools.fileInfo`/`tools.memo` 인근):
     ```js
     if (id === 'tools.abbrManage') { setShowAbbrevManage(true); return; }
     ```
   - **약어변환 = 매핑 가드 뒤**(본문 변경 → 매핑 비활성, `tools.insertDate` 인근):
     ```js
     if (id === 'tools.abbrConvert') { convertAbbrev(); return; }
     ```

6. **MENU_ENABLED**: 배열에 `'tools.abbrManage'`·`'tools.abbrConvert'`만 추가(다른 미결선 항목 추가 금지).

7. **다이얼로그 렌더**(`<MemoDialog>` 옆):
   ```jsx
   {/* 약어 관리(도구>약어관리) — controlled: 커밋 목록은 abbrevs(부모 소유·마운트 lazy-init), onAdd/onRemove가 즉시
       saveAbbrevs로 localStorage 영속. 본문/캐럿/임베드 무변경 → 매핑에서도 안전(매핑 가드 앞 결선). */}
   <AbbrevManageDialog
     open={showAbbrevManage}
     items={abbrevs}
     onAdd={addAbbrev}
     onRemove={removeAbbrev}
     onClose={() => setShowAbbrevManage(false)}
   />
   ```

> **주의**: 약어관리 경로에서 `updateField`·`serialize`·`insertEmbed`·`setPendingCaretLine`를 호출하지 마라(본문 무변경). 약어변환 경로에서는 `updateField('body', serialize(...))`만 쓰고 `Editor`의 새 prop·DOM 직접 조작을 하지 마라.

## 핵심 규칙 (반드시 준수 — 위반 시 반려)

1. **약어변환은 본문 안전 경로만·매핑 가드 뒤**: `convertAbbrev`는 `expandAbbrevInBlocks` + `updateField('body', serialize(...))`로만 본문을 바꾼다. 분기는 `if (isMapping) return;` **뒤**에 둔다(날짜삽입/찾기와 동일). 이유: 매핑 모드는 본문 텍스트 잠금(markupVersion 불변식) — 매핑에서 본문을 바꾸면 안 된다. DOM/`Editor` 직접 조작은 임베드·"(끝)"·색칠 경로를 깨뜨린다.
2. **약어관리는 본문 무변경·매핑 가드 앞**: `tools.abbrManage` 분기는 `setShowAbbrevManage(true)`만 하고 매핑 가드 **앞**에 둔다(`tools.fileInfo`/`tools.memo`와 같은 영역). CRUD 핸들러(`addAbbrev`/`removeAbbrev`)는 `abbrevs` state + `saveAbbrevs`만 만진다. 이유: 약어사전은 본문과 독립 — 매핑에서도 열려야 함(죽은 버튼 방지), 본문 오염 금지.
3. **즉시 영속(관리)**: `onAdd`/`onRemove`는 `saveAbbrevs`로 즉시 localStorage에 반영한다(별도 '저장' 버튼 없음). `saveAbbrevs`의 반환(정규화 목록)을 state에 세팅해 화면·저장소를 일치시킨다. 이유: 약어사전은 각 추가/삭제가 확정 동작 — 미저장 편집 개념이 없다(메모의 명시 저장 모델과 다름).
4. **전체 본문 transform — 캐럿 재배치 없음**: 약어변환은 여러 줄의 오프셋을 동시에 바꾸므로 `setPendingCaretLine`을 호출하지 마라(정확한 캐럿 복원은 이번 scope 밖). 이유: 부정확한 캐럿 이동이 사용자를 엉뚱한 줄로 보내는 것보다, 포커스를 그대로 두는 편이 안전하다.
5. **마운트 lazy-init·세션 진실 소스**: `abbrevs`는 `useState(() => loadAbbrevs())`로 한 번만 초기화하고, 이후 CRUD(`setAbbrevs(saveAbbrevs(...))`)로만 갱신한다. 매 렌더/오픈마다 `loadAbbrevs()`로 다시 초기화하지 마라. `convertAbbrev`도 `abbrevs` state를 쓴다(재-read 불필요 — CRUD가 state·저장소를 동기). 이유: state가 세션 내 단일 진실(glyphFavorites 게이트와 동일), 새로고침 시에만 저장소에서 복원.
6. **기존 메뉴 id 재사용**: `EditorMenuBar`의 `tools.abbrManage`/`tools.abbrConvert`를 그대로 결선한다. **새 id·새 라벨 금지**(id 불일치 시 메뉴가 죽는다 — BLOCKER 전력). 이유: 라벨이 아니라 안정 id 매칭.
7. **client 전용·server/DB 미변경**: `server/`·DB 스키마·`editorPrefs`를 건드리지 마라. 영속은 `abbrevStore`(localStorage)만. 이유: DB 비파괴·client 전용 기능.
8. **비결선 메뉴 비활성 유지**: `MENU_ENABLED`에 `tools.abbrManage`/`tools.abbrConvert`만 추가한다(사진발행/이력비교/간체번체/UI언어 등은 계속 비활성). 이유: Scope 최소화.

## Acceptance Criteria

```bash
npm run test:web -- WriterPage    # 신규 약어 결선 단언 + 수정된 회귀 가드 통과
npm run test:web                  # web 전체 회귀 통과
npm run build
npm run lint
```

추가 단언(vitest, `WriterPage.test.jsx` — `beforeEach`에서 `localStorage.clear()`):
- 도구 메뉴의 **'약어관리'·'약어변환' 항목이 활성**이다(이전엔 disabled placeholder — 비활성→활성 전환 단언).
- **회귀 가드 갱신**: 기존 `tools.abbrConvert` disabled 단언(L2605)을 **여전히 미결선인 항목**(예 `'사진발행/DB등록'`)으로 교체하고 통과.
- '약어관리' 클릭 시 `AbbrevManageDialog`(testid `abbrev-manage`, `role="dialog"` '약어 관리')가 열린다.
- 다이얼로그에서 짧은형/확장형 입력 후 '추가' → **localStorage(`yh.editorAbbrevs`)에 영속**되고(`loadAbbrevs()`가 그 약어 포함) 목록 행에 `short → long`이 보인다.
- 행 '삭제' → 목록에서 사라지고 localStorage에도 반영된다.
- '닫기'/Esc로 다이얼로그가 닫힌다(`abbrev-manage`가 사라짐).
- **약어변환 확장(본문 변경)**: 약어 `{short:'정부', long:'대한민국 정부'}`를 (localStorage 시드 또는 관리 다이얼로그로) 등록하고, 본문에 '정부'(단독)만 둔 뒤 '약어변환' 클릭 → 저장 시 PUT `markupVersion`이 확장형('대한민국 정부')을 담는다(날짜삽입 describe의 저장-단언 패턴). 
- **오확장 안 함**: 본문이 '행정부'뿐이고 약어 `{short:'정부',...}`만 등록됐을 때 '약어변환' 후 본문 불변(부분문자열 미치환 — 저장 `markupVersion`에 확장형 미포함).
- **미등록 no-op**: 등록 약어가 없을 때 '약어변환' 클릭 시 본문(저장 `markupVersion`)이 변하지 않는다.
- **매핑 모드**: 매핑 탭(`mode==='mapping'`)에서 '약어관리'는 활성이고 다이얼로그가 열린다(가드 앞). '약어변환' 클릭 시 본문이 변하지 않는다(no-op — 가드 뒤).
- **약어관리는 본문 무변경**: 약어관리를 열고 추가/삭제/닫기 해도 기사 본문(`updateField('body')`/저장 `markupVersion`)이 변하지 않는다.

## 검증 절차

1. 위 AC 커맨드를 실행한다(필요 시 `PYTHONUTF8=1`).
2. 아키텍처 체크리스트: 약어변환 본문 안전 경로(`updateField`+`serialize`)·매핑 가드 뒤·캐럿 재배치 없음; 약어관리 매핑 가드 앞·본문 무변경·즉시 영속; 마운트 lazy-init·기존 id 재사용·server/editorPrefs/DB 불변·`MENU_ENABLED`에 두 id만 추가·회귀 가드 갱신.
3. 결과에 따라 `phases/23-editor-abbrev/index.json`의 step 1을 갱신(completed+summary / error / blocked).

## 금지사항

- 약어변환 경로에서 `Editor`의 새 prop·DOM(`document.querySelector('.yh-editor')` 등) 직접 조작을 하지 마라 — `updateField('body', serialize(...))`만. 이유: 임베드·"(끝)"·색칠·매핑 경로를 깨뜨린다(안전 경로 우회 금지).
- `tools.abbrConvert` 분기를 매핑 가드(`if (isMapping) return;`) **앞**에 두지 마라. 이유: 약어변환은 본문 변경 → 매핑(텍스트 잠금)에서 실행되면 markupVersion 불변식 위반.
- `tools.abbrManage` 분기를 매핑 가드 **뒤**에 두지 마라. 이유: 약어관리는 본문 무관 — 매핑에서도 열려야 함(죽은 버튼 방지).
- 약어변환에서 `setPendingCaretLine`을 호출하지 마라. 이유: 전체 본문 transform이라 캐럿 오프셋이 대량 변동 — 부정확 캐럿 이동보다 포커스 유지가 안전(scope 밖).
- `abbrevs`를 렌더/오픈마다 `loadAbbrevs()`로 다시 초기화하거나 articleId/탭에 종속시키지 마라. 이유: 입력이 되돌아가고, 전역 약어사전 1개 모델에 어긋난다.
- 자동 키 인터셉트(타이핑 중 자동 확장)를 넣지 마라 — `Editor.jsx`/`onKeyDown`에 약어 처리를 추가하지 마라. 이유: Editor.jsx 미접촉(별도 phase로 DEFER).
- `tools.abbrConvert`/`tools.abbrManage`에 새 메뉴 id/라벨을 만들지 마라(기존 id 그대로 결선). 이유: id 불일치로 메뉴가 죽는다(BLOCKER 전력).
- 툴바의 `tool.abbrConvert`(단수, `EditorToolBar.jsx`) 또는 `<EditorToolBar />` 렌더를 건드리지 마라. 이유: 툴바 전체가 아직 미결선 — 별도 phase 범위, 이번 scope는 도구 메뉴만.
- `Editor.jsx`·`EditorMenuBar.jsx`·`server/`·`editorPrefs`·DB 스키마를 수정하지 마라. 이유: 결선만 — Editor 미접촉·client 전용·DB 비파괴.
- `MENU_ENABLED`에 `tools.abbrManage`/`tools.abbrConvert` 외 다른 미결선 항목을 추가하지 마라. 이유: Scope 최소화.
