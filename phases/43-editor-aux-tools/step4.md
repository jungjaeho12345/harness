# Step 4: company-code-save-override

컨트롤러 `save`/`submit`에 **선택적 body 오버라이드**를 추가한다(가산적·하위호환). 자동 기업코드 변환(step 5)이 저장·송고 직전에 변환한 본문을 컨트롤러가 그대로 영속하도록 하는 전용 통로다. 이 step은 컨트롤러 계층만 — view 결선은 step 5.

## 배경(왜 필요한가)

- `save`/`submit`은 `tabsRef.current`(effect로 동기화되는 미러 ref)에서 본문을 읽는다(`useWriteController.js` L277·L314). `tabsRef.current = tabs`는 `useEffect`(L162)로 갱신되므로, view가 같은 tick에 `commitBody`(→`updateField`→`setTabs`)로 변환 본문을 커밋해도 **그 tick의 `save`/`submit`은 변환 전 본문을 읽는다(stale)**. 따라서 자동 변환 본문을 확실히 영속하려면 view가 변환 결과를 **명시 인자로 전달**해야 한다(재렌더 flush 의존 금지 — phase 20·36 stale 교훈).

## 읽어야 할 파일

- `/docs/ADR.md`, `/docs/ARCHITECTURE.md` — Model←Controller←View, 얇은 통로, 의존성 주입.
- `web/src/controller/useWriteController.js`:
  - `toSaveDto(tab)`(L57-64): `const { body, ...rest } = tab.fields; const dto = { ...rest, markupVersion: body }; ...`. **body 오버라이드를 여기서 반영**한다.
  - `save`(L276-284): `model.saveArticle(toSaveDto(tab), tab.clientId)`.
  - `submit`(L313-332): 신규 경로 `model.saveArticle(toSaveDto(tab), tab.clientId, action)`; 편집 경로 `model.saveArticle(toSaveDto(tab), tab.clientId)` 후 `model.applyAction(...)`.
  - `saveMapping`(L300-309) — **오버라이드 대상 아님**(매핑=본문-only 불변식, 텍스트 변환 금지).
  - `tabsRef`(L160-162), `activeRef`(L161-163).
- (테스트 선례) `web/src/controller/useWriteController.test.*`(있으면) — fakeModel 주입 패턴. 없으면 이 프로젝트의 컨트롤러 훅 테스트 관례(@testing-library/react `renderHook` + in-memory fake `model`)를 따른다.

## 작업

### 1. `toSaveDto(tab, bodyOverride)` — 선택 인자

- 시그니처: `function toSaveDto(tab, bodyOverride)`. 본문은 `markupVersion: bodyOverride ?? body`. 즉 `bodyOverride`가 `undefined`/`null`이면 기존 동작 그대로(하위호환), 문자열이면 그 값으로 싣는다.

### 2. `save(bodyOverride)` — 선택 인자

- 시그니처: `const save = useCallback(async (bodyOverride) => { ... }, [model])`. 내부 `toSaveDto(tab)` → `toSaveDto(tab, bodyOverride)`. 신규 POST 성공 시 articleId 바인딩 로직은 불변.

### 3. `submit(action, bodyOverride)` — 선택 인자

- 시그니처: `const submit = useCallback(async (action, bodyOverride) => { ... }, [model, resetTabToBlank])`. 신규 경로·편집 경로의 `toSaveDto(tab)` 두 곳을 `toSaveDto(tab, bodyOverride)`로 바꾼다. 나머지(전이·unlock·resetTabToBlank)는 불변.

## 반드시 지킬 핵심 규칙

- **가산적·하위호환**: `bodyOverride` 미전달 시 동작이 기존과 **완전히 동일**해야 한다(기존 컨트롤러 테스트 회귀 0). 이유: 기존 호출부(파일>저장·송고 수동/manual 모드)는 인자 없이 그대로 호출한다.
- **DB 비파괴**: 오버라이드는 `markupVersion`(본문) 저장 값만 바꾼다. 행 삭제·비멱등 마이그레이션·다른 필드 변경 금지.
- **신뢰 경계 불변**: `role`은 어디서도 DTO에 싣지 않는다(ADR-004 — 기존 `toSaveDto` 계약 유지). `bodyOverride`는 본문 문자열일 뿐 권한과 무관.
- **saveMapping은 건드리지 않는다**: 매핑은 텍스트 잠금이라 기업코드 변환 대상이 아니다.

## Acceptance Criteria

```bash
npm run lint
npm run build
npm run test:web
```

## 검증 절차

1. 위 AC 커맨드를 실행한다.
2. 테스트(작성/보강, fakeModel 주입):
   - `save('오버라이드본문')` 호출 시 `fakeModel.saveArticle`가 `markupVersion: '오버라이드본문'`으로 호출된다.
   - `save()`(인자 없음)는 기존대로 `tab.fields.body`를 `markupVersion`으로 싣는다(하위호환).
   - `submit('send', '오버라이드본문')`(편집/신규 각각) 시 `saveArticle`가 오버라이드 본문으로 호출된다; `submit('send')`는 기존대로.
   - 프로덕션 `news.db` 미바인딩(in-memory fake만).
3. 아키텍처 체크: 변경은 `useWriteController.js`(toSaveDto/save/submit)에 국한. 얇은 통로 유지(비즈니스 로직 누수 없음).
4. `phases/43-editor-aux-tools/index.json`의 step 4를 갱신한다.

## 금지사항

- `saveMapping`에 오버라이드를 추가하지 마라. 이유: 매핑은 본문-only 불변식(텍스트 변환 금지).
- view(WriterPage) 결선을 이 step에 넣지 마라. 이유: 계층 분리 — view 결선은 step 5.
- `bodyOverride` 미전달 경로의 동작을 바꾸지 마라. 이유: 하위호환 필수(기존 저장/송고 회귀 방지).
- 프로덕션 DB에 바인딩하는 테스트를 쓰지 마라. 이유: 격리(in-memory 주입) 필수.
- 기존 테스트를 깨뜨리지 마라(web 1753 기준).
