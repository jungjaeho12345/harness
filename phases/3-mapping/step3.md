# Step 3: writer-page-mapping-ui

작성 페이지(`WriterPage`)에서 매핑 모드(`activeTab.mode === 'mapping'`)일 때 **본문 에디터를 readOnly로 잠그고, 메타 탭(이미지/영상/글기사) 임베드 추가는 활성, 액션바는 '저장' 버튼**으로 분기한다. 이 step은 **뷰 컴포넌트 한 모듈(`web/src/view/WriterPage.jsx`)** 만 다룬다. 컨트롤러 진입/저장 콜백(step 0)·버튼 규칙(step1)·진입 결선(step2)은 이미 완료됐다.

## 읽어야 할 파일

먼저 아래 파일들을 읽고 프로젝트의 아키텍처와 설계 의도를 파악하라:

- `/docs/ADR.md` — ADR-003(View는 Controller/Model 경유, 직접 fetch 금지).
- `/docs/news.md` — line 152~168(에디터: 본문은 텍스트/임베드 블록 markupVersion, 임베드 추가), line 199~203(편집 진입 매핑: 제목/본문/작성자/엠바고 입력란, 나머지 메타 읽기전용).
- `/web/src/view/WriterPage.jsx` — **이 step에서 수정할 파일.** 핵심 이해 포인트:
  - `useWriteController()`에서 `activeTab`(`.mode`/`.fields.body`/`.articleId`/`.status`/`.readOnly`), `updateField`, `submit`을 받는다. step 0에서 추가한 **매핑 저장 콜백(예: `saveMapping`)** 도 받아야 한다(구조분해에 추가).
  - `Editor` 컴포넌트는 `readOnly` prop을 받는다(`/web/src/view/Editor.jsx` line 60~130: `contentEditable={!readOnly}`, 임베드 × 버튼도 `readOnly`면 비활성). 즉 **readOnly를 true로 주면 텍스트 타이핑·"(끝)"·라인삭제·붙여넣기가 모두 막힌다.**
  - `onTextChange`/`onKeyDown`/`onRemoveEmbed`는 본문 텍스트 편집 콜백. 매핑에서는 텍스트 편집이 막혀야 하므로 `onTextChange`는 readOnly Editor에서 호출되지 않는다(Editor가 contentEditable=false라 input 이벤트가 안 난다). **별도로 매핑일 때 onTextChange/onKeyDown을 no-op으로 두는 방어를 둘지는 재량**이나, Editor readOnly만으로 텍스트 보존이 보장되는지 확인하라.
  - `insertEmbed(embed)` = `updateField('body', appendEmbedToBody(body, embed))` — 메타 탭에서 검색 결과를 본문에 임베드로 추가. **매핑에서도 이 경로는 활성이어야 한다**(임베드 추가가 매핑의 핵심).
  - 메타 탭: 공통정보(`CommonInfo`)·이미지/영상/글기사(`SearchPanel`). 매핑에서는 이미지/영상/글기사 검색·임베드 추가가 활성.
  - 액션바: `submitButtons({ mode, status, role, articleId })` 결과로 버튼을 그리고 `onAction(key)`로 송고/보류/KILL 처리. step1에서 매핑은 `['save']`를 반환한다 — `onAction`은 send/hold/kill만 처리하므로 **'save' 키 클릭은 매핑 저장 콜백(saveMapping)으로 분기**해야 한다.
- `/web/src/controller/useWriteController.js` — step 0에서 추가한 `mode:'mapping'`·매핑 저장 콜백(`saveMapping`) 시그니처/반환을 확인하라(읽기만, 수정 금지).
- `/web/src/view/writerButtons.js` — step1에서 `mode:'mapping'`→`['save']`, `SUBMIT_LABELS.save='저장'`(읽기만).
- `/web/src/view/Editor.jsx` — `readOnly` prop 동작(읽기만).
- `/web/src/view/writerBody.js` — `appendEmbedToBody`(텍스트 보존, 임베드만 추가).
- `/web/src/view/WriterPage.test.jsx` — WriterPage 통합 테스트(render + fakeModel/AppContext, 탭/에디터/메타탭/액션바 단언) 패턴. 이 파일에 매핑 케이스를 추가한다.

이전에 만들어진 코드를 꼼꼼히 읽고 설계 의도를 이해한 뒤 작업하라.

## 작업

TDD: **테스트를 먼저 작성**한 뒤 통과하는 구현을 작성한다.

`/web/src/view/WriterPage.jsx`에 매핑 모드 UI 분기를 추가한다.

핵심 결정(반드시 따른다):
1. **본문 에디터 readOnly:** `activeTab.mode === 'mapping'`이면 `Editor`에 `readOnly={true}`를 준다(`const isMapping = activeTab.mode === 'mapping'` 도출). 이로써 텍스트 타이핑/"(끝)"/라인삭제/붙여넣기가 모두 막히고 **본문 텍스트가 보존**된다. 임베드 × 삭제도 readOnly면 비활성된다(Editor/InlineEmbed가 readOnly 전파). 단 임베드 **추가**는 메타 탭의 `insertEmbed`로 별도 경로라 영향받지 않는다.
2. **메타 탭(이미지/영상/글기사) 활성:** 매핑에서도 이미지/영상/글기사 검색·`insertEmbed`(`appendEmbedToBody`)는 그대로 동작해야 한다 — 매핑의 목적이 임베드 추가다. 공통정보 탭은 표시하되, 매핑에서는 본문 텍스트를 안 건드리는 게 핵심이라 작성자/엠바고 입력은 기존대로 둬도 무방(재량 — 매핑 정의는 "텍스트 블록 미변경"이며 공통정보 메타 수정 자체는 매핑 범위 밖의 부수효과이니, 보수적으로 기존 동작 유지). **이미지/영상/글기사 탭 활성·임베드 추가 경로는 절대 막지 마라.**
3. **액션바 '저장' 버튼:** `submitButtons`가 매핑일 때 `['save']`를 반환한다(step1). 버튼 클릭 핸들러를 `key === 'save'`이면 **매핑 저장 콜백(`saveMapping`)** 을 호출하도록 분기한다. 송고/보류/KILL(`onAction`)의 제목·"(끝)" 가드·confirm은 매핑 저장에 적용하지 않는다(매핑은 전이 없음). 저장 확인창은 필요 시 '저장하시겠습니까?' 정도(재량) — 단 송고 가드(제목/"(끝)")는 넣지 마라.
4. **readOnly 보강(방어):** 매핑일 때 `onTextChange`가 혹시 호출돼도 본문 텍스트가 재구성되지 않도록, 매핑이면 `onTextChange`를 no-op으로 넘기거나 Editor가 readOnly라 onTextChange를 호출하지 않음을 테스트로 보장하라(둘 중 하나 — readOnly Editor는 input/composition 이벤트가 안 나므로 onTextChange 미호출이 정상).

구현(시그니처는 재량, 기존 구조 재사용):
- `const isMapping = activeTab.mode === 'mapping';` 도출.
- `<Editor ... readOnly={isMapping} />`.
- 액션바 버튼 클릭: 기존 `onClick={() => onAction(key)}`를 `onClick={() => (key === 'save' ? onSaveMapping() : onAction(key))}`(또는 동등) 형태로 분기. `onSaveMapping`은 `saveMapping` 호출 + (재량) confirm.
- 구조분해에 `saveMapping`(또는 step 0에서 채택한 이름)을 추가한다.

테스트(`WriterPage.test.jsx`에 케이스 추가 — fakeModel로 매핑 진입을 만들거나 sessionStorage PENDING_EDIT_KEY에 mode:'mapping'을 심어 render):
- 매핑 탭에서 Editor가 readOnly인지(예: `contentEditable=false` 또는 텍스트 입력이 반영 안 됨 — 기존 Editor.test 패턴 참고).
- 액션바에 '저장' 버튼만 있고 송고/보류/KILL이 없는지.
- 이미지/영상/글기사 메타 탭에서 검색 결과 클릭 시 본문에 임베드가 추가되고(`appendEmbedToBody` 경로), 저장된/현재 본문의 **텍스트 블록이 원본과 동일**(blocksToText 불변)한지.
- '저장' 클릭 시 매핑 저장 콜백(`saveMapping`)이 호출되는지(송고/applyAction 아님).
- 일반 편집('edit')·신규('new') 모드에서 Editor가 여전히 편집 가능하고 송고/보류 버튼이 뜨는지(무회귀).

## Acceptance Criteria

```bash
npm run lint
npm run build
npm run test:web
```

## 검증 절차

1. 위 AC를 실행한다. 기존 web 테스트 + 신규 테스트가 모두 통과해야 한다(무회귀).
2. 아키텍처 체크리스트:
   - 매핑 모드에서 Editor가 readOnly로 본문 텍스트가 보존되는가?
   - 이미지/영상/글기사 임베드 추가(`insertEmbed`/`appendEmbedToBody`)가 매핑에서도 활성인가?
   - 액션바가 '저장' 단일 버튼이고 클릭이 매핑 저장 콜백으로 가는가(송고/applyAction 아님)?
   - 일반 편집/신규 모드가 무회귀인가?
   - View가 Controller/Model 경유만 하는가(직접 fetch 금지, ADR-003)?
3. `phases/3-mapping/index.json`의 step 3을 업데이트(completed + summary: isMapping 분기·Editor readOnly·'저장' 버튼 결선·임베드 추가 활성·텍스트 보존 확인). 실패 시 error, 개입 필요 시 blocked.

## 금지사항

- 매핑 모드에서 본문 에디터를 편집 가능하게 두지 마라(readOnly 누락). 이유: 매핑은 본문 텍스트를 건드리지 않는다 — 편집 가능하면 텍스트가 바뀌어 보존이 깨진다.
- 매핑 '저장' 버튼에 송고 가드(제목 검증·"(끝)" 검증)나 `onAction`(send/hold/kill)·`applyAction`을 연결하지 마라. 이유: 매핑은 생애주기 전이가 아니라 임베드 추가 PUT이다.
- 이미지/영상/글기사 메타 탭의 검색·임베드 추가(`insertEmbed`) 경로를 막지 마라. 이유: 임베드 추가가 매핑의 핵심 기능이다.
- 직접 fetch/EventSource를 호출하지 마라(ADR-003). 검색·저장은 useSearchController·useWriteController(saveMapping) 경유.
- `useWriteController.js`/`writerButtons.js`/백엔드를 수정하지 마라. 이유: 진입·저장 콜백은 step 0, 버튼 규칙은 step1에서 완료됐다 — 이 step은 뷰 결선만이다.
- 기존 테스트를 깨뜨리지 마라.
