# Step 4: derive-http

후속/계속기사작성을 HTTP로 노출한다. **이 step은 얇은 transport 레이어(server/index.js)만 다룬다** — 파생 로직은 step3의 서비스/컨트롤러에 있다. 여기서는 세션 게이트 + author를 세션 사용자로 stamp + 컨트롤러 위임 + shape 매핑만 한다.

## 읽어야 할 파일

- `/docs/ADR.md` — ADR-004(role/identity는 세션에서만 도출), ADR-006(얇은 transport).
- `/docs/ARCHITECTURE.md` — 보안 경계, 데이터 흐름.
- `/docs/news.md` — 85행(후속/계속기사작성), 206행(신규 작성 RDS), 217행(부서 비면 세션 부서 stamp 관례는 POST /api/articles에 있음).
- step3 산출물: `src/services/articleService.js`(`deriveArticle(sourceId, mode, overrides)`), `src/controllers/index.js`(`article.derive`).
- 현재 구현(반드시 정독):
  - `server/index.js` — `POST /api/articles`(L218-230, 신규 생성·`me.role` 게이트·부서 stamp·`app.notifyChange('create')`·`delete dto.role` 패턴), `sessionOf`, 라우트 등록 순서.
  - 테스트 패턴: `test/server.test.js`, `test/body-contract.test.js`(실제 createApp 통합).

이전 코드를 정독하고, `POST /api/articles`가 어떻게 세션 게이트·부서 stamp·notifyChange를 하는지 이해한 뒤 작업하라.

## 작업

### TDD 순서: 먼저 실패 테스트를 쓴다

`test/server.test.js`(또는 신규 `test/derive.http.test.js`, 실제 `createApp` + `:memory:` db) 시나리오:

1. 로그인(예: reporter) → 원본 기사 생성 → `POST /api/articles/:id/derive` body `{ mode: 'continue' }` → 새 articleId(원본과 다름) 반환·status RDS. 새 기사의 `author`가 **세션 사용자**(body로 보낸 값이 아님)인지 확인.
2. `mode: 'followUp'`도 동작(본문 빈 값 — step3 규칙).
3. **원본 기사가 변경되지 않는다**(파생 후 원본 `GET /api/articles/:id`가 그대로).
4. 미인증(`x-session-id` 없음)은 401. 정의되지 않은 권한은 403(R/D/Z만 — 신규 작성 권한과 동일).
5. 알 수 없는 mode는 400(`unknown-mode`). 원본 없으면 404(`not-found`).
6. 성공 시 SSE 무효화 신호(`notifyChange('create')`)가 발생한다(새 기사 생성이므로).

먼저 실패를 확인한 뒤 구현한다.

### 구현: 라우트 `POST /api/articles/:id/derive`

`server/index.js`에 라우트를 추가하라. `POST /api/articles`(신규 생성) 패턴을 따른다:

- 세션 게이트: `me` 없으면 401. `ROLES.has(me.role)` 아니면 403(신규 작성과 동일 권한 — R/D/Z).
- body에서 `mode`만 읽는다(`'followUp'`|`'continue'`). 그 외 mode는 step3 서비스가 `unknown-mode`로 거부하므로 그대로 `fail(res, r, 400)`. (선택: 라우트에서 `ACTION`처럼 화이트리스트 검증을 먼저 해도 됨.)
- **author는 세션 사용자로 stamp**: `controllers.article.derive(req.params.id, mode, { author: me.name ?? me.userId })`. 부서가 비면(신규처럼) 세션 부서를 stamp할지 결정 — step3 `deriveArticle`이 원본 부서를 복사하면 그대로 두고, 비어 있으면 `POST /api/articles`의 부서 stamp 관례를 따른다(원본 부서 복사를 권장 — 같은 주제 기사이므로). **클라이언트가 보낸 author/role/articleId/status는 무시한다.**
- 결과 매핑: `r.ok`면 `app.notifyChange('create')` 후 `res.json(r)`. 아니면 `fail(res, r, 400)`(reason→상태코드 매핑은 기존 `STATUS_BY_REASON` 사용, `not-found`→404·`unknown-mode`는 fallback 400).
- `STATUS_BY_REASON`에 `unknown-mode`가 없으면 추가하라(400). additive 변경.
- **라우트 등록 순서:** `:id/derive`는 `/api/articles/:id`(단건 GET) 그룹에 둔다 — `/search`보다 뒤, 기존 `:id/action`·`:id/lock` 등과 정합. 정독한 순서를 깨지 마라.

이 step은 transport만 변경한다. 파생 로직(필드 복사·create)을 재구현하지 마라.

## Acceptance Criteria

```bash
npm run lint
npm run build
npm test
```

기존 테스트를 단 1개도 깨뜨리지 마라.

## 검증 절차

1. 위 AC 커맨드를 전부 실행한다.
2. 아키텍처 체크리스트:
   - 라우트가 세션 게이트→author stamp→컨트롤러 위임→shape 매핑만 하는가? 로직 재구현이 없는가? (ADR-006)
   - `author`가 클라이언트 값이 아닌 세션 사용자에서 stamp되는가? (ADR-004)
   - 원본 기사가 파생 후 불변인가? (DB 비파괴)
   - 미인증 401·미허가 권한 403·unknown-mode 400·not-found 404가 정확한가?
   - 성공 시 SSE `notifyChange('create')`가 발생하는가?
3. 결과에 따라 `phases/1-menu-actions/index.json`의 step 4를 업데이트한다(완료/error/blocked 양식 동일).

## 금지사항

- 클라이언트가 보낸 author/role/articleId/status를 신뢰하지 마라. 이유: ADR-004 — author는 세션에서 stamp, role은 세션에서 도출.
- 파생 필드 복사/articleId 발급을 server/index.js에서 재구현하지 마라. 이유: ADR-006 — step3 서비스에 있다. transport는 얇아야 한다.
- 원본 기사를 변경하는 라우트를 만들지 마라. 이유: 후속/계속은 새 기사 생성이다(DB 비파괴).
- 모델/서비스/컨트롤러/프론트를 이 step에서 수정하지 마라(`STATUS_BY_REASON`에 unknown-mode 추가는 예외). 이유: transport 단일 관심사.
- 기존 테스트를 깨뜨리지 마라.
