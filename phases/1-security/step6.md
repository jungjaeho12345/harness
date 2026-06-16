# Step 6: web-credentials

## 읽어야 할 파일

먼저 아래 파일들을 읽고 프로젝트의 아키텍처와 설계 의도를 파악하라:

- `/docs/ADR.md` — ADR-003(주입형 Model 계약 — transport는 httpModel 뒤에만), ADR-001(두 origin CORS·세션 전파), ADR-005(SSE EventSource)
- `/docs/ARCHITECTURE.md` — 프론트엔드 MVC(View ← Controller ← Model), "세션/인증: 클라이언트는 sessionId+user를 sessionStorage에 저장" (본 step이 이 sessionStorage 토큰 의존을 제거한다)
- `web/src/model/httpModel.js` — 현재 구현. 특히 `SESSION_STORAGE_KEY`('yh.sessionId'), `readSessionId`/`writeSessionId`, `request`(헤더에 `x-session-id` 첨부), `login`(응답 sessionId 저장), `logout`(토큰 제거), `restoreSession`, `subscribe`(`EventSource('/api/stream?session=' + sessionId)`)
- `web/src/model/contract.js` — `MODEL_KEYS` 계약(변경 불필요 — 메서드 이름·시그니처는 유지)
- `web/src/test/fakeModel.js` — 테스트용 가짜 Model(httpModel과 같은 응답 shape). sessionStorage/쿠키에 의존하지 않으므로 시그니처 호환만 유지하면 됨.
- `web/src/model/httpModel.test.js` — httpModel 단위 테스트. **`x-session-id` 헤더 첨부·sessionStorage 저장·`?session=` EventSource URL을 단언하는 테스트들을 함께 갱신해야 한다.**
- step 3·4 summary — 서버가 쿠키(`yh.sid`) 인증 + CORS credentials:true + SSE 쿠키 인증(`?session=` 제거)으로 전환됨. **서버가 이 전환을 마친 상태여야 이 step이 동작한다.**

step 3·4가 completed인지 summary로 확인한 뒤 작업하라.

## 작업

프론트 `httpModel`을 **쿠키 기반 세션**으로 전환한다. `fetch`는 `credentials:'include'`, `EventSource`는 `withCredentials:true`로 쿠키를 자동 전송하고, **sessionStorage 토큰 의존을 제거**한다. **프론트 Model 계층(httpModel)만** 다룬다(View/Controller는 건드리지 않는다 — ADR-003). TDD: 실패 테스트 먼저.

### 결정 사항(이 step에서 고정)

- 세션 토큰은 이제 **HttpOnly 쿠키**(`yh.sid`)가 소유하므로 JS는 토큰을 읽을 수 없다(그게 목적 — XSS 토큰 탈취 방지). 따라서 httpModel은 토큰을 sessionStorage에 저장/조회하지 않는다.
- `MODEL_KEYS` 계약(메서드 이름·인자)은 **바꾸지 않는다** — `login`/`logout`/`restoreSession`/`subscribe` 시그니처 유지. 컨트롤러·뷰는 영향받지 않는다.
- 사용자 식별 정보(`user`)는 로그인/복원 응답 body로 계속 받는다(쿠키엔 무작위 토큰만). httpModel은 토큰을 보관하지 않고, 신원 유지는 서버 세션 + F5 시 `restoreSession`(쿠키 기반)으로 한다.

### 구현

1. `web/src/model/httpModel.js`:
   - `SESSION_STORAGE_KEY`/`readSessionId`/`writeSessionId`와 `x-session-id` 헤더 첨부 로직을 **제거**한다.
   - `request(...)`: `fetch` init에 `credentials: 'include'`를 추가한다(쿠키 자동 전송). 헤더에서 `x-session-id`를 더 이상 붙이지 않는다.
   - `login`: 더 이상 응답 sessionId를 저장하지 않는다(쿠키는 서버가 Set-Cookie로 발급, 브라우저가 보관). 응답은 그대로 반환.
   - `logout`: 토큰 제거 코드 삭제. 서버가 쿠키를 만료시키므로 호출만 하면 된다.
   - `restoreSession`: 쿠키로 `/api/session`을 호출(이미 credentials:'include'면 자동). 동작 유지.
   - `subscribe`: `new EventSource(url, { withCredentials: true })`로 바꾸고 URL의 `?session=` 쿼리를 **제거**한다(쿠키로 인증). 나머지(ready/change 리스너, unsubscribe) 유지.
2. `web/src/model/httpModel.test.js` 갱신:
   - sessionStorage·`x-session-id`를 단언하던 테스트를 **`credentials:'include'`가 fetch init에 들어가는지**로 교체한다.
   - login이 토큰을 저장하지 않는지(sessionStorage 미사용), 이후 요청이 쿠키 모드(credentials include)로 나가는지.
   - `subscribe`가 `?session=` 없는 `/api/stream` URL + `{ withCredentials: true }`로 EventSource를 여는지(기존 FakeEventSource 테스트의 URL/옵션 단언을 갱신).
3. `web/src/test/fakeModel.js`: 시그니처 호환만 확인한다. fakeModel은 네트워크/쿠키에 의존하지 않으므로 동작 변경은 거의 없다 — 단, 혹시 sessionStorage를 가정하는 부분이 있으면 정리한다(없을 가능성 높음).
4. 영향 점검: `useLogin`/`App`의 F5 복원 흐름이 `restoreSession`(쿠키 기반)으로 여전히 동작하는지 관련 컨트롤러 테스트(`web/src/controller/useLoginController.test.jsx`, `web/src/app/App.test.jsx`)를 돌려 회귀가 없는지 확인한다. 이들은 fakeModel을 쓰므로 깨지지 않아야 한다 — 깨지면 **컨트롤러 로직을 바꾸지 말고** 원인을 분석해 httpModel/테스트 측에서 해결한다.

## Acceptance Criteria

```bash
npm run lint
npm run build
npm run test:web
```

(서버 측 회귀가 없는지도 함께 보려면 `npm test`도 실행한다 — 단 이 step의 변경은 web/ 안에만 있어야 한다.)

## 검증 절차

1. 위 AC 커맨드를 실행한다.
2. 아키텍처 체크리스트를 확인한다:
   - transport(fetch/EventSource)가 여전히 httpModel 안에만 있는가(View/Controller에 새지 않았는가 — ADR-003)?
   - `MODEL_KEYS` 계약 시그니처가 유지되는가(컨트롤러 영향 없음)?
   - sessionStorage 토큰·`x-session-id`·`?session=` 의존이 모두 제거되었는가?
   - `credentials:'include'`/`withCredentials:true`로 쿠키가 전송되는가?
3. 결과에 따라 `phases/1-security/index.json`의 step 6을 업데이트한다:
   - 성공 → `"status": "completed"`, `"summary"`에 sessionStorage 토큰 제거·credentials include·EventSource withCredentials 전환을 기록.
   - 실패/blocked → 절차 동일.

## 금지사항

- 세션 토큰을 다시 sessionStorage/localStorage에 저장하지 마라. 이유: 본 phase의 목적은 HttpOnly 쿠키로 옮겨 XSS 토큰 탈취 표면을 없애는 것 — JS 저장은 그 목적을 무효화한다.
- View/Controller 컴포넌트에서 `fetch`/`EventSource`를 직접 호출하거나 transport를 옮기지 마라. 이유: ADR-003 — transport는 httpModel 뒤에만.
- `MODEL_KEYS` 계약의 메서드 이름/인자를 바꾸지 마라. 이유: 컨트롤러·뷰·fakeModel·계약 검증이 모두 깨진다.
- `?session=` 쿼리나 `x-session-id` 헤더 첨부를 남기지 마라. 이유: 서버(step 3·4)가 쿠키 인증으로 전환됐고 쿼리 토큰 노출은 제거 대상.
- 기존 web 테스트(컨트롤러/뷰)를 깨뜨리지 마라(httpModel 단위 테스트는 갱신하되, 컨트롤러/뷰 테스트는 fakeModel 기반이라 무회귀여야 한다).
