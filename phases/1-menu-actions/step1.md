# Step 1: history-service

이력 데이터 접근(model)과 기록·조회(service)를 구현한다. **이력 기록 훅을 기존 `articleService`의 편집 저장(`update`)·생애주기 전이(`applyAction`)에 심는다.** 이 step은 백엔드 도메인 레이어(model + service)만 다룬다 — HTTP/컨트롤러/프론트는 이후 step 소관이다.

**핵심 전제:** 기존 기사에는 과거 이력이 없다. 기록은 지금부터 발생한 편집/전이부터 쌓인다. 이력 기록 실패가 본 기능(편집 저장/전이)을 막아서는 안 된다(이력은 부가 기록).

## 읽어야 할 파일

먼저 아래를 읽고 계층 분리(controllers→services→models→db, ADR-006)와 트랜잭션·비파괴 원칙을 파악하라:

- `/docs/ADR.md` — ADR-002(직접 SQL·DB 비파괴), ADR-006(서비스는 로직, 모델은 SQL, 의존성 주입).
- `/docs/ARCHITECTURE.md` — `src/models/`·`src/services/` 위치, 데이터 흐름.
- `/docs/SCHEMA.md` — `ArticleHistory` 테이블(step0에서 추가됨), 시간은 ISO-8601 UTC 문자열.
- `/docs/news.md` — 85행(이력보기/송고이력보기 메뉴), 205~219행(기사 생애주기 전이표 — status 이벤트가 기록할 전이).
- step0 산출물: `src/db/schema.js`의 `ArticleHistory` 정의(컬럼: id·articleId·eventType·action·fromStatus·toStatus·actorUserId·createdAt).
- 현재 구현(반드시 정독):
  - `src/models/articleModel.js` — 직접 SQL 패턴(`insertInto`/`updateSet`/`tx`), `getById`/`insert`/`update`/`query`.
  - `src/services/articleService.js` — `createArticleService({articleModel, db})`, 특히 `update(articleId, fields)`(L73-79)와 `applyAction(articleId, role, action, {userId})`(L96-114). 여기에 기록 훅을 심는다.
  - `src/controllers/index.js` — 서비스 결선 방식(어떤 의존성이 주입되는지). **이 step에선 controllers 파일을 수정하지 않지만**, articleService에 새 의존성(historyModel)을 추가하면 결선이 필요할 수 있다 — 아래 "구현" 참조.
  - 테스트 패턴: `test/articleModel.test.js`(in-memory db로 모델 SQL 검증), `test/articleService.test.js`·`test/editLock.test.js`(서비스를 가짜/인메모리 articleModel·db로 검증).

이전 step 코드를 정독하고, `update`/`applyAction`이 어디서 status 전이를 계산하는지 추적한 뒤 작업하라.

## 작업

### TDD 순서: 먼저 실패 테스트를 쓴다

1. **모델 테스트** `test/articleHistoryModel.test.js`(node --test, in-memory `:memory:` db + `createSchema`):
   - `insert(record)`가 `ArticleHistory`에 1행을 적재한다.
   - `queryByArticle(articleId)`가 해당 기사의 이력을 `createdAt`(또는 `id`) **오름차순/내림차순 일관된 순서**로 반환한다(순서를 테스트로 못박아라 — 권장: 최신순 `id DESC` 또는 `createdAt DESC`, 목록 표시에 맞춰 결정하고 주석으로 명시).
   - 다른 기사의 이력은 섞이지 않는다.
2. **서비스 테스트** `test/articleHistoryService.test.js` 또는 기존 `test/articleService.test.js`에 추가:
   - 편집 저장(`update`) 시 `eventType='edit'` 이력 1건이 기록된다(actorUserId 포함).
   - 생애주기 전이(`applyAction`)가 **성공할 때만** `eventType='status'` 이력 1건이 기록된다(`action`·`fromStatus`·`toStatus`·`actorUserId` 포함). 전이 거부(`{ok:false}`) 시 이력이 기록되지 **않는다**.
   - 송고(`send`) 전이는 `eventType='status'`, `action='send'`로 기록된다(송고이력보기가 이걸 필터한다).
   - **이력 기록이 실패해도(historyModel.insert가 throw) 편집/전이 자체는 정상 반환**되는지 검증하라(이력은 부가 기록 — try/catch로 격리).

### 구현 A: 이력 모델 `src/models/articleHistoryModel.js`

`createArticleHistoryModel(db)`를 만들고 `{ insert, queryByArticle }`를 반환하라. `articleModel.js`의 직접 SQL 패턴(`db.prepare(...).run/all`)을 그대로 따른다.

- `insert(record)` — `ArticleHistory`에 INSERT. record 키: `articleId, eventType, action, fromStatus, toStatus, actorUserId, createdAt`. 정의되지 않은 키는 무시(undefined는 컬럼 제외). `id`는 자동 증가이므로 넣지 않는다.
- `queryByArticle(articleId)` — `SELECT * FROM ArticleHistory WHERE articleId = ? ORDER BY id DESC`(또는 createdAt 기준 — 테스트와 일치). 읽기 전용.
- **행 삭제 함수를 두지 마라**(DB 비파괴).

### 구현 B: 이력 조회 서비스 + 기록 훅

`src/services/articleService.js`(또는 별도 `src/services/historyService.js`)에 이력 기록·조회를 추가하라. **권장: articleService에 `historyModel`을 주입**해 기록 훅을 한 트랜잭션 경계 가까이 둔다.

1. `createArticleService`의 인자에 `historyModel`을 추가하라(`{ articleModel, db, historyModel }`). **`historyModel`이 주입되지 않으면(undefined) 기록을 건너뛴다**(기존 테스트 호환 — 옵셔널). 권장 헬퍼:
   ```
   function record(rec) {
     if (!historyModel) return;
     try { historyModel.insert({ ...rec, createdAt: nowISO() }); }
     catch { /* 이력 기록 실패는 본 기능을 막지 않는다 */ }
   }
   ```
2. `update(articleId, fields)` 성공 후 `record({ articleId, eventType: 'edit', actorUserId: fields.modifier })`를 호출하라. (actor는 호출자가 fields.modifier로 넘긴 값 — HTTP 계층이 세션 userId를 stamp한다. step2 참조.)
3. `applyAction(articleId, role, action, {userId})`에서 **전이 성공 직후**(`articleModel.update` 호출 후) `record({ articleId, eventType: 'status', action, fromStatus: row.contents.status, toStatus: result.status, actorUserId: userId })`를 호출하라. 전이 거부(`{ok:false}`)·`no-end-marker` 거부 시에는 기록하지 않는다.
4. 조회 함수 `queryHistory(articleId)`를 서비스에 추가하고 반환 객체(L165-168)에 노출하라 — `historyModel.queryByArticle(articleId)`를 얇게 위임한다. **송고이력 필터는 서비스에서 옵션으로 처리**: `queryHistory(articleId, { sendOnly })` — `sendOnly`면 `eventType==='status' && action==='send'`만 반환. (필터를 서비스에 두는 이유: 모델은 순수 SQL, 분기는 도메인 규칙.)

### 구현 C: 결선(controllers) — 최소 변경

`src/controllers/index.js`에서 `createArticleHistoryModel(db)`를 결선하고 `createArticleService`에 `historyModel`로 주입하라. `article` 컨트롤러 객체에 `queryHistory: (articleId, opts) => articleService.queryHistory(articleId, opts)`를 추가하라(위임만 — ADR-006). **HTTP 라우트는 step2 소관이므로 server/index.js는 건드리지 마라.**

## Acceptance Criteria

```bash
npm run lint
npm run build
npm test           # 백엔드 — 신규 모델/서비스 이력 테스트 + 기존 전부 통과
```

기존 백엔드/프론트 테스트를 단 1개도 깨뜨리지 마라.

## 검증 절차

1. 위 AC 커맨드를 전부 실행한다.
2. 아키텍처 체크리스트:
   - 모델은 순수 SQL만, 분기/도메인 규칙은 서비스에 있는가? (ADR-006)
   - 이력 기록이 try/catch로 격리되어 본 기능(편집/전이)을 막지 않는가?
   - 전이 **성공 시에만** status 이력이 기록되는가? (거부 시 미기록)
   - `ArticleHistory`에 행 삭제 코드가 없는가? (DB 비파괴)
   - `historyModel` 미주입 시 기존 동작이 보존되는가?
3. 결과에 따라 `phases/1-menu-actions/index.json`의 step 1을 업데이트한다(완료/error/blocked는 step0과 동일 양식).

## 금지사항

- 이력 기록 실패가 편집 저장/전이를 실패시키게 만들지 마라. 이유: 이력은 부가 기록이다. insert throw를 try/catch로 삼켜라(본 워크플로우 무영향).
- 전이가 거부된 경우(`forbidden-transition`/`no-end-marker`/`not-found`)에 status 이력을 기록하지 마라. 이유: 실제로 일어나지 않은 전이를 이력에 남기면 거짓 기록이 된다.
- `actorUserId`를 클라이언트가 보낸 값으로 신뢰하지 마라. 이유: ADR-004 — actor는 서버 세션에서 도출된 userId여야 한다. 이 step은 인자로 받지만, step2 HTTP 계층이 반드시 세션 userId를 stamp한다(여기선 호출 계약만 맞춘다).
- `server/index.js`(HTTP 라우트)를 건드리지 마라. 이유: transport는 step2 소관 — 레이어를 섞으면 실패 격리가 불가능하다.
- 본문 markupVersion 스냅샷을 이력에 저장하지 마라. 이유: 이번 phase는 이벤트 로그만 다룬다(step0 동일 제약).
- 기존 테스트를 깨뜨리지 마라.
