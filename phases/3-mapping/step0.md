# Step 0: mapping-writer-mode

`매핑`(mapping) 진입을 `useWriteController`가 처리하도록 한다. 매핑은 **기존 기사 본문의 텍스트는 전혀 건드리지 않고, 이미지·영상·글기사 임베드만 추가**하는 기능이다. 이 step은 **프론트 컨트롤러 한 모듈(`web/src/controller/useWriteController.js`)** 만 다룬다. 저장 버튼 표시 규칙(`writerButtons.js`)은 step1, list.do에서 매핑을 골라 넘기는 결선(`useViewController`)은 step2, WriterPage UI 분기는 step3, 컨텍스트 메뉴 활성화는 step4다. 여기서는 writer가 **`mode:'mapping'` 편집 탭**을 여는 진입 경로와, 텍스트 보존 저장 경로만 만든다.

## 읽어야 할 파일

먼저 아래 파일들을 읽고 프로젝트의 아키텍처와 설계 의도를 파악하라:

- `/docs/ADR.md` — ADR-003(프론트 MVC, Model 계약 경유, 직접 fetch 금지), ADR-004(role은 서버 세션에서만 도출 — 클라이언트가 role을 싣지 않는다), ADR-006(백엔드는 controllers→services→models, 가능한 한 무변경).
- `/docs/news.md` — line 85~88(컨텍스트 메뉴 `매핑` 항목·비활성 항목), line 121~127(편집 잠금 lockYN), line 199~203(편집 진입 시 제목/본문/작성자/엠바고는 입력란, 나머지 메타는 읽기전용 — 매핑 매핑 규칙), line 152~168(에디터 본문은 텍스트/임베드 블록 구조 markupVersion으로 저장·보존), line 184~185(PUT /api/articles/:id는 편집 잠금 보유자만, lock/unlock API).
- `/web/src/controller/useWriteController.js` — **이 step에서 수정할 파일.** 핵심 이해 포인트:
  - `mode` 종류: `'new'`/`'edit'`/`'revise'`/`'portalRevise'`(편집 진입), 그리고 phase 2에서 추가된 `'followUp'`/`'continue'`(신규 파생). 매핑은 **편집 진입 계열의 새 mode `'mapping'`** 으로 추가한다.
  - `EDITABLE_FIELDS = ['title','body','author','embargoAt','secondEmbargoAt']`, `READONLY_FIELDS`(articleId/modifier/sender/department/departmentCode/createdAt/editedAt/sentAt).
  - `tabFromArticle(article, mode, fallbackAuthor)` — **편집 진입**용. `articleId`를 그대로 쓰고, READONLY_FIELDS를 `readOnly`로 보존하며 body를 `markupVersion`으로 채운다.
  - `openArticle(article, mode='edit')` — 이미 열린 기사면 dedup, 아니면 새 탭 push + `model.getArticle`로 단건 재조회(본문 markupVersion 채움) + `model.lockArticle(articleId, lockAction)`로 **잠금 획득**(lockAction은 portalRevise면 'portalRevise', 그 외 'revise'). 매핑은 기존 기사 편집이므로 이 경로를 그대로 재사용한다.
  - `updateField(field, value)` — `EDITABLE_FIELDS`만 갱신. 임베드 추가는 WriterPage가 `updateField('body', appendEmbedToBody(...))`로 호출한다(step3).
  - `toSaveDto(tab)` — `body`를 `markupVersion` 키로 싣고(절대 `body` 키로 보내지 마라 — 서버 ARTICLE_FIELDS와 불일치 시 본문 유실), `tab.articleId`가 있으면 `dto.articleId`를 싣는다. role은 어디서도 싣지 않는다.
  - `submit(action)` — 편집 컨텍스트(articleId 있음)는 `saveArticle(toSaveDto)` → `applyAction(articleId, action)` → 성공 시 `unlockArticle` + `resetTabToBlank`. **매핑은 생애주기 전이를 일으키지 않으므로 이 submit을 쓰지 않는다.** 별도 저장 콜백이 필요하다(아래 작업 참조).
  - `save()` — 현재 탭을 `saveArticle(toSaveDto)`로 저장(PUT, articleId 있으면). 전이/unlock 없음.
  - `removeTab(id,{unlock})`/`closeTab(id)` — 편집 탭 닫을 때 `unlockArticle` 호출.
- `/web/src/view/writerBody.js` — `appendEmbedToBody(currentBody, embed)`(텍스트 블록 보존, "(끝)" 앞에 embed만 삽입). `mergeTextIntoBody(currentBody, newText)`(타이핑 텍스트로 본문 재구성 — **매핑에서는 호출되면 안 된다**, 텍스트가 readOnly이기 때문).
- `/web/src/view/editorContent.js` — `deserialize`/`serialize`/`blocksToText`(텍스트 블록만 추림)/`isEmbedBlock`/`textBlock`/`embedBlock`.
- `/web/src/controller/useViewController.js` — `PENDING_EDIT_KEY`(편집 진입 채널) export 위치와 `enterEditor(article, mode)`가 쓰는 shape `{ article, mode }`. 매핑도 **편집 진입이므로 이 PENDING_EDIT_KEY 채널을 재사용**한다(step2가 mode='mapping'으로 쓴다). 후속/계속의 `PENDING_NEW_KEY`(신규 채널)와 혼동하지 마라 — 매핑은 잠금이 필요한 편집 진입이다.
- `/web/src/controller/useWriteController.test.jsx` — 기존 컨트롤러 테스트(fakeModel/AppContext 주입, sessionStorage 채널 소비, lock/save 단언) 패턴. 이 파일에 테스트를 추가한다.
- `/web/src/test/fakeModel.js` — `getArticle`/`lockArticle`/`unlockArticle`/`saveArticle`(articleId 있으면 PUT 업데이트) 동작 확인.

이전에 만들어진 코드를 꼼꼼히 읽고 설계 의도를 이해한 뒤 작업하라.

## 작업

TDD: **테스트를 먼저 작성**한 뒤 통과하는 구현을 작성한다.

`/web/src/controller/useWriteController.js`에 **매핑 진입(`mode:'mapping'`)** 과 **텍스트 보존 저장** 경로를 추가한다.

핵심 결정(이 phase에서 확정한 매핑 정의 — 반드시 따른다):

1. **매핑은 기존 기사 편집(write)이다.** 본문의 텍스트 블록은 추가/삭제/수정하지 않고, 임베드(embed 블록)만 추가한다. 저장은 PUT(`saveArticle`에 articleId 포함). **원본 행을 삭제하지 않는다(DB 비파괴).**
2. **진입 = 기존 편집 경로 재사용.** 매핑은 `openArticle(article, 'mapping')`으로 연다. 즉 `getArticle` 단건 재조회로 본문(markupVersion)·공통정보를 채우고, `lockArticle`로 **편집 잠금을 획득**한다(편집 잠금 수명은 기존 edit과 동일 — 탭 닫기/저장 성공/브라우저 닫힘 시 해제). 매핑은 별도 신규 채널(PENDING_NEW_KEY)을 쓰지 않는다.
3. **본문 텍스트 readOnly 보장(핵심 무결성 규칙):** 매핑 탭에서는 본문 텍스트가 절대 바뀌면 안 된다. 텍스트 변경은 WriterPage 에디터에서 `readOnly`로 막지만(step3), **컨트롤러 차원에서도 매핑 탭의 `body` 갱신은 임베드 추가(`appendEmbedToBody`)만 허용되고 타이핑 텍스트 재구성(`mergeTextIntoBody`)이 끼어들 수 없는 구조여야 한다.** `updateField('body', ...)`로 임베드가 더해진 markupVersion을 그대로 싣는다 — 원본 텍스트 블록은 그대로 보존된다(`appendEmbedToBody`가 텍스트 블록을 건드리지 않으므로). 컨트롤러는 body에 들어온 값을 그대로 저장만 하면 되고, 저장 시 텍스트 블록을 재조립하지 않는다(`toSaveDto`는 `tab.fields.body`를 그대로 markupVersion으로 싣는다 — 이미 그렇다, 확인하라).
4. **저장 흐름 = 전이 없는 PUT.** 매핑 저장은 생애주기 전이(send/hold/kill)를 일으키지 않는다. 따라서 `submit(action)`을 쓰지 않고, **저장(PUT) → 성공 시 잠금 해제(unlock) → 탭 정리(빈 새 기사 탭으로 전환, resetTabToBlank)** 만 하는 별도 콜백을 추가한다. 예: `saveMapping()`(이름 재량). 내부는 `save()`(이미 PUT) 재사용 + 성공 시 `unlockArticle` + `resetTabToBlank`. **`applyAction`을 호출하지 마라**(매핑은 상태 전이가 아니다).

구현 가이드(시그니처는 재량, 기존 패턴 재사용을 우선):
- `tabFromArticle`/`openArticle`은 mode 값만 `'mapping'`을 받을 수 있으면 되고 본문·잠금 로직은 그대로 재사용한다. `openArticle`의 `lockAction`은 매핑일 때 `'revise'`(기본)로 충분한지 따져라 — 매핑은 DPS 전용 고침이 아니라 일반 편집 잠금이면 된다. lockAction 분기를 매핑 때문에 바꿀 필요가 없으면 바꾸지 마라(portalRevise만 'portalRevise', 그 외 'revise' 유지).
- 마운트 시 1회 소비하는 기존 `PENDING_EDIT_KEY` useEffect를 그대로 쓴다 — `req.mode === 'mapping'`이면 `openArticle(req.article, 'mapping')`로 들어온다(기존 코드가 `req.mode || 'edit'`을 그대로 openArticle에 넘기므로 **별도 분기 추가 없이 동작할 수 있다** — 확인하고, 동작하면 useEffect를 수정하지 마라).
- 매핑 저장 콜백(예: `saveMapping()`)을 추가하고 반환 객체에 노출한다(step3 WriterPage가 호출). 시그니처: `async () => { ok, ... }`. 내부: 현재 활성 탭이 매핑 탭일 때 `model.saveArticle(toSaveDto(tab))`(PUT) → 성공 시 `model.unlockArticle(tab.articleId)` + `resetTabToBlank(tab.id)`. role은 싣지 않는다.

테스트(`useWriteController.test.jsx`에 케이스 추가):
- `PENDING_EDIT_KEY`에 `{article:{articleId:'AKR...',markupVersion:<텍스트+임베드 직렬화>}, mode:'mapping'}`를 넣고 마운트 → 새 탭이 `mode:'mapping'`, `articleId` 유지, body가 원본 markupVersion으로 채워지고, `model.lockArticle`이 **호출되는지**(편집 잠금 획득).
- 매핑 탭에서 `updateField('body', appendEmbedToBody(body, makeImageEmbed(...)))` 후 `saveMapping()` 호출 시 `model.saveArticle`가 **articleId 포함 PUT**으로 호출되고, 저장된 markupVersion의 **텍스트 블록이 원본과 동일**(blocksToText 결과 불변)하며 임베드만 1개 늘었는지.
- `saveMapping()` 성공 후 `model.unlockArticle(articleId)`가 호출되고 탭이 빈 새 기사 탭으로 초기화되는지. **`model.applyAction`은 호출되지 않는지**(전이 없음).
- 기존 PENDING_EDIT(일반 편집 'edit'/'revise'/'portalRevise') 동작·`submit`·후속/계속(PENDING_NEW) 동작이 무회귀인지.

## Acceptance Criteria

```bash
npm run lint
npm run build
npm test
npm run test:web
```

## 검증 절차

1. 위 AC를 실행한다. 기존 테스트(backend 204 + web 255 = 459) + 신규 테스트가 모두 통과해야 한다(무회귀).
2. 아키텍처 체크리스트:
   - 매핑 진입이 `openArticle`(getArticle 재조회 + lockArticle) 기존 편집 경로를 재사용하는가? 신규 채널(PENDING_NEW_KEY)을 쓰지 않는가?
   - 저장이 PUT(articleId 포함)이고 `applyAction`(상태 전이)을 호출하지 않는가?
   - 저장된 markupVersion의 텍스트 블록이 원본과 동일하고 임베드만 추가됐는가(텍스트 비파괴)?
   - 직접 fetch/EventSource 없이 Model 경유만 하는가(ADR-003)? role을 싣지 않는가(ADR-004)?
   - `contract.js`/`httpModel.js`/백엔드를 수정하지 않았는가(ADR-006 — 매핑은 기존 getArticle/lockArticle/saveArticle/unlock 재사용)?
3. `phases/3-mapping/index.json`의 step 0을 업데이트한다:
   - 성공 → `"status": "completed"`, `"summary"`: 추가한 mode('mapping')·저장 콜백 이름/동작·잠금 획득·텍스트 보존 보장 방식·전이 없음을 한 줄 요약.
   - 수정 3회 실패 → `"status": "error"`, `"error_message"`.
   - 개입 필요 → `"status": "blocked"`, `"blocked_reason"`.

## 금지사항

- 매핑 저장에서 본문 텍스트 블록을 추가/삭제/수정하지 마라. 이유: 매핑의 정의는 "텍스트는 건드리지 않고 임베드만 추가"다. `mergeTextIntoBody`(타이핑 텍스트로 본문 재구성)를 매핑 저장 경로에서 호출하면 텍스트가 재조립돼 보존이 깨진다 — `appendEmbedToBody`로 들어온 body를 그대로 저장만 하라.
- 매핑 저장에서 `model.applyAction`(send/hold/kill)을 호출하지 마라. 이유: 매핑은 생애주기 전이가 아니라 본문 임베드 추가 PUT이다. 전이를 일으키면 상태가 오염된다.
- 매핑 진입을 신규 채널(`PENDING_NEW_KEY`)이나 잠금 없이 처리하지 마라. 이유: 매핑은 기존 기사 편집(write)이므로 편집 잠금(lockArticle)이 반드시 필요하다 — 잠금 없이 PUT하면 동시 편집 충돌·서버 거부가 난다.
- `contract.js`/`httpModel.js`/`server/` 백엔드를 수정하지 마라. 이유: 매핑은 기존 `getArticle`+`lockArticle`+`saveArticle`(PUT)+`unlockArticle` Model 키 재사용으로 충분하다(ADR-006). 새 계약/라우트가 필요 없다.
- 기존 `submit`/`openFromSource`/`PENDING_NEW` 소비 로직을 변경하지 마라(일반 편집·후속·계속·송고 무회귀). 이유: 매핑은 별도 저장 콜백으로 추가한다 — 기존 경로와 섞으면 회귀가 난다.
- 기존 테스트를 깨뜨리지 마라.
