# Step 5: embargo-status-service

배부 사실을 기사 상태에 반영하는 서비스를 만든다 — `ArticleEmbargoService.syncEmbargoStatus(articleId, extraKinds, actorUserId)`(= `src/services/articleService.js` 277~300행 이식). 호출자는 **송고 훅(step6)**과 **tick(step7)** 둘이다.

이 step은 **service 계층만** 건드린다. 아직 아무도 이 서비스를 부르지 않으므로 계약 관측은 변하지 않는다.

## 읽어야 할 파일

- `phases/72-spring-distribution/index.json` — decisions **(6)(9)(10)(19)(25)**
- `src/services/articleService.js` 268~300행 — **이식 원본**(`syncEmbargoStatus`). 특히 주석: `transition()`을 거치지 않는 이유(role도 action도 없다 — 사람의 액션이 아니라 "이미 일어난 배부"의 반영) · `cycleDistributedKinds`와 `extraKinds`의 **합집합**을 쓰는 이유
- `src/services/embargoPolicy.js` `embargoStatusFor` — 허용 범위를 좁히는 유일한 지점(DES/EPS에서만 계산)
- `contract/cases/default/distribution-tick.contract.js` — `z-distribute-due` 케이스: 1차만 설정된 기사가 press 배부 후 **DPS**로 승격되고 되읽기에서 `distributedAt`이 채워진다
- `contract/cases/minimal/transitions.contract.js` — 이 서비스가 **절대 건드리면 안 되는** 상태 전이 계약(스풀 미설정이라 이 서비스가 불리지 않는다는 전제)
- 이 phase의 step1 산출물: `EmbargoPolicy.embargoStatusFor`·`cycleDistributedKinds`
- `server-spring/src/main/java/harness/news/service/ArticleLifecycleService.java` — 이력 기록·상태 쓰기의 기존 관례(present-only update · `ArticleHistoryRecorder`)
- `server-spring/src/main/java/harness/news/model/ArticleRepository.java` — `findById` · `update`

## 배경 (동결된 사실)

```
syncEmbargoStatus(articleId, extraKinds, actorUserId):
  row = articles.findById(articleId)
  없음 -> {ok:false, reason:'not-found'}
  fromStatus = row.contents.status
  history   = articleHistory.queryByArticle(articleId)
  distributed = distinct( EmbargoPolicy.cycleDistributedKinds(fromStatus, history) ∪ extraKinds )
  next = EmbargoPolicy.embargoStatusFor(fromStatus, contents, distributed)
  next == null -> {ok:true, status: fromStatus}        // 쓰기 0건
  articles.update(articleId, contents={status: next})  // present-only
  이력 {eventType:'status', action:'embargo', fromStatus, toStatus: next, actorUserId}
  return {ok:true, status: next}
```

- **승격 판정은 `cycleDistributedKinds`(이번 사이클)다.** 전체 이력(`distributedKinds`)으로 판정하면 보류→엠바고 재설정→재송고로 DES에 재진입한 기사가 **거짓 완결(DPS)**로 승격되고, DPS는 `MUTABLE_STATUSES` 밖이라 상태 계산이 다시는 개입하지 못한다 → 도래 시각이 와도 **영원히 배부되지 않는다**(무음 미배부 + 거짓 완결). 송고 훅의 `distributedKinds`와는 **질문이 다르다 — 바꾸지 마라**(decisions (9)).
- **`extraKinds`가 필요한 이유**: `DistributionService`의 이력 기록은 실패를 삼키므로 이력만 읽으면 승격이 누락될 수 있다. 반대로 힌트만 보면 tick의 self-heal이 무력해진다 → **합집합**.
- `action`은 **`'embargo'`** 고정이다(`send`가 아니다 — 사람의 액션이 아니다).
- **present-only**: `status` 한 컬럼만 쓴다. `sentAt`·`sender`·본문·잠금·`distributedAt`을 함께 쓰지 마라(`distributedAt`은 `DistributionService`의 단일 책임이다).
- `next == null`이면 **쓰기도 이력도 0건**이다(무의미한 쓰기 금지).
- 상태 쓰기 + 이력 insert는 **같은 트랜잭션**으로 묶는다(decisions (19)).
- 이 서비스는 **role·인가를 모른다**. 게이트는 호출자(라우트/컨트롤러)가 이미 통과시켰다.

## 작업

### A. Node 실측 대조

`node -e`로 원본을 가짜 모델로 불러 표를 만든다: DES + press 배부(1차만 설정) → DPS · DES + press(1+2차) → EPS · EPS + nonpress → DPS · EPS + 빈 extraKinds + 사이클 이력 없음 → **변화 없음**(역행 금지) · DPS 입력 → 변화 없음 · 엠바고 미설정 → 변화 없음 · 없는 기사 → `not-found`.

### B. `ArticleEmbargoService` (`harness.news.service`)

- 생성자 주입: `ArticleRepository` · `ArticleHistoryRepository`(조회) · `ArticleHistoryRecorder`(기록) · `TransactionTemplate`.
- 시그니처(구현 재량): `Result syncEmbargoStatus(String articleId, List<String> extraKinds, String actorUserId)` → `record Result(boolean ok, String status, String reason)`.
- `EmbargoPolicy`에 넘기는 `contents` 접근자는 step1이 정한 형태(`Function<String,Object>` 등)를 그대로 쓴다.
- **`ArticleLifecycleService`를 고치지 마라**(그 결선은 step6).

### C. 테스트 (먼저 쓴다 — `ArticleEmbargoServiceTest`, 임시 DB)

1. A의 실측 표 전건.
2. **역행 금지**: EPS 상태에서 배부 이력이 없어도 DES로 내려가지 않는다(쓰기 0건 · 이력 0행).
3. **거짓 완결 방지**: 과거 사이클의 `distribute` 이력 2건 + 재송고(`status/send`) 이후 DES 재진입 상태에서 `syncEmbargoStatus`를 부르면 **DPS로 가지 않는다**(사이클 판정 실증). `distributedKinds`를 쓰면 red.
4. **present-only**: 승격 시 `sentAt`·`sender`·`distributedAt`·본문·잠금 컬럼이 **바뀌지 않았다**(전 컬럼 비교).
5. 이력 행: `eventType='status'` · `action='embargo'` · `fromStatus`/`toStatus` 정확 · `actorUserId` stamp · **`snapshotTitle` 컬럼 없음**(본문 스냅샷이 아니다).
6. `next == null`이면 이력 0행·업데이트 0회(리포지토리 호출 카운트).
7. 없는 기사 → `not-found`(예외 아님).
8. `extraKinds`가 null·빈 목록·미지 값 포함·이력과 중복 → 합집합이 정확히 계산된다.
9. 상태 쓰기와 이력이 **같은 트랜잭션**임을 실증: 이력 insert가 던지도록 스텁하면 상태도 롤백되는가 — **Node는 이력 실패를 삼킨다**는 점을 먼저 실측하고, 그 동형을 택할지 트랜잭션 원자성을 택할지 **실측 근거로 결정한 뒤 그 결정을 테스트로 고정한다**(Node 동형이 기본이다: 이력 실패는 삼키고 상태는 남는다 — 이 경우 트랜잭션은 '두 문장 사이 커넥션 반납 방지' 목적으로만 쓴다).

## Acceptance Criteria

```bash
cd d:/agents/harness/server-spring && JAVA_HOME="D:/agents/tools/jdk-21.0.12+8" ./mvnw -B verify
cd d:/agents/harness && JAVA_HOME="D:/agents/tools/jdk-21.0.12+8" node scripts/spring-contract.mjs --parity
cd d:/agents/harness && git status --porcelain
```

- 1번: exit 0 · failures/errors 0 · 테스트 수 증가 · 정적 게이트 3종 green.
- 2번: exit 0 · 5 프로파일 diffs 0 · 관측 수 불변(아직 호출자가 없다).
- 3번 증분 = `.../service/ArticleEmbargoService.java` · 대응 테스트 · `phases/72-spring-distribution/index.json`.

## 검증 절차

1. **red 먼저**: 서비스 테스트를 구현 전에 돌려 실패 실측.
2. **변이 (a) 원복**: `cycleDistributedKinds` → `distributedKinds`로 바꿔 3번 red 확인 → 원복.
3. **변이 (b) 원복**: `action`을 `'send'`로 바꿔 5번 red 확인 → 원복. (이력 어휘가 갈리면 사이클 경계(`latestSendId`)가 오염된다 — **`action='embargo'` 행이 `send`로 기록되면 그 자체가 새 사이클 경계가 되어 배부 판정이 무너진다**. 이 변이의 파급을 요약에 적는다.)
4. **변이 (c) 원복**: 업데이트에 `distributedAt`을 함께 써서 4번 red 확인 → 원복.
5. **변이 (d) 원복**: `next == null`에도 이력을 남기게 해 6번 red 확인 → 원복.
6. AC 실행. index.json step5 상태 갱신.

## 금지사항

- 전이표(`Lifecycle.transition`)를 거치게 만들지 마라. 이유: role도 action도 없는 반영이다 — 표를 태우면 도달 불가 분기가 생기고 허용 범위가 두 곳으로 갈린다.
- `MUTABLE_STATUSES` 밖(DPS·EEK·EEH·DPD·RDS…)을 건드리지 마라. 이유: 완결·킬·보류·삭제 승인 기사의 부활은 회수 불가능한 사고다.
- `distributedKinds`(전체 이력)로 승격을 판정하지 마라. 이유: 재엠바고 기사가 거짓 완결되어 **영원히 배부되지 않는다**.
- `distributedAt`을 여기서 쓰지 마라. 이유: 배부 시각 갱신은 `DistributionService`의 단일 책임이다.
- 인가·세션을 끌어들이지 마라. 이유: 게이트는 호출자가 통과시켰고, 이 서비스는 tick(시스템 실행)에서도 불린다.
- `ArticleLifecycleService`를 고치지 마라. 이유: 송고 훅 결선은 step6다 — 이 step에서 손대면 실패 원인이 두 축으로 갈린다.
