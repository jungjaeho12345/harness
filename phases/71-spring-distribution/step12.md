# Step 12: send-distribution-hook

송고 직후 즉시 배부(ADR-008 (4))를 결선한다 — 순수 판정 `SendDistribution.kindsForSend(status, contents, alreadyDistributed)`(= `src/services/articleService.js` 86~94행)와, `ArticleLifecycleService.applyAction`이 송고 성공 뒤 그 판정으로 `DistributionService`를 부르는 **훅 한 자리**.

이 step은 phase 69가 소유한 **계약 밀집 파일**(`ArticleLifecycleService`)을 건드린다. 그래서 이 step의 1순위 AC는 **`--parity` default·minimal diffs 0**이다.

## 읽어야 할 파일

- `phases/71-spring-distribution/index.json` — decisions **(14)(15)(16)** · open_questions **(b)**
- `src/services/articleService.js` 70~94행(`distributionKindsForSend`의 표와 주석) · 205~270행(`applyAction`의 송고 훅 — **fire-and-forget이라 반환 status가 배부 전 값**이라는 사실)
- `docs/ADR.md` ADR-008 (4)(5)
- `contract/cases/default/articles-write.contract.js` — 송고 경로를 관측하는 계약(**이 step이 깨뜨리면 안 되는 것**)
- `contract/cases/minimal/transitions.contract.js` — 스풀 미설정 프로파일의 전이 결정성(훅이 결선되지 않는다는 전제 — phase 69 decisions (2))
- `contract/cases/default/distribution-tick.contract.js` — `sent.json.status === 'DES'` 단언(엠바고 기사가 송고 즉시 완결로 가면 red)
- `server-spring/src/main/java/harness/news/service/ArticleLifecycleService.java` 116~157행 — `applyAction`의 현재 흐름(전이 → end marker → `embargoAware` → present-only update → 이력 → 반환)
- 이 phase의 step7·step10·step11 산출물

## 배경 (동결된 사실)

### 판정표 (`kindsForSend`)

| 상태(최종) | 엠바고 | 결과 |
|---|---|---|
| `DPS` | 미설정 | `['press','nonpress']` — 전량 즉시 배부 |
| `DPS` | 설정 | **이미 배부된 kind에만**(정정본) = `['press','nonpress'] ∩ already` |
| `DES` | `!embargoAt && secondEmbargoAt` | `['press']` — 2차만 설정된 기사는 송고 시 바로 언론사 |
| 그 외(R의 RDS 유지 등) | — | `[]` |

- 엠바고 설정 판정은 **`EmbargoPolicy.requiredKinds`**가 단일 출처다(`!!contents.embargoAt` 식 재구현 금지). 단, `DES` 행의 조건은 **두 컬럼을 직접 본다**(Node 그대로).
- `already`는 **`EmbargoPolicy.distributedKinds`(전체 이력)**다 — "역사상 어디로 나갔나". **`cycleDistributedKinds`를 쓰지 마라**(decisions (15)).
- **여기서 시각 비교를 하지 마라.** "지금이 엠바고 시각인가"는 tick의 책임이다.

### 훅 결선 규율 (decisions (14))

- **응답 status는 훅 실행 여부와 무관하게 `finalStatus`**(전이 + 엠바고 후처리 결과)다. 훅이 승격을 일으켜도 그 값을 반환에 반영하지 마라 — Node가 fire-and-forget이라 항상 배부 전 값을 돌려주기 때문이다. **이 한 줄이 이 step 최대의 계약 위험이다.**
- 훅은 **동기 실행**한다(`@Async` 금지 — step1 게이트 + `--dual-run` 결정성).
- **배부 실패가 송고를 되돌리지 않는다**: 훅 전체를 예외 격리한다(동기 throw·비동기 rejection 등가 전부).
- 이력 조회 실패·미주입은 `already = []`로 폴백한다 → 엠바고가 설정된 DPS 재송고에서는 곧바로 `kinds=[]`(안전 기본값)가 되고, 엠바고 미설정 기사는 `already`를 참조하지 않으므로 조회 장애가 일반 배부를 막지 않는다.
- 훅 실행 순서: 전이 → present-only update → **이력 기록** → 훅. 이력이 훅보다 **먼저**여야 사이클 경계(`latestSendId`)가 이번 배부보다 앞에 놓인다(`embargoPolicy.latestSendId` 주석의 불변식).
- 배부가 성공하면(`distributed` 1건 이상) 그 kind들로 `ArticleEmbargoService.syncEmbargoStatus(articleId, doneKinds, actorUserId)`를 부른다. **`res.ok`만 보고 승격하지 마라** — `{ok:true, distributed:[], failed:[...]}`(전 수신처 실패)에도 승격이 일어나 배부되지 않은 기사가 완결 처리된다.
- **스풀 미설정 환경에서는 훅이 결선되지 않는다**(`DistributionService` 자체가 없다) — minimal 프로파일의 전이 결정성 전제가 그대로 유지된다.

## 작업

### A. Node 실측 대조 + 계약 노출면 조사

1. `node -e`로 `distributionKindsForSend`의 표 전건을 확인한다(특히 `DPS` + 엠바고 설정 + `already=[]` → `[]`).
2. **default 프로파일에서 활성 수신처가 존재하는 창에 일반 기사 송고가 있는지** 직접 확인한다: scope 표의 default 파일 목록을 알파벳 순서로 나열하고, 각 파일이 `createSentArticle`/`action:'send'`를 부르는지와 `distribution-targets`/`distribution-tick` 파일이 대상을 언제 만들고 언제 `deactivate`하는지 대조한다. **결론(창이 겹치는가/아닌가)을 요약에 적는다** — 이 step의 위험 평가 근거다.

### B. `SendDistribution` (순수)

- `public static List<String> kindsForSend(String status, <contents 접근자>, List<String> alreadyDistributed)` — 위 표 그대로. 반환 순서는 `press → nonpress` 고정.

### C. `ArticleLifecycleService`에 훅 한 자리 추가

- 생성자에 **선택 의존**(`ObjectProvider<DistributionService>` 또는 `@Nullable`)으로 배부 서비스와 `ArticleEmbargoService`·`ArticleHistoryRepository`를 받는다. **스풀 미설정이면 훅이 없다.**
- `applyAction`의 **이력 기록 뒤**에 `if (SEND.equals(action) && 배부서비스 있음)` 블록 하나를 넣는다:
  1. `already = distributedKinds(history.queryByArticle(articleId))` (실패 시 `[]`)
  2. `kinds = SendDistribution.kindsForSend(finalStatus, contents, already)` — **`contents`는 전이 전에 읽은 스냅샷**(Node `row.contents`)이다.
  3. `kinds` 비면 아무것도 하지 않는다.
  4. `res = distribution.distribute(articleId, kinds, actorUserId)`
  5. `res.ok && !res.distributed.isEmpty()`이면 `doneKinds`(distinct)로 `syncEmbargoStatus` 호출.
  6. 블록 전체를 `try/catch`로 감싼다(로그만 남기고 삼킨다).
- **반환문은 손대지 마라**: `return new ActionResult(true, finalStatus, null)` 그대로.
- 이 파일의 다른 부분(전이·end marker·`embargoAware`·update·이력)을 **한 줄도 바꾸지 마라**.

### D. 테스트 (먼저 쓴다)

- `SendDistributionTest`(순수): 표 전건 + `already`가 null·비배열·미지 값 + `DES`인데 `embargoAt`도 있는 경우(`[]`).
- `ArticleLifecycleServiceTest` 확장(임시 DB + 실제/가짜 배부 서비스):
  1. **엠바고 미설정 기사 송고** → press·nonpress 파일 2개(수신처 2곳) · `distributedAt` 갱신 · **응답 status `DPS`**.
  2. **1차 엠바고 기사 송고** → 파일 0개 · `distributedAt` NULL 유지 · **응답 status `DES`**.
  3. **2차만 설정된 기사 송고** → press 파일 1개 · `syncEmbargoStatus`로 DB status가 **EPS**가 되지만 **응답 status는 `DES`**(decisions (14)의 핵심 단언 — 이 테스트가 없으면 계약이 그 자리에서 갈린다).
  4. **DPS 재송고 + 엠바고 설정 + 배부 이력 없음** → `kinds=[]` → 파일 0개(안전 기본값).
  5. **DPS 재송고 + 엠바고 설정 + press 배부 이력 있음** → press에만 정정본(파일 1개).
  6. **전 수신처 쓰기 실패** → 승격 없음(status 불변) · 송고 자체는 **성공**(`ok=true`) · `distribute-failed` 이력 영속.
  7. **배부 서비스가 예외를 던져도** 송고는 성공하고 상태·이력이 남는다.
  8. **배부 서비스 미주입(스풀 미설정)** → 기존 동작과 완전히 동일(파일 0 · 추가 이력 0 · 응답 동일).
  9. **이력 순서**: `status/send` 행의 id가 그 배부의 `distribute` 행 id보다 **작다**(사이클 경계 불변식).
  10. R의 송고(RDS 유지) → 훅이 아무것도 하지 않는다.

## Acceptance Criteria

```bash
cd d:/agents/harness/server-spring && JAVA_HOME="D:/agents/tools/jdk-21.0.12+8" ./mvnw -B verify
cd d:/agents/harness && JAVA_HOME="D:/agents/tools/jdk-21.0.12+8" node scripts/spring-contract.mjs --parity
cd d:/agents/harness && JAVA_HOME="D:/agents/tools/jdk-21.0.12+8" node scripts/spring-contract.mjs --dual-run
cd d:/agents/harness && git status --porcelain
```

- 1번: exit 0 · failures/errors 0 · **기존 `ArticleLifecycleWireTest`·`ArticleCrudWireTest` red 0**.
- 2번(**1순위**): exit 0 · 5 프로파일 **diffs 0** · **관측 수 불변**. default 프로파일이 이제 '배부가 결선된 Node vs 배부가 결선된 Spring'을 비교한다 — 여기서 diff가 나면 훅의 의미론이 갈린 것이다.
- 3번: exit 0 · 5 프로파일 diffs 0. **자기 결정성이 이 step의 진짜 위험 축이다**(동기 실행이므로 통과해야 정상 — 실패하면 어딘가에 시간·순서 의존이 들어왔다).
- 4번 증분 = `.../service/SendDistribution.java` · `.../service/ArticleLifecycleService.java`(훅 블록 + 생성자) · 대응 테스트 · `phases/71-spring-distribution/index.json`.

## 검증 절차

1. **red 먼저**: 새 테스트를 구현 전에 돌려 실패 실측.
2. **A-2의 조사 결과**(활성 수신처 창과 송고 창이 겹치는가)를 요약에 명시한다. 겹친다는 결론이 나오면 **`--parity`를 연속 2회** 돌려 flake 여부를 판정한다.
3. **변이 (a) 원복**: 반환 status를 승격 후 값으로 바꿔 D-3 테스트 red 확인 → 원복. **그리고 `--parity`도 함께 확인**해 계약이 그 축을 보는지/못 보는지를 실측으로 남긴다(못 본다면 그 사실이 곧 'Java 테스트가 유일 방어선'의 증거다).
4. **변이 (b) 원복**: 승격 조건을 `res.ok`만으로 바꿔 D-6 red 확인 → 원복.
5. **변이 (c) 원복**: `already`를 `cycleDistributedKinds`로 바꿔 D-5 red 확인 → 원복.
6. **변이 (d) 원복**: 훅을 이력 기록 **앞으로** 옮겨 D-9 red 확인 → 원복.
7. **변이 (e) 원복**: 훅의 try/catch를 제거하고 배부 서비스가 던지게 해 D-7 red 확인 → 원복.
8. AC 실행. `--parity` 연속 2회 green(비고정 flake 0) 확인.
9. index.json step12 상태 갱신.

## 금지사항

- `applyAction`의 반환 status를 배부 후 값으로 바꾸지 마라. 이유: Node는 fire-and-forget이라 항상 배부 전 값을 돌려준다 — 바꾸는 순간 2차 엠바고 기사의 송고 응답이 갈린다.
- `@Async`·별도 스레드·`CompletableFuture`로 훅을 비동기화하지 마라. 이유: step1 게이트가 red를 내고, `--dual-run` 자기 결정성이 깨진다.
- 훅에서 예외가 새게 하지 마라. 이유: 스풀 쓰기 실패로 기사가 송고 불가 상태에 묶이면 복구 수단이 없다.
- 훅을 이력 기록보다 앞에 두지 마라. 이유: 사이클 경계(`latestSendId`)가 이번 배부보다 뒤에 놓여 `stale-cycle` 판정과 중복 억제가 무너진다.
- `already`에 `cycleDistributedKinds`를 쓰지 마라. 이유: 정정본 판정은 "역사상 어디로 나갔나"다 — 사이클로 좁히면 정정본이 나가지 않는다.
- 시각 비교(`embargoAt <= now`)를 훅에 넣지 마라. 이유: 시점 판정은 tick의 책임이며, 넣으면 두 곳의 판정이 발산한다.
- `ArticleLifecycleService`의 전이·`embargoAware`·update·이력 부분을 리팩터링하지 마라. 이유: 계약이 가장 촘촘한 파일이다 — 이 step의 diff는 **훅 블록 + 생성자**로 한정한다.
