# Step 2: cycle-boundary-policy

## 목표

**"이미 배부됨" 판정에 배부 사이클 경계 개념을 도입한다 — 순수 판정 모듈(`embargoPolicy`)에만.**

지금 `distributedKinds(historyRows)`는 기사 이력 전체에서 `eventType==='distribute'` 행을 모아 "이미 배부된 kind"로 본다. 이력은 append-only라 **과거 사이클의 배부 기록이 영원히 남는다**. 그래서 보류(hold) 후 엠바고를 다시 설정해 재송고한 기사는, 새 사이클에서 한 번도 배부되지 않았는데도 "이미 배부됨"으로 판정된다(그 결과는 step3의 배경 참조 — 엠바고 배부 무음 누락 + 즉시 DPS 승격).

이 step은 **판정 함수만** 추가한다. 소비처 결선(articleService·distributionTickService)은 **step3**의 범위다. 즉 이 step이 끝난 시점에 프로덕션 동작은 **하나도 바뀌지 않아야 한다**(새 export + 테스트만 추가).

수정 파일: `src/services/embargoPolicy.js` 1개 + 테스트 1개.

## 읽어야 할 파일

라인 번호는 실측 힌트 — 심볼명으로 재확인하라.

- `docs/ADR.md` — **ADR-008 전문**(특히 (3) tick pull·(5) 배부 이벤트는 ArticleHistory 기록), `docs/ARCHITECTURE.md`의 `[배부]`·`[tick]` 데이터 흐름 절.
- `docs/SCHEMA.md` L42~53 — Contents 상태값(RDS/DES/EPS/DPS/DDH/EEK/EEH/DPD…)과 `distributedAt` 정의.
- `src/services/embargoPolicy.js` — **전체**(148행). 이 step의 유일한 수정 대상 소스다.
  - `EMBARGO_DISTRIBUTABLE_STATUSES`(L18) = `['DES','EPS','DPS']`.
  - `MUTABLE_STATUSES`(L21) = `DES`,`EPS` — 상태 계산이 개입할 수 있는 상태.
  - `KIND_FIELDS`/`KINDS`(L24~29) — `press↔embargoAt`, `nonpress↔secondEmbargoAt`, 반환 순서의 단일 출처.
  - `requiredKinds`(L60~63), **`distributedKinds`(L71~80)**, `dueKinds`(L106~122), `embargoStatusFor`(L134~148).
  - 모듈 규약: **순수**(DB·HTTP·FS·타이머 비의존, `new Date()` 금지 — now는 항상 인자).
- `src/models/articleHistoryModel.js` — **전체**. `queryByArticle(articleId)`가 돌려주는 행 shape이 이 step의 입력이다:
  `{ id, articleId, eventType, action, fromStatus, toStatus, actorUserId, createdAt, hasSnapshot }`, 정렬은 **`ORDER BY id DESC`(최신 먼저)**, `id`는 INTEGER PK 자동 증가.
- `src/db/schema.js` L59~69 — ArticleHistory 컬럼 정의(`id` INTEGER PRIMARY KEY).
- `src/services/articleService.js` — 이력이 언제 어떤 모양으로 쌓이는지의 근거(읽기만, **수정 금지**):
  - `applyAction`의 `record({ articleId, eventType:'status', action, fromStatus, toStatus, actorUserId })`(L184~191) — **송고 이력은 상태 전이 직후, 배부 훅보다 먼저 insert된다**(경계 판정의 핵심 사실).
  - `update`의 `record({ eventType:'edit' , ... })`(L134).
- `src/services/distributionService.js` L45~50 — 배부 성공 시 `record({ eventType:'distribute', action:kind })` 기록(이력 insert 실패는 삼켜진다는 점도 확인).
- `test/embargoPolicy.test.js` — **전체**. 이 step의 테스트가 들어갈 파일이며 기존 케이스가 회귀 기준이다.
- `test/distributionTickService.test.js` L29~110 — 하네스 `addArticle()`이 **송고 이력을 먼저 넣고 그 뒤에 배부 이력을 심는다**(L57~65). 새 함수가 기존 테스트를 깨지 않는 이유를 여기서 확인하라.
- `test/articleService.test.js` L318~415 — `syncEmbargoStatus` 테스트의 픽스처(`seedEmbargo`)는 **송고 이력을 만들지 않고** 배부 이력만 심는다(경계 부재 = 전체 이력 폴백이 필요한 이유).

## 배경 (자기완결)

한 기사의 이력은 시간순으로 이렇게 쌓인다(id 오름차순):

```
edit … | status/send(DES) | distribute/press | status/embargo(DES→DPS)   ← 1차 사이클
       | status/hold(DPS→DDH) | edit(엠바고 재설정) | status/send(DDH→DES)  ← 2차 사이클 시작
```

2차 사이클의 tick이 "이미 배부됨"을 물으면, 전체 이력 기준으로는 `press`가 잡힌다 — 그러나 그 배부는 **이전 엠바고 시각에 대한 배부**였다. 이번 사이클에서는 아직 아무 데도 나가지 않았다.

**사이클 경계 = 가장 최근 송고 이력(`eventType==='status' && action==='send'`)이다.** 근거:
- DES(엠바고 배부 대기)로 진입하는 유일한 경로가 송고다(`articleService.applyAction`의 `DES_ENTRY_STATUSES = {RDS, DDH}` + 엠바고 설정).
- 송고 이력은 상태 전이 직후, 배부 훅보다 **먼저** insert된다 → 그 사이클의 배부는 전부 경계보다 뒤(id가 큼)에 남는다.

경계를 적용하는 상태는 **DES·EPS뿐**이다. `DPS`는 적용하지 않는다 — 배부가 완결된 기사의 재송고는 "이미 나간 곳에 정정본을 보낸다"는 phase 49 확정 계약(`distributionKindsForSend`의 DPS 분기, test/articleSendDistribution.test.js L226~332)을 쓰며, 여기에 경계를 적용하면 그 계약이 무너지고 tick이 완결 기사를 중복 배부한다.

**안전 방향 규칙(엠바고 파기 절대 금지)**: 경계를 확정할 수 없으면(송고 이력 없음, `id`가 정수가 아님 등) **전체 이력을 센다**. 전체를 세면 "이미 배부됨"이 넓어져 배부가 보수적으로 줄어들 뿐, 시각 전 배부는 절대 생기지 않는다. 반대로 경계를 넓게 추정하면(=이력을 덜 세면) 조기 배부 위험이 생긴다 — 그 방향으로 틀리지 마라.

## 작업

`src/services/embargoPolicy.js`에 아래를 추가한다(기존 export는 전부 유지).

```js
// 사이클 경계가 적용되는 상태 — 재송고로 "새 배부 사이클"이 열리는 DES·EPS뿐.
// DPS(완결·레거시)는 전체 이력을 본다: 재송고 정정본 계약(phase 49)의 근거가 "역사상 어디로 나갔나"이기 때문.
export const CYCLE_SCOPED_STATUSES = Object.freeze(['DES', 'EPS']);

/**
 * 이번 배부 사이클에서 이미 배부된 kind.
 * 경계는 가장 최근 송고 이력(eventType==='status' && action==='send')이며, 그 행보다 뒤(id가 큰)
 * distribute 이력만 이번 사이클로 센다. 경계를 확정할 수 없으면 전체 이력을 센다(안전측 — 조기 배부 금지).
 * @param {object} [args]
 * @param {string} [args.status] 기사 현재 상태
 * @param {Array<object>} [args.historyRows] articleHistoryModel.queryByArticle() 결과(id DESC)
 * @returns {string[]} 중복 없는 kind 목록(항상 [press, nonpress] 순서)
 */
export function cycleDistributedKinds({ status, historyRows } = {})
```

규칙:
- `CYCLE_SCOPED_STATUSES`에 없는 status(DPS·RDS·EEK·undefined 등) → `distributedKinds(historyRows)`와 **완전히 동일한 결과**를 돌려준다(기존 판정 재사용 — kind 필터링 로직을 복제하지 마라).
- 경계 행 선택: `eventType === 'status' && action === 'send'` 인 행 중 **`id`가 최대**인 것. `queryByArticle`이 id DESC로 주지만 **정렬에 의존하지 말고 값으로 판정하라**(호출자가 다른 정렬로 넘길 수 있다).
- `id`가 정수(`Number.isInteger`)가 아닌 행은 **경계 후보에서 제외**한다. 유효한 send 경계를 하나도 못 찾으면 전체 이력을 센다.
- **CRITICAL(안전측 방향)**: 경계를 확정한 뒤에도, `id`가 정수가 아닌 `distribute` 행은 **이번 사이클에 포함해서 센다**. 순진한 구현(`row.id > boundaryId`)은 `undefined > 2 === false`라 그 행을 **빼버리는데**, 이는 "이미 배부됨"을 좁혀 **조기 배부** 쪽으로 틀리는 방향이다 — 이 모듈의 안전측(모르면 넓게 센다)과 정반대다. 순서를 알 수 없는 행은 항상 "센다" 쪽으로 처리하라.
- 입력 배열을 **변형하지 마라**(정렬 시 복사본 사용). 비배열·`null`·비객체 원소에 throw하지 않는다.
- 순수 유지: `Date`/`now`/모델/파일시스템 접근 금지.
- `distributedKinds`는 **그대로 둔다**(송고 훅의 정정본 판정이 계속 쓴다). 두 함수의 의미 차이를 주석으로 명시하라:
  - `distributedKinds` = "역사상 어디로 나갔나"(정정본 대상 판정 — 송고 훅).
  - `cycleDistributedKinds` = "이번 사이클에서 이미 보냈나"(도래·완결 판정 — tick·상태 승격).

## TDD — 테스트 먼저

`test/embargoPolicy.test.js`에 추가한다. 이력 행은 `{ id, eventType, action, createdAt }` 리터럴로 만든다(모델·DB 불필요 — 순수 모듈 테스트).

1. **경계 없음(레거시)**: send 이력 없이 `distribute/press`만 있는 이력 → status `DES`·`EPS`·`DPS` 전부 `['press']`(전체 이력 폴백).
2. **핵심 회귀**: `[distribute/press(id 1), status.send(id 2)]` → status `DES` → **`[]`**(과거 사이클 배부는 세지 않는다). 같은 이력에 status `DPS` → `['press']`(DPS는 경계 미적용).
3. **사이클 내 배부**: `[status.send(1), distribute/press(2)]` → `DES` → `['press']`.
4. **혼합**: `[distribute/press(1), status.send(2), distribute/nonpress(3)]` → `EPS` → `['nonpress']`(순서·중복 없음).
5. **여러 송고**: send가 2건이면 **마지막(큰 id)** 이 경계다.
6. **정렬 비의존**: 같은 행 배열을 id 오름차순/내림차순/무작위로 넣어도 결과가 같다.
7. **경계 후보 전멸 → 전체 이력**: send 행이 있으나 그 **모든** send 행의 `id`가 정수가 아니면(예: `[{eventType:'status',action:'send'}(id 없음), distribute/press(id 1)]`) 경계를 확정하지 못해 전체 이력을 센다 → `DES`에서 `['press']`(= 케이스 1과 같은 결과).
7-a. **혼재(규칙 확정)**: 유효 send 경계가 **하나라도 있으면** 그 경계를 쓴다 — `[distribute/press(id 1), status.send(id 2, 유효), status.send(id 없음)]` → `DES` → **`[]`**(id 없는 send는 후보에서 제외되고, 유효 경계 뒤에는 배부가 없다).
7-b. **id 없는 distribute는 센다(안전측)**: `[status.send(id 2), {eventType:'distribute', action:'press'}(id 없음)]` → `DES` → **`['press']`**. 순서를 모르는 배부 행을 빼면 조기 배부로 이어지므로 반드시 포함한다.
8. **방어**: `historyRows`가 `undefined`/비배열/`[null, 3, {}]` 이어도 throw하지 않고 `[]` 계열의 안전한 결과를 준다. 인자 자체가 없어도(`cycleDistributedKinds()`) throw하지 않는다.
9. **입력 불변**: 호출 후 입력 배열의 순서·원소가 그대로다.
10. **기존 계약 회귀**: `distributedKinds`의 기존 테스트가 전부 green이고, 동작이 바뀌지 않았다.

케이스 2~7은 **구현 전 red**(함수 부재)를 확인하고 green으로 만든다.

## Acceptance Criteria

```bash
node --test test/embargoPolicy.test.js
npm test                 # tests 636+N / fail 0  — 이 step은 소비처를 안 바꾸므로 기존 테스트 결과가 하나도 변하면 안 된다
npm run lint
git diff --name-only      # src/services/embargoPolicy.js 와 test/embargoPolicy.test.js 2개뿐
```

## 검증 절차

1. 위 AC 커맨드 실행 — `npm test` fail 0, **기존 테스트 수·결과 불변**(새 테스트만 증가).
2. `git diff --name-only`가 정확히 2파일인지 확인한다. `articleService.js`·`distributionTickService.js`·`distributionService.js`가 diff에 있으면 이 step의 범위를 넘은 것이다(step3으로 되돌려라).
3. 변이 검증: 경계 판정을 "최근 send"가 아니라 "가장 오래된 send"로 바꾸면 케이스 5가 red가 되는가? `CYCLE_SCOPED_STATUSES`에 `DPS`를 넣으면 케이스 2 후반이 red가 되는가? 사이클 판정을 순진한 `row.id > boundaryId` 한 줄로 되돌리면 케이스 **7-b**가 red가 되는가(안전측 방향이 테스트로 잠겼는지)?
4. 아키텍처 체크리스트:
   - 모듈이 여전히 순수한가(`grep -n "new Date\|Date.now\|require\|import .*Model" src/services/embargoPolicy.js` — 시계·모델 참조 0건)?
   - `KINDS`/`KIND_FIELDS` 순서 단일 출처를 재사용했는가(kind 목록 하드코딩 복제 0건)?
5. `phases/51-security-hotfix/index.json`의 step2 상태·summary를 갱신한다.

## 금지사항

- 소비처(`articleService.js`·`distributionTickService.js`·`distributionService.js`)를 이 step에서 건드리지 마라. 이유: 결선은 step3이며, 판정 모듈과 소비처를 동시에 바꾸면 회귀 원인(판정 규칙 vs 결선)을 격리할 수 없다.
- `distributedKinds`의 동작을 바꾸거나 `cycleDistributedKinds`로 흡수·대체하지 마라. 이유: 송고 훅의 정정본 판정(phase 49 계약, test/articleSendDistribution.test.js L226~332)이 "전체 이력" 의미를 그대로 필요로 한다.
- `CYCLE_SCOPED_STATUSES`에 `DPS`를 넣지 마라. 이유: 완결된 기사의 이력이 사이클 밖으로 밀려 tick이 이미 배부된 수신처에 중복 배부한다(회수 불가).
- 경계를 못 찾았을 때 "배부 이력 없음(`[]`)"으로 폴백하지 마라. 이유: 그 방향의 오류는 **엠바고 시각 전 배부**로 이어진다 — 한 번 나간 기사는 회수 수단이 없다. 안전측은 항상 "전체 이력을 센다"다.
- 시각(`createdAt`) 비교로 경계를 판정하지 마라(정 필요하면 id 보조 수단으로만). 이유: 같은 밀리초에 여러 행이 들어갈 수 있고, 시각 문자열은 백필·수동 데이터에서 신뢰도가 낮다. 단조 증가하는 `id`가 유일하게 결정적인 순서다.
- `setInterval`/`setTimeout`/`fetch`/`new Date()`를 추가하지 마라. 이유: ADR-008(앱 내 타이머·egress 금지) + 이 모듈의 순수성 계약(now는 항상 인자).
- ArticleHistory 행을 삭제·수정하는 코드를 어디에도 넣지 마라. 이유: append-only·DB 비파괴 원칙.
