# Step 2: realtime-sse-recovery

기사 조회 화면의 실시간(SSE) 동기화가 dev에서 끊기는 문제를 고치고, 상태바가 하드코딩된 "실시간"이 아니라 **실제 SSE 연결 상태**를 표시하게 한다. 근본 원인은 인증 경로 불일치다 — REST는 `x-session-id` 헤더 폴백으로 동작하지만, `EventSource`는 커스텀 헤더를 보낼 수 없어 세션 쿠키에만 의존하는데, dev 쿠키가 `SameSite=Lax`라 cross-origin `EventSource(/api/stream)`에 첨부되지 않아 401로 끊긴다(ADR-005: SSE 라우트는 `?session=` 쿼리 폴백을 두지만 토큰이 없으면 URL 노출을 피한다). 이 step은 **프론트엔드 전용**(백엔드/스키마/DB 무변경)으로, 동일 출처 전략(dev 프록시 + 기본 base 변경)으로 쿠키가 SSE에 first-party로 실리게 하고 연결 상태를 View까지 끌어올린다.

## 읽어야 할 파일

먼저 아래 파일들을 읽고 프로젝트의 아키텍처와 설계 의도를 파악하라:

- `/docs/ADR.md` — ADR-005(SSE 단방향 무효화 스트림·자동 재연결·`?session=` 쿼리 인증 폴백), ADR-003(주입 가능한 Model 계약·View/Controller는 직접 fetch/EventSource 금지, transport는 httpModel에만 격리), ADR-004(세션 기반 인가·클라이언트 role 불신).
- `/web/src/model/httpModel.js` — **이 step에서 수정할 파일.** 핵심 이해 포인트:
  - 파일 상단 주석: 인증 1차 수단은 HttpOnly 세션 쿠키(`credentials:'include'`), `x-session-id` 헤더는 dev cross-origin(SameSite 제약) 폴백.
  - `createHttpModel({ base })` — 모든 REST/SSE의 base URL. 기본값이 cross-origin 절대 URL이면 SSE 쿠키가 막힌다(이 step에서 동일 출처로 변경).
  - `subscribe(filter, onChange)` — `EventSource(url, { withCredentials: true })`로 `/api/stream`에 연결, `ready`/`change`/`error` 이벤트를 듣고 `connected` 플래그를 유지한다. `onChange`는 "무효화 신호"만 받고 `filter`는 그대로 넘겨 Controller가 자기 필터로 재조회한다(ADR-005, 행 데이터 push 받지 않음).
- `/web/src/controller/useViewController.js` — **이 step에서 수정할 파일.** `model.subscribe`를 거는 `useEffect`(의존성 `[model, filter, refresh]`)와 반환 객체를 확인한다. 상태바에 넘길 연결 상태가 여기서 만들어진다.
- `/web/src/view/ListPage.jsx` — **이 step에서 수정할 파일.** `data-testid="live-status"` 상태바가 하드코딩된 `yh-live--on` 클래스·"실시간" 텍스트로 그려지는 지점.
- `/web/src/test/fakeModel.js` — 테스트용 in-memory Model. `subscribe` 시그니처가 실제 `httpModel`과 계약상 일치해야 한다.
- `/web/src/view/ListPage.test.jsx` — `createFakeModel`/`AppContext` 주입으로 ListPage를 렌더하는 테스트. 상태바 단언 케이스를 강화한다.
- `/web/vite.config.js` — **이 step에서 수정할 파일.** dev 서버 설정(프록시) 추가 지점.

이전에 만들어진 코드를 꼼꼼히 읽고 설계 의도를 이해한 뒤 작업하라.

## 작업

TDD: 가능한 단언을 먼저 강화한 뒤 통과하는 구현을 작성한다.

문제의 핵심은 **인증 경로 불일치**다 — REST는 `x-session-id` 헤더로 동작하지만 `EventSource`는 헤더를 못 보내 세션 쿠키에 의존하는데, dev의 `SameSite=Lax` 쿠키가 cross-origin SSE에 첨부되지 않는다. 따라서 **동일 출처**로 만들어 Lax 쿠키가 SSE에도 first-party로 실리게 하고, 연결 상태를 콜백으로 View까지 끌어올린다.

핵심 결정(반드시 따른다):
- **동일 출처 전략**: dev는 Vite 프록시(`/api`→API 서버), prod는 API 서버가 정적 번들을 같이 서빙한다. 기본 `base`를 빈 문자열(동일 출처)로 둔다. cross-origin로 띄워야 하면 `VITE_API_BASE`를 프록시 target으로 주거나 `base`를 명시 주입한다.
- transport(fetch/EventSource)는 **httpModel 안에만** 둔다(ADR-003) — Controller/View는 `onStatus` 콜백을 통해 상태만 받는다. role을 SSE 신호에 싣지 않는다(ADR-004).
- 상태바는 **실제 연결 상태**를 표시한다 — 끊기면 `EventSource`가 자동 재연결을 시도한다(ADR-005). 하드코딩 금지.

구현(시그니처는 재량, 기존 패턴 재사용):
- `web/vite.config.js`: `defineConfig`에 `server.proxy`를 추가해 `'/api'`를 API 서버로 포워딩한다. target은 `process.env.VITE_API_BASE ?? 'http://127.0.0.1:3001'`(상수로 도출), `changeOrigin: true`. 주석으로 "SSE 쿠키(SameSite=Lax)가 동일 출처에서만 first-party로 실린다"는 이유를 박아둔다.
- `web/src/model/httpModel.js`:
  - `createHttpModel`의 기본 `base`를 cross-origin 절대 URL에서 `''`(동일 출처)로 바꾼다. 그 이유(동일 출처여야 Lax 쿠키가 SSE에 실림)를 주석으로 남긴다.
  - `subscribe(filter, onChange)`에 선택적 3번째 인자 `onStatus(boolean)`를 추가한다. 내부에 `setStatus(next)` 헬퍼를 두어 `connected` 플래그 갱신과 `onStatus?.(next)` 호출을 일원화한다. `ready` 이벤트→`setStatus(true)`, `error` 이벤트→`setStatus(false)`. `change` 핸들러·`connected()`/`unsubscribe()` 반환은 무변경.
- `web/src/controller/useViewController.js`:
  - `live` 상태(`useState(false)`)를 추가한다(주석: ready→true, error/해제→false).
  - subscribe `useEffect`에서 진입 시 `setLive(false)`로 초기화하고 `setLive`를 `onStatus`로 `model.subscribe(filter, () => refresh(), setLive)`에 넘긴다. cleanup에서도 `setLive(false)` 후 `unsubscribe()`. 의존성 배열은 기존(`[model, filter, refresh]`) 유지.
  - 반환 객체에 `live`를 노출한다.
- `web/src/view/ListPage.jsx`: ctrl 구조분해에 `live`를 추가한다. 상태바의 하드코딩된 `yh-live--on`/"실시간"을 `live` 기반 조건부로 교체한다 — `className={\`yh-live ${live ? 'yh-live--on' : ''}\`}`, 텍스트는 `live ? '실시간' : '연결 끊김'`, `title`로 연결됨/끊김(자동 재연결 시도 중) 안내. `data-testid="live-status"`는 유지.
- `web/src/test/fakeModel.js`: `subscribe` 시그니처에 `onStatus`를 받아 `onStatus?.(true)`로 즉시 "연결됨" 처리한다(실제 httpModel과 계약 일치 — fake 스트림은 즉시 ready).

테스트(`web/src/view/ListPage.test.jsx`):
- 기존 "4개 메뉴와 실시간 상태바를 보여준다" 케이스를 `async`로 바꾸고 `waitFor`로 상태바가 **실제 연결 상태**를 반영하는지 단언한다 — fake 스트림은 `onStatus(true)`이므로 `live-status`가 `yh-live--on` 클래스를 갖고 "실시간" 텍스트를 표시해야 한다(하드코딩이 아님). `waitFor`는 이미 import되어 있다.

## Acceptance Criteria

```bash
npm run lint
npm run build
npm test
npm run test:web
```

## 검증 절차

1. 위 AC 커맨드를 실행한다. 기존 web 테스트 + 강화된 상태바 케이스가 모두 통과해야 한다(무회귀). 백엔드는 무변경이므로 backend 스위트도 무회귀여야 한다.
2. 아키텍처 체크리스트(ARCHITECTURE.md 디렉토리 구조·ADR 기술스택·CLAUDE.md CRITICAL):
   - transport(EventSource/fetch)가 `httpModel` 안에만 있는가? Controller/View는 `onStatus` 콜백으로 상태만 받는가(ADR-003 — View/Controller 직접 EventSource 금지)?
   - SSE 신호에 role/행 데이터를 싣지 않는가(ADR-004·ADR-005 — 무효화 신호만, Controller가 자기 필터로 재조회)?
   - `subscribe`의 `onStatus`는 선택적(미전달 시 무해)이라 다른 호출부가 무회귀인가?
   - 상태바가 하드코딩이 아니라 `live`를 반영하며 끊김 시 자동 재연결 전제(ADR-005)를 유지하는가?
   - DB/스키마/백엔드 무변경(DB 비파괴 — 이 step은 SELECT조차 추가하지 않음)인가?
3. `phases/4-mvp-polish/index.json`의 step 2를 업데이트(completed + summary: 동일 출처 프록시·base `''`·subscribe `onStatus`·useViewController `live`·ListPage 조건부 상태바). 실패 시 error, 개입 필요 시 blocked.

## 금지사항

- View/Controller에서 직접 `fetch`/`EventSource`를 호출하지 마라. 이유: 모든 transport는 `httpModel`(ADR-003 Model 계약)에만 격리한다 — 연결 상태는 `subscribe`의 `onStatus` 콜백으로만 전달한다.
- SSE 신호에 행 데이터나 클라이언트 role을 싣거나 신뢰하지 마라. 이유: ADR-005는 행 없는 "무효화 신호"만 보내고 클라가 자기 필터로 재조회하며, 인가는 서버 세션이 강제한다(ADR-004).
- `subscribe`의 `onStatus`를 **필수 인자**로 만들지 마라. 이유: 기존 호출부(`onStatus` 미전달)가 깨진다 — `onStatus?.()`로 선택적 호출해 무회귀를 보장한다.
- 기본 `base`를 다시 cross-origin 절대 URL로 되돌리거나 dev 프록시를 제거하지 마라. 이유: 그러면 `SameSite=Lax` 세션 쿠키가 cross-origin `EventSource`에 첨부되지 않아 `/api/stream`이 401로 끊기고 실시간이 복구되지 않는다.
- 상태바를 다시 하드코딩(`yh-live--on` 고정)하지 마라. 이유: 끊김 상태를 사용자가 알 수 없게 되어 이 step의 목적(실제 연결상태 표시)이 무력화된다.
- 백엔드/스키마/DB나 다른 step의 컨트롤러·뷰 로직을 건드리지 마라. 이유: 이 step은 SSE 인증 복구와 상태 표시(프론트엔드)만 다룬다 — 범위를 벗어난 변경은 무회귀 검증을 흐린다. 기존 테스트/기능을 깨뜨리지 마라.
