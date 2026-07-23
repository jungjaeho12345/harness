# Step 5: company-code-auto

자동 기업코드 변환을 결선한다. `edit.companyCode === 'auto'`일 때 **명시 저장(파일>저장/저장 버튼)과 송고/보류 직전**에 본문을 일괄 변환한다(화면 반영·undo 가능). **자동저장 타이머·타이핑 커밋에는 적용하지 않는다.**

## 읽어야 할 파일

- step 1 산출물: `web/src/view/companyCodeConvert.js`(`convertCompanyCodeInBlocks`).
- step 4 산출물: `web/src/controller/useWriteController.js` — `save(bodyOverride)`, `submit(action, bodyOverride)`(오버라이드 통로).
- `web/src/view/WriterPage.jsx`:
  - `saveDocument`(~706행): 기존 기사(`tab.articleId`)는 `await save()`; 신규는 `saveDraft(tab.articleId || tab.id, { ...tab.fields }, ...)`. **여기 자동 변환을 끼운다.**
  - `onAction`(~1315행): 가드(제목·"(끝)") → `window.confirm` → `const r = await submit(action);`. **confirm 통과 후, submit 직전에** 변환한다("직전에").
  - `commitBody`(~386행): `updateField('body', ...)` + 제목 재동기화 + 히스토리 캡처. 화면 반영·undo 단계는 이 경로로.
  - `blocks`(~271행) = `deserialize(body)` — 렌더 클로저. 핸들러 진입 시점의 `blocks`는 **현재 커밋된 최신 본문**이다(핸들러 안에 변환 전 async op가 없으므로 stale 아님). 변환은 이 `blocks`에서 파생한다.
  - 자동저장 타이머(~366-377행): `saveDraft(key, { ...tab.fields }, Date.now())` — **여기는 절대 변환하지 않는다**.
  - `insertDate`(~478행): `loadEditorPrefs().dateFormat` 액션 시점 읽기 관례(동형으로 `edit.companyCode`를 읽는다).
- `web/src/view/editorPrefs.js` — `loadEditorPrefs().edit.companyCode`(기본 `'manual'`, `'manual'|'auto'`)는 이미 존재·영속.

## 작업

공통 헬퍼(예: 로컬 함수 `autoCompanyCodeBody()`)를 두어 중복을 줄여도 좋다: 최신 `blocks`에서 `convertCompanyCodeInBlocks`를 적용, `changed`면 변환 본문(`serialize(r.blocks)`)을, 아니면 `null`을 반환.

### 1. `saveDocument` 자동 변환

- 함수 시작에서 `const auto = loadEditorPrefs().edit.companyCode === 'auto';`를 읽는다.
- `auto`이고 변환 결과가 `changed`이면:
  - `commitBody(convertedBody)` — 화면 반영 + undo 단계 생성.
  - 기존 기사 경로: `await save(convertedBody)`(오버라이드로 변환 본문 영속 — commitBody의 setState가 같은 tick에 tabsRef에 반영 안 되는 stale 회피).
  - 신규 경로: `saveDraft(tab.articleId || tab.id, { ...tab.fields, body: convertedBody }, Date.now())`(초안에도 변환 본문 — `{...tab.fields}`는 stale이므로 body만 명시 오버라이드).
- `auto`가 아니거나 변화 없음이면 기존 동작 그대로.

### 2. `onAction` 자동 변환(송고/보류)

- 가드(제목/"(끝)")와 `window.confirm` **통과 후**, `submit(action)` **직전에**:
  - `auto`이고 `changed`이면 `commitBody(convertedBody)` 후 `const r = await submit(action, convertedBody);`
  - 아니면 기존대로 `const r = await submit(action);`
- 이후 `if (r && r.ok) { clearDraft(key); historiesRef.current.delete(histTabId); }`는 불변.
- 가드는 변환 전 `blocks`/`body` 기준으로 평가해도 무방하다(기업코드 변환은 제목 첫 줄·"(끝)" 존재를 바꾸지 않는다). 순서는 "가드 → confirm → 변환 → commit → submit(override)".

## 반드시 지킬 핵심 규칙

- **자동저장/타이핑 제외**: autosave 타이머와 `onTextChange`(타이핑 커밋)에는 절대 자동 변환을 넣지 마라. 이유: 사용자 모르게 본문을 바꾸면 안 된다(사용자 확정 결정 3). 자동 변환은 명시 저장·송고/보류에서만.
- **최신 본문에서 파생·stale 회피**: 변환은 핸들러 진입 시점의 `blocks`(최신 커밋 본문)에서 파생한다. `commitBody` 후 `save/submit`이 `tabsRef`에서 읽는 값은 같은 tick에 stale이므로, 반드시 **변환 본문을 오버라이드 인자로 명시 전달**한다(step 4 통로). 재렌더 flush에 의존하지 마라(phase 20·36).
- **멱등 의존**: 이미 변환된 본문을 다시 저장/송고해도 `changed:false`라 no-op이어야 한다(step 1 멱등성). commitBody도 `changed`일 때만 호출해 불필요한 dirty/undo 단계를 만들지 마라.
- **매핑 제외**: 매핑 모드에서는 자동 변환하지 마라(본문-only 불변식). saveDocument/onAction의 자동 변환 분기에 `!isMapping` 가드를 두거나, 매핑에서 애초에 이 경로가 텍스트를 바꾸지 않도록 한다.
- **설정은 액션 시점 읽기**: `edit.companyCode`를 `useState`+마운트 effect로 미러링하지 마라. 이유: 저장/송고 순간에만 필요 — `insertDate`의 `dateFormat` 액션 시점 읽기와 동형. 게이트는 죽은 코드.

## Acceptance Criteria

```bash
npm run lint
npm run build
npm run test:web
```

## 검증 절차

1. 위 AC 커맨드를 실행한다.
2. 신규 테스트(작성, fakeModel 주입):
   - **auto + 저장(기존 기사)**: `edit.companyCode='auto'`, 본문 '삼성전자 발표'. 저장 클릭 → `saveArticle`가 `markupVersion` '삼성전자(005930) 발표'로 호출되고, 화면 본문도 변환된다(commitBody 반영).
   - **auto + 송고**: 송고 클릭(confirm 승인) → `submit`이 변환 본문으로 저장/전이한다.
   - **manual 모드**: `edit.companyCode='manual'`이면 저장/송고 시 본문이 변환되지 않는다(오버라이드 없이 원문 저장).
   - **자동저장 타이머 제외**: auto 모드라도 autosave 타이머가 도는 저장(초안)에는 변환이 적용되지 않는다(saveDraft 본문이 원문). (타이머 테스트가 어려우면 최소한 코드 경로상 타이머가 변환 헬퍼를 호출하지 않음을 단언.)
   - **멱등**: 이미 '삼성전자(005930)'인 본문을 auto로 다시 저장 → 이중 감쌈 없음, 추가 undo 단계 없음(changed:false).
   - **매핑 제외**: 매핑 모드 저장/송고 경로에서 자동 변환이 텍스트를 바꾸지 않는다.
3. 기존 저장/송고 테스트 회귀 0(manual 기본값 기준 — 기존 테스트는 대부분 companyCode 미설정=manual).
4. 아키텍처 체크: 변경은 WriterPage.jsx(saveDocument/onAction/헬퍼/import)에 국한. 컨트롤러 오버라이드(step4)만 소비.
5. `phases/43-editor-aux-tools/index.json`의 step 5를 갱신한다.

## 금지사항

- 자동저장 타이머·`onTextChange`(타이핑)에 자동 변환을 넣지 마라. 이유: 사용자 모르게 본문 변경 금지.
- `commitBody` 후 `save/submit`을 인자 없이 호출해 변환 본문 영속을 재렌더에 맡기지 마라. 이유: `tabsRef` stale로 변환 전 본문이 저장된다(오버라이드 명시 전달 필수).
- `edit.companyCode` 소비에 마운트 effect/게이트를 추가하지 마라. 이유: 액션 시점 읽기로 충분(죽은 코드 회피).
- 매핑 모드에서 본문을 변환하지 마라. 이유: 본문-only 불변식.
- 기존 테스트를 깨뜨리지 마라(web 1753 기준).
