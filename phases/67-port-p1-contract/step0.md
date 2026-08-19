# Step 0: contract-inventory

포팅 P1의 척추가 될 **계약 문서 골격**을 만든다. 이 step은 테스트 코드를 한 줄도 쓰지 않는다 — 39 라우트의 기계 인벤토리, 사유 토큰→HTTP 상태 실측표, SSE 프레임 계약, OpenAPI 뼈대, 그리고 "인벤토리가 실제 라우트 표와 어긋나면 실패하는" 드리프트 검사 스크립트까지가 범위다.

## 읽어야 할 파일

- `CLAUDE.md` — 프로젝트 규칙(DB 비파괴·신뢰 경계·TDD·커밋 규칙)
- `phases/67-port-p1-contract/index.json` — scope · baseline · decisions **(1)(2)(3)(13)(17)(19)(21)** · excluded (c)(d)(g)(h)(i)
- `docs/porting-plan-cpp-spring.md` — §2 "REST/SSE 계약 동결 원칙", §6.1 "계약 동결 산출물", **부록 A(39행 표)**
- `spikes/p0-spring/CONTRACT.md` 전체 — P0가 6개 엔드포인트에 대해 만든 정밀도의 본보기(부트 시퀀스·정확 프레임·쿠키·클라이언트 관용 규칙). **이 문서는 참고용이며 수정 대상이 아니다.**
- `server/index.js` 전체(1398줄) — 특히 `STATUS_BY_REASON`(321~352행), `fail()`(354행), 라우트 등록 전 구간(605~1217행), `UPLOAD_EXT_ALLOWLIST`·`UPLOAD_MAX_BYTES`(310~316행), `FILTER_KEYS`(378~384행), `sessionCookieOptions`/`setSessionCookie`(52~61·566~584행), `UNAUTHORIZED_FRAME`(423행), SSE 라우트 2개(1127~1217행)
- `src/services/contentsProjection.js` — 응답 투영 단일 지점(`lockerSessionId`·`lockerClientId` 제거)
- `src/services/lifecycle.js` — 전이표(DESK_TABLE·REPORTER_TABLE)와 거부 토큰
- `docs/SCHEMA.md` — status 11종·ArticleHistory eventType 어휘·DistributionTarget 계약
- `docs/ADR.md` ADR-004·005·007·008·009 — 인가·SSE·로그·배부·CSRF 계약의 근거
- `docs/LOGS.md` — 마스킹 규율(명세 문서에 비밀 예시를 넣지 않기 위해)

## 배경 (실측 사실 — 계획 단계에서 확인함)

- `server/index.js`의 라우트 표를 세면 **GET 16 / POST 19 / PUT 3 / DELETE 1 = 39**이고, 이 39에 SSE 2건(`GET /api/stream`·`GET /api/logs/stream`)이 **포함**돼 있다. 계획서 부록 A 39행과 정확히 일치한다. "REST 39 + SSE 2 = 41"은 이중 계수다.
- 전역 `STATUS_BY_REASON`은 22개 키를 가진다(계획서의 "21종"은 근사치다 — index.json open_questions (b)). 여기에 **라우트 로컬 매핑**이 더 있다: 로그인 `locked`→423(전역 401을 덮어씀), 업로드 `invalid-file`·`too-large`→400, 사진 `invalid-src`→400, 재전송의 `spool-write-failed`·`invalid-spool-dir`·`invalid-article-id`→500, 수집 `collection-disabled`→503, CSRF `forbidden-origin`→403, 전역 에러 핸들러 `internal-error`→500.
- 200인데 `ok:false`인 응답이 존재한다(번역: 키 없음/외부 실패도 500으로 감싸지 않고 서비스 객체를 그대로 내려보낸다). 이런 "상태코드로 성공을 판정할 수 없다"는 사실이 Spring 이식에서 가장 쉽게 깨지는 지점이므로 명세에 명시적으로 적는다.
- SSE 프레임 종결자는 빈 줄(`\n\n`)이고, 종료 신호는 `event: unauthorized` 1회 후 `res.end()`다. 로그 스트림은 접속 시 최근 2000건 replay 후 실시간을 잇는다.

## 작업

### A. `docs/api-contract/endpoints.json` — 기계 인벤토리 (이 phase 게이트의 입력)

39행 전수. **최상위 shape는 `{ "version": 1, "routes": [ ... ] }` 고정이다**(러너·검사 스크립트가 `routes` 배열만 읽는다 — 다른 최상위 키를 추가하지 마라). 각 행의 필드(고정 shape):

```
{ "id": "<kebab 고유 id>", "method": "GET|POST|PUT|DELETE", "path": "/api/...",
  "auth": "public|session|session-role|admin|token|lock-holder", "roles": ["R","D","Z"] 또는 생략,
  "profile": "default|minimal|failclosed|auth-negative|prod-cookie",
  "expect": ["success","unauthenticated","forbidden", ...],
  "sse": true 또는 생략, "notes": "<한 줄>" }
```

- `path`는 서버 코드의 라우트 패턴 그대로 쓴다(`/api/articles/:id/history/:historyId` 형태 — 실행 경로가 아니라 계약 식별자다).
- `expect`는 **그 라우트에서 반드시 케이스로 덮여야 하는 태그 집합**이다. 태그 어휘는 `success` / `unauthenticated`(401) / `forbidden`(403) / `not-found`(404) / `validation`(400) / `conflict`(409) / `disabled`(503) / `locked`(423) / `rate-limited`(429) / `graceful`(200인데 ok:false) 로 고정한다. 라우트마다 실제로 도달 가능한 것만 넣어라 — 도달 불가능한 태그를 넣으면 step12의 full 커버리지 게이트가 영원히 통과하지 못한다(예: `GET /api/health`는 `success` 하나뿐, `POST /api/distribution/tick`은 `success`·`unauthenticated`·`forbidden`·`disabled`).
- **도달 불가 태그의 대표 예(넣지 마라)**: `POST /api/login`의 `forbidden`(비활성 계정 403 `inactive`) — 시드 계정 3종은 전부 활성이고, 계약 스위트는 시드 계정을 비활성화하지 않는다(그 순간 러너의 세션 준비가 무너진다). 이 태그는 인벤토리에서 빼고 **step12의 미검증 목록에 "로그인 inactive 403 — 도달 경로 없음(시드 계정 비활성화 금지)"으로 기록**한다. 같은 판단이 필요한 태그를 발견하면 `notes`에 이유를 남기고 요약에 모아 둔다.
- `profile`은 **그 라우트의 주 케이스가 도는 프로파일**이다(대부분 `default`). `minimal`·`failclosed`가 추가로 필요한 라우트는 `notes`에 적는다. **예외 2건**: `articles-action`(#24)·`articles-derive`(#25)의 주 프로파일은 `minimal`이다 — 배부가 켜져 있으면 송고 직후 비동기 배부 훅이 DES→EPS→DPS 승격을 일으켜 전이 관측이 비결정적이 되기 때문이다(step6가 이 이유로 그 프로파일을 쓴다). 배부가 켜진 상태의 송고 계약은 step10(`default`)가 소유한다.
- id는 도메인-동작 형태로 짓는다(예: `health`, `login`, `logout`, `session`, `users-list`, `users-create`, `users-update`, `receiver-config-list/create/delete`, `distribution-targets-list/create/update/deactivate`, `distribution-tick/failures/retry`, `articles-search/list/get/history/history-snapshot/create/action/derive/translate/update`, `articles-lock/unlock/force-unlock`, `media-search`, `upload`, `photos-create/search`, `collection-receive/pull`, `stream`, `logs-digest`, `logs-stream`). 39개가 전부 유일해야 한다.

### B. `docs/api-contract/reason-tokens.md` — 사유 토큰 실측표

- 표 1: **전역 매핑**(`STATUS_BY_REASON` 전수) — 토큰 · 상태 · 발생 라우트(대표) · 의미 한 줄.
- 표 2: **라우트 로컬 매핑**(전역과 다르게 처리되는 것 전수 — 위 "배경" 목록을 코드에서 다시 확인해 채운다).
- 표 3: **서비스 계층 토큰 중 HTTP로 새어 나오는 것**(예: `duplicate-spool-dir`·`invalid-kind`·`invalid-name`·`invalid-active`·`unregistered`·`inactive`·`fetch-failed`·`no-active-api-source`·`no-key`·`error`) — 각각 어떤 라우트에서 어떤 상태로 나가는지. `fail()`의 fallback(400)에 의존하는 토큰은 그 사실을 명시한다.
- 각 표 아래에 **총 개수**를 숫자로 적는다(계획서 §6.1의 "21종"과 다르면 그 사실을 한 줄로 기록 — 계획서 파일은 고치지 마라).
- 토큰 문자열은 코드에서 그대로 옮긴다(오타 1글자가 Spring 이식에서 계약 위반이 된다).

### C. `docs/api-contract/sse.md` — SSE 확장 서술

- 두 스트림(`/api/stream` 무효화 신호 · `/api/logs/stream` Z 전용 실데이터)의: 인증 수단(쿠키 우선·`x-session-id` 폴백), 실패 시 **스트림을 열기 전** JSON 401/403으로 끝난다는 사실, 응답 헤더 3종, 프레임 문법(`event:`/`data:`/빈 줄 종결), 이벤트 어휘(`ready`·`change`·`log`·`unauthorized`), `change` payload(`{"kind":"create|update|status|lock"}` — 행 데이터 없음), 로그 replay 상한(2000)과 record 필드, push 시점 **비연장 재검증**(peek) 규칙과 그 실패 시 동작.
- 각 무효화 신호가 **어느 라우트에서 발생하는가** 표(create: 기사 생성·수집 수신/pull / update: 기사 수정 / status: 액션 전이·tick(배부 1건 이상)·재전송 성공 / lock: lock·unlock·force-unlock).
- 바이트 예시는 `spikes/p0-spring/CONTRACT.md`의 형식을 따르되 **현행 코드에서 다시 확인해서** 적는다.

### D. `docs/api-contract/openapi.yaml` — 뼈대만

- OpenAPI **3.1.0**. `info`(제목·버전 `1.0.0`·description에 "코드가 정본, 이 문서는 실측 스냅샷" 명시), `servers`(예시 `http://127.0.0.1:3001`), `tags`(도메인 9개 — auth·users·receiver-config·articles·locks·media·collection·distribution·stream).
- `components.securitySchemes`: `sessionCookie`(apiKey/cookie/`sid`), `sessionHeader`(apiKey/header/`x-session-id`), `collectionToken`(apiKey/header/`x-collection-token`). `x-edit-client` 헤더는 인증이 아니라 잠금 보유자 식별자이므로 securityScheme이 아니라 파라미터 컴포넌트로 둔다.
- `components.schemas`: `ErrorResponse`(`ok:false` + `reason` enum — reason-tokens.md 표 1·2·3의 합집합), `OkResponse`, `ContentsRow`(투영 후 필드 — `lockerSessionId`·`lockerClientId`가 **없다**는 사실을 description에 명시), `Article`, `HistoryRow`, `User`, `UserPublic`(4필드), `DistributionTarget`, `ReceiverConfig`.
- `paths:`는 **비워 둔다**(빈 매핑 `paths: {}`가 아니라 주석으로 "step3~step11이 도메인별로 append한다 — 다른 step이 쓴 절은 수정하지 않는다"를 남기고 실제 항목은 step3부터 채운다). 단 이 step에서 `/api/health` 1건은 형식 본보기로 채워 둔다(후속 step이 따라 쓸 템플릿).

### E. `docs/api-contract/README.md` — 정본 관계와 사용법

- **정본 관계**: 코드가 정본 / 이 디렉토리는 실측 스냅샷 / 불일치 시 문서를 코드에 맞춘다 / 코드는 이 phase에서 고치지 않는다.
- 39 라우트의 정의(REST 37 + SSE 2 = 39, GET 16/POST 19/PUT 3/DELETE 1)와 "REST 39 + SSE 2"가 이중 계수라는 사실.
- 파일 4종의 역할(누가 사람용이고 누가 기계 게이트 입력인지), 갱신 규율(라우트가 늘면 endpoints.json → openapi.yaml → 케이스 순).
- 측정 조건(= 프로파일): `SPA_DIR` 미설정, 외부 API 키 미설정, `.env` 미로드, NODE_ENV 미설정. 이 조건 밖의 동작(SPA 폴백·실 외부 API·프로덕션 HTTPS 강제)은 이 명세의 범위가 아니라는 것.
- **"코드 ↔ 스펙 문서 차이" 절**(빈 절이 아니라 실제 항목으로 시작한다 — 이 phase가 실측으로 확인한 드리프트 **2건**을 반드시 싣는다): ① `docs/porting-plan-cpp-spring.md` §6.1의 "사유 토큰 21종" ↔ 실측(전역 `STATUS_BY_REASON` 22개 + 라우트 로컬 매핑 다수) ② 부록 A #19의 "필터 15키" ↔ 실측 `FILTER_KEYS` **13키**. 두 건 모두 **코드가 정본**이며 계획서 파일은 고치지 않는다(index.json open_questions (b)). 이후 step이 새 차이를 발견하면 이 절에 계속 append한다.
- **계정 표기 규율**: 시드 계정은 **userId만** 적는다(`reporter`·`desk`·`admin`). 비밀번호는 값 대신 "`src/db/seed.js`의 `SAMPLE_USERS`와 동일"이라고만 쓴다(문서에 비밀 값 금지 — LOGS.md 마스킹 규율).
- **`x-` 접두사 예약 규칙** 한 줄(F 참조): 리포트 `routeId`는 인벤토리 id이거나 `x-` 접두사이며, `x-`는 커버리지 집계에서 제외된다.
- **미동결 목록**(index.json excluded의 요약) — 정직한 공백 기록. 여기에 "`POST /api/login`의 `inactive` 403 — 도달 경로 없음"을 포함한다.

### F. `scripts/contract-inventory-check.mjs` — 드리프트 검사 (기계 게이트 1)

- 입력 없이 실행되는 CLI. 하는 일 3가지:
  1. `server/index.js`를 텍스트로 읽어 라우트 등록(`app.<method>('<path>'` 형태)을 추출하고, `endpoints.json`의 (method, path) 집합과 **양방향 비교**한다. 한쪽에만 있으면 그 목록을 출력하고 exit 1.
  2. `endpoints.json` 자체 검증: 최상위 shape(`version`·`routes`) · 39행 · id 유일 · 필드 필수값 · `expect` 태그가 고정 어휘 안 · method 분포(GET 16/POST 19/PUT 3/DELETE 1) · **id가 `x-`로 시작하지 않을 것**.
  3. `openapi.yaml`을 텍스트로 읽어 인벤토리의 모든 `path` 문자열이 등장하는지 확인한다. **단 이 검사는 `--require-spec-paths` 플래그가 있을 때만 실패로 취급한다**(step3~step11이 채우는 중에는 경고만 — step12가 플래그를 켠다).
- **`x-` 접두사 예약 규칙**: 리포트의 `routeId`는 인벤토리 id이거나 `x-` 접두사여야 한다(`x-`는 "인벤토리에 없는 라우트에 대한 관측" 전용 채널이며 커버리지 집계에서 제외된다 — 예: 존재하지 않아야 하는 `DELETE /api/distribution-targets/:id`의 404 관측). 그래서 **인벤토리 id에는 `x-` 접두사를 쓰지 마라**(위 2번이 이를 강제한다). 규칙의 소비처는 러너(step1 리포트 스키마 B)이며, 이 문서(`docs/api-contract/README.md`)에도 한 줄로 남긴다.
- 성공 시 요약 1줄(`inventory-ok routes=39 ...`)을 stdout에 쓰고 exit 0.
- `scripts/**`는 eslint ignore 대상이므로 인자 가드는 직접 짠다. 값 플래그가 필요하면 기존 `scripts/lib/cliArgs.mjs`의 `flagValue`를 쓴다(새 파서 금지).

## Acceptance Criteria

```bash
node scripts/contract-inventory-check.mjs
node -e "const j=require('./docs/api-contract/endpoints.json');const m={};for(const r of j.routes)m[r.method]=(m[r.method]||0)+1;console.log(j.routes.length, JSON.stringify(m), new Set(j.routes.map(r=>r.id)).size)"
npm test
npm run lint
git status --porcelain
```

기대: 첫 커맨드 exit 0 · 두 번째가 `39 {"GET":16,"POST":19,"PUT":3,"DELETE":1} 39` 출력 · `npm test`는 **1327/1327 그대로**(기준선 무변) · lint clean.

## 검증 절차

1. 인벤토리를 손으로 채우기 전에 `server/index.js`의 라우트 등록을 순서대로 훑어 39행을 만든다. 계획서 부록 A와 대조하되 **코드가 정본**이다(부록 A와 다르면 코드 쪽을 채택하고 차이를 요약에 기록).
2. F의 드리프트 검사를 **일부러 깨뜨려** 게이트가 산다는 것을 증명한다(변이 2종, 각각 원복 후 재확인):
   - (a) `endpoints.json`에서 1행을 지운다 → 검사가 "인벤토리에 없는 라우트" 1건을 출력하고 exit 1.
   - (b) 1행의 `path`를 오타로 바꾼다 → 양방향 차이 2건(한쪽 누락 + 한쪽 잉여)을 출력하고 exit 1.
3. `reason-tokens.md`의 토큰 문자열을 코드와 1:1 대조한다. 대조 방법을 요약에 남겨라(예: 코드에서 추출한 목록과 문서 표의 목록을 정렬해 비교한 결과).
4. AC 전부 실행. `npm test` 결과가 1327에서 변하면 즉시 멈추고 원인을 조사한다(이 step은 test/**를 건드리지 않으므로 변할 이유가 없다).
5. `git status --porcelain` 증분이 소유 파일(`docs/api-contract/README.md`·`endpoints.json`·`reason-tokens.md`·`sse.md`·`openapi.yaml`, `scripts/contract-inventory-check.mjs`, `phases/67-port-p1-contract/index.json`)뿐인지 **시작 시점 스냅샷 대비**로 확인한다.
6. 아키텍처 체크: `server/**`·`src/**`·`web/**`·`client/**`·`test/**` 무수정 · `package.json` 무수정(npm script는 step2 소유) · 새 의존성 0 · DB 접속 0.
7. `phases/67-port-p1-contract/index.json`의 step0 status를 갱신하고 summary에 실측(39행 분포·토큰 총 개수·변이 결과·코드와 부록 A의 차이)을 남긴다.

## 금지사항

- `server/**`·`src/**`를 고치지 마라. 이유: 이 phase의 명세는 코드의 스냅샷이다 — 코드를 문서에 맞추면 계약 동결이 아니라 계약 변경이 되고, 하류 68+ 전체가 잘못된 기준선 위에 올라간다.
- `docs/porting-plan-cpp-spring.md`를 고치지 마라. 이유: 계획서는 로드맵 문서이고, 실측 정본은 `docs/api-contract/`다. 숫자 정정 여부는 open_questions (b)로 리뷰에 넘긴다.
- `spikes/**`를 고치지 마라. 이유: P0 스파이크는 이미 머지된 증거물이며 이 phase의 수정 대상이 아니다.
- 인벤토리에 도달 불가능한 `expect` 태그를 넣지 마라. 이유: step12의 full 커버리지 게이트가 영원히 red가 되고, 그 red를 풀려고 억지 케이스를 만들면 계약이 아니라 허구를 동결하게 된다.
- YAML 파서 등 새 의존성을 추가하지 마라. 이유: 이 phase의 제약이 "새 런타임/개발 의존성 0"이고, 기계 게이트는 JSON 인벤토리가 담당하도록 설계했다(decisions (3)).
- 명세 문서에 실제 세션 토큰·비밀번호·기사 본문·로그 라인을 예시로 넣지 마라. 이유: LOGS.md 마스킹 규율은 문서에도 적용된다 — 예시는 `<64-hex>`·`<redacted>` 같은 placeholder로 쓴다.
- `package.json`을 건드리지 마라. 이유: npm script 신설은 step2의 소유다(두 step이 같은 파일을 만지면 증분 판정이 흐려진다).
