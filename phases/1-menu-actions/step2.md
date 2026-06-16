# Step 2: history-http

이력 조회를 HTTP로 노출한다. **이 step은 얇은 transport 레이어(server/index.js)만 다룬다** — 비즈니스 로직은 step1의 컨트롤러/서비스에 이미 있다. 여기서는 세션 게이트 + 컨트롤러 위임 + shape 매핑만 한다(ADR-006).

추가로, step1에서 `update`/`applyAction`이 `actorUserId`를 기록하도록 만들었으므로, **HTTP 계층이 세션 userId를 actor로 stamp**하는 것을 보증한다(ADR-004 — actor는 서버 세션에서만 도출).

## 읽어야 할 파일

먼저 아래를 읽고 얇은 transport·세션 인가 게이트 패턴을 파악하라:

- `/docs/ADR.md` — ADR-004(acting role/identity는 검증된 `x-session-id` 세션에서만 도출, `req.body.role` 불신), ADR-006(얇은 transport — 세션 검증→인가 게이트→컨트롤러 위임→응답 매핑).
- `/docs/ARCHITECTURE.md` — 보안 경계 섹션, 데이터 흐름.
- `/docs/news.md` — 85행(이력보기/송고이력보기), 173~188행(API 명세 — 기존 라우트 네이밍 관례).
- step0/step1 산출물: `src/db/schema.js`(ArticleHistory), `src/models/articleHistoryModel.js`, `src/services/articleService.js`(`queryHistory(articleId, {sendOnly})`·기록 훅), `src/controllers/index.js`(`article.queryHistory` 위임).
- 현재 구현(반드시 정독):
  - `server/index.js` — 특히 `sessionOf(req)`(L95-98, x-session-id→검증 신원), `GET /api/articles/:id`(L207-215, 단건 조회 — 세션 게이트·404 패턴), `PUT /api/articles/:id`(L249-261, `fields.modifier = me.userId` stamp 패턴), `POST /api/articles/:id/action`(L234-246, `{ userId: me.userId }` 전달), 라우트 등록 순서 주의(`/search`가 `:id`보다 먼저).
  - 테스트 패턴: `test/server.test.js`(in-memory `createApp` + 세션으로 fetch 왕복), `test/body-contract.test.js`(실제 createApp 통합 패턴).

이전 코드를 정독하고, `:id` 하위 라우트 등록 순서와 세션 stamp 패턴을 이해한 뒤 작업하라.

## 작업

### TDD 순서: 먼저 실패 테스트를 쓴다

`test/server.test.js`(또는 신규 `test/history.http.test.js`, node --test, 실제 `createApp` + `:memory:` db) 시나리오:

1. 로그인 → 기사 생성(`POST /api/articles`) → 편집 잠금 획득 → `PUT /api/articles/:id`로 편집 저장 → `GET /api/articles/:id/history`가 `eventType='edit'` 이력 1건을 반환하고 그 `actorUserId`가 **세션 사용자(req.body.modifier가 아님)** 인지 확인.
2. `POST /api/articles/:id/action`(예: D 권한 send→DPS) 성공 후 `GET /api/articles/:id/history`에 `eventType='status'`, `action='send'` 이력이 포함된다.
3. `GET /api/articles/:id/history?sendOnly=1`(또는 `?type=send`)가 송고 이력만 반환한다(편집 이력 제외).
4. 미인증 요청(`x-session-id` 없음)은 401 `unauthenticated`.
5. 과거 이력이 없는(이번 phase 이전 생성) 기사 조회 시 빈 배열 `items: []`를 반환한다(404가 아님 — 이력 없음은 정상).

먼저 실패를 확인한 뒤 구현한다.

### 구현 A: 이력 조회 라우트 `GET /api/articles/:id/history`

`server/index.js`에 라우트를 추가하라:

- 세션 게이트: `sessionOf(req)`로 `me`가 없으면 `401 unauthenticated`(기존 `UNAUTH` 상수 재사용).
- 쿼리 파라미터 `sendOnly`(또는 `type=send`)를 읽어 `controllers.article.queryHistory(req.params.id, { sendOnly })`에 전달.
- 응답 shape: `{ ok: true, items: [...] }`. 이력이 없으면 빈 배열.
- **읽기 전용 — DB 행을 변경/삭제하지 마라.**
- **라우트 등록 순서:** `/api/articles/:id/history`는 `:id` 하위 경로이므로 Express 매칭 충돌이 없도록 기존 `/api/articles/:id`(단건), `/api/articles/:id/action` 등과 동일한 그룹에 두되, 더 구체적인 `/search` 뒤에 둔다(기존 관례 유지). 정독한 등록 순서를 깨지 마라.

### 구현 B: actor stamp 보증(이미 step1 계약과 정합)

`PUT /api/articles/:id`(L249-261)는 이미 `fields.modifier = me.userId`를 stamp한다 → step1의 `update`가 `actorUserId: fields.modifier`로 기록하므로 **세션 userId가 actor가 된다**(추가 변경 불필요할 수 있음 — 확인만 하라). `POST /api/articles/:id/action`도 이미 `{ userId: me.userId }`를 전달한다 → step1의 `applyAction`이 `actorUserId: userId`로 기록한다. **만약 step1 계약과 어긋나면 여기서 stamp를 보강**하되, 클라이언트가 보낸 actorUserId/modifier/role을 신뢰하지 마라(ADR-004).

이 step은 transport만 변경한다. 서비스/모델 로직을 재구현하지 마라.

## Acceptance Criteria

```bash
npm run lint
npm run build
npm test           # 백엔드 — 신규 history HTTP 통합 테스트 + 기존 전부 통과
```

기존 테스트를 단 1개도 깨뜨리지 마라.

## 검증 절차

1. 위 AC 커맨드를 전부 실행한다.
2. 아키텍처 체크리스트:
   - 라우트가 세션 검증→컨트롤러 위임→shape 매핑만 하는가? 비즈니스 로직 재구현이 없는가? (ADR-006)
   - `actorUserId`가 클라이언트 값이 아니라 세션 userId에서 도출되는가? (ADR-004)
   - 이력 조회가 읽기 전용인가? (DB 비파괴)
   - 미인증 요청이 401인가? 이력 없음이 빈 배열인가(404 아님)?
   - `:id` 하위 라우트 등록 순서가 기존 라우트와 충돌하지 않는가?
3. 결과에 따라 `phases/1-menu-actions/index.json`의 step 2를 업데이트한다(완료/error/blocked 양식 동일).

## 금지사항

- `req.body`/쿼리에서 받은 actor/modifier/role을 신뢰하지 마라. 이유: ADR-004 — actor·role은 검증된 세션에서만 도출한다.
- 비즈니스 로직(이력 필터·SQL)을 server/index.js에서 재구현하지 마라. 이유: ADR-006 — transport는 얇아야 한다. 필터는 step1 서비스에 있다.
- 이력 조회 라우트에서 DB 행을 쓰거나 삭제하지 마라. 이유: 읽기 전용·DB 비파괴(CLAUDE.md CRITICAL).
- 모델/서비스/컨트롤러 파일이나 프론트엔드를 이 step에서 수정하지 마라(actor stamp 보강 외). 이유: transport 단일 관심사 — 프론트 결선은 step7~8 소관.
- 기존 테스트를 깨뜨리지 마라.
