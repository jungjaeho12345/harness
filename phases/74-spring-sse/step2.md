# Step 2: sse-wire

## 읽어야 할 파일

**계획 문서**
- `phases/74-spring-sse/index.json` — `decisions` (3)(4)(9)(10)·`open_questions` (1)(2)(3).
- `phases/74-spring-sse/step0.md` — 「배경」의 **금지 철자 목록** · ADR-015 요지.

**아키텍처 정본**
- `docs/ADR.md` — **ADR-013 ④**(와이어 바이트가 합격 기준 · Content-Type 재조립 실측) · **ADR-015**(step0 신설).
- `docs/api-contract/sse.md` — 「응답 헤더 3종 + 즉시 flush」·「프레임 문법」·「이벤트 어휘 4종(바이트 예시)」 절 **전문**.

**계약 (읽기만 — 무수정)**
- `contract/cases/default/sse-stream.contract.js` **전문**. 특히 `READY_FRAME` 상수와 `readRawFirstFrame`(원문 바이트를 `startsWith`로 대조한다)·`UNAUTHORIZED_DATA`.
- `contract/lib/sse.js` — `openStream`이 `\n\n` 경계로 프레임을 자르고 `waitFor`가 250ms 폴링으로 조건 대기한다는 사실.

**Spring 현행 (선례 — 반드시 읽어라)**
- `server-spring/src/main/java/harness/news/web/RawContentType.java` **전문** — 왜 서블릿 API를 쓰지 않는가, seam이 없으면 **던진다**(폴백 금지)는 규율.
- `server-spring/src/main/java/harness/news/web/CoyoteResponseValve.java` — 생성자가 `super(true)`(비동기 지원)라는 사실.
- `server-spring/src/main/java/harness/news/web/JsonHttp.java` — 첫 번째 와이어 지점의 형태(`CONTENT_TYPE` 상수 · `RawContentType.set(request.getAttribute(...), ...)` 순서).
- `server-spring/src/test/java/harness/news/web/RawContentTypeTest.java` — seam 없음 → 예외를 어떻게 단언하는지.
- `server-spring/src/test/java/harness/news/testsupport/Wire.java` **전문** — **이 헬퍼는 SSE에 못 쓴다**(`Connection: close` + EOF까지 읽기라 스트림에서 영원히 블록한다). 새 헬퍼가 필요한 이유의 근거다.
- `server-spring/src/main/java/harness/news/web/WebConfig.java` — 필터 등록(`FilterRegistrationBean`)이 비동기를 지원하는지 확인할 자리.

**직전 step 산출물**
- `server-spring/src/main/java/harness/news/service/ChangeBus.java`(step0) · `LogService`의 구독 API(step1) — 이 step이 만드는 web층 프리미티브의 소비자다.

## 배경 (동결된 사실 — Node 원문 실측 2026-08-29)

계획 단계에서 **리포 밖 프로브로 raw 소켓 관측**한 Node의 응답 원문이다(추정이 아니다).

### `GET /api/stream` 200 (세션 헤더 인증)

```
HTTP/1.1 200 OK
... (helmet 보안 헤더 11종 — Spring에는 없다: ADR-013의 기존 공백, 이 phase 범위 밖)
Vary: Origin
Access-Control-Allow-Credentials: true
Content-Type: text/event-stream; charset=utf-8
Cache-Control: no-cache
Connection: keep-alive
Date: ...
Transfer-Encoding: chunked

20\r\n
event: ready\n
data: {"ok":true}\n
\n
\r\n
```

확정 사실:
- **`Content-Length`가 없고 `Transfer-Encoding: chunked`다.**
- **첫 청크 크기가 `0x20` = 32바이트**이고 그것이 ready 프레임 전체다: `event: ready\n`(13) + `data: {"ok":true}\n`(18) + `\n`(1) = **32**. 즉 **프레임 하나가 청크 하나** = Node는 `res.write` 때마다 flush한다.
- **초기 코멘트(`: ...`)·`id:`·`retry:`·heartbeat·패딩이 전부 0건**이다. 계약이 `raw.startsWith(READY_FRAME)`로 **첫 바이트부터** 대조하므로 앞에 무엇이든 붙이면 즉시 red다.
- 개행은 **LF(`\n`)만**이다(`\r` 0). 청크 프레이밍의 `\r\n`은 HTTP 계층이지 SSE 프레임이 아니다.
- `/api/logs/stream`(Z)도 **헤더 3종이 완전히 동일**하고, ready 뒤에 `event: log` 프레임이 각각 자기 청크로 이어졌다.

### 열기 전 거부 (401/403)

```
HTTP/1.1 401 Unauthorized
Content-Type: application/json; charset=utf-8
Content-Length: 39
ETag: W/"..."
Connection: keep-alive
Keep-Alive: timeout=5

{"ok":false,"reason":"unauthenticated"}
```
- 403(비-Z)도 동형이며 본문은 `{"ok":false,"reason":"forbidden"}`(33바이트)다.
- **SSE 헤더가 전혀 나가지 않는다.** 계약이 `assert.doesNotMatch(ct, /text\/event-stream/)`로 이것을 금지한다.

### 계약 리포트가 실제로 보는 헤더

`contract/lib/record.js`의 `ALLOWED_HEADERS`에 `connection`·`transfer-encoding`이 **없다**. 계약 케이스는 `headers: ['content-type','cache-control']`만 싣는다. 따라서 **`Connection`·`Transfer-Encoding`·helmet 헤더는 패리티 판정 대상이 아니다** — 그래도 `Connection: keep-alive` 설정을 시도하고 실측 결과를 기록하라(open_questions (1)).

### 종료 프레임 (Node `server/index.js` 423행 리터럴)

```
event: unauthorized\ndata: {"ok":false,"reason":"unauthenticated"}\n\n
```

### 하네스가 스트림을 어떻게 관측하는가 (조사 결과)

- 러너는 `node --test --test-concurrency=1 <files>`로 케이스 파일을 **순차** 실행한다 → 스트림 케이스끼리 겹치지 않는다.
- `--timeout`(기본 45000)은 **단계 대기**(서버 기동·헬스체크)지 테스트 실행 한도가 아니다. 러너는 테스트 자식이 `close`될 때까지 기다린다 → **케이스가 스트림을 닫지 않으면 러너가 끝나지 않는다**(케이스는 `finally`에서 닫는다).
- `openStream`은 `fetch`가 **헤더를 받는 순간** 반환한다 → 서버가 헤더를 flush하지 않으면 `timeoutMs`(15000)에 abort된다.
- `waitFor`는 250ms 폴링 상한으로 프레임 도착을 기다린다(케이스 한도 `WAIT_MS = 10000`) → **프레임마다 flush하지 않으면 전 change 케이스가 타임아웃 red**다.

### 이 step이 ADR-008 정적 게이트 2군과 정면으로 만난다 (JDK 25 기준선 · 2026-08-30)

`SseHttp`는 **서블릿 비동기**(`startAsync` · `AsyncContext` · `AsyncListener`)를 쓰는 이 리포의 **유일한 main 코드**다. 즉 `Adr008DisciplineTest`의 **2군(비동기·재시도)** 패턴 바로 옆을 지나간다. 두 가지를 구분하라.

- **허용(패턴에 없고 취지에도 맞다)**: `AsyncContext` · `startAsync` · `AsyncListener` · `setTimeout(0)` · `synchronized` · `Atomic*` · `CopyOnWriteArrayList`. 이것들은 **앱이 스스로 깨어나게 하지 않는다** — 컨테이너가 커넥션을 잡고 있을 뿐이고 쓰기는 트리거 요청 스레드가 한다(ADR-015).
- **금지(패턴에 걸린다)**: `ExecutorService`·`CompletableFuture`·`new Thread(`·`Thread.startVirtualThread(`·`CountDownLatch`·`.await(`·`Thread.sleep(`·`@Async` 등 step0 「금지 철자」 전건. 비동기 코드를 쓰다 보면 손이 가는 자리다 — **가지 마라**.
- **게이트가 못 잡지만 역시 금지(JDK 25 신규 표면 · 계획 단계 실측: `Adr008DisciplineTest` 908행 전문에 0건)**: `StructuredTaskScope`(`open()`/`fork()`/`join()`) · `ScopedValue`(`where(...).run(...)`) · `Subtask`. **게이트 통과는 허가가 아니다.** 이 공백의 조사·기록은 step6 작업 G가 소유하고, **이 step은 게이트 파일을 0줄 고친다**.

이 사실은 아래 D 항목 8(정적 스캔)이 기계로 잠근다 — 스캔 목록에 **JDK 25 신규 철자 3종을 반드시 포함**하라.

## 작업

### A — main `harness/news/web/SseHttp.java` 신설 (두 번째 와이어 지점)

**패키지는 반드시 `harness.news.web`**이다 — `RawContentType`이 패키지-프라이빗이라 다른 패키지에서는 접근할 수 없고, 접근하려고 `public`으로 넓히거나 리플렉션을 쓰면 seam 규율이 무너진다.

```java
package harness.news.web;

public class SseHttp {

    /** Node(express res.setHeader + charset 부착)가 보내는 문자열 원문. 세미콜론 뒤 공백까지 계약이다. */
    public static final String CONTENT_TYPE = "text/event-stream; charset=utf-8";

    /** "event: <e>\ndata: <d>\n\n" 의 UTF-8 바이트. 순수 함수 — 골든 벡터로 잠근다. */
    public static byte[] frame(String event, String data);

    /** 접속 직후 1회. 두 스트림 공통. */
    public static final byte[] READY;        // frame("ready", "{\"ok\":true}")
    /** 종료 신호 1회 후 연결을 끝낸다. */
    public static final byte[] UNAUTHORIZED; // frame("unauthorized", "{\"ok\":false,\"reason\":\"unauthenticated\"}")

    /** 헤더를 바이트 그대로 쓰고 200을 커밋한 뒤 비동기 컨텍스트를 연다. */
    public Stream open(HttpServletRequest request, HttpServletResponse response);

    public interface Stream extends AutoCloseable {
        /**
         * 프레임 1개를 쓰고 flush한다. 실패(끊김·닫힘)면 false를 돌려주고 스스로 봉인한다. 절대 던지지 않는다.
         * <b>prelude 구간이면 쓰지 않고 큐에 적재한다</b>(아래 「replay-gate」). 그때도 true를 돌려준다.
         */
        boolean write(byte[] frame);

        /** 위와 같되 드레인 시 중복 제거에 쓸 순서키를 함께 적재한다(로그 스트림의 seq). */
        boolean write(byte[] frame, long orderKey);

        /** prelude 구간에서 <b>호출자가 직접</b> 쓴다(큐를 거치지 않는다). ready·replay가 이 경로다. */
        boolean writePrelude(byte[] frame);

        /**
         * prelude를 닫는다. write monitor를 잡은 채 ① 큐에서 {@code orderKey <= dropOrderKeyUpTo}인
         * 항목을 버리고 ② 나머지를 <b>적재 순서대로</b> 쓰고 ③ live 모드로 전환한다. <b>멱등</b>.
         * 중복 제거가 필요 없으면 어떤 항목도 버리지 않는 값을 넘긴다.
         */
        void endPrelude(long dropOrderKeyUpTo);

        boolean isOpen();
        /** 멱등 — 여러 번 불러도 complete()는 1회. */
        @Override void close();
        /** 연결 종료(클라 끊김·컨테이너 종료)를 통지받을 콜백을 등록한다(구독 해제용). */
        void onClosed(Runnable callback);
    }
}
```

#### replay-gate (**이 phase의 핵심 동시성 규율 — 두 라우트가 모두 이것에 의존한다**)

**문제(2026-08-30 ② 검토가 지목)**: Node는 단일 스레드라 "ready를 쓰고 → 구독한다" 사이에 **다른 요청이 처리되지 않는다**. Spring은 **다른 워커가 동시에 돈다** — 그 창(로그 스트림의 replay는 최대 2000 write로 수십~수백 ms다) 동안 발생한 신호·로그가 **구독 부재로 유실**된다. `contract/lib/sse.js`의 규약은 **"ready 수신 = 구독 완료"를 전제**하는데 그 전제는 Node에서만 참이다.

> **[② 재검토 정정 — 중요] 계약은 이 축을 잡지 못한다. "계약 B-4가 red"는 거짓이다.** 초안 계획은 "구독을 뒤로 미루면 `logs.contract.js` B-4가 10초 타임아웃 red"라고 적었으나 **실측은 반대다**: ① `contract/cases/default/logs.contract.js` **170~178행**이 `seqBefore = maxLogSeq(s.frames)`를 ready 직후 샘플링하고 **그 자리 주석이 "replay 잔여가 늦게 도착할 수 있어 '새 라인 도착'의 **하한만** 본다"**고 명시한다 — 아직 안 온 replay 프레임(seq 오름차순)이 `seq > seqBefore`를 그대로 충족한다. ② `server-spring/src/main/java/harness/news/web/RequestLogFilter.java` **44~52행**은 **async 가드가 없는 plain `Filter`**라 `finally`가 컨트롤러 반환 직후 돌고, **SSE 요청 자신의 액세스 로그**가 (유실 버그가 있는 순서에서도 subscribe 이후에) 발행돼 **항상 새 seq를 만든다**. 따라서 **유실 창을 지키는 유일 방어선은 step5 항목 7(b)(d)의 Java 경합 테스트**다. 이 리포가 반복 확인한 패턴이다(72 송고 훅 status·73 키 유출도 계약이 못 보는 축이었다) — **거짓으로 "계약이 잡는다"고 적으면 다음 사람이 없는 방어선을 믿는다.**

**해법**: `open()`이 만든 `Stream`은 **prelude 모드**로 시작한다.
- **prelude 모드에서 `write(...)`는 쓰지 않고 인스턴스 큐에 적재**한다(구독 콜백이 이 경로로 들어온다).
- **`writePrelude(...)`는 큐를 거치지 않고 즉시 쓴다**(컨트롤러가 ready·replay를 이 경로로 쓴다).
- **`endPrelude(dropUpTo)`가 write monitor 안에서 드레인 + 모드 전환을 원자적으로** 한다.

**불변식(어기면 GREEN A/B가 재현성 있게 깨진다)**:
1. **모드 검사·큐 적재·드레인·모드 전환·`writePrelude`·`close`가 전부 같은 write monitor 안에서 일어난다.** 그래야 동시 트리거의 `write`가 **드레인 전이면 큐에 들어가고, 드레인 후면 직행**한다 — 둘 사이로 새는 경로가 없다. **`writePrelude`도 예외가 아니다**(② 재검토 지적): 다른 스레드의 `close()`와 경합할 수 있으므로 같은 monitor를 잡고, **이미 닫혔으면 `false`를 돌려주고 던지지 않는다**(`write`와 같은 규율 — 이 메서드도 결국 요청 스레드에서 불린다).
2. **드레인은 적재 순서(FIFO)를 보존**한다.
3. `endPrelude`는 **멱등**이고, prelude 중 `close()`가 일어나면 큐를 버리고 끝낸다(닫힌 응답에 쓰지 않는다).
4. **`endPrelude`를 부르지 않으면 스트림은 영원히 아무것도 내보내지 않는다** — 컨트롤러가 반드시 부른다. 이 사실을 javadoc에 적어라. **그리고 `setTimeout(0)`(무한)이라 컨테이너 타임아웃도 없다** — 즉 `open()`~`endPrelude` 사이에서 예외가 나 그냥 빠져나가면 **영구 침묵 + 구독·`AsyncContext` 누수**다. **그래서 두 컨트롤러는 그 구간 전체를 `try { ... } catch (RuntimeException ex) { seal(); }`로 감싼다**(불변식 6).
5. **큐는 유한하다.** 상한 `PRELUDE_MAX`(기본 결정: **4096 프레임**)를 두고 초과 시 **가장 오래된 것을 버리며** 버린 수를 테스트 관측용 카운터로 노출한다. **drop-oldest가 맞는 방향인 이유**: 큐는 seq 오름차순이라 **가장 오래된 것이 곧 `endPrelude(lastReplayedSeq)`가 어차피 버릴 중복 후보**와 겹친다.
   - **[② 재검토 반영 — 메모리 상한을 수치로 적어라] 스트림당 상한만 있고 총량 상한은 없다.** 로그 프레임 1건은 `event: log\ndata: {…5키…}\n\n`이고 `line`이 대부분을 차지한다 — **구현 시 실측한 평균/최악 프레임 바이트로 `PRELUDE_MAX × 프레임바이트`를 계산해 「스트림당 최악 N MiB」를 §A javadoc과 summary에 수치로 남겨라**(개략: 프레임 1 KiB 가정 시 스트림당 약 4 MiB). **그리고 동시 연결 상한이 없으므로**(`excluded (d)` · Node `setMaxListeners(0)` 동형) **총량은 `연결 수 × 그 수치`로 무한**이다. 이 사실과 드롭 경로가 **미검증**이라는 사실을 step6 `forward_notes` 6·6b(ii)에 넣어라. **여기서 연결 상한을 도입하지 마라** — `excluded (d)`가 배제한 축이고 `sse.md`가 "구독자 수 제한이 없다"로 동결했다.
6. **`open()`이 성공한 뒤 `endPrelude`에 도달하기 전에 예외가 나면 반드시 봉인한다.** 컨트롤러가 `try/catch(RuntimeException)` → `seal()`(구독 해제 → `close()`)로 감싼다. 이유: 불변식 4의 두 번째 문장 — 안 그러면 클라이언트가 헤더만 받고 **영원히 기다리며** 서버는 구독자와 `AsyncContext`를 붙든다. `seal()`이 멱등이므로 정상 경로와 겹쳐도 안전하다.

**금지**: prelude를 `Thread.sleep`·`CountDownLatch`·`.await(`·별도 스레드로 구현하지 마라(전부 금지 철자다). 이것은 **순수한 상태 플래그 + 큐 + `synchronized`**로 끝난다.

`open()`의 정확한 순서(어기면 헤더가 갈리거나 스트림이 안 열린다):
1. `RawContentType.set(request.getAttribute(RawContentType.REQUEST_ATTRIBUTE), CONTENT_TYPE)` — **seam이 없으면 던진다**(폴백 금지 · `JsonHttp.write`와 같은 규율).
2. `response.setStatus(200)`.
3. `response.setHeader("Cache-Control", "no-cache")`.
4. `Connection: keep-alive` 설정을 **시도**하고 실제로 와이어에 나가는지 step4의 와이어 테스트로 실측한다(Tomcat이 hop-by-hop 헤더를 자체 관리하면 무시되거나 중복될 수 있다 — 계약 미관측이므로 **컨테이너를 뚫어서 맞추지 마라**. 결과를 divergence로 기록한다).
5. **`setContentLength`를 부르지 마라** — chunked여야 한다.
6. `AsyncContext ctx = request.startAsync(); ctx.setTimeout(0);` (0 = 무한 · open_questions (2)의 기본 결정).
7. `ctx.addListener(...)`로 `onComplete`/`onError`/`onTimeout`에 정리 훅을 건다.
8. `response.getOutputStream().write(READY)` **는 여기서 하지 않는다**(호출자가 첫 프레임을 정한다 — logs 스트림은 ready 뒤 replay가 붙는다). 대신 `open()`이 **헤더를 flush**해 200이 즉시 나가게 한다(`response.flushBuffer()`).
9. **반환되는 `Stream`은 prelude 모드다**(위 「replay-gate」). 컨트롤러가 `endPrelude(...)`를 부르기 전까지 `write(...)`는 큐에 적재된다.

`write(byte[])`의 규칙:
- `OutputStream.write(frame)` → **즉시 flush**. 하나라도 빼면 계약 `waitFor`가 10초 타임아웃으로 red다.
- `IOException`(클라 끊김)·이미 닫힘이면 **예외를 던지지 말고** `false`를 돌려주고 내부적으로 `close()`한다. 이유: 이 메서드는 **트리거 요청의 스레드**에서 불린다 — 예외가 새면 성공한 저장이 500으로 뒤집힌다(Node `server/index.js` 1144~1150 주석).
- 동시 write에 대해 **스트림 인스턴스 단위로 직렬화**한다(`synchronized`). 두 트리거가 동시에 같은 스트림에 쓰면 프레임이 섞인다. `ReentrantLock`의 `Condition.await()`는 금지 철자다 — `synchronized`를 써라.

`close()`의 규칙:
- 멱등(플래그). `AsyncContext.complete()`를 **정확히 1회**.
- `onClosed` 콜백을 1회 호출한다(구독 해제 지점).
- **`close()`는 종료 프레임을 쓰지 않는다** — `unauthorized` 프레임을 쓸지는 호출자(컨트롤러)가 정한다. Node는 `createSseCloser.close()`가 ① 구독 해제 → ② `UNAUTHORIZED_FRAME` write → ③ `res.end()` 순서다. 그 조립은 step4/step5의 컨트롤러가 한다.

**절대 하지 마라**: `SseEmitter`·`ResponseBodyEmitter`·`StreamingResponseBody`·`@ResponseBody` 반환·메시지 컨버터. 이유는 아래 「금지사항」.

### B — 비동기 배선 확인 (코드 변경이 필요할 수도 있다)

`request.startAsync()`는 **디스패처 서블릿과 체인의 모든 필터**가 `asyncSupported=true`여야 동작한다. 아니면 `IllegalStateException`이 난다.
1. `WebConfig`의 `register(...)`가 만드는 `FilterRegistrationBean`의 `asyncSupported` 기본값을 **실측으로 확인**하라(코드를 읽고, 그리고 실제로 `startAsync()`가 되는지 step4에서 와이어로 확인한다).
2. 기본값이 `true`면 **아무것도 고치지 마라**. `false`면 5개 필터 전부에 명시적으로 `setAsyncSupported(true)`를 걸고, 그 변경이 기존 37 라우트의 동작을 바꾸지 않음을 `FilterWiringTest`로 잠가라.
3. `CoyoteResponseValve`는 이미 `super(true)`다(변경 불필요).
4. **`@EnableWebMvc`를 도입하지 마라** — Boot 기본 MVC 설정이 통째로 꺼져 기존 라우트가 함께 움직인다(`WebConfig` javadoc의 경고).

### C — 테스트 지원 `WireStream` 신설

`server-spring/src/test/java/harness/news/testsupport/WireStream.java`.

```java
public final class WireStream implements AutoCloseable {
    /** 소켓을 열어 요청을 보내고 응답 헤더까지 읽는다. 소켓은 닫지 않는다(스트림 유지). */
    public static WireStream open(int port, String path, Map<String,String> headers);
    public int status();
    /** 헤더 원문 줄 전체(예: "Content-Type: text/event-stream; charset=utf-8"). */
    public String line(String name);
    public List<String> headerLines();
    /** 지금까지 받은 본문 원문(청크 해독 후). 종결자 검사용. */
    public String rawBody();
    /** 조건 프레임이 deadline 안에 도착하면 반환, 아니면 null(throw 아님). */
    public Frame awaitFrame(Predicate<Frame> predicate, Duration timeout);
    /** deadline 동안 새 프레임이 하나도 오지 않으면 true(봉인 단언용). */
    public boolean awaitSilence(Duration timeout);
    public record Frame(String event, String data) {}
    @Override public void close();
}
```

규율:
- **`Wire`를 고치지 마라.** 기존 37 라우트의 관측 도구다 — 스트림 지원을 끼워 넣으면 그 도구가 두 모드를 갖게 되고, 한쪽만 맞아도 통과하는 자리가 생긴다.
- 요청은 `Connection: keep-alive`로 보내고 **EOF를 기다리지 않는다**. 읽기는 데드라인 기반이며 타임아웃은 `null`/`false`로 표현한다(throw 금지 — 실패는 케이스의 단언이 표현한다).
- 청크 해독을 하되 **`rawBody()`는 SSE 프레임 원문**(LF 포함)을 그대로 보존한다 — `\n\n` 종결자 검사가 이 위에서 이뤄진다.
- 헤더 이름·값의 **원문 대소문자와 공백을 보존**한다(`Wire`와 같은 이유 — 도구가 문자열을 만지면 판정이 무의미해진다).
- 모든 테스트는 `try (WireStream s = ...)`로 감싸 반드시 닫는다(소켓 누수 → surefire가 끝나지 않는다).

### D — 테스트 (먼저 작성한다)

`server-spring/src/test/java/harness/news/web/SseHttpTest.java` 신설.

최소 항목:
1. **골든 바이트** — `frame("ready","{\"ok\":true}")`가 정확히 `event: ready\ndata: {"ok":true}\n\n`의 UTF-8이고 **길이가 32**다.
2. `READY`가 위와 byte-identical · `UNAUTHORIZED`가 `event: unauthorized\ndata: {"ok":false,"reason":"unauthenticated"}\n\n`와 byte-identical.
3. `frame`이 만든 바이트에 **`\r`가 0개**이고 **정확히 `\n\n`으로 끝난다**.
4. `frame("change","{\"kind\":\"create\"}")` 등 4어휘 골든 벡터.
5. 비-ASCII data(한글)가 **UTF-8**로 인코딩된다(플랫폼 기본 charset을 쓰지 않는다).
6. `CONTENT_TYPE`이 정확히 `"text/event-stream; charset=utf-8"`이다 — 세미콜론 뒤 **공백 1개** · 소문자 `utf-8`. (문자열 비교 + `contains("; charset")` 이중 단언.)
7. seam이 없을 때(`request.getAttribute(...)`가 null이거나 Tomcat 응답이 아닐 때) `open()`이 **던진다**(폴백 금지). `RawContentTypeTest`의 형태를 따른다.
8. **소스 정적 스캔**: `SseHttp.java` 원문에 step0 「금지 철자」 0건 · **JDK 25 신규 표면 3종(`StructuredTaskScope`·`ScopedValue`·`Subtask`) 0건**(게이트가 못 잡으므로 이 테스트가 유일 방어선이다) · `SseEmitter`·`ResponseBodyEmitter`·`StreamingResponseBody` 문자열 0건 · `setContentLength` 0건 · `setContentType` 0건(서블릿 API로 Content-Type을 지정하지 않는다).
9. **와이어 지점이 둘뿐이라는 잠금**: `src/main/java` 전체에서 `RawContentType.set(`을 부르는 파일이 정확히 `JsonHttp.java`와 `SseHttp.java` **2개**임을 스캔으로 단언한다(ADR-015 · 지점이 셋이 되면 그 사실이 diff에 보인다).

**replay-gate(항목 10~15) — 가짜 `HttpServletResponse`/`OutputStream`으로 순수 단위 테스트한다(와이어 불필요)**

10. **prelude 적재**: prelude 모드에서 `write(A)`·`write(B)` → 출력 스트림에 **아무것도 나가지 않는다**. `endPrelude(신선한 값)` 후 **A·B가 적재 순서대로** 나간다.
11. **`writePrelude`는 즉시 나간다**: prelude 중 `writePrelude(READY)` → 그 자리에서 출력. 그리고 최종 순서가 **`READY` → 큐 항목** 순이다(ready가 반드시 첫 프레임이다).
12. **중복 제거**: `write(f1, 10)`·`write(f2, 11)` 적재 후 `endPrelude(10)` → **f2만** 나간다. `endPrelude(Long.MIN_VALUE)` 같은 "아무것도 안 버리는" 값이면 둘 다 나간다.
13. **원자성(교차 스레드)**: 별도 스레드 다수가 `write(...)`를 계속 호출하는 동안 `endPrelude(...)`를 부른다 — ① **프레임 유실 0**(호출 횟수 = 출력 프레임 수) ② **순서 역전 0** ③ **프레임 바이트가 섞이지 않는다**. 이것이 이 phase에서 GREEN A·B를 지키는 단언이다.
14. **`endPrelude` 멱등**: 두 번 불러도 큐가 두 번 나가지 않는다. 그리고 **prelude 중 `close()`** 후의 `endPrelude`는 아무것도 쓰지 않는다.
15. **큐 상한**: `PRELUDE_MAX + N`건을 적재하면 큐 길이가 `PRELUDE_MAX`를 넘지 않고 **가장 오래된 N건이 버려지며** 드롭 카운터가 정확히 N이다.
16. **prelude 중 `close()`의 정리(불변식 3·6의 `Stream` 쪽 절반)** — **이 step에는 컨트롤러가 없으므로 `Stream` 단위로만 단언한다.** prelude 구간에서 `close()`를 부르면 ① `isOpen()`이 false이고 `AsyncContext.complete()`가 **정확히 1회** ② **큐가 폐기되어** 이후 `endPrelude(...)`가 **아무것도 쓰지 않는다** ③ `close()`는 **멱등**이다. **불변식 6의 나머지 절반(컨트롤러가 `try/catch` → `seal()`로 감싸 "헤더만 나가고 영원히 침묵 + 구독 누수"를 막는다)은 컨트롤러가 생기는 step4·step5가 소유한다**(step4 항목 19 · M4-14 / step5 항목 21 · M5-13). 여기서 컨트롤러를 흉내 내는 헬퍼를 만들어 그것을 변이 대상으로 삼지 마라 — 변이가 자기 헬퍼를 고치는 순환이 된다.
17. **`writePrelude`도 닫힘에 안전하다**: `close()` 후 `writePrelude(...)`가 **`false`를 돌려주고 던지지 않는다**(불변식 1).

## Acceptance Criteria

```bash
# 1) Java 전체
cd /d/agents/harness/server-spring && JAVA_HOME="D:/agents/tools/jdk-25.0.4.1+1" ./mvnw -B clean verify
#   기대: BUILD SUCCESS · Tests run: <step1 종료 수치 + 신규 N> · Failures 0 · Errors 0 · Skipped 0

# 2) 계약 무회귀 — 관측 수 불변(라우트가 아직 없으므로 계약은 이 step을 보지 못한다)
cd /d/agents/harness/server-spring && JAVA_HOME="D:/agents/tools/jdk-25.0.4.1+1" ./mvnw -B -q package -DskipTests
cd /d/agents/harness && SPRING_JAVA_HOME="D:/agents/tools/jdk-25.0.4.1+1" node scripts/spring-contract.mjs --parity
#   기대: exit 0 · profiles=5 · 296관측 diffs 0

# 3) 핸들러 집합 불변 — 이 step은 라우트를 만들지 않는다
#   HandlerInventoryTest가 37 라우트 그대로 green이어야 한다(위 1)에 포함)
git diff --stat -- server-spring/src/test/java/harness/news/web/HandlerInventoryTest.java
#   기대: 출력 없음

# 4) 무접촉 경로 · ADR-008 게이트 0줄
git diff --stat -- contract docs/api-contract scripts/contract-run.mjs scripts/contract-diff.mjs server src web client test package.json spikes
git diff --stat -- server-spring/src/test/java/harness/news/config/Adr008DisciplineTest.java
git diff --stat -- server-spring/src/test/java/harness/news/testsupport/Wire.java
#   기대: 셋 다 출력 없음

# 5) 새 Maven 의존성 0
git diff -- server-spring/pom.xml
#   기대: 출력 없음
```

**종료 조건 — 아래 변이 전건의 결과표를 summary에 기록한다. 미기록 시 이 step은 미완이다.**

## 검증 절차 (변이)

| 변이 | 심는 곳 | 기대 |
|---|---|---|
| M2-1 | `frame`의 종결자를 `\n` 하나로 | 항목 1·3 red |
| M2-2 | `CONTENT_TYPE`에서 세미콜론 뒤 공백 제거 | 항목 6 red |
| M2-3 | `frame` 인코딩을 `String.getBytes()`(플랫폼 기본)로 | 항목 5 red |
| M2-4 | `open()`이 seam 없을 때 `response.setContentType(CONTENT_TYPE)`로 폴백 | 항목 7·8 red |
| M2-5 | `write()`가 flush를 생략 | **이 step에서는 red가 나지 않는다**(라우트가 없다). 그 사실을 기록하고 step4의 M4-x로 이월하라 — 정직한 공백이다 |
| M2-6 | `SseHttp.java`에 `Executors.newSingleThreadScheduledExecutor()` 한 줄 | `Adr008DisciplineTest` **red**(예외 4파일이 아니다) |
| M2-7 | `SseHttp.java`에 `RawContentType.set(` 호출을 하나 더 만든 세 번째 클래스를 신설 | 항목 9 red — 와이어 지점 2개 잠금의 비공허 실증 |
| M2-8 | `frame` 앞에 초기 코멘트 `": ok\n\n"`를 덧붙임 | 항목 1 red(계약 `startsWith`가 실패하는 것과 같은 축) |
| M2-9 | `SseHttp.java`에 `java.util.concurrent.StructuredTaskScope` 사용 한 줄(JDK 25 정식 API) | **항목 8 red**(이 step이 더한 JDK 25 스캔) · **`Adr008DisciplineTest`는 green으로 남을 가능성이 높다**(계획 단계 실측: 게이트 패턴에 그 철자가 0건) — **두 결과를 모두 기록하라.** 이것이 "게이트가 못 잡는 자리를 이 step의 스캔이 잡는다"의 비공허 실증이고, 게이트 파일은 **0줄 고치지 않는다** |
| M2-10 | prelude 모드에서 `write(...)`가 **큐를 거치지 않고 즉시 쓰도록** 변경(= replay-gate 제거) | 항목 11 red(ready가 첫 프레임이 아니게 된다) — **이것이 GREEN B를 깨뜨리는 결함의 단위 재현**이다 |
| M2-11 | `endPrelude`의 드레인을 write monitor **밖**에서 수행 | 항목 13 red(교차 스레드 유실·역전) |
| M2-12 | 드레인을 **역순(LIFO)**으로 | 항목 10·13 red |
| M2-13 | `endPrelude`의 멱등 플래그 제거 | 항목 14 red(큐가 두 번 나간다) |
| M2-14 | 큐 상한 제거(무한) | 항목 15 red |
| M2-15 | prelude 중 `close()`가 **큐를 폐기하지 않게** 함(닫힌 뒤 `endPrelude`가 큐를 흘려보낸다) | **항목 16② red** — 닫힌 응답에 write가 누적된다. **컨트롤러 축의 예외 경로 변이는 여기가 아니라 step4 M4-14 · step5 M5-13이다**(이 step에는 컨트롤러가 없다) |
| M2-16 | `writePrelude`가 monitor를 잡지 않고 닫힘 검사도 안 하게 함 | **항목 17 red**(닫힌 뒤 호출이 던진다) · 항목 13(교차 스레드)도 불안정해질 수 있다 — 두 결과를 모두 기록 |

각 변이 전후로 green→red→green 3단계를 기록하고, 원복 후 `cmp` byte-identical + `git status --porcelain` 무변을 확인하라.

## 금지사항

- **`SseEmitter`·`ResponseBodyEmitter`·`StreamingResponseBody`·메시지 컨버터로 스트림을 반환하지 마라.** 이유: 그 경로들은 서블릿 API로 Content-Type을 지정하고 coyote가 커밋 시점에 `타입 + ";charset=" + 인코딩명`으로 **재조립**한다 — 세미콜론 뒤 공백이 사라지고 charset이 대문자가 되어 `text/event-stream;charset=UTF-8`이 된다. 계약 리포트는 이 문자열을 정확 비교하므로 **전 SSE 관측이 diff**가 된다(ADR-013 ④ · ADR-015).
- **`response.setContentType(...)`·`setHeader("Content-Type", ...)`를 쓰지 마라.** 같은 이유다. Content-Type은 `RawContentType.set` 한 경로로만 쓴다.
- **`setContentLength`를 부르지 마라.** 이유: 길이를 정하면 컨테이너가 그 바이트에서 응답을 끝내 스트림이 첫 프레임에서 닫힌다.
- **초기 코멘트·패딩·`id:`·`retry:`·heartbeat를 넣지 마라.** 이유: Node 원문에 없다(실측). 계약이 첫 바이트부터 `startsWith(READY_FRAME)`으로 대조하므로 앞에 무엇을 붙여도 즉시 red다. 그리고 heartbeat는 앱 내 타이머라 ADR-008·ADR-015 위반이다.
- **`write()`에서 예외를 밖으로 던지지 마라.** 이유: 이 메서드는 트리거 요청 스레드에서 불린다 — 예외가 새면 성공한 저장이 500으로 뒤집히고 클라 재시도가 중복 저장을 만든다(Node가 명시적으로 막은 자리다).
- **`AsyncContext.setTimeout`에 유한값을 넣지 마라.** 이유: Node에 없는 종료 경로가 생기고, 그것은 사실상 앱 내 타이머다.
- **`testsupport/Wire.java`를 고치지 마라.** 이유: 기존 37 라우트의 관측 도구이고, 두 모드를 가지면 한쪽만 맞아도 통과하는 자리가 생긴다. 스트림용은 새 파일이다.
- **`Adr008DisciplineTest`의 예외 목록을 넓히지 마라.** 이유: step0과 동일 — 이 설계는 타이머·스레드를 만들지 않는다.
- **새 Maven 의존성(webflux 등)을 추가하지 마라.** 이유: 이 서버는 서블릿 스택 하나로 계약을 만족하며, 리액티브 스택은 필터 순서와 에러 shape의 소유권을 프레임워크로 옮긴다(ADR-013 ①의 취지).
- **`contract/**`·`server/**`·`src/**`·`test/**`·`spikes/**` 등 무접촉 목록을 고치지 마라.**
