# Step 7: frontend-model-contract

백엔드(step2·4·6)가 노출한 새 라우트를 프론트엔드 **Model 계약**에 추가한다. 이 step은 프론트엔드 Model 레이어만 다룬다 — transport(fetch)는 `httpModel` 뒤에만 두고(ADR-003), 계약·httpModel·fakeModel을 동기화한다. View/Controller는 이후 step(8·9·10) 소관이다.

추가할 계약 메서드 3개: `queryHistory`(이력보기·송고이력보기), `deriveArticle`(후속/계속기사작성), `translate`(번역).

## 읽어야 할 파일

- `/docs/ADR.md` — ADR-003(주입형 Model 계약·`MODEL_KEYS`·transport는 httpModel 뒤에만·테스트는 fakeModel).
- `/docs/ARCHITECTURE.md` — 프론트엔드 MVC(View←Controller←Model), 데이터 흐름.
- step2/4/6 산출물(라우트 계약 — 정확한 path·method·응답 shape를 여기에 맞춘다):
  - `GET /api/articles/:id/history?sendOnly=...` → `{ ok, items }`
  - `POST /api/articles/:id/derive` body `{ mode }` → `{ ok, articleId }`
  - 번역 라우트(step6에서 (A) `POST /api/articles/:id/translate` 또는 (B) `POST /api/translate`) → `{ ok, translatedText, ... }`. **step6이 택한 형태를 확인하고 맞춰라.**
- 현재 구현(반드시 정독 — 이 패턴을 그대로 따른다):
  - `web/src/model/contract.js` — `MODEL_KEYS`(Object.freeze 배열)·`assertModel`(모든 키가 함수인지 검증).
  - `web/src/model/httpModel.js` — `request(path, {method, body, query})` 단일 통로·세션 헤더 자동 첨부·기존 메서드(`getArticle`·`applyAction`·`saveArticle` 등)의 path/method 매핑. `buildQuery` 사용법.
  - `web/src/test/fakeModel.js` — in-memory 계약 구현(`getArticle`·`saveArticle` 등)·`assertModel` 통과.
  - 테스트 패턴: `web/src/model/contract.test.js`·`web/src/model/httpModel.test.js`(URL/메서드/헤더·assertModel 강제·fakeModel 계약 충족 검증).

이전 코드를 정독하고, 기존 메서드가 `MODEL_KEYS`→`httpModel`→`fakeModel` 3곳에서 어떻게 일관되게 정의되는지 이해한 뒤 작업하라.

## 작업

### TDD 순서: 먼저 실패 테스트를 쓴다

`web/src/model/contract.test.js`·`web/src/model/httpModel.test.js`에 추가(vitest):

1. `assertModel`이 새 키 3개(`queryHistory`·`deriveArticle`·`translate`)를 요구한다(누락 시 throw — 기존 강제 패턴).
2. `httpModel.queryHistory(articleId, { sendOnly })`가 `GET /api/articles/:id/history`를 올바른 query로 호출한다(fetch spy로 URL·method 검증).
3. `httpModel.deriveArticle(articleId, mode)`가 `POST /api/articles/:id/derive` body `{ mode }`를 호출한다. **role을 싣지 않는다**(ADR-004).
4. `httpModel.translate(articleId, targetLang)`(또는 step6 형태에 맞춤)가 올바른 path/method/body로 호출된다.
5. `fakeModel`이 세 메서드를 구현해 `assertModel`을 통과한다.

먼저 실패를 확인한 뒤 구현한다.

### 구현 A: 계약 `web/src/model/contract.js`

`MODEL_KEYS`(현재 19키)에 `'queryHistory'`, `'deriveArticle'`, `'translate'`를 추가하라(additive — 기존 키 제거/순서변경 금지).

### 구현 B: httpModel `web/src/model/httpModel.js`

세 메서드를 추가하라(기존 `request` 통로 사용 — 직접 fetch 금지):

```
queryHistory(articleId, { sendOnly } = {}) {
  return request(`/api/articles/${encodeURIComponent(articleId)}/history`, { query: sendOnly ? { sendOnly: 1 } : {} });
}
deriveArticle(articleId, mode) {
  return request(`/api/articles/${encodeURIComponent(articleId)}/derive`, { method: 'POST', body: { mode } });
}
translate(articleId, targetLang = 'ko') {
  // step6이 택한 형태에 맞춤:
  // (A) POST /api/articles/:id/translate body { targetLang }
  // (B) POST /api/translate body { text, targetLang } — 이 경우 시그니처를 translate(text, targetLang)로 맞추고 contract/fakeModel/테스트 일관화
}
```

- **role을 body에 싣지 마라**(ADR-004 — 서버 세션 도출).
- path encoding·세션 헤더는 `request`가 처리하므로 기존 메서드와 동일하게.

### 구현 C: fakeModel `web/src/test/fakeModel.js`

세 메서드를 in-memory로 구현하라(`assertModel` 통과·기존 248+ 테스트 무회귀):

- `queryHistory(articleId, opts)` — seed에 넣어둔 이력 배열(또는 빈 배열)을 반환 `{ ok:true, items }`. `sendOnly`면 필터. 최소 구현으로 충분(컨트롤러 테스트가 seed로 주입).
- `deriveArticle(articleId, mode)` — `saveArticle`처럼 새 articleId를 만들어 articles에 push하고 `notify('create')` 후 `{ ok:true, articleId }`. **원본은 변경하지 않는다**(in-memory에서도 비파괴 모사).
- `translate(articleId, targetLang)` — `{ ok:true, translatedText: <seed 또는 원문 모사> }`. 최소 구현.

## Acceptance Criteria

```bash
npm run lint
npm run build
npm test            # 백엔드 무회귀
npm run test:web    # 프론트 — 신규 계약/httpModel/fakeModel 테스트 + 기존 전부 통과
```

기존 프론트/백엔드 테스트를 단 1개도 깨뜨리지 마라.

## 검증 절차

1. 위 AC 커맨드를 전부 실행한다.
2. 아키텍처 체크리스트:
   - `MODEL_KEYS`·`httpModel`·`fakeModel` 3곳이 새 메서드에 대해 일관된가? `assertModel`이 강제하는가? (ADR-003)
   - transport(fetch)가 `httpModel` 뒤에만 있는가? 계약/fakeModel에 직접 fetch가 없는가?
   - httpModel 메서드가 step2/4/6 라우트의 path/method/응답 shape와 정확히 일치하는가?
   - `deriveArticle`/`translate`가 role을 싣지 않는가? (ADR-004)
   - fakeModel `deriveArticle`이 원본을 변경하지 않는가?
3. 결과에 따라 `phases/1-menu-actions/index.json`의 step 7을 업데이트한다(완료/error/blocked 양식 동일).

## 금지사항

- 계약/fakeModel/컨트롤러/뷰에서 직접 `fetch`/`EventSource`를 호출하지 마라. 이유: ADR-003 — 모든 transport는 httpModel 뒤에만.
- `deriveArticle`/`translate` 호출에 role/sessionId를 body로 싣지 마라. 이유: ADR-004 — 서버가 세션에서 도출. 세션 헤더는 `request`가 자동 첨부한다.
- 기존 `MODEL_KEYS` 키를 제거하거나 순서를 바꾸지 마라. 이유: 다른 메서드의 계약 검증이 깨진다(additive만).
- View/Controller(useViewController·ListPage·ContextMenu 등)를 이 step에서 수정하지 마라. 이유: Model 레이어 단일 관심사 — 결선은 step8·9·10.
- 기존 테스트를 깨뜨리지 마라.
