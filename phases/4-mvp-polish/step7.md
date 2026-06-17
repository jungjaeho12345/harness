# Step 7: detail-view

상세보기 새 창을 **(1) yonhap 디자인으로 개편**하고, **(2) 제목·본문이 안 보이던 버그를 본문 포함 단건 재조회로 수정**하며, **(3) 렌더 결과 미리보기 HTML**을 남긴다. 상세보기 새 창은 앱 CSS(`yonhap.css`)를 로드하지 못하므로 디자인은 인라인 `<style>`로 포함하고, 목록 행(Contents 전용)에는 본문(`markupVersion`)이 없으므로 클릭 직전 `model.getArticle(id)`로 본문까지 갖춘 전체 기사를 가져와 렌더한다(ADR-003 Model 경유). 이 step은 **뷰 두 모듈(`articleDetail.js`, `ListPage.jsx`)과 컨트롤러(`useViewController.js`)** 만 다룬다(Model/스키마/백엔드 무변경 — `getArticle`는 기존 contract).

## 읽어야 할 파일

먼저 아래 파일들을 읽고 프로젝트의 아키텍처와 설계 의도를 파악하라:

- `/docs/news.md` — 상세보기 규격(상단 공통정보 가로 나열·빈 필드는 '—', 하단 본문 블록을 저장 순서대로 한 영역에, 본문 첫 줄=제목).
- `/web/src/view/articleDetail.js` — **이 step에서 수정할 파일.** 핵심 이해 포인트:
  - `buildDetail(article)` — 공통정보 `common`(label/value, 빈 값은 `EMPTY_FIELD='—'`), 본문 `blocks`(텍스트/임베드), 창 제목 `windowTitle`을 만든다.
  - `renderDetailHtml(article)` — 새 창에 write할 HTML 문서 문자열. **모든 값은 `escapeHtml`로 이스케이프**(스크립트 실행 불가).
  - `EMPTY_FIELD` 상수, `isEmbedBlock(b)`, `escapeHtml`.
  - 새 창은 외부 CSS(`yonhap.css`)를 받지 못한다 → 디자인은 문서 안에 인라인해야 한다.
- `/web/src/view/yonhap.css` — 앱 디자인 토큰(블루 기조 `#0a4da6`·레드 포인트 `#c8102e`·명조 헤드라인). 새 창용 인라인 스타일이 이 톤을 따르도록 참고(읽기만).
- `/web/src/controller/useViewController.js` — **이 step에서 수정할 파일.** 핵심 이해 포인트:
  - 모든 데이터는 Model 경유(ADR-003), 직접 `fetch` 금지. `model.getArticle(id)`는 본문 포함 단건 `{ ok, article, contents }`를 반환한다(기존 contract).
  - 반환 객체에 콜백들(`editArticle`, `loadHistory`, `mapArticle` …)을 노출하는 패턴.
- `/web/src/view/ListPage.jsx` — **이 step에서 수정할 파일.** 핵심 이해 포인트:
  - `openDetail(article)` — `window.open('', '_blank', 'width=720,height=800')`로 빈 새 창을 열고 `renderDetailHtml`을 write한다.
  - 행 `onClick`과 `onCtxSelect`의 `case 'detail'`에서 `openDetail`을 호출한다.
  - 목록 행(`row`)은 조회 페이지용 Contents라 본문(`markupVersion`)이 없다 — 그래서 제목(첫 줄)·본문이 비어 보인다.
- `/web/src/model/httpModel.js` — `getArticle(articleId)`가 GET `/api/articles/:id`를 호출해 `{ ok, article, contents }`를 돌려줌을 확인(읽기만, 수정 금지).
- `/web/src/view/ListPage.test.jsx` — 상세보기 새 창 테스트(window.open spy) 패턴. 본문 재조회 케이스를 추가한다.

이전에 만들어진 코드를 꼼꼼히 읽고 설계 의도를 이해한 뒤 작업하라.

## 작업

TDD: 본문 미표시 수정은 **테스트를 먼저 작성**한 뒤 통과하는 구현을 작성한다(디자인 개편·미리보기 HTML은 시각 산출물이라 단위 테스트 없음).

핵심 결정(반드시 따른다):
- 상세보기 새 창은 앱 CSS를 못 받으므로 디자인을 **인라인 `<style>` 정적 문자열**로 문서에 포함한다. 정적이라 사용자 데이터를 담지 않는다(XSS 무관) — **본문/공통정보 값은 기존대로 `escapeHtml`을 유지**한다.
- 목록 행에는 본문이 없으므로, 상세보기 직전 `model.getArticle(id)`로 본문 포함 전체 기사를 받아 렌더한다(직접 fetch 금지 — ADR-003). 머지는 `{ ...contents, ...article }`로 하여 `markupVersion`·`title`이 `article`(Article 도메인) 값으로 우선되게 한다(본문 첫 줄=제목 렌더가 살아난다).
- 팝업 차단을 피하려 클릭 **즉시(동기)** 빈 창을 먼저 열고, 본문을 받은 뒤 `document.open()/write()/close()`로 채운다. 조회 실패 시 목록 행만으로 폴백 렌더(throw 없음).

구현(시그니처는 재량, 기존 패턴 재사용):
- `articleDetail.js`: 인라인 스타일 상수(예: `DETAIL_STYLE`)를 추가 — yonhap 디자인 토큰(블루 기조·레드 포인트·명조 헤드라인)을 직접 박는다. 공통정보는 가로 **그리드**(`grid-template-columns:repeat(auto-fill,minmax(140px,1fr))`)로, 본문은 명조(`'Nanum Myeongjo'`) 지면으로 렌더하고 **첫 줄(`.yh-detail__line:first-child`)을 제목으로 강조**(별도 제목 요소 없음). `renderDetailHtml`에서 ① 빈 필드(`value === EMPTY_FIELD`)에 `class="is-empty"` 부여, ② 본문 블록이 없으면 `'본문 내용이 없습니다.'` 폴백 단락, ③ `<head>`에 viewport meta·`<style>${DETAIL_STYLE}</style>` 추가, ④ 문서를 `<article class="yh-detail">`/`<header>` 래퍼로 감싼다.
- `useViewController.js`: `loadDetail(articleId)` 콜백 추가 — `await model.getArticle(articleId)` 호출, `r.ok === false`/없음이면 `null`, 아니면 `{ ...(r.contents||{}), ...(r.article||{}) }` 반환. 반환 객체에 `loadDetail` 노출.
- `ListPage.jsx`: `openDetail`을 `async (article, loadDetail)`로 바꾼다 — 클릭 즉시 빈 창 `window.open`(차단되면 return), `try { const f = await loadDetail(article.articleId); if (f) full = f; } catch {}`(폴백), 그 후 `w.document.open(); w.document.write(renderDetailHtml(full)); w.document.close();`. 컨트롤러 구조분해에 `loadDetail` 추가, 행 `onClick`·`onCtxSelect` `case 'detail'`을 `await openDetail(article, loadDetail)`로 전달.
- `detail-preview.html`(리포 루트): `renderDetailHtml`의 렌더 결과 고정 샘플(디자인 검수용 정적 미리보기). 빌드/런타임 비참조.

테스트(`ListPage.test.jsx`):
- 행 클릭 시 `model.getArticle(id)`가 호출되고, 응답의 `markupVersion`(첫 줄=제목, 둘째 줄=본문)이 새 창 write HTML에 제목·본문으로 들어가는지(window.open spy로 write 캡처).
- 기존 "상세보기 새 창(720×800)을 연다" 테스트의 window.open mock에 `document.open`을 추가(폴백 경로 호환).

## Acceptance Criteria

```bash
npm run lint
npm run build
npm test
npm run test:web
```

## 검증 절차

1. 위 AC 커맨드를 실행한다. 기존 web 테스트 + 신규/갱신 테스트가 모두 통과해야 한다(무회귀).
2. 아키텍처 체크리스트(ARCHITECTURE.md 디렉토리 구조·ADR 기술스택·CLAUDE.md CRITICAL·ADR-003/004/006·DB 비파괴):
   - 새 창의 디자인이 인라인 `<style>` 정적 문자열로 들어가는가? 본문/공통정보 값은 여전히 `escapeHtml`로 이스케이프되는가(XSS 차단)?
   - 본문 재조회가 `model.getArticle`(Model 경유)로만 일어나는가 — 뷰에서 직접 fetch가 없는가(ADR-003)?
   - 머지가 `{ ...contents, ...article }`라 `markupVersion`·`title`이 Article 값으로 우선되는가(제목·본문 렌더 복구)?
   - 조회 실패가 throw 없이 목록 행 폴백으로 처리되는가? 팝업은 클릭 즉시 동기로 열리는가(차단 회피)?
   - Model/스키마/`server/` 백엔드가 무변경인가(읽기 전용 단건 조회만, DB 비파괴 — SELECT)?
3. `phases/4-mvp-polish/index.json`의 step 7을 업데이트(completed + summary: DETAIL_STYLE 인라인·가로 그리드·명조 지면 첫 줄 제목·is-empty·본문 폴백·loadDetail 단건 재조회 머지·openDetail async 폴백·detail-preview.html·web 테스트 증감). 실패 시 error, 개입 필요 시 blocked.

## 금지사항

- 본문/공통정보 값을 이스케이프 없이 HTML에 넣지 마라. 이유: 새 창 write는 사용자 입력을 그대로 실행 가능한 마크업으로 만들 수 있다 — 정적 `<style>`만 인라인하고 값은 반드시 `escapeHtml`을 거쳐라.
- 상세보기에서 `model`을 거치지 않고 직접 `fetch`로 본문을 조회하지 마라. 이유: ADR-003(모든 데이터는 Model 경유) 위반이며 contract 일관성·테스트 가능성이 깨진다.
- 본문 머지 순서를 `{ ...article, ...contents }`로 두지 마라. 이유: Contents가 `markupVersion`·`title`을 덮어써 본문·제목이 다시 사라진다 — `article`이 마지막에 펼쳐져 우선돼야 한다.
- 새 창을 본문 조회(`await`) **이후에** 열지 마라. 이유: 비동기 뒤 `window.open`은 사용자 제스처를 벗어나 팝업 차단에 걸린다 — 클릭 즉시 빈 창을 먼저 열고 나중에 write하라.
- Model/스키마/`server/` 백엔드를 수정하거나 DB를 변경(UPDATE/DELETE)하지 마라. 이유: 이 step은 읽기 전용 단건 조회·렌더만이며, `getArticle`는 기존 contract다 — DB 비파괴.
- 기존 테스트/기능을 깨뜨리지 마라(특히 기존 새 창 720×800 테스트의 window.open mock 호환 유지).
