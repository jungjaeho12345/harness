# Step 0: history-failure-schema

## 목표

수신처 단위 배부 실패를 **영속**할 자리를 DB 계층에 연다.

1. `ArticleHistory`에 `targetId`(INTEGER) · `reason`(VARCHAR) 컬럼을 **additive 멱등 마이그레이션**으로 추가한다.
2. `articleHistoryModel`이 이 두 컬럼을 insert할 수 있게 하고, **배부 실패/재전송 이벤트만** 읽는 조회 메서드를 additive로 추가한다.
3. `docs/SCHEMA.md`에 새 컬럼 2개를 기술한다(스키마 문서와 실제 스키마의 드리프트 금지).

이 step은 db/model 계층 2파일 + 그 스키마 문서만 다룬다. "언제 무엇을 기록하는가"(서비스)·"미해소 판정"(순수 파생)·라우트는 이후 step 소관이다.

## 읽어야 할 파일

- `docs/ARCHITECTURE.md` — "DB 비파괴 원칙: 스키마는 `CREATE TABLE IF NOT EXISTS` / additive `ALTER`만, 행 삭제 없음".
- `docs/SCHEMA.md` **전체** — 이 step이 **수정하는 문서**다. 특히 L8(테이블 7개 목록에 ArticleHistory가 있음), L9("타입은 Article/Contents는 VARCHAR, User는 TEXT로 설정한다 (추가된 컬럼은 VARCHAR)"), L13~17(인덱스는 PK 자동 인덱스만), L49(배부 이벤트는 ArticleHistory에 append-only). **ArticleHistory 전용 절이 아직 없다** — 이 step에서 신설한다.
- `docs/ADR.md` ADR-002(node:sqlite 직접 SQL, ORM 없음)·ADR-006. **읽기 전용(무접촉)**.
- `src/db/schema.js` 전체(139줄) — 특히 L59~69 `ArticleHistory` 정의와 L104~122 `createSchema`의 `PRAGMA table_info` → 케이스 무시 비교 → `ALTER TABLE … ADD COLUMN` 멱등 패턴.
- `src/models/articleHistoryModel.js` 전체(57줄) — L6~9 `HISTORY_COLS`, L21~23 `insert`(present-only), L28~34 `queryByArticle`(**본문 blob 미포함 경량 계약**), L38~43 `querySnapshotById`(articleId 스코프), L48~54 `querySnapshotsByArticle`.
- `test/schema.test.js` L92~135 — ArticleHistory 관련 케이스(컬럼 존재는 `includes`로 단언하므로 additive 컬럼은 회귀를 만들지 않는다). 멱등 재실행 케이스도 확인하라.
- `test/articleHistoryModel.test.js` 전체 — 특히 "queryByArticle는 markupVersion 대신 hasSnapshot 플래그만 반환한다"와 "행 삭제 함수를 노출하지 않는다(DB 비파괴)". **두 케이스는 무수정 green이어야 한다.**
- 참고(수정 금지 — 왜 `queryByArticle`을 안 건드리는지의 근거): `src/services/distributionTickService.js` L72~75와 `src/services/articleService.js` L235 부근이 같은 `queryByArticle` 결과를 배부 멱등·사이클 경계 판정 입력으로 쓴다.

## 배경 (자기완결)

현재 배부 실패(`src/services/distributionService.js` L142~150)는 `failed` 배열 반환 + `onFailure` 콜백(→ `logService.warn`, in-memory 링버퍼)뿐이라 **영속이 0**이다. 서버가 재시작하면 어떤 수신처가 못 받았는지 알 방법이 없다. MVP-4는 이 사실을 `ArticleHistory`에 append-only로 남긴다.

기록 shape(다음 step들이 쓴다):

- 실패 1건 = `{ articleId, eventType:'distribute-failed', action:<kind>, targetId:<수신처 id>, reason:<고정 토큰>, actorUserId, createdAt }`
- 재전송 성공 1건 = `{ articleId, eventType:'distribute-retry', action:<kind>, targetId, actorUserId, createdAt }`

**`targetId`를 INTEGER로 선언하는 이유(함정)**: SQLite는 컬럼 선언 타입에 따라 affinity를 적용한다. `VARCHAR`로 선언하면 TEXT affinity라 숫자 `12`를 넣어도 `'12'`(문자열)로 저장되고, 조회 후 JS에서 `DistributionTarget.id`(숫자)와 `===` 비교하면 조용히 어긋난다(미해소 그룹 판정·재전송 대상 매칭이 전부 깨진다). `ArticleHistory.id`가 이미 INTEGER이므로 이 테이블에서 INTEGER 선언은 이질적이지 않다.

## TDD — 테스트 먼저

### `test/schema.test.js`에 케이스 추가(기존 케이스 수정 금지)

1. `createSchema` 후 `ArticleHistory` 컬럼에 `targetId`·`reason`이 있다.
2. 멱등: 같은 db에 `createSchema`를 2회 호출해도 throw하지 않고 두 컬럼이 중복 생성되지 않는다(`PRAGMA table_info` 결과에서 각 1회).
3. 레거시 DB 시나리오(비파괴): 두 컬럼이 **없는** ArticleHistory를 직접 `CREATE TABLE`로 만들고 행 1건을 넣은 뒤 `createSchema`를 실행하면 — 기존 행이 그대로 남고(삭제 0), 새 컬럼은 `NULL`이며, 기존 컬럼 값이 보존된다.

### `test/articleHistoryModel.test.js`에 케이스 추가(기존 케이스 수정 금지)

4. `insert({ …, targetId: 12, reason: 'spool-write-failed' })`가 두 값을 저장하고, 미전달 시 두 컬럼은 `NULL`이다(present-only).
5. **타입 함정 잠금**: `targetId: 12`로 넣은 뒤 `queryDistributionEvents()`로 읽은 행의 `targetId`가 **숫자 `12`**다(`'12'` 아님 — `assert.strictEqual(row.targetId, 12)`).
6. `queryByArticle` 반환 행에는 `targetId`·`reason` 키가 **없다**(일반 이력 계약 불변 — `Object.keys`로 단언).
7. `queryDistributionEvents()`는 `eventType`이 `'distribute-failed'` 또는 `'distribute-retry'`인 행만 반환한다 — `'distribute'`·`'status'`·`'edit'` 행은 섞이지 않는다.
8. 반환 shape는 `{ id, articleId, eventType, action, targetId, reason, actorUserId, createdAt }`이고 `markupVersion`이 없다(blob 미노출).
9. 정렬은 `id DESC`로 결정적이다.
10. `queryDistributionEvents({ articleId })`는 그 기사 행만 준다(다른 기사 미혼입).
11. `queryDistributionEvents({ limit: 2 })`는 최신 2건만 준다. limit 미지정이면 기본값이 적용된다(기본값은 구현 재량, 100 이상 권장).
12. 대상 이벤트가 없으면 **빈 배열**(throw·undefined 금지).
13. 회귀: 모델에 삭제 함수가 없다(기존 케이스 green 유지).

## 작업

### `src/db/schema.js`

`SCHEMA.ArticleHistory` 목록 끝에 두 줄을 **추가만** 한다(기존 컬럼 순서·정의 변경 금지).

```js
['targetId', 'INTEGER'], // 배부 실패/재전송 이벤트의 수신처(DistributionTarget.id) — 그 외 이벤트는 NULL
['reason', 'VARCHAR'],   // 배부 실패 사유 고정 토큰 — 경로·본문·예외 원문 금지
```

`createSchema` 함수 본문은 손대지 않는다(이미 멱등 additive다).

### `src/models/articleHistoryModel.js`

1. `HISTORY_COLS`에 `'targetId', 'reason'`을 추가한다(present-only insert가 그대로 동작한다).
2. 조회 메서드 1개를 추가하고 반환 객체에 노출한다.

```js
// 배부 실패/재전송 이벤트만 읽는다 — 실패 목록(Z 전용)과 재전송 대상 확인의 유일한 조회 경로.
// queryByArticle에 targetId/reason을 싣지 않는 이유: 그 응답은 전 사용자에게 열린 이력보기 계약이다.
function queryDistributionEvents({ articleId, limit } = {}) {} // → [{ id, articleId, eventType, action, targetId, reason, actorUserId, createdAt }] (id DESC)
```

규칙:

1. SQL은 파라미터 바인딩(`?`)만 쓴다 — `eventType IN (?, ?)`, 선택적 `AND articleId = ?`, `ORDER BY id DESC LIMIT ?`. 문자열 결합으로 값을 넣지 마라.
2. `limit`은 정수로 정규화한다(`Number.isInteger` 아니면 기본값, 1 미만이면 기본값). SQL에 문자열이 그대로 흘러가지 않게 한다.
3. eventType 리터럴 2종은 이 파일에 문자열로 두되, **판정 어휘의 단일 출처는 step1의 순수 모듈**이 된다 — step1 이후에도 이 모델은 순수 모듈을 import하지 않는다(모델은 도메인 비의존, ADR-006). 값이 어긋나지 않도록 주석에 "어휘 단일 출처: src/services/distributionFailureLog.js"라고 남겨라.
4. `queryByArticle`·`querySnapshotById`·`querySnapshotsByArticle`·`insert`의 SQL·시그니처를 바꾸지 마라(`insert`는 `HISTORY_COLS` 확장 외 변경 없음).
5. 비즈니스 규칙(미해소 판정·그룹핑·allowlist)을 모델에 넣지 마라 — 직접 SQL만.

### `docs/SCHEMA.md`

`## Contents Table` 절과 `## ReceiverConfig Table` 절 사이에 **`## ArticleHistory Table` 절을 신설**한다(테이블 목록 L8의 순서와 맞춘다). 기존 절·문장은 수정하지 않는다.

담을 내용(간결하게):

1. 목적 한 줄 — 기사 편집/생애주기 전이/배부 이벤트 로그이며 **append-only**(행 삭제·수정 없음).
2. 컬럼 목록 — `id`(INTEGER PK, ROWID alias, 자동 증가), `articleId`, `eventType`, `action`, `fromStatus`, `toStatus`, `actorUserId`, `createdAt`, `markupVersion`(편집 시점 본문 스냅샷 — 전이 행은 NULL), **`targetId`(배부 실패/재전송 이벤트의 수신처 = DistributionTarget.id, 그 외 이벤트는 NULL)**, **`reason`(배부 실패 사유 고정 토큰 — 경로·본문·예외 원문을 담지 않는다)**.
3. `eventType` 어휘 — `create`/`edit`/`status`(전이, `action`에 send·hold·kill·approveDelete·embargo)/`distribute`(kind 단위 배부, `action`=press|nonpress)/**`distribute-failed`**(수신처 단위 실패)/**`distribute-retry`**(수신처 단위 재전송 성공). 배부 멱등·사이클 경계 판정은 `eventType='distribute'` 행만 본다(ADR-008).
4. **타입 예외 1줄(필수)**: "L9의 '추가된 컬럼은 VARCHAR' 규칙의 예외는 `ArticleHistory.targetId`(INTEGER)다 — VARCHAR는 TEXT affinity라 숫자 id가 문자열로 저장되어 `DistributionTarget.id`와의 매칭이 조용히 어긋난다." (L9 자체는 수정하지 마라 — 전역 규칙 문장이다.)
5. 보조 인덱스 없음(PK 자동 인덱스만) — 배부 이벤트 조회는 id DESC 스캔 + LIMIT라는 비용 인식 1줄.

## Acceptance Criteria

```bash
npm test          # 실패 0 — 기준선(821) + 이번 신규 케이스
npm run lint      # 통과
```

**diff scope**: step 시작 전에 `git status --porcelain`을 찍어 스냅샷으로 남겨라. 종료 시점의 `git status --porcelain`이 그 스냅샷과 **다른 부분**은 `src/db/schema.js`, `src/models/articleHistoryModel.js`, `docs/SCHEMA.md`, `test/schema.test.js`, `test/articleHistoryModel.test.js` **5개뿐**이어야 한다(절대 목록 비교 금지 — 트리에 사용자 소유 미커밋 파일이 이미 있다).

## 검증 절차

1. 위 AC 커맨드를 실행한다.
2. 변이 검증 3종(확인 후 원복):
   - `targetId` 선언을 `VARCHAR`로 바꾸면 케이스 5가 red(타입 함정 잠금이 실제로 동작).
   - `queryDistributionEvents`의 `WHERE eventType IN (…)`을 지우면 케이스 7이 red.
   - `HISTORY_COLS`에서 `targetId`를 빼면 케이스 4가 red.
3. 아키텍처 체크리스트:
   - 모델에 도메인 분기(미해소 판정·사유 allowlist)가 들어가지 않았는가?
   - `DELETE`/`DROP`/기존 컬럼 재정의 SQL이 없는가(DB 비파괴)?
   - 새 인덱스·새 테이블을 만들지 않았는가?
   - `src/services/**`·`server/**`·`web/**`를 건드리지 않았는가?
   - **문서-코드 정합**: `docs/SCHEMA.md`의 새 절 컬럼 목록이 `src/db/schema.js`의 `SCHEMA.ArticleHistory` 정의와 이름·타입까지 일치하는가(드리프트 0)? `docs/SCHEMA.md` L9와 기존 절은 무수정인가?
4. `phases/57-distribution-mvp4/index.json`의 step0을 `completed` + `summary`로 갱신한다. summary에 추가 컬럼의 이름·타입, `queryDistributionEvents`의 시그니처·반환 shape·필터·정렬·limit 기본값, `docs/SCHEMA.md` 신설 절의 위치를 명시하라.

## 금지사항

- `queryByArticle`의 SELECT에 `targetId`·`reason`을 추가하지 마라. 이유: 그 결과는 전 사용자에게 열린 이력보기 응답이자 배부 멱등 판정의 입력이다 — 노출면을 넓히고 hot path 계약을 흔든다.
- 기존 컬럼 정의를 수정하거나 순서를 바꾸지 마라. 이유: `createSchema`는 누락 컬럼만 ADD 하는 멱등 마이그레이션이라, 정의 변경은 기존 DB에 반영되지 않아 코드-DB 불일치를 만든다.
- `DELETE`·`DROP`·`UPDATE` SQL을 이 두 파일에 넣지 마라. 이유: ArticleHistory는 append-only이며 DB 비파괴는 프로젝트 최상위 규칙이다.
- 보조 인덱스(`CREATE INDEX`)를 추가하지 마라. 이유: 이 프로젝트는 PK 자동 인덱스만 쓰기로 했고(SCHEMA.md), 성능 문제는 아직 관측되지 않았다 — 필요해지면 별도 결정으로 연다.
- `reason` 컬럼에 예외 메시지·파일 경로를 넣도록 설계하지 마라(모델은 저장만 하지만 주석으로 못 박아라). 이유: 스풀 경로가 이력을 타고 응답으로 새는 경로가 된다(distributionTickService의 화이트리스트 투영과 같은 규율).
- `docs/news.md`·`.claude/skills/**`·`phases/49-mini-backlog-cleanup/step0.md`·`phases/50-hygiene-cleanup/**`를 수정하지 마라. 이유: 이번 phase 무접촉 대상이며 `docs/news.md`는 사용자 소유의 미커밋 편집분이다.
- `docs/ADR.md`를 이 step에서 수정하지 마라. 이유: ADR-008 보강은 step13이 단독 소유하는 작업이다 — 같은 파일을 두 step이 만지면 diff scope 판정이 무너진다.
- `git add -A`/`git add .`로 스테이징하지 마라 — 이번 step이 만진 파일만 명시 경로로 `git add` 하라. 이유: 통짜 add는 사용자 소유 미커밋 파일을 커밋에 끌어들인다.
- 미커밋 사용자 파일을 `git restore`/`git checkout --`/`git stash`/`git clean`으로 되돌리거나 치우지 마라. 이유: 사용자 작업물이 소실된다.
