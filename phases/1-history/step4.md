# Step 4: history-model-contract

프론트엔드 Model 계약에 이력 조회 키 두 개를 추가하고, `httpModel`(실제 REST 배선)·`fakeModel`(테스트 가짜)에 구현한다. 이 step은 프론트 Model 레이어만 다룬다(View/Controller는 step 5).

## 읽어야 할 파일

- `/web/src/model/contract.js` — `MODEL_KEYS`(freeze 배열) + `assertModel`. 백엔드 라우트와 잇는 단일 통합 seam. **여기에 키 두 개를 추가**한다.
- `/web/src/model/httpModel.js` — REST 배선. `request(path, { method, query })` 단일 통로(세션 헤더 자동 첨부·JSON 역직렬화), `getArticle(articleId)`가 `GET /api/articles/:id`를 호출하는 패턴(encodeURIComponent 사용). **같은 패턴으로 이력 조회를 추가**한다. 응답 shape은 step 3 라우트와 1:1(`{ ok, items }`).
- `/web/src/test/fakeModel.js` — in-memory 가짜. `getArticle`/`queryArticles`가 seed 배열에서 응답을 만드는 패턴, `assertModel`을 통과해야 함. **이력 조회를 흉내내는 구현**을 추가한다.
- `/docs/ADR.md` — ADR-003(주입형 Model 계약, transport는 계약 뒤에 격리). View/Controller는 절대 직접 fetch 안 함.
- `phases/1-history/step3.md` — 백엔드 라우트 경로·응답 shape(`GET /api/articles/:id/history`, `/api/articles/:id/send-history` → `{ ok, items }`).

## 작업

TDD: **테스트를 먼저 작성**한 뒤 통과 구현.

1. `web/src/model/contract.js`: `MODEL_KEYS`에 `'getArticleHistory'`, `'getSendHistory'` 두 키를 추가한다(freeze 유지). 기존 키 순서/이름은 바꾸지 않는다.
2. `web/src/model/httpModel.js`: 두 메서드를 추가한다(`getArticle`와 동일한 `request`·encodeURIComponent 패턴):
   - `getArticleHistory(articleId)` → `GET /api/articles/{id}/history` → 응답 그대로 반환(`{ ok, items }`).
   - `getSendHistory(articleId)` → `GET /api/articles/{id}/send-history`.
   - **직접 fetch/EventSource를 새로 만들지 말고** 기존 `request` 통로를 쓴다(세션 헤더 자동 첨부 일관성).
3. `web/src/test/fakeModel.js`: 두 메서드를 구현한다. seed에 이력을 주입할 수 있게 `seed.histories`(또는 기존 컨벤션에 맞는 형태)를 받아, `getArticleHistory(articleId)`는 해당 기사의 이력을 `{ ok:true, items:[...] }`로, `getSendHistory`는 `eventType==='send'`만 반환한다. seed 미제공이면 빈 배열.
4. 테스트:
   - `contract.test.js`(있으면 확장): `MODEL_KEYS`에 두 키가 있고, `fakeModel`이 `assertModel`을 통과한다.
   - `fakeModel` 테스트: seed 이력으로 `getArticleHistory`/`getSendHistory`가 올바른 shape·필터로 응답한다.
   - (httpModel은 기존 테스트 컨벤션을 따른다 — fetch 모킹이 기존에 있으면 그 패턴으로 두 경로 호출을 검증, 없으면 contract/fakeModel 검증으로 충분.)

## Acceptance Criteria

```bash
npm run lint
npm run build
npm test
```

## 검증 절차

1. 위 AC 실행 — 기존 무회귀 + 신규 통과. `assertModel`이 통과해야 하므로 `httpModel`·`fakeModel` 둘 다 새 키를 구현했는지 확인(하나라도 누락 시 assertModel throw).
2. 체크리스트: `MODEL_KEYS`·`httpModel`·`fakeModel` 세 곳이 동기화됐는가? httpModel이 기존 `request` 통로(세션 헤더)를 쓰는가? 응답 shape이 step 3 라우트와 1:1(`{ ok, items }`)인가?
3. `phases/1-history/index.json`의 step 4 업데이트(completed + summary: 추가 키·메서드). 실패 시 error, 개입 필요 시 blocked.

## 금지사항

- View/Controller에서 직접 fetch를 호출하도록 유도하지 마라(이 step에선 둘을 건드리지 않는다). 이유: ADR-003 — transport는 Model 뒤에만.
- `MODEL_KEYS`의 기존 키를 재배치/개명하지 마라. 이유: 회귀(다른 모델 구현·테스트가 의존).
- 백엔드(라우트/서비스)나 View를 건드리지 마라. 이유: step 3은 완료, View는 step 5의 scope.
- 세 곳(contract/httpModel/fakeModel) 중 일부만 갱신하지 마라. 이유: `assertModel`이 누락을 throw하고 contract 불일치가 런타임에 터진다.
