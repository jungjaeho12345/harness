# Step 3: auth-login

인증 REST 표면을 만든다: `POST /api/login` · `POST /api/logout` · `GET /api/session` + `/api/login` 전용 IP 레이트리밋. 계정 잠금·자격 검증·세션 쿠키 속성·재도출 세션 신원을 계약대로 잠근다.

## 읽어야 할 파일

- 이전 step 산출물 전부(`server-spring/**`) — `AppConfig`(app.prod-cookie), `findUser`/`insertUser`/`updateUser`, `SessionStore`(issue/resolve/remove·세션ID 추출).
- `/home/user/harness/src/services/userService.js` — **로그인 도메인 로직 정본**: 더미 해시 타이밍 완화 · 비활성(active='N')은 잠금·카운트보다 우선 403 `inactive` · 잠긴 계정은 올바른 비밀번호여도 `locked`(자격보다 잠금 우선) · 실패 누적 `registerFailure`(임계 5회 도달 시 `lockedUntil=now+15분`) · 성공 시 `resetLockout`(failedLoginCount='0', lockedUntil/lastFailedLoginAt=NULL) · `LOCKOUT_THRESHOLD=5` · `LOCKOUT_DURATION_MS=15*60*1000` · `SAFE_FIELDS`.
- `/home/user/harness/contract/cases/default/auth.contract.js` — 성공 shape(200 `{ok,sessionId,user}` · sessionId 64-hex · user=SAFE_FIELDS **6키**(active 포함)) · 비프로덕션 쿠키(`sid=<64hex>; Path=/; Max-Age=3600; HttpOnly; SameSite=Lax` · **Secure 없음**) · 쿠키 값 = 응답 sessionId · 로그아웃 200 `{ok:true}` + 만료쿠키(빈 값·Max-Age=0·같은 속성) · 세션 없이도 로그아웃 200(멱등) · GET /api/session 200 user=**5키**(active 없음 — identity 투영) · 미인증 401 JSON `{ok:false,reason:'unauthenticated'}`.
- `/home/user/harness/contract/cases/auth-negative/login-negative.contract.js` — invalid-credentials 401(존재/미존재 계정 **동일 응답** — 사용자 열거 방지) · 계정 잠금 423 `{ok:false,reason:'locked'}`(임계 5회 실패 후, 올바른 비밀번호로도) · IP 레이트리밋 429(창 안 10회까지 처리, **11번째** 요청이 429) · **429는 JSON이 아니다**(`Content-Type: text/html`, 바디 없음, 헤더 `RateLimit-Limit: 10`).
- `/home/user/harness/contract/cases/prod-cookie/cookie-prod.contract.js` — 프로덕션 쿠키(`Secure` + `SameSite=None`) · 프로덕션에서도 x-session-id 헤더 폴백 생존 · 만료쿠키에도 Secure+None.
- `/home/user/harness/docs/api-contract/reason-tokens.md` — 표1/표2: `unauthenticated`→401 · `invalid-credentials`→401 · `inactive`→403 · `locked`→**로그인 라우트 로컬 423**(전역 locked 401을 덮어씀) · 미정의 fallback→401(로그인 라우트).

## 작업

컨트롤러(`AuthController`)와 도메인 서비스(`UserService` — userService.js의 login/sanitize를 Java로 1:1 이식)를 계층 분리(ADR-006: controller→service→repository, 주입)로 만든다.

- `POST /api/login` `{userId,password}`:
  - 로그인 로직: `findUser` → 항상 BCrypt 비교 1회(없는 사용자는 더미 해시로 타이밍 완화) → active='N'이면 403 `inactive`(카운트 올리지 않음) → 잠금 중이면 423 `locked`(자격보다 우선) → 자격 불일치면 `registerFailure` 후 401 `invalid-credentials`(존재/미존재 동일 응답) → 성공이면 `resetLockout` + 세션 발급.
  - `lockedUntil` 판정은 주입 시계로(`Long.parseLong` 비교 — 문자열 정수 저장). 만료 잠금은 자동 통과(행 삭제 없음).
  - 성공 응답: 200 `{ok:true, sessionId:<64hex>, user:<SAFE_FIELDS 6키>}` + `Set-Cookie`. **password/잠금 필드는 어떤 응답에도 없다.**
  - 쿠키 속성: 공통 `Path=/; Max-Age=3600; HttpOnly`. `app.prod-cookie=false` → `SameSite=Lax`, Secure 없음. `true` → `SameSite=None; Secure`.
- `/api/login` 전용 **IP 레이트리밋**(express-rate-limit 15분/10회 동형): 같은 클라이언트 IP가 15분 창에서 10회까지 처리, **11번째부터 429**. 429 응답은 **JSON이 아니라 `text/html`** 바디이고 헤더 `RateLimit-Limit: 10`을 실는다("모든 거부는 JSON" 규칙의 유일한 예외 — 계약). 창은 슬라이딩/고정 아무거나 좋으나 "10회 통과 후 11회째 거부"가 정확해야 한다. 구현은 서블릿 필터/인터셉터 또는 컨트롤러 진입 카운터(주입 시계) — 프로세스 로컬 인메모리(외부 의존 금지). **이 레이트리밋은 `/api/login`에만** 건다(다른 라우트 무영향).
- `POST /api/logout`: 세션 있으면 `remove`, 없어도 200 `{ok:true}`(멱등). 만료 쿠키(빈 값·Max-Age=0·로그인과 같은 SameSite/Secure/HttpOnly/Path) Set-Cookie.
- `GET /api/session`: `SessionStore.resolve`(재도출)로 User → null이면 401 JSON `{ok:false,reason:'unauthenticated'}`(바디 필수) · 있으면 200 `{ok:true, user:<identity 5키: userId,name,role,department,departmentCode>}`(**active 없음** — 로그인 응답과 다른 투영).
- **reason→status 매핑 단일 지점**: `unauthenticated`=401, `invalid-credentials`=401, `inactive`=403, 로그인 `locked`=423. 거부 응답 본문은 `{ok:false, reason:'<토큰>'}` 고정(레이트리밋 429만 예외). 이 매핑을 한 곳(헬퍼/enum)에 두고 하드코딩 분산 금지.
- **DTO 투영 단일 지점**: 엔티티/User 레코드를 직접 직렬화하지 말고 SAFE_FIELDS(6키, 로그인)·IDENTITY(5키, 세션) 투영을 명시 map으로 만든다. password·잠금 필드가 새는 경로가 없어야 한다.

핵심 규칙: acting 신원은 **오직 세션에서** 도출한다(`req.body.role`/헤더 role 불신 — ADR-004). 비밀번호는 BCrypt 검증에만 쓰고 로그·응답 금지.

### 테스트(TDD, 먼저 작성)

MockMvc/`@SpringBootTest`로 임시 시드 DB(reporter/desk/admin + 픽스처) 위에서: 로그인 성공 shape·쿠키 속성(prod/비prod 분기)·invalid-credentials 동일응답·inactive 403·잠금 423(임계 후·올바른 비번)·레이트리밋 429(text/html·RateLimit-Limit)·로그아웃 멱등·만료쿠키·세션 401/200(5키)·재도출(role 변경 반영). 시계 주입으로 잠금·레이트리밋을 결정적으로.

## Acceptance Criteria

```bash
cd /home/user/harness/server-spring && ./mvnw -q -DskipTests=false test
```

- 로그인/로그아웃/세션 + 레이트리밋 + 잠금 테스트 전부 green.

## 검증 절차

1. AC 실행.
2. 아키텍처 체크리스트:
   - acting 신원이 세션에서만 도출되는가(body/header role 불신)?
   - password·잠금 필드가 응답/로그에 0건인가?
   - 로그인 user=6키(active 포함)·세션 user=5키(active 없음) 투영이 분리됐는가?
   - 잠금 우선순위(inactive > locked > invalid-credentials)와 상태(403/423/401)가 정확한가?
   - 레이트리밋이 `/api/login`에만·11회째 429·text/html·RateLimit-Limit:10인가?
   - 쿠키가 app.prod-cookie로 Lax/None·Secure 분기되는가?
3. 결과 반영: 성공 → `completed` + `summary`(라우트·매핑·잠금/레이트리밋 방식·테스트 수). 실패 3회 → `error`. 외부 요인 → `blocked`.

## 금지사항

- `req.body.role`이나 클라이언트 헤더의 역할을 신뢰하지 마라. 이유: 신뢰 경계=서버, 권한 상승 차단(ADR-004).
- 비밀번호·bcrypt 해시·잠금 필드를 응답/로그에 싣지 마라. 이유: 계정 열거·자격 유출(userService SAFE_FIELDS).
- 레이트리밋 429를 JSON으로 응답하지 마라. 이유: 계약이 text/html + RateLimit-Limit 헤더를 동결한다(클라이언트가 이 예외에 관대하도록 설계됨).
- 전역(전 라우트) 레이트리밋/CORS/CSRF를 넣지 마라. 이유: 계약 표면 밖(step0 금지 표면) — 로그인만 레이트리밋한다.
- `server/**`·`src/**`·`web/**`·`contract/**`·`docs/**`를 수정하지 마라. 이유: 기존 npm test 1328 불변. 계약 케이스는 서버가 맞춰야 할 동결 사양이다.
- 기존 테스트를 깨뜨리지 마라.
