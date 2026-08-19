# 사유 토큰 → HTTP 상태 실측표

- **정본은 코드다** (`server/index.js` + `src/services/**`). 이 표는 2026-08-19 실측 스냅샷이다.
- 거부 응답 본문은 `{ ok:false, reason:'<토큰>' }` 고정이다(추가 필드는 라우트별 — 예: 번역의 `translatedText`).
- 토큰 문자열은 코드에서 그대로 옮겼다 — 오타 1글자가 Spring 이식에서 계약 위반이 된다.
- **상태코드로 성공을 판정할 수 없다**: 200인데 `ok:false`인 응답이 존재한다(표 3의 graceful 계열 — 번역). 클라이언트(httpModel)는 상태코드를 해석하지 않고 JSON 본문의 `ok`만 읽는다.

## 표 1 — 전역 매핑 (`STATUS_BY_REASON`, server/index.js 322~352행 전수)

`fail(res, result, fallback=400)`이 이 표를 조회하고, 미정의 토큰은 fallback(기본 400)으로 떨어진다.

| # | 토큰 | 상태 | 대표 발생 라우트 | 의미 |
|---|---|---|---|---|
| 1 | `unauthenticated` | 401 | 모든 세션 게이트 라우트 · 수집 토큰 불일치(동일 본문) | 세션 없음/무효 |
| 2 | `invalid-credentials` | 401 | POST /api/login | 아이디/비밀번호 불일치 |
| 3 | `inactive` | 403 | POST /api/login(비활성 계정) · POST /api/collection/receive(비활성 소스) · POST /api/distribution/retry(비활성 수신처) | 비활성 주체 거부 |
| 4 | `forbidden` | 403 | Z 전용 게이트 전반 · role 게이트(force-unlock 등) | 권한 없음 |
| 5 | `not-holder` | 403 | PUT /api/articles/:id · POST /api/articles/:id/unlock | 편집 잠금 보유자 아님 |
| 6 | `not-dps` | 403 | **현행 HTTP 도달 경로 없음** — lock 라우트가 not-dps를 "비-DPS 기사 = 잠금 허용"으로 통과 처리한다 | DPS 기사 아님(editDps 프로브 내부 판정) |
| 7 | `not-found` | 404 | 기사·이력·수신처 다수 | 대상 없음 |
| 8 | `locked` | **401** | POST /api/articles/:id/lock(다른 보유자와 충돌) | 편집 잠금 충돌. 로그인의 계정 잠금은 라우트 로컬 423이 이 매핑을 덮어쓴다(표 2). **주의**: server/index.js 629행 주석은 이 값을 409로 언급하나 실제 코드 값은 401이다(코드 내부 주석 드리프트 — 실측·기존 테스트 모두 401). |
| 9 | `forbidden-transition` | 409 | POST /api/articles/:id/action | 전이표 밖 (status, role, action) 조합 |
| 10 | `unknown-role` | 403 | **현행 HTTP 도달 경로 없음** — action 라우트가 `ROLES` 게이트를 먼저 통과시킨다 | lifecycle의 비 R/D/Z 거부 |
| 11 | `no-end-marker` | 400 | POST /api/articles/:id/action(send) | 본문 "(끝)" 마커 없음 |
| 12 | `unknown-action` | 400 | POST /api/articles/:id/action — 단 실제 응답은 라우트 직접 400(매핑 미경유, 같은 토큰) | 정의 외 action |
| 13 | `unknown-mode` | 400 | POST /api/articles/:id/derive — 라우트 직접 400(매핑 미경유, 같은 토큰) | 정의 외 파생 mode |
| 14 | `unknown-capability` | 400 | **현행 HTTP 도달 경로 없음** — capability 이름은 전부 하드코딩(authorization 방어 가드) | 정의 외 capability |
| 15 | `unregistered` | 403 | POST /api/collection/receive · /pull | 미등록 sourceId |
| 16 | `spool-disabled` | 503 | POST /api/distribution/tick · /retry | DIST_SPOOL_DIR 미설정(배부 비활성) |
| 17 | `tick-failed` | 500 | POST /api/distribution/tick | 후보 조회 실패(서버 장애) |
| 18 | `no-failure` | 404 | POST /api/distribution/retry | 재전송할 미해소 실패 없음 |
| 19 | `status-changed` | 409 | POST /api/distribution/retry | 기사 상태가 배부 불가로 변경됨 |
| 20 | `kind-changed` | 409 | POST /api/distribution/retry | 수신처 kind가 실패 이력과 달라짐 |
| 21 | `stale-cycle` | 409 | POST /api/distribution/retry | 재송고로 새 배부 사이클이 열림 |
| 22 | `retry-in-flight` | 409 | POST /api/distribution/retry | 같은 수신처 재전송 진행 중 |

**총 22종.** (계획서 `docs/porting-plan-cpp-spring.md` §6.1의 "21종"과 다르다 — 코드가 정본이며 계획서는 고치지 않는다. README "코드 ↔ 스펙 문서 차이" 절 참조.)

## 표 2 — 라우트 로컬 매핑 (전역 매핑을 덮어쓰거나 매핑을 거치지 않고 직접 상태를 지정하는 것 전수)

| # | 위치 | 토큰 | 상태 | 비고 |
|---|---|---|---|---|
| 1 | POST /api/login | `locked` | **423** | 계정 잠금(5회 실패/15분). 전역 `locked` 401을 덮어쓴다 |
| 2 | POST /api/login | (fallback) | 401 | `fail(res, r, 401)` — 미정의 reason 방어. 실제 발생 가능 토큰은 전부 매핑돼 있어 실측 도달 없음 |
| 3 | POST /api/upload | `invalid-file` | 400 | 파일명/타입 형식 위반·화이트리스트 밖 확장자(라우트 직접) |
| 4 | POST /api/upload | `too-large` | 400 | 디코드 5MB 초과(라우트 직접) |
| 5 | POST /api/photos | `invalid-src` | 400 | photoService 판정을 라우트가 400으로 직접 매핑 |
| 6 | POST /api/distribution/retry | `spool-write-failed` | 500 | 서버측 장애 취급(라우트 직접) |
| 7 | POST /api/distribution/retry | `invalid-spool-dir` | 500 | **같은 토큰이 배부 대상 CRUD에서는 400**(표 3 #5) — 라우트에 따라 상태가 다르다 |
| 8 | POST /api/distribution/retry | `invalid-article-id` | 500 | 서버 데이터 문제 취급(라우트 직접) |
| 9 | POST /api/collection/receive · /pull | `collection-disabled` | 503 | fail-closed: 비-loopback 바인딩 + COLLECTION_TOKEN 미설정(라우트 직접) |
| 10 | POST /api/articles/:id/action | `unknown-action` | 400 | 라우트 직접(매핑 미경유). 나머지 거부는 `fail(res, r, 409)` — fallback이 400이 아니라 409다 |
| 11 | POST /api/articles/:id/derive | `unknown-mode` | 400 | 라우트 직접(매핑 미경유) |
| 12 | GET /api/articles/:id | `not-found` | 404 | 라우트 직접(getById null) |
| 13 | GET /api/articles/:id/history/:historyId | `not-found` | 404 | 비정수 historyId(라우트 직접) + `getHistorySnapshot` 실패는 reason 무관 무조건 404 |
| 14 | csrfOriginGuard(전역 미들웨어) | `forbidden-origin` | 403 | 상태 변경 메서드의 Origin/Referer allowlist 거부(ADR-009) |
| 15 | 전역 에러 핸들러 | `internal-error` | 500 | 모든 미처리 예외. **본문 파서 오류(잘못된 JSON·limit 초과)도 여기로 흘러 500이다**(별도 400/413 매핑 없음) |

**총 15행.** 표 1에 없는 신규 토큰은 9종이다: `invalid-file` · `too-large` · `invalid-src` · `spool-write-failed` · `invalid-spool-dir` · `invalid-article-id` · `collection-disabled` · `forbidden-origin` · `internal-error`.

## 표 3 — 서비스 계층 토큰의 HTTP 출구 (전역 매핑 밖 토큰 + 출구가 자명하지 않은 것)

| # | 토큰 | 발생 서비스 | 출구 라우트 | 상태 | 경로 |
|---|---|---|---|---|---|
| 1 | `invalid-name` | distributionTargetService | POST·PUT /api/distribution-targets | 400 | **fail() fallback(400) 의존** — 전역 매핑 없음 |
| 2 | `invalid-kind` | distributionTargetService | POST·PUT /api/distribution-targets | 400 | fail() fallback 의존 |
| 3 | `invalid-active` | distributionTargetService | PUT /api/distribution-targets/:id | 400 | fail() fallback 의존 |
| 4 | `duplicate-spool-dir` | distributionTargetService | POST·PUT /api/distribution-targets | 400 | fail() fallback 의존 |
| 5 | `invalid-spool-dir` | distributionTargetService · spoolWriter | targets CRUD=400(fallback) / retry=**500**(표 2 #7) | 400/500 | 같은 토큰·다른 상태 |
| 6 | `invalid-article-id` | spoolWriter | POST /api/distribution/retry | 500 | 라우트 로컬(표 2 #8) |
| 7 | `spool-write-failed` | spoolWriter | POST /api/distribution/retry | 500 | 라우트 로컬(표 2 #6). tick에서는 HTTP 상태가 아니라 200 응답의 `failed[]` 항목 reason으로만 노출된다 |
| 8 | `unregistered` | collectionService | POST /api/collection/receive · /pull | 403 | 전역 매핑(표 1 #15) |
| 9 | `inactive` | userService(로그인) · collectionService(receive) · distributionRetryService(retry) | 각 라우트 | 403 | 전역 매핑(표 1 #3) |
| 10 | `no-active-api-source` | collectionService | POST /api/collection/pull | 400 | **fail() fallback(400) 의존** — 전역 매핑 없음 |
| 11 | `fetch-failed` | collectionService | POST /api/collection/pull | 400 | **fail() fallback(400) 의존** — 전역 매핑 없음 |
| 12 | `invalid-src` | photoService | POST /api/photos | 400 | 라우트 직접(표 2 #5) |
| 13 | `no-key` | translate | POST /api/articles/:id/translate | **200** | graceful — `{ ok:false, reason:'no-key', translatedText:<원문> }`. 키 누락을 500으로 감싸지 않는다 |
| 14 | `error` | translate | POST /api/articles/:id/translate | **200** | graceful — 외부 호출/파싱 실패. 본문 shape은 #13과 동일 |
| 15 | `locked` | userService(계정 잠금) · articleService(잠금 충돌) | 로그인=423(로컬) / lock=401(전역) | 423/401 | 같은 토큰·다른 상태(표 1 #8·표 2 #1) |

**총 15행.** 표 1·표 2에 없는 신규 토큰은 8종이다: `invalid-name` · `invalid-kind` · `invalid-active` · `duplicate-spool-dir` · `no-active-api-source` · `fetch-failed` · `no-key` · `error`. 그중 **fail()의 fallback(400)에 의존하는 토큰은 6종**(`invalid-name`·`invalid-kind`·`invalid-active`·`duplicate-spool-dir`·`no-active-api-source`·`fetch-failed` — `invalid-spool-dir`의 CRUD 400 경로도 fallback 의존이다).

**합집합 총계**: 표 1(22) + 표 2 신규(9) + 표 3 신규(8) = HTTP 응답 `reason`으로 관측 가능한 토큰 **39종**.

### 부기 — 토큰을 내지 않는 실패

- **GET /api/media/search**: 외부 실패·키 누락에도 항상 `200 { ok:true, items, error }`다. reason 토큰이 없다(`error`는 불리언 플래그). 키 미설정 시 결정적 데모 폴백이며, 서비스가 만드는 `demo:true` 플래그는 라우트가 응답에 싣지 않는다(응답 키 3종 고정).
- **거부 응답의 합집합**(표 1 ∪ 표 2 ∪ 표 3)은 `openapi.yaml`의 `ErrorResponse.reason` enum과 일치해야 한다 — 현재 39종.
