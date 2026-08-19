# Step 4: auth-endpoints

## 목표
인증 3라우트 컨트롤러 + 로그인 정책을 구현한다: `POST /api/login`, `POST /api/logout`, `GET /api/session`. 정책: 자격 검증(bcrypt·사용자 열거 방지 401), **계정잠금 423**(5회/15분), **IP 레이트리밋 429**(10회/15분). 이 step 완료 시 계약 4파일(`health`·`auth`·`login-negative`·`cookie-prod`)이 Node와 **diff 0**으로 green이 된다(session-guard는 step5 지원 라우트 필요).

## 계약 상세 (실측 — 정본은 케이스 파일과 `docs/api-contract/reason-tokens.md`)
- `GET /api/session`: 세션 가드 통과 시 200 `{"ok":true,"user":{...}}` — user 키 **정확 5개** `userId·name·role·department·departmentCode`(active 없음, password 없음). 미인증 401 `{"ok":false,"reason":"unauthenticated"}`(**401에도 JSON 바디 필수**). 신원은 로그인 스냅샷이 아니라 DB 최신값(step3 가드).
- `POST /api/login` 성공: 200 `{"ok":true,"sessionId":"<64-hex>","user":{...}}` — user 키 **정확 6개**(위 5 + `active`). Set-Cookie로 `sid`(step3 쿠키 writer). 단일 세션 정책(같은 userId 이전 세션 무효화).
- `POST /api/login` 음성:
  - 자격 불일치 → 401 `{"ok":false,"reason":"invalid-credentials"}`. **사용자 열거 방지**: 존재 계정의 틀린 비밀번호와 미존재 계정이 **상태·본문 완전 동일**.
  - 계정잠금 → 5회 연속 실패 시 잠기고, 그 다음부터 **올바른 비밀번호로도** 423 `{"ok":false,"reason":"locked"}`. **잠금 판정이 자격 판정보다 먼저**다(잠긴 계정은 자격 무관 423). 임계값 5회째 실패 자체는 아직 401 invalid-credentials(잠금은 그 시도에서 설정). 근거: `LOCKOUT_THRESHOLD=5`, 15분 창.
  - IP 레이트리밋 → 창 안 10번째까지는 라우트가 처리하고 **11번째 요청**이 429. 429는 **미들웨어가 응답**하므로 본문이 **JSON이 아니다**(text/html) — "모든 거부는 {ok,reason}"의 **유일한 예외**이며 그 예외가 계약이다. 응답 헤더 `RateLimit-Limit: 10`. 근거: `loginLimiter { windowMs:15분, limit:10 }` IP 단위.
- `POST /api/logout`: 세션 유무와 무관하게 **항상 200 `{"ok":true}`**(멱등) + 만료 쿠키(Max-Age=0). 로그아웃 후 같은 토큰은 401.

## 상태·본문 정합(패리티 주의)
계약 리포트는 각 관측의 `status·ok·reason·bodyKeys·헤더`를 Node와 비교한다(`contract/lib/record.js`의 `fromResponse`). 따라서 성공/실패 **본문의 최상위 키 집합**과 상태코드가 Node와 정확히 일치해야 한다. 추측하지 말고 케이스 파일의 단언값을 그대로 맞춰라.

## 읽어야 할 파일
- `contract/cases/default/auth.contract.js` — session/login/logout 성공·음성·단일세션·malformed·쿠키.
- `contract/cases/auth-negative/login-negative.contract.js` — invalid-credentials 동일성·423 잠금·429 레이트리밋(헤더/비-JSON 본문 계약).
- `contract/cases/prod-cookie/cookie-prod.contract.js` — 프로덕션 쿠키(step3 writer로 충족).
- `contract/cases/default/health.contract.js` — health 계약(step0 충족, 회귀 확인용).
- `docs/api-contract/reason-tokens.md` 표1 #1·#2, 표2 #1(423 잠금이 401을 덮어씀) — 토큰·상태 정본.
- `src/services/userService.js`(`LOCKOUT_THRESHOLD`·잠금 로직)·`server/index.js`의 login 라우트·`loginLimiter`(429·헤더) — **동작 정본**(문자열 토큰·상태·헤더를 코드에서 그대로 옮겨라).
- 이전 step 산출물: `SessionStore`·`SessionGuard`·`SessionCookieWriter`(step3), `NewsDb.findUser`/`updateUser`(step2 — 잠금 카운트 쓰기), `scripts/contract-run.mjs --target spring`·`scripts/contract-parity-spring.mjs`(step1).

## 작업 (TDD — 테스트 먼저)
1. **테스트 먼저** MockMvc: session(미인증 401 JSON·유효 200 5키), login(성공 6키+쿠키·invalid 401 동일성·단일세션 이전토큰 401), logout(멱등 200·만료쿠키·이후 401). 잠금/레이트리밋은 정책 단위 테스트로도 덮되(아래) 통합 판정은 AC의 계약 스위트가 한다.
2. **테스트 먼저** 잠금 정책: 실패 카운트 누적·5회째 잠금 설정·잠긴 계정 올바른 비번도 423·성공 로그인 시 카운트/lockedUntil 리셋. 저장 위치는 구현 재량이나 **DB 컬럼(`failedLoginCount`·`lockedUntil`·`lastFailedLoginAt`) 사용을 권장**(Node와 동형, `updateUser` 화이트리스트 경유). 15분 창 경계는 `lockedUntil`/`lastFailedLoginAt` 시각 비교로.
3. **테스트 먼저** IP 레이트리밋: 같은 IP 로그인 10회 통과, 11회째 429 + `RateLimit-Limit: 10` + 비-JSON 본문. 인메모리 카운터(프로세스 로컬 — auth-negative가 전용 프로세스라 격리). 필터/인터셉터로 `POST /api/login`에만 적용.
4. 컨트롤러/정책 구현. 응답 본문은 항상 JSON(**레이트리밋 429 예외만 비-JSON**). 계층: controller→service→repository, 생성자 주입.
5. `x-session-id` 헤더/쿠키 판독은 step3 헬퍼 재사용. acting 신원은 세션에서만(요청 body의 role 불신).

## Acceptance Criteria (실행 커맨드)
```bash
# 0) 빌드/유닛
mvn -f server-spring/pom.xml -q test && mvn -f server-spring/pom.xml -q -DskipTests package
# 1) 계약 4파일이 Spring에서 green + Node와 diff 0 (프로파일마다 새 Spring 프로세스)
node scripts/contract-run.mjs --target node   --profile default      --files contract/cases/default/health.contract.js,contract/cases/default/auth.contract.js --out /tmp/n-default.json --timeout 60000
node scripts/contract-run.mjs --target spring  --profile default      --files contract/cases/default/health.contract.js,contract/cases/default/auth.contract.js --out /tmp/s-default.json --timeout 60000
node scripts/contract-diff.mjs /tmp/n-default.json /tmp/s-default.json
node scripts/contract-run.mjs --target node   --profile auth-negative --files contract/cases/auth-negative/login-negative.contract.js --out /tmp/n-authneg.json --timeout 60000
node scripts/contract-run.mjs --target spring  --profile auth-negative --files contract/cases/auth-negative/login-negative.contract.js --out /tmp/s-authneg.json --timeout 60000
node scripts/contract-diff.mjs /tmp/n-authneg.json /tmp/s-authneg.json
node scripts/contract-run.mjs --target node   --profile prod-cookie   --files contract/cases/prod-cookie/cookie-prod.contract.js --out /tmp/n-prod.json --timeout 60000
node scripts/contract-run.mjs --target spring  --profile prod-cookie   --files contract/cases/prod-cookie/cookie-prod.contract.js --out /tmp/s-prod.json --timeout 60000
node scripts/contract-diff.mjs /tmp/n-prod.json /tmp/s-prod.json
# 2) 정적 안전망
npm run lint
```
- 세 `contract-diff` 호출이 각각 `contract-diff-ok` + exit 0이어야 한다.
- 각 러너 실행이 exit 0(케이스 green) + 리포 news.db 무변이어야 한다.

## 검증 절차
- `login-negative`의 429 관측이 Node와 동일하게 `content-type: text/html`·`ratelimit-limit: 10`·`bodyKeys: []`로 기록되는지(diff 0로 확인).
- 잠금 423이 "올바른 비밀번호로도 423"까지 재현되는지(케이스 C-2) 확인.
- default 프로파일 로그인 예산(러너 3 + auth 2 = 5 ≤ 10)이 지켜져 레이트리밋에 걸리지 않는지 확인.

## 금지사항
- 레이트리밋 429를 JSON 본문으로 응답하지 마라. 이유: Node는 미들웨어가 text/html로 응답한다 — JSON이면 `bodyKeys`/`content-type` diff가 난다(계약의 유일한 비-JSON 예외).
- 자격 검증을 잠금 검증보다 먼저 하지 마라. 이유: 잠긴 계정은 올바른 비밀번호로도 423이어야 한다(판정 순서가 계약).
- invalid-credentials에서 존재/미존재 계정을 다른 상태·본문으로 응답하지 마라. 이유: 사용자 열거 취약점 — 계약이 동일성을 요구한다.
- 세션 user 응답에 `active`(session)·`password`를 싣거나 5/6키를 어기지 마라. 이유: bodyKeys diff.
- 로그인 실패 카운트/잠금 저장에 DDL이나 DELETE를 쓰지 마라. 이유: `updateUser` 화이트리스트 UPDATE만(DB 비파괴).
