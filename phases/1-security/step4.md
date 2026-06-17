# Step 4: sse-cookie-auth

## 읽어야 할 파일

먼저 아래 파일들을 읽고 프로젝트의 아키텍처와 설계 의도를 파악하라:

- `/docs/ADR.md` — ADR-005(SSE 무효화 스트림, "`EventSource`가 커스텀 헤더를 못 보내 이 라우트만 `?session=` 쿼리 인증 폴백을 둔다" — 본 step이 이 폴백을 대체한다), ADR-004(세션 인가)
- `/docs/ARCHITECTURE.md` — 실시간 동기화(SSE 무효화 신호)
- `server/index.js` — 특히 `GET /api/stream`(현재 `req.get('x-session-id') || req.query.session`로 인증) 및 step 3에서 추가된 **쿠키 파싱 헬퍼/`sessionOf`**(쿠키 `yh.sid` 우선). `/api/session`도 `?session=` 폴백을 갖는지 확인.
- `web/src/model/httpModel.js` — `subscribe`가 `EventSource('/api/stream?session=' + sessionId)`로 쿼리 토큰을 붙이는 현재 구현(프론트 전환은 step 6에서 한다 — 이 step은 서버만).
- `test/server.test.js` — SSE `ready` 이벤트 검증 테스트(있다면 위치 확인). step 3에서 추가된 쿠키 헬퍼.

step 3 summary에서 쿠키 헬퍼 이름/파싱 방식을 확인한 뒤 작업하라. 이 step은 step 3의 쿠키 파싱에 의존한다.

## 작업

SSE 인증을 **쿠키 기반**으로 전환해 `?session=` 쿼리 토큰 노출(서버 로그·Referer·브라우저 히스토리 유출 위험, ADR-005가 명시한 취약점)을 제거한다. **transport(server/index.js) 계층만** 다룬다. TDD: 실패 테스트 먼저.

### 결정 사항(이 step에서 고정)

- SSE(`GET /api/stream`)와 `/api/session`의 인증을 **쿠키(`yh.sid`) 우선**으로 한다. `EventSource`는 same-origin 또는 `withCredentials` 시 쿠키를 자동 전송하므로 더 이상 쿼리 토큰이 필요 없다.
- **`?session=` 쿼리 폴백 제거 여부**: SSE에서 쿼리 토큰 인증을 **제거**하는 것이 이 phase의 목표다(노출 표면 제거). 단, step 3에서 `x-session-id` **헤더 폴백을 유지**하기로 했으므로, `/api/stream`도 **쿠키 → (헤더) 순**으로 인증하고 **`req.query.session`만 제거**한다. 헤더 폴백은 EventSource에서는 쓸 수 없지만 비-EventSource 클라이언트/테스트 호환을 위해 남긴다(step 3과 일관). `/api/session`도 동일하게 `req.query.session`을 제거하고 쿠키/헤더로만 인증한다.

### 구현

1. `GET /api/stream`: 인증 도출을 step 3의 쿠키 파싱(`yh.sid`) → 헤더(`x-session-id`) 순으로 바꾼다. **`req.query.session` 사용을 제거**한다. 나머지(SSE 헤더 세팅, `ready` 이벤트, `change` 브로드캐스트, `req.on('close')` 정리)는 그대로 둔다 — 무효화 신호 방식(행 데이터 없음, ADR-005)을 유지한다.
2. `GET /api/session`: 마찬가지로 `req.query.session`을 제거하고 쿠키/헤더로만 sid를 도출한다.
3. 주석 갱신: ADR-005가 말하던 `?session=` 폴백이 쿠키 인증으로 대체되었음을, 그리고 쿼리 토큰 제거 이유(로그/Referer 유출)를 `/api/stream` 근처에 남긴다.
4. 테스트(`test/server.test.js`):
   - 쿠키(`yh.sid`)로 `/api/stream` 연결 시 `ready` 이벤트를 받는지(step 3 쿠키 헬퍼 재사용).
   - **`?session=` 쿼리만으로는 더 이상 인증되지 않는지**(쿠키/헤더 없이 `?session=<sid>`로 접속 시 401).
   - 쿠키 없는 미인증 SSE 접속이 401인지.
   - `/api/session`도 쿠키로 복원되고 `?session=`만으로는 인증 안 되는지.

## Acceptance Criteria

```bash
npm run lint
npm run build
npm test
```

## 검증 절차

1. 위 AC 커맨드를 실행한다.
2. 아키텍처 체크리스트를 확인한다:
   - `/api/stream`·`/api/session` 어디에도 `req.query.session`이 남아있지 않은가?
   - SSE가 여전히 "무효화 신호만"(행 데이터 없음) 보내는가(ADR-005)?
   - 인증이 검증된 세션(쿠키→헤더)에서만 도출되는가(ADR-004)?
3. 결과에 따라 `phases/1-security/index.json`의 step 4를 업데이트한다:
   - 성공 → `"status": "completed"`, `"summary"`에 `?session=` 제거 사실·SSE 인증이 쿠키 기반임을 기록(step 6 프론트가 EventSource withCredentials로 전환해야 함을 명시).
   - 실패/blocked → 절차 동일.

## 금지사항

- `req.query.session`을 남겨두지 마라. 이유: 쿼리 토큰은 서버 로그·Referer·브라우저 히스토리로 유출되는 표면(ADR-005가 지적한 취약점) — 본 phase의 제거 대상.
- SSE 페이로드에 행 데이터를 싣지 마라. 이유: ADR-005 — 역할별 데이터 노출 회피를 위해 무효화 신호만 보낸다.
- 프론트 `httpModel.subscribe`를 이 step에서 바꾸지 마라. 이유: 이 step은 서버 전용. 프론트 EventSource credentials 전환은 step 6.
- 기존 SSE/`ready` 테스트를 깨뜨리지 마라(쿠키/헤더 인증으로 갱신하되 동작 보존).
