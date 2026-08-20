# Step 8: users-admin

Z 전용 역할 게이트와 사용자 쓰기 2라우트(`POST /api/users` · `PUT /api/users/:id`)를 만든다. 이 두 라우트는 **`contract/cases/default/session-guard.contract.js`의 픽스처 수단**이다 — 그 파일이 계정을 만들고, 강등하고, 비활성화해서 **세션 가드 축**을 검증한다(step9에서 green이 된다).

이 step은 계약 파일 단독 green 지점이 없다(session-guard는 `GET /api/logs/digest`도 필요하다). 판정은 Java 와이어 테스트 + 기존 계약 파일 무회귀로 한다.

## 읽어야 할 파일

- `phases/68-spring-auth/index.json` — decisions **(8)(12)(13)** · excluded (c) · forward_notes (6)
- `contract/cases/default/session-guard.contract.js` — 이 라우트들을 **어떻게 쓰는지**: `before()`에서 Z 세션으로 계정 생성 → 그 계정으로 1회 로그인 → `PUT`으로 `{role:'R'}` 강등(응답 `{ok:true, changes:1}`) → `PUT`으로 `{active:'N'}` 비활성화(같은 응답)
- `docs/api-contract/endpoints.json` — `users-create`(auth `admin`, expect `success`·`unauthenticated`·`forbidden`, notes "입력 검증 없음") · `users-update`(notes "**존재하지 않는 id도 200 `{ok:true, changes:0}`** — not-found 없음")
- `docs/api-contract/openapi.yaml` — `usersCreate`·`usersUpdate` 오퍼레이션(요청/응답 스키마 + **결함 후보 #1·#2 라벨**)
- `docs/api-contract/README.md` "결함 후보" 절 — #1(중복 userId 500) · #2(빈 비밀번호·role 무검증)
- `src/services/authorization.js` — **이식 원본**. capability → 허용 역할 표(`manageUsers: ['Z']`), "acting role은 검증된 세션에서만 도출한다"는 CRITICAL, 미인증 `unauthenticated` / 역할 불일치 `forbidden` / 미정의 capability `unknown-capability`
- `server/index.js` 654~683행 — users 3라우트의 게이트 호출 순서와 응답 위임 — **읽기 전용 참조**
- step3(세션 가드)·step4(사용자 서비스)·step5(에러 응답·상태 매핑)·step6(경로 정책 필터) 산출물

## 배경 (동결된 계약 사실)

- **acting role은 세션에서만 도출한다.** 요청 본문의 `role`은 절대 신뢰하지 않는다(ADR-004). 그리고 role은 **매 요청 재도출**된 신원에서 읽는다(step3의 가드) — 그래서 강등된 계정의 기존 세션이 즉시 403이 된다.
- 인가 실패의 사유 토큰: 미인증 401 `unauthenticated` · Z가 아님 403 `forbidden`.
- `POST /api/users` 200 → `{ok:true, user:{...}}`(요청이 준 필드 + 기본 `active:'Y'`, **`password` 키 없음**).
- `PUT /api/users/:id` 200 → `{ok:true, changes:<영향 행 수>}`. **없는 id도 200 + `changes:0`**(404가 아니다).
- **결함 후보 재현(decisions (12))**: 입력 검증 없음(정의 밖 `role` 문자열·빈 비밀번호 허용), 중복 `userId`는 4xx가 아니라 **500 `internal-error`**(step5의 전역 예외 핸들러가 만든다).
- `GET /api/users`(목록)는 **이 phase 범위 밖**이다(excluded (c)) — 구현하지 마라.

## 작업

### A. `service` 패키지 — 인가(capability) 게이트

- capability → 허용 역할 표를 상수 1곳에 둔다. 이 phase가 쓰는 것은 `manageUsers: [Z]` 하나지만, **표 구조는 Node와 동형**으로 만든다(후속 phase가 행만 추가한다). 정의되지 않은 capability는 `unknown-capability`로 거부한다.
- 게이트 함수는 `(sessionToken, capability)` → `{ok}` 또는 `{ok:false, reason}`이며, **role은 세션 가드 조회 결과에서만** 읽는다(파라미터로 role을 받지 마라).

### B. `controller` 패키지 — users 쓰기 2라우트

- 게이트 호출 → 실패면 사유 토큰 매핑(401/403) → 성공이면 step4의 서비스에 위임 → 응답 shape 그대로.
- **입력 검증을 추가하지 않는다**(decisions (12)).
- 경로 변수(`:id`)는 URL 세그먼트 그대로 쓴다(계약 케이스가 생성한 유니크 userId를 그대로 넣는다).

### C. 경로 정책 표 갱신

step6의 경로 정책 표에서 `/api/users`(POST·PUT)가 보호 경로로 이미 잡혀 있는지 확인한다. 필터가 미인증을 401로 끊고, 인증된 요청은 컨트롤러의 역할 게이트가 403으로 끊는다(두 층이 각자 자기 사유 토큰을 낸다).

### D. 테스트(먼저 쓴다 — RANDOM_PORT + 원시 HTTP)

1. Z 세션으로 생성 → 200 + `user` 투영에 **`password` 키 없음**.
2. 비-Z 세션(R·D)으로 생성·수정 → 403 `{ok:false, reason:'forbidden'}`.
3. 미인증 생성·수정 → 401 `{ok:false, reason:'unauthenticated'}`.
4. 수정: `{role:'R'}` 패치 → `{ok:true, changes:1}`, 없는 id → `{ok:true, changes:0}`.
5. **요청 본문에 `role:'Z'`를 넣어도 인가에 영향이 없다**(비-Z 세션은 그대로 403) — 클라이언트 role 불신의 실증.
6. **강등 왕복**: Z 계정을 만들고 그 계정으로 로그인한 뒤 role을 R로 바꾸면, **같은 토큰의 다음 요청**이 403이다(step3 가드와 이 게이트의 결선 실증 — session-guard 계약의 Java 판본).
7. 중복 `userId` 생성 → **500 `{ok:false, reason:'internal-error'}`**(결함 후보 #1 재현. 테스트 이름·주석에 "현행 계약의 재현이며 수정은 별도 판단(decisions (12))"임을 적는다).
8. 정의 밖 `role` 값·비밀번호 없는 생성 → **200**(결함 후보 #2 재현. 같은 라벨 주석).

## Acceptance Criteria

```bash
cd /d/agents/harness/server-spring && JAVA_HOME="D:/agents/tools/jdk-21.0.12+8" ./mvnw -B -q verify
cd /d/agents/harness/server-spring && JAVA_HOME="D:/agents/tools/jdk-21.0.12+8" ./mvnw -B -q package -DskipTests
cd /d/agents/harness && node scripts/spring-contract.mjs --profile default --files contract/cases/default/auth.contract.js,contract/cases/default/crosscutting.contract.js,contract/cases/default/health.contract.js --parity
cd /d/agents/harness && node scripts/spring-contract.mjs --profile auth-negative
cd /d/agents/harness && node scripts/spring-contract.mjs --profile prod-cookie
cd /d/agents/harness && npm test
cd /d/agents/harness && git status --porcelain
```

- 3·4·5번은 **무회귀 확인**이다(이 step은 새 계약 파일을 green으로 만들지 않는다 — session-guard는 step9에서 완성된다).

## 검증 절차

1. red 먼저(D의 8개). 6·7·8의 red 관측을 요약에 남긴다.
2. AC 실행 후, **session-guard 계약 파일을 진단 목적으로 1회 실행**해 본다:
   `node scripts/spring-contract.mjs --profile default --files contract/cases/default/session-guard.contract.js`
   이 시점에는 `GET /api/logs/digest` 미구현 때문에 **실패하는 것이 정상**이다. 실패가 **정확히 logs-digest 케이스에서만** 나는지(users 픽스처 단계는 통과하는지) 확인하고 그 사실을 요약에 적는다 — step9의 잔여 작업 범위를 확정하는 관측이다.
3. **변이 실증 2종**(확인 후 원복): (a) 게이트가 요청 본문의 role을 읽게 만들면 테스트 5가 red인가(권한 상승 재현 — 반드시 원복), (b) 없는 id 수정에 404를 내면 테스트 4가 red인가.
4. **DB 비파괴 확인**: 이 step의 테스트·계약 실행이 만든 사용자 행은 전부 임시 DB 안이며, 리포 `news.db`는 무변이다(하네스 단언 + 눈으로 크기·mtime 확인).
5. `git status --porcelain` 증분 = `server-spring/src/main/**` · `server-spring/src/test/**` · `phases/68-spring-auth/index.json`.
6. index.json step8 status·summary 갱신(결함 후보 #1·#2 재현 명시 + 2번 진단 관측).

## 금지사항

- 입력 검증(role enum·빈 비밀번호 거부·중복 userId 409)을 추가하지 마라. 이유: decisions (12) — 현행 계약의 재현이 이 phase의 임무다. 지금 고치면 phase 69의 `users.contract.js`가 red가 되고 "이식 결함"과 "의도된 계약 변경"이 뒤섞인다. 수정은 Node·Spring·명세·케이스를 한 번에 바꾸는 별도 판단이다.
- 요청 본문·헤더의 `role`을 인가 판정에 쓰지 마라. 이유: 신뢰 경계는 서버이고 acting role은 검증된 세션에서만 도출한다(ADR-004). 이 규칙이 깨지면 누구나 Z가 된다.
- 사용자 행을 삭제하는 경로를 만들지 마라(비활성화는 `active='N'` UPDATE). 이유: DB 비파괴 최상위 규칙.
- `GET /api/users`(목록)를 구현하지 마라. 이유: 이 phase의 계약 파일이 검증하지 않는다 — 검증 없는 구현은 **패리티 착시**를 만든다(그 라우트의 Z=6키/비-Z=4키 투영은 phase 69의 `users.contract.js`가 소유한다).
- 응답에 `password`·잠금 메타(`failedLoginCount`·`lockedUntil`·`lastFailedLoginAt`)를 담지 마라. 이유: 투영 6키가 계약이고 잠금 메타는 계정 열거 단서다.
- 계약 케이스가 만든 시드 계정(`reporter`·`desk`·`admin`)의 role·active를 바꾸는 코드를 만들지 마라. 이유: 러너가 그 계정으로 전 프로파일을 돌린다 — 건드리면 그 프로파일의 모든 케이스가 무너진다.
- 로그·예외 메시지에 사용자 비밀번호를 담지 마라.
