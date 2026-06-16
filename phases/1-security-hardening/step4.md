# Step 4: cookie-session-client

## 읽어야 할 파일

먼저 아래 파일들을 읽고 현재 클라이언트 세션 배선을 파악하라:

- `/docs/news.md` — "세션 정책"(F5 복원, 클라가 사용자 정보·세션ID를 sessionStorage에 저장 후 복원, 복원 전엔 로그인 페이지로 안 보냄)
- `/docs/ARCHITECTURE.md` — 프론트 MVC(View←Controller←Model), "상태 관리"(sessionStorage 복원), 데이터 흐름(fetch(x-session-id))
- `/docs/ADR.md` — ADR-003(주입형 Model 계약, transport는 httpModel 뒤에 격리), ADR-001(두 origin CORS·세션 헤더 전파)
- `web/src/model/httpModel.js` — **현재 클라이언트 세션 transport(유일한 fetch/EventSource 소유처)**:
  - `SESSION_STORAGE_KEY='yh.sessionId'`, `readSessionId`/`writeSessionId`로 sessionStorage 관리.
  - `request()`가 `x-session-id` 헤더를 자동 첨부. `login()`이 응답의 `sessionId`를 저장, `logout()`이 비움, `restoreSession()`이 `/api/session` 호출.
  - `subscribe()`가 `?session=` 쿼리로 SSE 연결(step5에서 다룸 — 이 step에서 건드리지 마라).
- `web/src/model/httpModel.test.js` — **httpModel 테스트 패턴**(fetch 모킹). 헤더 첨부·세션 저장 검증이 있다. **이 테스트들을 깨지 않게** 보강한다.
- `web/src/model/contract.js` / `contract.test.js` — `MODEL_KEYS` freeze된 계약. 메서드 집합이 바뀌면 계약도 동기화해야 한다.
- `phases/1-security-hardening/step3.md` 산출물 — 서버가 로그인 시 HttpOnly 세션 쿠키를 발급하고, 요청에서 **쿠키 우선 → x-session-id 헤더 폴백** 순으로 읽는다. CORS `credentials: true`가 켜졌다(cross-origin 쿠키 허용). cross-origin SameSite 한계가 step3 summary에 기록되어 있으니 반드시 확인하라.

## 작업

클라이언트가 **세션 쿠키 기반**으로 동작하도록 httpModel을 전환한다. HttpOnly 쿠키는 **JS가 읽을 수 없으므로**, 클라이언트는 토큰을 직접 다루지 않고 **브라우저가 쿠키를 자동 전송**하게 한다. 단, step3가 cross-origin SameSite 제약으로 헤더 폴백을 유지하므로, 클라이언트도 **쿠키를 우선하되 기존 sessionStorage 헤더 경로를 안전하게 병행**한다. TDD — 테스트 먼저.

1. **credentials 포함**: `request()`의 `fetch` init에 `credentials: 'include'`를 추가한다. 그래야 cross-origin 요청에 세션 쿠키가 실린다(step3에서 CORS `credentials: true` 켜짐).
2. **SSE도 credentials**: `subscribe()`는 step5에서 다루므로 **이 step에서 변경하지 마라**. (단 `new EventSource(url, { withCredentials: true })` 전환은 step5의 작업임을 인지하라.)
3. **세션 저장 전략**:
   - HttpOnly 쿠키는 JS로 못 읽으므로 `sessionId`를 토큰으로 신뢰할 수 없다. 하지만 **F5 복원은 여전히 `/api/session`으로 한다** — 쿠키가 자동 전송되면 서버가 사용자 신원을 돌려준다(news.md: 복원은 서버 확인 후).
   - 로그인 응답의 `sessionId`는 (헤더 폴백 호환을 위해) 계속 sessionStorage에 저장해도 되지만, **인증의 1차 수단은 쿠키**다. 즉 쿠키가 있으면 헤더 없이도 인증되어야 한다.
   - **사용자 정보(user)** 는 기존대로 컨트롤러/앱 레벨에서 보관·복원한다(이건 토큰이 아니라 표시용 — 우측 상단 사용자 정보). 이 부분의 기존 동작을 깨지 마라.
4. **F5 복원 무회귀**: 새로고침 후 `restoreSession()`이 쿠키(자동 전송) 또는 헤더(폴백)로 `/api/session`을 호출해 `{ ok:true, user }`를 받고, 복원이 끝나기 전엔 로그인 페이지로 보내지 않는 기존 동작을 유지한다.
5. **로그아웃**: `logout()`은 `/api/logout`을 호출(서버가 쿠키 만료)하고 로컬 sessionStorage도 비운다.
6. **계약 동기화**: `MODEL_KEYS`(contract.js)의 메서드 집합이 바뀌지 않으면 contract는 손대지 않는다. 시그니처(메서드 이름/인자)는 유지하고 내부 transport만 바꾸는 것이 원칙이다.

테스트(`web/src/model/httpModel.test.js` 보강):
- `request()`(및 그를 쓰는 메서드)의 fetch 호출에 `credentials: 'include'`가 들어간다.
- 쿠키 기반 시나리오: sessionStorage에 토큰이 없어도(쿠키로 인증되는 상황을 fetch 모킹으로 가정) `restoreSession()`/`queryArticles()` 등이 정상 동작한다.
- 헤더 폴백 시나리오: sessionStorage에 토큰이 있으면 여전히 `x-session-id` 헤더가 첨부된다(무회귀).
- `logout()` 후 sessionStorage가 비워진다.

> 참고: web 테스트 실행은 `npm run test:web`(vitest)이다. backend `npm test`(node --test)와 별개다 — 아래 AC에 둘 다 포함한다.

## Acceptance Criteria

```bash
npm run lint
npm run build
npm test
npm run test:web
```

## 검증 절차

1. 위 AC 커맨드를 모두 실행한다.
2. 아키텍처 체크리스트:
   - 모든 transport(fetch/credentials)가 `httpModel.js` 안에만 있는가? (View/Controller가 직접 fetch 안 함 — ADR-003)
   - `credentials: 'include'`가 추가되어 쿠키가 cross-origin 전송되는가?
   - HttpOnly 쿠키 토큰을 JS로 읽으려 시도하지 않았는가? (읽을 수 없음 — 서버 `/api/session`에 의존)
   - 헤더 폴백과 F5 복원 동작이 무회귀인가? (httpModel.test.js / contract.test.js 통과)
   - `MODEL_KEYS` 계약이 깨지지 않았는가?
3. `phases/1-security-hardening/index.json`의 step 4 업데이트(completed + summary: credentials 추가·세션 저장 전략·F5 복원 경로). 실패 시 error, 모호 시 blocked.

## 금지사항

- `subscribe()`(SSE)를 이 step에서 수정하지 마라. 이유: SSE 인증 강화는 step5의 scope다(scope 최소화).
- View/Controller(`web/src/view`, `web/src/controller`)에서 직접 `fetch`/쿠키를 다루지 마라. 이유: ADR-003 — transport는 httpModel 뒤에만 둔다.
- HttpOnly 쿠키 값을 `document.cookie`로 읽으려 하지 마라. 이유: HttpOnly는 JS 접근이 원천 차단된다 — 신원 복원은 서버 `/api/session`이 담당한다.
- `sessionStorage` 헤더 경로를 제거하지 마라. 이유: cross-origin SameSite 제약(step3)으로 개발/일부 환경에서 쿠키가 안 실릴 수 있어 폴백이 필요하다 — 제거 시 회귀.
- 백엔드(`server/`, `src/`)를 이 step에서 수정하지 마라. 이유: 서버측 쿠키 처리는 step3에서 끝났다.
