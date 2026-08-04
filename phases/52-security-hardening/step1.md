# Step 1: session-revalidation

## 읽어야 할 파일

먼저 아래 파일들을 읽고 프로젝트의 아키텍처와 설계 의도를 파악하라:

- `docs/ARCHITECTURE.md` — 백엔드 계층 분리(controllers → services → models → db), 상태 관리/세션 절
- `docs/ADR.md` — ADR-004(세션 기반 서버측 인가, 1시간 슬라이딩 만료), ADR-006(계층형 도메인)
- `docs/news.md` — 세션 수명(로그아웃 전까지 유지, 활동마다 sliding 갱신), `active='N'`은 로그인 불가
- `src/services/sessionService.js` — 현재 전량(in-memory Map, `IDENTITY_FIELDS`, `identityOf`, `createSession`/`touchSession`/`invalidate`)
- `src/services/userService.js` — `SAFE_FIELDS`, 로그인의 `active === 'N'` 판정 규칙(비활성 우선 거부)
- `src/models/userModel.js` — `findById(userId)`는 비밀번호·잠금 컬럼을 포함한 raw row를 반환한다
- `src/services/authorization.js` — `sessionService.touchSession(sessionId)`을 호출하는 소비처(이 step에서는 수정하지 않는다)
- `test/sessionService.test.js` — 가짜 시계(now 주입) 테스트 패턴

## 배경 (이 step 안에서 자기완결)

2026-08-03 전수감사 발견 [high]: 세션에는 **로그인 시점의 role/active 스냅샷**이 고정된다(`sessionService.createSession`이 `identityOf(user)`를 그대로 보관). 그래서 Z가 사용자를 비활성화(`active='N'`)하거나 역할을 강등해도 그 사용자의 **기존 세션은 최대 1시간 슬라이딩으로 무한정 이전 권한을 유지**한다. 요구사항의 핵심은 "비활성 계정 즉시 차단"이다.

확정된 설계(재논의하지 마라): **매 요청 DB 재조회**. 단, `sessionService`에 `userModel`을 직접 결합하지 않는다 — 세션을 DB 없이 조립하는 기존 서비스 단위 테스트 계약을 보존해야 하기 때문이다. 대신 **같은 인터페이스를 갖는 데코레이터**(`sessionGuard`)를 신설한다. 결선(소비처 연결)은 다음 step이며, **이 step에서는 프로덕션 동작이 하나도 바뀌지 않는다**.

또한 다음 step들이 쓸 **비연장 조회**(`peekSession`)를 이 step에서 함께 만든다. SSE처럼 "연결이 살아 있는 동안 반복 확인"하는 경로가 `touchSession`을 쓰면 사용자가 아무 활동을 하지 않아도 세션이 영원히 연장돼 유휴 만료가 무력화된다.

## 작업

### 1) 착수 전 실측

```bash
npm test        # 679/679 pass 가 기준선
npm run lint
```

### 2) 테스트 먼저 (TDD — red 확인 필수)

- `test/sessionService.test.js`에 `peekSession` 케이스를 추가한다.
- `test/sessionGuard.test.js`를 신설한다. in-memory `DatabaseSync(':memory:')` + `createSchema(db)` + `createUserModel(db)`로 실제 User 행을 만들고, `createSessionService()`로 세션을 발급한 뒤 가드를 조립해 검증한다(bcrypt 로그인 경로는 불필요 — 모델에 직접 insert/update 하면 된다).

공격/보안 시나리오:

1. `active='N'`으로 바뀐 사용자의 세션 → `touchSession`이 `undefined`를 반환하고, **같은 토큰으로 재시도해도 계속 `undefined`**(세션이 스토어에서 무효화됐다). 되돌려 `active='Y'`로 바꿔도 그 토큰은 부활하지 않는다(재로그인 필요).
2. 역할 강등: 세션 발급 시 role `Z` → 행을 `R`로 update → `touchSession(sid).role === 'R'`.
3. 역할 승격: `R` → `Z`도 대칭으로 반영된다.
4. User 행이 없는 세션(다른 DB를 가리키는 등) → `undefined` + 무효화.
5. 반환 신원에 `password`·`failedLoginCount`·`lockedUntil`·`lastFailedLoginAt` 키가 **없다**.
6. `peekSession`도 1·2와 동일하게 비활성 차단·역할 재도출을 한다.
7. 캐시 금지 잠금: 유효 세션으로 `touchSession`을 3회 호출하면 `findById`가 정확히 3회 호출된다(주입한 스파이 userModel로 확인).
8. 스파이 호환 잠금: 가드 생성 **후** `sessionService.touchSession`을 다른 함수로 교체하면 가드가 그 교체본을 호출한다(생성 시점에 메서드를 구조분해로 캡처하면 red — 기존 `test/sse-auth.test.js`가 이 방식으로 라우트를 검사한다).

정상 플로우 무손상(회귀 케이스 — 반드시 포함):

9. `active='Y'`인 정상 사용자는 `touchSession`이 매번 신원을 반환하고, 슬라이딩 연장도 그대로 동작한다(가짜 시계로 59분 경과 후에도 유효).
10. `active` 컬럼이 비어 있는(undefined/null) 레거시 행은 **차단하지 않는다**(비활성 판정은 정확히 `'N'`일 때만).
11. `peekSession`은 만료를 **연장하지 않는다**: 가짜 시계로 peek만 반복하면 최초 발급 후 1시간이 지난 시점에 만료되고, 같은 조건에서 `touchSession`을 쓰면 연장된다.
12. `createSession`/`invalidate`는 가드를 통해도 원본과 동일하게 동작한다(로그인/로그아웃 경로 보존).

### 3) 구현

#### 3-1. `src/services/sessionService.js` (additive)

```js
// 만료 판정만 하고 expiresAt을 갱신하지 않는 조회. 만료면 스토어에서 제거하고 undefined.
function peekSession(sessionId) // -> identity | undefined
export { identityOf }           // 또는 동등한 방법으로 정제 헬퍼를 재사용 가능하게 노출
```

- `touchSession`의 기존 동작(슬라이딩 연장)은 **그대로 둔다**.
- 만료 판정 규칙(`now() >= expiresAt`), 반환 신원 정제(`{ ...identity }` 사본), `IDENTITY_FIELDS` 목록은 기존 코드를 재사용한다 — 판정식을 복제하지 마라.

#### 3-2. `src/services/sessionGuard.js` (신설)

```js
export function createSessionGuard({ sessionService, userModel })
// -> { createSession, touchSession, peekSession, invalidate }
```

핵심 규칙(벗어나지 마라):

- `touchSession(sid)` = `sessionService.touchSession(sid)` **동적 호출**(`const { touchSession } = sessionService` 같은 구조분해 캡처 금지) → 결과가 없으면 `undefined` → 있으면 재검증.
- `peekSession(sid)` = `sessionService.peekSession(sid)` → 동일 재검증.
- 재검증: `userModel.findById(identity.userId)`
  - 행이 없으면 → `sessionService.invalidate(sid)` 후 `undefined`
  - `row.active === 'N'`이면 → `sessionService.invalidate(sid)` 후 `undefined`
  - 그 외에는 **DB 행에서 재도출한 신원**을 반환한다. 정제는 `sessionService`의 `identityOf`(또는 `IDENTITY_FIELDS`)를 **재사용**해 화이트리스트 필드만 담는다 — 비밀번호·잠금 필드가 절대 새 신원에 들어가면 안 된다.
- `createSession`/`invalidate`는 원본에 그대로 위임한다.
- 캐시·메모이제이션·타이머를 두지 마라(아래 금지사항 참조).

## Acceptance Criteria

```bash
node --test test/sessionGuard.test.js test/sessionService.test.js   # 신규/보강 테스트 green
npm test                                                            # 679 + 신규, fail 0
npm run lint                                                        # clean
```

## 검증 절차

1. 위 AC 커맨드를 실행한다.
2. 변이 검증: (a) 가드의 `active === 'N'` 분기를 제거하면 시나리오 1·6이 red, (b) DB 행 대신 세션 스냅샷을 반환하도록 되돌리면 시나리오 2·3이 red, (c) `peekSession`이 `touchSession`을 호출하도록 바꾸면 시나리오 11이 red인지 확인하고 전부 원복한다.
3. 아키텍처 체크리스트:
   - 수정 범위가 `src/services/sessionService.js` + 신설 `src/services/sessionGuard.js` + 테스트뿐인가? (`server/`·`src/controllers/`·`web/` 변경 0건)
   - 이 step만으로 프로덕션 동작이 바뀌지 않는가?(소비처 미결선) 기존 679 테스트가 전부 green인가?
   - ADR-006 계층(services → models) 방향을 지켰는가? DB 접근은 주입받은 `userModel`로만 하는가?
4. 결과에 따라 `phases/52-security-hardening/index.json`의 step 1을 업데이트한다:
   - 성공 → `"status": "completed"`, `"summary": "신설 모듈·시그니처·판정 규칙·테스트 증감 요약(다음 step이 결선에 그대로 쓸 수 있도록)"`
   - 3회 수정 후에도 실패 → `"status": "error"`, `"error_message": "구체적 에러"`
   - 사용자 개입 필요 → `"status": "blocked"`, `"blocked_reason": "사유"` 후 즉시 중단

## 금지사항

- `sessionService`가 `userModel`/`db`를 직접 import 하거나 필수 의존성으로 받게 만들지 마라. 이유: 기존 테스트(authorization·receiverConfigService·distributionTargetService 등)가 DB 없이 세션을 발급하는 계약에 의존한다. 그 계약이 깨지면 이번 phase와 무관한 다수 테스트가 함께 red가 되어 회귀 원인 격리가 불가능해진다.
- 재검증 결과를 캐시하지 마라(TTL 캐시·마지막 조회 시각 비교 포함). 이유: 캐시 창이 곧 무효화 지연이며, "비활성 즉시 차단"이라는 이 항목의 요구를 정면으로 위반한다. in-process SQLite PK 조회는 마이크로초 단위라 최적화가 필요 없다.
- `setInterval`/`setTimeout`/백그라운드 스캔을 도입하지 마라. 이유: ADR-008의 "앱 내 타이머·외부 egress 없음" 규율.
- 비활성 판정을 `'N'` 이외의 값(falsy·`'n'`·`0` 등)으로 확장하지 마라. 이유: `userService.login`의 판정과 어긋나면 로그인은 되는데 즉시 401이 되는 모순이 생기고, `active`가 비어 있는 레거시 행 사용자가 통째로 잠긴다.
- 소비처(`src/controllers/index.js`, `server/index.js`, `src/services/authorization.js`)를 이 step에서 수정하지 마라. 이유: 결선은 step 2다. 도메인과 결선을 한 step에 섞으면 회귀 발생 시 원인 격리가 안 된다.
- 신원 객체에 DB row를 통째로 담지 마라(스프레드 금지). 이유: 비밀번호 해시·계정 잠금 메타가 응답 경로로 새어나간다(phase 51 step0이 닫은 종류의 구멍).
- DB 스키마 변경·행 삭제·백필을 하지 마라. 이유: CLAUDE.md·ADR-002 DB 비파괴 원칙.
- 기존 테스트를 깨뜨리지 마라.
