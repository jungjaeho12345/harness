# Step 0: embargo-completion

EPS 기사의 **요구 배부 집합**을 도출하는 순수 헬퍼와, 그 집합이 전부 배부 완료됐을 때만
**EPS→DPS로 전이**하는 서비스 함수를 `articleService`에 추가한다(ADR-008 (5)).

이 step은 `src/services/articleService.js` **한 모듈만** 수정한다.
시점 판정(tick)·HTTP 라우트·SSE 신호는 이 step의 범위가 아니다(step1/2/3).

여기서 만드는 `requiredDistributionKinds`는 **"엠바고 설정 → 요구 배부 kind" 매핑의 단일 출처**다.
step1의 tick 서비스는 이 함수를 import해 재사용하며, 같은 판정표를 다시 구현하지 않는다.

## 읽어야 할 파일

- `docs/news.md` — **"엠바고 규칙" 절 전문(256~263행)**. 아래 판정표의 유일한 근거.
- `docs/ADR.md` — ADR-008 (특히 **(5) "배부 이벤트는 ArticleHistory에 기록하고, 엠바고 기사의 배부가 전부 완결되면 EPS→DPS로 전이한다"**), ADR-006(계층), ADR-004(신뢰 경계).
- `src/services/articleService.js` — **전체**. 특히:
  - `distributionKindsForSend(status, contents)` (L75~, phase 47 산출물) — 송고 시 즉시 배부 kinds 판정. 이번에 추가할 헬퍼와 **정합**해야 한다.
  - `createArticleService({ articleModel, db, historyModel, distributionService })` (L82~)
  - `record(rec)` (L85~89) — 이력 기록 헬퍼(실패 격리, `historyModel` 미주입 시 skip)
  - `applyAction` (L137~188) — 전이 → `articleModel.update(articleId, { contents })` → `record({ eventType:'status', action, fromStatus, toStatus, actorUserId })` 관례, 엠바고 truthy 판정(L152)
- `src/services/lifecycle.js` — 전이표. `EPS: { kill: 'EEK', hold: 'EEH' }` (L16) — **send/완결 전이는 정의돼 있지 않다. 이 파일은 이번 step에서 수정하지 않는다.**
- `src/models/articleModel.js` — `getById(articleId)`(L47~), `update(articleId, { article, contents })`(L62~) — present-only 부분 업데이트.
- `src/models/articleHistoryModel.js` — `queryByArticle(articleId)`(L28~34): `id, articleId, eventType, action, fromStatus, toStatus, actorUserId, createdAt, hasSnapshot`를 **id DESC**로 반환.
- `src/services/distributionService.js` — L84~89: 배부 성공 시 `record({ articleId, eventType: 'distribute', action: kind, actorUserId })`. **이 행이 "이미 배부됨" 판정의 유일한 근거다.**
- `test/articleService*.test.js` — 백엔드 서비스 테스트 하네스 관례(node:test + in-memory `DatabaseSync`).

## 요구 배부 집합 판정표 (news.md 엠바고 규칙에서 그대로 도출 — 임의 확장 금지)

| `embargoAt` | `secondEmbargoAt` | requiredKinds | 근거 |
|---|---|---|---|
| 있음 | 없음 | `['press']` | "1차 엠바고 시간에는 언론사에 배부한다" — 비언론사 배부 규정 없음 |
| 없음 | 있음 | `['press','nonpress']` | "2차 엠바고 시간에는 비언론사에 배부하는데, **송고시 바로 언론사에 배부**한다" → press는 송고 시 이미 완료(`distributionKindsForSend`가 `['press']` 반환) |
| 있음 | 있음 | `['press','nonpress']` | "1+2차는 1차에 언론사, 2차에 비언론사" |
| 없음 | 없음 | `[]` | EPS 진입 조건 자체가 성립하지 않는 데이터 이상 → **전이하지 않는다**(아래 규칙 참조) |

- "설정됨" 판정은 **truthy**(빈 문자열·null·undefined는 미설정) — `applyAction` L152와 동일 규칙으로 통일한다.
- 순서는 항상 `['press','nonpress']` 고정(집합 비교 시 순서 의존 로직을 쓰지 마라).

## 작업

**TDD: 테스트를 먼저 쓰고 red를 확인한 뒤 구현한다.**

### 1) `test/articleEmbargoCompletion.test.js` (신규, node:test)

`requiredDistributionKinds` 단위 케이스:
- 위 판정표 4행 전부.
- `contents` 미전달/`{}` → `[]` (throw 금지).
- 공백 문자열 `' '`은 truthy이므로 설정으로 본다 — 별도 trim 규칙을 발명하지 않는다(현행 `applyAction`과 동일 동작임을 테스트로 고정).

`completeEmbargoDistribution(articleId, { actorUserId })` 케이스:
- **없는 기사** → `{ ok:false, reason:'not-found' }`, DB 무변경.
- **status가 EPS가 아님**(RDS/DPS/EEH/DDK 등) → `{ ok:true, status:<현재>, transitioned:false }`, **status 컬럼 무변경·이력 미기록**(멱등 no-op).
- **EPS + 1차만 설정 + `distribute/press` 이력 있음** → `{ ok:true, status:'DPS', transitioned:true }`, Contents.status가 실제로 `DPS`, `ArticleHistory`에 `eventType='status', action='distributeComplete', fromStatus='EPS', toStatus='DPS'` 1행 추가.
- **EPS + 1+2차 설정 + `press`만 배부됨** → `{ ok:true, status:'EPS', transitioned:false }`, status 유지, 이력 미기록.
- **EPS + 1+2차 설정 + `press`,`nonpress` 모두 배부됨** → 전이 성공.
- **EPS + 2차만 설정 + `press`만 배부됨** → 전이하지 않는다(nonpress가 남았다).
- **EPS + 엠바고 컬럼 둘 다 비어 있음** → `{ ok:true, status:'EPS', transitioned:false, reason:'no-embargo' }`, **전이 금지**.
- **이미 DPS로 전이된 기사에 다시 호출** → 두 번째 호출은 no-op이고 `distributeComplete` 이력이 **1행만** 존재한다(중복 이력 금지 = 멱등).
- **`historyModel` 미주입으로 생성한 서비스** → 완결 판정 근거가 없으므로 `transitioned:false`(전이 금지, 안전측).
- **다른 eventType 오염 무시**: 같은 기사에 `eventType='status', action='press'` 같은 행이 있어도 배부로 세지 않는다(`eventType==='distribute'`인 행만 센다).

### 2) `src/services/articleService.js` 수정 (additive)

- 파일 상단 근처(`distributionKindsForSend` 옆)에 순수 헬퍼를 **export** 추가:
  ```js
  export function requiredDistributionKinds(contents = {}) // -> string[] ('press' | 'nonpress')
  ```
  - 이 함수는 **모듈 최상위의 named export**여야 한다(`createArticleService` 클로저 안에 두지 마라). 이유: step1의 tick 서비스가 서비스 인스턴스 없이 import해 재사용해야 하고, 그래야 엠바고→kind 매핑이 코드베이스에 한 벌만 존재한다.
  - 순수 함수로 둔다 — DB 접근·시각 비교·로그 없음.
- `createArticleService(...)` 내부에 함수 추가하고 반환 객체(L310 근처 `return { ... }`)에 포함:
  ```js
  function completeEmbargoDistribution(articleId, { actorUserId = null } = {})
  // -> { ok:true, status, transitioned:boolean, required:string[], distributed:string[], reason? }
  //  | { ok:false, reason:'not-found' }
  ```
  - `required`는 반드시 `requiredDistributionKinds(contents)` 결과를 그대로 담는다(내부에서 다른 규칙으로 다시 계산하지 마라).
- 반드시 지킬 규칙:
  1. **판정 입력은 DB 값만** — `articleModel.getById`로 읽은 `contents`와 `historyModel.queryByArticle`의 이력만 쓴다. 호출자가 넘긴 status/kinds는 받지 않는다(ADR-004).
  2. 전이는 `articleModel.update(articleId, { contents: { status: 'DPS' } })` **present-only 1건**. `sentAt`/`sender`/`distributedAt`/본문은 건드리지 않는다(DB 비파괴).
  3. 전이 성공 시에만 `record({ articleId, eventType:'status', action:'distributeComplete', fromStatus:'EPS', toStatus:'DPS', actorUserId })`.
  4. **동기 함수로 둔다**(`applyAction`과 동일 계약). 파일 I/O·네트워크·타이머 없음.
  5. 이력 조회 실패(throw)는 격리해 `transitioned:false`로 수렴한다 — 예외를 호출자에게 던져 tick 루프를 깨지 마라.

## Acceptance Criteria

```bash
npm test && npm run lint
```

- 신규 테스트 green, **기존 백엔드 테스트 무회귀**(`applyAction`/`lifecycle` 관련 테스트가 한 건도 깨지지 않아야 한다).
- lint 경고 0.

## 검증 절차

1. `npm test` 전량 green 확인.
2. `git diff --stat` → 변경 파일이 `src/services/articleService.js` + 신규 테스트 **2개뿐**인지 확인(`lifecycle.js`·`server/**`·`web/**` 무접촉).
3. `grep -rn "distributeComplete" src/ server/` → `articleService.js`에만 존재(라우트 노출 0건).
4. `grep -rn "export function requiredDistributionKinds" src/services/articleService.js` → **1건**(모듈 최상위 export 확인 — step1이 import한다).
5. `grep -rn "DELETE FROM\|DROP " src/services/articleService.js` → 0건.

## 금지사항

- `src/services/lifecycle.js`의 전이표를 수정하지 마라. 이유: EPS→DPS 완결 전이는 사용자 액션이 아니라 시스템 후처리이며, 전이표에 넣으면 `/api/articles/:id/action`의 `ACTION_SET` 확장 유혹이 생겨 사용자가 임의로 EPS를 DPS로 올릴 수 있는 우회 경로가 열린다.
- `completeEmbargoDistribution`을 `/api/articles/:id/action`이나 컨트롤러 `article` 도메인에 노출하지 마라. 이유: 이 함수의 유일한 호출자는 tick 서비스(step1)다.
- 배부(스풀 쓰기)를 이 함수에서 수행하지 마라. 이유: 배부 실행은 `distributionService.distribute`가 단일 출처다(phase 47).
- 현재 시각과 엠바고 시각을 비교하지 마라. 이유: 시점 판정은 step1(tick 서비스) 책임이며, 여기에 시계가 들어오면 완결 판정이 비결정적이 된다.
- `requiredDistributionKinds`가 판정표에 없는 값을 반환하게 만들지 마라(예: 빈 엠바고인데 `['press','nonpress']`). 이유: 근거 없는 자동 전이는 되돌릴 수 없는 상태 변경이다.
- `applyAction`/`create`/`update`의 시그니처·반환 계약을 바꾸지 마라. 이유: 라우트와 다수 기존 테스트가 현재 계약을 전제한다.
