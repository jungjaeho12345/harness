# Step 1: spec-gap-fixes

명세(news.md·rcv.md·SCHEMA.md)에서 누락된 4건을 일괄 보강한다 — **(1) DB 빈 부서 자동 보정(backfill) + 마이그레이션 대소문자 안전화, (2) 편집 저장 시 부서 stamp, (3) 수집(자동기사) 능동 pull(API 호출), (4) 수신설정 생성폼 입력란 확장.** 커밋 메시지상 부서 조회버튼(#2)은 `ListPage` 충돌로 별도 커밋으로 보류한다(이 step 범위 밖). 모든 변경은 비파괴·멱등이며 ADR-003/004/006을 준수한다.

## 읽어야 할 파일

먼저 아래 파일들을 읽고 프로젝트의 아키텍처와 설계 의도를 파악하라:

- `/docs/news.md` — 편집 저장 부서 보정(신규 POST와 정합: 빈 부서면 세션 부서 stamp), 외부 실패는 throw 없이 graceful 거부.
- `/docs/rcv.md` — 수신 명세(등록되지 않은 sourceId 미수신, 등록 기사는 attribute='자동기사'), "API 호출 후 응답 분석"(서버가 등록된 활성 API 소스를 능동 호출하는 pull 경로).
- `/docs/SCHEMA.md` — Contents.department/departmentCode, ReceiverConfig(type/apiEndpoint/apiKey/active/username/password), 비파괴 멱등 마이그레이션 원칙.
- `/docs/ADR.md` — ADR-002(node:sqlite 직접 SQL), ADR-003(View는 Controller/Model 경유·직접 fetch 금지), ADR-004(role/부서는 세션에서만 도출·클라 body 불신), ADR-006(얇은 라우트·로직은 service, 외부 의존성은 주입형).
- `/src/db/schema.js` — **이 step에서 수정.** `createSchema(db)`의 ADD COLUMN 멱등 마이그레이션, `SCHEMA.Contents`(department/departmentCode/lockYN 등). 신규 `backfillEmptyDepartments`를 여기에 추가한다.
- `/src/services/collectionService.js` — **이 step에서 수정.** `createCollectionService({ articleService, receiverConfigModel, parser })`와 기존 `receive(sourceId, payload)`(등록·활성 확인 → parse → articleService.create, attribute='자동기사'). 여기에 `fetchFn` 주입과 `pull`을 추가한다.
- `/src/controllers/index.js` — **이 step에서 수정.** 합성 루트. `createCollectionService` 호출과 `collection` 객체(receive 노출).
- `/server/index.js` — **이 step에서 수정.** `POST /api/receive` 라우트(토큰 가드 패턴)·`PUT /api/articles/:id`(`delete fields.role` 등 세션 정규화)·`bootstrap()`(createSchema 호출). 신규 `POST /api/collection/pull` 라우트와 bootstrap backfill 배선을 추가한다.
- `/web/src/view/RcvMgmtPage.jsx` — **이 step에서 수정.** 수신설정 생성폼(`form`/`set(k,v)`/`createConfig(form)`). 입력란 4개를 추가한다.
- `/web/src/controller/useRcvMgmtController.js` — `createConfig`/BLANK 초기 폼 상태(username/password/apiKey/active 키 존재 여부)와 transport 경유(읽기만).
- 테스트 패턴: `/test/schema.test.js`, `/test/collectionService.test.js`, `/test/server.test.js`, `/web/src/view/RcvMgmtPage.test.jsx`.

이전에 만들어진 코드를 꼼꼼히 읽고 설계 의도를 이해한 뒤 작업하라.

## 작업

TDD: **테스트를 먼저 작성**한 뒤 통과하는 구현을 작성한다. 4건은 독립적이므로 각각 테스트→구현으로 진행한다.

### #1 DB schema — 마이그레이션 대소문자 안전화 + 빈 부서 backfill (`src/db/schema.js`)

- **(a) 마이그레이션 대소문자 보정:** SQLite 식별자는 대소문자를 무시한다. 레거시 DB가 `'LockYN'` 등 다른 표기로 같은 컬럼을 이미 가질 수 있으므로, 기존 컬럼 집합을 `PRAGMA table_info`의 `c.name.toLowerCase()`로 모으고 ADD COLUMN 판단도 `!existing.has(name.toLowerCase())`로 한다. 이로써 중복 `ADD COLUMN`(=duplicate column 오류)을 회피한다. **ADD COLUMN만 허용 — DROP/DELETE 금지.**
- **(b) 신규 export `backfillEmptyDepartments(db)`:** 단일 `UPDATE Contents` 문으로, `department`가 `NULL`이거나 `''`인 행에 한해, `author`가 `User.name`과 일치하고 그 `User.department`가 비어있지 않은(`IS NOT NULL AND != ''`) 경우에만 해당 User의 `department`/`departmentCode`로 채운다. `.run().changes`(보정 행 수)를 반환한다. **비파괴(빈 값만 채움, 기존 부서 미덮어쓰기)·멱등(재호출 시 0).**

### #2 편집 저장 시 부서 stamp (`server/index.js`, `PUT /api/articles/:id`)

- 기존 `delete fields.role`(클라 role 제거)에 더해, `fields`에 `'department'` 키가 **존재하면서** 그 값이 falsy인 경우에만(`'department' in fields && !fields.department`) `fields.department = me.department`, `fields.departmentCode = me.departmentCode`로 세션 부서를 stamp한다. `me`는 세션에서 도출한 사용자다(ADR-004 — 클라 body 불신, 세션 신뢰).
- **부서 키가 아예 없는 부분 수정은 건드리지 않는다** → 기존 부서 보존. 실제 갱신은 `controllers.article.update`(→service) 경유.

### #3 수집 능동 pull (`collectionService.js` → `controllers/index.js` → `server/index.js`)

- **service:** `createCollectionService`가 `fetchFn = globalThis.fetch` 주입 파라미터를 받도록 시그니처 확장(외부 네트워크 직접 결합 금지·테스트는 가짜 주입, ADR-006). 내부 `decodeBody(text)`(문자열이면 `JSON.parse` 시도 후 실패 시 평문 반환)와 `async pull(sourceId)` 추가:
  - `receiverConfigModel.query({ sourceId })` → 없으면 `{ ok:false, reason:'unregistered' }`.
  - `(c.active ?? 'Y') !== 'N' && c.type === 'API' && c.apiEndpoint`인 cfg를 find, 없으면 `reason:'no-active-api-source'`.
  - `cfg.apiKey`가 있으면 `init.headers.Authorization = \`Bearer ${apiKey}\``로 `fetchFn(cfg.apiEndpoint, init)` 호출. `!res || !res.ok`면 `reason:'fetch-failed'`. fetch가 throw해도 `try/catch`로 `reason:'fetch-failed'` graceful 거부(**throw 금지**, news.md).
  - 성공 시 `decodeBody(await res.text())`로 payload를 만들어 **기존 `receive(sourceId, payload)`를 재사용**(등록·활성 재확인 → parse → `attribute='자동기사'`로 create). 반환에 `pull` 추가.
- **controller:** `createCollectionService` 호출에 `fetchFn` 주입, `collection` 객체에 `pull: (sourceId) => collectionService.pull(sourceId)` 추가.
- **transport(얇은 라우트):** `POST /api/collection/pull` 신설. `/receive`와 동일하게 선택적 `COLLECTION_TOKEN`(`x-collection-token` 헤더) 검증, 불일치 시 `401 UNAUTH`. `req.body.sourceId`를 `controllers.collection.pull`로 위임, `r.ok`면 `app.notifyChange('create')` 후 `res.json(r)`, 아니면 `fail(res, r)`. **라우트는 토큰 가드+위임만**(ADR-006).
- **bootstrap 배선:** `bootstrap()`의 `createSchema(db)` 직후 `backfillEmptyDepartments(db)` 호출(주석에 비파괴·멱등 명시).

### #4 수신설정 생성폼 입력란 확장 (`web/src/view/RcvMgmtPage.jsx`)

- 기존 폼에 사용자명(`rcv-username`)·비밀번호(`rcv-password`, `type=password`)·API 키(`rcv-apikey`, `type=password`)·활성(`rcv-active`, `select` Y/N) 4개 `yh-field`를 추가한다. 모두 `set(k, v)`로 `form` 상태에 바인딩(BLANK 초기상태에 해당 키들이 이미 존재). 제출은 기존 `createConfig(form)` 컨트롤러 경유 — **직접 fetch 금지(ADR-003).**

### 테스트(먼저 작성)

- `/test/schema.test.js` 3건: 레거시 `'LockYN'` 대소문자 컬럼이 있어도 중복 미추가·데이터 보존; `backfillEmptyDepartments`가 빈 부서만 보정(기존 부서·매칭 없음 보존, `changed=1`); 멱등(2회차 0건).
- `/test/collectionService.test.js` 5건: 활성 API 소스 호출 시 `apiEndpoint` URL·`Authorization Bearer` 헤더 검증 및 자동기사(`attribute='자동기사'`, `status='RDS'`) 등록; 평문(비JSON) 응답 파싱 등록; `!ok` 응답 graceful 거부(`reason='fetch-failed'`, 기사 0건); fetch throw 시 graceful 거부; 미등록(`unregistered`)·FTP 타입/비활성 API(`no-active-api-source`) 거부 및 **거부 경로에서 외부 호출 미발생** 검증.
- `/test/server.test.js` 3건: `PUT` 빈 부서 전송 시 세션 부서 stamp(예: 사회부/SOC); 부서 키 미전송 시 기존 부서 보존(예: 경제부); `POST /api/collection/pull` 통합(능동 호출 자동기사 등록 200 + 미등록 거부).
- `/web/src/view/RcvMgmtPage.test.jsx` 1건: 사용자명/비밀번호/API키/활성 입력이 `createReceiverConfig`로 `{ username, password, apiKey, active }`로 전달됨 검증.

## Acceptance Criteria

```bash
npm run lint
npm run build
npm test
npm run test:web
```

## 검증 절차

1. 위 AC 커맨드를 실행한다. 기존 테스트 + 신규 테스트(schema 3·collectionService 5·server 3·RcvMgmtPage 1 = 12건)가 모두 통과해야 한다(무회귀).
2. 아키텍처 체크리스트(ARCHITECTURE.md 디렉토리 구조·ADR 기술스택·CLAUDE.md CRITICAL):
   - **ADR-006:** `POST /api/collection/pull` 라우트가 토큰 가드+`collection.pull` 위임+`notifyChange`만 하고, 호출·파싱·등록 로직은 `collectionService.pull`에 있는가? 외부 의존성(`fetchFn`)이 주입형이라 테스트가 네트워크 없이 동작하는가?
   - **ADR-004:** 빈 부서 보정 시 클라 값이 아니라 세션 `me.department`/`me.departmentCode`를 쓰고, `delete fields.role`로 클라 role을 계속 제거하는가?
   - **ADR-003:** `RcvMgmtPage.jsx`가 직접 fetch 없이 `useRcvMgmtController`의 `createConfig`만 경유하는가?
   - **DB 비파괴:** `backfillEmptyDepartments`가 빈 부서(NULL/'')만 채우고 기존 값 미덮어쓰기·멱등인가? 마이그레이션이 ADD COLUMN만(대소문자 보정으로 중복 ADD 회피)이고 DROP/DELETE가 없는가?
3. 결과에 따라 `phases/4-mvp-polish/index.json`의 step 1 status를 갱신(completed + summary). 실패 시 error, 개입 필요 시 blocked.

## 금지사항

- 마이그레이션에서 `DROP COLUMN`/`DELETE`/테이블 재생성을 하지 마라. 이유: DB 비파괴 원칙(CLAUDE.md CRITICAL) — 멱등 ADD COLUMN과 대소문자 보정으로만 처리한다.
- 컬럼 존재 비교를 대소문자 구분으로 하지 마라. 이유: SQLite는 식별자 케이스를 무시하므로 레거시 표기(`LockYN`)를 누락으로 오판해 duplicate column 오류가 난다 — `toLowerCase()` 비교 필수.
- `backfillEmptyDepartments`에서 비어있지 않은 기존 부서를 덮어쓰지 마라. 이유: 비파괴·멱등 보장 — 빈 값(NULL/'')만 채운다.
- 편집 저장 부서 보정에서 클라가 보낸 부서/role 값을 신뢰하지 마라. 이유: ADR-004 — role/부서는 세션(`me`)에서만 도출한다. 또한 부서 키가 없는 부분 수정에 부서를 강제 주입하지 마라(기존 부서 보존).
- `collectionService.pull`이 fetch 실패에 throw하게 두지 마라. 이유: news.md 외부 실패 graceful 거부 — `try/catch`로 `reason:'fetch-failed'`를 반환한다. 거부 경로(unregistered/no-active-api-source)에서는 외부 호출 자체를 하지 마라.
- 호출/파싱/등록 비즈니스 로직을 `POST /api/collection/pull` 라우트에 인라인하지 마라. 이유: ADR-006 — 라우트는 토큰 가드+service 위임만 하는 얇은 transport다.
- `RcvMgmtPage.jsx`에서 직접 `fetch`/`EventSource`를 호출하지 마라. 이유: ADR-003 — 생성은 `useRcvMgmtController.createConfig` 경유.
- 부서 조회버튼(#2)을 이 step에서 끼워넣지 마라. 이유: `ListPage` 충돌로 별도 커밋으로 보류된 범위 밖 작업이다.
- 기존 테스트/기능을 깨뜨리지 마라.
