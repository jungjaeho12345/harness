# Step 6: edge-filters

미들웨어 축(라우트가 아닌 계약)을 만든다: **CORS allowlist/preflight · CSRF Origin/Referer 가드 · 미정의 경로 404 shape · 선언된 보호 경로의 미인증 401**. 이 step이 끝나면 `contract/cases/default/crosscutting.contract.js`가 Spring 대상에서 green이 된다.

## 읽어야 할 파일

- `phases/68-spring-auth/index.json` — decisions **(7)(8)(9)(13)(17)**
- `contract/cases/default/crosscutting.contract.js` — **판정 기준 원문**. 6케이스: 교차 출처 Origin 403 `forbidden-origin` · 허용 출처 Referer만 있어도 통과 · 파싱 불가 Referer 403 · 허용 출처 preflight 2xx + ACAO/ACAC + 허용 헤더 4종 · 비허용 출처 preflight는 2xx이지만 **ACAO 부재**(ACAC는 실린다) · 미정의 경로 404 + **본문이 JSON이 아니다**(Content-Type `text/html`)
- `contract/cases/default/session-guard.contract.js` 마지막 케이스 — 죽은 토큰으로 `GET /api/articles` 호출 시 **401 `{ok:false, reason:'unauthenticated'}`**. 이 phase에 기사 핸들러는 없다 — **경로 정책 필터가 이 401을 만든다**(decisions (8))
- `docs/api-contract/openapi.yaml` 최상위 **`x-cross-cutting`** — `csrf`·`cors`·`errorShapes` 절(문자열 그대로 계약이다)
- `docs/api-contract/endpoints.json` — 39행의 `auth` 값(`public`/`session`/`session-role`/`admin`/`token`) — **경로 정책 표의 출처**
- `server/index.js` — `allowedOrigins`(92~99행), `csrfOriginGuard`(283~305행), `isLoopbackOrigin`(267~275행), cors 설정(509~516행), 미들웨어 등록 순서(488~562행) — **읽기 전용 참조**
- `docs/ADR.md` ADR-009(CSRF Origin/Referer allowlist)
- step5 산출물(와이어 포맷 단일 지점·세션 토큰 판독·에러 응답 헬퍼)

## 배경 (동결된 계약 사실)

- **CORS**: `credentials: true`(와일드카드 origin 금지), 메서드 5종, 허용 헤더 **정확히 4종**(`Content-Type, x-session-id, x-collection-token, x-edit-client`). 허용 출처 preflight는 2xx + ACAO(요청 Origin 반향) + ACAC `true`. 비허용 출처 preflight도 **2xx**이고 ACAO만 없다(403이 아니다).
- **preflight는 핸들러 존재와 무관해야 한다**: 계약 케이스는 `OPTIONS /api/articles`로 preflight를 검증하는데 **이 phase에는 기사 핸들러가 없다**. Spring MVC의 기본 preflight 처리는 매칭되는 핸들러를 요구하므로 그대로 두면 404가 난다 → **서블릿 필터 레벨에서 preflight에 응답**해야 한다.
- **CSRF 가드**: 상태 변경 메서드(비 GET/HEAD/OPTIONS)만 본다. 판정 순서 = Origin → 없으면 Referer의 origin → **둘 다 없으면 통과**(서버-서버/cron 관용. 계약 스위트 전체가 이 관용 위에서 돈다) → 자기 출처면 통과 → allowlist면 통과 → 비프로덕션이면 loopback 관용 → 그 외 **403 `{ok:false, reason:'forbidden-origin'}`**. Referer가 파싱 불가면 403.
- **allowlist 출처**: 비프로덕션 기본값 2개(`http://localhost:5173`·`http://127.0.0.1:5173`) + `ALLOWED_ORIGINS` / 프로덕션은 `ALLOWED_ORIGINS`만(기본값 제외, loopback 관용 off).
- **자기 출처 판정에 `X-Forwarded-Host`를 쓰지 마라**(스푸핑으로 게이트가 뚫린다 — Node 주석의 CRITICAL).
- **미정의 경로 404는 JSON이 아니다**(`text/html`). "모든 거부는 JSON"의 예외 2건 중 하나이며 **그 예외 자체가 계약**이다. Spring Boot 기본 에러 처리가 어떤 Content-Type을 내는지는 실측해서 맞춘다.
- **선언된 보호 경로의 미인증 401**: `endpoints.json`에서 `auth != public`인 경로는 미인증이면 401 JSON이다. 이 phase에서 아직 핸들러가 없는 경로도 마찬가지다(Node는 라우트 안에서 세션을 검사하지만 결과는 동형이다).

## 작업

### A. `web` 패키지 — CORS 필터

- 서블릿 필터로 구현한다(핸들러 매핑에 의존하지 않는다). preflight(OPTIONS + `Access-Control-Request-Method`)는 **필터가 직접 2xx로 끝낸다**.
- 허용 출처면 ACAO에 **요청 Origin을 그대로** 반향하고 ACAC `true`를 싣는다. 비허용 출처면 ACAO를 싣지 않는다(ACAC는 실린다 — 실측이 그렇다. `crosscutting` 케이스가 이 비대칭을 단언한다).
- 허용 헤더 목록은 상수 1곳(4종, 순서·표기는 계약 케이스가 소문자 정렬로 비교하므로 표기는 자유, **집합이 정확히 4종**이어야 한다).
- **preflight의 상태코드까지 Node 실측에 맞춘다**: 계약 케이스는 `status < 300`으로만 보지만 `scripts/contract-diff.mjs` 59행은 **`status`를 정확 비교**한다 — 2xx 아무 값이나 내면 **기능 green·패리티 red**가 된다. 허용/비허용 preflight의 **상태 정수와 헤더 문자열**을 step5 작업 A와 같은 절차(아래 작업 A′)로 Node 리포트에서 읽어 그대로 맞춘다.

### A′. Node 기준값 실측 (구현보다 **먼저** — decisions (9)를 헤더 밖으로 확장)

```bash
cd /d/agents/harness
node scripts/contract-run.mjs --profile default --files contract/cases/default/crosscutting.contract.js --out "${TEMP:-/tmp}/node-crosscutting-baseline.json"
```

리포트에서 다음을 **원문 그대로** 요약에 옮긴다: ① 허용 출처 preflight 관측의 `status`(정수)와 `headers`(ACAO·ACAC 정규화 값) ② 비허용 출처 preflight 관측의 `status`와 헤더 ③ 미정의 경로 404 관측의 `status`·`headers['content-type']` 문자열. 확인 후 리포트 파일을 삭제한다(리포 밖 임시 경로에 만들 것).

### B. `web` 패키지 — CSRF Origin 가드 필터

- 위 "배경"의 판정 순서를 그대로 구현한다. 라우트별 예외 목록을 만들지 않는다(서버-서버 관용은 "Origin·Referer 부재" 단일 규칙으로만 표현한다 — Node 주석의 규율).
- 거부는 403 + `{ok:false, reason:'forbidden-origin'}` JSON(step5의 에러 응답 헬퍼 재사용).
- 자기 출처 판정은 요청의 스킴·Host 헤더로 하되 **`X-Forwarded-*`를 신뢰하지 않는다**.

### C. `web` 패키지 — 경로 정책(미인증 401) 필터

- `endpoints.json`의 `auth` 분류에서 파생한 **경로 패턴 표**를 Java 상수로 둔다(런타임에 문서 파일을 읽지 않는다 — 배포 산출물에 문서가 없다). 표 머리말에 출처(`docs/api-contract/endpoints.json`)와 "라우트가 늘면 이 표를 갱신한다"를 적는다.
- **표는 `경로 → auth 클래스`를 보존한다**(`public` · `session` · `session-role` · `admin` · `lock-holder` · `token`). "`public`이 아니면 세션 요구"로 뭉개지 마라 — `collection-receive`·`collection-pull`은 `auth: "token"`(`x-collection-token` + loopback)이라 세션이 없는 것이 정상인데, 뭉개면 **유효 토큰에도 401**이 나고 그 오류가 phase 69+로 상속된다.
- 이 phase에서 **세션을 요구하는 대상은 `session`·`session-role`·`admin`·`lock-holder` 클래스뿐**이다. `token` 클래스 행은 표에 **클래스 그대로 남기되 이 필터의 대상에서 제외**하고, 옆에 "수집 도메인 phase 소유(fail-closed 503 → 토큰 인증 순서 포함)"라고 표기한다.
- 표에 **매칭되는 경로만** 세션을 요구한다. 매칭되지 않는 경로(예: `/api/does-not-exist`)는 그대로 통과시켜 컨테이너 404로 흘려보낸다.
- 세션 판정은 step3의 **가드**를 통해서만 한다(스토어 직접 접근 금지). 미인증이면 401 `{ok:false, reason:'unauthenticated'}`.
- 인증된 요청은 통과시킨다 — 이 phase에 핸들러가 없는 경로는 404가 되며, **그것이 의도된 상태**다(decisions (8)).

### D. 필터 순서

`CORS → CSRF → (step7 레이트리밋) → 경로 정책 → 디스패처`. 순서 상수를 **한 곳**에 모으고 각 순서의 근거를 주석으로 남긴다(Node의 등록 순서와 동형: preflight는 CSRF에 도달하지 않고, CSRF 거부는 세션 판정보다 먼저 일어난다).

### E. 미정의 경로 404

- Spring Boot 기본 동작을 **실측**한다(`Accept: */*`로 미정의 `/api/...` 경로 호출 시 상태·Content-Type·본문 형식). 계약(404 + 비-JSON `text/html`)과 다르면 맞춘다.
- 계약이 요구하는 것은 "JSON이 아니다 + Content-Type이 `text/html`"이며, **본문 문자열은 계약이 아니다**(리포트는 bodyKeys만 본다). 다만 `--parity` diff는 **상태 정수와 Content-Type 문자열**을 정확 비교하므로 작업 A′의 실측값과 같아야 한다.

### F. 테스트(먼저 쓴다 — RANDOM_PORT + 원시 HTTP)

허용/비허용 preflight · **핸들러 없는 경로의 preflight** · 교차 출처 상태 변경 403 · Referer만 있는 통과/파싱 불가 403 · Origin·Referer 부재 통과 · 프로덕션 프로파일에서 loopback Origin 403(관용 off) · 미정의 경로 404 + Content-Type · 보호 경로 미인증 401 JSON(핸들러 없는 경로 포함) · **`X-Forwarded-Host`로 자기 출처를 위조해도 403**.

## Acceptance Criteria

```bash
cd /d/agents/harness/server-spring && JAVA_HOME="D:/agents/tools/jdk-21.0.12+8" ./mvnw -B -q verify
cd /d/agents/harness/server-spring && JAVA_HOME="D:/agents/tools/jdk-21.0.12+8" ./mvnw -B -q package -DskipTests
cd /d/agents/harness && node scripts/spring-contract.mjs --profile default --files contract/cases/default/auth.contract.js,contract/cases/default/crosscutting.contract.js,contract/cases/default/health.contract.js
cd /d/agents/harness && node scripts/spring-contract.mjs --profile default --files contract/cases/default/auth.contract.js,contract/cases/default/crosscutting.contract.js,contract/cases/default/health.contract.js --parity
cd /d/agents/harness && node scripts/spring-contract.mjs --profile default --files contract/cases/default/auth.contract.js,contract/cases/default/crosscutting.contract.js,contract/cases/default/health.contract.js --dual-run
cd /d/agents/harness && node scripts/spring-contract.mjs --profile prod-cookie --parity
cd /d/agents/harness && npm test
cd /d/agents/harness && git status --porcelain
```

- 3·4번이 green이면 이 step의 목표(계약 파일 3개 + 패리티)가 달성된 것이다. **4번(패리티)이 이 step의 진짜 게이트**다 — preflight 상태 정수와 404 Content-Type은 기능 케이스가 잡아 주지 않는다.
- 5번은 자기 결정성(하네스가 **새 DATA_DIR + 새 프로세스로 두 패스**를 돌린다 — step1 배경).
- 6번은 **회귀 확인**(프로덕션 프로파일에서 CSRF allowlist가 비고 loopback 관용이 꺼져도 cookie-prod 케이스가 그대로 통과해야 한다 — 그 케이스들은 Origin을 보내지 않는다).

## 검증 절차

1. A′(Node 기준값 실측) → F(테스트 red 확인) → 구현 순서를 지킨다. 실측한 **preflight 상태 정수 2종·404 상태/Content-Type**을 요약에 남긴다.
2. AC 실행. 3번(기능 green) → 4번(패리티 green)을 따로 기록한다 — 이 둘은 다른 사건이다.
3. **변이 실증 4종**(확인 후 원복): (a) CSRF에서 "Origin·Referer 부재 통과"를 제거하면 → 계약 스위트 **전체가 무너지는지**(관용 위에서 돈다는 사실의 실증), (b) 경로 정책을 `/api/**` 전체로 넓히면 → 미정의 경로 404 케이스가 red인가(401이 되어), (c) 허용 헤더에 5번째 헤더를 추가하면 → preflight 케이스가 red인가, (d) preflight 상태를 실측값과 다른 2xx로 바꾸면 → **기능 케이스는 green인데 `--parity`가 red**인가(status 정확 비교의 실증).
4. **X-Forwarded-Host 위조 프로브**를 손으로 1회 실행해 403을 확인한다(F에 테스트가 있어도 실기 확인을 남긴다 — 게이트 우회는 조용히 뚫린다).
5. 경로 정책 표에 `token` 클래스 행이 **세션 요구 대상에서 제외**돼 있는지 눈으로 확인한다(작업 C — 수집 2라우트가 유효 토큰에도 401이 되면 phase 69+가 그 오류를 상속한다).
6. AC 5번(`--dual-run`)에서 두 패스가 서로 다른 임시 DATA_DIR·서로 다른 java 프로세스로 떴는지 로그로 확인한다.
7. `git status --porcelain` 증분 = `server-spring/src/main/**` · `server-spring/src/test/**` · `phases/68-spring-auth/index.json`.
8. index.json step6 status·summary 갱신(실측한 preflight 상태·404 Content-Type 문자열 포함).

## 금지사항

- preflight 응답을 핸들러(컨트롤러) 존재에 의존시키지 마라(`@CrossOrigin`·MVC 기본 preflight 처리에 맡기지 마라). 이유: `OPTIONS /api/articles`는 이 phase에 핸들러가 없어 404가 나고, 계약 케이스가 정확히 그 경로로 preflight를 검증한다.
- 경로 정책 필터를 `/api/**` 와일드카드로 걸지 마라. 이유: 미정의 경로가 401이 되어 "404 + 비-JSON"이라는 동결된 에러 shape 계약이 깨진다.
- 경로 정책 표를 "`public`이 아니면 세션"으로 뭉개지 마라(`auth` 클래스를 보존하라). 이유: `auth: "token"` 라우트(수집 2건)는 `x-collection-token` + loopback으로 인증하므로 세션이 없다 — 뭉개면 **유효 토큰에도 401**이 되고, 이 표는 후속 phase가 그대로 물려받기 때문에 오류가 수집 도메인까지 상속된다.
- preflight 상태코드를 "2xx면 아무거나"로 두지 마라. 이유: `contract-diff.mjs`는 `status`를 **정확 비교**한다 — 계약 케이스(`status < 300`)만 보고 넘기면 패리티에서 터진다.
- CSRF에 라우트별 예외 목록을 만들지 마라. 이유: Node는 단일 규칙(부재 관용)만 갖는다 — 예외 목록은 이식 과정에서 조용히 늘어나 게이트를 무력화한다.
- 자기 출처 판정에 `X-Forwarded-Host`/`X-Forwarded-Proto`를 쓰지 마라. 이유: 헤더 스푸핑으로 CSRF 게이트가 통째로 뚫린다(Node 주석의 CRITICAL). 호스트 재작성 배포는 `ALLOWED_ORIGINS`로 명시 등록한다.
- 비허용 출처 preflight를 403으로 만들지 마라. 이유: 실측 계약은 2xx + ACAO 부재다(판독 차단은 브라우저가 한다).
- 미정의 경로 404를 JSON으로 바꾸지 마라. 이유: 비-JSON 404가 동결된 계약이며, 바꾸면 계약 케이스가 red가 된다(고치고 싶다면 그것은 계약 변경이고 별도 판단이다 — decisions (17)).
- 여기서 레이트리밋·사용자 관리·로그를 구현하지 마라. 이유: 각각 step7·step8·step9의 범위다.
- `contract/**`·`docs/api-contract/**`를 고치지 마라.
