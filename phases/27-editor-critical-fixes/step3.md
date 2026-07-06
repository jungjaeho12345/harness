# Step 3: file-link-href-guard

CommonInfo의 첨부/자료파일 링크 `href`가 스킴 검증 없이 DB 원본값을 그대로 렌더해, 조작된 값(예: `javascript:...`)이 편집 화면에서 클릭 시 실행되는 **저장형 XSS(클릭 유발)** 결함을 고친다. 이미 존재하는 공용 함수 `isAllowedHref`(clipboardEmbed.js)로 href를 검증한다.

## 읽어야 할 파일

먼저 아래 파일들을 읽고 프로젝트의 아키텍처와 설계 의도를 파악하라:

- `/CLAUDE.md` — 프로젝트 규칙(DB 비파괴·TDD·conventional commits).
- `/docs/ARCHITECTURE.md` — 보안 경계(신뢰 경계=서버), 프론트 MVC.
- `/docs/ADR.md` — ADR-004(클라이언트 role 불신), zero-dep. phase 19 노트의 XSS 방어(URL 검증 단일 출처 `clipboardEmbed.js`) 맥락.
- `/docs/news.md` — 공통정보 첨부/자료파일(49행), 상세보기 이스케이프(108행 — 상세보기는 이미 안전, 노출면은 편집 화면 클릭).
- `/docs/UI_GUIDE.md` — 링크/텍스트 표시 톤(참조만).
- `/web/src/view/WriterPage.jsx` — **수정 대상**. 이 파일은 step0(최소 변경 가능)·step2에서 이미 손댔을 수 있으니 **현재 파일을 처음부터 정독**하라. 특히 `CommonInfo`(약 941행~) 안의 첨부/자료파일 링크:
  - 첨부: 약 997~1004행 — `{f.attachmentFile && (<span className="yh-file-saved"><a href={f.attachmentFile}>{f.attachmentFile}</a> ... 지우기 버튼 ...</span>)}`.
  - 자료: 약 1006~1017행 — `<a href={f.referenceFile}>{f.referenceFile}</a>` 동일 구조.
  - `f.attachmentFile`/`f.referenceFile`은 DB 원본값(서버 articleService가 스킴 검증 없이 저장 — 상세보기는 이스케이프되어 안전하지만 편집 화면 링크는 클릭 시 실행 가능).
- `/web/src/view/clipboardEmbed.js` — **재사용할 공용 함수**. `export function isAllowedHref(href)`(약 68~73행): `classifyUrl` 기반. **스킴 없는 상대경로(예: `/uploads/xxx.ext`)는 허용(scheme==='' → true), `https://`만 허용, `javascript:`/`data:`/`http:`/제어문자/백슬래시/프로토콜상대(`//`)는 거부.** 첨부 path는 `/uploads` 상대경로이므로 정상 링크는 안 깨지고 위험 스킴만 막힌다. `InlineEmbed.jsx`가 이미 링크 임베드에 이 함수를 쓴다.
- `/web/src/view/WriterPage.test.jsx` — **수정 대상**. 참고: "편집 진입 시 저장된 첨부/자료파일 path가 표시된다"(약 957~970행)에서 seed로 `attachmentFile`/`referenceFile`을 주입해 렌더를 검증하는 방식.

이전 step에서 만들어진 코드를 꼼꼼히 읽고, 설계 의도를 이해한 뒤 작업하라.

## 배경(결함 상세)

- crafted API로 `attachmentFile='javascript:...'`가 저장되면, 편집 진입 시 링크가 렌더되고 클릭 시 피해자 세션(`x-session-id` 컨텍스트)에서 스크립트가 실행된다.
- 상세보기(발행 뷰)는 이미 이스케이프되어 안전하다 — 노출면은 **편집 화면의 링크 클릭**뿐이다.
- 링크 임베드는 이미 `isAllowedHref`로 검증한다(phase 19). 첨부/자료 링크만 이 검증이 빠져 있어 동일 공용 함수를 적용하면 된다.

## 작업 (TDD — 테스트 먼저)

### 1) 테스트 먼저 작성 — `WriterPage.test.jsx`

첨부/자료파일에 대해 각각(또는 파라미터화하여) 추가한다:

- **위험 스킴 거부**: seed에 `attachmentFile='javascript:alert(1)'`(그리고 별도로 `referenceFile='javascript:alert(1)'`)를 주입해 편집 진입 렌더 시 → 클릭 가능한 `<a href="javascript:...">`가 렌더되지 **않음**을 단언한다(예: 해당 텍스트를 담은 `<a>` 요소가 없음, 또는 href 속성이 실리지 않음). 파일명 텍스트 자체(`javascript:alert(1)` 문자열)는 이스케이프된 텍스트로 표시되어도 무방하다(textNode는 안전).
- **정상 상대경로 허용**: seed에 `attachmentFile='/uploads/stored-a.pdf'`(그리고 `referenceFile='/uploads/stored-r.docx'`)를 주입하면 → `<a href="/uploads/stored-a.pdf">`가 **정상 렌더**됨을 단언한다(기존 표시 테스트가 깨지지 않아야 함).
- (선택·권장) `https://example.com/x.pdf` 같은 `https://` 값도 링크로 렌더됨을, `http://...`나 프로토콜상대 `//evil/x`는 링크로 렌더되지 않음을 단언해 `isAllowedHref` 규칙과 일치함을 확인한다.
- 기존 표시 테스트(약 957~970행)는 상대경로 값을 쓰므로 **그대로 통과**해야 한다.

### 2) 구현 — WriterPage.jsx (`CommonInfo`)

- `clipboardEmbed.js`에서 `isAllowedHref`를 import한다(이미 다른 곳에서 쓰는 공용 함수 — 재정의 금지).
- 첨부/자료 링크 렌더에 `isAllowedHref(f.attachmentFile)` / `isAllowedHref(f.referenceFile)`를 적용한다:
  - 허용(`true`)이면 기존대로 `<a href={...}>{파일명}</a>`로 클릭 가능한 링크를 렌더한다.
  - 비허용(`false`)이면 **링크 대신** 이스케이프된 텍스트(예: `<span>{파일명}</span>`)로만 표시해 클릭이 불가능하게 한다(href를 아예 싣지 않는다). '지우기' 버튼(×) 등 나머지 UI는 유지한다.
- 첨부와 자료 두 곳 모두 동일하게 적용한다.

### 시그니처 수준 지시

- import: `import { isAllowedHref } from './clipboardEmbed.js';`(경로/기존 import 구문에 병합). 검증 로직을 새로 구현하지 말고 이 함수만 사용한다.
- 렌더 분기(링크 vs 텍스트)만 추가한다. `onFileChange`/업로드/지우기 버튼 로직은 이 step에서 건드리지 않는다.

### 핵심 불변식(반드시 준수)

- `isAllowedHref(value) === false`인 첨부/자료값은 **클릭 가능한 `<a href>`로 렌더되지 않는다**(위험 스킴 링크 차단).
- `/uploads/...` 상대경로 및 `https://...` 정상값은 기존대로 링크로 렌더된다(정상 링크를 깨지 않는다).
- 파일명 텍스트는 React 기본 이스케이프(textNode)로 표시한다 — `dangerouslySetInnerHTML`을 쓰지 않는다.
- View는 transport 비의존을 유지한다(검증은 순수 함수 `isAllowedHref`만 사용).

## Acceptance Criteria

```bash
npm run test:web   # 신규 href 가드 테스트 + 전체 회귀 통과 (vitest, web 루트)
npm run build      # vite 프로덕션 빌드 에러 없음
npm run lint       # ESLint 위반 없음
```

모든 신규/수정 텍스트는 UTF-8로 저장하라.

## 검증 절차

1. 위 AC 커맨드를 실행한다.
2. 아키텍처 체크리스트를 확인한다:
   - `isAllowedHref`를 `clipboardEmbed.js`에서 import해 재사용했는가(검증 로직 재구현 금지)?
   - `dangerouslySetInnerHTML`을 쓰지 않고 React 기본 이스케이프로 텍스트를 표시하는가?
   - CLAUDE.md 규칙(DB 비파괴·zero-dep)과 ADR-004(보안 경계) 정신을 지키는가?
3. 결과에 따라 `phases/27-editor-critical-fixes/index.json`의 step 3을 업데이트한다:
   - 성공 → `"status": "completed"`, `"summary": "산출물 한 줄 요약"`
   - 수정 3회 시도 후에도 실패 → `"status": "error"`, `"error_message": "구체적 에러 내용"`
   - 사용자 개입 필요 → `"status": "blocked"`, `"blocked_reason": "구체적 사유"` 후 즉시 중단

## 금지사항

- href 스킴 검증 로직을 새로 작성하지 마라. 이유: `clipboardEmbed.js`의 `isAllowedHref`가 phase 19 적대적 XSS 검증을 거친 단일 출처다 — 재구현하면 우회 벡터(제어문자/공백/백슬래시/`//`)를 놓친다.
- `dangerouslySetInnerHTML`이나 raw HTML 삽입을 쓰지 마라. 이유: 새 XSS 표면을 만든다 — 파일명은 반드시 textNode로 표시한다.
- 서버 `articleService`나 DB 스키마를 수정하지 마라(이 4건은 클라이언트 방어가 1차 — 서버 심화방어는 별도 phase). 이유: DB 비파괴 원칙, 그리고 이 step의 노출면은 편집 화면 렌더다.
- `onFileChange`/업로드/탭 가드(step2 산출물) 로직을 건드리지 마라. 이유: scope 최소화 — 이 step은 링크 렌더 분기만 추가한다.
- View에서 `fetch`/`EventSource`를 직접 호출하지 마라. 이유: ADR-003 — transport는 httpModel 안에만.
- 새 npm 의존성을 추가하지 마라(zero-dep).
- 기존 테스트를 깨뜨리지 마라(특히 첨부/자료 path 표시 테스트). 이유: 회귀 스위트가 하류 단계의 안전망이다.
