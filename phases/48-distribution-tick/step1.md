# Step 1: tick-service

**시점 배부(tick)의 도메인 서비스**를 신규 모듈로 만든다: 주입된 `now` 기준으로 엠바고 시각이 도래한
EPS 기사를 찾아 `distributionService.distribute`로 배부하고(멱등), step0의
`completeEmbargoDistribution`으로 완결 전이를 시도한다.

HTTP 라우트/컨트롤러 결선은 이 step의 범위가 아니다(step2). 이 step에서 만드는 것은
`src/services/distributionTickService.js` 와 `src/services/authorization.js`의 capability 1건뿐이다.

## 읽어야 할 파일

- `docs/ADR.md` — **ADR-008 (3)**: "시점 배부(엠바고 1·2차 시각)는 앱 내 타이머가 아니라 `POST /api/distribution/tick`(Z/시스템 전용) pull 엔드포인트로 실행한다 — 외부 운영 루틴이 주기 호출한다." + ADR-004(신뢰 경계), ADR-006(계층).
- `docs/news.md` — 엠바고 규칙 절(256~263행).
- `src/services/distributionService.js` — **전체(102줄)**. 재사용할 시그니처:
  ```js
  createDistributionService({ distributionTargetModel, articleModel, historyModel, spoolWriter, now, onFailure })
  async distribute(articleId, { kinds, actorUserId = null })
  // -> { ok:true, distributed:[{targetId,kind,spoolDir,file}], failed:[{targetId,kind,reason}] }
  //  | { ok:false, reason:'spool-disabled' | 'not-found' }
  ```
  L84~89에서 성공 kind마다 `ArticleHistory(eventType='distribute', action=kind)`를 남긴다 — **멱등 판정 근거**.
  `distribute`는 **async**이며 내부에서 스풀 파일 쓰기를 `await`한다(= 호출 사이에 다른 실행이 끼어들 수 있다).
- `src/services/articleService.js` — **step0 산출물**:
  - `export function requiredDistributionKinds(contents)` — 모듈 최상위 named export, 순수 함수. **엠바고→요구 kind 매핑의 단일 출처.**
  - `completeEmbargoDistribution(articleId, { actorUserId })` — 동기, 반환 `{ ok, status, transitioned, required, distributed, reason? }`.
  - `distributionKindsForSend(status, contents)` (L75~, phase 47) — 송고 시 즉시 배부 kinds. 2차 엠바고만 설정된 기사에 `['press']`를 반환한다(아래 "송고 시 press 예외"의 근거).
- `src/models/articleModel.js` — `query(filters)`(L73~): `status` 문자열/배열 IN 필터 지원, **Contents 행 전체**(`articleId, status, embargoAt, secondEmbargoAt, distributedAt, sentAt, ...`)를 반환.
- `src/models/articleHistoryModel.js` — `queryByArticle(articleId)`(L28~34).
- `src/services/authorization.js` — **전체(68줄)**. `CAPABILITIES`(L6~11), `manageDistributionTarget(sessionId, op, payload)`(L59~65)가 **동형 템플릿**이다(`sessionService.touchSession` → `assertAuthorized` → `{ ok:true, role }`).
- `src/services/distributionTargetService.js` — L1~10 주석(서비스가 게이트를 첫 줄에서 강제하는 관례).
- `test/distributionService.test.js`, `test/distributionTargetService.test.js` — 하네스 관례(in-memory `DatabaseSync` + 실제 `sessionService`/`authorization`으로 역할별 세션 발급, 가짜 spoolWriter 주입).

## 시점 판정 규약 (구현자가 임의로 바꾸지 마라)

- **`now` 계약**: 주입되는 `now`는 **현재 시각(Date)을 반환하는 함수**이며 기본값은 `() => new Date()`다. 서비스는 판정 때마다 `now()`를 호출해 시각을 얻는다.
- **도래(due) 판정**: 어떤 시각 문자열 `value`에 대해 **`Date.parse(value)`가 유한수이고 `Date.parse(value) <= now().getTime()`**이면 도래로 본다. `Date.parse(value)`가 `NaN`이거나 `value`가 falsy면 **미도래로 취급**(배부하지 않는다).
  - 근거: `Contents.embargoAt`은 `VARCHAR`이고(`src/db/schema.js:41`) 입력이 자유 텍스트라 포맷 보장이 없다. 파싱 불가 값을 배부하면 되돌릴 수 없으므로 **안전측 실패**를 택한다.
  - 오프셋 없는 문자열(`'2026-01-01T09:00'`)은 Date 표준대로 서버 로컬 타임존으로 해석된다. 이 동작을 문자열 조작으로 "보정"하지 마라.
- **kind별 도래 시각 매핑**: `embargoAt` 도래 → `press`. `secondEmbargoAt` 도래 → `nonpress`. (news.md 엠바고 규칙)
- **송고 시 press 예외(2차 엠바고만인 기사)**: EPS이고 `!embargoAt && secondEmbargoAt`이면 `press`의 도래 시각은 **송고 시점**이므로(news.md: "2차 엠바고 시간에는 비언론사에 배부하는데, 송고시 바로 언론사에 배부한다") tick에서는 **항상 도래**로 본다. 이미 배부된 kind를 빼는 차집합이 중복을 차단하므로 안전하며, 송고 훅의 press 배부가 실패했더라도 다음 tick이 press를 due로 재평가해 완결 전이(EPS→DPS)에 도달할 수 있다.
- **due kinds 계산식(단일 출처 고정)**:
  ```
  dueKinds(article) = requiredDistributionKinds(contents)          // step0 함수 재사용 — 재구현 금지
                      ∩ { 도래한 시각의 kind }                      // 위 매핑 + Date.parse 규칙 + 송고 시 press 예외
                      − { 이미 배부된 kind }                        // ArticleHistory eventType='distribute', action=kind
  ```
  - `requiredDistributionKinds`가 포함하지 않은 kind는 **도래했더라도 배부하지 않는다**(요구 집합 밖 배부 금지).
  - 결과 순서는 `['press','nonpress']` 상대순서를 유지한다.
- **후보 집합**: `articleModel.query({ status: 'EPS' })`. EPS가 아닌 상태(DPS/EEH/EEK/RDS…)는 tick 대상이 아니다.
- **완결 전이**: due 배부 수행 여부와 무관하게 후보마다 `articleService.completeEmbargoDistribution(articleId, { actorUserId })`를 **배부 이후에** 호출한다. 이유: 과거 tick에서 배부는 됐으나 전이가 누락된 기사를 다음 tick이 회복해야 한다.
- **단일 실행(single-flight)**: 같은 프로세스에서 이전 `run`이 끝나기 전 새 `run`이 들어오면 **즉시 `{ ok:false, reason:'busy' }`**로 거절한다. 이유: 멱등 판정이 "이력 조회 후 배부"(check-then-act)인데 `distribute`가 await 지점에서 양보하므로, 중첩 호출 시 두 실행이 모두 "이력 없음"으로 판정해 같은 kind를 두 번 스풀에 기록한다 — 외부 전송기가 기사를 두 번 발송하며 되돌릴 수 없다(ADR-008 트레이드오프: 앱은 발송 결과를 모른다).

## 작업

**TDD: 테스트를 먼저 쓰고 red를 확인한 뒤 구현한다.**

### 1) `test/distributionTickService.test.js` (신규, node:test)

하네스: in-memory `DatabaseSync` + `createSchema` + 실제 `createSessionService`/`createAuthorization`,
가짜 `distributionService`(호출 인자 기록 + 결과 조작 + **외부에서 resolve 가능한 deferred 반환 옵션**),
가짜/실제 `articleModel`·`historyModel`, 주입 `now`(고정 시각을 반환하는 함수 — 예: `() => new Date('2026-01-01T00:00:00Z')`).

인가:
- 세션 없음/잘못된 sid → `{ ok:false, reason:'unauthenticated' }`, **후보 조회조차 하지 않는다**.
- role `R`/`D` 세션 → `{ ok:false, reason:'forbidden' }`, 배부 0회.
- role `Z` 세션 → 실행.
- **게이트가 스풀 설정 검사보다 먼저** 수행된다: `distributionService` 미주입 + 비Z 세션이면 `forbidden`(스풀 상태가 새지 않는다).

실행:
- `distributionService` 미주입/undefined + Z 세션 → `{ ok:false, reason:'spool-disabled' }`, **DB 무변경**.
- 1차만 설정 + `embargoAt` 도래(`Date.parse(embargoAt) <= now().getTime()`) + 이력 없음 → `distribute(articleId, { kinds:['press'], actorUserId })` **1회**.
- 1차만 설정 + `embargoAt` 미도래(`Date.parse(embargoAt) > now().getTime()`) → `distribute` **미호출**.
- 1+2차 설정 + 둘 다 도래 + 이력 없음 → `kinds:['press','nonpress']` **1회 호출**(kind마다 나눠 호출하지 않는다).
- 1+2차 설정 + 1차만 도래 → `kinds:['press']`.
- 2차만 설정 + 2차 도래 + `press` 이력 이미 있음 → `kinds:['nonpress']`.
- **송고 시 press 예외 회복**: 2차만 설정 + 2차 **미도래** + `press` 이력 **없음** → `kinds:['press']` 1회 호출(송고 훅의 press 배부가 실패한 기사를 tick이 회복한다).
- **송고 시 press 예외 + 멱등**: 2차만 설정 + 2차 미도래 + `press` 이력 **있음** → `distribute` 미호출(차집합이 중복을 차단).
- **멱등**: `press` 이력이 이미 있고 1차만 설정 → `distribute` 미호출, 그리고 `completeEmbargoDistribution`은 호출되어 전이가 회복된다.
- `embargoAt`이 `'없음'`/`''`/`'not-a-date'` → `Date.parse`가 `NaN`이므로 미도래로 취급, 배부 0회(throw 금지).
- 후보가 0건 → `{ ok:true, evaluated:0, distributed:[], transitioned:[], failed:[] }`.
- **실패 격리**: 후보 3건 중 2번째의 `distribute`가 reject/throw해도 1·3번째는 처리되고, 반환의 `failed`에 `{ articleId, reason }`이 담긴다.
- `completeEmbargoDistribution`이 `transitioned:true`를 주면 반환 `transitioned` 배열에 articleId가 담긴다.
- **호출 순서**: 같은 기사에 대해 `distribute` → `completeEmbargoDistribution` 순서로 호출된다(전자 await 완료 후).

단일 실행(single-flight) — **필수**:
- 가짜 `distribute`가 외부 제어 deferred를 반환하도록 두고,
  ```
  const p1 = svc.run(zSid);   // await 하지 않는다 — 배부 도중 상태로 진입
  const p2 = svc.run(zSid);   // 중첩 호출
  resolveDeferred();          // 첫 실행의 스풀 쓰기 완료
  const [r1, r2] = await Promise.all([p1, p2]);
  ```
  단언: `distribute` 총 호출 횟수 **1회**, `r2`는 `{ ok:false, reason:'busy' }`, `r1.ok === true`.
- **게이트 우선순위**: 첫 run이 진행 중인 상태에서 role `R` 세션으로 호출하면 `busy`가 아니라 `forbidden`이 반환된다(인가가 실행 상태보다 먼저 판정된다).
- **플래그 해제**: 첫 run 내부에서 예외가 발생해도(예: `articleModel.query`가 throw) 그 다음 `run`은 `busy`가 아니라 정상 실행된다(try/finally 해제 확인).
- 각 테스트는 이전 `run` Promise를 **반드시 await한 뒤** 다음 단언으로 넘어간다(단일 실행 플래그는 모듈 스코프라 인스턴스를 새로 만들어도 공유된다).

주의: **시간 대기(`setTimeout`/sleep) 기반 단언을 쓰지 마라.** 스케줄러 부재는 아래 검증 절차 2의 grep으로 확인하고,
배부 횟수는 `run` Promise가 resolve된 **직후 동기적으로** 단언한다.

정합성 회귀(엠바고→kind 단일 출처):
- 같은 `contents`(1+2차 설정, 두 시각 모두 과거)에 대해 `requiredDistributionKinds(contents)`(step0 export)와
  tick이 산출한 `kinds`가 **어긋나지 않음**을 단언한다: tick의 `kinds` ⊆ `requiredDistributionKinds(contents)`이고,
  이력이 전무한 상태에서는 두 집합이 동일하다. (2차만 설정 + press 이력 있음 케이스에서는 tick `kinds`가 `['nonpress']`,
  required는 `['press','nonpress']` — 차집합이 정확히 이미 배부된 kind임을 단언.)

### 2) `src/services/authorization.js` — capability 1개 additive 추가

- `CAPABILITIES`에 `runDistributionTick: ['Z'], // 시점 배부 tick 실행 — Z 전용 (ADR-008 (3))` 추가.
- `manageDistributionTarget`(L59~65)과 **동형**으로 게이트 함수를 추가하고 반환 객체에 포함:
  ```js
  function runDistributionTick(sessionId) // -> { ok:true, role, userId } | { ok:false, reason:'unauthenticated'|'forbidden' }
  ```
  `userId`는 `touchSession` 결과의 세션 사용자다(배부/전이 이력의 actor로 쓴다).
- 기존 capability/게이트 동작은 변경하지 않는다.

### 3) `src/services/distributionTickService.js` (신규)

```js
import { requiredDistributionKinds } from './articleService.js'; // 엠바고→kind 매핑 단일 출처(재구현 금지)

// 프로세스 내 단일 실행 게이트 — 중첩 tick이 같은 kind를 중복 배부하는 것을 막는다.
let running = false;

export function createDistributionTickService({
  articleModel,
  historyModel,
  distributionService,   // 선택 — 미주입이면 run이 { ok:false, reason:'spool-disabled' }
  articleService,        // step0의 completeEmbargoDistribution 사용
  authorization,
  now = () => new Date(),   // 현재 시각(Date)을 반환하는 함수
}) {
  async function run(sessionId) {
    const gate = authorization.runDistributionTick(sessionId);
    if (!gate.ok) return gate;                      // 1) 인가가 항상 먼저
    if (running) return { ok: false, reason: 'busy' }; // 2) 그 다음 단일 실행 게이트
    running = true;
    try {
      /* spool-disabled 확인 → 후보 순회 → distribute → completeEmbargoDistribution */
    } finally {
      running = false;                              // 예외 경로에서도 반드시 해제
    }
  }
  return { run };
}
```

반환 계약:
```js
// { ok:true, evaluated:Number, distributed:[{ articleId, kinds:string[] }],
//   transitioned:[articleId], failed:[{ articleId, reason }] }
// | { ok:false, reason:'unauthenticated'|'forbidden'|'spool-disabled'|'busy' }
```

반드시 지킬 규칙:
1. **첫 줄에서 게이트**: `const gate = authorization.runDistributionTick(sessionId); if (!gate.ok) return gate;` — 그 뒤에야 스풀/DB에 접근한다. `actorUserId`는 `gate.userId`에서만 얻는다(호출자가 준 값 금지, ADR-004).
2. **단일 실행**: `running` 플래그는 **모듈 스코프**에 둔다(인스턴스 스코프 금지 — 합성 루트가 서비스를 여러 번 만들어도 프로세스 내 배부는 직렬화돼야 한다). 해제는 반드시 `finally`에서 한다. `busy` 판정은 인가 게이트 **통과 후**에 한다(비인가 호출자에게 실행 상태를 노출하지 않는다).
3. `run`은 **호출당 정확히 1회 순회**한다. 내부에 `setInterval`/`setTimeout`/재귀 스케줄/자동 재시도를 두지 마라(ADR-008). `busy`로 거절한 요청을 내부에서 대기·큐잉하지 마라 — 다음 외부 호출이 처리한다.
4. due kinds는 위 **계산식**대로만 구한다(도래 판정은 `Date.parse(value)`가 유한수이고 `<= now().getTime()`, 2차 엠바고만인 기사의 press는 항상 도래). `requiredDistributionKinds`를 import해 쓰고, 엠바고 조합 판정표를 이 파일에 다시 적지 마라.
5. 스풀 파일 쓰기·대상 선정·`distributedAt` 갱신·`distribute` 이력 기록을 **재구현하지 마라** — 전부 `distributionService.distribute`에 위임한다.
6. 상태 전이를 직접 `articleModel.update`로 하지 마라 — `articleService.completeEmbargoDistribution`에만 위임한다.
7. 기사 1건의 예외가 루프를 중단시키지 않는다(try/catch로 격리 후 `failed`에 기록).
8. 이 모듈은 `node:fs`·`fetch`·타이머를 import하지 않는다(순수 도메인, ADR-006).
9. 로그·SSE 신호는 이 모듈의 책임이 아니다(step2/3의 transport·합성 루트가 한다).

## Acceptance Criteria

```bash
npm test && npm run lint
```

- 신규 테스트 green, 기존 백엔드 테스트 무회귀(특히 `test/authorization*.test.js`·`test/distributionService.test.js`).
- lint 경고 0.

## 검증 절차

1. `npm test` 전량 green.
2. `grep -rn "setInterval\|setTimeout\|node:fs\|fetch(" src/services/distributionTickService.js` → **0건**.
3. `grep -rn "spoolDir\|writeFile\|distributedAt" src/services/distributionTickService.js` → **0건**(스풀 로직 재구현 없음).
4. `grep -rn "articleModel.update" src/services/distributionTickService.js` → **0건**(전이 재구현 없음).
5. `grep -rn "requiredDistributionKinds" src/services/distributionTickService.js` → **1건 이상**(step0 함수 재사용 확인), 그리고 같은 파일에 `secondEmbargoAt`을 근거로 요구 집합을 새로 만드는 분기가 없는지 육안 확인(도래 판정 — 2차 도래 매핑과 "송고 시 press 예외" — 에만 쓰여야 한다).
6. `grep -rn "let running\|finally" src/services/distributionTickService.js` → 단일 실행 플래그와 `finally` 해제가 **각 1건 이상**.
7. `git diff --stat` → `src/services/distributionTickService.js`(신규), `src/services/authorization.js`, 신규 테스트만. `server/**`·`web/**` 무접촉.

## 금지사항

- 세션 외의 인증 경로(환경변수 토큰, `x-tick-secret` 헤더, IP 허용목록 등)를 새로 만들지 마라. 이유: 인증 메커니즘 추가는 ADR 개정 사안이고 이번 phase의 확정 지시에 없다 — 필요하면 계획을 되돌려 결정을 받는다.
- `sessionId`/role/`now`를 함수 인자로 "테스트 편의상" 클라이언트가 통제 가능한 형태로 열지 마라(예: `run(sessionId, { now })`). 이유: HTTP로 노출되면 미래 시각을 주입해 엠바고를 조기 해제할 수 있다. `now`는 **서비스 생성 시점 주입**만 허용한다.
- 단일 실행 플래그를 `createDistributionTickService` 클로저 안(인스턴스별)으로 옮기지 마라. 이유: 인스턴스가 둘이면 게이트가 무력화돼 중복 배부가 다시 열린다.
- `busy`일 때 요청을 큐에 쌓거나 재시도 루프를 돌리지 마라. 이유: 앱 내부에 사실상의 스케줄러가 생겨 ADR-008(외부 cron이 유일한 트리거)을 위반한다.
- 후보 조회 범위를 EPS 밖으로 넓히지 마라(예: 전체 기사 스캔 후 필터). 이유: 대상이 아닌 상태(EEH/EEK/DPD 등)를 배부하면 되돌릴 수 없고, 풀스캔은 목록 성능을 갉아먹는다.
- 이미 배부된 kind를 "혹시 모르니" 다시 배부하지 마라. 이유: 스풀 파일이 중복 생성돼 외부 전송기가 기사를 두 번 발송한다.
- "송고 시 press 예외"를 1차 엠바고가 설정된 기사(`embargoAt` truthy)로 확대하지 마라. 이유: 1차 엠바고 기사의 press 도래 시각은 `embargoAt`이며, 이를 항상 도래로 보면 엠바고 조기 해제가 된다.
- 엠바고 시각을 정규화/마이그레이션하는 코드를 넣지 마라(예: 저장값을 ISO로 덮어쓰기). 이유: DB 비파괴 원칙 위반이며 포맷 규정은 문서에 없다.
- 배부 실패를 이유로 이미 성공한 배부를 되돌리거나 status를 되돌리지 마라. 이유: 앱은 발송 결과를 알 수 없고(ADR-008 트레이드오프), 이력은 append-only다.
