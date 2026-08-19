# Step 3: auth-session

인증·세션 3 라우트(`POST /api/login` · `POST /api/logout` · `GET /api/session`)와 그 위에 얹힌 **교차 계약**(세션 쿠키 속성, 쿠키↔헤더 폴백, CSRF Origin 게이트, CORS allowlist, 계정 잠금 423, 레이트리밋 429)을 동결한다. Spring 이식에서 가장 먼저 깨지는 축이다.

## 읽어야 할 파일

- `phases/67-port-p1-contract/index.json` — decisions **(2)(6)(7)(8)(9)(11)(16)(18)(22)** · excluded (g)(h)
- `phases/67-port-p1-contract/step2.md` "작업 A" — lib 시그니처(`api`·`record`·`fromResponse`·`actor`·`sid`·`credentials`·`hasSessions`·`requireProfile`)
- `docs/api-contract/endpoints.json` — `login`·`logout`·`session` 행의 `expect` 태그
- `docs/api-contract/reason-tokens.md` — `invalid-credentials`·`inactive`·`locked`·`unauthenticated`·`forbidden-origin`
- `spikes/p0-spring/CONTRACT.md` — 부트 시퀀스·쿠키·"401에도 JSON 바디 필수"·클라이언트 관용 규칙(수정 금지, 참고용)
- `server/index.js` — `sessionCookieOptions`(52~61행), `csrfOriginGuard`(283~305행), `allowedOrigins`(92~99행), cors 설정(509~516행), `setSessionCookie`/`clearSessionCookie`/`readSessionToken`(566~589행), login 라우트와 423 분기(616~635행), logout(637~642행), session(646~650행), `loginLimiter`(609~614행)
- `src/services/userService.js` — 로그인 판정과 잠금 정책(`invalid-credentials`·`inactive`·`locked`), 잠금 임계값
- `src/services/sessionGuard.js` · `src/services/sessionService.js` — 매 요청 User 재조회·슬라이딩 만료
- `test/session-cookie.test.js` · `test/server.cookie.test.js` · `test/csrf-origin.test.js` · `test/account-lockout.test.js` — **기대값을 여기서 먼저 읽어 예측을 세운다**(케이스를 베끼지는 마라 — 이 테스트들은 in-process 주입형이고 계약 스위트는 HTTP 블랙박스다)

## 배경

- 세션 토큰 운반 수단이 **둘**이다: `sid` 쿠키(우선) · `x-session-id` 헤더(폴백). 둘 다 계약이며 Spring도 둘 다 지원해야 한다. 과거의 `?session=` 쿼리 폴백은 제거됐다(있으면 안 되는 것도 계약이다).
- 비프로덕션 쿠키는 `HttpOnly; SameSite=Lax; Path=/; Max-Age=3600`(Secure 없음), 프로덕션은 `Secure; SameSite=None`이다. 후자는 `prod-cookie` 프로파일에서만 관측할 수 있다.
- CSRF 게이트는 상태 변경 메서드만 본다. **Origin·Referer가 둘 다 없으면 통과**(서버-서버 관용)이고, 이상한 Origin은 403 `forbidden-origin`이다. 계약 스위트는 기본적으로 Origin을 안 보내므로 이 관용 위에서 돈다 — 그 사실 자체를 케이스로 못 박는다.
- 로그인 실패 사유는 상태코드가 갈린다: `invalid-credentials` 401 · `inactive` 403 · `locked` **423**(전역 매핑 401을 라우트가 덮어씀).

## 작업

### A. `contract/cases/default/auth.contract.js`

1. `GET /api/session` 미인증 → **401 + JSON 바디** `{ok:false, reason:'unauthenticated'}`. (SPA가 이 응답에 의존한다 — 바디 없는 401은 계약 위반.) → `record('session','unauthenticated')`
2. `GET /api/session` 헤더 세션(R) → 200 · `user` 객체의 **정확한 키 집합**을 단언(`userId,name,role,department,departmentCode` — 실측으로 확정하고 예상과 다르면 요약에 기록) · 비밀번호 키 부재. → `success`
3. `POST /api/login` 성공(예: D 계정 — 자격증명은 **반드시 `credentials('D')`로 받는다**. 비밀번호를 케이스에 적지 마라. **default 프로파일 로그인 예산 중 1회 소비**) → 200 · `{ok:true, sessionId:<64-hex>, user:{...}}` · `Set-Cookie`가 `sid=`로 시작하고 `HttpOnly`·`SameSite=Lax`·`Path=/`·`Max-Age`를 포함하며 **`Secure`는 없다** · `user.password` 부재. 리포트에는 쿠키 **속성만 정규화**해 남긴다(값 금지). → `success`
4. 3에서 받은 **쿠키만으로**(헤더 없이) `GET /api/session` 200 — 쿠키 경로 실증. → `success`(같은 라우트의 다른 caseId)
5. `POST /api/logout`(3의 세션) → 200 `{ok:true}` + `Set-Cookie`에 `Max-Age=0`(또는 만료된 값) · 그 뒤 같은 토큰으로 `GET /api/session` → 401. → `logout: success`
6. `POST /api/logout` 세션 없이 → **200 `{ok:true}`**(멱등·항상 성공이 계약). → `logout: success`(caseId 구분)
7. `?session=<sid>` 쿼리로만 `GET /api/session` → 401(쿼리 폴백 부재 잠금). → `session: unauthenticated`
8. 잘못된 형식의 토큰(`x-session-id: not-a-real-token`) → 401.

### B. `contract/cases/default/crosscutting.contract.js` (교차 계약 — 라우트가 아니라 미들웨어 축)

1. **CSRF 거부**: `POST /api/logout`에 `Origin: http://evil.example`를 붙여 호출 → 403 `{ok:false, reason:'forbidden-origin'}`. (부수효과 없는 라우트를 골라 상태 오염을 피한다.)
2. **CSRF 관용**: Origin·Referer 없는 상태 변경 요청이 통과한다(A-5가 이미 증명 — 여기서는 `Referer`만 있는 경우가 origin 파싱으로 통과하는지 1건 확인).
3. **CORS preflight**: `OPTIONS /api/articles` + `Origin: http://localhost:5173` + `Access-Control-Request-Method: GET` → 2xx이며 `access-control-allow-origin`이 그 출처, `access-control-allow-credentials: true`, `access-control-allow-headers`에 **`Content-Type, x-session-id, x-collection-token, x-edit-client` 4종**이 있다.
4. **비허용 출처 preflight**: `Origin: http://evil.example` → `access-control-allow-origin` 헤더 부재(실측으로 확정).
5. **에러 shape**: 정의되지 않은 `/api/does-not-exist`에 GET → 404(SPA 서빙이 꺼진 프로파일 전제 — README의 측정 조건과 일치하는지 확인). 응답 형식을 실측해 명세에 기록한다.

리포트 태그는 라우트에 매달아야 하므로 이 파일의 관측은 `routeId: 'logout'|'articles-list'` 등 **실제 호출한 라우트**에 `tag:'forbidden'`/`'success'`로 기록하고, 교차 계약이라는 사실은 `caseId`에 남긴다(예: `crosscutting/csrf-foreign-origin`).

### C. `contract/cases/auth-negative/login-negative.contract.js` (전용 프로파일 — 단일 파일·직렬 실행)

이 파일은 **순서가 의미를 가진다**(레이트리밋 카운터와 계정 잠금 카운터를 소비한다). 서브테스트를 위에서 아래로 실행되게 쓴다. 자격증명은 전부 `credentials(role)`로 받고(비밀번호 하드코딩 금지), 틀린 비밀번호는 그 값에 접미사를 붙여 만든다.

**이 프로파일의 로그인 예산 표**(전용 프로세스라 카운터가 이 파일 전용이다 — 러너는 이 프로파일에서 세션을 준비하지 않는다):

| 케이스 | 로그인 호출 수 | 누적 | 근거 |
|---|---|---|---|
| C-1 invalid-credentials | 2(존재 계정 1 + 미존재 계정 1) | 2 | — |
| C-2 계정 잠금 423 | 임계값 회 + 확인 1 = **6**(임계 5 기준) | 8 | 잠금 임계값은 `src/services/userService.js`의 정책 상수에서 읽어 확인한다(하드코딩 금지) |
| C-3 레이트리밋 429 | 최소 3(9·10번째 성공/거부 + **11번째에서 429**) | 11+ | 리밋 10회/15분 — `server/index.js` 609~614행 `loginLimiter` |

- **C-3은 반드시 이 파일의 마지막**이다(429가 뜨는 순간 이 프로파일의 나머지 로그인은 전부 429가 된다).
- 임계값·리밋 숫자가 코드와 다르면 **코드가 정본**이다 — 표의 숫자는 근거 라인을 확인해 조정하고, 조정 사실을 요약에 남긴다.

1. `invalid-credentials`: 존재하는 계정 + 틀린 비밀번호 → 401 `{ok:false, reason:'invalid-credentials'}`. 존재하지 않는 계정도 **같은 토큰·같은 상태**인지 확인(사용자 열거 방지 계약 — 실측 결과를 명세에 기록).
2. `locked`(423): 같은 계정에 틀린 비밀번호를 **정책 임계값만큼** 반복(임계값은 `src/services/userService.js`에서 읽어 하드코딩하지 말고 상수처럼 파일 상단에 근거 주석과 함께 둔다) → 다음 시도에서 **423** `{ok:false, reason:'locked'}`. 잠긴 계정은 **올바른 비밀번호로도** 423인지 확인.
3. `rate-limited`(429) — **이 파일의 마지막 케이스**: 위 표대로 남은 예산을 소진하도록 로그인을 반복 호출하되 **상한(예: 20회)을 두고** 429가 관측되면 즉시 멈춘다. 429의 **본문 형식을 실측**해 기록한다(JSON이 아닐 수 있다 — 그렇다면 그 사실 자체가 계약이며, "모든 응답이 JSON"이라는 클라이언트 관용 규칙과 충돌한다는 점을 명세와 요약에 명시하라). 상한 안에서 429가 나오지 않으면 실패다.
4. 이 파일은 **다른 계정을 잠그지 않는다** — 잠금 대상 계정 하나를 정해 그것만 쓴다(다른 케이스가 이 프로파일을 쓰지 않으므로 안전하지만, 규율로 남긴다).

### D. `contract/cases/prod-cookie/cookie-prod.contract.js`

1. `POST /api/login` → `Set-Cookie`에 **`Secure`**와 **`SameSite=None`**이 있다(비프로덕션과의 차이가 계약이다).
2. 발급된 세션을 `x-session-id` 헤더로 써서 `GET /api/session` 200 — 프로덕션 프로파일에서도 헤더 폴백이 산다는 것.
3. `POST /api/logout` → 만료 쿠키에도 같은 속성이 실리는지 확인.
- 이 프로파일에서는 러너가 세션을 준비하지 않으므로 케이스가 `credentials(role)`로 **직접 1회 로그인**하고 그 세션을 3케이스가 공유한다(로그인 호출 총 1회로 고정).
- `hasSessions()`가 false인 프로파일이므로 `actor()`/`sid()`를 부르지 마라(즉시 실패한다 — 그것이 설계된 안내다).

### E. 명세 반영 `docs/api-contract/openapi.yaml`

- `paths`에 `/api/login`·`/api/logout`·`/api/session` 3개를 추가한다(요청 스키마·응답 200/401/403/423/429·`Set-Cookie` 헤더 서술·`security`).
- 교차 계약(CSRF·CORS·허용 헤더 4종·쿠키 속성 2변형)은 `info.description` 또는 최상위 `x-cross-cutting` 확장 절에 서술한다(경로가 없는 계약이라 paths에 못 넣는다). 어디에 뒀는지 `docs/api-contract/README.md`에 한 줄 남긴다.

## Acceptance Criteria

```bash
npm run test:contract -- --profile default --files contract/cases/default/auth.contract.js,contract/cases/default/crosscutting.contract.js
npm run test:contract -- --profile auth-negative
npm run test:contract -- --profile prod-cookie
npm run test:contract
npm test
npm run lint
node scripts/contract-inventory-check.mjs
git status --porcelain
```

## 검증 절차

1. **예측 먼저**(decisions (16)): 케이스를 쓰기 전에 각 케이스의 기대 상태코드·사유 토큰·응답 키 집합을 요약 초안에 적는다. 실행 후 예측과 다른 항목을 **전부** 요약에 남긴다(이것이 이 phase의 실질 산출물이다).
2. AC를 위에서부터 실행한다. `auth-negative`는 로그인 카운터를 소비하므로 **재실행 시 서버가 새로 뜨는지**(카운터 리셋) 확인한다 — 같은 커맨드를 연속 2회 돌려 둘 다 green이어야 한다(그렇지 않다면 프로파일 격리가 깨진 것이다).
3. **vacuity 변이 2종**(각각 red 확인 후 원복): (a) A-1의 기대 상태 401→403, (b) C-2의 기대 토큰 `locked`→`lock`. 각각 정확히 그 케이스만 red여야 한다.
4. 쿠키 속성 단언이 **문자열 부분일치로 통과해 버리는 함정**을 점검한다: `Secure`가 없어야 하는 프로파일에서 `SameSite=None`을 기대하도록 잠깐 뒤집어 red가 나는지 확인하고 원복(속성 파싱이 실제로 동작한다는 증거).
5. 리포트 누출 재확인: 이번 step은 세션·쿠키를 다루므로 리포트에 64-hex 토큰이나 쿠키 값 원문이 없는지 반드시 확인한다.
6. `git status --porcelain` 증분 = 소유 파일(`contract/cases/default/auth.contract.js`·`contract/cases/default/crosscutting.contract.js`·`contract/cases/auth-negative/login-negative.contract.js`·`contract/cases/prod-cookie/cookie-prod.contract.js`·`docs/api-contract/openapi.yaml`·`phases/67-port-p1-contract/index.json`).
7. 아키텍처 체크: 서버 코드 무수정 · `test/**` 무수정 · `npm test` 1327 유지 · 새 의존성 0.
8. index.json step3 status·summary 갱신(예측 대비 실측 차이·429 본문 형식·변이 결과 포함).

## 금지사항

- `default` 프로파일에서 이 step의 로그인 호출이 **1회(A-3)** 를 넘게 하지 마라. 이유: 그 프로파일의 전체 예산은 러너 3 + 이 step 1 + step11(로그아웃 검증) 1 = **5회 ≤ 10회/15분**로 잡혀 있다. 여기서 더 쓰면 뒤 step의 케이스가 429로 무너지고, 원인이 자기 step에 없어 진단이 가장 어려운 실패가 된다.
- 케이스에 비밀번호를 문자열로 적지 마라(`credentials(role)`만 쓴다). 이유: 68+ Spring 대상은 계정·비밀번호가 다를 수 있고, 하드코딩하면 이 파일들이 전부 재작성 대상이 된다(문서·리포트 마스킹 규율도 함께 깨진다).
- `auth-negative` 프로파일에 다른 도메인 케이스를 넣지 마라. 이유: 그 프로파일은 카운터를 의도적으로 소진하는 곳이라, 다른 케이스가 함께 있으면 429/423 오염으로 비결정적이 된다.
- 계정 잠금 임계값·레이트리밋 한도를 명세에 "추측"으로 적지 마라. 이유: 이 숫자는 Spring이 그대로 구현해야 하는 계약값이다 — 코드에서 읽은 값만 적고 근거 파일·행을 주석에 남긴다.
- 세션 토큰·쿠키 값을 리포트나 로그에 남기지 마라. 이유: 세션 토큰은 그 자체가 권한이다(ADR-004).
- `?session=` 쿼리 폴백이 동작하도록 서버를 고치거나, 동작한다고 명세에 적지 마라. 이유: 그 폴백은 보안 사유로 제거됐고 **부재가 계약**이다.
- CSRF 케이스에서 부수효과가 있는 라우트(기사 저장·전이·tick)로 403을 유발하지 마라. 이유: 게이트가 뚫려 있었다면 실제 데이터가 바뀐다 — 무해한 라우트로 검증한다.
