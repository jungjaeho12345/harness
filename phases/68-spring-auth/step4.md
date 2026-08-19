# Step 4: auth-domain

로그인 판정과 **계정 잠금 정책**, 사용자 생성·수정 서비스를 만든다. 여전히 HTTP 없는 서비스 계층이다.

## 읽어야 할 파일

- `phases/68-spring-auth/index.json` — decisions **(10)(11)(12)(13)(14)** · forward_notes (6)
- `src/services/userService.js` — **이식 원본**(115행). `SAFE_FIELDS` 6키, `LOCKOUT_THRESHOLD=5`·`LOCKOUT_DURATION_MS=15분`, 판정 순서(비활성 → 잠금 → 자격), 존재하지 않는 사용자도 더미 해시로 bcrypt 1회 비교(타이밍 완화), 실패 누적·성공 시 리셋, `create`/`update`의 해시 처리
- `contract/cases/auth-negative/login-negative.contract.js` — 이 축이 어떻게 검증되는지: `invalid-credentials` 401(**존재/미존재 계정이 같은 응답** = 사용자 열거 방지) · 임계값 5회 실패 후 **올바른 비밀번호로도 423 `locked`**
- `contract/cases/default/session-guard.contract.js` — 픽스처 계정 생성(`POST /api/users`)과 강등·비활성화(`PUT /api/users/:id`)가 이 서비스의 `create`/`update`를 탄다
- `docs/api-contract/reason-tokens.md` — `invalid-credentials`(401) · `inactive`(403) · `locked`(**로그인 라우트 로컬 매핑 423**) · `unauthenticated`(401)
- `docs/api-contract/README.md` — "결함 후보" 절 **#1·#2**(이 step이 처분을 실행한다 — decisions (12))
- `docs/api-contract/openapi.yaml` — `usersCreate`·`usersUpdate` 오퍼레이션(응답 shape·결함 후보 라벨)
- `src/models/userModel.js` + step2의 리포지토리 — 잠금 컬럼 4종의 저장 표현

## 배경 (동결된 계약 사실)

- **판정 순서가 계약이다**: `active='N'` → `inactive` / 잠금 중 → `locked`(올바른 비밀번호여도) / 그 외 자격 불일치 → `invalid-credentials`. 잠긴 계정에도 bcrypt 비교를 1회 수행해 경로 간 소요시간 차이를 줄인다.
- **사용자 열거 방지**: 미존재 계정과 비밀번호 불일치가 **완전히 같은 401 본문**이어야 한다(계약 케이스가 두 응답의 동일성을 단언한다).
- **잠금 임계·기간**: 5회 / 15분. 잠금 설정·해제는 **컬럼 UPDATE**로만 한다(행 삭제 없음).
- **잠금 컬럼 표현**(decisions (11)): `failedLoginCount`는 문자열 정수, `lockedUntil`·`lastFailedLoginAt`은 **epoch ms 문자열**, 성공 시 `'0'` + NULL 리셋.
- **응답 투영 6키**(`userId, name, role, department, departmentCode, active`) — 비밀번호·잠금 메타는 절대 나가지 않는다.
- **결함 후보 재현(decisions (12))**: `create`는 **입력 검증을 하지 않는다** — 비밀번호가 없으면 빈 문자열을 해시하고, `role` 값도 검증하지 않는다. 이것이 현재의 동결된 계약이며 phase 69의 `contract/cases/default/users.contract.js`가 그대로 단언한다. **여기서 고치지 마라**(금지사항 참조).
- `update`는 영향 행 수를 그대로 돌려준다(없는 id도 성공 + `changes: 0`).

## 작업

### A. pom 의존성

`org.springframework.security:spring-security-crypto`를 추가한다(`BCryptPasswordEncoder`만 쓴다 — starter-security 금지). `~/.m2`에 캐시가 있다.

### B. `service` 패키지 — 사용자 서비스

- `login(userId, password)` → 결과 객체: 성공이면 6키 투영 사용자, 실패면 사유 토큰(`inactive`·`locked`·`invalid-credentials`) 중 하나. **HTTP 상태는 여기서 정하지 않는다**(step5의 매핑 표 책임).
- 타이밍 완화: 사용자 부재·잠금 상황에서도 bcrypt 비교를 1회 수행한다(더미 해시 상수 1개를 서비스 초기화 시 생성).
- 실패 누적/잠금 설정/성공 시 리셋을 리포지토리 UPDATE로 수행한다.
- `create(dto)` → 비밀번호를 bcrypt(cost 10)로 해시해 저장, `active` 미지정이면 `'Y'`, 반환은 6키 투영(요청에 없던 키는 담기지 않는다 — Node의 `sanitize`가 정의된 필드만 싣는 동작을 그대로 따른다). **검증 없음**.
- `update(userId, fields)` → `password`가 오면 해시로 치환, 나머지는 그대로 패치, `{changes}` 반환.
- 임계값·잠금 기간은 **상수 1곳**(설정으로 덮지 않는다 — 계약값이다).

### C. 테스트(먼저 쓴다 — 고정 시계 + step2의 임시 DB 리포지토리)

1. 성공 로그인: 6키 투영, **비밀번호·잠금 컬럼 키 부재**.
2. `inactive`가 잠금·자격보다 우선(비활성 계정은 실패 카운트가 올라가지 않는다).
3. 실패 4회까지는 `invalid-credentials`이고 카운터가 정확히 누적된다(컬럼 값을 읽어 확인).
4. 5회째 실패에서 잠금이 설정되고, 그 다음 시도는 **올바른 비밀번호여도** `locked`.
5. 잠금 기간 경과 후(시계 전진) 올바른 비밀번호로 성공하고 카운터가 `'0'`·NULL로 리셋된다.
6. 미존재 계정과 비밀번호 불일치의 결과가 **동일한 사유 토큰**이다.
7. `create`: 비밀번호 없이 만들어도 성공하고, 그 계정으로 **빈 비밀번호 로그인이 성공**한다(결함 후보 #2의 재현을 테스트로 **명시 고정**하고, 테스트 이름·주석에 "현행 계약의 재현이며 수정은 별도 판단(decisions (12))"임을 적는다). `role`에 정의 밖 값을 넣어도 저장된다.
8. `update`: 없는 id → `changes 0` · 비밀번호 패치 시 해시가 바뀌고 평문이 저장되지 않는다.

**bcryptjs 해시 호환**은 Java 테스트에서 하드코딩 해시로 검증하지 마라(비밀 표기 규율) — 그 호환은 step5의 계약 실행(하네스가 Node `seedUsers`로 시드한 DB에 로그인 성공)이 실증한다.

## Acceptance Criteria

```bash
cd /d/agents/harness/server-spring && JAVA_HOME="D:/agents/tools/jdk-21.0.12+8" ./mvnw -B -q verify
cd /d/agents/harness/server-spring && JAVA_HOME="D:/agents/tools/jdk-21.0.12+8" ./mvnw -B -q package -DskipTests
cd /d/agents/harness && node scripts/spring-contract.mjs --boot-check --profile auth-negative --profile prod-cookie
cd /d/agents/harness && npm test
cd /d/agents/harness && git status --porcelain
```

## 검증 절차

1. red 먼저(C의 8개). 요약에 red 관측을 남긴다.
2. **변이 실증 3종**(확인 후 원복): (a) 판정 순서를 자격 → 잠금으로 뒤집으면 테스트 4가 red인가, (b) 미존재 계정에서 bcrypt 비교를 건너뛰면 테스트 6이 여전히 green인가(= **타이밍 축은 테스트로 잡히지 않는다**는 사실을 요약에 정직하게 기록한다 — 계약도 이 축을 동결하지 않는다), (c) 잠금 리셋을 누락하면 테스트 5가 red인가.
3. 잠금 컬럼의 **저장 표현**을 DB에서 직접 읽어 문자열 정수/epoch ms 문자열/NULL인지 확인하고 요약에 적는다(decisions (11) 준수 실증).
4. `git status --porcelain` 증분 = `server-spring/pom.xml` · `server-spring/src/main/**` · `server-spring/src/test/**` · `phases/68-spring-auth/index.json`.
5. index.json step4 status·summary 갱신(결함 후보 #2 재현을 명시).

## 금지사항

- `create`에 입력 검증(빈 비밀번호 거부·role enum 검증)을 추가하지 마라. 이유: decisions (12) — 지금 Spring만 고치면 phase 69가 실행할 `contract/cases/default/users.contract.js`(정의 밖 role 200을 동결)가 red가 되고, **"이식 결함"과 "의도된 계약 변경"이 구분되지 않는다**. 고치는 시점은 Node·Spring·명세·케이스를 한 번에 바꾸는 별도 판단이다.
- 중복 `userId` 생성에 4xx를 만들지 마라. 이유: 현행 계약은 PK 제약 위반이 전역 에러 핸들러로 흘러 **500 `internal-error`**다(결함 후보 #1). 이것도 재현 대상이며, step5의 전역 예외 핸들러가 자연히 만들어 준다.
- 비밀번호(평문·해시)·잠금 메타를 반환값·로그·예외 메시지에 넣지 마라. 이유: 응답 투영 6키가 계약이고, 잠금 메타는 계정 열거 단서다.
- 잠금 해제를 행 삭제로 구현하지 마라(UPDATE로만). 이유: DB 비파괴 최상위 규칙.
- 임계값·잠금 기간을 환경변수·설정으로 노출하지 마라. 이유: 계약값이다 — 설정으로 흔들리면 계약 스위트가 환경에 따라 다른 판정을 낸다.
- `System.currentTimeMillis()`를 직접 부르지 마라(주입 `Clock`만). 이유: 잠금 만료 테스트가 실제 15분을 기다려야 하는 순간 그 축은 영원히 검증되지 않는다.
- 로그인 실패 로그에 비밀번호를 남기지 마라(userId·사유 토큰까지만 — Node 동형). 이유: LOGS.md 마스킹 규율.
- HTTP·필터 코드를 이 step에서 쓰지 마라.
