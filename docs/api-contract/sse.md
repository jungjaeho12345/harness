# SSE 프레임 계약 (2026-08-19 현행 코드 실측)

정본은 `server/index.js`(1127~1217행)다. 이 문서는 두 스트림의 와이어 계약을 바이트 수준으로 동결한다. 예시의 형식은 `spikes/p0-spring/CONTRACT.md`를 따르되 전부 현행 코드에서 다시 확인했다.

## 스트림 2개

| 경로 | 인가 | 내용 |
|---|---|---|
| `GET /api/stream` | 세션(로그인만) | **무효화 신호만** — 행 데이터 없음(ADR-005) |
| `GET /api/logs/stream` | 세션 + **role Z 전용** | 로그 라인 **실데이터** push(ADR-007 — ADR-005 원칙의 유일 예외) |

## 인증과 스트림 열기 전 거부

- 세션 토큰 판독은 **쿠키(`sid`) 우선, `x-session-id` 헤더 폴백**이다. 평문 `?session=` 쿼리 폴백은 존재하지 않는다(제거됨 — URL 누출 표면).
- 인증/인가 실패는 **스트림을 열기 전** 일반 JSON으로 끝난다:
  - `/api/stream`: 미인증 → `401 {"ok":false,"reason":"unauthenticated"}`
  - `/api/logs/stream`: 미인증 → 401 동형, 인증됐지만 비-Z → `403 {"ok":false,"reason":"forbidden"}`
- 즉 SSE 헤더(200)가 이미 나간 뒤의 세션 무효화는 HTTP 상태로 표현할 수 없고, 아래 `unauthorized` 이벤트 + 연결 종료가 유일한 수단이다.

## 응답 헤더 3종 + 즉시 flush

```
Content-Type: text/event-stream
Cache-Control: no-cache
Connection: keep-alive
```

헤더 설정 직후 `flushHeaders()` 하고 곧바로 ready 프레임을 쓴다.

## 프레임 문법

- 프레임 = `event: <이름>` 줄 + `data: <JSON 1줄>` 줄 + **빈 줄(프레임 종결자)**. 줄바꿈은 LF(`\n`)다.
- **CRITICAL**: 끝의 빈 줄(`\n\n`)이 빠지면 브라우저 EventSource가 이벤트를 디스패치하지 않는다 — 클라이언트가 스트림을 닫지 못하고 무한 재연결이 남는다(서버·클라 테스트 둘 다 green인 채 실환경만 조용히 실패하는 함정).
- `id:`·`retry:` 필드는 쓰지 않는다(Last-Event-ID 프로토콜 미구현 — 재연결 유실은 로그 스트림의 replay가 해소).

## 이벤트 어휘 4종 (바이트 예시)

```
event: ready
data: {"ok":true}
␊
event: change
data: {"kind":"update"}
␊
event: log
data: {"seq":42,"ts":1755590400000,"level":"INFO","message":"<redacted>","line":"[YYYY-MM-DD HH:MM:SS] [INFO] <redacted>"}
␊
event: unauthorized
data: {"ok":false,"reason":"unauthenticated"}
␊
```

(␊ = 프레임 종결 빈 줄. `log`의 message/line 실값은 서버 로그 라인이며 이 문서에는 싣지 않는다 — LOGS.md 마스킹 규율.)

- `ready`: 접속 직후 1회. payload `{"ok":true}` 고정. 두 스트림 공통.
- `change`: `/api/stream` 전용. payload는 `{"kind":"create|update|status|lock"}` — **행 데이터 없음**. 클라이언트는 자기 권한/필터로 재조회한다.
- `log`: `/api/logs/stream` 전용. payload = record `{ seq, ts, level, message, line }` — `seq`는 프로세스 수명 단조 증가(중복 필터용), `ts`는 epoch ms, `level`은 DEBUG|INFO|WARN|ERROR, `line`은 `[YYYY-MM-DD HH:MM:SS] [LEVEL] 메시지`(KST 벽시계).
- `unauthorized`: 종료 신호. payload `{"ok":false,"reason":"unauthenticated"}` 고정(로그아웃·만료·강등·비활성을 구분하지 않는다). **이 프레임 1회 후 서버가 `res.end()` 한다.** 클라이언트는 이 이벤트에서 EventSource를 닫는다(연결 단절만으로는 자동 재연결이 계속된다).

## `/api/stream` — 무효화 신호의 발생 라우트 표

| kind | 발생 지점(성공 시에만) |
|---|---|
| `create` | POST /api/articles · POST /api/articles/:id/derive · POST /api/collection/receive · POST /api/collection/pull · (HTTP 밖) FTP watcher 수신 |
| `update` | PUT /api/articles/:id |
| `status` | POST /api/articles/:id/action · POST /api/distribution/tick(**distributed 1건 이상일 때만**) · POST /api/distribution/retry(재전송 성공 시에만) |
| `lock` | POST /api/articles/:id/lock · /unlock · /force-unlock |

- 거부/실패 응답은 신호를 내지 않는다(변경 0건 재조회 낭비 + 오신호 방지).
- 송고 훅의 비동기 엠바고 승격(DES→EPS→DPS, articleService.syncEmbargoStatus)은 **자체 신호를 내지 않는다** — 상태 변화 관측은 tick 라우트의 `status` 신호 또는 재조회에 의존한다.

## `/api/logs/stream` — replay 계약

- 접속 직후 링 버퍼의 **최근 2000건**(`LOG_REPLAY_MAX`)을 `log` 프레임으로 replay한 뒤 실시간 push를 잇는다(버퍼 cap은 10000 — replay는 그 중 최근 2000).
- replay는 접속 시점 인증으로 충분하다(같은 tick — 재검증 없음). 중복 라인은 클라이언트가 `seq`로 거른다.

## push 시점 비연장 재검증 (peek)

- **매 push 직전** 세션을 재검증한다. 반드시 **비연장 peek**이다 — touch면 열린 스트림이 세션 유휴 만료(1시간)를 무한 연장한다.
- `/api/stream`: peek 실패(무효 세션) 또는 peek 중 예외(DB 장애 등) → 그 신호를 **쓰지 않고** `unauthorized` 프레임 1회 후 종료(fail-closed).
- `/api/logs/stream`: peek 실패 **또는 role이 Z가 아니게 된 경우**(강등) → 그 로그 라인을 **한 줄도 쓰지 않고** 동일하게 종료. Z 전용 봉인이 시간축에서도 유지된다.
- 주기 재검증 타이머는 없다(ADR-008 — 앱 내 타이머 금지). 대가: 이벤트가 없으면 종료가 다음 이벤트까지 지연된다.

## 판정 시 주의 (계약 테스트 규율 — decisions (10))

- EventSource가 아니라 fetch 스트림을 읽어 `\n\n` 경계로 프레임을 자른다(쿠키·헤더 인증 겸용).
- 반드시 `ready` 수신 **후** 트리거(POST)를 쏜다. 판정은 "유한 시간 안에 조건 프레임 도착"(다른 kind가 섞여 와도 통과)이다 — 정확 개수·순서 단언은 flake가 된다.
- 클라이언트는 동시 SSE 연결 2개(writer + list)를 여는 것이 정상 사용 패턴이다 — 서버는 구독자 수 제한이 없다(`setMaxListeners(0)`).
