# Step 1: adr008-discipline

ADR-008의 아키텍처 규율을 **기계가 지키게** 만든다 — 신설 정적 게이트 `Adr008DisciplineTest`가 `server-spring/src/main/java` 전체를 스캔해 **주기 실행·비동기/재시도·네트워크 클라이언트·파일 쓰기**를 red로 만들고, 정당한 예외를 **파일 단위 명시 목록**으로 둔다.

이 step은 **테스트만 추가한다**(main 소스 0줄 변경). 게이트를 **위반 코드를 쓰기 전에** 세우는 것이 목적이다: 이후 step들이 `@Scheduled`·`@Retryable`·`RestTemplate`으로 손이 가는 순간 그 자리에서 red가 난다.

## 읽어야 할 파일

- `phases/71-spring-collection/index.json` — decisions **(2)** · excluded **(a)**
- `docs/ADR.md` **ADR-008**(45~47행) — 결정 (1) 파일 스풀 outbound·egress 없음 · (3) tick pull(앱 내 타이머 없음) · (6) 자동 재시도·백오프·재시도 큐 없음
- `docs/ADR.md` ADR-007 — "앱에 타이머/외부 egress 없음" 원칙의 원출처
- `server-spring/src/test/java/harness/news/config/ClockDisciplineTest.java` — **이 게이트의 형태 원본**: 금지 패턴 목록 · 파일 단위 예외 목록(`CLOCK_FACTORY_FILES`) · 주석 제거 후 판정 · 공허성 자기 검사 3종
- `server-spring/src/test/java/harness/news/db/NoSchemaSqlInMainSourcesTest.java` — 상수 펼침 스캔(`inlineTableConstants`)과 그 **한계**(키워드를 쪼갠 형태·`String.format`은 통과) · 자기 검사로 경계를 잠그는 방식
- `src/services/distributionTickService.js` 1~13행 · `src/services/spoolWriter.js` 1~11행 · `src/services/distributionRetryService.js` 1~15행 — Node가 같은 규율을 주석으로 선언한 자리(문구 참조용, 이식 대상 아님)

## 배경 (동결된 사실)

- phase 70 testing_gate 변이 ⑧의 교훈: **규칙이 문서·주석에만 있고 기계가 지키지 않으면, 그 규칙을 어긴 코드는 결과가 같은 한 어떤 테스트도 red를 내지 않는다.** 그때 유일하게 red를 낸 것이 `ClockDisciplineTest`였다.
- 이 phase와 후속 배부 phase는 그 유혹이 가장 큰 자리다: 시점 배부에 `@Scheduled`, 배부 실패에 `@Retryable`/백오프, 송고 훅에 `@Async`, 수집 pull에 `RestTemplate`을 쓰고 싶어진다. **전부 ADR-008과 정면 충돌**한다.
- 정당한 예외는 **정확히 2개**이고, **이 step이 그 목록을 확정한다**(파일을 만드는 주체는 서로 다르다):
  - **네트워크 클라이언트** — `HttpApiSourceFetcher.java`. **이 phase step4가 만든다.** ADR-008의 egress 금지는 **배부** 축이고, 수집 pull은 `rcv.md`가 정의한 능동 수집이라 아웃바운드 호출이 기능 그 자체다.
  - **파일 쓰기** — `SpoolWriter.java`. **`phases/72-spring-distribution` step3이 만든다** — 이 phase에서는 **존재하지 않는 이름을 예외 목록에 미리 등재**한다(스캔은 파일이 없으면 아무것도 하지 않으므로 무해하다).
  - **주기 실행·비동기·재시도는 예외 0**이다.
- 스캔 대상 파일이 아직 없어도 예외 목록에 이름을 미리 두는 것은 정상이다(`ClockDisciplineTest`가 예외를 파일 단위로 두는 이유와 같다 — 예외가 늘면 diff에 보인다).
- **이 게이트는 `phases/72-spring-distribution`이 상속한다**: 그 phase는 목록을 넓히지 않고 `SpoolWriter.java`로 빈 자리를 채울 뿐이다. 목록을 넓히려는 시도는 그 자체가 아키텍처 결정이며 별도 근거가 필요하다 — `theExceptionListIsExactlyTwoFiles`가 그 사실을 diff와 red로 드러낸다.

## 작업

### A. 테스트 먼저 — 공허성 자기 검사부터 쓴다

구현(스캐너)보다 **자기 검사 3종**을 먼저 써서 스캐너가 무엇을 잡고 무엇을 허용해야 하는지 고정한다.

### B. `Adr008DisciplineTest` 신설 (`server-spring/src/test/java/harness/news/config/`)

금지 패턴 4군(정규식, 주석 제거 후 판정):

1. **주기 실행 (예외 0)** — `@Scheduled` · `@EnableScheduling` · `TaskScheduler` · `ScheduledExecutorService` · `Executors.newScheduled…` · `new Timer(` · `Thread.sleep(` · `ScheduledFuture`
2. **비동기·재시도 (예외 0)** — `@Async` · `@EnableAsync` · `@Retryable` · `@EnableRetry` · `RetryTemplate` · `CompletableFuture.supplyAsync` · `CompletableFuture.runAsync` · `ExecutorService`(생성) · `@Recover`
3. **네트워크 클라이언트 (예외: `HttpApiSourceFetcher.java`)** — `HttpClient` · `RestTemplate` · `WebClient` · `RestClient` · `new Socket(` · `openConnection(` · `URLConnection` · `HttpURLConnection`
4. **파일 쓰기 (예외: `SpoolWriter.java`)** — `Files.write` · `Files.newOutputStream` · `Files.newBufferedWriter` · `FileOutputStream` · `FileWriter` · `Files.createDirectories` · `Files.createDirectory` · `Files.move` · `Files.copy` · `Files.delete`

시그니처 수준(구현 재량):

- `void mainSourcesRunNoTimersOrRetries()` — 1·2군 위반 목록이 비어 있어야 한다. 위반 메시지에 파일 경로와 패턴을 담는다.
- `void onlyTheCollectionPullAdapterTalksToTheNetwork()` — 3군은 예외 파일에서만 허용.
- `void onlyTheSpoolWriterWritesFiles()` — 4군은 예외 파일에서만 허용.
- `void theExceptionListIsExactlyTwoFiles()` — 예외 목록의 **크기와 구성**을 단언한다(예외가 늘어나면 그 사실이 반드시 diff와 red로 드러난다 — phase 70 review_gate low의 `theDerivedMainJavaListDropsExactlyTheDeleteFromPattern`과 같은 계열).
- 공허성 자기 검사 3종: ① 심어 둔 위반 문자열(각 군 1개씩)을 스캐너가 잡는가 ② 정상 코드(예: `ConcurrentHashMap`·`AtomicBoolean`·`Files.readString`·`Files.exists`)를 **막지 않는가** ③ 주석 속 규칙 설명이 위반으로 잡히지 않는가(주석 제거가 실제로 동작하는가).

### C. 오탐 경계를 명시적으로 확인한다

이 phase가 실제로 쓸 정상 API가 스캔에 걸리지 않아야 한다 — 아래를 자기 검사 ②에 **전부** 넣는다:

- `AtomicBoolean`(tick single-flight) · `ConcurrentHashMap.newKeySet()`(retry in-flight) · `Collections.synchronizedSet`
- `Files.readString` · `Files.exists` · `Files.isDirectory` · `Path.of` · `@TempDir`(테스트 전용이라 스캔 대상 아님)
- `Instant.parse` · `OffsetDateTime.parse`(phase 72-spring-distribution step1) · `Clock` 주입 호출
- `TransactionTemplate`(다중 문장 쓰기 규율 — 이 phase는 쓰지 않지만 배부 phase가 쓴다)

### D. 게이트의 한계를 문서로 남긴다(테스트 javadoc)

- **덮는 벡터**: 리터럴로 쓴 애노테이션·타입·메서드 호출.
- **덮지 못하는 벡터**: 문자열을 끊어 쓰거나 리플렉션·`String.format`으로 만든 호출, 라이브러리가 내부에서 도는 타이머, 그리고 "규칙은 지켰는데 의미가 틀린" 코드. **실질 그물은 각 step의 행동 단언**(스풀 파일 개수·이력 행 수·응답 키 집합·`--dual-run` diff 0)이다 — 스캔을 넓혀 오탐을 늘리지 마라(phase 70 remaining_gaps ⑤).

## Acceptance Criteria

```bash
cd d:/agents/harness/server-spring && JAVA_HOME="D:/agents/tools/jdk-21.0.12+8" ./mvnw -B verify
cd d:/agents/harness && JAVA_HOME="D:/agents/tools/jdk-21.0.12+8" node scripts/spring-contract.mjs --parity
cd d:/agents/harness && git status --porcelain
```

- 1번: exit 0 · failures/errors 0 · 테스트 수 **670 → 670+N**(N = 신설 테스트 수, 실측치를 요약에 적는다) · 기존 테스트 red 0.
- 2번: exit 0 · **4 프로파일** diffs 0(+ `failclosed`는 `bootOnly` skip — step0 작업 C) · 관측 수 **215 불변**(HTTP 변경 없음).
- 3번 증분 = `server-spring/src/test/java/harness/news/config/Adr008DisciplineTest.java` · `phases/71-spring-collection/index.json` **뿐**(main 소스 0).

## 검증 절차

1. **red 먼저**: 자기 검사 3종을 스캐너 없이 돌려 컴파일/실패를 확인한 뒤 스캐너를 채운다.
2. **변이 4종 실증(Edit로 주입 → 확인 → Edit로 원복, `restore`/`checkout`/`stash` 금지)**:
   - (a) 아무 main 클래스에 `@Scheduled(fixedDelay = 60000)` 메서드 추가 → 1군 red.
   - (b) `@Async` 메서드 추가 → 2군 red.
   - (c) `HealthController`에 `java.net.http.HttpClient` 필드 추가 → 3군 red(예외 파일이 아니므로).
   - (d) 아무 서비스에 `Files.write(...)` 한 줄 추가 → 4군 red.
   - 넷 다 원복 후 green 재확인.
3. **오탐 변이 실증(원복)**: `AtomicBoolean`·`Files.readString`·`ConcurrentHashMap`을 main 소스에 실제로 넣어 보고 **green 유지**를 확인 → 원복. (여기서 red가 나면 스캔이 너무 넓어 이후 step들을 막는다.)
4. **예외 목록 변이(원복)**: 예외 목록에 파일 하나를 더 넣어 `theExceptionListIsExactlyTwoFiles`가 red인지 확인 → 원복.
5. AC 실행. `--parity` 관측 수 불변 확인.
6. `phases/71-spring-collection/index.json`의 step1 상태를 갱신한다.

## 금지사항

- `ClockDisciplineTest`·`NoSchemaSqlInMainSourcesTest`를 약화·삭제·병합하지 마라. 이유: 이 phase는 시각(엠바고·stamp)과 원장(append-only)을 동시에 건드린다 — 두 게이트가 다른 축을 잠근다.
- 예외 목록에 파일을 '미리 넉넉히' 넣지 마라. 이유: 예외는 그것을 쓰는 step에서 그 파일 하나만 늘어나야 diff에 보인다(이 step은 `HttpApiSourceFetcher.java`·`SpoolWriter.java` 2개로 고정한다).
- 스캔 패턴을 문자열 조립·`String.format`·리플렉션까지 잡도록 넓히지 마라. 이유: 정규식이 넓어질수록 정상 코드를 막는 오탐 비용이 커지고, 그 벡터의 실질 방어선은 행동 단언이다.
- main 소스를 고치지 마라(변이 실증은 반드시 원복). 이유: 이 step은 테스트 전용이며, main 변경은 다음 step들의 diff scope를 오염시킨다.
- 이 게이트를 `@Disabled`·태그 제외로 돌리지 마라. 이유: 게이트가 꺼지면 이 phase의 아키텍처 방어선이 문서 한 줄로 되돌아간다.
