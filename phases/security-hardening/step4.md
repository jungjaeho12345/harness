# Step 4: frontend-cookie-session

## 목표
프론트엔드 transport(`web/src/model/httpModel.js`)를 **쿠키 기반 세션**과 정합하도록 전환한다. step0~2에서 서버가 HttpOnly 쿠키로 세션을 발급/검증하므로, 프론트는 (1) 모든 `fetch`에 `credentials:'include'`를 붙여 쿠키를 주고받고, (2) `EventSource`는 `{ withCredentials:true }`로 생성해 쿠키를 첨부하며 `?session=` 쿼리 토큰을 제거하고, (3) **HttpOnly 쿠키는 JS로 읽을 수 없으므로** `sessionStorage`의 세션 **토큰 의존을 제거**한다. 단 F5 복원 UX(news.md 119행: 복원 끝나기 전 로그인 페이지로 보내지 않음)는 유지한다. 이 step은 **프론트 transport 계층(`httpModel.js`)만** 단일 책임으로 손댄다 — Model 계약(`MODEL_KEYS`)·Controller·View·서버는 무변경.

## 읽어야 할 파일
- `/home/user/harness/docs/ADR.md` — ADR-003(주입형 Model 계약 `contract.js`/`MODEL_KEYS`, 실제 배선은 `httpModel` 뒤에 격리, 테스트는 `fakeModel`), ADR-001(2-origin → CORS credentials 필요)
- `/home/user/harness/docs/news.md` — `## 세션 정책` 116·119행(F5 복원 시 서버 확인 후 복원, 복원 전 로그인 페이지로 보내지 않음). 쿠키 전환 후에도 **이 UX 계약은 유지**
- `/home/user/harness/web/src/model/httpModel.js` — 전부. `SESSION_STORAGE_KEY`/`readSessionId`/`writeSessionId`(8~26행), `request`의 `x-session-id` 헤더 첨부(42~53행), `login`/`logout`/`restoreSession`(57~71행), `subscribe`의 `?session=` URL(140~159행)
- `/home/user/harness/web/src/model/contract.js` — `MODEL_KEYS` 계약. `login`/`logout`/`restoreSession`/`subscribe` 등 **메서드 시그니처·반환 shape은 바꾸지 마라**(Controller/View가 의존)
- `/home/user/harness/web/src/model/httpModel.test.js` — 기존 transport 테스트 패턴(fetch/EventSource 목 방식). 쿠키 전환 회귀 가드를 여기에 보강
- `/home/user/harness/phases/security-hardening/step0.md` — 서버가 `credentials:true` CORS + 쿠키 발급으로 바뀐 점(프론트 `credentials:'include'`와 짝)
- `/home/user/harness/phases/security-hardening/step2.md` — SSE가 쿠키/헤더만 받고 `?session=` 쿼리를 더 이상 인증하지 않는 점(이 step에서 프론트 `withCredentials:true`로 맞춤)
- `/home/user/harness/src/controllers/index.js` — `auth.login`이 여전히 `{ ok, sessionId, user }`를 반환(하위호환). 프론트는 `user`만 쓰고 `sessionId`는 더 이상 저장하지 않아도 됨

## 작업 (TDD — 테스트 먼저, `npm run test:web`)
1. **fetch credentials**: `request(...)`의 `init`에 `credentials: 'include'`를 추가한다 — cross-origin(`:5173`↔`:3001`)에서 쿠키를 주고받기 위함(서버 CORS `credentials:true`와 짝, step0). 
2. **세션 토큰 의존 제거**: HttpOnly 쿠키는 JS가 못 읽으므로 `readSessionId`로 헤더를 붙이는 경로는 더 이상 인증의 주된 수단이 아니다. 
   - `login` 성공 시 `writeSessionId(result.sessionId)` 저장을 **제거**한다(쿠키가 세션을 보유). `result.user`만 상위(Controller)로 흘린다. `logout`의 `writeSessionId(null)`도 제거(서버 `clearCookie`가 처리).
   - `request`에서 `x-session-id` 헤더 자동 첨부 로직을 제거한다(쿠키로 인증). **단, 하위호환이 필요하면** 헤더 경로를 한 단계 남길 수 있으나, 이 step의 목표는 토큰을 JS에서 다루지 않는 것이므로 **제거를 권장**하고 근거를 summary에 남겨라(남길 경우 토큰 출처가 사라져 무의미해짐 — 제거가 자연스럽다).
   - `SESSION_STORAGE_KEY`/`readSessionId`/`writeSessionId` 헬퍼가 더 이상 안 쓰이면 제거한다(dead code 금지).
3. **restoreSession(F5 복원)**: `request('/api/session')`는 그대로 호출하되 이제 **쿠키**로 인증된다(credentials:'include' 덕분). 반환 shape `{ ok, user }` / `{ ok:false, reason:'unauthenticated' }`는 유지 — Controller의 복원 UX(news.md 119행)가 그대로 동작한다. **세션 식별자는 sessionStorage에 두지 않는다**(쿠키가 보유). 단 사용자 정보(user) 캐시를 sessionStorage에 두는 기존 UX는 Controller 책임이라면 이 step에서 건드리지 않는다(transport만).
4. **SSE subscribe**: `?session=readSessionId()` 쿼리를 **제거**하고, `new EventSource(\`${base}/api/stream\`, { withCredentials: true })`로 쿠키를 첨부한다(step2 서버 변경과 짝). `ready`/`change`/`error` 리스너·`unsubscribe`/`connected` 반환은 그대로 유지(ADR-005 자동 재연결·무효화 신호 방식 무변경).
5. **계약 동기화 확인**: `contract.test.js`의 `MODEL_KEYS` 검증이 깨지지 않게 메서드 집합·시그니처를 유지한다(프론트 통합 seam — ADR-003).

## 테스트 계획 (`web/src/model/httpModel.test.js` 보강 — vitest)
- `fetch` 목으로: 모든 요청 `init`에 `credentials:'include'`가 들어간다.
- `login` 성공 후 `sessionStorage`에 토큰을 쓰지 않는다(HttpOnly 쿠키 가정). `request`가 `x-session-id` 헤더를 붙이지 않는다(제거를 택한 경우).
- `restoreSession`이 `GET /api/session`을 `credentials:'include'`로 호출하고, `{ok:true,user}` / 비로그인 응답을 그대로 반환한다.
- `subscribe`가 `EventSource`를 `withCredentials:true`로 생성하고 URL에 `?session=`이 **없다**. `change` 이벤트 수신 시 `onChange(signal, filter)`가 호출된다(무효화 신호 회귀).
- `MODEL_KEYS` 계약 테스트(`contract.test.js`)가 통과한다(메서드 집합 불변).
- EventSource/sessionStorage 목은 jsdom/vitest 환경에 맞춰 주입한다(실제 네트워크 없이).

## Acceptance Criteria
```bash
npm run lint
npm run build
npm test
npm run test:web
```

## 검증 절차
1. AC 실행. `npm test`(백엔드 무회귀)와 `npm run test:web`(프론트) 모두 통과. 기존 `httpModel.test.js`·`contract.test.js`가 갱신/무회귀로 통과.
2. 체크리스트: 모든 fetch가 `credentials:'include'`인가? `sessionStorage` 토큰 저장이 제거됐는가? `EventSource`가 `withCredentials:true`이고 `?session=`이 없는가? `MODEL_KEYS` 계약(메서드 시그니처/반환 shape)이 보존됐는가? F5 복원 UX가 유지되는가?
3. index.json의 step 4를 completed + summary(credentials 적용 범위·헤더/sessionStorage 제거 결정·withCredentials SSE·계약 무변경 확인)로 갱신. phase 전체(0~4) 완료 시 `phases/index.json`의 `security-hardening` status를 `completed`로 갱신하도록 오케스트레이터에 보고.

## 금지사항 / 불변규칙 체크리스트
- `MODEL_KEYS` 계약의 메서드 집합·시그니처·반환 shape을 바꾸지 마라. 이유: ADR-003 — 이 계약이 프론트/백 통합 seam이며 Controller/View/fakeModel이 의존한다.
- Controller/View 코드를 이 step에서 수정하지 마라. 이유: 단일 책임(transport) — 한 step에 여러 레이어를 섞으면 실패 격리가 불가능하다.
- HttpOnly 쿠키 값을 JS로 읽으려 하지 마라(`document.cookie` 파싱 등). 이유: HttpOnly는 정의상 JS 접근 불가 — 인증은 브라우저가 쿠키를 자동 전송한다(credentials:'include'/withCredentials).
- `?session=` 쿼리 토큰을 SSE URL에 남기지 마라. 이유: step2에서 서버가 쿼리 인증을 제거했고, 토큰 누출 표면을 닫는 것이 목적이다.
- `credentials:'include'`를 빼먹지 마라. 이유: cross-origin(:5173↔:3001)에서 빠지면 쿠키가 전송되지 않아 전 인증이 깨진다.
- 서버/DB/스키마를 건드리지 마라. 이 step은 프론트 transport만. DB 비파괴 원칙.
