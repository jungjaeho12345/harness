# Step 1: embargo-policy

엠바고 배부 판정을 **순수 모듈**로 이식한다 — `EmbargoPolicy`(= `src/services/embargoPolicy.js` 207행 1:1)와 시각 파싱 헬퍼 `NodeInstants`. 이 모듈은 "지금 어떤 kind를 배부해야 하는가"와 "배부 이력이 이러할 때 상태는 무엇이어야 하는가" **두 질문만** 답한다.

이 step은 **순수 모듈만** 만든다: DB·HTTP·파일시스템·**시계** 의존 0(`Clock`도 주입받지 않는다 — `now`는 항상 인자).

## 읽어야 할 파일

- `phases/72-spring-distribution/index.json` — decisions **(6)(7)(9)(10)**
- `src/services/embargoPolicy.js` — **이식 원본 전문**. 특히 각 함수의 CRITICAL 주석(안전 기본값의 **방향**이 계약이다)
- `docs/news.md` 엠바고 규칙(1차→언론사 · 2차→비언론사, 송고 시 언론사 즉시 · 1+2차 조합) — 이 모듈이 그 직역이다
- `docs/ADR.md` ADR-008 (3)(5)
- `contract/cases/default/distribution-tick.contract.js` — 이 모듈이 만족시켜야 할 관측: 엠바고가 **1시간 전**인 기사가 송고 시 DES → tick에서 `kinds:['press']` · `status:'DPS'`(1차만 설정된 기사는 같은 배부가 첫 배부이자 완결) · 재실행 시 재배부 없음
- `server-spring/src/main/java/harness/news/service/Lifecycle.java` — 순수 판정 모듈의 기존 관례(상수·표·불변 컬렉션)
- `server-spring/src/main/java/harness/news/service/ArticleLifecycleService.java` 59행·211~230행 — phase 69의 `EMBARGO_COLUMNS`·`embargoAware`·`embargoSet`. **이 step은 그 코드를 고치지 않는다**(decisions (10))
- `server-spring/src/test/java/harness/news/config/ClockDisciplineTest.java` — 이 모듈이 그 스캔에 걸리지 않아야 하는 이유

## 배경 (동결된 계약 사실 — 이 목록이 곧 테스트다)

- **`EMBARGO_DISTRIBUTABLE_STATUSES = [DES, EPS, DPS]`(불변)** — 송고 훅·tick·배부 실행의 TOCTOU 가드·재전송이 **공유하는 단일 출처**다. RDS·RRH·RRK·DDH·DDK·EEK·EEH·DPD는 전부 제외다. 한 번 나간 기사는 회수 수단이 없으므로 **이 게이트가 유일한 방어선**이다. 복제 금지.
- **`CYCLE_SCOPED_STATUSES = [DES, EPS]`(불변)** — 재송고로 새 배부 사이클이 열리는 상태. **DPS를 넣지 마라**(넣으면 tick이 이미 배부된 수신처로 중복 배부한다 — 회수 불가).
- **`KIND_FIELDS` 순서 고정**: `press ↔ embargoAt` · `nonpress ↔ secondEmbargoAt`. **모든 반환 배열은 이 순서**다(수집 순서가 아니라 상수 순서 — 단언 안정성).
- `requiredKinds(contents)` — 값이 truthy인 필드의 kind. **빈 문자열은 미설정**(JS falsy 의미론).
- `distributedKinds(rows)` — `eventType === 'distribute'` 행의 `action` 집합 ∩ KINDS. **"역사상 어디로 나갔나"**.
- `latestSendId(rows)` — `eventType==='status' && action==='send'`이고 **`id`가 정수인** 행의 최대 id. 없으면 null. 정렬에 의존하지 않고 **값으로만** 최대를 고른다. 시각(`createdAt`)을 쓰지 마라.
- `cycleDistributedKinds({status, historyRows})` — `status`가 사이클 대상이 아니면 전체 이력 판정. 경계가 null이면 **전체 이력을 센다**(넓게 — 조기 배부 금지). **`id`를 알 수 없는 `distribute` 행은 이번 사이클에 포함해서 센다**(`!Number.isInteger(id) || id > boundary`). 순진한 `id > boundary`는 그 행을 빼서 조기 배부가 된다 — **방향이 계약이다**.
- `unparsableEmbargoFields(contents)` — 값이 truthy인데 파싱 불가한 필드명(순서 고정).
- `dueKinds({status, contents, distributed, now})` — status가 배부 가능 목록 밖이면 `[]` · **`now` 파싱 불가면 `[]`**(잘못된 시계로 조기 배부하지 않는다) · 이미 배부된 kind 제외 · `at <= nowMs`인 kind만.
- `embargoStatusFor({status, contents, distributed})` — `requiredKinds`가 비면 null(관여 안 함) · `status`가 `MUTABLE_STATUSES{DES,EPS}` 밖이면 null(DPS 완결·EEK·EEH·DPD·RDS 불변) · 완결(required ⊆ done) → `DPS` · done 1건 이상 → `EPS` · 아니면 `DES` · **결과가 현재와 같으면 null**(무의미한 쓰기 금지) · **`EPS → DES` 역행이면 null**.
- **객체가 아닌 입력에도 throw하지 않는다**(`asObject`) — 판정 모듈이 호출자를 깨뜨리지 않는다.

### 시각 파싱 (decisions (7))

`NodeInstants.parseIsoMillis(String) → Long|null`이 덮는 범위:

1. `Instant.parse` 가능한 Z 표기(`2026-01-01T00:00:00Z` · 밀리초 유무 무관)
2. 오프셋 표기(`OffsetDateTime.parse` — `+09:00` 등)
3. **`YYYY-MM-DD` 날짜만** → UTC 자정(JS `Date.parse`와 동일)

그 밖(오프셋 없는 날짜-시각 `2026-01-01T09:00`, 레거시 문자열, 빈 문자열, 비문자열)은 **null**이다. 근거와 divergence는 decisions (7)에 있다 — **틀리는 방향이 안전측**(미도래 → 배부 안 함 → tick `invalid`에 표면화)이라는 사실을 테스트로 못 박는다.

## 작업

### A. Node 실측 대조

`node -e`로 원본 함수들을 직접 불러 경계 입력의 반환을 뽑아 표로 만든다(최소):

- `dueKinds`: now가 `undefined`/숫자(epoch ms)/`'not-a-date'`/정확히 같은 시각/1ms 전/1ms 후 · status가 `RDS`/`EEK`/`DPS` · distributed가 비배열·미지 값 포함.
- `cycleDistributedKinds`: 경계 null · 경계 있음 + 경계 이전/이후 distribute 행 · **id 없는 distribute 행** · status가 `DPS`.
- `embargoStatusFor`: DES→DPS(1차만) · DES→EPS(1+2차 중 press만) · EPS→DPS · **EPS→DES 시도**(null) · DPS 입력(null) · required 0(null) · 같은 값(null).
- `Date.parse` 실측: 위 시각 파싱 범위 5종 + 오프셋 없는 날짜-시각(JS는 **로컬 시간**으로 해석한다는 사실 확인).

### B. `NodeInstants` (순수)

- `public static Long parseIsoMillis(Object value)` — 비문자열·빈 문자열 → null. 위 3범위만 파싱. **예외를 던지지 않는다.**
- 시스템 기본 시간대를 **읽지 마라**(`ZoneId.systemDefault()` 금지 — 서버 TZ가 판정에 들어오면 결정성이 무너진다).

### C. `EmbargoPolicy` (순수, `harness.news.service`)

- 전부 `public static`. 상수는 불변 컬렉션(`List.of`).
- 입력은 `ContentsRow`가 아니라 **`Object column(String)` 접근이 가능한 형태**로 받는다. 두 호출자(tick은 `ContentsRow`, 재전송은 맵)가 있으므로 **`java.util.function.Function<String,Object>` 또는 좁은 인터페이스**로 받아 모듈이 model 타입에 묶이지 않게 한다(구현 재량 — 단, `EmbargoPolicy`가 `ContentsRow`를 import하면 순수성이 깨지고 단위 테스트가 model에 묶인다).
- 이력 행은 `List<Map<String,Object>>`(리포지토리 반환 그대로).

### D. 테스트 (먼저 쓴다 — `EmbargoPolicyTest`·`NodeInstantsTest`)

A의 실측 표를 그대로 옮긴다. **반드시 포함(각각이 특정 결함을 잡는다)**:

1. `dueKinds`의 `now`가 **숫자·null·파싱 불가**일 때 `[]`(조기 배부 금지). 이 테스트가 없으면 '전 기사가 조용히 미배부'가 통과한다.
2. **경계 시각 3종**: `at < now` 배부 · `at == now` **배부**(`<=`) · `at > now` 미배부.
3. `cycleDistributedKinds`의 **id 없는 distribute 행 포함** 규칙(넓게 센다).
4. 경계 null → 전체 이력.
5. `status='DPS'` → 전체 이력(사이클 무시).
6. `embargoStatusFor`의 **EPS→DES 역행 금지** · DPS 불변 · 같은 값이면 null.
7. **과거 시각·파싱 불가·동시각 3변형**(phase 69 forward_notes (4)⑨: 계약 픽스처는 **전부 미래 시각**이라 이 축을 영원히 관측하지 못한다 — Java가 유일 방어선이다).
8. `unparsableEmbargoFields`: 오타 값 · 빈 문자열(대상 아님) · 두 필드 모두 오타(순서 고정).
9. **non-객체 입력**(null·문자열·숫자)에 throw하지 않는다.
10. `NodeInstants`: Z 표기 · 오프셋 표기 · 날짜만 → UTC 자정 · **오프셋 없는 날짜-시각 → null** · 비문자열 → null.
11. **`ArticleLifecycleService`의 엠바고 판정과의 정합성**(decisions (10)) — **관측 가능한 경로로만** 잠근다. `embargoSet`은 `ArticleLifecycleService.java` 223행에서 **`private static`**이라 같은 패키지 테스트도 부를 수 없고, 가시성을 넓히는 것은 이 step의 '그 파일을 고치지 마라'와 충돌한다. 그래서 **`applyAction`의 DES 진입**으로 등가성을 단언한다: `embargoAt`·`secondEmbargoAt` 2컬럼의 **4×4 조합**(값 있음 · 빈 문자열 · SQL NULL · 공백만)마다 RDS 기사를 D 세션으로 송고한 뒤

```
(applyAction(...).status() == "DES")  ==  (EmbargoPolicy.requiredKinds(contents).size() > 0)
```

가 성립하는지 본다. **반드시 `applyAction`의 반환 status(= `finalStatus`)로 단언하고, DB에서 되읽은 status로 단언하지 마라.** 이유: step6이 송고 훅을 붙이면 `secondEmbargoAt`만 설정된 조합에서 `kindsForSend → ['press']` 배부가 성공해 `syncEmbargoStatus`가 **저장된 status를 EPS로 승격**시킨다(`src/services/embargoPolicy.js` 200~202행 실측). 그때 되읽기 단언은 red가 되고, 그 red의 **잘못된 복구는 "동치 단언을 완화"하는 것**이다 — 이 단언은 엠바고 누수 방어의 유일한 잠금이므로 완화하면 안 된다. 반환 status는 decisions (8)에 의해 **훅 실행 여부와 무관하게 불변**이라 그 함정을 구조적으로 피한다. **private 접근·가시성 확대·리플렉션·소스 리팩터링 전부 하지 않는다.** 위치는 기존 `ArticleLifecycleServiceTest` 확장이 자연스럽다 — 그 경우 증분 목록에 그 테스트 파일을 명시하라(**main 소스는 여전히 0줄 변경**).

## Acceptance Criteria

```bash
cd d:/agents/harness/server-spring && JAVA_HOME="D:/agents/tools/jdk-21.0.12+8" ./mvnw -B verify
cd d:/agents/harness && JAVA_HOME="D:/agents/tools/jdk-21.0.12+8" node scripts/spring-contract.mjs --parity
cd d:/agents/harness && git status --porcelain
```

- 1번: exit 0 · failures/errors 0 · 테스트 수 증가 · **`ClockDisciplineTest` green**(이 모듈은 시각을 읽지 않는다) · `Adr008DisciplineTest` green.
- 2번: exit 0 · 5 프로파일 diffs 0 · 관측 수 불변.
- 3번 증분 = `.../service/EmbargoPolicy.java` · `.../service/NodeInstants.java` · 대응 테스트 2개 · **`.../service/ArticleLifecycleServiceTest.java`(D-11 정합성 테스트만 추가)** · `phases/72-spring-distribution/index.json`. **`.../service/ArticleLifecycleService.java`(main)는 증분에 없어야 한다** — 이 step은 main 0줄 변경이다.

## 검증 절차

1. **red 먼저**: 단위 테스트를 구현 전에 돌려 실패 실측.
2. **변이 (a) 원복**: `dueKinds`의 `now` 파싱 실패 폴백을 `[]` → "전부 도래"로 바꿔 1번 red 확인 → 원복. (이 변이는 **엠바고 전량 누수**다.)
3. **변이 (b) 원복**: `cycleDistributedKinds`의 포함 규칙을 순진한 `id > boundary`로 바꿔 3번 red 확인 → 원복.
4. **변이 (c) 원복**: 역행 금지 줄을 지워 6번 red 확인 → 원복.
5. **변이 (d) 원복**: `<=` 비교를 `<`로 바꿔 2번의 동시각 케이스 red 확인 → 원복.
6. **변이 (e) 원복**: `NodeInstants`에 `ZoneId.systemDefault()` 폴백을 넣어 10번(오프셋 없는 날짜-시각 → null) red 확인 → 원복.
7. **변이 (f) 원복**: `ArticleLifecycleService`의 `embargoSet`을 `embargoAt`만 보도록 좁혀 11번(4×4 DES 진입) red 확인 → **반드시 Edit로 원복**. 이 변이는 main 소스를 잠시 건드리므로 원복 후 `git status --porcelain`으로 그 파일이 증분에 없음을 재확인한다.
8. AC 실행. index.json step1 상태 갱신.

## 금지사항

- 이 모듈에 `Clock`·`Instant.now()`·`System.currentTimeMillis()`를 두지 마라. 이유: `now`는 항상 인자다 — 시계를 들이면 tick의 '실행당 1회 시계 읽기' 불변식(기사마다 판정이 갈리지 않는다)이 깨지고 `ClockDisciplineTest`가 red다.
- 안전 기본값의 **방향**을 바꾸지 마라(모르면 넓게 센다 · 모르면 배부하지 않는다). 이유: 반대 방향은 전부 '회수 불가능한 조기 배부'로 끝난다.
- `EMBARGO_DISTRIBUTABLE_STATUSES`를 다른 파일에 복제하지 마라. 이유: 네 호출자가 공유하는 유일한 게이트다 — 갈리면 한쪽에서 KILL 기사가 나간다.
- `distributedKinds`와 `cycleDistributedKinds`를 통합하지 마라. 이유: "역사상 어디로 나갔나"(송고 훅)와 "이번 사이클에 이미 보냈나"(tick·승격)는 다른 질문이다(phase 69 forward_notes (13) 계열의 함정).
- `ArticleLifecycleService`의 `embargoAware`/`embargoSet`을 리팩터링하지 마라. 이유: Node도 그 자리를 인라인으로 둔다 — 합치면 계약이 잠근 DES 진입 판정과 완결 요건 판정이 한 함수에 묶인다(decisions (10)).
- `ContentsRow`를 import하지 마라. 이유: 순수 모듈이 model 타입에 묶이면 단위 테스트가 DB 픽스처를 요구하게 된다.
- DB·HTTP·파일시스템을 건드리지 마라. 이유: 이 step은 순수 모듈 전용이다.
