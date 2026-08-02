# Step 0: lock-token-projection

## 목표

**활성 세션 토큰(`Contents.lockerSessionId`)이 기사 조회 응답으로 전 인증 사용자에게 새는 권한 상승 구멍을 막는다.**

`src/models/articleModel.js`의 `CONTENTS_COLS`에는 `lockerSessionId`가 들어 있고, `query()`/`getById()`는 `SELECT *`로 행 전체를 돌려준다. 그 행이 `GET /api/articles`(server/index.js L468~474)와 `GET /api/articles/:id`(L478~486)에서 그대로 응답 JSON이 된다. 즉 **어떤 기사를 누군가 편집 중이면, 그 편집자의 유효 세션 토큰이 목록 응답에 실려 나간다**. R(기자) 세션으로 목록만 조회하면 D/Z의 토큰을 얻어 `x-session-id: <탈취 토큰>`으로 데스크 권한 행위(송고·강제해제·사용자 관리)를 할 수 있다 — ADR-004의 신뢰 경계가 무력화된다.

수정 방침(원칙 고정):
- **DB 컬럼과 저장 로직은 그대로 둔다.** `lockerSessionId`는 재로그인 takeover 판정(`acquireEditLock`의 `sameUserReLogin`)에 필요하다. DB 비파괴(CLAUDE.md·ADR-002).
- **응답으로 나가는 투영에서만 제거한다.** 라우트마다 `delete row.lockerSessionId`를 반복하면 새 라우트에서 반드시 누락된다 → **단일 chokepoint 한 곳**에서만 제거한다.
- 잠금 표시에 쓰는 `lockYN`·`lockerUserId`·`lockedAt`은 **유지**한다(기존 UI 계약 — `web/src/view/columnConfig.js`의 `lockYN` 컬럼 등).

이 step은 **백엔드 서비스 계층 1개 모듈 + 새 순수 모듈 1개**만 수정한다(+테스트). 모델·컨트롤러·라우트·DB 스키마·web 무접촉.

## 읽어야 할 파일

라인 번호는 실측 힌트 — 반드시 심볼명으로 재확인하라.

- `docs/ADR.md` — **ADR-004**(신뢰 경계=서버, 세션 토큰은 권한 그 자체), **ADR-006**(controllers→services→models→db, 얇은 transport).
- `docs/ARCHITECTURE.md` — "보안 경계" 절, 백엔드 계층 규칙.
- `docs/SCHEMA.md` L42~53 — Contents 잠금 컬럼(`lockYN`/`lockerUserId`/`lockerSessionId`/`lockedAt`) 정의.
- `src/models/articleModel.js` — **전체**. `CONTENTS_COLS`(L7~14), `getById`(L47~52), `query`(L73~140), `searchByText`(L143~148), `setLock`/`clearLock`(L150~160). **이 파일은 수정 대상이 아니다**(아래 금지사항).
- `src/services/articleService.js` — 읽기 경로 `getById`(L139~141)·`query`(L143~145)·`search`(L147~149)가 **수정 대상**. 잠금 판정 경로 `acquireEditLock`(L313~335, **L323에서 `c.lockerSessionId`를 쓴다**)·`releaseEditLock`·`assertLockHolder`·`applyAction`·`syncEmbargoStatus`는 전부 `articleModel.getById`를 **직접** 호출한다 → 투영의 영향을 받지 않는다(반드시 이 사실을 코드로 재확인하고, 확인 후 그 경로들은 손대지 마라).
- `src/controllers/index.js` L130~144 — `article.query/search/getById`가 서비스에 위임만 한다(수정 불필요).
- `server/index.js` — Contents 행이 응답에 실리는 지점: L460~466(`/api/articles/search`), L468~474(`/api/articles`), L478~486(`/api/articles/:id`), L579~590(`/:id/translate`는 본문 텍스트만 사용). 다른 라우트가 Contents 행을 싣는지 **직접 grep으로 재확인**하라(`controllers.article.` 호출부 전수).
- `src/services/spoolWriter.js` — 외부 반출 필드 allowlist 투영의 **선례**(phase 47 step0). 같은 규율을 응답 투영에 적용한다.
- `test/server.test.js` L25~57 — HTTP 테스트 하네스(`start()`/`api(base, method, path, { sid, body, clientId })`/`seedUser`/`login`). 이 step의 전수 단언 테스트가 그대로 재사용할 형태다.
- `test/editLock.test.js` — 잠금 계약 회귀 기준(특히 L36의 "잠근 세션 비노출" 단언, L47~56 재로그인 takeover).
- `test/articleModel.test.js` L155~175 — 모델은 여전히 잠금 컬럼을 돌려줘야 한다는 기존 단언.

## 배경 (자기완결)

- 세션 토큰은 `sessionService`가 발급한 무작위 문자열이며, 서버는 쿠키(`sid`) 또는 `x-session-id` 헤더로 이 값을 받아 **그 자체를 신원**으로 취급한다(server/index.js `readSessionToken`/`sessionOf`). 토큰 = 권한이다.
- 편집 잠금을 획득하면(`POST /api/articles/:id/lock`) 라우트가 `acquireEditLock(id, { userId: me.userId, sessionId: sid, clientId })`를 부르고, 모델이 `Contents.lockerSessionId`에 **그 세션 토큰 원문**을 저장한다.
- `lockerClientId`도 함께 제거 대상이다. 이유: 저장 인가(`assertLockHolder`)가 클라이언트가 보낸 `x-edit-client` 문자열과 `lockerClientId`를 비교하는데, 그 값이 응답에 실리면 **누구나 남의 편집 탭을 사칭할 재료**를 얻는다(step1이 세션 대조를 추가하지만, 위조 재료 자체를 응답에서 없애는 것이 방어의 1선이다). web에서 이 키를 참조하는 곳은 **`web/src/test/fakeModel.js`(테스트용 가짜 서버)와 `web/src/view/WriterPage.test.jsx`(L2505 주석·L2553 픽스처) 둘뿐이며 모두 테스트 경로다** — 프로덕션 뷰/컨트롤러 참조는 0건이므로 응답에서 빼도 UI 계약이 깨지지 않는다. **작업 전 `grep -rn "lockerClientId\|lockerSessionId" web/src`로 직접 재확인하고, 결과가 위 2파일뿐인지 확인하라**(다른 파일이 나오면 그 참조를 서버 파생 값으로 대체하는 것이 선행 작업이다).

## 작업

### 1) 순수 투영 모듈 신설

새 파일(예: `src/services/contentsProjection.js`) — 이름은 재량이나 도메인 서비스 계층에 두고 DB/HTTP/시계에 의존하지 않는 **순수 모듈**이어야 한다.

```js
// 응답으로 나가면 안 되는 Contents 컬럼(단일 출처). 값이 곧 인증 자격이거나 위조 재료인 것만 담는다.
export const PRIVATE_CONTENTS_COLS = Object.freeze(['lockerSessionId', 'lockerClientId']);

// Contents 행 → 클라이언트로 내보낼 안전한 사본. 원본은 변형하지 않는다.
export function toPublicContents(contents);
```

규칙:
- **원본 객체를 mutate하지 마라**(`delete row.x` 금지). 이유: 같은 행 객체가 잠금 판정·후속 로직에서 재사용될 수 있고, 조용한 상태 오염은 재현이 어렵다. 항상 새 객체를 만들어 반환한다.
- 입력이 `null`/`undefined`/비객체면 입력을 그대로 돌려준다(방어 — 투영이 호출자를 깨뜨리지 않는다).
- 제거 대상은 `PRIVATE_CONTENTS_COLS` **한 곳**에서만 정의한다(리터럴 복제 금지).

### 2) articleService 읽기 경로에 투영 적용

- `getById(articleId)` → `{ article, contents: toPublicContents(contents) }`. `null` 반환 계약(행 없음)은 그대로.
- `query(filters)` → 각 행에 투영 적용한 배열.
- `search(q)` → Article 행이라 잠금 컬럼이 없다(스키마 확인). 투영 적용은 재량이되, **AC의 전수 단언에는 반드시 포함**한다.
- 파일 상단/함수 위 주석에 "여기가 Contents 행이 응답으로 나가는 단일 투영 지점이다 — 라우트에서 개별 삭제 금지"를 명시한다.

### 3) 내부 판정 경로 무변경 확인

`acquireEditLock`/`releaseEditLock`/`assertLockHolder`/`applyAction`/`syncEmbargoStatus`/`deriveArticle`은 `articleModel.getById`를 직접 부른다 → **코드 변경 없음**. 변경했다면 잠금 takeover 판정이 깨진다. `git diff`로 이 함수들이 손대지지 않았음을 확인하라.

## TDD — 테스트 먼저

### (a) 순수 모듈 단위 테스트 (새 파일, 예 `test/contentsProjection.test.js`)

1. **골든 키 목록**: Contents 전 컬럼을 채운 행을 투영하면, 결과 키 집합이 **`[전 컬럼] - PRIVATE_CONTENTS_COLS`** 와 정확히 일치한다(`Object.keys(...).sort()` deepEqual).
   - **컬럼 목록의 출처는 DB 스키마여야 한다**: `createSchema(new DatabaseSync(':memory:'))` 후 `PRAGMA table_info(Contents)`로 컬럼명을 도출하라(`test/schema.test.js` L6~7의 `columns(db, table)` 헬퍼와 동형). 컬럼명을 테스트에 **리터럴로 하드코딩하지 마라** — 하드코딩하면 새 컬럼이 추가돼도 테스트가 통과해 "새 비밀 컬럼이 조용히 노출"되는 것을 못 잡는다(이 테스트의 존재 이유가 사라진다).
2. `lockYN`·`lockerUserId`·`lockedAt`·`status`·`internalComment` 등 기존 필드는 값까지 보존된다.
3. 원본 객체는 변형되지 않는다(투영 후 원본에 `lockerSessionId`가 남아 있다).
4. `null`/`undefined`/문자열 입력에 throw하지 않는다.

### (b) 서비스 계층 테스트 (`test/articleService.test.js` 또는 editLock 테스트에 추가)

5. 잠금 획득 후 `service.getById(id).contents`와 `service.query({})[0]`에 `lockerSessionId`·`lockerClientId`가 **없다**. 같은 시점 `articleModel.getById(id).contents`에는 **있다**(모델 무변경 = 잠금 판정 보존).
6. 잠금 획득 → 같은 사용자 다른 세션 재로그인 takeover(`editLock.test.js` L47~56 시나리오)가 그대로 성공한다.

### (c) 전수 노출 단언 (핵심, 새 파일 예 `test/response-secrets.test.js`)

`test/server.test.js`의 하네스(`start`/`seedUser`/`login`/`api`)를 그대로 본떠서:

- 사용자 2명(D `desk1`, R `rep1`) 시드 → 둘 다 로그인해 세션 토큰 2개를 확보.
- D 세션 + `x-edit-client: tab-d`로 기사 1건 생성·잠금 획득 → `Contents.lockerSessionId`에 D의 실토큰이 저장된 상태를 만든다(DB에서 직접 확인해 픽스처가 진짜인지 단언).
- **R 세션으로** 아래 라우트를 전부 호출하고, 각 응답에 대해 `JSON.stringify(body)`가
  (i) D의 세션 토큰 문자열을 포함하지 않고, (ii) `"lockerSessionId"`·`"lockerClientId"` 키 이름도 포함하지 않음을 단언한다:
  - `GET /api/articles`
  - `GET /api/articles/:id`
  - `GET /api/articles/search?q=...`
  - `GET /api/articles/:id/history`
  - `GET /api/articles/:id/history/:historyId`
  - `POST /api/articles` (신규 저장)
  - `POST /api/articles/:id/action` (거부 응답 포함)
  - `POST /api/articles/:id/derive`
  - `POST /api/articles/:id/lock` / `/unlock` / `/force-unlock`
  - `PUT /api/articles/:id`
  - `POST /api/articles/:id/translate`
  - `POST /api/distribution/tick` (스풀 미설정 → `spool-disabled`여도 호출해 응답을 검사)
  라우트 목록은 **배열로 선언하고 루프**로 단언해, 라우트가 추가될 때 목록에 넣는 것을 잊지 않도록 실패 메시지에 경로를 담아라.
- `GET /api/stream`(SSE)은 행 데이터 없는 무효화 신호라 대상이 아니다(ADR-005) — 테스트 주석에 이유를 남긴다.
- 정상 계약 회귀: `GET /api/articles` 응답 행에 `lockYN === 'Y'`, `lockerUserId === 'desk1'`, `lockedAt`이 **존재**한다(잠금 표시 UI 계약 보존).

각 케이스는 **구현 전에 red**를 확인하고(특히 (c)의 목록·상세 라우트) 구현 후 green으로 만든다.

## Acceptance Criteria

```bash
node --test test/contentsProjection.test.js test/response-secrets.test.js test/articleService.test.js test/editLock.test.js test/server.test.js test/articleModel.test.js
npm test                 # tests 636+N / fail 0  (기준선 636/636 green 유지)
npm run lint
# 프로덕션 코드 참조 0건 — 테스트 경로(fakeModel.js·*.test.jsx)를 제외하면 출력이 비어 있어야 한다(빈 출력 = 통과)
grep -rn "lockerSessionId\|lockerClientId" web/src --include=*.js --include=*.jsx \
  | grep -v "web/src/test/" | grep -v "\.test\."
git diff --name-only      # web/ 변경 0건
```

## 검증 절차

1. 위 AC 커맨드를 실행한다. `npm test` 요약의 **fail은 반드시 0**.
2. 변이 검증(구현이 진짜 잠겼는지):
   - `articleService.query`의 투영을 제거하면 (c)의 `GET /api/articles` 케이스가 red가 되는가?
   - `PRIVATE_CONTENTS_COLS`에서 `lockerClientId`를 빼면 (a)-1 골든 키 테스트가 red가 되는가?
3. 아키텍처 체크리스트:
   - 투영은 **한 곳**에서만 일어나는가(`grep -rn "lockerSessionId" server/ src/`로 라우트/컨트롤러에 개별 삭제 코드가 없는지 확인)?
   - 모델(`articleModel.js`)과 스키마(`db/schema.js`)는 무변경인가(`git diff --name-only`)?
   - DB 비파괴: 행 삭제·컬럼 DROP·백필·일괄 UPDATE 0건인가?
4. `phases/51-security-hotfix/index.json`의 step0을 `completed`/`error`/`blocked`로 갱신하고 `summary`(또는 `error_message`/`blocked_reason`)를 기록한다.

## 금지사항

- `src/models/articleModel.js`의 `CONTENTS_COLS`에서 `lockerSessionId`/`lockerClientId`를 빼거나 `SELECT *`를 컬럼 나열로 바꾸지 마라. 이유: 모델은 잠금 판정(`acquireEditLock`의 `sameUserReLogin`)과 저장 경로가 쓰는 원본 행의 단일 출처다 — 여기서 지우면 takeover 판정이 조용히 깨진다.
- DB 컬럼 DROP·마이그레이션·기존 행 UPDATE(잠금 컬럼 비우기)를 하지 마라. 이유: DB 비파괴 원칙(CLAUDE.md·ADR-002)이며, 운영 중인 잠금이 무효화되면 편집자가 저장을 잃는다.
- 라우트(`server/index.js`)나 컨트롤러에서 `delete row.lockerSessionId` 식으로 개별 제거하지 마라. 이유: 새 라우트가 추가될 때마다 반드시 누락된다(이 결함의 원인 자체가 라우트별 처리 부재다).
- `lockYN`·`lockerUserId`·`lockedAt`을 응답에서 함께 제거하지 마라. 이유: 목록 컬럼(`web/src/view/columnConfig.js`의 `lockYN`)과 컨텍스트 메뉴 잠금 판정(`web/src/view/ContextMenu.jsx`)이 쓰는 기존 계약이 깨진다.
- 세션 토큰을 해시·마스킹·prefix 등 **다른 형태로 파생해 응답에 담지 마라**. 이유: 부분 노출도 대조·추측 공격 표면이며, 클라이언트는 이 값이 전혀 필요 없다.
- web/·`assertLockHolder` 판정 로직을 건드리지 마라. 이유: 저장 인가 수정은 step1의 범위다(같은 파일의 다른 함수 — 동시 수정은 실패 원인 격리를 막는다).
- 기존 테스트를 삭제하거나 단언을 약화하지 마라(기준선: backend 636/636 green, lint clean).
