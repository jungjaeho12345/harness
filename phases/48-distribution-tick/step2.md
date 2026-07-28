# Step 2: tick-route

step1의 tick 서비스를 합성 루트(`src/controllers/index.js`)에 결선하고,
`POST /api/distribution/tick` 라우트(`server/index.js`)를 추가한다. 라우트는 얇게 —
인가·단일 실행·도메인 로직은 전부 서비스가 이미 강제한다(ADR-006).

**SSE 신호 책임 분리(중요)**: 이 라우트가 발행하는 신호는 **status 전이가 발생했을 때의 `notifyChange('status')` 하나뿐**이다.
배부 자체에 대한 무효화 신호(`'update'`)는 이 step에서 **발행하지 않는다** — 배부 신호의 단일 출처는
step3에서 `distributionService.onDistributed`에 결선된다(라우트와 서비스가 둘 다 발행하면 tick 1회에 신호가 N+1번 나간다).

## 읽어야 할 파일

- `docs/ADR.md` — ADR-008 (3), **ADR-005**(SSE는 무효화 "신호"만 보낸다 — 행 데이터 push 금지), ADR-006, ADR-004.
- `src/controllers/index.js` — **전체(159줄)**. 특히:
  - `createControllers(db, { sessionService, env, fetchFn, lockoutPolicy, spoolFs, logService })`(L33~40)
  - `DIST_SPOOL_DIR` 분기로 `spoolWriter`/`distributionService`를 만드는 부분(L52~74). `spoolFs`는 `{ mkdir, writeFile, rename }` 3종만 주입되며 `writeFile`은 `await`된다.
  - 도메인 반환 객체(L158): `{ auth, user, article, media, translation, receiverConfig, collection, photo, distributionTarget }` — **현재 9개**
  - `distributionTarget` 도메인(L141~146)이 `sessionId`를 그대로 서비스에 넘기는 관례
- `server/index.js`:
  - `createApp({ controllers, sessionService, logService, forceHttps })`(L173~180)
  - `app.notifyChange = (kind) => bus.emit('change', { kind })`(L297) — 사용 kind: `'create' | 'update' | 'status' | 'lock'`
  - `readSessionToken(req)` / `sessionOf(req)`(L299~) — 쿠키 우선, `x-session-id` 폴백. **`req.body.role`은 절대 쓰지 않는다.**
  - `STATUS_BY_REASON`(L84~100)과 `fail(res, result, fallback = 400)`(L102~104). 현재 맵에 `busy` **없음** → 이번 step에서 추가한다.
  - 배부 대상 라우트 블록(L408~439) — 새 라우트를 이 블록 바로 뒤에 둔다
  - 부트스트랩(L837~855): `createControllers(db, { sessionService, logService })` → `createApp(...)` → `DIST_SPOOL_DIR` 로그. L852의 "시점 배부(tick)는 phase 48" 주석을 현행화한다.
- **step1 산출물**: `src/services/distributionTickService.js`
  ```js
  createDistributionTickService({ articleModel, historyModel, distributionService, articleService, authorization, now })
  async run(sessionId)
  // -> { ok:true, evaluated, distributed:[{articleId,kinds}], transitioned:[articleId], failed:[{articleId,reason}] }
  //  | { ok:false, reason:'unauthenticated'|'forbidden'|'spool-disabled'|'busy' }
  ```
  `busy`는 이전 tick이 아직 실행 중일 때 반환된다(모듈 스코프 단일 실행 게이트).
- **step0 산출물**: `src/services/articleService.js`의 `completeEmbargoDistribution`, `requiredDistributionKinds`.
- `test/distribution-targets-api.test.js` — **HTTP 테스트 하네스 템플릿**(in-memory DB → `createControllers` → `createApp` → `app.listen(0)` → `x-session-id` 헤더로 요청). `spoolFs` 주입으로 실제 파일 쓰기를 피하는 방법은 `test/controllers.test.js` 참고.

## 작업

**TDD: 테스트를 먼저 쓰고 red를 확인한 뒤 구현한다.**

### 1) `test/distribution-tick-api.test.js` (신규, node:test)

- `POST /api/distribution/tick`
  - 세션 헤더 없음 → **401**, body `{ ok:false, reason:'unauthenticated' }`.
  - role `R` 세션 → **403**, role `D` 세션 → **403**.
  - role `Z` 세션 + `DIST_SPOOL_DIR` 미설정 → **400**, `reason:'spool-disabled'`(스풀 미설정 환경 회귀 방지).
  - role `Z` 세션 + `DIST_SPOOL_DIR` 설정(가짜 `spoolFs` 주입) + **과거 시각** 1차 엠바고를 가진 EPS 기사 1건 → **200**, `distributed`에 해당 articleId와 `kinds:['press']`, 그리고 요구 배부 완결이면 `transitioned`에 포함되고 이후 `GET`으로 조회한 기사 status가 `DPS`.
  - **멱등**: 같은 요청을 연속 2회(첫 요청 완료 후 두 번째) → 두 번째 응답의 `distributed`는 빈 배열, 가짜 FS의 파일 쓰기 횟수가 늘지 않는다.
  - **중첩 호출 → 409**: 가짜 `spoolFs.writeFile`을 **외부에서 resolve하는 deferred**로 만들어 첫 요청이 스풀 쓰기에서 대기하게 한 뒤, 두 번째 POST를 보낸다 → 두 번째 응답은 **409**, body `{ ok:false, reason:'busy' }`. 그 후 deferred를 resolve하고 첫 응답이 **200**임을 확인하며, 가짜 FS의 `writeFile` 호출 횟수가 **1회**(중복 스풀 기록 없음)임을 단언한다.
  - **미래 시각** 엠바고만 있는 EPS 기사 → `distributed` 빈 배열, status는 `EPS` 유지.
  - `GET /api/distribution/tick` → **404**(POST만 존재).
  - body에 `{ role:'Z' }`만 넣고 세션 헤더 없이 호출 → **401**(클라이언트 role 불신 회귀 테스트).
  - body에 `{ now:'2099-01-01T00:00:00Z' }`를 넣어도 판정이 바뀌지 않는다(미래 엠바고 기사가 배부되지 않는다).
- 시각 제어는 **HTTP로 주입하지 않고**, 픽스처의 엠바고 값을 과거(`'2000-01-01T00:00:00Z'`)/미래(`'2999-01-01T00:00:00Z'`)로 두어 실제 시계로 결정적으로 만든다.
- 단일 실행 플래그는 프로세스 전역이므로, 각 테스트 케이스는 **직전 요청의 응답을 받은 뒤** 다음 요청을 보낸다(409 케이스만 의도적으로 중첩).
- `test/controllers.test.js` 보강: 도메인 키 집합 단언을 **10개**(`distribution` 추가)로 갱신하고, `DIST_SPOOL_DIR` 미설정에서도 `controllers.distribution.tick`이 **존재**하며 비Z 세션에 `forbidden`을 돌려주는지 확인한다.

### 2) `src/controllers/index.js`

- `createDistributionTickService`를 import하고 **항상 생성한다**(스풀 미설정이어도):
  ```js
  const distributionTickService = createDistributionTickService({
    articleModel, historyModel: articleHistoryModel, distributionService, articleService, authorization,
  });
  ```
  이유: 인가 게이트가 스풀 설정 여부보다 **먼저** 판정돼야 비인가 호출자에게 배부 설정 상태가 새지 않는다. `distributionService`가 `undefined`면 서비스가 `spool-disabled`를 반환한다(step1 계약).
- 도메인 1개 추가 후 반환 객체에 포함(총 10개):
  ```js
  const distribution = { tick: (sessionId) => distributionTickService.run(sessionId) };
  ```
- 컨트롤러에서 시각 계산·엠바고 판정·인가 판정을 **하지 마라**(위임만).

### 3) `server/index.js`

- `STATUS_BY_REASON`(L84~100)에 **한 줄 additive 추가**:
  ```js
  busy: 409,   // 이전 tick이 실행 중 — 중복 배부 방지 게이트(ADR-008). 재시도는 다음 주기 호출이 한다.
  ```
  기존 매핑 값은 하나도 바꾸지 않는다.
- 배부 대상 라우트 블록(L439) 바로 뒤에 추가:
  ```js
  // --- 시점 배부 tick (Z 전용 — 게이트는 distributionTickService가 강제, ADR-008 (3)) ---
  // 외부 운영 cron이 주기 호출한다. 앱 내부에는 타이머가 없다.
  // 신호 책임: 이 라우트는 status 전이에 대한 'status'만 발행한다.
  // 배부('update') 신호의 단일 출처는 distributionService.onDistributed다 — 여기서 중복 발행하지 않는다.
  app.post('/api/distribution/tick', async (req, res, next) => {
    try {
      const r = await controllers.distribution.tick(readSessionToken(req));
      if (!r.ok) return fail(res, r);
      if (r.transitioned.length) app.notifyChange('status');
      logService.info(`distribution tick evaluated=${r.evaluated} distributed=${r.distributed.length} transitioned=${r.transitioned.length} failed=${r.failed.length}`);
      return res.json(r);
    } catch (e) { next(e); }
  });
  ```
- 로그에는 **식별자와 개수만** 남긴다(본문·스풀 경로·페이로드 금지 — 마스킹 규율).
- 부트스트랩 L850~855의 주석에서 "시점 배부(tick)는 phase 48" 문구를 현행화한다(예: "시점 배부는 `POST /api/distribution/tick` 외부 호출로만 실행된다 — 앱에 타이머 없음"). **부트스트랩에 스케줄러를 추가하지 마라.**

## Acceptance Criteria

```bash
npm test && npm run lint && npm run build
```

- 신규 HTTP 테스트 green, 기존 백엔드 테스트 무회귀(도메인 키 개수 단언 갱신 외 수정 없음), lint 경고 0, build clean.

## 검증 절차

1. `npm test` 전량 green.
2. `grep -rn "setInterval\|setTimeout\|cron" server/index.js src/controllers/index.js` → 배부 관련 신규 **0건**.
3. `grep -rn "req.body" server/index.js | grep -i tick` → **0건**(요청 본문을 판정에 쓰지 않는다).
4. `grep -rn "distribution/tick" server/index.js` → **1건(POST만)**.
5. busy 매핑은 **한 곳에만** 있어야 한다 — 결정적으로 두 커맨드로 확인한다:
   - `grep -c "busy: 409" server/index.js` → **1** (`STATUS_BY_REASON` 매핑 1건)
   - `grep -c "reason: *'busy'" server/index.js` → **0** (라우트가 busy 결과를 직접 만들지 않고 서비스 반환을 `fail()`로 그대로 매핑한다)
6. tick 라우트 블록에 `notifyChange` 호출이 **정확히 1개**(`'status'`)인지 육안 확인 — `notifyChange('update')` 분기가 있으면 제거한다(step3가 단일 출처로 발행한다).
7. `git diff --stat` → `src/controllers/index.js`, `server/index.js`, 테스트 2개. `web/**` 무접촉.

## 금지사항

- tick 라우트에서 `app.notifyChange('update')`를 호출하지 마라. 이유: step3의 `onDistributed` 콜백이 배부 1건당 신호를 발행하므로, 라우트가 또 발행하면 tick 1회에 N+1개의 무효화 신호가 나가 전 클라이언트가 중복 재조회한다.
- 라우트 핸들러 안에서 엠바고 시각을 비교하거나 `articleModel`을 직접 호출하지 마라. 이유: 얇은 transport 원칙(ADR-006) — 도메인 로직 이중 구현은 두 곳이 서로 어긋나는 순간 오배부를 만든다.
- `busy`를 200으로 감싸 성공처럼 응답하지 마라. 이유: 외부 cron이 "정상 처리됨"으로 오인해 미배부 기사를 놓친다 — 409로 재호출 필요성을 명시적으로 알려야 한다.
- `busy`일 때 라우트에서 대기·재시도하지 마라(setTimeout·while 루프). 이유: 앱 내부에 스케줄러가 생겨 ADR-008을 위반하고 요청 스레드를 점유한다.
- `req.body.now` / `req.query.now` / `req.body.role` / `req.body.articleId`를 읽지 마라. 이유: 클라이언트가 시각·대상·권한을 통제하면 엠바고를 임의 해제할 수 있다(ADR-004).
- `GET`으로도 tick을 노출하지 마라. 이유: 상태 변경 요청이며, GET이면 브라우저 프리페치·크롤러·링크 클릭으로 의도치 않은 배부가 발생한다.
- SSE로 기사 행 데이터를 push하지 마라 — `app.notifyChange(kind)`만 호출한다. 이유: ADR-005는 무효화 신호 전용이며(ADR-007 로그 스트림만 예외), 데이터 push는 인가 우회 통로가 된다.
- `notifyChange`를 결과와 무관하게 매 tick 호출하지 마라. 이유: 변화 없는 신호가 모든 접속 클라이언트의 목록 재조회를 유발한다(cron 주기마다 전체 재조회 폭풍).
- 부트스트랩·컨트롤러·라우트 어디에도 주기 실행 코드를 넣지 마라. 이유: ADR-008이 명시적으로 앱 내 타이머를 금지한다(외부 cron이 유일한 트리거).
- 새 환경변수를 만들지 마라(tick 전용 토큰·주기·배치 크기 등). 이유: 이번 phase의 확정 지시에 없다.
