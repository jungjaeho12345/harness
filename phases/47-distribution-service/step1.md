# Step 1: distribution-service

배부 실행 도메인 서비스를 만든다. "누구에게(활성 DistributionTarget) 무엇을(기사 스냅샷) 배부하고,
그 사실을 어디에 남기는가(`Contents.distributedAt` + `ArticleHistory`)"가 이 step의 전부다.

**시점 배부(tick)는 phase 48이다 — 이 step에 타이머·폴링·tick 라우트를 만들지 마라.**
이 서비스는 "지금 이 kind 집합으로 배부하라"는 **명령형 실행 함수**만 노출하고, 언제 부를지는 호출자(step2 송고 훅, phase 48 tick)가 정한다.

## 읽어야 할 파일

- `docs/ADR.md` — ADR-008 전체. 특히 (4) 엠바고 없는 기사는 송고 즉시 언론사+비언론사 전체 배부 후 `distributedAt` 기록, (5) 배부 이벤트는 ArticleHistory 기록.
- `docs/news.md` — "엠바고 규칙" 절(1차→언론사, 2차→비언론사, 송고 시 언론사 즉시), "기사 생애주기" 절.
- `docs/SCHEMA.md` — Contents(`distributedAt`), DistributionTarget(`kind`, `active`, `spoolDir`) 절.
- `src/services/spoolWriter.js` — **step0에서 생성**. `write({ spoolDir, articleId, article, contents })` → `Promise<{ ok, file|reason }>`.
  **외부 파일 shape·필드 allowlist는 spoolWriter가 단일 출처다** — 이 서비스는 `articleModel.getById`가 준 행을 그대로 넘기기만 하고 페이로드를 조립하지 않는다.
- `src/models/distributionTargetModel.js` — `query(filters)`(화이트리스트 AND 동등 필터, `ORDER BY id`).
- `src/models/articleModel.js` — `getById(articleId)` → `{ article, contents }`, `update(articleId, { contents })`(present-only, 트랜잭션).
- `src/models/articleHistoryModel.js` — `insert(record)` 컬럼: `articleId, eventType, action, fromStatus, toStatus, actorUserId, createdAt, markupVersion`.
- `src/services/articleService.js` — 이력 기록 헬퍼 `record()`의 "부가 기록은 본 기능을 막지 않는다" 관례.
- `src/services/receiverConfigService.js`, `src/services/distributionTargetService.js` — 서비스 계층 스타일.

## 작업

**TDD: 테스트를 먼저 쓰고 red를 확인한 뒤 구현한다.**

### 1) `test/distributionService.test.js` (신규, node:test)

in-memory DB(`node:sqlite` `:memory:` + `createSchema`) 또는 가짜 모델을 주입하고, `spoolWriter`는 가짜를 주입한다(실 FS 금지).
최소 커버리지:

- `kind` 선택: `kinds:['press']`면 `kind='press'` **활성('Y')** 대상에게만 쓰고, 비활성('N') 대상과 다른 kind는 건너뛴다.
- `kinds:['press','nonpress']`면 두 kind 활성 대상 전부에게 쓴다.
- 대상 0건이면 `{ ok:true, distributed:[] }`이고 파일 쓰기·`distributedAt` 갱신·이력 기록이 **없다**(송고를 막지 않는다).
- 없는 기사면 `{ ok:false, reason:'not-found' }`, 파일 쓰기 0건.
- 성공 시 `Contents.distributedAt`이 주입 시계 값으로 갱신된다. **다른 Contents 컬럼(status·sentAt·본문)은 불변**.
- `ArticleHistory`에 kind별 1행(`eventType:'distribute'`, `action:'press'|'nonpress'`, `actorUserId`)이 append된다. 기존 이력 행은 그대로 남는다.
- 한 수신처의 스풀 쓰기가 실패(`{ok:false}`)해도 나머지 수신처 쓰기는 계속되고, 결과에 `failed`로 보고된다.
- **전량 실패**면 `distributedAt`을 갱신하지 않고 해당 kind 이력도 남기지 않는다(거짓 기록 금지).
- `spoolWriter.write`가 `{ spoolDir, articleId, article, contents }`로 호출된다 — 본문 행(`article.markupVersion`)이 그대로 전달된다.
- DB 비파괴: 실행 후 Article/Contents/DistributionTarget 행 수가 그대로다.

### 2) `src/services/distributionService.js` (신규)

```js
export function createDistributionService({
  distributionTargetModel,
  articleModel,
  historyModel,          // 선택 — 미주입이면 이력 기록만 건너뛴다
  spoolWriter,           // 선택 — 미주입이면 { ok:false, reason:'spool-disabled' }
  now = () => new Date().toISOString(),
}) {
  // kinds: ('press'|'nonpress')[] — 호출자가 정한다(엠바고 판정은 호출자 책임).
  // 반환: { ok:true, distributed:[{ targetId, kind, file }], failed:[{ targetId, kind, reason }] }
  async function distribute(articleId, { kinds, actorUserId } = {}) { /* ... */ }
  return { distribute };
}
```

핵심 규칙(벗어나지 마라):

- **대상 선정은 모델 필터로**: `distributionTargetModel.query({ kind, active: 'Y' })` — 비활성 대상은 배부하지 않는다(SCHEMA.md: `'N'`이면 배부 대상 제외).
- **kinds 화이트리스트**: `'press'|'nonpress'` 외 값은 무시한다(빈 배열/미지정이면 아무것도 하지 않고 `{ ok:true, distributed:[] }`).
- **`distributedAt` 정책(확정)**: 배부 지시가 1건이라도 성공하면 `articleModel.update(articleId, { contents:{ distributedAt: now() } })`로 **최신 배부 시각으로 갱신**한다.
  근거: ADR-008 트레이드오프 "스풀 기록 시각 = distributedAt". 과거 배부 사실은 `ArticleHistory`에 append-only로 전부 남으므로 정보 손실이 없다.
  **`status`·`sentAt`·본문 등 다른 컬럼은 절대 함께 쓰지 마라**(present-only 업데이트).
- **이력 기록 단위**: kind별 1행. 그 kind에서 **성공한 쓰기가 1건 이상일 때만** 남긴다.
  `eventType:'distribute'`는 기존 이력 조회(`articleService.queryHistory`)에 그대로 섞여 노출된다 —
  송고이력 필터(`sendOnly`)는 `eventType==='status' && action==='send'`이므로 **영향 없음**을 테스트로 잠근다.
  이력보기 UI의 한글 라벨링은 web 범위(MVP-4)라 이 phase에서 다루지 않는다.
  이 행이 phase 48 tick의 "이미 배부됨" 판정 근거가 되므로 kind 값(`action` 컬럼)을 정확히 기록한다.
  이력 기록 실패는 try/catch로 격리한다(배부 자체를 되돌리지 않는다).
- **상태 전이 금지**: EPS→DPS 전이는 **여기서 하지 않는다**. 엠바고 기사는 최소 한 번의 시점 배부가 남아 있어 tick(phase 48)이 완결을 판정한다.
- **부분 실패 격리**: 수신처 하나의 실패가 다른 수신처·상위 송고를 막지 않는다. 실패는 `failed[]`로 **반환**한다(throw 금지).
- **egress/타이머 0**: `fetch`·`setInterval`·`setTimeout` 금지. 파일 접촉은 오직 주입된 `spoolWriter`를 통해서만(직접 `node:fs` import 금지).
- **DB 삭제 0**: `DELETE`/`DROP` 금지.

## Acceptance Criteria

```bash
npm test && npm run lint
```

- 신규 테스트 green, 기존 백엔드 테스트 무회귀(step0 종료 시점 수치 대비 증가만).

## 검증 절차

1. 신규 테스트 red 확인 후 구현 → green.
2. `grep -n "node:fs\|fetch(\|setInterval\|setTimeout\|DELETE FROM\|DROP " src/services/distributionService.js` → 0건.
3. `git diff --stat`이 `src/services/distributionService.js` + `test/distributionService.test.js` 2개뿐인지 확인(step0 파일 제외).

## 금지사항

- `POST /api/distribution/tick` 라우트나 주기 실행 루프를 만들지 마라. 이유: phase 48 범위이며, 앱 내 타이머는 ADR-008 위반이다.
- 엠바고 시각 비교(“지금이 1차 시각을 지났는가”) 로직을 여기에 넣지 마라. 이유: 시점 판정은 tick(phase 48)의 책임이고, 이 서비스는 "주어진 kind로 지금 배부"만 한다.
- `articleModel.update`로 `status`를 바꾸지 마라. 이유: 생애주기 전이는 `lifecycle.transition`/`articleService`가 단일 출처다.
- 배부 실패 시 예외를 던지지 마라. 이유: 송고(상태 전이)가 배부 실패로 롤백되면 기사가 유실 상태에 빠진다.
- `internalComment` 등 비공개 필드를 페이로드에 추가하지 마라. 이유: allowlist는 step0 `spoolWriter`가 단일 출처다.
