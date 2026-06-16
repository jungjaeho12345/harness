# Step 0: resend-action

`재송`(resend) 컨텍스트 메뉴 동작을 `useViewController`에 추가한다. 이 step은 **프론트 컨트롤러 한 모듈(useViewController.js)** 만 다룬다. ContextMenu/ListPage 결선은 다음 step(step3) 소관이다 — 여기서는 컨트롤러가 노출하는 콜백만 만든다.

## 읽어야 할 파일

먼저 아래 파일들을 읽고 프로젝트의 아키텍처와 설계 의도를 파악하라:

- `/docs/ADR.md` — 특히 ADR-003(프론트 View←Controller←Model 계약, 직접 fetch 금지), ADR-004(acting role은 서버 세션에서만 도출 — 클라가 role을 보내지 않는다).
- `/docs/news.md` — line 85~88(컨텍스트 메뉴 항목·`재송`이 현재 비활성), **line 217(`DPS 기사를 송고하면 DPS가 유지되고(재송고)`, DPS는 바로 KILL 불가)**, line 72("(끝)" 마커 없으면 송고 차단), line 140(확인창 정책).
- `/src/services/lifecycle.js` — 전이표. `DESK_TABLE.DPS.send='DPS'`(재송고 = 일반 send 전이가 DPS를 DPS로 유지), `REPORTER_TABLE`에는 DPS 항목이 없음(R은 DPS를 전이 불가).
- `/src/services/articleService.js` — `applyAction(articleId, role, action, {userId})`. send는 `hasEndMarker` 가드를 통과해야 한다(없으면 `{ok:false,reason:'no-end-marker'}`). role은 인자로 받되 서버 HTTP 계층이 세션에서 도출한다.
- `/web/src/controller/useViewController.js` — **이 step에서 수정할 파일.** 기존 `requestDelete`(applyAction 'approveDelete' + confirm + D/Z 게이트)와 `viewHistory`/`viewSendHistory` 패턴을 그대로 따른다. `canManage(identity)`(D/Z 판정) 헬퍼가 이미 있다.
- `/web/src/model/httpModel.js` — `applyAction(articleId, action)`는 `POST /api/articles/:id/action`에 `{action}`만 싣는다(role 미포함, ADR-004). 신규 Model 키가 필요 없음을 확인하라.
- `/web/src/controller/useViewController.test.jsx` — 기존 컨트롤러 테스트의 fakeModel 주입·confirm 모킹 패턴. 이 파일에 테스트를 추가한다.
- `/web/src/test/fakeModel.js` — `applyAction(articleId, action)`은 `{ok:true,articleId}`를 돌려준다(없으면 `{ok:false,reason:'not-found'}`).

이전에 만들어진 코드를 꼼꼼히 읽고 설계 의도를 이해한 뒤 작업하라.

## 작업

TDD: **테스트를 먼저 작성**한 뒤 통과하는 구현을 작성한다.

`/web/src/controller/useViewController.js`에 `resendArticle(article)` 콜백을 추가하고 컨트롤러 반환 객체에 노출한다.

핵심 결정(이 phase에서 확정한 재송 정의 — 반드시 따른다):
- **재송 = 기존 `send` 전이의 재사용이다.** 별도 백엔드 동작을 만들지 않는다. news.md line 217의 "DPS 기사를 송고하면 DPS 유지(재송고)"가 곧 재송이다. 따라서 `resendArticle`은 `model.applyAction(article.articleId, 'send')` 한 번을 호출한다.
- **대상/권한은 서버가 강제한다.** lifecycle상 DPS+send는 D/Z(DESK_TABLE)만 통과하고 R은 거부된다. 프론트는 클라 권한 상승을 막기 위해 role을 싣지 않는다(ADR-004). 다만 UX 차원에서 `requestDelete`와 동일하게 `canManage(identity)`(D/Z) 가드를 먼저 두어 R이면 `{ok:false,reason:'forbidden'}`로 no-op한다(서버도 어차피 거부하므로 이중 안전망).
- **확인창**: news.md line 140 정책에 맞춰 `globalThis.confirm('재송하시겠습니까?')`로 확인받고, 취소 시 `{ok:false,reason:'cancelled'}`로 아무것도 전송하지 않는다. (`requestDelete`/`releaseLock`의 confirm 패턴과 동일.)
- **"(끝)" 마커 가드**는 서버 `applyAction`이 send 경로에서 이미 강제한다 — 프론트에서 본문을 다시 검사하지 마라(목록행에는 본문이 없어 오탐이 난다). 마커가 없으면 서버가 `{ok:false,reason:'no-end-marker'}`를 돌려주고, 프론트는 그 응답을 그대로 반환한다.

시그니처(구현은 재량):
```js
// D/Z만, '재송하시겠습니까?' 확인 후 applyAction('send')로 재송고(DPS→DPS). 응답 그대로 반환.
const resendArticle = useCallback(async (article) => { /* ... */ }, [model, identity]);
```
반환 객체에 `resendArticle`를 추가한다.

테스트(`useViewController.test.jsx`에 케이스 추가):
- D 권한 + confirm=true → `model.applyAction(id,'send')`가 호출되고 `{ok:true}` 반환.
- confirm=false(취소) → applyAction이 호출되지 않고 `{ok:false,reason:'cancelled'}`.
- R 권한 → applyAction 미호출, `{ok:false,reason:'forbidden'}`.
- (선택) 서버가 `no-end-marker`/`forbidden-transition`을 돌려주면 그 응답을 그대로 전달하는지(applyAction 모킹으로 검증).

## Acceptance Criteria

```bash
npm run lint
npm run build
npm test
```

## 검증 절차

1. 위 AC를 실행한다. 기존 backend 204 + web 238 = 442개 테스트 + 신규 테스트가 모두 통과해야 한다(무회귀).
2. 체크리스트:
   - 직접 `fetch`/`EventSource`를 호출하지 않고 `model.applyAction`만 경유하는가(ADR-003)?
   - role을 Model/요청에 싣지 않는가(ADR-004)?
   - 신규 Model 키(`contract.js` MODEL_KEYS) 추가가 **없는가**? (재송은 기존 `applyAction` 재사용이므로 계약 변경 불필요.)
   - 백엔드/서버/스키마 파일을 건드리지 않았는가?
3. `phases/2-followup-resend/index.json`의 step 0을 업데이트(completed + summary: 추가한 콜백·재사용한 Model 키·재송 정의). 실패 시 error, 개입 필요 시 blocked.

## 금지사항

- 백엔드(`src/`, `server/`)·스키마·`contract.js`·`httpModel.js`를 수정하지 마라. 이유: 재송은 기존 `send` 전이/`applyAction` Model 키의 재사용이며 신규 계약이 필요 없다. 계약을 늘리면 검토 게이트가 무력화된다.
- 프론트에서 본문 "(끝)" 마커를 검사하지 마라. 이유: 목록행에는 본문(markupVersion)이 없어 오탐한다. 마커 가드는 서버 `applyAction`이 권위 있게 강제한다.
- 클라이언트에서 role/status로 전이 가능 여부를 최종 판정하려 하지 마라(UX용 `canManage` 가드까지만). 이유: 신뢰 경계는 서버다(ADR-004). lifecycle 전이 판정을 프론트에 재구현하면 서버 규칙과 어긋난다.
- `translate`/`mapping`/`followUp`/`continue` 항목을 건드리지 마라. 이유: 이 step의 scope는 재송 콜백 하나다(followUp/continue는 step1~3, translate/mapping은 다음 phase).
- 기존 테스트를 깨뜨리지 마라.
