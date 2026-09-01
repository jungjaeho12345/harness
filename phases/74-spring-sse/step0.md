# Step 0: baseline-and-change-bus

## 읽어야 할 파일

**계획 문서 (먼저)**
- `phases/74-spring-sse/index.json` — 이 phase의 `scope`·`baseline`·`decisions`·`excluded`·`open_questions` 전문. 특히 **decisions (1)(2)(3)(4)(6)**.
- `phases/73-spring-media-upload/index.json` — `forward_notes` (2)(4)(5)(8)(9)(10)(11). 이 phase가 상속하는 규율의 원문이다.

**아키텍처 정본**
- `docs/ADR.md` — **ADR-005**(SSE 단방향 무효화 스트림 — 이 phase의 지배 결정) · **ADR-007**(로그 SSE는 실데이터 · Z 전용 · push 시점 비연장 peek) · **ADR-008**(앱 내 타이머/egress 금지) · **ADR-013**(Spring 포팅 · 특히 ④ 와이어 바이트) · **ADR-014**(ADR-008 예외 확대의 선례와 그 대가).
- `docs/api-contract/sse.md` — 두 스트림의 와이어 계약 전문(바이트 수준).
- `ARCHITECTURE.md` — 계층 규율.

**Node 정본 (무수정 — 읽기만)**
- `server/index.js` **585~600행**(`bus` 생성 · `bus.setMaxListeners(0)` · `app.notifyChange = (kind) => bus.emit('change', { kind })`).
- `server/index.js` **1124~1160행**(`GET /api/stream` 전문).
- `server/index.js` **415~443행**(`UNAUTHORIZED_FRAME` 리터럴 · `createSseCloser`).

**Spring 현행**
- `server-spring/src/main/java/harness/news/service/LogService.java` — **서비스층 인프라 빈의 선례**(시계 주입 · 타이머 0 · javadoc "구독 API는 두지 않았다"는 문단이 이 phase에서 거짓이 된다 — step1이 고친다).
- `server-spring/src/main/java/harness/news/web/WebConfig.java` — 빈 배선 지점.
- `server-spring/src/main/java/harness/news/config/AppConfig.java` — `LogService` 빈이 어디서 만들어지는지 확인.
- `server-spring/src/test/java/harness/news/config/Adr008DisciplineTest.java` — **금지 철자 4군 전문**. 이 step이 쓰는 코드가 어느 패턴에도 걸리지 않아야 한다.
- `server-spring/README.md` — 「ADR-008 규율은 정적 게이트가 지킨다」 절.

## 배경 (동결된 사실 — 조사 결과이며 추정이 아니다)

1. **Node의 무효화 버스는 in-process `EventEmitter` 하나이고, `bus.emit`은 트리거 요청 핸들러의 스택에서 동기로 돈다.** 구독자 콜백(SSE 라우트의 `onChange`)이 그 자리에서 응답에 프레임을 쓴다. **타이머도 워커풀도 큐도 없다.** `bus.setMaxListeners(0)` = 동시 구독자 수 제한 없음.
2. **`notifyChange` 발행 지점은 HTTP 라우트 11곳이다**(2026-08-29 재실측 — 72 ⑤가 인용한 748·784는 실제로 749·787이다):
   `server/index.js` **749**(tick · `Array.isArray(r.distributed) && r.distributed.length > 0`) · **787**(retry 성공 분기) · **867**(create · `if (r.ok)`) · **883**(action) · **902**(derive) · **944**(update · `if (r.ok)`) · **963**(lock) · **976**(unlock) · **988**(force-unlock) · **1090**(collection receive) · **1116**(collection pull). 결선은 **step3**이 한다 — 이 step은 버스만 만든다.
3. **`Adr008DisciplineTest`의 예외 목록은 파일 단위 4개이고 이 phase는 그 목록을 넓히지 않는다.** 이 phase의 설계(서블릿 비동기 + 트리거 스레드 직접 쓰기)는 앱 코드에 타이머·스레드·실행자를 **하나도** 만들지 않기 때문이다. 근거 없는 확대는 ② 검토가 revise를 내는 자리다(73 초안이 실제로 반려됐다).
4. **금지 철자(main 소스 전역, 예외 4파일 밖)** — 이 step의 새 코드에 하나도 쓰지 마라:
   `@Scheduled` · `@EnableScheduling` · `TaskScheduler` · `ScheduledExecutorService` · `ScheduledThreadPoolExecutor` · `Executors.newScheduled*(` · `new Timer(` · `Thread.sleep(` · `TimeUnit.*.sleep(` · `.schedule*(` · `ScheduledFuture` · `LockSupport` · `.park*(` · **`.await(`** · `@Async` · `@EnableAsync` · `@Retryable` · `RetryTemplate` · `CompletableFuture` · `CompletionStage` · `.thenApply/thenAccept/thenRun/thenCompose/thenCombine/whenComplete*(` · `ExecutorService` · `ThreadPoolExecutor` · `ForkJoinPool` · `TaskExecutor`/`AsyncTaskExecutor` · `Executors.new*(` · `new Thread(` · `Thread.startVirtualThread(` · `Thread.of(Virtual|Platform)(` · **`CountDownLatch`** · `.sendAsync(` · `@Recover` · 네트워크 군(`HttpClient`·`RestTemplate`·`WebClient`·`RestClient`·`.openConnection(`·`.openStream(` 등) · 파일 쓰기 군.
   **허용(패턴에 없다)**: `ConcurrentHashMap` · `CopyOnWriteArrayList` · `AtomicLong`/`AtomicBoolean` · `synchronized` · `ReentrantLock`(단 `Condition.await()`는 금지 철자에 걸린다 — 쓰지 마라).
   **[JDK 25 주의 — 2026-08-30 계획 단계 실측] 위 패턴 목록은 JDK 21 API 표면 기준으로 작성됐고, JDK 25가 정식화한 일부 표면이 거기에 없다.** `Adr008DisciplineTest.java`(908행) 전문에 `StructuredTaskScope` · `ScopedValue` · `Subtask` · `.fork(` · `.join(` 문자열이 **0건**이다 — 즉 **게이트가 잡지 못한다**. 그래도 **쓰지 마라**: ADR-008의 취지는 패턴 목록이 아니라 "앱이 스스로 깨어나지 않고 스스로 다시 시도하지 않는다"이고, 게이트를 통과한다는 사실은 허가가 아니다. (가상 스레드 진입로 `Thread.startVirtualThread(`·`Thread.of(Virtual|Platform)(`·`Executors.new*(`는 **이미 걸린다**.) 이 공백의 조사·기록은 **step6 작업 G**가 소유한다 — **여기서 게이트 파일을 고치지 마라**(이 phase는 그 파일을 0줄 고친다).
5. **`docs/ADR.md`는 순수 추가만 허용된다.** 기존 ADR 본문(ADR-001~014)은 **한 글자도** 고치지 않는다 — 각 문장은 그 시점의 결정·실측 기록이고 소급 수정은 이력을 오염시킨다(ADR-014가 명문화한 규율).

## 작업

### A0 (선행) — 툴체인 전제 확인 (가벼운 확인 · 3커맨드)

이 phase의 기준선은 **포터블 Temurin JDK 25.0.4.1+1**(`D:/agents/tools/jdk-25.0.4.1+1`)이다. PR #119(`fde4e3e` → 머지 `4543cea`)가 `server-spring`을 JDK 21에서 JDK 25로 옮기면서 **측정까지 동반**했다. 착수 시 그 전제가 그대로인지만 확인한다.

```bash
# ① pom이 25인가 (기대: server-spring은 25 · spikes/p0-spring은 21 그대로)
grep -n "java.version" server-spring/pom.xml spikes/p0-spring/pom.xml

# ② 포터블 JDK 25가 있는가
ls -d D:/agents/tools/jdk-25.0.4.1+1

# ③ 브랜치에 이 phase가 만들지 않은 커밋이 있는가
git log --oneline -3 && git show --stat --format="" HEAD
```

기대치(2026-08-30 계획 단계 재실측):
- `server-spring/pom.xml` → `<java.version>25</java.version>`. **`maven-compiler-plugin` 블록은 없다** — Spring Boot 부모 POM이 `maven.compiler.release`로 전달한다(빌드 로그 `Compiling ... with javac [debug parameters release 25]`로 확인됨). **`maven-compiler-plugin`을 새로 추가하지 마라**(부모가 이미 하는 일을 두 곳에서 하게 된다).
- `spikes/p0-spring/pom.xml` → **21 유지**. 동결된 P0 산출물이고 게이트 대상이 아니며 **이 phase의 무접촉 목록**이다. 21이라고 해서 고치지 마라.
- ①이 다르면(예: `server-spring`이 21로 되돌아갔거나 `<release>`가 박혔거나 `spikes`가 25로 바뀌었다면) **멈추고 오케스트레이터에게 보고하라** — 아래 「환경 함정」이 재발한 것이다.

> **환경 함정(2026-08-29~30 실측 · 재발 가능)**: 이 리포에는 VS Code의 **GitHub Copilot App Modernization(java-upgrade) 세션**이 붙어 있다(`.github/modernize/java-upgrade/` — gitignore 대상이라 `git status`에 안 뜬다). 그 도구는 포터블 JDK를 찾지 못해 **기준선 측정을 통째로 건너뛴 채** pom만 Java 25로 바꾼 커밋 `d1d5e84`를 이 브랜치에 남긴 전례가 있다(그 커밋은 `wip-jdk25-upgrade`에 보존됐고 이 브랜치에서는 제거됐다. 이후 PR #119가 **측정을 동반해** 정식으로 JDK 25로 옮겼다). 세션 파일 4개에는 재개 금지 표지를 남겨 뒀으나 **IDE가 그 세션을 재개하면 다시 pom·`.vscode/`를 건드릴 수 있다.** 그래서 이 확인이 매 착수의 전제이고, 그래서 **`git add -A`가 금지**다.

### A1 (선행) — 기준선 재측정

아래를 **직렬로** 돌려라. 결과를 summary에 수치로 적는다.

```bash
# ① Java (반드시 clean — IDE가 target/에 다른 릴리스의 클래스를 남기면 Tests run: 0 + BUILD FAILURE로 즉사한다)
cd /d/agents/harness/server-spring && JAVA_HOME="D:/agents/tools/jdk-25.0.4.1+1" ./mvnw -B clean verify

# ② 계약 패리티 (리포 루트 cwd · SPRING_JAVA_HOME 필수)
cd /d/agents/harness && SPRING_JAVA_HOME="D:/agents/tools/jdk-25.0.4.1+1" node scripts/spring-contract.mjs --parity

# ③ Node 스위트
cd /d/agents/harness && npm test

# ④ 구현 라우트 수
grep -c '"\(GET\|POST\|PUT\|DELETE\) /api' server-spring/src/test/java/harness/news/web/HandlerInventoryTest.java

# ⑤ 작업 트리
git status --porcelain
```

기대치(**2026-08-30 계획 단계 재실측 — `4543cea` 트리 · 포터블 JDK 25.0.4.1+1**):
- ① **Tests run: 1246, Failures: 0, Errors: 0, Skipped: 0** BUILD SUCCESS(3:40) · jar 35,781,124 B
- ② exit 0 · profiles=5 · **296관측 diffs 0**(default 229 · minimal 55 · auth-negative 4 · failclosed 5 · prod-cookie 3)
- ③ **tests 1328 / pass 1328 / fail 0**
- ④ **37**
- ⑤ 미추적 `.vscode/`만. **단 PR #120(`.gitignore`에 `.vscode/` 추가)이 머지된 뒤라면 그것도 뜨지 않는다 — 둘 다 정상이다.** `.gitignore`에 `.vscode` 항목이 있는지 먼저 확인해 어느 쪽인지 판정하고, 그 밖의 미추적 항목이 있으면 멈춰라.

**불일치하면 그 자리에서 `index.json`의 `baseline`과 전 step AC의 기대 수치를 갱신한 뒤 진행하라.** 추정치를 물려받지 마라.

> **CRITICAL(계획 단계 실측 함정)**: `mvnw verify`와 계약 하네스(`spring-contract.mjs`/`contract-run.mjs`)를 **동시에 돌리지 마라**. 2026-08-29 실측에서 동시 실행이 Spring 와이어 테스트 63건을 `{"ok":false,"reason":"internal-error"}`(SQLite 경합 추정)로 무너뜨렸다 — 소스 결함이 아니다. 직렬로 돌리면 0 실패다.

### A2 — `docs/ADR.md`에 **ADR-015** 신설 (순수 추가)

파일 **맨 끝에** 다음 요지의 항목을 ADR-014와 같은 형식(`### ADR-015: 제목` / `**결정**:` / `**이유**:` / `**트레이드오프**:`)으로 추가한다. **기존 줄은 한 글자도 고치지 마라.**

- **제목 요지**: 장수명 SSE 응답의 와이어 지점은 `SseHttp` 두 번째 지점이며 `RawContentType` seam을 공유한다 — 연결은 서블릿 비동기 컨텍스트로 유지하고 프레임은 트리거 요청 스레드가 쓴다(앱 타이머·워커풀 0).
- **결정**에 담을 것:
  1. JSON 응답의 와이어 단일 지점은 `JsonHttp`로 유지한다. **SSE만** 두 번째 지점 `harness/news/web/SseHttp.java`를 갖는다. 두 지점은 **같은 `RawContentType`**(coyote 응답에 완성 문자열을 직접 기록)을 쓴다 — 그것이 `Content-Type: text/event-stream; charset=utf-8`의 **세미콜론 뒤 공백 1바이트**를 지키는 유일한 경로다(ADR-013 ④).
  2. `SseEmitter`·`ResponseBodyEmitter`·`StreamingResponseBody`·메시지 컨버터·WebFlux를 **쓰지 않는다**. 그 경로들은 서블릿 API로 Content-Type을 지정해 컨테이너가 `text/event-stream;charset=UTF-8`로 **재조립**한다(공백 소실 + 대문자) — 전 SSE 관측이 diff가 된다.
  3. 연결은 **서블릿 비동기 컨텍스트**(`HttpServletRequest#startAsync` · `AsyncContext#setTimeout(0)` = 무한)로 유지한다. 그래서 스트림이 열려 있는 동안 **Tomcat 워커를 점유하지 않는다**.
  4. 프레임 쓰기는 **트리거가 된 요청의 스레드**에서 동기로 한다(Node `bus.emit`이 라우트 핸들러 스택에서 도는 것과 동형). **앱 내 타이머·스케줄러·워커풀·백그라운드 스레드·heartbeat·`retry:`·`id:`가 0이다** — 그래서 `Adr008DisciplineTest`의 예외 목록은 **4파일 그대로**이고 이 phase는 그 파일을 한 줄도 고치지 않는다.
  5. 세션 재검증은 **push 시점 비연장 peek**이며(ADR-005·ADR-007) 주기 재검증 타이머는 두지 않는다.
- **이유**에 담을 것: 와이어 바이트가 합격 기준이라는 ADR-013의 전제 / ADR-008 (3)(6)의 취지(앱이 스스로 깨어나지 않고 스스로 다시 시도하지 않는다)를 **넓히지 않고** 지킨다 / 워커 점유를 스트림 수명만큼 잡는 블로킹 구현은 37 라우트 전부를 죽인다(71a·72가 반복 확인한 축).
- **트레이드오프**에 담을 것: 와이어 지점이 둘이 됐다(둘이 같은 seam을 쓴다는 사실은 테스트가 잠근다 — 갈리면 조용히 1바이트가 어긋난다) / 느린 구독자가 트리거 요청을 지연시킨다(Node 동형 · 상한 없음) / 이벤트가 없으면 종료가 다음 이벤트까지 지연된다(ADR-005·007이 이미 기록한 대가) / 비동기 서블릿은 필터 체인 전원이 `asyncSupported`여야 하며 그 사실이 테스트로만 고정된다 / `Connection: keep-alive` 같은 hop-by-hop 헤더는 컨테이너가 자체 관리하므로 Node와 바이트가 갈릴 수 있다(계약 미관측 · 실측해 기록한다).

### A3 — main `harness/news/service/ChangeBus.java` 신설

**서비스층**이다. 서블릿 타입(`jakarta.servlet.*`)을 **하나도** import하지 않는다.

```java
package harness.news.service;

public class ChangeBus {
    public interface Listener { void onChange(String kind); }

    /** 무효화 신호 어휘 4종(sse.md) — 검증하지 않고 상수로만 제공한다(Node 동형). */
    public static final String CREATE = "create";
    public static final String UPDATE = "update";
    public static final String STATUS = "status";
    public static final String LOCK   = "lock";

    /** 구독. 반환값의 close()가 해제이며 이중 호출이 안전하다(Node의 off 동형). */
    public AutoCloseable subscribe(Listener listener);

    /** 호출 스레드에서 동기로 전 구독자에게 통지한다. 절대 던지지 않는다. */
    public void publish(String kind);

    /** 테스트 관측용 — 누수 0을 단언한다. */
    public int subscriberCount();
}
```

핵심 규칙(벗어나지 마라):
- **`publish`는 절대 예외를 밖으로 내보내지 않는다.** 한 구독자가 던져도 (a) 나머지 구독자에게 통지가 계속되고 (b) 호출자(라우트)는 정상 반환을 받는다. 이유: Node `server/index.js` 1144~1150행 주석이 명시한 위험 — 예외가 새면 **성공한 저장이 전역 에러 핸들러에 걸려 500으로 뒤집히고 클라 재시도가 중복 저장을 만든다**.
- **`publish`는 호출 스레드에서 돈다.** 별도 스레드·큐·실행자에 넘기지 마라(ADR-008 · ADR-015).
- 구독자 컨테이너는 `CopyOnWriteArrayList`(반복 중 해제가 안전하다). `ConcurrentModificationException`을 만들지 마라.
- **kind 값을 검증하지 마라**(Node는 검증하지 않는다). 상수만 제공한다.
- payload JSON(`{"kind":"..."}`)을 여기서 만들지 마라 — **직렬화는 web층 소유**다(서비스층에 와이어 포맷이 새면 지점이 갈린다).

빈 배선: `LogService`가 등록된 것과 같은 자리(`AppConfig` 또는 `WebConfig` — 현행을 읽고 같은 형태로)에 싱글턴 빈으로 등록한다. `@Component` 스캔이든 `@Bean`이든 **현행 선례를 따르고 새 방식을 도입하지 마라**(73 step2 실측: 합성 루트가 컴포넌트 스캔이라 `@Bean`을 더하면 중복 정의가 된다).

### A4 — 테스트 (먼저 작성한다)

`server-spring/src/test/java/harness/news/service/ChangeBusTest.java` 신설. **red를 먼저 확인**하고 구현하라.

최소 항목:
1. 구독자 1개가 `publish("create")`를 받는다 · kind 문자열이 그대로 전달된다.
2. **구독자 2개가 publish 1회에 둘 다 받는다**(계약 A-5 fanout의 서비스층 대응).
3. `close()` 후에는 받지 않는다 · **이중 `close()`가 안전하다**(예외 0 · 다른 구독자 영향 0).
4. 구독자가 `RuntimeException`을 던져도 (a) 나머지 구독자가 받고 (b) `publish`가 던지지 않는다.
5. **`publish`는 호출 스레드에서 돈다** — 콜백 안에서 `Thread.currentThread()`가 호출 스레드와 동일함을 단언.
6. 구독자 0명일 때 `publish`는 무해하다.
7. `subscriberCount()`가 구독·해제에 따라 정확히 오르내린다(누수 0의 관측 수단).
8. **소스 정적 스캔**: `ChangeBus.java` 원문에 위 「금지 철자」가 0건이고 `jakarta.servlet` 문자열이 0건이다.

## Acceptance Criteria

```bash
# 1) Java 전체 — clean 필수
cd /d/agents/harness/server-spring && JAVA_HOME="D:/agents/tools/jdk-25.0.4.1+1" ./mvnw -B clean verify
#   기대: BUILD SUCCESS · Tests run: <기준선 1246 + 이 step 신규 N> · Failures 0 · Errors 0 · Skipped 0
#   N(신규 테스트 수)을 summary에 반드시 적어라.

# 2) 계약 무회귀 — 관측 수가 변하지 않아야 한다(이 step은 계약이 하나도 보지 못한다)
cd /d/agents/harness && SPRING_JAVA_HOME="D:/agents/tools/jdk-25.0.4.1+1" node scripts/spring-contract.mjs --parity
#   기대: exit 0 · profiles=5 · 296관측 diffs 0(default 229 · minimal 55 · auth-negative 4 · failclosed 5 · prod-cookie 3)
#   (소스를 고쳤으므로 반드시 먼저: cd server-spring && JAVA_HOME="D:/agents/tools/jdk-25.0.4.1+1" ./mvnw -B -q package -DskipTests)

# 3) ADR은 순수 추가다 — 기존 텍스트가 새 텍스트의 접두사임을 기계로 확인
git show HEAD:docs/ADR.md > /tmp/adr-before.md 2>/dev/null || git show 4543cea:docs/ADR.md > /tmp/adr-before.md
node -e "const fs=require('fs');const a=fs.readFileSync('/tmp/adr-before.md','utf8');const b=fs.readFileSync('docs/ADR.md','utf8');if(!b.startsWith(a)){console.error('ADR 순수 추가가 아니다');process.exit(1)}console.log('ADR pure-append OK +'+(b.length-a.length)+'B')"

# 4) 무접촉 경로 — 출력이 있으면 즉시 실패
git diff --stat -- contract docs/api-contract scripts/contract-run.mjs scripts/contract-diff.mjs server src web client test package.json spikes

# 5) ADR-008 정적 게이트 파일은 0줄 변경
git diff --stat -- server-spring/src/test/java/harness/news/config/Adr008DisciplineTest.java
```

**종료 조건 — 아래 변이 전건의 결과표를 summary에 기록한다. 미기록 시 이 step은 미완이다.**

## 검증 절차 (변이 — 전건 실행하고 결과를 표로 남긴다)

각 변이는 ① 심고 ② 지정된 커맨드를 돌려 ③ red를 확인하고 ④ **원복 후 `git status --porcelain`이 변이 전과 같고 원본 사본과 `cmp`로 byte-identical**임을 확인한다.

| 변이 | 심는 곳 | 기대 |
|---|---|---|
| M0-1 | `ChangeBus.publish`가 **첫 구독자에게만** 통지 | `ChangeBusTest` 항목 2 red |
| M0-2 | 구독자 예외를 격리하지 않고 그대로 전파 | `ChangeBusTest` 항목 4 red |
| M0-3 | `close()`를 두 번 부르면 예외 | `ChangeBusTest` 항목 3 red |
| M0-4 | `ChangeBus.java`에 `java.util.concurrent.Executors.newSingleThreadExecutor()` 한 줄 추가 | `Adr008DisciplineTest` **red**(예외 4파일이 아니므로) — 예외 목록을 넓히지 않았다는 사실의 **비공허 실증** |
| M0-5 | `ChangeBus.java`에 `jakarta.servlet.http.HttpServletResponse` import 추가 | `ChangeBusTest` 항목 8 red(서비스층 서블릿 import 0) |
| M0-6 | `docs/ADR.md`의 ADR-015 문단을 삭제 | AC 3)의 접두사 검사는 **green**이다(삭제도 접두사를 깨지 않는 방향이 있으므로) → 이 사실을 기록하고, ADR-015 존재 자체는 step2·step4가 javadoc에서 인용해 잠근다 |

추가로 **비공허성 자기 검사**: M0-4를 심기 전에 `Adr008DisciplineTest`가 green임을 확인하고, 심은 뒤 red, 원복 뒤 다시 green 3단계를 기록하라(green→red→green이 아니면 그 변이는 아무것도 증명하지 않는다).

## 금지사항

- **`Adr008DisciplineTest`의 예외 목록을 넓히지 마라.** 이유: 이 phase의 설계는 앱 코드에 타이머·스레드·실행자를 만들지 않으므로 확대의 근거가 없다. 근거 없는 확대는 ② 검토가 revise를 낸 자리다(73 초안 선례). 넓혀야 한다고 느껴지면 그것은 설계가 ADR-015에서 벗어났다는 신호다.
- **`ChangeBus`에 서블릿 타입(`jakarta.servlet.*`)·`HttpServletResponse`·`AsyncContext`를 import하지 마라.** 이유: 서비스층 서블릿 import 0 규율(ADR-006·013). 구독자는 `Listener` 콜백이고 응답에 쓰는 일은 web층 람다가 한다(Node의 라우트 클로저와 같은 자리).
- **`publish`를 별도 스레드·큐·`CompletableFuture`에 넘기지 마라.** 이유: ADR-008 (6) 위반이고 `Adr008DisciplineTest`가 즉시 red다. 그리고 응답이 끝난 뒤 무슨 일이 벌어지는지 계약이 관측할 방법이 없다.
- **kind 문자열을 검증해 예외를 던지지 마라.** 이유: Node는 검증하지 않는다. 검증 예외가 라우트로 새면 성공한 저장이 500으로 뒤집힌다.
- **`docs/ADR.md`의 기존 ADR 본문을 고치지 마라.** 이유: 각 문장은 그 시점의 결정·실측 기록이며 소급 수정은 이력을 오염시킨다(ADR-014가 명문화).
- **`contract/**`·`docs/api-contract/**`·`scripts/contract-run.mjs`·`scripts/contract-diff.mjs`·`server/**`·`src/**`·`web/**`·`client/**`·`test/**`·`package.json`·`spikes/**`·리포 `news.db`·리포 `uploads/`를 고치지 마라.** 이유: 계약 정본과 Node 정본을 고치면 패리티 판정이 자기 자신을 측정하게 된다.
- **`git add -A`를 쓰지 마라.** 명시 경로만 add하라. 이유: `.vscode/`(IDE 산출물)와 임시 산출물이 커밋에 섞인다 — 이 브랜치에서 실제로 일어났다.
