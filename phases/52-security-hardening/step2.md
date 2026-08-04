# Step 2: session-revalidation-wiring

## 읽어야 할 파일

먼저 아래 파일들을 읽고 프로젝트의 아키텍처와 설계 의도를 파악하라:

- `docs/ARCHITECTURE.md` — 백엔드 계층 분리, "보안 경계"
- `docs/ADR.md` — ADR-004(세션 기반 서버측 인가), ADR-006(얇은 transport + 계층형 도메인)
- `src/services/sessionGuard.js` — **step 1에서 신설**. `createSessionGuard({ sessionService, userModel })` → `{ createSession, touchSession, peekSession, invalidate }`. `touchSession`/`peekSession`이 매 호출 User 행을 재조회해 `active='N'`/행 없음이면 세션을 무효화하고, 그 외에는 DB 최신값으로 신원을 재도출한다.
- `src/services/sessionService.js` — step 1에서 `peekSession`(비연장 조회)이 추가됐다.
- `src/controllers/index.js` — 합성 루트. `const session = sessionService ?? createSessionService()`, `createAuthorization({ sessionService: session, articleModel })`, `auth.login/logout/session/manageUsers/editDps`
- `server/index.js` — `createApp({ controllers, sessionService, ... })`, `sessionOf(req)`, `GET /api/session`, `GET /api/stream`의 인증 부분
- `src/services/authorization.js` — 주입받은 `sessionService.touchSession`으로 role을 도출한다(이 파일은 수정하지 않는다)
- `test/server.test.js` — HTTP 테스트 조립 패턴(`start()`, `seedUser`, `login`, `api`)
- `test/controllers.test.js` — "createControllers: 외부 sessionService 주입을 지원한다" 테스트(주입한 원본 스토어로 세션을 검증한다)
- `test/sse-auth.test.js` L140~160 — `ctx.sessionService.touchSession`을 **런타임에 교체**해 `/api/stream`이 그것을 호출하는지 확인하는 스파이 테스트

## 배경 (이 step 안에서 자기완결)

step 1이 만든 재검증 데코레이터를 **실제 인증 경로에 연결**하는 step이다. 연결 지점을 하나라도 빠뜨리면 그 라우트만 옛 스냅샷 권한으로 남아 구멍이 된다. 현재 신원 도출 경로는 두 갈래다:

1. `server/index.js`의 `sessionOf(req)` / `GET /api/session` / `GET /api/stream` → **주입된 `sessionService`를 직접** 호출
2. `src/services/authorization.js`(Z 게이트·editDps 등) → `createControllers`가 넘긴 `session`을 호출

따라서 `createControllers`가 가드로 감싸고(2번 커버), transport는 세션 스토어를 직접 만지지 말고 컨트롤러를 통해 신원을 얻도록 바꾼다(1번 커버). 이렇게 하면 **앱을 재검증 없이 조립할 수 있는 경로 자체가 사라진다.**

## 작업

### 1) 착수 전 실측

```bash
npm test        # step 1 반영본 기준선(679 + step1 신규) pass, fail 0
npm run lint
```

### 2) 테스트 먼저 (TDD — red 확인 필수)

`test/session-revalidation-api.test.js`를 신설한다(HTTP 레벨). 조립은 `test/server.test.js`와 동형(`createSchema` → `createSessionService` → `createControllers` → `createApp` → `listen(0)`), 사용자 시드 후 `POST /api/login`으로 세션을 받는다.

공격/보안 시나리오:

1. R로 로그인 → Z 세션으로 `PUT /api/users/:id`에 `{ active: 'N' }` → 그 R 세션으로 `GET /api/articles` → **401 unauthenticated**(즉시 차단).
2. 1과 같은 상태에서 `POST /api/articles`(신규 저장) → 401이고 **Article 행 수가 늘지 않는다**(DB로 단언).
3. D로 로그인(강제 해제 권한 보유) → Z가 그 사용자의 role을 `'R'`로 update → `POST /api/articles/:id/force-unlock` → **403 forbidden**, 잠금은 유지.
4. Z로 로그인 → Z가 **자기 자신**의 role을 `'R'`로 강등 → `POST /api/users`(Z 전용) → **403**(authorization 게이트도 재검증 경로를 탄다).
5. 비활성화로 죽은 세션 토큰은 다시 `active='Y'`로 되돌려도 401이다(재로그인 필요 — 토큰 부활 금지).
6. 비활성 사용자의 `GET /api/stream` 접속 → 401(SSE 접속 시점 인증도 재검증 경로를 탄다).

정상 플로우 무손상(회귀 케이스 — 반드시 포함):

7. 로그인 → 기사 생성 → `POST /:id/lock` → `PUT /:id`(저장) → `POST /:id/action`(송고) 전 과정이 기존과 동일하게 200 계열로 통과한다.
8. 권한과 무관한 사용자 정보 변경(예: `department` 수정)은 세션을 죽이지 않고, 다음 요청부터 새 값이 신원에 반영된다(부서 stamp 확인).
9. `GET /api/session`(F5 복원)이 정상 사용자에게 그대로 `{ ok: true, user }`를 준다.
10. 로그인/로그아웃 왕복이 그대로 동작한다(로그아웃 후 401).

계약 잠금(`test/controllers.test.js`에 1건 추가 — step 3이 소비할 표면을 이 step에서 잠근다):

11. `createControllers(...).auth`에 **`peek` 키가 존재**하고 함수다. 그리고 `auth.peek`은 **만료를 연장하지 않는다**: 가짜 시계(`createSessionService({ now })`)로 세션을 발급하고 peek만 반복해도 1시간 경과 시 `undefined`가 되며, 같은 조건에서 `auth.session`을 쓰면 연장되어 유효하다. 이 단언이 없으면 `peek` 결선 누락이 step 3에서야 드러난다.

### 3) 구현

#### 3-1. `src/controllers/index.js` (합성 루트)

```js
const rawSession = sessionService ?? createSessionService();
const session = createSessionGuard({ sessionService: rawSession, userModel });
```

- 이후 `session`을 쓰던 모든 지점(`createAuthorization({ sessionService: session, ... })`, `auth.login`의 `createSession`, `auth.logout`, `auth.session`)은 **가드를 쓴다**.
- `auth`에 비연장 조회를 추가한다: `peek: (sessionId) => session.peekSession(sessionId)`. 이 step에서는 소비처가 없어도 된다(step 3이 쓴다).
- 주입받은 원본 인스턴스(`rawSession`)는 그대로 유지된다 — 외부에서 같은 스토어를 검증하는 기존 테스트가 계속 통과해야 한다.

#### 3-2. `server/index.js` (transport)

- `sessionOf(req)`는 `{ sid, me: sid ? controllers.auth.session(sid) : undefined }`로 바꾼다.
- `GET /api/session`, `GET /api/stream`의 인증도 `controllers.auth.session(sid)`을 쓴다.
- `createApp`의 **`sessionService` 파라미터를 제거**한다(호출부가 계속 넘겨도 무해하다 — JS는 잉여 속성을 무시한다). 이유: 신원 도출 경로가 둘이면 한쪽만 재검증되는 구멍이 다시 생긴다. 파라미터 제거 후 `server/index.js` 안에 `sessionService.` 참조가 **0건**이어야 한다(grep으로 확인).
- 부트스트랩(`bootstrap()`)은 계속 `createSessionService()`를 만들어 `createControllers`에 넘긴다(가드는 그 안에서 조립된다). `createApp` 호출 인자에서 `sessionService`는 빼도 되고 남겨도 되지만, 남긴다면 "사용되지 않음"이 lint에 걸리지 않는지 확인하라.
- 라우트 핸들러 안에 재검증 코드를 개별 삽입하지 마라 — 신원은 오직 `sessionOf`/`controllers.auth.*` 단일 경로에서만 나온다.

#### 3-3. 문서 갱신 — `docs/ADR.md` + `docs/ARCHITECTURE.md`

- **ADR-004 보강**: 본문에 **1~2문장만** 추가한다(결정 문장 자체와 다른 ADR은 수정하지 마라). 세션 신원은 스냅샷이 아니라 매 요청 User 행 재조회로 재도출하며 `active='N'`/행 없음이면 세션을 즉시 무효화한다는 사실과, 그 대가(인증 요청마다 PK 조회 1회, 권한 변경이 재로그인 없이 즉시 반영됨)를 트레이드오프로 남긴다.
- **ARCHITECTURE.md 갱신**: "보안 경계" 절의 첫 줄(신뢰 경계·acting role 도출 규칙)에 **"신원(role/active)은 세션 스냅샷이 아니라 매 요청 User 행 재조회로 재도출한다"**는 규율을 1줄로 반영한다(step 0이 같은 절에 추가한 Origin 검증 줄은 건드리지 마라). 다른 절은 수정하지 않는다.

## Acceptance Criteria

```bash
node --test test/session-revalidation-api.test.js test/controllers.test.js   # 신규 + auth.peek 계약 잠금 green
npm test                                                                     # 전체 green, fail 0
npm run lint                                                                 # clean
```

## 검증 절차

1. 위 AC 커맨드를 실행한다.
2. 변이 검증: `sessionOf`를 원래대로 세션 스토어 직접 호출로 되돌리면 시나리오 1·2·3이 red가 되는지 확인하고 원복한다.
3. 기존 테스트 중 red가 나면 **가드를 완화하지 말고** 원인을 분류하라. DB에 없는 사용자로 세션을 위조해 HTTP를 호출하는 테스트라면 그 테스트의 픽스처(User 행 시드)를 고치는 것이 맞다. 정상 사용자가 막히는 red라면 구현이 틀린 것이다.
4. 아키텍처 체크리스트:
   - 수정 범위가 `src/controllers/index.js` + `server/index.js` + `docs/ADR.md` + `docs/ARCHITECTURE.md`("보안 경계" 1줄) + 테스트뿐인가? (`src/services/*`는 step 1 산출물 그대로, `web/` 변경 0건)
   - `src/services/authorization.js`를 수정하지 않고도 Z 게이트가 재검증되는가?(주입 객체만 바뀌어야 한다)
   - `server/index.js`에 `sessionService.` 참조가 0건인가?
   - DB 스키마·행 변경 0건인가?
5. 결과에 따라 `phases/52-security-hardening/index.json`의 step 2를 업데이트한다:
   - 성공 → `"status": "completed"`, `"summary": "결선 지점·auth.peek 추가·기존 테스트 영향 요약"`
   - 3회 수정 후에도 실패 → `"status": "error"`, `"error_message": "구체적 에러"`
   - 사용자 개입 필요 → `"status": "blocked"`, `"blocked_reason": "사유"` 후 즉시 중단

## 금지사항

- 재검증을 라우트별로 복사해 넣지 마라. 이유: 누락된 라우트가 곧 권한 상승 구멍이 된다. 신원은 `sessionOf`/`controllers.auth.*` 단일 경로에서만 도출한다.
- `req.body`·헤더·쿼리에서 `role`/`userId`를 파생하지 마라. 이유: ADR-004 신뢰 경계 위반(클라이언트 값 불신).
- 세션 스토어를 DB 테이블이나 외부 저장소로 옮기지 마라. 이유: ADR-004가 in-process 스토어를 명시 결정했고, 다중 인스턴스 대응은 이 phase 범위 밖이다.
- `src/services/authorization.js`·`src/services/userService.js`를 수정하지 마라. 이유: 이 step은 결선만 한다. 인가 규칙(capability 표)이나 로그인 정책을 함께 건드리면 회귀 원인 격리가 불가능해진다.
- 사용자 정보 변경 시 세션을 일괄 무효화하는 훅을 추가하지 마라. 이유: 매 요청 재조회로 이미 즉시 반영되며, 훅을 겹치면 부서·이름 수정 같은 무해한 변경으로 편집 중인 사용자가 로그아웃돼 편집물이 유실된다.
- `peekSession`을 `sessionOf`(일반 REST 경로)에 쓰지 마라. 이유: 일반 요청은 슬라이딩 갱신(news.md "인증된 모든 요청마다 갱신")이 계약이다. peek는 step 3의 SSE 재검증 전용이다.
- DB 행 삭제·스키마 변경·백필을 하지 마라. 이유: CLAUDE.md·ADR-002 DB 비파괴 원칙.
- 기존 테스트를 깨뜨리지 마라. 특히 `test/sse-auth.test.js`의 `touchSession` 스파이와 `test/controllers.test.js`의 "외부 sessionService 주입" 테스트가 green이어야 한다.
