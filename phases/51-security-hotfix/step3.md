# Step 3: cycle-boundary-wiring

## 목표

**phase 49가 남긴 배부 회귀를 닫는다 — 보류 후 엠바고를 다시 설정해 재송고한 기사가, 과거 사이클의 배부 이력 때문에 "이미 배부됨"으로 오판돼 (1) 엠바고 배부가 무음 누락되고 (2) DES가 즉시 DPS로 승격되는 결함.**

step2가 만든 순수 판정 `cycleDistributedKinds({ status, historyRows })`를 **소비처 두 곳**에 결선한다:
- `src/services/articleService.js`의 `syncEmbargoStatus`(상태 승격 판정)
- `src/services/distributionTickService.js`의 `distributedOf`(도래/미배부 판정)

송고 훅(`applyAction` 안의 `distributedKinds(...)` 호출)은 **절대 바꾸지 않는다** — 그것은 "역사상 어디로 나갔나"(정정본 대상) 판정이며 phase 49가 테스트로 잠근 계약이다.

## 읽어야 할 파일

라인 번호는 실측 힌트 — 심볼명으로 재확인하라.

- `docs/ADR.md` — **ADR-008 전문**((3) tick pull·앱 내 타이머 금지, (5) 배부 이벤트 이력·EPS→DPS 전이), `docs/ARCHITECTURE.md`의 `[배부]`·`[tick]` 흐름.
- `docs/SCHEMA.md` L45~53 — 상태값 정의(DES=엠바고 배부 전 대기, EPS=첫 배부 후, DPS=완결), `distributedAt` 의미.
- `src/services/embargoPolicy.js` — **전체**. 이 step이 쓰는 계약:
  - `cycleDistributedKinds({ status, historyRows })`(step2 신설) — DES·EPS면 "마지막 송고 이력 이후"의 distribute만, 그 외 상태면 전체 이력.
  - `distributedKinds(historyRows)` — 전체 이력(송고 훅 전용, 이 step에서 **호출부를 바꾸지 않는다**).
  - `dueKinds({ status, contents, distributed, now })` — 도래+미배부 판정(now는 ISO-8601 UTC **문자열**).
  - `embargoStatusFor({ status, contents, distributed })` — DES/EPS에서만 계산, 완결이면 DPS·1건 이상이면 EPS·없으면 DES, 역행 금지.
  - `EMBARGO_DISTRIBUTABLE_STATUSES` = `['DES','EPS','DPS']`.
- `src/services/articleService.js`
  - `syncEmbargoStatus(articleId, { extraKinds, actorUserId })`(L230~248) ← **수정 대상**. 현재 L235~239가 `distributedKinds(history)` ∪ `extraKinds`를 만든다.
  - `applyAction`의 송고 훅(L197~220), 특히 **L203의 `distributedKinds(historyModel.queryByArticle(articleId))`** ← **수정 금지**(정정본 판정).
  - `distributionKindsForSend`(L82~90)·`DES_ENTRY_STATUSES`(L95) ← **수정 금지**.
- `src/services/distributionTickService.js` — **전체**(219행). 특히:
  - `distributedOf(articleId)`(L68~71) ← **수정 대상**.
  - `runOnce`의 후보 스캔(L113~126), TOCTOU 재검증(L145~159), `due.length === 0`의 **self-heal 승격**(L161~168) ← 이 경로가 잘못된 DPS 승격을 만든다. 로직 구조는 유지하고 판정 입력만 바꾼다.
  - `syncStatus(...)`(L76~80) — 상태 전이는 전적으로 `articleService.syncEmbargoStatus` 위임(그대로 유지).
- `src/models/articleHistoryModel.js` — `queryByArticle`이 `id` 포함 행을 id DESC로 준다.
- `src/services/lifecycle.js` L12~20 — `DPS: { send:'DPS', hold:'DDH', approveDelete:'DPD' }`, `DDH: { send:'DPS', kill:'DDK' }`, `DES: { kill:'EEK', hold:'EEH' }`. 재현 시나리오의 전이 경로 근거다.
- `test/distributionTickService.test.js` — **전체**. 하네스(`harness()`/`addArticle`/`fakeDistribution`/`tickWith`)와 기존 회귀 케이스가 있다. `addArticle`은 **송고 이력을 먼저 넣고 배부 이력을 뒤에** 심으므로(L57~65) 기존 케이스는 경계 도입 후에도 green이어야 한다 — red가 나면 결선이 틀린 것이다.
- `test/articleService.test.js` L318~415 — `syncEmbargoStatus` 기존 계약(픽스처에 **송고 이력이 없다** → 전체 이력 폴백으로 그대로 green이어야 한다).
- `test/articleSendDistribution.test.js` L218~352 — phase 49가 잠근 DPS 재송고 정정본 계약(**이 step에서 하나도 바뀌면 안 된다**).

## 배경 (자기완결) — 결함의 실제 경로와 영향 범위

재현 경로(전부 실코드 확인):

1. 엠바고(1차 `embargoAt=T1`) 기사를 D가 송고 → `applyAction`이 `DES_ENTRY_STATUSES`(RDS·DDH) 규칙으로 **DES**.
2. 외부 cron이 `POST /api/distribution/tick` 호출(T1 도래) → `dueKinds`가 `press` 반환 → 배부 → `ArticleHistory(eventType='distribute', action='press')` 기록 → `syncEmbargoStatus`가 `required(['press']) ⊆ distributed` 로 보고 **DPS**(완결).
3. 데스크가 보류 → `DPS + hold` → **DDH**.
4. 편집으로 `embargoAt`를 미래 `T9`로 다시 설정(수정은 `CONTENTS_FIELDS`에 `embargoAt`가 있어 그대로 저장된다).
5. 재송고 → `DDH + send` → `DPS` → 엠바고 설정됨 → **DES**(새 사이클 시작). 송고 훅의 즉시 배부는 `distributionKindsForSend('DES', ...)`가 `[]`를 주므로 없다(1차 엠바고는 tick 책임 — 정상).
6. **여기서 결함**: tick이 이 기사를 잡으면 `distributedOf`가 **전체 이력**에서 `['press']`를 얻는다 → `dueKinds`가 "이미 배부됨"으로 `press`를 걸러 `due = []` → 배부 없음. 그리고 `due.length === 0` 분기의 self-heal이 `syncEmbargoStatus`를 부르는데, 여기서도 전체 이력 기준 `distributed=['press']` → `embargoStatusFor`가 완결로 판정해 **DES → DPS 즉시 승격**.

**영향 범위(중요)**: "나중에 tick이 주워가는" 복구 경로는 **없다**. (a) `press`는 이력 때문에 영원히 `dueKinds`에서 제외되고, (b) 상태가 DPS로 올라가면 `embargoStatusFor`의 `MUTABLE_STATUSES`(DES·EPS) 밖이라 상태 계산이 다시는 개입하지 않으며, (c) DPS는 tick 후보에는 남지만 (a) 때문에 배부되지 않는다. 즉 **T9가 와도 이 기사는 영원히 배부되지 않고, 화면에는 배부 완결(DPS)로 표시된다** — 무음 미배부 + 거짓 완결. 1+2차 조합이면 두 kind 모두 같은 방식으로 소실된다.

수정 후 기대 동작:
- 5 이후 tick(미도래): 배부 0건, 상태 **DES 유지**(거짓 완결 없음).
- T9 도래 후 tick: `press` 배부 1건 → `syncEmbargoStatus` → 완결이면 DPS.
- 반복 tick: 사이클 내 배부 이력이 있으므로 재배부 0건(멱등 유지).
- **엠바고 파기 없음**: `dueKinds`의 시각 게이트(`at <= now`)는 그대로다 — 이 step은 "이미 배부됨" 집합만 좁힌다.
- **의도된 동작 변화(명시)**: 엠바고 시각을 고치지 않고 재송고해 DES에 재진입한 기사도 새 사이클이 열린 것으로 본다 → 이미 도래한 시각의 kind가 **정정본으로 다시 배부된다**(과거에 나간 곳과 같은 수신처). 이는 phase 49가 DPS 재송고에 확정한 "이미 배부된 곳에 정정본" 의미론과 동형이며, 대안(과거 이력을 계속 세는 것)은 곧 이번 결함(영구 미배부)이다. 재배부는 사이클당 1회이고 이후 tick은 멱등이다.

## 작업

### 1) `articleService.syncEmbargoStatus`

`distributedKinds(history)` → `cycleDistributedKinds({ status: fromStatus, historyRows: history })`로 교체한다.
- `extraKinds`(방금 성공한 배부 힌트)와의 **합집합 구조는 그대로** 유지한다(이력 insert 실패 보정 — 기존 주석 근거).
- `fromStatus`는 이미 `row.contents.status`에서 읽고 있다(재조회 추가 금지).
- 그 외(present-only status 쓰기, `record({ eventType:'status', action:'embargo' })`, not-found 처리)는 **불변**.
- 주석에 "승격 판정은 **이번 사이클**의 배부만 센다 — 과거 사이클 이력으로 재엠바고 기사가 거짓 완결되지 않게" 근거를 남긴다.

### 2) `distributionTickService.distributedOf`

`cycleDistributedKinds({ status, historyRows: historyModel.queryByArticle(articleId) })`를 쓰도록 status를 인자로 받게 한다(예: `distributedOf(articleId, status)`).

**불변식(반드시 지켜라)**: `done`을 계산할 때 사용한 status와, 그 `done`을 넘기는 `dueKinds`/`embargoStatusFor`의 status는 **항상 같아야 한다**. 현재 코드는 스캔 스냅샷(`contents.status`)으로 `done`을 계산한 뒤, `due>0`이면 fresh read(`fresh.status`)로 `dueKinds`를 다시 계산한다(L145~159) — fresh의 status가 스냅샷과 다르면 `done`도 **fresh 기준으로 다시 계산**하라(이력 재조회 1회 추가는 허용 — 이미 수신처마다 `getById`를 하는 모듈이다).

나머지(순차 처리, TOCTOU 가드, `failed`/`invalid` 화이트리스트 투영, single-flight, self-heal 분기 구조)는 **불변**이다.

### 3) 송고 훅은 무변경 확인

`applyAction` 내부의 `distributedKinds(...)` 호출과 `distributionKindsForSend`는 그대로다. `git diff`에서 `articleService.js`의 변경이 `syncEmbargoStatus` 블록(+주석/import)에 한정되는지 확인하라.

## TDD — 테스트 먼저

### (a) `syncEmbargoStatus` 단위 (`test/articleService.test.js`)

기존 `seedEmbargo`/`distHist` 헬퍼를 재사용하되, **송고 이력을 심는 헬퍼**를 추가한다(`historyModel.insert({ articleId, eventType:'status', action:'send', fromStatus:'DDH', toStatus:'DES', createdAt })`).

1. **핵심 회귀**: 1차 엠바고 기사, 이력 순서 `[distribute/press, status.send]`, 상태 `DES` → `syncEmbargoStatus(id)`가 상태를 **바꾸지 않는다**(`{ ok:true, status:'DES' }`, DB status `DES`, `eventType='status' && action='embargo'` 이력 0건 = 쓰기 0건).
2. 같은 픽스처에서 `extraKinds:['press']`를 주면 → `DPS`(방금 성공한 배부 힌트는 사이클 안이다).
3. 이력 순서 `[status.send, distribute/press]`(사이클 내 배부), 2차만 설정, 상태 `DES` → `EPS`.
4. 기존 케이스 전부 green(송고 이력 없는 픽스처 = 전체 이력 폴백).

### (b) tick 회귀 시나리오 (`test/distributionTickService.test.js`)

기존 하네스 위에 **실제 전이를 밟는** 시나리오 테스트를 추가한다(픽스처를 직접 심지 말고 `articleService.applyAction`/`update`로 상태를 만들어라 — 결함이 상태 전이와 이력의 상호작용에서 나오므로).

5. **핵심 e2e**: `embargoAt = T1`(과거) 기사 생성 → `applyAction(D,'send')`(→DES) → `tick(now=T1)`으로 press 배부·DPS 완결 확인 → `applyAction(D,'hold')`(→DDH) → `update(id, { embargoAt: T9(미래) })` → `applyAction(D,'send')`(→DES) →
   - `tick(now=T1)`: `distribute` 호출 **0회**, 상태 **DES 유지**(현행 red: DPS로 승격됨), `distributed`/`failed` 요약에 이 기사 없음.
   - `tick(now=T9)`: `distribute` 호출 1회 + `kinds === ['press']`, 상태 `DPS`.
   - 한 번 더 `tick(now=T9)`: 배부 **0회**(멱등).
6. **엠바고 파기 가드**: 5의 첫 tick 시점에 스풀/배부 호출이 0회임을 단언(시각 게이트가 살아 있음).
7. **1+2차 조합**: 재설정된 두 엠바고(`T9`,`T10`)로 재송고 → `tick(T9)` → press만 배부·`EPS` → `tick(T10)` → nonpress 배부·`DPS`.
7-a. **엠바고 미수정 재송고(동작 변화 고정)**: 5의 1차 사이클(DPS 완결)까지 만든 뒤 `hold`(→DDH) → **`embargoAt`을 그대로 둔 채** 재송고(→DES) → `tick(now = T1 이후)`:
   - `distribute` 호출 **1회**, `kinds === ['press']`(도래한 kind에 정정본 재배부 — 위 "의도된 동작 변화"),
   - 상태 `DPS`(완결), 이어서 다시 `tick` → 배부 **0회**(사이클 내 이력으로 멱등),
   - 과거 사이클의 distribute 이력 행이 그대로 남고 Article/Contents/ArticleHistory 행 수가 줄지 않는다.
   이 케이스가 red/green 어느 쪽이든 **기대값을 여기 고정한 대로** 잠근다 — 후속 세션이 "재배부는 버그"라고 되돌리지 않도록 테스트 주석에 근거(§배경 "의도된 동작 변화")를 남겨라.
8. **DB 비파괴**: 시나리오 전 구간에서 Article/Contents/ArticleHistory **행 수가 줄지 않는다**(기존 `counts()` 헬퍼 사용), 과거 사이클의 distribute 이력 행이 그대로 남아 있다.
9. **레거시 회귀**: 기존 케이스(송고 이력 뒤에 배부 이력을 심는 `addArticle` 픽스처, 레거시 DPS 픽업, self-heal 승격, TOCTOU status-changed, no-active-target, invalid 보고)가 **전부 green**.

### (c) 송고 훅 계약 회귀

10. `test/articleSendDistribution.test.js` 전체가 **무수정으로 green**(특히 L226~332의 DPS 재송고 정정본 4케이스). 이 파일을 고쳐야 green이 된다면 결선이 잘못된 것이다 — 송고 훅을 건드렸다는 신호다.

케이스 1·5·7은 **구현 전 red**를 반드시 확인하고 green으로 만든다.

## Acceptance Criteria

```bash
node --test test/distributionTickService.test.js test/articleService.test.js test/articleSendDistribution.test.js test/embargoPolicy.test.js test/distributionService.test.js test/distribution-tick-api.test.js
npm test                 # tests 636+N / fail 0
npm run lint
git diff --name-only      # src/services/articleService.js, src/services/distributionTickService.js + 테스트 파일만. web/ 0건
grep -n "setInterval\|setTimeout\|fetch(" src/services/distributionTickService.js src/services/articleService.js   # 0건
```

## 검증 절차

1. 위 AC 커맨드 실행 — `npm test` fail 0.
2. 변이 검증:
   - `syncEmbargoStatus`와 `distributedOf`를 `distributedKinds`(전체 이력)로 되돌리면 (a)-1과 (b)-5가 red가 되는가?
   - `dueKinds`의 시각 비교를 무력화하면 (b)-6이 red가 되는가?(엠바고 게이트가 테스트로 잠겨 있는지)
3. 아키텍처 체크리스트:
   - 판정 규칙이 `embargoPolicy` 단일 출처인가(articleService·tick에 kind 필터링·경계 판정 재구현 0건)?
   - `articleService`에 시각 비교(`Date.parse`, `<= now`)를 추가하지 않았는가(시점 판정은 tick 책임)?
   - tick은 여전히 status를 직접 쓰지 않고 `syncEmbargoStatus`에만 위임하는가?
   - DB 비파괴: 이력 삭제·UPDATE·백필 0건인가?
4. `phases/51-security-hotfix/index.json`의 step3 상태·summary를 갱신한다. summary에는 **"tick 자동 복구 경로 없음(무음 미배부+거짓 완결)"** 이라는 영향 범위 판단과 사이클 경계 규칙을 남긴다.

## 금지사항

- `applyAction` 송고 훅의 `distributedKinds(...)` 호출이나 `distributionKindsForSend`를 바꾸지 마라. 이유: "이미 배부된 kind에만 정정본"은 phase 49가 확정하고 test/articleSendDistribution.test.js L226~332이 잠근 계약이다 — 사이클 경계를 여기에 적용하면 재송고 시점에는 항상 `[]`가 되어 정정본이 사라진다(송고 이력이 배부 훅보다 먼저 기록되기 때문).
- `DES_ENTRY_STATUSES`에 `DPS`를 추가하지 마라. 이유: 배부 이력이 있는 기사를 DES로 되돌리면 영구 DES 고착이 된다(phase 48·49가 명시한 금지).
- `embargoStatusFor`의 승격 규칙(완결→DPS, 1건 이상→EPS, EPS→DES 역행 금지)이나 `MUTABLE_STATUSES`를 바꾸지 마라. 이유: 상태 계산의 단일 출처이며, 이 결함의 원인은 규칙이 아니라 **입력(distributed) 집합**이다.
- 과거 사이클 이력 행을 삭제·수정하거나, 재송고 시 이력을 정리하는 코드를 넣지 마라. 이유: ArticleHistory는 append-only이고 DB 비파괴 원칙이다 — 사이클 구분은 **읽기 시 판정**으로만 한다.
- `setInterval`/`setTimeout`/`fetch`/네트워크 전송을 추가하지 마라. 이유: ADR-008 — 앱에 타이머·egress를 두지 않는다(시점 배부는 외부 cron의 tick pull).
- `distributionService`·`spoolWriter`·라우트·컨트롤러·web을 수정하지 마라. 이유: 이 step의 범위는 판정 입력 결선 두 곳이다.
- 기존 테스트의 단언을 약화하거나 삭제하지 마라(기준선: backend 636/636 green, lint clean).
