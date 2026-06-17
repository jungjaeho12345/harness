# Step 3: cookie-session

## 읽어야 할 파일

먼저 아래 파일들을 읽고 프로젝트의 아키텍처와 설계 의도를 파악하라:

- `/docs/ADR.md` — ADR-001(두 origin CORS·x-session-id 전파), ADR-004(세션 인가, "세션ID가 HttpOnly 쿠키가 아닌 헤더 방식이라 쿠키 전환·HTTPS 강제 등 추가 하드닝이 후속 과제"), ADR-006(얇은 transport)
- `/docs/ARCHITECTURE.md` — 보안 경계, "신뢰 경계는 서버"
- `/docs/PRD.md` — "MVP 제외 사항"의 HttpOnly/Secure/SameSite 쿠키 세션 후속 과제
- `server/index.js` — 현재 전송 계층. 특히 `sessionOf(req)`(`x-session-id` 헤더 → `touchSession`), `/api/login`(세션 발급 후 `res.json(r)`로 sessionId 반환), `/api/logout`(헤더/`body.sessionId`로 invalidate), `/api/session`(F5 복원), `cors({ allowedHeaders: [...'x-session-id'...] })`
- `src/services/sessionService.js` — `createSession`/`touchSession`/`invalidate`(세션 토큰은 서버 발급 무작위 hex). 이 서비스는 transport에 비의존이며 변경 불필요.
- `src/controllers/index.js` — `auth.login`이 `{ ok, sessionId, user }`를 반환하는 부분.
- `test/server.test.js` — 전송 계층 통합 테스트. 특히 `api(base, method, path, { sid })`가 `x-session-id` 헤더로 인증하는 헬퍼와 로그인→보호라우트 흐름. **이 테스트들을 함께 갱신해야 한다.**

step 2까지의 변경(잠금 service)은 이 step과 독립이다. server/index.js 현재 구조를 정확히 이해한 뒤 작업하라.

## 작업

세션 전송 방식을 **HttpOnly + SameSite 쿠키**로 전환한다. 이 step은 **transport(server/index.js) 계층만** 다룬다(프론트 httpModel은 step 6). 비즈니스 로직·세션 스토어는 건드리지 않는다(ADR-006). TDD: 실패 테스트 먼저.

### 결정 사항(이 step에서 고정한다)

- **쿠키 이름**: `yh.sid`.
- **쿠키 속성(개발 기본)**: `HttpOnly`, `SameSite=Lax`, `Path=/`. `Secure`는 **프로덕션에서만** 켠다(이 step에서는 `process.env.NODE_ENV === 'production'`일 때만 Secure를 붙이는 분기를 둔다 — 로컬 http 개발 유지). HSTS 등 추가 강화는 step 5에서 한다.
  - **SameSite 트레이드오프(주석으로 남길 것)**: 프론트(`:5173`)와 API(`:3001`)는 포트가 달라 cross-site로 취급될 수 있다. `Lax`는 일반적으로 cross-site fetch(credentials)에서 쿠키가 붙지 않을 수 있으나, 로컬은 동일 호스트(localhost) 다른 포트라 브라우저 정책에 따라 동작이 갈린다. 본 환경(사내 도구, 동일 사이트 배포 가정)에서는 `Lax`를 기본으로 하되, cross-origin credentialed 요청이 필요하면 `SameSite=None; Secure`(프로덕션 https)가 필요함을 주석으로 명시한다. 기본 코드는 `Lax`로 두고, 환경변수 `SESSION_SAMESITE`(기본 'Lax')로 오버라이드 가능하게 한다.
- **헤더 폴백 유지 여부**: `x-session-id` 헤더 폴백을 **한시적으로 유지**한다(쿠키 우선, 없으면 헤더). 이유: (a) 기존 402개 테스트 다수가 `x-session-id` 헤더로 인증하므로 한 step에서 전부 갈아엎으면 회귀 위험이 큼, (b) 프론트(step 6)가 credentials 전환을 마치기 전까지의 전환기 호환. **단, 폴백이 살아있다는 사실과 "프론트 전환(step 6) 완료 후 제거 검토" TODO를 주석으로 명시한다.** 보안상 헤더 폴백은 XSS로 토큰 탈취 표면이 남으므로 최종 제거가 목표임을 적는다.

### 구현

1. **쿠키 파싱**: 요청 쿠키에서 `yh.sid`를 읽는 헬퍼를 둔다. 의존성 추가 없이 표준만 쓰려면 `req.headers.cookie`를 직접 파싱하거나, 가벼운 미들웨어를 써도 된다(외부 의존성 추가는 ADR 철학상 최소화 — 가능하면 직접 파싱). `sessionOf(req)`를 갱신: **쿠키(`yh.sid`) 우선 → 없으면 `x-session-id` 헤더** 순으로 sid를 도출한 뒤 `touchSession`.
2. **set-cookie 발급(login)**: `POST /api/login` 성공 시 발급된 sessionId를 위 속성으로 `Set-Cookie`(`res.cookie` 또는 `res.append('Set-Cookie', ...)`)한다. **전환기 호환을 위해 응답 body의 `sessionId`는 당분간 유지**해도 되나, 프론트는 더 이상 의존하지 않게 될 것이다(step 6). body sessionId 유지/제거는 재량이되 기존 server.test.js의 `ok.sessionId` 단언과 충돌하지 않도록 테스트를 함께 정리한다.
3. **clear(logout)**: `POST /api/logout`에서 sid를 쿠키(우선)/헤더/`body.sessionId`로 도출해 `invalidate`하고, 동일 속성(Path 등 일치)으로 쿠키를 만료(`res.clearCookie('yh.sid', {...})`)한다.
4. **CORS credentials**: `cors({ ... credentials: true })`로 바꾸고, `origin`은 기존 allowlist(`localhost:5173`/`127.0.0.1:5173`)를 유지한다(credentials 모드에서는 와일드카드 origin 금지 — 명시 allowlist 필수). `allowedHeaders`에서 `x-session-id`는 폴백 유지를 위해 남겨둔다.
5. **`/api/session`(F5 복원)**: 쿠키(우선)/헤더에서 sid를 읽어 `touchSession`. SSE의 `?session=` 쿼리 폴백은 **이 step에서 건드리지 않는다**(step 4 책임).
6. 테스트(`test/server.test.js`):
   - 헬퍼 보강: 로그인 응답의 `Set-Cookie` 헤더에서 `yh.sid`를 추출해 이후 요청에 `Cookie` 헤더로 전달하는 경로를 추가한다. 기존 `x-session-id` 헬퍼는 **폴백 회귀 테스트로 유지**한다(헤더로도 여전히 인증되는지).
   - 새 단언: 로그인 시 `Set-Cookie`에 `yh.sid`, `HttpOnly`, `SameSite=Lax`가 포함되는가. NODE_ENV가 production이 아닐 때 `Secure`가 **빠지는가**. 쿠키만으로 보호 라우트 접근이 되는가. 로그아웃 후 쿠키가 만료(Max-Age=0/Expires 과거)되고 세션이 무효화되는가.

## Acceptance Criteria

```bash
npm run lint
npm run build
npm test
```

## 검증 절차

1. 위 AC 커맨드를 실행한다.
2. 아키텍처 체크리스트를 확인한다:
   - 라우트가 여전히 얇은가(쿠키 파싱/발급만, 비즈니스 로직 없음 — ADR-006)?
   - acting role이 여전히 검증된 세션에서만 도출되는가(쿠키든 헤더든 sid → touchSession, `req.body.role` 미사용 — ADR-004)?
   - 쿠키가 `HttpOnly`+`SameSite`이고 `Secure`는 프로덕션 분기인가?
   - CORS가 credentials:true + 명시 origin allowlist(와일드카드 금지)인가?
3. 결과에 따라 `phases/1-security/index.json`의 step 3을 업데이트한다:
   - 성공 → `"status": "completed"`, `"summary"`에 쿠키 이름(`yh.sid`)·속성·헤더 폴백 유지 사실·CORS credentials 변경·body sessionId 유지 여부를 기록(step 4·6이 참조).
   - 실패/blocked → 절차 동일.

## 금지사항

- 세션 토큰을 쿠키 값에 권한/사용자 정보와 함께 직렬화해 넣지 마라. 이유: 세션ID는 서버 스토어를 가리키는 무작위 토큰이어야 한다(ADR-004) — 클라이언트가 신원을 변조할 수 없게.
- 헤더 폴백을 이 step에서 제거하지 마라. 이유: 기존 테스트·프론트(step 6 미완)와의 전환기 호환이 깨진다. 제거는 프론트 전환 후 별도 판단.
- CORS origin을 `*`/reflect-any로 열지 마라. 이유: credentials 모드에서 와일드카드 origin은 브라우저가 거부하며, 임의 origin 허용은 CSRF/탈취 표면을 넓힌다.
- `Secure`를 개발 기본으로 강제하지 마라. 이유: 로컬 http에서 쿠키가 전송되지 않아 개발이 막힌다(프로덕션 분기로 둔다).
- sessionService(스토어)·controllers의 로직을 바꾸지 마라. 이유: 이 step은 transport 전용. 스토어 변경은 범위 밖.
- 기존 테스트를 깨뜨리지 마라(헤더 폴백 경로 회귀 테스트 포함).
