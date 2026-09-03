# Step 0: schema-spec

엔진 중립 정규 스키마 명세를 `src/db/schema.js`가 만드는 **실제 구조**에서 파생하는 생성기와, 그 산출물(`docs/db-migration/schema-canonical.json`)과 잠금 테스트를 만든다. **구조만 다룬다 — 데이터/값은 이 step 범위 밖이다.**

## 읽어야 할 파일

**계획 문서**
- `phases/75-p2-migration-foundation/index.json` — `scope`·`baseline`·`order`·`decisions` (1)(3)(8)·`open_questions` (1)(3).

**정본(무수정 — 읽기만)**
- `src/db/schema.js` **전문** — `SCHEMA` const의 7 테이블·컬럼 순서·타입·기본값·PK 규칙(첫 컬럼이 PK) · `createSchema(db)`의 동작(CREATE TABLE IF NOT EXISTS + additive ALTER) · `backfillEmptyDepartments`·`backfillHistoryTitles`의 존재(구조가 아니라 데이터 백필 — 이 step은 무관하되 존재는 인지하라).
- `docs/SCHEMA.md` — 사람이 읽는 산문 명세(정본이 아니라 **참조**). 특히 `ArticleHistory.targetId`가 INTEGER인 이유(VARCHAR면 숫자 id가 문자열로 저장되어 매칭이 조용히 깨진다), append-only·soft-delete 주석. **이 파일을 고치지 마라.**
- `docs/ADR.md` — **ADR-013 ②**('스키마 소유자는 P2까지 Node' · Spring DDL 0)만.

**형식 참조**
- `test/schema.test.js` — `new DatabaseSync(':memory:')` + `createSchema(db)` + `PRAGMA table_info(<table>)` 패턴. 이 step의 테스트도 같은 패턴을 쓴다.

## 배경 (동결된 사실)

1. **스키마 정본은 코드다**(decisions (3)). `docs/SCHEMA.md`는 산문이고 드리프트할 수 있으므로 파싱하지 않는다. `src/db/schema.js`의 `SCHEMA` const는 **export되지 않았고**, `src/**`는 이 phase의 무접촉 목록이다 — **export를 추가하지 마라.** `createSchema`는 이미 export돼 있으니 그것만 import해서 in-memory DB에 적용한 뒤 `PRAGMA table_info`로 구조를 파생한다.
2. **7 테이블**: User · Article · Contents · ArticleHistory · ReceiverConfig · Photo · DistributionTarget.
3. **타입군은 3종**: User는 TEXT, Article/Contents/ReceiverConfig/DistributionTarget/Photo는 VARCHAR, PK id들과 `ArticleHistory.targetId`는 INTEGER. `PRAGMA table_info`가 돌려주는 `type` 문자열을 그대로 담되, 하류(step1 정규화)가 쓸 **타입군(text/integer)** 도 함께 도출한다(SQLite affinity 규칙: INTEGER 선언 = 수치 · 그 외 = 텍스트).
4. **PK는 각 테이블 첫 컬럼**이고 `PRAGMA table_info`의 `pk` 필드로도 확인 가능하다. 명세는 두 경로(선언 순서 첫 컬럼 · `pk` 플래그)가 일치함을 담아 후속 도구가 PK를 오인하지 않게 한다.
5. **보조 인덱스·FK 없음**(PK 자동 인덱스만) — 명세에 그 사실을 담는다(구조 대조 시 인덱스가 늘면 신호).
6. **이 step은 어떤 SQLite 파일도 디스크에 만들지 않는다** — in-memory(`:memory:`)로 충분하다(구조만 파생).

## 작업

### A — 정규 스키마 명세 생성기 (`scripts/db-migrate/schema-spec.mjs`)

시그니처 수준 지시(구현은 재량):

```js
// 순수 파생: in-memory DB에 createSchema를 적용하고 PRAGMA로 구조를 읽어 정규 명세 객체를 만든다.
// 반환 예: { version, generatedFrom: 'src/db/schema.js', tables: [ { name, primaryKey, columns: [ { name, declaredType, typeClass /* 'text' | 'integer' */, notNull, defaultValue, ordinal } ], indexes: [] } ] }
export function buildCanonicalSchema(): object

// 결정적 직렬화(키 정렬·2-space·후행 개행) — 커밋본과 byte-identical 비교가 가능해야 한다.
export function serializeCanonicalSchema(spec): string
```

- **결정적**이어야 한다: 테이블 순서·컬럼 순서는 `createSchema`의 선언 순서(= `PRAGMA table_info`의 cid 순서)를 따르고, JSON 키는 안정 정렬한다. 같은 입력에 항상 같은 바이트.
- CLI 진입점: 인자 없이 실행하면 `docs/db-migration/schema-canonical.json`을 **덮어쓰기 생성**하고, `--check`면 기존 파일과 재생성 결과를 비교해 다르면 diff 출력 + exit 1(잠금 테스트가 이걸 부른다). 인자 파싱은 직접 짠다(불리언 1개).
- **DB에 쓰지 않는다** — `:memory:`이고 `createSchema` 외 어떤 DDL/DML도 실행하지 않는다.

### B — 산출물 커밋 (`docs/db-migration/schema-canonical.json`)

- 생성기로 만든 명세를 커밋한다. 이것이 'P2까지 스키마 소유자는 Node'의 기계 스냅샷이다.

### C — 테스트 (먼저 작성한다 — TDD)

`test/dbmigrate-schema-spec.test.js`. red 확인 후 구현.

최소 항목:
1. `buildCanonicalSchema()`가 **정확히 7 테이블**을 그 이름들로 담는다.
2. 각 테이블의 첫 컬럼이 PK이고 `primaryKey`와 일치한다(두 경로 교차 확인).
3. `ArticleHistory.targetId`의 `typeClass`가 `'integer'`이고, User 전 컬럼이 `'text'`, Contents 전 컬럼(id 아님)이 텍스트군임을 단언(타입군 도출의 핵심 회귀).
4. `Contents`가 `lockerSessionId`·`lockerClientId` 컬럼을 **명세에는 담는다**(구조 사실 — 응답 투영 제외는 서버 계약이지 스키마가 아니다).
5. **결정성**: `serializeCanonicalSchema(buildCanonicalSchema())`를 두 번 호출하면 byte-identical.
6. **잠금**: 커밋된 `docs/db-migration/schema-canonical.json`이 재생성 결과와 byte-identical(= `--check`가 exit 0). 이 항목이 P2까지 스키마 무변의 감시자다.
7. **DB 비파괴**: 생성기 실행이 어떤 파일도 만들거나 고치지 않음(스크래치 디렉토리 스냅샷 무변 — in-memory만 쓴다).

## Acceptance Criteria

```bash
# 1) 이 step의 테스트가 green (그리고 기존 test/** 무회귀)
npm test

# 2) 명세 잠금 게이트가 exit 0 (커밋본 == 재생성)
node scripts/db-migrate/schema-spec.mjs --check ; echo "exit=$?"

# 3) 린트 (test/**는 린트 대상 · scripts/**는 eslint ignore)
npm run lint

# 4) 무접촉 경로 — 정본 0줄 변경
git diff --stat -- src server server-spring contract docs/api-contract docs/SCHEMA.md docs/news.md web client package.json

# 5) 순수 추가 자리만 변경
git status --porcelain
#   기대: scripts/db-migrate/schema-spec.mjs · docs/db-migration/schema-canonical.json · test/dbmigrate-schema-spec.test.js 만 신규
```

**종료 조건 — 아래 변이 결과표를 summary에 기록한다. 미기록 시 미완이다.**

## 검증 절차 (변이)

각 변이는 심고 → 지정 커맨드로 red 확인 → 원복 후 무변 확인.

| 변이 | 심는 곳 | 기대 |
|---|---|---|
| M0-1 | 커밋된 `schema-canonical.json`에서 한 컬럼 삭제 | 항목 6 red · `--check` exit 1 (스키마 드리프트 감시가 비공허) |
| M0-2 | `typeClass` 도출을 전부 `'text'`로 | 항목 3 red (targetId INTEGER 예외가 사라지면 잡힌다) |
| M0-3 | 테이블 순서를 알파벳 정렬로 바꿈 | 항목 5는 여전히 green이나(결정적이므로) 항목 6 red (커밋본과 갈림) — '결정성 ≠ 안정성' 구분의 실증 |

## 금지사항

- **`src/db/schema.js`에 export를 추가하지 마라.** 이유: `src/**` 무접촉 · Node 서버 무수정 원칙(ADR-013). `createSchema`(이미 export됨)만 쓴다.
- **`docs/SCHEMA.md`를 파싱하거나 고치지 마라.** 이유: 정본은 코드다(decisions (3)). 산문을 파싱하면 드리프트가 명세로 새어든다.
- **명세에 값/행 데이터를 담지 마라.** 이유: 이 step은 구조 전용이다. 값 정규화·행 체크섬은 step1이다.
- **디스크에 SQLite 파일을 만들지 마라.** 이유: 구조 파생은 `:memory:`로 충분하고, 파일을 만들면 비파괴 관측이 흐려진다.
- **새 npm 의존성을 추가하지 마라.** 이유: `node:sqlite`·`node:test`만으로 된다(baseline).
