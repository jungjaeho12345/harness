# Step 2: sse-cookie-auth

## 목표
SSE(`/api/stream`) 인증을 쿠키 기반 세션과 일관되게 강화한다. 현재는 `EventSource`가 커스텀 헤더를 못 보내 `?session=<토큰>` **평문 쿼리 폴백**으로 인증하는데(ADR-005 트레이드오프), 이 쿼리 토큰은 URL/액세스 로그/Referer에 새는 표면이다. step0에서 세션이 **HttpOnly 쿠키**로 전송되므로, 브라우저 `EventSource`는 same-origin/withCredentials로 쿠키를 자동 첨부할 수 있다 → **쿠키(우선) + 헤더(하위호환)** 만 허용하고 `?session=` 쿼리 폴백을 **제거**한다. 이 step은 **transport 계층(`server/index.js`)의 `/api/stream` 라우트만** 손댄다. 프론트 `subscribe`의 쿼리 토큰 제거는 step4에서 한다(이 step은 서버가 쿼리를 더 이상 신뢰하지 않게 만드는 것까지).

## 읽어야 할 파일
- `/home/user/harness/docs/ADR.md` — ADR-005(SSE 무효화 스트림, `EventSource`가 헤더를 못 보내 `?session=` 폴백을 둔다는 31행). 이 폴백이 쿠키 도입으로 불필요해지는 맥락
- `/home/user/harness/docs/news.md` — 76행(SSE 실시간·자동 재연결), `## 세션 정책`(113~119행)
- `/home/user/harness/server/index.js` — `/api/stream` 라우트(330~346행: `const sid = req.get('x-session-id') || req.query.session;`), `sessionOf`/`sidFrom`(step0에서 통합된 sid 도출 헬퍼), `cors(...)`의 `credentials`/allowlist(step0에서 `credentials:true` 추가됨)
- `/home/user/harness/phases/security-hardening/step0.md` — step0가 만든 쿠키명·`sidFrom(req)` 우선순위(쿠키→헤더). SSE도 같은 `sidFrom`을 재사용해야 일관된다
- `/home/user/harness/web/src/model/httpModel.js` — `subscribe`(140~159행)가 현재 `?session=readSessionId()`로 URL을 만든다. **이 파일은 step4에서 수정** — 이 step에서는 읽고 영향만 파악(서버 변경이 프론트를 깨뜨리지 않게 step4까지 헤더/쿠키 둘 다 받아주는지 확인)
- `/home/user/harness/test/server.test.js` — SSE 관련 기존 테스트가 있으면 그 패턴(EventSource 대신 fetch로 stream 라우트 인증만 확인하는 식)

## 작업 (TDD — 테스트 먼저)
1. `/api/stream` 라우트의 sid 도출을 step0의 `sidFrom(req)`(쿠키→헤더)로 교체하고, **`req.query.session` 폴백을 제거**한다. 인증 실패면 기존대로 401.
   - 인증 통과 후 SSE 응답 헤더/`ready` 이벤트/`bus.on('change')` 배선·`req.on('close')` 정리 로직은 **그대로 유지**한다(ADR-005 무효화 신호 방식 무변경).
2. 쿠키로 SSE 인증이 되려면 브라우저 `EventSource`가 쿠키를 첨부해야 한다. **same-origin**이면 자동 첨부되지만, 현재 아키텍처는 프론트(`:5173`)와 API(`:3001`)가 **다른 origin**이다(ADR-001). cross-origin `EventSource`는 `new EventSource(url, { withCredentials: true })`가 필요하고, 서버 CORS가 `credentials:true`+명시 origin이어야 쿠키가 전송된다(step0에서 `credentials:true` 설정됨). 따라서:
   - 서버는 이 step에서 쿠키/헤더만 받게 바꾸고,
   - 프론트의 `withCredentials:true` 적용은 **step4** 소관임을 명시한다(이 step의 작업 범위가 아님).
   - 단, 헤더 폴백(`x-session-id`)은 유지하므로 step4 전까지도 SSE가 깨지지 않게 한다(테스트로 확인).
3. 보안 메모: 쿼리 토큰 제거는 토큰이 서버 액세스 로그·프록시 로그·브라우저 히스토리에 남는 표면을 닫는다. 이 근거를 summary에 남겨라.

## 테스트 계획 (`test/sse-auth.test.js` 신규 또는 `server.test.js` 보강)
- 쿠키만 실은(헤더/쿼리 없음) `GET /api/stream` 요청이 인증을 통과해 `text/event-stream` 응답을 시작한다(`ready` 이벤트 수신). fetch + 응답 헤더/첫 청크 확인 방식으로 검증(EventSource 없이).
- 헤더(`x-session-id`)만 실은 요청도 통과한다(하위호환 회귀 가드).
- `?session=<유효토큰>` 쿼리만 실은 요청은 **이제 401**이다(쿼리 폴백 제거 회귀 가드 — 이게 이 step의 핵심 변경).
- 쿠키·헤더 둘 다 없으면 401.
- 만료/위조 sid면 401, 인증 후 슬라이딩 갱신(`touchSession`)이 동작하는지 확인.

## Acceptance Criteria
```bash
npm run lint
npm run build
npm test
```

## 검증 절차
1. AC 실행. 기존 `test/server.test.js`의 SSE·세션 관련 테스트가 무회귀 통과(단, `?session=` 폴백에 의존하던 기존 테스트가 있으면 쿠키/헤더 방식으로 갱신 — 폴백 제거가 의도된 변경임을 명시).
2. 체크리스트: 쿠키로 SSE 인증되는가? 헤더 폴백 유지되는가? `?session=` 쿼리가 더 이상 인증되지 않는가(401)? 무효화 신호 배선이 보존됐는가?
3. index.json의 step 2를 completed + summary(쿼리 폴백 제거·sidFrom 재사용·step4 withCredentials 후속·보안 근거)로 갱신.

## 금지사항 / 불변규칙 체크리스트
- `?session=` 쿼리 인증 폴백을 **남겨두지** 마라. 이유: 세션 토큰이 URL/로그/Referer로 새는 표면이 이 step의 제거 대상이다(쿠키로 대체됨).
- 헤더(`x-session-id`) 폴백을 제거하지 마라. 이유: 프론트가 아직 헤더 방식이며(step4 전), 제거하면 SSE가 끊긴다(하위호환).
- SSE 페이로드에 행 데이터를 싣지 마라. 이유: ADR-005 — 무효화 신호만 보내 권한별 데이터 노출을 회피한다(현 동작 유지).
- `sessionService`의 만료/슬라이딩 로직을 변경하지 마라. 이유: 만료의 단일 진실은 세션 스토어이며 이 step은 transport 인증 입력만 바꾼다.
- 이 step에서 프론트(`web/src/model/httpModel.js`)를 수정하지 마라. 이유: 프론트 전환은 step4 단일 책임 — 한 step에 백/프론트를 섞으면 실패 격리가 어려워진다.
- DB 스키마/행을 건드리지 마라. DB 비파괴 원칙.
