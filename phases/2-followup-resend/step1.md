# Step 1: followup-continue-writer

`후속기사작성`(followUp)/`계속기사작성`(continue)이 만드는 **신규 기사 작성 탭**을 `useWriteController`가 열 수 있도록 한다. 이 step은 **프론트 컨트롤러 한 모듈(useWriteController.js)** 만 다룬다. 원본을 list.do에서 골라 draft를 만들고 writer.do로 보내는 쪽(useViewController)은 step2, 메뉴 활성화는 step3이다 — 여기서는 writer가 "원본에서 파생된 신규 draft"를 소비하는 진입 경로만 만든다.

## 읽어야 할 파일

먼저 아래 파일들을 읽고 프로젝트의 아키텍처와 설계 의도를 파악하라:

- `/docs/ADR.md` — ADR-003(프론트 MVC, Model 계약 경유), ADR-004(role 불신).
- `/docs/news.md` — line 54~60(작성 탭·탭별 독립 보존·이미 열린 기사 dedup), line 85(`후속기사작성`/`계속기사작성` 메뉴), line 199~203(매핑 — 제목/본문/작성자/엠바고는 입력란, 나머지 메타는 읽기전용), line 205~207(**신규 기사는 RDS, 최초 송고는 전이 없이 RDS 유지**).
- `/web/src/controller/useWriteController.js` — **이 step에서 수정할 파일.** 핵심 이해 포인트:
  - `PENDING_EDIT_KEY`(`useViewController.js`에서 import) — list.do→writer.do로 편집 대상·모드를 넘기는 sessionStorage 채널. 마운트 시 1회 소비해 `openArticle(req.article, req.mode)`로 편집 탭을 연다.
  - `blankTab()` — 빈 신규 탭(`mode:'new'`, `articleId:null`, `status:null`).
  - `tabFromArticle(article, mode, fallbackAuthor)` — **편집 진입**용. `articleId`를 그대로 쓰고, READONLY_FIELDS(articleId/modifier/sender/department/createdAt/editedAt/sentAt 등)를 읽기전용으로 보존하며, `openArticle`이 단건 재조회로 본문(markupVersion)을 채우고 **잠금을 획득(lockArticle)** 한다.
  - `toSaveDto(tab)` — body를 `markupVersion`으로 싣고, `tab.articleId`가 있을 때만 `dto.articleId`를 싣는다(없으면 신규 POST 경로).
  - `submit(action)` — `tab.articleId`가 없으면(신규) 전이 없이 저장만 하고 탭 초기화한다.
- `/web/src/controller/useViewController.js` — `PENDING_EDIT_KEY` export 위치와 `enterEditor(article, mode)`가 채널에 쓰는 shape `{ article, mode }`. step2가 추가할 신규 채널의 형태를 여기에 맞춰 설계할 것.
- `/web/src/controller/useWriteController.test.jsx` — 기존 컨트롤러 테스트(fakeModel/AppContext 주입, sessionStorage 채널 소비 테스트) 패턴. 이 파일에 테스트를 추가한다.
- `/web/src/test/fakeModel.js` — `saveArticle(dto)`는 articleId 없으면 신규 발번(`AKRFAKE...`)+status 'RDS'로 push, getArticle/lockArticle 동작.

이전에 만들어진 코드를 꼼꼼히 읽고 설계 의도를 이해한 뒤 작업하라.

## 작업

TDD: **테스트를 먼저 작성**한 뒤 통과하는 구현을 작성한다.

`/web/src/controller/useWriteController.js`에 **원본에서 파생된 신규 기사 탭**을 여는 경로를 추가한다.

핵심 결정(이 phase에서 확정한 후속/계속 정의 — 반드시 따른다):
- **후속/계속은 신규 기사 생성 경로다.** 원본을 수정/삭제하지 않는다. 새 탭은 `articleId: null`로 연다 → 저장 시 `toSaveDto`가 articleId를 싣지 않아 `saveArticle`이 신규 POST(서버 `create`, status 'RDS', 신규 발번)로 처리한다. 기존 `create` 경로를 그대로 재사용하므로 **백엔드 변경이 없다.**
- **원본→신규 필드 매핑(복사 vs 초기화):**
  - 복사(입력란 채움): `title`, `body`(원본 `markupVersion`), `author`(원본 작성자 또는 로그인 사용자명 fallback), `embargoAt`, `secondEmbargoAt`. — 매핑 시 편집가능 필드(news.md line 201)와 동일한 EDITABLE_FIELDS 집합을 따른다.
  - **초기화(비움/미설정):** `articleId`(신규 발번을 위해 null), `sender`/`sentAt`(송고자·송고시간 — 신규라 미송고), `modifier`, `createdAt`/`editedAt`, `status`(신규 draft이므로 null → 저장 시 서버가 RDS 부여). 즉 READONLY 메타를 **읽기전용 표시로 끌어오지 않는다**(새 기사에는 원본 메타가 없어야 한다).
  - 본문 채우기: 목록행에는 본문이 없으므로 `openArticle`과 동일하게 `model.getArticle(원본 articleId)`로 단건 재조회해 `markupVersion`을 가져와 body로 넣는다(조회 실패 시 목록행 폴백). **단, 잠금(lockArticle)은 획득하지 마라** — 신규 기사 작성이지 원본 편집이 아니다. 원본은 잠그지 않는다.
- **후속 vs 계속 구분 표현:** 탭의 `mode`로 구분한다. 신규 mode 두 개(`'followUp'`, `'continue'`)를 도입하되, **버튼 표시 규칙상으로는 신규(`mode:'new'`)와 동일하게 취급**되어야 한다. `writerButtons.js`의 `submitButtons`는 `!articleId || mode === 'new'`를 신규로 본다 — `articleId`가 null이면 mode가 followUp/continue여도 이미 신규로 분류되므로 writerButtons는 **수정하지 않는다**(확인만 하라). mode 값은 후속/계속을 메타로 표시(주소창/탭 식별·후속 phase 확장 여지)하는 용도로만 둔다.

구현 가이드(시그니처는 재량, 기존 패턴 재사용을 우선):
- 신규 sessionStorage 채널 키를 하나 도입한다(예: `PENDING_NEW_KEY = 'yh.pendingNew'`, `export`). 페이로드 shape는 `{ article, mode }`(mode ∈ `'followUp'|'continue'`). step2의 useViewController가 이 채널에 쓰고 writer.do로 navigate한다.
- 원본에서 신규 탭을 만드는 헬퍼(예: `tabFromSource(article, mode, fallbackAuthor)`)를 추가한다 — `blankTab()` 기반으로 위 "복사" 필드만 채우고 `articleId:null`/`status:null`/`readOnly:{}`를 유지한다.
- 신규 탭을 여는 콜백(예: `openFromSource(article, mode)`)을 추가한다 — `addTab` 흐름처럼 새 탭을 push+활성화하고, `model.getArticle`로 본문을 채운다(잠금 없음). 반환 객체에 노출한다(step3는 ListPage가 직접 호출하지 않고 채널로만 들어오지만, 마운트 소비 로직에서 호출하므로 export까지는 필요 없을 수 있다 — 마운트 소비 useEffect에서 직접 호출해도 된다).
- 마운트 시 1회 소비하는 useEffect를 추가/확장한다 — 기존 `PENDING_EDIT_KEY` 소비 패턴과 동일하게 `PENDING_NEW_KEY`를 읽어 소비(removeItem)하고 `openFromSource(req.article, req.mode)`를 호출한다. **기존 PENDING_EDIT 소비 로직은 변경하지 마라**(별도 useEffect 또는 같은 useEffect 내 분기 추가).

테스트(`useWriteController.test.jsx`에 케이스 추가):
- `PENDING_NEW_KEY`에 `{article:{articleId:'AKR...',title:'T',markupVersion:'본문'}, mode:'followUp'}`를 넣고 마운트 → 새 탭이 `articleId:null`, `mode:'followUp'`, `fields.title==='T'`, `fields.body`에 본문이 채워지는지.
- 그 탭에서 `submit('send')`(또는 save) 호출 시 `model.saveArticle`가 **articleId 없이**(신규 POST 경로) 호출되는지(원본 articleId가 dto에 실리지 않음 — 원본 미수정 보장).
- followUp 진입 시 `model.lockArticle`이 **호출되지 않는지**(원본 미잠금).
- `mode:'continue'`도 동일하게 신규 탭이 열리는지(구분이 mode로 표현됨).
- 기존 PENDING_EDIT(편집 진입) 동작이 무회귀인지(편집 탭은 여전히 articleId 유지·잠금 획득).

## Acceptance Criteria

```bash
npm run lint
npm run build
npm test
```

## 검증 절차

1. 위 AC를 실행한다. 기존 442개 테스트 + 신규 테스트가 모두 통과해야 한다(무회귀).
2. 체크리스트:
   - 신규 탭이 `articleId:null`이라 저장 시 신규 POST(create) 경로로 가는가(원본 미수정)?
   - 원본 기사에 `lockArticle`를 호출하지 않는가?
   - `sender`/`sentAt`/`status` 등 원본 메타를 신규 탭으로 끌어오지 않는가(초기화)?
   - 직접 fetch/EventSource 없이 Model 경유만 하는가(ADR-003)? role을 싣지 않는가(ADR-004)?
   - `writerButtons.js`·`contract.js`·백엔드를 수정하지 않았는가?
3. `phases/2-followup-resend/index.json`의 step 1을 업데이트(completed + summary: 추가한 채널 키/헬퍼/콜백, 복사·초기화한 필드 목록, 후속·계속을 mode로 구분한 사실). 실패 시 error, 개입 필요 시 blocked.

## 금지사항

- 원본 기사를 수정/삭제하거나 잠그지 마라(`saveArticle`에 원본 articleId 싣기, `lockArticle(원본)` 금지). 이유: 후속/계속은 **신규 기사 생성**이며 원본은 손대지 않는다(phase 제약).
- 신규 탭에 원본의 `sender`/`sentAt`/`articleId`/`status`를 채우지 마라. 이유: 새 기사는 미송고·미발번 RDS draft여야 한다. 원본 송고 메타를 끌어오면 송고자/송고시간이 오염된다.
- `writerButtons.js`를 수정하지 마라. 이유: `articleId===null`이면 이미 신규로 분류되어 송고·보류(KILL 숨김)가 정확히 표시된다. 건드리면 버튼 진리표가 깨진다(무회귀 위험).
- `contract.js`/`httpModel.js`/백엔드를 수정하지 마라. 이유: 후속/계속은 기존 `getArticle`+`saveArticle`(create) Model 키의 재사용이며 신규 계약이 필요 없다.
- 기존 `PENDING_EDIT_KEY` 소비 로직·`openArticle`·`tabFromArticle`을 변경하지 마라(편집 진입 무회귀). 이유: 후속/계속은 별도 채널·별도 헬퍼로 추가한다 — 편집 경로와 섞으면 잠금/매핑 회귀가 난다.
- 기존 테스트를 깨뜨리지 마라.
