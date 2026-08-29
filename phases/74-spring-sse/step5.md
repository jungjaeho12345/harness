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
- `server-spring/src/main/java/harness/news/service/Authorization.java` — `VIEW_LOGS`가 `List.of("Z")`.
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

흐름(Node 1180~1217행과 1:1):
1. 토큰 판독 → `Authorization.Decision gate = authorization.authorize(token, Authorization.VIEW_LOGS)`.
   - `gate.ok()`가 거짓이면 `json.write(..., ReasonStatus.of(gate.reason()), JsonHttp.fail(gate.reason()))` 후 **return**(미인증 401 · 비-Z 403 — **스트림을 열기 전**).
   - `digest` 핸들러와 **같은 방식**으로 게이트하라(판정이 두 곳으로 갈리면 한쪽만 고쳐도 조용히 뚫린다).
2. `SseHttp.Stream s = sse.open(request, response)`.
3. `s.write(SseHttp.READY)`.
4. **replay**: `List<LogRecord> snap = logs.snapshot();` → **마지막 `LOG_REPLAY_MAX`(=2000)건만** 순서대로 `s.write(frame("log", json(rec.asMap())))`.
   - `LOG_REPLAY_MAX`는 이 컨트롤러의 `private static final int` 상수로 두고 javadoc에 "Node `server/index.js` 1178행과 정렬"을 적는다.
5. **subscribe**: `AutoCloseable sub = logs.subscribe(rec -> { ... })`; 콜백 내용:
   - `Identity actor; try { actor = sessions.peekSession(token); } catch (RuntimeException ex) { seal(); return; }`
   - `if (actor == null || !"Z".equals(actor.role())) { seal(); return; }` — **그 로그 라인을 쓰지 않는다.**
   - `s.write(frame("log", json(rec.asMap())))` — 실패면 구독 해제.
   - **이 콜백 안에서 `LogService`에 로그하지 마라**(무한 재귀).
6. `seal()` = ① `sub.close()` → ② `s.write(SseHttp.UNAUTHORIZED)` → ③ `s.close()`. 멱등.
7. `s.onClosed(() -> sub.close())`.

주의:
- role 재판정은 **`Authorization`을 통해** 하는 편이 좋다(문자열 `"Z"`가 두 곳에 생기지 않게). `authorize(token, VIEW_LOGS)`를 push 시점에 다시 부르되 **그것이 세션을 연장하지 않는지** 반드시 확인하라 — `Authorization`이 내부에서 `touchSession`을 쓴다면 **push 경로에는 쓸 수 없다**. 그 경우 `peekSession` + `VIEW_LOGS`의 역할 목록을 참조하는 별도 판정 지점을 만들고, 그 지점이 `Authorization`의 역할 표와 **같은 출처**를 쓰도록 하라(역할 목록을 복제하지 마라).
- **replay는 재검증하지 않는다**(Node 동형 · "같은 tick").

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
7. **순서**: `ready`가 **첫 프레임**이고 그 다음이 replay `log`들이며, live는 그 뒤다.
8. **강등 봉인(ADR-007의 핵심)**: Z로 스트림을 연 뒤 그 사용자를 **D로 강등**하고 새 로그를 발생시키면 → **`log` 프레임이 한 줄도 나가지 않고** `unauthorized` 1회 후 종료, 이후 2초 침묵.
9. **비활성화 봉인**: 사용자를 `active=N`으로 만들면 동일하게 봉인된다.
10. **로그아웃 봉인**: 세션 무효화 후 동일하게 봉인된다.
11. **비연장 peek**: push가 세션 유휴 만료를 연장하지 않는다(시계 주입).
12. **fail-closed**: 재검증이 예외를 던지면 그 줄을 쓰지 않고 봉인한다.
13. **누수 0**: 스트림 5개를 열고 닫으면 `LogService.subscriberCount()`가 0. 소켓을 그냥 끊은 경우에도 0.
14. **재귀 없음**: 스트림 1개를 연 채 요청 1건을 보내면 **버퍼 증가분이 유한**하다(폭주 0). 그리고 SSE 구독 콜백 소스에 `logs.info/warn/error/debug` 호출이 **0건**임을 정적 스캔으로 단언한다.
15. **워커 점유 0**: 스트림을 열어 둔 채 다른 라우트 10건이 정상 응답.
16. **마스킹**: 이 테스트 파일의 어떤 단언 메시지도 로그 **실값**을 출력하지 않는다(키 집합·정규식 판정만 · `assert*` 실패 메시지에 record 내용을 넣지 마라).
17. `HandlerInventoryTest` **39행** green · `PathPolicyWireTest` 새 프로브 green.

## Acceptance Criteria

```bash
# 1) Java 전체
cd /d/agents/harness/server-spring && JAVA_HOME="D:/agents/tools/jdk-21.0.12+8" ./mvnw -B clean verify
#   기대: BUILD SUCCESS · Tests run: <step4 종료 수치 + 신규 N> · Failures 0 · Errors 0 · Skipped 0

# 2) jar 갱신 후 계약 — **이 step의 green 지점**
cd /d/agents/harness/server-spring && JAVA_HOME="D:/agents/tools/jdk-21.0.12+8" ./mvnw -B -q package -DskipTests
cd /d/agents/harness && SPRING_JAVA_HOME="D:/agents/tools/jdk-21.0.12+8" node scripts/spring-contract.mjs --profile default
#   기대: exit 0 · default **files=14** · covered=**32/39**(29 + stream + logs-stream + logs-digest — 실측해 기록)

# 3) 패리티 — P1 최종 수치
cd /d/agents/harness && SPRING_JAVA_HOME="D:/agents/tools/jdk-21.0.12+8" node scripts/spring-contract.mjs --parity
#   기대: exit 0 · profiles=5 · **313관측 diffs 0**(default **246** · minimal 55 · auth-negative 4 · failclosed 5 · prod-cookie 3)

# 4) 자기 결정성
cd /d/agents/harness && SPRING_JAVA_HOME="D:/agents/tools/jdk-21.0.12+8" node scripts/spring-contract.mjs --dual-run
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
| M5-5 | replay를 ready **앞**으로 | Java 항목 7 red(계약은 순서를 단언하지 않는다 — 그 사실도 기록) |
| M5-6 | push 재검증을 `touchSession`으로 | Java 항목 11 red · 계약 green |
| M5-7 | 구독 콜백 안에서 `logs.warn(...)` 호출 | Java 항목 14 red(폭주/정적 스캔) |
| M5-8 | 구독 해제 제거 | Java 항목 13 red |
| M5-9 | `LogsController`에 `@Scheduled` heartbeat | `Adr008DisciplineTest` red |
| M5-10 | scope 표에서 `logs.contract.js` 행 삭제 | `HandlerInventoryTest` green · `--parity`가 **306관측**으로 조용히 줄어든다(exit 0) — 기계 증거는 관측 수뿐 |
| M5-11 | 프로브를 옮기지 않고 `/api/logs/stream`에 둠 | `PathPolicyWireTest` red(200이 된다) — 이동이 필수였다는 실증 |
| M5-12 | `LogRecord.asMap()`에서 `seq` 제거 | 계약 `assertLogRecord` red(키 집합) |

각 변이는 green→red→green 3단계 기록 + 원복 후 `cmp` byte-identical + `git status --porcelain` 무변.

## 금지사항

- **role 게이트를 빼거나 `/api/stream`과 같은 등급으로 맞추지 마라.** 이유: Node 1162행 주석이 명시한다 — "게이트를 빼면 R/D가 서버 로그(전 사용자 요청 흔적)를 본다". ADR-007이 Z 전용으로 봉인한 축이다.
- **role을 요청 헤더·본문·쿼리에서 도출하지 마라.** 이유: ADR-004 — 신원과 역할은 **검증된 세션에서만** 도출한다.
- **push 시점에 `touchSession`을 쓰지 마라.** 이유: 열린 스트림이 세션 만료를 무한 연장한다. 계약이 못 보는 축이다.
- **replay를 `LogService.snapshot()` 쪽에서 자르지 마라.** 이유: 절단 지점이 둘이 되면 한쪽만 고쳐도 조용히 갈린다(step1이 그렇게 못 박았다).
- **구독 콜백 안에서 `LogService`에 로그하지 마라.** 이유: 통지 → 로그 → 통지의 무한 재귀다.
- **로그 실값(경로·userId·메시지)을 단언·실패 메시지·리포트·주석에 싣지 마라.** 이유: LOGS.md 마스킹 — 이 버퍼는 `GET /api/logs/digest`로 밖으로 나간다. **여기 들어간 한 조각은 곧 응답이다.**
- **프로브를 같은 이름으로 두고 경로만 바꾸지 마라.** 이유: 의미가 "스텁 금지"에서 "미정의 경로 404 shape"으로 **바뀐다** — 이름을 유지하면 다음 사람이 스텁 금지가 여전히 지켜지는 줄 안다(73 forward_notes (3)).
- **`LogRecord`의 5키·`line` 포맷·`digest()` 창을 바꾸지 마라.** 이유: 계약 동결 축이다.
- **`contract/**`·`docs/api-contract/**`·`server/**`·`src/**`·`test/**`·`spikes/**` 등 무접촉 목록을 고치지 마라.**
- **`git add -A`를 쓰지 마라** — 명시 경로만.
