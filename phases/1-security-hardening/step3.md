# Step 3: cookie-session-server

## 읽어야 할 파일

먼저 아래 파일들을 읽고 현재 세션 transport를 정확히 파악하라:

- `/docs/news.md` — "세션 정책"(1시간 슬라이딩, F5 복원, 무작위 토큰·권한 미포함, 로그인 시 기존 세션 무효화), "로그인 워크플로우"
- `/docs/ARCHITECTURE.md` — "상태 관리"(서버 in-process 세션, 클라가 sessionId+user를 sessionStorage에 저장, F5 시 /api/session 복원), "보안 경계"(신뢰 경계=서버, CORS allowlist localhost:5173)
- `/docs/ADR.md` — **ADR-004 전문**(세션ID가 HttpOnly 쿠키가 아닌 헤더 방식이라 쿠키 전환이 후속 과제). ADR-001(두 origin 간 CORS·x-session-id 전파를 직접 관리)
- `server/index.js` — **현재 세션 transport**:
  - `sessionOf(req)`가 `req.get('x-session-id')`로 세션을 읽는다.
  - `/api/login`(controllers.auth.login → `{ ok, sessionId, user }`), `/api/logout`(`req.get('x-session-id') || req.body.sessionId`), `/api/session`(`req.get('x-session-id') || req.query.session`).
  - CORS: `allowedHeaders`에 `x-session-id` 포함, `credentials` 옵션 **없음**.
  - `helmet`/`express.json()` 미들웨어 순서.
- `src/services/sessionService.js` — `createSession`/`touchSession`/`invalidate`. 세션ID는 `randomBytes(32).toString('hex')`(64 hex). **이 서비스는 transport-agnostic하므로 수정하지 않는다**(세션 저장 방식은 그대로, 운반 수단만 쿠키로 추가).
- `src/controllers/index.js` — `auth.login`이 `sessionId`를 반환하는 구조.
- `test/server.test.js` — HTTP 테스트가 `x-session-id` 헤더로 인증한다(`api(base, method, path, { sid })`). **이 테스트들이 깨지면 안 된다.**

## 작업

세션 토큰을 **HttpOnly / Secure / SameSite 쿠키**로도 운반할 수 있게 서버 transport를 확장한다. **헤더 방식(`x-session-id`)은 전환 기간 동안 폴백으로 유지**하여 기존 테스트·클라이언트 무회귀를 보장한다. TDD — 테스트 먼저.

세션 저장(sessionService)·발급 로직은 바꾸지 않는다. 바뀌는 것은 **토큰이 응답에 실려 나가고 요청에서 읽히는 경로**뿐이다.

1. **쿠키 파싱**: 표준 `Cookie` 헤더를 읽는다. 외부 의존성 최소화 원칙(ADR 철학)에 따라 `cookie-parser` 도입 여부는 구현 재량이되, 단순 파싱이면 헬퍼 함수로 직접 처리해도 된다. (의존성을 추가하면 package.json에 명시하고 lockfile을 갱신하라.)

2. **세션 쿠키 발급** — `/api/login` 성공 시 `Set-Cookie`로 세션 토큰을 내린다. 쿠키 속성:
   - `HttpOnly` (JS 접근 차단 — XSS로 토큰 탈취 방지)
   - `Secure` (HTTPS에서만 전송) — **단 개발/테스트(HTTP)에서 쿠키가 동작하도록** `Secure` 여부를 환경에 따라 토글한다(예: `process.env.NODE_ENV === 'production'`일 때만 Secure). 토글 기준을 주입/환경변수로 두어 테스트가 제어 가능하게 하라.
   - `SameSite` — 기본 `Lax`. **주의: 현재 프론트(:5173)와 API(:3001)는 cross-origin(다른 포트)이라 `SameSite=Lax/Strict`면 cross-origin fetch에 쿠키가 실리지 않는다.** 이 제약을 step 본문 summary에 반드시 기록하고, 동작 가능한 조합을 택하라:
     - **권장**: CORS에 `credentials: true`를 켜고, 쿠키는 `SameSite=None; Secure`로 발급(cross-origin 허용). 단 `SameSite=None`은 `Secure` 필수라 HTTP 개발환경에서 안 실린다 → 개발은 헤더 폴백으로 동작.
     - 또는 同일 출처 배포를 전제로 `SameSite=Lax`로 두고 cross-origin은 헤더 폴백에 의존.
     - **이 트레이드오프는 추측하지 말고**, 택한 조합과 그 한계를 summary에 명시하라. (헤더 폴백을 유지하므로 어느 쪽이든 기존 테스트는 통과한다.)
   - `Path=/`, `Max-Age`는 세션 슬라이딩(1시간)과 정합되게 두되, 만료 권위는 서버 sessionService가 가진다(쿠키 만료는 보조).

3. **CORS credentials**: 쿠키를 cross-origin으로 주고받으려면 `cors({ ..., credentials: true })`가 필요하다. allowlist(`localhost:5173`/`127.0.0.1:5173`)는 유지한다. `credentials: true`이면 `origin`을 `*`로 두면 안 된다(이미 allowlist라 안전).

4. **요청에서 세션 읽기** — `sessionOf(req)`(및 `/api/logout`, `/api/session`)가 **쿠키 → 그다음 `x-session-id` 헤더** 순으로 토큰을 찾도록 한다. 쿠키가 있으면 쿠키 우선, 없으면 헤더 폴백. (`/api/stream`의 `?session=` 폴백은 step5에서 다룬다 — 이 step에서 건드리지 마라.)

5. **로그아웃** — `/api/logout`이 세션을 무효화하고 `Set-Cookie`로 세션 쿠키를 만료(`Max-Age=0`)시킨다.

시그니처(가이드):
```
// server/index.js 내부 헬퍼
function readSessionToken(req) // 쿠키 우선, x-session-id 헤더 폴백
function setSessionCookie(res, sessionId) // HttpOnly; SameSite; (조건부)Secure; Path=/
function clearSessionCookie(res)
```

테스트(`test/server.test.js` 보강 또는 신규 `test/server.cookie.test.js`):
- `/api/login` 성공 응답에 `Set-Cookie` 헤더가 있고, `HttpOnly`와 `SameSite` 속성이 들어 있다.
- 발급된 쿠키만으로(헤더 없이) 보호 라우트(예: `GET /api/articles`)에 접근하면 인증된다.
- `x-session-id` 헤더만으로도 여전히 인증된다(폴백 무회귀 — 기존 테스트가 이를 커버).
- `/api/logout`이 세션 쿠키를 만료시킨다(`Max-Age=0` 또는 과거 Expires).
- (선택) 테스트 환경에서 `Secure`가 꺼져 쿠키가 실제로 동작함을 확인.

## Acceptance Criteria

```bash
npm run lint
npm run build
npm test
```

## 검증 절차

1. 위 AC 커맨드를 실행한다.
2. 아키텍처 체크리스트:
   - sessionService(세션 스토어/발급)를 수정하지 않았는가? (운반 수단만 추가)
   - 쿠키에 `HttpOnly`가 항상 켜져 있는가? (JS 접근 차단)
   - `Secure`가 프로덕션에서 켜지고 개발/테스트에서 토글되는가?
   - `x-session-id` 헤더 폴백이 유지되어 기존 테스트가 통과하는가? (무회귀)
   - CORS allowlist가 유지되고 `origin:*`가 아닌가?
3. `phases/1-security-hardening/index.json`의 step 3 업데이트(completed + summary: 쿠키 속성·SameSite/credentials 결정과 cross-origin 한계·추가 의존성 여부). 실패 시 error, SameSite/CORS 결정 모호 시 blocked.

## 금지사항

- `sessionService.js`를 수정하지 마라. 이유: 세션 저장/만료는 transport-agnostic해야 한다(ADR-004) — 이 step은 운반 수단만 추가한다.
- `x-session-id` 헤더 경로를 제거하지 마라. 이유: 402개 기존 테스트와 현 클라이언트가 헤더로 인증한다 — 전환 기간 폴백을 끊으면 대량 회귀가 난다. (헤더 제거는 이 phase 범위 밖의 후속 과제다.)
- `cors`의 `origin`을 `*`로 바꾸지 마라. 이유: `credentials: true`와 `origin:*`는 브라우저가 거부하며, allowlist가 보안 경계다.
- 쿠키에 권한/역할 정보를 담지 마라. 이유: news.md — 세션 토큰은 권한 정보를 담지 않는 무작위 토큰이다. 역할은 서버 세션에서만 도출한다(ADR-004).
- 프론트엔드(web/)를 이 step에서 수정하지 마라. 이유: 클라이언트 전환은 step4의 scope다(scope 최소화).
