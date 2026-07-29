# Step 0: embargo-schedule

배부 3부작(46 대상관리 → 47 즉시배부 → **48 시점 배부 tick**) 마지막 phase의 첫 step이다.
이 step은 **순수 규칙 모듈 하나만** 만든다: "지금 이 기사에 어떤 배부가 도래했는가 / 무엇이 남았는가"를 판정하는 함수들.
DB·시계·파일시스템·네트워크·타이머를 일절 건드리지 않는다(다음 step의 tick 서비스가 이 모듈을 주입받아 쓴다).

## 읽어야 할 파일

- `docs/ADR.md` — **ADR-008**(배부는 파일 스풀 outbound + tick pull, 앱 내 타이머/egress 금지), ADR-006(계층 분리).
- `docs/news.md` — "엠바고 규칙" 절(1차 → 언론사, 2차 → 비언론사이며 송고 시 바로 언론사, 1+2차 조합) 과 "기사 생애주기"의 EPS/EEH/EEK.
- `docs/SCHEMA.md` — Contents 절(`embargoAt`, `secondEmbargoAt`, `status`, `distributedAt`, 시간 컬럼은 ISO-8601 UTC 문자열).
- `src/services/articleService.js` 의 `distributionKindsForSend(status, contents)` (파일 상단 주석 포함) — **송고 시점 즉시 배부 규칙의 단일 출처**. 이 모듈은 그 규칙과 충돌하면 안 된다(중복 반출 금지).
- `src/services/distributionService.js` — `distribute(articleId, { kinds, actorUserId })`의 `kinds`가 `'press' | 'nonpress'` 두 값뿐임을 확인한다.
- `src/services/spoolDir.js` — 순수 헬퍼 작성 관례(타입 게이트 먼저, 강제변환 금지, throw 없이 값으로 반환).
- `test/spoolDir.test.js` — 순수 모듈 단위 테스트 관례(`node --test` + `node:assert/strict`).

## 작업

**TDD: `test/embargoSchedule.test.js`를 먼저 쓰고 red(모듈 부재)를 확인한 뒤 구현한다.**

### 1) 신규 파일 `src/services/embargoSchedule.js` — 순수 함수만 export

```js
export function parseInstant(value)                       // → epoch ms(number) | null
export function isDue(value, nowMs)                       // → boolean
export function requiredKinds(contents)                   // → string[]  ('press' | 'nonpress' 부분집합, 순서 고정)
export function dueKinds(contents, nowMs)                 // → string[]
export function missingKinds(contents, distributedKinds)  // → string[]
export function isComplete(contents, distributedKinds)    // → boolean
```

`contents`는 Contents 행(객체)이다 — 이 모듈은 `embargoAt`, `secondEmbargoAt` 두 필드만 읽는다.
`distributedKinds`는 **이미 배부된 kind 목록**이며 배열 또는 Set을 모두 받는다(호출자는 ArticleHistory에서 만든다 — step1).

### 2) 반드시 지킬 판정 규칙

**(a) 시각 비교는 epoch 기반으로만 한다.**
- `parseInstant`: 문자열이 아니면 `null`(강제변환 금지). trim 후 빈 문자열이면 `null`.
- **명시적 타임존 오프셋(`Z`/`z`/`+HH:MM`/`-HH:MM`/`+HHMM`/`-HHMM`)으로 끝나지 않는 값은 `null`.**
  이유: `'2026-07-30T09:00'`처럼 오프셋 없는 값은 런타임 로컬 시각으로 해석되어 서버 TZ에 따라 **엠바고 시각 전에 조기 반출**될 수 있다.
- 오프셋이 있어도 `Date.parse`가 `NaN`이면 `null`.
- `isDue(value, nowMs)`: `Number.isFinite(nowMs)`가 아니면 `false`. `parseInstant(value)`가 `null`이면 `false`. 그 외 `instant <= nowMs`(동시각 = 도래).
- **문자열끼리 `<`/`>`로 비교하지 마라.** 이유: `'2026-07-30T09:00:00+09:00'`와 `'2026-07-30T01:00:00Z'`는 같은 시각인데 사전식 비교는 반대로 판정한다 — 포맷이 섞이면 엠바고 전 반출이 발생한다.

**(b) `requiredKinds(contents)` — tick이 책임지는 kind 집합(완결 요건).**
- `embargoAt`가 **설정되어 있으면** `'press'` 포함.
- `secondEmbargoAt`가 **설정되어 있으면** `'nonpress'` 포함.
- 반환 순서는 항상 `['press', 'nonpress']` 기준(테스트 결정성).
- 따라서 **"2차만 설정된 기사"의 `requiredKinds`는 `['nonpress']`뿐이다 — press는 들어가지 않는다.**
  이유: 2차만 설정된 기사의 언론사 배부는 송고 훅(`distributionKindsForSend` → `['press']`)이 이미 즉시 수행했다.
  여기에 press를 넣으면 tick이 같은 기사를 언론사로 **두 번 반출**하거나(중복), 송고 훅 실패 시 완결이 영원히 안 되는 stuck-EPS가 된다.
- "설정되어 있음"의 판정: 값이 `null`/`undefined`가 아니고 문자열화한 뒤 trim이 빈 문자열이 아니면 설정으로 본다(관대한 존재 판정).
  **존재 판정은 관대하게, 시각 파싱은 엄격하게** — 쓰레기 값이 들어온 컬럼은 "required이지만 영원히 due 아님"이 되어 EPS에 머문다(fail-safe).
  반대로 하면(존재 판정도 엄격) 쓰레기 값이 "미설정"으로 흡수되어 배부 없이 완결 처리될 수 있다.

**(c) `dueKinds(contents, nowMs)` — 지금 배부해야 할 kind.**
- `requiredKinds`의 각 원소에 대해, 대응 필드(`press`↔`embargoAt`, `nonpress`↔`secondEmbargoAt`)가 `isDue`면 포함.
- `requiredKinds`에 없는 kind는 절대 포함하지 않는다(2차만 기사에서 press가 나올 수 없는 구조적 보장).

**(d) `missingKinds` / `isComplete` — 완결 판정.**
- `missingKinds(contents, distributedKinds)` = `requiredKinds` 중 `distributedKinds`에 없는 것들(순서 유지).
- `isComplete(contents, distributedKinds)` = `requiredKinds().length > 0 && missingKinds().length === 0`.
- **`requiredKinds`가 빈 배열이면 `isComplete`는 항상 `false`다.** 이유: 엠바고 컬럼이 둘 다 비어 있는 EPS 행(비정상 데이터)을 배부 0건으로 DPS 전이시키면 안 된다 — 그런 기사는 tick이 손대지 않고 운영자가 값을 고치게 둔다.

### 3) 테스트 (`test/embargoSchedule.test.js` 신규) — 최소 다음을 덮는다

1. `parseInstant`: `'2026-07-30T00:00:00.000Z'` → epoch, `'2026-07-30T09:00:00+09:00'`와 `'2026-07-30T00:00:00Z'`가 **같은 수**.
2. `parseInstant`: 오프셋 없는 `'2026-07-30T09:00:00'`/`'2026-07-30 09:00'` → `null`. 비문자열(`123`, `null`, `undefined`, `{}`, `new Date()`) → `null`. `''`/공백 → `null`. `'내일 오후 2시'` → `null`.
3. `isDue`: 도래 전 `false`, 정확히 같은 시각 `true`, 지난 시각 `true`, 파싱 불가 값 `false`, `nowMs`가 `NaN`/비수 `false`.
4. **사전식 함정 회귀**: `embargoAt='2026-07-30T09:00:00+09:00'`(=00:00Z)이고 `nowMs`가 `2026-07-29T23:59:59Z`일 때 `dueKinds`는 `[]` (문자열 비교였다면 `'2026-07-30...' > '2026-07-29...'`로 뒤집혔을 케이스).
5. `requiredKinds`: 1차만 → `['press']`, 2차만 → `['nonpress']`, 1+2차 → `['press','nonpress']`, 둘 다 없음/빈문자열/공백 → `[]`.
6. `dueKinds`: 1+2차에서 1차만 도래 → `['press']`, 둘 다 도래 → `['press','nonpress']`, 2차만 설정 기사에서 2차 도래 → `['nonpress']`(press 절대 미포함).
7. `missingKinds`/`isComplete`: 배열·Set 입력 모두 동작, 부분 배부 → `missing` 정확, 전량 배부 → `isComplete true`, `requiredKinds`가 `[]`면 `isComplete false`.
8. 쓰레기 엠바고 값(`embargoAt='곧'`) → `requiredKinds`에 `'press'` 포함 + `dueKinds`에 미포함 + `isComplete false`(fail-safe).
9. 입력 불변성: 호출 후 인자로 넘긴 `contents` 객체와 `distributedKinds` 배열이 변형되지 않는다.

## Acceptance Criteria

```bash
npm test && npm run lint
```

- 신규 `test/embargoSchedule.test.js` 전량 green, 기존 백엔드 테스트 무회귀(phase 47 완료 시점 기준선 **527 pass / 0 fail** → 신규 건수만큼 증가, fail 0), lint 경고 0.

```bash
grep -rnE "setTimeout|setInterval|fetch\(|node:fs|node:sqlite|require\(|import .*from" src/services/embargoSchedule.js
```
- 마지막 grep에서 **import 문이 0건**이어야 한다(순수 모듈 — 의존성 없음).

## 검증 절차

1. `npm test` 실행 전 의존성이 설치돼 있는지 확인한다. `node_modules`가 없으면 `ERR_MODULE_NOT_FOUND`로 무관한 테스트가 대량 실패한다(코드 문제 아님) — 필요하면 `npm install` 후 진행한다.
2. 구현 전 `node --test test/embargoSchedule.test.js`로 red를 확인하고 기록한다(TDD 근거).
3. `npm test`로 전체 무회귀 확인.
4. `git diff --stat` — 변경 파일이 `src/services/embargoSchedule.js`, `test/embargoSchedule.test.js` 2개뿐인지 확인한다.

## 금지사항

- 문자열 사전식 비교(`a < b`)로 시각을 판정하지 마라. 이유: 오프셋/포맷이 섞이면 엠바고 시각 **전에** 도래로 판정되어 조기 반출된다(되돌릴 수 없는 사고).
- 파싱 실패·오프셋 없는 값을 "지금 도래"로 흡수하지 마라(예: `Date.parse` 실패 시 `0`이나 현재 시각 대입). 이유: 잘못된 입력이 즉시 반출로 이어진다 — 실패는 항상 "도래 아님"으로 수렴해야 한다.
- 2차만 설정된 기사의 `requiredKinds`/`dueKinds`에 `'press'`를 넣지 마라. 이유: 송고 훅이 이미 언론사에 즉시 배부했다 — 중복 반출이다.
- 이 모듈에서 `new Date()`/`Date.now()`를 부르지 마라. 이유: 시계는 호출자가 주입한다(테스트 결정성). `nowMs`는 항상 인자로 받는다.
- DB·모델·`distributionService`·파일시스템·`fetch`·타이머를 import하지 마라. 이유: 이 모듈은 순수 규칙의 단일 출처이며, 의존이 생기면 다음 step의 tick 서비스가 이 규칙을 우회해 재구현하게 된다.
- 상태 전이(EPS→DPS)나 배부 실행을 여기서 하지 마라. 이유: step1(tick 서비스)의 책임이다.
- `web/**` 를 수정하지 마라. 이유: 배부 현황 UI는 MVP-4 후속 범위다(PRD).
