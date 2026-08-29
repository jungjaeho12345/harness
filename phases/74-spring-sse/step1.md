# Step 1: log-stream-source

## 읽어야 할 파일

**계획 문서**
- `phases/74-spring-sse/index.json` — `baseline`·`decisions` (4)(7)(11)·`excluded`.
- `phases/74-spring-sse/step0.md` — 「배경」의 **금지 철자 목록**(그대로 적용된다)과 ADR-015 요지.

**아키텍처 정본**
- `docs/ADR.md` — **ADR-007**(로그 SSE는 실데이터 push · Z 전용 · in-memory 링 버퍼 · replay 2000 · push 시점 비연장 peek) · **ADR-015**(step0이 신설).
- `docs/api-contract/sse.md` — 「`/api/logs/stream` — replay 계약」 절과 「이벤트 어휘 4종」의 `log` 프레임.
- `docs/LOGS.md`가 있으면 마스킹 규율 절.

**Node 정본 (무수정 — 읽기만)**
- `src/services/logService.js` 전문 — `subscribe`/`snapshot`/`log`의 정확한 순서와 반환값(`off` 함수).
- `server/index.js` **1178~1217행** — `LOG_REPLAY_MAX = 2000` · `logService.snapshot().slice(-LOG_REPLAY_MAX)` · `logService.subscribe(...)` 콜백의 try/catch 위치와 그 이유(주석 전문을 반드시 읽어라).

**Spring 현행 (이 step이 고치는 것)**
- `server-spring/src/main/java/harness/news/service/LogService.java` — **전문**. 특히 javadoc의 「구독(subscribe) API는 두지 않았다」 문단.
- `server-spring/src/main/java/harness/news/service/LogRecord.java` — 5키(`seq`·`ts`·`level`·`message`·`line`)와 `asMap()`.
- `server-spring/src/main/java/harness/news/web/RequestLogFilter.java` — **`finally`에서 `logs.info(...)`를 부른다**. 이 사실이 이 step의 락 규율을 결정한다.
- `server-spring/src/test/java/harness/news/service/LogServiceTest.java` — 기존 항목(무회귀 대상).

**직전 step 산출물**
- `server-spring/src/main/java/harness/news/service/ChangeBus.java`(step0) — **구독/해제 API의 형태를 여기에 맞춘다**(두 버스가 서로 다른 모양이면 web층이 두 규약을 외워야 한다).

## 배경 (동결된 사실)

1. **Spring `LogService`에는 `subscribe`/`snapshot`이 없다.** javadoc이 "SSE는 이 phase 범위 밖이라 소비자 없는 API를 미리 만들지 않았다 — SSE를 소유하는 phase가 그때 추가한다"고 적어 뒀다. **이 phase가 그 phase다.** 문단을 지우지 말고 **사실이 된 내용으로 갱신**하라(거짓 문장을 남기면 다음 사람이 오해한다).
2. **Node의 통지는 `logService.log`가 동기로 부른다.** 그 호출자는 요청 로거의 `res.on('finish')`이고, 콜백이 예외를 흘리면 `uncaughtException` → **프로세스 종료**가 된다(Node 주석이 명시). Spring의 대응 위치는 `RequestLogFilter.doFilter`의 `finally`이며, 여기서 예외가 새면 **응답이 이미 나간 뒤에 필터가 터진다**.
3. **`LogService.log`와 `digest`는 현재 `synchronized`다.** 구독자 통지를 monitor를 **잡은 채** 하면 (a) 느린 구독자가 전 요청의 로그 기록을 직렬화하고 (b) 통지 중에 다른 스레드가 `digest()`(= `GET /api/logs/digest`)를 부르면 그 요청이 스트림 소비자를 기다린다. **버퍼 갱신은 monitor 안에서, 통지는 monitor 밖에서** 한다.
4. **replay 상한 2000은 라우트 소유다**(Node `server/index.js` 1178행 상수). `LogService.snapshot()`은 **버퍼 전체**(오래된→최신)를 준다. 절단은 step5의 컨트롤러가 한다 — 여기서 2000으로 잘라 반환하면 `digest`와 다른 창을 갖는 두 번째 절단 지점이 생긴다.
5. **`LogRecord` 5키·`line` 포맷·`digest()` 창 계산은 계약이 동결한 축이다.** 이 step은 그것들을 **한 글자도** 바꾸지 않는다.
6. step0의 「금지 철자」 전 목록이 그대로 적용된다. 특히 통지에 `ExecutorService`·`CompletableFuture`·`new Thread(`를 쓰면 `Adr008DisciplineTest`가 red다.

## 작업

### A — `LogService`에 구독·스냅샷 API 추가

```java
public class LogService {
    public interface Listener { void onLog(LogRecord record); }

    /** 오래된→최신 전체 사본(방어 복사). 절단(replay 2000)은 호출자 책임이다. */
    public List<LogRecord> snapshot();

    /** 구독. 반환값의 close()가 해제이며 이중 호출이 안전하다(ChangeBus와 같은 형태). */
    public AutoCloseable subscribe(Listener listener);

    /** 테스트 관측용 — 누수 0을 단언한다. */
    public int subscriberCount();
}
```

핵심 규칙:
- **`log(...)`의 순서**: ① `synchronized` 블록 안에서 seq 증가·record 생성·버퍼 append·evict → ② **monitor를 푼 뒤** 구독자에게 통지 → ③ record 반환. 통지 대상 목록은 `CopyOnWriteArrayList`라 스냅샷이 필요 없다.
- **구독자 예외는 격리한다** — 한 구독자가 던져도 (a) 다른 구독자가 받고 (b) `log(...)`가 던지지 않는다. 이유: 배경 (2). 그리고 예외를 삼킬 때 **`LogService`에 다시 로그하지 마라**(무한 재귀).
- **통지 순서는 등록 순서**다(결정성).
- `snapshot()`은 **불변/방어 복사**(`List.copyOf`)다. 내부 `Deque`의 뷰를 반환하면 반복 중 `ConcurrentModificationException`이 나고 호출자가 버퍼를 들여다본다.
- 기존 `digest()`·`log()`의 **관측 가능한 동작은 그대로**다(테스트 무회귀).
- javadoc의 「구독(subscribe) API는 두지 않았다」 문단을 **갱신**한다: 이제 소비자는 `GET /api/logs/stream`(step5)이고, 통지는 호출 스레드에서 monitor 밖에서 돌며 예외는 격리된다는 사실, 그리고 **구독 콜백이 다시 `LogService`에 로그하면 무한 재귀**라는 경고를 남긴다.

### B — 테스트 (먼저 작성한다)

`server-spring/src/test/java/harness/news/service/LogServiceTest.java` 증설. red 확인 후 구현.

최소 항목:
1. `subscribe` 후 `info("x")` 1건이 콜백으로 온다 · 전달된 record가 반환 record와 **동일 객체/동일 5키**다.
2. 구독자 2개가 1건에 둘 다 받고 **등록 순서대로** 받는다.
3. `close()` 후 안 받는다 · **이중 `close()` 안전** · `subscriberCount()`가 정확히 오르내린다.
4. 구독자가 던져도 (a) 다른 구독자가 받고 (b) `info(...)`가 던지지 않고 (c) 반환 record가 정상이다.
5. **통지는 monitor 밖에서 돈다** — 콜백 안에서 **별도 스레드**로 `logService.digest()`를 호출해 2초 안에 반환됨을 단언한다(테스트 소스는 `Adr008DisciplineTest`의 스캔 대상이 아니다 — 스캔 루트는 `src/main/java`다. 테스트에서 스레드·타임아웃을 쓰는 것은 허용된다).
6. **통지는 호출 스레드에서 돈다** — 콜백의 `Thread.currentThread()`가 `info()` 호출 스레드와 같다.
7. `snapshot()`은 방어 복사다: 반환 리스트를 수정해도 버퍼가 안 바뀌고(또는 불변이라 `UnsupportedOperationException`), 이후 append가 **이전 스냅샷에 보이지 않는다**.
8. `snapshot()`은 **오래된→최신** 순서다 · cap evict 후 길이는 정확히 cap이고 **가장 오래된 것이 빠진다**.
9. **`snapshot()`은 절단하지 않는다** — 3000건을 넣으면 3000건이 나온다(cap이 그보다 클 때). replay 2000 절단이 여기에 없다는 사실의 잠금.
10. 기존 `digest()` 항목 전건 무회귀.
11. **소스 정적 스캔**: `LogService.java` 원문에 step0 「금지 철자」 0건 · `jakarta.servlet` 0건.

## Acceptance Criteria

```bash
# 1) Java 전체
cd /d/agents/harness/server-spring && JAVA_HOME="D:/agents/tools/jdk-21.0.12+8" ./mvnw -B clean verify
#   기대: BUILD SUCCESS · Tests run: <step0 종료 수치 + 신규 N> · Failures 0 · Errors 0 · Skipped 0

# 2) 계약 무회귀 — 관측 수 불변(이 step도 계약이 하나도 보지 못한다)
cd /d/agents/harness/server-spring && JAVA_HOME="D:/agents/tools/jdk-21.0.12+8" ./mvnw -B -q package -DskipTests
cd /d/agents/harness && SPRING_JAVA_HOME="D:/agents/tools/jdk-21.0.12+8" node scripts/spring-contract.mjs --parity
#   기대: exit 0 · profiles=5 · 296관측 diffs 0

# 3) 무접촉 경로
git diff --stat -- contract docs/api-contract scripts/contract-run.mjs scripts/contract-diff.mjs server src web client test package.json spikes

# 4) ADR-008 게이트 파일 0줄 변경
git diff --stat -- server-spring/src/test/java/harness/news/config/Adr008DisciplineTest.java

# 5) 계약 동결 축 무변 — LogRecord와 digest 창은 이 step이 건드리지 않는다
git diff --stat -- server-spring/src/main/java/harness/news/service/LogRecord.java
```

**종료 조건 — 아래 변이 전건의 결과표를 summary에 기록한다. 미기록 시 이 step은 미완이다.**

## 검증 절차 (변이)

각 변이는 심고 → 지정 커맨드로 red 확인 → 원복 후 `cmp` byte-identical + `git status --porcelain` 무변을 확인한다.

| 변이 | 심는 곳 | 기대 |
|---|---|---|
| M1-1 | 구독자 통지를 `synchronized` 블록 **안**으로 이동 | 항목 5(교차 스레드 `digest()`) red |
| M1-2 | 구독자 예외를 격리하지 않고 전파 | 항목 4 red |
| M1-3 | `snapshot()`이 내부 `Deque`를 그대로 반환 | 항목 7 red |
| M1-4 | `snapshot()`이 최근 2000건만 반환 | 항목 9 red(절단 지점이 두 곳이 되는 것을 막는다) |
| M1-5 | 통지 순서를 역순으로 | 항목 2 red |
| M1-6 | `LogService.java`에 `Executors.newSingleThreadExecutor()` 한 줄 | `Adr008DisciplineTest` **red** — 통지가 비동기가 아니라는 사실의 비공허 실증 |
| M1-7 | 예외 격리 블록 안에서 `this.warn("subscriber failed")` 호출 | 항목 4가 **무한 재귀/StackOverflow**로 red — "삼킬 때 로그하지 마라"의 실증 |

각 변이 전후로 green→red→green 3단계를 기록하라.

## 금지사항

- **`LogRecord`의 5키·순서·`line` 포맷(`[YYYY-MM-DD HH:MM:SS] [LEVEL] 메시지`)을 바꾸지 마라.** 이유: `logs.contract.js`의 `assertLogRecord`가 키 집합과 접두 포맷을 정확 비교한다(step5에서 green이 되는 계약이다).
- **`digest()`의 06:00 정렬 24시간 창 계산을 고치지 마라.** 이유: 계약과 `LogServiceTest`가 이미 동결했고 이 step의 범위가 아니다.
- **`snapshot()`에서 2000건으로 자르지 마라.** 이유: replay 상한은 라우트 소유(Node `server/index.js` 1178행)다. 여기서 자르면 절단 지점이 둘이 되고 한쪽만 고쳐도 조용히 갈린다.
- **통지를 별도 스레드·실행자·`CompletableFuture`로 옮기지 마라.** 이유: ADR-008 (6) 위반 + `Adr008DisciplineTest` red + 응답이 끝난 뒤의 동작을 계약이 관측할 수 없다.
- **예외를 삼키면서 `LogService`에 로그하지 마라.** 이유: 통지 → 예외 → 로그 → 통지의 무한 재귀다(M1-7이 실증한다).
- **`@Scheduled`·타이머로 버퍼를 비우거나 evict하지 마라.** 이유: ADR-007이 "evict는 append 시점, 창 계산은 조회 시점"으로 동결했다.
- **로그의 실값(경로·userId·메시지)을 테스트 단언 메시지나 실패 출력에 싣지 마라.** 이유: LOGS.md 마스킹 규율 — 이 버퍼는 `GET /api/logs/digest`로 밖으로 나간다.
- **`contract/**`·`server/**`·`src/**`·`test/**`·`spikes/**` 등 무접촉 목록을 고치지 마라.**
