# Step 4: stream-http  ← **GREEN A (계약 파일 1개 · 10관측)**

## 읽어야 할 파일

**계획 문서**
- `phases/74-spring-sse/index.json` — `decisions` (1)(2)(3)(4)(5)(6)(8)(9)(10)(12) 전문.
- `phases/74-spring-sse/step2.md` — 「배경」의 **Node 원문 실측 헤더/프레임 바이트**와 「하네스가 스트림을 어떻게 관측하는가」.
- `phases/73-spring-media-upload/index.json` — `forward_notes` (2)①②③ · (3) 프로브 이동 규칙 · (11)⑧(scope 표 누락은 조용히 통과한다).

**계약 (읽기만 — 무수정). 이 step이 green으로 만드는 파일이다.**
- `contract/cases/default/sse-stream.contract.js` **전문** — A-1~A-6 + 공용 R 세션 복구 케이스. 특히:
  - `READY_FRAME = 'event: ready\ndata: {"ok":true}\n\n'` · `UNAUTHORIZED_DATA`
  - A-4가 `assert.deepEqual(Object.keys(frame.json).sort(), ['kind'])`로 **행 데이터 0**을 단언한다(ADR-005 (a)의 유일한 계약 관측점)
  - A-6이 "봉인" 후 `waitFor(() => true, 2000)`가 **null**이어야 한다고 단언한다
- `contract/lib/sse.js` · `contract/lib/record.js`(`ALLOWED_HEADERS`) · `contract/lib/session.js`(`republish`)
- `docs/api-contract/sse.md` · `docs/api-contract/endpoints.json`의 `stream` 행(`expect: ["success","unauthenticated"]`)

**아키텍처 정본**
- `docs/ADR.md` — **ADR-005 전문**(무효화 신호 · 비연장 peek) · **ADR-015**(step0 신설) · ADR-004(신원은 세션에서만).

**Node 정본 (무수정 — 읽기만)**
- `server/index.js` **1124~1160행** — `GET /api/stream` 전문. `sessionOf` → 401 → 헤더 3종 → `flushHeaders()` → ready write → `createSseCloser` → `bus.on('change', onChange)` → `closer.setUnsubscribe(...)` → `req.on('close', ...)`.
- `server/index.js` **428~443행** — `createSseCloser`: **구독 해제 → 종료 프레임 → `res.end()`** 순서와 그 이유.

**Spring 현행**
- `server-spring/src/main/java/harness/news/web/RoutePolicy.java` **166행** — `new Route("stream", "GET", "/api/stream", AuthClass.SESSION)`. **이미 등재돼 있다 — 이 파일을 고치지 마라.**
- `server-spring/src/main/java/harness/news/web/PathPolicyFilter.java` — 미인증 401 JSON을 만드는 자리(`touchSession` 사용).
- `server-spring/src/main/java/harness/news/service/SessionGuard.java` — **`peekSession`(비연장)** 과 `touchSession`(연장)의 차이.
- `server-spring/src/main/java/harness/news/web/SessionTokens.java` — 쿠키 우선 · `x-session-id` 폴백.
- `server-spring/src/test/java/harness/news/web/HandlerInventoryTest.java` — 37행 목록 · 메서드 이름 `exactlyTheThirtySevenImplementedRoutesHaveHandlers` · 실패 메시지의 수치.
- `server-spring/src/test/java/harness/news/web/PathPolicyWireTest.java` **107~137행** — 스텁 금지 프로브(현재 `GET /api/stream`)와 그 javadoc의 「다음에 옮길 사람을 위한 규칙」.
- `scripts/spring-contract.mjs` **68~95행** — SCOPE `default.files` 목록(알파벳 순서).

**직전 step 산출물**
- `harness/news/web/SseHttp.java`(step2) · `harness/news/service/ChangeBus.java`(step0) · `testsupport/WireStream.java`(step2) · 발행 11 지점(step3).

## 배경 (동결된 사실)

1. **인가 등급**: `/api/stream`은 **로그인만**(`AuthClass.SESSION`)이다. `/api/logs/stream`은 **Z 전용**(`AuthClass.ADMIN`)이며 step5가 소유한다. 두 라우트 모두 `RoutePolicy`에 **이미 등재돼 있다** — 이 phase는 `RoutePolicy`를 **0줄** 고친다.
2. **401은 `PathPolicyFilter`가 만든다**(스트림을 열기 전 JSON — 계약 요구와 정확히 일치). 컨트롤러까지 오면 이미 인증된 요청이다. 그래도 컨트롤러는 **토큰을 다시 읽어 `peekSession`으로 신원을 확인**해야 한다(push 시점 재검증에 쓸 `sid`가 필요하고, null이면 fail-closed 401).
3. **push 시점 재검증은 `peekSession`(비연장)이다.** `touchSession`을 쓰면 **열린 스트림이 세션 유휴 만료(1시간)를 무한 연장**한다 — ADR-005·ADR-007이 명시적으로 금지한 자리다. **계약은 이 축을 관측할 수 없다**(시계를 주입할 수 없다) → **Java 테스트가 유일 방어선**이다.
4. **peek 중 예외(DB 장애 등)도 봉인이다**(fail-closed). Node는 리스너 국소 try/catch로 잡는다 — `sessionGuard`에서 잡으면 HTTP 라우트의 DB 예외가 500 대신 401이 되는 광범위한 변화가 생긴다는 주석이 있다. **같은 위치(구독 콜백 안)에서 잡아라.**
5. **종료 순서는 ① 구독 해제 → ② `unauthorized` 프레임 1회 → ③ `AsyncContext.complete()`**다. 해제를 먼저 하는 이유: 닫힌 응답에 write가 누적되면 누수와 예외가 된다.
6. **`HandlerInventoryTest`의 목록을 늘리는 것은 "계약도 같이 늘렸다"는 선언이다.** 같은 커밋에서 `scripts/spring-contract.mjs`의 scope 표에도 행을 넣어라. 늘리지 않으면 **`HandlerInventoryTest`는 green이고 관측 수만 조용히 그대로다**(73 변이 F 실측: default cases 194→163·covered 29→24로 줄어도 exit 0이다 — 기계 증거는 관측 수뿐이다).
7. **scope 표 `default.files`는 알파벳 정렬 순서 그대로**여야 한다(러너 디렉토리 스캔 순서와 같아야 공용 세션 복구 규약이 이어진다). `sse-stream.contract.js`의 자리는 `session-guard.contract.js` **뒤**, `users.contract.js` **앞**이다.
8. **로그인 예산**: 이 계약 파일은 default에서 정확히 2회 로그인한다(A-6 전용 + 공용 R 복구). 프로파일 합계 = 러너 3 + `auth.contract.js` 2 + 여기 2 = **7 ≤ 10회/15분**. Spring의 `LoginRateLimit`(15분/10회)이 이미 그 계약을 지킨다 — **레이트리밋 설정을 건드리지 마라**.
9. **이 step은 서블릿 async를 실제로 켜는 첫 라우트다 — ADR-008 정적 게이트 2군과 정면으로 만난다**(JDK 25 기준선 · 2026-08-30 계획 단계 실측). 허용은 `AsyncContext`·`startAsync`·`AsyncListener`·`setTimeout(0)`·`synchronized`·`Atomic*`뿐이다. 스트림이 안 열린다고 `ExecutorService`·`CompletableFuture`·`new Thread(`·`CountDownLatch`·`Thread.sleep(`으로 손이 가면 `Adr008DisciplineTest`가 즉시 red다(M4-9가 그 사실을 실증한다). **게이트가 못 잡는 JDK 25 신규 표면**(`StructuredTaskScope`·`ScopedValue`·`Subtask` — 그 파일 908행 전문에 0건)도 **똑같이 금지**다: 게이트 통과는 허가가 아니다. 그 공백의 조사·기록은 step6 작업 G가 소유하고 **이 step은 게이트 파일을 0줄 고친다**. `StreamController.java`에 그 3종 철자가 0건임을 정적 스캔으로 단언하라(step2 항목 8과 같은 형태).
10. **프로브 이동**: 이 step이 `stream`을 구현하면 `PathPolicyWireTest`의 스텁 금지 프로브가 **200**이 되어 red다. 인벤토리 안에 남는 후보는 **`GET /api/logs/stream` 하나**다(step5가 그것도 구현하면 후보가 0이 되어 인벤토리 밖으로 옮겨야 한다 — step5의 몫). `logs-stream`은 `AuthClass.ADMIN`이고 `ADMIN.requiresSession() == true`이므로 **인증된 요청은 필터를 통과하고 핸들러가 없어 404 `text/html`**이 된다(프로브가 요구하는 정확한 형태 — 실측 확인 완료).

## 작업

### A — main `harness/news/controller/StreamController.java` 신설

```java
@RestController
public class StreamController {
    // 생성자 주입: SessionGuard · ChangeBus · SseHttp · JsonHttp
    @GetMapping("/api/stream")
    public void stream(HttpServletRequest request, HttpServletResponse response);
}
```

핸들러 흐름(Node 1124~1160행과 1:1):
1. `SessionTokens.read(cookie 헤더, x-session-id 헤더)` → 토큰.
2. `Identity me = sessions.peekSession(token)` — null이면 `json.write(..., 401, JsonHttp.fail("unauthenticated"))` 후 **return**(스트림을 열지 않는다).
3. `SseHttp.Stream s = sse.open(request, response)` — 헤더 3종 + 200 커밋 + flush. **반환 시점의 스트림은 prelude 모드다**(step2 「replay-gate」).
4. **`AutoCloseable sub = changeBus.subscribe(...)` — 구독을 먼저 등록한다.** 콜백은 `s.write(...)`를 부르고, prelude 모드이므로 **큐에 적재**된다.
5. `s.writePrelude(SseHttp.READY)` — ready가 **반드시 첫 프레임**이다.
6. **`s.endPrelude(<아무것도 버리지 않는 값>)`** — write monitor 안에서 큐를 순서대로 드레인하고 live로 전환한다. `/api/stream`은 중복 제거 대상이 없다(payload가 `kind` 하나뿐이라 순서키가 없다).
   - **[② 재검토 반영 · 필수] 4~6 구간 전체를 `try { ... } catch (RuntimeException ex) { seal(); }`로 감싸라.** 이유: `open()`이 성공한 뒤 `endPrelude`에 도달하기 전에 예외가 나 그냥 빠져나가면 **클라이언트는 헤더만 받고 영원히 기다리고**(`AsyncContext.setTimeout(0)`이라 **컨테이너 타임아웃도 없다**) 서버는 구독자와 `AsyncContext`를 붙든다 = **영구 침묵 + 누수**. `seal()`이 멱등이라 정상 경로와 겹쳐도 안전하다(step2 불변식 6). **이 자리를 지키는 것은 이 step의 항목 19와 변이 M4-14다** — step2의 항목 16·M2-15는 컨트롤러가 없어 `Stream` 쪽 절반만 본다.

콜백 내용:
   - `try { if (sessions.peekSession(token) == null) { seal(); return; } } catch (RuntimeException ex) { seal(); return; }`
   - `s.write(SseHttp.frame("change", "{\"kind\":\"" + kind + "\"}"))` — 반환이 `false`면(클라 끊김) 구독 해제.
   - **payload는 `kind` 한 키뿐이다**(ADR-005 · 계약 A-4가 `deepEqual(['kind'])`로 단언한다).
7. `seal()` = ① `sub.close()`(구독 해제) → ② `s.write(SseHttp.UNAUTHORIZED)` → ③ `s.close()`. **멱등**이어야 한다.
8. `s.onClosed(() -> sub.close())` — 클라 끊김·컨테이너 종료 시 구독 해제(누수 0).

주의:
- **kind JSON 조립은 문자열 이어붙이기 대신 `JsonHttp`가 쓰는 것과 같은 `ObjectMapper`로** 만드는 편이 안전하다. 다만 어휘가 4종 고정이므로 **`Map.of("kind", kind)` 직렬화**를 권장한다(이스케이프 규칙이 한 곳에 모인다).
- 봉인 이후에는 **한 줄도 나가지 않는다**(계약 A-6이 2초 침묵을 단언한다).
- **[② 검토 반영 · 초안 정정] 구독 등록은 ready write보다 _먼저_ 한다.** 초안은 "Node와 같은 순서"를 근거로 ready **뒤**를 지시했는데 그것이 틀렸다: Node는 단일 스레드라 `write(READY)`와 `subscribe` 사이에 **다른 요청이 처리되지 않지만**, Spring은 다른 워커가 동시에 돈다 — GC·선점으로 그 창이 수십 ms 벌어지면 그 사이 트리거의 change가 **구독 부재로 유실**된다. 순서 뒤집기가 안전한 이유는 **prelude 게이트가 순서를 대신 지켜주기** 때문이다(step2): 창에서 온 change는 큐에 적재되고 `endPrelude`가 ready 뒤에 순서대로 흘려보낸다. **따라서 "구독이 ready보다 먼저"와 "ready가 첫 프레임"이 동시에 참이다.**
- **구독 등록·ready·드레인·live 전환은 write monitor 안에서 원자적**이어야 한다(step2 불변식 1). 이 셋 사이로 트리거가 새면 프레임이 유실되거나 ready 앞으로 끼어든다.
- **`endPrelude`를 빼먹으면 스트림이 영원히 침묵한다** — 계약 A-2가 즉시 red다.

### B — `HandlerInventoryTest` 37 → 38

- `IMPLEMENTED_ROUTES`에 `"GET /api/stream"` 추가(알파벳 자리).
- **메서드 이름과 실패 메시지의 수치도 같은 커밋에서** 고쳐라: `exactlyTheThirtySevenImplementedRoutesHaveHandlers` → `...ThirtyEight...`, 메시지의 "37 라우트" → "38 라우트". 수치가 목록과 어긋나면 그 테스트가 주장하는 문장이 거짓이 된다.
- javadoc에 이 phase(74) step4가 `stream`을 추가했다는 사실을 한 줄 남겨라.

### C — `PathPolicyWireTest` 프로브 재조준 (`/api/stream` → `/api/logs/stream`)

- 요청 경로만 바꾸고 **단언(404 + `Content-Type: text/html; charset=utf-8`)은 그대로 둔다**.
- javadoc에 **재조준 이력 3회차**를 추가하고, **다음 이동이 마지막**이라는 사실(step5가 `logs-stream`을 구현하면 인벤토리 안 후보가 0)을 명시하라.
- **단언을 지우거나 405를 허용으로 넓히지 마라.** 그러면 스텁 0을 지키는 와이어 게이트가 사라진다.

### D — `scripts/spring-contract.mjs` scope 표에 1행

`SCOPE`의 `default.files`에 `'contract/cases/default/sse-stream.contract.js'`를 **`session-guard.contract.js` 뒤 · `users.contract.js` 앞**에 넣고, 다른 12행과 같은 형식으로 한 줄 주석을 단다(예: `// phase 74 step4 — GET /api/stream이 붙으면서 green이 됐다(무효화 신호 · 프레임 원문 바이트 · 쿠키 인증 · 동시 2연결 · 봉인)`).

**이 파일에서 그 밖의 어떤 줄도 고치지 마라.**

### E — 테스트 (먼저 작성한다)

`server-spring/src/test/java/harness/news/controller/StreamWireTest.java` 신설(`WireStream` 사용). 최소 항목:

**와이어 형태(계약과 겹치는 축 — 그래도 Java로 먼저 잡는다)**
1. 미인증 → **401** · `Content-Type: application/json; charset=utf-8` · 본문 `{"ok":false,"reason":"unauthenticated"}` · 응답에 `text/event-stream` **0건**.
2. 헤더(`x-session-id`) 인증 → 200 · 헤더 원문 `Content-Type: text/event-stream; charset=utf-8` · `Cache-Control: no-cache` · **`Content-Length` 헤더 부재**.
3. **ready 프레임 원문**: 본문의 **첫 바이트부터** `event: ready\ndata: {"ok":true}\n\n`와 정확히 일치하고 길이 32(앞에 코멘트·패딩이 0이라는 뜻).
4. **쿠키(`sid=`)만으로도 200**(EventSource 실사용 경로 · ADR-005).
5. `Connection` 헤더의 **실측값을 기록**하는 테스트(단언이 아니라 관측): 나가면 그 원문을, 안 나가면 그 사실을 남긴다. 계약 미관측 축이므로 **컨테이너를 뚫어서 맞추지 마라**(divergence로 forward_notes에 기록).

**신호(계약과 겹치는 축)**
6. change 4종 — 스트림을 연 뒤 실제 요청으로 create/lock/update/status를 트리거해 각각 프레임이 도착하고 **payload 키가 `kind` 하나**임을 단언.
7. **동시 연결 2개**가 트리거 1회에 둘 다 받는다.

**계약이 구조적으로 못 보는 축 — 여기가 이 step의 진짜 방어선이다**
8. **비연장 peek**: 시계를 주입해 세션 만료 직전까지 밀고 push를 여러 번 발생시킨 뒤, **만료 시각이 밀리지 않았음**을 단언한다(예: 만료 경계를 넘긴 뒤 `GET /api/session`이 401). `touchSession`으로 바꾸면 red여야 한다.
9. **fail-closed**: `peekSession`이 예외를 던지는 상황(주입된 가짜 세션 가드 등)에서 그 신호를 **쓰지 않고** `unauthorized` 1회 후 종료한다.
10. **봉인**: 세션 무효화(로그아웃) 후 트리거 → `unauthorized` 1회 → 이후 2초 동안 **프레임 0건**(`awaitSilence`).
11. **구독 누수 0** — 두 경로를 **다르게** 단언한다(② 검토 반영).
    - (a) **정상 종료**: 스트림 5개를 열고 전부 정상으로 닫으면 `ChangeBus.subscriberCount()`가 **즉시 0**이다.
    - (b) **소켓 강제 끊김**: 종료 프레임 없이 소켓을 끊은 뒤에는 **`changeBus.publish(...)`를 1회 발생시킨 다음** `subscriberCount()`가 **0**임을 단언한다. **"끊자마자 0"으로 단언하지 마라** — `AsyncContext.setTimeout(0)`(무한)이라 Tomcat이 `onError`/`onComplete`를 **바로 내지 않을 수 있고**, 그러면 해제는 다음 write 실패(`IOException` → `false` → 자기 봉인) 시점까지 지연된다. 그 지연은 **결함이 아니라 이 설계의 회수 경로**다(decisions (12)).
    - (c) **`onError`/`onComplete`가 실제로 발화하는지 실측해 기록**하라(단언이 아니라 관측). 발화하면 (b)의 publish 없이도 0이 될 것이고, 안 하면 publish가 유일한 회수 트리거다. **어느 쪽이든 divergence로 forward_notes에 남긴다** — 컨테이너 동작에 의존하는 자리를 숨기지 마라.
12. **워커 점유 0** — **테스트 컨텍스트에 워커 상한을 낮춰 구성한다**(② 검토 반영: 기본 `max-threads=200`에서 "최소 10건"은 **블로킹 구현도 통과**하는 공허한 AC다). `@SpringBootTest(properties = "server.tomcat.threads.max=5")`(또는 이 리포의 기존 프로퍼티 주입 선례와 같은 방식) 아래에서 **스트림을 워커 수보다 많이**(예: 8개) 열어 둔 채 다른 라우트 요청이 정상 응답함을 단언한다. **스트림 수 > 워커 수**가 이 테스트의 전부다 — 그 관계가 깨지면 다시 공허해지므로 상수 두 개를 나란히 두고 `assertTrue(STREAMS > MAX_THREADS)`를 테스트 안에 박아라(공허화 방지 자기 단언).
13. **구독 콜백이 응답을 뒤집지 않는다**: 구독자 write가 실패하는 상태에서 트리거 요청이 여전히 200이다.
14. **응답 위생**: 200 응답 전문·헤더에 **64-hex 세션 토큰 0건** · 드라이브 문자로 시작하는 절대경로 0건.

**replay-gate — 계약이 재현성 있게 red를 내는 축이므로 Java로 먼저 잡는다(② 검토 반영)**

15. **등록 창 유실 0(경합 반복)**: 스트림을 여는 요청과 **동시에** 다른 스레드가 `changeBus.publish("create")`를 계속 쏘는 구성을 만들고, **최소 200회 반복**한다. 매 반복에서 ① ready 수신 후 발행된 change가 **전부 도착**하고 ② 유실 0이다. **1회 실행은 증거가 아니다** — 한가한 환경에서 창이 좁아 우연히 통과한다. 반복 횟수와 관측된 유실 수를 summary에 수치로 적어라.
16. **ready가 첫 프레임(경합 하)**: 위와 같은 경합에서 본문의 **첫 32바이트가 항상 ready 프레임**이고 change 프레임이 그 앞에 오지 않는다.
17. **드레인 순서**: 창에서 발생한 change가 여러 건이면 **발생 순서대로** 도착한다.
18. `HandlerInventoryTest` 38행 green.
19. **예외 경로 봉인(step2 불변식 6의 컨트롤러 절반)**: `open()` 성공 뒤 `endPrelude` 도달 전에 `RuntimeException`이 나는 상황을 주입하고(예: 구독 등록·`writePrelude` 경로가 던지도록 협력자를 스텁) ① 스트림이 **봉인·종료**되고(클라이언트가 무한 대기하지 않는다) ② `ChangeBus.subscriberCount()`가 **0**으로 돌아옴을 단언한다. **"헤더만 나가고 영원히 침묵 + 구독 누수"가 남지 않는다**는 것이 이 항목의 전부다. `setTimeout(0)`이라 **컨테이너가 대신 정리해 주지 않는다.**

## Acceptance Criteria

```bash
# 1) Java 전체
cd /d/agents/harness/server-spring && JAVA_HOME="D:/agents/tools/jdk-25.0.4.1+1" ./mvnw -B clean verify
#   기대: BUILD SUCCESS · Tests run: <step3 종료 수치 + 신규 N> · Failures 0 · Errors 0 · Skipped 0

# 2) jar 갱신 후 계약 — **이 step의 green 지점**
cd /d/agents/harness/server-spring && JAVA_HOME="D:/agents/tools/jdk-25.0.4.1+1" ./mvnw -B -q package -DskipTests
cd /d/agents/harness && SPRING_JAVA_HOME="D:/agents/tools/jdk-25.0.4.1+1" node scripts/spring-contract.mjs --profile default
#   기대: exit 0 · default files=13 · cases가 194에서 늘어난다(실측해 기록)

# 3) 패리티
cd /d/agents/harness && SPRING_JAVA_HOME="D:/agents/tools/jdk-25.0.4.1+1" node scripts/spring-contract.mjs --parity
#   기대: exit 0 · profiles=5 · **306관측 diffs 0**(default 229 → **239** · minimal 55 · auth-negative 4 · failclosed 5 · prod-cookie 3)
#   default covered=29/39 → **30/39**
#   (수치가 다르면 실측값을 기록하고 index.json baseline·step5·step6 기대치를 갱신하라)

# 4) 자기 결정성
cd /d/agents/harness && SPRING_JAVA_HOME="D:/agents/tools/jdk-25.0.4.1+1" node scripts/spring-contract.mjs --dual-run
#   기대: exit 0 · 306관측 diffs 0

# 5) 무접촉 경로 · ADR-008 게이트 0줄 · RoutePolicy 0줄
git diff --stat -- contract docs/api-contract scripts/contract-run.mjs scripts/contract-diff.mjs server src web client test package.json spikes
git diff --stat -- server-spring/src/test/java/harness/news/config/Adr008DisciplineTest.java
git diff --stat -- server-spring/src/main/java/harness/news/web/RoutePolicy.java
#   기대: 셋 다 출력 없음

# 6) scope 표는 1행만 늘었다
git diff -- scripts/spring-contract.mjs
#   기대: 추가 2줄(주석 1 + 파일 경로 1)뿐
```

**종료 조건 — 변이 전건 결과표를 summary에 기록한다. 미기록 시 이 step은 미완이다.**

## 검증 절차 (변이)

| 변이 | 심는 곳 | 기대 |
|---|---|---|
| M4-1 | change payload에 `articleId` 키 추가 | **계약 A-4 red**(`deepEqual(['kind'])`) — ADR-005 (a) "행 데이터 없음"이 계약으로 관측 가능하다는 실증 |
| M4-2 | push 재검증을 `peekSession` → `touchSession` | **Java 항목 8 red · 계약은 green** — ADR-005 (b)가 계약이 못 보는 축이라는 실증. 두 결과를 **모두** 표에 적어라 |
| M4-3 | ready 프레임 종결자를 `\n` 하나로 | 계약 `frame-bytes`(`ready-raw-bytes`) red |
| M4-4 | `SseHttp.write`의 flush 제거 | **계약 A-2·A-4 타임아웃 red**(step2 M2-5의 이월 — 여기서 비로소 red가 난다) |
| M4-5 | Content-Type을 `response.setContentType(...)`로 | `--parity` diff ≥ 1(SSE 관측 전부) |
| M4-6 | 구독 해제(`onClosed`) 제거 | Java 항목 11(누수 0) red |
| M4-7 | 봉인 후에도 프레임을 계속 씀 | 계약 A-6 red(2초 침묵 단언) |
| M4-8 | 미인증에도 스트림을 열고 오류 프레임을 보냄 | 계약 A-1 red(`doesNotMatch(text/event-stream)`) |
| M4-9 | `StreamController.java`에 `@Scheduled(fixedDelay=30000)` heartbeat | `Adr008DisciplineTest` **red**(예외 4파일이 아니다) — ADR-015의 "타이머 0"이 기계로 지켜진다는 실증 |
| M4-10 | scope 표에서 `sse-stream.contract.js` 행 삭제 | `HandlerInventoryTest` **green**이고 `--parity`가 **296관측**으로 조용히 줄어든다(exit 0) — 73 변이 F 승계. **기계 증거는 관측 수뿐**임을 기록하라 |
| M4-11 | **replay-gate 우회** — 구독 등록을 `endPrelude` **뒤**로 옮긴다(= 초안의 "ready write 뒤 구독" 순서로 되돌린다) | **Java 항목 15 red**(동시 트리거 하 유실). **주의: 한가한 환경에서는 창이 좁아 red가 안 날 수 있다** — 항목 15가 지정한 반복 횟수(≥200회)를 반드시 돌려라. 1회 실행으로 green이 나왔다고 "잡힌다"고 적지 마라 |
| M4-12 | `s.writePrelude(READY)`를 `s.write(READY)`로(= ready가 큐에 들어가 순서가 흐트러진다) | **Java 항목 16 red**(ready가 첫 프레임이 아니다) · 계약 A-3(`ready-raw-bytes`)도 red |
| M4-13 | `endPrelude(...)` 호출 자체를 삭제 | **계약 A-2 즉시 red**(스트림이 영원히 침묵 → `waitFor` 10초 타임아웃) — 게이트를 빼먹으면 조용하지 않다는 실증 |
| M4-14 | `StreamController`의 `try { ... } catch (RuntimeException ex) { seal(); }`를 제거해 `endPrelude` 전 예외가 그대로 빠져나가게 함 | **항목 19 red** — 스트림이 봉인되지 않아 클라이언트가 무한 대기하고 `ChangeBus.subscriberCount()`가 0으로 안 떨어진다. `setTimeout(0)`이라 **컨테이너가 대신 정리해 주지 않는다**는 사실을 결과에 명시하라(step2 M2-15는 `Stream` 쪽 절반만 본다 — 이 변이가 컨트롤러 절반이다) |

각 변이는 green→red→green 3단계를 기록하고, 원복 후 `cmp` byte-identical + `git status --porcelain` 무변을 확인하라.

## 금지사항

- **`RoutePolicy`를 고치지 마라.** 이유: `stream`은 이미 `AuthClass.SESSION`으로, `logs-stream`은 `ADMIN`으로 등재돼 있다. 고치면 두 라우트의 인가 등급이 계약과 갈린다.
- **스트림을 연 뒤 401/403을 프레임으로 보내지 마라.** 이유: 계약이 `assert.doesNotMatch(ct, /text\/event-stream/)`으로 명시 금지했다("열고 나서 오류 프레임을 보내는 구현은 위반이다").
- **push 시점에 `touchSession`을 쓰지 마라.** 이유: 열린 스트림이 세션 유휴 만료를 무한 연장한다(ADR-005·ADR-007 명시). 계약이 못 보는 축이라 Java 테스트가 유일 방어선이다.
- **peek 예외를 `SessionGuard`에서 잡지 마라.** 이유: HTTP 라우트의 DB 예외가 500 대신 401로 바뀌는 광범위한 동작 변화가 생긴다(Node 주석이 명시한 자리다). 잡는 곳은 **구독 콜백 안**이다.
- **change payload에 도메인 데이터(articleId·title·status 등)를 싣지 마라.** 이유: ADR-005의 결정 그 자체다 — 역할별 데이터 노출 회피가 이 설계의 존재 이유다.
- **heartbeat·`retry:`·`id:`·초기 코멘트를 넣지 마라.** 이유: Node 원문에 없고(실측), 계약이 첫 바이트부터 대조하며, heartbeat는 앱 내 타이머라 ADR-008·ADR-015 위반이다.
- **`HandlerInventoryTest` 목록만 늘리고 scope 표를 안 늘리지 마라.** 이유: 그 조합은 두 게이트 모두 green인 채 관측만 줄어드는 조용한 통과다(M4-10이 실증한다).
- **프로브 단언(404 + `text/html`)을 지우거나 405를 허용으로 넓히지 마라.** 이유: 스텁 0을 지키는 유일한 와이어 게이트다.
- **`contract/**`·`docs/api-contract/**`·`scripts/contract-run.mjs`·`scripts/contract-diff.mjs`·`server/**`·`src/**`·`web/**`·`client/**`·`test/**`·`package.json`·`spikes/**`를 고치지 마라.**
- **`git add -A`를 쓰지 마라** — 명시 경로만.
