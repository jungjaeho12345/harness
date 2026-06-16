# Step 5: sse-auth-hardening

## 읽어야 할 파일

먼저 아래 파일들을 읽고 현재 SSE 인증을 정확히 파악하라:

- `/docs/news.md` — "기사 조회페이지"(실시간 SSE, 끊기면 자동 재연결), "API 명세서"(`/api/stream` SSE)
- `/docs/ARCHITECTURE.md` — 데이터 흐름 "[실시간]"(서버 EventEmitter → SSE(/api/stream) → httpModel.subscribe → Controller 무효화 신호 수신, 행 데이터 push 안 함)
- `/docs/ADR.md` — **ADR-005 전문**(SSE 단방향 무효화. `EventSource`가 커스텀 헤더를 못 보내 이 라우트만 `?session=` 쿼리 인증 폴백을 둔다)
- `server/index.js` — **현재 SSE 라우트** `app.get('/api/stream', ...)`:
  - `const sid = req.get('x-session-id') || req.query.session;` 로 인증. **세션 토큰이 URL 쿼리에 노출된다**(접근 로그·Referer·프록시 캐시에 남는 위험).
  - 인증 후 `text/event-stream` 헤더 + `bus.on('change', onChange)`, `req.on('close', ...)`로 정리.
  - step3에서 `readSessionToken(req)`(쿠키 우선→헤더 폴백) 헬퍼가 생겼고, CORS `credentials: true`가 켜졌다.
- `web/src/model/httpModel.js` — `subscribe(filter, onChange)`가 `new EventSource(url)`을 `?session=` 쿼리로 연다.
- `web/src/model/httpModel.test.js` — SSE 구독 테스트 패턴(EventSource 모킹).
- `test/server.test.js` — `GET /api/stream: 세션 폴백(?session=)으로 ready 무효화 신호를 보낸다` 테스트(264행 부근)와 미인증 거부 테스트. **이 테스트가 새 인증 방식에 맞게 갱신되어야 할 수 있다.**
- `phases/1-security-hardening/step3.md` / `step4.md` 산출물 — 서버는 세션 쿠키(HttpOnly)를 발급하고 쿠키 우선으로 읽는다. CORS `credentials: true`. 클라이언트 fetch는 `credentials: 'include'`.

## 작업

SSE 인증을 **쿠키 기반**으로 강화해 **세션 토큰이 URL 쿼리(`?session=`)에 노출되는 문제를 제거**한다. `EventSource`는 커스텀 헤더를 못 보내지만, **쿠키는 자동 전송**되며 `withCredentials: true`로 cross-origin 쿠키를 실을 수 있다. TDD — 테스트 먼저.

1. **서버 `/api/stream` 인증 전환**:
   - 인증 토큰을 **쿠키(step3의 `readSessionToken`) 우선**으로 읽는다. `?session=` 쿼리 폴백은 **제거를 목표**로 하되, cross-origin SameSite 제약(step3 summary 확인)으로 쿠키가 안 실리는 개발 환경을 위해 **남길지 여부를 step3의 SameSite/credentials 결정과 정합되게** 판단하라:
     - 쿠키가 cross-origin으로 동작하는 조합(SameSite=None; Secure + withCredentials)을 step3에서 택했다면 → `?session=` 쿼리 폴백을 **제거**한다(목표 달성: 토큰 URL 노출 제거).
     - 헤더/쿼리 폴백에 의존하는 조합이라면 → 쿼리 폴백 유지가 불가피함을 summary에 명시하고, 최소한 **쿠키가 있으면 쿼리를 무시**하도록 우선순위를 둔다.
   - 미인증(쿠키·폴백 모두 없음)은 기존대로 `401 { ok:false, reason:'unauthenticated' }`.
   - 인증 후 스트림 동작(ready 신호, change 브로드캐스트, close 정리)은 그대로 유지한다.
2. **클라이언트 `subscribe()` 전환**:
   - `new EventSource(url, { withCredentials: true })`로 쿠키를 cross-origin 전송한다.
   - `?session=` 쿼리를 URL에서 **제거**한다(쿠키 폴백 제거 시). 폴백을 유지하기로 했다면 쿠키 우선 정책에 맞춰 최소화한다.
   - 자동 재연결·`ready`/`change`/`error` 리스너·`unsubscribe` 동작은 유지한다(news.md: 끊기면 자동 재연결).
3. **무효화 신호 불변식 유지**: SSE 페이로드는 여전히 **행 데이터 없는 무효화 신호**다(ADR-005). 인증만 강화하고 페이로드 형태는 바꾸지 마라.

> dev 환경 주의: cross-origin(:5173↔:3001) HTTP dev에서는 `SameSite=None; Secure` 쿠키가 안 실리고 `EventSource`는 헤더도 못 보낸다. 즉 **쿼리 폴백을 제거하면 dev SSE 인증 수단이 사라진다.** 따라서 폴백 제거는 same-origin(Vite proxy) 배포/개발을 전제할 때만 택하고, 그렇지 않으면 쿼리 폴백을 유지(쿠키 우선)하라. 택한 전제를 step3 결정과 정합시켜 summary에 명시.

테스트:
- (`test/server.test.js`) 쿠키로 `/api/stream`에 연결하면 `ready` 신호를 받는다. 미인증은 401. **`?session=` 쿼리 폴백을 제거하기로 택했다면, 기존 `?session=` 기반 stream 테스트(264행 부근 "세션 폴백(?session=)으로 ready" 테스트)를 쿠키 인증 버전으로 반드시 교체한다** — 안 고치면 그 테스트가 깨진다. 폴백을 유지하기로 했다면 쿠키 우선 검증을 추가한다.
- (`web/src/model/httpModel.test.js`) `subscribe()`가 `withCredentials: true`로 EventSource를 만들고, URL에 세션 토큰이 노출되지 않는다(쿼리 폴백 제거 시).

## Acceptance Criteria

```bash
npm run lint
npm run build
npm test
npm run test:web
```

## 검증 절차

1. 위 AC 커맨드를 모두 실행한다.
2. 아키텍처 체크리스트:
   - SSE 인증이 쿠키 우선으로 전환되었는가? 세션 토큰이 URL 쿼리에 노출되지 않는가(또는 최소화·쿠키 우선)?
   - 미인증 SSE 연결이 401로 거부되는가?
   - SSE 페이로드가 여전히 행 데이터 없는 무효화 신호인가(ADR-005 불변)?
   - 자동 재연결·정리(close) 동작이 무회귀인가?
   - EventSource transport가 httpModel.js 안에만 있는가(ADR-003)?
3. `phases/1-security-hardening/index.json`의 step 5 업데이트(completed + summary: 쿼리 폴백 제거/유지 결정과 근거, withCredentials 적용). 실패 시 error, step3 SameSite 결정과의 정합이 모호하면 blocked.

## 금지사항

- SSE 페이로드에 기사 행 데이터를 싣지 마라. 이유: ADR-005 — 권한별 데이터 노출을 막기 위해 "무효화 신호"만 보낸다. 클라이언트가 자기 필터로 재조회한다.
- 인증 없이 `/api/stream`을 열어 두지 마라. 이유: 인증 강화가 이 step의 목적이다 — 미인증은 401로 거부한다.
- `?session=` 쿼리 폴백을 step3의 SameSite/credentials 결정과 무관하게 임의로 남기거나 지우지 마라. 이유: 쿠키가 cross-origin으로 안 실리는 조합에서 폴백을 지우면 SSE가 죽는다(회귀). 두 step의 결정을 정합시켜라.
- 세션 저장/발급(sessionService)을 수정하지 마라. 이유: 이 step은 SSE 운반·인증 경로만 다룬다(계층 분리).
