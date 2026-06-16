# Step 11: mapping-embed-mode

우클릭 메뉴의 **매핑(mapping)** 을 동작하게 만든다. 매핑은 기존 기사를 기사작성 에디터(writer.do)로 여는 **임베드 전용 제한 편집 모드**다: 본문에 이미지/영상/글기사 임베드를 추가·삭제할 수 있으나, **본문 텍스트와 공통정보(공통정보 탭 필드)는 수정할 수 없다.** 이 step은 프론트엔드 View + Controller 레이어만 다룬다. 백엔드 신규 계약/엔드포인트는 만들지 않는다(아래 "백엔드 불필요 근거" 참조).

**매핑 명세(사용자 확정):**
- 기존 기사를 `useWriteController`의 새 진입 모드 `mapping`으로 연다(기존 `new`/`edit`/`revise`/`portalRevise`와 동일 메커니즘 — `openArticle`/`tabFromArticle`/lock 획득/`save` 재사용).
- 에디터 **본문 텍스트 입력/수정은 차단**한다. 단 **이미지/영상/글기사 임베드 삽입·삭제는 허용**한다(이미지/영상/글기사 검색 탭으로 추가, × 버튼으로 삭제 — 기존 `InlineEmbed`/`useSearchController`/`appendEmbedToBody` 재사용).
- **공통정보 탭 필드는 전부 readOnly**(제목·작성자·엠바고·2차엠바고 포함). 매핑은 본문 임베드만 변경한다.
- 저장은 **기존 편집 저장 경로를 재사용**한다(편집 잠금 acquire → 본문 `markupVersion`에 임베드 반영 → `model.saveArticle`(PUT /api/articles/:id) → 탭 닫힐 때 unlock). **기사 상태값 전이를 일으키지 않는다**(고침 진입과 동일한 순수 편집 진입 — `applyAction` 호출 없음).

**백엔드 불필요 근거(조사 결과):** 매핑이 쓰는 호출 — 단건 조회(`getArticle`), 잠금(`lockArticle`/`unlockArticle`), 저장(`saveArticle` = PUT /api/articles/:id), 임베드 검색(`searchMedia`·`searchArticles`) — 은 전부 이미 `web/src/model/contract.js`의 `MODEL_KEYS`에 존재한다. 매핑은 본문 `markupVersion`만 바꿔 기존 잠금-게이트 PUT으로 저장하므로 **신규 백엔드 계약/라우트가 필요 없다.** 따라서 이 phase의 매핑은 프론트 step 1개로 끝낸다.

## 읽어야 할 파일

- `/docs/ADR.md` — ADR-003(View←Controller←Model, transport는 Model 계약 뒤로), ADR-004(역할은 세션에서만 도출 — 클라이언트 role 불신), ADR-006(얇은 transport + 계층형 백엔드).
- `/docs/ARCHITECTURE.md` — 프론트엔드 MVC.
- `/docs/news.md` — 50행(이미지/영상/글기사 임베딩 데이터 조회), 54행(편집 진입은 보존 내용보다 우선), 85·88행(우클릭 매핑 — 현재 비활성), 106행(본문은 HTML 이스케이프), 156행(검색 결과를 커서 위치에 임베딩, 결과 유지), 159·165·166행(임베드/× 삭제 버튼), 167행(markupVersion 블록 구조 저장·순서 보존), 200~201행(편집 진입 시 ContentsVO 매핑 — 제목/본문/작성자/엠바고는 입력란, 나머지는 읽기전용).
- 현재 구현(반드시 정독):
  - `web/src/controller/useWriteController.js` — `EDITABLE_FIELDS`/`READONLY_FIELDS`, `blankTab()`, `tabFromArticle(article, mode, fallbackAuthor)`, `openArticle(article, mode='edit')`(dedup → `getArticle` 재조회 → 새 탭 → `lockArticle(articleId, lockAction)`), `updateField(field,value)`(현재 `EDITABLE_FIELDS`만 허용), `toSaveDto(tab)`(body → `markupVersion`), `save()`/`submit(action)`. 반환 객체에서 `activeTab`/`openArticle`/`updateField`/`save`가 어떻게 노출되는지 확인.
  - `web/src/view/Editor.jsx` — `readOnly` prop 동작. 현재 `readOnly=true`면 `contentEditable={!readOnly}`로 **본문 전체가 비편집**이 되고, 동시에 `InlineEmbed`에 `readOnly`가 전파돼 **× 삭제 버튼도 숨겨진다**. 즉 현재 단일 `readOnly`로는 "텍스트 편집 불가 + 임베드 추가/삭제 가능"을 표현할 수 없다 → 새 상태가 필요하다(아래 작업 A).
  - `web/src/view/InlineEmbed.jsx` — `!readOnly && (× 삭제 버튼)`. 매핑에서는 × 버튼이 보여야 한다.
  - `web/src/view/WriterPage.jsx` — `Editor`에 현재 `readOnly`를 **전혀 넘기지 않는다**(기본 false). `onTextChange`(타이핑 → `mergeTextIntoBody` + 제목 동기화), `onKeyDown`(Alt+Y/Ctrl+D/라인삭제), `onRemoveEmbed`(임베드 삭제 → `updateField('body', ...)`), `insertEmbed`(검색결과 → `appendEmbedToBody` → `updateField('body', ...)`), `CommonInfo`(작성자/엠바고 input + 읽기전용 메타), `SearchPanel`(이미지/영상/글기사). 임베드 추가/삭제는 전부 `updateField('body', <직렬화 결과>)`로 흐른다 — 즉 매핑의 차단 대상은 "필드 이름 body"가 아니라 "본문 텍스트 타이핑(`onTextChange`) 및 텍스트 키 입력"이다.
  - `web/src/controller/useSearchController.js` — `searchImages`/`searchVideos`/`searchArticles`(전부 Model 경유). 매핑 모드에서도 그대로 동작해야 한다(변경 불필요할 가능성 높음 — 조사 후 확정).
  - `web/src/view/ContextMenu.jsx` — `INACTIVE_ITEMS`(현재 `mapping` 포함)·`inactive(key)`·`buildContextMenuItems(menu, article, identity)`. 매핑 항목을 활성화한다.
  - `web/src/controller/useViewController.js` — `enterEditor(article, mode)`(sessionStorage `PENDING_EDIT_KEY`로 `{article, mode}` 전달 후 `navigate('writer.do', ...)`), `editArticle`/`reviseArticle`. 매핑 진입 핸들러를 같은 패턴으로 추가한다.
  - `web/src/view/ListPage.jsx` — `onCtxSelect(key, article)`의 `switch`(현재 매핑 case 없음 → `default`로 무시됨).
  - `web/src/view/clipboardEmbed.js` — `makeImageEmbed`/`makeVideoEmbed`/`makeArticleEmbed`(검색 결과 → 임베드 블록). 변경 없이 재사용.
  - `web/src/view/writerButtons.js` — `submitButtons({mode,status,role,articleId})`. 매핑 모드를 어떻게 다룰지 확인(아래 작업 C).
  - `web/src/model/contract.js` — `MODEL_KEYS`. 매핑이 쓰는 키가 전부 존재함을 확인(신규 추가 금지).
- 테스트 패턴(정독 후 동일 스타일로 작성):
  - `web/src/view/ContextMenu.test.jsx`
  - `web/src/controller/useWriteController.test.jsx`(존재 시) / `web/src/controller/useViewController.test.jsx`
  - `web/src/view/WriterPage.test.jsx`(`pendingEdit: { article, mode }` 시드 패턴 — 매핑 모드 시드에 재사용).

이전 코드를 정독하고, step10이 활성화한 `translate`·기존 활성 항목들의 상태를 건드리지 않도록 매핑 항목만 다룬다.

## 작업

### 설계 결정(반드시 이 형태로 구현)

매핑 모드의 핵심은 **"본문 텍스트 타이핑 차단 + 공통정보 필드 readOnly + 임베드 추가/삭제 허용"** 이라는 세 번째 상태다. 단일 `readOnly` 불리언으로는 표현 불가(현재 `readOnly`는 임베드 × 버튼까지 숨김). 따라서:

- `useWriteController`에 진입 모드 `mapping`을 추가하고, 탭이 매핑 모드인지 알 수 있게 한다.
- **본문 텍스트 차단 = `onTextChange` 경로 무력화**(타이핑/IME/붙여넣기 텍스트가 body에 반영되지 않게). **임베드 허용 = `updateField('body', ...)` 자체는 매핑 모드에서도 허용**(임베드 추가/삭제는 이 경로로 흐른다). 즉 차단 단위는 "필드 body"가 아니라 "텍스트 입력 이벤트"다.
- **공통정보 필드 차단 = `updateField`가 매핑 모드에서 `title`/`author`/`embargoAt`/`secondEmbargoAt`를 거부**하고, `CommonInfo`의 입력란을 `readOnly`로 렌더.
- 에디터는 **텍스트는 비편집이되 임베드 × 버튼은 노출**되도록 한다. `Editor`/`InlineEmbed`에 임베드 삭제 가능 여부와 텍스트 편집 가능 여부를 **분리**해 전달한다(아래 A).

> 시그니처 형태는 구현자 재량이되, 위 차단/허용 의미론은 반드시 지킨다. 구체 prop 이름은 예시일 뿐이다(예: `Editor`에 `textEditable`/`allowEmbedRemove`를 따로, 또는 `mode='mapping'` 전달). 단 **임베드 × 버튼 노출 여부와 텍스트 contentEditable 여부를 같은 불리언에 묶지 마라**(현재 `readOnly`의 문제점).

### TDD 순서: 먼저 실패 테스트를 쓴다

먼저 아래 테스트를 작성하고 **실패를 확인한 뒤** 구현한다.

1. **ContextMenu** `web/src/view/ContextMenu.test.jsx`:
   - `mapping` 항목이 부서별 작성/송고·개인별 수정 메뉴에서 **활성**(`enabled:true`)이다(세션 있으면 가능 — 서버가 인증/잠금 게이트). `deskUnsent` 메뉴 항목 구성은 그대로(매핑 미노출).
   - 기존에 활성/비활성이던 다른 항목들의 상태가 그대로인지 회귀 검증(특히 step10이 활성화한 `translate`, history/sendHistory/followUp/continue/resend, revise/delete/lock).
2. **useWriteController** `web/src/controller/useWriteController.test.jsx`(fakeModel 주입):
   - `openArticle(article, 'mapping')`가 탭을 매핑 모드로 열고, `getArticle`로 본문을 채우며, `lockArticle(articleId, <action>)`을 호출한다(기존 편집 진입처럼 잠금 획득 — `applyAction`은 호출하지 않는다).
   - 매핑 모드 탭에서 `updateField('title'|'author'|'embargoAt'|'secondEmbargoAt', ...)` 호출이 **필드를 바꾸지 않는다**(공통정보 readOnly 강제).
   - 매핑 모드 탭에서 **임베드 반영 경로**(body를 임베드가 포함된 새 직렬화 문자열로 바꾸는 호출)는 **반영된다**(임베드 추가/삭제 허용). 즉 매핑 모드에서도 body 갱신 자체는 허용됨을 검증.
   - `save()`가 매핑 모드에서 `model.saveArticle`(articleId 포함 = PUT)을 호출하고 **상태 전이(`applyAction`)를 호출하지 않는다**.
3. **WriterPage** `web/src/view/WriterPage.test.jsx`(`pendingEdit: { article, mode:'mapping' }` 시드):
   - 매핑 진입 시 에디터 본문에 **텍스트 입력을 시도해도 body가 바뀌지 않는다**(`onTextChange` 무력화 — 텍스트 비편집).
   - 공통정보 탭의 작성자/엠바고/2차엠바고 입력란이 **readOnly**다(값 변경 시도가 막힘).
   - 이미지/영상/글기사 검색 결과를 클릭하면 **임베드가 본문에 추가**된다(body의 markupVersion에 임베드 블록 반영).
   - 임베드 × 삭제 버튼이 **노출**되고 클릭 시 임베드가 제거된다.

먼저 전부 실패를 확인한 뒤 구현한다.

### 구현 A: 에디터 — 텍스트 비편집 + 임베드 추가/삭제 허용 (`web/src/view/Editor.jsx`, `web/src/view/InlineEmbed.jsx`)

- 매핑 모드를 위해 "텍스트 편집 가능 여부"와 "임베드 삭제 버튼 노출 여부"를 **분리**한다. 예: `Editor`가 텍스트 편집 차단 신호(예: `mode==='mapping'` 또는 `textEditable=false`)를 받으면 본문 텍스트 타이핑이 body에 반영되지 않게 하되, `InlineEmbed`의 × 버튼은 계속 노출되도록 한다.
- 본문 텍스트 입력 차단은 **`onTextChange`로 흘러가는 변경을 막는 것으로 충분**하다(WriterPage `onTextChange`가 body를 바꾸는 유일한 텍스트 경로). `contentEditable`을 끄든, `onTextChange`를 연결하지 않든, IME/paste 텍스트가 body에 커밋되지 않게 하라. **임베드 삽입은 검색 패널 클릭(별도 경로)으로 이뤄지므로 contentEditable 비활성과 무관하게 동작한다** — 이 점을 깨지 않게 한다.
- 기존 `readOnly` 동작(상세보기 등 완전 읽기전용)을 **회귀시키지 마라** — 기존 `readOnly=true` 사용처가 있으면 그 의미(텍스트+임베드 모두 잠금)를 유지하고, 매핑은 별도 신호로 처리.

### 구현 B: 컨트롤러 — `mapping` 진입 모드 (`web/src/controller/useWriteController.js`)

- `openArticle(article, mode)`가 `mode='mapping'`을 받아 기존 편집 진입과 동일하게 동작하게 한다(dedup → `getArticle` 재조회 → `tabFromArticle(full, 'mapping', ...)` → 새 탭 → 잠금 획득). 잠금 `lockAction`은 매핑이 순수 편집이므로 기존 `'revise'`(전이 없는 잠금)를 그대로 재사용하라(현재 코드 L169 `mode === 'portalRevise' ? 'portalRevise' : 'revise'` 분기에서 매핑은 `revise` 갈래로 떨어진다 — 별도 분기 불필요). "매핑은 임베드 전용 편집이므로 전이 없는 잠금"이라는 합리적 도출임을 코드 주석으로 명시.
- **서버 잠금 게이트와의 정합(중요):** 서버 `POST /api/articles/:id/lock`(server/index.js L264-275)은 `authorization.editDps`로 **DPS 기사는 D만, 비-DPS 기사는 인증된 R/D/Z 통과**(not-dps면 통과)로 잠금을 인가한다. 따라서 매핑은 ContextMenu에서 "세션만 있으면 노출"(UX 어포던스)이더라도 **실제 인가는 서버가 강제**한다 — DPS 기사를 비-D가 매핑 시도하면 서버가 잠금을 거부(forbidden)하는 것이 **정상 동작**(신뢰경계=서버, 버그 아님). 이 거부 경로를 테스트로 확인하고, 매핑 진입 실패 시 탭이 잠금 없이 열리지 않도록(또는 잠금 실패를 사용자에게 알리도록) 기존 편집 진입과 동일하게 처리하라.
- `updateField(field, value)`가 **매핑 모드 활성 탭에서는 공통정보 필드(`title`/`author`/`embargoAt`/`secondEmbargoAt`)를 거부**하도록 한다. 단 **`body` 갱신은 매핑 모드에서도 허용**해야 한다(임베드 추가/삭제 경로). 즉 매핑 모드에서 `updateField`의 허용 화이트리스트는 `['body']`로 좁힌다(텍스트 타이핑은 WriterPage가 `onTextChange`를 연결하지 않음으로써 별도 차단 — A 참조).
- `save()`/`submit()`은 매핑에서 **상태 전이 없이 저장만** 한다. `save()`는 그대로 PUT 저장이므로 재사용. 매핑은 송고/보류/KILL 액션바를 노출하지 않으므로 `submit(action)` 경로를 타지 않는다(작업 C). 매핑 저장 버튼은 기존 `save()`(PUT)를 호출한다.
- 반환 객체에 매핑 모드 식별 수단(예: `activeTab.mode === 'mapping'`)이 View에서 보이게 한다(이미 `activeTab`이 노출되면 추가 노출 불필요).

### 구현 C: WriterPage 결선 (`web/src/view/WriterPage.jsx`)

- 활성 탭이 매핑 모드면:
  - `Editor`에 텍스트 비편집 신호를 전달하고 **`onTextChange`/`onKeyDown`의 텍스트 변경 경로를 비활성화**한다(임베드 추가/삭제 콜백 `onRemoveEmbed`·`insertEmbed`는 유지).
  - `CommonInfo`의 작성자/엠바고/2차엠바고 입력란을 **readOnly**로 렌더(매핑 모드 prop 전달).
  - 송고/보류/KILL 액션바를 **숨긴다**(매핑은 전이 없음). `writerButtons.submitButtons`가 `mode==='mapping'`에서 **빈 배열**을 반환하도록 하거나, WriterPage가 매핑 모드에서 액션바를 렌더하지 않게 한다. 대신 **저장 버튼**(기존 `save()` 호출)을 노출해 임베드 변경을 PUT 저장할 수 있게 한다.
    - **주의:** 현재 `WriterPage.jsx`(L53-57)는 `useWriteController()`에서 `save`·`openArticle`을 **구조분해하지 않는다**(받는 건 `updateField, submit`까지). 매핑 저장 버튼이 `save()`를 호출하려면 **WriterPage 구조분해 목록에 `save`를 추가**해야 한다. 기존 비매핑 모드 동작에는 영향이 없도록 추가만 한다(제거·변경 금지).
  - 이미지/영상/글기사 검색 패널(`SearchPanel`)과 임베드 삽입(`insertEmbed`)·삭제(`onRemoveEmbed`)는 **그대로 동작**해야 한다(매핑의 본체).
- 비매핑 모드(new/edit/revise/portalRevise)의 기존 동작은 **한 글자도 바뀌면 안 된다**(회귀 금지).

### 구현 D: 진입 핸들러 + 컨텍스트 메뉴 활성화 (`web/src/controller/useViewController.js`, `web/src/view/ContextMenu.jsx`, `web/src/view/ListPage.jsx`)

- `useViewController`에 `mapArticle(article)` 핸들러를 추가하고 반환에 노출한다 — 기존 `enterEditor(article, mode)` 패턴 재사용: `enterEditor(article, 'mapping')`. (직접 fetch 금지 — 진입은 sessionStorage 채널 + navigate.)
- `ContextMenu.jsx`: `mapping`을 `INACTIVE_ITEMS`에서 빼고 `{ key:'mapping', label:'매핑', enabled:true }`로 활성화한다. 활성 조건은 **세션만 있으면 가능**(news.md에 매핑 권한/상태 제한 명시 없음 — 편집처럼 동작하되 잠금 필요, deskUnsent 외 메뉴에 노출). 근거가 약한 부분(권한 게이트 부재)은 "명세에 제한 없음 → 서버가 인증/잠금 게이트, 합리적 도출"임을 코드 주석으로 명시하라. `deskUnsent` 메뉴 구성에는 매핑을 추가하지 않는다(news.md 85행은 부서별 작성/송고·개인별 수정 메뉴만 언급).
- `ListPage.jsx` `onCtxSelect`에 `case 'mapping': mapArticle(article); break;` 추가.

## Acceptance Criteria

```bash
npm run lint
npm run build
npm test
npm run test:web
```

기존 테스트를 단 1개도 깨뜨리지 마라.

## 검증 절차

1. 위 AC 커맨드를 전부 실행한다.
2. 아키텍처/명세 체크리스트:
   - 매핑 진입/저장/검색이 전부 Model 계약(`getArticle`/`lockArticle`/`unlockArticle`/`saveArticle`/`searchMedia`/`searchArticles`) 경유인가? 직접 `fetch`가 없는가? (ADR-003)
   - `contract.js` `MODEL_KEYS`에 신규 키를 추가하지 않았는가? 백엔드 라우트/서비스 신규 추가가 없는가? (매핑은 기존 계약 재사용)
   - 매핑 모드에서 본문 텍스트 타이핑이 차단되는가(테스트로 강제)?
   - 공통정보 입력란(제목/작성자/엠바고/2차엠바고)이 readOnly인가(테스트로 강제)?
   - 임베드 추가/삭제는 매핑 모드에서 동작하는가(테스트로 강제)?
   - 매핑 저장이 PUT(`saveArticle` with articleId)이고 `applyAction`(상태 전이)을 호출하지 않는가? (전이 없음)
   - 잠금은 기존 lock-gated 경로로 획득/해제되는가(탭 닫기·언로드 시 unlock)? (신뢰경계=서버)
   - 비매핑 모드(new/edit/revise/portalRevise)와 step10이 활성화한 translate, 기타 메뉴 항목의 동작/상태가 회귀하지 않았는가?
   - 새 창/DOM에 본문/임베드를 삽입할 때 HTML 이스케이프가 유지되는가? (news.md 106행 — 기존 렌더 경로 유지)
3. 결과에 따라 `phases/1-menu-actions/index.json`의 step 11을 업데이트한다(완료/error/blocked 양식 동일).

## 금지사항

- 백엔드 신규 엔드포인트/서비스/계약 키를 만들지 마라. 이유: 매핑은 기존 `saveArticle`/lock/`searchMedia`/`searchArticles` 재사용으로 충분하며, scope 최소화 원칙상 프론트 1개 step으로 끝낸다.
- 매핑에서 `applyAction`(송고/보류/KILL/삭제승인 등 상태 전이)을 호출하지 마라. 이유: 매핑은 고침 진입과 동일한 순수 편집 진입 — 기사 상태값을 전이시키지 않는다.
- 매핑에서 본문 텍스트·공통정보(제목/작성자/엠바고/2차엠바고)를 수정 가능하게 두지 마라. 이유: 사용자 확정 명세 — 매핑은 임베드 전용 제한 편집 모드.
- 임베드 삭제(× 버튼) 노출 여부와 텍스트 contentEditable 여부를 같은 불리언에 묶지 마라. 이유: 현재 `readOnly`가 둘을 묶어 "텍스트 잠금 + 임베드 편집 가능"을 표현 못 한다 — 이게 매핑의 핵심 차이다.
- 직접 `fetch`로 진입/저장/검색하지 마라. 이유: ADR-003 — 데이터 호출은 Model 계약 뒤로.
- DB 행을 삭제하지 마라(임베드 삭제는 markupVersion 본문 블록 제거일 뿐, 기사 행 삭제가 아니다). 이유: DB 비파괴 원칙.
- 클라이언트가 보낸 `role`로 인가를 판단하게 만들지 마라(저장/잠금 인가는 서버 세션이 결정). 이유: ADR-004 신뢰경계=서버.
- 비매핑 모드(new/edit/revise/portalRevise)·step10 translate·history/sendHistory/followUp/continue/resend/revise/delete/lock의 동작·활성 상태를 변경하지 마라. 이유: 회귀 위험 — 매핑 항목만 다룬다.
- 기존 테스트를 깨뜨리지 마라.
