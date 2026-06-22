# Step 1: byline-detail-apply — 상세보기 작성자에 바이라인(email/blog) 부가 표시

## 배경 / 요구사항

Step 0에서 바이라인 설정 `byline = { email: bool, emailValue: str, blog: bool, blogValue: str }`이 환경설정 탭 + localStorage(editorPrefs)에 갖춰졌다. 이 step은 그 설정을 **실제로 출력**한다(현재는 어디에도 읽히지 않는 상태).

확정된 출력 위치(이 파일이 단일 출처): **상세보기(articleDetail) 새 창의 공통정보 '작성자' 필드 아래에**, 사용여부가 켜졌고 값이 비어있지 않은 email/blog를 **부가 라인으로** 표시한다.

예시:
```
[ 상세보기 ▸ 공통정보 ]
  작성자 : 홍길동
           hong@yna.co.kr      ← byline.email === true 이고 emailValue 비어있지 않을 때만
           https://blog...     ← byline.blog === true 이고 blogValue 비어있지 않을 때만
```

날짜형식(dateFormat)이 ListPage 마운트 시점에 `loadEditorPrefs()`로 적용되는 것과 **동일한 "call-site에서 prefs 주입" 패턴**을 쓴다. 상세보기 prefs는 그 브라우저의 editorPrefs 기준이다(뷰어 기준 — 의도된 동작).

## 읽어야 할 파일

먼저 아래를 읽고 상세보기 렌더 경로와 보안 규칙을 정확히 파악하라:

- `/CLAUDE.md`, `/docs/ARCHITECTURE.md`, `/docs/ADR.md`
- `web/src/view/editorPrefs.js` — **Step 0 결과**: `loadEditorPrefs().byline` = `{ email, emailValue, blog, blogValue }`.
- `web/src/view/articleDetail.js` — 상세보기 데이터/HTML 렌더. `DETAIL_COMMON_FIELDS`(작성자=`author`가 첫 항목), `buildDetail(article)`(공통정보 배열 + 본문 블록 + 창 제목 구성), `renderDetailHtml(article)`(새 창 HTML 문자열 생성, 공통정보 `<dl>` 렌더), `escapeHtml`(모든 값 이스케이프), `DETAIL_STYLE`(인라인 CSS — 새 창은 외부 CSS 미로드). **CRITICAL 주석**: 모든 사용자 값은 escapeHtml로 이스케이프되어 스크립트가 실행되지 않는다.
- `web/src/view/articleDetail.test.js` — 기존 buildDetail/renderDetailHtml/escape 테스트. 신규 바이라인 테스트를 같은 스타일로 추가한다.
- `web/src/view/ListPage.jsx` — `openDetail(article, loadDetail)`이 `renderDetailHtml(full)`로 새 창(720×800)에 HTML을 쓴다(현재 위치 근처). `loadEditorPrefs`는 이 파일에서 이미 dateFormat 적용에 쓰이므로 import되어 있다(확인하라).
- `web/src/view/ListPage.test.jsx` — 상세보기 새 창 테스트 패턴.

## 작업

TDD로 진행한다. 테스트 먼저.

### 1. `articleDetail.js` — byline 인자 추가 + 작성자 부가 라인

- `buildDetail(article = {}, byline = {})`로 **선택적 둘째 인자**를 추가한다. 작성자(`author`) 필드 항목에 부가 라인 배열을 계산해 붙인다:
  - `extra = []`
  - `byline.email === true` 이고 `byline.emailValue`가 공백 아닌 값이면 `extra.push(byline.emailValue)`.
  - `byline.blog === true` 이고 `byline.blogValue`가 공백 아닌 값이면 `extra.push(byline.blogValue)`.
  - 이 `extra`는 **작성자 필드 항목에만** 부여한다(다른 공통정보 필드는 불변).
- `renderDetailHtml(article = {}, byline = {})`로 **선택적 둘째 인자**를 추가하고 `buildDetail(article, byline)`로 넘긴다. 공통정보 필드 렌더 시, 해당 필드에 부가 라인(extra)이 있으면 **작성자 `<dd>` 안에 부가 라인을 줄 단위로** 렌더한다(예: 라인마다 `<div class="yh-detail__byline">…</div>`).
  - **CRITICAL: 부가 라인 값도 반드시 `escapeHtml`로 이스케이프한다.** 이유: emailValue/blogValue는 사용자 입력이므로 `<script>`/`"` 등이 섞이면 새 창에서 실행/속성탈출될 수 있다(articleDetail의 XSS 비실행 규칙 유지).
- 필요하면 `DETAIL_STYLE`에 `.yh-detail__byline` 작은 스타일(흐린 색·작은 글씨)을 추가한다(정적 문자열이라 사용자 값 무관 — 선택).

### 2. `ListPage.jsx` — 상세보기에 prefs 주입

- `openDetail`에서 `renderDetailHtml(full)` 호출을 `renderDetailHtml(full, loadEditorPrefs().byline)`로 바꾼다(dateFormat 적용과 동일한 call-site prefs 패턴). `loadEditorPrefs`가 import되어 있지 않으면 추가한다.

## Acceptance Criteria

```bash
npm run test:web && npm run build && npm run lint
```

추가 단언(articleDetail.test.js + ListPage.test.jsx, vitest):
- byline `{ email:true, emailValue:'hong@yna.co.kr', blog:false, blogValue:'' }`로 `renderDetailHtml(article, byline)` → 작성자 영역에 `hong@yna.co.kr`이 포함되고 blog 값은 없다.
- 사용여부 **OFF**(`email:false`)면 emailValue가 있어도 출력에 나타나지 않는다.
- 사용여부 ON이지만 **값이 빈 문자열**이면 부가 라인이 나타나지 않는다.
- byline 값에 `<script>alert(1)</script>` 같은 문자열이 있어도 **이스케이프되어** raw `<script>`가 출력 HTML에 그대로 들어가지 않는다(`&lt;script&gt;` 형태).
- **하위호환**: `renderDetailHtml(article)`/`buildDetail(article)`를 byline 인자 없이 호출해도(기존 호출부·테스트) 부가 라인 없이 정상 동작한다(기존 articleDetail 테스트 전부 통과).
- 작성자 외 공통정보 필드와 본문 블록 렌더는 불변(기존 ListPage 상세보기 테스트 통과).

## 검증 절차

1. 위 AC 커맨드를 실행한다.
2. 아키텍처 체크: ADR-003(ListPage의 `loadEditorPrefs`는 view 모듈 호출 — 서버 아님, dateFormat 선례와 동일) / articleDetail XSS 비실행 규칙(모든 값 escapeHtml) 유지 / CLAUDE.md CRITICAL(DB 비파괴 — 무관).
3. `phases/15-editor-prefs-byline/index.json`의 step 1을 갱신한다(성공 → `completed` + `summary` / 3회 실패 → `error` + `error_message` / 개입 필요 → `blocked` + `blocked_reason`).

## 금지사항

- **부가 라인 값을 escapeHtml 없이 출력하지 마라.** 이유: 사용자 입력(emailValue/blogValue)의 XSS·속성 탈출을 막아야 한다(articleDetail의 핵심 보안 규칙).
- 작성자 외 공통정보 필드나 본문 블록 렌더를 바꾸지 마라(회귀 금지).
- `buildDetail`/`renderDetailHtml`의 byline 인자를 **필수**로 만들지 마라(기본값 `{}`). 이유: 인자 없는 기존 호출/테스트가 깨진다(하위호환).
- 바이라인을 서버 DTO·기사 본문·DB에 쓰지 마라. 이유: 이번 결정은 상세보기 표시(클라이언트 prefs)만이다.
- 기존 테스트를 깨뜨리지 마라.
