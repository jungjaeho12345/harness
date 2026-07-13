# Step 0: server-fileref-href-guard

phase 27 step3은 편집 화면 링크 렌더(CommonInfo)에만 `isAllowedHref`를 적용했다(클라이언트 방어 1차). 그러나 조작된 API 요청은 여전히 `attachmentFile`/`referenceFile`에 위험 스킴(예: `javascript:...`)을 **DB에 저장**할 수 있다. 서버 신뢰 경계(ADR-004)에서 저장 시점에 이 두 값을 **/uploads 상대경로 또는 https:// 만** 허용하도록 심화 방어한다.

## 읽어야 할 파일

먼저 아래 파일들을 읽고 프로젝트의 아키텍처와 설계 의도를 파악하라:

- `/CLAUDE.md` — 프로젝트 규칙(DB 비파괴·TDD·conventional commits).
- `/docs/ARCHITECTURE.md` — 보안 경계(신뢰 경계=서버, 55~57행), 백엔드 계층(controllers→services→models→db), DB 비파괴 원칙.
- `/docs/ADR.md` — ADR-002(node:sqlite·additive 마이그레이션만·행 삭제 없음), ADR-004(클라이언트 값 불신·서버 인가), ADR-006(얇은 transport·계층형 도메인), zero-dep 철학.
- `/docs/SCHEMA.md` — Contents 테이블 공통정보 컬럼(첨부파일 attachmentFile·자료파일 referenceFile, 47행), "DB에 있는 내용은 절대 삭제하지 않는다"(11행), 멱등 마이그레이션.
- `/docs/news.md` — 공통정보 첨부/자료파일(49행), 보안(291~295행).
- `/src/services/articleService.js` — **수정 대상**. `CONTENTS_FIELDS`(14~19행)에 `attachmentFile`/`referenceFile`가 포함되고, `create`(68~80행)와 `update`(84~94행)가 `pick(dto, CONTENTS_FIELDS)`로 검증 없이 그대로 조립·저장한다. 여기가 저장 시점 유일 관문이다. 참고: `hasEndMarker`/`isStale` 같은 **모듈 사설 순수 헬퍼**가 이미 파일 상단에 있으니 동형으로 추가하라.
- `/src/models/articleModel.js` — 참고(수정 금지). `insert`/`update`가 `CONTENTS_COLS`만 SQL로 반영하며 present 컬럼만 SET한다(undefined 필드는 건드리지 않음 — 이 성질이 DB 비파괴 보장의 근거다).
- `/web/src/view/clipboardEmbed.js` — **참고만(수정·import 금지, web 번들이라 서버가 import 불가)**. `classifyUrl`(26~36행)·`isAllowedHref`(68~73행)의 **거부 기반 정규화 규칙**을 서버 헬퍼가 동형으로 재현할 근거다: 제어문자·공백(U+0000~U+0020) 거부, 백슬래시 거부, 프로토콜상대(`//`) 거부, `https://`(authority 포함)만 허용, 스킴 없는 상대경로 허용.
- `/test/articleService.test.js` — **수정 대상(테스트 추가)**. `setup()`(8~14행: in-memory db + articleModel + service)·`getById`로 저장 결과를 검증하는 기존 스타일을 그대로 따른다.

이전 step에서 만들어진 코드를 꼼꼼히 읽고, 설계 의도를 이해한 뒤 작업하라.

## 배경(결함 상세)

- crafted API(`POST /api/articles`·`PUT /api/articles/:id`)로 `attachmentFile='javascript:alert(1)'` 같은 값이 서버에 도달하면 `articleService.create`/`update`가 검증 없이 Contents에 저장한다.
- 클라이언트 렌더 방어(phase 27 step3)는 편집 화면 클릭 실행만 막을 뿐, **DB에는 위험 값이 그대로 남는다** — 다른 클라이언트/후속 뷰가 방어를 빠뜨리면 재노출된다. 서버에서 저장 자체를 막는 게 심화 방어다.
- 정상 값은 두 가지뿐이다: 업로드가 만든 **`/uploads/...` 상대경로**, 또는 외부 **`https://...`**. 그 외 스킴(`javascript:`/`data:`/`http:`/프로토콜상대 `//`/제어문자·백슬래시 우회)은 저장하지 않는다.

## 작업 (TDD — 테스트 먼저)

### 1) 테스트 먼저 작성 — `/test/articleService.test.js`

기존 `setup()`/`markup()` 헬퍼와 `articleModel.getById(...).contents`로 저장값을 확인하는 스타일을 따른다. 아래를 추가한다(첨부·자료 각각, 또는 반복문으로):

- **위험 스킴 거부(create)**: `service.create({ title:'t', author:'kim', attachmentFile:'javascript:alert(1)', referenceFile:'javascript:alert(1)' })` 후 `getById(id).contents.attachmentFile`/`.referenceFile`가 위험 값이 아니라 **빈 문자열('')** 임을 단언한다.
- **위험 스킴 거부(update)**: 정상 생성 후 `service.update(id, { attachmentFile:'javascript:alert(1)' })` → 저장값이 `''` 임을 단언한다.
- **정상 상대경로 허용**: `attachmentFile:'/uploads/stored-a.pdf'` / `referenceFile:'/uploads/stored-r.docx'`가 create·update 모두 **그대로 저장**됨을 단언한다.
- **정상 https 허용**: `attachmentFile:'https://example.com/x.pdf'`가 그대로 저장됨을 단언한다.
- **우회 벡터 거부**: `http://evil/x`, 프로토콜상대 `//evil/x`, 백슬래시 포함 `/\evil`, 선행 제어문자/공백 은닉(예: `' javascript:alert(1)'`, `"java\tscript:alert(1)"`), 경로 traversal(`/uploads/../etc/passwd`)이 모두 `''`로 저장됨을 단언한다.
- **빈 값(클리어) 허용**: `attachmentFile:''`(사용자가 × 버튼으로 첨부 제거)는 `''` 그대로 통과함을 단언한다(정상 클리어를 막지 않는다).
- **미전달 필드 불변(DB 비파괴)**: `attachmentFile:'/uploads/a.pdf'`로 생성한 뒤 `service.update(id, { region:'부산' })`(파일 필드 미포함)를 실행하면 기존 `attachmentFile`이 **그대로 보존**됨을 단언한다(검증이 미전달 필드를 건드리지 않음).

### 2) 구현 — `/src/services/articleService.js`

- **모듈 사설 순수 헬퍼**를 파일 상단(`hasEndMarker`/`isStale` 근처)에 추가한다. `clipboardEmbed.js`를 import하지 말고(web 번들) 그 규칙을 서버에서 재현한다. 시그니처 예:

  ```js
  // 첨부/자료 파일 참조 스킴 방어 — /uploads 상대경로 또는 https:// 만 허용.
  // 위험 스킴(javascript:/data:/http:/프로토콜상대//·제어문자·백슬래시 우회)은 빈 문자열로 무력화.
  // clipboardEmbed.isAllowedHref(web)와 동일한 거부 기반 정규화 — 단, 상대경로는 /uploads 접두만 허용(서버 심화방어).
  function sanitizeFileRef(value) { /* return 정상값 | '' */ }
  ```

  허용 판정 규칙(거부 기반 — 정상 URL엔 raw 제어문자·공백·백슬래시·`//`가 없다):
  - `String(value)`로 강제. `''`(빈값)이면 허용(정상 클리어) → `''` 반환.
  - 제어문자·공백(정규식 `/[\x00-\x20]/`) 포함 → 거부.
  - 백슬래시(`\`) 포함 → 거부.
  - `//`로 시작(프로토콜상대) → 거부.
  - `https://`(대소문자 무시, authority 포함 = 슬래시 2개) 이면 허용.
  - 그 외 **스킴 없는 상대경로이고 `/uploads/`로 시작**하면 허용(서버는 /uploads 접두만 신뢰 — 심화 방어). 단, 경로에 `..` 세그먼트(`/../` 포함 또는 `/..`로 끝)가 있으면 거부 — `/uploads/../...` 형태로 접두 검사를 우회하는 경로 traversal을 막는다.
  - 위 어디에도 안 맞으면 거부 → `''` 반환.

- `create`에서 조립한 `contents` 객체 중 **`attachmentFile`/`referenceFile`가 present일 때만** 각 값을 `sanitizeFileRef`로 통과시켜 대체한다. present가 아니면(=`undefined`) 손대지 않는다.
- `update`에서 `pick(fields, CONTENTS_FIELDS)` 결과 중 **present인 `attachmentFile`/`referenceFile`만** `sanitizeFileRef`로 대체한다. 미전달 필드는 절대 추가·변경하지 않는다(모델의 present-only SET과 함께 DB 비파괴 보장).

### 핵심 불변식(반드시 준수)

- `sanitizeFileRef`를 통과하지 못한 값은 **DB에 절대 저장되지 않는다**(거부 시 `''`).
- `/uploads/...` 상대경로와 `https://...` 정상값은 **훼손 없이 그대로 저장**된다.
- **미전달(`undefined`) 파일 필드는 create/update 어느 경로로도 새로 쓰거나 지우지 않는다** — 기존 행 데이터를 절대 파괴하지 않는다(DB 비파괴, ADR-002/SCHEMA.md 11행).
- 마이그레이션·기존 행 일괄 정정·행 삭제를 **하지 않는다** — 이 step은 **신규 저장 요청 경로**만 검증한다.
- `articleService`는 HTTP/transport 비의존을 유지한다(ADR-006) — `sanitizeFileRef`는 순수 함수로 둔다(외부 의존·부수효과 금지).

## Acceptance Criteria

```bash
npm run test   # 신규 파일참조 가드 테스트 + 전체 백엔드 회귀 통과 (node --test)
npm run lint   # ESLint 위반 없음
```

참고: `npm run build`는 web(Vite) 전용 빌드라 이 서버-only 변경에는 불필요하다(실행해도 무해하나 AC 아님).
모든 신규/수정 텍스트는 UTF-8로 저장하라(마커/한글 주석 포함).

## 검증 절차

1. 위 AC 커맨드를 실행한다.
2. 아키텍처 체크리스트를 확인한다:
   - 검증을 **서비스 계층**(articleService)에 두었는가(신뢰 경계=서버, ADR-004/006)? 모델·라우트에 로직을 흩뿌리지 않았는가?
   - `web/src/view/clipboardEmbed.js`를 서버에서 import하지 않았는가(계층/번들 경계 위반 금지)?
   - 미전달 필드를 건드리지 않아 DB 비파괴를 지켰는가? 마이그레이션/행 정정/삭제 코드를 넣지 않았는가?
   - zero-dep(새 npm 의존성 없음)를 지켰는가?
3. 결과에 따라 `phases/28-audit-stabilization/index.json`의 step 0을 업데이트한다:
   - 성공 → `"status": "completed"`, `"summary": "산출물 한 줄 요약(수정 파일·핵심 불변식)"`
   - 수정 3회 시도 후에도 실패 → `"status": "error"`, `"error_message": "구체적 에러 내용"`
   - 사용자 개입 필요 → `"status": "blocked"`, `"blocked_reason": "구체적 사유"` 후 즉시 중단

## 금지사항

- 기존 DB 행을 마이그레이션·일괄 정정·삭제하지 마라. 이유: SCHEMA.md/ADR-002의 DB 비파괴 원칙 — 이 step의 방어는 **신규 저장 요청**만 대상으로 한다(기존 데이터에 소급 적용 금지).
- 미전달(`undefined`) 파일 필드를 `''`로 덮어쓰지 마라. 이유: 파일 필드를 안 보낸 부분 수정(예: 지역만 변경)이 기존 첨부를 지워버리는 데이터 파손이 된다 — present인 필드만 검증·대체한다.
- `web/src/view/clipboardEmbed.js`(또는 web 하위 어떤 모듈)를 서버 코드에서 import하지 마라. 이유: 프론트/백은 별도 번들·계층이라 import가 빌드·경계를 깨뜨린다 — 규칙을 서버 순수 헬퍼로 재현한다.
- 스킴 검증을 정규식 하나(`^https:` 등)로 얕게 하지 마라. 이유: 선행 제어문자/공백·백슬래시·프로토콜상대(`//`)로 위험 스킴이 되살아난다 — 반드시 거부 기반(제어문자·`\`·`//` 선차단)으로 정규화한다.
- 상대경로를 무제한 허용하지 마라(스킴 없으면 전부 통과 금지). 이유: 서버 심화 방어의 취지는 신뢰 가능한 업로드 위치(`/uploads/`)로 좁히는 것이다 — `/uploads/` 접두만 허용한다.
- HTTP 라우트(`server/index.js`)나 모델(`articleModel.js`)에 검증 로직을 넣지 마라. 이유: 저장 규칙은 도메인 로직이라 서비스 계층 소관이다(ADR-006 계층 분리) — 라우트는 얇게 유지한다.
- 새 npm 의존성을 추가하지 마라(zero-dep). 이유: ADR 철학 — URL 파싱 라이브러리 없이 표준 문자열/정규식만 쓴다.
