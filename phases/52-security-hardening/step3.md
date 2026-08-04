# Step 3: sse-reauth

## 읽어야 할 파일

먼저 아래 파일들을 읽고 프로젝트의 아키텍처와 설계 의도를 파악하라:

- `docs/ADR.md` — ADR-005(SSE 무효화 스트림), **ADR-007(관리자 로그 SSE는 실데이터 push, Z 전용 봉인)**, ADR-008(앱 내 타이머·외부 egress 금지)
- `docs/LOGS.md` — 로그 노출 정책(파일 미저장, in-memory 링 버퍼)
- `docs/ARCHITECTURE.md` — 실시간 동기화 흐름
- `server/index.js` — `GET /api/stream`(무효화 신호 브로드캐스트, `bus.on('change', onChange)` / `req.on('close', ...)`)과 `GET /api/logs/stream`(Z 전용, 접속 시 버퍼 replay 후 `logService.subscribe(...)` push) 전량, 그리고 `sessionOf`
- `src/controllers/index.js` — **step 2에서 `auth.peek(sessionId)`가 추가됐다**(비연장 재검증 조회)
- `src/services/sessionGuard.js` / `src/services/sessionService.js` — step 1 산출물(`peekSession`은 만료를 연장하지 않고, User 행을 재조회해 비활성/삭제/역할 변경을 반영한다)
- `src/services/logService.js` — `subscribe(listener)` 반환값(구독 해제 함수), `snapshot()`
- `test/logs-api.test.js` — SSE를 저수준으로 읽는 `streamGet(base, path, { headers, until, timeoutMs })` 패턴(청크 누적)
- `test/sse-auth.test.js` — `/api/stream` 인증 테스트 패턴

## 배경 (이 step 안에서 자기완결)

2026-08-03 전수감사 발견 [medium]: `GET /api/logs/stream`(Z 전용)은 **접속 시점에 한 번만** 인증한다. 그래서 로그아웃·세션 만료·역할 강등·계정 비활성화가 일어나도 **연결이 살아 있는 한 전 사용자 요청 로그가 계속 푸시**된다. ADR-007은 "Z 전용 봉인"을 전제로 실데이터 push를 정당화했는데, 그 전제가 시간축에서 깨진다. `GET /api/stream`(로그인 전용, 무효화 신호)도 같은 성질이다 — 페이로드에 행 데이터가 없어 노출 위험은 낮지만 인증 만료가 강제되지 않는 문제는 동일하다.

확정된 설계(재논의하지 마라): **push 시점 재검증**. 이벤트를 쓰기 직전에 `controllers.auth.peek(sid)`로 세션·역할을 재확인하고, 실패하면 그 이벤트를 쓰지 않고 스트림을 종료한다. 타이머(setInterval)를 도입하지 않는다(ADR-008). 재검증은 **비연장 peek**로 한다 — `touchSession`을 쓰면 열려 있는 SSE가 세션을 무기한 연장해 유휴 만료가 무력화된다.

## 작업

### 1) 착수 전 실측

```bash
npm test        # step 2 반영본 기준선 pass, fail 0
npm run lint
```

`server/index.js`의 두 SSE 라우트 현재 코드를 정확히 읽고, `res.write` 호출 지점을 모두 파악하라(ready, change, replay log, live log).

### 2) 테스트 먼저 (TDD — red 확인 필수)

`test/sse-reauth.test.js`를 신설한다. 조립은 `test/logs-api.test.js`와 동형(`createControllers`로 앱을 만들고 `logService`를 주입해 로그 라인을 결정적으로 만든다), 스트림 읽기는 그 파일의 `streamGet(..., { until })` 패턴을 재사용한다.

공격/보안 시나리오:

1. Z 로그인 → `/api/logs/stream` 접속(ready + replay 수신 확인) → `POST /api/logout` → 새 로그 라인 발생 → 스트림에 **그 로그 라인이 실리지 않고**, `event: unauthorized`가 1회 온 뒤 서버가 연결을 끝낸다.
2. Z 로그인 → 스트림 접속 → Z가 자기 role을 `'R'`로 강등 → 새 로그 발생 → 로그 미전송 + `unauthorized` 종료(역할 강등이 스트림에 반영된다).
3. Z 로그인 → 스트림 접속 → 그 계정 `active='N'` → 새 로그 발생 → 로그 미전송 + 종료.
4. `/api/stream`: 로그인 → 접속 → 로그아웃 → 다른 사용자의 기사 생성으로 `notifyChange` 유발 → `event: change` 미전송 + `unauthorized` 종료.
5. 세션 만료: 가짜 시계(`createSessionService({ now })`)로 발급 후 1시간 이상 전진 → 다음 push 시점에 종료된다(만료가 실제로 강제된다).

정상 플로우 무손상(회귀 케이스 — 반드시 포함):

6. 유효한 Z 세션에서는 접속 후 발생한 로그 라인들이 계속 전달되고 연결이 유지된다(재검증이 정상 스트림을 끊지 않는다).
7. 유효한 일반 세션에서 `/api/stream`의 `change` 신호가 정상 전달된다.
8. SSE 연결만 유지하는 동안 세션이 **연장되지 않는다**: 가짜 시계로 push를 여러 번 발생시켜도 최초 발급 후 1시간이 지나면 종료된다(연장하는 구현이면 red).
9. 접속 시점 인증은 그대로다 — 미인증 401, 비-Z의 로그 스트림 403(`test/logs-api.test.js`·`test/sse-auth.test.js` 기존 케이스 green).
10. 종료 시 구독이 해제된다 — `logService.subscribe`/`bus`의 리스너가 남지 않는다(누수 금지: `bus.listenerCount('change')`나 주입 로그 서비스의 구독 수로 단언).

프레임 형식 잠금(반드시 포함 — 문자열 "포함" 단언만으로는 잡히지 않는다):

11. 시나리오 1(로그 스트림)과 4(`/api/stream`) 각각에서 수신 버퍼가 **`'event: unauthorized\ndata: {"ok":false,"reason":"unauthenticated"}\n\n'` 전체(끝의 빈 줄 포함)로 끝나고 그 뒤에 추가 바이트가 없음**을 단언한다(예: `buf.endsWith(FRAME)`). 종결 개행을 하나 지우면 red가 되어야 한다.

### 3) 구현 — `server/index.js`의 두 SSE 라우트만 수정

공통 헬퍼(라우트 안 지역 함수 또는 파일 스코프 헬퍼)를 하나 두고 두 라우트가 같은 방식으로 끝내게 하라:

```js
// 재인증 실패 시: 구독 해제 → 종료 이벤트 1회 → res.end(). 중복 호출은 무시(플래그).
// 종료 이벤트 계약(클라이언트가 이 이름으로 EventSource를 닫는다 — step 5).
// 정확히 이 바이트열이어야 한다(끝의 빈 줄 = 프레임 종결자):
res.write('event: unauthorized\ndata: {"ok":false,"reason":"unauthenticated"}\n\n');
```

**CRITICAL(프레임 종결):** SSE는 **빈 줄(`\n\n`)로 프레임이 끝나야** 브라우저가 이벤트를 디스패치한다. 마지막 `\n`을 빠뜨리면 서버 테스트도(문자열 포함 단언) 클라이언트 테스트도(step 5는 FakeEventSource의 `emit`을 직접 호출한다) green이지만, **실제 브라우저는 이 이벤트를 영원히 받지 못해** 무한 재연결이 그대로 남는다 — 이 phase의 수정이 실환경에서만 무효가 되는 조합이다. 기존 `ready` 프레임(`res.write('event: ready\ndata: {"ok":true}\n\n')`)과 정확히 같은 규율을 따르고, 아래 시나리오 11로 잠근다.

- `/api/stream`: 접속 시 인증은 현행 유지(`sessionOf`/`controllers.auth.session`). 접속 시 `sid`를 클로저에 잡아두고, `onChange`에서 **write 전에** `controllers.auth.peek(sid)`를 호출한다. falsy면 종료.
- `/api/logs/stream`: 접속 시 인증·Z 게이트는 현행 유지. live push 콜백에서 **write 전에** `controllers.auth.peek(sid)` 호출 → falsy이거나 `role !== 'Z'`이면 종료. 접속 직후의 replay 루프는 접속 시점 인증으로 충분하다(추가 검사 불필요).
- 종료 사유를 응답 본문에 상세히 적지 마라(누가/왜는 노출하지 않는다). 고정 토큰 `unauthenticated`만 쓴다.
- `req.on('close', ...)`의 기존 구독 해제는 그대로 두고, 종료 헬퍼도 같은 해제 함수를 호출하도록 해 이중 해제에 안전하게 만들어라.

### 4) `docs/ADR.md` 갱신

- **ADR-007**: 트레이드오프 문단에 "접속 시점 인증만으로는 로그아웃·만료·강등 이후에도 push가 계속되던 문제를 push 시점 재검증(비연장 peek)으로 닫았고, 무효화 이후에는 단 한 줄도 전송되지 않는다. 다만 이벤트가 없으면 연결 종료가 다음 이벤트까지 지연된다(타이머를 두지 않기 때문 — ADR-008)"는 사실을 1~2문장으로 추가한다.
- **ADR-005**: `/api/stream`도 같은 재검증을 적용한다는 사실을 1문장으로 추가한다.
- 결정 문장 자체와 다른 ADR 본문은 수정하지 마라.

## Acceptance Criteria

```bash
node --test test/sse-reauth.test.js test/logs-api.test.js test/sse-auth.test.js   # 신규 + 기존 SSE 테스트 green
npm test                                                                          # 전체 green, fail 0
npm run lint                                                                      # clean
```

## 검증 절차

1. 위 AC 커맨드를 실행한다.
2. 변이 검증: (a) push 전 재검증 호출을 제거하면 시나리오 1~4가 red, (b) `peek` 대신 `session`(연장 조회)을 쓰면 시나리오 8이 red, (c) 종료 프레임의 마지막 `\n` 하나를 지우면 시나리오 11이 red인지 확인하고 전부 원복한다.
3. `grep -n "setInterval\|setTimeout" server/index.js`로 이 step이 타이머를 도입하지 않았는지 확인한다(테스트 파일의 타임아웃 헬퍼는 대상 아님).
4. 아키텍처 체크리스트:
   - 수정 범위가 `server/index.js`(SSE 2개 라우트) + `docs/ADR.md` + 테스트뿐인가? (`src/`·`web/` 변경 0건)
   - ADR-008(앱 내 타이머 없음)을 지켰는가?
   - 로그 라인·세션 토큰 등 민감 값이 종료 이벤트 payload에 들어가지 않았는가?
5. 결과에 따라 `phases/52-security-hardening/index.json`의 step 3을 업데이트한다:
   - 성공 → `"status": "completed"`, `"summary": "재검증 지점·종료 이벤트 계약(event: unauthorized)·테스트 증감 — step 5가 소비할 계약을 명시"`
   - 3회 수정 후에도 실패 → `"status": "error"`, `"error_message": "구체적 에러"`
   - 사용자 개입 필요 → `"status": "blocked"`, `"blocked_reason": "사유"` 후 즉시 중단

## 금지사항

- `setInterval`/`setTimeout`으로 주기 재검증이나 하트비트를 만들지 마라. 이유: ADR-008의 "앱 내 타이머 없음" 규율 위반이며, 다중 연결·다중 인스턴스에서 예측 불가능한 부하와 종료 타이밍을 만든다. 재검증은 push 시점에만 한다.
- 재검증에 `touchSession`(연장 조회)을 쓰지 마라. 이유: 열린 SSE가 세션을 무한 연장해 1시간 유휴 만료가 무력화된다(감사 지적을 다른 형태로 되살리는 것).
- 재검증 결과를 캐시하지 마라. 이유: 캐시 창이 곧 무효화 지연이다.
- 접속 시점 인증·Z 역할 게이트를 제거하거나 완화하지 마라. 이유: ADR-007의 Z 전용 봉인이 로그 노출을 정당화하는 유일한 근거다.
- 스트림 종료를 HTTP 상태 코드로 표현하려 하지 마라(이미 200 헤더가 나갔다). 이유: 헤더 재전송은 불가능하다 — 종료는 `event: unauthorized` + `res.end()`로만 한다.
- 클라이언트(`web/`)를 이 step에서 수정하지 마라. 이유: 종료 이벤트를 소비하는 클라이언트 변경은 step 5다(레이어 분리).
- 구독 해제 없이 `res.end()`만 호출하지 마라. 이유: 닫힌 응답에 write가 누적돼 리스너 누수와 예외가 발생한다.
- 종료 프레임의 종결 빈 줄(`\n\n`)을 빠뜨리지 마라. 이유: 브라우저가 이벤트를 디스패치하지 않아 클라이언트가 EventSource를 닫지 못하고 무한 재연결이 남는데, 서버·클라이언트 테스트는 둘 다 green이라 실환경에서만 조용히 실패한다.
- 기존 테스트를 깨뜨리지 마라. 특히 `test/logs-api.test.js`의 replay·Z 게이트 케이스와 `test/sse-auth.test.js` 전부.
