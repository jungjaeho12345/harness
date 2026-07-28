# Step 3: tick-wiring

**진입점 계층**을 만든다: tick 실행 권한 게이트(Z 전용)와 컨트롤러 결선.
파일 2개(`src/services/authorization.js`, `src/controllers/index.js`) + 테스트.
HTTP 라우트는 아직 만들지 않는다(step4).

## 읽어야 할 파일

- `docs/ADR.md` ADR-004(acting role은 검증된 세션에서만 도출 — `req.body.role` 불신), ADR-006(계층), ADR-008 (3) "`POST /api/distribution/tick`(Z/시스템 전용) pull 엔드포인트".
- `src/services/authorization.js` 전체 — `CAPABILITIES` 표와 `manageDistributionTarget(sessionId, op, payload)` 게이트 패턴(세션 검증 → `assertAuthorized(me.role, capability)` → `{ ok:true, role, ... }`).
- `src/controllers/index.js` 전체 — 특히 52~74행(스풀/배부 서비스 결선, `DIST_SPOOL_DIR` 미설정 시 `undefined`), 140~146행(`distributionTarget` 도메인 노출), 158행(반환 도메인 집합).
- `src/services/sessionService.js` 10~17행 — 세션 신원 필드(`userId`, `role`, ...). `userId`는 여기서만 가져온다.
- step0~2 산출물: `src/services/embargoSchedule.js`, `src/services/lifecycle.js`, `src/services/distributionService.js`(`onDistributed`), `src/services/distributionTickService.js`.
- `test/controllers.test.js` — 컨트롤러 결선 테스트 관례(가짜 `spoolFs` 주입, 도메인 집합 단언). **현재 도메인 집합 단언 개수(9)를 확인하고 갱신하라.**
- `test/authorization.test.js`(있으면) — 게이트 테스트 관례.

## 작업

**TDD: 테스트를 먼저 쓰고 red를 확인한 뒤 구현한다.**

### 1) `src/services/authorization.js`

- `CAPABILITIES`에 `runDistributionTick: ['Z']`를 추가한다(ADR-008 (3) Z/시스템 전용).
- 게이트 함수 `runDistributionTick(sessionId)`를 추가하고 반환에 포함한다:
  - 세션 미검증 → `{ ok:false, reason:'unauthenticated' }`
  - 비-Z → `{ ok:false, reason:'forbidden' }`
  - 통과 → `{ ok:true, role: me.role, userId: me.userId }`
- **role·userId는 반드시 `sessionService.touchSession(sessionId)` 결과에서만 도출한다.** 인자로 받은 role/userId를 신뢰하는 코드를 만들지 마라.
- 기존 게이트(`manageUsers`/`manageReceiverConfig`/`manageDistributionTarget`/`editDps`)의 동작을 바꾸지 마라.

### 2) `src/controllers/index.js`

- `createDistributionTickService({ articleModel, historyModel: articleHistoryModel, distributionService })`를 결선한다.
- **SSE 무효화 신호 seam** — 컨트롤러가 배부 변경 리스너를 보관하고, `createDistributionService`에 `onDistributed`를 넘겨 리스너들에게 전달한다:
  ```js
  const changeListeners = [];
  // distributionService: onDistributed: () => notifyDistributed()
  // 리스너 호출은 try/catch로 격리한다(구독자 예외가 배부를 깨뜨리지 않는다).
  ```
  이유: `createApp`이 컨트롤러를 받아 만들어지므로(부트스트랩 순서상 app이 나중), 컨트롤러가 구독 seam을 노출해야 transport가 `app.notifyChange`를 붙일 수 있다. 부트스트랩에서 늦은 대입(late binding)으로 우회하지 마라 — 테스트로 만든 app에는 결선이 빠진다.
- 새 도메인 `distribution`을 노출한다:
  ```js
  const distribution = {
    tick: async (sessionId) => { /* 게이트 → tickService.tick({ actorUserId }) */ },
    onChange: (listener) => { /* 구독 등록 */ },
  };
  ```
  - `tick`은 **먼저** `authorization.runDistributionTick(sessionId)` 게이트를 통과시키고, 실패하면 게이트 결과를 그대로 반환한다.
  - `actorUserId`는 게이트가 돌려준 세션 `userId`만 쓴다(클라이언트 값 금지).
  - **tick 결과에 완결 전이(`completed`)가 1건 이상이면 배부가 0건이어도 리스너에게 알린다(CRITICAL).**
    이유: `onDistributed`는 배부가 있었을 때만 발화하는데, EPS→DPS 전이만 일어난 tick(이력은 이미 있고 전이만 밀렸던 자가 치유 경로)에서는 목록의 status 배지가 바뀌었는데도 SSE 신호가 나가지 않아 화면이 옛 상태로 남는다.
    중복 알림은 무해하다(무효화 신호는 멱등한 재조회를 유발할 뿐) — 누락이 유해하다.
  - `DIST_SPOOL_DIR` 미설정(배부 비활성) 환경에서도 `distribution` 도메인 자체는 노출한다. 이때 `tick`은 게이트 통과 후 `{ ok:false, reason:'spool-disabled' }`를 반환한다(라우트가 일관되게 응답할 수 있어야 한다).
- 반환 도메인 집합에 `distribution`을 추가한다(기존 9개 → 10개). 컨트롤러에 비즈니스 로직을 재구현하지 마라 — 서비스 위임만.

### 3) 테스트

- `test/authorization.test.js`(또는 신규): `runDistributionTick` — 미인증 401 사유, R/D는 `forbidden`, Z만 `ok:true` + `userId`가 세션 값과 일치.
- `test/controllers.test.js` 보강:
  - `DIST_SPOOL_DIR` 설정 + Z 세션 → `controllers.distribution.tick(sid)`이 EPS 기사(엠바고 시각 과거)를 배부하고 `Contents.status`가 `DPS`가 된다(가짜 `spoolFs` 주입 — **실제 FS 접촉 금지**).
  - 비-Z 세션 → `{ ok:false, reason:'forbidden' }`이고 파일 쓰기 시도 0건.
  - `DIST_SPOOL_DIR` 미설정 + Z 세션 → `{ ok:false, reason:'spool-disabled' }`.
  - 도메인 집합 단언을 10개로 갱신한다.
  - 배부(송고 훅 또는 tick)로 실제 배부가 일어나면 `controllers.distribution.onChange`로 등록한 리스너가 호출된다.
  - **배부 0건 + 완결 전이 1건인 tick(자가 치유 경로)에서도 리스너가 호출된다.**
  - 아무 일도 없던 tick(대상 0건)에서는 리스너가 호출되지 않는다(불필요한 전체 재조회 유발 금지).
  - 리스너가 throw해도 `tick`은 정상 결과를 반환한다(격리).

## Acceptance Criteria

```bash
npm test && npm run lint
```

- 백엔드 테스트 전량 green(step2 결과 대비 신규분만 증가, 회귀 0), lint 경고 0.

## 검증 절차

1. 구현 전 신규 단언에서 red를 확인한다.
2. `grep -rn "req.body\|role:" src/controllers/index.js | grep -i tick` → 클라이언트 role 사용 0건.
3. `grep -nE "setInterval|setTimeout" src/controllers/index.js` → 0건.
4. `git diff --stat` — `web/**` 무접촉.

## 금지사항

- `tick(sessionId, role)`처럼 role을 인자로 받지 마라. 이유: ADR-004 — 클라이언트가 보낸 역할을 받는 순간 Z 권한을 위조할 수 있다.
- 게이트를 라우트(step4)에만 두지 마라. 이유: 이 코드베이스는 `receiverConfig`/`distributionTarget`과 동일하게 **서비스/컨트롤러가 인가를 강제**한다 — 게이트가 transport에만 있으면 다른 진입점이 생길 때 우회된다.
- 컨트롤러에서 엠바고 판정·이력 조회·SQL을 직접 하지 마라. 이유: ADR-006 계층 분리 — 컨트롤러는 결선과 위임만 한다.
- 부트스트랩에서 `app`을 늦게 대입해 `notifyChange`를 잇는 우회를 쓰지 마라. 이유: `createApp`을 직접 조립하는 테스트/다른 진입점에서 결선이 빠져 SSE 재발행이 조용히 사라진다.
- 배부 비활성 환경에서 `distribution` 도메인을 통째로 감추지 마라. 이유: 라우트가 도메인 존재 여부로 분기하게 되면 404/500이 섞여 운영 루틴이 실패를 구분할 수 없다.
