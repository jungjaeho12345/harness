# Step 1: writer-page-wiring — 도구>간체↔번체 변환 결선(방향 다이얼로그 + 본문 transform)

## 배경 / 요구사항

Step 0이 데이터/순수/표시 모듈 3개를 만들었다:
- `simpTradTable.js` — `SIMP_TRAD_PAIRS`(번들 `[간체, 번체]` 튜플 배열, 상용 한자 위주·불완전).
- `simpTradConvert.js` — `convertSimpTrad(text, direction)` / `convertSimpTradInBlocks(blocks, direction) -> { blocks, changed }`(코드포인트 단위·미매핑 pass-through·임베드/"(끝)" 불변). `DIRECTIONS = { TO_TRAD: 'toTrad', TO_SIMP: 'toSimp' }`.
- `SimpTradConvertDialog.jsx` — stateless 방향 선택 다이얼로그(`open`/`onConvert(direction)`/`onClose`).

이 step은 `web/src/view/WriterPage.jsx`에서 도구 메뉴 **'간체↔번체 변환'(`tools.simpTradConvert`)**을 결선한다.

**동작 모델 — 반드시 이대로 구현한다:**

1. 도구>간체↔번체 변환 클릭 → **방향 선택 다이얼로그를 연다**(`setShowSimpTrad(true)`). 다이얼로그의 두 버튼('간체→번체'/'번체→간체')이 `onConvert(direction)`을 호출한다.
2. `onConvert(direction)` 핸들러 → 등록 표로 **현재 기사 본문 텍스트 블록을 방향대로 변환**한다. `convertSimpTradInBlocks(blocks, direction)`로 새 블록을 만들고 **안전 경로 `updateField('body', serialize(...))`**로만 반영한다(약어변환/날짜삽입과 동일 경로 — `Editor.jsx`/DOM 직접 조작 금지). 변환 후 다이얼로그를 닫는다(1회성).
3. **본문을 바꾸는 기능**이므로 **매핑 모드에서는 전체가 no-op**이어야 한다 — 메뉴 클릭이 다이얼로그를 열지 않는다(**매핑 가드 뒤** 결선). 약어변환(`tools.abbrConvert`)이 매핑에서 no-op인 것과 동일 정책.

기존 결선 패턴을 그대로 따른다(`web/src/view/WriterPage.jsx`):
- 메뉴 활성: `MENU_ENABLED` 배열에 `tools.simpTradConvert` 추가.
- 라우팅: `onMenuSelect(id)`에 분기 추가(**매핑 가드 뒤** — 약어변환/날짜삽입과 같은 영역).
- 표시 토글 state: `showAbbrevManage`/`showMemo`와 동일한 boolean(`showSimpTrad`).
- 다이얼로그 배치: `<AbbrevManageDialog>` 옆에 `<SimpTradConvertDialog>` 추가.

## 읽어야 할 파일

- `/CLAUDE.md`, `/docs/ARCHITECTURE.md` — 프론트 MVC, DB 비파괴, 명령어(`npm run test:web`/`build`/`lint`, web 루트).
- `/docs/ADR.md` — ADR-003(View 순수·transport 비의존). 매핑 모드의 본문 불변식(markupVersion 불변)은 코드의 markupVersion 규칙에서 온다 — **간↔번 변환은 본문을 바꾸므로 매핑에서 차단**.
- `/docs/news.md` — L182(도구 메뉴 '간체<->번체 변환').
- `web/src/view/WriterPage.jsx` — **결선 지점(실측; 라인은 근사, 반드시 파일에서 재확인)**:
  - import 블록(L22~24 `AbbrevManageDialog`/`loadAbbrevs`/`expandAbbrevInBlocks` 인접)에 `import { SimpTradConvertDialog } from './SimpTradConvertDialog.jsx';`·`import { convertSimpTradInBlocks } from './simpTradConvert.js';` 추가.
  - `MENU_ENABLED` 배열(L77) — `'tools.simpTradConvert'` 추가(다른 미결선 항목은 추가 금지).
  - state 선언부 — `showAbbrevManage`(L124)·`showMemo`(L119) 패턴을 따라 `showSimpTrad` boolean 추가.
  - `convertAbbrev`(L282~286) — **본문 transform 안전 경로 실측 기준**: `expandAbbrevInBlocks(blocks, abbrevs)` → `if (!r.changed) return;` → `updateField('body', serialize(r.blocks))`. 간↔번 핸들러도 같은 경로(치환 함수만 교체 + 방향 인자 + 변환 후 다이얼로그 닫기).
  - `onMenuSelect(id)`(L334~) — **매핑 가드 `if (isMapping) return;`(L351)** 기준으로: `tools.simpTradConvert`는 **가드 뒤**(`tools.abbrConvert`(L370)/`tools.insertDate`(L368) 인근)에 둔다.
  - 다이얼로그 렌더 블록(L805~ `<AbbrevManageDialog>`) — 여기 옆에 `<SimpTradConvertDialog>`를 추가.
- `web/src/view/SimpTradConvertDialog.jsx`(Step 0) — props 계약: `open`·`onConvert(direction)`·`onClose()`.
- `web/src/view/simpTradConvert.js`(Step 0) — `convertSimpTradInBlocks(blocks, direction)`(→`{blocks, changed}`), `DIRECTIONS`.
- `web/src/view/EditorMenuBar.jsx`(L99) — `tools.simpTradConvert`(라벨 '간체↔번체 변환') id 확인. **이 id를 그대로 결선**(새 id 금지).
- `web/src/view/WriterPage.test.jsx` — **테스트 컨벤션**: fakeModel/렌더, 메뉴 열기→항목 클릭, 다이얼로그 오픈/닫기, 메뉴 활성/비활성 단언, 매핑 탭 렌더, 저장(PUT) `markupVersion` 단언(약어변환 describe·날짜삽입 describe L2449~가 실측 기준). `beforeEach`에서 `localStorage.clear()`.
  - **⚠️ 회귀 가드 재확인(grep)**: `simpTradConvert`/`간체`/`번체`를 grep 해 **"여전히 disabled"로 단언하는 회귀가드가 있는지 확인**한다. **현재(계획 시점) 없음** — 유일한 disabled 회귀가드는 L2600 `'다른 비결선 도구 항목(tools.publishPhoto)은 여전히 비활성이다(회귀 없음)'`로 **`사진발행/DB등록`(`tools.publishPhoto`)**를 단언한다. `tools.publishPhoto`는 이번에 결선하지 않으므로 **이 가드는 그대로 유효**하다(교체 불필요). 만약 재확인 결과 `simpTradConvert`를 disabled로 단언하는 테스트가 새로 생겼으면 여전히 미결선인 항목(`tools.publishPhoto`/`tools.historyCompare`/`tools.uiLanguage`)으로 교체한다.

## 작업

TDD로 진행한다(vitest). **`WriterPage.test.jsx`에 단언을 먼저 추가**하고 통과하는 결선을 만든다.

### 결선 (시그니처/배치 수준 — 구현 재량)

1. **import**(상단, abbrev import 인접):
   ```js
   import { SimpTradConvertDialog } from './SimpTradConvertDialog.jsx';
   import { convertSimpTradInBlocks } from './simpTradConvert.js';
   ```

2. **state**:
   ```js
   const [showSimpTrad, setShowSimpTrad] = useState(false);  // showAbbrevManage/showMemo 패턴
   ```
   > 목록/표는 번들 정적 데이터(`SIMP_TRAD_PAIRS`)라 WriterPage state가 **필요 없다**(약어의 `abbrevs` 같은 lazy-init state를 추가하지 마라 — 표는 localStorage가 아니라 번들 상수).

3. **변환 핸들러**(본문 transform — 매핑 가드 뒤에서만 도달·이중 방어):
   ```js
   const applySimpTrad = (direction) => {
     if (isMapping) return;                                  // 이중 방어(가드 뒤 결선이지만 다이얼로그 열린 채 탭전환 대비)
     const r = convertSimpTradInBlocks(blocks, direction);
     if (r.changed) updateField('body', serialize(r.blocks)); // 안전 경로만 — DOM/Editor 직접 조작 금지
     setShowSimpTrad(false);                                 // 1회성 — 변환(또는 no-op) 후 닫기
   };
   ```
   > **캐럿 재배치 없음**: 간↔번은 문자단위 1:1이라 오프셋이 보존되지만, 메뉴→다이얼로그 경로에서 포커스가 이미 빠져 있고 전체 본문 transform이므로 `setPendingCaretLine`을 호출하지 않는다(약어변환과 동일 정책 — scope 밖).

4. **라우팅**(`onMenuSelect` — **매핑 가드 `if (isMapping) return;` 뒤**, `tools.abbrConvert` 인근):
   ```js
   if (id === 'tools.simpTradConvert') { setShowSimpTrad(true); return; }
   ```

5. **MENU_ENABLED**: 배열에 `'tools.simpTradConvert'`만 추가(다른 미결선 항목 추가 금지).

6. **다이얼로그 렌더**(`<AbbrevManageDialog>` 옆):
   ```jsx
   {/* 간체↔번체 변환(도구>간체↔번체 변환) — 방향 선택 다이얼로그. 버튼 클릭 시 applySimpTrad(direction)이
       convertSimpTradInBlocks + updateField('body', serialize(...)) 안전 경로로 본문을 변환하고 닫는다.
       본문 변경이므로 매핑 가드 뒤 결선(매핑에선 메뉴가 다이얼로그를 열지 않음 — 약어변환과 동일 정책). */}
   <SimpTradConvertDialog
     open={showSimpTrad}
     onConvert={applySimpTrad}
     onClose={() => setShowSimpTrad(false)}
   />
   ```

> **주의**: 변환 경로에서 `updateField('body', serialize(...))`만 쓰고 `Editor`의 새 prop·DOM(`document.querySelector('.yh-editor')` 등) 직접 조작을 하지 마라. `abbrevs`처럼 표를 localStorage state로 두지 마라(표는 번들 상수).

## 핵심 규칙 (반드시 준수 — 위반 시 반려)

1. **본문 안전 경로만·매핑 가드 뒤**: `applySimpTrad`는 `convertSimpTradInBlocks` + `updateField('body', serialize(...))`로만 본문을 바꾼다. `tools.simpTradConvert` 분기는 `if (isMapping) return;` **뒤**에 둔다(약어변환/날짜삽입과 동일). 이유: 매핑 모드는 본문 텍스트 잠금(markupVersion 불변식) — 매핑에서 본문을 바꾸면 안 된다. DOM/`Editor` 직접 조작은 임베드·"(끝)"·색칠 경로를 깨뜨린다.
2. **전체가 body-changing → 가드 뒤에서 다이얼로그 오픈**: 이 기능은 결과적으로 본문을 바꾸므로, 진입점(다이얼로그 오픈)을 **매핑 가드 뒤**에 둬 매핑에서는 아예 열리지 않게 한다(약어변환 선례). 매핑 가드 **앞**에 두지 마라 — 매핑에서 열려도 변환할 수 없는 죽은 다이얼로그가 되고, `applySimpTrad`의 이중 방어에만 의존하게 된다.
3. **변환 함수는 no-op을 스스로 판정**: `if (r.changed)`일 때만 `updateField` 한다. 변환 대상(중국어)이 없거나 잘못된 방향이면 `changed=false` → 본문 불변(불필요한 dirty 방지). 이유: 순수 함수가 no-op을 계약으로 보장(약어변환과 동일).
4. **전체 본문 transform — 캐럿 재배치 없음**: `setPendingCaretLine`을 호출하지 마라. 이유: 전체 본문 변환·메뉴/다이얼로그로 포커스 상실 — 부정확 캐럿 이동보다 포커스 유지가 안전(scope 밖, 약어변환과 동일).
5. **표는 번들 상수·localStorage state 금지**: `SIMP_TRAD_PAIRS`는 번들 정적 데이터라 WriterPage에 `abbrevs` 같은 lazy-init state를 추가하지 마라. `convertSimpTradInBlocks`가 표를 직접 참조한다. 이유: 표는 사용자 편집 대상이 아님(약어사전과 다름) — 불필요한 state/영속 금지.
6. **기존 메뉴 id 재사용**: `EditorMenuBar`의 `tools.simpTradConvert`를 그대로 결선한다. **새 id·새 라벨 금지**(id 불일치 시 메뉴가 죽는다 — BLOCKER 전력). 이유: 라벨이 아니라 안정 id 매칭.
7. **client 전용·server/DB 미변경**: `server/`·DB 스키마·`editorPrefs`를 건드리지 마라. 변환은 번들 표만(영속 없음). 이유: DB 비파괴·client 전용 기능.
8. **비결선 메뉴 비활성 유지**: `MENU_ENABLED`에 `tools.simpTradConvert`만 추가한다(사진발행/이력비교/UI언어 등은 계속 비활성). 이유: Scope 최소화.

## Acceptance Criteria

```bash
cd web
npm run test:web -- WriterPage    # 신규 간↔번 결선 단언 + (해당 시)회귀 가드 통과
npm run test:web                  # web 전체 회귀 통과
npm run build
npm run lint
```

추가 단언(vitest, `WriterPage.test.jsx` — `beforeEach`에서 `localStorage.clear()`):
- 도구 메뉴의 **'간체↔번체 변환' 항목이 활성**이다(이전엔 disabled placeholder — 비활성→활성 전환 단언).
- **회귀 가드 유지**: L2600의 `사진발행/DB등록`(`tools.publishPhoto`) disabled 단언이 **여전히 통과**한다(publishPhoto 미결선). (grep 재확인 결과 `simpTradConvert`를 disabled로 단언하는 별도 가드는 없음.)
- '간체↔번체 변환' 클릭 시 `SimpTradConvertDialog`(testid `simptrad-convert`, `role="dialog"` '간체/번체 변환')가 열린다.
- **간체→번체 변환(본문 변경)**: 본문에 간체('国' 등 표에 있는 문자)를 두고 '간체↔번체 변환' → '간체→번체' 버튼 클릭 → 저장 시 PUT `markupVersion`이 번체('國')를 담는다(약어변환/날짜삽입 describe의 저장-단언 패턴). 변환 후 다이얼로그가 닫힌다.
- **번체→간체 변환**: 본문에 번체('國')를 두고 '번체→간체' 버튼 클릭 → 저장 `markupVersion`이 간체('国')를 담는다.
- **미매핑 no-op**: 본문이 한글/라틴뿐일 때 어느 방향 버튼을 눌러도 본문(저장 `markupVersion`)이 변하지 않는다(그리고 다이얼로그는 닫힌다).
- **임베드/"(끝)" 불변**: 본문에 임베드/"(끝)"가 있어도 변환 후 임베드·"(끝)"는 그대로다(텍스트 중국어만 변환).
- **닫기/Esc**: '닫기'/Esc로 다이얼로그가 닫힌다(`simptrad-convert`가 사라짐), 본문 무변경.
- **매핑 모드**: 매핑 탭(`mode==='mapping'`)에서 '간체↔번체 변환'을 클릭해도 다이얼로그가 열리지 않고 본문이 변하지 않는다(no-op — 가드 뒤).

## 검증 절차

1. 위 AC 커맨드를 web 루트(`web/`)에서 실행한다(필요 시 `PYTHONUTF8=1` — 한자/한글 출력).
2. 아키텍처 체크리스트: 변환 본문 안전 경로(`updateField`+`serialize`)·매핑 가드 뒤·캐럿 재배치 없음·`changed` no-op 판정; 표 번들 상수(WriterPage state/영속 없음); 기존 id 재사용·server/editorPrefs/DB 불변·`MENU_ENABLED`에 한 id만 추가·회귀 가드(publishPhoto) 유지.
3. 결과에 따라 `phases/24-editor-simptrad/index.json`의 step 1을 갱신(completed+summary / error / blocked).

## 금지사항

- 변환 경로에서 `Editor`의 새 prop·DOM(`document.querySelector('.yh-editor')` 등) 직접 조작을 하지 마라 — `updateField('body', serialize(...))`만. 이유: 임베드·"(끝)"·색칠·매핑 경로를 깨뜨린다(안전 경로 우회 금지).
- `tools.simpTradConvert` 분기(다이얼로그 오픈)를 매핑 가드(`if (isMapping) return;`) **앞**에 두지 마라. 이유: 이 기능은 결과적으로 본문 변경 — 매핑(텍스트 잠금)에서 열리면 죽은 다이얼로그가 되고 markupVersion 불변식 위반 위험(약어변환과 동일 정책).
- `applySimpTrad`에서 `setPendingCaretLine`을 호출하지 마라. 이유: 전체 본문 transform — 포커스 유지가 안전(scope 밖).
- 표(`SIMP_TRAD_PAIRS`)를 WriterPage state/localStorage로 복제하지 마라(약어의 `abbrevs` 패턴을 흉내내지 마라). 이유: 표는 번들 상수·사용자 편집 대상 아님 — 불필요한 state/영속.
- 자동 변환(타이핑 중 자동 간↔번 치환)을 넣지 마라 — `Editor.jsx`/`onKeyDown`에 변환 처리를 추가하지 마라. 이유: Editor.jsx 미접촉·수동 변환만(별도 phase로 DEFER).
- `tools.simpTradConvert`에 새 메뉴 id/라벨을 만들지 마라(기존 id 그대로 결선). 이유: id 불일치로 메뉴가 죽는다(BLOCKER 전력).
- 툴바(`EditorToolBar.jsx`)나 `<EditorToolBar />` 렌더를 건드리지 마라. 이유: 툴바 전체가 아직 미결선 — 별도 phase 범위, 이번 scope는 도구 메뉴만.
- `Editor.jsx`·`EditorMenuBar.jsx`·`server/`·`editorPrefs`·DB 스키마·`package.json`을 수정하지 마라. 이유: 결선만 — Editor 미접촉·client 전용·DB 비파괴·새 의존성 금지.
- `MENU_ENABLED`에 `tools.simpTradConvert` 외 다른 미결선 항목을 추가하지 마라. 이유: Scope 최소화.
