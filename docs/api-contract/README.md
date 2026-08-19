# docs/api-contract — REST/SSE 계약 동결 명세 (포팅 P1)

C++/Spring 포팅(P1)의 척추가 되는 **실측 계약 명세** 디렉토리다. Spring 재구현(68+)은 이 명세와 계약 테스트 스위트(`contract/**`)를 패리티 기준으로 쓴다.

## 정본 관계

- **코드가 정본이다** — `server/index.js` + `src/services/**`. 이 디렉토리는 실측 스냅샷이다(2026-08-19).
- 불일치가 발견되면 **문서를 코드에 맞춘다**. 코드는 이 phase(67)에서 고치지 않는다 — 코드를 문서에 맞추면 계약 동결이 아니라 계약 변경이고, 하류 phase 전체가 잘못된 기준선 위에 올라간다.
- 계약 검증 중 서버 결함으로 보이는 것은 고치지 말고 관측 사실(무엇을·어디서·어떤 입력으로)만 기록한다 — 수정은 별도 phase의 판단이다.

## 39 라우트의 정의

- 실측: **REST 37 + SSE 2 = 39** (GET 16 / POST 19 / PUT 3 / DELETE 1). SSE 2건(`GET /api/stream` · `GET /api/logs/stream`)은 39에 **포함**이다.
- "REST 39 + SSE 2(=41)"라는 표현은 **이중 계수**다 — 계획서 부록 A의 39행 표와 코드 라우트 표가 정확히 일치한다.

## 파일 4종의 역할

| 파일 | 소비자 | 역할 |
|---|---|---|
| `endpoints.json` | **기계**(scripts/contract-inventory-check.mjs · 계약 러너의 커버리지 게이트) | 39 라우트 인벤토리 — id·method·path·인증·주 프로파일·필수 expect 태그. **이 phase 게이트의 입력** |
| `openapi.yaml` | 사람 · Spring 도구 | OpenAPI 3.1 명세(paths 34 · **오퍼레이션 39** = 인벤토리와 1:1 · schemas 27). 경로에 매달 수 없는 **교차 계약(CSRF·CORS·쿠키 2변형·로그인 레이트리밋/계정잠금·에러 shape 예외)은 최상위 `x-cross-cutting` 절**에 있다 — paths만 읽으면 놓친다 |
| `reason-tokens.md` | 사람 | 사유 토큰 → HTTP 상태 실측표(전역 22종 + 라우트 로컬 + 서비스 계층 유출 — 합집합 39종) |
| `sse.md` | 사람 | SSE 프레임 바이트 계약(헤더·프레임 문법·이벤트 4종·replay·peek 재검증) |

**갱신 규율**: 라우트가 늘면 `endpoints.json` → `openapi.yaml` → 계약 케이스(contract/cases) 순으로 갱신한다. 드리프트는 `node scripts/contract-inventory-check.mjs`가 기계 판정한다(라우트 표 양방향 비교 + 인벤토리 자체 검증 + **인벤토리 ↔ YAML 오퍼레이션 1:1 양방향 대조** — 마지막 항목은 `--require-spec-paths`에서 실패로 승격된다). **이 게이트는 `npm test`가 자동 실행한다**(`test/contract-inventory-gate.test.js` — spawn 1건, 서버 기동 없음). 수동 실행은 그대로 유효하다.

- **인벤토리 자체 검증에는 `expect` 최소 규칙이 있다**(게이트 입력을 약화시키는 편집을 red로 만든다): ① `auth`가 `public`이 아니면 `expect`에 `unauthenticated`가 있어야 한다 ② 역할 게이트 라우트(`auth: admin`, 그리고 `roles`가 R/D/Z 전부는 아닌 `auth: session-role`)는 `expect`에 `forbidden`이 있어야 한다. `roles`가 R·D·Z 전부인 3행(`articles-create`·`articles-action`·`articles-derive`)은 ②에서 **제외**한다 — 정상 사용자 role이 전부 허용이라 403(`unknown-role`)에 도달할 HTTP 경로가 없다(아래 "미검증·미동결 목록").

- 표기 규약: 인벤토리는 Express 실측 표기(`/api/articles/:id`), OpenAPI는 표준 템플릿 표기(`/api/articles/{id}`)다. 검사기가 **두 표기를 정규화해** 비교하므로 YAML 주석에 콜론 표기를 심어 두는 우회는 필요 없다(그 우회는 주석이 사라지는 순간 무너진다 — 실제로 발생했다). 경로 파라미터가 있는 path 항목에는 실측 경로를 `x-express-path`로 병기한다(사람·도구용 대조 정보이며 게이트의 입력은 아니다).

## 측정 조건 (= 계약 스위트의 기본 프로파일 전제)

- `SPA_DIR` 미설정(정적 서빙 off) · 외부 API 키(GOOGLE_*·YOUTUBE_*) 미설정 · `.env` 미로드(`node server/index.js` 직접 spawn) · `NODE_ENV` 미설정(prod-cookie 프로파일만 예외) · `RCV_SPOOL_DIR` 미설정(FTP watcher off).
- 이 조건 밖의 동작 — SPA 폴백(phase 60), 실 외부 API 호출, 프로덕션 HTTPS 강제(308)·HSTS — 은 **이 명세의 범위가 아니다**.

## 코드 ↔ 스펙 문서 차이 (실측 드리프트 원장 — 발견 시 append)

처분은 전 항목 **"코드가 정본"**이다. 1~5는 **바깥 문서·코드 주석의 오차**이며 그 파일들은 고치지 않는다(계획서·news.md는 phase 67 open_questions (b), 서버 주석은 서버 코드 무수정 규율). 6~8은 **이 디렉토리 자체의 오차**라 실측에 맞춰 정정했고, 무엇을 왜 고쳤는지 남긴다.

1. **`docs/porting-plan-cpp-spring.md` §6.1·§9 "사유 토큰 21종"** ↔ 실측: 전역 `STATUS_BY_REASON`은 **22종**이고, 그 밖에 라우트 로컬 매핑(로그인 locked 423, 업로드 400 2종, 사진 400, 재전송 500 3종, 수집 503, CSRF 403, 에러 핸들러 500)과 서비스 계층 유출 토큰이 더 있다 — HTTP로 관측 가능한 토큰 합집합은 **39종**(reason-tokens.md).
2. **`docs/porting-plan-cpp-spring.md` 부록 A #19 "필터 15키"** ↔ 실측: `GET /api/articles`의 `FILTER_KEYS` 화이트리스트는 **13키**다(`articleId, author, sender, status, excludeStatus, department, departments, createdAtFrom, createdAtTo, sentAtFrom, sentAtTo, distributedAtFrom, distributedAtTo`).
3. **`server/index.js` 로그인 라우트 주석(629행) "`STATUS_BY_REASON.locked`(409, 기사 편집 잠금)"** ↔ 실측: 전역 매핑의 `locked`는 **401**이다(`server/index.js` 330행). 기사 편집 잠금 충돌은 409·423이 아니라 **401 `locked`**이며 계약 케이스(step5)와 기존 backend 테스트가 401을 단언한다. 주석만 틀렸고 코드·계약은 401이다 — 이식 시 409로 옮기면 클라이언트의 잠금 처리가 조용히 깨진다.
4. **`server/index.js` derive 라우트 주석(899행) "부서 등 나머지 공통정보는 서비스가 원본에서 복사"** ↔ 실측: `articleService`의 복사 목록은 `coAuthor·category·region·attribute·keyword·internalComment·externalComment·attachmentFile·referenceFile` 9키이고 **`department`·`departmentCode`는 복사되지 않아 파생 기사에서 null**이다(step6 실측). 주석이 아니라 복사 목록이 계약이다.
5. **`docs/news.md` 전이표 대비 차이 2건**(step6) — DES발 2칸(EPS/DPS 승격)이 news.md에 명시돼 있지 않고, 마커 검사와 전이 판정의 **가드 순서**가 규정돼 있지 않다. 실측(전이 판정이 마커 검사보다 먼저)을 정본으로 채택했고 news.md는 고치지 않는다.

**이 디렉토리 자체의 실측 오차 — step12에서 정정한 것**(기록을 남기는 이유: 같은 실수를 Spring 명세에 옮기지 않기 위해서다):

6. **`endpoints.json`의 `session` 행 notes가 user 6키(`active` 포함)로 적혀 있었다** ↔ 실측: `GET /api/session`의 user는 **정확히 5키**(`userId, name, role, department, departmentCode`)다. **로그인 응답(`POST /api/login`)의 user는 6키(`active` 포함)**라 두 라우트의 user shape이 다르다 — 같은 DTO로 묶으면 어긋난다. notes를 5키로 정정했다.
7. **`openapi.yaml`의 `ContentsRow`에 `category` 프로퍼티가 없었다** ↔ 실측: `category`는 Contents 실컬럼(`src/db/schema.js`)이고 응답 투영 27키에 포함되며 파생(derive)이 복사하는 9키 중 하나다. 스키마에 추가했다(투영 27키 = Contents 29컬럼 − `lockerSessionId`·`lockerClientId`).
8. **`sse.md`의 응답 헤더 예시가 `Content-Type: text/event-stream`(charset 없음)이었다** ↔ 실측: 두 스트림 모두 **`text/event-stream; charset=utf-8`**이다(계약 리포트 관측값). 예시를 실측으로 정정했다.

## 결함 후보 — 동결하되 **고칠 대상** (서버 코드 무수정 원장)

이 절의 항목은 계약으로 **동결돼 있지만 "옳다"고 승인된 것이 아니다.** phase 67은 서버 코드를 고치지 않는다(정본 관계 절) — 그래서 결함으로 보이는 실측도 명세·케이스에 그대로 들어가 있다. 68+ Spring 이식은 항목마다 둘 중 하나를 **의식적으로** 골라야 한다: (a) 실측 그대로 재현해 패리티를 맞춘 뒤 Node·Spring을 함께 고친다, (b) Spring에서 먼저 고치고 그 차이를 **의도된 계약 변경**으로 기록한다(그러면 계약 스위트가 그 지점에서 red가 나는 것이 정상이다). 라벨 없이 스펙만 베끼면 결함이 그대로 요구사항이 된다 — 이 절이 그것을 막는다.

| # | 무엇 | 어디(코드) | 어떻게 관측했나 | 왜 그대로 두면 위험한가 | 명세 라벨 |
|---|---|---|---|---|---|
| 1 | **중복 userId가 4xx가 아니라 500 `internal-error`** | `POST /api/users` — PK 제약 위반 예외가 전역 에러 핸들러로 흐른다 | 같은 userId로 두 번 생성 → `500 {ok:false, reason:'internal-error'}` (contract/cases/default/users.contract.js) | 클라이언트 입력 오류가 서버 장애로 보고된다(재시도·알림·모니터링 정책이 오작동). 계약 케이스는 이 관측을 tag `server-error`로 기록한다 — `conflict`로 적으면 존재하지 않는 409 계약이 커버리지에서 충족된 것처럼 보인다 | `openapi.yaml` usersCreate(description·500) |
| 2 | **빈 비밀번호 허용 + role 무검증** | `src/services/userService.js` `create` — `bcrypt.hashSync(String(password ?? ''), 10)`, role 값 검증 없음(라우트도 없음) | `POST /api/users {userId, role:'X', active:'N'}` → 200이고 응답 `user.role === 'X'` · password 생략도 200 | 빈 비밀번호가 **유효 자격증명**이 되고, 정의 밖 role 계정은 모든 role 게이트에서 403이라 **복구 불가 사용자**로 남는다(DB 비파괴 원칙상 행을 지울 수도 없다) | `openapi.yaml` usersCreate(description·role·password) |
| 3 | **시크릿이 필터 키로 받아들여진다(값 확인 오라클)** | `src/models/receiverConfigModel.js` `FILTERABLE`에 `password`·`apiKey` 포함 | `GET /api/receiver-config?password=<추측값>` — 응답 투영(SAFE_FIELDS 10키)은 값을 감추지만 **필터가 값을 되묻는다** | 응답에서 감춘 시크릿을 질의로 한 글자씩 확인할 수 있다(Z 전용이라 범위는 제한적이나, 같은 파일 주석의 "시크릿은 쓰기 전용"과 정면으로 모순) | `openapi.yaml` receiverConfigList(200) |
| 4 | **스칼라 전용 필터 키를 반복하면 500 `internal-error`** | `GET /api/articles` — 배열이 그대로 SQL 바인딩으로 내려간다 | `?articleId=A&articleId=B`(스칼라 6키: articleId·author·sender·department·날짜) → `500 {ok:false, reason:'internal-error'}` | 400이어야 할 입력 오류가 5xx다. 관측은 `x-articles-list-repeated-scalar-key`(커버리지 집계 제외 채널)로만 기록해 정상 계약과 섞이지 않게 했다 | `openapi.yaml` articlesList(description·500) |
| 5 | **`GET /api/photos/search`가 `SELECT *` 무투영** | 사진 행 6컬럼을 그대로 싣는다 | 검색 응답 원소에 `registeredBy`가 항상 포함 | 등록자(사번/아이디)가 전 사용자에게 노출된다. 투영을 붙이면 클라이언트 표시가 달라지므로 **고칠 때 UI와 함께 판단**해야 한다 | `openapi.yaml` photosSearch(description) |

**이 절에 넣지 않은 것**(혼동 방지):

- **`GET /uploads/<32hex>.<ext>`에 세션 게이트가 없다** — 결함이 아니라 **의도된 capability URL 모델**이다(발행 HTML이 재임베드하는 이미지 — 인증을 붙이면 그 순간 발행물이 깨진다). "미검증·미동결 목록"의 *계약의 예외* 묶음에 있다. 이식 시 같은 판단을 내려야 한다.
- **코드 주석 2건의 드리프트**(server/index.js 629·899행) — 코드가 아니라 주석이 틀린 것이라 위 "코드 ↔ 스펙 문서 차이" 원장 3·4번이 소유한다.

## 계정 표기 규율

- 시드 계정은 **userId만** 적는다: `reporter`(R) · `desk`(D) · `admin`(Z).
- 비밀번호는 값 대신 **"`src/db/seed.js`의 `SAMPLE_USERS`와 동일"** 이라고만 쓴다 — 명세·리포트·로그 어디에도 비밀 값·세션 토큰 원문을 싣지 않는다(LOGS.md 마스킹 규율). 예시는 `<64-hex>`·`<redacted>` placeholder로 쓴다.

## `x-` 접두사 예약 규칙

계약 리포트의 `routeId`는 **인벤토리 id이거나 `x-` 접두사**여야 한다. `x-`는 "인벤토리에 없는 라우트에 대한 관측" 전용 채널이며(예: 존재하지 않아야 하는 `DELETE /api/distribution-targets/:id`의 404 관측) **커버리지 집계에서 제외**된다. 따라서 인벤토리 id에는 `x-` 접두사를 쓰지 않는다(contract-inventory-check가 강제).

## 동결 완료 범위 (phase 67 마감 실측 — 2026-08-19)

| 축 | 실측 |
|---|---|
| 라우트 커버리지 | **39/39**(라우트마다 선언된 필수 `expect` 태그를 전부 관측) — `npm run test:contract -- --require-full-coverage` exit 0 |
| 프로파일 | **5종**(`default`·`minimal`·`auth-negative` 필수 / `failclosed`·`prod-cookie` 선택) 전부 기동·실행, `skipped=0` |
| 케이스 | **274**(= (프로파일, caseId) 유일 조합) · node --test 기준 **204 테스트 pass / 0 fail** |
| 리포트 관측 | **313행**(정규화·마스킹 후) |
| 이중 실행 | 같은 대상 2회 실행 리포트 **diff 0**(`--dual-run` — `contract-dual-run ok passes=A:0,B:0 observations=313 diffs=0`, 두 리포트 바이트 동일 140,141B) |
| 명세 | openapi.yaml paths 34 · 오퍼레이션 39 · schemas 27 · `$ref` 27건 전부 해결 · `operationId` 유일 |
| 기존 스위트 | `npm test` **1328/1328**(51 suites). 계약 **스위트 본체**는 `npm test`에 편입하지 않는다(서버 5회 기동 비용 — open_questions (c)). 다만 **드리프트 게이트는 편입했다**: `test/contract-inventory-gate.test.js`가 `contract-inventory-check --require-spec-paths`를 spawn해 exit 0을 단언한다(파일 읽기뿐이라 서버 기동 비용이 없다) — 그래서 기준선이 1327 → **1328**이다 |

## 미검증·미동결 목록 (정직한 공백 기록)

이 명세·스위트가 **동결하지 않는** 계약. 커버리지 게이트의 대상이 아니며, 각 항목에 **왜**와 **누가 소유하는가**를 적는다. Spring 이식(68+)은 여기 있는 항목을 "검증됐다"고 가정하면 안 된다.

**도달 경로가 없어서 못 한 것**(스위트 안에서 만들 수 없는 상태)

- **`POST /api/login`의 `inactive` 403** — 시드 계정 3종은 전부 활성이고 계약 스위트는 시드 계정을 비활성화하지 않는다(그 순간 러너의 세션 준비가 무너진다). 소유: backend 테스트.
- **`POST /api/articles`·`/action`·`/derive`의 비 R/D/Z 403(`unknown-role`)** — 정상 사용자 role은 전부 R/D/Z이고, 가짜 role 계정 생성 + 로그인은 로그인 예산 규율(decisions (8))과 충돌한다. `not-dps`·`unknown-capability` 토큰도 같은 이유로 HTTP 도달 경로가 없다(매핑만 존재 — `reason-tokens.md`).
- **`POST /api/distribution/retry`의 success·409 4종(`status-changed`·`kind-changed`·`stale-cycle`·`retry-in-flight`)·500 3종** — 배부 실패 원장을 API만으로 결정적으로 만들 수 없다(수신처 CRUD가 잘못된 spoolDir를 애초에 거부한다). `#16 failures`도 **빈 목록 shape**까지만 동결했다. 소유: `test/distribution-failure-api.test.js`.
- **`POST /api/distribution/tick`의 `skipped:'in-progress'`(single-flight)·`tick-failed`** — 동시 tick을 HTTP만으로 결정적으로 만들 수 없다. 소유: backend 테스트.
- **`POST /api/collection/pull`의 success** — 실 API 소스 호출이 필요하다(egress 0 규율). `fetch-failed`·`no-active-api-source` 400 축으로만 동결.
- **`POST /api/articles/:id/translate`의 `ok:true`·`GET /api/media/search`의 실 검색 결과** — 외부 키가 설정된 서버의 동작. 키 미설정의 graceful(번역 200 `no-key` / 미디어 결정적 데모 폴백)로만 동결.
- **전이표의 `EPS`발 2칸** — 엠바고 승격(DES→EPS)은 서버 시계 의존 비동기라 HTTP만으로 결정적으로 도달할 수 없다. 소유: backend 테스트.
- **`GET /api/logs/stream`의 R 역할 403** — 로그인 예산·단일 세션 정책 때문에 D 역할로 대체 동결했다(비-Z 축은 덮였고 R 축만 미동결).

**환경·시간 축이라 못 한 것**

- **로그 다이제스트 24h 창 경계(06:00 KST 정렬)** — 서버 시계를 주입할 수 없다. 게다가 갓 기동한 서버에서 **`GET /api/logs/digest`의 `items`는 항상 빈 배열**이다(창이 항상 과거 구간이라 방금 쌓인 로그가 들어오지 않는다) — 그래서 record 5키의 shape 동결은 `/api/logs/stream`의 replay가 담당한다. 인가(Z 전용)·`{ok, items}` shape만 동결.
- **레이트리밋 15분 창 리셋 타이밍** — 실행 시간이 15분 늘어난다. 초과 시 429 + 실측 본문 형식까지만 동결.
- **업로드 5MB 정확 경계** — 경계 근처 페이로드를 매 실행 만들면 스위트가 느려진다. 정상 1건 + 여유 있게 초과한 `too-large` 1건만 동결.
- **프로덕션 HTTPS 강제(308)·HSTS** — TLS 종단 프록시 전제(`prod-cookie` 프로파일은 `FORCE_HTTPS=false`로 이 축을 끈다).
- **SPA 정적 서빙·`index.html` 폴백**(측정 조건이 `SPA_DIR` 미설정) · **FTP 스풀 수집**(`RCV_SPOOL_DIR` 미설정 — HTTP 계약이 아니다).

**계약의 예외로 기록만 한 것**(Spring이 그대로 재현해야 하는 "이상한 실측")

- **"모든 거부는 `{ok:false, reason}` JSON"의 예외 2건**: 로그인 **429**(express-rate-limit이 만드는 비-JSON 본문)와 **미정의 경로 404**(express 기본 HTML). 이 둘만 JSON이 아니다 — `x-cross-cutting.errorShapes`에 명시.
- **`GET /uploads/<32hex>.<ext>` 정적 서빙에는 세션 게이트가 없다**(미인증 200). 발행 HTML이 재임베드하는 이미지의 capability URL 모델이라 **인증을 붙이면 그 순간 발행물이 깨진다**. 39 라우트 밖이라 커버리지 대상은 아니지만 이식 시 반드시 같은 판단을 내려야 한다.
- **`GET /api/photos/search`는 `SELECT *` 무투영이라 `registeredBy`가 전 사용자에게 노출된다**(현행 계약 — 바꾸면 클라이언트 표시가 달라진다).

**도구 축**

- **OpenAPI 스키마 수준 자동 검증**(요청/응답 예시를 스키마로 실제 검증) — YAML 파서 의존성이 필요해 미도입(open_questions (a)). 자동 판정은 ① 인벤토리 ↔ 서버 라우트 표 ② 인벤토리 ↔ YAML 오퍼레이션 1:1 ③ 인벤토리 ↔ 리포트 커버리지 ④ 인벤토리 `expect` 최소 규칙(위 "갱신 규율") 4종까지다.
- **서버 라우트 표 추출의 전제** — `scripts/contract-inventory-check.mjs`는 `server/` 아래 `.js` 파일에서 `app.<method>('<path>'`(홑따옴표 리터럴) 형태만 텍스트로 긁는다. 기존 라우트가 이 형태를 벗어나면 "inventory에만 있음"으로 red가 나므로 실패 방향은 안전하지만, **새 라우트를 다른 표기(Router 분리·백틱·동적 조립)로 추가하면 양쪽 모두에서 안 보여 조용히 통과한다** — 라우팅 표기를 바꾸는 변경은 추출기를 함께 고쳐야 한다(스크립트 머리말에 같은 경고가 있다).

## openapi.yaml 파싱 확인 (1회 수동 — 자동 게이트 아님)

- **언제·무엇으로**: 2026-08-19(step12 마감 시점), **리포 밖 일회성 스크립트**에서 `js-yaml`(리포 `node_modules`에 이미 존재하는 eslint의 전이 의존)을 `createRequire`로 직접 로드해 `yaml.load()` 했다. **리포에는 아무것도 추가하지 않았다** — `package.json`·게이트·`npm run test:contract` 어디에도 YAML 파서 의존성이 없다(새 의존성 0).
- **결과**: 파싱 성공(중복 매핑 키 없음) · `openapi: 3.1.0` · paths 34 · 오퍼레이션 39(인벤토리 39와 1:1) · schemas 27 · `$ref` 27건 전부 해결 · `operationId` 중복 0 · 최상위 `x-cross-cutting` 존재 · 경로 파라미터가 있는 13개 path 전부 `x-express-path` 병기.
- **한계**: 이것은 **스냅샷 확인**이지 게이트가 아니다. 이후 이 파일을 편집하면 **다시 확인해야 한다**(자동으로 깨진 것을 알려 주지 않는다). 자동으로 남아 있는 것은 오퍼레이션 1:1 대조(`--require-spec-paths`)뿐이며, 그것은 YAML 문법이 아니라 들여쓰기 규약에 기댄 얕은 스캔이다.

## 68+ (Spring 대상) 사용법

같은 스위트를 base URL만 바꿔 돌린다 — 케이스는 서버 구현을 모른다.

```bash
# 1) 대상 서버 5 프로파일을 띄우고 base URL 맵과 자격증명을 준비한다
#    targets.json: { "default": "http://host:8080", "minimal": "...", "auth-negative": "...", ... }
#    creds.json:   { "R": {"userId":"...","password":"..."}, "D": {...}, "Z": {...} }   ← 외부 대상에서는 필수
npm run test:contract -- --base-url-map targets.json --credentials creds.json --out spring.json

# 2) 대상 서버의 자기 결정성 먼저 확인(같은 서버 2회 → diff 0이어야 한다)
npm run test:contract -- --base-url-map targets.json --credentials creds.json --dual-run

# 3) Node 리포트와 기계 비교 — 이것이 패리티 판정이다
npm run test:contract -- --out node.json --require-full-coverage
node scripts/contract-diff.mjs node.json spring.json          # 동일 → contract-diff-ok, 다르면 차이 목록 + exit 1
```

- **사전조건**: 계정 3종이 존재하고 역할이 각각 R/D/Z이며 활성이어야 한다(userId: `reporter`·`desk`·`admin`, 비밀번호는 `src/db/seed.js`의 `SAMPLE_USERS`와 동일). 계정·비밀번호가 다르면 `--credentials <file>`로 주입한다 — 케이스는 비밀번호를 하드코딩하지 않는다.
- **프로파일**: 필수 3종(`default`·`minimal`·`auth-negative`) · 선택 2종(`failclosed`·`prod-cookie`). 선택 프로파일을 제공하지 않으면 그 케이스는 리포트에 `skipped:{reason:'profile-unavailable'}`로 남고 **diff가 `skipped-vs-observed`로 잡는다**(통과로 위장되지 않는다). 기동/세션 준비가 실패한 프로파일은 `profile-boot-failed`로 남고 종합 exit는 1이다.
- **diff가 보는 것**: `(profile, routeId, tag, caseId)`로 매칭한 뒤 `status`·`ok`·`reason`·`bodyKeys`·`values`·`headers`를 비교한다. `meta.target`(node/external)은 차이로 보지 않는다. 차이 종류는 `only-in-A`/`only-in-B`/`value-mismatch(<필드>)`/`skipped-vs-observed`다.
- **리포트에 비밀은 없다** — 세션 토큰·쿠키 값·비밀번호·본문·articleId·타임스탬프·절대 경로는 기록 시점에 `<redacted>`로 마스킹된다(`contract/lib/record.js` 단일 출처). 그래서 리포트는 그대로 공유·첨부해도 된다.
- **비밀 파일 수명** — 러너가 케이스에 넘기는 `credentials.json`(외부 대상이면 **실계정 비밀번호**)과 `sessions.json`(**살아 있는 세션 토큰**)은 임시 디렉토리에 `0600`으로 쓰고 프로파일 종료 시 **항상** 지운다(실패로 보존되는 진단 디렉토리에도 남지 않는다 — 진단 가치가 0이면서 위험만 남기기 때문이다). `--credentials`로 준 원본 파일은 사용자 소유다: 리포 밖에 두고 절대 커밋하지 마라.
- **리포트 파일 수명** — `--out`을 주면 그 경로에 쓰고 지우지 않는다. 생략하면 OS 임시 디렉토리에 쓰고 **성공 + `--keep` 없음**이면 정리한다(경로는 요약에 그대로 출력된다). 실패하거나 `--keep`이면 보존한다 — 리포트를 남기려면 `--out`을 써라.
