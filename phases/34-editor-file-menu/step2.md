# Step 2: file-save

파일 메뉴의 **저장(`file.save`)** 과 **다른이름으로 저장(`file.saveAs`)** 을 결선한다. 저장은 **기사 상태(기존/신규)에 따라 갈린다** — 기존 기사는 서버 PUT 수정, 신규는 로컬 초안(draft)만. 다른이름으로 저장은 현재 본문을 **새 기사로 POST(복제본)** 한다. 서버/DB 스키마 변경 0 — 기존 엔드포인트(`saveArticle`)만 재사용한다.

## 확정된 설계 결정 (이대로 못박아라)

1. **저장(`file.save`)**:
   - **기존 기사(`activeTab.articleId` 有)** → 컨트롤러 `save()` 호출 → `model.saveArticle(dto, clientId)`가 **PUT 부분 수정**(잠금 보유자). 상태 전이·잠금 해제·탭 리셋 **없이 편집을 이어간다**(save()의 기존 계약 그대로).
   - **신규 기사(`activeTab.articleId` 無)** → **`editorDraft.saveDraft`로 로컬 초안만 저장(DB 미생성)**. 절대 `save()`/`model.saveArticle`을 부르지 마라 — 신규를 POST하면 송고 전 DB에 draft 행이 생겨 DB를 오염시킨다(파일>복구가 이 초안을 되살린다).
2. **다른이름으로 저장(`file.saveAs`)** = 현재 본문/공통정보를 **articleId 없이 POST** → 서버가 새 AKR articleId를 발번한 **복제본** 생성. **현재 탭의 `articleId`는 재바인딩하지 않는다**(원본 편집 세션·잠금을 그대로 유지 — '복제본'이라 현재 문서 정체성을 바꾸지 않는다).

> 참고: `save()`(L271-279)는 articleId 유무로 POST/PUT을 자동 분기하므로, **신규 탭에서 그대로 부르면 POST가 나간다**. 그래서 `file.save`의 신규 분기는 `save()`를 **부르지 않고** `saveDraft`만 쓴다. 이 분기 판단은 `WriterPage`가 `activeTab.articleId`로 한다.

## 읽어야 할 파일

- `docs/ARCHITECTURE.md`, `docs/ADR.md`(ADR-003 view→controller, ADR-004 role은 서버 세션에서 도출 — dto에 role 미포함).
- `docs/news.md` L181(저장, 다른이름으로 저장), L199-(자동저장/복구 문맥).
- `web/src/controller/useWriteController.js`:
  - `save()` L271-279 — `model.saveArticle(toSaveDto(tab), tab.clientId)`. 신규는 POST(성공 시 새 탭에 articleId 바인딩), 편집은 PUT. **전이/unlock/reset 없음**.
  - `toSaveDto(tab)` L59-64 — `{ ...fields(body→markupVersion) }`, `tab.articleId` 있으면 dto.articleId 포함. role 미포함(ADR-004).
  - `submit`/`saveMapping`(L297-316/L284-293) — 전이·unlock을 하는 경로. **file.save/saveAs는 이 경로가 아니다**(전이·리셋 없음)임을 대조 확인.
  - 반환 객체(공개 API) L388-393 — 현재 `save`는 이미 노출됨. `saveAsNew`(신규)를 여기에 additive로 추가할 것.
  - `useCallback`/`tabsRef.current`/`activeRef.current` 패턴(콜백이 최신 활성 탭을 읽는 방식) — `saveAsNew`도 동형으로 작성.
- `web/src/model/httpModel.js` `saveArticle(dto, clientId, action)` L157-163 — `dto.articleId` 있으면 PUT, 없으면 POST(`{ ok, articleId }` 반환).
- `web/src/view/editorDraft.js` — `saveDraft(key, data, nowMs)` L27(localStorage `yh.editorDrafts`). 시간은 호출자가 `Date.now()`로 주입. 파일>복구(WriterPage L600-609)가 `key = tab.articleId || tab.id`로 이 초안을 읽는다.
- `web/src/view/WriterPage.jsx`:
  - L104-108 컨트롤러 구조분해 — **현재 `save`가 빠져 있다. `save`(그리고 추가할 `saveAsNew`)를 구조분해에 추가**하라.
  - L43 `saveDraft`/`loadDraft`/`clearDraft` import(이미 있음), L215 `body`, L535-691 `onMenuSelect`, L598 `isMapping` 가드, L600-609 `file.recover`(초안 key 규약 참고).
  - L93 `MENU_ENABLED`.
- `web/src/view/WriterPage.test.jsx`, `web/src/controller/useWriteController.test.js`(또는 상응 컨트롤러 테스트) — fakeModel 주입 + `saveArticle` 호출 기록 패턴을 재사용.
- **이전 step 산출물**: step0/step1이 `MENU_ENABLED`/`onMenuSelect`에 file 계열 id를 추가했을 수 있다 — 기존 항목을 제거하지 말고 네 id만 추가하라.

## 작업 (TDD — 실패하는 테스트부터)

### 1) `web/src/controller/useWriteController.js` — `saveAsNew` 추가(additive)

기존 `save`/`submit` 아래에 `useCallback`으로 추가한다. 시그니처: `saveAsNew(): Promise<{ ok, articleId?, ... }>`.

- 현재 활성 탭을 `tabsRef.current`/`activeRef.current`로 찾는다(`save`와 동형).
- `toSaveDto(tab)`에서 **`articleId`를 제거**한 dto를 만들어(`const { articleId, ...dto } = toSaveDto(tab);`) `model.saveArticle(dto)`를 호출한다 → articleId 없으니 **POST(새 발번)**.
  - 편집 잠금 `clientId`는 **넘기지 마라**(새 기사는 잠금 대상이 아니다 — 원본 잠금과 무관).
- **현재 탭의 `articleId`/`clientId`를 절대 변경하지 마라**(복제본 생성이지 현재 문서 정체성 전환이 아니다). `save`가 신규 POST 성공 시 탭에 articleId를 바인딩하는 것과 **다르다**.
- 결과 객체(`{ ok, articleId }`)를 그대로 반환(호출자 피드백용).
- 반환 객체(공개 API)에 `saveAsNew`를 추가한다.

### 2) `web/src/view/WriterPage.jsx`

1. 구조분해(L104-108)에 **`save`, `saveAsNew`** 추가.
2. 저장 헬퍼(결정 1):

   ```jsx
   const saveDocument = async () => {
     const tab = activeTab;
     if (tab.articleId) {
       const r = await save();                                   // 기존 → PUT(전이/unlock 없음)
       window.alert(r && r.ok ? '저장되었습니다.' : '저장에 실패했습니다.');
     } else {
       saveDraft(tab.articleId || tab.id, { ...tab.fields }, Date.now()); // 신규 → 로컬 초안만(DB 미생성)
       window.alert('임시 저장했습니다. (송고 전에는 DB에 생성되지 않으며, 파일>복구로 되살릴 수 있습니다.)');
     }
   };
   ```

   - 초안 key는 **`tab.articleId || tab.id`**(신규는 `tab.id`) — 자동저장·파일>복구와 동일 key 규약이라 복구로 되살릴 수 있다.
3. 다른이름 저장 헬퍼(결정 2):

   ```jsx
   const saveAsDocument = async () => {
     const r = await saveAsNew();
     window.alert(r && r.ok && r.articleId
       ? `새 기사로 저장했습니다: ${r.articleId}`
       : '다른 이름으로 저장에 실패했습니다.');
   };
   ```

4. `MENU_ENABLED`에 `'file.save'`, `'file.saveAs'` 추가(기존 id 유지).
5. `onMenuSelect`에서 **`isMapping` 가드(L598) 뒤**에 분기 추가:
   - `if (id === 'file.save') { saveDocument(); return; }`
   - `if (id === 'file.saveAs') { saveAsDocument(); return; }`
   - 배치 이유(못박음): 매핑 모드는 임베드 전용 편집이며 **자체 '저장' 버튼(saveMapping — 저장+unlock+리셋)** 을 가진다. 파일 메뉴 save/saveAs를 매핑에서 동작시키면 잠금/리셋 의미가 이원화된다. 따라서 매핑에서는 no-op(가드 뒤)로 두어 매핑의 전용 저장 흐름과 충돌하지 않게 한다(편집 op들이 가드 뒤에 있는 것과 동일 위치). `saveDocument`/`saveAsDocument`는 async이지만 `onMenuSelect`는 fire-and-forget으로 호출한다(`openHistoryCompare` 패턴).

### 테스트

**컨트롤러 테스트(`useWriteController`):** fakeModel 주입.

- `saveAsNew` 호출 시 `model.saveArticle`가 **articleId 없는 dto**(=POST)로 불림 단언(기존 편집 탭이라도 dto에서 articleId 제거).
- `saveAsNew` 후에도 **현재 활성 탭의 `articleId`가 변하지 않음** 단언(복제본이 현재 탭을 하이재킹하지 않음).
- `saveAsNew`가 fakeModel의 `{ ok, articleId }`를 그대로 반환함 단언.

**`web/src/view/WriterPage.test.jsx`:** fakeModel + `saveArticle`/`saveDraft` 관찰.

- **file.save(기존 탭)**: `articleId`를 가진 편집 탭에서 '저장' 클릭 → `saveArticle`가 **PUT(dto.articleId 포함)** 로 불림, 상태 전이/unlock/탭 리셋 없음 단언(탭이 그대로 남음).
- **file.save(신규 탭)**: `articleId` 없는 새 탭에서 본문을 넣고 '저장' 클릭 → **`model.saveArticle`가 호출되지 않고**(POST 금지), localStorage `yh.editorDrafts`에 `tab.id` key로 초안이 저장됨 단언(핵심 — DB 미오염). 파일>복구로 되살아나는 경로와 key 일치도 확인.
- **file.saveAs**: '다른이름으로 저장' 클릭 → `saveArticle`가 articleId 없는 dto(POST)로 불림 + 현재 탭 articleId 불변 단언.
- (선택) 실패 응답(`{ ok:false }`)에서 실패 alert 경로가 동작함 단언.

## Acceptance Criteria

```bash
npm run lint
npm run build
npm run test:web
```

(백엔드 무관 — `npm test` 불필요. 서버/DB는 건드리지 않는다.)

## 검증 절차

1. 위 AC 커맨드를 실행한다.
2. 아키텍처 체크리스트:
   - `web/src/view/Editor.jsx`·`server/`·DB 스키마가 diff에 없는가?(기존 `saveArticle` 엔드포인트만 재사용)
   - 신규 탭 file.save가 **POST를 내지 않는가**?(DB 비파괴/미오염 — 이 phase의 핵심 규칙)
   - `saveAsNew`가 현재 탭 articleId를 바꾸지 않는가?
   - dto에 role이 실리지 않는가?(ADR-004 — `toSaveDto`가 이미 role을 제외; 새 코드가 추가하지 않았는지 확인)
   - `MENU_ENABLED`에서 기존 id(step0/step1 포함)가 제거되지 않았는가?
   - CLAUDE.md 준수(UTF-8·DB 비파괴·ADR-003).
3. 결과에 따라 `phases/34-editor-file-menu/index.json`의 step2를 업데이트한다:
   - 성공 → `"status": "completed"` + `"summary"`(신규 `saveAsNew`·file.save 기존/신규 분기·초안 key·POST 금지 회귀 테스트).
   - 실패/blocked 처리는 step0과 동일 규약.
4. top-level `phases/index.json`의 34 상태는 execute.py가 관리한다.

## 금지사항

- 신규 탭(`articleId` 無)의 `file.save`에서 `save()`/`model.saveArticle`을 부르지 마라. 이유: articleId 없는 저장은 POST라 송고 전 DB에 draft 행이 생겨 DB를 오염시킨다 — 신규는 `saveDraft`(localStorage)만 써야 한다(결정 1).
- `saveAsNew`가 현재 탭의 `articleId`/`clientId`를 재바인딩하게 하지 마라. 이유: '다른이름으로 저장'은 복제본 생성이지 현재 문서의 정체성 전환이 아니다. 재바인딩하면 원본 편집 세션/잠금이 새 기사로 넘어가 데이터·잠금 정합성이 깨진다.
- `file.save`/`file.saveAs`를 `submit`/`applyAction`/`saveMapping` 경로로 라우팅하지 마라. 이유: 저장은 상태 전이·잠금 해제·탭 리셋이 없어야 한다(편집 유지). 전이 경로를 쓰면 저장만 하려던 사용자의 편집 세션이 종료된다.
- dto에 `role`을 싣지 마라. 이유: acting role은 서버 세션에서만 도출한다(ADR-004) — 클라이언트 role은 신뢰 경계 밖이다.
- DB 행을 삭제하거나 스키마를 바꾸지 마라(멱등·additive 원칙). 이유: DB 비파괴는 프로젝트 불변 규칙이다.
- `web/src/view/Editor.jsx`·`server/`를 건드리지 마라.
- `MENU_ENABLED`에서 기존 결선 id를 제거하지 마라. 기존 테스트를 깨뜨리지 마라.
