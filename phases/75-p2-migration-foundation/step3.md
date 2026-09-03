# Step 3: neutral-export

소스 SQLite를 **읽기 전용**으로 읽어 엔진 중립 JSONL로 내보내는 export 도구를 만든다. 이것이 §7 P2 게이트의 '역방향(참조용 export) 경로 확보'이며, 어떤 미래 대상 엔진의 적재 도구든 읽을 수 있는 결정적 데이터 산출물이다.

## 읽어야 할 파일

**계획 문서**
- `phases/75-p2-migration-foundation/index.json` — `decisions` (2)(4)(6)·`excluded` (a).
- `phases/75-p2-migration-foundation/step1.md` — 정규화 단일 출처·읽기 전용 규율·PK 정렬.

**직전 step 산출물**
- `scripts/db-migrate/canonical.mjs`(step1) — export도 **같은 정규화**를 쓴다(복제 금지).
- `scripts/db-migrate/inventory.mjs`(step1) — 라운드트립 대조의 기준(export → 재매니페스트 == inventory 매니페스트).
- `scripts/db-migrate/schema-spec.mjs`(step0) — 테이블·컬럼 순서·PK·typeClass.
- `test/dbmigrate-nondestructive-gate.test.js`(step2) — 이 step의 신규 `export.mjs`도 자동으로 이 게이트의 스캔 대상이 된다.

**정본(무수정 — 읽기만)**
- `src/db/schema.js` — 픽스처 생성용 `createSchema`.
- `docs/ADR.md` — ADR-013 ②(DB 비파괴) · CLAUDE.md 최상위 규칙.

## 배경 (동결된 사실)

1. **JSONL을 고른 이유**(decisions (6)): 새 의존성 없이 스트리밍 가능하고 어떤 엔진 적재 도구든 읽기 쉽다. 테이블당 파일 1개, 행당 1줄(컬럼→값 객체).
2. **값은 정규형으로 쓴다** — `canonical.mjs`의 `canonicalizeValue`를 통과한 문자열. 이래야 export에서 다시 만든 매니페스트가 inventory 매니페스트와 aggregateDigest가 같다(라운드트립 잠금). **원시 값을 그대로 쓰면** NULL/빈 문자열·정수 표기가 엔진 간에 갈려 라운드트립이 깨진다.
3. **출력은 항상 새 디렉토리에만** 쓴다 — 소스는 `{readOnly:true}`, 출력 경로가 이미 존재하고 비어 있지 않으면 **거부**한다(기존 산출물 덮어쓰기로 인한 조용한 혼합 방지). 소스 파일은 절대 건드리지 않는다.
4. **행 순서는 PK 정규형 오름차순으로 결정적**이어야 한다(step1과 같은 정렬) — 그래야 두 번 export한 결과가 byte-identical이고 대상 엔진의 순서 차이에 영향받지 않는다.
5. **`news.db`는 리포에 없다** — 테스트는 `createSchema` + 픽스처로 소스를 만든다.

## 작업

### A — export 도구 (`scripts/db-migrate/export.mjs`)

```js
// 소스(읽기 전용)를 엔진 중립 JSONL로 outDir에 쓴다. 테이블당 <TableName>.jsonl.
// 각 줄: JSON.stringify({ <col>: <정규형 문자열>, ... }) — 컬럼 순서는 schema-spec 순서.
// outDir이 없으면 만들고, 비어 있지 않으면 거부(throw). 소스는 절대 쓰지 않는다.
export function exportToNeutral(sourcePath, outDir): { tables: [{ name, rowCount }] }

// export된 JSONL 디렉토리에서 inventory와 동형의 매니페스트를 파생(라운드트립 검증용).
export function manifestFromExport(outDir): object  // buildInventory(source)와 aggregateDigest 동일해야 함
```

- CLI: `node scripts/db-migrate/export.mjs <sourcePath> <outDir>`. 인자 파싱 직접.
- **소스 open은 `{ readOnly: true }`** · SELECT만. 출력은 파일시스템 쓰기(JSONL)뿐.
- JSONL 직렬화는 결정적: 객체 키를 schema-spec 컬럼 순서로 배열해 안정 출력(엔진/런타임의 키 순서에 의존하지 않는다).

### B — 테스트 (먼저 작성한다 — TDD)

`test/dbmigrate-export.test.js`. red 확인 후 구현.

최소 항목:
1. 픽스처 소스를 export하면 7개 `.jsonl` 파일이 outDir에 생기고 각 파일 줄 수 = 해당 테이블 rowCount.
2. **라운드트립 잠금(핵심)**: `manifestFromExport(outDir)`의 테이블별 aggregateDigest가 `buildInventory(source)`의 것과 **전부 동일**. export가 값·순서를 잃지 않았다는 증거.
3. **결정성**: 같은 소스를 두 outDir로 export하면 각 `.jsonl`이 byte-identical.
4. **NULL/빈 문자열 보존**: NULL 컬럼과 `''` 컬럼이 export에서 구별되어(정규형 토큰) 라운드트립 후에도 다른 체크섬.
5. **비파괴**: export 전후 소스 md5 동일.
6. **덮어쓰기 거부**: 비어 있지 않은 outDir로 export하면 throw(조용한 혼합 방지).
7. 큰 `ArticleHistory.targetId`가 export→라운드트립에서 정수 정규형으로 안정.

## Acceptance Criteria

```bash
# 1) 신규 테스트 green + 기존 무회귀 + step2 게이트가 export.mjs를 스캔해도 green
npm test

# 2) 린트
npm run lint

# 3) 무접촉 경로
git diff --stat -- src server server-spring contract docs/api-contract docs/SCHEMA.md docs/news.md web client package.json

# 4) 이전 step 산출물 무회귀
node scripts/db-migrate/schema-spec.mjs --check ; echo "exit=$?"
```

**종료 조건 — 변이 결과표를 summary에 기록한다.**

## 검증 절차 (변이)

| 변이 | 심는 곳 | 기대 |
|---|---|---|
| M3-1 | export가 `canonicalizeValue` 대신 원시 값을 쓰게 | 항목 2·4 red(라운드트립 aggregateDigest 갈림 · NULL/빈 문자열 구별 소실) |
| M3-2 | 행 순서를 엔진 반환 순서 그대로 | 항목 3 red(byte-identical 깨짐) |
| M3-3 | JSONL 키 순서를 `Object.keys(row)`로(schema-spec 순서 무시) | 항목 3 red(결정성 깨짐) |
| M3-4 | 덮어쓰기 거부 제거 | 항목 6 red |
| M3-5 | 소스를 `{readOnly:false}`로 열기 | step2 게이트 red(읽기 전용 규율) — 게이트가 신규 파일을 실제로 보호함의 실증 |

## 금지사항

- **소스 SQLite에 쓰지 마라.** 이유: DB 비파괴. `{readOnly:true}` + SELECT만.
- **정규화를 export에 복제하지 마라.** 이유: `canonical.mjs` 단일 출처(decisions (4)) — 복제하면 inventory와 갈려 라운드트립이 거짓 green이 된다.
- **원시 DB 값을 JSONL에 그대로 쓰지 마라.** 이유: 엔진 간 NULL/정수 표기 차이가 대상 적재 시 조용한 불일치를 만든다(M3-1이 실증).
- **기존 출력 디렉토리를 덮어쓰지 마라.** 이유: 두 소스의 산출물이 섞이면 이후 대조가 오염된다.
- **특정 엔진용 적재 SQL(INSERT 스크립트 등)을 만들지 마라.** 이유: excluded (a) — 엔진 결정(open_questions (1)) 종속. 이 step은 중립 JSONL까지다.
