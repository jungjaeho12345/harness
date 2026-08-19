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
| `openapi.yaml` | 사람 · Spring 도구 | OpenAPI 3.1 명세. step0은 뼈대(info·tags·securitySchemes·공통 schemas + `/api/health` 본보기)만 — paths는 step3~step11이 도메인별로 append한다 |
| `reason-tokens.md` | 사람 | 사유 토큰 → HTTP 상태 실측표(전역 22종 + 라우트 로컬 + 서비스 계층 유출 — 합집합 39종) |
| `sse.md` | 사람 | SSE 프레임 바이트 계약(헤더·프레임 문법·이벤트 4종·replay·peek 재검증) |

**갱신 규율**: 라우트가 늘면 `endpoints.json` → `openapi.yaml` → 계약 케이스(contract/cases) 순으로 갱신한다. 드리프트는 `node scripts/contract-inventory-check.mjs`가 기계 판정한다(라우트 표 양방향 비교 + 인벤토리 자체 검증 + YAML 경로 존재 — YAML 검사는 step12부터 `--require-spec-paths`로 강제).

## 측정 조건 (= 계약 스위트의 기본 프로파일 전제)

- `SPA_DIR` 미설정(정적 서빙 off) · 외부 API 키(GOOGLE_*·YOUTUBE_*) 미설정 · `.env` 미로드(`node server/index.js` 직접 spawn) · `NODE_ENV` 미설정(prod-cookie 프로파일만 예외) · `RCV_SPOOL_DIR` 미설정(FTP watcher off).
- 이 조건 밖의 동작 — SPA 폴백(phase 60), 실 외부 API 호출, 프로덕션 HTTPS 강제(308)·HSTS — 은 **이 명세의 범위가 아니다**.

## 코드 ↔ 스펙 문서 차이 (실측 드리프트 원장 — 발견 시 append)

처분은 전 항목 **"코드가 정본"**이며, 아래 스펙 문서(계획서) 파일은 고치지 않는다(phase 67 open_questions (b)).

1. **`docs/porting-plan-cpp-spring.md` §6.1·§9 "사유 토큰 21종"** ↔ 실측: 전역 `STATUS_BY_REASON`은 **22종**이고, 그 밖에 라우트 로컬 매핑(로그인 locked 423, 업로드 400 2종, 사진 400, 재전송 500 3종, 수집 503, CSRF 403, 에러 핸들러 500)과 서비스 계층 유출 토큰이 더 있다 — HTTP로 관측 가능한 토큰 합집합은 **39종**(reason-tokens.md).
2. **`docs/porting-plan-cpp-spring.md` 부록 A #19 "필터 15키"** ↔ 실측: `GET /api/articles`의 `FILTER_KEYS` 화이트리스트는 **13키**다(`articleId, author, sender, status, excludeStatus, department, departments, createdAtFrom, createdAtTo, sentAtFrom, sentAtTo, distributedAtFrom, distributedAtTo`).

## 계정 표기 규율

- 시드 계정은 **userId만** 적는다: `reporter`(R) · `desk`(D) · `admin`(Z).
- 비밀번호는 값 대신 **"`src/db/seed.js`의 `SAMPLE_USERS`와 동일"** 이라고만 쓴다 — 명세·리포트·로그 어디에도 비밀 값·세션 토큰 원문을 싣지 않는다(LOGS.md 마스킹 규율). 예시는 `<64-hex>`·`<redacted>` placeholder로 쓴다.

## `x-` 접두사 예약 규칙

계약 리포트의 `routeId`는 **인벤토리 id이거나 `x-` 접두사**여야 한다. `x-`는 "인벤토리에 없는 라우트에 대한 관측" 전용 채널이며(예: 존재하지 않아야 하는 `DELETE /api/distribution-targets/:id`의 404 관측) **커버리지 집계에서 제외**된다. 따라서 인벤토리 id에는 `x-` 접두사를 쓰지 않는다(contract-inventory-check가 강제).

## 미동결 목록 (정직한 공백 기록 — phase 67 excluded 요약)

이 명세·스위트가 **동결하지 않는** 계약. 커버리지 게이트의 대상이 아니며, 후속 phase 또는 기존 backend 테스트가 소유한다.

- **`POST /api/login`의 `inactive` 403** — 도달 경로 없음. 시드 계정 3종은 전부 활성이고, 계약 스위트는 시드 계정을 비활성화하지 않는다(그 순간 러너의 세션 준비가 무너진다).
- **`POST /api/articles`·`/action`·`/derive`의 비 R/D/Z 403** — 도달 경로 없음. 시드·정상 사용자 role은 전부 R/D/Z이고, 가짜 role 사용자 생성+로그인은 로그인 예산 규율(decisions (8))과 충돌한다.
- **`POST /api/distribution/retry`의 success·409 계열(status-changed·kind-changed·stale-cycle·retry-in-flight)·500 계열** — 배부 실패 원장을 API만으로 결정적으로 만들 수 없다(excluded (f)). 실패 행이 있는 상태의 계약은 `test/distribution-failure-api.test.js`가 소유.
- **`POST /api/collection/pull`의 success** — 실 API 소스 호출이 필요하다(egress 0 규율). `fetch-failed`·`no-active-api-source` 400 축으로만 동결.
- **`POST /api/articles/:id/translate`의 `ok:true` 성공** — 외부 번역 키 필요. 키 미설정의 graceful 200(`no-key`)로만 동결.
- **OpenAPI 스키마 수준 자동 검증** — YAML 파서 의존성이 필요해 미도입(open_questions (a)). 자동 판정은 인벤토리↔라우트 표·인벤토리↔YAML 경로 존재·인벤토리↔리포트 커버리지 3종까지.
- **SPA 정적 서빙·index.html 폴백**(excluded (d)) · **FTP 스풀 수집**(excluded (e)) · **HTTPS 강제 308·HSTS**(excluded (g)) · **레이트리밋 15분 창 리셋 타이밍**(excluded (h)) · **로그 다이제스트 24h 창 경계**(excluded (i)) · **업로드 5MB 정확 경계**(excluded (j)).
