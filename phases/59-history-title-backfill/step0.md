# Step 0: backfill-core

## 목표

레거시 이력 스냅샷 행의 **빈 표시제목 컬럼(`ArticleHistory.snapshotTitle`)을 채우는 멱등·비파괴 백필 함수**를 만든다. DB 레이어(`src/db/schema.js`) 하나만 다룬다.

부트 결선(호출·로그)은 이 step의 범위가 **아니다**(step1). 문서·주석 정정도 아니다(step2 — 단, `src/db/schema.js` 안의 사실과 어긋나게 되는 주석은 이 step이 고친다).

## 읽어야 할 파일

- `src/db/schema.js` 전체(146줄) — 특히 `SCHEMA.ArticleHistory` 항목(59~76행, `markupVersion`·`snapshotTitle` 주석 포함), `createSchema`(112~129행: `CREATE TABLE IF NOT EXISTS` → `PRAGMA table_info` → 누락분만 `ALTER TABLE ... ADD COLUMN`), **그리고 이 step이 본뜰 전례인 `backfillEmptyDepartments`(131~146행)**. 전례의 3요소를 그대로 가져온다: (a) 빈 값만 채우고 기존 값은 절대 덮지 않는다, (b) 보정한 행 수를 반환한다, (c) 멱등 — 재호출 시 0. **이 파일은 이 step이 단독 소유한다.**
- `src/services/historyMeta.js` 1~36행 — `snapshotTitle(markupVersion)`의 파생 규칙(블록 JSON이면 `type:'text'` 블록만 이어 붙여 첫 줄, 깨진 JSON·평문은 문자열 그대로의 첫 줄, `trim`, 200자 절단, `null`/`undefined`/`''`는 `''`). **이 함수는 import하지 않는다**(아래 계층 규칙) — 파생 규칙의 단일 출처가 무엇인지 알기 위해 읽는다.
- `src/models/articleHistoryModel.js` 64~79행 — `querySnapshotTitlesByArticle`의 `WHERE articleId = ? AND length(markupVersion) > 0`. **백필의 대상 술어는 이것과 동형**이어야 한다(`length(markupVersion) > 0`은 `markupVersion IS NOT NULL AND markupVersion != ''`와 동치: `NULL` → 결과 `NULL`이라 참이 아니고, `''` → `0`).
- `src/models/articleModel.js` 32~43행 — 트랜잭션 관례 `tx(db, fn)`(`BEGIN` → `fn()` → `COMMIT`, 예외 시 `ROLLBACK` 후 재throw). **스타일만 참고하고 import하지 마라**(모델 → db는 계층 역방향이다).
- `test/schema.test.js` 426~467행 — phase 58이 추가한 `snapshotTitle` 컬럼 케이스 3건. 특히 **구버전 테이블(컬럼 없이 직접 `CREATE TABLE` + 기존 행 삽입) → `createSchema` → 기존 행 보존·컬럼 추가** 케이스(437~453행)의 시드 방식. 신규 케이스 9번이 이 패턴을 그대로 본뜬다.
- `test/schema.test.js` 257~283행 — `backfillEmptyDepartments`의 기존 테스트 2건(보정/보존/무매칭 3분기 + 멱등). 신규 테스트의 단언 스타일을 여기에 맞춘다.
- `test/historyMeta.test.js` 29~70행 — 파생 규칙 케이스(블록 문서·공백 첫 줄·임베드 선행·평문 레거시·깨진 JSON·200자 절단). 신규 케이스 7번의 입력을 여기서 가져온다.
- `phases/59-history-title-backfill/index.json`의 `decisions` (1)~(8).

## 배경 (자기완결)

phase 58이 `ArticleHistory`에 additive 컬럼 `snapshotTitle`(VARCHAR)을 추가했다. 편집 스냅샷을 남기는 시점에 `articleService.record()`가 `historyMeta.snapshotTitle(markupVersion)`으로 표시 제목을 파생해 함께 저장하고, 이력 조회는 그 컬럼만 읽는다. 목적은 **이력보기가 본문 blob을 읽지 않게 하는 것**이다.

그런데 컬럼 도입 **이전에 기록된 행은 `snapshotTitle`이 `NULL`** 이다. phase 58의 조회(`articleHistoryModel.querySnapshotTitlesByArticle`)는 그런 행에 한해 `markupVersion`(본문 전문)을 함께 실어 서비스가 그 자리에서 파생하도록 폴백을 남겼다. 결과적으로 **옛 기사는 이력보기를 열 때마다 그 기사의 레거시 스냅샷 본문 전량을 여전히 읽는다**(phase 58 완료 note의 잔여 백로그 (a): "순수 레거시 기사는 개선 0").

이 step은 그 빈 컬럼을 **부트 1회 멱등 백필**로 채우는 순수 DB 함수를 만든다. 같은 파일에 이미 전례가 있다 — `backfillEmptyDepartments`(빈 부서만 채우고 기존 값은 덮지 않으며 보정 행 수를 반환, 재호출 시 0).

### 핵심 제약 6가지

1. **계층 방향(ADR-006)** — `src/db`는 `src/services`를 import하지 않는다(실코드 확인: `src/db/schema.js`의 import는 0개다). 파생 규칙(`historyMeta.snapshotTitle`)은 **인자로 주입받는 seam**으로 처리하고, 실제 결선은 합성 루트(`server/index.js` bootstrap, step1)가 한다. 파생 규칙을 SQL이나 이 파일에 복제하는 것은 **금지** — 기록 경로와 백필 경로가 다른 제목을 내는 순간 이 phase는 그 자체가 버그다.
2. **대상 행 술어** — `snapshotTitle IS NULL AND length(markupVersion) > 0`. 스냅샷이 아닌 행(상태 전이·`distribute`·`distribute-failed` 등 `markupVersion`이 `NULL`/`''`인 행)은 절대 건드리지 않는다. 백필은 기사 스코프가 아니라 **테이블 전역 1회**다.
   이 술어는 phase 58의 **조회** 술어와 동형이지만 **기록 게이트보다 넓다** — `articleService.record`는 `typeof row.markupVersion === 'string' && row.markupVersion !== ''`일 때만 제목을 저장하므로, 비문자열 본문(예: JSON 숫자)이 들어온 행은 TEXT affinity로 저장돼 DB 술어로는 스냅샷(`length > 0`)인데 제목 컬럼은 `NULL`로 남는다(phase 58이 "조건부 동형 — 표시는 정확하고 성능만 현행 유지"로 수용한 gap이다. `src/services/articleService.js` 125~127행 주석 참조). 백필은 **그 행도 대상에 포함해 채운다** — DB에서 읽으면 문자열로 돌아오므로 파생이 정상 동작하고 표시 결과는 폴백과 같다. 즉 백필 대상은 "컬럼 도입 이전 행"만이 아니다.
3. **`''`도 저장한다** — 파생 결과가 빈 문자열이어도 `''`를 저장한다. `NULL`로 두면(`derived || null` 류) 그 행은 매 부트마다 다시 스캔·재파생되는 **영구 미완 백필**이 되고, phase 58의 "스냅샷 없음 ≠ 제목이 빈 스냅샷" 규율과도 어긋난다.
4. **무덮기·비파괴** — 이미 값이 있는 행은 재파생하지 않는다. 행 삭제·`markupVersion` 재작성·다른 컬럼 수정은 0이다. `UPDATE`에도 `AND snapshotTitle IS NULL` 술어를 남겨 이중 방어한다.
5. **멱등** — 1회 실행 후 재실행하면 **채운 행 수가 0이고 저장된 값이 하나도 바뀌지 않는다**. "대상 0건"이라고 쓰지 마라(정확하지 않다): 파생이 건너뛴 행(제약 아래 케이스 12)은 `NULL`로 남아 다음 실행의 `SELECT`에 다시 잡힌다 — 다만 `UPDATE`·카운트는 0이고 그 행의 표시는 조회 폴백이 정확히 처리한다. 이 phase의 1급 계약이다.
6. **메모리 상한** — 레거시 blob 전량을 한 번에 JS 힙에 올리지 마라(수만 행 × 수십 KB). `id` 오름차순 커서 + 고정 배치 + 배치당 트랜잭션으로 처리한다.

## TDD — 테스트 먼저

신규 파일 `test/schema.historyTitleBackfill.test.js`를 만든다(기존 `test/schema.test.js`는 무수정 — 파일 소유 분리. 파일명은 `schema.lockout.test.js` 관례를 따른다).

시드는 `createSchema(new DatabaseSync(':memory:'))` 후 직접 SQL `INSERT`로 한다. 파생 정합 케이스(7)와 기본 케이스에서는 `deriveTitle`로 **실제 `historyMeta.snapshotTitle`을 주입**해 단일 출처 정합을 증명하고, 주입 계약 케이스(11·12)에서만 가짜 함수를 쓴다.

1. **기본 백필** — 레거시 스냅샷 행 2건(`snapshotTitle` 미전달 = `NULL`, `markupVersion` = 블록 JSON 문서)을 심고 실행 → 두 행의 `snapshotTitle`이 각 본문의 첫 텍스트 줄이 되고, 반환값이 `2`다.
2. **기존 값 무덮기** — `snapshotTitle`이 `'기존 제목'`으로 저장된 행은 본문 첫 줄이 다르더라도 값이 그대로다(그 행은 반환 카운트에도 들어가지 않는다).
3. **빈 제목은 `''`로 저장** — 첫 텍스트 블록이 공백뿐인 본문 행 → `assert.strictEqual(row.snapshotTitle, '')`(`null` 금지).
4. **멱등** — 1회차 실행 후 2회차 **채운 행 수가 `0`** 이고, 케이스 3의 `''` 행을 포함해 모든 값이 1회차와 동일하다(`''` 행이 다시 `UPDATE` 대상이 되지 않는다는 것이 이 케이스의 핵심이다).
5. **비스냅샷 행 무접촉** — `markupVersion`이 `NULL`인 행(상태 전이)과 `''`인 행을 심고 실행 → 두 행의 `snapshotTitle`이 여전히 `null`이고 반환 카운트에도 포함되지 않는다.
6. **DB 비파괴** — 실행 전후로 `ArticleHistory` 행 수가 같고, 전 행을 `SELECT *`로 비교했을 때 **`snapshotTitle` 외의 모든 컬럼이 완전히 동일**하다(`markupVersion`·`eventType`·`createdAt`·`targetId`·`reason` 포함). 삭제·재작성 0을 이 케이스가 잠근다.
7. **파생 정합(단일 출처)** — 다음 4종 본문을 심고 실행한 뒤, 저장된 값이 **`historyMeta.snapshotTitle(그 본문)`을 직접 호출한 값과 정확히 같다**: (a) 임베드 블록이 첫 원소인 블록 문서, (b) 깨진 JSON(`'{'`), (c) 평문 레거시(`'제목줄\n본문'`), (d) 첫 줄이 200자를 넘는 문서(절단 결과 일치). 하드코딩한 기대 문자열이 아니라 **함수 호출 결과와 대조**하라(규칙 복제 시 red가 되게).
8. **여러 기사 혼재** — 서로 다른 `articleId` 3건 + 각기 다른 상태(레거시/신규/비스냅샷)가 섞인 테이블에서 정확히 대상 행만 채워진다(전역 백필임을 확인 — 기사 인자를 받지 않는다).
9. **구버전 테이블** — `snapshotTitle` 컬럼 **없이** `ArticleHistory`를 직접 `CREATE TABLE`하고 레거시 행 1건 삽입 → `createSchema(db)`(컬럼이 이때 `ADD COLUMN`된다) → 백필 실행 → 그 행이 정상적으로 채워진다(`test/schema.test.js` 437~453행 패턴 재사용).
10. **배치 경계** — `HISTORY_TITLE_BACKFILL_BATCH`를 import해 `상수 * 2 + 1`건의 레거시 행을 심고 1회 실행 → 전부 채워지고 반환값이 그 행 수와 같으며, 2회차는 `0`이다(배치 루프가 중간에 멈추지 않는다).
11. **주입 계약** — `deriveTitle`을 주지 않거나 함수가 아닌 값을 주면 `TypeError`를 throw한다(조용한 no-op 금지). 이때 DB는 변경되지 않는다.
12. **비문자열 파생값은 건너뛴다** — `deriveTitle`이 특정 행에서 `undefined`(또는 숫자)를 돌려주면 그 행은 `NULL`로 남고 반환 카운트에서 빠지며, **같은 실행의 다른 행들은 정상적으로 채워진다**(throw 금지). 비문자열을 그대로 저장하면 표시 계약이 오염되므로 저장하지 않는다. **이어서 같은 DB에 2회차를 실행해 반환이 `0`이고 값이 불변임을 단언한다** — 건너뛴 행이 `SELECT`에 다시 잡히더라도 `UPDATE`·카운트가 0이어야 하고(멱등 계약의 정확한 형태), 커서 없이 구현하면 이 케이스가 무한 루프로 red가 된다.
13. **비문자열 본문 행도 대상이다(phase 58 gap 봉합)** — `markupVersion`에 문자열이 아닌 값(예: 숫자 `12345`)을 바인딩해 넣은 행(TEXT affinity로 저장되어 `length(markupVersion) > 0`이지만 phase 58의 기록 게이트는 통과하지 못해 제목이 `NULL`인 행)도 백필이 채운다. 저장값은 `historyMeta.snapshotTitle(DB에서 읽은 값)`과 같다. 이 케이스가 "백필 대상 = 컬럼 도입 이전 행"이라는 오해를 봉쇄한다.
14. **반환값 의미** — 반환값은 실제로 채운 행 수다(채울 게 없으면 `0`). 케이스 1·2·5·12의 카운트 단언으로 확인한다.

## 작업

`src/db/schema.js`에만 추가한다(`createSchema`·`backfillEmptyDepartments` 본문은 **한 글자도 바꾸지 않는다**).

### 시그니처

```js
// 한 번에 읽는 레거시 행 수 — blob을 통째로 힙에 올리지 않기 위한 상한.
export const HISTORY_TITLE_BACKFILL_BATCH = 500;

// ArticleHistory의 빈 표시제목(snapshotTitle)을 그 행의 본문에서 파생해 채운다.
// deriveTitle: (markupVersion) => string — 파생 규칙의 단일 출처(services/historyMeta.snapshotTitle)를
//   주입받는다. src/db는 services를 import하지 않는다(ADR-006) — 결선은 부트(합성 루트) 책임이다.
// 채운 행 수를 반환한다(멱등 — 재호출 시 0).
export function backfillHistoryTitles(db, { deriveTitle }) { /* ... */ }
```

### 구현 규칙(벗어나면 안 되는 것만)

- `deriveTitle`이 함수가 아니면 즉시 `TypeError`를 throw한다(DB 무변경).
- 대상 조회는 커서 방식으로 반복한다:
  ```sql
  SELECT id, markupVersion FROM ArticleHistory
   WHERE snapshotTitle IS NULL AND length(markupVersion) > 0 AND id > ?
   ORDER BY id LIMIT ?
  ```
  커서(`lastId`)는 **건너뛴 행을 포함해** 그 배치에서 본 마지막 `id`로 갱신한다(그래야 케이스 12 같은 미처리 행이 있어도 다음 배치가 같은 행을 다시 집지 않는다 — 무한 루프 불가능).
- 갱신은 행 단위로 하되 술어를 남긴다: `UPDATE ArticleHistory SET snapshotTitle = ? WHERE id = ? AND snapshotTitle IS NULL`. 채운 행 수는 `.changes` 합으로 센다.
- 한 배치를 하나의 트랜잭션으로 감싼다(`db.exec('BEGIN')` → 배치 처리 → `db.exec('COMMIT')`, 예외 시 `db.exec('ROLLBACK')` 후 재throw). 파일 안에 작은 지역 헬퍼를 두는 것은 허용하되 **`src/models/articleModel.js`의 `tx`를 import하지 마라**(db → models는 계층 역방향이다).
- 예외를 삼키지 마라(전파). 근거는 아래 "실패 정책".
- 파생값이 문자열이 아니면 그 행은 건너뛴다(UPDATE 없음, 카운트 없음).

### 실패 정책 (주석으로 근거를 남길 것)

같은 부트 블록의 `createSchema`·`backfillEmptyDepartments`가 모두 `try/catch` 없이 전파한다 — DB가 이 `UPDATE`를 받지 못하는 상태면 그 DB로 요청을 받는 것 자체가 위험하고, 조용한 삼킴은 "개선이 안 됐는데 안 된 줄 모르는" 상태를 만든다. **배치당 커밋**이므로 중간 실패에도 이전 배치의 진행은 보존되고, 멱등이므로 원인 해소 후 재기동이 이어서 완결한다. 이 3문장을 함수 주석에 남겨라.

### 사실과 어긋나게 되는 주석 정정 (같은 파일 안)

`SCHEMA.ArticleHistory`의 `snapshotTitle` 주석(69~71행)에 있는 `(백필 없음 — ...)` 문구는 이 step 이후 거짓이 된다. 다음 사실로 정정한다(1~2줄, 기존 줄 삭제 최소화):

- 표시제목이 비어 있는(`NULL`) 스냅샷 행은 **부트 시 멱등 백필이 빈 컬럼만 채운다**(컬럼 도입 이전 행 + 비문자열 본문 edge 행).
- 이미 저장된 값은 재파생·덮어쓰기하지 않는다 → 파생 규칙이 바뀌어도 저장된 행은 옛 규칙의 값을 유지한다(phase 58 결정 유지).
- 조회의 행 단위 폴백은 그대로 남는다.

## Acceptance Criteria

```bash
npm test          # 실패 0 — 기준선 991 대비 증가, 위 TDD 목록의 전 항목이 통과해야 한다
npm run lint      # 통과
```

**diff scope**: 시작 시점 `git status --porcelain` 스냅샷 대비 증분이 `src/db/schema.js`, `test/schema.historyTitleBackfill.test.js` **2개**(+ 진행 기록 `phases/59-history-title-backfill/index.json`)뿐. `web/**`·`server/**`·`src/services/**`·`src/models/**`·`docs/**`는 증분 0이어야 한다.

**추가 확인(porcelain 증분이 못 잡는 구멍)**: `phases/index.json`은 계획 단계에서 이미 수정(`M`) 상태로 스냅샷에 들어 있어 증분 판정으로는 변경이 드러나지 않는다. 이 step은 그 파일을 **건드리지 않는다** — `git diff phases/index.json`이 계획 시점 내용 그대로인지(59 항목이 `pending`이고 그 외 변경 0) 직접 확인하라. 갱신은 step2가 한다.

## 검증 절차

1. 위 AC 커맨드를 실행한다. 기존 스위트 중 `test/schema.test.js`·`test/articleHistoryModel.test.js`·`test/articleHistoryService.test.js`·`test/server.test.js`가 **무수정 green**인지 확인하라(이 step은 조회 경로를 건드리지 않는다).
2. 변이 검증 6종(확인 후 반드시 원복):
   - `SELECT` 술어를 `snapshotTitle IS NULL OR snapshotTitle = ''`로 넓히면 → 케이스 4가 red(`''` 행이 매번 다시 대상이 되어 2회차 반환이 0이 아니다).
   - 파생값 저장을 `derived || null`(또는 `derived || undefined`)로 바꾸면 → 케이스 3·4가 red.
   - `AND length(markupVersion) > 0`을 빼면 → 케이스 5가 red.
   - `deriveTitle` 호출 대신 본문 첫 줄을 직접 `split('\n')[0]`으로 파생하면 → 케이스 7(임베드 선행 블록 문서·200자 절단)이 red.
   - 커서 갱신을 건너뛴 행에 대해 하지 않으면(처리한 행만 갱신) → 케이스 12가 무한 루프/타임아웃으로 red.
   - `SELECT` 술어에 기록 게이트를 복제해(`typeof` 검사 등으로) 비문자열 본문 행을 제외하면 → 케이스 13이 red("기록 게이트보다 넓다"는 결정(3)의 회귀 잠금).
3. 성능 스모크 **1회만**(테스트로 커밋하지 마라 — 시간 단언은 flake다). 일회성 스크립트나 REPL로 in-memory DB에 레거시 행 **2,000건**(본문 2~5KB 블록 JSON)을 심고 백필 1회 실행 시간과 채운 행 수를 기록한다. 기준은 "부트를 눈에 띄게 지연시키지 않는다" 수준의 확인이며, 배치 상수 교차 확인이나 20,000행 벤치마크는 **하지 마라**(이 저장소 실 DB의 백필 대상은 0행이다 — 과한 성능 검증은 이 phase의 비용 대비 가치에 맞지 않는다). 커서+배치 설계 자체는 대형 배포의 부팅 OOM 실패 모드를 없애기 위한 것이지 속도 최적화가 아니다.
4. 아키텍처 체크리스트:
   - `src/db/schema.js`의 import 목록이 여전히 **비어 있는가**(services·models import 0)?
   - `DROP`/`DELETE`/`CREATE INDEX` 문이 새로 생기지 않았는가? `UPDATE`가 `snapshotTitle` 외의 컬럼을 건드리지 않는가?
   - 파생 규칙(첫 줄·trim·200자·블록 파싱)이 이 파일 어디에도 복제되지 않았는가?
   - 함수가 특정 기사 인자를 받지 않는가(전역 1회 백필)?
5. `phases/59-history-title-backfill/index.json`의 step0을 `completed` + `summary`로 갱신한다(시그니처·대상 술어(기록 게이트보다 넓다는 점 포함)·배치/트랜잭션 방식·`''` 저장·무덮기·멱등 문구(채운 행 수 0·값 불변)·반환 의미·테스트 증가분·변이 5종 결과·2,000행 스모크 수치 명시).

## 금지사항

- `src/services/historyMeta.js`(또는 다른 `src/services/**`)를 이 파일에서 import하지 마라. 이유: `src/db`는 계층 최하위이며 services를 끌어오면 ADR-006의 의존 방향이 역전되고 부트/시드 스크립트가 서비스 트리를 통째로 로드하게 된다. 파생은 주입 seam으로만 받는다.
- 파생 규칙(첫 줄 추출·trim·200자 절단·블록 JSON 파싱)을 SQL(`substr`/`instr`)이나 이 파일의 JS로 복제하지 마라. 이유: 기록 경로(`articleService.record`)와 백필 경로가 서로 다른 제목을 만들면 같은 목록 안에서 행마다 다른 규칙의 제목이 보인다 — 이 phase가 고치려는 문제보다 나쁜 결과다.
- 파생 결과가 `''`일 때 `NULL`을 저장하지 마라. 이유: 그 행이 매 부트마다 다시 스캔·재파생되는 영구 미완 백필이 되고, phase 58의 "스냅샷 없음 ≠ 제목이 빈 스냅샷" 규율이 깨진다.
- 이미 값이 있는 행을 재파생·덮어쓰기하지 마라(`WHERE`에서 `IS NULL`을 빼는 것 포함). 이유: 저장된 값은 그 시점 규칙의 결과이며 덮어쓰기는 감사 원장의 조용한 재작성이다. `backfillEmptyDepartments`의 "빈 값만" 규율과도 어긋난다.
- 행 삭제(`DELETE`)·`markupVersion` 수정·컬럼 추가/변경(`ALTER`)·인덱스 생성(`CREATE INDEX`)을 하지 마라. 이유: DB 비파괴 원칙(CLAUDE.md)이고, 스키마 변경은 이 phase 밖이다(컬럼은 phase 58에서 이미 존재한다). 인덱스는 SCHEMA.md의 "보조 인덱스 없음" 규율 대상이며 1회성 스캔을 위해 영구 인덱스를 만들 이유가 없다.
- 대상 행을 `.all()` 한 번으로 전부 읽지 마라(커서·`LIMIT` 없이). 이유: 레거시 본문 전량이 한 번에 JS 힙에 올라와 수만 행 규모에서 부트가 메모리로 죽는다.
- `articleModel.js`의 `tx` 헬퍼를 import하지 마라. 이유: `src/db` → `src/models`는 계층 역방향이다(같은 이유로 모델의 조회 함수도 쓰지 않는다).
- 조회 경로(`articleHistoryModel.querySnapshotTitlesByArticle`의 `CASE`, `historyMeta`의 폴백, `articleService.queryHistory`)를 "이제 불필요하다"며 손대지 마라. 이유: 백필을 돌리지 않은 DB·구버전 인스턴스가 기록한 행과 파생이 건너뛴 행이 남을 수 있고, 폴백 제거는 그 행의 제목이 통째로 사라지는 회귀다. 또한 그 파일들은 이 step의 소유가 아니다.
- 부트 호출부(`server/index.js`)를 건드리지 마라. 이유: step1의 단독 소유 파일이며, 한 step이 두 레이어를 동시에 수정하면 실패 원인 격리가 불가능해진다.
- 앱 내 타이머(`setInterval`/`setTimeout`)나 백그라운드 워커로 백필을 돌리지 마라. 이유: ADR-008이 앱 내 타이머를 금지한다(다중 인스턴스에서 중복 실행). 이 백필은 부트 동기 실행 1회다.
- `docs/**`·`web/**`·`scripts/**`·`.claude/skills/**`·`phases/49-mini-backlog-cleanup/step0.md`·`phases/50-hygiene-cleanup/**`를 수정하지 마라.
- `git add -A`/`git add .` 금지, 미커밋 사용자 파일의 `restore`/`checkout`/`stash`/`clean` 금지.
