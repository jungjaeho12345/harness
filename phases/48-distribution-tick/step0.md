# Step 0: tick-decision

시점 배부(tick)의 "지금 이 kind를 배부해야 하는가 / 엠바고 배부가 완결되었는가"를 판정하는 **순수 함수 모듈**을 만든다. FS·DB·타이머·네트워크 의존 0. 이 step은 판정 로직 한 레이어만 다룬다.

## 읽어야 할 파일

먼저 아래를 읽고 설계 의도를 파악하라:

- `/home/user/harness/docs/ADR.md` — ADR-008 (배부 = 파일 스풀 outbound + tick pull, 앱 타이머/egress 금지)
- `/home/user/harness/docs/news.md` — "엠바고 규칙" 절 (1차→언론사, 2차→비언론사·송고 시 언론사 즉시, 1+2차 조합)
- `/home/user/harness/src/services/articleService.js` — 기존 순수 헬퍼 `distributionKindsForSend(status, contents)` (69–79행). 이 step의 헬퍼는 그 "시점 배부판" 대응물이다. 스타일을 맞춘다.
- `/home/user/harness/src/services/distributionService.js` — `KINDS = ['press','nonpress']` 및 배부 이력 기록 방식(`eventType='distribute', action=kind`). 완결 판정 근거가 이 이력이다.

## 작업

새 파일 `src/services/embargoTick.js`를 만들고 아래 순수 함수 2개를 export 한다. 내부 구현은 재량이나 **아래 규칙은 반드시 지킨다**.

```js
// 배부 대상 종류 — distributionService.KINDS와 동일 의미(단일 출처는 distributionService지만 순수 모듈이라 재선언).
// press = 언론사, nonpress = 비언론사.

// 지금(now) 배부해야 하는 kind 목록을 돌려준다. 이미 배부된 kind와 시각 미도래 kind는 제외한다.
//   contents: { embargoAt, secondEmbargoAt } (둘 다 문자열 또는 빈값/undefined)
//   distributedKinds: 이미 배부된 kind의 Set 또는 배열 (ArticleHistory distribute 이력의 action 값)
//   nowISO: 기준 시각 문자열
// 반환: ['press'] | ['nonpress'] | ['press','nonpress'] | [] (KINDS 순서 유지)
export function dueDistributionKinds(contents, distributedKinds, nowISO) { ... }

// 엠바고 배부가 전부 완결되었는가(EPS→DPS 전이 조건).
//   반환: boolean. required kind가 모두 distributedKinds에 있으면 true.
export function isEmbargoComplete(contents, distributedKinds) { ... }
```

### 판정 규칙 (news.md 엠바고 규칙 직역 — 반드시 준수)

`embargoAt`(1차), `secondEmbargoAt`(2차)의 **설정 여부**로 엠바고 유형이 도출된다(별도 유형 컬럼 없음).

- **press가 required** ⇔ `embargoAt`가 설정됨(truthy). (1차 엠바고 시각에 언론사 배부)
- **nonpress가 required** ⇔ `secondEmbargoAt`가 설정됨(truthy). (2차 엠바고 시각에 비언론사 배부)
- 따라서:
  - 1차만: required = {press}
  - 2차만: required = {nonpress} (press는 송고 훅이 이미 즉시 배부했으므로 완결 조건에는 넣지 않는다 — required가 아님)
  - 1+2차: required = {press, nonpress}

`dueDistributionKinds`:
- press가 due ⇔ press가 required **그리고** `now >= embargoAt` **그리고** press가 아직 미배부(`!distributedKinds.has('press')`).
- nonpress가 due ⇔ nonpress가 required **그리고** `now >= secondEmbargoAt` **그리고** nonpress가 아직 미배부.
- 반환 배열은 `['press','nonpress']` 순서를 유지한다.

`isEmbargoComplete`:
- required kind 집합이 비어 있으면(둘 다 미설정 — 엠바고 기사가 아님) `false`를 반환한다. 이유: 엠바고 없는 기사는 애초에 EPS가 아니므로 tick의 완결 전이 대상이 아니다. 완결 판정이 실수로 true가 되어 비-엠바고 기사를 전이시키면 안 된다.
- required kind가 모두 distributedKinds에 있으면 `true`.

### 시각 비교 규칙 (반드시 준수)

- 시각 비교는 `Date.parse(x)` 로 인스턴트를 얻어 숫자로 비교한다: `Date.parse(embargoAt) <= Date.parse(nowISO)` 이면 도래.
- `Date.parse`가 `NaN`(빈값·비ISO·미설정)이면 그 kind는 **due가 아니다**(안전측 — 파싱 불가한 시각으로 조기 배부 금지).
- `distributedKinds`는 Set 또는 배열 둘 다 받아 정규화한다(호출자 편의).
- **금지: `setTimeout`/`setInterval`/`Date.now()` 기반 자체 스케줄링.** 이유: ADR-008 — 앱 내 타이머 금지. now는 반드시 인자로 주입받는다(결정적 테스트).

## Acceptance Criteria

```bash
cd /home/user/harness && node --test "test/embargoTick.test.js"   # 신규 테스트 통과
cd /home/user/harness && npm test                                  # 전체 무회귀(기준선 527 pass/0 fail → 527+신규)
cd /home/user/harness && npm run lint                              # 0 warning
```

## 검증 절차

1. TDD: 먼저 `test/embargoTick.test.js`를 작성해 red(ERR_MODULE_NOT_FOUND)를 확인한 뒤 구현으로 green.
   테스트 케이스(최소): 1차만/2차만/1+2차 각각의 due(시각 전/후)·complete, 이미 배부된 kind 제외, 시각 미도래 제외, 빈값/NaN 시각 방어, distributedKinds를 Set·배열 둘 다로 호출, 비-엠바고(둘 다 미설정) complete=false.
2. 아키텍처 체크: 순수 모듈(import 0 — DB/FS/타이머/네트워크 없음)인가? ADR-008 위반(타이머) 없는가?
3. 결과에 따라 `phases/48-distribution-tick/index.json`의 step 0을 갱신한다(성공→completed+summary).

## 금지사항

- DB/모델/HTTP를 import 하지 마라. 이유: 이 모듈은 순수 판정 함수다 — 부수효과가 섞이면 다음 step(orchestration)에서 테스트가 결정적이지 않다.
- 시각을 `new Date()`로 내부 조달하지 마라. 이유: now 주입이 없으면 tick 테스트가 벽시계에 의존해 깨진다(ADR-008 타이머 금지와 정합).
- press를 2차만 기사의 required에 넣지 마라. 이유: 2차만 기사의 press는 송고 시점 즉시 배부분이라 완결 조건이 아니다 — 넣으면 EPS→DPS 전이가 영영 안 일어난다.
- 기존 테스트를 깨뜨리지 마라.
