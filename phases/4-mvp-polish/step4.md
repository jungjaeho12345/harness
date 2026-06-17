# Step 4: media-search-demo

미디어 검색에 **데모 폴백**을 넣어 API 키가 없는 개발/데모 환경에서도 검색 UI가 빈 화면이 되지 않게 하고, 작성 페이지(`WriterPage`)의 **검색 패널 디자인**을 정리한다(검색창+버튼 한 줄, 이미지/영상은 썸네일 카드, 글기사는 제목 + '삽입' 버튼 행). 이 step은 **백엔드 미디어 검색 서비스 한 모듈(`src/services/mediaSearch.js`)** 과 **작성 페이지 뷰/스타일(`web/src/view/WriterPage.jsx`·`web/src/styles/yonhap.css`)** 만 다룬다. 검색 결과 임베드 추가(`onPick`) 경로 자체는 건드리지 않는다.

## 읽어야 할 파일

먼저 아래 파일들을 읽고 프로젝트의 아키텍처와 설계 의도를 파악하라:

- `/docs/ADR.md` — ADR-006(얇은 transport + 계층형 도메인 백엔드: controllers → services → models. 외부 API 호출은 services에 격리), ADR-003(View는 Controller/Model 경유, 직접 fetch 금지).
- `/docs/news.md` — 미디어 검색 보안/실패 규칙: API 키는 서버 env에서만 읽는다(소스 하드코딩 금지), 외부 호출 실패는 예외로 전파하지 않고 빈 결과를 반환한다.
- `/src/services/mediaSearch.js` — **이 step에서 수정할 백엔드 파일.** 핵심 이해 포인트:
  - `createMediaSearch({ fetchFn, env })`가 `search(query, type)`를 반환한다. `type`은 `normalizeType`으로 `'image'|'video'`로 정규화된다.
  - `buildUrl(kind, query, env)`가 키 누락 시 falsy를 반환한다. 기존엔 `if (!url) return empty()`(`{ items: [], error: true }`)로 빈 결과를 줬다 — **데모 환경에서 검색창이 항상 비는 문제**.
  - CRITICAL: API 키는 주입된 `env`에서만 읽는다(소스 하드코딩 금지). 외부 호출은 주입된 `fetchFn`으로만 한다(`globalThis.fetch` 직접 호출 금지 — 테스트 결정성).
  - `empty()`는 **실제 외부 호출 실패**(fetch throw/비정상 응답)용으로 유지한다(`error: true`).
- `/web/src/view/WriterPage.jsx` — **이 step에서 수정할 뷰 파일.** 핵심 이해 포인트:
  - `SearchPanel({ kind, results, onSearch, onPick })`가 이미지(`image`)/영상(`video`)/글기사(`article`) 공통 검색 패널이다. `onSearch(q)`로 검색, `onPick(item)`으로 결과를 본문에 임베드(이 경로는 무변경).
  - 결과 item은 종류별로 키가 다르다: 이미지=`src`/`link`, 영상=`videoId`(또는 `id.videoId`)/`url`, 글기사=`articleId`/`title`/`status`.
- `/web/src/styles/yonhap.css` — `--yh-sp-sm`·`--yh-border`·`--yh-accent` 등 디자인 토큰과 `.yh-btn`·`.yh-search-results` 기존 스타일. 신규 클래스를 additive로 추가한다.
- `/test/mediaSearch.test.js` — `fakeFetch`/`ok` 헬퍼로 `fetchFn`을 주입하고 `calls`로 외부 호출 여부를 단언하는 패턴. 키 누락 케이스를 데모 폴백으로 갱신한다.
- `/web/src/view/WriterPage.test.jsx` — `openMapping`/`fakeModel`/`userEvent` 기반 통합 테스트 패턴(`searchArticles` mock, `data-embed-type` 단언). 글기사 디자인 케이스를 추가한다.

이전에 만들어진 코드를 꼼꼼히 읽고 설계 의도를 이해한 뒤 작업하라.

## 작업

TDD: **테스트를 먼저 작성**한 뒤 통과하는 구현을 작성한다.

### A. `src/services/mediaSearch.js` — 데모 폴백

핵심 결정(반드시 따른다):
1. **데모 폴백 헬퍼를 추가한다**: `demoResults(type, query)`.
   - `query`를 trim한 시드(`q = String(query ?? '').trim() || '뉴스'`)로 결정적 샘플을 만든다.
   - `type === 'image'`: picsum 시드 URL 6개 — `{ title: `${q} 이미지 ${i+1} (데모)`, link: `https://picsum.photos/seed/${encodeURIComponent(q)}-${i}/320/200` }`.
   - 그 외(영상): `DEMO_VIDEO_IDS`(임베드 가능한 **공개 유튜브 video id** 4개) 매핑 — `{ title, videoId: id, url: `https://www.youtube.com/watch?v=${id}` }`. video id는 임베드를 위해 11자리 형태여야 한다.
2. **키 누락 분기만 교체한다**: `search()`에서 `if (!url) return empty();`를 `if (!url) return { items: demoResults(kind, query), error: false, demo: true };`로 바꾼다. 외부 호출 없이(=`fetchFn` 미호출) 데모 샘플을 돌려준다.
3. **실 API 경로는 무변경**: 실제 키(GOOGLE_*/YOUTUBE_*)가 있으면 `buildUrl`→`fetchFn` 경로로 기존대로 Google/YouTube를 호출한다. 데모 폴백은 키 누락일 때만 쓰인다.
4. **진짜 실패는 여전히 빈 결과**: `fetchFn` throw/비정상 응답 등 외부 호출 실패는 기존처럼 `empty()`(`error: true`)로 처리한다 — 데모 폴백과 헷갈리지 마라.

### B. `web/src/view/WriterPage.jsx`·`yonhap.css` — 검색 패널 디자인

핵심 결정:
1. **검색창 한 줄 정렬 + Enter 검색**: `SearchPanel`의 검색 input과 '검색' 버튼을 `.yh-search-bar` 한 줄로 묶는다. input에 `onKeyDown`을 달아 `Enter`면 검색(`const submit = () => onSearch(q)`)을 트리거한다.
2. **글기사는 제목 + '삽입' 행**: `kind === 'article'`이면 `<ul className="yh-article-results">`로 렌더 — 각 행은 `.yh-article-result__title`(제목, ellipsis)과 `.yh-btn yh-btn--sm` '삽입' 버튼. 클릭 시 `onPick(item)`(임베드 추가 경로 무변경). 제목이 없으면 `articleId`/`(제목 없음)` 폴백.
3. **이미지/영상은 썸네일 카드**: 그 외(`image`/`video`)는 `.yh-media-result` 버튼 카드로 렌더. 썸네일은 이미지면 `item.src ?? item.link`, 영상이면 `youtubeThumb(item)` 헬퍼(`https://img.youtube.com/vi/${id}/mqdefault.jpg`, id 없으면 null) 사용. 썸네일이 없으면 제목/`url`/`결과` 텍스트 폴백.
4. **CSS는 additive**: `yonhap.css`에 `.yh-search-bar`(flex 한 줄, input `flex:1`), `.yh-media-result`(테두리 카드·hover accent·`img` width 110px), `.yh-article-results`/`.yh-article-result`/`.yh-article-result__title`(목록 행·제목 ellipsis), `.yh-btn--sm`(작은 버튼) 스타일만 추가한다 — 기존 스타일/토큰을 바꾸지 마라.

구현(시그니처는 재량, 기존 구조 재사용):
- `mediaSearch.js`: 모듈 상수 `DEMO_VIDEO_IDS`, 함수 `demoResults(type, query)` 추가. `search()`의 키 누락 return만 교체.
- `WriterPage.jsx`: 헬퍼 `youtubeThumb(item)` 추가, `SearchPanel`을 `.yh-search-bar` + (article ↔ media) 분기 렌더로 재구성.

테스트:
- `test/mediaSearch.test.js`: 키 누락 케이스 2개를 갱신 — (1) YouTube 키 없음(video): `fetch` 미호출(`calls.length === 0`)·`error === false`·`items.length > 0`·각 `videoId`가 `/^[\w-]{11}$/`. (2) Google 키/CSE_ID 없음(image): `fetch` 미호출·`error === false`·`items.length > 0`·각 `link`가 비어있지 않은 문자열.
- `web/src/view/WriterPage.test.jsx`: 글기사 케이스 1개 추가 — `searchArticles`를 `{ ok:true, items:[{ articleId, title, status }] }`로 mock, '글기사' 탭→검색어 입력→'검색' 클릭 후 **제목이 그대로 보이고** 같은 행의 '삽입' 버튼 클릭 시 본문에 `[data-embed-type="article"]` 임베드가 추가되는지.

## Acceptance Criteria

```bash
npm run lint
npm run build
npm test
npm run test:web
```

## 검증 절차

1. 위 AC 커맨드를 실행한다. 기존 테스트 + 갱신/신규 테스트가 모두 통과해야 한다(무회귀).
2. 아키텍처 체크리스트(ARCHITECTURE.md 디렉토리 구조·ADR 기술스택·CLAUDE.md CRITICAL):
   - 데모 폴백이 백엔드 service 계층(`src/services/mediaSearch.js`)에만 있고, 외부 호출은 `fetchFn`·키는 `env`로만 다루는가(ADR-006·news.md 보안, globalThis.fetch 직접 호출 없음)?
   - 실제 키가 있을 때 실 API 호출 경로가 무변경이고, 외부 호출 실패는 여전히 `empty()`(error:true)인가?
   - 데모 폴백은 키 누락일 때만 동작하고 `fetchFn`을 부르지 않는가(테스트로 보장)?
   - View(`WriterPage`)가 직접 fetch 없이 `onSearch`/`onPick` 콜백만 경유하는가(ADR-003)?
   - DB 비파괴: 미디어 검색/글기사 조회는 읽기·외부검색만이고 쓰기/삭제가 없는가?
   - 글기사 '삽입' 클릭 시 임베드 추가(`onPick`) 동작이 무회귀인가?
3. 결과에 따라 `phases/4-mvp-polish/index.json`의 step 4 status를 갱신한다(통과 시 completed + summary). 실패 시 error, 개입 필요 시 blocked.

## 금지사항

- 데모 폴백을 실 API 호출 경로(키가 있을 때)에까지 적용하지 마라. 이유: 실제 키가 설정된 환경에서는 진짜 Google/YouTube 결과를 줘야 한다 — 데모 샘플은 키 누락 폴백 전용이다.
- 진짜 외부 호출 실패(`fetchFn` throw·비정상 응답)를 데모 샘플로 가리지 마라. 이유: 실패는 기존대로 `empty()`(error:true)로 처리해야 호출자가 오류를 구분한다.
- API 키를 소스에 하드코딩하거나 `globalThis.fetch`를 직접 호출하지 마라(news.md 보안·테스트 결정성). 외부 호출은 주입된 `fetchFn`, 키는 주입된 `env`로만.
- View(`WriterPage`)에서 직접 fetch/EventSource를 호출하지 마라(ADR-003). 검색·결과 처리는 `onSearch`/`onPick` 콜백 경유.
- 검색 결과 임베드 추가(`onPick`) 로직을 디자인 변경 중에 바꾸지 마라. 이유: 이 step은 폴백 데이터 + 표시(디자인)만이고, 임베드 추가 동작은 무회귀여야 한다.
- 기존 CSS 토큰/클래스를 수정·제거하지 마라(신규 클래스만 additive). 기존 테스트/기능을 깨뜨리지 마라.
