# Step 5: http-auth

인증 3라우트(`POST /api/login` · `POST /api/logout` · `GET /api/session`)의 HTTP 계층을 만든다. 이 step이 끝나면 **Spring 대상에서 첫 계약 파일이 green**이 된다: `contract/cases/default/auth.contract.js`와 `contract/cases/prod-cookie/cookie-prod.contract.js`.

이 step은 "동작"이 아니라 **와이어 바이트**가 판정 대상이다. 계약 리포트 diff는 헤더 문자열을 정확 비교하므로, 프레임워크 기본값을 그대로 쓰면 기능은 맞는데 패리티가 깨진다.

## 읽어야 할 파일

- `phases/68-spring-auth/index.json` — decisions **(9)(10)(12)(13)(17)** · order
- `contract/cases/default/auth.contract.js` — **판정 기준 원문**. 9개 케이스: 미인증 401 JSON · 헤더 폴백 200 + user 정확 5키 · 로그인 200(`sessionId` 64-hex, user 6키, 쿠키 속성) · 단일 세션(이전 토큰 401) · 쿠키만으로 200 · 로그아웃 200 + 만료 쿠키(Max-Age=0) + 이후 401 · 세션 없이 로그아웃 200 · `?session=` 쿼리 폴백 부재 401 · 형식 잘못된 토큰 401. **파일 끝의 공용 세션 복구 케이스**(R 재로그인)도 반드시 통과해야 뒤 파일이 산다
- `contract/cases/prod-cookie/cookie-prod.contract.js` — 프로덕션 쿠키 3케이스(Secure + SameSite=None, 헤더 폴백 생존, 만료 쿠키에도 같은 속성)
- `docs/api-contract/openapi.yaml` — `login`·`logout`·`session` 오퍼레이션 + 최상위 **`x-cross-cutting`**(`sessionTransport`·`sessionCookie`·`errorShapes`)
- `docs/api-contract/endpoints.json` — `login`·`logout`·`session` 행의 `expect` 태그와 notes(세션 user는 **정확히 5키**, 로그인 user는 6키 — 두 라우트의 shape이 다르다)
- `docs/api-contract/reason-tokens.md` — 전역 매핑 22종과 **로그인 라우트 로컬 423**
- `server/index.js` — `sessionCookieOptions`(52~61행), `setSessionCookie`/`clearSessionCookie`/`readSessionToken`(566~589행), login 라우트와 423 분기(616~635행), logout(637~642행), session(646~650행), `STATUS_BY_REASON`(322~352행), 전역 에러 핸들러(1244~1247행) — **읽기 전용 참조**
- `src/services/sessionService.js`의 `identityOf` · `src/services/userService.js`의 `SAFE_FIELDS` — 5키/6키의 출처
- step3·step4 산출물(세션 가드·사용자 서비스) 시그니처

## 배경 (동결된 계약 사실)

- **토큰 운반 2수단**: `sid` 쿠키 **우선**, `x-session-id` 헤더 **폴백**. `?session=` 쿼리 폴백은 **부재가 계약**이다(유효 토큰을 쿼리로 줘도 401).
- **쿠키 속성 2변형**: 비프로덕션 `HttpOnly; Path=/; Max-Age=3600; SameSite=Lax`(Secure 없음) / 프로덕션 `HttpOnly; Path=/; Max-Age=3600; SameSite=None; Secure`. 로그아웃은 **같은 속성 + 빈 값 + Max-Age=0**.
- **응답 shape**: 로그인 200 `{ok, sessionId, user}`(user 6키), 세션 200 `{ok, user}`(user **5키** — `active` 없음), 로그아웃 200 `{ok:true}`(**항상 성공·멱등**, 세션이 없어도 200).
- **모든 거부는 `{ok:false, reason}` JSON**이다 — **401에도 반드시 바디가 있다**(SPA·계약 케이스가 상태코드가 아니라 본문을 읽는다). 예외는 429와 미정의 경로 404뿐이며 둘 다 이 step의 소관이 아니다(step6·step7).
- **로그인 사유 → 상태**: `invalid-credentials` 401 · `inactive` 403 · `locked` **423**(전역 매핑의 401을 라우트가 덮어쓴다).
- **전역 예외 → 500 `{ok:false, reason:'internal-error'}`**(내부 스택·메시지 노출 금지). 이것이 결함 후보 #1(중복 userId 500)의 재현 경로다.

## 작업

### A. Node 기준값 실측 (구현보다 **먼저**)

계약 리포트 diff가 비교하는 헤더 문자열의 정답을 Node에서 뽑는다. **계획서의 문장이 아니라 이 실측이 기준이다**(decisions (9)).

```bash
cd /d/agents/harness
node scripts/contract-run.mjs --profile default --files contract/cases/default/auth.contract.js --out "${TEMP:-/tmp}/node-auth-baseline.json"
node scripts/contract-run.mjs --profile prod-cookie --out "${TEMP:-/tmp}/node-cookieprod-baseline.json"
```

두 리포트에서 관측마다의 `headers['content-type']`과 `headers['set-cookie']`(정규화된 문자열 — 값은 마스킹, `Expires`는 제거됨) **원문을 그대로 요약에 옮겨 적는다**. 확인할 축:

- JSON 응답의 Content-Type 문자열(파라미터 표기까지).
- Set-Cookie의 **속성 순서와 표기**(Express `res.cookie`의 직렬화 순서는 Spring `ResponseCookie.toString()`과 다르다 — 순서가 다르면 diff가 `value-mismatch(headers.set-cookie)`로 터진다. 계약 케이스의 단언은 속성을 파싱하므로 **기능 테스트만으로는 이 차이가 드러나지 않는다**).
- 리포트를 확인한 뒤 두 파일을 삭제한다(리포 밖 임시 경로에 만들 것).

### B. `web` 패키지 — 와이어 포맷 단일 지점

- JSON 응답 Content-Type을 A의 실측값과 **동일한 문자열**로 내는 지점을 한 곳에 만든다.
- Set-Cookie 문자열을 직접 조립하는 지점을 한 곳에 만든다(속성 순서·표기·대소문자를 A의 실측에 맞춘다). 발급용·만료용 두 형태.
- 이 클래스에 "왜 프레임워크 기본값을 쓰지 않는가"(diff가 헤더 문자열을 정확 비교한다)를 주석으로 남긴다.

### C. `web` 패키지 — 세션 토큰 판독

- 쿠키 `sid` → 없으면 `x-session-id` 헤더. **쿼리 파라미터는 읽지 않는다.**
- 쿠키 파싱은 자체 구현한다(잘못된 퍼센트 인코딩이 들어와도 500이 아니라 원본값 폴백 → 인증 실패 401로 수렴 — Node의 `parseCookie` 동형).

### D. `controller` 패키지 — 3라우트

- 로그인: 자격 판정(step4) → 성공 시 세션 생성(step3 가드 경유) → 쿠키 발급 + `{ok, sessionId, user}` 200. 실패는 사유 토큰 → 상태 매핑(로그인 로컬 423 포함).
- 로그아웃: 토큰 판독(쿠키·헤더, **없으면 body의 `sessionId` 폴백** — endpoints.json notes) → 무효화 시도 → **항상** 200 `{ok:true}` + 만료 쿠키.
- 세션 복원: 토큰 판독 → 가드 조회 → 200 `{ok, user}`(5키) 또는 401 `{ok:false, reason:'unauthenticated'}`.
- 사유 토큰 → HTTP 상태 매핑 표를 **상수 1곳**에 둔다(`docs/api-contract/reason-tokens.md`의 전역 표를 옮기되, 이 phase에서 도달 가능한 토큰만 쓰고 나머지는 표에만 남긴다). 미정의 토큰의 폴백은 400.
- 전역 예외 핸들러: 500 `{ok:false, reason:'internal-error'}` + 서버 로그에만 원인 기록(응답에 스택·메시지 금지).

### E. 프로덕션 분기

- `app.env == production`이면 쿠키가 `Secure` + `SameSite=None`이 된다(그 외에는 `SameSite=Lax`, Secure 없음). 분기 판정은 **한 곳**(설정 바인딩)에서 하고 컨트롤러가 각자 판단하지 않는다.

### F. 테스트(먼저 쓴다 — RANDOM_PORT 전 기동 + 원시 HTTP)

계약 케이스의 축을 Java 쪽에서도 잠근다(계약 스위트는 최종 판정이고, Java 테스트는 진단이 빠르다):
로그인 성공 shape · 쿠키 속성 문자열(A의 실측과 **문자열 동일**) · 헤더 폴백 · 쿠키 전용 경로 · 쿼리 폴백 부재 · 로그아웃 멱등 + 만료 쿠키 · 단일 세션(이전 토큰 401) · 잘못된 토큰 401 · 401/403/423 JSON 본문 · 전역 예외 500 shape.

## Acceptance Criteria

```bash
cd /d/agents/harness/server-spring && JAVA_HOME="D:/agents/tools/jdk-21.0.12+8" ./mvnw -B -q verify
cd /d/agents/harness/server-spring && JAVA_HOME="D:/agents/tools/jdk-21.0.12+8" ./mvnw -B -q package -DskipTests
cd /d/agents/harness && node scripts/spring-contract.mjs --profile default --files contract/cases/default/auth.contract.js,contract/cases/default/health.contract.js
cd /d/agents/harness && node scripts/spring-contract.mjs --profile prod-cookie
cd /d/agents/harness && node scripts/spring-contract.mjs --profile prod-cookie --parity
cd /d/agents/harness && node scripts/spring-contract.mjs --profile default --files contract/cases/default/auth.contract.js,contract/cases/default/health.contract.js --parity
cd /d/agents/harness && node scripts/spring-contract.mjs --profile prod-cookie --dual-run
cd /d/agents/harness && node scripts/spring-contract.mjs --boot-check
cd /d/agents/harness && npm test
cd /d/agents/harness && git status --porcelain
```

- 3·4번: 계약 케이스 green(exit 0). `health.contract.js`가 여기 포함되는 이유는 **JSON Content-Type 패리티를 가장 싸게 잠그기 때문**이다(로그인 0회·부수효과 0 — step1 scope 표 주석).
- 5·6번: **패리티 diff 0**(exit 0). 여기서 터지는 것은 대부분 헤더 문자열·쿠키 속성 순서다 — 이 phase가 이 시점에 그것을 잡는 것이 설계 의도다.
- 7번: **자기 결정성**(`--dual-run`) — 하네스가 **새 DATA_DIR + 새 Spring 프로세스로 두 패스**를 돌려 리포트 diff 0을 판정한다(step1 배경: 같은 인스턴스 2회는 레이트리밋·잠금 카운터 때문에 성립하지 않는다). **이 phase에서 dual-run 경로가 처음으로 실증되는 지점**이다.
- 8번: 이제 `default`를 포함한 **3 프로파일 전부** `--boot-check` green이어야 한다(러너의 R/D/Z 3회 로그인이 성공한다 = bcryptjs 해시 호환·시드 계정 계약 충족 실증).

## 검증 절차

1. A(기준값 실측) → F(테스트 red 확인) → 구현 순서를 지킨다. A의 실측 문자열을 요약에 남긴다.
2. AC를 위에서부터 실행한다. 3·4번이 green이 된 뒤에 5·6번(패리티)을 돌린다 — **기능 green과 바이트 green은 다른 사건**이며 둘 다 요약에 따로 적는다.
3. **자기 결정성**(AC 7번): `--dual-run`이 exit 0(diffs 0)인지 확인하고, **두 패스가 서로 다른 임시 DATA_DIR·서로 다른 java 프로세스**로 떴는지 로그에서 확인한다(step1 설계대로인지의 실증). 실패하면 Spring 응답에 비결정 값(타임스탬프·랜덤)이 리포트에 새고 있거나, 두 패스가 상태를 공유하고 있다는 뜻이다.
4. **변이 실증 3종**(각각 red 확인 후 원복): (a) 쿠키에서 `HttpOnly`를 빼면 default·prod-cookie 케이스가 red인가, (b) `?session=` 쿼리 폴백을 잠깐 구현하면 해당 케이스가 red인가(**권한 상승 회귀의 재현 — 반드시 원복**), (c) JSON Content-Type을 프레임워크 기본값으로 되돌리면 **기능 케이스는 green인데 `--parity`가 red**인가(이 두 게이트의 역할 차이를 실증).
5. **로그인 예산**: 이 실행에서 `default` 프로파일이 소비하는 로그인은 러너 3 + `auth.contract.js` 2 = 5회다(상한 15분/10회). AC를 짧은 간격으로 반복 실행하면 429가 날 수 있다 — 429가 관측되면 실패가 아니라 **예산 소진**이므로 15분 대기 후 재확인하고 그 사실을 요약에 적는다(각 실행이 새 인스턴스를 띄우므로 실제로는 카운터가 리셋된다는 점도 확인).
6. **누출 스캔**: 리포트·서버 로그에 세션 토큰(64-hex)·쿠키 값·비밀번호가 없는지 확인한다.
7. `git status --porcelain` 증분 = `server-spring/src/main/**` · `server-spring/src/test/**` · `phases/68-spring-auth/index.json`.
8. index.json step5 status·summary 갱신(실측 헤더 문자열·패리티 결과·변이 3종 포함).

## 금지사항

- `?session=` 쿼리 폴백을 구현하지 마라(변이 실증 후 반드시 원복). 이유: 그 폴백은 URL·로그 누출 표면 때문에 서버·클라이언트 양쪽에서 제거됐고 **부재가 계약**이다(2026-08 감사의 권한상승 3건 중 하나).
- 쿠키·JSON 직렬화를 프레임워크 기본값에 맡기지 마라. 이유: 계약 리포트 diff는 헤더 **문자열**을 정확 비교한다 — Spring 기본 JSON Content-Type과 `ResponseCookie` 속성 순서는 Express와 다르고, 기능 테스트는 이 차이를 통과시킨다(거짓 green).
- 401·403·423 응답을 본문 없이 내지 마라. 이유: 클라이언트(httpModel)는 상태코드가 아니라 본문 `ok`/`reason`을 읽는다 — 바디 없는 401은 SPA를 "세션 복원 중"에서 영구 정지시킨다(P0 스파이크 실측).
- 로그아웃을 실패시키지 마라(세션이 없거나 토큰이 이상해도 200). 이유: 멱등·항상 성공이 계약이고, 계약 케이스가 CSRF 프로브로도 이 라우트를 쓴다.
- 예외 메시지·스택을 응답에 담지 마라. 이유: 전역 500 응답 shape은 `{ok:false, reason:'internal-error'}` 고정이다(ADR 보안 경계).
- 세션 토큰을 요청 로그·액세스 로그에 남기지 마라(경로만). 이유: LOGS.md 마스킹 규율.
- CORS·CSRF·레이트리밋을 이 step에서 구현하지 마라. 이유: step6·step7의 범위이며, 한 step에 엣지 필터까지 넣으면 실패 원인 격리가 무너진다. (지금 CORS가 없어도 `auth.contract.js`·`cookie-prod.contract.js`는 Origin 헤더를 보내지 않으므로 green이 된다.)
- 계약 케이스·러너를 고쳐 통과시키지 마라. 이유: decisions (17) — 다르면 Spring을 고친다.
