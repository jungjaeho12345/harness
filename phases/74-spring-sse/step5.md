# Step 5: logs-stream-http  ← **GREEN B (계약 파일 1개 · 7관측) · 39/39 달성**

## 읽어야 할 파일

**계획 문서**
- `phases/74-spring-sse/index.json` — `decisions` (1)(5)(6)(11)(13)·`open_questions` (6).
- `phases/74-spring-sse/step2.md` — Node 원문 실측(헤더 3종은 `/api/stream`과 **완전히 동일**하다).
- `phases/74-spring-sse/step4.md` — 「배경」 (9) 프로브 이동 규칙(이 step이 **마지막 이동**을 한다).

**계약 (읽기만 — 무수정). 이 step이 green으로 만드는 파일이다.**
- `contract/cases/default/logs.contract.js` **전문** — B-1~B-5. **이 파일은 `logs-digest` 3케이스도 함께 관측한다**(현재 Spring scope 밖이라 `logs-digest`의 `unauthenticated`가 미커버였다 — 계획 단계 실측).
  - `assertLogRecord`가 **키 집합 5종·타입·`line` 접두 포맷**만 본다(실값은 절대 단언하지 않는다 — LOGS.md 마스킹).
  - B-3: ready 후 **트리거 없이** 도착하는 `log` 프레임 = 접속 시점 replay.
  - B-4: 스트림을 연 채 `GET /api/health` 1건 → `seq > seqBefore`인 새 `log` 프레임.
- `docs/api-contract/sse.md` — 「`/api/logs/stream` — replay 계약」·「push 시점 비연장 재검증」 절.
- `docs/api-contract/endpoints.json`의 `logs-stream` 행(`auth: "admin"` · `expect: ["success","unauthenticated","forbidden"]`).

**아키텍처 정본**
- `docs/ADR.md` — **ADR-007 전문**(Z 전용 · replay 2000 · 강등 시 봉인 · 비연장 peek) · **ADR-015**.
- `docs/LOGS.md`(있으면) — 마스킹 규율.

**Node 정본 (무수정 — 읽기만)**
- `server/index.js` **1162~1217행** — `GET /api/logs/stream` 전문. 특히:
  - **1162~1165행 주석**: "둘 다 Z 전용이다. `/api/stream`(로그인만)과 달리 role 게이트가 있다 — 게이트를 빼면 R/D가 서버 로그(전 사용자 요청 흔적)를 본다. role은 검증 세션에서만 도출한다(ADR-004)."
  - `LOG_REPLAY_MAX = 2000` · `logService.snapshot().slice(-LOG_REPLAY_MAX)`
  - live push 콜백의 try/catch 위치와 **`!actor || actor.role !== 'Z'` 이중 판정**

**Spring 현행**
- `server-spring/src/main/java/harness/news/controller/LogsController.java` — `GET /api/logs/digest`의 Z 게이트(`Authorization.VIEW_LOGS`) 선례. **이 step이 여기에 스트림 핸들러를 추가한다.**
- `server-spring/src/main/java/harness/news/service/Authorization.java` — **전문을 읽어라.** 실측 좌표: `VIEW_LOGS`(45행) · `CAPABILITIES`(86행 · `VIEW_LOGS -> List.of("Z")`는 88행) · **`authorize`(136행)와 `editDps`(166행)가 `sessions.touchSession(...)`을 쓴다** · private `allow(role, capability)`(187행). **이 step이 여기에 `authorizePeek` 1메서드를 순수 추가한다**(작업 A 주의 참조).
- `server-spring/src/test/java/harness/news/service/AuthorizationTest.java` — 증설 대상(항목 16).
- `server-spring/src/main/java/harness/news/service/LogRecord.java` — `asMap()`(5키).
- `server-spring/src/test/java/harness/news/web/PathPolicyWireTest.java` — 프로브(step4가 `/api/logs/stream`으로 옮겨 둔 상태).
- `server-spring/src/test/java/harness/news/controller/LogsWireTest.java` — 무회귀 + 증설 대상.
- `scripts/spring-contract.mjs` SCOPE `default.files`.

**직전 step 산출물**
- `LogService.subscribe/snapshot/subscriberCount`(step1) · `SseHttp`(step2) · `StreamController`(step4) · `WireStream`(step2).

## 배경 (동결된 사실)

1. **인가 등급이 `/api/stream`과 다르다.** `/api/logs/stream`은 **세션 + role Z**다. 401은 `PathPolicyFilter`(`AuthClass.ADMIN`)가, **403은 컨트롤러가** 낸다(`GET /api/logs/digest`와 같은 2단 구조). 둘 다 **스트림을 열기 전** JSON이다.
2. **`/api/stream`과 200 응답 헤더 3종이 완전히 동일**하다(계획 단계 raw 소켓 실측): `Content-Type: text/event-stream; charset=utf-8` · `Cache-Control: no-cache` · `Connection: keep-alive` · `Transfer-Encoding: chunked` · `Content-Length` 없음. ready 프레임도 같다.
3. **replay는 접속 시점 인증으로 충분하다**(같은 tick — 재검증 없음). replay 뒤부터 live push이며, **live push마다** 비연장 peek + **role Z 재확인**을 한다. **강등(Z→D)되면 그 로그 라인을 한 줄도 쓰지 않고** `unauthorized` 1회 후 종료한다 — ADR-007의 "Z 전용 봉인이 시간축에서도 유지된다".
4. **replay 상한 2000은 라우트 소유다**(`LogService.snapshot()`은 전체를 준다 — step1이 그렇게 못 박았다). 버퍼 cap은 10000.
5. **계약이 못 보는 축(= Java 테스트가 유일 방어선)**: replay 상한 2000 · 강등 봉인 · 비연장 peek · 누수 0 · ready→replay→live 순서 · 재귀 없음.
6. **Spring `RequestLogFilter`는 `finally`에서 로그한다.** 비동기 스트림에서는 체인이 즉시 풀리므로 **SSE 요청 자신의 액세스 로그 1줄이 스트림이 열린 상태에서 발생**해 자기 스트림으로 push된다. Node는 `res.on('finish')`(= 스트림 종료 시점)라 그 줄이 스트림 중에는 나가지 않는다. **관측 가능한 divergence이지만 계약은 이것을 red로 만들지 않는다**(B-3은 "log 프레임이 하나라도 오면 통과", B-4는 "새 seq가 오면 통과"). 이 사실을 실측해 forward_notes에 기록하라. **재귀는 아니다** — 그 write는 새 로그를 만들지 않기 때문이다. 그 사실을 테스트로 잠근다.
7. **프로브의 마지막 이동**: 이 step이 `logs-stream`을 구현하면 **인벤토리 39 라우트 안에 미구현 후보가 0**이 된다. 프로브를 **인벤토리 밖 경로**로 옮기고 **테스트 이름과 javadoc을 함께 바꿔** 의미가 "스텁 금지"에서 "미정의 경로 404 shape"으로 **바뀌었다는 사실을 명시**하라. 같은 이름을 유지한 채 의미만 바꾸면 다음 사람이 스텁 금지가 여전히 지켜지는 줄 안다(73 forward_notes (3)의 명시 규칙).
8. **scope 표 자리**: `logs.contract.js`는 `health.contract.js` **뒤**, `media-upload.contract.js` **앞**(알파벳 순서).
9. **이 step이 끝나면 Spring scope 표의 파일 집합이 각 프로파일의 디렉토리 전체와 같아진다**(default 14 · minimal 3 · auth-negative 1 · failclosed 1 · prod-cookie 1 = **20파일**). 즉 Spring 대상이 Node 대상의 전수 케이스와 같은 집합을 돌게 된다 — step6의 합산 커버리지 게이트의 전제다.

## 작업

### A — `LogsController`에 `GET /api/logs/stream` 추가

```java
@GetMapping("/api/logs/stream")
public void stream(HttpServletRequest request, HttpServletResponse response);
```

흐름 — **초안의 순서를 ② 검토 반영으로 정정했다. 아래 순서를 지켜라.**

> **왜 바뀌었나(반드시 읽어라)**: 초안은 `ready` → **replay(최대 2000 write)** → `subscribe` 순서였다. Node는 단일 스레드라 그 구간에 **다른 요청이 처리되지 않지만**, Spring은 다른 워커가 동시에 돈다 — replay가 도는 **수십~수백 ms** 동안 발생한 로그가 **구독 부재로 유실**된다. `contract/lib/sse.js`의 규약이 **"ready 수신 = 구독 완료"를 전제**하는데 그 전제는 Node에서만 참이다. `decisions (4)`의 "Node와 1:1" 서술은 이 지점에서 부정확했다(index.json (4)에 정정 문단이 붙어 있다).
>
> **[② 재검토 정정 — 이 문단을 반드시 읽어라] 계약은 이 유실을 잡지 못한다.** 초안 계획은 "구독을 뒤로 미루면 B-4가 10초 타임아웃 red"라고 적었으나 **실측은 반대다**: ① `contract/cases/default/logs.contract.js` **170~178행**의 주석이 **"replay 잔여가 늦게 도착할 수 있어 '새 라인 도착'의 _하한만_ 본다"**고 명시한다 — `seqBefore = maxLogSeq(s.frames)`를 ready 직후 샘플링하므로 **아직 도착하지 않은 replay 프레임**(seq 오름차순)이 `seq > seqBefore`를 그대로 충족해 통과한다. ② `server-spring/src/main/java/harness/news/web/RequestLogFilter.java` **44~52행**은 **async 가드가 없는 plain `Filter`**라 `finally`가 컨트롤러 반환 직후 돌고, **SSE 요청 자신의 액세스 로그**가 (유실 버그가 있는 순서에서도 subscribe 이후에) 발행돼 **항상 새 seq를 만든다**. **따라서 이 축의 유일 방어선은 아래 항목 7(b)(d)의 Java 경합 테스트다.** 72 송고 훅 status·73 키 유출과 같은 "계약이 구조적으로 못 보는 축"이며, **거짓으로 "계약이 잡는다"고 적으면 다음 사람이 없는 방어선을 믿는다.**

1. 토큰 판독 → `Authorization.Decision gate = authorization.authorize(token, Authorization.VIEW_LOGS)`.
   - `gate.ok()`가 거짓이면 `json.write(..., ReasonStatus.of(gate.reason()), JsonHttp.fail(gate.reason()))` 후 **return**(미인증 401 · 비-Z 403 — **스트림을 열기 전**).
   - `digest` 핸들러와 **같은 방식**으로 게이트하라(판정이 두 곳으로 갈리면 한쪽만 고쳐도 조용히 뚫린다).
   - **접속 게이트에서는 `authorize(...)`가 맞다**(연장이 정상인 실제 요청이다). **push 경로에서만 금지**다 — 아래 주의 참조.
2. `SseHttp.Stream s = sse.open(request, response)` — **prelude 모드로 열린다**(step2 「replay-gate」).
3. **subscribe — 구독을 _가장 먼저_ 등록한다.** `AutoCloseable sub = logs.subscribe(rec -> { ... s.write(frame, rec.seq()) ... })`. prelude 모드이므로 이 write는 **`rec.seq()`를 순서키로 달고 큐에 적재**된다. **이 시점부터 유실 창이 0이다.**
4. **snapshot — 구독 _뒤에_ 뜬다.** `List<LogRecord> snap = logs.snapshot();` 순서가 반대면(스냅샷 먼저) 스냅샷과 구독 사이에 창이 생긴다.
5. `s.writePrelude(SseHttp.READY)` — ready가 **반드시 첫 프레임**이다.
6. **replay**: `snap`의 **마지막 `LOG_REPLAY_MAX`(=2000)건만** 순서대로 `s.writePrelude(frame("log", json(rec.asMap())))`. 쓴 것 중 **최대 seq**를 `lastReplayedSeq`에 담는다(replay가 0건이면 "아무것도 버리지 않는 값").
   - `LOG_REPLAY_MAX`는 이 컨트롤러의 `private static final int` 상수로 두고 javadoc에 "Node `server/index.js` 1178행과 정렬"을 적는다.
7. **`s.endPrelude(lastReplayedSeq)`** — write monitor 안에서 큐를 드레인한다. **`seq <= lastReplayedSeq`인 항목은 버린다**(3~6 사이에 들어온 로그가 스냅샷에도 있고 큐에도 있을 수 있다 — **중복 제거**). 나머지는 적재 순서대로 나가고 live로 전환한다.
   - 결과 순서: **`ready` → replay(오래된→최신) → 창에서 온 신규 로그 → live**. 유실 0 · 중복 0 · 역전 0.
   - **[② 재검토 반영 · 필수] 위 3~7 구간 전체를 `try { ... } catch (RuntimeException ex) { seal(); }`로 감싸라.** 이유: `open()` 성공 후 `endPrelude`에 도달하기 전에 예외가 나면(replay 중 직렬화 실패 등) 클라이언트는 **헤더만 받고 영원히 기다리고**(`setTimeout(0)`이라 **컨테이너 타임아웃도 없다**) 서버는 구독자와 `AsyncContext`를 붙든다 = **영구 침묵 + 누수**. replay가 2000 write를 도는 이 라우트가 가장 위험하다. `seal()`은 멱등이다(step2 불변식 6). **이 자리를 지키는 것은 이 step의 항목 21과 변이 M5-13이다** — step2의 항목 16·M2-15는 컨트롤러가 없어 `Stream` 쪽 절반만 본다.
8. 구독 콜백 내용:
   - `Identity actor; try { actor = sessions.peekSession(token); } catch (RuntimeException ex) { seal(); return; }`
   - **role Z 재확인** — 아래 주의의 `authorizePeek`를 쓴다. 거짓이면 `seal(); return;` — **그 로그 라인을 쓰지 않는다.**
   - `s.write(frame("log", json(rec.asMap())), rec.seq())` — 실패면 구독 해제.
   - **이 콜백 안에서 `LogService`에 로그하지 마라**(무한 재귀).
9. `seal()` = ① `sub.close()` → ② `s.write(SseHttp.UNAUTHORIZED)` → ③ `s.close()`. 멱등. **prelude 중에 봉인이 일어나면 큐를 버리고 끝낸다**(step2 불변식 3).
10. `s.onClosed(() -> sub.close())`.

주의:
- **[확정 · 추측 아님] push 시점에 `Authorization.authorize(...)`를 부르지 마라.** 실측 확인: `server-spring/src/main/java/harness/news/service/Authorization.java` **136행**(`authorize`)과 **166행**(`editDps`)이 `this.sessions.touchSession(sessionToken)`을 쓴다 — **세션을 연장한다**. 열린 스트림이 push마다 그것을 부르면 **세션 유휴 만료가 무한 연장**되어 ADR-005·ADR-007의 비연장 peek 불변식이 깨진다. 이것은 초안의 open_questions (7)이 "확인하라"로 남긴 자리였으나 **이제 확정된 금지사항**이다.
- **대신 `Authorization`에 비연장 판정 1메서드를 순수 추가**한다: `public Decision authorizePeek(String sessionToken, String capability)` — `sessions.peekSession(...)`을 쓰고 **기존 `authorize`와 같은 private `allow(role, capability)`/`CAPABILITIES` 표에 위임**한다(실측: `CAPABILITIES`는 86행, `VIEW_LOGS -> List.of("Z")`는 88행, `allow`는 187행 private). **역할 목록·문자열 `"Z"`를 컨트롤러에 복제하지 마라** — 복제하면 한쪽만 고쳐도 조용히 갈린다.
  - 이것이 이 step이 건드리는 **유일한 서비스층 파일**이다. 기존 `authorize`/`editDps`의 동작은 **0줄 변경**이며 기존 호출자에 영향이 없다(순수 추가 1메서드). 그 사실을 `AuthorizationTest`에 단언으로 박아라: `authorize`는 세션을 연장하고 `authorizePeek`는 **연장하지 않으며**, 같은 (role, capability) 입력에 대해 **두 메서드의 판정 결과가 항상 같다**.
- **replay는 재검증하지 않는다**(Node 동형 · "같은 tick"). 재검증은 7 이후의 live push부터다.

### B — `HandlerInventoryTest` 38 → **39**

- `"GET /api/logs/stream"` 추가. 메서드 이름·실패 메시지의 수치도 같은 커밋에서 `ThirtyNine`으로.
- javadoc에 **"39/39 — P1 포팅 라우트 완결"**을 명시하고, `FRAMEWORK_ROUTES`(Boot `/error`)와 인벤토리 밖 `/uploads/**`는 여전히 그 밖이라는 사실을 유지하라.

### C — `PathPolicyWireTest` 프로브의 **마지막 이동**

- 경로: 인벤토리 밖(예: `GET /api/does-not-exist`). `RoutePolicy.match`가 null이므로 `PathPolicyFilter`는 세션을 요구하지 않는다 — **미인증도 404**다. 프로브가 인증된 요청을 보내는 것 자체는 유지하되 그 사실을 javadoc에 적어라.
- **테스트 이름을 바꿔라**: `authenticatedRequestToAnUnimplementedRouteIs404NotAStub` → 예 `anUndefinedPathIs404HtmlNotAJsonError`.
- javadoc에 명시할 것: ① 인벤토리 39 라우트가 전부 구현되어 **"미구현 라우트"라는 프로브 대상이 더는 존재하지 않는다** ② 그래서 이 프로브의 의미가 **"스텁 금지"에서 "미정의 경로의 404 shape"으로 바뀌었다** ③ 스텁 금지는 이제 **`HandlerInventoryTest`의 정확 집합 단언**이 단독으로 지킨다.
- 단언(404 + `Content-Type: text/html; charset=utf-8`)은 그대로 둔다.

### D — `scripts/spring-contract.mjs` scope 표에 1행

`'contract/cases/default/logs.contract.js'`를 `health.contract.js` 뒤·`media-upload.contract.js` 앞에 넣고 한 줄 주석(예: `// phase 74 step5 — GET /api/logs/stream이 붙으면서 green이 됐다(Z 전용 · replay · live push · logs-digest 3관측 동반)`).

### E — 테스트 (먼저 작성한다)

`server-spring/src/test/java/harness/news/controller/LogsStreamWireTest.java` 신설.

**인가(계약과 겹치는 축)**
1. 미인증 → **401** JSON · SSE 헤더 0건.
2. **비-Z(D) → 403** `{"ok":false,"reason":"forbidden"}` · SSE 헤더 0건. **핵심 보안 단언 — 200이 아니다.**
3. Z → 200 · 헤더 원문 3종 · `Content-Length` 부재 · ready 프레임 원문 32바이트.

**replay·live(계약과 겹치는 축)**
4. 접속 전에 N줄 쌓고 접속하면 그 줄들이 `log` 프레임으로 오고 **record 5키**(`level`·`line`·`message`·`seq`·`ts`)이며 `line`이 `[YYYY-MM-DD HH:MM:SS] [LEVEL] ` 접두다.
5. 스트림을 연 채 요청 1건 → **새 `seq`** 프레임 도착.

**계약이 구조적으로 못 보는 축 — 이 step의 진짜 방어선**
6. **replay 상한 2000**: 버퍼에 2500건을 쌓고 접속 → replay `log` 프레임이 **정확히 2000건**이고 **가장 최근 2000건**(가장 오래된 500건이 없다)이다.
7. **순서 + 등록 창 유실 0(replay-gate의 핵심 단언 · ② 검토 반영)** — 세 가지를 한 축으로 잠근다.
   - (a) **순서**: `ready`가 **첫 프레임**이고 그 다음이 replay `log`들(오래된→최신)이며, live는 그 뒤다.
   - (b) **유실 0**: replay가 **실제로 오래 걸리는 구성**(버퍼에 2000건 이상을 쌓아 replay가 2000 write를 돌게 한다)에서, **스트림을 여는 동안 다른 스레드가 `logs.info(...)`를 계속 발생**시킨다. 스트림이 열린 뒤 **그 구간에 발생한 seq가 하나도 빠지지 않고** 도착한다. **최소 50회 반복**하고 관측된 유실 수를 summary에 수치로 적어라. **1회 실행은 증거가 아니다.**
   - (c) **중복 0 · 역전 0**: 수신한 `log` 프레임의 `seq`가 **엄격 증가**이고 **같은 seq가 두 번 오지 않는다**(스냅샷과 prelude 큐가 겹치는 구간이 `endPrelude(lastReplayedSeq)`로 제거된다).
   - (d) **계약 B-4의 형태를 재현하되 _계약보다 엄격하게_ 단언한다.** `ready` 수신 **직후** 프로브 요청 1건을 쏘고 **그 요청이 만든 바로 그 로그 줄**이 도착함을 단언한다. **계약 B-4처럼 `seq > seqBefore` 하한만 보지 마라** — 그 하한은 **replay 잔여 프레임으로도 충족되고**(그 파일 170~178행 주석이 명시) **SSE 요청 자신의 액세스 로그**(`RequestLogFilter` 44~52행 · async 가드 없음)로도 충족되므로 유실이 있어도 통과한다.
     - **[② 3차 반영 — `GET /api/health 200` 문자열만으로는 부족하다] 그 문자열은 _replay에 섞인 과거 health 줄_ 로도 충족된다**(이 스위트는 health를 여러 번 부른다). 그러면 계약이 하한만 보는 것과 **똑같은 함정을 Java 테스트가 반복**한다. **다음 둘 중 하나(또는 둘 다)로 replay 잔여와 구별되게 만들어라.**
       ① **유니크 프로브**: 매 반복마다 다른 쿼리 문자열로 요청한다(예: `GET /api/health?probe=<nonce>` — nonce는 반복마다 새로 생성). `RequestLogFilter`가 `getRequestURI()`를 쓰므로 쿼리가 `line`에 남지 않을 수 있다 — **먼저 실측해 확인하고**, 안 남으면 ②를 쓰거나 URI에 남는 다른 유니크 프로브를 골라라(그 판정 근거를 테스트 javadoc에 적어라).
       ② **`seq > lastReplayedSeq` 동반 단언**: 도착한 프레임의 `seq`가 **replay 마지막 seq보다 크다**는 것을 함께 단언한다(테스트가 replay 프레임을 세고 있으므로 그 값을 알 수 있다).
     - **어느 쪽을 택하든 "replay 잔여와 구별된다"는 사실이 단언 자체에 드러나야 한다** — 주석으로만 적지 마라. **여기가 계약과 갈리는 지점이고, 그래서 이 항목이 유일 방어선이다.**
8. **강등 봉인(ADR-007의 핵심)**: Z로 스트림을 연 뒤 그 사용자를 **D로 강등**하고 새 로그를 발생시키면 → **`log` 프레임이 한 줄도 나가지 않고** `unauthorized` 1회 후 종료, 이후 2초 침묵.
9. **비활성화 봉인**: 사용자를 `active=N`으로 만들면 동일하게 봉인된다.
10. **로그아웃 봉인**: 세션 무효화 후 동일하게 봉인된다.
11. **비연장 peek**: push가 세션 유휴 만료를 연장하지 않는다(시계 주입).
12. **fail-closed**: 재검증이 예외를 던지면 그 줄을 쓰지 않고 봉인한다.
13. **누수 0** — 두 경로를 **다르게** 단언한다(② 검토 반영 · step4 항목 11과 같은 규율).
    - (a) **정상 종료**: 스트림 5개를 열고 정상으로 닫으면 `LogService.subscriberCount()`가 **즉시 0**.
    - (b) **소켓 강제 끊김**: 끊은 뒤 **`logs.info(...)`를 1회 발생시킨 다음** `subscriberCount()`가 **0**임을 단언한다. **"끊자마자 0"으로 단언하지 마라** — `setTimeout(0)`이라 Tomcat이 `onError`를 안 낼 수 있고, 그러면 해제가 다음 write 실패 시점까지 지연된다(decisions (12)).
    - (c) `onError`/`onComplete` 발화 여부를 **실측해 기록**하라(단언이 아니라 관측 · divergence로 forward_notes에 남긴다).
14. **재귀 없음**: 스트림 1개를 연 채 요청 1건을 보내면 **버퍼 증가분이 유한**하다(폭주 0). 그리고 SSE 구독 콜백 소스에 `logs.info/warn/error/debug` 호출이 **0건**임을 정적 스캔으로 단언한다.
15. **워커 점유 0** — **테스트 컨텍스트에 워커 상한을 낮춰 구성한다**(② 검토 반영: 기본 `max-threads=200`에서 "10건"은 **블로킹 구현도 통과**하는 공허한 AC다). `server.tomcat.threads.max=5` 아래에서 **스트림을 워커 수보다 많이**(예: 8개) 열어 둔 채 다른 라우트가 정상 응답함을 단언하고, `assertTrue(STREAMS > MAX_THREADS)`를 테스트 안에 박아라(공허화 방지 자기 단언).
16. **`authorizePeek` 단위 단언**(`AuthorizationTest` 증설): ① `authorize`는 세션을 연장하고 `authorizePeek`는 **연장하지 않는다**(시계 주입) ② 같은 (role, capability)에 대해 **두 메서드의 판정이 항상 같다**(역할 표가 한 출처임의 잠금) ③ 기존 `authorize`/`editDps` 호출자 무회귀.
17. **정적 스캔 2종** — 행동 단언이 못 잡는 자리를 소스 문자열로 잠근다.
    - (a) **[② 재검토 반영] push 경로에 `authorization.authorize(` 0건**: `LogsController.java`에서 **구독 콜백(push 경로) 안에 `authorize(`·`editDps(`·`touchSession(` 철자가 0건**임을 단언한다(접속 게이트 1단계의 `authorize(` 1회는 허용 — 그 자리는 연장이 정상이다). 이유: **M5-6은 행동만 본다**(시계 주입으로 연장을 관측). 누군가 `authorize`를 되돌려 놓아도 시계 주입 테스트가 약해지면 조용히 통과하므로, **철자 스캔이 독립 방어선**이다. 허용 1회와 금지 0회를 구분해야 하므로 **콜백 람다의 소스 범위**를 대상으로 하거나, 파일 전체에서 `authorize(` 총 호출 수가 **정확히 1**임을 단언하라(어느 쪽이든 그 판정 근거를 테스트 javadoc에 적어라).
    - (b) **JDK 25 신규 표면 0건**: `LogsController.java`(및 이 step이 만든 나머지 main 소스)에 `StructuredTaskScope`·`ScopedValue`·`Subtask`가 **0건**임을 정적 스캔으로 단언한다. 이유: 그 3종은 JDK 25가 정식화한 표면인데 `Adr008DisciplineTest`의 5군 패턴에 **0건이라 게이트가 잡지 못한다**(계획 단계 실측 · 그 파일 908행 전문 확인). **게이트 통과는 허가가 아니다.** step2 항목 8·step4와 같은 형태로 걸어라. **게이트 파일 자체는 0줄 고치지 마라** — 그 공백의 조사·기록은 step6 작업 G가 소유한다.
18. **마스킹**: 이 테스트 파일의 어떤 단언 메시지도 로그 **실값**을 출력하지 않는다(키 집합·정규식 판정만 · `assert*` 실패 메시지에 record 내용을 넣지 마라).
19. `HandlerInventoryTest` **39행** green · `PathPolicyWireTest` 새 프로브 green.
20. **블로킹 소비자 1개가 서버 전체에 미치는 영향 — 단언이 아니라 _관측_ 이다(② 재검토 반영).** 소켓을 열고 **읽지 않는 소비자**(TCP 수신 버퍼를 채워 `ServletOutputStream.write`가 블로킹되게 만드는 클라이언트)를 1개 붙인 뒤, 다른 라우트(`GET /api/health`)가 **응답하는지·얼마나 걸리는지**를 재서 기록하라. **배경**: `LogService.log`의 통지는 `notifyLock` 안에서 돌고 `RequestLogFilter`가 `finally`에서 `logs.info(...)`를 부르므로, 멈춘 소비자 하나가 그 락을 물면 **모든 요청의 액세스 로그가 대기해 서버 전체가 정지**한다(Node `res.write`는 논블로킹 버퍼링이라 이 축이 **비대칭**이다 — step1 배경 참조). **정지가 관측되면 그것을 결함으로 보고하지 말고 `forward_notes` 6(미검증 공백)에 수치와 함께 인계하라** — 해법(비블로킹 write·타임아웃·연결 상한)은 전부 이 phase의 무접촉·금지 철자 영역이거나 `excluded (d)`가 배제한 축이다. **테스트가 영구 정지하지 않도록 관측에는 반드시 데드라인을 걸어라**(`WireStream`의 데드라인 기반 읽기를 쓰고, 타임아웃은 `null`/`false`로 표현한다 — throw 금지).
21. **예외 경로 봉인(step2 불변식 6의 컨트롤러 절반)**: `open()` 성공 뒤 `endPrelude` 도달 전에 `RuntimeException`이 나는 상황을 주입하고(**replay 중 직렬화 실패**가 가장 현실적이다 — 이 라우트는 최대 2000 write를 돈다) ① 스트림이 **봉인·종료**되고 ② `LogService.subscriberCount()`가 **0**으로 돌아옴을 단언한다. `setTimeout(0)`이라 **컨테이너가 대신 정리해 주지 않는다.**

## Acceptance Criteria

```bash
# 1) Java 전체
cd /d/agents/harness/server-spring && JAVA_HOME="D:/agents/tools/jdk-25.0.4.1+1" ./mvnw -B clean verify
#   기대: BUILD SUCCESS · Tests run: <step4 종료 수치 + 신규 N> · Failures 0 · Errors 0 · Skipped 0

# 2) jar 갱신 후 계약 — **이 step의 green 지점**
cd /d/agents/harness/server-spring && JAVA_HOME="D:/agents/tools/jdk-25.0.4.1+1" ./mvnw -B -q package -DskipTests
cd /d/agents/harness && SPRING_JAVA_HOME="D:/agents/tools/jdk-25.0.4.1+1" node scripts/spring-contract.mjs --profile default
#   기대: exit 0 · default **files=14** · covered=**32/39**(29 + stream + logs-stream + logs-digest — 실측해 기록)

# 3) 패리티 — P1 최종 수치
cd /d/agents/harness && SPRING_JAVA_HOME="D:/agents/tools/jdk-25.0.4.1+1" node scripts/spring-contract.mjs --parity
#   기대: exit 0 · profiles=5 · **313관측 diffs 0**(default **246** · minimal 55 · auth-negative 4 · failclosed 5 · prod-cookie 3)

# 4) 자기 결정성
cd /d/agents/harness && SPRING_JAVA_HOME="D:/agents/tools/jdk-25.0.4.1+1" node scripts/spring-contract.mjs --dual-run
#   기대: exit 0 · 313관측 diffs 0

# 5) 구현 라우트 39
grep -c '"\(GET\|POST\|PUT\|DELETE\) /api' server-spring/src/test/java/harness/news/web/HandlerInventoryTest.java
#   기대: 39

# 6) scope 표 파일 집합 = 디렉토리 전체(P1 완결의 기계 증거)
node -e "
const fs=require('fs');const src=fs.readFileSync('scripts/spring-contract.mjs','utf8');
for(const p of ['default','minimal','auth-negative','failclosed','prod-cookie']){
  const dir=fs.readdirSync('contract/cases/'+p).filter(f=>f.endsWith('.contract.js')).sort();
  const missing=dir.filter(f=>!src.includes('contract/cases/'+p+'/'+f));
  console.log(p, 'dir='+dir.length, 'missing='+JSON.stringify(missing));
}"
#   기대: 전 프로파일 missing=[]

# 7) 무접촉 경로 · ADR-008 게이트 0줄 · RoutePolicy 0줄
git diff --stat -- contract docs/api-contract scripts/contract-run.mjs scripts/contract-diff.mjs server src web client test package.json spikes
git diff --stat -- server-spring/src/test/java/harness/news/config/Adr008DisciplineTest.java
git diff --stat -- server-spring/src/main/java/harness/news/web/RoutePolicy.java
#   기대: 셋 다 출력 없음
```

**종료 조건 — 변이 전건 결과표를 summary에 기록한다. 미기록 시 이 step은 미완이다.**

## 검증 절차 (변이)

| 변이 | 심는 곳 | 기대 |
|---|---|---|
| M5-1 | replay 상한 2000 제거(전체 replay) | **Java 항목 6 red · 계약 green** — 계약이 못 보는 축의 실증 |
| M5-2 | live push의 role 재판정 제거(peek만) | **Java 항목 8 red · 계약 green** — ADR-007 Z 봉인의 유일 방어선 실증 |
| M5-3 | 비-Z 403을 스트림을 연 뒤 프레임으로 | **계약 B-2 red**(`doesNotMatch(text/event-stream)`) |
| M5-4 | 403을 401로 | 계약 B-2 red |
| M5-5 | **replay-gate 우회 — 구독 등록을 `endPrelude` 뒤로 옮긴다**(= 초안의 "ready → replay → subscribe" 순서로 되돌린다) | **Java 항목 7(b)(d) red · 계약은 green**(`--parity` 313관측 diffs 0 그대로). **[② 재검토 정정] 초안이 적었던 "계약 B-4도 red"는 거짓이다** — B-4는 `seq > seqBefore` **하한만** 보고(그 파일 170~178행 주석이 명시), 그 하한은 **replay 잔여 프레임**과 **SSE 요청 자신의 액세스 로그**(`RequestLogFilter` async 가드 없음)로 충족된다. **두 결과(Java red · 계약 green)를 모두 표에 적어라** — 이것이 "계약이 구조적으로 못 보는 축"의 실증이다. **한가한 환경에서는 창이 좁아 Java도 통과할 수 있다** — 항목 7(b)의 반복 횟수(≥50)와 "버퍼 2000건 이상" 구성을 반드시 갖춰라 |
| M5-5b | `s.writePrelude(READY)`를 `s.write(READY)`로 | Java 항목 7(a) red(ready가 첫 프레임이 아니다) · 계약 B-3도 red |
| M5-5c | `endPrelude(lastReplayedSeq)`를 `endPrelude(<아무것도 안 버리는 값>)`으로 | Java 항목 7(c) red(**같은 seq가 두 번 온다**) — 중복 제거의 비공허 실증 |
| M5-5d | `endPrelude(...)` 호출 삭제 | **계약 B-3 즉시 red**(스트림 영원히 침묵) |
| M5-5e | snapshot을 subscribe **앞**으로 이동 | Java 항목 7(b) red(스냅샷~구독 사이 창에서 유실) |
| M5-6 | push 재검증을 `authorization.authorize(...)`로(= `touchSession` 경로) | Java 항목 11 red · 계약 green — **`Authorization.java:136`이 `touchSession`을 쓴다는 실측의 비공허 실증** |
| M5-6b | `authorizePeek`의 판정을 `allow(...)` 위임 대신 컨트롤러의 `"Z"` 문자열 비교로 복제 | Java 항목 16② red(두 메서드 판정 일치) — 역할 표 복제 금지의 비공허 실증 |
| M5-6c | push 콜백에서 `authorizePeek`를 `authorize`로 바꾸되 **시계 주입 테스트(항목 11)를 함께 비활성화** | **항목 17(a) red** — 행동 단언이 약해져도 **철자 스캔이 독립적으로 잡는다**는 비공허 실증. 두 방어선이 서로를 대체하지 않는다는 사실을 표에 명시하라 |
| M5-7 | 구독 콜백 안에서 `logs.warn(...)` 호출 | Java 항목 14 red(폭주/정적 스캔) |
| M5-8 | 구독 해제 제거 | Java 항목 13 red |
| M5-9 | `LogsController`에 `@Scheduled` heartbeat | `Adr008DisciplineTest` red |
| M5-10 | scope 표에서 `logs.contract.js` 행 삭제 | `HandlerInventoryTest` green · `--parity`가 **306관측**으로 조용히 줄어든다(exit 0) — 기계 증거는 관측 수뿐 |
| M5-11 | 프로브를 옮기지 않고 `/api/logs/stream`에 둠 | `PathPolicyWireTest` red(200이 된다) — 이동이 필수였다는 실증 |
| M5-12 | `LogRecord.asMap()`에서 `seq` 제거 | 계약 `assertLogRecord` red(키 집합) |
| M5-13 | `LogsController`의 `try { ... } catch (RuntimeException ex) { seal(); }`를 제거해 replay 중 예외가 그대로 빠져나가게 함 | **항목 21 red** — 스트림이 봉인되지 않아 클라이언트가 무한 대기하고 `LogService.subscriberCount()`가 0으로 안 떨어진다. `setTimeout(0)`이라 **컨테이너가 대신 정리해 주지 않는다**는 사실을 결과에 명시하라(step2 M2-15는 `Stream` 쪽 절반만 본다 — 이 변이가 컨트롤러 절반이다) |

각 변이는 green→red→green 3단계 기록 + 원복 후 `cmp` byte-identical + `git status --porcelain` 무변.

## 금지사항

- **role 게이트를 빼거나 `/api/stream`과 같은 등급으로 맞추지 마라.** 이유: Node 1162행 주석이 명시한다 — "게이트를 빼면 R/D가 서버 로그(전 사용자 요청 흔적)를 본다". ADR-007이 Z 전용으로 봉인한 축이다.
- **role을 요청 헤더·본문·쿼리에서 도출하지 마라.** 이유: ADR-004 — 신원과 역할은 **검증된 세션에서만** 도출한다.
- **push 시점에 `touchSession`을 쓰지 마라.** 이유: 열린 스트림이 세션 만료를 무한 연장한다. 계약이 못 보는 축이다.
- **[확정] push 시점에 `Authorization.authorize(...)`(및 `editDps`)를 부르지 마라.** 이유: **실측 확인** — `Authorization.java` **136행**과 **166행**이 `sessions.touchSession(...)`을 쓴다. push마다 부르면 열린 스트림이 세션 유휴 만료를 무한 연장해 ADR-005·ADR-007의 비연장 peek 불변식이 깨진다. push 경로는 **`authorizePeek`**(순수 추가 · `peekSession` + 같은 `allow`/`CAPABILITIES` 표)만 쓴다. **접속 게이트(1단계)에서는 `authorize`가 맞다** — 그것은 연장이 정상인 실제 요청이다.
- **역할 목록(`"Z"`·`VIEW_LOGS`의 role 배열)을 컨트롤러에 복제하지 마라.** 이유: 출처가 둘이 되면 한쪽만 고쳐도 조용히 갈린다. `Authorization`의 `CAPABILITIES` 표에 위임하라(M5-6b가 실증한다).
- **구독을 `endPrelude` 뒤에 등록하지 마라 · snapshot을 subscribe 앞에 두지 마라.** 이유: 둘 다 **등록 창 유실**을 만든다. Node에서는 단일 스레드라 그 창이 없지만 Spring은 다른 워커가 동시에 돈다. **그리고 계약은 이것을 잡지 못한다** — B-4는 `seq > seqBefore` 하한만 보고 그 하한이 replay 잔여·SSE 자신의 액세스 로그로 충족된다(② 재검토 실측). **유일 방어선은 항목 7(b)(d)이고 그것을 지우면 이 결함이 무방비가 된다**(M5-5·M5-5e는 Java red · 계약 green이다).
- **`endPrelude` 호출을 빼먹지 마라.** 이유: 스트림이 영원히 침묵해 계약 B-3이 10초 타임아웃 red다.
- **replay를 `LogService.snapshot()` 쪽에서 자르지 마라.** 이유: 절단 지점이 둘이 되면 한쪽만 고쳐도 조용히 갈린다(step1이 그렇게 못 박았다).
- **구독 콜백 안에서 `LogService`에 로그하지 마라.** 이유: 통지 → 로그 → 통지의 무한 재귀다.
- **로그 실값(경로·userId·메시지)을 단언·실패 메시지·리포트·주석에 싣지 마라.** 이유: LOGS.md 마스킹 — 이 버퍼는 `GET /api/logs/digest`로 밖으로 나간다. **여기 들어간 한 조각은 곧 응답이다.**
- **프로브를 같은 이름으로 두고 경로만 바꾸지 마라.** 이유: 의미가 "스텁 금지"에서 "미정의 경로 404 shape"으로 **바뀐다** — 이름을 유지하면 다음 사람이 스텁 금지가 여전히 지켜지는 줄 안다(73 forward_notes (3)).
- **`LogRecord`의 5키·`line` 포맷·`digest()` 창을 바꾸지 마라.** 이유: 계약 동결 축이다.
- **`contract/**`·`docs/api-contract/**`·`server/**`·`src/**`·`test/**`·`spikes/**` 등 무접촉 목록을 고치지 마라.**
- **`git add -A`를 쓰지 마라** — 명시 경로만.
