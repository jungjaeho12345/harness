# Step 0: csrf-origin-guard

## 읽어야 할 파일

먼저 아래 파일들을 읽고 프로젝트의 아키텍처와 설계 의도를 파악하라:

- `docs/ARCHITECTURE.md` — "보안 경계", "얇은 transport" 절
- `docs/ADR.md` — ADR-001(SPA/API 두 프로세스 분리), ADR-004(신뢰 경계=서버), ADR-005(SSE)
- `docs/PRD.md` — "MVP 제외 사항"의 보안 하드닝 항목
- `server/index.js` — 전체. 특히 `sessionCookieOptions`(쿠키 SameSite/Secure env 분기), `enforceHttps`, `createApp` 내 helmet → cors → https 리다이렉트 → JSON 파서 → 요청 로거 → `/uploads` 정적 서빙 → 라우트 등록 순서, 그리고 상태 변경 라우트들(`POST /api/articles/:id/action`, `POST /api/articles/:id/lock`, `/unlock`, `/force-unlock`, `POST /api/distribution-targets/:id/deactivate`, `POST /api/distribution/tick`, `POST /api/logout`)
- `test/server.https.test.js` — CORS preflight·프록시 헤더(X-Forwarded-Proto) 테스트 패턴과 `rawFetch`(node:http.request) 헬퍼
- `test/session-cookie.test.js` — env 분기(프로덕션/비프로덕션) 테스트 패턴
- `web/vite.config.js` — dev 프록시(`/api` → `http://127.0.0.1:3001`, `changeOrigin: true`)
- `web/src/model/httpModel.js` — 모든 REST 호출의 단일 통로(`credentials: 'include'`, base 기본값은 빈 문자열=동일 출처)

## 배경 (이 step 안에서 자기완결)

2026-08-03 전수감사 발견 [medium]: 프로덕션에서 세션 쿠키가 `SameSite=None; Secure`로 발급되는데 CSRF 토큰도 Origin/Referer 검증도 없다. CORS는 **응답 읽기**를 막을 뿐 **요청 실행**을 막지 않으므로, 본문이 없거나 `application/json`이 아닌 상태 변경 요청(예: 잠금 강제 해제, 배부 대상 비활성화, tick, 로그아웃)은 cross-site에서 피해자의 쿠키와 함께 실행될 수 있다.

이 step은 그 표면을 **Origin/Referer 검증 미들웨어**로 닫는다. 설계 근거(이미 확정된 결정이며 재논의하지 마라):

- 브라우저는 Fetch 표준상 **GET/HEAD가 아닌 모든 요청에 `Origin` 헤더를 항상 붙인다**(same-origin 요청에도, form 전송에도). 공격자는 이를 생략시킬 수 없다. 따라서 "상태 변경 메서드에서 Origin이 허용 목록/자기 출처와 다르면 거부"가 유효한 방어다.
- 반대로 서버-서버 클라이언트(수집 인제스트, 배부 tick cron, 기존 테스트의 node fetch/http.request)는 Origin을 보내지 않는다. **Origin·Referer가 둘 다 없으면 통과**시킨다(브라우저 공격 벡터가 아니다). 이 관용은 의도된 트레이드오프이며 ADR에 남긴다.
- dev는 Vite 프록시로 SPA와 API가 동일 출처처럼 보이지만 브라우저가 보내는 Origin은 `http://localhost:5173`(포트가 밀리면 5174 등)이다. 따라서 **비프로덕션에서는 loopback(localhost/127.0.0.1/[::1]) origin을 포트 무관하게 허용**한다. 프로덕션은 엄격하게 간다.
- 프로덕션 가정: **동일 출처 배포**(리버스 프록시가 SPA와 `/api`를 같은 출처로 묶는 배치)다. 앱 자체는 SPA 번들을 서빙하지 않는다 — `express.static`은 `/uploads` 하나뿐이다. 별도 출처·호스트 재작성 배포는 `ALLOWED_ORIGINS`로 명시 등록해야 하며, 미설정 시 프로덕션 쓰기가 전부 403이 된다. 이 가정과 실패 모드를 ADR에 반드시 남긴다(아래 4단계).

## 작업

### 1) 착수 전 실측

```bash
npm test         # 679/679 pass, fail 0 이 기준선이다
npm run lint
```

기준선과 다르면 그 사실을 먼저 기록하고 진행하라.

### 2) 테스트 먼저 (TDD — red 확인 필수)

`test/csrf-origin.test.js`를 신설한다. 앱 구성은 `test/server.https.test.js`/`test/session-cookie.test.js`와 동형으로 하라(in-memory `DatabaseSync(':memory:')` → `createSchema` → `createSessionService` → `createControllers` → `createApp({ controllers, sessionService, env })` → `app.listen(0)`). 헤더를 정확히 통제해야 하므로 `Origin`/`Referer`/`Host`/`X-Forwarded-Proto`는 `node:http.request` 기반 raw 헬퍼로 보내라(`test/https-enforcement.test.js`의 `rawFetch` 패턴). 사용자 시드·로그인은 기존 테스트 헬퍼 패턴을 그대로 쓴다.

**프로덕션 모드 테스트의 필수 전제(빠뜨리면 CSRF 가드가 아니라 HTTPS 리다이렉트를 측정하게 된다):** `createApp({ ..., env: 'production' })`은 `app.set('trust proxy', 1)`(server/index.js L193·L198)과 평문 → https **308 리다이렉트 미들웨어**(L232~240)를 켜고, 그 리다이렉트는 CSRF 가드보다 **앞**에 등록된다. 따라서 프로덕션 앱을 쓰는 **모든 요청(로그인 포함)에 `x-forwarded-proto: https` 헤더를 실어라**. `forceHttps: false`로 끄는 방식으로 우회하지 마라 — 그러면 `trust proxy`가 꺼져 `req.protocol`이 `http`가 되고 자기 출처 판정(`${req.protocol}://${req.get('host')}`)이 시나리오 9·13과 달라진다.

공격 시나리오(전부 red → green이어야 한다. 1·2·3·4·5·10·12·13은 프로덕션 앱 — 위 전제대로 `x-forwarded-proto: https`를 매 요청에 싣는다):

1. 프로덕션 앱(`createApp({ ..., env: 'production' })`)에 유효 세션 쿠키 + `Origin: https://evil.example`로 `POST /api/articles/:id/action` → **403**, 응답 `{ ok:false, reason:'forbidden-origin' }`, 그리고 **기사 status가 그대로**(부수효과 0)임을 DB로 단언.
2. 같은 조건으로 `POST /api/articles/:id/force-unlock` → 403 + `lockYN='Y'` 유지(본문 없는 라우트가 실제 표적이다).
3. `Origin: null`(referrer-policy로 익명화된 cross-site 요청) → 403.
4. Origin 없이 `Referer: https://evil.example/x` 만 있는 상태 변경 요청 → 403.
5. 파싱 불가능한 Referer(`Referer: not-a-url`, Origin 없음) → 403.

정상 플로우 무손상(회귀 케이스 — 반드시 포함):

6. Origin/Referer 둘 다 없는 상태 변경 요청(현행 서버-서버·cron·테스트 스타일) → 기존과 동일하게 200 계열로 통과.
7. 비프로덕션 앱에서 `Origin: http://localhost:5174`(포트 드리프트) → 통과.
8. 비프로덕션 앱에서 `Origin: http://127.0.0.1:5173` → 통과.
9. 프로덕션 앱에서 자기 출처(`Host: app.example`, `X-Forwarded-Proto: https`, `Origin: https://app.example`) → 통과.
10. 프로덕션 앱에서 `Origin: https://evil.example` + `GET /api/articles` → **통과**(읽기는 이 미들웨어의 대상이 아니다. 응답 노출 차단은 CORS 책임).
11. `OPTIONS` preflight는 영향을 받지 않는다(`test/server.https.test.js`의 preflight 테스트가 계속 green이어야 한다).
12. env `ALLOWED_ORIGINS`에 `https://app.example`를 넣은 프로덕션 앱에서 그 origin의 상태 변경 요청 → 통과. env 미설정이면 기본 allowlist는 오늘과 동일하다.
13. 프로덕션 앱에서 `Origin: https://evil.example` + `X-Forwarded-Host: evil.example` → **403**(포워드 호스트 스푸핑으로 자기 출처 판정을 통과시키지 못한다).

### 3) 구현 — `server/index.js`만 수정

`enforceHttps`/`sessionCookieOptions`와 같은 기존 스타일(모듈 스코프 export + 주입 가능한 인자)을 따른다.

```js
// 두 소비처(cors 옵션 · CSRF 가드)가 같은 목록을 쓰도록 단일 출처화한다.
export function allowedOrigins(env = process.env) // -> string[]
// 기본값: ['http://localhost:5173', 'http://127.0.0.1:5173'] (오늘과 동일)
// env.ALLOWED_ORIGINS(콤마 구분)가 있으면 트림 후 빈 값 제외하고 append.

// 상태 변경 메서드 전용 Origin/Referer 게이트.
export function csrfOriginGuard({ origins = [], isProd = false } = {}) // -> (req, res, next)
```

`csrfOriginGuard` 판정 순서(이 규칙에서 벗어나지 마라):

1. `req.method`가 `GET`/`HEAD`/`OPTIONS`면 `next()`.
2. 주장 출처 결정: `req.get('origin')`이 있으면 그 값. 없고 `req.get('referer')`가 있으면 `new URL(referer).origin`(파싱 실패면 거부). 둘 다 없으면 `next()`.
3. 자기 출처(`${req.protocol}://${req.get('host')}`)와 같으면 `next()`.
4. `origins`에 포함되면 `next()`.
5. `isProd`가 false이고 주장 출처가 loopback(`http://localhost:<port>` / `http://127.0.0.1:<port>` / `http://[::1]:<port>`, 포트 무관, https도 동일 호스트면 허용)이면 `next()`.
6. 그 외(`'null'` 문자열 포함)는 `res.status(403).json({ ok: false, reason: 'forbidden-origin' })`.

등록 위치: `createApp` 안에서 **요청 로거(`res.on('finish')`로 INFO를 남기는 미들웨어) 다음, `/uploads` 정적 서빙과 라우트들 앞**. 이유: 거부(403)도 액세스 로그에 남아야 하고, CORS preflight(OPTIONS)는 cors 미들웨어가 먼저 끝낸다. `cors(...)`의 `origin` 옵션은 `allowedOrigins(...)` 반환값을 쓰도록 바꾸되 기본 동작(허용 목록 값)은 오늘과 동일해야 한다. `isProd`는 이미 `createApp` 안에 있는 값을 그대로 넘긴다.

### 4) 문서 갱신 — `docs/ADR.md` + `docs/ARCHITECTURE.md`

**ADR-009 신설**: `docs/ADR.md` 맨 끝에 추가한다(기존 ADR-001~008 본문은 수정하지 마라). 포함할 내용:

- 결정: 상태 변경 메서드에 대한 Origin/Referer allowlist 검증 미들웨어. CSRF 토큰 미도입, 쿠키 SameSite 정책 무변경.
- 이유: CORS는 simple request의 **실행**을 막지 않는다(응답 읽기만 막는다) / 브라우저는 비-GET에 Origin을 항상 붙인다 / CORS allowlist가 `localhost:5173` 고정(server/index.js)이라 별도 출처 SPA 배포는 preflight 단계에서 이미 동작하지 않는다 / 토큰 방식은 클라이언트 전 REST 경로 개조가 필요하다.
- **가정과 실패 모드(반드시 이 형태로 적어라 — 실코드에 없는 사실을 단정하지 마라)**: 이 결정은 **동일 출처 배포를 전제**한다(리버스 프록시가 SPA와 `/api`를 같은 출처로 묶는 배치). 앱 자체는 SPA 번들을 서빙하지 않는다 — `express.static`은 `/uploads` 하나뿐이다. 별도 출처로 SPA를 띄우거나 프록시가 Host를 재작성하는 배포에서는 `ALLOWED_ORIGINS`를 명시 설정해야 하며, **미설정 시 프로덕션의 모든 쓰기 요청이 403**이 된다.
- 트레이드오프: Origin·Referer가 모두 없는 요청은 통과시킨다(서버-서버 클라이언트 보존, 아주 오래된 브라우저의 form POST는 방어 밖) / 비프로덕션 loopback 관용 — 단 `vite --host`로 LAN IP(`http://192.168.x.x:5173`)에서 띄우는 모바일 실기 테스트는 loopback이 아니므로 비프로덕션에서도 쓰기가 403이 된다(그 경우 `ALLOWED_ORIGINS` 설정이 필요하다) / `X-Forwarded-Host`는 신뢰하지 않는다 / 상태를 바꾸는 GET을 새로 만들면 이 방어 밖이다.

**ARCHITECTURE.md 갱신**: `docs/ARCHITECTURE.md`의 "보안 경계" 목록(현재 helmet·CORS allowlist·레이트리밋·bcrypt·전역 에러 핸들러를 나열한 줄)에 **상태 변경 메서드의 Origin/Referer 검증 미들웨어**를 1줄로 추가한다(phase 48이 tick 결선 시 같은 문서를 갱신한 선례를 따른다). 다른 절은 건드리지 마라.

## Acceptance Criteria

```bash
node --test test/csrf-origin.test.js   # 신규 테스트 green
npm test                               # 679 + 신규 케이스, fail 0
npm run lint                           # clean
```

## 검증 절차

1. 위 AC 커맨드를 실행한다.
2. 변이 검증(구현이 실제로 게이트 역할을 하는지): `csrfOriginGuard`의 403 분기를 일시적으로 `next()`로 바꾸면 공격 시나리오 1~5가 red가 되는지 확인하고, 원복한다.
3. 아키텍처 체크리스트:
   - 수정 범위가 `server/index.js`(얇은 transport) + `docs/ADR.md`(ADR-009 신설) + `docs/ARCHITECTURE.md`("보안 경계" 1줄) + 테스트뿐인가? `src/`·`web/`·DB·스키마 변경 0건인가?
   - ADR-009에 실코드에 없는 배포 사실을 단정하지 않고 "가정 + 실패 모드"로 적었는가?
   - ADR-004(신뢰 경계=서버) 위반 없는가? 클라이언트가 보낸 값으로 인가를 판정하지 않았는가?
   - CLAUDE.md: DB 행 삭제·파괴적 마이그레이션 0건인가?
4. 결과에 따라 `phases/52-security-hardening/index.json`의 step 0을 업데이트한다:
   - 성공 → `"status": "completed"`, `"summary": "산출물 한 줄 요약(신설 export·등록 위치·테스트 수·기준선 대비 증감)"`
   - 3회 수정 후에도 실패 → `"status": "error"`, `"error_message": "구체적 에러"`
   - 사용자 개입 필요 → `"status": "blocked"`, `"blocked_reason": "사유"` 후 즉시 중단

## 금지사항

- CSRF 토큰(double-submit cookie 등)을 도입하지 마라. 이유: 클라이언트 전 REST 경로·SSE 예외 배선 개조가 필요해 회귀 표면이 이 phase의 검증 범위를 넘고, 동일 출처 배포에서는 Origin 검증이 같은 방어를 0-클라이언트-변경으로 제공한다(ADR-009 결정).
- `sessionCookieOptions`/`setSessionCookie`의 SameSite·Secure 값을 바꾸지 마라. 이유: 쿠키 전송 정책 변경은 배포 형상에 따라 로그인 자체를 조용히 깨뜨리고, 이 step의 테스트로는 그 파손을 잡지 못한다.
- `X-Forwarded-Host`를 자기 출처 판정에 쓰지 마라. 이유: 프록시가 덮어쓰지 않는 구성에서는 공격자가 스푸핑해 게이트를 통과한다. 호스트 재작성 배포는 `ALLOWED_ORIGINS`로 명시 등록한다.
- 라우트별 예외 목록(allow list of paths)을 만들지 마라. 이유: 예외 항목이 곧 우회 경로가 되고, 새 라우트가 추가될 때 조용히 방어 밖으로 샌다. 필요한 관용(서버-서버)은 "Origin·Referer 부재"라는 단일 규칙으로만 표현한다.
- 기본 CORS allowlist 값을 축소·확대하지 마라(`ALLOWED_ORIGINS` 미설정 시 오늘과 동일해야 한다). 이유: dev 배선과 기존 preflight 테스트가 그 값에 묶여 있다.
- 상태를 바꾸는 GET 라우트를 새로 만들지 마라. 이유: 이 방어는 비-GET만 검사한다.
- `express-rate-limit`·helmet 설정, 세션/도메인/DB 코드를 건드리지 마라. 이유: 이 step의 회귀 원인 격리 범위를 벗어난다.
- 기존 테스트를 깨뜨리지 마라. 특히 `test/server.https.test.js`의 preflight 테스트와 Origin 없이 요청하는 기존 HTTP 테스트 전부가 green이어야 한다.
