# Step 6: edit-lock-hardening

편집 잠금을 강화한다. (1) 편집 진입 시 다른 세션/탭이 잠근 기사면 **'편집중입니다.' 안내 후 탭/이동을 막는다**(작성 컨트롤러·뷰 컨트롤러 양쪽). (2) 진입 잠금 충돌을 **이동(navigate) 전에** 판정해 빈 작성 페이지로 새는 것을 막는다. (3) 잠금 보유자 식별 단위를 **세션(sessionId)→편집 탭(clientId)** 으로 좁혀 "한 탭만 편집"을 강제하고, 동시에 **같은 userId 재로그인 시 본인 orphan 잠금을 자동 인계(takeover)** 하는 길을 연다. 본 step은 프런트 transport/컨트롤러와 서버 service/route/DB 스키마를 함께 다루되, 잠김 판정·인가 게이트는 전부 서버에 둔다(ADR-004).

## 읽어야 할 파일

먼저 아래 파일들을 읽고 프로젝트의 아키텍처와 설계 의도를 파악하라:

- `/docs/ADR.md` — ADR-003(프론트 transport=주입 Model 계약, 컴포넌트/컨트롤러 직접 fetch 금지), ADR-004(역할은 세션에서만 도출·클라 role 불신·1시간 idle 만료·편집 잠금 게이트), ADR-006(얇은 transport 라우트 → controllers → services → models).
- `/docs/ARCHITECTURE.md` — 디렉토리 구조(server/·src/·web/src/), Model 계약 경계.
- `/docs/SCHEMA.md` — Contents 테이블의 잠금 컬럼(lockYN/lockerUserId/lockerSessionId/lockedAt) 정의. 본 step에서 `lockerClientId`를 additive 추가한다.
- `/src/services/articleService.js` — **이 step의 핵심.** `acquireEditLock`/`releaseEditLock`/`assertLockHolder`/`forceReleaseEditLock`의 stale(30분)·보유자 판정 로직.
- `/src/models/articleModel.js` — `CONTENTS_COLS`, `setLock`/`clearLock` (잠금 컬럼 UPDATE, 행 삭제 아님).
- `/src/db/schema.js` — Contents 컬럼 정의(additive 추가 위치).
- `/server/index.js` — 얇은 라우트 `PUT /api/articles/:id`, `POST /:id/lock`, `POST /:id/unlock`, CORS `allowedHeaders`.
- `/web/src/controller/useWriteController.js` — 작성 컨트롤러. `openArticle`(getArticle 재조회 + lockArticle), `blankTab`/`tabFromArticle`, save/saveMapping/submit, closeTab/onUnload.
- `/web/src/controller/useViewController.js` — 뷰 컨트롤러. `enterEditor`(편집/고침/포털고침/매핑 진입), `createFollowUp`/`createContinue`.
- `/web/src/model/httpModel.js` — transport. 공용 `request()`, `saveArticle`/`lockArticle`/`unlockArticle`/`forceUnlockArticle`.
- `/web/src/test/fakeModel.js` — 테스트용 in-memory fake Model(계약 시그니처 일치 필요).
- 테스트: `/test/editLock.test.js`, `/test/server.test.js`, `/test/controllers.test.js`, `/test/articleModel.test.js`, `/test/body-contract.test.js`, `/web/src/model/httpModel.test.js`, `/web/src/controller/useWriteController.test.jsx`, `/web/src/controller/useViewController.test.jsx`.

이전에 만들어진 코드를 꼼꼼히 읽고 설계 의도를 이해한 뒤 작업하라.

## 작업

TDD: **테스트를 먼저 작성**한 뒤 통과하는 구현을 작성한다. 아래 [A]/[B]/[C] 세 묶음으로 진행한다.

### [A] 작성 컨트롤러 — 잠김이면 '편집중입니다.' 안내 + 탭 미오픈 (`useWriteController.openArticle`)
- 기존 `openArticle`은 탭을 먼저 만들어 열고 `lockArticle` 결과를 catch로 무시한 채 항상 tab id를 반환해, 서버가 `{ ok:false, reason:'locked' }`를 줘도 편집 탭이 열렸다.
- **잠금 획득을 탭 생성보다 앞으로 옮긴다.** catch 폴백을 `{}`→`null`로 바꿔 `const lock = await Promise.resolve(model.lockArticle(...)).catch(() => null)` 로 결과를 받는다.
- `lock && lock.ok === false && lock.reason === 'locked'` 이면 `globalThis.alert?.('편집중입니다.')` 후 `return null`(탭 미오픈).
- 잠김이 아니면 `getArticle` 재조회 폴백 → `tabFromArticle`로 탭 생성·활성화 후 tab id 반환. `lockAction` 산출과 `useCallback` 의존성은 동일 의미 유지.

### [B] 뷰 컨트롤러 — 이동 전에 잠금 판정 (`useViewController.enterEditor`)
- 기존 `enterEditor`는 먼저 `navigate('writer.do', { articleId })` 한 뒤 잠금을 확인해, 다른 세션이 편집 중이면 빈 작성 페이지로 이동한 채 ALERT만 떴다.
- `enterEditor`를 **async**로 바꾸고, 이동 **전에** 잠금을 먼저 획득한다: `lockAction = mode === 'portalRevise' ? 'portalRevise' : 'revise'`, `const lock = await Promise.resolve(model.lockArticle(article.articleId, lockAction)).catch(() => null)`.
- `lock && lock.ok === false && lock.reason === 'locked'` 이면 `globalThis.alert?.('편집중입니다.')` 후 `return null` — `sessionStorage`(PENDING_EDIT_KEY)에 쓰지 않고 navigate도 하지 않아 **현재(목록) 페이지에 그대로 머문다**.
- 잠금 성공 시에만 `sessionStorage.setItem(PENDING_EDIT_KEY, ...)` + `navigate` 후 `article.articleId` 반환. `useCallback` 의존성에 `model` 추가.
- `createFollowUp`/`createContinue`는 새 기사 잠금까지 `await enterEditor(...)` 하도록 갱신. 실제 인가는 서버 `POST :id/lock` 게이트가 강제(ADR-004) — 여기선 충돌(locked) UX만 담당.

### [C] 잠금 보유자 단위를 탭(clientId)으로 확장 + 재로그인 takeover (서버/DB/service + 프런트 transport)
서버/DB/서비스:
- `src/db/schema.js`: Contents에 `['lockerClientId', 'VARCHAR']` 컬럼 1개를 **additive**(기존 컬럼 보존, 비파괴)로 추가.
- `src/models/articleModel.js`: `CONTENTS_COLS`에 `'lockerClientId'` 추가. `setLock(articleId, { lockerUserId, lockerSessionId, lockerClientId, lockedAt })`가 `lockerClientId` 컬럼도 UPDATE하고, `clearLock`가 `lockerClientId = NULL`로 함께 비운다(행 삭제 아님).
- `src/services/articleService.js`:
  - `acquireEditLock(articleId, { userId, sessionId, clientId })`: 신선도 기준을 `held = lockYN === 'Y' && lockerClientId` 로 둔다. held가 stale이 아니고, `sameClient`(`lockerClientId === clientId`, F5 재획득)도 아니고 `sameUserReLogin`(`lockerUserId === userId && lockerSessionId !== sessionId`, 재로그인 takeover)도 아니면 `{ ok:false, reason:'locked' }`. 따라서 **같은 세션 다른 탭(같은 userId·같은 sessionId·다른 clientId)** 은 둘 다 거짓이라 차단. `setLock`에 `lockerClientId` 동봉.
  - `releaseEditLock(articleId, { clientId })`: 보유자 비교를 `lockerSessionId`→`lockerClientId` 로 변경(`lockerClientId`가 있고 `clientId`와 다르면 not-holder). `lockYN!=='Y'`면 멱등 ok 유지.
  - `assertLockHolder(articleId, { clientId })`: `lockYN === 'Y' && lockerClientId === clientId` 일 때만 ok(저장 권한을 탭 단위로).
- `server/index.js`(얇은 라우트만): CORS `allowedHeaders`에 `'x-edit-client'` 추가. `PUT /api/articles/:id`·`POST /:id/lock`·`POST /:id/unlock`이 `req.get('x-edit-client')`로 clientId를 읽어 각각 `assertLockHolder`/`acquireEditLock`/`releaseEditLock`에 전달. PUT·unlock은 보유자 식별에 sid 대신 clientId만 사용. PUT 핸들러는 기존대로 fields에서 role을 제거하고 modifier를 세션 me.userId로 세팅(ADR-004).

프런트(transport=Model 계약):
- `web/src/model/httpModel.js`: 공용 `request(path, { ..., clientId })`가 clientId가 있으면 `headers['x-edit-client']`에 싣는다. `saveArticle(dto, clientId)`는 PUT(articleId 있을 때)·POST 모두에, `lockArticle(articleId, action, clientId)`·`unlockArticle(articleId, clientId)`도 clientId를 헤더로 운반. `forceUnlockArticle`은 clientId 미사용 그대로.
- `web/src/controller/useWriteController.js`: 편집 탭마다 `nextClientId()`로 고유 clientId 발급(crypto.randomUUID 우선 `c-<uuid>`, 실패 시 폴백 `c-<base36시간>-<카운터>`). `blankTab`/`tabFromArticle`에 `clientId` 필드 추가. `openArticle`에서 lock 직전 clientId 발급해 `lockArticle`에 전달하고 탭에 보관, save/saveMapping/submit의 `saveArticle`와 closeTab/onUnload의 `unlockArticle` 모두 `tab.clientId` 동봉.
- `web/src/test/fakeModel.js`: in-memory fake를 clientId-aware로 확장 — `lockArticle`는 다른 lockerClientId가 잠그고 있으면 locked 거부·같은 clientId면 재획득, `saveArticle`(PUT)은 보유 lockerClientId와 다르면 not-holder, `unlockArticle`은 보유 탭만 해제(아니면 not-holder), `forceUnlockArticle`은 clientId 무관하게 lockerClientId까지 비움.

핵심 규칙:
- 잠김/인가 판정은 전부 서버 service에 둔다. 클라(컨트롤러)는 서버가 돌려준 `ok:false, reason:'locked'`로 **UX(편집중 안내·미이동·미오픈)** 만 처리한다(ADR-004 신뢰경계).
- clientId는 권한/role이 아니라 **편집 탭 식별자**일 뿐이다 — 헤더 운반은 transport(`httpModel.request`)에만, 컨트롤러는 Model 메서드 인자로만 전달(직접 fetch/헤더 조작 금지, ADR-003).
- `lockerClientId`는 additive 컬럼이고 clearLock/releaseEditLock는 컬럼을 NULL/'N'으로 갱신할 뿐 행을 삭제하지 않는다(DB 비파괴).

## Acceptance Criteria

```bash
npm run lint
npm run build
npm test
npm run test:web
```

## 검증 절차

1. 위 AC 커맨드를 실행한다. 기존 + 신규 테스트가 모두 통과해야 한다(무회귀).
2. 아키텍처 체크리스트:
   - ARCHITECTURE.md 디렉토리 구조(server/·src/·web/src/) 유지, ADR 기술스택 준수.
   - CLAUDE.md CRITICAL·TDD 준수(테스트 선행).
   - ADR-003: 컨트롤러/컴포넌트 직접 fetch 없음 — clientId는 httpModel.request 헤더에만, 컨트롤러는 Model 인자로만 전달. fakeModel도 같은 시그니처.
   - ADR-004: 잠김/role/인가는 서버 세션·service 게이트에서 도출. clientId는 식별자일 뿐 권한 아님. PUT은 fields role 제거·modifier=세션 me.userId.
   - ADR-006: 라우트는 헤더 읽어 service로 위임만, takeover/차단/stale 판정은 articleService에.
   - DB 비파괴: lockerClientId additive 추가, 잠금 해제는 컬럼 NULL/'N' 갱신(행 삭제 없음).
3. 결과에 따라 `phases/4-mvp-polish/index.json`의 step 6 status를 갱신(completed + summary). 실패 시 error, 개입 필요 시 blocked.

## 금지사항

- 잠김(locked) 충돌인데 편집 탭을 열거나 writer.do로 이동하지 마라. 이유: 빈 작성 페이지로 새거나 다른 세션의 편집을 덮어쓸 수 있다 — 잠금 획득은 탭 생성·navigate보다 **앞에** 와야 한다.
- 클라이언트(컨트롤러/컴포넌트)에서 직접 fetch/헤더 조작을 하지 마라(ADR-003). clientId는 Model 메서드 인자로만 넘기고 transport(httpModel.request)에서만 x-edit-client 헤더로 싣는다.
- clientId/req.body로 role·인가를 도출하지 마라(ADR-004). clientId는 편집 탭 식별자일 뿐이며 role은 서버 세션에서만 도출한다.
- 잠금 보유자 판정·takeover·stale 로직을 라우트(server/index.js)에 두지 마라(ADR-006). 라우트는 헤더 읽어 service로 위임만 한다.
- DB 행이나 기존 컬럼을 삭제/파괴하지 마라. lockerClientId는 additive로만 추가하고, 잠금 해제는 컬럼을 NULL/'N'으로 갱신한다(DB 비파괴 — CLAUDE.md).
- 기존 테스트/기능을 깨뜨리지 마라. 같은 탭 F5 재획득·30분 stale 인계·forceUnlock(관리자 강제 해제) 동작은 보존한다.
