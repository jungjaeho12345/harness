# Step 0: backend-initial-status — 최초 작성 초기 상태 결정 (Z 보류 → DDH)

## 배경 / 요구사항

`docs/news.md` "기사 생애주기" 절에 새 규칙이 추가됐다:

> 권한 Z 사용자가 최초 작성시에 보류는 RDS가 아닌 DDH가 된다. (news.md:208)

**현재 동작**: 신규 기사 저장(`POST /api/articles` → `articleService.create`)은 **역할·액션과 무관하게 항상 `status: 'RDS'`로 하드코딩**되어 있다(`src/services/articleService.js:73`). 즉 Z가 신규 작성 화면에서 "보류"를 눌러도 RDS로 저장된다.

**목표(이 step)**: 서버가 **세션에서 도출한 role**과 **클라이언트가 보낸 의도 action**을 근거로 최초 저장 상태를 결정한다. 규칙은 단 하나의 예외만 둔다:

- `role === 'Z' && action === 'hold'` → `'DDH'`
- 그 외 모든 경우(모든 역할의 송고, D/R의 보류, action 누락) → `'RDS'` (현행 유지)

이 step은 **백엔드(순수 함수 + 서비스 + HTTP 라우트)만** 다룬다. 프론트엔드(신규 저장 시 `action` 전송)는 Step 1에서 한다. 따라서 이 step의 검증은 **서비스/라우트 단위 테스트로만** 한다(브라우저 동작은 Step 1).

## 읽어야 할 파일

먼저 아래 파일들을 읽고 프로젝트의 아키텍처와 설계 의도를 파악하라:

- `/CLAUDE.md` — CRITICAL 규칙(DB 비파괴, TDD)
- `/docs/ARCHITECTURE.md`, `/docs/ADR.md` — 레이어 구조와 ADR-004(신뢰 경계: role/status는 세션·서버에서만 도출), ADR-006(얇은 transport)
- `/docs/news.md` — "기사 생애주기" 절 전체(특히 205~220줄). **최초 작성(create)과 편집 전이(transition)는 별개 경로**라는 점을 이해하라.
- `src/services/lifecycle.js` — 편집 컨텍스트 전이표(`DESK_TABLE`/`REPORTER_TABLE`)와 순수 함수 `transition(status, role, action)`. **이 파일에 새 순수 함수를 추가한다.** Z가 D와 같은 `DESK_TABLE`을 공유하는 점, ACTIONS Set, 파일 상단 주석(최초 송고=RDS는 create가 실현, transition은 편집 전이만)을 정독하라.
- `src/services/articleService.js` — `createArticleService(...)`의 `create(dto)`(66~78줄, status 'RDS' 하드코딩)와 `deriveArticle`(후속/계속 기사가 `create(dto)`를 호출해 RDS를 강제하는 부분, 약 146~174줄). `pick`/`CONTENTS_FIELDS`(status는 여기 없음에 주목).
- `src/controllers/index.js` (또는 `src/controllers/` 하위 article 컨트롤러) — `controllers.article.create`가 service.create를 어떻게 감싸는지. 시그니처 변경 시 이 위임 경로가 role/action을 통과시키는지 확인하라.
- `server/index.js` — `POST /api/articles` 라우트(약 432~447줄). 세션에서 `me.role`을 도출하고 `delete dto.role` 하는 부분, `controllers.article.create(dto)` 호출부.
- `test/lifecycle.test.js` — `transition` 데이터 주도 테스트(ALLOWED/DENIED 표). 같은 스타일로 `initialStatus` 테스트를 추가한다.
- `test/articleService.test.js` — `create`가 RDS로 저장하는지 검증하는 기존 테스트. 회귀 기준.
- 서버 라우트 통합 테스트 파일(예: `test/server.test.js` 또는 `test/api.*.test.js`). `POST /api/articles`를 in-memory db/세션으로 구동하는 기존 테스트 패턴을 찾아 그대로 따른다.

이전 코드를 정독하고 **"role/status는 절대 클라이언트 입력에서 취하지 않는다(ADR-004)"** 불변식을 이해한 뒤 작업하라.

## 작업

TDD로 진행한다. 각 항목마다 테스트를 먼저 쓰고 통과시키는 최소 구현을 작성하라.

### 1. 순수 함수 `initialStatus` 추가 (`src/services/lifecycle.js`)

```js
// 최초 작성(create) 시 초기 상태를 결정한다. 기본 RDS.
// 예외: Z가 보류로 최초 작성하면 DDH (news.md "기사 생애주기").
// transition()(편집 컨텍스트 전이)과는 별개다 — 항상 유효한 상태를 반환하며 거부하지 않는다.
export function initialStatus(role, action) // → 'RDS' | 'DDH'
```

- 규칙: `role === 'Z' && action === 'hold'` 면 `'DDH'`, 그 외(모든 role의 send, D/R의 hold, role/action 누락·미지정·기타 값) 전부 `'RDS'`.
- **거부하지 않는다.** 최초 저장은 항상 성공해야 하므로 `{ok:false}` 같은 형태를 반환하지 말고 상태 문자열만 반환한다.
- 기존 `transition`/`DESK_TABLE`/`REPORTER_TABLE`은 **수정하지 마라** (편집 전이는 이 변경과 무관).

### 2. `create` 시그니처 확장 (`src/services/articleService.js`)

```js
function create(dto = {}, { role, action } = {})
```

- 내부에서 `status: initialStatus(role, action)`로 Contents의 status를 정한다(현재 `status: 'RDS'` 하드코딩을 대체).
- `lifecycle.js`의 `initialStatus`를 import해서 쓴다(서비스 안에서 if문으로 재구현하지 마라 — 규칙의 단일 출처를 유지).
- **하위호환 필수**: 두 번째 인자가 없으면(`deriveArticle`의 `create(dto)` 호출 등) `role`/`action`이 `undefined` → `initialStatus(undefined, undefined)` → `'RDS'`. 즉 **deriveArticle 및 기존 호출은 변경 없이 RDS를 유지**해야 한다. `deriveArticle` 코드는 건드리지 마라.
- `dto.status`/`dto.role`은 **읽지 마라**(이미 `CONTENTS_FIELDS`에 status가 없어 통과 못 하지만, 새로 추가하지도 마라).

### 3. 컨트롤러 위임 확인 (`src/controllers/`)

- `controllers.article.create`가 service.create로 위임할 때 두 번째 인자(`{ role, action }`)를 통과시키도록 한다. 컨트롤러가 단순 패스스루면 시그니처만 맞춰 전달하라.

### 4. HTTP 라우트 결선 (`server/index.js`의 `POST /api/articles`)

- 세션에서 도출한 `me.role`과 `req.body?.action`을 create에 전달한다:
  ```js
  const action = req.body?.action; // 클라가 보낸 의도(send/hold). 검증은 initialStatus가 흡수.
  const r = controllers.article.create(dto, { role: me.role, action });
  ```
- 기존 `delete dto.role`(클라 role 무시)·부서 stamp·`author` 보정·`app.notifyChange('create')`·세션/ROLES 게이트는 **그대로 유지**한다.
- `req.body.status`를 dto에 넣거나 create로 넘기지 **마라**.

## 핵심 규칙 (반드시 준수 — 위반 시 반려)

1. **CRITICAL(ADR-004 신뢰 경계)**: 초기 status는 **세션 role + 의도 action으로 서버가 계산**한다. `req.body.status`/`req.body.role`을 status 결정에 절대 쓰지 마라. 이유: 클라가 status를 보내 DPS/DDK 등으로 우회 저장하면 인가·생애주기가 깨진다.
2. **회귀 금지**: 모든 역할의 최초 **송고**(send) → RDS, D/R의 최초 **보류**(hold) → RDS, `deriveArticle`(후속/계속) → RDS. 오직 `Z + hold`만 DDH.
3. **DB 비파괴(CLAUDE.md)**: DROP/DELETE 없음. 이 step은 새 기사 insert 시 status 값만 분기한다.
4. `initialStatus`는 거부하지 않는 순수 함수다(HTTP/DB 비의존). `transition`과 혼동하지 마라.

## Acceptance Criteria

```bash
npm test        # 전체 테스트 통과 (신규 initialStatus/create/route 테스트 포함)
npm run lint    # ESLint 0 에러
```

추가로, 아래 단언이 테스트에 포함돼야 한다:

- `initialStatus('Z','hold') === 'DDH'`
- `initialStatus('Z','send') === 'RDS'`, `initialStatus('D','hold') === 'RDS'`, `initialStatus('R','hold') === 'RDS'`, `initialStatus(undefined, undefined) === 'RDS'`
- `create(dto, { role:'Z', action:'hold' })` 로 저장된 기사의 status가 `'DDH'`
- `create(dto, { role:'D', action:'hold' })` 및 `create(dto)`(인자 없음)로 저장된 기사의 status가 `'RDS'`
- `POST /api/articles` 라우트: 세션 role Z + body `{action:'hold'}` → 저장된 기사 status `'DDH'`; 세션 role D + `{action:'hold'}` → `'RDS'`; role Z + `{action:'send'}` → `'RDS'`

## 검증 절차

1. 위 AC 커맨드를 실행한다.
2. 아키텍처 체크리스트를 확인한다:
   - ARCHITECTURE.md 디렉토리 구조를 따르는가? (순수 함수는 services, 라우트는 server)
   - ADR 기술 스택을 벗어나지 않았는가? (외부 의존성 추가 없음)
   - CLAUDE.md CRITICAL 규칙(ADR-004 신뢰 경계, DB 비파괴, TDD)을 위반하지 않았는가?
3. 결과에 따라 `phases/6-firstauthor-hold/index.json`의 step 0을 업데이트한다:
   - 성공 → `"status": "completed"`, `"summary": "산출물 한 줄 요약(추가/변경 파일·함수 시그니처·계약 포함)"`
   - 수정 3회 시도 후에도 실패 → `"status": "error"`, `"error_message": "구체적 에러 내용"`
   - 사용자 개입 필요 → `"status": "blocked"`, `"blocked_reason": "구체적 사유"` 후 즉시 중단

## 금지사항

- `lifecycle.js`의 `transition`/`DESK_TABLE`/`REPORTER_TABLE`을 수정하지 마라. 이유: 편집 컨텍스트 전이는 이 변경과 무관하며, 건드리면 송고/보류/KILL 회귀를 유발한다.
- `deriveArticle`(후속/계속 기사) 로직을 수정하지 마라. 이유: 파생 기사는 항상 RDS여야 하고, `create` 두 번째 인자 미전달로 이미 RDS가 보장된다.
- `req.body.status`/`req.body.role`을 status 결정에 쓰지 마라. 이유: 신뢰 경계(ADR-004) 위반 — 클라가 임의 상태로 저장을 우회한다.
- 프론트엔드(`web/`)를 이 step에서 건드리지 마라. 이유: 신규 저장 시 `action` 전송은 Step 1의 범위다.
- 기존 테스트를 깨뜨리지 마라.
