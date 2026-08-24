# Step 14: retry-service

배부 실패 조회·재전송 서비스를 만든다 — `DistributionRetryService.list(limit)`와 `retry(historyId, actorUserId)`(= `src/services/distributionRetryService.js` 259행 이식). ADR-008 MVP-4: **복구 트리거는 Z의 명시적 조작뿐**이고 앱에는 자동 재시도·백오프·큐가 없다.

이 step은 **service 계층만** 건드린다. 컨트롤러가 없어 계약은 아직 green이 될 수 없다.

## 읽어야 할 파일

- `phases/71-spring-distribution/index.json` — decisions **(6)(17)(18)(19)(20)** · excluded **(f)(l)**
- `src/services/distributionRetryService.js` — **이식 원본 전문**. 특히 상수 3개(`DEFAULT_LIST_LIMIT`·`MAX_LIST_LIMIT`·`RETRY_SCAN_LIMIT`)의 **서로 다른 목적**과 `retry`의 게이트 순서 주석
- `docs/ADR.md` ADR-008 (6)
- `contract/cases/default/distribution-tick.contract.js` — `FAILURE_ITEM_KEYS`(**정렬된 10키**) · `limit` 정규화 4프로브(`undefined`·`1`·`'abc'`·`-1` 전부 **200**) · retry 4프로브(전부 **404 `no-failure`**, `extra-fields-ignored` 포함)
- `contract/cases/minimal/distribution-disabled.contract.js` — 스풀 미설정에서 retry는 **404보다 먼저** `spool-disabled`(DB 무접촉) · **failures는 200**
- 이 phase의 step6·step7·step8·step9 산출물
- `server-spring/src/main/java/harness/news/model/DistributionTargetRepository.java` — `findById(double id)`
- `server-spring/src/main/java/harness/news/model/ArticleRepository.java` — `findStatus(articleId)`(경량 status 조회) · `findById` · `update`
- `server-spring/src/main/java/harness/news/web/NodeNumber.java` — `toNumber`

## 배경 (동결된 사실)

### `list({limit})`

- `limit` 정규화: **정수 ≥1이 아니면 기본값**, 맞으면 `min(limit, 최대치)`. 상수 값은 **Node 소스에서 실측**한다(계획서 수치를 믿지 마라).
- `articleHistory.queryDistributionEvents(null, 정규화된 limit)` → `DistributionFailureLog.unresolvedFailures` → 항목마다 투영.
- **항목 10키(정렬)**: `articleId, failedAt, historyId, kind, kindDistributed, reason, targetActive, targetId, targetKind, targetName`.
  - `targetName`/`targetKind`: 대상 행이 없으면 `null` · `targetActive`: 대상 행이 없으면 **`'N'`**(재전송 불가 쪽으로).
  - `kindDistributed`: `EmbargoPolicy.cycleDistributedKinds(status, historyRows).contains(kind)` — **tick의 실판정 함수 재사용**. `distributedKinds`(전체 이력) 금지: 재송고로 새 사이클이 열린 기사에서 이번 사이클 전량 실패가 과거 사이클 배부 행에 가려져 `true`가 되고, 경고가 막으려던 중복 배부가 무경고로 지나간다.
- **호출당 캐시**: 수신처 조회는 targetId당 1회(대상 행 부재도 캐시) · 기사 조회(status + 이력)는 articleId당 1회. **호출 사이 캐시 금지**(대상의 active·kind 변경이 다음 조회에 즉시 보여야 한다).
- **투영은 화이트리스트**다 — 모델 행 스프레드 금지(`spoolDir`이 새는 유일한 경로).
- `list`는 **스풀 설정과 무관하게 동작**한다(minimal에서 200).

### `retry({historyId, actorUserId})` — 게이트 순서가 계약이다

| 순서 | 게이트 | 거부 사유 |
|---|---|---|
| (a) | `spoolWriter` 없음 | `spool-disabled` — **DB를 건드리지 않는다** |
| — | `historyId` 정규화(양의 정수) | `no-failure` — **어떤 이력 조회도 하지 않는다**(전역 스캔 봉쇄) |
| (b) | `getDistributionEventById` 없음 / `articleId`가 비문자열·빈 값 | `no-failure` |
| (b) | 미해소 집합 멤버십(그 id가 그룹의 최신 실패) | `no-failure` |
| (b') | `historyId <= latestSendId` 경계 | `stale-cycle` |
| (c) | 같은 (articleId,targetId) 재전송 진행 중 | `retry-in-flight` |
| (d) | 대상 없음 / `active != 'Y'` | `not-found` / `inactive` |
| (e) | `target.kind != failure.kind` (**엄격 비교**) | `kind-changed` |
| (f) | 기사 없음 | `not-found` |
| (g) | status가 배부 가능 목록 밖 | `status-changed` |
| (h) | 스풀 재기록 | 실패 시 writer 토큰 그대로 |

- **어떤 거부 경로에서도 `write`가 호출되지 않는다.**
- **게이트 거부는 이력을 남기지 않는다**(시도조차 하지 않았으므로 사실 기록이 아니다).
- 재전송 **실패**는 새 `distribute-failed` 행으로 append(기록 조건은 `isRetryableFailureReason` 단일 술어) + 통지 + 그 사유 반환.
- 재전송 **성공**은 새 `distribute-retry` 행 append + `distributedAt` **present-only** 갱신 + 반환 `{ok:true, articleId, targetId, kind, at}`. **`file`·`spoolDir`을 반환에 담지 마라.**
- **미해소 조회는 `articleId` 스코프 + 사실상 무제한**(`RETRY_SCAN_LIMIT`)이다. 표시용 창(`DEFAULT_LIST_LIMIT`)을 그대로 쓰면 오래돼 창 밖으로 밀린 실패가 `no-failure`로 오거부된다(복구 불가). **두 상수를 통일하지 마라.**
- in-flight 키는 **수신처 단위**(`articleId` + `targetId`)다. 해제는 **`finally`**(거부·실패·예외 어느 경로에서도) — 아니면 그 수신처 재전송이 영구 봉쇄된다.
- `stale-cycle` 경계가 **미확정(null)이면 거부하지 않는다**(기존 복구 경로 보존).

## 작업

### A. Node 실측 대조

`node -e`로 원본을 가짜 모델로 불러 표를 만든다: 세 상수의 실제 값 · `limit` 정규화 6종(`undefined`·`0`·`-1`·`1`·`1e9`·`'abc'`) · 게이트 9종 각각의 반환 · 성공 반환 키 · 실패 시 append되는 행 · 대상 행 부재 폴백(`targetActive:'N'`).

### B. `DistributionRetryService` (`harness.news.service`)

- 생성자 주입: `ArticleHistoryRepository` · `ArticleHistoryRecorder` · `DistributionTargetRepository` · `ArticleRepository` · `SpoolWriter`(선택 — 없으면 `spool-disabled`) · `Clock`. 통지 seam 2개(`onFailure`/`onHistoryError` 어휘 분리).
- 시그니처(구현 재량): `ListResult list(Object limit)` · `RetryResult retry(Object historyId, String actorUserId)`.
- in-flight: `ConcurrentHashMap.newKeySet()`(step1 게이트의 오탐 목록에 포함돼 있다).
- **숫자 판독은 `NodeNumber.toNumber` 단일 출처**(decisions (19)). `historyId`는 `typeof`가 number/string이 아니면 즉시 null, `''`도 null, 그 외 `toNumber` 후 `정수 && >= 1`.
- 이력 insert + `distributedAt` update는 `TransactionTemplate`로 묶는다(decisions (20)).

### C. 테스트 (먼저 쓴다 — `DistributionRetryServiceTest`, 임시 DB + `@TempDir` 스풀)

**list**

1. 실패 원장을 직접 시드하고 **항목 정확 10키**(정렬)와 값들을 단언.
2. 대상 행이 없는 실패 → `targetName:null` · `targetKind:null` · **`targetActive:'N'`**.
3. `kindDistributed`: 같은 사이클에 그 kind의 `distribute` 행이 있으면 true · **과거 사이클 행만 있으면 false**(재송고 이후 — `distributedKinds`를 쓰면 red).
4. `limit` 정규화 6종(A 실측 표) · 상한 클램프.
5. 스풀 미설정에서도 200 · 정상 목록.
6. 캐시: 같은 targetId가 여러 항목에 걸쳐도 `findById` 호출 1회(스파이).
7. **경로 유출 0**: 반환 JSON 전문에 `spoolDir` 슬러그·`.json`·경로 구분자 없음.

**retry — 게이트 9종을 각각 하나씩**

8. 스풀 미설정 → `spool-disabled`이고 **리포지토리 호출 0회**(스파이로 단언 — DB 무접촉이 계약이다).
9. `historyId`가 `null`·`''`·`'abc'`·`0`·`-1`·`1.5`·객체 → `no-failure`이고 **이력 조회 0회**.
10. 없는 id · `status` 이벤트 id → `no-failure`.
11. 그룹의 **최신이 아닌** 실패 id → `no-failure`(멤버십 게이트).
12. `stale-cycle`: 실패 행 뒤에 `status/send` 행을 넣고 재전송 → `stale-cycle` · **파일 0개**.
13. `retry-in-flight`: 같은 키로 동시 호출(쓰기 지연 seam) → 하나는 `retry-in-flight` · **finally 해제 확인**(그 뒤 정상 호출이 성공).
14. 대상 비활성 → `inactive` · 대상 없음 → `not-found` · 파일 0개.
15. `kind-changed`: 대상 kind를 바꾼 뒤 재전송 → `kind-changed`(대소문자·공백 관용 없음).
16. 기사 없음 → `not-found` · status가 `EEK` → `status-changed` · 파일 0개.
17. **성공**: 파일 1개 · `distribute-retry` 이력 1행 · `distributedAt` 갱신 · 반환 5키(`ok,articleId,targetId,kind,at`) · **`file`·`spoolDir` 없음** · 그 뒤 `list`에서 그 항목이 **사라진다**.
18. **실패**: writer가 `spool-write-failed` → 새 `distribute-failed` 행 append · 통지 1회 · 반환 사유 그대로 · `distributedAt` **미갱신**.
19. **게이트 거부는 이력 0행**(8~16 각각에서 `ArticleHistory` 행 수 불변 단언 — 행동 그물).
20. `RETRY_SCAN_LIMIT`이 표시용 창보다 넓다는 실증: 표시 창 밖으로 밀릴 만큼 실패 행을 쌓은 뒤 오래된 미해소 실패의 재전송이 **성공**하는지(창을 통일하면 red).
21. **동시 삽입 id 귀속**: 여러 스레드가 재전송 실패 이력을 넣어도 각자 자기 id를 받는다.

## Acceptance Criteria

```bash
cd d:/agents/harness/server-spring && JAVA_HOME="D:/agents/tools/jdk-21.0.12+8" ./mvnw -B verify
cd d:/agents/harness && JAVA_HOME="D:/agents/tools/jdk-21.0.12+8" node scripts/spring-contract.mjs --parity
cd d:/agents/harness && git status --porcelain
```

- 1번: exit 0 · failures/errors 0 · 테스트 수 증가 · 정적 게이트 3종 green(**자동 재시도 0**).
- 2번: exit 0 · 5 프로파일 diffs 0 · 관측 수 불변.
- 3번 증분 = `.../service/DistributionRetryService.java` · 대응 테스트 · `phases/71-spring-distribution/index.json`.

## 검증 절차

1. **red 먼저**: 서비스 테스트를 구현 전에 돌려 실패 실측.
2. **변이 (a) 원복**: `spool-disabled` 게이트를 이력 조회 **뒤로** 옮겨 8번(DB 무접촉) red 확인 → 원복.
3. **변이 (b) 원복**: `historyId` 정규화를 제거해 9번(이력 조회 0회) red 확인 → 원복. (**전역 스캔 봉쇄**가 방어 대상이다.)
4. **변이 (c) 원복**: 멤버십 게이트를 "배부 이벤트 행이면 통과"로 완화해 11번 red 확인 → 원복. (이 게이트가 **보안 핵심**이다 — 없으면 임의 배부 경로가 열린다.)
5. **변이 (d) 원복**: `stale-cycle` 게이트를 제거해 12번 red 확인 → 원복(미도래 스풀 유출).
6. **변이 (e) 원복**: `kind` 비교를 `equalsIgnoreCase`+trim으로 완화해 15번 red 확인 → 원복.
7. **변이 (f) 원복**: `RETRY_SCAN_LIMIT`을 표시용 창 값으로 통일해 20번 red 확인 → 원복.
8. **변이 (g) 원복**: in-flight 해제를 `finally` 밖으로 빼서 13번 후반 red 확인 → 원복.
9. **변이 (h) 원복**: `kindDistributed`를 `distributedKinds`로 바꿔 3번 red 확인 → 원복.
10. AC 실행. index.json step14 상태 갱신.

## 금지사항

- 자동 재시도·백오프·재시도 큐·워커를 넣지 마라. 이유: ADR-008 (6) — 복구 트리거는 Z의 명시적 조작뿐이다.
- 재전송 입력에 `articleId`·`targetId`·`kind`를 받지 마라. 이유: 전부 실패 행에서만 도출한다(ADR-004) — 받는 순간 임의 수신처로 임의 기사를 내보내는 경로가 열린다.
- 미해소 판정을 여기서 재구현하지 마라. 이유: `DistributionFailureLog` 단일 출처다 — 갈리면 목록에 없는 실패로 재전송이 통과한다.
- 표시용 창과 게이트용 스캔 상한을 통일하지 마라. 이유: 오래된 실패가 `no-failure`로 오거부되어 **복구 불가**가 된다.
- `file`·`spoolDir`을 반환·통지·로그에 담지 마라. 이유: 서버 파일시스템 경로는 HTTP로 나가면 안 된다.
- 게이트 거부에 이력을 남기지 마라. 이유: 시도하지 않은 일을 사실로 기록하면 원장이 오염되고 미해소 판정이 뒤집힌다.
- `spool-write-failed`·`invalid-spool-dir`·`invalid-article-id`를 `ReasonStatus`에 넣지 마라. 이유: 라우트 재매핑(step15)이 그 셋만 500으로 올린다 — 전역화하면 phase 70의 `distribution-targets` 400 계약이 깨진다.
- 컨트롤러·라우트·scope 표를 건드리지 마라. 이유: 이 step은 service 계층 전용이다.
