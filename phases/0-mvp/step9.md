# Step 9: frontend-model

## 읽어야 할 파일

- `/news.md` — **클라이언트 기술명세(react/vite, MVC), API 명세서**(엔드포인트), 세션/잠금 흐름
- `/docs/ADR.md` — ADR-003(주입형 Model 계약, transport 격리)
- `/docs/ARCHITECTURE.md` — 프론트 MVC(View←Controller←Model)
- `server/index.js`(step8 — 실제 엔드포인트/응답 shape), `web/src/main.jsx`(step0 placeholder)

## 작업

프론트엔드 Model 계층을 구현한다. View/Controller가 transport-agnostic하도록 **계약 뒤에 REST/SSE를 격리**한다. TDD(vitest).

1. `web/src/model/contract.js`:
   - `export const MODEL_KEYS = Object.freeze([ 'login','logout','queryUsers','queryArticles','searchArticles','searchMedia','applyAction','saveArticle','lockArticle','unlockArticle','forceUnlockArticle','queryReceiverConfig','createReceiverConfig','deleteReceiverConfig','subscribe' ])`
   - `export function assertModel(model)` — 모든 키가 함수인지 검증(누락 시 throw).
2. `web/src/model/httpModel.js` — `export function createHttpModel({ base } = {})`:
   - `base` 기본값은 `import.meta.env.VITE_API_BASE ?? 'http://127.0.0.1:3001'`.
   - 각 MODEL_KEYS 메서드를 step8 라우트에 매핑(fetch, JSON, **저장된 `x-session-id` 헤더 자동 첨부**, 로그인 응답의 sessionId 보관).
   - `subscribe(filter, onChange)` — `EventSource('/api/stream?session=...')`로 `change` 수신, `{ unsubscribe, connected }` 반환, 끊기면 자동 재연결.
3. `web/src/test/fakeModel.js` — `export function createFakeModel(seed)` — MODEL_KEYS를 모두 구현한 in-memory 가짜(테스트/스토리에서 주입). assertModel 통과해야 함.
4. `web/src/main.jsx` 갱신 — `createHttpModel()`를 만들어 `<App model={model} />`로 주입(App은 step10에서 완성; 지금은 placeholder App에 model prop 전달 형태만).
5. 테스트(`web/src/model/*.test.js`): contract assertModel, httpModel이 올바른 URL/메서드/헤더로 fetch하는지(전역 fetch/EventSource mock), fakeModel이 계약을 만족하는지.

## Acceptance Criteria

```bash
npm run lint
npm run build
npm run test:web
```

## 검증 절차

1. AC 실행(build로 vite가 main.jsx+model을 번들하는지 포함).
2. 체크리스트: 모든 transport(fetch/EventSource)가 httpModel 안에만 있는가? assertModel이 계약을 강제하는가? fakeModel이 계약을 만족하는가? x-session-id가 자동 첨부되는가?
3. step 9 업데이트(completed + summary: MODEL_KEYS, createHttpModel/createFakeModel 시그니처).

## 금지사항

- View/컴포넌트에서 직접 fetch/EventSource를 호출하지 마라. 이유: ADR-003 — transport는 Model 뒤에만.
- 계약(MODEL_KEYS)을 step8 라우트와 어긋나게 만들지 마라. 이유: 단일 통합 seam.
- 기존(백엔드) 테스트를 깨뜨리지 마라.
