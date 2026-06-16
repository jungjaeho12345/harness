# Step 3: account-lockout

## 목표
로그인 실패가 누적되면 계정을 잠근다(시도 차단). 기존 IP 단위 레이트리밋(15분/10회)과 **공존**하는 **계정(userId) 단위** 방어다. User 테이블에 **additive** 컬럼만 추가하고, 잠금/해제는 **컬럼 값 업데이트**로만 한다(행 삭제 절대 금지 — DB 비파괴). 도메인 로직은 `userService.login`(자격 검증)과 그 호출자(`controllers.auth.login`)에 둔다 — transport는 거부 reason만 매핑한다. 기존 bcrypt 비교·`active='N'` 차단·타이밍 평준화는 깨지 않는다.

## 읽어야 할 파일
- `/home/user/harness/docs/news.md` — `## 로그인 워크플로우`(129~136행): 레이트리밋 15분/10회, `active='N'` 차단, **실패 시 원인과 무관하게 같은 시간이 걸리도록**(136행 — 타이밍 평준화 유지)
- `/home/user/harness/docs/SCHEMA.md` — `## User Table`(26~32행), 스키마 변경은 **컬럼 추가(멱등)만**(10행), **행 삭제 금지**(11행). 주의: 기존 `lockYN`은 **Contents(편집 잠금)** 컬럼이다(46행) — User의 계정 잠금과 **이름이 겹치지 않게** 한다
- `/home/user/harness/docs/PRD.md` — 23행(계정 잠금이 이번 phase 대상)
- `/home/user/harness/src/db/schema.js` — `SCHEMA.User` 배열(8~16행). 여기에 additive 컬럼을 추가하면 `createSchema`가 멱등 `ALTER ADD COLUMN`으로 적용(70~85행)
- `/home/user/harness/src/services/userService.js` — `login(userId, password)`(22~31행): findById → bcrypt.compare → `{ok:false, reason:'invalid-credentials'}` / `{ok:false, reason:'inactive'}` / `{ok:true, user}`. `DUMMY_HASH` 타이밍 평준화(11행), `SAFE_FIELDS`(비밀번호 제외)
- `/home/user/harness/src/models/userModel.js` — `COLUMNS` 화이트리스트(5행), `findById`/`update`(35~41행). 새 컬럼을 읽고/쓰려면 `COLUMNS`에 추가해야 한다
- `/home/user/harness/src/controllers/index.js` — `auth.login`(44~49행): `userService.login` 성공 시 `session.createSession` → `{ ok, sessionId, user }`. **이 반환 shape 유지**
- `/home/user/harness/server/index.js` — `/api/login`(111~117행), `STATUS_BY_REASON`(현재 65행~). **주의: `locked: 409`는 이미 정의돼 있다(server/index.js:73). 새로 추가할 필요 없다** — 기존 409 계약을 유지할지 변경할지만 결정한다(아래 작업4 참조). 로그인 레이트리밋(104~109행)
- `/home/user/harness/src/services/sessionService.js` — `now` 주입 패턴(19행). 잠금 만료(lockedUntil) 판정도 **주입된 시계**로 결정적으로 한다(Date.now() 직접 호출 금지)

## 결정해야 할 사항 (구현 전 명확히, summary에 근거 기록)
- 잠금 정책 파라미터: 실패 임계치(예: 5회)와 잠금 시간(예: 15분, 또는 영구 잠금=관리자 해제). news.md에 계정 잠금 구체 수치는 없으므로 보수적 기본값(임계치 5, 잠금 15분 자동 해제)을 채택하되 **상수로 한 곳에 정의**하고 근거를 남겨라. 영구 잠금을 택하면 Z(관리자) 해제 경로가 필요하므로 범위가 커진다 — 자동 해제(시간 경과) 방식을 권장.
- 잠금/실패 상태의 신뢰 원천은 **서버 DB(User 행)** 다 — 클라이언트가 보낸 값으로 판정하지 마라(ADR-004 신뢰 경계).

## 작업 (TDD — 테스트 먼저)
1. **스키마(additive)**: `src/db/schema.js`의 `SCHEMA.User`에 컬럼을 추가한다. Contents의 `lockYN`과 혼동되지 않게 **계정 전용 이름**을 쓴다. 예:
   - `failedLoginCount` (`TEXT`, 기본 `'0'`) — 연속 실패 횟수
   - `lockedUntil` (`TEXT`) — 잠금 해제 예정 ISO-8601 UTC 시각(없으면 미잠금)
   (자동 해제 방식이면 별도 `accountLocked` 플래그 없이 `lockedUntil` 한 컬럼으로 충분하다 — 단순화. 영구 잠금을 택하면 플래그 컬럼 추가.) `createSchema`는 멱등이므로 기존 행은 기본값으로 채워지고 데이터는 보존된다.
2. **모델**: `userModel.COLUMNS`에 새 컬럼을 추가해 `findById`가 잠금 필드를 읽고, `update`가 쓰게 한다. 새 전용 메서드가 필요하면 추가(예: `recordFailure`/`resetFailures`)하되 직접 SQL 화이트리스트 패턴을 따른다(임의 컬럼 주입 차단).
3. **서비스(`userService.login`)** — 핵심 로직. 순서가 중요하다:
   - findById로 행을 가져온다(없는 사용자도 기존처럼 `DUMMY_HASH`로 bcrypt 1회 — 타이밍 평준화 유지, news.md 136행).
   - **잠금 검사**: 행이 있고 `lockedUntil`이 미래(주입 시계 기준)면 **bcrypt 비교 여부와 무관하게** `{ok:false, reason:'locked'}`를 반환한다(타이밍 평준화를 위해 잠긴 경우에도 더미/실제 bcrypt를 1회 수행하는 것을 고려 — news.md 136행 정합).
   - **`failedLoginCount` 타입 변환 규칙(CRITICAL)**: 저장은 `TEXT`지만 증가·비교는 반드시 `const n = Number(row.failedLoginCount ?? '0')`로 숫자 파싱한 뒤 `String(n + 1)`로 재저장한다. 문자열 그대로 `+ 1`을 쓰면 `'0' + 1 === '01'` 누적 버그가 난다(절대 금지). 임계치 비교도 파싱한 `n`(숫자)으로 한다.
   - 비밀번호 불일치면 위 규칙으로 `failedLoginCount`를 증가시키고, 임계치 도달 시 `lockedUntil = now + 잠금시간`을 stamp한다(모델 update). 그래도 응답 reason은 **기존과 동일하게** `invalid-credentials`로 둔다(계정 존재/잠금 임박 여부를 노출하지 않음 — 정보 누출 방지). 잠금이 이미 걸린 상태면 `locked`.
   - 비밀번호 일치 + active='Y'면: `failedLoginCount`를 0으로 리셋하고 `lockedUntil`을 비운 뒤 `{ok:true, user: sanitize(row)}`. `active='N'`이면 기존대로 `inactive`.
   - **`lockedUntil`/`failedLoginCount`는 절대 `sanitize`/응답에 포함하지 마라**(SAFE_FIELDS에 넣지 않는다 — 비밀번호와 같은 내부 필드).
   - `now`는 주입한다(서비스 생성 시 `createUserService({ userModel, now })` 형태로 옵션 추가). Date.now() 직접 호출 금지.
4. **transport**: `server/index.js`의 `STATUS_BY_REASON.locked`는 **이미 `409`로 정의돼 있다(server/index.js:73)** — 매핑을 새로 추가하지 마라. 기존 `409` 계약을 그대로 유지할지(권장: 기존 계약·테스트 보존), `423`(Locked)/`429`(Too Many Requests)로 변경할지 결정한다. **변경을 택하면, `409`에 의존하는 기존 테스트(예: `test/server.test.js`의 `forbidden-transition`/`locked` 관련 단언)와 프론트의 영향 범위를 먼저 확인하고 근거를 summary에 기록하라.** `/api/login`은 거부 reason을 그대로 매핑만 한다(로직 재구현 금지). IP 레이트리밋(15분/10회)은 **그대로 유지** — 계정 잠금과 IP 레이트리밋은 독립 방어층이다.

## 테스트 계획
- `test/userService.test.js` 보강(또는 신규 `test/account-lockout.test.js`): 가짜 시계(`now`)와 in-memory userModel 주입.
  - 연속 실패가 임계치 미만이면 매번 `invalid-credentials`이고 `failedLoginCount`가 증가한다.
  - 임계치 도달 후 다음 시도는 `locked`(올바른 비밀번호를 줘도 잠금 시간 내에는 `locked`).
  - 잠금 시간 경과 후(시계 전진)에는 올바른 비밀번호로 다시 로그인 성공하고 카운터가 리셋된다.
  - 로그인 성공 시 `failedLoginCount`가 0으로 리셋되고 `lockedUntil`이 비워진다.
  - 응답(`user`)에 `failedLoginCount`/`lockedUntil`/`password`가 **절대 포함되지 않는다**.
  - `active='N'`은 잠금 로직과 무관하게 `inactive`(기존 회귀).
  - 존재하지 않는 사용자도 더미 bcrypt 1회 수행(타이밍 평준화 회귀).
- `test/schema.test.js` 보강: 새 User 컬럼이 `createSchema` 후 존재하고, **기존 행 데이터가 보존**되며(멱등 재실행 안전), 재실행이 에러 없이 통과한다.
- `test/server.test.js` 보강: 잠긴 계정 로그인 시 매핑된 HTTP 상태(기본 유지 시 `409`, 변경을 택했다면 그 코드)와 `{ok:false, reason:'locked'}` 매핑. `409` 변경을 택했다면 기존 `409` 단언이 깨지지 않게 함께 갱신. IP 레이트리밋(15분/10회)이 여전히 동작(회귀).

## Acceptance Criteria
```bash
npm run lint
npm run build
npm test
```

## 검증 절차
1. AC 실행. 기존 `test/userService.test.js`·`test/schema.test.js`·`test/server.test.js` 무회귀 통과 확인.
2. 체크리스트: 컬럼이 additive로만 추가됐는가(DROP/DELETE 없음)? 잠금 판정이 주입 시계로 결정적인가? 잠금/실패 필드가 응답에 새지 않는가? 타이밍 평준화·`active='N'`·IP 레이트리밋이 보존되는가? acting role/세션은 변경하지 않았는가?
3. index.json의 step 3을 completed + summary(추가 컬럼명·임계치/잠금시간 상수·`locked` HTTP 코드 유지/변경 결정·자동해제 vs 영구잠금 결정 근거)로 갱신.

## 금지사항 / 불변규칙 체크리스트
- DB 행을 삭제하거나 컬럼을 DROP하지 마라. 잠금/해제는 **컬럼 값 업데이트만**. 이유: DB 비파괴 원칙(SCHEMA.md 11행).
- 새 컬럼을 Contents의 `lockYN`과 같은 이름으로 만들지 마라. 이유: 편집 잠금(Contents.lockYN)과 계정 잠금(User)은 전혀 다른 개념이라 혼동/버그를 부른다.
- 잠금/실패 카운트 필드를 응답(`user`)이나 `SAFE_FIELDS`에 노출하지 마라. 이유: 비밀번호와 동급 내부 상태이며, 계정 존재/잠금 임박 여부 노출은 정보 누출이다.
- 실패 응답 reason을 잠금 임박/계정 존재에 따라 분기 노출하지 마라(`invalid-credentials` 일관 유지, 잠금 시에만 `locked`). 이유: 사용자 열거 공격 표면.
- `Date.now()`를 서비스에서 직접 호출하지 마라. 이유: 테스트 결정성 — `now` 주입 패턴(sessionService와 일관).
- 기존 IP 레이트리밋·bcrypt 비교·타이밍 평준화·`active='N'` 차단을 제거/약화하지 마라. 이유: 회귀 방지 — 독립 방어층을 모두 보존한다.
- transport(`/api/login`)에서 잠금 로직을 재구현하지 마라. 이유: ADR-006 — 도메인 로직은 서비스에, 라우트는 매핑만.
- `failedLoginCount`(TEXT)를 문자열인 채로 `+ 1`하지 마라. 이유: `'0' + 1 === '01'`로 카운트가 깨져 잠금이 영영 트리거되지 않는다 — 반드시 `Number(...)` 파싱 후 `String(n+1)`.
- `STATUS_BY_REASON`에 `locked` 매핑을 중복 추가하지 마라. 이유: 이미 `409`로 존재한다(server/index.js:73) — 중복 키는 혼란/회귀를 부른다.
