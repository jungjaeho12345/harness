# Step 6: save-title-contract

## 목표

자동 기업코드 변환(`edit.companyCode='auto'`)이 저장/송고 직전에 본문을 바꿀 때의 **제목 재파생 경로를 한 번에 정리**한다. 두 가지를 같이 고친다(둘 다 같은 함수·같은 계약을 지난다).

1. **레이어 역행 제거** — `web/src/controller/useWriteController.js` L11이 `../view/writerBody.js`의 `bodyTitle`을 import한다. 프론트 의존 방향은 `View ← Controller ← Model`인데(ARCHITECTURE.md·ADR-003) 컨트롤러가 뷰를 참조하는 **유일한 프로덕션 위반**이다.
2. **신규 초안 저장의 stale title** — `WriterPage.saveDocument`의 신규(articleId 無) 분기가 `draftFields`에 **변환된 body와 변환 전 title**을 함께 저장한다(자기모순 스냅샷).

해법(하나의 계약 변경): **오버라이드를 `{ body, title }` 객체로 만들고 제목 파생은 전적으로 뷰가 한다.** 컨트롤러는 받은 값을 dto에 싣기만 하므로 `bodyTitle` import가 사라지고, 뷰는 저장 경로(PUT)·초안 경로·송고 경로에서 **같은 한 쌍**을 쓴다.

## 읽어야 할 파일

라인 번호는 실측 힌트 — 심볼명으로 재확인하라.

- `docs/ARCHITECTURE.md`(프론트 MVC 의존 방향: `View ← Controller ← Model`), `docs/ADR.md` **ADR-003**(Model 계약이 유일한 transport seam)·**ADR-004**(role 등 신뢰 필드는 dto에 싣지 않는다).
- `web/src/controller/useWriteController.js` — **전체**. 핵심:
  - L11 `import { bodyTitle } from '../view/writerBody.js';` ← **삭제 대상**.
  - `toSaveDto(tab, bodyOverride)`(L58~72 주석 포함) — `{ body, ...rest }` 분해 → `markupVersion: bodyOverride ?? body`, L69 `if (bodyOverride != null) dto.title = bodyTitle(bodyOverride);`, `articleId`는 있을 때만.
  - `save(bodyOverride)`(L284~), `saveAsNew()`(L301, `toSaveDto(tab)` — 오버라이드 없음), `saveMapping()`(L311, 동일), `submit(action, bodyOverride)`(L321~333).
- `web/src/view/writerBody.js` — `bodyTitle(body)`(L11~14): `blocksToText(deserialize(body))`의 첫 줄 trim. **제목=본문 첫 줄 규칙의 단일 출처**(뷰의 `commitBody`도 이걸 쓴다). 위치를 **옮기지 마라**(아래 "기각한 대안" 참조).
- `web/src/view/WriterPage.jsx` — 다음 지점만:
  - L85 import 목록에 `bodyTitle`이 이미 들어와 있다.
  - `commitBody(nextBody)`(L431~433) — 본문 변경 단일 choke point(`updateField('body')` + `updateField('title', bodyTitle(nextBody))`). **수정 금지**(phase 28 불변식).
  - **`autoCompanyCodeBody()`(L593~601)** — auto 모드에서 변환 후 `commitBody(nextBody)`하고 변환 본문 **문자열**을 반환(변화 없음/매핑/manual이면 `null`). ← 반환 shape 변경 대상.
  - **`saveDocument()`(L793~804)** — 기존 기사: `await save(autoBody)`. 신규: `draftFields = autoBody ? { ...tab.fields, body: autoBody } : { ...tab.fields }` → `saveDraft(key, draftFields, Date.now())` ← **stale title 지점**.
  - **`onAction(action)`(L1437~1458)** — L1453 `const autoBody = autoCompanyCodeBody();` → `await submit(action, autoBody)`.
  - 파일>복구 분기(L934~948) — 초안 복구 시 `title` 키는 **건너뛰고** body만 `commitBody`로 되살려 제목을 재파생한다. 이 동작은 **그대로 둔다**.
- `web/src/controller/useWriteController.test.jsx` — `describe('useWriteController — save/submit bodyOverride (phase43)')`(L618~), `describe('useWriteController — bodyOverride title 재파생 (phase45)')`(L675~). 문자열 오버라이드를 쓰는 기존 케이스 전부가 이 step의 갱신 대상이다.
- `web/src/view/WriterPage.test.jsx` — `describe('WriterPage — 자동 기업코드 변환(edit.companyCode=auto)')`(L7361~)이 실제 컨트롤러+fakeModel로 dto를 검사하는 **end-to-end 회귀 가드**다. 초안 저장소 파싱 헬퍼(L2027·L2374 근처 `JSON.parse(localStorage.getItem('yh.editorDrafts'))`)도 여기에 있다.

## 배경 (자기완결)

`commitBody`의 `setState`는 같은 tick에 `tabsRef`에 반영되지 않는다(effect 지연). 그래서 auto 변환 본문은 `save`/`submit`에 **명시 오버라이드**로 넘겨야 확실히 영속된다(phase 43). phase 45는 여기에 title 재파생을 추가했는데, 그 구현이 컨트롤러 안에서 `bodyTitle`을 부르는 방식이라 레이어 역행이 생겼다.

초안 경로는 오버라이드를 쓰지 않고 `tab.fields`를 직접 스냅샷하므로 **title만 변환 전 값**으로 남는다. 현재 복구 로직이 title을 무시하고 body에서 재파생하기 때문에 **사용자에게 보이는 증상은 없지만**, 저장된 스냅샷 자체가 자기모순이라 향후 소비자(초안 목록 표시 등)가 생기면 즉시 잘못된 제목을 보여준다. 같은 함수 안에서 3줄 거리에 있는 결함이므로 함께 고친다.

**기각한 대안**: `bodyTitle`을 "공용 순수 모듈"(예: `web/src/model/`)로 옮겨 양쪽이 참조하기. `bodyTitle`은 `view/editorContent.js`의 `deserialize`/`blocksToText`에 의존한다 — 옮기면 **model → view** import가 생겨 더 나쁜 역행이 된다. `editorContent.js`까지 옮기려면 프로덕션 20 + 테스트 20, 총 40개 파일의 import를 바꿔야 해서 미니 백로그 정리 범위를 크게 벗어난다. 반면 이 step의 방식은 파생 규칙을 뷰(단일 출처 `bodyTitle`)에 그대로 두고 컨트롤러를 **순수 dto/transport 조립**으로 되돌린다.

## TDD — 테스트 먼저

### `web/src/controller/useWriteController.test.jsx`

기존 문자열 오버라이드 케이스를 **객체 오버라이드**로 갱신하고(계약이 곧 테스트다), 아래를 red→green으로 확인한다.

1. `save({ body, title })` → `saveArticle` dto가 `markupVersion === body`, `title === title`.
2. `submit(action, { body, title })`(편집 PUT 경로·신규 create 경로 둘 다) → 동일.
3. **오버라이드 없음 회귀 가드**: `save()`·`saveAsNew()`·`saveMapping()`은 `tab.fields.title`/`tab.fields.body`를 그대로 싣는다(사용자가 편집한 title 보존).
4. **title 없는 오버라이드**: `save({ body })`(title 미전달)면 `dto.markupVersion`만 교체되고 `dto.title`은 `tab.fields.title` 그대로(문서화된 폴백 — 조용한 오류가 아니라 명시 계약).
4-a. **문자열 오버라이드는 미적용(계약 테스트)**: `save('변환된 본문')`처럼 옛 계약으로 부르면 **오버라이드가 무시되어** `dto.markupVersion === tab.fields.body`, `dto.title === tab.fields.title`이다(문자열을 body로 슬쩍 받아들이지 않는다). 이유: 반쪽 적용(본문만 바뀌고 제목은 stale)이 가장 발견하기 어려운 실패라서, 계약 위반은 **전부 아니면 전무**로 고정한다.
5. `articleId`·`role` 관련 기존 단언 불변(ADR-004: role은 어떤 경로에서도 dto에 실리지 않는다).

### `web/src/view/WriterPage.test.jsx`

6. **초안 title 동기화(신규 결함 수정)**: `edit.companyCode='auto'` + **신규 탭**(articleId 없음)에 `삼성전자\n본문`을 입력하고 파일>저장 → `localStorage`의 `yh.editorDrafts` 항목에서 `data.body`가 변환 본문이고 **`data.title === '삼성전자(005930)'`**(변환 전 '삼성전자'가 아님). 구현 전 red 확인 필수.
7. **기존 auto describe 전부 green 유지**(기존 기사 저장 PUT·송고 전이 저장·멱등·manual 미변환·타이핑 미변환) — 오버라이드 shape이 바뀌어도 dto 결과는 동일해야 한다.
8. 초안 복구(파일>복구)가 여전히 body에서 title을 재파생하는지 확인하는 기존 케이스 green 유지.

## 작업

### 1) 컨트롤러 — 오버라이드 계약 변경 + 뷰 import 제거

```js
// override(선택): 뷰가 저장/송고 직전에 만든 본문 교체 값. shape은 { body, title }.
//   body  — markupVersion으로 실린다.
//   title — 그 본문에서 뷰가 bodyTitle(단일 출처)로 파생한 제목. 미전달이면 tab.fields.title 유지.
// 컨트롤러는 제목 파생 규칙을 알지 않는다(뷰의 commitBody와 같은 출처를 쓰기 위함 — 이원화 금지).
function toSaveDto(tab, override) { ... }
const save = useCallback(async (override) => { ... }, [...]);
const submit = useCallback(async (action, override) => { ... }, [...]);
```

- `import { bodyTitle } from '../view/writerBody.js';`를 **삭제**한다(이 파일에 `../view/` import가 하나도 남지 않아야 한다).
- **오버라이드 자체의 판정은 타입까지 본다**: `const ov = override && typeof override === 'object' ? override : null;` 로 정규화한 뒤 `markupVersion: ov?.body ?? body`, `if (ov && ov.title != null) dto.title = ov.title;`. 이유: 이전 계약(문자열)으로 호출하는 코드가 남아 있으면 `'...'.body === undefined`라 **본문 교체가 조용히 무시되는** 최악의 무음 실패가 된다 — 문자열은 아예 "오버라이드 없음"으로 취급해 기존 `tab.fields`가 저장되게 하고, 아래 계약 테스트로 그 동작을 고정한다(호출부는 반드시 객체로 고친다).
- `dto.title` 대입 조건은 `ov && ov.body != null && ov.title != null`이다. **빈 문자열 `''`은 유효한 제목(본문 첫 줄이 비어 있음)이므로 반드시 통과시켜라**(`!= null` 사용, truthy 체크 금지).
- **`body` 없는 title-only 오버라이드(`{ title }`)는 title도 적용하지 않는다** — 4-a와 같은 "전부 아니면 전무" 원칙이다. 이유: 본문은 stale인데 제목만 교체되면 저장된 기사가 자기모순(제목 ≠ 본문 첫 줄)이 된다. 뷰의 유일한 생성부(`autoCompanyCodeOverride`)가 항상 두 필드를 함께 만들므로 정상 경로에서는 발생하지 않는 방어다.
- `saveAsNew`/`saveMapping`의 `toSaveDto(tab)` 호출은 그대로(오버라이드 없음).
- 나머지 계약(잠금 `clientId` 전달, `articleId` 유무에 따른 POST/PUT 분기, 반환 shape)은 **불변**.

### 2) 뷰 — 오버라이드 생성부/소비부

- `autoCompanyCodeBody()` → **`autoCompanyCodeOverride()`로 이름을 바꾸고** 반환을 `null | { body: nextBody, title: bodyTitle(nextBody) }`로 바꾼다(반환 shape이 바뀌었으므로 이름을 남겨두면 오독을 부른다). `isMapping`/`manual`/`changed===false` → `null`, `commitBody(nextBody)` 호출 위치·순서는 **불변**.
- `saveDocument()`:
  - 기존 기사: `const r = await save(auto);`(auto가 null이면 기존 동작 그대로).
  - 신규 기사: `const draftFields = auto ? { ...tab.fields, body: auto.body, title: auto.title } : { ...tab.fields };` → `saveDraft(...)`. **여전히 `save()`/POST를 부르지 않는다**(송고 전 DB 오염 금지 — 기존 계약).
- `onAction(action)`: `const auto = autoCompanyCodeOverride(); const r = await submit(action, auto);` — 나머지(제목/"(끝)" 가드, confirm, key/histTabId 캡처 타이밍)는 **불변**.
- 자동저장 타이머(L410~422)는 **건드리지 마라**(사용자 모르게 본문 변경 금지 — auto 변환은 명시 저장/송고에서만).

### 3) 주석

컨트롤러의 오버라이드 주석을 새 계약으로 갱신하고, "제목 파생은 뷰의 `bodyTitle` 단일 출처가 담당한다 — 컨트롤러는 뷰를 import하지 않는다(의존 방향 `View ← Controller ← Model`)"를 한 줄로 남겨라.

## Acceptance Criteria

```bash
npm run lint
npm run build
npm run test:web        # 87 files, 실패 0 (기준선 1944 pass + 신규 케이스)
npm test                # 620/620 green — 백엔드 무접촉 증명(step0 이후 기준선)
```

추가 확인(구조 검증):

```bash
grep -rn "\.\./view/" web/src/controller --include=*.js     # 결과 0줄이어야 한다(테스트 파일 제외)
```

`git diff --name-only`는 소스 2(`useWriteController.js`, `WriterPage.jsx`) + 테스트 2(`useWriteController.test.jsx`, `WriterPage.test.jsx`)여야 한다.

## 검증 절차

1. 위 AC 커맨드를 실행한다.
2. 구조 검증: 프로덕션 컨트롤러 파일(`web/src/controller/*.js`)에 `../view/` import가 **0건**임을 grep으로 확인한다(테스트 파일 `.test.jsx`의 뷰 헬퍼 import는 허용 — 테스트는 계층 규칙 대상이 아니다).
3. 변이 검증: `dto.title` 대입을 제거하면 컨트롤러 테스트 1·2와 WriterPage auto 저장 케이스가 red가 되는지 확인한다.
4. 아키텍처 체크리스트:
   - 제목 파생이 `bodyTitle` 단일 출처만 쓰는가?(컨트롤러·뷰 어디에도 `split('\n')[0]` 재구현이 없어야 한다)
   - `commitBody` 단일 choke point(phase 28 불변식)가 유지되는가?
   - ADR-004: dto에 `role` 등 신뢰 필드가 새로 실리지 않았는가?
5. `phases/49-mini-backlog-cleanup/index.json`의 step6을 갱신한다(`completed` + `summary` 등). `summary`에 **새 오버라이드 계약 `{ body, title }`**를 반드시 남겨라.

## 금지사항

- `bodyTitle`을 `web/src/model/`이나 새 디렉토리로 옮기지 마라. 이유: `bodyTitle`은 `view/editorContent.js`(deserialize/blocksToText)에 의존한다 — 옮기면 model→view 역행이 생기고, editorContent까지 옮기려면 40개 파일 import를 바꿔야 해서 이 phase의 범위를 벗어난다.
- 컨트롤러에 첫 줄 파싱(`split('\n')[0]`, `deserialize` 등) 로직을 새로 구현하지 마라. 이유: 제목 파생 단일 출처(`bodyTitle`)와 규칙이 갈라져 뷰(commitBody)와 저장 dto의 제목이 달라진다 — phase 28이 없앤 stale 제목 결함의 재발이다.
- 오버라이드를 문자열과 객체 둘 다 받는 하이브리드로 만들지 마라(`typeof override === 'string' ? { body: override } : override` 금지). 이유: 문자열 경로는 title이 빠진 채 통과해 phase 45의 수정을 조용히 되돌린다. 계약은 하나여야 하고, 위반은 무음 반쪽 적용이 아니라 "오버라이드 없음"으로 수렴해야 한다(테스트 4-a가 잠근다).
- `dto.title` 대입에 truthy 체크(`if (override.title)`)를 쓰지 마라. 이유: 본문 첫 줄이 비어 제목이 `''`인 경우가 정상 값이다 — truthy 체크면 그 케이스에서 stale 제목이 남는다.
- 신규(articleId 無) 경로에서 `save()`/POST를 부르지 마라. 이유: 송고 전에 DB에 draft 행이 생겨 DB가 오염된다(기존 계약·주석에 명시된 금지).
- 자동저장 타이머 경로에 auto 변환을 넣지 마라. 이유: "사용자 모르게 본문 변경 금지"(news.md 사용자 확정) — 변환은 명시 저장/송고 직전에만.
- 기존 테스트를 깨뜨리지 마라(기준: web 87 files / 1944 pass 이상, lint·build clean, 백엔드 620/620 green 유지).
