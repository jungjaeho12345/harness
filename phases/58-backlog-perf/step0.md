# Step 0: history-title-column

## 목표

이력 제목 파생값을 **기록 시점에 저장할 자리**를 만든다. DB 레이어만 다룬다.

1. `ArticleHistory`에 additive 컬럼 `snapshotTitle`(VARCHAR)을 추가한다.
2. `articleHistoryModel`이 그 컬럼을 쓰고(insert) 읽는(신규 경량 조회) 경로를 연다.
3. `docs/SCHEMA.md`의 ArticleHistory 절에 컬럼 의미를 반영한다.

서비스·조회 결선은 이 step의 범위가 **아니다**(step1·step2).

## 읽어야 할 파일

- `docs/SCHEMA.md` — 상단 기술명세서(5~11행: "추가된 컬럼은 VARCHAR", "멱등 마이그레이션만", "DB 삭제 금지")와 `## ArticleHistory Table` 절(55~64행). **이 파일은 이 step이 단독 소유한다.**
- `src/db/schema.js` 전체(143줄) — `SCHEMA` 상수의 `ArticleHistory` 항목(59~72행)과 `createSchema`의 멱등 마이그레이션 루프(107~125행: `CREATE TABLE IF NOT EXISTS` → `PRAGMA table_info` → 누락분만 `ALTER TABLE ... ADD COLUMN`, 케이스 무시 비교).
- `src/models/articleHistoryModel.js` 전체(93줄) — `HISTORY_COLS`, `insert`, `queryByArticle`(경량 계약: blob 미SELECT, `hasSnapshot` 파생), `querySnapshotById`, `querySnapshotsByArticle`(50~59행), `queryDistributionEvents`, `getDistributionEventById`.
- `test/schema.test.js` — 특히 `createSchema: ArticleHistory — markupVersion 본문 스냅샷 컬럼이 있다`(127~134행)와 `구버전 ArticleHistory(markupVersion 없음)에 additive 마이그레이션 시 기존 행 보존`(136~152행). **신규 케이스는 이 두 케이스를 그대로 본뜬다.**
- `test/articleHistoryModel.test.js` — `querySnapshotsByArticle` 케이스 묶음(117~200행)의 시드 방식·단언 스타일.

## 배경 (자기완결)

현재 이력보기(`GET /api/articles/:id/history`)는 한 번 열릴 때마다 `articleService.queryHistory`가 `querySnapshotsByArticle`로 **그 기사의 모든 편집 스냅샷 본문(markupVersion 전문)** 을 읽고, `historyMeta`가 각 본문의 **첫 줄 한 줄**만 뽑아 제목으로 쓴다. 150편집·30KB 기사에서 실측 29ms / 4.5MB이며 `node:sqlite`는 동기라 그동안 이벤트 루프가 멈춘다.

해법은 **파생 제목을 쓰는 시점(편집 스냅샷 기록)에 컬럼으로 함께 저장**하고, 조회는 그 컬럼을 읽되 **값이 없는 레거시 행에서만** 본문을 함께 싣는 것이다. 이 step은 그 컬럼과 조회 경로만 만든다.

핵심 제약 4가지:

1. **행 재작성 금지** — `SCHEMA` 목록에 한 줄 추가만 한다. 기존 행은 `NULL`로 남는다. 백필 `UPDATE`·행 재작성·인덱스 추가를 하지 마라(레거시 행의 제목은 조회 시 본문에서 파생한다).
2. **`queryByArticle`의 SELECT를 넓히지 마라** — 그 조회는 이력보기뿐 아니라 배부 멱등·사이클 경계 판정(`embargoPolicy.distributedKinds` / `cycleDistributedKinds` / `latestSendId`), `distributionTickService`, `distributionRetryService`가 공유하는 **경량 계약**이다. 최대 200자 × 행수를 거기에 실으면 같은 phase의 step4가 줄이려는 비용을 다른 경로에서 늘린다.
3. **폴백은 행 단위로 SQL에서 끝낸다** — 신규 조회는 `snapshotTitle`이 `NULL`인 행에만 `markupVersion`을 실어 돌려준다(`CASE` 식). 그래야 서비스가 "레거시가 1건이라도 있으면 blob 전량 재조회" 같은 2차 조회를 하지 않는다. 비용 비교: 신규 행만 있는 기사 = blob 0건 / 혼재 기사 = 레거시 행 blob만 / 순수 레거시 기사 = 현행과 동수(회귀 0). **세 경우 모두 현행 이상**이다. 잔여 한계: 순수 레거시 기사는 개선이 0이다(백필을 하지 않기로 한 결정의 대가 — 새 편집이 쌓이면 그 행부터 개선된다).
4. **필터는 스냅샷 보유 여부 기준** — `WHERE ... AND length(markupVersion) > 0`을 쓴다. 이는 기존 `hasSnapshot` 판정(`markupVersion IS NOT NULL AND markupVersion != ''`)과 동치이고(`NULL` → `NULL`이라 참이 아님, `''` → `0`), 본문 값을 결과 컬럼으로 싣지 않아 신규 행 본문이 JS 경계를 넘지 않는다. `WHERE snapshotTitle IS NOT NULL`로 거르면 레거시 행이 결과에서 통째로 사라져 폴백 대상 자체를 식별할 수 없다 — **금지**. 레거시 행은 `snapshotTitle: null` + `markupVersion: <본문>`으로, 신규 행은 `snapshotTitle: <제목>` + `markupVersion: null`로 반환되어야 한다.

## TDD — 테스트 먼저

### `test/schema.test.js` (추가만, 기존 케이스 수정 금지)

1. `createSchema` 후 `ArticleHistory` 컬럼에 `snapshotTitle`이 있다.
2. 구버전 테이블(`snapshotTitle` 없이 직접 `CREATE TABLE` + 기존 행 1건 삽입) → `createSchema` → 컬럼이 추가되고 **기존 행이 보존**되며 그 행의 `snapshotTitle`은 `null`이다(136~152행 케이스와 동형).
3. 멱등: 같은 db에 `createSchema`를 2회 호출해도 오류 없이 통과하고 데이터가 보존된다(신규 컬럼 기준으로 확인).

### `test/articleHistoryModel.test.js` (추가만)

4. `insert({ ..., markupVersion, snapshotTitle: '헤드라인' })` → 직접 SQL `SELECT`로 그 행의 `snapshotTitle`이 `'헤드라인'`이다.
5. `insert`에 `snapshotTitle`을 주지 않으면 그 행의 값은 `null`이다(present-only 계약 유지).
6. `querySnapshotTitlesByArticle(articleId)`는 스냅샷 보유 행만 `{ id, snapshotTitle, markupVersion }` 3키로 반환하고 순서는 `id DESC`다.
7. **신규 행**: `snapshotTitle`이 저장된 행은 그 값이 그대로 오고 `markupVersion`은 `null`이다(본문이 결과에 실리지 않는다 — 이 step의 성능 계약).
8. **레거시 행 식별**: `markupVersion`은 있고 `snapshotTitle`이 `NULL`인 행도 결과에 포함되며, `snapshotTitle`은 `null`이고 `markupVersion`에는 본문 전문이 실린다(폴백 입력).
9. **혼재 기사**: 신규 행 1건 + 레거시 행 1건인 기사에서 한 번의 조회로 두 행이 모두 오고, **신규 행의 `markupVersion`만 `null`** 이다(레거시 행 본문만 실린다 — reviewer 확정 케이스).
10. **빈 제목은 레거시가 아니다**: `snapshotTitle`이 `''`로 저장된 행은 `snapshotTitle: ''` + `markupVersion: null`로 온다(`CASE`가 `IS NULL`만 본다).
11. `markupVersion`이 `''`이거나 `NULL`인 행은 결과에서 제외된다(`hasSnapshot` 판정과 동형 — `length(markupVersion) > 0`).
12. 다른 기사의 행이 섞이지 않는다.
13. 이력/스냅샷이 없으면 `[]`다.
14. **계약 잠금**: `queryByArticle` 반환 행에 `snapshotTitle` 키가 **없다**. `querySnapshotsByArticle` 반환 행은 여전히 `{ id, markupVersion }` 2키다(무수정 유지). `queryDistributionEvents`·`getDistributionEventById` 반환 키 집합도 불변이다.

## 작업

### `src/db/schema.js`

`SCHEMA.ArticleHistory` 목록에 `markupVersion` 바로 뒤로 한 줄만 추가한다. `createSchema` 본문은 **한 글자도 바꾸지 않는다**(기존 멱등 루프가 `ADD COLUMN`을 처리한다).

```js
// 이력 목록 표시용 제목 — 스냅샷 기록 시점에 historyMeta.snapshotTitle(markupVersion)로 파생해 저장한다.
// 조회가 blob(markupVersion)을 읽지 않게 하는 것이 목적이다. 이전 버전에서 기록된 행은 NULL이고
// 조회가 그 행에 한해 본문을 함께 읽어 파생한다(백필 없음 — 파생 규칙이 바뀌어도 저장된 행은 옛 규칙 값 유지).
['snapshotTitle', 'VARCHAR'],
```

### `src/models/articleHistoryModel.js`

- `HISTORY_COLS`에 `'snapshotTitle'`을 추가한다(`markupVersion` 뒤). `insert`는 present-only이므로 미전달 시 그대로 NULL이다.
- 신규 조회 함수 1개를 추가하고 export 객체에 싣는다:

```js
// 이력 목록 '제목' 파생의 입력을 한 번에 읽는다 — 저장된 파생 제목이 있으면 그것만, 없으면(레거시 행)
// 그 행에 한해 본문을 함께 싣는다. 행 단위 폴백을 SQL에서 끝내므로 서비스에 2차 blob 조회가 없다:
//   신규 행만 있는 기사 = 본문 0건 / 혼재 = 레거시 행 본문만 / 순수 레거시 = 현행과 동수(회귀 0).
// 필터 length(markupVersion) > 0은 hasSnapshot 판정(IS NOT NULL AND != '')과 동치다(NULL→NULL, ''→0).
// snapshotTitle 기준으로 거르면 레거시 행이 사라져 폴백 대상을 식별할 수 없다 — 금지.
function querySnapshotTitlesByArticle(articleId) // → [{ id, snapshotTitle, markupVersion }] (id DESC)
```

SQL은 다음 형태로 고정한다(파라미터 바인딩 유지):

```sql
SELECT id, snapshotTitle,
       CASE WHEN snapshotTitle IS NULL THEN markupVersion END AS markupVersion
  FROM ArticleHistory
 WHERE articleId = ? AND length(markupVersion) > 0
 ORDER BY id DESC
```

- `queryByArticle` / `querySnapshotById` / `querySnapshotsByArticle` / `queryDistributionEvents` / `getDistributionEventById`는 **전부 무수정**이다. (`querySnapshotsByArticle`은 step2 이후 `src` 소비자가 없어지지만 **제거하지 마라** — 모델 표면 정리는 이 phase 밖의 별도 백로그다.)

### `docs/SCHEMA.md`

`## ArticleHistory Table` 절에 additive로 반영한다(기존 문장 삭제 금지):

- property 나열 행에 `표시제목(snapshotTitle)`을 추가한다.
- 2~3줄 설명: (a) 스냅샷 기록 시점에 본문 첫 줄에서 파생해 저장하는 표시용 제목이며, 이력 조회가 본문을 읽지 않게 하는 것이 목적이다. (b) 이전 버전에서 기록된 행은 NULL이고, 조회가 **그 행에 한해** 본문을 함께 읽어 파생하는 폴백을 유지한다(백필·행 재작성 없음 — 이력은 append-only 원장이다). (c) 파생 규칙이 바뀌어도 이미 저장된 행은 옛 규칙의 값을 유지한다(재파생·백필 없음).

## Acceptance Criteria

```bash
npm test          # 실패 0 — 기준선 944 + 신규 케이스(14건 이상)
npm run lint      # 통과
```

**diff scope**: 시작 시점 `git status --porcelain` 스냅샷 대비 증분이 `src/db/schema.js`, `src/models/articleHistoryModel.js`, `docs/SCHEMA.md`, `test/schema.test.js`, `test/articleHistoryModel.test.js` **5개**(+ 진행 기록 `phases/58-backlog-perf/index.json`)뿐.

## 검증 절차

1. 위 AC 커맨드를 실행한다. 기존 배부/이력 스위트(`test/articleHistoryService.test.js`, `test/distributionRetryService.test.js`, `test/distributionTickService.test.js`, `test/server.test.js`)가 **무수정 green**인지 확인하라.
2. 변이 검증 4종(확인 후 원복):
   - `querySnapshotTitlesByArticle`의 WHERE를 `snapshotTitle IS NOT NULL`로 바꾸면 케이스 8이 red.
   - `CASE WHEN snapshotTitle IS NULL THEN markupVersion END`을 그냥 `markupVersion`으로 바꾸면 케이스 7·9가 red(신규 행 본문이 결과에 실린다).
   - `HISTORY_COLS`에서 `snapshotTitle`을 빼면 케이스 4가 red.
   - `queryByArticle`의 SELECT에 `snapshotTitle`을 추가하면 케이스 14가 red.
3. 아키텍처 체크리스트:
   - 모델에 비즈니스 규칙이 없는가(제목 파생 로직은 이 파일에 없다 — SQL과 매핑뿐)?
   - `createSchema` 본문이 무수정인가? `DROP`/`DELETE`/`UPDATE` 문이 새로 생기지 않았는가?
   - 신규 조회가 **레거시 행 외에는** `markupVersion` 값을 돌려주지 않는가?
4. `phases/58-backlog-perf/index.json`의 step0을 `completed` + `summary`로 갱신한다(컬럼 정의·신규 조회 SQL과 반환 shape·세 경우(신규/혼재/순수 레거시)의 blob 건수·무수정 유지한 조회 목록·테스트 증가분·변이 결과 명시).

## 금지사항

- 기존 행의 `snapshotTitle`을 채우는 백필 `UPDATE`(마이그레이션 스크립트 포함)를 작성하지 마라. 이유: 이력은 append-only 감사 원장이고, 대량 UPDATE는 이 phase(확정 백로그 4건)의 범위 밖 결정이다(이 코드베이스에 백필 전례 자체는 있다 — `schema.js`의 `backfillEmptyDepartments`. 그건 "빈 부서만 채운다"는 별도 결정이었고, 여기서는 그 결정을 하지 않았다). 이 phase의 확정 해법은 "레거시 행은 조회 시 본문에서 파생"이다.
- `queryByArticle`·`querySnapshotsByArticle`·`queryDistributionEvents`의 SELECT 목록이나 반환 shape을 바꾸지 마라(삭제도 금지). 이유: 배부 판정 3경로와 이력보기 응답이 그 shape에 묶여 있고(케이스 14가 잠근다), `querySnapshotsByArticle` 제거는 이 phase 4건 밖의 별도 백로그다.
- 신규 조회에서 `markupVersion`을 무조건 SELECT하지 마라(`CASE` 없이). 이유: 신규 행 본문이 매 이력보기마다 JS로 전송·파싱되어 이 phase의 목적이 통째로 무력화된다 — 변이 검증 2번 항목이 정확히 그 실수를 잡는다.
- 보조 인덱스(`CREATE INDEX`)를 추가하지 마라. 이유: SCHEMA.md가 "PK 자동 인덱스만"을 명시하며, 인덱스 도입은 이 phase 범위 밖의 별도 결정이다.
- 컬럼에 길이 제한(`VARCHAR(200)`)이나 `NOT NULL`/`DEFAULT`를 붙이지 마라. 이유: 레거시 행이 NULL이어야 폴백 대상 식별이 가능하고, 이 스키마의 관례는 무제약 VARCHAR다.
- `historyMeta.snapshotTitle` 같은 파생 규칙을 모델이나 SQL로 복제하지 마라. 이유: 규칙 단일 출처가 깨지면 기록값과 폴백값이 서로 다른 제목을 낸다.
- `docs/news.md`·`.claude/skills/**`·`phases/49-mini-backlog-cleanup/step0.md`·`phases/50-hygiene-cleanup/**`·`docs/ADR.md`·`docs/ARCHITECTURE.md`를 수정하지 마라.
- `git add -A`/`git add .` 금지, 미커밋 사용자 파일의 `restore`/`checkout`/`stash`/`clean` 금지.
