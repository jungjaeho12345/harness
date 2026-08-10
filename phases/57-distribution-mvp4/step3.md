# Step 3: retry-service

## 목표

`src/services/distributionRetryService.js`를 신설한다. 책임 둘:

1. `list({ limit })` — 미해소 수신처 실패 목록을 파생해 **화이트리스트 투영**으로 돌려준다.
2. `retry({ articleId, targetId, actorUserId })` — 그 수신처 **한 곳에만** 기사 파일을 다시 스풀에 쓰고, 성공/실패를 append-only로 남긴다.

도메인 서비스다 — HTTP·세션·타이머 비의존, 의존성은 전부 주입(ADR-006). 인가 게이트 결선은 step4 소관이다.

## 읽어야 할 파일

- `docs/ADR.md` **ADR-008**(파일 스풀 outbound — 앱은 스풀에 쓰기만, egress·타이머 없음)·**ADR-004**(신뢰 경계=서버)·ADR-006. **읽기 전용(무접촉)**.
- `docs/SCHEMA.md` L45~49 — `distributedAt`은 "배부(스풀 기록) 실행 시각이며 실행될 때마다 최신으로 갱신, 개별 이벤트는 ArticleHistory에 append-only".
- `src/services/distributionService.js` 전체 — 특히 L26~28 `isDistributable`(상태 allowlist 재확인), L109~151 수신처 루프(쓰기 → 성공/실패 분기), L163~165 `distributedAt` present-only 갱신, L54~67 `record`.
- `src/services/embargoPolicy.js` L13~18 `EMBARGO_DISTRIBUTABLE_STATUSES`(DES·EPS·DPS — **복제 금지, import해서 쓴다**).
- `src/services/distributionFailureLog.js`(step1) — `unresolvedFailures`, `findUnresolvedFailure`, `DISTRIBUTE_FAILED_EVENT`, `DISTRIBUTE_RETRY_EVENT`.
- `src/models/articleHistoryModel.js`(step0) — `queryDistributionEvents({ articleId, limit })`, `insert`.
- `src/models/distributionTargetModel.js` — `query(filters)`, `findById(id)`.
- `src/services/spoolWriter.js` 전체 — `write({ spoolDir, articleId, article, contents })` → `{ ok, file } | { ok:false, reason }`(throw하지 않는다).
- `src/services/distributionTickService.js` L33~44 `projectFailure` — **응답에 식별자·고정 사유만 싣는 화이트리스트 투영**의 선례(경로 유출 방지).
- `test/distributionService.test.js` — 하네스(in-memory DB + 실제 모델 + 가짜 writer) 스타일.

## 배경 (자기완결)

**왜 별도 서비스인가**: `distributionService.distribute`는 "kind 단위 배부"가 계약이고 tick·송고 훅이 공유한다. 재전송은 "수신처 1곳 복구"라 대상 선정 규칙(활성 대상 전체)도, 이력 어휘도 다르다. 섞으면 tick 경로의 위험이 커진다.

**재전송 인가 4중 게이트**(하나라도 빠지면 임의 기사를 임의 폴더로 내보내는 경로가 열린다):

1. Z 세션 — step4/step5에서 서비스 **바깥**에 둔다(이 서비스는 세션을 모른다).
2. `(articleId, targetId)` 쌍에 **미해소 실패 행이 실제로 존재**해야 한다. 없으면 `no-failure`. 배부 kind는 클라이언트 입력이 아니라 **그 실패 행의 `action`**에서 도출한다.
3. **대상의 현재 `kind`가 실패 행의 `action`과 같아야 한다.** 다르면 `kind-changed`로 거부한다.
4. 기사 status가 `EMBARGO_DISTRIBUTABLE_STATUSES`(DES·EPS·DPS) 안이어야 한다. KILL(EEK/RRK/DDK)·보류(EEH/RRH/DDH)·삭제 승인(DPD)·미송고(RDS)는 `status-changed`로 거부한다 — 한 번 나간 기사는 회수 수단이 없다.

추가로 대상 수신처가 존재하고 `active='Y'`여야 한다(비활성 수신처는 배부 대상에서 제외 — SCHEMA.md).

**게이트 3(kind 일치)이 왜 필수인가 — 회수 불가 사고 시나리오**: `kind`는 Z가 언제든 바꿀 수 있다(`distributionTargetService.update` → `PUT /api/distribution-targets/:id`). 어떤 수신처로 `press`(1차 엠바고 = 언론사) 배부가 실패한 뒤 그 수신처가 `nonpress`로 재분류되면, kind를 확인하지 않는 재전송은 **2차 엠바고 시각 전에 비언론사로 기사를 내보낸다**(엠바고 파기, 회수 수단 없음). 게다가 이력에는 `action='press'`가 남아 `nonpress`는 여전히 미배부로 판정되므로, T2 도래 시 tick이 같은 수신처에 **또** 배부한다(중복). 실패 이력의 kind는 "그때의 분류"이고 스풀 대상은 "지금의 분류"라 둘이 어긋날 수 있다 — 어긋나면 **아무것도 보내지 않는 것**이 유일하게 안전한 선택이다(운영자는 수신처 kind를 되돌리거나 새 사이클로 배부한다).

**게이트 4에서 "지금이 배부 시각인가"(`dueKinds`)를 다시 묻지 않는 이유**: 미해소 실패 행이 존재한다는 것은 **그 시점에 그 kind의 배부가 이미 지시됐다**는 사실 기록이다(실패 행은 실제 배부 시도에서만 생긴다) — 즉 도래 판정은 이미 통과했다. 재전송은 새 배부 결정이 아니라 **이미 내려진 결정의 복구**이므로 시점 판정을 반복하지 않는다. 알려진 한계(수용): 배부 시도 후 엠바고 시각을 **미래로 수정**한 기사는 재전송이 그 새 시각 전에 나갈 수 있다. 그 기사는 이미 다른 수신처로 나갔거나 나가려 했던 기사이므로 실질 피해가 없고, 시점 재판정을 넣으면 정상 복구가 대부분 막힌다(엠바고 기사 아닌 DPS는 `dueKinds`가 항상 빈 배열이다).

**결과 기록**:

- 성공 → `record({ articleId, eventType:'distribute-retry', action:kind, targetId, actorUserId })` + `articleModel.update(articleId, { contents: { distributedAt: now() } })`(present-only).
- 실패 → `record({ articleId, eventType:'distribute-failed', action:kind, targetId, reason, actorUserId })`(새 행 append — 그룹 최신이 다시 실패가 되어 목록에 남는다) + `onFailure` 통지.
- **게이트 거부(no-failure·kind-changed·inactive·not-found·status-changed)는 이력을 남기지 않는다** — 배부를 시도조차 하지 않았으므로 사실 기록이 아니다.

**`list` 항목의 `kindDistributed` 플래그(중복 배부 경고용)**: 각 항목에 "tick이 이 기사의 이 kind를 이미 배부됐다고 보는가"를 실어 준다. 판정은 `embargoPolicy.cycleDistributedKinds({ status, historyRows: articleHistoryModel.queryByArticle(articleId) }).includes(kind)`로 **tick의 실판정 함수를 재사용**한다(`distributionTickService.js:74`와 동일 입력 — 판정 복제 금지). `status`는 `articleModel.getById(articleId)?.contents?.status`에서 얻는다(아래 캐시에 함께 얹는다).

- ⚠️ `distributedKinds`(전체 이력)를 쓰지 마라. 이유: 이 플래그의 질문은 "다음 tick이 배부할 것인가"인데 tick은 `cycleDistributedKinds`(현 사이클)를 본다 — 전체 이력 판정을 쓰면 **보류→엠바고 재설정→재송고로 새 사이클이 열린 기사에서 이번 사이클 전량 실패가 과거 사이클 배부 행에 가려져 `true`가 되고, 경고가 막으려던 바로 그 중복(재전송+다음 tick 전 대상 배부)이 경고 없이 지나간다**(phase 51 사이클 경계와 같은 뿌리 — `embargoPolicy.js`·`articleService.js:273` "두 함수는 질문이 다르다" 주석 참조).
- `false`(= 이번 사이클에 그 kind 배부 행이 없는 상태)면 tick이 아직 그 kind를 "미배부"로 보고 있다 → 다음 tick이 **전 활성 수신처**에 배부한다. 이때 Z가 먼저 재전송을 누르면 그 수신처만 두 번 받는다. 화면(step8)이 이 플래그로 경고를 띄운다.
- 비용: 항목의 **distinct articleId 당 1회** 조회다(이력 + status를 같은 캐시 엔트리에 얹어 같은 기사의 여러 항목이 재조회하지 않게 하라). 목록은 limit으로 상한이 있으므로 수용 가능하다.

## TDD — 테스트 먼저

`test/distributionRetryService.test.js`를 새로 만든다(`test/distributionService.test.js` 하네스 복제: in-memory `DatabaseSync` + 실제 모델 + 가짜 writer + 고정 `now`).

### list

1. 미해소 실패가 없으면 `{ ok:true, items: [] }`.
2. 실패 1건 → items 1건이고 shape는 `{ articleId, targetId, kind, reason, failedAt, historyId, targetName, targetActive, targetKind, kindDistributed }` 정확히 이 키들뿐이다. **`spoolDir`·파일 경로·예외 문자열이 어떤 필드에도 없다.**
3. `targetName`·`targetActive`·`targetKind`는 `DistributionTarget` 행에서 온다. 대상 행이 없으면(삭제된 적은 없지만 방어) `targetName`·`targetKind`는 `null`, `targetActive`는 `'N'`로 폴백하고 throw하지 않는다.
4. 재전송 성공 이력이 뒤따르면 그 항목은 목록에서 사라진다(step1 판정 재사용).
5. 서로 다른 기사·수신처·kind의 실패가 각각 별도 항목으로 나온다.
6. `limit`은 모델 조회에 전달된다(스파이로 확인). 과도한 값·비정수는 서비스가 정규화한다(상한 고정, 1000 이하 권장).
7. 정렬은 최신 실패 우선(historyId DESC)이다.
7-1. `kindDistributed`가 `true`다: 같은 기사·같은 kind에 `eventType='distribute'` 행이 있는 부분 실패 시나리오(수신처 2곳 중 1곳 성공).
7-2. `kindDistributed`가 `false`다: 그 kind의 수신처가 전부 실패해 `distribute` 행이 없는 시나리오.
7-3. `kindDistributed` 판정은 `kind`별로 독립이다: `press`만 배부 행이 있으면 `nonpress` 실패 항목은 `false`다.
7-4. 같은 기사에 실패 항목이 3건이어도 `queryByArticle` 조회는 **1회**다(distinct articleId 캐시 — 스파이 카운트).
7-5. `targetKind`가 실패 행의 `kind`와 다른 항목도 **목록에는 그대로 나온다**(숨기지 않는다 — 화면이 재전송 불가 사유를 보여줄 수 있어야 한다).
7-6. **사이클 경계 정합**: 과거 사이클에 `distribute` 행이 있고(예: press 배부 후 보류→엠바고 재설정→재송고) 이번 사이클(최신 status/send 이후)에서 그 kind가 전량 실패한 기사 → `kindDistributed === false`다(전체 이력 판정이면 true가 되는 입력으로 구성 — `cycleDistributedKinds` 사용을 잠근다).

### retry

8. 정상 경로: 실패한 수신처의 `spoolDir`로 **정확히 1회** `spoolWriter.write`가 호출되고(다른 수신처 0회), 반환은 `{ ok:true, articleId, targetId, kind, at }`이며 **`file`·`spoolDir`가 반환에 없다**.
9. 정상 경로 후: `distribute-retry` 이력 1건이 생기고, `Contents.distributedAt`이 `now()`로 갱신되며, `status`·`sentAt`·본문(`markupVersion`)·잠금 컬럼은 **불변**이다.
10. 정상 경로 후 `list()`에서 그 항목이 사라진다(왕복 검증).
11. `no-failure`: 미해소 실패가 없는 `(articleId,targetId)` 쌍이면 `{ ok:false, reason:'no-failure' }`이고 **`write` 호출 0회·이력 0건**이다(임의 배부 경로 차단 — 이 케이스가 이 step의 보안 핵심이다).
12. 이미 재전송으로 해소된 쌍을 다시 요청해도 `no-failure`다.
13. `not-found`: 기사 행이 없으면(또는 `contents` 없음) `{ ok:false, reason:'not-found' }`, `write` 0회.
14. `not-found`: 대상 수신처 행이 없으면 같은 처리.
15. `inactive`: 대상이 `active='N'`이면 `{ ok:false, reason:'inactive' }`, `write` 0회.
15-1. **`kind-changed`(보안 핵심)**: `press` 실패 행이 있는 수신처의 현재 `kind`를 `nonpress`로 바꾼 뒤 재전송하면 `{ ok:false, reason:'kind-changed' }`이고 **`write` 호출 0회·이력 0건**이다(엠바고 파기 차단).
15-2. `kind-changed` 거부는 실패 항목을 소비하지 않는다: 이후 `list()`에 그 항목이 그대로 남아 있고, 수신처 kind를 원래대로 되돌린 뒤 재전송하면 정상 성공한다(복구 경로 존재).
15-3. `kind` 대소문자·공백이 다른 값(`'PRESS'`·`' press'`)도 불일치로 본다(정규화 없이 엄격 비교 — 미지 값에 관대해질 이유가 없다).
16. `status-changed`: 기사 status가 `EEK`(그리고 `RDS`·`DPD`도 각각) 이면 `{ ok:false, reason:'status-changed' }`, `write` 0회, 이력 0건.
17. `spool-disabled`: `spoolWriter` 미주입이면 `{ ok:false, reason:'spool-disabled' }`이고 DB를 건드리지 않는다. 단 `list`는 정상 동작한다(조회는 스풀과 무관).
18. 재전송이 실패하면(`write`가 `{ ok:false, reason:'spool-write-failed' }`) 반환은 `{ ok:false, reason:'spool-write-failed' }`이고, **새 `distribute-failed` 행이 append**되며 그 항목은 여전히 `list()`에 남는다. `distributedAt`은 갱신되지 않는다.
19. `write`가 throw해도 서비스는 throw하지 않고 `spool-write-failed`로 수렴한다(방어).
20. `targetId`를 문자열 `'12'`로 줘도 숫자 12 대상과 매칭된다(HTTP 경계 정규화).
21. 페이로드는 **현재 DB 행**에서 만든다: `write` 인자의 `article`·`contents`가 `articleModel.getById` 결과 그대로다(호출자가 준 값이 아니다 — ADR-004).
22. 이력 insert가 throw해도 재전송 결과는 그대로이고 `onHistoryError`가 호출된다(배부 서비스와 동형).
23. DB 비파괴: 재전송 전후로 `Article`·`Contents`·`DistributionTarget` 행 수가 같고 기존 이력 행이 보존된다(삭제 0).

## 작업

```js
// 배부 실패 복구(재전송) 서비스 — ADR-008. 앱은 스풀 파일을 다시 쓸 뿐 네트워크 전송을 하지 않는다.
// 여기에 타이머·자동 재시도·백오프를 두지 않는다: 복구 트리거는 Z의 명시적 조작뿐이다.
export function createDistributionRetryService({
  articleHistoryModel,
  distributionTargetModel,
  articleModel,
  spoolWriter,                 // 미주입(DIST_SPOOL_DIR 미설정) 시 retry는 spool-disabled, list는 정상
  now = () => new Date().toISOString(),
  onFailure,                   // 재전송 실패 표면화(distributionService.onFailure와 동형 — 식별자·사유만)
  onHistoryError,              // 이력 insert 실패 표면화(어휘 분리)
}) {
  return { list, retry };
}
// list({ limit } = {}) → { ok:true, items:[{ articleId, targetId, kind, reason, failedAt, historyId,
//                                            targetName, targetActive, targetKind, kindDistributed }] }
// retry({ articleId, targetId, actorUserId }) → { ok:true, articleId, targetId, kind, at }
//                                             | { ok:false, reason:'spool-disabled'|'no-failure'|'not-found'
//                                                              |'inactive'|'kind-changed'|'status-changed'|'spool-write-failed' }
```

규칙:

1. 상태 allowlist는 `embargoPolicy`의 `EMBARGO_DISTRIBUTABLE_STATUSES`를 **import**해서 쓴다(문자열 배열 복제 금지 — 단일 출처). `kindDistributed` 파생도 같은 모듈의 `cycleDistributedKinds`를 import해서 쓴다(`distributedKinds` 금지 — 위 ⚠️ 참조, 케이스 7-6이 잠근다).
2. 미해소 판정·kind 도출은 step1의 `findUnresolvedFailure`/`unresolvedFailures`만 쓴다(판정 규칙 재구현 금지).
3. 게이트 순서는 **부작용 없는 판정 → 쓰기**다: (a) spoolWriter 유무 → (b) 실패 행 존재 → (c) 대상 존재/활성 → **(d) 대상 현재 kind == 실패 행 kind** → (e) 기사 존재 → (f) status allowlist → (g) `write`. 어떤 거부 경로에서도 `write`가 호출되지 않아야 한다.
4. **게이트 (b)의 미해소 조회는 `articleId` 스코프 + 사실상 무제한 limit**으로 한다(`queryDistributionEvents({ articleId, limit: <충분히 큰 값> })`). 목록 표시용 최근 N건 창을 여기에 그대로 쓰면, 오래돼 창 밖으로 밀린 실패가 `no-failure`로 **오거부**된다(복구 불가). 조회 범위가 한 기사로 좁혀져 있으므로 비용도 작다.
5. `record()` 헬퍼는 `distributionService`와 동형으로 구현한다(try/catch로 삼키되 `onHistoryError`로 남긴다 — 이력 실패가 이미 나간 배부를 되돌리지 않는다).
6. 응답 투영은 **화이트리스트**다. 모델 행을 스프레드로 그대로 싣지 마라(`spoolDir`가 새는 유일한 경로다).
7. `list`의 `limit`은 정수 정규화 + 상한 클램프 후 모델에 넘긴다(표시용 창 — 위 (4)의 재전송 조회와는 별개다).
8. `kindDistributed`는 distinct `articleId` 당 `queryByArticle` 1회로 계산한다(Map 캐시).
9. kind 비교는 엄격 동등(`===`)이다 — trim·소문자 변환 같은 관용을 넣지 마라.
10. 시계는 주입된 `now`만 쓴다(`new Date()` 직접 호출 금지 — 테스트 결정성).
11. 파일 상단에 "무엇이 책임이 아닌가"(인가·HTTP·주기 실행·kind 단위 배부·시점 판정)를 명시한다.

## Acceptance Criteria

```bash
npm test          # 실패 0 — step2 종료 시점 개수 + 신규 케이스
npm run lint      # 통과
```

**diff scope**: 시작 시점 `git status --porcelain` 스냅샷 대비 증분이 `src/services/distributionRetryService.js`, `test/distributionRetryService.test.js` **2개뿐**.

## 검증 절차

1. 위 AC 커맨드를 실행한다.
2. 변이 검증 6종(확인 후 원복):
   - 미해소 실패 존재 검사를 제거하면 케이스 11이 red(임의 배부 차단이 실제로 동작).
   - **`target.kind === failure.kind` 비교를 제거하면 케이스 15-1이 red**(엠바고 파기 차단이 실제로 동작).
   - status allowlist 검사를 제거하면 케이스 16이 red.
   - `active` 검사를 제거하면 케이스 15가 red.
   - 응답 투영을 `{...target}` 스프레드로 바꾸면 케이스 2가 red(`spoolDir` 유출 감지).
   - 재전송용 미해소 조회에 표시용 작은 limit(예: 1)을 그대로 쓰면, 그보다 오래된 실패를 시드한 케이스가 red여야 한다(케이스 11의 변형으로 "창 밖 실패도 재전송된다" 케이스를 하나 추가해 두라).
3. 아키텍처 체크리스트:
   - 세션·HTTP·Express를 참조하지 않는가?
   - `setTimeout`/`setInterval`/`fetch`가 0개인가(ADR-008)?
   - 행 삭제·수정 SQL을 호출하지 않는가(`articleModel.update`의 present-only `distributedAt` 한 곳만 쓴다)?
   - 상태 전이(status 쓰기)를 하지 않는가(생애주기는 articleService 단일 출처)?
4. `phases/57-distribution-mvp4/index.json`의 step3을 `completed` + `summary`로 갱신한다. summary에 두 메서드의 시그니처·반환 shape·거부 사유 토큰 전체(`kind-changed` 포함)·게이트 순서·투영 필드 목록·`kindDistributed` 파생 방식과 조회 횟수를 명시하라.

## 금지사항

- 클라이언트가 준 `kind`/`spoolDir`/`status`/시각을 받지 마라. 이유: 배부 대상과 시점을 클라이언트가 정하면 엠바고·인가가 무력화된다(ADR-004). kind는 실패 이력에서, 경로는 DistributionTarget 행에서, 시각은 주입된 `now`에서만 온다.
- 미해소 실패 검사 없이 `(articleId, targetId)`만으로 스풀을 쓰지 마라. 이유: Z 계정이 임의 기사를 임의 수신처로 내보내는 범용 배부 API가 되고, 감사 근거(어떤 실패를 복구했는가)가 사라진다.
- 대상의 현재 `kind`와 실패 행의 `kind`가 다를 때 "실패 행 kind로 그냥 보내기"나 "대상의 현재 kind로 바꿔 보내기" 중 어느 쪽도 하지 마라 — 거부(`kind-changed`)가 유일한 처리다. 이유: 전자는 재분류된 비언론사에 2차 엠바고 전 기사를 내보내고(회수 불가), 후자는 이력의 kind와 실제 발송 kind가 어긋나 tick이 남은 kind를 중복 배부한다.
- 여러 수신처·kind 전체를 한 번에 재배부하는 옵션(`retryAll` 등)을 만들지 마라. 이유: 그것은 기존 '재송'(정정본 새 사이클)과 겹치고, 사이클 경계·tick 멱등 판정을 오염시킨다. MVP-4 재전송은 실패분 복구 전용이다.
- `eventType:'distribute'` 행을 남기지 마라. 이유: kind 단위 배부 완료 판정의 근거가 오염돼 tick이 남은 수신처로의 재배부를 건너뛴다(전 수신처 실패 후 부분 복구 시 영구 미배부).
- 기사 status를 바꾸지 마라(EPS→DPS 승격 포함). 이유: 생애주기 단일 출처는 `articleService.syncEmbargoStatus`다 — 규칙이 두 곳으로 갈라지면 상태가 발산한다.
- 실패 행을 UPDATE/DELETE로 "해소 처리"하지 마라. 이유: DB 비파괴 + append-only 원장이 이 phase의 판정 근거다.
- `setTimeout`·`setInterval`·큐·워커·`fetch`를 도입하지 마라. 이유: ADR-008이 앱 내 타이머와 네트워크 egress를 금지한다.
- 응답·이력에 `spoolDir`·`file` 경로·예외 원문을 싣지 마라. 이유: 서버 파일시스템 경로 유출이며, tick 응답 투영이 막고 있는 것과 같은 위험이다.
- `docs/news.md`·`.claude/skills/**`·`phases/49-mini-backlog-cleanup/step0.md`·`phases/50-hygiene-cleanup/**`를 수정하지 마라.
- `docs/ADR.md`를 이 step에서 수정하지 마라. 이유: ADR-008 보강은 step13이 단독 소유하는 작업이다 — 같은 파일을 두 step이 만지면 diff scope 판정이 무너진다.
- `git add -A`/`git add .` 금지, 미커밋 사용자 파일의 `restore`/`checkout`/`stash`/`clean` 금지.
