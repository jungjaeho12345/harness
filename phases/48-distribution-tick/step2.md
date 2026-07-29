# Step 2: tick-authz

tick 실행 권한을 **Z(관리자/시스템) 전용**으로 인가 계층에 박고, 컨트롤러(합성 루트)에 tick 진입점을 노출한다.
HTTP 라우트는 만들지 않는다(step3).

**CRITICAL(ADR-004)**: acting actor는 검증된 세션에서만 도출한다. 요청 바디의 `role`/`actor`/대상/시각은 신뢰하지 않는다.

## 읽어야 할 파일

- `docs/ADR.md` — **ADR-004**(세션 기반 서버측 인가 — 클라이언트 role 불신), ADR-008 (3)(`POST /api/distribution/tick`은 Z/시스템 전용 pull), ADR-006.
- `src/services/authorization.js` — `CAPABILITIES` 맵과 `manageDistributionTarget`/`manageReceiverConfig` 게이트 구현 패턴(`sessionService.touchSession(sessionId)` → 미인증 `unauthenticated` → 역할 게이트 `forbidden`).
- `src/controllers/index.js` — 합성 루트. `env.DIST_SPOOL_DIR`이 있을 때만 `spoolWriter` → `distributionService`를 만들고 `articleService`에 주입하는 기존 분기, 그리고 반환하는 도메인 집합(현재 9개: `auth, user, article, media, translation, receiverConfig, collection, photo, distributionTarget`).
- **step1 산출물** `src/services/distributionTickService.js` — `createDistributionTickService({ articleModel, historyModel, distributionService, embargoSchedule, now })` → `{ runTick({ actorUserId }) }` (async).
- `src/services/sessionService.js` — `touchSession(sessionId)`가 돌려주는 신원 객체 필드(`userId`, `role` 등).
- `test/authorization.test.js`, `test/controllers.test.js` — 기존 게이트/결선 테스트 관례(도메인 키 개수 단언 포함).

## 작업

**TDD: 테스트를 먼저 갱신해 red를 확인한 뒤 구현한다.**

### 1) `src/services/authorization.js`

- `CAPABILITIES`에 한 줄 추가: `runDistributionTick: ['Z'],  // 시점 배부 tick 실행 — Z/시스템 전용 (ADR-008 (3))`
- 게이트 함수 추가:

```js
// 시점 배부 tick 실행 인가 — Z 전용. actor는 세션에서만 도출한다(ADR-004).
function runDistributionTick(sessionId) // → { ok:true, role, userId } | { ok:false, reason:'unauthenticated'|'forbidden' }
```

- 기존 게이트와 동일한 순서: `touchSession` → 없으면 `unauthenticated` → `assertAuthorized(me.role, 'runDistributionTick')` → 실패면 그대로 반환 → 성공이면 `{ ok:true, role: me.role, userId: me.userId }`.
- 반환 객체에 `userId`를 담는 이유: 컨트롤러가 이 값을 `actorUserId`로 tick 서비스에 넘겨 이력에 남기기 위함이다. **클라이언트가 준 값은 절대 쓰지 않는다.**
- 반환 객체를 `createAuthorization`의 반환 목록에 추가한다.

### 2) `src/controllers/index.js`

- `createDistributionTickService`를 import하고, **기존 `distributionService` 분기 안에서만** tick 서비스를 만든다:

```js
const distributionTickService = distributionService
  ? createDistributionTickService({
      articleModel, historyModel: articleHistoryModel, distributionService,
    })
  : undefined;
```

- 새 도메인 진입점 하나를 노출한다(도메인 집합 9개 → **10개**):

```js
// 시점/엠바고 배부 tick — 외부 운영 cron이 pull한다(ADR-008 (3)). 인자는 세션 토큰 하나뿐이다.
const distribution = {
  runTick: (sessionId) => { /* ... */ },   // async
};
```

**runTick의 고정 규칙**

1. **인자는 `sessionId` 하나뿐이다.** 대상 기사·시각·kind를 받는 파라미터를 만들지 마라 — 호출자가 "무엇을 언제 반출할지" 주입할 수 있으면 엠바고가 무력화된다.
2. 인가 게이트를 **먼저** 통과시킨다: `const gate = authorization.runDistributionTick(sessionId); if (!gate.ok) return gate;`
3. 게이트 통과 후에 스풀 가용성을 본다: `if (!distributionTickService) return { ok:false, reason:'spool-disabled' };`
   순서가 중요하다 — 미인증/비-Z 호출자에게 서버 설정 상태(스풀 구성 여부)를 알려주지 않는다.
4. `return distributionTickService.runTick({ actorUserId: gate.userId });` (Promise 그대로 반환 — 라우트가 await 한다.)

- **인가 게이트를 tick 서비스 안으로 옮기지 마라.** 이유: step1의 tick 서비스는 세션/HTTP를 모르는 순수 도메인 엔진이고, 주입 목록에 `authorization`이 없다(계층 분리).

### 3) 테스트

- `test/authorization.test.js` 갱신(추가 케이스):
  - Z 세션 → `{ ok:true, role:'Z', userId:'<세션 사용자>' }`.
  - R 세션 / D 세션 → `{ ok:false, reason:'forbidden' }`.
  - 세션 없음/만료/잘못된 토큰 → `{ ok:false, reason:'unauthenticated' }`.
  - `assertAuthorized('Z', 'runDistributionTick')`는 ok, 정의되지 않은 capability는 `unknown-capability` 유지(회귀).
- `test/controllers.test.js` 갱신:
  - 반환 도메인 키 집합 단언을 **10개**로 갱신하고 `distribution` 포함을 확인한다.
  - `env.DIST_SPOOL_DIR` 설정 + Z 세션 → `await controllers.distribution.runTick(sid)`가 `{ ok:true, ... }`(배부 대상이 없으면 `checked:0`)를 반환.
  - `DIST_SPOOL_DIR` **미설정** + Z 세션 → `{ ok:false, reason:'spool-disabled' }`.
  - 비-Z 세션(R/D) → `{ ok:false, reason:'forbidden' }`이고, **스풀 미설정 환경에서도 `forbidden`이 먼저 나온다**(설정 상태 누출 방지 회귀 테스트).
  - 세션 없음 → `unauthenticated`.
  - 파일시스템 접촉이 필요하면 기존 `spoolFs`(mkdir/writeFile/rename) 주입 seam을 쓴다 — **실제 FS에 쓰지 마라.**

## Acceptance Criteria

```bash
npm test && npm run lint
```

- 신규/갱신 테스트 전량 green, 기존 백엔드 테스트 무회귀(fail 0).

```bash
grep -rn "req.body\|x-session-id\|express" src/services/authorization.js src/controllers/index.js
```
- `authorization.js`/`controllers/index.js`에 HTTP/Express 코드나 `req.body` 참조가 **없어야 한다**(얇은 transport 원칙 — 세션 토큰은 라우트가 뽑아 넘긴다).

```bash
git diff --stat -- server/index.js web src/services/distributionTickService.js src/services/embargoSchedule.js
```
- **변경 0** 이어야 한다(라우트는 step3, step0/step1 산출물은 이 step에서 고치지 않는다).

## 검증 절차

1. 의존성 설치 확인(`node_modules` 없으면 무관한 테스트가 대량 실패 — 코드 문제 아님).
2. 구현 전 갱신한 테스트로 red를 확인하고 기록한다.
3. `npm test` 전체 green 확인.
4. `grep -n "runDistributionTick" -r src/` 로 capability 정의·게이트·컨트롤러 호출 3지점이 일관된지 확인한다.

## 금지사항

- `req.body.role`/`req.body.actor`/바디의 대상·시각을 읽는 코드를 만들지 마라. 이유: ADR-004 신뢰 경계는 서버다 — 바디로 actor를 주면 R 사용자가 Z를 사칭하고, 대상/시각을 주면 엠바고 전 강제 반출이 가능해진다.
- `runTick`에 `articleId`/`kinds`/`now` 같은 파라미터를 추가하지 마라. 이유: 외부에서 반출 대상·시점을 주입할 수 있는 순간 엠바고 통제가 무너진다(시각은 서버 시계, 대상은 DB status로만 결정).
- 스풀 가용성 검사를 인가보다 **먼저** 하지 마라. 이유: 미인증 호출자에게 서버 구성 정보를 흘린다.
- tick 실행 권한을 `['Z','D']` 등으로 넓히지 마라. 이유: ADR-008 (3)이 Z/시스템 전용으로 못 박았다.
- `src/services/distributionTickService.js`에 인가·세션 코드를 넣지 마라. 이유: 계층 분리(ADR-006) — 도메인 엔진은 세션을 모른다.
- HTTP 라우트(`POST /api/distribution/tick`)를 만들지 마라. 이유: step3 범위다(스코프 혼입은 리뷰 게이트에서 반려된다).
- `web/**` 를 수정하지 마라. 이유: 배부 현황 UI는 MVP-4 후속 범위다(PRD).
