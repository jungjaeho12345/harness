# Step 3: distribute-notify

**배부 완료 시 SSE 무효화 신호**를 발행한다. 송고 훅(phase 47)의 배부는 fire-and-forget이라
라우트가 이미 응답을 보낸 **뒤에** `Contents.distributedAt`이 갱신된다 — 목록의 배부시간이 다음 수동
새로고침 전까지 낡은 채로 남는 결함을 해소한다.

이 step이 배부 신호(`'update'`)의 **단일 출처**를 확정한다: `distributionService.onDistributed` → 합성 루트의 `onChange('update')`.
tick 라우트(step2)는 status 전이 신호만 발행하며, 배부 신호를 중복 발행하지 않는다.

변경은 **선택 콜백 추가 + 합성 루트 결선**뿐이다. 도메인 로직·판정 규칙은 건드리지 않는다.

## 읽어야 할 파일

- `docs/ADR.md` — **ADR-005**(SSE는 무효화 신호만; 행 데이터 push 금지), ADR-006, ADR-008.
- `src/services/distributionService.js` — **전체(102줄)**. 특히:
  - `createDistributionService({ ..., onFailure })`와 `notifyFailure(info)`(L27~31) — **콜백 격리 관례의 템플릿**(try/catch로 감싸 실패가 배부를 깨지 않게 한다)
  - `distribute` 말미의 `if (distributed.length > 0) { articleModel.update(articleId, { contents: { distributedAt: now() } }); }`(L94~96)
- `src/controllers/index.js` — `createControllers(db, { ..., spoolFs, logService })`(L33~40), `onFailure` 결선(L68~72), **step2에서 추가된** `distribution` 도메인(`tick`).
- `server/index.js` — `app.notifyChange`(L297), tick 라우트(step2 산출물, `notifyChange('status')` 1개만 있어야 한다), 부트스트랩 순서: `createControllers(...)`(L838) → `createApp(...)`(L843). **컨트롤러가 app보다 먼저 만들어진다**(늦은 바인딩이 필요한 이유).
- **step2 산출물**: `POST /api/distribution/tick` 라우트, `controllers.distribution.tick`, `STATUS_BY_REASON.busy = 409`.
- `test/distributionService.test.js`, `test/controllers.test.js` — 콜백 주입·가짜 `spoolFs` 하네스 관례.
- `test/distribution-tick-api.test.js` — **step2 산출물**. 이번 step의 신호 횟수 회귀 테스트를 여기에 추가한다(Z 세션 발급 + EPS 픽스처 + 가짜 `spoolFs`가 이미 갖춰져 있다).
- `test/distribution-targets-api.test.js` — **역할별 세션 발급 관례의 근거**(실제 `sessionService`로 로그인해 `x-session-id`로 쓸 세션ID를 얻는 방식). 신호 횟수 회귀 테스트에서 Z 세션(`zSid`)을 만들 때 이 관례를 그대로 따른다.

## 작업

**TDD: 테스트를 먼저 쓰고 red를 확인한 뒤 구현한다.**

### 1) 테스트

`test/distributionService.test.js` 보강:
- `onDistributed` 주입 + 성공 배부 → `{ articleId, kinds:['press'] }` 형태로 **1회** 호출(수신처 N곳이어도 호출은 배부 1회당 1번).
- 배부 성공 0건(대상 없음/전부 실패) → **미호출**.
- `onDistributed` 미주입 → 기존 동작과 완전히 동일(하위호환).
- `onDistributed`가 throw → `distribute`의 반환값과 `distributedAt` 갱신·이력 기록이 영향받지 않는다(`onFailure` 격리와 동형).
- 콜백에 **본문/스풀 경로가 넘어가지 않는다**(전달 객체 키를 단언 — `articleId`, `kinds` 외 키 없음).

`test/controllers.test.js` 보강:
- `createControllers(db, { env:{ DIST_SPOOL_DIR:'spool' }, spoolFs: 가짜, onChange: 스파이 })`로 만든 뒤 배부가 성공하면 `onChange`가 `'update'`로 호출된다.
- `onChange` 미주입이어도 배부가 정상 동작한다(기본값 no-op).

**신호 횟수 회귀 테스트(필수)** — **`test/distribution-tick-api.test.js`에 둔다**(step2가 만든 Z 세션 발급 하네스·EPS 픽스처·가짜 `spoolFs`를 재사용하며, 컨트롤러를 직접 호출해 HTTP 없이 신호 횟수만 센다). Z 세션은 `test/distribution-targets-api.test.js`의 관례대로 실제 `sessionService` 로그인으로 발급한다:
- EPS 기사 **1건**(과거 1차 엠바고, 수신처 2곳)에 대해 `controllers.distribution.tick(zSid)`를 1회 호출 → `onChange` 스파이 호출 총 **1회**, 인자 `'update'`(수신처 수만큼 늘지 않는다).
- EPS 기사 **2건**이 모두 배부되는 tick 1회 → `onChange` 호출 **2회**(기사당 1회, 그 이상 아님).
- 배부 대상 0건인 tick 1회 → `onChange` **0회**.
- 라우트 계층 중복 발행 부재는 아래 검증 절차 3의 grep으로 고정한다.

### 2) `src/services/distributionService.js` (additive)

- 생성 옵션에 `onDistributed`(선택)를 추가한다:
  ```js
  createDistributionService({ ..., onFailure, onDistributed })
  // onDistributed({ articleId, kinds: string[] }) — 실제 스풀 기록이 1건 이상 성공한 배부 호출당 1회
  ```
- `notifyFailure`와 동형으로 try/catch 격리한다. **호출 시점은 `distributedAt` 갱신 이후**(신호를 받은 클라이언트가 재조회하면 갱신된 값을 보게).
- 콜백 인자에 기사 본문·`spoolDir`·파일명을 넣지 마라(식별자와 kind만).

### 3) `src/controllers/index.js` (additive)

- 옵션에 `onChange = () => {}` 추가(선택, 기본 no-op)하고 `createDistributionService`에 결선:
  ```js
  onDistributed: () => onChange('update'),
  ```
- 컨트롤러는 `app`/Express를 import하지 않는다 — 콜백만 받는다(계층 분리).

### 4) `server/index.js` 부트스트랩 (늦은 바인딩)

- `createControllers`가 `createApp`보다 먼저 호출되므로, 간접 참조로 연결한다:
  ```js
  const notify = { emit: () => {} };                 // app 생성 전 호출은 조용히 무시
  const controllers = createControllers(db, { sessionService, logService, onChange: (kind) => notify.emit(kind) });
  const app = createApp({ controllers, sessionService, logService, forceHttps });
  notify.emit = app.notifyChange;
  ```
- `createApp` 내부(테스트가 주입하는 경로)는 변경하지 않는다.
- tick 라우트를 확인해 `app.notifyChange('update')` 분기가 남아 있으면 **제거한다**(step2 계획대로라면 이미 없다). 라우트는 `transitioned`에 대한 `'status'` 신호만 발행한다.

## Acceptance Criteria

```bash
npm test && npm run lint && npm run build
```

- 보강 테스트 green(신호 횟수 회귀 포함), 기존 백엔드/웹 테스트 무회귀, lint 경고 0, build clean.

## 검증 절차

1. `npm test` 전량 green.
2. `grep -rn "notifyChange\|express" src/services/ src/controllers/` → **0건**(서비스/컨트롤러가 transport를 직접 참조하지 않는다).
3. `grep -n "notifyChange" server/index.js` → tick 라우트 블록 내에는 **`'status'` 1건만** 존재(`notifyChange('update')`가 tick 라우트에 없음을 육안 확인 — 배부 신호 단일 출처는 `onDistributed`).
4. `grep -rn "onDistributed" src/ server/` → `distributionService.js`·`controllers/index.js` 결선 각 1곳.
5. `git diff --stat` → 소스 3개(`src/services/distributionService.js`, `src/controllers/index.js`, `server/index.js`) + 테스트 3개(`test/distributionService.test.js`, `test/controllers.test.js`, `test/distribution-tick-api.test.js`). `web/**` 무접촉.

## 금지사항

- tick 라우트나 다른 라우트에서 배부에 대한 `'update'` 신호를 추가로 발행하지 마라. 이유: `onDistributed`와 이중 발행이 되어 tick 1회에 신호가 N+1번 나가고, 접속 클라이언트 전체가 중복 재조회한다.
- SSE 이벤트에 기사 데이터(제목·본문·행)를 실어 보내지 마라. 이유: ADR-005는 무효화 신호 전용이다 — 데이터 push는 인가 검사를 우회한다.
- `distributionService`에서 `app.notifyChange`를 직접 import/참조하지 마라. 이유: 도메인 서비스가 transport에 의존하면 ADR-006 계층 방향이 뒤집히고 서비스 테스트가 서버 없이는 못 돈다.
- 콜백을 `await`해 배부 흐름을 막지 마라. 이유: 알림 지연/실패가 스풀 쓰기 완료를 지연시키면 배부 정시성이 신호 처리에 종속된다.
- `distribute` 실패 시에도 신호를 보내지 마라. 이유: 바뀐 것이 없는데 전 클라이언트가 재조회한다.
- 수신처 1곳당 1회씩 신호를 보내지 마라. 이유: 수신처 수에 비례해 신호가 증폭된다 — 기사 단위 1회면 클라이언트 재조회로 충분하다.
- 신호 횟수 회귀 테스트에서 role을 하드코딩한 가짜 세션·가짜 authorization을 쓰지 마라. 이유: 실제 `sessionService` 발급 세션이어야 인가 경로까지 함께 회귀 검증된다(`test/distribution-targets-api.test.js` 관례).
- 이 step에서 tick 판정·엠바고 규칙·상태 전이·단일 실행 게이트 코드를 손대지 마라. 이유: step0~2가 단일 출처이며, 신호 배선 step에서 도메인이 바뀌면 실패 원인 격리가 불가능해진다.
- `web/**`를 수정하지 마라. 이유: 프런트는 이미 SSE 신호에 반응해 재조회한다(배부 UI는 MVP-4 범위).
