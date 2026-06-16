# Step 2: account-lockout-route

## 읽어야 할 파일

먼저 아래 파일들을 읽고 현재 로그인 transport 경로를 파악하라:

- `/docs/news.md` — "로그인 워크플로우"(실패 시 ALERT 메시지, 실패 원인 무관 동일 소요시간)
- `/docs/ARCHITECTURE.md` — 얇은 transport(라우트는 세션검증→인가게이트→컨트롤러 위임→응답 매핑만)
- `/docs/ADR.md` — ADR-006(얇은 transport), ADR-004(신뢰 경계 서버)
- `server/index.js` — **현재 로그인 라우트**. `app.post('/api/login', loginLimiter, ...)`가 `controllers.auth.login(userId, password)`를 호출하고 `r.ok ? res.json(r) : fail(res, r, 401)`로 응답한다. `STATUS_BY_REASON` 맵에 reason→HTTP 코드 매핑이 있다(`locked: 409`가 **이미** 정의되어 있음 — 기사 잠금용이지만 재사용 가능). `fail()` 헬퍼 확인.
- `src/controllers/index.js` — `auth.login`이 `userService.login` 결과가 ok면 세션을 발급(`session.createSession`)하고 `{ ok, sessionId, user }`를 반환. 실패 reason은 그대로 전파.
- `test/server.test.js` — **HTTP 계층 테스트 패턴**: in-memory db로 `createApp({ controllers, sessionService })`를 만들고 `api()`/`login()` 헬퍼로 호출. 로그인 성공/실패 테스트가 이미 있다. **이 패턴을 그대로 따른다.**
- `phases/1-security-hardening/step1.md` 산출물 — `userService.login`이 잠금 시 `{ ok:false, reason:'locked' }`를 반환하도록 변경됨. `auth.login`은 이 reason을 그대로 전파한다(컨트롤러는 ok가 아니면 결과를 그대로 돌려줌 — index.js 49행 확인).

## 작업

계정 잠금 거부가 **로그인 라우트 응답에 올바른 HTTP 상태/메시지로 노출**되는지 확인하고, 누락 시 배선한다. 도메인 로직은 step1에서 끝났으므로 이 step은 **transport 매핑과 회귀 검증**이 핵심이다. TDD — 테스트 먼저.

1. `controllers.auth.login`이 `userService.login`의 `reason:'locked'`를 **그대로 전파**하는지 확인한다(index.js 44-49행). 전파되지 않으면(예: ok=false를 일반화) `reason`을 보존하도록 최소 수정한다. 새 비즈니스 규칙을 컨트롤러에 넣지 마라 — 위임/전파만.
2. `server/index.js`의 `/api/login` 라우트가 `reason:'locked'`에 대해 **명확한 상태 코드**로 응답하는지 확인한다. `STATUS_BY_REASON.locked`는 현재 `409`다. 로그인 잠금에 `409 Conflict`가 의미상 부적절하면(권장: `423 Locked` 또는 `429 Too Many Requests`) **로그인 전용 분기**로 처리하고, 기존 기사 잠금(`locked → 409`)의 의미는 건드리지 마라.
   - 결정 가이드: 로그인 잠금은 `423`(Locked)이 의미상 가장 정확하다. `STATUS_BY_REASON`를 공유 변경하면 기사 잠금 응답이 깨지므로, **로그인 라우트 안에서만** locked를 별도 상태로 매핑한다(예: `r.reason === 'locked' ? res.status(423).json(r) : fail(res, r, 401)`).
3. 실패 응답 body는 `{ ok:false, reason:'locked' }` 형태를 유지한다(클라이언트가 reason으로 ALERT 문구를 고를 수 있도록). **응답 body에 남은 시도 횟수·잠금 해제 시각 같은 내부 상태를 포함하지 마라**(계정 열거 단서).

테스트(`test/server.test.js` 보강):
- 임계치만큼 잘못된 비밀번호로 `/api/login`을 반복 호출하면, 그 다음 **올바른** 자격으로도 `reason:'locked'`와 잠금 상태 코드(423)를 받는다. (레이트리밋 10회 한도와 충돌하지 않도록 임계치를 레이트리밋보다 작게 둔 step1 기본값 5회를 활용 — 5회 실패 후 6번째 시도에서 검증)
- 잠긴 응답 body에 `sessionId`가 없다(세션 미발급).
- 정상 로그인은 여전히 `{ ok:true, sessionId }`를 반환한다(무회귀).
- **레이트리밋 회귀 주의**: in-memory 테스트에서 같은 앱 인스턴스로 10회 이상 로그인하면 레이트리밋(429)에 걸릴 수 있다. 잠금 테스트는 5회 실패 + 1회로 6회 호출이라 한도(10) 안이다. 테스트가 레이트리밋에 걸리지 않게 호출 수를 관리하라.

## Acceptance Criteria

```bash
npm run lint
npm run build
npm test
```

## 검증 절차

1. 위 AC 커맨드를 실행한다.
2. 아키텍처 체크리스트:
   - 라우트가 비즈니스 로직 없이 reason→상태 매핑만 했는가(얇은 transport)?
   - 기사 잠금(`locked → 409`)의 기존 의미를 깨지 않았는가? (로그인 전용 분기로 격리)
   - 잠금 응답 body에 내부 상태(남은 횟수/해제시각)가 없는가?
   - 세션이 잠금 시 발급되지 않는가?
3. `phases/1-security-hardening/index.json`의 step 2 업데이트(completed + summary: 로그인 잠금 상태코드 결정, 변경 파일). 실패 시 error, 모호 시 blocked.

## 금지사항

- `STATUS_BY_REASON.locked`의 값(409)을 전역 변경하지 마라. 이유: 기사 편집 잠금 응답이 같은 reason을 써서 회귀가 난다. 로그인 분기 안에서만 매핑하라.
- 잠금 카운트 증가/판정 로직을 라우트나 컨트롤러에 재구현하지 마라. 이유: 그 로직은 step1의 userService에 있다(계층 분리·단일 책임).
- 응답에 잔여 시도/해제 시각을 노출하지 마라. 이유: 계정 열거·잠금 우회 단서가 된다.
- 프론트엔드(web/)를 이 step에서 수정하지 마라. 이유: 이 phase의 잠금 항목은 서버측 강제가 본질이며, 클라이언트는 reason 문자열만 ALERT로 띄우면 된다(기존 useLoginController가 reason을 이미 처리하는지는 별도 확인 불필요 — 무회귀만 보장).
