# Step 2: tick-service

시점 배부의 **실행 서비스**를 만든다. 신규 파일 1개(`src/services/distributionTickService.js`) + 테스트 1개.
"외부 운영 루틴이 주기적으로 부르면, 지금 시각 기준으로 배부할 게 있는 EPS 기사를 찾아 배부하고, 완결된 기사를 EPS→DPS로 전이한다."

HTTP·라우트·인가·타이머는 여기에 없다(step3/step4 및 ADR-008 (3)).

## 읽어야 할 파일

- `docs/ADR.md` ADR-008 — (3) `POST /api/distribution/tick` pull, (5) 배부 이벤트 ArticleHistory 기록 + 완결 시 EPS→DPS.
- `docs/news.md` 256~263행 엠바고 규칙.
- `src/services/embargoSchedule.js` (step0 산출물) — `pendingKinds(contents, historyRows, nowIso)`, `isEmbargoComplete(contents, historyRows)`.
- `src/services/lifecycle.js` (step0에서 `embargoCompleteTransition` 추가됨).
- `src/services/distributionService.js` (step1에서 `onDistributed` 추가됨) — `distribute(articleId, { kinds, actorUserId })` 계약과 반환 shape.
- `src/models/articleModel.js` 73~140행 `query(filters)` — `status` 필터(문자열/배열 IN)와 반환이 **Contents 행 배열**이라는 점(본문 없음).
- `src/models/articleHistoryModel.js` — `queryByArticle(articleId)`(id DESC), `insert(record)`. **삭제 함수는 없다(있어서도 안 된다).**
- `src/services/articleService.js` 135~188행 `applyAction` — 상태 전이 후 `record({ eventType:'status', action, fromStatus, toStatus, actorUserId })`를 남기는 관례. 이 step의 완결 전이도 같은 형식으로 남긴다.
- `test/distributionService.test.js` — in-memory DB + 실제 모델 + 가짜 spoolWriter 조립 관례.

## 작업

**TDD: 테스트를 먼저 쓰고 red를 확인한 뒤 구현한다.**

### 1) 테스트 `test/distributionTickService.test.js` (신규)

in-memory DB(`node:sqlite` + 기존 스키마 헬퍼)에 실제 `articleModel`/`articleHistoryModel`을 물리고, `distributionService`는 **가짜**(호출 인자 기록 + 성공/실패 제어)로 주입한다. `now`는 주입해 결정적으로 만든다.

최소 케이스:
1. **1차 엠바고 도달** — EPS + `embargoAt` 과거 → `distribute(articleId, { kinds:['press'] })` 1회 호출, 이력에 press가 쌓이면 status가 `DPS`로 전이되고 `ArticleHistory`에 `{eventType:'status', action:'embargoComplete', fromStatus:'EPS', toStatus:'DPS'}` 1행이 추가된다.
2. **미도달** — EPS + `embargoAt` 미래 → `distribute` 호출 0, status `EPS` 유지, 이력 증가 0.
3. **1+2차 부분 도달** — 1차만 지난 상태 → press만 배부, **status는 EPS 유지**(nonpress 미완결). 이후 2차 시각으로 `now`를 옮겨 재호출하면 nonpress 배부 + `DPS` 전이.
4. **2차만 설정** — 송고 시 press 이력이 이미 있는 EPS 기사에서 2차 시각 도달 → nonpress만 배부 후 `DPS` 전이. press를 다시 배부하지 않는다.
5. **멱등성** — 같은 시각으로 tick을 연속 2회 호출하면 2회차의 `distribute` 호출은 0이고 상태·이력이 더 변하지 않는다(2회차에 status 이력이 중복 append되지 않는다).
6. **배부 실패** — 가짜 distributionService가 `{ ok:true, distributed:[], failed:[...] }`를 반환(이력 미기록)하면 status는 `EPS` 유지, `DPS` 전이 없음. tick은 throw하지 않고 요약에 실패를 담는다.
7. **대상 스코프** — status가 `EEH`/`EEK`(보류·킬된 엠바고 기사), `DPS`, `RDS`인 기사는 시각이 지났어도 **절대 배부·전이 대상이 아니다**.
8. **한 기사 실패가 다른 기사를 막지 않는다** — 첫 기사에서 distributionService가 throw해도 다음 기사는 정상 처리된다.
9. **비활성화** — `distributionService` 미주입이면 `{ ok:false, reason:'spool-disabled' }`를 반환하고 DB를 건드리지 않는다.
10. **DB 비파괴** — tick 전후로 Article/Contents 행 수가 동일하고, 기존 이력 행이 하나도 사라지지 않는다(append만).
11. **배부 없는 완결 전이(자가 치유)** — EPS 기사에 필요한 `distribute` 이력이 이미 전부 있고 배부할 pending이 0인 경우(이전 tick이 전이 전에 중단된 상황), tick은 `distribute`를 호출하지 않고도 `DPS`로 전이하고 `embargoComplete` 이력을 남긴다. **이 케이스가 빠지면 기사가 영구히 EPS에 고착된다.**
12. **미완결 요약** — 2차 엠바고만 있고 press 이력이 없는 EPS 기사에서 2차 시각이 지나 nonpress를 배부해도 완결이 아니며(`press` 누락), status는 `EPS`로 남고 요약의 `incomplete`에 `missing:['press']`로 드러난다.
13. **부분 성공 완결** — 수신처 2곳 중 1곳만 성공해 이력이 1행 남은 경우에도 그 kind는 배부된 것으로 계산돼 완결·전이가 성립한다(실패분은 `failed`에 남는다).

### 2) `src/services/distributionTickService.js` (신규)

```js
export function createDistributionTickService({
  articleModel, historyModel, distributionService,
  now = () => new Date().toISOString(),
}) {
  async function tick({ actorUserId = null } = {}) { /* ... */ }
  return { tick };
}
```

반환: `{ ok:true, checkedCount, distributed:[{ articleId, kinds }], completed:[articleId], incomplete:[{ articleId, missing:[kind] }], failed:[{ articleId, kind, reason }] }`
(정확한 필드명은 재량이나, "몇 건 확인 / 무엇을 배부 / 무엇이 완결 / **무엇이 아직 미완결이며 무슨 kind가 빠졌는지** / 무엇이 실패"가 호출자에게 보여야 한다 — 운영 루틴이 이 응답으로 배부 상태를 판단한다.)

핵심 규칙(벗어나지 마라):
- **대상 선정은 `articleModel.query({ status: 'EPS' })`로만** 한다. `EEH`/`EEK`/`DPS`를 포함시키지 마라.
- **배부와 완결 판정은 서로 독립적으로 수행한다(CRITICAL).** 기사마다 ① `pendingKinds`가 있으면 배부하고, ② 배부 여부와 **무관하게** 완결 판정·전이를 시도한다.
  `pendingKinds`가 0인 기사를 판정 없이 건너뛰지 마라 — 이전 tick이 배부 이력을 남긴 뒤 전이 전에 중단됐거나, 송고 훅이 필요한 kind를 이미 전부 배부한 기사는 배부할 게 없는데도 전이가 필요하다. 건너뛰면 그 기사는 영원히 EPS에 고착된다(자가 치유 불가).
- **시점 판정은 step0 순수 함수에 위임**한다. 시각 비교(`>`/`Date.parse`)를 이 파일에서 재구현하지 마라(단일 출처).
- **완결 판정 근거는 `historyModel.queryByArticle(articleId)`의 `eventType='distribute'` 이력**이다(ADR-008 (5)). 배부 호출 **후** 이력을 다시 읽어 판정한다 — `distribute()`의 반환값만 믿지 않는다(이력 기록이 실패했으면 완결로 봐선 안 된다).
- **부분 성공의 의미** — phase 47의 `distributionService`는 한 kind 안에서 수신처 1곳이라도 성공하면 이력 1행을 남긴다. 따라서 부분 성공도 그 kind는 "배부됨"으로 계산된다. 이 semantics를 바꾸지 마라(실패 수신처 재전송은 MVP-4 범위) — 대신 `failed`에 남겨 운영자가 볼 수 있게 한다.
- **미완결 기사는 요약에 드러낸다** — 완결 판정이 false인 EPS 기사는 `incomplete`에 `missing`(빠진 kind)과 함께 담는다. 이유: 2차 엠바고만 있는 기사에서 송고 시 press 배부가 실패하면 그 기사는 이력이 채워질 때까지 EPS에 남는데, 응답에 드러나지 않으면 운영자가 원인을 알 수 없다.
- **전이는 `embargoCompleteTransition(현재 status)`가 ok일 때만** 수행하고, `articleModel.update(articleId, { contents: { status } })` **present-only**로 쓴다. `sentAt`·`sender`·본문·`distributedAt`을 함께 쓰지 마라.
- 전이 직후 `historyModel.insert({ articleId, eventType:'status', action:'embargoComplete', fromStatus:'EPS', toStatus:'DPS', actorUserId, createdAt: now() })` 1행을 남긴다. 이력 기록 실패는 try/catch로 격리한다(기존 `record` 관례).
- **기사 단위 격리** — 한 기사에서 예외가 나도 루프를 멈추지 마라(다른 기사의 엠바고가 통째로 밀린다).
- **타이머 금지** — `setInterval`/`setTimeout`/`fs.watch` 0건. 이 서비스는 호출될 때만 1회 동작한다.
- **네트워크 egress 금지** — `fetch` 0건. 파일 쓰기는 오직 주입된 `distributionService`(→ spoolWriter)를 통해서만.
- **DB 삭제 금지** — `DELETE`/`DROP`/행 제거 0건.

## Acceptance Criteria

```bash
npm test && npm run lint
```

- 백엔드 테스트 전량 green(step1 결과 대비 신규분만 증가, 회귀 0), lint 경고 0.

## 검증 절차

1. 구현 전 신규 테스트에서 red를 확인한다.
2. `grep -nE "setInterval|setTimeout|fetch\(|node:fs|DELETE FROM|DROP " src/services/distributionTickService.js` → 0건.
3. `grep -n "prepare(" src/services/distributionTickService.js` → 0건(서비스는 SQL을 직접 쓰지 않는다 — 모델 경유, ADR-006).
4. 테스트에서 tick 2회 호출 후 `SELECT COUNT(*) FROM Contents` 값이 1회 호출 시와 같은지 확인한다(멱등성·비파괴).

## 금지사항

- 앱 안에서 주기 실행(타이머·크론·재귀 setTimeout)을 만들지 마라. 이유: ADR-008 (3)이 "앱 내 타이머가 아니라 tick pull"로 결정했다 — 타이머가 들어오면 배부가 앱 프로세스 수명에 묶여 다중 인스턴스에서 중복 반출이 난다.
- `distribute()` 반환값만으로 완결을 판정하지 마라. 이유: 이력 append가 실패한 배부를 완결로 오인하면 EPS→DPS 전이 후 근거가 DB에 없어 감사 추적이 끊긴다(요구 명세는 "완결 판정 근거는 ArticleHistory 이력").
- 이미 배부된 kind를 다시 배부하지 마라. 이유: tick은 외부 루틴이 분 단위로 반복 호출한다 — 멱등하지 않으면 같은 기사가 수신처로 수십 번 반출된다(회수 불가).
- `EEH`/`EEK` 기사를 배부·전이 대상에 넣지 마라. 이유: 보류·킬된 기사가 엠바고 시각이 됐다고 외부로 나가면 편집국 통제를 벗어난다.
- 배부할 pending이 0이라고 해서 완결 판정을 건너뛰지 마라. 이유: 이력은 남았는데 전이가 안 된 기사가 자가 치유되지 않아 영구 EPS로 고착되고, 운영자가 수동 DB 수정 외에는 복구할 수단이 없다.
- Contents 행을 삭제하거나 status 외 컬럼을 함께 덮어쓰지 마라. 이유: DB 비파괴 원칙(CLAUDE.md CRITICAL) + present-only 업데이트가 이 코드베이스의 계약이다.
- HTTP/Express 코드를 이 파일에 두지 마라. 이유: 얇은 transport 원칙(ADR-006) — 라우트는 step4의 책임이다.
