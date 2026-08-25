# Step 7: tick-service

엠바고 시점 배부 tick을 만든다 — `DistributionTickService.run(actorUserId)`(= `src/services/distributionTickService.js` 229행 이식). ADR-008 (3): 시점 배부는 **앱 내 타이머가 아니라 외부 운영 cron이 부르는 pull**이다. 이 모듈에는 주기 실행도 egress도 없다.

이 step은 **service 계층만** 건드린다. 컨트롤러가 없어 계약은 아직 green이 될 수 없다.

## 읽어야 할 파일

- `phases/72-spring-distribution/index.json` — decisions **(2)(6)(13)(14)** · excluded **(l)(m)**
- `src/services/distributionTickService.js` — **이식 원본 전문**. 특히 `projectFailure`(화이트리스트 4필드) · `distributedOf`(사이클 범위) · TOCTOU 재검증 · `touched` 판정 · self-heal · `running` 플래그
- `docs/ADR.md` ADR-008 (3)
- `contract/cases/default/distribution-tick.contract.js` — **이 step이 만족시켜야 할 관측 전부**: 6키 shape · `distributed` 원소 3키 · 도래 기사 배부 + `status:'DPS'` + `distributedAt` 채워짐 · **멱등**(재실행 시 재배부 없음) · `assertNoSpoolPath`
- `contract/cases/minimal/distribution-disabled.contract.js` — 스풀 미설정에서 `spool-disabled`
- 이 phase의 step1·step4·step5 산출물

## 배경 (동결된 사실)

### 반환 shape

```
{ ok:true, at, scanned, distributed:[{articleId,kinds,status}],
  failed:[{articleId,targetId,kind,reason}], invalid:[{articleId,field}] }     // 정확 6키
{ ok:true, at, scanned:0, distributed:[], failed:[], invalid:[], skipped:'in-progress' }  // 재진입 시 7키
{ ok:false, reason:'spool-disabled' | 'tick-failed' }
```

- **`failed` 원소는 4키 화이트리스트**다. 실물 실패 항목(`DistributionService`)은 `spoolDir`을 갖고 있으므로 **그대로 합치면 서버 경로가 HTTP로 나간다**. 향후 필드가 추가돼도 기본값은 미노출이다.
- 사유는 **고정 토큰만**: `tick-failed` · `status-changed` · `no-active-target` · `spool-write-failed`(기본값). **예외 메시지를 쓰지 마라** — 스풀 경로가 실려 나가면 화이트리스트가 그대로 우회된다.
- `at`은 **실행당 한 번만** 읽은 시각이다(같은 실행 안에서 시각이 흔들리면 기사마다 판정이 갈린다). 주입 `Clock` → ISO-8601 UTC 문자열.

### 실행 흐름

```
run(actorUserId):
  distributionService 없음 -> {ok:false, reason:'spool-disabled'}
  running이면 -> 스킵 응답(스캔 없음)
  running = true; try { runOnce } finally { running = false }   // finally 필수

runOnce:
  at = now()                                   // ISO 문자열, 1회
  candidates = articles.query({status:[DES,EPS,DPS]})
                 .filter(c -> EmbargoPolicy.requiredKinds(c).size() > 0)
    조회 실패 -> 통지 후 {ok:false, reason:'tick-failed'}
  for contents in candidates:                  // 순차 처리(병렬 금지)
    try:
      invalid += unparsableEmbargoFields(contents).map(f -> {articleId, field})
      done = cycleDistributedKinds(contents.status, history.queryByArticle(id))
      due  = dueKinds(contents.status, contents, done, at)
      if due 비어있지 않음:
        fresh = articles.findById(id)?.contents          // TOCTOU 1회 재조회
        fresh 없음 or status가 배부 가능 밖 -> failed += {id, null, null, 'status-changed'}; continue
        effective = fresh
        fresh.status != contents.status -> done = cycleDistributedKinds(fresh.status, history)
        due = dueKinds(fresh.status, fresh, done, at)
      if due 비어있음:
        effective.status가 DES/EPS면 syncEmbargoStatus(id, [], actor)   // self-heal
        continue
      res = distribution.distribute(id, due, actor)
      res.ok != true -> failed += projectFailure(id, {reason: res.reason}); continue
      res.failed 전부 -> failed += projectFailure(id, item)
      touched = (res.distributed ∪ res.failed).map(kind)
      due 중 touched에 없는 kind -> failed += {id, null, kind, 'no-active-target'}
      okKinds = distinct(res.distributed.kind)
      okKinds 비었음 -> continue                                  // 거짓 완결 금지
      status = syncEmbargoStatus(id, okKinds, actor).status ?? effective.status
      distributed += {articleId:id, kinds:okKinds, status}
    catch e:
      통지; failed += {id, null, null, 'tick-failed'}             // 스캔은 계속된다
  return {ok:true, at, scanned: candidates.size(), distributed, failed, invalid}
```

핵심 불변식:

- **불변식(A)**: `done`을 계산할 때 쓴 status와 그 `done`을 넘기는 `dueKinds`의 status는 **항상 같아야** 한다(사이클 범위가 status에 따라 달라진다). TOCTOU 재조회로 status가 바뀌면 `done`도 다시 센다 — 안 그러면 **이미 나간 수신처로 중복 배부**된다.
- **`no-active-target`**: 도래한 kind가 성공·실패 어디에도 없는 유일한 경우다. 빠뜨리면 미배부가 요약 어디에도 안 남는다(무음 삼킴 금지).
- **self-heal**: 이력은 있는데 승격이 누락된 기사(이력 insert 실패·과거 데이터)가 영원히 대기 상태로 남지 않게 한다. 바꿀 게 없으면 `embargoStatusFor`가 null을 주므로 **쓰기 0건**이다.
- **`distributedAt`을 여기서 쓰지 마라** — `DistributionService`의 단일 책임이다.
- **status도 직접 쓰지 마라** — `ArticleEmbargoService`에 전적으로 위임한다.
- **throw 금지**(decisions (14)).
- **single-flight**: `AtomicBoolean`(또는 등가). 다중 인스턴스 중복은 앱이 막지 않는다(ADR-008 (3) 운영 규율) — **분산 락을 넣지 마라**.
- 후보 조회는 송고된 전 기사(DPS 전량)를 로드한 뒤 걸러낸다 — **의도적으로 수용한 비용**이고 규모는 `scanned`로 노출한다. 최적화를 위해 SQL에 엠바고 조건을 넣지 마라(레거시 DPS 엠바고 기사 픽업을 잃는다).

## 작업

### A. Node 실측 대조

`node -e`로 원본을 가짜 모델로 불러 표를 만든다: 후보 0건 · 도래 1건 · 도래했지만 활성 수신처 0곳 · TOCTOU로 EEK 전이 · 파싱 불가 엠바고 · 이미 배부됨(멱등) · 재진입(`running`) · 후보 조회 예외 · 기사 단위 예외. 각 케이스의 **반환 키 집합과 배열 원소 키**를 기록한다.

### B. `DistributionTickService` (`harness.news.service`)

- 생성자 주입: `ArticleRepository` · `ArticleHistoryRepository` · `DistributionService` · `ArticleEmbargoService` · `Clock` · 오류 통지 seam.
- 시그니처(구현 재량): `Result run(String actorUserId)` → 응답 맵을 만드는 것은 컨트롤러가 아니라 **이 서비스**다(투영이 서비스 책임 — 컨트롤러는 shape 매핑만).
- 반환 맵은 **`LinkedHashMap`으로 키 순서를 고정**하되, 계약은 정렬된 키 집합만 보므로 순서 자체는 자유다. 다만 `skipped`는 **재진입 경로에서만** 추가된다.
- `EmbargoPolicy`에 넘기는 `contents` 접근자는 step1이 정한 형태를 쓴다.

### C. 테스트 (먼저 쓴다 — `DistributionTickServiceTest`, 임시 DB + `@TempDir` 스풀 + `MutableClock`)

1. 후보 0건 → 6키 · `scanned=0` · 세 배열 비었음.
2. 도래 기사 1건(1차만) → 파일 1개 · `distributed=[{articleId,kinds:['press'],status:'DPS'}]` · `distributedAt` 채워짐 · **원소 정확 3키**.
3. 1+2차 기사, 1차만 도래 → `kinds:['press']` · `status:'EPS'`.
4. **멱등**: 같은 시각 재실행 → `distributed`에 그 기사 없음 · 파일 추가 0개 · `distributedAt` 불변.
5. **미도래**: 미래 엠바고 → 배부 0 · self-heal이 status를 바꾸지 않는다.
6. **파싱 불가 엠바고** → `invalid=[{articleId, field}]` 2키 · 배부 0.
7. **활성 수신처 0곳** → `failed=[{articleId,targetId:null,kind,reason:'no-active-target'}]`.
8. **TOCTOU**: 후보 스캔 후 `EEK`로 바꾸면 → 파일 0 · `failed` reason `status-changed` · 상태 불변.
9. **경로 유출 0**: 반환 전체를 JSON으로 직렬화해 `spoolDir` 슬러그·`.json`·경로 구분자가 없음을 단언(계약 `assertNoSpoolPath`의 Java 등가).
10. **재진입**: `running`이 참인 상태를 만들어(스풀 writer가 재진입 호출을 트리거하는 seam 또는 직접 상태 주입) 스킵 응답 **7키**와 `scanned=0`을 단언. 그리고 **예외 반환 경로에서도 플래그가 풀리는지**(다음 호출이 정상 실행되는지).
11. **후보 조회 예외** → `{ok:false, reason:'tick-failed'}` · 통지 1회 · **throw 없음**.
12. **기사 단위 예외** → 그 기사만 `failed`에 `tick-failed`로 남고 나머지 기사는 계속 처리된다.
13. **불변식(A)**: TOCTOU로 `DES → DPS`가 된 기사에서 `done`을 다시 세지 않으면 중복 배부가 나는 시나리오를 구성해, 다시 세는 구현에서 파일이 1개인지 단언.
14. `scanned`가 **필터 후 후보 수**(엠바고 설정된 기사)인지, 전체 조회 수가 아닌지.
15. **시계 1회 읽기**: `MutableClock`을 실행 중 전진시켜도 `at`과 모든 판정이 같은 값을 쓰는지(기사 2건 이상으로 실증).
16. **전 수신처 쓰기 실패 → 거짓 완결 금지(`if (okKinds.length === 0) continue`의 유일한 잠금)**: 활성 수신처 **2곳이 모두 쓰기에 실패**하도록 만든 뒤 tick 1회 →
    - `distributed`에 **그 기사가 없다**(승격 요약이 나가지 않는다)
    - 기사 **status 불변**(DES면 DES 그대로 — `syncEmbargoStatus`가 불리지 않는다)
    - `failed` **2건**이고 각 `reason`이 `spool-write-failed`
    - `distributedAt` **미갱신**
    이 테스트가 없으면 tick의 핵심 안전장치가 무테스트로 남는다(계약도 excluded (f)로 못 본다 — **Java가 유일 방어선**이다).

## Acceptance Criteria

```bash
cd d:/agents/harness/server-spring && JAVA_HOME="D:/agents/tools/jdk-21.0.12+8" ./mvnw -B verify
cd d:/agents/harness && JAVA_HOME="D:/agents/tools/jdk-21.0.12+8" node scripts/spring-contract.mjs --parity
cd d:/agents/harness && git status --porcelain
```

- 1번: exit 0 · failures/errors 0 · 테스트 수 증가 · `Adr008DisciplineTest` green(**타이머·스케줄러 0**) · `ClockDisciplineTest` green.
- 2번: exit 0 · 5 프로파일 diffs 0 · 관측 수 불변(아직 라우트가 없다).
- 3번 증분 = `.../service/DistributionTickService.java` · 대응 테스트 · `phases/72-spring-distribution/index.json`.

## 검증 절차

1. **red 먼저**: tick 테스트를 구현 전에 돌려 실패 실측.
2. **변이 (a) 원복**: `projectFailure`를 제거하고 실물 실패 항목을 그대로 담아 9번 red 확인 → 원복. (**경로 유출**이 이 테스트의 방어 대상이다.)
3. **변이 (b) 원복**: TOCTOU 재조회 후 `done` 재계산을 빼고 13번 red 확인 → 원복.
4. **변이 (c) 원복**: `no-active-target` 항목을 빼고 7번 red 확인 → 원복(무음 미배부).
5. **변이 (d) 원복**: `if (okKinds.isEmpty()) continue` 가드를 제거해 전 수신처 실패에도 승격·`distributed` 등재가 일어나게 만들고 **16번 red** 확인 → 원복. (거짓 완결 = 배부되지 않은 기사가 완결 처리되고 다음 tick이 재시도하지 않는다.)
6. **변이 (e) 원복**: `running` 해제를 `finally`에서 빼고 예외 경로 뒤 다음 호출이 영구 스킵되는지(10번 후반) red 확인 → 원복.
7. **변이 (f) 원복**: 후보 조회 예외를 던지게 놔둬 11번 red 확인 → 원복.
8. **변이 (g) 원복**: `at`을 기사마다 새로 읽게 바꿔 15번 red 확인 → 원복.
9. AC 실행. 리포 안 스풀 파일 0 · 임시 디렉토리 정리 확인.
10. index.json step7 상태 갱신.

## 금지사항

- `@Scheduled`·`TaskScheduler`·`Timer`·백그라운드 스레드를 쓰지 마라. 이유: ADR-008 (3) — 트리거는 외부 cron의 tick pull 하나뿐이다. phase 71-spring-collection step1 게이트가 red를 낸다.
- 분산 락·다중 인스턴스 조정을 넣지 마라. 이유: 그 책임은 운영 규율(외부 cron 단일 트리거)이 진다 — 앱에 넣으면 검증되지 않은 새 표면이 생긴다.
- 예외를 밖으로 던지지 마라. 이유: 라우트가 500으로 새면 운영 cron이 원인을 알 수 없다.
- 실패 항목을 화이트리스트 없이 그대로 싣지 마라. 이유: `spoolDir`이 HTTP 응답으로 나간다(계약이 경로 구분자 부재까지 단언한다).
- 예외 메시지·`String(e)`를 사유로 쓰지 마라. 이유: 메시지에 경로가 실려 화이트리스트가 우회된다.
- `status`·`distributedAt`을 직접 쓰지 마라. 이유: 각각 `ArticleEmbargoService`·`DistributionService`의 단일 책임이다 — 두 곳에서 쓰면 판정이 발산한다.
- 후보 조회를 SQL 엠바고 조건으로 좁히지 마라. 이유: 레거시 DPS 엠바고 기사 픽업을 잃는다(비용은 `scanned`로 노출하기로 한 의도적 수용이다).
- 병렬 처리(`parallelStream`·스레드풀)를 넣지 마라. 이유: 같은 SQLite 파일에 쓰고, 테스트가 결정적이어야 한다.
