# Step 0: session-cookie-transport

## 목표
세션 토큰을 HttpOnly/Secure/SameSite 쿠키로도 발급·검증하도록 **서버 transport 계층(`server/index.js`)** 만 전환한다. 기존 헤더 방식(`x-session-id`)은 **하위호환으로 유지**(쿠키 우선, 없으면 헤더). 세션 스토어(`sessionService`)·도메인 로직·DB는 건드리지 않는다. 이 step은 SSE(`/api/stream`)는 손대지 않는다 — SSE는 step2 소관.

## 읽어야 할 파일
- `/home/user/harness/docs/ADR.md` — ADR-004(세션 기반 서버측 인가, role은 검증 세션에서만 도출), ADR-001(2-origin CORS·세션 전파 배선이 직접 관리 대상이라는 점)
- `/home/user/harness/docs/news.md` — `## 세션 정책`(113~119행: 1h 슬라이딩, F5 복원, 토큰은 권한 미포함, 로그인 성공 시 기존 세션 무효화)
- `/home/user/harness/server/index.js` — 현재 transport 전부. 특히 `sessionOf(req)`(94~98행), `/api/login`(111행)·`/api/logout`(119행)·`/api/session`(126행), `createApp({controllers, sessionService})` 시그니처, `cors(...)` 설정(81~85행)
- `/home/user/harness/src/controllers/index.js` — `auth.login`이 `{ ok, sessionId, user }`를 반환하는 오케스트레이션(43~54행). 이 반환 shape은 **변경하지 마라**(프론트·다른 라우트가 의존)
- `/home/user/harness/src/services/sessionService.js` — 세션 토큰은 64hex 무작위, 권한 미포함. **무변경**
- `/home/user/harness/package.json` — 현재 런타임 의존성(express/helmet/cors/express-rate-limit). cookie 파서가 없다

## 작업 (TDD — 테스트 먼저)
1. `server/index.js`의 `createApp`에 쿠키 파싱을 추가한다. Express 4 환경이므로 `cookie-parser`를 런타임 의존성으로 추가하거나(권장: 표준적이고 ADR-001의 "보안 미들웨어" 범주), `req.headers.cookie`를 직접 파싱하는 작은 헬퍼를 둔다. **둘 중 하나를 택하되 외부 의존성 최소화 철학(ADR 철학)을 존중**해 결정 근거를 summary에 남겨라.
2. 세션 쿠키 상수를 한 곳에 정의한다: 쿠키명(예: `yh.sid`), 옵션 빌더 `sessionCookieOptions(env)` →
   - `httpOnly: true` (항상)
   - **`sameSite`/`secure`는 env로 분기**한다. **CRITICAL — cross-site 제약**: 이 아키텍처는 SPA(`http://localhost:5173`)와 API(`:3001`)가 **다른 origin = cross-site**다(ADR-001). 브라우저는 `SameSite=Strict`/`Lax` 쿠키를 **cross-site 요청(fetch/EventSource)에 첨부하지 않는다**. step2(SSE `withCredentials`)·step4(`credentials:'include'`)가 쿠키가 cross-site로 전송되는 것에 의존하므로, `SameSite=Strict`/`Lax`를 쓰면 브라우저에서 전 인증이 조용히 깨진다(직접 `Cookie:` 헤더를 박는 서버 테스트는 통과해 버그가 가려진다). 따라서:
     - `NODE_ENV === 'production'`: `sameSite: 'none'` + `secure: true`. (`SameSite=None`은 `Secure` 동반이 필수다.)
     - 그 외(로컬/테스트, http): `secure`는 false여야 http localhost에서 쿠키가 전송된다. 이때 `SameSite=None`은 `Secure` 없으면 브라우저가 거부하므로, **로컬 개발 한정으로는 `sameSite: 'lax'`(Secure 없음)**를 쓴다(로컬은 보통 동일 머신/프록시로 운용·테스트는 직접 헤더). 분기 경계와 trade-off를 summary에 명확히 남겨라.
     - (대안: 프로덕션에서 SPA와 API를 **같은 origin(리버스 프록시 경로)으로 합치면** `SameSite=Lax`로도 충분하다. 이 배포 토폴로지 결정은 step 범위 밖이지만, 택한 `sameSite` 값의 근거로 summary에 기록하라.)
   - `maxAge`: 세션 슬라이딩과 정합되게 1시간(`60*60*1000`). 단 **만료의 신뢰 원천은 서버 세션 스토어**다 — 쿠키 maxAge는 보조일 뿐, 만료 판정은 `sessionService.touchSession`이 한다.
   - `path: '/'`
3. `/api/login`: 로그인 성공 시 응답 body의 `{ ok, sessionId, user }`는 **그대로 유지**하면서(하위호환), 추가로 `res.cookie(쿠키명, sessionId, sessionCookieOptions(...))`로 세션을 쿠키에도 심는다.
4. `/api/logout`: `controllers.auth.logout(sid)` 호출 후 `res.clearCookie(쿠키명, { path:'/' })`로 쿠키도 제거한다. `sid` 도출은 아래 5번의 통합 헬퍼를 사용.
5. `sessionOf(req)`(및 `/api/session`의 sid 도출)를 **쿠키 우선 → 헤더 폴백**으로 통합한다. 새 헬퍼 `sidFrom(req)`:
   - 1순위: 파싱된 쿠키의 세션 쿠키값
   - 2순위: `req.get('x-session-id')` (헤더 — 하위호환)
   - SSE의 `?session=` 폴백은 이 step에서 건드리지 않는다(step2).
   `sessionOf`는 `sidFrom(req)`로 sid를 구해 `sessionService.touchSession(sid)`로 신원을 도출한다. **acting role은 반드시 검증된 세션에서만 도출한다(ADR-004) — req.body.role 신뢰 금지 규칙을 깨지 마라.**
6. CORS: 프론트가 쿠키를 주고받으려면 `credentials: true`가 필요하다. `cors(...)`에 `credentials: true`를 추가한다. origin allowlist(`localhost:5173`/`127.0.0.1:5173`)는 유지(credentials 모드에서는 와일드카드 origin 금지이므로 명시 allowlist가 필수다). `allowedHeaders`의 `x-session-id`는 하위호환으로 유지.

## 테스트 계획 (`test/server.test.js` 또는 신규 `test/session-cookie.test.js`)
- 로그인 성공 응답에 `Set-Cookie` 헤더가 있고, `HttpOnly`·`SameSite=Strict`가 포함된다(supertest 또는 기존 테스트 하네스 방식 그대로).
- 로그인 후 받은 쿠키만 다시 실어 보낸 보호 라우트(예: `GET /api/session`, `GET /api/articles`)가 **헤더 없이도** 인증 통과한다.
- 헤더(`x-session-id`)만 실은 기존 방식 요청도 **여전히** 인증 통과한다(하위호환 회귀 가드).
- 쿠키·헤더 둘 다 없으면 401.
- `/api/logout`이 세션 무효화 + `Set-Cookie`로 쿠키 만료(clearCookie)를 내린다.
- `req.body.role`을 위조해 보내도 acting role이 세션 신원에서만 도출됨(권한 상승 불가) — 기존 회귀 테스트가 깨지지 않는지 확인.
- `secure` 옵션이 `NODE_ENV=production`에서만 true가 되는지(env 분기) 단위 검증.

## Acceptance Criteria
```bash
npm run lint
npm run build
npm test
```

## 검증 절차
1. AC 실행. 기존 `test/server.test.js`(0-mvp step8의 14개)가 무회귀로 통과하는지 확인.
2. 체크리스트: 쿠키에 `HttpOnly`+`SameSite`가 박히는가? 헤더 방식이 여전히 동작하는가(하위호환)? acting role이 세션에서만 도출되는가? CORS `credentials:true`가 켜졌는가?
3. index.json의 step 0을 completed + summary(쿠키명·옵션 빌더·sidFrom 우선순위·cookie 파서 선택 근거·CORS credentials)로 갱신.

## 금지사항 / 불변규칙 체크리스트
- `sessionService.js`(세션 스토어/만료 로직)를 변경하지 마라. 이유: 만료의 단일 진실은 서버 세션 스토어이며 이번 step은 transport 전송 방식만 바꾼다.
- `auth.login`의 반환 shape `{ ok, sessionId, user }`를 바꾸지 마라. 이유: 프론트 httpModel·fakeModel·다른 라우트가 이 shape에 의존한다(계약 깨짐).
- `req.body.role`을 신뢰하거나 acting role을 클라 입력에서 도출하지 마라. 이유: ADR-004 신뢰 경계 = 서버.
- 로컬 개발에서 `secure: true`를 무조건 켜지 마라. 이유: http 로컬에서 쿠키가 전송되지 않아 인증이 깨진다(env 분기 필수).
- 헤더 `x-session-id` 경로를 제거하지 마라. 이유: 프론트 전환(step4) 전까지 하위호환이 필요하고, SSE(step2)도 아직 헤더/쿼리에 의존한다.
- DB 스키마·행을 건드리지 마라(이 step은 transport만). DB 비파괴 원칙.
