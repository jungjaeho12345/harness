# Step 1: dps-resend-kinds

## 목표

**DPS 재송고(고침/포털고침 후 재송고)가 엠바고를 무시하고 전 수신처에 즉시 배부하는 구멍을 막는다.**

현재 `distributionKindsForSend('DPS', contents)`는 엠바고 컬럼을 보지 않고 무조건 `['press','nonpress']`를 돌려준다. 그래서 **엠바고 시각이 아직 오지 않은 DPS 기사**(phase 47 이전 DDH 경로로 새어 DPS로 남은 레거시 행, 또는 배부 완결 후 엠바고가 다시 설정된 행)를 재송고하면 **엠바고 시각 전에 비언론사까지 배부**된다. 한 번 나간 기사는 회수 수단이 없다.

수정 방침: DPS 재송고는 **이미 배부 이력이 있는 kind에만** 정정본을 보낸다. 아직 배부되지 않은 kind는 건드리지 않고 tick(`distributionTickService`)이 도래 시각에 배부한다 — tick은 배부 직전 최신 행을 다시 읽으므로 정정된 내용이 나간다.

이 step은 **`src/services/articleService.js` 한 모듈만** 수정한다(+ 테스트). 라우트·컨트롤러·모델·DB 스키마·웹 무접촉.

## 읽어야 할 파일

라인 번호는 실측 힌트 — 심볼명으로 재확인하라.

- `docs/ARCHITECTURE.md`(백엔드 계층 `controllers → services → models → db`), `docs/ADR.md` **ADR-008 전문**(특히 (3) tick pull, (4) 일반 DPS 즉시 배부), `docs/news.md`의 "엠바고 규칙", `docs/SCHEMA.md`(Contents.embargoAt/secondEmbargoAt/distributedAt).
- `src/services/embargoPolicy.js` — **전체**. 이 step에서 쓰는 계약:
  - `requiredKinds(contents)` → 설정된 엠바고 필드에 대응하는 kind 배열(`embargoAt`→`press`, `secondEmbargoAt`→`nonpress`, 항상 `[press, nonpress]` 순서). **엠바고 미설정이면 `[]`**.
  - `distributedKinds(historyRows)` → `eventType==='distribute'` 이력의 action에서 도출한 이미 배부된 kind 배열.
  - `dueKinds(...)`/`embargoStatusFor(...)` — 이 step에서 호출하지 않는다(시각 판정은 tick의 책임).
- `src/services/articleService.js` — **전체**. 핵심 지점:
  - `distributionKindsForSend(status, contents = {})`(L70~82 주석 + 본문) ← **수정 대상**.
  - `applyAction(...)`의 송고 후처리 배부 훅(L185~205): `const kinds = distributionKindsForSend(finalStatus, row.contents);` ← **호출부 수정 대상**.
  - `syncEmbargoStatus(articleId, { extraKinds, actorUserId })`(L209~233) — 배부 성공 후 상태 승격. **수정하지 마라**.
  - 파일 상단 import(L8): `distributedKinds`, `embargoStatusFor`가 이미 들어와 있다.
- `src/services/lifecycle.js` — `DPS: { send: 'DPS', ... }`(L14, DPS는 재송고만 가능).
- `test/articleSendDistribution.test.js` — **전체**. 이 step의 테스트가 들어갈 파일이다. `fakeDistribution({ mode })`(호출 인자 기록·실물과 동형 반환), `setup({ distributionService, contents, body })`(in-memory SQLite + 실제 articleModel/historyModel), `statusOf`/`statusHistory` 헬퍼가 이미 있다.
- `test/articleService.test.js` — 회귀 확인용(수정 불필요).

## 배경 (자기완결)

`applyAction`은 송고 성공 직후 배부 훅을 fire-and-forget으로 돈다. 판정표(현행):

| 최종 status | 엠바고 | 즉시 배부 kinds |
|---|---|---|
| DPS | 없음 | `['press','nonpress']` |
| DES | 2차만 | `['press']` (송고 시 바로 언론사) |
| DES | 1차 / 1+2차 | `[]` (시점 배부는 tick) |
| DPS | **설정됨** | `['press','nonpress']` ← **결함** |

마지막 행이 문제다. "DPS인데 엠바고가 설정돼 있다"가 성립하는 경우:
- phase 47 시절 DDH→송고 경로로 새어 DPS가 된 **레거시 엠바고 기사**(phase 48 step2가 앞으로의 유입은 막았지만 기존 행은 마이그레이션하지 않았다 — DB 비파괴),
- 배부가 완결돼 DPS가 된 뒤 고침 편집에서 엠바고 값이 남아 있는 기사.

앞의 경우 재송고하면 1차·2차 시각과 무관하게 즉시 전량 배부된다(엠바고 누수). 뒤의 경우는 이미 배부된 곳에 정정본을 보내는 것이라 정상이다. **두 경우를 가르는 신뢰 가능한 기준은 "이미 배부된 kind"(append-only `distribute` 이력)뿐이다.**

여기서 **시각 비교를 하지 않는다**는 기존 원칙(L77 주석)은 그대로 유지한다 — "지금이 엠바고 시각인가"는 tick의 책임이다. 이 step은 이력만 본다.

## 작업

### 1) `distributionKindsForSend`에 배부 이력 인자 추가 (순수 유지)

```js
// distributed: 이 기사에서 이미 배부된 kind 목록(= embargoPolicy.distributedKinds(이력)). 조회는 호출자 책임.
export function distributionKindsForSend(status, contents = {}, distributed = []) { ... }
```

판정 규칙(이것만 바뀐다):

- `status === 'DPS'`:
  - `requiredKinds(contents).length === 0`(엠바고 미설정) → `['press','nonpress']` — **기존 동작 그대로**.
  - 엠바고 설정됨 → `['press','nonpress']` 중 **`distributed`에 이미 있는 kind만** 반환(순서는 `[press, nonpress]` 고정). 전부 미배부면 `[]`.
- `status === 'DES' && !contents.embargoAt && contents.secondEmbargoAt` → `['press']`(불변).
- 그 외 → `[]`(불변).

제약:
- 함수는 **순수**하게 유지한다 — 모델/DB/시계(`Date`, `now`)를 만지지 마라. `requiredKinds`는 `embargoPolicy`에서 import해 쓴다(엠바고 설정 판정을 `!!contents.embargoAt` 식으로 **재구현하지 마라** — 단일 출처는 embargoPolicy다).
- `distributed`가 배열이 아니면 `[]`로 취급한다(방어).
- 반환 순서는 항상 `[press, nonpress]`(기존 계약 — 테스트가 deepEqual로 잠근다).

### 2) 호출부(`applyAction` 송고 훅) 결선

배부 훅 진입 시 이력을 읽어 넘긴다. **이력 조회와 kinds 판정을 기존 `try` 블록(L192) 안으로 옮겨라** — 현재 `try`는 `distributionService.distribute(...)` 호출만 감싸고 있어서, 밖에서 `historyModel.queryByArticle(articleId)`를 부르면 **모델 예외가 `applyAction` 전체를 깨뜨린다**(송고는 이미 DB에 커밋된 뒤라 라우트가 500을 던지면 사용자에게 "송고 실패"로 보이고 재시도까지 유발된다).

```js
if (action === 'send' && distributionService) {
  try {
    // 이력 조회 실패·미주입은 "아는 배부 이력 없음([])"으로 폴백한다.
    // → 엠바고가 설정된 DPS 재송고에서는 곧바로 kinds=[](배부 없음)가 되어 안전 기본값이 성립한다.
    let already = [];
    try { if (historyModel) already = distributedKinds(historyModel.queryByArticle(articleId)); }
    catch { already = []; }

    const kinds = distributionKindsForSend(finalStatus, row.contents, already);
    if (kinds.length > 0) {
      Promise.resolve(distributionService.distribute(articleId, { kinds, actorUserId: userId ?? null }))
        .then((res) => { /* 기존 승격 로직 그대로 */ })
        .catch(() => { /* 기존 주석 그대로 */ });
    }
  } catch { /* 배부 지시 실패는 송고를 막지 않는다(기존 격리 정책) */ }
}
```

- `historyModel`은 선택 의존성이다 — 미주입이면 `[]`(= 엠바고 DPS 재송고 시 배부 없음, **안전 기본값**).
- 조회가 throw해도 **`applyAction`은 `{ ok:true, status }`를 동기 반환**해야 한다(예외가 훅 밖으로 새면 이미 커밋된 송고가 500으로 보고돼 사용자 재시도를 유발한다). 아래 TDD 케이스 7이 잠근다.
- 실패 폴백은 `already = []`이며, **엠바고가 설정된 DPS에서는 그 값이 곧 `kinds = []`(배부 없음)** 이다 — 모르는 상태의 안전 기본값이다. 반대로 **엠바고 미설정 기사는 `distributed`를 아예 참조하지 않으므로** 이력 조회가 실패해도 기존대로 `['press','nonpress']`가 나간다(이력 장애가 일반 송고 배부까지 멈추게 만들지 않는다 — 조회 폴백을 훅 전체 bail-out으로 만들지 마라).
- `applyAction`의 **동기 반환 계약**(`{ ok:true, status }`)과 `syncEmbargoStatus` 승격 로직(`res.distributed` 성공 kind만)은 **불변**이다.

### 3) 주석 갱신

`distributionKindsForSend` 위 판정표 주석에 DPS 행을 추가한다 — "엠바고가 설정된 DPS 재송고는 이미 배부된 kind에만 보낸다(미도래분은 tick의 책임). 시각 비교는 여전히 하지 않는다."

## TDD — 테스트 먼저

`test/articleSendDistribution.test.js`에 아래 케이스를 red→green으로 추가한다. 배부 이력은 `historyModel.insert({ articleId, eventType:'distribute', action:'press', createdAt })`로 직접 심는다(실제 배부와 동일한 근거 행).

1. **회귀 가드(엠바고 없음)**: DPS 기사 재송고 → `fakeDistribution.calls[0].kinds`가 `['press','nonpress']`. 이력 유무와 무관.
2. **레거시 누수 차단(핵심)**: `embargoAt`·`secondEmbargoAt`가 미래로 설정된 **DPS** 기사 + distribute 이력 0건 → 재송고 시 `distributionService.distribute` **호출 0회**, 상태 DPS 유지, status 이력은 send 1건만.
3. **부분 배부**: 위와 같되 `distribute/press` 이력 1건 → `kinds === ['press']`(nonpress 미포함).
4. **완결 후 정정본**: press·nonpress 이력 모두 있음 → `kinds === ['press','nonpress']`.
5. **2차만 설정된 레거시 DPS**: `secondEmbargoAt`만 설정 + press 이력 1건 → `kinds === ['press']`.
6. **historyModel 미주입**: `createArticleService({ articleModel, db, distributionService })`(historyModel 없음) + 엠바고 설정 DPS → 배부 호출 0회(안전 기본값).
7. **이력 조회 예외 격리**: `queryByArticle`이 throw하는 가짜 historyModel(insert는 정상)을 주입하고 엠바고 설정 DPS를 재송고 → (a) `applyAction`이 **throw하지 않고 `{ ok:true, status:'DPS' }`를 동기 반환**, (b) `distribute` 호출 **0회**, (c) status 전이·이력 기록은 정상 수행. 엠바고 없는 DPS에서도 같은 상황에서 배부가 정상 동작하는지 함께 본다(조회 실패 폴백이 일반 배부를 막지 않는지 — `distributionKindsForSend`가 엠바고 미설정이면 `distributed`를 보지 않으므로 `['press','nonpress']`가 유지돼야 한다).
8. **DES 경로 회귀**: 기존 케이스(2차만 → `['press']`, 1차/1+2차 → 배부 없음, RDS·DDH 진입)가 그대로 green.

각 케이스는 반드시 **구현 전에 red를 확인**하고(2·3·5·6·7은 현재 red여야 한다) 구현 후 green으로 만든다.

## Acceptance Criteria

```bash
node --test test/articleSendDistribution.test.js test/articleService.test.js test/distributionTickService.test.js
npm test          # tests 620+N / fail 0  (step0가 올려둔 620/620 green 기준선 유지 — 실패 0)
npm run lint
```

`npm run test:web`은 무관하다(웹 무접촉). `git diff --name-only`에 `web/`이 없어야 한다.

## 검증 절차

1. 위 AC 커맨드를 실행한다. `npm test` 요약의 **fail은 반드시 0**이어야 한다(step0 이후 기준선).
2. 변이 검증(구현이 진짜 잠겼는지):
   - `distributionKindsForSend`의 DPS 분기에서 이력 교집합을 없애고 `['press','nonpress']`로 되돌리면 케이스 2·3·5가 red가 되는지 확인한다.
3. 아키텍처 체크리스트:
   - 판정은 `embargoPolicy`(requiredKinds/distributedKinds) 단일 출처를 쓰는가? 엠바고 판정을 articleService에 재구현하지 않았는가?
   - `articleService`에 시각 비교(`Date.parse`, `<= now`)를 추가하지 않았는가?(tick의 책임)
   - DB 비파괴: 행 삭제·백필·일괄 UPDATE 0건인가?
4. `phases/49-mini-backlog-cleanup/index.json`의 step1을 `completed`/`error`/`blocked`로 갱신하고 `summary`(또는 `error_message`/`blocked_reason`)를 기록한다.

## 금지사항

- 엠바고 시각과 현재 시각을 비교하는 코드를 `articleService`에 넣지 마라. 이유: 시점 판정은 `distributionTickService`의 단일 책임이며, 송고 훅에 시계가 들어오면 같은 규칙이 두 곳으로 갈라진다(ADR-008 (3)).
- `setInterval`/`setTimeout`/`fetch`/네트워크 전송을 추가하지 마라. 이유: ADR-008 — 앱에 타이머·egress를 두지 않는다(배부는 스풀 파일 쓰기뿐).
- 레거시 DPS 엠바고 행을 DES로 되돌리는 마이그레이션·백필을 하지 마라. 이유: 배부 이력이 있는 기사를 DES로 되돌리면 tick의 "미배부" 판정에 걸리지 않아 영구 고착된다(phase 48 step2가 명시한 금지사항). 또한 DB 비파괴 원칙상 일괄 UPDATE는 금지다.
- `syncEmbargoStatus`·`embargoStatusFor`의 승격 규칙을 바꾸지 마라. 이유: DPS는 이미 `MUTABLE_STATUSES` 밖이라 상태가 흔들리지 않는다 — 건드리면 DES/EPS 승격 계약이 깨진다.
- `distributionService`·`spoolWriter`·라우트·컨트롤러를 수정하지 마라. 이유: 이 step의 범위는 "어떤 kind를 배부할지 정하는 판정" 한 곳이다(다음 step이 distributionService를 다룬다 — 충돌 방지).
- 기존 테스트를 깨뜨리지 마라(기준: 백엔드 620/620 green, lint clean).
