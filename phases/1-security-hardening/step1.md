# Step 1: account-lockout-service

## 읽어야 할 파일

먼저 아래 파일들을 읽고 현재 로그인/잠금 관련 도메인 로직을 파악하라:

- `/docs/news.md` — "로그인 워크플로우"(15분/10회 레이트리밋, active='N' 차단, 실패 원인 무관 동일 소요시간), "세션 정책"
- `/docs/PRD.md` — 핵심기능 1(로그인/세션), MVP 제외 사항 23행(계정 잠금이 후속 과제)
- `/docs/ADR.md` — ADR-004(신뢰 경계 = 서버), 철학(외부 의존성 최소화, 표준 우선)
- `src/services/userService.js` — **현재 로그인 도메인 로직**. `login(userId, password)`이 bcrypt 비교 후 `{ ok, user }` 또는 `{ ok:false, reason:'invalid-credentials'|'inactive' }`를 반환한다. 더미 해시로 타이밍 균등화 중.
- `src/models/userModel.js` — `findById`/`query`/`insert`/`update`. **이전 step(step0)에서 `COLUMNS`에 `failedLoginCount`/`lockedUntil`/`lastFailedLoginAt`가 추가되어 있다.** raw row를 반환(비밀번호 포함) — 정제는 서비스 책임.
- `test/userService.test.js` — 현재 로그인 서비스 테스트 패턴(가짜 userModel 주입). **이 패턴(주입형 fake)을 그대로 따른다.**
- `phases/1-security-hardening/step0.md` 산출물 — User 테이블에 추가된 잠금 컬럼 3개(`failedLoginCount` TEXT DEFAULT '0', `lockedUntil` TEXT, `lastFailedLoginAt` TEXT)와 userModel.COLUMNS 확장.

## 작업

`userService.login`에 **계정 잠금(account lockout)** 로직을 추가한다. 레이트리밋(IP 단위, 15분/10회)은 그대로 두고, 그 위에 **사용자 단위** 누적 실패 잠금을 얹는다. TDD — 테스트 먼저.

정책(이 step에서 확정):
- 연속 로그인 실패가 **임계치(기본 5회)** 에 도달하면 계정을 **잠금 기간(기본 15분)** 동안 잠근다. 임계치/기간은 `createUserService`의 옵션 인자로 주입 가능하게 하고 기본값을 상수로 둔다.
- 잠금 중(`lockedUntil`이 미래)에는 자격이 맞아도 로그인을 거부하고 `{ ok:false, reason:'locked' }`를 반환한다. **단 비밀번호 비교는 여전히 1회 수행**하여 잠긴 계정과 안 잠긴 계정의 응답 소요시간 차이를 만들지 않는다(news.md: 실패 원인 무관 동일 소요시간).
- 로그인 **성공** 시 `failedLoginCount`를 `'0'`으로, `lockedUntil`/`lastFailedLoginAt`를 비움(리셋)을 userModel.update로 영속화한다.
- 로그인 **실패**(invalid-credentials) 시 `failedLoginCount`를 +1 하고 `lastFailedLoginAt`를 갱신한다. 증가 후 임계치 이상이면 `lockedUntil = now + 잠금기간`을 설정한다.
- `active === 'N'`(비활성) 거부는 기존대로 유지하되, 잠금 판정보다 우선순위는 기존 로직 순서를 깨지 않는 선에서 결정한다(비활성 사용자에게 잠금 카운트를 올릴 필요는 없다 — 비활성 체크를 먼저 한다).
- 시계는 **주입**한다(`now = () => Date.now()` 옵션). Date.now() 직접 호출 금지 — 테스트는 가짜 시계를 주입한다(sessionService.js 패턴과 동일).

시그니처(가이드, 구현 재량):
```
createUserService({ userModel, now = () => Date.now(),
                    lockoutThreshold = 5, lockoutWindowMs = 15*60*1000 })
async login(userId, password)
  -> { ok:true, user } | { ok:false, reason:'invalid-credentials'|'inactive'|'locked' }
```

테스트(`test/userService.test.js` 보강 또는 신규 `test/userService.lockout.test.js`):
- 실패가 임계치 미만이면 카운트만 오르고 잠기지 않는다(다음 시도에서 정상 거부).
- 실패가 임계치에 도달하면 `lockedUntil`이 설정되고, 그 후 **올바른 비밀번호**로도 `reason:'locked'`를 받는다.
- `lockedUntil` 경과(가짜 시계 전진) 후에는 다시 로그인 시도가 가능하다(잠금 자동 만료 — 별도 행 삭제 없음).
- 로그인 성공 시 카운트/잠금이 리셋된다.
- 비활성(active='N') 사용자는 잠금 카운트와 무관하게 `reason:'inactive'`.
- 응답에 `password`/`failedLoginCount`/`lockedUntil`이 절대 포함되지 않는다(sanitize 유지).

## Acceptance Criteria

```bash
npm run lint
npm run build
npm test
```

## 검증 절차

1. 위 AC 커맨드를 실행한다.
2. 아키텍처 체크리스트:
   - 잠금 판정/갱신이 **서비스 계층**에만 있는가? (HTTP/모델에 비즈니스 규칙을 넣지 않았는가)
   - 시계를 주입했는가(Date.now() 직접 호출 없음)?
   - 잠긴 계정도 bcrypt 비교를 1회 수행해 타이밍 균등성을 유지하는가?
   - 잠금 상태 필드가 응답 sanitize에서 제외되는가?
   - userModel.update로만 카운트/잠금을 영속하고, 행 삭제가 없는가(DB 비파괴)?
3. 결과에 따라 `phases/1-security-hardening/index.json`의 step 1을 업데이트한다:
   - 성공 → `"status": "completed"`, `"summary"`에 login 시그니처 변경·기본 임계치/기간·리셋 규칙 기록.
   - 실패 3회 → `"status": "error"` + `error_message`. 설계 모호로 막히면 `"status": "blocked"`.

## 금지사항

- 레이트리밋(express-rate-limit, 15분/10회)을 제거하거나 잠금으로 대체하지 마라. 이유: IP 단위 레이트리밋과 사용자 단위 잠금은 보완 관계다 — news.md가 레이트리밋을 명시한다.
- 잠금 만료를 위해 User 행을 DELETE 하지 마라. 이유: DB 비파괴 원칙. 만료는 `lockedUntil`을 시계와 비교해 판정한다.
- HTTP 라우트(`server/index.js`)를 이 step에서 수정하지 마라. 이유: 라우트 배선은 step2의 scope다(scope 최소화).
- `Date.now()`를 직접 호출하지 마라. 이유: 테스트 결정성 — 시계는 주입한다.
- 응답 shape에 잠금 내부 상태(카운트/잠금시각)를 노출하지 마라. 이유: 잠금 상태 노출은 계정 열거 공격에 단서를 준다.
