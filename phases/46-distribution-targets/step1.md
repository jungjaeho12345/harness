# Step 1: service-routes

## 목표

step0의 `distributionTargetModel` 위에 **배부 대상 도메인 서비스**(`src/services/distributionTargetService.js`)와
그 서비스를 노출하는 **Z 전용 세션 게이트 REST 라우트**(`server/index.js`)를 만든다. 입력 검증(특히 **spoolDir 경로 조작 차단**)이
이 step의 핵심 보안 책임이다.

배경(자기완결):
- 배부 아키텍처의 단일 출처는 **ADR-008**이다. 앱은 배부 스풀 디렉토리에 파일을 쓰기만 하고 네트워크 발송은 외부 전송기가 한다.
  **이번 phase(46)는 대상(수신처) 관리 CRUD만** 다룬다 — 스풀 파일 쓰기·`Contents.distributedAt` 기록·EPS→DPS 전이·tick은 phase 47/48이다.
- `spoolDir`는 phase 47에서 **스풀 루트 아래 하위 폴더명**으로 실제 파일 경로에 합성된다. 따라서 지금 저장 단계에서
  경로 조작(절대경로·`..`·구분자·드라이브 문자·널바이트)을 **거부**해 두는 것이 유일한 방어 지점이다.
- 신뢰 경계는 서버다(**ADR-004**): acting role은 검증된 `x-session-id`(또는 세션 쿠키) 세션에서만 도출하고,
  `req.body.role`·`req.query.role`은 절대 읽지 않는다.

## 읽어야 할 파일

라인 번호는 실측 힌트 — 반드시 심볼명으로 재확인하라.

- `docs/ADR.md` — **ADR-008**(L45~48) 전문, **ADR-004**(신뢰경계=서버 세션, L25~28), **ADR-007**(앱 내 타이머/외부 egress 없음, L40~43), ADR-006(얇은 transport).
- `docs/ARCHITECTURE.md` — "얇은 transport", "보안 경계".
- `CLAUDE.md` — DB 비파괴·TDD·커밋 형식.
- **step0 산출물**(이번 step의 입력): `src/db/schema.js`(DistributionTarget 엔트리), `src/models/distributionTargetModel.js`
  (`createDistributionTargetModel(db) -> { query, findById, insert, update }` — **remove 없음**), `docs/SCHEMA.md`의 `## DistributionTarget Table`.
- `src/services/receiverConfigService.js` — **전체**(41줄). 게이트 우선 호출(`authorization.manageReceiverConfig` → `if (!gate.ok) return gate`),
  `SAFE_FIELDS` allowlist + `sanitize` 응답 정제, `{ ok: true, items }` / `{ ok: true, id }` 응답 shape. **구조 청사진**(내용 재사용 아님).
- `src/services/authorization.js` — **전체**(58줄). `CAPABILITIES`(L6~10), `manageReceiverConfig(sessionId, op, payload)`(L49~55),
  반환 객체(L57). 이번에 **동형 capability 1개를 additive로 추가**한다.
- `src/services/fileRef.js` — **전체**(21줄). 순수 거부 기반 sanitize 헬퍼의 계약(유효하면 원문, 아니면 `''`)·주석 스타일. spoolDir 검증기의 형태 청사진.
- `src/services/photoService.js` — 검증 실패를 `{ ok: false, reason: 'invalid-src' }`로 돌려주는 패턴(L13~25)과 "세션에서 도출한 값만 stamp" 규율.
- `src/controllers/index.js` — **전체**(112줄). 모델 결선(L31~36) → 서비스 결선(L41~49) → 도메인 진입점(`receiverConfig` L95~99) → `return`(L111).
- `server/index.js` — `createApp({...})`(L173~), `readSessionToken(req)`(L289~291), `sessionOf(req)`(L300~303),
  `fail(res, result, fallback = 400)`(L102~104), `STATUS_BY_REASON`(L84~100), **수신 설정 라우트 블록**(L386~406 — 배치·형태 청사진),
  그 아래 `// --- 기사 조회/검색 ---`(L408~).
- `test/receiverConfigService.test.js` — **전체**(130줄). 서비스 테스트 하네스(in-memory DB + 실제 sessionService/authorization + 역할별 세션 발급).
- `test/photos-api.test.js` L1~80 — 라우트 테스트 하네스(`createControllers` + `createApp` + `app.listen(0)` + `fetch` 헬퍼 + `seedUser`/`login`).
- `test/controllers.test.js` L40~45 — **`Object.keys(controllers)` 정확 집합 단언**(현재 8개). 이번 결선으로 **반드시 갱신 대상**이다.

## 작업

### 1) 테스트 먼저 (TDD — red 확인 후 구현)

**a. `test/spoolDir.test.js` 신규** — 순수 검증기 전수 테스트.

허용(원문 그대로 반환):
- `'kbs'`, `'yonhap-tv'`, `'press_01'`, `'a'`, 길이 64 문자열.

거부(빈 문자열 `''` 반환) — **아래 케이스는 전부 테스트에 넣어라**:

| 입력 예 | 차단 이유 |
|---------|-----------|
| `''`, `'   '` | 빈 값 |
| `'/etc/passwd'`, `'/kbs'` | 절대경로(POSIX) |
| `'..'`, `'../secret'`, `'a/../../b'` | traversal |
| `'a/b'`, `'a\\b'` | 경로 구분자(슬래시/백슬래시) |
| `'C:\\spool'`, `'c:'` | 드라이브 문자 |
| `'kbs\u0000.txt'` | 널바이트 |
| `'kbs '`, `' kbs'`, `'k bs'`, `'kbs\n'` | 공백/제어문자 |
| `'.hidden'`, `'-kbs'`, `'_kbs'` | 선행 dot/구분기호(dotfile·옵션 오인) |
| `'KBS'`, `'한국방송'`, `'kbs★'` | 화이트리스트 밖 문자(대문자/유니코드/기호) |
| 65자 이상 | 길이 초과 |
| `'con'`, `'NUL'`, `'com1'`, `'lpt9'`, `'aux'`, `'prn'` | Windows 예약 장치명(대소문자 무시 — 그 이름의 폴더를 만들 수 없다) |
| `null`, `undefined`, `123`, `true`, `{}`, `[]` | **비문자열 입력 — 강제변환 금지**(throw도 금지, `''` 반환) |

> **비문자열 거부는 이 검증기의 핵심 케이스다.** `String(null)==='null'`, `String(undefined)==='undefined'`,
> `String(123)==='123'`, `String(true)==='true'`는 **전부 화이트리스트 정규식을 통과한다**(실측 확인).
> 즉 `String(value)`로 강제변환한 뒤 정규식을 돌리면 `{"spoolDir": null}`이나 필드 누락 요청이
> `spoolDir='null'`/`'undefined'` 행을 만들고, phase 47이 그 문자열을 스풀 루트에 합성해
> **타입 오류가 실제 디렉토리명이 된다**. 반드시 `typeof` 검사로 선차단하라.

**b. `test/distributionTargetService.test.js` 신규**(`receiverConfigService.test.js` 하네스 차용):

- Z 세션: `create` → `{ ok: true, id }`, `query` → `{ ok: true, items }`(등록한 행이 조회됨), `update` → `{ ok: true, changes: 1 }`,
  `deactivate` → `{ ok: true, changes: 1 }` 후 **행이 남고 `active==='N'`**.
- 비-Z(R/D) 세션은 4개 op 전부 `reason: 'forbidden'`, 미인증/무효 세션은 `'unauthenticated'`.
- **게이트가 모델 호출 자체를 차단**한다: 비-Z가 `create`를 시도해도 모델 조회에 행이 생기지 않는다.
- 검증 거부(모두 `ok:false` + 지정 reason, **DB에 행이 생기지 않는다**):
  - `invalid-name`: 빈 문자열 / 공백만 / 100자 초과 / **키 누락(undefined)** / `null` / `123` / `{}`
    (**비문자열 4종은 필수 케이스다** — `String(undefined).trim()==='undefined'`가 통과해 `name='undefined'` 행이 생기는 결함을 잠근다)
  - `invalid-kind`: `'press'|'nonpress'` 외 — `'PRESS'`, `''`, `undefined`, `'other'`, `null`, `123`
  - `invalid-spool-dir`: 위 거부 표에서 대표 5종 이상(최소 `'../x'`, `'a/b'`, `'/abs'`, `'C:\\x'`, 널바이트)
    **+ `null`·`undefined` 2종 필수**(키 누락 포함 — `spoolDir='null'`/`'undefined'` 행 방지)
  - `invalid-active`: `'Y'|'N'` 외(`'y'`, `''`, `1`, `null`)
  - `duplicate-spool-dir`: 같은 spoolDir 재등록 — 비활성 행과의 충돌 포함
- `update`는 **present-only**: 전달한 필드만 검증·반영하고 미전달 필드는 불변. 전달된 필드가 규칙 위반이면 거부하고 **아무것도 저장하지 않는다**.
- `update`로 `spoolDir`를 자기 자신과 같은 값으로 다시 저장하는 것은 `duplicate-spool-dir`가 **아니다**(자기 자신 제외).
- 없는 id의 `update`/`deactivate` → `reason: 'not-found'`.
- **비활성 두 경로의 동치성**: 같은 초기 행에 대해 `update(id, { active: 'N' })`를 적용한 결과 행과
  `deactivate(id)`를 적용한 결과 행이 **동일한 상태**여야 한다(`active==='N'`이고 `updatedAt`이 양쪽 모두 stamp되며
  다른 컬럼은 불변). 주입 시계(`now`)를 고정해 결정적으로 비교하라 — 두 경로가 같은 내부 헬퍼를 쓰는지 잠그는 가드다.
- `createdAt`/`updatedAt`은 **서버가 stamp**한다: 클라이언트가 `createdAt: '1999-01-01'`, `id: 999`를 보내도 무시된다.
- 응답 정제: `query` 결과 item은 `SAFE_FIELDS` 키만 갖는다(향후 시크릿 컬럼 추가 시 자동 비노출 — allowlist 가드 테스트).
- `deactivate` 후 같은 DB의 `Article`/`Contents` 행이 보존된다(DB 비파괴 가드).
- 노출 메서드 가드: `assert.deepEqual(Object.keys(service).sort(), ['create', 'deactivate', 'query', 'update'])` — `remove`/`delete` 없음.

**c. `test/distribution-targets-api.test.js` 신규**(`photos-api.test.js` 하네스 차용):

- 미인증: 4개 라우트 전부 **401** `unauthenticated`.
- 비-Z(R/D) 로그인: 4개 라우트 전부 **403** `forbidden`.
- Z 로그인 풀 루프: `POST` 등록 → `GET` 목록에 나타남 → `PUT` 수정 반영 → `POST .../deactivate` 후 목록에 **여전히 존재**하고 `active==='N'`.
- **신뢰 경계**: R 세션이 `body: { role: 'Z', ... }`를 보내도 **403**이다(body의 role은 무시된다).
- 잘못된 spoolDir로 `POST` → **400** `invalid-spool-dir`, 잘못된 kind → 400 `invalid-kind`.
- 없는 id `PUT`/`deactivate` → **404** `not-found`.
- **비수치 `:id` 회귀 잠금**: `PUT /api/distribution-targets/abc`와 `POST /api/distribution-targets/abc/deactivate`
  각 1건 → **404** `not-found`(500이 아니다). 근거: `Number('abc')`는 `NaN`이고 node:sqlite는 NaN 바인딩을
  예외 없이 처리해 행 미매치로 수렴한다(실측 확인 — `.get(NaN)`은 `undefined`, `UPDATE ... WHERE id=NaN`은 `changes:0`).
  즉 현재 설계는 이미 안전하며, 이 테스트는 그 성질을 **잠그는** 회귀 가드다(향후 id 처리 변경 시 여기서 터진다).
- **`DELETE /api/distribution-targets/:id`는 라우트가 없다** — Express 기본 404(핸들러 미등록)를 단언해 회귀 시 드러나게 하라.

**d. `test/controllers.test.js` 갱신**: `Object.keys(controllers).sort()` 기대값에 `'distributionTarget'`을 추가하고
(8개 → 9개, 테스트 제목의 "8개 도메인"도 현행화), `controllers.distributionTarget`의 4개 메서드가 함수인지 단언한다.

### 2) `src/services/spoolDir.js` 신규 — 순수 검증기

```js
// 배부 스풀 하위 폴더명 검증 — 순수 헬퍼(부수효과·외부 의존 없음). 규칙의 단일 출처.
export function sanitizeSpoolDir(value); // 유효하면 원문 문자열, 아니면 '' (fileRef.js와 동형 계약)
```

검사 순서를 아래대로 **고정**한다(순서가 곧 계약이다):

1. **타입 게이트 — `typeof value !== 'string'`이면 즉시 `''` 반환.** 강제변환(`String(value)`)을 **하지 마라**.
   이유: `String(null)==='null'`, `String(undefined)==='undefined'`, `String(123)==='123'`, `String(true)==='true'`가
   아래 화이트리스트를 **전부 통과한다**(실측 확인) — 강제변환하면 검증기가 무력화된다. throw도 하지 않는다(`''` 반환).
2. **화이트리스트**: `/^[a-z0-9][a-z0-9_-]{0,63}$/` (소문자 영숫자로 시작, 이후 영숫자·`-`·`_`, 총 1~64자).
   이 한 줄이 절대경로·`..`·`/`·`\`·`:`·널바이트·공백·제어문자·유니코드·대문자를 **전부** 거부한다.
3. **예약 장치명 거부**: Windows 예약명(`con prn aux nul com1~com9 lpt1~lpt9`) — 소문자 비교로 거부.
   이유: 그 이름의 디렉토리는 Windows에서 생성 불가라 phase 47이 무조건 실패한다.
4. 위를 모두 통과하면 **원문 그대로** 반환한다(정규화·소문자 변환·trim 금지 — 입력을 고쳐서 통과시키지 않는다).
- 파일 상단 주석에 "phase 47에서 스풀 경로에 합성되는 값이므로 저장 시점이 유일한 방어 지점" + "여기서 디렉토리를 만들지 않는다(ADR-008)"를 명시한다.

### 3) `src/services/authorization.js` — capability 1개 additive 추가

- `CAPABILITIES`에 `manageDistributionTarget: ['Z'], // 배부 대상(수신처) CRUD — Z 전용 (ADR-008)` 추가.
- `manageDistributionTarget(sessionId, op, payload)`를 `manageReceiverConfig`(L49~55)와 **동형**으로 추가하고 반환 객체에 포함한다.
- 기존 함수(`assertAuthorized`/`editDps`/`manageUsers`/`manageReceiverConfig`)는 **한 글자도 수정하지 않는다**.

### 4) `src/services/distributionTargetService.js` 신규

```js
export function createDistributionTargetService({
  distributionTargetModel,
  authorization,
  now = () => new Date().toISOString(), // 주입 가능한 시계(테스트 결정성)
}) {
  // query(sessionId, filters = {})   -> { ok: true, items } | 게이트/거부 결과
  // create(sessionId, entry = {})    -> { ok: true, id }
  // update(sessionId, id, fields={}) -> { ok: true, changes }
  // deactivate(sessionId, id)        -> { ok: true, changes }   // active='N' — 행 삭제 아님
  return { query, create, update, deactivate };
}
```

규칙(전부 서비스 계층에서 강제):

| 항목 | 규칙 | 위반 reason |
|------|------|-------------|
| 게이트 | 모든 op는 **첫 줄에서** `authorization.manageDistributionTarget(sessionId, op, payload)` 호출 → `!gate.ok`면 그대로 반환 | `unauthenticated` / `forbidden` |
| `name` | 필수. **`typeof name !== 'string'`이면 즉시 거부**(강제변환 금지 — `String(undefined)==='undefined'`가 통과하는 결함 차단). 그 다음 `name.trim()`이 비어있지 않고 길이 ≤ 100. 저장은 trim된 값 | `invalid-name` |
| `kind` | `'press'` \| `'nonpress'` 정확 일치만(대소문자 보정 없음 — 집합 검사이므로 비문자열은 자연 거부) | `invalid-kind` |
| `spoolDir` | 필수. `sanitizeSpoolDir(spoolDir)`가 `''`이면 거부(검증기가 타입 게이트를 포함한다). 저장은 검증 통과한 값 | `invalid-spool-dir` |
| `spoolDir` 유일성 | 다른 행(비활성 포함)이 같은 `spoolDir`를 쓰면 거부. update 시 **자기 자신은 제외** | `duplicate-spool-dir` |
| `active` | 미지정이면 `'Y'`. 지정 시 `'Y'`\|`'N'` 정확 일치만(집합 검사) | `invalid-active` |
| 타임스탬프 | `createdAt`은 create에서만, `updatedAt`은 create/update/deactivate에서 **서버가** `now()`로 stamp. 클라이언트 값은 무시 | — |
| id | 클라이언트가 보낸 `id`는 무시(insert 대상 아님). update/deactivate의 id는 인자로만 받는다 | — |
| 존재 확인 | update/deactivate는 `findById`로 존재를 확인하고 없으면 거부 | `not-found` |
| 응답 정제 | `SAFE_FIELDS = ['id','name','kind','spoolDir','active','createdAt','updatedAt']` allowlist + `sanitize`(receiverConfigService 동형) | — |
| 필터 정규화 | `query`의 filters는 허용 키(`id,name,kind,spoolDir,active`)만 pick하고 **문자열/숫자 원시값만** 통과(배열·객체는 무시) | — |

- 검증은 **write 경로(create/update)에서만** 강제한다. 이미 저장된 행은 조회를 거부하지 않는다(기존 데이터 보존 — 비파괴).
- **비활성 경로 일원화**: `deactivate(sessionId, id)`는 자체 SQL/자체 stamp 로직을 갖지 않고,
  `update`가 쓰는 것과 **동일한 내부 헬퍼**(예: `applyPatch(id, patch)` — 존재 확인 → `updatedAt` stamp → `model.update`)를
  `{ active: 'N' }`로 호출한다. 이유: `PUT /:id`(body `{active:'N'}`)와 `POST /:id/deactivate`가 같은 상태 전이를
  수행하므로 두 경로의 결과가 갈라지면(예: 한쪽만 `updatedAt` stamp) 감사 기록이 경로에 따라 달라진다.
  게이트 호출과 op 이름만 각 진입점이 갖고, 상태 변경은 한 곳에서만 일어나야 한다.
- 파일 상단 주석에 "배부 실행(스풀 파일 쓰기·distributedAt·상태 전이)은 이 서비스의 책임이 아니다 — phase 47(ADR-008)"을 명시한다.

### 5) `src/controllers/index.js` — 결선

- `createDistributionTargetModel` / `createDistributionTargetService` import 추가.
- 모델·서비스 결선(`const distributionTargetModel = createDistributionTargetModel(db);`,
  `const distributionTargetService = createDistributionTargetService({ distributionTargetModel, authorization });`).
- 도메인 진입점(`receiverConfig` 블록 아래, 동형):
  ```js
  const distributionTarget = {
    query: (sessionId, filters) => distributionTargetService.query(sessionId, filters),
    create: (sessionId, entry) => distributionTargetService.create(sessionId, entry),
    update: (sessionId, id, fields) => distributionTargetService.update(sessionId, id, fields),
    deactivate: (sessionId, id) => distributionTargetService.deactivate(sessionId, id),
  };
  ```
- `return { ... , distributionTarget }`에 추가. 비즈니스 로직은 컨트롤러에 두지 않는다(위임만).

### 6) `server/index.js` — Z 전용 라우트 4개

수신 설정 라우트 블록(L386~406) **바로 아래**, `// --- 기사 조회/검색 ---` **앞**에 배치한다.
헤더 주석: `// --- 배부 대상 (Z 전용 — 게이트는 distributionTargetService가 강제, ADR-008) ---`

| 메서드 | 경로 | 위임 |
|--------|------|------|
| GET | `/api/distribution-targets` | `controllers.distributionTarget.query(readSessionToken(req), req.query)` |
| POST | `/api/distribution-targets` | `controllers.distributionTarget.create(readSessionToken(req), req.body ?? {})` |
| PUT | `/api/distribution-targets/:id` | `controllers.distributionTarget.update(readSessionToken(req), Number(req.params.id), req.body ?? {})` |
| POST | `/api/distribution-targets/:id/deactivate` | `controllers.distributionTarget.deactivate(readSessionToken(req), Number(req.params.id))` |

`PUT /:id`(body에 `active:'N'` 포함 가능)와 `POST /:id/deactivate`는 **같은 상태 전이의 두 진입점**이다 —
§4의 "비활성 경로 일원화"에 따라 서비스 내부에서 동일 헬퍼로 수렴하므로 라우트에서 분기 로직을 두지 마라.
(하위경로 POST로 부수효과를 표현하는 것은 기존 관례다 — `/action`, `/lock`, `/unlock`, `/force-unlock`.)

- 각 핸들러는 수신 설정 라우트와 **동형**으로 `try { const r = ...; return r.ok ? res.json(r) : fail(res, r); } catch (e) { next(e); }` 형태만 가진다(로직 금지).
- `STATUS_BY_REASON`은 **수정하지 않는다**: `not-found`는 이미 404로 매핑돼 있고, 검증 거부 reason들은 `fail`의 기본 fallback 400으로 정확히 떨어진다.
- 세션 판독은 반드시 `readSessionToken(req)`(쿠키 우선 + `x-session-id` 폴백)를 쓴다.

## Acceptance Criteria

```bash
npm test
npm run lint
```

- `npm test` **전부 통과, 실패 0**. 통과 개수는 **step0 완료 시점 이상**이어야 한다(신규 테스트만큼 증가 — 감소하면 회귀).
- `npm run lint` clean(경고 0).
- web 무접촉이므로 `npm run test:web`/`npm run build`는 이 step의 AC가 아니다.

## 검증 절차

0. **진행 순서를 고정한다**(이 step은 소스 4 + 테스트 4로 이 phase에서 가장 무겁다 — 중단 시 부분 산출물 정리 비용을 줄이기 위함):
   **① 검증기 + 서비스**(`spoolDir.js` → `authorization.js` capability → `distributionTargetService.js`)를
   `test/spoolDir.test.js` + `test/distributionTargetService.test.js`로 **완전히 green**으로 만든 뒤,
   **② 컨트롤러 결선 + 라우트**(`controllers/index.js` → `server/index.js`)를 `test/distribution-targets-api.test.js` +
   `test/controllers.test.js`로 green으로 만든다. ①이 그린이 되기 전에 ②를 시작하지 마라 — ①만으로도
   그 자체로 완결된(HTTP 비의존) 산출물이라 중단 시 그대로 커밋 가능하다.
1. 3개 테스트 파일을 먼저 작성해 **red**(모듈 없음/라우트 404)를 확인한 뒤 구현한다.
2. 보안 체크리스트 — 아래가 전부 테스트로 증명되어야 한다:
   - [ ] 미인증 401 · 비-Z 403(4개 라우트 전부)
   - [ ] `body.role: 'Z'` 스푸핑이 통하지 않는다
   - [ ] spoolDir 거부 케이스(절대경로·`..`·`/`·`\`·드라이브문자·널바이트·예약명) 전부 400
   - [ ] **비문자열(`null`/`undefined`/숫자/불리언/객체) name·spoolDir이 거부된다** — `'null'`/`'undefined'` 문자열 행이 만들어지지 않는다
   - [ ] `DELETE /api/distribution-targets/:id` 라우트가 존재하지 않는다
   - [ ] `deactivate` 후 행이 남고 `active==='N'`, Article/Contents 무손상
3. `grep -rn "req.body.role\|req.query.role" server/index.js src/services/distributionTargetService.js` → **0건**.
4. `grep -rn "node:fs\|node:path\|setInterval\|setTimeout\|fetch(" src/services/distributionTargetService.js src/services/spoolDir.js` → **0건**.
   추가로 `grep -n "String(" src/services/spoolDir.js src/services/distributionTargetService.js` → **spoolDir/name 검증 경로에 0건**
   (강제변환은 검증 무력화 경로다 — 타입 게이트로 대체됐는지 확인).
5. `grep -rn "DELETE FROM\|DROP TABLE" src/services src/models server/index.js` → 신규 코드에 **0건**(기존 `receiverConfigModel.remove`는 무접촉).
6. `git diff --stat`에 `web/**` 파일이 **없어야** 한다.

## 커밋 계획

- **feat**: `feat(46-distribution-targets): step1 — distributionTargetService(검증·Z 게이트) + spoolDir 슬러그 검증기 + 배부대상 REST 라우트`
  — `src/services/spoolDir.js`, `src/services/distributionTargetService.js`, `src/services/authorization.js`,
  `src/controllers/index.js`, `server/index.js`, `test/spoolDir.test.js`, `test/distributionTargetService.test.js`,
  `test/distribution-targets-api.test.js`, `test/controllers.test.js`.
- **chore**: `chore(46-distribution-targets): step1 status — completed` — index.json만. 코드와 분리 커밋.

## 금지사항

- `req.body.role`·`req.query.role`·클라이언트가 보낸 어떤 신원 값도 읽지 마라. 이유: ADR-004 — acting role은 검증된 세션에서만 도출한다. 읽는 순간 권한 상승이 가능해진다.
- `DELETE /api/distribution-targets/:id` 라우트나 서비스 `remove`를 만들지 마라. 이유: DB 비파괴 — 제거는 `active='N'` soft delete가 유일한 경로이고, 삭제 경로가 존재하면 언젠가 호출된다.
- `node:fs`/`node:path`를 import하거나 `spoolDir`로 디렉토리 생성·파일 쓰기·존재 확인을 하지 마라. 이유: ADR-008 — 스풀 쓰기는 phase 47의 책임이고, 대상 등록이 파일시스템 상태에 의존하면 테스트가 비결정적이 된다.
- `setInterval`/`setTimeout`/`fetch`/외부 네트워크 호출을 넣지 마라. 이유: ADR-007·ADR-008 — 앱 내 타이머와 egress는 금지다(시점 배부는 phase 48의 tick pull 엔드포인트가 담당한다).
- `Contents.distributedAt`·기사 상태 전이(EPS→DPS)·`ArticleHistory` 기록을 건드리지 마라. 이유: 배부 실행은 phase 47 범위 — 여기서 섞으면 리뷰 게이트가 무력화되고 롤백 단위가 사라진다.
- `receiverConfigService`/`manageReceiverConfig`/`collectionService`를 수정하거나 배부에 재사용하지 마라. 이유: ADR-008 (2) — ReceiverConfig는 수집(inbound) 전용이다.
- 검증 대상 입력(`name`·`spoolDir`)에 `String(value)` 강제변환을 쓰지 마라. 이유: `String(null)==='null'`, `String(undefined)==='undefined'`, `String(123)==='123'`가 화이트리스트를 **통과**해 `spoolDir='null'` 같은 행이 저장되고, phase 47에서 그 문자열이 실제 디렉토리명이 된다 — 반드시 `typeof` 게이트로 선차단하라.
- 실패하는 검증 테스트를 만나면 테스트를 완화하지 말고 **구현을 고쳐라**(특히 비문자열 거부 케이스). 이유: 그 케이스들이 이 step의 실질 보안 계약이다.
- spoolDir 검증 규칙을 라우트·모델·프론트에 **재구현**하지 마라. 이유: `fileRef.js` 주석이 못박은 원칙 — 규칙이 두 곳에 있으면 발산해 우회 벡터가 된다. `sanitizeSpoolDir`가 유일한 출처다.
- 검증을 조회(read) 경로에 적용해 기존 행을 숨기지 마라. 이유: 과거에 저장된 값이 새 규칙에 걸리면 관리 화면에서 영영 보이지 않아 수정조차 못 한다(비파괴 원칙 위배).
- `app.notifyChange`/SSE 브로드캐스트를 추가하지 마라. 이유: `/api/stream`은 기사 무효화 신호 계약이다(ADR-005) — 관리 화면은 수신설정 관리와 동형으로 수동 조회면 충분하고, 신호 종류를 늘리면 전 클라이언트가 재조회한다.
- `web/**`를 수정하지 마라. 이유: 계약 3면은 step2, UI는 step3 — 레이어 혼입 금지.
- 기존 테스트를 삭제하거나 약화시키지 마라(`test/controllers.test.js`는 **갱신**이지 삭제가 아니다).
