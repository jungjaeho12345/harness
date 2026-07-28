# Step 2: tick-route-sse

`distributionTick`을 HTTP로 노출하고(`POST /api/distribution/tick`, Z/시스템 전용 pull), 배부 완료 시 SSE 무효화 신호를 재발행해 목록의 배부시간이 즉시 갱신되게 한다. 문서를 현행화한다. 이 step은 transport/wiring 레이어만 다룬다.

## 읽어야 할 파일

- `/home/user/harness/docs/ADR.md` — ADR-008 (3): 시점 배부는 앱 타이머가 아니라 `POST /api/distribution/tick`(Z/시스템 전용) pull 엔드포인트로 실행한다. ADR-005(SSE는 무효화 신호만), ADR-006(얇은 transport).
- `/home/user/harness/server/index.js` — `createApp`. 특히: `app.notifyChange(kind)`(297행, SSE 무효화 브로드캐스트), `sessionOf(req)`/`readSessionToken`(300·289행), Z 게이트 예시 `GET /api/logs/digest`(785–792행), 시스템 토큰 게이트 예시 `POST /api/collection/pull`(738–755행, `x-collection-token`), `POST /api/articles/:id/action`(523–535행) 라우트 형태, `bootstrap()`(830행~)에서 `createControllers`→`createApp` 순서.
- `/home/user/harness/src/controllers/index.js` — `createControllers(db, { sessionService, env, fetchFn, lockoutPolicy, spoolFs, logService })`. `distributionService` 결선(62–74행), `article` 도메인 객체(110–122행 부근), `onFailure` 콜백 패턴(70–72행).
- `/home/user/harness/src/services/distributionService.js` — `createDistributionService({ ..., onFailure })`. `onDistributed` 콜백을 여기에 추가한다.
- `/home/user/harness/src/services/articleService.js` — step 1에서 추가된 `distributionTick`.
- `/home/user/harness/test/controllers.test.js`, `/home/user/harness/test/server.test.js` — 기존 라우트/컨트롤러 테스트 하네스(supertest 등). 같은 방식으로 tick 라우트·SSE 재발행을 검증한다.
- `/home/user/harness/.env.example`, `/home/user/harness/docs/ARCHITECTURE.md`, `/home/user/harness/docs/SCHEMA.md`, `/home/user/harness/README.md` — 문서 현행화 대상.

## 작업

### (a) distributionService: `onDistributed` 콜백 (SSE 재발행 훅)

`createDistributionService`에 선택 파라미터 `onDistributed`를 추가한다. `distribute()`에서 **실제로 배부된 게 1건 이상일 때(`distributed.length > 0`)** `onDistributed({ articleId, kinds })`를 호출한다(`onFailure`와 동형으로 try/catch 격리 — 알림 실패가 배부를 깨지 않게). `kinds`는 이번에 배부 성공한 kind들이다.
- 이유: 송고 시점 즉시 배부는 fire-and-forget(비동기)이라 라우트가 이미 `notifyChange('status')`를 보낸 **뒤에** distributedAt이 기록된다 → 목록의 배부시간이 즉시 안 바뀐다(handoff #2). 이 콜백이 배부 완료 시점에 무효화 신호를 재발행한다.

### (b) controllers: tick 노출 + onChange 배선

`createControllers`에 선택 옵션 `onChange`(함수)를 추가한다. `distributionService` 결선 시 `onDistributed: (info) => onChange?.('distribute')`를 주입한다. `article` 도메인 객체에 `distributionTick: (opts) => articleService.distributionTick(opts)`를 추가한다.

### (c) server: tick 라우트 + bootstrap 배선

`createApp`의 라우트 그룹(배부 대상 라우트 인근, ADR-008 배부 절)에 추가한다:

```
POST /api/distribution/tick
  - 게이트: 시스템 토큰(설정 시) 우선, 아니면 Z 세션.
      token = process.env.DISTRIBUTION_TOKEN
      tokenOk = token && req.get('x-distribution-token') === token
      if (!tokenOk):
        { me } = sessionOf(req); if (!me) return 401 UNAUTH; if (me.role !== 'Z') return 403 FORBIDDEN
  - const r = await controllers.article.distributionTick()
  - app.notifyChange('distribute')      // tick 경로: 목록 배부시간/상태 즉시 갱신
  - return res.json(r)
  - CRITICAL(ADR-004): role은 검증된 세션에서만 도출한다. req.body.role을 신뢰하지 마라.
```

`bootstrap()`에서 `createControllers`가 `createApp`보다 먼저 호출되므로 `app.notifyChange`를 지연 바인딩한다:

```
let notify = () => {};
const controllers = createControllers(db, { sessionService, logService, onChange: (k) => notify(k) });
const app = createApp({ controllers, sessionService, logService, forceHttps });
notify = app.notifyChange;   // 이제 controllers의 배부 완료 → SSE 무효화로 이어진다
```

(테스트에서 `createControllers`에 직접 `onChange` 스파이를 넘겨 검증할 수 있다.)

### (d) 문서 현행화

- `docs/ARCHITECTURE.md`: 데이터 흐름 [배부] 블록에 tick pull 엔드포인트(`POST /api/distribution/tick`, Z/시스템, 앱 타이머 없음 — 외부 cron이 주기 호출)와 완결 시 EPS→DPS 전이, 배부 완료 SSE 재발행을 반영.
- `docs/SCHEMA.md`: Contents 절에 EPS→DPS 완결 전이(ArticleHistory `eventType='status', action='embargoComplete'` 이력, distribute 이력 kind 기준 완결 판정) 1–2줄.
- `README.md` / `.env.example`: 환경변수에 `DISTRIBUTION_TOKEN`(선택 — tick pull의 시스템 호출 토큰; 미설정 시 Z 세션만 허용) 추가.

## Acceptance Criteria

```bash
cd /home/user/harness && node --test "test/controllers.test.js" "test/server.test.js"   # 신규 포함 통과
cd /home/user/harness && npm test                                                        # 전체 무회귀(0 fail)
cd /home/user/harness && npm run test:web                                                # web 무접촉이면 기준선 1927 유지
cd /home/user/harness && npm run lint                                                     # 0 warning
cd /home/user/harness && npm run build                                                   # clean
```

## 검증 절차

1. TDD: 라우트·onChange 재발행 테스트를 먼저 작성해 red 확인 후 구현으로 green.
   케이스(최소):
   - `DISTRIBUTION_TOKEN` 설정 + 올바른 헤더 → tick 200, EPS 완결 기사 DPS 전이.
   - 토큰 미설정 + Z 세션 → 200. 비-Z 세션 → 403. 미인증 → 401.
   - 토큰 설정 + 헤더 불일치 + 비-Z → 401/403(우회 불가).
   - tick 호출 후 `notifyChange('distribute')`가 발생(SSE 구독자가 change 신호 수신).
   - 송고 시점 즉시 배부(DIST_SPOOL_DIR 설정, DPS 송고) 완료 후 `onChange('distribute')` 호출됨(handoff #2 — 배부시간 즉시 갱신 신호).
2. 아키텍처 체크: ADR-006(얇은 transport — 비즈니스 로직 없음), ADR-008(앱 타이머·egress 0), 신뢰 경계(role은 세션/토큰만), web/** 무접촉(diffstat).
3. `phases/48-distribution-tick/index.json` step 2 갱신.

## 금지사항

- tick 라우트에서 배부/전이 로직을 재구현하지 마라 — `controllers.article.distributionTick`에 위임만 한다(ADR-006 얇은 transport). 이유: 비즈니스 로직이 HTTP에 새면 테스트·재사용이 깨진다.
- `req.body.role`/클라이언트가 보낸 권한으로 tick을 인가하지 마라. 이유: 신뢰 경계는 서버 세션/시스템 토큰뿐(ADR-004).
- 앱 내 타이머(`setInterval`)로 tick을 자동 호출하지 마라. 이유: ADR-008 — 시점 배부는 외부 cron의 pull이다.
- SSE로 행 데이터를 실어 보내지 마라 — `notifyChange`는 무효화 신호(kind)만 브로드캐스트한다(ADR-005).
- `web/**`를 수정하지 마라(배부 UI는 MVP-4 범위 밖).
- 기존 테스트를 깨뜨리지 마라.
