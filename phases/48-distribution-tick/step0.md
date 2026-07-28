# Step 0: embargo-rules

시점 배부의 **순수 규칙 계층**을 만든다. I/O·타이머·DB 접근이 전혀 없는 함수들만 만든다.
"지금 이 기사에서 어떤 kind를 배부해야 하는가 / 배부가 완결됐는가 / 완결 시 어떤 status인가"를 판정하는 단일 출처다.

이 step은 **파일 2개(둘 다 순수 규칙 모듈)** 만 건드린다: 신규 `src/services/embargoSchedule.js` + 기존 `src/services/lifecycle.js`에 export 1개 추가.
lifecycle에 넣는 이유: 기존 코드(`src/services/distributionService.js` 상단 주석)가 "상태 전이(EPS→DPS) → 생애주기는 lifecycle/articleService가 단일 출처다"라고 못박았다. 전이 규칙을 배부 모듈이 자체 구현하면 출처가 둘로 갈라진다.

## 읽어야 할 파일

- `docs/news.md` 256~263행 "엠바고 규칙" — 이 step의 유일한 실질 스펙.
- `docs/ADR.md` ADR-008 — (3) tick pull, (5) 배부 이벤트는 ArticleHistory에 기록하고 엠바고 기사의 배부가 전부 완결되면 EPS→DPS로 전이.
- `docs/SCHEMA.md` — Contents(`embargoAt`, `secondEmbargoAt`, `status`) 절, ArticleHistory 관련 서술.
- `src/services/lifecycle.js` — 전이표(순수 함수) 관례. `transition(status, role, action)`은 role 기반 전이만 다루고 EPS에는 `send`가 없다.
- `src/services/articleService.js` 69~79행 `distributionKindsForSend(status, contents)` — phase 47이 **송고 시점**에 쓰는 대칭 규칙. 이 step은 그 나머지(시점 배부분)를 담당한다.
- `src/models/articleHistoryModel.js` — `queryByArticle(articleId)`가 반환하는 행 shape(`{ id, articleId, eventType, action, fromStatus, toStatus, actorUserId, createdAt, hasSnapshot }`, id DESC).
- `src/services/distributionService.js` 84~88행 — 배부 성공 시 남기는 이력 행: `{ articleId, eventType: 'distribute', action: kind, actorUserId }`. **완결 판정 근거가 이 행이다.**
- `test/lifecycle.test.js`(있으면) — 순수 함수 테스트 관례.

## 작업

**TDD: 테스트를 먼저 쓰고 red(모듈 없음/함수 없음)를 확인한 뒤 구현한다.**

### 1) 테스트 `test/embargoSchedule.test.js` (신규)

아래 규칙표를 그대로 케이스로 옮긴다(news.md 256~260행 직역).

| 엠바고 유형 | embargoAt | secondEmbargoAt | 완결에 필요한 kind(requiredKinds) | 시점 배부 대상(dueKinds 후보) |
|---|---|---|---|---|
| 없음 | 없음 | 없음 | `[]` | `[]` (송고 즉시 DPS — tick 대상 아님) |
| 1차만 | 있음 | 없음 | `['press']` | embargoAt 도달 시 `press` |
| 2차만 | 없음 | 있음 | `['press','nonpress']` (press는 **송고 시** 이미 배부됨 — phase 47) | secondEmbargoAt 도달 시 `nonpress` |
| 1+2차 | 있음 | 있음 | `['press','nonpress']` | embargoAt 도달 시 `press`, secondEmbargoAt 도달 시 `nonpress` |

최소 케이스:
- `dueKinds`: 시각 미도달이면 빈 배열, 정확히 같은 시각이면 도달로 본다(`>=`), 도달했으면 해당 kind만.
- `dueKinds`: 파싱 불가/빈 문자열/null/숫자 등 비정상 엠바고 값은 **절대 due가 되지 않는다**(빈 배열).
- `dueKinds`: 2차만 설정된 기사에서 `press`는 절대 due가 아니다(송고 시 배부분이며, 실패분 재전송은 MVP-4 범위).
- `distributedKinds`: `eventType='distribute'` 행의 `action`만 모은다 — `eventType='status'`(송고 이력)나 `eventType='edit'`은 섞이지 않는다. 미지 action(`'press '`, `'all'` 등)은 무시. 중복은 1회로 접힌다.
- `pendingKinds`: due − 이미 배부된 kind (멱등성 — 같은 tick을 두 번 돌려도 재배부 0).
- `isEmbargoComplete`: requiredKinds가 전부 이력에 있으면 true. 하나라도 없으면 false. requiredKinds가 빈 배열(엠바고 없음)이면 **false**(완결 판정 대상 아님 — 엠바고 없는 기사를 EPS→DPS로 건드리지 않는다).
- `embargoCompleteTransition('EPS')` → `{ ok:true, status:'DPS' }`, `'DPS'`/`'EEH'`/`'EEK'`/`'RDS'`/undefined → `{ ok:false, reason:'forbidden-transition' }`.

### 2) `src/services/embargoSchedule.js` (신규)

시그니처(구현은 재량, 아래 계약은 고정):

```js
export const DISTRIBUTION_KINDS = ['press', 'nonpress'];      // 순서 고정(press 우선)
export function requiredKinds(contents = {}) -> string[]      // 완결에 필요한 kind 집합
export function dueKinds(contents = {}, nowIso) -> string[]   // 시각이 도래한 kind
export function distributedKinds(historyRows = []) -> string[] // 이력에서 배부 완료된 kind
export function pendingKinds(contents = {}, historyRows = [], nowIso) -> string[] // due − distributed
export function isEmbargoComplete(contents = {}, historyRows = []) -> boolean
```

핵심 규칙(벗어나지 마라):
- **순수** — `Date.now()`·`setTimeout`·`setInterval`·fs·fetch·DB 접근 0. 현재 시각은 반드시 인자(`nowIso`)로 받는다.
- **시각 비교** — 값은 `Date.parse()`로 파싱해 epoch ms로 비교한다. 문자열 사전식 비교를 쓰지 마라(포맷이 섞이면 오배부한다). `Date.parse`가 `NaN`이면 **due 아님**으로 수렴한다(보수적 — 판정 불가 값으로 외부 반출이 일어나면 되돌릴 수 없다). `nowIso` 자체가 파싱 불가면 모든 kind가 due 아님.
- **allowlist** — 반환하는 kind는 `DISTRIBUTION_KINDS` 안의 값만. 이력의 `action` 값을 그대로 흘려보내지 마라(임의 폴더 배부 벡터).
- 입력을 변형하지 마라(인자 객체·배열 mutate 금지) — 호출자가 DB 행을 그대로 넘긴다.

### 3) `src/services/lifecycle.js` (기존 파일에 추가)

```js
// 엠바고 배부 완결에 의한 시스템 전이 — role/action 기반 전이표와 분리된 유일한 자동 전이(ADR-008 (5)).
export function embargoCompleteTransition(status) -> { ok:true, status:'DPS' } | { ok:false, reason:'forbidden-transition' }
```
- `status === 'EPS'`일 때만 허용한다. **EEH/EEK(보류·킬된 엠바고 기사)는 절대 DPS로 되살리지 마라.**
- 기존 `transition()`/`DESK_TABLE`/`initialStatus()`의 동작을 바꾸지 마라(기존 테스트가 계약을 고정하고 있다).

## Acceptance Criteria

```bash
npm test && npm run lint
```

- 백엔드 테스트 전량 green(기준선 527 pass·fail 0 대비 신규분만 증가, 회귀 0), lint 경고 0.

## 검증 절차

1. 구현 전 `npm test -- test/embargoSchedule.test.js`(또는 `node --test test/embargoSchedule.test.js`)로 red를 확인한다.
2. `grep -nE "setInterval|setTimeout|Date\.now|require\(|node:fs|fetch\(" src/services/embargoSchedule.js` → 0건.
3. `git diff --stat` — 변경 파일이 `src/services/embargoSchedule.js`, `src/services/lifecycle.js`, `test/embargoSchedule.test.js` 3개뿐인지 확인한다.

## 금지사항

- 앱 내 타이머(`setInterval`/`setTimeout`)를 만들지 마라. 이유: ADR-008 (3)이 시점 배부를 외부 tick pull로 못박았다 — 타이머를 넣는 순간 아키텍처 결정이 무효화된다.
- 실제 파일 쓰기·DB 조회·HTTP 호출을 이 모듈에 넣지 마라. 이유: 규칙 계층이 I/O에 묶이면 tick 서비스(step2)의 테스트가 비결정적이 된다.
- 사전식 문자열 비교로 시각을 판정하지 마라. 이유: `'2026-07-28T10:00:00Z'`와 `'2026-07-28 10:00'`이 섞이면 비교 결과가 뒤집혀 엠바고 전 기사가 외부로 나간다(회수 불가).
- `transition()` 전이표에 EPS→DPS를 끼워 넣지 마라. 이유: 그 표는 news.md의 **역할·액션 기반** 전이이며, EPS에 `send`가 없다는 사실 자체가 계약이다. 자동 전이는 별도 함수로 분리해야 감사 이력(action)이 구분된다.
- 2차 엠바고만 있는 기사의 `press`를 시점 배부 대상으로 만들지 마라. 이유: news.md는 "2차 엠바고... 송고시 바로 언론사에 배부"라고 정했고 그 경로는 phase 47이 이미 구현했다 — tick이 또 배부하면 중복 반출이다.
