# Step 0: db-model

## 목표

배부(distribution) 대상(수신처)을 담을 **DistributionTarget 테이블을 additive 신설**하고, 그 데이터 접근 계층
`src/models/distributionTargetModel.js`를 만든다. 이 step은 **db + model 계층만** 다룬다 — 서비스/라우트/프론트 무접촉.

배경(자기완결): 배부 시스템은 2026-07-26 스코프 확장으로 착수했고 아키텍처는 **ADR-008**이 단일 출처다.
배부 3부작 중 첫 phase(46)는 **배부 대상 관리 CRUD만** 다룬다. 실제 배부 실행(스풀 파일 쓰기·`Contents.distributedAt`
기록·EPS→DPS 전이)은 **phase 47**이므로 이 phase에 절대 섞지 않는다.

`spoolDir`(수신처별 스풀 하위 폴더명)는 phase 47에서 **파일 경로의 일부**가 될 문자열이다. 이 step에서는
**문자열 컬럼으로 저장만** 한다 — 디렉토리를 만들거나 파일을 쓰지 않는다(검증은 step1 서비스 계층 책임).

**ReceiverConfig는 청사진으로 읽기만 한다.** ADR-008 (2): ReceiverConfig는 수집(inbound) 전용이라 배부에
재사용하지 않는다 — 테이블/모델/서비스 어느 것도 수정하지 않는다.

## 읽어야 할 파일

라인 번호는 실측 힌트 — 반드시 심볼명으로 재확인하라.

- `docs/ADR.md` — **ADR-008(배부 아키텍처, L45~48)** 전문, ADR-002(멱등 비파괴 마이그레이션), ADR-006(계층 분리).
- `docs/SCHEMA.md` — 전체. 특히 `## ReceiverConfig Table`(L53~62)·`## Photo Table`(L64~74) 섹션 **형식**(이번 문서화가 이 형식을 따른다).
- `docs/ARCHITECTURE.md` — 디렉토리 구조·"백엔드 MVC + 계층 분리".
- `CLAUDE.md` — DB 비파괴 원칙, TDD 규칙, 커밋 형식.
- `src/db/schema.js` — **전체**. `SCHEMA` 객체(L7~92: 테이블 → `[컬럼명, 정의]` 순서 목록, 첫 컬럼이 PK),
  `createSchema(db)`(L95~112: `CREATE TABLE IF NOT EXISTS` + 누락 컬럼만 `ALTER ... ADD COLUMN`, 대소문자 보정).
  `ReceiverConfig`(L70~83)·`Photo`(L84~91) 엔트리가 `id INTEGER PRIMARY KEY`(ROWID alias) 신규 테이블의 청사진이다.
- `src/models/receiverConfigModel.js` — **전체**(39줄). `COLUMNS`/`FILTERABLE` 화이트리스트, `query`의 AND 동등 필터,
  `insert`의 present-only 컬럼 구성 + `lastInsertRowid` 반환. **복제 대상**이되 `remove`는 복제하지 않는다(아래 참조).
- `src/models/userModel.js` — L2 주석("삭제 함수는 두지 않는다: 비활성화는 active='N' 업데이트로 처리한다"),
  `update(userId, fields)`(L39~45)의 **present-only SET** 패턴. 이 모델이 update의 청사진이다.
- `test/schema.test.js` — 특히 Photo 신규 테이블 테스트 3종(L294~335: 테이블/컬럼, id INTEGER PK 자동증가,
  구버전 DB에 additive 생성 + 기존 행 보존)과 FK 미선언 테스트(L285~292 — 테이블 목록에 신규 테이블을 넣어야 한다).
- `test/receiverConfigModel.test.js` — **전체**(58줄). 모델 테스트 스타일(in-memory `:memory:` DB + `createSchema`)과
  "노출 메서드는 …뿐이다" 가드 테스트(L54~57).
- `test/userModel.test.js` L68~73 — 삭제 함수 미노출 가드 테스트 형식.

## 작업

### 1) 테스트 먼저 (TDD — red 확인 후 구현)

**a. `test/schema.test.js`에 DistributionTarget 케이스 추가**(Photo 케이스 L294~335와 동형):

- `createSchema`가 `DistributionTarget` 테이블을 만든다(`sqlite_master` 조회).
- 컬럼 전량 존재: `id, name, kind, spoolDir, active, createdAt, updatedAt`.
- `id`가 `INTEGER PRIMARY KEY`(`PRAGMA table_info`에서 `pk===1`, `type==='INTEGER'`)이고 2회 INSERT 시 id가 `[1, 2]`로 자동 증가한다.
- **구버전 DB 마이그레이션**: `DistributionTarget`이 없고 다른 테이블 + 기존 행만 있는 DB에 `createSchema`를 돌리면
  테이블이 additive로 생기고 **기존 행이 보존된다**.
- **부분 컬럼 구버전**: `CREATE TABLE DistributionTarget (id INTEGER PRIMARY KEY, name VARCHAR)` + 기존 행 1건(`name='옛 대상'`)이 있는 DB에
  `createSchema`를 돌리면 누락 컬럼(`kind`/`spoolDir`/`active`/`createdAt`/`updatedAt`)이 `ALTER ADD COLUMN`으로 추가된다.
  **기대값은 아래로 확정한다**(구현/런타임을 보고 맞추지 마라 — 테스트를 먼저 이 값으로 쓰고 red→green을 확인한다):
  기존 행의 `name === '옛 대상'`(보존), **`active === 'Y'`**(SQLite는 상수 DEFAULT를 기존 행에 채운다 — 실측 확인),
  `kind === null`, `spoolDir === null`, `createdAt === null`, `updatedAt === null`.
  (User 계정잠금 마이그레이션 테스트 L42~55가 같은 형식으로 `failedLoginCount === '0'`·`lockedUntil === null`을 단언한다.)
- 기존 FK 미선언 테스트(L285~292)의 테이블 목록에 `'DistributionTarget'`을 **추가**한다.
- 기존 "보조 인덱스를 만들지 않는다" 테스트(L199~207)는 그대로 통과해야 한다(=`CREATE INDEX` 금지).

**b. `test/distributionTargetModel.test.js` 신규**(`test/receiverConfigModel.test.js`와 동형):

- `insert`가 자동 증가 id를 반환하고 `query({ id })`로 조회된다.
- `query`가 화이트리스트 AND 동등 필터(`kind`/`active`/`spoolDir`)를 지원하고, 필터 없으면 전체를 `id` 오름차순으로 준다.
- `findById(id)`가 단건을 주고, 없는 id는 `undefined`.
- `update(id, { active: 'N' })`가 `changes===1`을 주고 **행은 그대로 남는다**(`query({ id }).length === 1`, `active === 'N'`) — soft delete.
- `update`는 **present-only**다: 전달하지 않은 컬럼은 값이 변하지 않고, 빈 fields면 `0`을 반환하며 SQL을 실행하지 않는다.
- `update`는 `id` 컬럼을 SET하지 않는다(`update(1, { id: 99, name: 'x' })` 후에도 id가 1로 남는다).
- **삭제 함수 미노출 가드**: `assert.deepEqual(Object.keys(model).sort(), ['findById', 'insert', 'query', 'update'])`,
  `model.remove === undefined`, `model.delete === undefined`.
- **DB 비파괴 가드**: 대상 비활성화(`update(id, { active: 'N' })`) 후에도 같은 DB의 `Article`/`Contents` 행이 보존된다
  (`receiverConfigModel.test.js` L38~52 형식 차용 — 단 DELETE가 아니라 UPDATE 경로다).

### 2) `src/db/schema.js` — SCHEMA에 DistributionTarget 엔트리 추가

`ReceiverConfig` 엔트리 **뒤에** 다음 엔트리를 추가한다(다른 테이블 정의는 한 글자도 건드리지 않는다):

| 컬럼 | 정의 | 의미 |
|------|------|------|
| `id` | `INTEGER PRIMARY KEY` | ROWID alias — 자동 증가 |
| `name` | `VARCHAR` | 수신처명(표시용, 예: '연합뉴스TV') |
| `kind` | `VARCHAR` | `'press'`(언론사) \| `'nonpress'`(비언론사) — enum 강제는 step1 서비스 |
| `spoolDir` | `VARCHAR` | 배부 스풀 하위 폴더명 **슬러그 문자열**. 여기서는 저장만 — 경로 검증은 step1, 실제 파일 쓰기는 phase 47 |
| `active` | `VARCHAR DEFAULT 'Y'` | `'Y'`/`'N'`. `'N'` = soft delete(비활성) — 행은 남는다 |
| `createdAt` | `VARCHAR` | ISO-8601 UTC 문자열(서버 stamp — step1) |
| `updatedAt` | `VARCHAR` | ISO-8601 UTC 문자열(서버 stamp — step1) |

엔트리 위에 한 줄 주석으로 "배부 대상(수신처) — ADR-008. 삭제 없음(active='N' soft delete)"을 남긴다.

### 3) `src/models/distributionTargetModel.js` 신규

시그니처만 고정하고 구현은 재량(단 `receiverConfigModel`/`userModel`의 SQL 스타일을 벗어나지 마라):

```js
export function createDistributionTargetModel(db) {
  // query(filters = {}) -> rows[]        : 화이트리스트 컬럼만 AND 동등 필터, ORDER BY id
  // findById(id)        -> row|undefined : SELECT * ... WHERE id = ?
  // insert(entry)       -> lastInsertRowid: present-only 컬럼만 INSERT(id 제외)
  // update(id, fields)  -> changes(number): present-only SET, id는 SET 대상에서 제외, 없으면 0
  return { query, findById, insert, update };
}
```

- 컬럼 화이트리스트 상수(`COLUMNS`)를 파일 상단에 두고 `query`/`insert`/`update` 모두 그것만 사용한다(임의 컬럼명 주입 차단).
- 파일 상단 주석에 "삭제 함수를 두지 않는다 — 비활성은 `active='N'` update(DB 비파괴)"와 "검증(kind enum·spoolDir 슬러그)은
  서비스 계층 책임(ADR-006)"을 명시한다.

### 4) `docs/SCHEMA.md` 문서화 (additive)

- 상단 기술명세서 L8의 "테이블은 User, Article, Contents, ReceiverConfig, Photo 5개이다"를 아래 문구로 **교체**한다
  (현재 문장은 ArticleHistory 누락으로 이미 stale이다 — 실제 `src/db/schema.js`의 `SCHEMA` 객체 기준):
  > 테이블은 **User, Article, Contents, ArticleHistory, ReceiverConfig, Photo, DistributionTarget 7개**이다.
- `## Photo Table` 섹션 **뒤에** `## DistributionTarget Table` 섹션을 추가한다(ReceiverConfig 섹션 형식과 동형):
  - 용도(배부 대상 수신처 관리, Z 전용 CRUD, ADR-008), 컬럼 목록/타입, `kind` enum 값, `active` 기본값과 의미,
    **"행 삭제 없음 — 비활성은 active='N' soft delete(DB 비파괴)"**,
    **"spoolDir는 문자열 저장/검증만 — 앱은 이 phase에서 디렉토리를 만들거나 파일을 쓰지 않는다(스풀 쓰기는 phase 47)"**,
    "보조 인덱스/FK 없음. 정합성은 애플리케이션이 유지".

## Acceptance Criteria

```bash
npm test
npm run lint
```

- `npm test`(node --test) **전부 통과, 실패 0**. 통과 개수는 기준선 **427 이상**이어야 한다(신규 테스트만큼 증가, 감소하면 회귀).
- `npm run lint` clean(경고 0).
- web 무접촉이므로 `npm run test:web` / `npm run build`는 이 step의 AC가 아니다(실행해도 무해하나 필수 아님).

## 검증 절차

1. 신규/추가 테스트를 먼저 작성하고 **구현 전에 red**(테이블 없음 / `createDistributionTargetModel is not a function`)를 눈으로 확인한다.
2. `schema.js` → 모델 순으로 구현하고 `npm test`로 green 전환을 확인한다.
3. 회귀 확인 체크리스트:
   - `test/schema.test.js`의 기존 케이스(멱등 2회 호출, 보조 인덱스 0, FK 0, 대소문자 보정)가 전부 그린인가.
   - `test/receiverConfigModel.test.js` / `test/photoModel.test.js` / `test/userModel.test.js` 그린인가(무접촉 확인).
   - `git diff --stat`에 `src/services/*`, `src/controllers/*`, `server/*`, `web/*` 파일이 **없어야** 한다.
4. `grep -rn "DELETE FROM\|DROP TABLE" src/models/distributionTargetModel.js` → **0건**이어야 한다.
5. `grep -rn "node:fs\|node:path" src/models/distributionTargetModel.js src/db/schema.js` → **0건**이어야 한다.

## 커밋 계획

- **feat**: `feat(46-distribution-targets): step0 — DistributionTarget 테이블 additive 신설 + distributionTargetModel(CRUD, 삭제 없음)`
  — `src/db/schema.js`, `src/models/distributionTargetModel.js`, `test/schema.test.js`, `test/distributionTargetModel.test.js`, `docs/SCHEMA.md`.
- **chore**: `chore(46-distribution-targets): step0 status — completed` — `phases/46-distribution-targets/index.json`만. 코드와 분리 커밋.

## 금지사항

- `DELETE FROM` / `DROP TABLE` / `TRUNCATE`를 쓰지 마라. 이유: DB 비파괴가 프로젝트 최상위 규칙이다 — 배부 대상 제거는 `active='N'`이 유일한 경로다.
- 모델에 `remove`/`delete` 함수를 만들지 마라. 이유: 존재하면 상위 계층이 언젠가 호출한다(userModel/photoModel 선례가 아예 노출하지 않는다). 가드 테스트가 이를 강제한다.
- `ReceiverConfig` 테이블 정의·`receiverConfigModel.js`·`receiverConfigService.js`를 수정하거나 배부에 재사용하지 마라. 이유: ADR-008 (2) — ReceiverConfig는 수집(inbound) 전용이다. 컬럼 하나라도 공유하면 두 시스템의 수명주기가 얽힌다.
- 기존 테이블(User/Article/Contents/ArticleHistory/ReceiverConfig/Photo)의 컬럼 정의를 바꾸거나 제거하지 마라. 이유: `createSchema`는 additive 전용이고, 정의 변경은 기존 `news.db`에 반영되지 않아 코드/DB가 어긋난다.
- `CREATE INDEX`(보조 인덱스)나 FK 제약을 선언하지 마라. 이유: `test/schema.test.js`가 "PK 자동 인덱스만·FK 0"을 강제한다(SCHEMA.md 명세).
- `node:fs`/`node:path`를 import하거나 `spoolDir`로 디렉토리를 만들지 마라. 이유: ADR-008 — 앱은 이 phase에서 파일 시스템에 손대지 않는다(스풀 쓰기는 phase 47). 문자열 컬럼일 뿐이다.
- 검증 로직(kind enum 강제, spoolDir 슬러그 검사, name 필수)을 모델에 넣지 마라. 이유: ADR-006 — 모델은 SQL만, 도메인 규칙은 서비스(step1)다. 두 곳에 두면 규칙이 발산한다.
- `src/controllers/index.js`·`src/services/*`·`server/index.js`·`web/**`를 수정하지 마라. 이유: 결선은 step1, 프론트는 step2/3 — 레이어를 섞으면 실패 원인 격리가 불가능해진다.
- 기존 테스트를 삭제하거나 약화시키지 마라(기준: backend 427 통과 · lint clean).
