# Step 2: failure-persist

## 목표

`src/services/distributionService.js`가 **수신처 단위 스풀 쓰기 실패를 ArticleHistory에 append-only로 남기게** 한다. 지금은 `failed` 배열 반환 + `onFailure` 로그뿐이라 서버가 재시작하면 미발송 사실이 사라진다.

이 step은 서비스 파일 1개만 다룬다. 재전송·조회·라우트는 이후 step 소관이다.

## 읽어야 할 파일

- `docs/ADR.md` **ADR-008**(파일 스풀 outbound·앱 내 타이머/egress 금지), `docs/ARCHITECTURE.md`([배부] 흐름·DB 비파괴). **읽기 전용(무접촉)**.
- `src/services/distributionService.js` **전체(171줄)** — 특히
  - L30~34 주석: `onFailure`(수신처 미발송)와 `onHistoryError`(이력 insert 실패)를 **분리**하는 이유.
  - L54~67 `record(rec)` — `historyModel.insert({ ...rec, createdAt: now() })` + 실패 격리(삼키되 `onHistoryError`로 남긴다).
  - L86~94 `aborted` / `abortEntry` — 상태 가드 중단 항목(`reason: 'status-changed'`).
  - L129~150 수신처 루프의 쓰기 실패 처리(`failed.push(info)` + `notifyFailure(info)`).
  - L153~157 kind 단위 `distribute` 이력(성공 1건 이상일 때만).
  - L163~165 `distributedAt` 갱신.
- `src/services/distributionFailureLog.js`(step1 신설) — `DISTRIBUTE_FAILED_EVENT`, `isRetryableFailureReason`, `RETRYABLE_FAILURE_REASONS`.
- `src/models/articleHistoryModel.js`(step0 갱신) — `HISTORY_COLS`에 `targetId`·`reason` 포함.
- `test/distributionService.test.js` **전체** — 특히 L153~171(부분 실패), L173~190(전량 실패 "거짓 기록 금지"), L206~230(append-only), L409~433(상태 가드: 이력 `['distribute:press']` 정확 일치), L479 이후(중단 항목 onFailure).
- 회귀 확인 대상(수정 금지): `test/distributionTickService.test.js`, `test/articleSendDistribution.test.js`, `test/controllers.test.js`, `test/distribution-tick-api.test.js`.

## 배경 (자기완결)

기록 규칙(확정):

- **기록 대상**: `targetId`가 있고(수신처가 특정됨) `reason`이 재전송 가능 allowlist(step1 `RETRYABLE_FAILURE_REASONS`)인 실패 항목만.
- **비기록 대상**: `reason: 'status-changed'`(KILL·보류 전이로 인한 안전 중단)와 `targetId: null`인 kind 단위 항목. 기사 자체가 배부 불가로 전이된 것이라 재전송 대상이 아니고, 기록하면 영원히 해소되지 않는 항목이 된다. 이 항목들은 **기존대로 `notifyFailure`로만** 표면화한다(무음 삼킴 아님).
- **기록 시점**: 실패가 확인된 그 자리(수신처 루프 안)에서 즉시. 순서 불변식에 판정을 의존시키지 않는다(step1 참조).
- **기존 `distribute` 행 shape는 한 글자도 바꾸지 않는다**: kind 단위 1행, `action=kind`, `targetId` 없음, 그 kind에서 실제 스풀 기록이 1건 이상일 때만. 이 행이 tick 멱등(`embargoPolicy.distributedKinds`)과 사이클 경계(`cycleDistributedKinds`) 판정의 유일한 근거다.

## TDD — 테스트 먼저

`test/distributionService.test.js`에 케이스를 **추가**하고, 아래 2건만 의미를 유지한 채 **좁혀서 갱신**한다.

### 신규 케이스

1. 부분 실패: 실패한 수신처에 대해 `eventType='distribute-failed'` 행 1건이 남고 `action`=kind, `targetId`=그 수신처 id(**숫자**), `reason='spool-write-failed'`, `actorUserId`가 인자로 받은 값, `createdAt`=주입한 `now()`다.
2. 전량 실패: 수신처 2곳(press/nonpress) 전부 실패하면 `distribute-failed` 2건이 남고 `eventType='distribute'` 행은 **0건**이며 `distributedAt`은 `null`이다(거짓 기록 금지는 그대로).
3. 성공한 수신처에 대해서는 `distribute-failed` 행이 생기지 않는다(성공 2곳/실패 1곳 → 실패 행 1건).
4. **status-changed 미기록**: 상태 가드로 중단된 항목(`targetId`가 있는 잔여 수신처 포함)은 `distribute-failed` 행을 만들지 않는다. `onFailure`로는 여전히 통지된다(기존 케이스가 잠근 동작 — 여기서는 이력 0건만 추가 단언).
5. `invalid-spool-dir`(실제 `spoolWriter`가 거부하는 레거시 값)도 `distribute-failed`로 기록된다(allowlist 포함 사유).
6. 재실행 시 실패 행이 **누적**된다(같은 수신처가 두 번 실패하면 2행 — append-only, 갱신·삭제 없음).
7. 이력 insert 실패가 배부를 되돌리지 않는다: `historyModel.insert`가 항상 throw해도 `distribute()` 반환값·`distributedAt`은 그대로이고 `onHistoryError`가 호출된다(사유·식별자만 담김 — 본문/페이로드 금지).
8. 반환 shape 불변: `{ ok, distributed, failed }`와 `failed` 항목 필드(`articleId,targetId,kind,spoolDir,reason`)가 그대로다(tick의 화이트리스트 투영이 이 shape에 묶여 있다).
9. DB 비파괴 회귀: 배부 전후로 `Article`·`Contents`·`DistributionTarget` 행 수가 같고, 기존 이력 행이 보존된다.

### 기존 케이스 갱신(의도 유지, 단언만 좁힌다)

- L170 `assert.equal(historyOf(db).length, 1)` → **`eventType='distribute'` 행이 1건**임을 단언하도록 좁히고, `distribute-failed` 1건을 함께 단언한다.
- L189 `assert.equal(historyOf(db).length, 0)` → **`eventType='distribute'` 행이 0건**임을 단언하도록 좁힌다(테스트 제목의 "거짓 기록 금지" 의도 유지). `distribute-failed` 2건은 신규 케이스 2에서 단언해도 되고 여기서 함께 단언해도 된다.

> 그 외 기존 케이스(특히 L409~433의 `['distribute:press']` 정확 일치, L406의 nonpress 이력 0건)는 status-changed를 기록하지 않으므로 **무수정 green**이어야 한다. green이 아니면 기록 조건이 잘못된 것이다.

## 작업

`src/services/distributionService.js`만 수정한다.

1. `distributionFailureLog.js`에서 `DISTRIBUTE_FAILED_EVENT`·`isRetryableFailureReason`을 import한다(어휘 복제 금지).
2. 수신처 쓰기 실패 지점(L142~150의 `else` 분기)에서 `failed.push` + `notifyFailure` 다음에 **조건부로** 이력 1행을 남긴다.

```js
// 수신처 단위 미발송 사실을 영속한다(append-only) — MVP-4 재전송의 유일한 근거.
// targetId가 있고 재전송 가능한 사유일 때만 남긴다(status-changed 안전 중단은 로그로만).
record({ articleId, eventType: DISTRIBUTE_FAILED_EVENT, action: kind, targetId: t.id, reason, actorUserId });
```

3. `abortEntry`(상태 가드 중단) 경로에서는 이력을 남기지 않는다 — 기록 여부는 `targetId != null && isRetryableFailureReason(reason)` 한 조건으로 판정되게 짜서, 중단 항목이 실수로 새는 경로를 만들지 마라.
4. `record()`는 기존 함수를 그대로 재사용한다(이력 실패 격리·`onHistoryError` 규율 자동 승계).
5. 기존 `distribute` 이력 기록(L153~157)·`distributedAt` 갱신(L163~165)·반환 shape·TOCTOU 가드·`notifyFailure` 호출은 **변경 금지**.
6. 파일 상단 주석의 "책임은 셋뿐이다" 목록에 실패 영속이 (3) 사실 기록의 일부임을 한 줄로 반영하고, L148의 `// 미발송은 운영자가 알아야 한다 — 무음 삼킴 금지(재전송은 후속 MVP-4).` 주석을 현재 상태에 맞게 고쳐라(stale 주석 금지 — 리뷰 지적 이력 있음).

## Acceptance Criteria

```bash
npm test          # 실패 0 — step1 종료 시점 개수 + 신규 케이스
npm run lint      # 통과
```

**diff scope**: step 시작 전 `git status --porcelain` 스냅샷 대비 증분이 `src/services/distributionService.js`, `test/distributionService.test.js` **2개뿐**이어야 한다(절대 목록 비교 금지).

## 검증 절차

1. 위 AC 커맨드를 실행한다. `test/distributionTickService.test.js`·`test/articleSendDistribution.test.js`·`test/distribution-tick-api.test.js`가 **무수정 green**인지 특히 확인하라(배부 판정 오염 없음의 실증).
2. 변이 검증 3종(확인 후 원복):
   - 기록 조건에서 `isRetryableFailureReason`을 빼면 케이스 4가 red(status-changed가 영속됨).
   - 기록 조건에서 `targetId != null` 가드를 빼면 케이스 4가 red.
   - 실패 행의 `eventType`을 `'distribute'`로 바꾸면 케이스 2가 red이고, `test/distributionTickService.test.js`의 멱등 케이스도 red가 되는지 확인하라(오염이 실제로 감지된다는 증거).
3. 아키텍처 체크리스트:
   - `distribute` 행의 shape·조건(okInKind > 0)이 그대로인가?
   - 실패 이력 실패가 배부를 되돌리지 않는가(`record`의 try/catch 경유)?
   - `reason`에 예외 메시지·경로가 들어가지 않는가(항상 고정 토큰)?
   - 모델·라우트·web을 건드리지 않았는가?
4. `phases/57-distribution-mvp4/index.json`의 step2를 `completed` + `summary`로 갱신한다. summary에 기록 조건(2가지 가드)·기록 시점·비기록 대상·갱신한 기존 단언 2건을 명시하라.

## 금지사항

- `distribute` 이력 행의 shape(행 수·`action`·`targetId` 부재)나 기록 조건(`okInKind > 0`)을 바꾸지 마라. 이유: `embargoPolicy.distributedKinds`/`cycleDistributedKinds`가 이 행만 보고 배부 멱등·사이클 경계를 판정한다 — 바뀌면 중복 배부(회수 불가)나 영구 미배부가 된다.
- 실패 시 `distributedAt`을 갱신하지 마라. 이유: 나가지 않은 배부를 나간 것으로 기록하는 거짓 기록이다(기존 테스트가 잠근 계약).
- 실패 이력 실패(insert throw)를 `onFailure`로 흘리지 마라. 이유: `onFailure`는 "수신처 미발송"의 어휘다 — 이력 실패를 그리로 보내면 운영자가 배부 실패로 오독한다(파일 상단 주석의 명시 규율).
- 재시도 루프·백오프·`setTimeout`을 여기에 넣지 마라. 이유: ADR-008은 앱 내 타이머를 금지한다 — 복구는 Z의 명시적 재전송(step3~5)뿐이다.
- `spoolDir`·파일 경로·예외 원문을 `reason`이나 이력에 넣지 마라. 이유: 이력은 이후 Z 응답으로 나가고, 경로 노출은 tick 응답 투영이 막고 있는 바로 그 위험이다.
- 실패 항목을 이력에 남겼다고 `failed` 배열 반환이나 `notifyFailure` 호출을 없애지 마라. 이유: tick 요약(`distributionTickService`의 `touched` 판정)과 운영 로그가 그 둘에 묶여 있다.
- `docs/news.md`·`.claude/skills/**`·`phases/49-mini-backlog-cleanup/step0.md`·`phases/50-hygiene-cleanup/**`를 수정하지 마라.
- `docs/ADR.md`를 이 step에서 수정하지 마라. 이유: ADR-008 보강은 step13이 단독 소유하는 작업이다 — 같은 파일을 두 step이 만지면 diff scope 판정이 무너진다.
- `git add -A`/`git add .` 금지, 미커밋 사용자 파일의 `restore`/`checkout`/`stash`/`clean` 금지.
