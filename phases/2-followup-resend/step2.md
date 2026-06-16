# Step 2: followup-continue-controller

list.do(기사 조회페이지)에서 원본 기사를 골라 `후속기사작성`/`계속기사작성` draft를 만들어 writer.do로 보내는 진입을 `useViewController`에 추가한다. 이 step은 **프론트 컨트롤러 한 모듈(useViewController.js)** 만 다룬다. 신규 탭을 소비하는 쪽(useWriteController)은 step1에서 완료됐고, 메뉴 활성화/결선은 step3이다.

## 읽어야 할 파일

먼저 아래 파일들을 읽고 프로젝트의 아키텍처와 설계 의도를 파악하라:

- `/docs/ADR.md` — ADR-003(프론트 MVC, 직접 fetch 금지), ADR-004(role 불신).
- `/docs/news.md` — line 85(`후속기사작성`/`계속기사작성` 메뉴), line 54~56(list.do→writer.do는 새 탭으로 진입).
- `/web/src/controller/useViewController.js` — **이 step에서 수정할 파일.** 핵심 패턴:
  - `PENDING_EDIT_KEY` + `enterEditor(article, mode)` — sessionStorage 채널에 `{article, mode}`를 쓰고 `navigate('writer.do', { articleId })`로 이동(편집 진입). `editArticle`/`reviseArticle`이 이를 호출한다.
  - `requestDelete`/`releaseLock` 등 콜백을 반환 객체에 노출하는 패턴.
- `/web/src/controller/useWriteController.js` — **step1에서 추가된** 신규 채널 키(예: `PENDING_NEW_KEY`)와 그 페이로드 shape `{ article, mode }`(mode ∈ `'followUp'|'continue'`). **이 step은 그 키/shape에 정확히 맞춰 써야 한다.** step1 완료 summary(phases/2-followup-resend/index.json의 step1)에 정확한 export 이름이 기록돼 있으니 확인하라.
- `/web/src/controller/useViewController.test.jsx` — fakeModel/navigate 모킹·sessionStorage 검증 패턴. 이 파일에 테스트를 추가한다.

이전에 만들어진 코드를 꼼꼼히 읽고 설계 의도를 이해한 뒤 작업하라.

## 작업

TDD: **테스트를 먼저 작성**한 뒤 통과하는 구현을 작성한다.

`/web/src/controller/useViewController.js`에 후속/계속 진입 콜백을 추가하고 반환 객체에 노출한다.

핵심 결정(반드시 따른다):
- **신규 기사 생성 진입이다 — 편집 채널(PENDING_EDIT_KEY)을 재사용하지 마라.** step1이 만든 신규 전용 채널(`PENDING_NEW_KEY`)에 `{ article, mode }`를 쓰고 `navigate('writer.do', {})`로 이동한다. **navigate에 `articleId`를 싣지 마라** — 새 기사 탭의 주소창엔 기사아이디가 없어야 한다(원본 articleId를 URL에 노출하면 writer가 편집 탭으로 오인할 수 있다).
- **원본 기사를 변형하지 않는다.** 컨트롤러는 채널에 원본 행(목록행)과 mode만 싣는다. 본문 재조회·필드 복사·초기화는 step1의 writer(`openFromSource`)가 책임진다 — **여기서 본문을 조회하거나 dto를 만들지 마라**(중복·계층 침범).
- **권한 가드:** 후속/계속은 R/D/Z 누구나 신규 기사를 쓸 수 있는 일반 작성이다(news.md에 권한 제한 서술 없음). 따라서 `requestDelete`처럼 D/Z 게이트를 두지 **않는다** — confirm도 두지 않는다(작성 진입은 파괴적 동작이 아니다). 단순히 채널에 쓰고 이동한다.

시그니처(구현은 재량 — `enterEditor` 패턴을 본떠 신규 채널용 헬퍼를 만든다):
```js
// 원본 행과 mode를 신규 작성 채널에 싣고 writer.do로 이동(원본 미변형, articleId를 URL에 싣지 않음).
const enterFromSource = useCallback((article, mode) => { /* sessionStorage PENDING_NEW_KEY = {article, mode}; navigate('writer.do', {}) */ }, [navigate]);
const followUpArticle = useCallback((article) => enterFromSource(article, 'followUp'), [enterFromSource]);
const continueArticle = useCallback((article) => enterFromSource(article, 'continue'), [enterFromSource]);
```
반환 객체에 `followUpArticle`, `continueArticle`를 추가한다.

sessionStorage 접근은 기존 `enterEditor`처럼 try/catch로 감싸 실패해도 navigate는 진행한다(writer가 빈 탭으로 시작).

테스트(`useViewController.test.jsx`에 케이스 추가):
- `followUpArticle(article)` 호출 → `PENDING_NEW_KEY`에 `{article, mode:'followUp'}`가 저장되고 `navigate('writer.do', ...)`가 호출되며 **articleId가 URL params에 실리지 않는지**.
- `continueArticle(article)` → `mode:'continue'`로 저장.
- `PENDING_EDIT_KEY`(편집 채널)에는 쓰지 않는지(편집과 분리 확인).

## Acceptance Criteria

```bash
npm run lint
npm run build
npm test
```

## 검증 절차

1. 위 AC를 실행한다. 기존 테스트 + step0/step1 신규 테스트 + 이 step 신규 테스트가 모두 통과해야 한다(무회귀).
2. 체크리스트:
   - step1이 정의한 채널 키·페이로드 shape와 정확히 일치하는가?
   - `navigate`에 `articleId`를 싣지 않는가(새 기사 탭 주소창)?
   - 편집 채널(PENDING_EDIT_KEY)을 재사용하지 않는가?
   - 컨트롤러에서 본문 조회/필드 복사를 하지 않는가(writer 책임)?
   - 직접 fetch 없이 navigate/sessionStorage만 쓰는가(ADR-003)?
3. `phases/2-followup-resend/index.json`의 step 2를 업데이트(completed + summary: 추가한 콜백·사용한 채널 키·권한 가드 없음 결정). 실패 시 error, 개입 필요 시 blocked.

## 금지사항

- `PENDING_EDIT_KEY`(편집 채널)에 후속/계속 draft를 싣지 마라. 이유: writer가 그것을 편집 탭(원본 articleId 보존+잠금 획득)으로 처리해 원본을 잠그고 수정 경로로 보낸다 — 신규 작성 의도와 어긋난다.
- `navigate`에 원본 `articleId`를 싣지 마라. 이유: 새 기사 탭 주소창엔 기사아이디가 없어야 한다(news.md). 싣으면 writer 라우팅이 편집으로 오인한다.
- 컨트롤러에서 `model.getArticle`로 본문을 조회하거나 신규 dto를 조립하지 마라. 이유: 그 책임은 step1의 writer(`openFromSource`)에 있다. 여기서 하면 계층 중복·이중 조회가 된다.
- 후속/계속에 D/Z 권한 게이트나 confirm을 넣지 마라. 이유: 일반 신규 작성 진입이며 파괴적이지 않다(삭제요청과 다르다).
- `재송`/`translate`/`mapping`을 건드리지 마라. 이유: 재송은 step0, translate/mapping은 다음 phase. 이 step scope는 후속/계속 진입 콜백 2개다.
- 기존 테스트를 깨뜨리지 마라.
