# Step 4: auth-session-services

## 읽어야 할 파일

- `/docs/news.md` — **세션 정책(1h 슬라이딩), 로그인 워크플로우, 사용자 권한(R/D/Z)** 섹션이 1차 기준.
- `/docs/SCHEMA.md` — User 테이블, `active`('Y'/'N'), bcrypt 해시
- `/docs/ADR.md` — ADR-004(세션 기반 서버측 인가, role은 세션에서만 도출)
- `src/models/userModel.js` (step2 산출물)

## 작업

세션·로그인·인가 서비스를 구현한다. TDD. 시간 의존 로직은 **주입 가능한 now()** 로 테스트 결정성을 확보하라.

1. `src/services/sessionService.js` — `export function createSessionService({ now } = {})`:
   - `createSession(user)` — 서버 발급 **무작위 토큰**(권한 정보 미포함) 반환. 로그인 성공 시 기존 세션 무효화 후 새 토큰.
   - `touchSession(sessionId)` — 유효하면 **1시간 슬라이딩** 갱신 후 정제된 신원(`{ userId, role, department, departmentCode, name }`, 비밀번호 없음) 반환, 없거나 만료면 `undefined`.
   - `invalidate(sessionId)`(로그아웃).
2. `src/services/userService.js` — `export function createUserService({ userModel })`:
   - `login(userId, password, ...)` — bcrypt 비교. `active==='N'`이면 로그인 불가. **응답/반환에 비밀번호(해시 포함) 절대 미포함**. 성공/실패 경로의 소요 시간 차이를 최소화(타이밍 공격 완화).
   - `query(filters)` — 부서 등 조회(정제된 필드).
3. `src/services/authorization.js` — `export function createAuthorization({ sessionService, articleModel })`:
   - `assertAuthorized(role, capability)` — R/D/Z 역할 게이트.
   - `editDps(sessionId, articleId, action)` — DPS 기사는 D만 고침/포털고침(news.md 권한 규칙) 등 편집 인가.
   - `manageUsers(sessionId, op, payload)` / `manageReceiverConfig(...)` — **Z 전용** 게이트. 미인증/비-Z는 `{ ok:false, reason }`.
   - **모든 acting role은 검증된 세션에서만 도출**한다.
4. 테스트: bcrypt 해시/검증, active='N' 차단, 슬라이딩 만료(주입 시계로 59분/61분 경계), 기존 세션 무효화, Z 게이트, 비밀번호 미노출.

## Acceptance Criteria

```bash
npm run lint
npm run build
npm test
```

## 검증 절차

1. AC 실행.
2. 체크리스트: 세션 토큰에 권한이 안 담기는가? 1h 슬라이딩이 주입 시계로 검증되는가? 비밀번호가 어떤 반환에도 없는가? Z 전용 게이트가 미인증/비-Z를 거부하는가?
3. step 4 업데이트(completed + summary: 각 서비스 export와 핵심 메서드, now 주입 방식).

## 금지사항

- 비밀번호(평문/해시)를 함수 반환값이나 세션 신원에 포함하지 마라. 이유: news.md 보안 — 응답에 비밀번호 미포함.
- 권한을 클라이언트 입력 파라미터에서 도출하지 마라. 이유: ADR-004 — role은 검증된 세션에서만.
- `Date.now()` 직접 호출로 만료를 계산하지 마라(테스트 비결정). 주입된 now()를 사용하라.
- HTTP 코드를 넣지 마라. 기존 테스트를 깨뜨리지 마라.
