# Step 2: origin-allowlist-prod

## 목표

프로덕션에서도 무조건 허용되던 **개발용 loopback 출처(`http://localhost:5173`·`http://127.0.0.1:5173`)를 프로덕션 allowlist에서 제외**한다. 이 목록은 CORS(응답 읽기 허용)와 CSRF 가드(상태 변경 허용)가 **공유**하므로, 프로덕션에서는 `ALLOWED_ORIGINS`로 명시 등록한 출처만 남는다.

> **선행**: backend 패스의 세 번째 step. step0(`contentsProjection.js`)·step1(`articleService`/`distributionService`/`controllers`)과 파일 중복이 없다.
> 수정 대상은 **`server/index.js` 1개 + `test/csrf-origin.test.js`(및 필요 시 `test/server.https.test.js` 신규 케이스)**다. 문서 갱신은 이 step이 하지 않는다(step9 소유).

## 읽어야 할 파일

라인 번호는 실측 힌트다 — 심볼명으로 재확인하라.

- `docs/ARCHITECTURE.md` — "보안 경계" 절(CORS allowlist·CSRF Origin/Referer 검증·프로덕션 쿠키).
- `server/index.js`
  - `sessionCookieOptions(env)` — 프로덕션이면 `secure:true`, `sameSite:'none'`(cross-site 전송 허용). **이 함수는 수정 금지**(읽어서 위험을 이해하는 용도).
  - `const DEFAULT_ALLOWED_ORIGINS = ['http://localhost:5173', 'http://127.0.0.1:5173'];`
  - `export function allowedOrigins(env = process.env)` — `env.ALLOWED_ORIGINS`(콤마 구분)를 트림·빈 값 제외 후 **기본 목록 뒤에 append**한다. ← 수정 대상.
  - `const LOOPBACK_HOSTNAMES` / `isLoopbackOrigin(origin)` / `csrfOriginGuard({ origins, isProd })` — 가드는 자기 출처 → allowlist → (비프로덕션 한정) loopback 관용 순으로 통과시킨다. **가드 로직은 수정 금지.**
  - `createApp({ …, origins = allowedOrigins() })` — 기본값이 이 함수다. `app.use(cors({ origin: origins, credentials: true, … }))`로 CORS와 공유된다.
- `test/csrf-origin.test.js`
  - `allowedOrigins({})`가 기본 두 항목과 정확히 같다는 단언, `allowedOrigins()`가 두 항목을 포함한다는 단언, `ALLOWED_ORIGINS` append 단언.
  - 프로덕션 앱(`start({ env:'production', origins: allowedOrigins({ ALLOWED_ORIGINS: spa }) })`)에서 등록 출처가 통과하는 시나리오, 비프로덕션 loopback 관용(포트 9999) 시나리오.
- `test/server.https.test.js` — `origin: http://localhost:5173` preflight로 `access-control-allow-origin`을 확인하는 기존 케이스가 있으나, 그 앱은 `forceHttps: true` 구성일 뿐 `env: 'production'`이 아니어서 이번 변경의 영향을 받지 않는다(무수정 green이어야 한다). **이번 변화의 실제 관측 지점은 `test/csrf-origin.test.js`의 프로덕션 구성(`start({ env: 'production', origins })`)이다.**

## 배경 (자기완결) — 왜 위험인가

프로덕션 세션 쿠키는 `SameSite=None; Secure`다(SPA와 API가 다른 출처라 cross-site 전송이 필요하다). 즉 **브라우저는 다른 출처의 페이지가 API로 보내는 요청에도 세션 쿠키를 붙인다.** 그 요청을 걸러 내는 두 장치가 모두 같은 목록(`allowedOrigins()`)을 본다:

- CORS `origin: origins` → 목록에 있으면 응답을 **읽을 수** 있다.
- `csrfOriginGuard` → 목록에 있으면 상태 변경(POST/PUT/DELETE)이 **실행된다**.

이 목록에 `http://localhost:5173`이 항상 들어 있으므로, 피해자 브라우저에서 그 주소로 열린 아무 페이지(사내 PC에서 흔히 도는 임의의 dev 서버·데모 스크립트)가 **운영 API를 피해자 세션으로 호출하고 응답까지 읽을 수 있다**. 공격자가 Origin 헤더를 위조할 필요조차 없다 — 브라우저가 진짜로 그 값을 보낸다.

정당한 프로덕션 사용처는 없다. 운영 SPA는 실제 출처에서 서빙되고, ADR-009는 그런 배포에 `ALLOWED_ORIGINS` 명시 등록을 이미 요구한다. dev/test는 `NODE_ENV`가 production이 아니므로 아무 영향이 없다(게다가 CSRF 가드에는 비프로덕션 loopback 관용이 따로 있다).

## TDD — 테스트 먼저

`test/csrf-origin.test.js`에 red → green으로 추가한다(기존 케이스는 수정하지 않는다).

1. **순수 함수 계약**
   - `allowedOrigins({ NODE_ENV: 'production' })` → **빈 배열**.
   - `allowedOrigins({ NODE_ENV: 'production', ALLOWED_ORIGINS: ' https://spa.example , ,https://admin.example ' })` → `['https://spa.example', 'https://admin.example']`(트림·빈 값 제외 유지, 기본 두 항목 없음).
   - 회귀: `allowedOrigins({})`·`allowedOrigins({ NODE_ENV: 'development' })`·`allowedOrigins({ NODE_ENV: 'test' })`는 기본 두 항목을 그대로 포함한다.
2. **앱 수준(프로덕션)** — 기존 `start({ env: 'production', origins: … })` 헬퍼 패턴을 그대로 쓴다.
   - `origins: allowedOrigins({ NODE_ENV:'production' })`(=빈 배열)로 띄운 앱에 로그인 쿠키를 실은 **상태 변경 요청**을 `Origin: http://localhost:5173`으로 보내면 **403 `forbidden-origin`**이고, 대상 리소스가 바뀌지 않았다.
   - 같은 앱에서 `Origin: 자기 출처`(`http://127.0.0.1:<port>`) 요청은 여전히 통과한다(자기 출처 분기 무손상).
   - `origins: allowedOrigins({ NODE_ENV:'production', ALLOWED_ORIGINS:'http://spa.example' })`로 띄운 앱은 `Origin: http://spa.example` 요청을 통과시킨다.
   - Origin·Referer가 **둘 다 없는** 요청(서버-서버/cron: `POST /api/distribution/tick` 등)은 프로덕션에서도 계속 통과한다(회귀 — ADR-009의 서버-서버 관용).
3. **비프로덕션 회귀**: 오늘의 dev 구성(`env` 미지정 + 기본 origins)에서 `Origin: http://localhost:5173` 상태 변경이 계속 통과한다.

## 작업

`server/index.js`의 `allowedOrigins`만 바꾼다.

```js
export function allowedOrigins(env = process.env) {
  // 프로덕션에서는 개발용 loopback 기본값을 내보내지 않는다 — ALLOWED_ORIGINS로 명시 등록한 출처만 허용.
  const extra = /* 오늘과 동일한 파싱 */;
  return env?.NODE_ENV === 'production' ? extra : [...DEFAULT_ALLOWED_ORIGINS, ...extra];
}
```

지켜야 할 규칙:

- 프로덕션 판별은 **인자로 받은 env 객체의 `NODE_ENV`**만 본다(`process.env`를 함수 안에서 따로 읽지 마라 — 주입 seam이 깨져 테스트가 전역 상태에 의존하게 된다).
- `DEFAULT_ALLOWED_ORIGINS` 상수 자체는 유지한다(비프로덕션 기본값이자 dev 배선 근거).
- `ALLOWED_ORIGINS` 파싱 규칙(콤마 분리·트림·빈 값 제외·순서)은 그대로 둔다.
- `csrfOriginGuard`·`isLoopbackOrigin`·`LOOPBACK_HOSTNAMES`·`cors(...)` 설정·`createApp` 시그니처는 **수정하지 않는다**.
- 함수 주석에 "프로덕션에서는 기본 loopback을 제외한다(쿠키가 SameSite=None이라 로컬 dev 페이지가 운영 API를 피해자 세션으로 호출·판독할 수 있다)" 취지의 문장을 **보태기만** 한다.

## Acceptance Criteria

```bash
npm run lint      # 통과
npm run build     # 통과
npm test          # 백엔드 — 실패 0, 개수는 step1 종료 시점 + 이번 신규 케이스
npm run test:web  # 웹 무접촉 — 87 files / 2124 tests, 실패 0(개수 불변)
```

`git diff --name-only`는 `server/index.js`와 테스트 파일(들)뿐이어야 한다. `docs/`·`src/`·`web/`가 포함되면 범위를 넘은 것이다.

## 검증 절차

1. 위 AC 커맨드를 실행한다. **기존 csrf/https 테스트가 무수정 green**인지 확인한다(비프로덕션 동작이 그대로라는 증거).
2. 변이 검증: 프로덕션 분기를 지워 오늘 동작으로 되돌리면 신규 케이스(프로덕션 loopback 403·빈 배열)만 red가 되는지 확인 후 원복한다.
3. 공유 확인: `git grep -n "allowedOrigins" -- server`로 CORS와 CSRF 가드가 여전히 **같은 목록**을 쓰는지(단일 출처 유지) 확인한다.
4. 아키텍처 체크리스트:
   - transport 계층(`server/index.js`)만 수정했는가(`src/`·`web/` 무접촉)?
   - 세션·인가·쿠키 옵션 로직을 건드리지 않았는가?
   - DB 스키마·행 변경 0건, 앱 내 타이머·egress 0건인가?
5. `phases/54-audit-closeout/index.json`의 step2를 `completed` + `summary`로 갱신한다. summary에 **운영 영향**을 반드시 적어라: "프로덕션 배포는 `ALLOWED_ORIGINS`에 SPA 출처를 등록해야 한다(미설정 시 자기 출처 외 쓰기 403)". step9가 이 문장을 문서로 옮긴다.

## 금지사항

- `csrfOriginGuard`의 비프로덕션 loopback 관용(`if (!isProd && isLoopbackOrigin(claimed))`)을 없애지 마라. 이유: dev는 Vite 포트가 밀려(5174 등) 목록으로 못 잡는다 — 이 관용이 없으면 로컬 개발이 전부 403이 된다.
- Origin·Referer가 둘 다 없는 요청을 막지 마라. 이유: 외부 cron의 `POST /api/distribution/tick`(ADR-008 (3))과 서버-서버 클라이언트가 그 규칙으로 통과한다.
- 자기 출처 판정에 `req.hostname`/`X-Forwarded-Host`를 쓰지 마라. 이유: 스푸핑으로 게이트가 통째로 뚫린다(현재 코드의 CRITICAL 주석).
- `sessionCookieOptions`·`enforceHttps`·helmet/CSP 설정을 함께 손대지 마라. 이유: 이 step의 변경이 안전했는지 증명할 수 없게 된다 — 쿠키/HTTPS 조합 이슈는 step9에서 **문서로만** 다룬다.
- CORS를 `origin: true`나 와일드카드로 바꾸지 마라. 이유: credentials 모드에서 브라우저가 거부하며, 이번 수정의 반대 방향이다.
- 새 환경변수를 만들지 마라(`ALLOWED_ORIGINS` 하나로 충분하다). 이유: 운영 설정 표면이 늘수록 잘못 구성될 확률이 커진다.
- `docs/**`를 수정하지 마라. 이유: 이 phase의 문서 변경은 step9가 한 곳에서 소유한다(중복·상충 방지).
- `docs/ADR.md`·`docs/news.md`·`.claude/skills/**`·`phases/49-mini-backlog-cleanup/step0.md`·`phases/50-hygiene-cleanup/**`를 수정하거나 커밋에 포함하지 마라.
- 기존 테스트를 깨뜨리지 마라.
