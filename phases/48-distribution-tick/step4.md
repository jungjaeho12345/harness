# Step 4: tick-route

step3의 tick 엔진을 **인가 게이트 + 컨트롤러 결선 + REST 라우트**로 노출한다: `POST /api/distribution/tick` (Z/시스템 전용).
도메인 로직은 한 줄도 새로 쓰지 않는다 — 이 step은 결선과 transport뿐이다(ADR-006 얇은 transport).

## 배경

- ADR-008 (3): 시점 배부는 **`POST /api/distribution/tick`(Z/시스템 전용) pull 엔드포인트**로 실행하고 외부 운영 cron이 주기 호출한다. 앱에 타이머를 두지 않는다.
- ADR-004: acting role은 **검증된 `x-session-id` 세션에서만** 도출한다. `req.body.role`은 신뢰하지 않는다.
- 인증 수단은 **기존 Z 세션뿐**이다. 외부 cron은 Z 계정으로 로그인해 `x-session-id`를 붙여 호출한다.
  새 인증 수단(API 키·공유 시크릿·IP allowlist 등)을 발명하지 마라 — 스펙에 근거가 없고 새 비밀 관리 표면이 생긴다.
- 배부는 `DIST_SPOOL_DIR`이 설정된 환경에서만 활성이다(`src/controllers/index.js:52-74`). 미설정이면 tick은 `spool-disabled`로 거부한다.

## 읽어야 할 파일

- `docs/ADR.md` — ADR-008 (3), ADR-004, ADR-006, ADR-007(Z 전용 pull 엔드포인트의 선례).
- `src/services/authorization.js` — 전체(69행). `CAPABILITIES`(6-11행), `manageDistributionTarget`(59-65행) — 새 capability는 이 패턴을 그대로 따른다.
- `src/controllers/index.js` — 전체. 배부 결선부(52-74행), 서비스 결선부(76-88행), 도메인 노출 객체(90-158행, 특히 `distributionTarget` 141-146행).
- `server/index.js` — `STATUS_BY_REASON`(84-100행), `fail()`(102-104행), `readSessionToken`/`sessionOf` 사용 패턴, 배부 대상 라우트(408-439행), 액션 라우트(523-535행: `app.notifyChange('status')` 호출 위치), 로그 다이제스트 라우트(785-792행: Z 게이트 선례), bootstrap(830-878행, 특히 850-855행의 `DIST_SPOOL_DIR` 로그와 "시점 배부(tick)는 phase 48" 주석).
- `src/services/distributionTickService.js` — **step3에서 생성**. `run({ actorUserId })`의 반환 shape.
- `src/services/articleService.js` — **step2에서 수정**. `syncEmbargoStatus`(tick 서비스에 주입할 대상).
- `test/distribution-targets-api.test.js` — 라우트 테스트 골격(`start()`/`api()`/`loginAs()` 헬퍼, 21-56행). 이 step의 신규 라우트 테스트도 같은 골격을 쓴다.
- `test/controllers.test.js` — 배부 결선 테스트 관례(가짜 `spoolFs` 주입, `DIST_SPOOL_DIR` 유무 두 갈래). **특히 40-45행: 도메인 키 전수 `deepEqual` 단언(9개) — 이 step에서 갱신 대상이다.**
- `scripts/seed-articles.js` — 69-72행(`isoAfter`가 현재 시각으로 클램프), 126행(25% 확률 `embargoAt`). 시드 DB로 수동 확인할 때의 동작 이해에 필요하다.
- `docs/ARCHITECTURE.md` — 디렉토리 구조의 services 목록(16행)과 데이터 흐름 `[배부]` 블록(47-52행). 이 step에서 갱신한다.

## 작업

**TDD: 라우트/결선 테스트를 먼저 쓰고 red를 확인한 뒤 구현한다.**

### 1) `src/services/authorization.js` — Z 전용 capability 추가

- `CAPABILITIES`에 `runDistributionTick: ['Z']` 추가(주석에 ADR-008 (3) 근거).
- `runDistributionTick(sessionId)` 함수 추가 — `manageDistributionTarget`과 동일한 형태(세션 검증 → `assertAuthorized` → ok).
  단, 반환에 **`userId`를 포함**한다(`{ ok:true, role, userId }`). 이유: tick이 배부/상태 이력의 `actorUserId`로 stamp해야 감사 추적이 끊기지 않는다.
- 기존 4개 함수의 시그니처/반환은 건드리지 않는다.

### 2) `src/controllers/index.js` — tick 서비스 결선 + 진입점 노출

- `distributionService`가 존재할 때만 `createDistributionTickService({ articleModel, historyModel: articleHistoryModel, distributionService, articleService, now })`를 만든다.
- `createControllers(db, { ..., now })`에 **선택 파라미터 `now`** 를 추가해 tick 서비스에 넘긴다(미전달이면 실제 시계). 테스트는 이걸로 가짜 시계를 주입한다.
- 도메인 진입점 추가:
  ```js
  const distribution = {
    tick: async (sessionId) => { /* 인가 게이트 → tickService.run({ actorUserId }) */ },
  };
  ```
  - **게이트를 먼저** 통과시킨다. 비-Z/미인증에는 `spool-disabled` 여부조차 알려주지 않는다(설정 상태 노출 최소화).
  - `distributionService`(=tick 서비스) 미가용이면 `{ ok:false, reason:'spool-disabled' }`.
  - 반환 객체에 `distribution`을 추가한다(기존 9개 도메인 + 1 = 10개).
- 컨트롤러는 **오케스트레이션만** 한다 — 스캔·판정·전이 로직을 여기에 복제하지 마라.

### 3) `server/index.js` — 라우트

```js
app.post('/api/distribution/tick', async (req, res, next) => { ... });
```
- 본문(body)을 읽지 않는다 — 파라미터가 없다. `req.body.role` 같은 값은 절대 참조하지 않는다(ADR-004).
- `const r = await controllers.distribution.tick(readSessionToken(req));`
  - `r.ok`가 아니면 `fail(res, r)`.
  - 성공이고 `r.distributed.length > 0`이면 `app.notifyChange('status')`(SSE 무효화 신호 — 목록의 상태 배지가 갱신돼야 한다). 변경이 없으면 신호를 보내지 않는다(불필요한 전체 재조회 방지).
- **async 라우트이므로 반드시 `try { ... } catch (e) { next(e); }`** 로 감싼다. Express 4는 async 핸들러의 rejection을 잡지 못해 미처리 거부로 샌다.
- `STATUS_BY_REASON`에 `'spool-disabled': 503` 추가(배부 미설정은 클라이언트 잘못이 아니다).
- 라우트 등록 위치는 배부 대상 라우트(408-439행) 바로 아래가 자연스럽다. 경로가 `/api/distribution-targets`와 충돌하지 않는지 확인하라.
- bootstrap(850-855행)의 "시점 배부(tick)는 phase 48 — 앱에 타이머/주기 실행은 두지 않는다" 주석을 현행화한다:
  **여전히 앱에 타이머를 만들지 않으며**, tick은 외부 cron이 `POST /api/distribution/tick`을 호출해 실행한다는 사실을 적는다. `setInterval` 추가 금지.

### 4) 테스트

**(a) `test/distribution-tick-api.test.js` (신규, 라우트 계약)** — `test/distribution-targets-api.test.js`의 `start()/api()/loginAs()` 골격 재사용:
- 미인증(`x-session-id` 없음) → **401** `unauthenticated`.
- R/D 세션 → **403** `forbidden`. (body에 `role:'Z'`를 실어도 403 — ADR-004 증거)
- Z 세션 + `DIST_SPOOL_DIR` 미설정 → **503** `spool-disabled`.
- Z 세션 + 스풀 설정(가짜 `spoolFs`) + 도래한 엠바고 기사 → **200**, 응답에 처리 요약(`distributed`·`scanned` 등)이 담기고 실제로 스풀 쓰기가 일어난다.
- 같은 호출을 한 번 더 → 200이지만 `distributed`가 비어 있다(멱등).
- **응답 위생**: 실패가 섞인 상황(쓰기 실패 `spoolFs`)에서 200 응답의 `JSON.stringify(body)`에 **`spoolDir`·스풀 루트 경로 문자열이 없다**.
  근거: step3이 `failed`를 `{ articleId, targetId, kind, reason }`로 투영하도록 계약했다. 이 단언이 그 계약의 transport 쪽 잠금이다.

**(b) `test/controllers.test.js` (기존 파일 — 아래 기존 단언 갱신이 **필수**)**:
- **`test/controllers.test.js:40-45` 갱신(필수)**: 이 테스트는 `assert.deepEqual(Object.keys(controllers).sort(), [...9개...])`로 도메인 키를 **전수 단언**한다.
  `distribution`을 노출하면 이 단언이 깨져 **신규 실패 1건**이 생기고 AC("기존 4건 그대로 + 신규 실패 0")를 만족할 수 없다.
  → 기대 배열에 `'distribution'`을 추가(정렬 위치 주의: `article`, `auth`, `collection`, **`distribution`**, `distributionTarget`, …)하고,
  테스트 제목 `createControllers: 9개 도메인과 메서드를 결선한다`를 **10개**로 갱신한다. 같은 테스트에서 `typeof controllers.distribution.tick === 'function'`도 단언한다.
  **우회 금지**: 이 단언을 피하려고 `distributionTarget.tick`처럼 기존 도메인에 얹지 마라 — 배부 대상 CRUD(phase 46)와 배부 실행은 다른 책임이다.
- `createControllers(db, { env:{...,DIST_SPOOL_DIR}, spoolFs, sessionService, now })`로 가짜 시계를 주입해
  1차 엠바고 도래 기사가 tick으로 press 배부되고 상태가 `DES`→`DPS`(1차만) 또는 `DES`→`EPS`(1+2차)로 승격되는 end-to-end 1건.
- `DIST_SPOOL_DIR` 미설정 시 `controllers.distribution.tick(zSid)`가 `spool-disabled`이고 파일 쓰기 0건.

### 5) `docs/ARCHITECTURE.md` 갱신 (additive)

- 16행 services 목록에 `distributionTick`(및 step0의 `embargoPolicy`)을 추가한다.
- 47-52행 `[배부]` 흐름에 tick 경로를 덧붙인다:
  `외부 cron → POST /api/distribution/tick(Z 세션) → distributionTickService(도래+미배부 스캔) → distributionService → spoolWriter … → syncEmbargoStatus(DES→EPS→DPS)`.
  그리고 엠바고 기사 생애주기가 `RDS→DES→EPS→DPS`임을 한 줄로 반영한다(기존 `EPS →` 표기 현행화).
- 선택: `src/services/distributionService.js:10-12`, `src/services/distributionTargetService.js:5`의 "phase 48"/"EPS→DPS" 주석을 현행 사실로 다듬어도 된다(**주석만** — 동작 변경 금지).

## Acceptance Criteria

```bash
node --test test/distribution-tick-api.test.js test/controllers.test.js
npm test
npm run lint
```

- 신규/수정 테스트 green. 단 `test/controllers.test.js`의 **기존 실패 1건**(아래 목록 1번)은 그대로 실패할 수 있다 — 이 step에서 고치지 않는다.
- `npm test` 기준선: **총 527 / pass 523 / fail 4**(phase 47 머지본의 기존 실패 — Windows 경로 구분자 `\` vs `/` 단언, phase 48 범위 밖):
  1. `createControllers: DIST_SPOOL_DIR 설정 시 송고가 활성 수신처 스풀에 배부된다` (`test/controllers.test.js`)
  2. `레거시 행의 잘못된 spoolDir는 실제 writer가 거부해 failed로 격리된다(경로 조작 방어)` (`test/distributionService.test.js:265`)
  3. `spoolWriter: 수신처 폴더를 recursive mkdir 후 임시 파일에 쓰고 rename으로 게시한다` (`test/spoolWriter.test.js`)
  4. `spoolWriter: 파일명은 <articleId>_<timestamp>.json 이며 재배부해도 덮어쓰지 않는다` (`test/spoolWriter.test.js`)
  → 합격 조건은 **"fail이 위 4건 그대로, 신규 실패 0"**.
  **주의**: 이 step은 `test/controllers.test.js`를 수정한다(1번 실패 테스트와 같은 파일). 새로 추가하는 단언에서 경로를 문자열로 비교하지 말고
  `spoolFs.calls`의 호출 여부/개수나 `path.join`으로 만든 기대값을 쓰라 — 같은 종류의 플랫폼 의존 실패를 새로 만들지 마라.
- `npm run lint` clean.
- web 무접촉이므로 `npm run test:web`/`npm run build`는 이 step의 AC가 아니다.

## 검증 절차

1. 라우트/결선 테스트 작성 → red 확인(404/미구현).
2. 구현 → 신규 테스트 green.
3. `npm test` 후 fail 목록을 위 4건과 이름 대조(신규 실패 0).
4. 인가 게이트 증거: 비-Z 403 테스트가 body에 `role:'Z'`를 실은 상태로 통과하는지 확인.
5. 타이머 부재 확인: `grep -rn "setInterval\|setTimeout" server/index.js src/controllers/index.js` 결과에 이번 diff로 추가된 항목이 **0건**인지 확인.
6. 응답 위생 확인: 실패 케이스 200 응답 본문에 `spoolDir`/스풀 경로 문자열이 없음(위 (a) 마지막 단언).
7. `git diff --stat`이 `src/services/authorization.js`, `src/controllers/index.js`, `server/index.js`, `docs/ARCHITECTURE.md`, 테스트 2개(+선택 주석 2파일)로 한정되는지 확인.
8. **시드된 개발 DB로 수동 확인할 때의 주의(테스터 인지 사항)**: `scripts/seed-articles.js:126`은 25% 확률로 `embargoAt`를 채우고,
   `isoAfter()`(69-72행)가 `Math.min(ms, nowMs())`로 **현재 시각 이하로 클램프**하므로 시드된 엠바고 시각은 사실상 **전부 과거(=즉시 도래)** 다.
   그중 일부는 `status='DPS'`이고 `distributedAt`은 null·배부 이력도 없다 → `DIST_SPOOL_DIR`을 켜고 tick을 돌리면 **레거시 DPS 픽업이 실제로 발동**해 스풀 파일이 무더기로 생긴다.
   이는 사용자 확정 스펙 B.8의 **의도된 동작**이다. 버그나 예상치 못한 유출로 오해하지 마라(단, 상태는 DPS 그대로여야 한다 — 역행 없음).

## 금지사항

- 라우트/컨트롤러에 스캔·시각 비교·상태 전이 로직을 재구현하지 마라. 이유: ADR-006 얇은 transport — 로직이 두 곳으로 갈라지면 규칙이 발산한다.
- `req.body`에서 role·시각(`now`)·대상 기사 목록을 받지 마라. 이유: 클라이언트가 시계를 조작하면 엠바고가 무력화된다(ADR-004 신뢰 경계는 서버).
- 앱 부트스트랩에 `setInterval`/워커/스케줄러를 넣지 마라. 이유: ADR-008 (3)이 외부 cron pull을 명시했고, 중복 인스턴스가 중복 배부를 만든다.
- 새 인증 수단(API 키/토큰/IP allowlist)을 도입하지 마라. 이유: 스펙 근거가 없고 비밀 관리 표면이 늘어난다 — Z 세션으로 충분하다.
- tick 응답에 기사 본문·수신처 비밀 정보를 담지 마라. 이유: 로그/응답 마스킹 규율(식별자와 사유만).
- GET으로 tick을 노출하지 마라. 이유: 부수효과가 있는 연산이며, 브라우저 프리페치/크롤러가 배부를 트리거할 수 있다.
- `src/services/*`(step0-3에서 만든 도메인 모듈)의 동작을 이 step에서 바꾸지 마라. 이유: 결선 step이 도메인을 손대면 회귀 원인 격리가 불가능하다.
