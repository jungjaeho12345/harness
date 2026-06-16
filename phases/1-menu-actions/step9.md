# Step 9: frontend-derive-resend-wiring

우클릭 메뉴의 **후속기사작성(followUp)**·**계속기사작성(continue)**·**재송(resend)**을 동작하게 만든다. 이 step은 프론트엔드 View + Controller 레이어를 다룬다(컨텍스트 메뉴 활성화 + 액션 핸들러).

- **followUp/continue**: 백엔드 `deriveArticle`(step3·4)로 새 기사를 만든 뒤, 그 새 기사로 **writer.do 편집 진입**한다(기존 편집 진입 패턴 재사용).
- **resend**: 이미 송고된 **DPS 기사를 다시 송고**한다. 생애주기상 DPS+send는 DPS 유지(재송고 — news.md 217행, `lifecycle.transition`에 이미 존재). 따라서 `model.applyAction(articleId, 'send')`를 재사용한다(신규 백엔드 불필요).

## 읽어야 할 파일

- `/docs/ADR.md` — ADR-003(View←Controller←Model), ADR-004(role은 서버 세션 도출 — applyAction에 role 미전송).
- `/docs/ARCHITECTURE.md` — 프론트엔드 MVC.
- `/docs/news.md` — 85행(후속/계속기사작성·재송 메뉴), 88행(현재 비활성), 206~217행(생애주기 — DPS send=DPS 재송고·신규 RDS), 199~201행(편집 진입 매핑), 72행(송고는 본문 "(끝)" 필요 — 재송도 동일 가드, 서버가 강제).
- step3/4 산출물: 백엔드 `deriveArticle` + `POST /api/articles/:id/derive`.
- step7 산출물: `web/src/model/*`(`deriveArticle`)·기존 `applyAction`.
- 현재 구현(반드시 정독):
  - `web/src/view/ContextMenu.jsx` — `INACTIVE_ITEMS`(`followUp`·`continue`·`resend` 포함)·`buildContextMenuItems`. **여기서 이 3개를 활성화**(상태/권한 게이트 결정 — 아래 참조).
  - `web/src/view/ListPage.jsx` — `onCtxSelect`(switch 분기)·컨텍스트 메뉴 결선.
  - `web/src/controller/useViewController.js` — `enterEditor(article, mode)`(L102-109, sessionStorage `pendingEdit` + `navigate('writer.do', {articleId})`)·`editArticle`/`reviseArticle`(편집 진입)·`requestDelete`(확인창+applyAction 패턴)·`canManage`. **여기에 followUp/continue/resend 핸들러 추가.**
  - `web/src/controller/useWriteController.js` — `openArticle`(편집 진입 시 단건 재조회·잠금 획득)·`pendingEdit` 소비. **후속/계속 진입 시 새 기사를 어떻게 writer가 받는지** 확인.
  - 테스트 패턴: `web/src/view/ContextMenu.test.jsx`·`web/src/controller/useViewController.test.jsx`.

이전 코드를 정독하고, 편집 진입(enterEditor→pendingEdit→openArticle)과 생애주기 재송고 경로를 이해한 뒤 작업하라.

## 작업

### 활성 조건(결정 — 주석으로 근거)

news.md에 followUp/continue/resend의 활성 권한·상태 조건이 명시돼 있지 않다. 아래를 채택하고 주석으로 "news.md 명세 부재 — 도출"이라 남겨라:

- **followUp/continue**: 기사 작성 권한이 있는 R/D/Z에서 활성(파생은 새 기사 작성). 상태 게이트 없음(어떤 기사든 후속/계속 작성 가능). 서버가 최종 권한 게이트.
- **resend(재송)**: **DPS 기사 + D/Z** 에서만 활성(재송고=데스크 송고 행위 — 부서별 송고 메뉴의 DPS 행에서 의미가 있다). 비-DPS나 R 권한에는 비활성. 서버 `applyAction`이 (DPS, D/Z, send)만 허용하므로 클라 게이트는 UX, 서버가 최종 강제.

### TDD 순서: 먼저 실패 테스트를 쓴다

1. **ContextMenu** `web/src/view/ContextMenu.test.jsx`:
   - `followUp`·`continue`가 부서별 작성/송고·개인별 수정 메뉴에서 활성(role R/D/Z).
   - `resend`가 **DPS + D/Z** 일 때만 활성, RDS이거나 R 권한이면 비활성.
2. **Controller** `web/src/controller/useViewController.test.jsx`(fakeModel):
   - `createFollowUp(article)`가 `model.deriveArticle(articleId, 'followUp')`를 호출하고, 성공 시 새 기사로 편집 진입(`enterEditor`/navigate)을 트리거한다.
   - `createContinue(article)`가 `'continue'` 모드로 동일.
   - `resend(article)`가 확인창 후 `model.applyAction(article.articleId, 'send')`를 호출한다(role 미전송). 취소 시 호출 안 함.

먼저 실패를 확인한 뒤 구현한다.

### 구현 A: 컨텍스트 메뉴 활성화 `web/src/view/ContextMenu.jsx`

`followUp`·`continue`·`resend`를 `inactive()`에서 빼고 활성 조건을 적용하라:

- `buildContextMenuItems` 안에서: `const canWrite = role === 'R' || role === 'D' || role === 'Z';` `const canResend = isDPS && (role === 'D' || role === 'Z');`
- `{ key:'followUp', label:'후속기사작성', enabled: canWrite }`, `{ key:'continue', label:'계속기사작성', enabled: canWrite }`, `{ key:'resend', label:'재송', enabled: canResend }`.
- **이 step에서는 followUp/continue/resend만 활성화하고 history/sendHistory/translate/mapping은 건드리지 마라**(history/sendHistory는 step8에서 활성화됨 — 그대로 둠, translate는 step10, mapping은 보류로 비활성 유지).
- `INACTIVE_ITEMS`에서 followUp/continue/resend 항목을 정리하되, 다른 항목(translate·mapping)의 `inactive()` 호출이 깨지지 않도록 주의하라.

### 구현 B: 컨트롤러 핸들러 `web/src/controller/useViewController.js`

세 핸들러를 추가하고 반환에 노출하라:

```
const createFollowUp = useCallback(async (article) => {
  const r = await model.deriveArticle(article.articleId, 'followUp');
  if (r && r.ok && r.articleId) enterEditor({ articleId: r.articleId }, 'edit');
  return r;
}, [model, enterEditor]);
// createContinue: 동일, 'continue'
const resend = useCallback(async (article) => {
  if (!globalThis.confirm || !globalThis.confirm('재송하시겠습니까?')) return { ok:false, reason:'cancelled' };
  return model.applyAction(article.articleId, 'send'); // DPS send=DPS 재송고. role 미전송(서버 세션 도출).
}, [model]);
```

- 파생 후 편집 진입은 기존 `enterEditor`를 재사용한다(새 articleId로 writer.do 진입 → `openArticle`이 단건 재조회로 본문/메타를 채운다 — step14 경로 재사용). 새 기사는 RDS·미잠금이므로 잠금 획득이 정상 동작한다.
- **resend는 role을 서버로 보내지 않는다**(ADR-004). 송고 "(끝)" 가드·전이 유효성은 서버가 강제하므로, 서버가 `no-end-marker`/`forbidden-transition`을 돌려주면 프론트는 그 reason을 사용자에게 안내(ALERT)할 수 있다.

### 구현 C: 표시 결선 `web/src/view/ListPage.jsx`

`onCtxSelect`에 케이스 추가:

- `case 'followUp': createFollowUp(article); break;`
- `case 'continue': createContinue(article); break;`
- `case 'resend': { const r = await resend(article); if (r && !r.ok && r.reason && r.reason !== 'cancelled') alert(적절한 안내); break; }` — resend 실패 reason(no-end-marker 등)을 사용자에게 ALERT로 안내(news.md 72행 정신). onCtxSelect를 async로 만들거나 핸들러 안에서 처리.

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
   - `followUp`/`continue`/`resend`만 활성화하고 history/sendHistory/translate/mapping은 안 건드렸는가? (step 분리)
   - 파생/재송이 `model.deriveArticle`/`model.applyAction` 경유인가? 직접 fetch가 없는가? (ADR-003)
   - `applyAction('send')`에 role을 싣지 않는가? (ADR-004)
   - resend가 확인창 후에만 송고하는가? 취소 시 미호출인가?
   - resend 활성 조건이 DPS+D/Z인가? followUp/continue가 R/D/Z인가?
3. 결과에 따라 `phases/1-menu-actions/index.json`의 step 9를 업데이트한다(완료/error/blocked 양식 동일).

## 금지사항

- 파생/재송을 위해 직접 `fetch`를 호출하지 마라. 이유: ADR-003 — Model 계약만.
- `applyAction`/`deriveArticle`에 role을 싣지 마라. 이유: ADR-004 — 서버 세션 도출.
- 재송 시 확인창 없이 바로 송고하지 마라. 이유: news.md 140행 — 송고 전 확인창. 취소 시 아무것도 전송하지 않는다.
- 후속/계속에서 **원본 기사를 편집 진입하지 마라.** 이유: 후속/계속은 deriveArticle이 만든 **새 기사**로 진입해야 한다(원본 비파괴 — 원본으로 진입하면 원본을 편집/잠금하게 된다).
- history/sendHistory/translate/mapping 항목을 이 step에서 활성화/수정하지 마라. 이유: step8·step10 소관이며 mapping은 보류. 동시 수정은 충돌.
- 기존 테스트를 깨뜨리지 마라.
