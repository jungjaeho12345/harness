# Step 7: login-rate-limit

로그인 IP 레이트리밋(15분/10회)을 만든다. 이 step이 끝나면 `auth-negative` 프로파일(= `contract/cases/auth-negative/login-negative.contract.js`)이 Spring 대상에서 green이 된다 — 계정 잠금 423(step4)과 레이트리밋 429가 한 파일에서 함께 판정된다.

## 읽어야 할 파일

- `phases/68-spring-auth/index.json` — decisions **(7)(9)(13)**
- `contract/cases/auth-negative/login-negative.contract.js` — **판정 기준 원문**. 3케이스가 **순서대로** 돈다: C-1 `invalid-credentials` 2회(존재/미존재 계정이 같은 401) → C-2 임계 5회 실패 후 **올바른 비밀번호로도 423** → C-3 남은 예산 소진 후 **429**. 단언: `attempts == RATE_LIMIT + 1`(창 안 11번째 요청에서 429) · **본문이 JSON이 아니다** · `content-type`이 `text/html` · **`ratelimit-limit` 헤더 == `'10'`**
- `docs/api-contract/openapi.yaml` 최상위 `x-cross-cutting.loginLimits`·`errorShapes` — 429는 "모든 거부는 JSON"의 예외 2건 중 하나
- `docs/api-contract/endpoints.json` — `login` 행의 `expect`에 `rate-limited` 포함
- `server/index.js` 609~614행 — `loginLimiter`(`windowMs` 15분 · `limit` 10 · `standardHeaders: true` · `legacyHeaders: false`) — **읽기 전용 참조**
- `contract/lib/record.js`의 `ALLOWED_HEADERS` — 리포트에 실을 수 있는 헤더(`ratelimit-limit`·`ratelimit-policy`는 허용, `-remaining`·`-reset`·`retry-after`는 **휘발이라 불허**)
- step5·step6 산출물(와이어 포맷 단일 지점·필터 순서 상수)

## 배경 (동결된 계약 사실)

- 한도는 **IP 단위 15분 / 10회**이고, 창 안에서 10회까지는 라우트가 처리하며 **그 다음(11번째) 요청이 거부**된다.
- 429 응답은 **라우트가 아니라 레이트리밋 계층이 만든다** → 본문이 JSON이 아니고 Content-Type이 `text/html`이다. 이 예외 자체가 계약이며 클라이언트는 파싱 실패에 관대하다.
- `ratelimit-limit` 헤더 값이 `10`이어야 한다(리포트에 기록되는 유일한 레이트리밋 헤더). `-remaining`/`-reset`은 리포트에 실리지 않으므로 있어도 diff에 영향이 없다 — 붙일지는 재량이되 **값이 시간에 따라 변하는 헤더를 리포트 대상 이름으로 쓰지 마라**.
- 이 프로파일은 **전용 인스턴스**다(카운터 격리). 하네스가 프로파일마다 새 프로세스를 띄우므로 재실행할 때마다 카운터가 리셋된다.
- 잠금 423과 레이트리밋 429의 **판정 순서**: C-3은 이미 잠긴 계정으로 반복 호출하며 "429 전까지는 423"을 단언한다 → **레이트리밋이 라우트보다 먼저**여야 한다(한도 초과 전에는 라우트가 423을 만들고, 초과하는 순간 레이트리밋이 429를 만든다).

## 작업

### A. `web` 패키지 — 레이트리밋 필터

- 적용 범위는 **`POST /api/login`만**이다(다른 라우트에 걸지 마라).
- 고정 창(15분) 카운터를 클라이언트 IP별로 in-memory에 둔다. 시각은 주입 `Clock`(decisions (14)).
- 클라이언트 식별은 **원격 소켓 주소**로 한다 — `X-Forwarded-For`·`X-Real-IP`를 신뢰하지 않는다(신뢰하면 헤더 한 줄로 한도가 우회된다. Node도 비프로덕션에서 프록시를 신뢰하지 않는다).
- 초과 시 429 + **비-JSON 본문** + Content-Type `text/html`(문자열은 step5 작업 A와 같은 방법으로 Node 리포트에서 실측해 맞춘다) + `RateLimit-Limit` 헤더.
- 카운터 저장소는 무한 증식하지 않게 창 경과 항목을 조회 시 정리한다(정리 타이머 금지 — 금지사항 참조).
- 필터 순서: CSRF 다음, 경로 정책 앞(step6의 순서 상수에 추가한다). 근거를 주석으로 남긴다.

### B. 설정

한도·창 크기는 **계약값**이므로 코드 상수 또는 기본 프로퍼티로 두고 프로파일이 덮지 않는다. 상수 옆에 근거(`server/index.js` 609~614행)를 주석으로 적는다.

### C. 테스트(먼저 쓴다 — RANDOM_PORT + 원시 HTTP)

1. 한도 안에서는 라우트가 응답한다(예: 잘못된 자격 401이 반복된다).
2. 한도를 넘는 요청이 **429 + 비-JSON + `text/html` + `RateLimit-Limit`** 를 낸다.
3. 429가 나는 요청 번호가 **한도 + 1**이다.
4. 창이 지나면(고정 시계 전진) 다시 통과한다.
5. `X-Forwarded-For`를 바꿔가며 호출해도 **한도가 우회되지 않는다**.
6. 레이트리밋은 `/api/login` 외 라우트에 적용되지 않는다(예: `GET /api/session`을 20회 호출해도 429가 없다).

## Acceptance Criteria

```bash
cd /d/agents/harness/server-spring && JAVA_HOME="D:/agents/tools/jdk-21.0.12+8" ./mvnw -B -q verify
cd /d/agents/harness/server-spring && JAVA_HOME="D:/agents/tools/jdk-21.0.12+8" ./mvnw -B -q package -DskipTests
cd /d/agents/harness && node scripts/spring-contract.mjs --profile auth-negative
cd /d/agents/harness && node scripts/spring-contract.mjs --profile auth-negative --parity
cd /d/agents/harness && node scripts/spring-contract.mjs --profile auth-negative --dual-run
cd /d/agents/harness && node scripts/spring-contract.mjs --profile default --files contract/cases/default/auth.contract.js,contract/cases/default/crosscutting.contract.js,contract/cases/default/health.contract.js
cd /d/agents/harness && npm test
cd /d/agents/harness && git status --porcelain
```

- 3번: `auth-negative` 계약 파일 green.
- 4번: 패리티 diff 0 — 429의 Content-Type 문자열과 `ratelimit-limit` 값이 Node와 같아야 통과한다.
- 5번: 자기 결정성. **이 프로파일이 dual-run 설계의 시금석이다** — 패스 1이 IP 한도(설계상 정확히 11회)를 소진하므로, 하네스가 패스마다 **새 DATA_DIR + 새 Spring 프로세스**를 띄우지 않으면 패스 2가 첫 케이스부터 429로 확정 red가 된다(step1 배경).
- 6번: **회귀 확인** — 레이트리밋을 넣은 뒤에도 default 프로파일의 로그인 5회(러너 3 + auth 2)가 한도 안에서 정상 동작하는지.

## 검증 절차

1. red 먼저(C). 요약에 red 관측을 남긴다.
2. AC 3번을 **연속 2회** 실행해 둘 다 green인지 본다 — 2회차가 429로 깨지면 하네스가 프로파일마다 새 인스턴스를 띄우지 않는다는 뜻이다(카운터 격리 실증).
3. **변이 실증 2종**(확인 후 원복): (a) 한도를 9로 바꾸면 `attempts == RATE_LIMIT + 1` 단언이 red인가(계약 케이스가 숫자를 실제로 검증한다는 실증), (b) 429 본문을 JSON으로 만들면 계약 케이스가 red인가.
4. 계정 잠금(423)과 레이트리밋(429)의 **순서**가 계약과 같은지 확인한다: C-3이 "429 전까지는 423"을 단언하므로 순서가 뒤집히면 red가 난다.
5. AC 5번(`--dual-run`)이 exit 0(diffs 0)인지 확인하고, 로그에서 두 패스의 **임시 DATA_DIR 경로와 java PID가 서로 다른지** 확인한다. 두 패스가 인스턴스를 공유하면 여기서 429로 반드시 터진다 — **dual-run 대상에서 제외하는 우회는 없다**(제외하면 이 phase에서 자기 결정성을 판정할 수 있는 유일한 상태 소진형 프로파일을 잃는다). 터지면 하네스(step1 설계)를 고친다.
6. `git status --porcelain` 증분 = `server-spring/src/main/**` · `server-spring/src/test/**` · `phases/68-spring-auth/index.json`.
7. index.json step7 status·summary 갱신.

## 금지사항

- 레이트리밋을 전역(모든 라우트)에 걸지 마라. 이유: 계약은 로그인 라우트 한 곳의 IP 한도만 동결한다 — 다른 라우트에 걸면 계약 스위트가 픽스처 생성 중 429로 무너진다(원인이 자기 step에 없어 진단이 가장 어려운 실패다).
- 429 본문을 JSON으로 내지 마라. 이유: "모든 거부는 JSON"의 **의도된 예외**이며 계약 케이스가 `res.json === undefined`와 `text/html`을 단언한다.
- `X-Forwarded-For`·`X-Real-IP`로 클라이언트를 식별하지 마라. 이유: 헤더 한 줄로 한도가 무한 우회된다(리버스 프록시 배포는 별도 판단 — 지금은 프록시가 없다).
- 카운터를 DB·세션에 저장하지 마라. 이유: 로그인 실패는 미인증 요청이라 세션이 없고, DB에 쓰면 무제한 행 증식 + DB 비파괴 규칙과 충돌한다(in-memory가 Node 동형).
- 정리용 스케줄러(`@Scheduled`)를 만들지 마라. 이유: ADR-008의 "앱 내 타이머 0" 규율 — 정리는 조회 시점에 한다.
- 휘발성 헤더(`-remaining`·`-reset`·`Retry-After`)를 리포트 대상 이름으로 쓰지 마라. 이유: 값이 시간에 따라 변해 이중 실행 diff가 무의미해진다(`contract/lib/record.js`가 그래서 허용 목록에서 뺐다).
- 계정 잠금 로직(step4)을 여기서 손대지 마라. 이유: 두 축이 한 파일에서 함께 판정되므로, 실패 시 어느 축인지 구분할 수 있게 소유 step을 분리해 둔 것이다.
