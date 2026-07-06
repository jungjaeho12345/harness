# Step 2: log-api — Z 전용 로그 스트림(SSE) + 다이제스트 엔드포인트 + ADR-007 기록

## 배경 / 요구사항

Step 0에서 `src/services/logService.js`(record `{ seq, ts, level, message, line }`, `snapshot()/subscribe()/digest()`)를, Step 1에서 그 logService를 `createApp({ ..., logService })`로 주입하고 서버 곳곳을 계측했다. 이제 서버는 로그를 **생산**한다.

이 step은 로그를 **노출하는 두 개의 읽기 전용 엔드포인트**를 `server/index.js`에 추가한다:
1. `GET /api/logs/stream` — **실시간 로그 SSE**. 접속 시 현재 버퍼의 최근 2000건(`snapshot().slice(-2000)`)을 replay한 뒤, 이후 새 로그를 실시간 push.
2. `GET /api/logs/digest` — **다이제스트 pull**. `logService.digest()`(전날 06:00 ~ 당일 05:59:59.999 창)를 JSON으로 반환. 매일 6시 전달은 하네스 운영 루틴(phase 범위 밖)이 이 API를 읽어 수행한다.

### 확정된 설계 결정 (그대로 구현)

- **둘 다 Z(관리자) 전용.** 세션 role이 `Z`여야만 접근한다 — 미인증 401, 인증됐지만 비-Z(R/D) 403.
  - **CRITICAL 경고**: 기존 `GET /api/stream`(L672~688)은 **로그인만 요구**하고 role을 보지 않는다. 이 SSE 골격을 **그대로 복붙하면 R/D도 로그를 본다** — 반드시 role Z 게이트를 추가하라. role은 검증된 세션에서만 도출한다(`sessionOf(req).me.role`, ADR-004). `req.query`/`req.body`의 role은 신뢰하지 않는다.
- **ADR-005 예외 기록 필수.** 기존 SSE(`/api/stream`)는 "행 데이터 없는 무효화 신호만" 원칙(ADR-005)이다. 로그 스트림은 **실데이터(로그 라인)를 push**하므로 그 원칙의 예외다. `docs/ADR.md`에 **ADR-007**로 이 예외 결정을 기록한다(Z 전용 게이트로 노출을 봉인·in-memory 링 버퍼·비영속).
- **재연결 replay로 단순 해소.** EventSource 자동 재연결 시 끊긴 구간 유실을 막기 위해 **접속마다 `snapshot()`의 최근 2000건을 먼저 보낸 뒤 실시간**을 잇는다(2000 = step4 클라 MAX_LINES와 정렬 — 전체 cap 10000건 replay는 첫 접속 렌더 폭주/대역폭 낭비). Last-Event-ID 프로토콜은 구현하지 않는다(과설계). 재연결 시 replay로 중복될 수 있는 라인은 클라이언트가 record `seq`로 걸러낸다(step4 책임).

## 읽어야 할 파일

- `/CLAUDE.md`, `/docs/ARCHITECTURE.md` — 얇은 transport(ADR-006), 신뢰 경계=서버.
- `/docs/ADR.md` — ADR-004(세션 role 게이트), ADR-005(SSE 무효화 신호 원칙 — 이 step이 예외를 추가). **파일 끝에 ADR-007을 append한다.**
- `/docs/LOGS.md` — 다이제스트 창 규칙("전날 하루부터 오전 5시 59분까지").
- `src/services/logService.js` (Step 0) — `snapshot()`(replay 소스), `subscribe(listener)`(실시간 push 소스, 반환 unsubscribe), `digest(atMs=now())`(창 계산). 이 step 라우트는 이 메서드에 위임만 한다.
- `server/index.js` — **결선 지점(실측)**:
  - `sessionOf(req)`(L285~288) → `{ sid, me }`, `me.role`로 Z 판정. `UNAUTH`(L79)/`FORBIDDEN`(L80) 상수.
  - `GET /api/stream` SSE 골격(L672~688) — 헤더 셋(text/event-stream)·`flushHeaders`·`event: ready`·`bus.on/off`·`req.on('close')` 패턴. **role 게이트만 추가해 재사용**한다(무효화 버스 대신 logService.subscribe).
  - `logService`는 Step 1에서 `createApp` 옵션으로 주입돼 이 스코프에서 접근 가능하다.
  - 전역 에러 핸들러(L690~694) — 새 라우트는 그 **앞**에 둔다(마지막 등록이 에러 핸들러).
- `test/sse-auth.test.js` — SSE 저수준 테스트 골격: `start()`(in-memory createApp + listen(0)), `login()`, `streamGet()`(첫 SSE 청크만 읽고 destroy / 비-200은 바디 수집), Z가 아닌 사용자로 role 게이트를 검증하는 방법. **이 파일을 본떠 새 테스트 파일을 쓴다.**

## 작업

TDD로 진행한다(`node --test`). **테스트를 먼저 작성**하고 통과하는 라우트를 만든다. 이 step은 `server/index.js`(라우트 2개) + `docs/ADR.md`(ADR-007) + 테스트만 다룬다.

### 1. `GET /api/logs/digest` (Z 전용, 읽기 전용) — `server/index.js`

- `/api/stream` 인접 위치(전역 에러 핸들러 앞)에 추가:
  ```js
  // 로그 다이제스트 — 전날 06:00~당일 05:59:59.999 창. Z 전용. 읽기 전용(메모리 버퍼만 읽음).
  app.get('/api/logs/digest', (req, res, next) => {
    try {
      const { me } = sessionOf(req);
      if (!me) return res.status(401).json(UNAUTH);
      if (me.role !== 'Z') return res.status(403).json(FORBIDDEN);
      return res.json({ ok: true, items: logService.digest() });
    } catch (e) { next(e); }
  });
  ```
  - `digest()`는 인자 없이 호출(내부 `now()` 사용). 반환 record 배열을 `items`로 싣는다.

### 2. `GET /api/logs/stream` (Z 전용 SSE, 읽기 전용) — `server/index.js`

- `/api/stream` 골격을 재사용하되 **role Z 게이트 + logService 구독**으로 바꾼다:
  ```js
  app.get('/api/logs/stream', (req, res) => {
    const { me } = sessionOf(req);        // 쿠키/x-session-id에서 검증 세션 도출
    if (!me) return res.status(401).json(UNAUTH);
    if (me.role !== 'Z') return res.status(403).json(FORBIDDEN);   // ★ 비-Z 차단 — /api/stream엔 없는 게이트
    res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    if (res.flushHeaders) res.flushHeaders();
    res.write('event: ready\ndata: {"ok":true}\n\n');
    // 접속 시 버퍼를 replay(끊긴 구간 유실 방지 — 재연결 시에도 다시 보냄).
    // 최근 2000건만 — step4 클라 MAX_LINES(2000)와 정렬. 전체 cap(10000) replay는 낭비.
    for (const rec of logService.snapshot().slice(-2000)) res.write(`event: log\ndata: ${JSON.stringify(rec)}\n\n`);
    // 이후 새 로그를 실시간 push.
    const off = logService.subscribe((rec) => res.write(`event: log\ndata: ${JSON.stringify(rec)}\n\n`));
    req.on('close', () => off());
  });
  ```
  - replay와 실시간 모두 `event: log` + record JSON(`{ seq, ts, level, message, line }`). 클라(step4)가 `seq`로 replay 중복을 거른다.
  - `req.on('close')`에서 반드시 `unsubscribe`(off)를 호출해 구독 누수를 막는다.
  - **인증 실패(401/403)는 SSE 헤더를 열기 전에** JSON으로 끝낸다(스트림을 열지 않는다).

### 3. ADR-007 기록 — `docs/ADR.md`

- 파일 끝에 ADR-005의 예외로 **ADR-007**을 append한다(형식은 기존 ADR-00N와 동일: 결정/이유/트레이드오프 3단). 담을 내용:
  - **결정**: 관리자용 실시간 로그 뷰어를 위해 `/api/logs/stream`(SSE)로 **로그 라인 실데이터**를 push하고, `/api/logs/digest`로 24시간 창을 pull한다. 로그는 **in-memory 링 버퍼**에만 보존(파일/DB 미저장), 두 엔드포인트는 **세션 role Z 전용**. EventSource 인증은 **HttpOnly 세션 쿠키(withCredentials)** — 쿼리스트링에 토큰을 싣지 않는다(평문 토큰 URL 누출 표면 금지, 기존 `?session=` 폴백은 이미 제거됨).
  - **이유**: ADR-005의 "행 데이터 없는 무효화 신호" 원칙은 역할별 데이터 노출을 피하기 위함인데, 로그는 그 자체가 표시 대상이라 신호만으로는 불가능하다. Z 전용 게이트로 노출을 봉인해 위험을 좁힌다. zero-dep(log4j 스타일 자체 구현), LOGS.md "파일 미저장" + DB 비파괴(무한 증식 방지)를 지킨다. LOGS.md의 "전날 하루부터 오전 5시 59분까지"는 **06:00 정렬 24시간 창 [D-1 06:00, D 06:00)** 으로 확정 해석한다.
  - **트레이드오프**: 서버 재시작 시 버퍼 유실. cap(예: 10000줄) 초과 시 오래된 로그 evict. 다이제스트 6시 전달은 앱이 아니라 운영 루틴이 pull로 수행(앱에 타이머/외부 egress 없음).

### 4. 테스트 (먼저 작성) — `test/logs-api.test.js` (신규)

`sse-auth.test.js`의 `start()`/`login()`/`streamGet()`를 본뜬다. `createApp`에 **미리 로그를 채운 logService 인스턴스**를 주입해(예: `const logService = createLogService(); logService.info('seed-a'); logService.warn('seed-b');` 후 `createApp({ ..., logService })`) 결정적으로 검증한다:

- **digest 인가**:
  - 미인증 → 401.
  - R(비-Z) 로그인 → 403(`forbidden`). **핵심 보안 단언 — 200이 아님.**
  - Z 로그인 → 200 + `items` 배열(시드 포함). **주의: 기본 시계로 시드하면 digest는 항상 빈 배열이다** — 창은 [직전 06:00, 당일 06:00) 반열림이라, now 시점에 기록한 로그의 ts는 boundary(직전 06:00) 이후여서 제외된다. step0 테스트처럼 **가변 가짜 시계를 주입**하라: `let clock; const logService = createLogService({ now: () => clock });`로 만들고, clock을 창 내부 시각(예: KST 전날 12:00에 해당하는 epoch ms)으로 두고 시드 기록 → clock을 당일 06:00:00(KST) 이후로 올린 뒤 digest를 호출·단언한다. (위 인라인 시딩 예시(기본 시계)는 stream replay 테스트 전용이다.)
- **stream 인가**:
  - 미인증 → 401(스트림 미개시, contentType이 event-stream 아님).
  - R(비-Z) → 403. **핵심 보안 단언 — 비-Z는 로그 스트림을 못 받는다(/api/stream과의 차이).**
  - Z → 200 + `text/event-stream`, 첫 청크에 `event: ready`, 그리고 replay된 `event: log`(시드 로그)가 포함됨(streamGet이 첫 data 청크를 읽음 — 필요 시 replay가 첫 청크에 실리도록 시드를 접속 전에 넣는다). **SSE 청크 분할은 프로토콜상 보장되지 않으므로**, 본뜬 헬퍼는 첫 청크에 기대 내용이 없으면 data 이벤트를 누적해 읽도록 확장하라(첫 청크 coalescing에 의존 금지).
- **구독 해제(누수 가드, 필수)**: Z로 스트림 접속 → 소켓 destroy → `logService.subscriberCount()`가 접속 전 기준선(0)으로 복귀함을 단언(close 전파는 비동기이므로 짧은 폴링/대기 허용). req close에서 off() 미호출 회귀를 테스트로 봉인한다.
- **회귀 가드**: 기존 `/api/stream`(무효화 신호)은 여전히 **로그인만으로** 통과함을 깨지 않았는지 확인(sse-auth.test.js가 이미 커버 — 이 파일에서 재검증 불필요, 다만 새 라우트가 기존을 건드리지 않았음을 전체 `npm run test`로 확인).

## Acceptance Criteria

```bash
npm run test          # node --test — logs-api 신규 테스트(인가 401/403/200 + SSE ready/replay) + 기존 전체 통과
npm run lint          # ESLint
```

기대 단언(요약): `/api/logs/digest`·`/api/logs/stream` 모두 미인증 401·비-Z 403·Z 200. stream은 text/event-stream + `event: ready` + 버퍼 replay(`event: log`, 최근 2000건). 접속 종료 시 subscriberCount 기준선 복귀(구독 누수 없음). digest는 `{ ok, items }`(가짜 시계로 창 내부 시드). ADR-007이 docs/ADR.md에 추가됨. 기존 `/api/stream`(무효화 신호) 회귀 없음.

## 검증 절차

1. 위 AC 커맨드를 실행한다(필요 시 `PYTHONUTF8=1`).
2. 아키텍처 체크리스트: 두 라우트 모두 **role Z 게이트**(비-Z 403, `/api/stream` 복붙 함정 회피)·role은 세션에서만 도출(ADR-004)·읽기 전용(logService에 위임만, DB/파일 미변경)·SSE는 접속 시 snapshot replay 후 subscribe·req close에서 unsubscribe(누수 방지)·에러 핸들러 앞 등록·ADR-007로 ADR-005 예외 문서화.
3. 결과에 따라 `phases/26-log-viewer/index.json`의 step 2를 갱신(completed+summary / error / blocked). summary에 두 라우트 경로·Z 게이트·응답 shape(`stream: event log {record}`, `digest: {ok, items}`)·ADR-007 추가를 남긴다.

## 금지사항

- `/api/logs/stream`·`/api/logs/digest`에서 role Z 게이트를 빼고 세션(로그인)만으로 통과시키지 마라. 이유: 사용자 확정 결정 — Z 전용. `/api/stream`(로그인만)을 그대로 복붙하면 R/D가 서버 로그를 본다(누출).
- role을 `req.query`/`req.body`에서 읽지 마라. 이유: 신뢰 경계=서버 — role은 `sessionOf(req).me.role`(검증 세션)에서만(ADR-004).
- SSE `req.on('close')`에서 `unsubscribe`를 호출하지 않고 두지 마라. 이유: 구독자 누수 → 닫힌 응답에 write 시도 → 메모리/에러 누적.
- 로그를 파일이나 DB에 쓰거나, 라우트에서 logService 외 다른 저장소를 만들지 마라. 이유: 링 버퍼(메모리)만 — LOGS.md/DB 비파괴.
- 다이제스트에 6시 타이머/스케줄러/외부 전송을 붙이지 마라. 이유: pull 전용 — 전달은 운영 루틴 책임(phase 범위 밖).
- 이 step에서 `web/`·model 계약(contract/httpModel/fakeModel)·logService 내부를 수정하지 마라. 이유: 이 step은 서버 라우트 + ADR 문서만 — 클라이언트는 step3~4, logService는 step0에서 완료.
- 새 npm 패키지를 추가하지 마라. 이유: zero-dep 확정.
- 기존 테스트를 깨뜨리지 마라(특히 `/api/stream` 회귀).
