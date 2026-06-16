# Step 2: lockout-service

## 읽어야 할 파일

먼저 아래 파일들을 읽고 프로젝트의 아키텍처와 설계 의도를 파악하라:

- `/docs/ADR.md` — ADR-004(신뢰 경계는 서버), ADR-006(services 계층에 비즈니스 로직)
- `/docs/PRD.md` — 핵심 기능 1(로그인/세션: bcrypt, active='N' 차단) + "MVP 제외 사항"의 계정 잠금 후속 과제
- `/docs/SCHEMA.md` — User Table(active, 잠금 추적 컬럼)
- `src/services/userService.js` — 현재 `login`/`query`/`create`/`update`. 특히 `login`의 흐름(findById → bcrypt.compare → active 검사 → sanitize), `SAFE_FIELDS`, `DUMMY_HASH` 타이밍 완화.
- `src/models/userModel.js` — step 1에서 `COLUMNS`에 잠금 컬럼이 추가됨. `findById`(raw row, 잠금 컬럼 포함)·`update(userId, fields)`.
- `src/db/schema.js` — step 0의 잠금 컬럼 정의(`failedLoginCount` 기본 '0', `lockedUntil`, `lastFailedLoginAt`)
- `test/userService.test.js` — 기존 userService 테스트(주입형 가짜 userModel 또는 in-memory db 패턴 확인)
- `test/server.test.js` — 로그인 경로를 거치는 통합 테스트(회귀 주의 대상)

step 0(컬럼)·step 1(model 화이트리스트) summary를 확인한 뒤 작업하라.

## 작업

로그인 실패 누적 시 계정을 **일시 잠금**하는 로직을 userService에 추가한다. 비즈니스 규칙(임계치·해제 방식)은 여기(service)에만 둔다. **신뢰 경계는 서버**(ADR-004) — 잠금 판정은 서버 세션/DB 기준으로만 한다. TDD: 실패 테스트 먼저.

1. `src/services/userService.js` — `createUserService`에 시계와 잠금 정책을 **주입 가능**하게 한다(테스트 결정성: `Date.now()` 직접 호출 금지, sessionService 패턴과 동일):
   - 시그니처 확장: `createUserService({ userModel, now = () => Date.now(), maxFailedAttempts = 5, lockDurationMs = 15 * 60 * 1000 })`.
   - 정책(기본값): 실패 **5회 누적** 시 **15분** 잠금. 잠금 해제는 `lockedUntil` 시각 경과로 자동(시간 경과 해제) — **관리자 수동 해제는 이 step 범위 밖**(컬럼은 이미 있으니 후속 가능).
2. `login(userId, password)` 흐름을 아래로 갱신한다(반환 shape은 기존과 호환 유지 — `{ ok, reason }` / `{ ok, user }`):
   - findById로 raw row 조회. **사용자 부재 시에도** 기존처럼 `DUMMY_HASH`로 bcrypt 비교를 1회 수행(타이밍 완화 유지). 부재면 `{ ok:false, reason:'invalid-credentials' }`.
   - **잠금 우선 검사**: `lockedUntil`이 있고 `now() < lockedUntil(파싱)`이면 비밀번호 검증 결과와 무관하게 `{ ok:false, reason:'locked' }`를 반환한다(잠금 중에는 카운터를 더 올리지 않아도 된다 — 구현 재량, 단 잠금 연장으로 사용자를 영구 잠그지 말 것).
   - 비밀번호 불일치(passwordOk=false): `failedLoginCount`를 1 증가시키고 `lastFailedLoginAt`을 `now()` ISO 문자열로 기록한다. 증가 결과가 `maxFailedAttempts` 이상이면 `lockedUntil = now() + lockDurationMs`(ISO 문자열)로 잠근다. `userModel.update(userId, {...})`로 영속. 반환 `{ ok:false, reason:'invalid-credentials' }` (또는 방금 잠겼다면 `'locked'` — 어느 쪽이든 비밀번호를 노출하지 않으면 됨; 일관된 하나를 골라 테스트로 고정).
   - `active === 'N'`: 기존대로 `{ ok:false, reason:'inactive' }` (잠금보다 먼저 둘지 뒤에 둘지는 재량이나, inactive 계정에 잠금 카운터를 쌓지 않도록 순서를 정하고 테스트로 고정).
   - **로그인 성공 시**: `failedLoginCount`를 '0'으로 리셋하고 `lockedUntil`을 비운다(`null` 또는 빈 문자열). 그 후 `{ ok:true, user: sanitize(row) }`.
   - `lockedUntil`/`failedLoginCount`/`lastFailedLoginAt`은 **절대 sanitize 응답(SAFE_FIELDS)에 포함하지 않는다** — 잠금 메타는 클라이언트로 새지 않는다.
3. `src/controllers/index.js`의 `createControllers`는 `createUserService({ userModel })`를 호출한다. 잠금 정책/시계 주입 지점을 확인하고, **운영 기본값으로 동작하도록** 한다(추가 인자 없이도 위 기본 정책이 적용되게). 시계 주입이 필요하면 controllers 시그니처를 깨지 않는 선에서 옵션으로만 전달(기존 호출부 호환 유지).
4. 테스트:
   - `test/userService.test.js`: 주입 시계로 5회 실패 → 6번째 시도가 `reason:'locked'`인지, `lockDurationMs` 경과 후 정상 로그인 시 `failedLoginCount` 리셋되는지, 성공 로그인이 카운터/lockedUntil을 비우는지, 잠금 메타가 user 응답에 없는지, `inactive`/`invalid-credentials` 기존 동작이 유지되는지.
   - `test/server.test.js`: 잠금 관련 통합 1~2건(예: 잘못된 비밀번호 반복 → 401 `locked`)을 보강하되, **기존 로그인 성공/실패 테스트가 깨지지 않게** 한다(임계치 5회 미만에서는 기존과 동일하게 `invalid-credentials`).

## Acceptance Criteria

```bash
npm run lint
npm run build
npm test
```

## 검증 절차

1. 위 AC 커맨드를 실행한다.
2. 아키텍처 체크리스트를 확인한다:
   - 잠금 판정 로직이 service에만 있는가(model/transport에 새지 않았는가)?
   - 시계가 주입형인가(`Date.now()` 직접 호출 없음, sessionService와 동일 패턴)?
   - 잠금 메타(`lockedUntil` 등)가 sanitize 응답에서 제외되는가?
   - DB 비파괴 — 잠금/리셋이 `update`(additive)로만 처리되고 행 삭제가 없는가?
3. 결과에 따라 `phases/1-security/index.json`의 step 2를 업데이트한다:
   - 성공 → `"status": "completed"`, `"summary"`에 정책(5회/15분), 잠금 시 reason, 시계 주입 지점, 성공 시 리셋을 기록.
   - 실패/blocked → 절차 동일.

## 금지사항

- 잠금 임계치/지속시간을 하드코딩으로만 박지 마라(주입 가능하게 + 기본값). 이유: 테스트 결정성과 정책 조정 여지.
- `Date.now()`를 직접 호출하지 마라. 이유: 테스트가 시계를 주입해 만료/잠금 경계를 결정적으로 검증한다(sessionService 패턴).
- `lockedUntil`/`failedLoginCount`/`lastFailedLoginAt`을 로그인 응답·사용자 목록에 노출하지 마라. 이유: 잠금 메타 유출은 계정 열거(enumeration)에 악용될 수 있다.
- 비밀번호(해시 포함)를 어떤 반환값에도 넣지 마라. 이유: news.md 보안 — password 미노출.
- 사용자 행을 삭제하거나 active를 잠금 용도로 덮어쓰지 마라. 이유: DB 비파괴 + active는 별도 의미(관리자 비활성화).
- 기존 테스트(server.test.js의 로그인 성공/실패 포함)를 깨뜨리지 마라.
