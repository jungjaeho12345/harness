# Step 10: distribution-service

배부 실행 서비스를 만든다 — `DistributionService.distribute(articleId, kinds, actorUserId)`(= `src/services/distributionService.js` 244행 이식). 책임은 셋뿐이다: (1) 주어진 kind의 **활성** 수신처 선정 (2) 수신처별 스풀 쓰기 (3) **사실 기록**(`distributedAt` 갱신 · `distribute` 이력 · 수신처 단위 실패의 append-only 영속).

이 step은 **service 계층만** 건드린다. 계약은 아직 green이 될 수 없다.

## 읽어야 할 파일

- `phases/71-spring-distribution/index.json` — decisions **(8)(17)(20)(26)** · excluded **(l)(m)**
- `src/services/distributionService.js` — **이식 원본 전문**. 특히 `recordTargetFailure`·`isDuplicateSameCycleFailure`의 CRITICAL 주석(경계 이전 행과의 일치는 중복이 **아니다** — 그 행만 남기면 재전송이 `stale-cycle`로 영구 409가 되고 tick도 재시도하지 않아 **복구 경로가 0**이 된다)
- `docs/ADR.md` ADR-008 (1)(5)(6)
- `docs/SCHEMA.md`의 `Contents.distributedAt` 절(배부가 실행될 때마다 최신 시각)
- 이 phase의 step7·step8·step9 산출물(`EmbargoPolicy`·`DistributionFailureLog`·`SpoolWriter`)
- `server-spring/src/main/java/harness/news/model/DistributionTargetRepository.java` — `query(filters)`(phase 70). `{kind, active:'Y'}` 필터가 되는지 확인
- `server-spring/src/main/java/harness/news/model/ArticleRepository.java` — `findById` · `update(articleId, article, contents)`
- `server-spring/src/main/java/harness/news/service/ArticleHistoryRecorder.java` — 이력 1행 기록(시각 stamp · 실패 격리 · 통지 seam). **`markupVersion`이 없으면 `snapshotTitle`을 싣지 않는다**는 사실을 확인
- `server-spring/src/main/java/harness/news/service/HistoryErrorLogger.java` — 이력 실패 통지의 기존 구현

## 배경 (동결된 사실 — 실행 순서가 계약이다)

```
distribute(articleId, kinds, actorUserId):
  spoolWriter 없음               -> {ok:false, reason:'spool-disabled'}
  wanted = KINDS ∩ kinds         (허용 밖·비배열은 조용히 버린다)
  wanted 비었음                  -> {ok:true, distributed:[], failed:[]}
  row = articles.findById(id)
  row 없음/contents 없음         -> {ok:false, reason:'not-found'}
  for kind in wanted:            (press -> nonpress 순서 고정)
    aborted면 -> failed += {targetId:null, kind, reason:'status-changed'}; continue
    targets = distributionTargets.query({kind, active:'Y'})
    for i, t in targets:
      TOCTOU 가드: articles.findById(id)를 다시 읽어 status가 배부 가능 목록 밖이면
        aborted = true
        i == 0 -> failed += {targetId:null, kind, 'status-changed'}
        i  > 0 -> 남은 수신처 전부 failed += {targetId:rest.id, kind, spoolDir, 'status-changed'}
        break
      res = spoolWriter.write(t.spoolDir, articleId, row.article, row.contents)   (예외도 spool-write-failed)
      ok  -> distributed += {targetId, kind, spoolDir, file}
      실패 -> reportFailure({articleId, targetId, kind, spoolDir, reason})
    okInKind > 0 -> 이력 {eventType:'distribute', action:kind, actorUserId}
  distributed 1건 이상 -> articles.update(id, contents={distributedAt: now()})
  return {ok:true, distributed, failed}
```

핵심 불변식:

- **TOCTOU 가드는 매 쓰기 직전** 최신 status를 다시 읽는다(N+1 읽기는 **의도적으로 수용한 비용**이다 — 회수 불가능한 KILL 기사 유출을 막는 가치가 압도한다). **페이로드는 최초 스냅샷(`row`)을 계속 쓴다**(한 배부 배치는 같은 본문을 내보내야 정정 추적이 가능하다) — 재조회는 **status 판정 전용**이다.
- 가드에 걸리면 **남은 수신처·남은 kind 전부 중단**한다. 그래도 `failed`에 남긴다 — tick이 `distributed ∪ failed`에 등장한 kind만 "처리됨"으로 보므로, 빠뜨리면 활성 수신처가 있는데도 `no-active-target`으로 오보한다.
- **이력은 실제로 스풀에 기록된 게 있을 때만** 남긴다(`okInKind > 0`) — 거짓 기록 금지. 그 행이 tick의 "이미 배부됨" 멱등 판정 근거다.
- **실패 영속 조건은 단 하나**: `targetId != null` **AND** `DistributionFailureLog.isRetryableFailureReason(reason)`. `status-changed`와 `targetId:null` 항목은 기록하지 않는다(재전송 대상이 아니며, 영속하면 영원히 해소되지 않는 항목이 된다).
- **같은 사이클 중복 억제**: 그 그룹의 미해소 최신 실패가 **이번 사이클(마지막 send 경계 이후)의 같은 reason**이면 insert 생략. 경계 이전 행과의 일치는 **중복이 아니다**(위 CRITICAL). 경계 미확정(null)이면 억제해도 된다(사이클 구분이 없어 `stale-cycle` 거부도 없다). 판정은 `DistributionFailureLog.unresolvedFailures` + `EmbargoPolicy.latestSendId`만 재사용한다 — **새 판정 규칙 금지**.
- 중복 억제 컨텍스트는 **이 호출 안에서 기사 단위 1회 lazy 조회**다(수신처마다 전체 스캔 금지 · 실패가 하나도 없으면 조회 자체가 없다 · **호출 사이 캐시 금지**). 조회 실패·모델 미가용이면 **빈 컨텍스트**(모르면 기록하는 쪽 = 과다 기록 > 무음 유실).
- `failed` 반환과 `onFailure` 통지는 **기록 생략과 무관하게 매번** 일어난다(무음 삼킴 금지).
- **이력 기록 실패는 삼키되 반드시 통지**한다. 통지 어휘를 둘로 나눈다: 수신처 미발송(`onFailure`)과 이력 쓰기 실패(`onHistoryError`) — 섞으면 운영자가 배부 실패로 오독한다.
- `distributedAt` 갱신은 **present-only 한 컬럼**이다(status·sentAt·본문·잠금을 함께 쓰지 마라).

## 작업

### A. Node 실측 대조

`node -e`로 원본 `createDistributionService`를 가짜 모델·가짜 writer로 불러 다음을 표로 만든다: 활성 수신처 0곳 · 2곳 중 1곳 실패 · 첫 수신처 전에 상태 전이 · 두 번째 수신처 전에 상태 전이 · 같은 reason 재실패(억제) · 경계 이후/이전 실패 · `kinds`가 비배열·미지 값.

### B. `DistributionService` (`harness.news.service`)

- 생성자 주입: `DistributionTargetRepository` · `ArticleRepository` · `ArticleHistoryRepository`(또는 `ArticleHistoryRecorder`) · `SpoolWriter` · `Clock` · 실패 통지 seam 2개.
- 시그니처(구현 재량): `Result distribute(String articleId, List<String> kinds, String actorUserId)` → `record Result(boolean ok, String reason, List<Distributed> distributed, List<Failed> failed)`.
- **`Failed`는 내부 타입이고 `spoolDir`을 담는다** — 그 값이 HTTP로 나가지 않게 하는 것은 tick의 투영 책임(step13)이다. 이 사실을 javadoc에 명시한다.
- 통지 seam은 phase 68~70 관례(`HistoryErrorListener`/`HistoryErrorLogger`)를 따른다. 통지 payload는 **식별자와 고정 사유만**(경로·본문 금지).
- **트랜잭션 경계(decisions (20))**: 이력 insert + `distributedAt` update처럼 여러 문장이 묶여야 하는 자리만 `TransactionTemplate`으로 감싼다. **한 배부 호출 전체를 하나의 트랜잭션으로 묶지 마라** — 수신처 A 성공 후 B 실패에서 A의 이력까지 롤백되면 '나간 파일은 있는데 기록은 없는' 상태가 되어 다음 tick이 중복 배부한다(회수 불가).
- **비동기·병렬 금지**: 수신처는 순차 처리한다(`Promise.all` 등가 금지). 같은 SQLite 파일에 쓰므로 순서가 예측 가능해야 하고 테스트도 결정적이어야 한다.

### C. 테스트 (먼저 쓴다 — `DistributionServiceTest`, 임시 DB + 가짜/실제 writer)

1. 활성 수신처 2곳 → 파일 2개 · `distributed` 2건 · `distribute` 이력 **1행**(kind당 1행) · `distributedAt` 갱신.
2. 활성 0곳 → 파일 0 · 이력 0 · `distributedAt` **미갱신** · `distributed`·`failed` 모두 비었음.
3. **비활성('N') 수신처는 배부하지 않는다**(그 수신처의 스풀 폴더에 파일 0).
4. 2곳 중 1곳 쓰기 실패 → 성공 1건 · `failed` 1건 · **이력 `distribute` 1행은 남는다**(okInKind > 0) · `distribute-failed` 1행 영속.
5. 전부 실패 → `distributed` 비었음 · **`distribute` 이력 0행** · `distributedAt` **미갱신**.
6. **TOCTOU**: 첫 수신처 쓰기 직전에 status를 `EEK`로 바꾸면 → 파일 0 · `failed`에 `{targetId:null, kind, status-changed}` · **다음 kind도 시작하지 않는다**(중단 전파).
7. TOCTOU가 i>0에서 걸리면 남은 수신처들이 `targetId` 있는 `status-changed` 항목으로 남는다.
8. **실패 영속 조건**: `status-changed`는 이력에 **남지 않는다** · `targetId:null` 항목도 남지 않는다 · 재전송 가능 3사유만 남는다.
9. **같은 사이클 중복 억제**: 같은 (기사,수신처,kind,reason)으로 두 번 실패 → `distribute-failed` **1행**. reason이 다르면 2행. `distribute-retry`로 해소된 뒤 재실패면 새 행.
10. **경계 이전 실패는 억제하지 않는다**: 실패 행 뒤에 `status/send` 이력을 넣어 새 사이클을 연 다음 같은 실패 → **새 행이 생긴다**(위 CRITICAL의 실증 — 이 테스트가 없으면 복구 경로 0 결함이 통과한다).
11. **페이로드는 최초 스냅샷**: 첫 수신처 쓰기 후 제목을 바꿔도 두 번째 수신처 파일의 제목이 같다.
12. `kinds`가 `null`·`[]`·`['press','bogus']`·`'press'`(비배열) → 각각의 동작이 Node와 같다.
13. 이력 insert 실패(리포지토리 스텁이 던짐) → **배부는 성공**하고 통지가 1회 오며 예외가 밖으로 나가지 않는다.
14. 반환 `Failed` 항목이 **`onFailure` 통지에도 경로를 담지 않는다**.
15. **동시 삽입 id 귀속**(phase 70 review_gate med-4 계열): 여러 스레드가 동시에 실패 이력을 넣어도 각자 자기 id를 받는지(이력 id가 재전송의 식별자이므로 뒤바뀌면 남의 실패를 재전송한다).

## Acceptance Criteria

```bash
cd d:/agents/harness/server-spring && JAVA_HOME="D:/agents/tools/jdk-21.0.12+8" ./mvnw -B verify
cd d:/agents/harness && JAVA_HOME="D:/agents/tools/jdk-21.0.12+8" node scripts/spring-contract.mjs --parity
cd d:/agents/harness && git status --porcelain
```

- 1번: exit 0 · failures/errors 0 · 테스트 수 증가 · `Adr008DisciplineTest`·`ClockDisciplineTest`·`NoSchemaSqlInMainSourcesTest` green.
- 2번: exit 0 · 5 프로파일 diffs 0 · 관측 수 불변(아직 아무도 이 서비스를 부르지 않는다).
- 3번 증분 = `.../service/DistributionService.java` · 대응 테스트 · `phases/71-spring-distribution/index.json`.

## 검증 절차

1. **red 먼저**: 서비스 테스트를 구현 전에 돌려 실패 실측.
2. **변이 (a) 원복**: TOCTOU 재조회를 제거해 6번 red 확인 → 원복. (**KILL 기사 유출**이 이 테스트의 방어 대상이다.)
3. **변이 (b) 원복**: 이력 기록 조건을 `okInKind > 0` → 무조건으로 바꿔 5번 red 확인 → 원복. (거짓 기록 = 다음 tick이 재시도하지 않음 = **무음 미배부**.)
4. **변이 (c) 원복**: 중복 억제 판정에서 사이클 경계를 무시하도록(`match만 있으면 억제`) 바꿔 10번 red 확인 → 원복.
5. **변이 (d) 원복**: `status-changed`를 영속 대상에 넣어 8번 red 확인 → 원복.
6. **변이 (e) 원복**: 한 배부 호출 전체를 하나의 트랜잭션으로 묶어 4번(1곳 실패해도 성공분 이력은 남는다) red 확인 → 원복.
7. **변이 (f) 원복**: 비활성 수신처도 대상에 넣어 3번 red 확인 → 원복.
8. AC 실행. 리포 안에 스풀 파일 0(모든 테스트가 `@TempDir`).
9. index.json step10 상태 갱신.

## 금지사항

- 상태 전이(`status` 쓰기)를 여기서 하지 마라. 이유: 생애주기는 `ArticleEmbargoService`/`ArticleLifecycleService` 단일 출처다(step11) — 갈리면 DES/EPS/DPS 판정이 발산한다. 이 서비스는 status를 **읽기만** 한다.
- `EMBARGO_DISTRIBUTABLE_STATUSES`를 복제하지 마라. 이유: `EmbargoPolicy`가 단일 출처다.
- 병렬 배부·비동기 실행·재시도를 넣지 마라. 이유: ADR-008 (6) + 결정성 + step1 게이트.
- 한 배부 호출 전체를 트랜잭션으로 묶지 마라. 이유: 부분 성공의 사실 기록이 롤백되면 다음 tick이 중복 배부한다(회수 불가).
- 실패 항목의 `spoolDir`·`file`을 통지·로그·반환의 **상위 경로**로 흘리지 마라. 이유: tick 응답에 경로가 새면 계약이 red다.
- 중복 억제 컨텍스트를 호출 사이에 캐시하지 마라. 이유: 원장은 호출마다 자란다 — 낡은 컨텍스트는 신선한 실패를 무음으로 삼킨다.
- 컨트롤러·라우트·scope 표를 건드리지 마라. 이유: 이 step은 service 계층 전용이다.
