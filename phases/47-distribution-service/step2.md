# Step 2: send-hook

## 목표

step0(writer)·step1(service)을 **송고 경로에 결선**한다. 결과적으로:

- **엠바고 없는** 기사가 송고되어 **DPS**가 되면 → 언론사+비언론사 **전체 배부**(`distribute(id, 'all')`).
- **2차 엠바고만** 설정된 기사가 송고되면 → 언론사에 **즉시 배부**(`distribute(id, 'press')`).
  결과 상태가 EPS든 **DPS든**(DDH 송고·재송고 경로) 동일하게 적용된다.
- **1차 엠바고가 설정된 기사는 상태와 무관하게 이번에 배부하지 않는다**(1차/2차 시각 도래 배부 = phase 48).

즉 **배부군은 상태가 아니라 엠바고 설정이 정한다**(§2 판정표) — 상태로 판정하면 엠바고 파기가 발생한다.

그리고 **가장 중요한 불변식**: **스풀 쓰기 실패가 송고를 롤백하거나 실패시키지 않는다.**

배경(자기완결 — 이전 대화를 참조하지 마라):

- **news.md 엠바고 규칙(L256~263)**: 1차 엠바고 시각 → 언론사, 2차 엠바고 시각 → 비언론사이되 **송고 시 바로 언론사**,
  1+2차는 각각. 1차 또는 2차가 설정된 기사는 데스크 미송고에서 송고 시 **EPS**가 된다(L262).
- **ADR-008 (4)**: 엠바고 없는 일반 기사(DPS)는 송고 즉시 언론사+비언론사 전체에 배부하고 `Contents.distributedAt`을 기록한다.
- **ADR-008 (1)(3)**: 앱은 스풀 파일만 쓴다 — **네트워크 egress 없음**, **앱 내 타이머 없음**. 시각 도래 배부는 phase 48의 tick pull.
- **신뢰 경계(ADR-004)**: 배부는 서버 내부(송고 후처리)에서만 트리거된다. **이번 phase에 새 공개 라우트는 없다.**
  `req.body.role` 같은 클라이언트 값은 어디서도 읽지 않는다.
- **step0 산출물**: `src/services/spoolWriter.js` — `createSpoolWriter({ rootDir, fs })` → `{ enabled, write(...) }`(동기, throw 없음).
- **step1 산출물**: `src/services/distributionService.js` — `createDistributionService({ articleModel, distributionTargetModel, historyModel, spoolWriter, now, logger })`
  → `{ distribute(articleId, audience, { actorUserId }) }`(동기, throw 없음, `audience`는 `'press'`\|`'all'`).

## 읽어야 할 파일

라인 번호는 실측 힌트다 — 반드시 심볼명으로 재확인하라.

- `docs/ADR.md` — **ADR-008(L45~48)**, ADR-004(신뢰 경계, L25 부근), ADR-006(얇은 transport·주입, L35~38), ADR-005(SSE 무효화 신호, L30~33).
- `docs/news.md` — 엠바고 규칙(L256~263), 기사 생애주기(L265~), 배부시간 조회(L12).
- `docs/ARCHITECTURE.md` — 디렉토리 구조(L9~30, **이 step에서 L16 services 목록 1줄 갱신**), 계층(L33), 보안 경계(L54~57).
- `README.md` L40~50 — 환경변수 목록(**이 step에서 `DIST_SPOOL_DIR` 1줄 추가**, `RCV_SPOOL_DIR` 표기와 대칭).
- **step0/step1 산출물 전체**: `src/services/spoolWriter.js`, `src/services/distributionService.js`,
  그리고 그 테스트(`test/spoolWriter.test.js`, `test/distributionService.test.js` — 가짜 fs 하네스를 재사용한다).
- `src/services/articleService.js` **전체(287줄)** — 특히:
  - `createArticleService({ articleModel, db, historyModel })`(L69) — **여기에 주입 1개를 additive로 추가한다**.
  - `record` 헬퍼(L72~76) — 부가 기록이 본 기능을 막지 않는 선례.
  - `applyAction`(L124~161): 전이 계산(L128~133) → 엠바고 EPS 후처리(L135~143) → `articleModel.update`(L150) →
    `record({ eventType:'status', ... })`(L152~159) → `return { ok:true, status:finalStatus }`(L160).
- `src/models/articleModel.js` L32~43(`tx` — `BEGIN`/`COMMIT`/`ROLLBACK`), L62~69(`update`가 자체 트랜잭션으로 커밋 후 반환).
- `src/services/lifecycle.js` **전체(50줄)** — `DESK_TABLE`(L12~17): `RDS.send='DPS'`, **`DPS.send='DPS'`(재송고 허용)**,
  `DDH.send='DPS'`, **`EPS`에는 send가 없다**(재송고 미정의). `REPORTER_TABLE`(L20~22): `RDS.send='RDS'`.
- `src/controllers/index.js` **전체(124줄)** — 옵션 시그니처(L27~32), 모델 결선(L34~39), 서비스 결선(L45~53),
  `article` 진입점(L75~89), `return`(L123). **이 step에서 수정한다.**
- `server/index.js` — 부트스트랩 `bootstrap()`(L830~870): `createControllers`(L836), `createLogService`(L841),
  `createApp`(L842), **수집 watcher 블록(L849~869 — env 미설정 시 비활성 선례, 이번 결선의 대칭 청사진)**.
  그리고 송고 라우트(L521~535 — `controllers.article.applyAction` 위임, 이 step에서 **수정하지 않는다**).
- `src/services/logService.js` L27~55 — `debug/info/warn/error` 시그니처(주입 logger 계약).
- 회귀 주의 대상(읽기만): `test/controllers.test.js` L145~166(송고 후 **이력 1건** 단언),
  `test/server.test.js` L215~265(이력/송고이력 단언), `test/articleHistoryService.test.js` L38~64
  (**`assert.deepEqual(r, { ok: true, status: 'EPS' })` — applyAction 반환 shape 정확 일치 단언**).

## 변경할 파일

**수정**
- `src/services/articleService.js` — 주입 1개 추가 + `applyAction` 말미 후처리 훅.
- `src/controllers/index.js` — spoolWriter·distributionService 결선 + 옵션 3개 추가.
- `server/index.js` — 부트스트랩에서 `DIST_SPOOL_DIR`·logger 주입(라우트/미들웨어 **무수정**).
- `README.md` — 환경변수 1줄.
- `docs/ARCHITECTURE.md` — services 목록 1줄.

**신규**
- `test/distributionSendHook.test.js`

**수정 금지**: `web/**`, `src/services/spoolWriter.js`, `src/services/distributionService.js`(step0/1 산출물은 그대로 쓴다),
`src/db/schema.js`, `src/models/**`.

## 인계 사실 (실측 확인됨 — 추측하지 말고 이대로 전제하라)

- **백엔드 기준선 489 pass / 0 fail**(브랜치 tip 기준). 아래 3곳은 **한 글자도 바뀌지 않고 통과해야 한다** —
  바뀌어야 한다면 설계가 틀린 것이다: `test/controllers.test.js` L157(송고 후 이력 **1건**),
  `test/server.test.js` L221(`items.length===1`), `test/articleHistoryService.test.js` L60(`deepEqual(r,{ok:true,status:'EPS'})`).
- **`createControllers`를 14개 테스트 파일이 직접 호출한다** → `distSpoolDir`에 env 기본값을 두지 않는 것은 **협상 불가**다(§3).
- 경로 단언은 반드시 `join`으로 만든 기대값과 비교하라 — Windows에서 `join('/spool','kbs')`는 `\spool\kbs`다.
- `DistributionTarget.active`는 `VARCHAR DEFAULT 'Y'`(`src/db/schema.js` L90)이므로 step1의 엄격 `active==='Y'` 판정이
  정상 행을 누락시키지 않는다(직접 SQL로 NULL을 넣은 행만 제외 — outbound에서 fail-safe).
- 송고 라우트(`server/index.js` L523~535)는 `applyAction` 반환 후 이미 `app.notifyChange('status')`를 호출한다 →
  `distributedAt` 변경도 **같은 신호로 클라이언트에 전달**된다. **새 SSE 신호를 추가하지 마라.**

## 상세 설계

### 1) `src/services/articleService.js` — 주입 추가

```js
export function createArticleService({
  articleModel,
  db,
  historyModel,
  distributionService = null,   // ADR-008 배부. 미주입이면 배부 없음(하위호환 — 기존 호출자 무영향)
}) {
```

- **기본값 `null` 필수.** 기존 호출자(`createControllers`, 다수 테스트)는 이 키를 주지 않는다 — 기본값이 없으면 전부 깨진다.

### 2) `applyAction` 후처리 훅 — 위치와 규칙

`record({ eventType:'status', ... })` **다음**, `return { ok:true, status:finalStatus }` **직전**에 후처리를 넣는다.

**audience 도출은 상태가 아니라 엠바고를 1순위로 본다(확정 정책 — 이 선택을 바꾸지 마라).**

```js
// 배부 후처리(ADR-008) — 상태 전이 저장·이력 기록이 모두 끝난 뒤에만 실행한다.
// 스풀 쓰기 실패는 송고를 실패시키지 않는다: 반환값을 바꾸지 않고, 예외도 밖으로 흘리지 않는다.
if (action === 'send' && distributionService) {
  // 송고 완료 상태에서만 배부한다(R의 RDS 송고, 보류/KILL 결과는 배부 대상이 아니다).
  const sent = finalStatus === 'DPS' || finalStatus === 'EPS';
  // CRITICAL: 엠바고 우선 판정 — 상태(DPS/EPS)로 배부군을 정하지 마라.
  //   DPS는 엠바고 기사에서도 도달한다(DDH→send, DPS 재송고): articleService의 EPS 치환은
  //   fromStatus==='RDS'로 한정돼 있어(L140) 엠바고가 설정된 DDH 기사를 송고하면 EPS가 아니라 DPS가 된다.
  //   상태로 판정하면 그 기사를 즉시 전체 배부해 엠바고를 파기한다.
  const audience = !sent ? null
    : row.contents.embargoAt ? null            // 1차 엠바고 → 시각 배부(phase 48). 지금은 배부하지 않는다.
      : row.contents.secondEmbargoAt ? 'press' // 2차 엠바고만 → 송고 즉시 언론사(news.md L259)
        : (finalStatus === 'DPS' ? 'all' : null); // 엠바고 없음 → 전체(ADR-008 (4))
  if (audience) {
    try { distributionService.distribute(articleId, audience, { actorUserId: userId ?? null }); }
    catch { /* 배부 실패는 송고를 막지 않는다 — 가시성은 distributionService의 logger가 담당 */ }
  }
}
```

이 도출은 `row.contents`(전이 **이전**에 읽은 행)의 엠바고 값을 본다 — `applyAction`은 엠바고 컬럼을 수정하지 않으므로
전이 전후 값이 동일하다. 별도로 재조회하지 마라(불필요한 쿼리 + 경합 표면).

**트랜잭션 경계(반드시 이대로)**:
- `articleModel.update`(L150)는 `articleModel.tx`로 **BEGIN/COMMIT을 스스로 끝내고 반환**한다(L32~43·L62~69).
  따라서 위 후처리는 **커밋 이후**에 실행된다 — 배부 실패가 상태 전이를 롤백할 수 있는 경로가 **구조적으로 존재하지 않는다**.
- **후처리를 `articleModel.update` 앞으로 옮기거나 트랜잭션 안으로 넣지 마라.** 아직 커밋되지 않은 상태를
  스풀 파일이 먼저 반영해 버리거나(파일은 롤백 불가), 파일 IO가 DB 트랜잭션을 열어둔 채 지연시킨다.
- 후처리는 `distributionService`가 반환한 결과를 **보지 않는다**(성공/실패 모두 동일 처리).

**반환 shape 불변(CRITICAL)**:
- `applyAction`의 반환은 **`{ ok: true, status }` 그대로**다. 배부 결과 필드를 추가하지 마라.
  이유: `test/articleHistoryService.test.js` L60의 `assert.deepEqual(r, { ok: true, status: 'EPS' })`처럼
  **정확 일치 단언**이 여러 곳에 있어 키를 하나만 추가해도 기존 테스트가 깨진다(그리고 HTTP 응답 계약도 바뀐다).

**판정표 (embargo-first — 모든 도달 경로를 덮는다)**:

| # | action | 전이 전 status | embargoAt | secondEmbargoAt | finalStatus | 동작 | 근거 |
|---|--------|----------------|-----------|-----------------|-------------|------|------|
| 1 | send | RDS(D/Z) | 없음 | 없음 | `DPS` | `distribute(id,'all')` | ADR-008 (4) |
| 2 | send | RDS(D/Z) | 없음 | 있음 | `EPS` | `distribute(id,'press')` | news.md L259 |
| 3 | send | RDS(D/Z) | 있음 | 무관 | `EPS` | **배부 없음** | news.md L258·L260 — 1차는 시각 배부(48) |
| 4 | send | **DDH** | 없음 | 없음 | `DPS` | `distribute(id,'all')` | 보류 해제 후 정상 송고 |
| 5 | send | **DDH** | 없음 | **있음** | **`DPS`** | `distribute(id,'press')` | **엠바고 우선 판정** — 상태로 보면 `'all'`이 되어 **2차 엠바고 파기** |
| 6 | send | **DDH** | **있음** | 무관 | **`DPS`** | **배부 없음** | **엠바고 우선 판정** — 상태로 보면 즉시 전체 배부 = **1차 엠바고 파기** |
| 7 | send | **DPS**(재송고) | 없음 | 없음 | `DPS` | `distribute(id,'all')` | 정정본 배부(의도) |
| 8 | send | **DPS**(재송고) | 있음/2차만 | — | `DPS` | 6·5와 동일(엠바고 우선) | 편집으로 엠바고가 추가될 수 있다(`CONTENTS_FIELDS` L15~20) |
| 9 | send | RDS(**R**) | — | — | `RDS` | 배부 없음 | 데스크 미송고에 남는다(송고 완료 아님) |
| 10 | hold/kill/approveDelete | — | — | — | — | 배부 없음 | 배부 트리거가 아니다 |
| 11 | 전이 거부(`no-end-marker`/`forbidden-transition`/`not-found`) | — | — | — | — | 배부 없음 | 이미 early return |

**#5·#6이 이 step의 핵심 함정이다**: `src/services/lifecycle.js` L15가 `DDH: { send: 'DPS' }`이고,
`src/services/articleService.js` L140의 EPS 치환 조건이 **`row.contents.status === 'RDS'` 한정**이라
**엠바고가 설정된 DDH 기사를 송고하면 EPS가 아니라 DPS가 된다**. `finalStatus==='DPS' → 'all'`로 단순 분기하면
그 기사가 엠바고 시각 전에 전량 배부된다(엠바고 파기 — 되돌릴 수 없다).

- `embargoAt`/`secondEmbargoAt`는 **falsy 판정**으로 본다(빈 문자열 `''`이 정상 값이다 — `deriveArticle` L194~195가 `''`로 초기화한다).
  `!== null`·`!== undefined` 같은 판정을 쓰지 마라.
- **EPS 기사는 배부 후에도 상태가 EPS로 유지된다.** 상태 전이를 추가하지 마라(EPS→DPS 전이는 phase 48).
- 재송고(#7)는 **다시 배부된다** — 정정본 배부로 의도된 동작이다(step1 §3 참조).

**phase 48 인계(반드시 summary에도 남겨라)**:
> **엠바고가 설정됐지만 상태가 EPS가 아닌(DPS) 기사가 존재한다**(#5·#6 — DDH 송고·DPS 재송고 경로).
> tick의 배부 대상 선정이 `status==='EPS'`만 보면 이 기사들은 **영영 배부되지 않는다**.
> 대상 선정은 상태가 아니라 **엠바고 시각 + 미배부 여부**(`ArticleHistory`의 `eventType='distribute'` + `action`)를 기준으로 하라.

### 3) `src/controllers/index.js` — 합성 루트 결선

```js
import { mkdirSync, writeFileSync } from 'node:fs';      // 실 fs 공급은 합성 루트의 책임
import { createSpoolWriter } from '../services/spoolWriter.js';
import { createDistributionService } from '../services/distributionService.js';

export function createControllers(db, {
  sessionService,
  env = process.env,
  fetchFn = globalThis.fetch,
  lockoutPolicy = {},
  // 배부(ADR-008) — 스풀 루트가 주어질 때만 활성. 미주입이면 배부는 비활성이다.
  distSpoolDir = undefined,
  spoolFs = { mkdirSync, writeFileSync },
  logger = null,
} = {}) {
```

결선 순서(순환 없음):

```js
const spoolWriter = createSpoolWriter({ rootDir: distSpoolDir, fs: spoolFs });
const distributionService = createDistributionService({
  articleModel, distributionTargetModel, historyModel: articleHistoryModel, spoolWriter, logger,
});
const articleService = createArticleService({ articleModel, db, historyModel: articleHistoryModel, distributionService });
```

- **`distSpoolDir`에 `env.DIST_SPOOL_DIR` 기본값을 주지 마라.** 이유: `createControllers`는 수십 개 테스트가
  직접 호출한다. env를 자동 판독하면 `DIST_SPOOL_DIR`가 설정된 개발자 머신에서만 배부가 켜져
  `test/controllers.test.js` L157(이력 1건) 같은 단언이 깨지고, 테스트가 실제 디스크에 파일을 쓴다.
  **env 판독은 부트스트랩 한 곳(§4)에서만** 한다 — 수집 watcher가 `RCV_SPOOL_DIR`를 부트스트랩에서만 읽는 것과 동형.
- `distributionTarget` 진입점(L106~111)·`article` 진입점(L75~89)·`return`(L123)의 **키 집합은 바꾸지 마라**
  (`test/controllers.test.js`가 `Object.keys(controllers)` 정확 집합을 단언한다 — 9개 유지).
  **배부용 컨트롤러 진입점을 새로 만들지 마라**(외부에서 배부를 호출할 경로가 생기면 안 된다 — tick은 phase 48).

### 4) `server/index.js` — 부트스트랩 결선 (라우트 무수정)

`bootstrap()`(L830~)만 손댄다:

1. `const logService = createLogService();`(현재 L841)를 **`createControllers` 호출보다 위로 올린다**
   (동작 변화 없음 — 단순 선언 순서 변경). 그래야 컨트롤러에 logger를 넘길 수 있다.
2. ```js
   const controllers = createControllers(db, {
     sessionService,
     logger: logService,
     distSpoolDir: process.env.DIST_SPOOL_DIR, // 미설정이면 배부 비활성(수집 RCV_SPOOL_DIR과 동형)
   });
   ```
3. 수집 watcher 블록(L849~869) **아래**에 배부 스풀 상태 로그 1줄을 남긴다(watcher 로그와 대칭):
   ```js
   if (process.env.DIST_SPOOL_DIR) logService.info(`Distribution spool at ${process.env.DIST_SPOOL_DIR}`);
   else logService.info('Distribution disabled (DIST_SPOOL_DIR unset)');
   ```
- **`createApp`·라우트·미들웨어·`STATUS_BY_REASON`·SSE는 한 글자도 고치지 마라.** 새 라우트도 없다.
- 부트스트랩은 `import.meta.url` 가드 안에서만 실행되므로 테스트 import 시 영향이 없다(L872~874).

### 5) 문서 (additive 1줄씩)

- `README.md` L48 부근: `- (선택) \`DIST_SPOOL_DIR\` — 배부 스풀 디렉토리(수신처별 하위 폴더에 기사 JSON 기록). 미설정 시 배부 비활성`
- `docs/ARCHITECTURE.md` L16 services 목록에 `· distribution · spoolWriter` 추가(기존 문장 유지).

기존 문장 삭제·재작성 금지 — 추가만 한다.

## TDD 테스트 목록 (red → green 순서)

`test/distributionSendHook.test.js` 신규.

**A. 단위 — 가짜 distributionService 주입** (`createArticleService({ articleModel, db, historyModel, distributionService: fake })`,
fake는 호출 인자를 배열에 기록)

1. D가 엠바고 없는 RDS 기사를 송고(→DPS) → `distribute(articleId, 'all', { actorUserId: 'desk' })` **1회**.
2. **2차 엠바고만** 설정된 기사를 D가 송고(→EPS) → `distribute(articleId, 'press', …)` 1회.
3. **1차 엠바고만** 설정(→EPS) → **호출 0회**.
4. **1+2차 모두** 설정(→EPS) → **호출 0회**(1차 시각 배부는 phase 48).
5. `secondEmbargoAt=''`(빈 문자열)인 DPS 송고 → `'all'` 1회(빈 문자열은 미설정이다).
6. `hold`/`kill`/`approveDelete` → 호출 0회.
7. R이 RDS 기사를 송고(→RDS) → 호출 0회.
8. 전이 거부(`no-end-marker`, `forbidden-transition`, `not-found`) → 호출 0회(부작용 없음).
9. **DPS 재송고**(엠바고 없는 DPS 기사에 D가 send → DPS) → `'all'` 1회 더(누적 2회) — 정정본 배부.

**A′. 엠바고 파기 방지 — DDH 송고 3케이스(필수, 판정표 #4~#6 잠금)**

> 이 케이스들이 이 step의 최대 리스크다. `articleService` L140의 EPS 치환은 `status==='RDS'` 한정이라
> **엠바고가 설정된 DDH 기사를 D가 송고하면 finalStatus가 EPS가 아니라 DPS**가 된다.
> 준비: `articleService.create`로 만든 뒤 `articleModel.update`로 `status='DDH'`와 엠바고 값을 직접 세팅하고
> `applyAction(id, 'D', 'send')`를 호출한다. 각 케이스에서 **`r.status === 'DPS'`임을 먼저 단언**해
> 전제(전이 결과)가 실제로 DPS임을 고정한 뒤 배부 호출을 검사하라.

9b. DDH + **1차 엠바고만** → `status==='DPS'`이지만 `distribute` **호출 0회**(1차 엠바고 파기 방지).
9c. DDH + **2차 엠바고만** → `status==='DPS'`이고 `distribute(id, **'press'**, …)` 1회(`'all'`이면 2차 엠바고 파기 — 실패해야 한다).
9d. DDH + **1+2차 모두** → `status==='DPS'`, `distribute` **호출 0회**.
9e. DDH + **엠바고 없음** → `status==='DPS'`, `distribute(id,'all')` 1회(정상 경로가 막히지 않았음을 확인).
9f. **엠바고가 붙은 DPS 재송고**: DPS 기사에 `embargoAt`를 설정한 뒤 D가 send → `status==='DPS'`, 호출 0회.
10. **`distribute`가 throw해도** `applyAction`은 `{ ok:true, status:'DPS' }`를 반환하고,
    DB의 `Contents.status==='DPS'`·`sentAt` stamp·`eventType='status'` 이력이 **정상 유지**된다(롤백 없음).
11. `distribute`가 `{ ok:false, reason:'…' }`를 반환해도 송고는 성공 처리된다.
12. **반환 shape 회귀 잠금**: `assert.deepEqual(r, { ok: true, status: 'DPS' })`(키 추가 금지 계약).
13. `distributionService` 미주입(기존 호출 형태)이어도 모든 기존 동작이 동일하다.

**B. 통합 — 실제 결선 + 가짜 fs** (`createControllers(db, { sessionService, distSpoolDir: '/spool', spoolFs: fakeFs, logger: fakeLogger })`,
대상 행은 같은 `db`에 `createDistributionTargetModel(db).insert(...)`로 직접 넣거나 Z 세션으로 `controllers.distributionTarget.create` 사용)

14. 활성 press 1 + nonpress 1 등록 후 D 송고(엠바고 없음) → **파일 2개**(각 대상 폴더), `Contents.distributedAt` stamp,
    이력 2행(`queryByArticle`가 id DESC이므로 **`items[0].eventType==='distribute'`**, `items[1].eventType==='status'`).
    - **커밋 순서 불변식 단언(필수)**: 기록된 파일을 `JSON.parse`해 **`article.status === 'DPS'`**(전이 **이후** 값)이고
      **`article.sentAt`이 이번 송고에서 stamp된 값**임을 확인한다. 후처리가 커밋(또는 상태 계산) **이전**으로 옮겨지면
      파일에 이전 상태(`'RDS'`)나 옛 `sentAt`이 실려 이 단언이 깨진다 — 파일 개수·DB 값만 보면 잡히지 않는 회귀다.
15. 2차 엠바고만 있는 기사 송고 → **press 폴더에만 파일 1개**, `Contents.status`는 여전히 **`'EPS'`**(전이 없음),
    `distributedAt` stamp됨. **파일 내용의 `article.status === 'EPS'`**이고 `article.secondEmbargoAt`이 설정값과 일치한다.
16. 1차 엠바고가 있는 기사 송고 → **파일 0개**, `distributedAt`은 여전히 null, 이력은 `status` 1행뿐.
16b. **DDH 경로 통합 재확인**: 2차 엠바고만 있는 DDH 기사를 D가 송고 → `Contents.status==='DPS'`인데
    **press 폴더에만 파일 1개**(nonpress 폴더 파일 0), 파일의 `article.status==='DPS'`. (A′ 9c의 통합판 — 실제 결선에서도 성립하는지 잠근다.)
17. `spoolFs.writeFileSync`가 항상 throw해도 **송고는 200/ok**이고 `Contents.status==='DPS'`,
    `distributedAt`은 null(파일 0건), 이력은 `status` 1행뿐, `fakeLogger.warn`에 실패 로그가 남는다.
18. **송고이력 회귀**: `controllers.article.queryHistory(id, { sendOnly:true })`는 배부가 일어난 뒤에도 `status/send` 1건만 반환한다.

**C. 기본 비활성 잠금(회귀 방지의 핵심)**

19. `createControllers(db, { sessionService })`(옵션 미주입)로 송고 → **fs 접촉 0**, 이력 1행(`status`), `distributedAt` null.
20. **`process.env.DIST_SPOOL_DIR`를 설정한 뒤** 같은 호출을 해도 결과가 19와 동일하다
    (env는 컨트롤러가 읽지 않는다 — 테스트 끝에 원래 env 값을 반드시 복원하라).

**D. 아키텍처 가드**

21. `src/services/articleService.js` 소스에 `node:fs`·`fetch`·`setInterval`·`setTimeout`이 없다(소스 문자열 단언).
22. `src/controllers/index.js` 소스에 `DIST_SPOOL_DIR` 문자열이 **없다**(env 판독은 부트스트랩 전용 — #20의 소스 레벨 잠금).

순서: **A → B → C → D**. A(단위 훅)가 green이 되기 전에 B(결선)를 시작하지 마라 — A만으로도 커밋 가능한 완결 산출물이다.

## Acceptance Criteria

```bash
npm test
npm run lint
npm run build
```

- `npm test`: **fail 0**, pass = step1 완료 시점 개수 + 신규 테스트 수. **기존 테스트 개수가 줄면 안 된다**
  (특히 `test/controllers.test.js`·`test/server.test.js`·`test/articleHistoryService.test.js`의 이력/반환 shape 단언이
  그대로 통과해야 한다 — 하나라도 손대야 한다면 설계가 틀린 것이다).
- `npm run lint`: clean(경고 0).
- `npm run build`: clean(web 무접촉이지만 `README`/docs 외 실수 편집이 없음을 확인하는 저비용 게이트).
- `npm run test:web`은 필수 AC가 **아니다**(web 파일 무접촉). 확인하고 싶으면 참고 기준선은 **1927 pass**다.

## 검증 절차

1. `test/distributionSendHook.test.js`를 먼저 작성해 **red** 확인 후 구현한다(A → B → C → D).
2. 불변식 체크리스트 — 테스트로 증명되어야 한다:
   - [ ] 스풀 쓰기 실패/예외에도 송고 상태 전이·`sentAt`·`status` 이력이 **그대로 유지**된다(#10·#17)
   - [ ] `applyAction` 반환은 `{ ok, status }` 정확히 2키(#12)
   - [ ] EPS는 배부 후에도 EPS(#15)
   - [ ] **엠바고 파기 0**: 1차 엠바고가 있으면 EPS든 **DPS든** 배부하지 않는다(#3·#4·**9b·9d·9f·16**)
   - [ ] **2차 엠바고만 있으면 상태와 무관하게 `'press'`뿐이다**(#2·**9c·16b**) — `'all'`이면 실패
   - [ ] 옵션 미주입 = 배부 비활성, env도 읽지 않는다(#19·#20)
   - [ ] 스풀 파일 내용이 **전이 이후** 상태를 담는다(#14·#15 — 커밋 순서 회귀 탐지)
3. `grep -rn "req.body.role\|req.query.role" src/ server/index.js` → **0건**.
4. `grep -rn "setInterval\|setTimeout\|fetch(" src/services/articleService.js src/services/distributionService.js src/services/spoolWriter.js` → **0건**
   (`fetchFn` 주입 기본값이 있는 `src/controllers/index.js`·`mediaSearch`는 기존 코드 — 무접촉 확인만).
5. `grep -n "DIST_SPOOL_DIR" -r src/` → **0건** / `grep -n "DIST_SPOOL_DIR" server/index.js README.md` → **각 1건 이상**.
6. `grep -rn "DELETE FROM\|DROP \|TRUNCATE" src/ server/index.js` → 신규/변경 코드에 **0건**.
7. `git diff --stat`이 위 "변경할 파일" 6개(수정 5 + 신규 1)와 정확히 일치하는지 확인한다.
   `web/**`·`src/models/**`·`src/db/schema.js`가 diff에 있으면 **범위 위반**이다.
8. `git diff src/controllers/index.js`에서 `return { ... }`(L123)의 키 집합이 **변하지 않았는지** 확인한다(9개 유지).
9. `git diff server/index.js`가 `bootstrap()` 함수 내부 + import 없음으로 한정되는지 확인한다(라우트·미들웨어 변경 0).

## 커밋 계획

feat 커밋을 **A/B 두 개로 분리**한다(A는 그 자체로 완결·회귀 없는 산출물이라 중단 시에도 안전하다):

- **feat A(단위 훅)**: `feat(47-distribution-service): step2 — applyAction 송고 후처리 배부 훅(엠바고 우선 판정)`
  — `src/services/articleService.js`, `test/distributionSendHook.test.js`(A·A′ 케이스).
- **feat B(결선)**: `feat(47-distribution-service): step2 — 배부 스풀 결선(컨트롤러 주입·DIST_SPOOL_DIR 부트스트랩)`
  — `src/controllers/index.js`, `server/index.js`, `test/distributionSendHook.test.js`(B·C·D 케이스), `README.md`, `docs/ARCHITECTURE.md`.
- **chore**: `chore(47-distribution-service): step2 status — completed` — `phases/47-distribution-service/index.json`만.

## 금지사항

- 배부 후처리를 `articleModel.update` **이전**이나 DB 트랜잭션 **안**으로 넣지 마라. 이유: 스풀 파일은 롤백할 수 없다 — 커밋되지 않은 상태가 파일로 먼저 나가거나, 파일 IO가 트랜잭션을 열어둔 채 DB를 잠근다.
- 배부 실패로 `applyAction`이 `ok:false`를 반환하거나 예외를 전파하게 만들지 마라. 이유: 송고는 기자·데스크의 업무 행위이고 배부는 후처리다. 외부 스풀 디스크 상태가 편집국 업무를 막으면 안 된다(ADR-008 트레이드오프가 명시한 설계).
- `applyAction` 반환 객체에 배부 결과 필드를 추가하지 마라. 이유: `assert.deepEqual(r, { ok:true, status:'EPS' })`류의 정확 일치 단언이 여러 테스트에 있고, HTTP 응답 계약도 함께 바뀐다.
- `createArticleService`의 `distributionService` 인자에 기본값을 빼먹지 마라. 이유: 이 키를 넘기지 않는 기존 호출자(컨트롤러·다수 테스트)가 전부 깨진다.
- `createControllers`에서 `process.env.DIST_SPOOL_DIR`를 읽지 마라(기본값으로도 금지). 이유: 수십 개 테스트가 `createControllers`를 직접 호출한다 — env가 설정된 머신에서만 배부가 켜져 이력 개수 단언이 깨지고 테스트가 실제 디스크에 파일을 쓴다. env 판독은 부트스트랩 한 곳에서만 한다.
- **`finalStatus`만 보고 audience를 정하지 마라**(`finalStatus==='DPS' ? 'all'` 단순 분기 금지). 이유: DPS는 엠바고 기사에서도 도달한다 — `lifecycle.js` L15의 `DDH.send='DPS'`와 `articleService.js` L140의 EPS 치환 `status==='RDS'` 한정 때문에, 엠바고가 설정된 DDH 기사를 송고하면 DPS가 된다. 상태로 판정하면 그 기사를 즉시 전량 배부해 **엠바고를 파기**한다(되돌릴 수 없다). 엠바고 우선으로 도출하라(§2 판정표).
- 1차 엠바고가 설정된 기사를 상태와 무관하게(EPS든 DPS든) 배부하지 마라. 이유: news.md L258·L260 — 1차 배부는 **엠바고 시각**에 일어난다(phase 48 tick). 지금 배부하면 엠바고 파기다.
- EPS→DPS 상태 전이를 추가하지 마라. 이유: 엠바고 배부 완결 판정과 전이는 phase 48 소관이다(ADR-008 (5)).
- `POST /api/distribution/tick`이나 다른 새 라우트·컨트롤러 진입점을 만들지 마라. 이유: 이번 phase의 배부 트리거는 **서버 내부 송고 후처리뿐**이다. 외부에서 배부를 호출할 표면이 생기면 인가 설계 없이 배부가 노출된다.
- `setInterval`/`setTimeout`/`fetch`/네트워크 전송을 넣지 마라. 이유: ADR-008 — 앱 내 타이머·egress 금지.
- 스풀 폴더 변경(대상의 `spoolDir` 수정) 시 **구 폴더의 기존 파일을 옮기거나 지우거나, 변경을 차단하지 마라**. 이유: ADR-008 트레이드오프 철학 — 스풀 기록은 그 자체로 **배부 지시 완료**이며 이후 파일의 소유권은 외부 전송기에 있다. 앱이 관여하면 전송 중 파일을 파괴하거나 이미 발송된 기사를 되돌리려는 잘못된 기대를 만든다. 앱은 관여하지 않는다(마이그레이션·정리·변경 차단 없음 — phase 46 인수인계 ②의 확정 판단).
- 기존 테스트를 수정·삭제·약화시키지 마라(특히 이력 개수·반환 shape 단언). 이유: 그 단언들이 이번 결선이 지켜야 할 계약이다 — 깨진다면 구현이 틀린 것이다.
- `app.notifyChange`에 새 신호 종류를 추가하거나 배부용 SSE 이벤트를 만들지 마라. 이유: ADR-005 — `/api/stream`은 행 데이터 없는 무효화 신호 계약이고, 송고 라우트(`server/index.js` L523~535)가 `applyAction` 직후 이미 `notifyChange('status')`를 보내 `distributedAt` 변경까지 함께 전달된다(중복 재조회만 늘어난다).
- `web/**`를 수정하지 마라. 이유: 배부는 서버 내부 동작이고 `distributedAt`은 이미 조회 필터로 노출돼 있다 — 클라이언트 변경이 필요 없다.
- `src/db/schema.js`·`src/models/**`를 수정하지 마라. 이유: 이번 결선에 새 컬럼·새 SQL이 필요 없다(있다고 느껴지면 설계가 틀린 것이므로 멈추고 계획을 재검토하라).
