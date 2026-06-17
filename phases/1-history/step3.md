# Step 3: history-controller-routes

이력 조회를 컨트롤러에 노출하고, 두 개의 읽기 전용 REST 라우트를 추가한다. 이 step은 백엔드 결선/transport 한 레이어만 다룬다.

## 읽어야 할 파일

- `/src/controllers/index.js` — `createControllers(db, ...)`에서 모델/서비스 결선. `articleModel`/`createArticleService({ articleModel, db })` 결선부와 `const article = { ... }` 진입점 묶음. **여기서 `articleHistoryModel`을 만들어 articleModel·articleService에 주입**하고, `article`에 조회 진입점을 추가한다.
- `/src/models/articleHistoryModel.js` — `createArticleHistoryModel(db)` (step 1).
- `/src/models/articleModel.js`·`/src/services/articleService.js` — step 2에서 historyModel 선택 주입을 받도록 확장됨. 주입을 실제로 연결한다.
- `/server/index.js` — 기사 라우트 패턴(line 188~300). 특히 `GET /api/articles/:id`(line 207~215)의 세션 게이트(`sessionOf(req)` → 미인증이면 401 `UNAUTH`) + `controllers.article.getById` 위임 + shape 매핑. `:id` 충돌을 피하려고 `/search`를 `:id`보다 먼저 등록한 점에 주의. `fail(res, result)` 헬퍼와 `STATUS_BY_REASON` 매핑.
- `/docs/ADR.md` — ADR-006(얇은 transport: 세션 검증→위임→shape 매핑만), ADR-004(role은 세션에서 도출).
- `phases/1-history/step2.md` — 서비스 시그니처(`getHistory`/`getSendHistory`).

## 작업

TDD: **테스트를 먼저 작성**한 뒤 통과 구현.

### (a) `src/controllers/index.js` — 결선
1. `const articleHistoryModel = createArticleHistoryModel(db);`를 만든다(import 추가).
2. `articleModel`·`articleService` 생성 시 `articleHistoryModel`을 주입한다(step 2가 받도록 만든 주입구 사용). 기존 다른 결선은 건드리지 않는다.
3. `const article = { ... }`에 진입점 두 개 추가(위임만, 로직 재구현 금지):
   - `getHistory: (articleId) => articleService.getHistory(articleId)`
   - `getSendHistory: (articleId) => articleService.getSendHistory(articleId)`

### (b) `server/index.js` — 라우트
4. 읽기 전용 GET 라우트 두 개를 추가한다. **반드시 `GET /api/articles/:id`(단건 조회)보다 위, 그리고 `/api/articles/search`처럼 구체 경로가 `:id`에 먹히지 않도록** 적절한 위치에 등록한다(예: `/api/articles/:id/history`, `/api/articles/:id/send-history` — 이들은 `:id` 뒤 하위 경로라 단건 `:id` 라우트와 충돌하지 않지만, 등록 순서·Express 매칭을 테스트로 확인하라).
   - `GET /api/articles/:id/history`:
     - 세션 게이트: `sessionOf(req)`로 `me` 도출, 없으면 `res.status(401).json(UNAUTH)`. (조회는 인증된 R/D/Z 모두 허용 — 별도 역할 게이트 없음. news.md 우클릭 메뉴는 4개 조회 메뉴 모두에서 이력보기를 제공.)
     - `controllers.article.getHistory(req.params.id)` 위임 → `res.json({ ok: true, items })`.
   - `GET /api/articles/:id/send-history`: 동일 패턴, `getSendHistory` 위임.
   - 라우트는 **읽기 전용**이다 — 어떤 쓰기/상태변경/SSE notify도 하지 않는다.
5. 테스트:
   - 컨트롤러 테스트(기존 controllers 테스트 확장): `getHistory`/`getSendHistory`가 서비스에 위임되고 배열을 반환한다.
   - 라우트 테스트(기존 server 테스트 패턴 따라 in-memory db로 app 구동, supertest 또는 기존 방식): 미인증 요청 → 401; 인증 요청 → `{ ok:true, items:[...] }`; `send-history`는 send 이벤트만; 존재하지 않는 기사면 빈 items(또는 기존 컨벤션에 맞춰 — 기존 `:id`가 404를 쓰지만 이력은 "이벤트 없음=빈 배열"이 자연스럽다. 빈 배열로 통일하고 테스트로 고정).

## Acceptance Criteria

```bash
npm run lint
npm run build
npm test
```

## 검증 절차

1. 위 AC 실행 — 기존 무회귀 + 신규 통과. 특히 기존 `/api/articles/:id` 단건 조회·`/search` 라우트가 새 라우트 추가로 깨지지 않았는지(라우트 매칭 충돌) 확인.
2. 체크리스트: 라우트가 세션 검증→위임→shape 매핑만 하는가(비즈니스 로직 없음)? 읽기 전용인가(쓰기/notify 없음)? role은 세션에서 도출하는가? 컨트롤러가 서비스에 위임만 하는가(로직 재구현 없음)?
3. `phases/1-history/index.json`의 step 3 업데이트(completed + summary: 추가 라우트·컨트롤러 진입점). 실패 시 error, 개입 필요 시 blocked.

## 금지사항

- 비즈니스 로직(이벤트 필터링·정렬·권한 판정)을 라우트나 컨트롤러에 재구현하지 마라. 이유: ADR-006 — 라우트는 transport·게이트만, 로직은 서비스/모델.
- 이력 라우트에서 쓰기/상태전이/`app.notifyChange`를 호출하지 마라. 이유: 이력 조회는 읽기 전용. DB 비파괴·부작용 없음.
- `req.body.role`을 신뢰하지 마라. 이유: ADR-004 — acting role은 세션에서만 도출.
- 프론트 코드(contract/httpModel/View)를 건드리지 마라. 이유: step 4~5의 scope.
- `/api/articles/:id` 단건 라우트나 `/search` 라우트의 동작을 바꾸지 마라. 이유: 회귀. 새 라우트는 추가만.
