# Step 1: distribution-tick

시점 배부 오케스트레이션을 `articleService`에 추가한다: pending EPS 기사 중 배부 시점이 도래한 kind를 골라 배부하고, 엠바고 배부가 완결되면 **EPS→DPS로 전이**한다. 이 step은 서비스 오케스트레이션 한 레이어만 다룬다(HTTP·라우트는 step 2).

## 읽어야 할 파일

- `/home/user/harness/docs/ADR.md` — ADR-008 (5): 배부 이벤트는 ArticleHistory에 기록하고, 엠바고 배부가 전부 완결되면 EPS→DPS로 전이한다.
- `/home/user/harness/src/services/embargoTick.js` — step 0의 `dueDistributionKinds`, `isEmbargoComplete`. 이 step이 이들을 사용한다.
- `/home/user/harness/src/services/articleService.js` — `createArticleService({ articleModel, db, historyModel, distributionService })`. 여기에 메서드를 추가한다. 특히 137–188행 `applyAction`의 배부 훅·이력 기록(`record`) 패턴, 148–156행 EPS 진입 후처리를 그대로 참고한다.
- `/home/user/harness/src/services/distributionService.js` — `distribute(articleId, { kinds, actorUserId })` 시그니처와 이력 기록(`eventType='distribute', action=kind`).
- `/home/user/harness/src/models/articleModel.js` — `query({ status })`는 Contents 행 배열을 돌려준다(embargoAt·secondEmbargoAt·articleId·status 포함). `update(articleId, { contents })`는 present-only SET(미전달 컬럼 불변). `getById`는 `{ article, contents }`.
- `/home/user/harness/src/models/articleHistoryModel.js` — `queryByArticle(articleId)`는 `{ eventType, action, ... }` 행 배열. `insert(record)`.
- `/home/user/harness/test/distributionService.test.js` — in-memory DB + 실제 모델 + 가짜 spoolWriter 하네스 패턴. 같은 방식으로 테스트한다.

## 작업

`createArticleService`에 async 메서드 `distributionTick({ now } = {})`를 추가하고 반환 객체에 노출한다. `now` 미전달 시 `nowISO()`(기존 헬퍼)를 쓴다.

### 알고리즘 (반드시 준수)

```
distributionTick({ now } = {}):
  nowVal = now ?? nowISO()
  if (!distributionService) return { ok: true, distributed: [], completed: [] }   // 스풀 미설정 — no-op
  eps = articleModel.query({ status: 'EPS' })              // Contents 행 배열
  distributed = []; completed = []
  for (row of eps):
    id = row.articleId
    distSet1 = 배부이력 kind 집합                            // historyModel.queryByArticle(id) 중 eventType==='distribute' 의 action
    due = dueDistributionKinds(row, distSet1, nowVal)       // step0 순수 함수
    if (due.length > 0):
      await distributionService.distribute(id, { kinds: due, actorUserId: null })
      distributed.push({ articleId: id, kinds: due })
    distSet2 = 배부이력 kind 집합 재조회                      // 배부 후 최신 이력 — 완결 판정은 "이력 kind 기준"
    if (isEmbargoComplete(row, distSet2)):
      fresh = articleModel.getById(id)
      if (fresh?.contents?.status === 'EPS'):               // 아직 EPS일 때만 전이(멱등·경합 방지)
        articleModel.update(id, { contents: { status: 'DPS' } })   // present-only — status만 변경
        record({ articleId: id, eventType: 'status', action: 'embargoComplete',
                 fromStatus: 'EPS', toStatus: 'DPS', actorUserId: null })
        completed.push(id)
  return { ok: true, distributed, completed }
```

### 반드시 지킬 규칙

- **완결 판정은 배부 후 재조회한 ArticleHistory distribute 이력 kind로만** 한다(handoff·ADR-008). `distribute()` 반환값이 아니라 이력을 다시 읽는다 — 그래야 2차만 기사의 송고 시점 press 이력까지 반영된다.
- **EPS→DPS 전이는 present-only `articleModel.update(id, { contents: { status: 'DPS' } })`** 로만 한다. status 외 컬럼(sentAt·sender·distributedAt·본문·잠금)은 절대 건드리지 마라. `distributedAt`은 `distribute()`가 이미 갱신한다.
- 전이 직전 `getById`로 현재 status가 여전히 `EPS`인지 확인하고, EPS일 때만 전이·이력 기록한다. 이유: 멱등성(두 번째 tick·이미 전이된 기사 재처리 방지).
- 배부 실패(활성 대상 0·스풀 실패)로 완결 못 하면 그 기사는 EPS로 남고 다음 tick이 재시도한다. `distribute()`는 throw하지 않으니 tick 전체가 한 기사 때문에 멈추면 안 된다 — 기사별 처리를 `try/catch`로 감싸 격리하라(한 기사 오류가 다른 기사·전체 tick을 막지 않게).
- 이력 기록은 기존 `record` 헬퍼(historyModel 미주입·insert 실패를 격리)를 그대로 쓴다.
- `actorUserId`는 `null`(시스템 tick — 사람 액터 없음). 절대 클라이언트 값에서 도출하지 마라.

### EPS→DPS status 이력의 action 값

`action='embargoComplete'`를 쓴다. 이유: 이 전이는 사람이 누른 송고/보류/KILL이 아니라 시스템 완결 전이다. `queryHistory(..., { sendOnly:true })`의 송고이력 필터(`eventType==='status' && action==='send'`)에 잡히면 안 되므로 `'send'`를 재사용하지 마라.

## Acceptance Criteria

```bash
cd /home/user/harness && node --test "test/distributionTick.test.js"   # 신규 테스트 통과
cd /home/user/harness && npm test                                       # 전체 무회귀(step0 대비 +신규, 0 fail)
cd /home/user/harness && npm run lint                                   # 0 warning
```

## 검증 절차

1. TDD: `test/distributionTick.test.js`를 먼저 작성해 red 확인 후 구현으로 green. 하네스는 `distributionService.test.js`와 동일하게 in-memory DB + 실제 모델 + 실제 distributionService(가짜 spoolWriter 주입).
   케이스(최소):
   - 1차만 EPS, now < embargoAt → 배부·전이 없음(EPS 유지, 파일 쓰기 0).
   - 1차만 EPS, now >= embargoAt, 활성 press 대상 있음 → press 배부 + distributedAt 기록 + distribute:press 이력 + EPS→DPS 전이 + status:embargoComplete 이력.
   - 2차만 EPS(송고 시 press 이력 이미 존재), now >= secondEmbargoAt → nonpress 배부 + 완결 → DPS.
   - 1+2차 EPS, now가 1차만 지남 → press만 배부, 미완결(EPS 유지). 이어 now가 2차도 지남 → nonpress 배부, 완결 → DPS.
   - 멱등성: 이미 배부·전이된 기사에 tick 재실행 → 추가 파일 쓰기 0·중복 이력 0·상태 DPS 유지.
   - 활성 대상 0으로 배부 okInKind=0 → 이력 없음·완결 안 됨·EPS 유지(다음 tick 재시도 가능).
   - DB 비파괴: tick 전후 Article/Contents/DistributionTarget 행 수 동일, 송고 이력(status/send) 보존.
   - `!distributionService`(미주입)면 `{ ok:true, distributed:[], completed:[] }` no-op.
2. 아키텍처 체크: 앱 타이머/네트워크 egress 0(`setInterval`/`setTimeout`/`fetch` 미사용), DB 비파괴(행 삭제 0), 신뢰 경계(actorUserId=null 시스템).
3. `phases/48-distribution-tick/index.json` step 1 갱신.

## 금지사항

- `distributionService`나 `spoolWriter`를 재구현하지 마라(phase 47 것을 그대로 호출). 이유: 배부 파일 shape·대상 선정의 단일 출처가 흔들린다.
- 시각 비교 로직을 여기서 다시 짜지 마라 — `embargoTick.js`(step 0)에 위임한다. 이유: 판정 규칙 중복은 불일치를 낳는다.
- status 외 컬럼을 전이 시 함께 update 하지 마라. 이유: present-only 계약이 깨지면 DB 비파괴(sentAt·본문 등 덮어쓰기 위험)가 무너진다.
- DB 행을 삭제하는 코드·마이그레이션을 넣지 마라.
- `applyAction`의 동기 반환 계약을 바꾸지 마라(별도 async 메서드 추가일 뿐, 기존 메서드 시그니처 불변).
- 기존 테스트를 깨뜨리지 마라.
