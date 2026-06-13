# Step 14: body-contract

프론트엔드↔백엔드 **본문(markupVersion) 데이터 유실**을 수정하고, 그 계약 이음새를 실제 서버를 거치는 통합 테스트로 못박는다. 목록에서 편집 진입 시 본문이 비는 문제(전체 기사 재조회 부재)도 함께 해결한다. **이 step은 데이터 round-trip(contract) 한 가지 관심사만 다룬다. 에디터 키 동작/임베드 보안은 step15·step16 소관이므로 건드리지 마라.**

## 근본 원인 (이 step에서 고치는 것)

### 14-A [Critical] 본문 데이터 유실
- 클라가 본문을 `body` 키로 전송한다. `web/src/controller/useWriteController.js`의 `save`(L165-175)/`submit`(L179-196)가 `dto = { ...tab.fields }`를 보내는데 `tab.fields`는 `{ title, body, author, embargoAt, secondEmbargoAt }`(L39, L51-57)로 본문이 `body` 키다.
- `web/src/model/httpModel.js`의 `saveArticle`(L102-107)은 dto를 그대로 POST/PUT 한다.
- 서버 `src/services/articleService.js`의 `ARTICLE_FIELDS = ['title','markupVersion','modifier']`(L12)로만 pick한다(`create` L60, `update` L74-77). 따라서 `body` 키는 Article·Contents 어느 컬럼에도 들어가지 않고 **매 저장마다 본문(텍스트+임베드+"(끝)")이 통째로 유실**된다.
- 연쇄 피해: 편집 후 송고 시 서버 send 가드 `hasEndMarker(row.article)`(articleService.js L98, markupVersion을 읽음)가 빈 markupVersion을 보고 `no-end-marker`로 거부한다.
- 363개 테스트가 통과한 이유: `web/src/test/fakeModel.js`의 `saveArticle`(L85-97)이 dto를 그대로 펼쳐 `body` 키로 저장 → 실제 서버의 pick(영속 필드만 골라내는) 이음새를 검증하지 못한다. **즉 fakeModel이 서버보다 관대해서 contract 불일치가 단위테스트에서 드러나지 않았다.**

### 14-B [High] 목록 편집 진입 시 빈 에디터
- 목록행은 `model.queryArticles` → 서버 `GET /api/articles` → `controllers.article.query` → `src/models/articleModel.js`의 `query`(L73-140)가 `SELECT * FROM Contents`만 반환한다. **Contents 테이블에는 본문 컬럼(markupVersion/content/body)이 없다**(본문은 Article 테이블, `src/db/schema.js` L17-23 참조).
- 그래서 편집 진입 경로(`web/src/controller/useViewController.js`의 `enterEditor` L93-100 → sessionStorage `pendingEdit` → `useWriteController.js`의 `openArticle`/`tabFromArticle` L45-60)에서 `article.body ?? article.markupVersion ?? article.content`(L53)가 전부 `undefined`다 → **편집 탭이 빈 본문으로 열린다.** 14-A와 합쳐지면 저장 시 빈 본문이 그대로 덮어쓰여 실제 기사 본문이 날아간다.

## 읽어야 할 파일

먼저 아래를 읽고 설계 의도를 파악하라. 특히 **본문은 항상 블록 markupVersion 문자열로 다룬다**는 규칙(아래 모든 계층이 공유)을 이해하라:

- `/docs/ADR.md` — ADR-002(SQLite/직접SQL·DB 비파괴), ADR-003(주입형 Model 계약, 백/프론트 잇는 단일 통합 seam), ADR-004(role은 서버 세션에서만 도출), ADR-006(controllers→services→models 계층).
- `/docs/ARCHITECTURE.md` — 디렉토리 구조, 데이터 흐름(쓰기 경로), DB 비파괴 원칙.
- `/docs/SCHEMA.md`, `/docs/news.md`(특히 167행 "본문은 텍스트/임베드 블록 구조(markupVersion)로 저장…편집-저장-불러오기를 반복해도 블록 순서가 보존" / 198-199행 편집 진입 시 제목·본문·공통정보 전부 불러오기).
- 프론트: `web/src/controller/useWriteController.js`, `web/src/controller/useViewController.js`, `web/src/model/httpModel.js`, `web/src/model/contract.js`, `web/src/test/fakeModel.js`, `web/src/view/writerBody.js`, `web/src/view/editorContent.js`.
- 백엔드: `src/services/articleService.js`, `src/models/articleModel.js`, `src/controllers/index.js`, `server/index.js`(특히 `POST /api/articles` L206-218, `PUT /api/articles/:id` L237-249, `GET /api/articles` L197-203).
- 테스트 패턴 참고: `test/integration.smoke.test.js`(in-memory `:memory:` db로 `createApp`을 띄워 fetch로 왕복하는 패턴), `test/server.test.js`, `web/src/controller/useWriteController.test.jsx`.

이전 step에서 만들어진 코드를 꼼꼼히 읽고, 본문이 어느 키로 흐르는지 계층별로 추적한 뒤 작업하라.

## 작업

### TDD 순서: 먼저 실패하는 재현 테스트를 쓴다

1. **서버 contract 통합 테스트(가장 중요)** — `test/integration.smoke.test.js` 또는 신규 `test/body-contract.test.js`(node --test)에 **실제 `createApp`(in-memory `:memory:` db)을 거치는** 테스트를 추가하라. fakeModel을 쓰지 마라(이 버그는 fakeModel이 가려왔다). 시나리오:
   - 로그인 → `POST /api/articles`로 본문이 담긴 markupVersion(예: `serialize`된 `{format:'yh-editor',version:1,blocks:[{type:'text',text:'제목'},{type:'text',text:'본문줄'},{type:'text',text:'(끝)'}]}` 문자열)을 저장.
   - 편집 잠금 획득(`POST /api/articles/:id/lock`) → `PUT /api/articles/:id`로 본문 markupVersion을 수정.
   - **단건 조회**로 저장된 본문이 그대로 보존됐는지 확인(아래 14-B에서 추가하는 `GET /api/articles/:id`를 사용). markupVersion이 `null`/빈 문자열이 아니라 저장한 블록 JSON과 동일해야 한다.
   - 편집 후 `POST /api/articles/:id/action` `send`가 `no-end-marker`로 거부되지 **않고** 성공하는지 확인(본문에 "(끝)"이 보존됐으므로).
   - 이 테스트가 현재 코드에서 **실패**하는 것을 먼저 확인한 뒤 구현한다.

2. **프론트 컨트롤러 단위 테스트** — `web/src/controller/useWriteController.test.jsx`에 추가: `save`/`submit` 호출 시 `model.saveArticle`로 넘어가는 dto에 본문이 **서버가 영속하는 키(`markupVersion`)로** 실린다는 것을 spy로 검증하라(`expect(saveSpy).toHaveBeenCalledWith(expect.objectContaining({ markupVersion: <블록문자열> }))`).

### 구현 14-A: 본문을 `markupVersion` 키로 전송

`web/src/controller/useWriteController.js`에서 `save`(L165-175)와 `submit`(L179-196)이 `model.saveArticle`에 넘기는 dto를 만들 때, **에디터 본문(`tab.fields.body`, 이미 `serialize`된 블록 markupVersion 문자열)을 `markupVersion` 키로 매핑**하라. 권장: dto 구성 시 `dto.markupVersion = tab.fields.body`를 세팅하고 `body` 키는 보내지 않는다(또는 `tab.fields` 자체를 `markupVersion`으로 바꾸는 리팩터링). 어떤 방식이든:
- `EDITABLE_FIELDS`(L15)와 `blankTab().fields`(L39), `tabFromArticle().fields`(L51-57)와 `WriterPage.jsx`가 읽는 `activeTab.fields.body`(WriterPage L50)가 **일관**되게 유지돼야 한다. 즉 내부 탭 상태 키를 바꾼다면 `WriterPage.jsx`/`writerBody.js` 호출부도 함께 일관되게 맞춰라(이 step 범위 내, 에디터 키동작 로직은 변경 금지).
- 로드(편집 진입) 시 본문 우선순위는 `article.markupVersion`을 최우선으로 한다(현재 L53은 `article.body`가 먼저라 잘못됐다). `tabFromArticle`의 본문 매핑을 `article.markupVersion ?? article.body ?? article.content ?? ''`로 바꿔라.

### 구현 14-A(보강): fakeModel을 실제 서버 shape에 맞춘다

`web/src/test/fakeModel.js`의 `saveArticle`(L85-97)이 **실제 영속 필드만 pick**하도록 맞춰라. 최소한 본문은 `markupVersion` 키만 저장하고 `body` 키는 저장하지 않도록(서버 `ARTICLE_FIELDS`와 동일하게) 정규화하라. 목적: contract 불일치가 단위테스트에서도 드러나게 하는 것. 단 기존 fakeModel 기반 363개 테스트가 깨지지 않도록, 본문을 읽는 쪽도 일관되게 `markupVersion`을 보게 맞춰라(필요하면 `queryArticles`/단건조회 흉내에도 동일 키 사용).

### 구현 14-B: 편집 진입 시 전체 기사 본문 재조회

목록행에는 본문이 없으므로(Contents만 조회), 편집 진입 시 **단건 기사(article+contents)를 재조회**해 본문을 채워야 한다.

1. **서버에 단건 조회 라우트 추가(additive·비파괴)** — `server/index.js`에 `GET /api/articles/:id`를 추가하라. 세션 게이트(미인증 401) 후 `controllers.article.getById(req.params.id)`를 호출해 `{ ok:true, article, contents }`(없으면 404 `not-found`)를 반환한다. **DB 행을 삭제/변경하지 마라(읽기 전용).** `:id` 라우트가 기존 `/api/articles/search`(L189) 등 다른 라우트와 충돌하지 않도록 등록 순서를 주의하라(Express는 `/api/articles/search`가 `/api/articles/:id`보다 먼저 매칭돼야 한다 — 더 구체적인 경로를 위에 둔다).
2. **컨트롤러 위임** — `src/controllers/index.js`의 `article`에 `getById: (articleId) => articleService.getById(articleId)` 또는 모델 직접 위임을 추가하라. `src/services/articleService.js`에 `getById(articleId)`가 없으면 `articleModel.getById`(이미 `{article,contents}` 반환, L47-52)를 얇게 위임하는 함수를 추가하고 service의 반환 객체(L160-163)에 노출하라. **비즈니스 로직 재구현 금지 — 위임만(ADR-006).**
3. **Model 계약 확장** — `web/src/model/contract.js`의 `MODEL_KEYS`에 `getArticle`을 추가하고, `web/src/model/httpModel.js`에 `getArticle(articleId)` → `GET /api/articles/:id` 매핑을 추가하라. `web/src/test/fakeModel.js`에도 `getArticle(articleId)`를 구현(in-memory에서 해당 기사 반환)해 `assertModel`을 통과시켜라. **transport는 httpModel 뒤에만(ADR-003) — 컨트롤러/뷰에서 직접 fetch 금지.**
4. **컨트롤러 결선** — `web/src/controller/useWriteController.js`의 `openArticle`(L142-154)에서, 목록행 article로 탭을 만들 때 **본문이 없으면(또는 항상) `model.getArticle(article.articleId)`로 전체 기사를 받아** markupVersion·공통정보를 채우도록 보강하라. 받은 `{article, contents}`를 `tabFromArticle`이 쓰는 평탄한 형태로 합쳐 본문(`markupVersion`)과 readOnly 메타를 채운다. 잠금 획득(L150-152)은 그대로 유지한다. 조회 실패 시에는 기존처럼 넘어온 article로 폴백한다(throw로 탭 열기가 막히면 안 됨).
   - `useViewController.js`의 `enterEditor`(L93-100)는 그대로 두어도 된다(여전히 sessionStorage로 article을 넘김). 본문 채우기는 `openArticle`이 책임진다. 단 `ListPage.jsx`의 `copyBody`(L63)가 빈 문자열을 복사하는 문제도 있으니, copyBody 역시 본문이 비면 무의미하다 — **copyBody 수정은 선택사항이며, 본문이 목록행에 없는 한 빈 값이 정상이다. 이 step에서 copyBody의 본문 소스를 바꿔 단건조회를 추가로 부르지는 마라(우클릭 1회에 네트워크 폭증 방지).** copyBody는 현행 유지.

## Acceptance Criteria

```bash
npm run lint                              # ESLint 통과 (web 포함)
npm run build                             # 프론트 빌드 에러 없음
npm test                                  # 백엔드 node --test 전부 통과
npm run test:web                          # Vitest 전부 통과
```

기존 363개 테스트(백엔드 175 + 프론트 188)를 단 1개도 깨뜨리지 마라. 신규 테스트(서버 contract 통합 + 프론트 컨트롤러 단위 + getArticle 계약)는 추가된다.

## 검증 절차

1. 위 AC 커맨드를 전부 실행한다.
2. 아키텍처 체크리스트:
   - 본문이 클라→서버→DB→재조회 round-trip에서 `markupVersion`으로 일관되게 흐르는가? (서버 `ARTICLE_FIELDS`와 클라 전송 키가 일치)
   - 새 contract 통합 테스트가 **fakeModel이 아닌 실제 `createApp`(in-memory db)** 을 거치는가? (이 버그를 fakeModel이 가렸으므로 필수)
   - transport(fetch/EventSource)가 `web/src/model/httpModel.js` 뒤에만 있는가? 컨트롤러/뷰에서 직접 fetch 호출이 없는가? (ADR-003)
   - 백엔드 컨트롤러가 로직을 재구현하지 않고 위임만 하는가? (ADR-006)
   - DB 행 삭제/덮어쓰기(스키마 DROP/DELETE)가 없는가? `GET /api/articles/:id`가 읽기 전용인가? (CLAUDE.md CRITICAL, ADR-002)
3. 결과에 따라 `phases/0-mvp/index.json`의 step 14를 업데이트한다:
   - 성공 → `"status": "completed"`, `"summary": "산출물 한 줄 요약"`
   - 수정 3회 실패 → `"status": "error"`, `"error_message": "구체적 에러"`
   - 사용자 개입 필요 → `"status": "blocked"`, `"blocked_reason": "사유"` 후 중단

## 금지사항

- 본문 데이터 round-trip 검증을 **fakeModel에만 의존하지 마라.** 이유: 이 Critical 버그는 fakeModel이 dto를 그대로 펼쳐 서버의 pick 이음새를 가렸기 때문에 363개 테스트가 통과했다. 반드시 실제 서버(`createApp`)를 거치는 통합 테스트로 못박아야 재발을 막는다.
- DB 행을 삭제하거나 스키마를 DROP/DELETE 하지 마라. 이유: CLAUDE.md CRITICAL·ADR-002 DB 비파괴 원칙. 단건 조회 라우트는 읽기 전용이어야 한다.
- 클라이언트에서 `role`을 서버로 보내지 마라. 이유: ADR-004 — acting role은 서버 세션에서만 도출한다. saveArticle/PUT/action 어디서도 role을 실으면 안 된다(서버는 이미 무시하지만 클라도 보내지 않는다).
- 컨트롤러/뷰에서 직접 `fetch`/`EventSource`를 호출하지 마라. 이유: ADR-003 — 모든 transport는 `httpModel` 뒤에만. `getArticle`도 반드시 Model 계약을 통해 추가한다.
- 에디터 키 동작("(끝)" 입력차단·Ctrl+D·IME 재색칠)이나 임베드 보안(iframe sandbox·src 검증)을 이 step에서 건드리지 마라. 이유: 각각 step15·step16의 응집 단위다. 범위를 섞으면 실패 격리가 불가능해진다.
- 기존 테스트를 깨뜨리지 마라.
