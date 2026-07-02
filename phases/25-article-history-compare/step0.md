# Step 0: history-snapshot-backend — 편집 본문 스냅샷 기록 + 단건 스냅샷 조회 API

## 배경 / 요구사항

도구>기사이력비교(`tools.historyCompare`)는 **현재 편집 중인 기사의 과거 본문 스냅샷 두 개(또는 스냅샷↔현재본문)를 읽기 전용 diff로 비교**하는 기능이다. 그런데 현재 `ArticleHistory` 테이블은 **본문 스냅샷을 저장하지 않는다**(컬럼: articleId/eventType/action/fromStatus/toStatus/actorUserId/createdAt). 그래서 지금 데이터로는 과거 본문을 복원해 비교할 수 없다 — **이것이 이 phase의 핵심 gap이며, 이 step이 그 gap을 메운다.**

이 step은 **백엔드(server/ + src/)만** 다룬다:
1. `ArticleHistory`에 본문 스냅샷 컬럼 `markupVersion`(VARCHAR)을 **additive**로 추가(기존 멱등 마이그레이션 패턴).
2. 편집 저장(`articleService.update`, eventType=`edit`) 시 그 시점 본문(markupVersion)을 이력에 스냅샷으로 함께 기록.
3. 이력 목록(`queryByArticle`/`/history`)은 스냅샷 blob을 싣지 않고 **`hasSnapshot` 파생 플래그만** 노출(목록 경량 유지 — ListPage 이력보기 모달 회귀 방지).
4. 단건 스냅샷 본문을 반환하는 **새 읽기전용 엔드포인트** `GET /api/articles/:id/history/:historyId`(세션 게이트).

### 확정된 설계 결정 (그대로 구현)

- **스냅샷은 편집(edit) 이벤트에만 기록한다.** 생성(create)에는 기록하지 않는다.
  - 이유(반드시 준수): (a) `articleService.create`는 **현재 어떤 이력도 기록하지 않는다**(record() 호출 없음). 여기에 스냅샷용 record를 새로 넣으면 **새 이벤트 타입이 ListPage 이력보기 모달에 노출**되어 기존 모달 동작이 바뀐다(이 phase의 회귀 금지 제약 위반). (b) 기존 이력 카운트 테스트(`test/articleHistoryService.test.js`: create 후 update 시 이력 1건 등)가 깨진다.
  - 상태 전이(status) 이벤트는 본문이 불변이므로 스냅샷을 **기록하지 않는다(NULL)**. transition 경로의 record 호출은 markupVersion을 넘기지 않는다(NULL 유지).
  - **기존 행은 markupVersion이 NULL = 비교 불가(정상).** API/UI가 자연 처리한다(`hasSnapshot=false`).
- **목록 vs 상세 payload 분리(경량 목록 + 지연 단건 조회):**
  - 목록(`queryByArticle`)은 스냅샷 본문을 **SELECT하지 않고** `hasSnapshot`(스냅샷 존재 여부)만 파생 컬럼으로 반환한다. 이유: `/history`는 ListPage 이력보기/송고이력보기 모달도 쓴다 — 모든 이력 행에 본문 blob을 실으면 무겁고, 모달은 본문을 쓰지 않는다.
  - 상세(단건 본문)는 **별도 엔드포인트** `GET /api/articles/:id/history/:historyId`로 필요할 때만 조회한다. 비교 다이얼로그가 사용자가 고른 스냅샷 2개만 지연 조회한다.

## 읽어야 할 파일

- `/CLAUDE.md`, `/docs/ARCHITECTURE.md` — 백엔드 MVC(controllers→services→models→db), 얇은 transport, DB 비파괴, 명령어.
- `/docs/ADR.md` — ADR-002(node:sqlite 직접 SQL·멱등 마이그레이션·행 삭제 금지), ADR-004(세션 인가 — 읽기전용은 세션 게이트만), ADR-006(얇은 transport + 계층형 도메인).
- `/docs/SCHEMA.md` — ArticleHistory/Article 컬럼, 멱등 마이그레이션 원칙, 본문은 markupVersion에 블록 JSON.
- `/docs/news.md` L182 — 도구 메뉴 '기사이력비교'.
- `src/db/schema.js` — **결선 지점**: `SCHEMA.ArticleHistory` 배열(L58~67). `createSchema`(L85~102)는 배열에 컬럼 한 줄 추가하면 `CREATE TABLE IF NOT EXISTS` + `PRAGMA table_info`로 누락 컬럼만 `ALTER ADD COLUMN`한다(기존 DB에 자동·멱등·비파괴 반영). **이 패턴 그대로 쓴다 — 별도 마이그레이션 코드 금지.**
- `src/models/articleHistoryModel.js` — **결선 지점**: `HISTORY_COLS`(L6~8, insert 화이트리스트), `insert`(정의되지 않은 키 제외 → NULL 유지), `queryByArticle`(L25~28, `SELECT * ... ORDER BY id DESC`).
- `src/services/articleService.js` — **결선 지점**: `record()` 헬퍼(L59~63, try/catch 격리), `update()`의 record 호출(L91 — `record({ articleId, eventType:'edit', actorUserId: fields.modifier })`), `applyAction()`의 status record(L138~145), `queryHistory()`(L189~194). 여기에 단건 스냅샷 서비스 메서드를 추가한다.
- `src/controllers/index.js` — **결선 지점**: `const article = { ... queryHistory: ..., ... }`(L67~80). 여기에 단건 스냅샷 위임을 추가한다.
- `server/index.js` — **결선 지점**: `GET /api/articles/:id/history`(L419~429, 세션 게이트·읽기전용·`controllers.article.queryHistory` 위임). 이 라우트 바로 뒤에 `:historyId` 하위 라우트를 추가한다. `sessionOf(req)`/`UNAUTH` 사용법 참고.
- `test/schema.test.js` — 마이그레이션 테스트 컨벤션. **특히 L127~134** `'createSchema: ArticleHistory — markupVersion 본문 스냅샷 컬럼이 없다 (범위 밖)'` 테스트는 이제 **거짓이 되어 실패한다 — 반드시 갱신한다**(아래 작업 참조).
- `test/articleHistoryModel.test.js` — 모델 테스트 컨벤션(insert/queryByArticle). L52~62의 `queryByArticle`는 `rows.map(r => r.action)`만 단언하므로 컬럼 축소에 영향받지 않는다.
- `test/articleHistoryService.test.js` — 서비스 테스트 컨벤션(edit/status 이력, sendOnly 필터, 이력 실패 격리, historyModel 미주입). 스냅샷 단언을 여기에 추가한다.

## 작업

TDD로 진행한다(`node --test`). **테스트를 먼저 추가/갱신**하고 통과하는 구현을 만든다. 이 step은 하나의 백엔드 수직 슬라이스(schema→model→service→controller→route)이며 단일 계약(스냅샷 기록 + 단건 조회 API)으로 함께 검증한다.

### 1. 스키마 — `src/db/schema.js`
- `SCHEMA.ArticleHistory` 배열에 `['markupVersion', 'VARCHAR']` 한 줄을 **추가**한다(맨 끝에). 이유: 편집 시점 본문 스냅샷 저장.
- `createSchema`/`backfillEmptyDepartments`는 **수정하지 않는다** — 기존 additive 마이그레이션 로직이 기존 DB에 컬럼을 자동·멱등·비파괴로 추가한다.

### 2. 모델 — `src/models/articleHistoryModel.js`
- `HISTORY_COLS`에 `'markupVersion'`을 추가한다(insert 화이트리스트). 이유: 스냅샷을 insert할 수 있게. `insert`는 그대로 — undefined 키는 제외되므로 status 이벤트(markupVersion 미전달)는 NULL로 남는다.
- `queryByArticle(articleId)` — **본문 스냅샷(markupVersion)을 SELECT에서 제외**하고, 대신 스냅샷 존재 여부를 파생 플래그로 반환한다. 명시적 컬럼 목록으로 바꾼다:
  - 반환 컬럼: `id, articleId, eventType, action, fromStatus, toStatus, actorUserId, createdAt` + 파생 `hasSnapshot`(예: `CASE WHEN markupVersion IS NOT NULL AND markupVersion != '' THEN 1 ELSE 0 END AS hasSnapshot`). 정렬은 기존대로 `ORDER BY id DESC`.
  - 이유: 목록 경량 유지(모달·비교 다이얼로그의 선택 목록이 본문 blob 없이 스냅샷 존재만 알면 됨). `SELECT *`를 유지하면 markupVersion 전체 본문이 모든 이력 행에 실린다.
- 새 메서드 `querySnapshotById(articleId, id)`를 추가한다 — 단건 스냅샷 **본문 포함** 조회. `SELECT id, articleId, eventType, action, actorUserId, createdAt, markupVersion FROM ArticleHistory WHERE id = ? AND articleId = ?` → 행 또는 `undefined` 반환. **반드시 articleId로 스코프**한다(다른 기사의 스냅샷이 id만으로 새지 않게).
- `return { insert, queryByArticle, querySnapshotById }`로 노출. **행 삭제/UPDATE 함수는 추가하지 않는다**(append-only·DB 비파괴).

### 3. 서비스 — `src/services/articleService.js`
- `update()`의 record 호출에 본문 스냅샷을 추가한다:
  ```js
  record({ articleId, eventType: 'edit', actorUserId: fields.modifier, markupVersion: fields.markupVersion });
  ```
  - `fields.markupVersion`은 이 편집에서 저장되는 본문이다. 본문을 바꾸지 않는 메타 전용 편집이면 undefined → insert가 제외 → NULL 스냅샷(= 비교 불가, 정상).
  - `record()`의 try/catch 격리는 **유지**한다(이력 기록 실패가 편집 저장을 막지 않는다).
- `applyAction()`의 status record는 **그대로 둔다**(markupVersion 미전달 → NULL). 상태 전이는 본문 불변이므로 스냅샷 없음.
- `create()`에는 **record를 추가하지 않는다**(위 설계 결정 — create는 이력을 기록하지 않는 현 동작 유지).
- 새 메서드 `getHistorySnapshot(articleId, historyId)`를 추가한다 — `historyModel` 미주입이면 `{ ok: false, reason: 'not-found' }`. 그 외 `historyModel.querySnapshotById(articleId, historyId)` 결과가 없으면 `{ ok: false, reason: 'not-found' }`, 있으면 `{ ok: true, item }`(item에 markupVersion 포함). 반환 shape은 구현 재량이되 위 계약을 지킨다.
- `return { ... getHistorySnapshot }`로 노출.

### 4. 컨트롤러 — `src/controllers/index.js`
- `article` 객체에 위임을 추가한다(로직 재구현 금지, 위임만 — ADR-006):
  ```js
  getHistorySnapshot: (articleId, historyId) => articleService.getHistorySnapshot(articleId, historyId),
  ```

### 5. 라우트 — `server/index.js`
- `GET /api/articles/:id/history` 바로 뒤에 하위 라우트를 추가한다:
  ```js
  // 단건 이력 스냅샷 조회 — 기사이력비교용 본문(markupVersion) 반환. 세션 게이트, 읽기 전용(DB 비파괴).
  app.get('/api/articles/:id/history/:historyId', (req, res, next) => { ... });
  ```
  - 세션 게이트만(읽기전용 — ADR-004, `/history`와 동일). 미인증이면 401 `UNAUTH`.
  - `controllers.article.getHistorySnapshot(req.params.id, Number(req.params.historyId))`에 위임. `historyId`는 숫자 PK — `Number(...)`로 변환하고, 결과가 not-found면 404 `{ ok: false, reason: 'not-found' }`, ok면 200 `{ ok: true, item }`.
  - **라우트 순서**: `/history/:historyId`(5세그먼트)는 `/history`(4세그먼트)·`/:id`와 세그먼트 수가 달라 충돌하지 않는다. `/history` 바로 뒤에 둔다.

### 6. 테스트 (먼저 작성/갱신)
- `test/schema.test.js`:
  - **L127~134의 부정 단언 테스트를 교체**한다 — `markupVersion` 컬럼이 **존재함**을 단언하는 테스트로 바꾼다(`columns(db,'ArticleHistory').includes('markupVersion')`). 이유: 이제 컬럼이 있으므로 기존 부정 단언은 반드시 실패한다.
  - 구버전 ArticleHistory(markupVersion 없는 테이블) + 기존 행 → `createSchema` 후 컬럼이 additive로 추가되고 기존 행이 보존됨을 단언하는 마이그레이션 테스트를 추가한다(L153 패턴).
- `test/articleHistoryModel.test.js`:
  - `queryByArticle`가 markupVersion을 **반환하지 않고** `hasSnapshot`을 반환함을 단언(스냅샷 있는 edit 행=1/truthy, status 행=0/falsy).
  - `querySnapshotById`가 본문(markupVersion)을 반환하고, **다른 articleId의 id로는 조회되지 않음**(스코프)을 단언. 없는 id는 undefined.
- `test/articleHistoryService.test.js`:
  - `update()`(edit) 후 이력 행의 스냅샷(markupVersion)이 저장된 본문과 일치함을 단언.
  - status 전이 이력 행은 markupVersion이 NULL임을 단언(본문 불변).
  - `getHistorySnapshot(articleId, id)`가 스냅샷 본문을 반환하고, 존재하지 않는 id / 다른 기사 id는 `{ ok:false, reason:'not-found' }`임을 단언.
  - `getHistorySnapshot`이 `historyModel` 미주입 서비스에서 `{ ok:false, reason:'not-found' }`임을 단언(기존 미주입 보존 테스트 패턴).
- **(필수)** `server/index.js` 라우트 테스트 파일(기존 server route 테스트 컨벤션)에서 `GET /api/articles/:id/history/:historyId`가 **미인증 401·인증 시 200 item·없는 id 404**를 반환함을 단언한다. 이유: 신규 라우트의 인가 경계(세션 게이트, ADR-004)는 회귀·보안 관점에서 반드시 테스트로 고정한다 — "선택"으로 두지 말 것.

## Acceptance Criteria

```bash
npm run test          # 서버(node --test) — 스키마/모델/서비스/라우트 전체 통과(신규 스냅샷 단언 포함)
npm run lint          # ESLint
```

기대 단언(요약):
- `ArticleHistory`에 `markupVersion` 컬럼이 있고, markupVersion 없는 구버전 테이블에서 additive 마이그레이션 시 기존 행이 보존된다.
- 편집 저장(edit) 이력 행에 본문 스냅샷이 저장되고, status 전이 이력 행의 스냅샷은 NULL이다.
- `queryByArticle`는 본문 blob 없이 `hasSnapshot`만 반환한다(모달·기존 서비스 회귀 없음).
- `querySnapshotById`/`getHistorySnapshot`가 단건 본문을 articleId 스코프로 반환하고, 없는/타기사 id는 not-found다.
- `GET /api/articles/:id/history/:historyId`가 세션 게이트 아래 단건 스냅샷을 반환하고 없는 id는 404다.
- 기존 이력 테스트(edit/status 카운트·sendOnly·실패 격리·미주입 보존)가 **모두 그대로 통과**한다(회귀 없음).

## 검증 절차

1. 위 AC 커맨드를 실행한다(필요 시 `PYTHONUTF8=1`).
2. 아키텍처 체크리스트: additive 마이그레이션만(schema 배열 한 줄)·행 삭제/UPDATE 없음·append-only 유지·목록 경량(hasSnapshot)·단건 조회 articleId 스코프·세션 게이트(읽기전용)·record try/catch 격리 유지·컨트롤러는 위임만.
3. 결과에 따라 `phases/25-article-history-compare/index.json`의 step 0을 갱신(completed+summary / error / blocked).

## 금지사항

- `ArticleHistory` 행을 삭제하거나 기존 행을 UPDATE로 변형하지 마라. 이유: DB 비파괴·append-only 이력.
- `create()`에 이력 record를 추가하지 마라. 이유: create는 이력을 기록하지 않는 현 동작 유지 — 새 이벤트가 ListPage 이력 모달에 노출되고 기존 카운트 테스트가 깨진다(회귀 금지 제약).
- status 전이 record에 markupVersion을 넘기지 마라(NULL 유지). 이유: 상태 전이는 본문 불변 — 스냅샷은 편집 이벤트만.
- `queryByArticle`가 markupVersion(본문 blob)을 SELECT해 목록에 싣지 마라. 이유: `/history`는 이력보기/송고이력보기 모달도 쓰는 경량 목록 — 본문 blob은 단건 엔드포인트로만.
- `querySnapshotById`/단건 라우트에서 articleId 스코프를 빼고 id만으로 조회하지 마라. 이유: 다른 기사의 스냅샷 유출 방지.
- `record()`의 try/catch 격리를 제거하지 마라. 이유: 이력 기록 실패가 편집 저장/전이를 막으면 안 된다.
- 단건 스냅샷 라우트에 역할(R/D/Z) 게이트를 붙이지 마라(세션 게이트만). 이유: 읽기전용은 `/history`와 동일하게 세션만(ADR-004).
- `createSchema`/`backfillEmptyDepartments`, `web/`(프론트), fakeModel/contract를 이 step에서 건드리지 마라. 이유: 이 step은 백엔드 스냅샷 계약만 — 클라이언트 결선은 step1·step2.
- `test/schema.test.js`의 markupVersion 부정 단언(L127~134)을 그대로 남겨두지 마라. 이유: 컬럼이 추가되어 반드시 실패한다 — 긍정 단언으로 교체한다.
