# Step 1: tick-service

시점/엠바고 배부의 **도메인 엔진**을 만든다: EPS(엠바고 송고 대기) 기사들을 훑어 도래한 kind만 배부하고,
배부 요건이 전부 채워진 기사만 EPS→DPS로 전이한다.
HTTP·세션·타이머·파일시스템을 모르는 순수 도메인 계층이다(ADR-006). 의존성은 전부 주입한다.

**앱 내 타이머를 만들지 않는다** — `runTick()`은 외부 운영 cron이 HTTP로 pull하는 1회 실행 함수다(ADR-008 (3)). 라우트는 step3.

## 읽어야 할 파일

- `docs/ADR.md` — **ADR-008**(스풀 outbound + tick pull, 앱 타이머/egress 금지), ADR-006(계층 분리·주입), ADR-002(DB 비파괴).
- `docs/news.md` — "엠바고 규칙", "기사 생애주기"(EPS/EEH/EEK/DPS).
- `docs/SCHEMA.md` — Contents 절(`status`, `distributedAt`, `embargoAt`, `secondEmbargoAt`).
- **step0 산출물** `src/services/embargoSchedule.js` — `parseInstant / isDue / requiredKinds / dueKinds / missingKinds / isComplete`. 규칙은 **여기서 재구현하지 않고 호출만 한다**.
- `src/services/distributionService.js` — `distribute(articleId, { kinds, actorUserId })` → `{ ok:true, distributed:[{targetId, kind, spoolDir, file}], failed:[...] }` 또는 `{ ok:false, reason:'spool-disabled'|'not-found' }`. 성공한 kind마다 `ArticleHistory`에 `eventType='distribute'`, `action=kind` 1행을 남기고 `Contents.distributedAt`을 갱신한다.
- `src/services/articleService.js` — `applyAction`의 이력 기록 형태(`record({ articleId, eventType:'status', action, fromStatus, toStatus, actorUserId })`)와 배부 훅.
- `src/services/lifecycle.js` — 전이표(`EPS`에는 `kill`/`hold`만 있고 `send` 없음). **이 표는 이 step에서 수정하지 않는다.**
- `src/models/articleModel.js` — `getById(articleId)` → `{ article, contents } | null`, `query(filters)`(`status` 문자열/배열 지원), `update(articleId, { article, contents })`(present-only).
- `src/models/articleHistoryModel.js` — `queryByArticle(articleId)` → `[{ id, articleId, eventType, action, fromStatus, toStatus, actorUserId, createdAt, hasSnapshot }]` (id DESC), `insert(record)`.
- `test/distributionService.test.js` — in-memory DB + 실제 모델 + 가짜 주입 테스트 관례.

## 작업

**TDD: `test/distributionTickService.test.js`를 먼저 쓰고 red를 확인한 뒤 구현한다.**

### 1) 신규 파일 `src/services/distributionTickService.js`

```js
import * as embargoScheduleModule from './embargoSchedule.js';

export function createDistributionTickService({
  articleModel,
  historyModel,
  distributionService,                        // 없으면(스풀 미설정) runTick은 spool-disabled
  embargoSchedule = embargoScheduleModule,    // 순수 규칙 모듈(주입 가능 — 테스트 결정성)
  now = () => new Date().toISOString(),       // 주입 가능한 시계
}) {
  // 반환은 runTick 하나뿐이다.
  async function runTick({ actorUserId = null } = {}) { /* ... */ }
  return { runTick };
}
```

**반환 계약**

```
성공: {
  ok: true,
  checked: number,                                  // status='EPS'로 훑은 기사 수
  distributed: [{ articleId, kinds: ['press'] }],   // 이번 tick에서 실제로 스풀 기록에 성공한 kind만
  completed: ['AKR...'],                            // EPS→DPS 전이한 기사아이디
  incomplete: [{ articleId, missing: ['nonpress'] }] // 아직 요건 미충족(도래 전 포함)
}
실패: { ok:false, reason: 'spool-disabled' | 'tick-in-progress' | 'invalid-clock' }
```

### 2) 반드시 지킬 실행 규칙

**(a) 진입 가드**
- `distributionService`가 없으면 즉시 `{ ok:false, reason:'spool-disabled' }` — DB를 읽지도 않는다.
- **single-flight**: 클로저 플래그로 동시 실행을 막는다. 이미 실행 중이면 `{ ok:false, reason:'tick-in-progress' }`를 반환하고 **아무 일도 하지 않는다**. 플래그 해제는 `finally`에서 한다(예외가 나도 영구 잠김 금지).
  이유: `runTick`은 `await`를 포함하므로, cron이 겹쳐 호출하면 같은 기사가 두 번 반출된다.
- `nowMs = embargoSchedule.parseInstant(now())`. `null`이면 `{ ok:false, reason:'invalid-clock' }`(배부 0건 — fail-safe).

**(b) 대상 조회 — EPS만**
- `articleModel.query({ status: 'EPS' })`로 후보를 얻는다. **다른 status를 대상에 넣지 마라.**
- 기사마다 루프 진입 직후 `articleModel.getById(articleId)`로 **최신 행을 다시 읽고**, `contents.status !== 'EPS'`면 즉시 건너뛴다(카운트만).
  이유(TOCTOU): 목록 조회와 처리 사이에 데스크가 그 기사를 KILL(EEK)/보류(EEH)했을 수 있다 — 죽은 기사를 되살려 반출하면 안 된다.

**(c) 배부 — 도래한 kind만, 이력 기반 멱등**
- `already` = `historyModel.queryByArticle(articleId)`에서 `eventType === 'distribute'`인 행들의 `action` 값 집합.
  **"무엇이 이미 배부됐는가"의 판정 근거는 ArticleHistory뿐이다.** `Contents.distributedAt`을 근거로 쓰지 마라 — 그 컬럼은 마지막 시각 하나뿐이라 어떤 kind가 나갔는지 알 수 없다.
- `due` = `embargoSchedule.dueKinds(fresh.contents, nowMs)`.
- `toDistribute` = `due` 중 `already`에 없는 것. **비어 있으면 `distributionService.distribute`를 호출하지 않는다**(반복 tick에서 재배부 0 = 멱등).
- 호출은 `await distributionService.distribute(articleId, { kinds: toDistribute, actorUserId })`.
  반환이 `{ ok:false }`거나 `failed`가 있어도 **throw하지 말고** 그 기사만 미완결로 남긴 뒤 다음 기사로 진행한다.

**(d) 완결 판정 — 다시 이력으로**
- 배부 호출 뒤 `historyModel.queryByArticle`를 **다시 읽어** 최신 배부 kind 집합을 만들고, 그걸로 `embargoSchedule.missingKinds/isComplete`를 계산한다.
  이유: 실제로 스풀에 기록된 것만 이력에 남는다(distributionService가 보증) — 반환값을 믿고 완결 처리하면 실패한 배부가 완결로 둔갑한다.
- `missing.length > 0`이면 `incomplete`에 `{ articleId, missing }`을 담고 **전이하지 않는다**.

**(e) 완결 시 전이 — present-only + append-only**
- 전이 **직전에** `articleModel.getById(articleId)`로 한 번 더 최신 행을 읽고 `status === 'EPS'`가 아니면 전이를 포기한다(배부 중에 KILL/보류된 기사 부활 금지).
- `articleModel.update(articleId, { contents: { status: 'DPS' } })` — **status 하나만** 넘긴다.
  `sentAt`/`sender`/`distributedAt`/`embargoAt`/`secondEmbargoAt`/본문은 건드리지 않는다(`distributedAt`은 distributionService가 이미 갱신했다).
- 이력 1행 append: `historyModel.insert({ articleId, eventType: 'status', action: 'embargoComplete', fromStatus: 'EPS', toStatus: 'DPS', actorUserId, createdAt: now() })`.
  이력 insert 실패는 `try/catch`로 격리한다(이미 끝난 전이를 되돌리지 않는다 — `articleService.record` 관례와 동일).
- `completed`에 articleId를 담는다.

**(f) 격리**
- 기사 단위로 `try/catch` — 한 기사에서 예외가 나도 tick 전체가 죽지 않고 나머지 기사를 계속 처리한다. 예외가 난 기사는 `incomplete`에 담아 표면화한다(무음 삼킴 금지).

**(g) 상태 전이 표를 건드리지 않는다**
- `src/services/lifecycle.js`의 `transition`에 `EPS.send` 같은 칸을 추가하지 마라. 이유: 그 표는 **사용자 액션** 전이표이며, EPS에 send를 열면 사용자가 엠바고 기사를 직접 송고해 시각 전에 상태를 넘길 수 있다(news.md 위반). EPS→DPS는 tick만 하는 **시스템 전이**다.

### 3) 테스트 (`test/distributionTickService.test.js` 신규) — 최소 다음을 덮는다

하네스: in-memory `DatabaseSync(':memory:')` + `createSchema` + 실제 `articleModel`/`articleHistoryModel` + **가짜 `distributionService`**(호출 인자를 기록하고, 성공 시 실제 historyModel에 `eventType:'distribute', action:kind` 행을 넣어 실물과 동일하게 동작시킨다) + 고정 `now`.

1. 1차 엠바고 도래 → `press`만 배부, `nonpress` 호출 없음.
2. 1+2차에서 1차만 도래 → `press` 배부 후 **EPS 유지**, `incomplete`에 `{ articleId, missing:['nonpress'] }`.
3. 1+2차 둘 다 도래 → `press`+`nonpress` 배부 → status `DPS`, `completed`에 포함, `ArticleHistory`에 `eventType='status'`·`action='embargoComplete'`·`fromStatus='EPS'`·`toStatus='DPS'` 1행.
4. **멱등**: 같은 조건으로 `runTick`을 2회 연속 호출 → 2회차의 `distribute` 호출 0건, 이력 행 수 불변, status `DPS` 유지(2회차엔 EPS 후보가 아니므로 `checked` 감소).
5. **부분 배부 후 재tick**: 1차 배부만 끝난 상태에서 2차 시각이 지난 뒤 tick → `nonpress`만 배부(`press` 재배부 0) → 완결 전이.
6. **2차만 설정된 기사**: 송고 훅이 남긴 `distribute/press` 이력이 있는 EPS 기사 → tick은 `press`를 다시 배부하지 않고, 2차 도래 시 `nonpress`만 배부한 뒤 DPS 전이.
7. **도래 전**: 미래 엠바고 → `distribute` 호출 0건, status EPS 유지, `incomplete`에 표면화.
8. **파싱 불가 값**(`embargoAt='곧'`) → 배부 0건, EPS 유지, 예외 없음.
9. **TOCTOU**: 목록 조회 후 처리 직전에 status가 `EEK`로 바뀐 기사(가짜 `articleModel` 래퍼나 `distribute` 콜백 안에서 DB를 갱신해 재현) → 배부/전이 0건, DPS로 되살아나지 않는다.
10. **배부 실패**: 가짜 distributionService가 `{ ok:true, distributed:[], failed:[...] }`(이력 미기록)를 반환 → 완결 전이 없음, status EPS 유지, `incomplete`에 남는다.
11. **single-flight**: 첫 호출이 진행 중(가짜 distribute가 pending Promise)일 때의 두 번째 호출은 `{ ok:false, reason:'tick-in-progress' }`이고 `distribute` 추가 호출 0건. 첫 호출이 끝난 뒤에는 다시 실행 가능(플래그 해제).
12. `distributionService` 미주입 → `{ ok:false, reason:'spool-disabled' }`, DB 무변경.
13. **DB 비파괴**: tick 전후 Article/Contents 행 수 동일, 기존 이력 행이 하나도 사라지지 않는다(이력은 증가만).
14. 한 기사에서 예외가 나도 다른 기사는 정상 처리된다(격리).

## Acceptance Criteria

```bash
npm test && npm run lint
```

- 신규 테스트 전량 green, 기존 백엔드 테스트 무회귀(fail 0).

```bash
grep -rnE "setTimeout|setInterval|fetch\(|node:fs|DELETE FROM|DROP " src/services/distributionTickService.js
```
- **0건**이어야 한다(앱 내 타이머·egress·행 삭제 금지 — ADR-008/DB 비파괴).

```bash
git diff --stat -- src/services/lifecycle.js server/index.js src/controllers/index.js web
```
- **변경 0** 이어야 한다(전이표·transport·결선은 이 step 범위 밖).

## 검증 절차

1. 의존성이 설치돼 있는지 확인한다(`node_modules` 없으면 무관한 테스트가 대량 실패 — 코드 문제 아님).
2. 구현 전 `node --test test/distributionTickService.test.js` red를 확인하고 기록한다.
3. `npm test` 전체 green 확인.
4. `grep -n "eventType" src/services/distributionTickService.js` — 완결 판정이 `'distribute'` 이력 조회로만 이루어지는지 눈으로 확인한다(`distributedAt` 사용 0건).

## 금지사항

- `setInterval`/`setTimeout`/`setImmediate`로 주기 실행을 만들지 마라. 이유: ADR-008 — 주기 호출은 외부 cron이 tick 라우트를 pull해 수행한다. 앱에 스케줄러를 두면 다중 인스턴스에서 중복 반출된다.
- `fetch`/소켓/`node:fs`를 쓰지 마라. 이유: 앱은 스풀 파일만 쓰고(그것도 `spoolWriter` 책임) 네트워크 egress가 없다.
- 엠바고 시각 비교 로직을 이 파일에 재구현하지 마라(`Date.parse`·문자열 비교 직접 호출 금지, `now()` 파싱 제외). 이유: 규칙의 단일 출처는 step0의 `embargoSchedule`이며, 두 곳에 있으면 한쪽만 고쳐져 조기 반출이 재발한다.
- `EEH`/`EEK`/`DPD`/`DDK` 등 EPS 이외 상태를 전이 대상으로 삼지 마라. 이유: 보류·킬된 기사를 되살려 반출하는 사고다.
- 완결 판정을 `distribute()` 반환값이나 `Contents.distributedAt`만으로 하지 마라. 이유: 반환값은 실패를 포함할 수 있고 `distributedAt`은 kind 정보를 담지 않는다 — 실패한 배부가 완결로 둔갑한다.
- `articleModel.update`에 `status` 외의 필드를 함께 넘기지 마라. 이유: present-only 갱신 원칙이며, `sentAt`/본문을 덮으면 송고 사실이 훼손된다(DB 비파괴).
- 행 삭제(`DELETE`/`DROP`)나 이력 갱신(UPDATE)을 하지 마라. 이유: ArticleHistory는 append-only, DB 데이터는 삭제하지 않는다.
- HTTP 라우트·세션·`x-session-id`·인가 판정을 이 파일에 넣지 마라. 이유: step2(인가/컨트롤러), step3(라우트) 범위다.
- `web/**` 를 수정하지 마라. 이유: 배부 현황 UI는 MVP-4 후속 범위다(PRD).
