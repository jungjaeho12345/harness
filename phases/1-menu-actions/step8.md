# Step 8: frontend-history-view

우클릭 메뉴의 **이력보기(history)**·**송고이력보기(sendHistory)**를 동작하게 만든다. 클릭 시 해당 기사의 이력을 모달/새 창으로 보여준다. 이 step은 프론트엔드 View + Controller 레이어를 다룬다(같은 기능 응집 단위: 컨텍스트 메뉴 활성화 + 이력 조회/표시).

**핵심 전제:** 기존 기사에는 과거 이력이 없다(step0~2). 이력이 비면 "이력 없음"을 표시한다(오류 아님).

## 읽어야 할 파일

- `/docs/ADR.md` — ADR-003(View←Controller←Model·transport는 httpModel 뒤), ADR-005(데이터는 필요 시 재조회).
- `/docs/ARCHITECTURE.md` — 프론트엔드 MVC.
- `/docs/news.md` — 85행(이력보기/송고이력보기), 88행(현재 비활성 — 이 step이 활성화), 92행(데스크 미송고 메뉴에도 이력보기 있음), 103~106행(상세보기 새 창 패턴 — 이력 표시 UI 참고).
- step7 산출물: `web/src/model/contract.js`(`queryHistory`)·`web/src/model/httpModel.js`·`web/src/test/fakeModel.js`(`queryHistory(articleId, {sendOnly})`).
- 현재 구현(반드시 정독):
  - `web/src/view/ContextMenu.jsx` — `INACTIVE_ITEMS`(L11-19, `history`·`sendHistory` 포함)·`inactive(key)`(항상 enabled:false)·`buildContextMenuItems(menu, article, identity)`. **여기서 history/sendHistory를 활성화**한다.
  - `web/src/view/ListPage.jsx` — `onCtxSelect(key, article)`(L55-67, switch로 메뉴 동작 분기)·`openDetail(article)`(L25-30, 새 창 패턴)·컨텍스트 메뉴 결선(L157-166).
  - `web/src/controller/useViewController.js` — 우클릭 액션 핸들러 패턴(`releaseLock`·`requestDelete` — 확인창·model 호출·반환). **여기에 이력 조회 핸들러를 추가**한다.
  - 테스트 패턴: `web/src/view/ContextMenu.test.jsx`(메뉴 항목 활성/비활성 검증), `web/src/controller/useViewController.test.jsx`(fakeModel로 액션 검증), `web/src/view/ListPage.test.jsx`.

이전 코드를 정독하고, 우클릭 항목이 `buildContextMenuItems`→`ContextMenu`→`onCtxSelect`→컨트롤러로 흐르는 경로를 이해한 뒤 작업하라.

## 작업

### TDD 순서: 먼저 실패 테스트를 쓴다

1. **ContextMenu** `web/src/view/ContextMenu.test.jsx`: `history`·`sendHistory` 항목이 **활성(enabled:true)** 으로 나온다(기존엔 비활성). 데스크 미송고 메뉴(`deskUnsent`)에는 `history`가 활성, 부서별 작성/송고·개인별 수정에는 `history`·`sendHistory` 둘 다 활성.
2. **Controller** `web/src/controller/useViewController.test.jsx`: `loadHistory(article, { sendOnly })`가 `model.queryHistory`를 호출하고 items를 반환한다(fakeModel seed로 검증). 이력 없으면 빈 배열.
3. **ListPage**(선택): 우클릭 `이력보기` 선택 시 모달/창이 열리고 이력 행이 렌더된다(또는 컨트롤러 핸들러가 호출된다 — 렌더 방식에 맞춰).

먼저 실패를 확인한 뒤 구현한다.

### 구현 A: 컨텍스트 메뉴 활성화 `web/src/view/ContextMenu.jsx`

`history`·`sendHistory`를 `INACTIVE_ITEMS`/`inactive()`에서 빼고 **활성 항목으로 만들어라**:

- `deskUnsent` 메뉴: 기존 `inactive('history')`를 `{ key:'history', label:'이력보기', enabled:true }`로.
- 그 외 메뉴(deptWrite/deptSend/personal): `inactive('history')`·`inactive('sendHistory')`를 활성으로.
- `INACTIVE_ITEMS`에는 `translate`(step10에서 활성)·`mapping`(이번 phase 보류 — 비활성 유지)만 남고, `followUp`·`continue`·`resend`는 step9에서 활성화된다. **이 step에서는 history/sendHistory만 활성화하고 나머지는 건드리지 마라**(각 step이 자기 항목만 활성화 — 충돌 방지).
- 활성 조건: 이력은 모든 기사에서 볼 수 있으므로 권한/상태 게이트 없이 enabled:true(이력 조회는 읽기 전용·세션만 있으면 됨 — 서버가 인증 게이트).

### 구현 B: 컨트롤러 핸들러 `web/src/controller/useViewController.js`

`loadHistory(article, { sendOnly = false } = {})`를 추가하고 반환 객체에 노출하라:

```
const loadHistory = useCallback(async (article, { sendOnly = false } = {}) => {
  const r = await model.queryHistory(article.articleId, { sendOnly });
  return (r && r.items) || [];
}, [model]);
```

- 확인창은 필요 없다(읽기 동작).
- 모든 데이터는 `model.queryHistory` 경유(직접 fetch 금지 — ADR-003).

### 구현 C: 표시 UI `web/src/view/ListPage.jsx`

`onCtxSelect`에 `history`·`sendHistory` 케이스를 추가하라:

- `case 'history':` → `loadHistory(article)` 결과를 **모달 또는 새 창**으로 표시.
- `case 'sendHistory':` → `loadHistory(article, { sendOnly: true })` 결과 표시.
- 표시 방식은 둘 중 택1(주석으로 근거): (1) 기존 `openDetail`처럼 **새 창**에 이스케이프된 HTML로 이력 테이블 렌더(상세보기 패턴 재사용 — 모든 내용 HTML 이스케이프, 스크립트 실행 불가), 또는 (2) ListPage 내 **모달**(`showColModal` 패턴 재사용)로 이력 행 렌더. **권장: 모달**(컬럼 설정 모달과 동일 패턴이라 일관·테스트 쉬움). 이력 행 컬럼: 시각(createdAt, `formatDateTime` 사용)·종류(eventType/action)·전이(fromStatus→toStatus)·작성자(actorUserId).
- 새 창 방식을 택하면 **반드시 HTML 이스케이프**하라(news.md 106행 — 스크립트 미실행). actorUserId 등 사용자 입력 유래 값이 들어가므로 XSS 방어 필수.
- 이력이 비면 "이력이 없습니다" 안내를 표시한다.

## Acceptance Criteria

```bash
npm run lint
npm run build
npm test
npm run test:web
```

기존 테스트를 단 1개도 깨뜨리지 마라.

## 검증 절차

1. 위 AC 커맨드를 전부 실행한다.
2. 아키텍처 체크리스트:
   - `history`/`sendHistory`만 활성화하고 `followUp`/`continue`/`resend`/`translate`/`mapping`은 건드리지 않았는가? (step 분리)
   - 이력 데이터가 `model.queryHistory` 경유인가? 직접 fetch가 없는가? (ADR-003)
   - 새 창 방식이면 모든 표시 내용이 HTML 이스케이프되는가? (news.md XSS 방어)
   - 이력 없음이 "이력 없음" 안내로 graceful 표시되는가? (과거 데이터 없음 전제)
3. 결과에 따라 `phases/1-menu-actions/index.json`의 step 8을 업데이트한다(완료/error/blocked 양식 동일).

## 금지사항

- 이력 표시를 위해 직접 `fetch`를 호출하지 마라. 이유: ADR-003 — `model.queryHistory`만.
- 새 창/모달에 사용자 유래 값을 이스케이프 없이 넣지 마라. 이유: news.md 106행 — 스크립트 실행 방지(XSS).
- `followUp`/`continue`/`resend`/`translate`/`mapping` 메뉴 항목을 이 step에서 활성화하지 마라. 이유: 각 step이 자기 항목만 활성화한다 — 동시 수정은 충돌·실패 격리 불가.
- 이력이 없을 때 오류를 띄우지 마라. 이유: 기존 기사는 과거 이력이 없는 게 정상이다(step0 전제).
- 기존 테스트를 깨뜨리지 마라.
