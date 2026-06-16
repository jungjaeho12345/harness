# Step 2: mapping-view-entry

list.do 우클릭에서 `매핑`을 고르면 대상 기사를 writer.do로 넘겨 **매핑 모드 편집 탭**을 여는 콜백을 `useViewController`에 추가한다. 이 step은 **프론트 컨트롤러 한 모듈(`web/src/controller/useViewController.js`)** 만 다룬다. writer 쪽 진입 처리(`mode:'mapping'`)는 step 0에서 이미 만들었고, WriterPage UI 분기는 step3, ContextMenu 활성화/ListPage 결선은 step4다.

## 읽어야 할 파일

먼저 아래 파일들을 읽고 프로젝트의 아키텍처와 설계 의도를 파악하라:

- `/docs/ADR.md` — ADR-003(Model 계약 경유·직접 fetch 금지), ADR-004(role 불신).
- `/docs/news.md` — line 85~88(컨텍스트 메뉴 `매핑`), line 121~127(편집 잠금), line 199~203(편집 진입 매핑 규칙).
- `/web/src/controller/useViewController.js` — **이 step에서 수정할 파일.** 핵심 이해 포인트:
  - `PENDING_EDIT_KEY`(export) — list.do→writer.do 편집 진입 채널. shape `{ article, mode }`.
  - `enterEditor(article, mode)` — `PENDING_EDIT_KEY`에 `{article, mode}`를 try/catch로 쓰고 `navigate('writer.do', { articleId: article.articleId })`로 이동(편집 탭 주소창에 기사아이디 포함). 매핑도 **편집 진입이므로 이 enterEditor를 재사용**한다.
  - `editArticle(article)=enterEditor(article,'edit')`, `reviseArticle(article,portal)=enterEditor(article, portal?'portalRevise':'revise')` — 매핑 콜백도 이 패턴을 따른다.
  - `enterFromSource`/`followUpArticle`/`continueArticle` — 후속/계속(신규 채널 PENDING_NEW_KEY). **매핑은 이 신규 경로를 쓰지 않는다**(매핑은 잠금이 필요한 편집 진입). 혼동하지 마라.
  - `resendArticle`/`releaseLock`/`requestDelete`처럼 권한 게이트(canManage)·confirm을 두는 콜백도 있으나, **매핑은 일반 편집 진입이라 권한 게이트·confirm을 두지 않는다**(고침/포털고침처럼 단순 편집 진입이며 파괴적 동작 아님 — 서버 lock/PUT이 잠금·권한을 강제한다).
- `/web/src/controller/useWriteController.js` — step 0에서 추가한 `mode:'mapping'` 진입 처리 확인(PENDING_EDIT_KEY를 마운트 시 소비해 `openArticle(req.article, 'mapping')`로 연다). 이 파일은 **수정하지 마라**(읽기만).
- `/web/src/controller/useViewController.test.jsx` — 기존 컨트롤러 테스트(fakeModel/AppContext 주입, sessionStorage 채널·navigate 단언) 패턴. editArticle/reviseArticle 테스트 케이스를 참고해 매핑 케이스를 추가한다.

이전에 만들어진 코드를 꼼꼼히 읽고 설계 의도를 이해한 뒤 작업하라.

## 작업

TDD: **테스트를 먼저 작성**한 뒤 통과하는 구현을 작성한다.

`/web/src/controller/useViewController.js`에 매핑 진입 콜백을 추가한다.

핵심 결정(반드시 따른다):
- 매핑은 **편집 진입**이다 → 후속/계속의 신규 채널(`PENDING_NEW_KEY`)이 아니라 **편집 채널(`PENDING_EDIT_KEY`)** 에 `{ article, mode:'mapping' }`을 싣고, `navigate('writer.do', { articleId: article.articleId })`로 이동한다(편집 탭 주소창에 기사아이디 포함 — writer가 잠금을 획득). 즉 `enterEditor`를 그대로 재사용한다.
- 매핑은 일반 편집 진입이므로 **권한 게이트(canManage)·confirm을 두지 않는다**. 서버가 `lockArticle`(잠금)·`PUT`(잠금 보유자 검증)으로 권한·동시성을 강제한다(ADR-004).

구현(시그니처는 재량, 기존 패턴 재사용):
- `mapArticle(article)` (이름 재량) 콜백을 추가한다 — `enterEditor(article, 'mapping')`. `useCallback`으로 감싸고 의존성은 `[enterEditor]`.
- 반환 객체에 `mapArticle`(또는 채택한 이름)을 노출한다. step4의 ListPage가 `onCtxSelect`의 `case 'mapping'`에서 호출한다.
- `editArticle`/`reviseArticle`/`followUpArticle` 등 기존 콜백은 변경하지 마라.

테스트(`useViewController.test.jsx`에 케이스 추가):
- `mapArticle(article)` 호출 시 `PENDING_EDIT_KEY`에 `{article, mode:'mapping'}`이 저장되고 `navigate`가 `'writer.do', {articleId: article.articleId}`로 호출되는지(편집 진입 채널·기사아이디 포함).
- 후속/계속의 신규 채널(`PENDING_NEW_KEY`)에는 **쓰지 않는지**(매핑은 편집 채널만 사용).
- 권한이 R이어도 confirm 없이 진입하는지(권한 게이트 없음 — 서버가 잠금/PUT으로 강제).
- 기존 editArticle/reviseArticle/followUpArticle/resendArticle 동작이 무회귀인지.

## Acceptance Criteria

```bash
npm run lint
npm run build
npm run test:web
```

## 검증 절차

1. 위 AC를 실행한다. 기존 web 테스트 + 신규 테스트가 모두 통과해야 한다(무회귀).
2. 아키텍처 체크리스트:
   - 매핑 진입이 편집 채널(`PENDING_EDIT_KEY`)을 쓰고 mode `'mapping'`·articleId 포함 navigate를 하는가(신규 채널 미사용)?
   - 권한 게이트/confirm 없이 진입하는가(일반 편집 진입)?
   - 직접 fetch/EventSource 없이 채널+navigate만 하는가(ADR-003)? role을 싣지 않는가(ADR-004)?
   - 본문 조회/dto 조립을 여기서 하지 않는가(writer openArticle 책임)?
3. `phases/3-mapping/index.json`의 step 2를 업데이트(completed + summary: 추가한 콜백 이름·편집 채널 재사용·mode 'mapping'·권한 게이트 없음). 실패 시 error, 개입 필요 시 blocked.

## 금지사항

- 매핑을 신규 채널(`PENDING_NEW_KEY`)로 보내거나 navigate에서 articleId를 빼지 마라. 이유: 매핑은 기존 기사 편집(잠금 필요)이다 — 신규 채널/articleId 누락 시 writer가 잠금을 획득하지 못하거나 신규 작성으로 오인한다.
- 권한 게이트(canManage)나 confirm을 추가하지 마라. 이유: 매핑은 단순 편집 진입(고침/포털고침과 동일 성격)이며 파괴적 동작이 아니다 — 권한·동시성은 서버 lock/PUT이 강제한다.
- 여기서 본문(markupVersion)을 조회하거나 dto를 조립하지 마라. 이유: 본문 재조회·잠금은 writer의 `openArticle` 책임이다(중복 결선 금지).
- `useWriteController.js`/`ContextMenu.jsx`/`ListPage.jsx`를 수정하지 마라. 이유: 이 step은 컨트롤러 콜백만 추가한다 — 메뉴 활성화/결선은 step4 소관이다.
- 기존 테스트를 깨뜨리지 마라.
