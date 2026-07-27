# Step 2: model-contract

## 목표

step1의 배부 대상 REST 라우트를 프론트엔드 **Model 계약 3면**에 잇는다:
`contract.js`(MODEL_KEYS) · `httpModel.js`(실제 REST 배선) · `test/fakeModel.js`(in-memory 가짜).
**View/Controller는 이 step에서 손대지 않는다**(UI는 step3).

배경(자기완결):
- ADR-003: 프론트는 `freeze`된 `MODEL_KEYS` 계약을 따르는 주입형 Model을 쓴다. `App`은 마운트 시 `assertModel(model)`로
  **모든 키가 함수인지 런타임 검증**하므로, 계약에 키를 추가하면 `httpModel`과 `fakeModel`을 **같은 커밋에서 함께** 채워야 한다
  (하나라도 빠지면 앱 전체가 throw하고 web 테스트가 광범위하게 깨진다).
- 서버 계약(step1 산출)은 아래 4개 라우트다. 응답 shape을 **1:1**로 맞춘다.

| 메서드 | 경로 | 응답 |
|--------|------|------|
| GET | `/api/distribution-targets` (쿼리 필터: `id,name,kind,spoolDir,active`) | `{ ok: true, items: [...] }` |
| POST | `/api/distribution-targets` (body: `{ name, kind, spoolDir, active? }`) | `{ ok: true, id }` |
| PUT | `/api/distribution-targets/:id` (body: 변경 필드만) | `{ ok: true, changes }` |
| POST | `/api/distribution-targets/:id/deactivate` (body 없음) | `{ ok: true, changes }` |

거부 응답: `{ ok: false, reason }` — `unauthenticated`(401) / `forbidden`(403) / `not-found`(404) /
`invalid-name` · `invalid-kind` · `invalid-spool-dir` · `invalid-active` · `duplicate-spool-dir`(400).

item shape: `{ id, name, kind: 'press'|'nonpress', spoolDir, active: 'Y'|'N', createdAt, updatedAt }`.
**비활성(`active='N'`) 행도 목록에 그대로 남는다**(서버가 soft delete이므로 — 행이 사라지지 않는다).

## 읽어야 할 파일

라인 번호는 실측 힌트 — 반드시 심볼명으로 재확인하라.

- `docs/ADR.md` — **ADR-003**(주입 가능한 Model 계약, L20~23), ADR-008(배부 아키텍처), ADR-004(신뢰 경계).
- `docs/ARCHITECTURE.md` — "프론트엔드 MVC".
- **step1 산출물**(이번 step의 입력): `server/index.js`의 `// --- 배부 대상 (Z 전용 ...) ---` 라우트 블록,
  `src/services/distributionTargetService.js`(응답 shape·reason 목록), `test/distribution-targets-api.test.js`(실제 응답 예시).
- `web/src/model/contract.js` — **전체**(51줄). `MODEL_KEYS`(L5~39, 현재 **28개**)·`assertModel`(L42~51).
- `web/src/model/contract.test.js` — **전체**. **L6~13의 `expect(MODEL_KEYS).toHaveLength(28)`** ← 이번에 반드시 갱신해야 하는 지점.
  `createFakeModel` describe(L71~)의 라운드트립 테스트 스타일(`publishPhoto→searchPhotos` L170~194)이 이번 루프 테스트의 청사진이다.
- `web/src/model/httpModel.js` — `createHttpModel({ base })`의 `request(path, { method, body, query, clientId })`(L76~96),
  `buildQuery`(L61~71), **수신 설정 3메서드 블록(L235~244)** ← 새 블록을 이 바로 아래에 배치한다.
- `web/src/model/httpModel.test.js` — `publishPhoto`/`searchPhotos` 케이스(L416~447): `fetchMock`·`callAt(0)`·`jsonResponse` 하네스,
  URL/`init.method`/`init.credentials`/`JSON.parse(init.body)` 단언 형식.
- `web/src/test/fakeModel.js` — **전체**(265줄). seed 배열 선언부(L13~24), `seq` 카운터(L28),
  수신 설정 3메서드(L224~236 — **`deleteReceiverConfig`의 `splice`는 이번에 복제하면 안 되는 부분**).

## 작업

### 1) 테스트 먼저 (TDD — red 확인 후 구현)

**a. `web/src/model/contract.test.js`**

- `toHaveLength(28)` → **`toHaveLength(32)`**로 갱신하고 it 제목의 "28 contract methods"도 현행화한다.
- 새 it: 배부 대상 키 4개가 `MODEL_KEYS`에 있다
  (`queryDistributionTargets`, `createDistributionTarget`, `updateDistributionTarget`, `deactivateDistributionTarget`).
- 새 it(`createFakeModel` describe): **등록 → 조회 루프**
  - `createDistributionTarget({ name: 'KBS', kind: 'press', spoolDir: 'kbs' })` → `{ ok: true, id }`
  - `queryDistributionTargets()` → 그 항목이 `{ id, name: 'KBS', kind: 'press', spoolDir: 'kbs', active: 'Y' }`로 조회된다(active 기본값 'Y').
  - 반환 `items`는 **복사본**이다(반환 객체를 고쳐도 다음 조회 결과가 오염되지 않는다 — `searchPhotos` 테스트 L190~193 형식).
- 새 it: **비활성은 행을 지우지 않는다** — `deactivateDistributionTarget(id)` 후 `queryDistributionTargets()`에
  그 항목이 **여전히 존재**하고 `active === 'N'`이다(서버 soft delete와 동형).
- 새 it: `updateDistributionTarget(id, { name: '한국방송' })`가 present-only로 반영되고 나머지 필드는 불변,
  없는 id는 `{ ok: false, reason: 'not-found' }`(update/deactivate 둘 다).
- 새 it: `queryDistributionTargets({ active: 'Y' })` / `({ kind: 'press' })`가 동등 필터로 걸러 준다.

**b. `web/src/model/httpModel.test.js`** (수신 설정/사진 케이스와 동형, 각 메서드 1건 이상)

- `queryDistributionTargets({ active: 'Y' })` → `GET`, `pathname === '/api/distribution-targets'`,
  `searchParams.get('active') === 'Y'`, `init.body === undefined`, `init.credentials === 'include'`.
- `createDistributionTarget({...})` → `POST /api/distribution-targets`, body가 전달 payload와 정확히 일치하고
  **`body.role`이 undefined**다(ADR-004 — 신원/역할은 어떤 형태로도 싣지 않는다).
- `updateDistributionTarget(7, { name: 'x' })` → `PUT /api/distribution-targets/7`, body `{ name: 'x' }`.
- `deactivateDistributionTarget(7)` → `POST /api/distribution-targets/7/deactivate`, **body 없음**(`init.body === undefined`).
- 응답 JSON을 가공 없이 그대로 반환한다(`{ ok: true, id: 3 }` 등).

### 2) `web/src/model/contract.js`

`MODEL_KEYS`의 수신 설정 키(`queryReceiverConfig`/`createReceiverConfig`/`deleteReceiverConfig`) **아래에** 4개를 추가하고,
바로 위에 한 줄 주석으로 출처를 남긴다:
`// 배부 대상 관리(phase 46, distMgmt.do — Z 전용) — /api/distribution-targets 라우트와 1:1. 삭제 없음(비활성=soft delete).`

키 이름은 **고정**이다(기존 `queryUsers`/`createUser`/`updateUser` 명명과 정합):
`queryDistributionTargets`, `createDistributionTarget`, `updateDistributionTarget`, `deactivateDistributionTarget`.

### 3) `web/src/model/httpModel.js`

수신 설정 블록(L235~244) 아래에 배부 대상 블록을 추가한다. 모든 호출은 **`request()` 경유**(직접 `fetch` 금지):

```js
// --- 배부 대상 (Z 전용 — 서버 게이트. 삭제 없음: 비활성은 deactivate) ---
queryDistributionTargets(filters = {}) { /* GET  /api/distribution-targets, query: filters */ },
createDistributionTarget(entry)        { /* POST /api/distribution-targets, body: entry */ },
updateDistributionTarget(id, fields)   { /* PUT  /api/distribution-targets/${encodeURIComponent(id)}, body: fields */ },
deactivateDistributionTarget(id)       { /* POST /api/distribution-targets/${encodeURIComponent(id)}/deactivate, body 없음 */ },
```

- id는 반드시 `encodeURIComponent`로 감싼다(기존 메서드와 동형).
- 역할/신원 값을 body·query에 싣지 마라 — 서버가 세션에서 도출한다.

### 4) `web/src/test/fakeModel.js`

- seed 배열 추가: `const distributionTargets = [...(seed.distributionTargets ?? [])];` (기존 seed 선언부 근처).
- 수신 설정 3메서드 아래에 4메서드를 추가한다:
  - `queryDistributionTargets(filters = {})` → 허용 키(`id,name,kind,spoolDir,active`) 동등 필터 적용 후 `{ ok: true, items: [...복사본] }`.
  - `createDistributionTarget(entry = {})` → `id = seq++`, `active`는 미지정 시 `'Y'`로 채워 push, `{ ok: true, id }`.
  - `updateDistributionTarget(id, fields = {})` → 없는 id면 `{ ok: false, reason: 'not-found' }`,
    있으면 **undefined가 아닌 필드만** 병합하고 `{ ok: true, changes: 1 }`.
  - `deactivateDistributionTarget(id)` → 없는 id면 `not-found`, 있으면 **`active = 'N'`만 설정**하고 `{ ok: true, changes: 1 }`.
- 입력 **검증은 흉내내지 않는다**(fake는 shape 모사 전용 — 검증의 진실은 서버다). 단 `active` 기본값 stamp는 서버와 동형이므로 반영한다.

## Acceptance Criteria

```bash
npm run lint
npm run build
npm run test:web
```

- `npm run test:web`(vitest) **전부 통과, 실패 0**. 통과 개수는 기준선 **1893 이상**(신규 테스트만큼 증가 — 감소하면 회귀).
- `npm run build` clean, `npm run lint` clean(경고 0).
- 백엔드 무접촉이므로 `npm test`는 이 step의 AC가 아니다(실행해도 무해).

## 검증 절차

1. 테스트를 먼저 작성해 red를 확인한다 — 특히 `toHaveLength(32)`가 **28인 상태에서 실패**하는 것을 눈으로 본다.
2. `contract.js` → `httpModel.js` → `fakeModel.js` 순으로 채우고 green 전환을 확인한다.
3. 회귀 체크리스트:
   - [ ] `App.test.jsx`가 그린이다(`createFakeModel`이 `assertModel`을 계속 통과 — 키 누락 시 여기서 대량 실패한다).
   - [ ] 기존 `useRcvMgmtController.test.jsx`·`useUserMgmtController.test.jsx`·`RcvMgmtPage.test.jsx` 그린.
   - [ ] `git diff --stat`에 `web/src/view/**`·`web/src/controller/**`·`web/src/app/**`·`src/**`·`server/**`가 **없다**.
4. `grep -rn "fetch(\|EventSource" web/src/test/fakeModel.js` → **0건**(fake는 네트워크를 쓰지 않는다).
5. `grep -n "splice\|delete " web/src/test/fakeModel.js` 결과에 **배부 대상 메서드가 포함되지 않는지** 확인한다.

## 커밋 계획

- **feat**: `feat(46-distribution-targets): step2 — Model 계약 3면에 배부 대상 4메서드 추가(contract/httpModel/fakeModel)`
  — `web/src/model/contract.js`, `web/src/model/httpModel.js`, `web/src/test/fakeModel.js`,
  `web/src/model/contract.test.js`, `web/src/model/httpModel.test.js`.
- **chore**: `chore(46-distribution-targets): step2 status — completed` — index.json만. 코드와 분리 커밋.

## 금지사항

- `fakeModel`의 `deactivateDistributionTarget`에서 `splice`/`delete`로 행을 제거하지 마라(=`deleteReceiverConfig` L232~236 패턴 복제 금지). 이유: 서버는 soft delete라 행이 남는다 — fake가 행을 지우면 계약이 어긋나 step3 UI 테스트가 실제 서버에서 재현되지 않는 동작을 검증하게 된다.
- `httpModel` 밖에서 `fetch`/`EventSource`를 호출하거나, `httpModel`에 도메인 로직(검증·정렬·필터)을 넣지 마라. 이유: ADR-003 — transport는 `httpModel` 뒤에 격리되고 규칙의 진실은 서버다.
- body/query에 `role`·`userId` 등 신원 값을 넣지 마라. 이유: ADR-004 — 서버가 세션에서 도출한다. 보내는 순간 클라이언트 신뢰가 계약에 스며든다.
- `MODEL_KEYS`에 키를 추가하면서 `httpModel`·`fakeModel` 중 하나라도 비워두지 마라. 이유: `assertModel`이 App 마운트에서 throw해 web 테스트가 전면 실패한다.
- `contract.test.js`의 길이 단언을 **삭제**해 회피하지 마라 — 32로 **갱신**하라. 이유: 그 단언이 3면 동기화를 강제하는 가드다.
- View/Controller/라우팅(`web/src/view/**`, `web/src/controller/**`, `web/src/app/**`)을 수정하지 마라. 이유: UI는 step3 — 계약과 화면을 한 step에 섞으면 실패 원인 격리가 불가능하다.
- 백엔드(`src/**`, `server/**`)를 수정하지 마라. 이유: 서버 계약은 step1에서 확정됐다 — 프론트가 안 맞으면 프론트를 고쳐라.
- 기존 테스트를 삭제하거나 약화시키지 마라(기준: web 1893 통과 · lint/build clean).
