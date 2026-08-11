# Step 0: spa-static

## 목표

Express가 **Vite 빌드 산출물(SPA)을 같은 출처에서 서빙**하게 한다. 두 가지를 추가한다.

1. 정적 서빙 — `<spaDir>/assets/*`, `<spaDir>/index.html` 등 빌드 산출물을 그대로 내려준다.
2. SPA 폴백 — `/list.do`, `/writer.do?articleId=X` 같은 **비-API 내비게이션 GET**에 `index.html`을 내려줘 클라이언트 라우터가 처리하게 한다.

**단 서빙은 opt-in이다.** `spaDir`를 주입하지 않거나 그 안에 `index.html`이 없으면 앱은 지금과 **완전히 동일하게** 동작해야 한다(기존 백엔드 테스트 1015건 무영향).

수정 대상은 `server/index.js` 하나뿐이다. `src/**`·`web/**`·`docs/**`는 무수정이다.

## 읽어야 할 파일

먼저 아래를 읽고 설계 의도를 파악하라.

- `docs/ARCHITECTURE.md` — 개요(3~7행), 패턴(32~35행: 얇은 transport), 보안 경계(73~80행).
- `docs/ADR.md` — **ADR-001**(10~13행: SPA + 독립 Express, 두 origin), **ADR-006**(35~38행: 얇은 transport + 주입), **ADR-009**(50~54행). 특히 ADR-009의 "가정과 실패 모드"에 있는 다음 문장을 확인하라: *"이 결정은 **동일 출처 배포를 전제**한다 … 앱 자체는 SPA 번들을 서빙하지 않는다 — `express.static`은 `/uploads` 하나뿐이다."* — 이 step은 그 전제를 앱 안에서 실현하는 작업이라 그 문장이 거짓이 된다. **이 step에서는 읽기 전용·무접촉이다** — 문장 정정은 step2 소관이며 정정문은 `phases/60-same-origin-serving/index.json`의 `adr_correction`에 확정돼 있다.
- `docs/news.md` 39행 — *"페이지 URL(.do)은 SPA 라우팅으로 처리한다. 브라우저 뒤로/앞으로 가기를 지원하며, 정의되지 않은 경로는 로그인 페이지로 이동한다."* **읽기 전용·무접촉.** 이 규칙은 서버가 아니라 SPA가 지킨다(아래 `web/src/app/routing.js` 참조).
- `server/index.js` — 이 step이 단독 소유한다. 최소한 다음 지점을 읽어라.
  - 319~327행: `createApp({ controllers, env, cookieSecure, forceHttps, uploadDir, logService, origins })` 시그니처와 **주입 seam 주석 규율**.
  - 342~361행: helmet CSP 디렉티브(`defaultSrc`/`scriptSrc`/`styleSrc`/`connectSrc`/`frameSrc`).
  - 399~416행: 요청 로거 → `csrfOriginGuard` → `app.use('/uploads', express.static(uploadDir))` 등록 순서와 그 근거 주석.
  - 459~460행(`/api/health`)부터 1057행(`/api/logs/stream` 끝)까지: 라우트 그룹 전체 범위.
  - 1059~1067행: 전역 에러 핸들러(4-arg, 마지막 등록) 그리고 `return app;`.
  - 1070~1128행: `bootstrap()` — 테스트가 `createApp`을 import할 때는 실행되지 않는다(`import.meta.url === argv[1]` 가드, 1130~1132행).
- `web/vite.config.js`(전문 22행) — dev 프록시(`/api`·`/uploads` → `127.0.0.1:3001`)와 그 근거 주석. **무수정**. 16~19행 주석이 이미 *"빌드 서빙에서는 백엔드 동일 출처라 무관"* 이라고 이 phase의 배치를 전제하고 있다.
- `web/src/app/routing.js` 7~22행 — `ROUTES = ['login.do','writer.do','list.do','rcvMgmt.do','userMgmt.do','logs.do','distMgmt.do']`, `parseLocation`이 정의되지 않은 경로를 `login.do`로 떨어뜨린다. **무수정** — 서버는 이 목록을 알 필요가 없다(폴백은 경로 목록이 아니라 "API가 아닌 내비게이션"으로 판정한다).
- `test/upload.test.js` 1~45행 — **주입 + 임시 디렉터리 테스트 전례**(`fs.mkdtempSync(path.join(os.tmpdir(), 'upload-test-'))` → `createApp({ controllers, sessionService, uploadDir })` → `app.listen(0)`). 이 step의 테스트는 이 패턴을 그대로 따른다.
- `test/distribution-targets-api.test.js` 300~310행 — *"핸들러 미등록 → Express 기본 404(JSON 응답 계약이 아니다)"* 를 잠그는 테스트. **이 계약을 깨면 안 된다.**
- `test/server.test.js` 24~56행 — `start()`/`api()` 헬퍼 형태(신규 테스트의 스타일 기준).
- `phases/60-same-origin-serving/index.json`의 `decisions` (1)~(7)·(10)과 `excluded`.

## 배경 (자기완결 — 이전 대화 참조 없음)

현재 배치는 **두 출처**다. SPA는 Vite dev 서버(`:5173`)가 서빙하고 API는 Express(`127.0.0.1:3001`)가 담당하며, dev에서는 Vite 프록시가 `/api`·`/uploads`를 3001로 넘겨 "같은 출처처럼" 보이게 한다. 배포 시에는 리버스 프록시가 그 역할을 하도록 ADR-009가 전제만 해 두었고, 앱은 SPA 번들을 서빙하지 않는다.

이 phase는 그 전제를 앱 안에서 실현한다. 그러면 쿠키(SameSite)·SSE(EventSource가 헤더를 못 보냄)·CSRF 자기 출처 판정이 전부 자연스럽게 풀리고, 후속 phase(단일 exe 서버 배포 / Electron 접속 클라이언트)가 별도 웹서버 없이 성립한다.

**빌드 산출물의 실제 형태(2026-08-11 실측)**

`npm run build`(= `vite build web`)는 `web/dist/`를 만든다.

```
web/dist/index.html
web/dist/assets/index-<hash>.js
web/dist/assets/index-<hash>.css
```

`web/dist/index.html` 본문:

```html
<!doctype html>
<html lang="ko">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>기사 작성기</title>
    <script type="module" crossorigin src="/assets/index-<hash>.js"></script>
    <link rel="stylesheet" crossorigin href="/assets/index-<hash>.css">
  </head>
  <body><div id="root"></div></body>
</html>
```

즉 **인라인 스크립트가 없고 자산 참조가 전부 동일 출처 절대 경로**다. 그래서 helmet의 현행 CSP(`script-src 'self'`, `style-src 'self' 'unsafe-inline'`, `connect-src 'self'`)로 그대로 로딩된다 — **CSP는 한 글자도 바꾸지 않는다**(웹 소스에 `eval`/`new Function`/Worker/blob URL/외부 폰트·CSS import 사용처가 0인 것도 확인됐다).

**`web/dist`는 커밋하지 않는다**(`.gitignore`에 `dist/`·`web/dist/`). 그런데 로컬 작업 트리에는 이미 빌드 산출물이 존재할 수 있다. 그래서 **`createApp`의 `spaDir` 기본값은 "비활성"이어야 한다** — 기본값을 `web/dist`로 두면 기존 1015건 테스트의 미정의 경로 동작이 "그 머신에서 빌드했는가"에 따라 달라진다(비결정적 회귀). `web/dist` 기본값은 step1이 아니라 **다음 step이 아니라 이 step의 `bootstrap()` 결선**에서 준다(아래 작업 3).

**폴백이 절대 건드리면 안 되는 것**

- `/api/**` 전체 — 인증 401·인가 403·404·SSE(`/api/stream`, `/api/logs/stream`) 응답이 HTML로 바뀌면 클라이언트 계약이 통째로 깨진다.
- `/uploads/**` — 없는 파일은 404여야 한다(`express.static`은 미스 시 `next()`로 흘린다).
- 비-GET 메서드 — 폴백은 GET/HEAD만이다.
- CSRF 가드(`csrfOriginGuard`, 비-GET 대상) 동작 — 정적/폴백은 GET 전용이라 무간섭이다.

## TDD — 테스트 먼저

신규 파일 `test/spa-serving.test.js`를 만든다(**기존 테스트 파일 무수정**). `test/upload.test.js`처럼 `os.tmpdir()` 아래 가짜 dist를 만들어 주입한다.

```js
// 가짜 dist 픽스처 예시 — 실제 vite 산출물과 같은 구조.
//   <tmp>/index.html                (본문에 식별 가능한 표식 문자열 포함)
//   <tmp>/assets/app-abc123.js      (본문에 식별 가능한 표식 포함)
```

아래 케이스를 모두 작성한다(번호는 검증 절차에서 참조한다).

**A. 순수 판정 함수 (HTTP 없이)**

1. `isSpaFallbackRequest`: `{ method:'GET', path:'/list.do', accept:'text/html,application/xhtml+xml,*/*;q=0.8' }` → `true`. `writer.do`·`/`·`/login.do`·`/unknown/deep/path`도 `true`.
2. 메서드 게이트: 같은 경로·Accept라도 `POST`·`PUT`·`DELETE`·`OPTIONS`는 `false`. `HEAD`는 `true`.
3. 접두사 게이트: `/api`, `/api/`, `/api/health`, `/api/stream`, `/uploads`, `/uploads/x.png`는 전부 `false`. **대소문자 무관**임을 함께 잠근다 — `/API/health`, `/Api/unknown`, `/UPLOADS/x.png`도 `false`(Express 라우팅이 기본 case-insensitive라 대문자 경로도 API 네임스페이스다). 반면 **`/apidocs`·`/uploadsomething`처럼 접두사가 단어 경계에서 끊기지 않는 경로는 `true`**(정확 일치 또는 `/` 하위만 제외한다는 규칙의 잠금).
4. Accept 게이트: `accept: '*/*'`·`'application/json'`·`undefined`·`''` → `false`. `'text/html'` 포함이면 `true`.

**B. 서빙 활성 (가짜 dist 주입)**

5. `GET /` → 200, 본문이 픽스처 `index.html`이고 `content-type`이 `text/html`.
6. `GET /assets/app-abc123.js` → 200, 본문이 픽스처 JS, `content-type`에 `javascript` 포함.
7. `GET /list.do`(Accept: text/html) → 200, 본문이 `index.html`(SPA 폴백).
8. `GET /writer.do?articleId=A1`(Accept: text/html) → 200, 본문이 `index.html`(쿼리스트링 무관).
9. `HEAD /list.do`(Accept: text/html) → 200, 본문 없음.

**C. 경계 — 폴백이 절대 먹으면 안 되는 곳 (전부 Accept: text/html을 명시해 "브라우저인 척" 요청한다)**

10. `GET /api/health` → 200 JSON `{ok:true}`(정적/폴백이 API를 가리지 않는다).
11. `GET /api/articles` 미인증 → **401 JSON** `{ok:false, reason:'unauthenticated'}`(HTML 아님).
12. `GET /api/stream` 미인증 → **401 JSON**(SSE 라우트 무손상).
13. `GET /api/unknown-path` → **404**이고 본문이 `index.html`이 **아니다**.
14. `GET /uploads/missing.png` → **404**이고 본문이 `index.html`이 **아니다**.
15. `POST /list.do`(Accept: text/html) → **404**(비-GET은 폴백 대상 아님). 응답이 `index.html`이 아니어야 한다.
16. `GET /assets/does-not-exist.js`(Accept: `*/*`) → **404**, 본문이 `index.html`이 아니다(해시 어긋난 자산이 HTML 200으로 응답되는 함정 차단).
17. **경로 탈출 금지**: `/../package.json`, `/..%2f..%2fpackage.json`, `/%2e%2e/news.db` 류를 요청해 **응답 본문에 정적 루트 밖 파일의 내용이 없음**을 단언한다(`"name": "article-production-system"`·`"article-production-system"` 문자열, SQLite 헤더 `SQLite format 3` 등).
    - **반드시 `node:http.request({ host, port, path })`로 원시 경로를 그대로 보내라.** `fetch`는 클라이언트가 URL을 정규화해 `..`를 미리 없애므로 서버 방어를 전혀 검증하지 못한다(무의미한 green).
    - **기대값은 200 + `index.html`이다.** `express.static`은 탈출 시도를 거부하고 `next()`로 흘리며(fallthrough), 그 뒤 폴백이 Accept: text/html 요청에 `index.html`을 준다 — 이것이 정상 동작이다. **상태 코드를 단언하지 마라**(403/404를 기대하면 구현이 아니라 기대가 틀린 것이다). 이 케이스의 계약은 오직 "루트 밖 파일 내용이 응답에 실리지 않는다"이다.
18. **CSRF 무간섭**: 활성 상태에서 `POST /api/logout`에 `Origin: https://evil.example`를 붙이면 여전히 **403 `forbidden-origin`**이다.

**D. 비활성 (현행 동작 완전 동일)**

19. `spaDir` 미주입 → `GET /list.do`(Accept: text/html) → **404**, `GET /` → **404**, `GET /assets/app-abc123.js` → **404**.
20. `spaDir`를 **빈 임시 디렉터리**(index.html 없음)로 주입 → 위 셋 전부 **404**이며 **500이 아니다**(존재 게이트가 없으면 ENOENT가 500으로 뒤집힌다 — 이 케이스가 그 회귀를 잡는다).
21. `spaDir`를 **존재하지 않는 경로** 문자열로 주입 → 마찬가지로 404, 500 없음, throw 없음.

**E. 실제 빌드 산출물 스모크 (조건부 skip)**

22. `web/dist/index.html`이 존재할 때만 실행되는 테스트(`test('...', { skip: !fs.existsSync(...) }, ...)`)를 1건 둔다. 실제 `web/dist`를 `spaDir`로 주입하고:
    - `GET /login.do`(Accept: text/html) → 200이고 본문이 `web/dist/index.html`과 동일하다.
    - 그 HTML에서 **정규식으로 `<script ... src="...">`의 src를 추출**해(해시를 하드코딩하지 마라) 그 경로를 GET → 200이고 `content-type`에 `javascript`가 포함된다.
    - **CSP 호환 잠금**: 응답 헤더 `content-security-policy`에 `script-src 'self'`가 포함되고, `index.html`에 **내용이 있는 인라인 `<script>`가 0개**이며 모든 `src`/`href`가 `/`로 시작하는 동일 출처 절대 경로다(외부 도메인·`data:` 스크립트 0). 이 단언이 red가 되면 CSP를 완화할 게 아니라 빌드 설정을 의심해야 한다.

## 작업

### `server/index.js` — 1) 순수 판정 함수 + 루트 해석기 (export)

이 파일의 house style대로 **주입 가능한 순수 함수를 export**하고 근거 주석을 단다(`allowedOrigins`·`csrfOriginGuard`·`logOriginDiagnostics` 전례).

```js
// SPA 폴백에서 제외하는 예약 접두사 — 정확히 일치하거나 그 하위 경로만 제외한다.
// ('/apidocs' 같은 경로는 제외 대상이 아니다 — 접두사 문자열 비교만 하면 오제외된다.)
// 비교는 소문자화한 경로로 한다 — Express 라우팅이 기본 case-insensitive라 '/API/...'도 API
// 네임스페이스다. 대소문자를 구분하면 매칭 라우트가 없는 '/API/unknown'이 HTML을 받는다.
const SPA_EXCLUDED_PREFIXES = ['/api', '/uploads'];

// 이 요청에 index.html을 돌려줘야 하는가(= 브라우저 내비게이션인가).
// 순수 함수 — req 객체가 아니라 값 3개만 받는다(테스트가 HTTP 없이 규칙을 잠글 수 있게).
export function isSpaFallbackRequest({ method, path, accept } = {}) { /* ... */ }

// spaDir → 서빙 루트 절대 경로. 비활성(미주입/빈 값/index.html 부재)이면 undefined.
// CRITICAL: 판정 기준은 디렉토리가 아니라 <dir>/index.html 파일이다 — 파일이 없는데 폴백을 켜면
//   미정의 GET마다 sendFile ENOENT가 전역 에러 핸들러로 흘러 404가 500으로 뒤집힌다.
export function resolveSpaRoot(spaDir) { /* ... */ }
```

규칙:

- `isSpaFallbackRequest`는 `method`가 `GET`/`HEAD`가 아니면 `false`, **소문자화한** `path`가 예약 접두사(정확 일치 또는 `<접두사>/` 시작)에 걸리면 `false`, `accept`가 문자열이 아니거나 `text/html`을 포함하지 않으면 `false`, 나머지는 `true`.
- `resolveSpaRoot`는 문자열이 아니거나 트림 결과가 비면 `undefined`, 아니면 절대 경로로 정규화(`nodePath.resolve`)한 뒤 `<root>/index.html` 존재를 `fs.existsSync`로 확인해 있으면 그 절대 경로를, 없으면 `undefined`를 돌려준다. **throw 하지 않는다.**
- 존재 확인은 **createApp 호출 시 1회**다(요청마다 stat 금지 — 근거는 index.json `decisions` (2)).

### `server/index.js` — 2) `createApp`에 `spaDir` 주입 + 마운트

- 시그니처에 `spaDir` 파라미터를 추가한다. **기본값은 주지 마라**(= `undefined` = 비활성). 파일 상단의 파라미터 주석 블록(307~318행 스타일)에 근거를 한두 줄 남긴다: 기본값을 `web/dist`로 두면 로컬 빌드 산출물 유무에 따라 기존 테스트의 404 동작이 달라진다.
- 마운트 지점은 **마지막 라우트(`/api/logs/stream`) 다음, 전역 에러 핸들러(4-arg) 앞**이다. 그래야 API 라우트가 항상 먼저 매칭되어 "정적/폴백이 API를 가릴 수 없음"이 구조적으로 보장된다.

```js
// --- SPA 동일 출처 서빙 (opt-in) ---
// 등록 위치: 모든 /api 라우트 뒤 · 전역 에러 핸들러 앞. 라우트가 먼저 매칭되므로 API를 가릴 수 없다.
// 요청 로거·csrfOriginGuard보다 뒤라 액세스 로그와 CSRF 계약은 그대로다(정적/폴백은 GET/HEAD 전용).
const spaRoot = resolveSpaRoot(spaDir);
if (spaRoot) {
  app.use(express.static(spaRoot));           // /assets/* 등 실제 파일. 미스는 next()로 흘린다.
  app.use((req, res, next) => { /* isSpaFallbackRequest → res.sendFile(index.html) : next() */ });
}
```

- `res.sendFile`은 **절대 경로**를 요구한다(`nodePath.join(spaRoot, 'index.html')`). 콜백 에러는 삼키지 말고 `next(err)`로 넘겨 전역 에러 핸들러가 처리하게 한다(부트 이후 dist가 지워진 비정상 상황이 조용한 무응답으로 남지 않게).
- 캐시·압축 옵션을 넣지 마라(기본값 유지 — `decisions` (7)).

### `server/index.js` — 3) `bootstrap()` 결선

`createApp(...)` 호출에 `spaDir`를 넘긴다. **기본값은 여기서만** 준다.

```js
// SPA 정적 루트 — SPA_DIR 미설정 시 이 모듈 기준 ../web/dist(=vite build 산출물).
// 명시적으로 빈 값(SPA_DIR=)이면 비활성이다(dev에서 Vite :5173만 쓸 때의 off 스위치).
// cwd가 아니라 모듈 위치 기준으로 푼다 — 어느 디렉토리에서 실행해도 같은 곳을 본다.
export function resolveSpaDir(env = process.env, baseDir = <이 모듈의 디렉토리>) { /* ... */ }
```

- `env.SPA_DIR`가 **정의돼 있고 트림 결과가 비어 있지 않으면** 그 값을 쓴다(상대 경로면 `nodePath.resolve`로 절대화).
- `env.SPA_DIR`가 **정의돼 있고 트림 결과가 빈 문자열이면 `undefined`**(명시적 off).
- 정의돼 있지 않으면 `nodePath.join(baseDir, '..', 'web', 'dist')`.
- `baseDir` 기본값은 이 모듈의 디렉토리(`nodePath.dirname(fileURLToPath(import.meta.url))` 등)로 하되, **인자로 주입 가능하게** 둬서 테스트가 임시 디렉터리를 기준으로 검증할 수 있게 한다.
- 부트 로그는 **활성일 때만** INFO 1줄(예: `serving SPA from <경로>`). 비활성일 때는 남기지 마라(대부분의 dev 부트가 비활성이라 매번 남기면 Z 전용 10000줄 링 버퍼에 소음이 쌓인다 — `logOriginDiagnostics`·`runHistoryTitleBackfill`과 같은 규율). 경로 문자열은 비밀이 아니므로 그대로 남겨도 된다.
- `bootstrap()`의 다른 줄(스키마·백필·watcher·listen)은 건드리지 마라. **listen 주소는 이 step에서 손대지 않는다 — step1 소관이다.**

## Acceptance Criteria

```bash
npm test          # 실패 0 — 기준선 1015 + 신규 케이스(22건 이상)
npm run lint      # 통과
npm run build     # 통과 (web/dist 생성 — 케이스 22의 조건부 스모크가 실제로 실행되게)
```

**빌드 전/후 양쪽 확인**: 이 step의 핵심 계약은 "빌드 여부와 무관하게 결정적"이므로 `web/dist`가 **있을 때**와 **없을 때** 모두 `npm test`가 green이어야 한다.

- 있을 때: `npm run build && npm test` — 케이스 22가 skip 없이 실행된다.
- 없을 때: `web/dist`를 지우고 `npm test` — 케이스 22는 skip, 나머지는 동일하게 green.
- **`web/dist` 삭제는 허용된다**(빌드 산출물이고 `.gitignore` 대상이라 언제든 `npm run build`로 재생성된다). Git Bash 기준 `rm -rf web/dist`, PowerShell 기준 `Remove-Item -Recurse -Force web\dist`.
- 삭제가 곤란한 상황(다른 세션이 dev 서버를 물고 있는 등)이면 이 확인은 **선택 항목**으로 두고 summary에 skip 사유를 남겨라. 단 "있을 때" 확인은 필수다.

**diff scope**: 시작 시점 `git status --porcelain` 스냅샷 대비 증분이 `server/index.js`, `test/spa-serving.test.js` **2개**(+ 진행 기록 `phases/60-same-origin-serving/index.json`)뿐. `src/**`·`web/**`(빌드 산출물 `web/dist/**`는 .gitignore라 증분에 잡히지 않는다)·`docs/**`·`README.md`·`.env.example` 증분 0.

**추가 확인(porcelain 증분이 못 잡는 구멍)**: `phases/index.json`은 계획 단계에서 이미 `M` 상태라 증분 판정에 걸리지 않는다. 이 step은 그 파일을 건드리지 않는다 — `git diff phases/index.json`으로 60 항목이 여전히 `pending`이고 그 외 변경이 없는지 직접 확인하라.

## 검증 절차

1. 위 AC 커맨드를 실행한다(`web/dist` 있는 상태 1회 필수, 지운 상태 1회 — 케이스 22 실행/skip 양쪽 green. 삭제가 곤란하면 후자는 선택이며 사유를 summary에 남긴다).
2. **기존 스위트 무수정 green 확인**(계약 무회귀의 증거): `test/server.test.js` · `test/csrf-origin.test.js` · `test/sse-auth.test.js` · `test/sse-reauth.test.js` · `test/upload.test.js` · `test/distribution-targets-api.test.js` · `test/logs-api.test.js` · `test/server-logging.test.js`.
3. 변이 검증 7종(확인 후 반드시 원복):
   - `isSpaFallbackRequest`의 Accept 조건을 제거 → 케이스 4·16이 red.
   - 예약 접두사에서 `'/uploads'`를 제거 → 케이스 14가 red.
   - 예약 접두사 비교를 단순 `startsWith`로 바꿔 경계 검사를 없앰 → 케이스 3이 red(`/apidocs` 오제외).
   - 경로 소문자화(`toLowerCase`)를 제거 → 케이스 3이 red(`/API/health`가 폴백 대상이 된다).
   - 메서드 게이트를 제거 → 케이스 15가 red.
   - `resolveSpaRoot`의 `index.html` 존재 확인을 디렉토리 존재 확인으로 바꿈 → 케이스 20이 red(404가 500으로 뒤집힌다).
   - 마운트 위치를 라우트보다 **앞**(예: `/uploads` static 옆)으로 옮김 → 케이스 13(`/api/unknown-path`)이나 11이 red가 되는지 확인하라. **red가 나지 않더라도 원위치로 되돌려라** — 위치 규칙의 근거는 "구조적 보장"이지 "테스트가 잡아준다"가 아니다.
4. `bootstrap()` 결선은 테스트가 실행하지 않는다(`import.meta.url` 가드) — `git diff`로 **눈으로** 확인하라: `createApp(...)` 호출에 `spaDir`가 실제로 전달되는가, 기본 경로가 모듈 기준인가, 활성일 때만 로그를 남기는가.
5. 실기 스모크(가능하면 수행하고 결과를 summary에 기록, 실패해도 AC는 아니다): `npm run build` 후 `npm run server`를 띄우고 `http://127.0.0.1:3001/login.do`를 브라우저나 curl로 열어 (a) HTML 200, (b) `/assets/*` 200, (c) `/api/health` JSON 200, (d) 브라우저 콘솔에 CSP 위반 0을 확인한다. 확인 뒤 서버를 반드시 종료하라.
6. 아키텍처 체크리스트:
   - `createApp`이 여전히 "얇은 transport"인가(비즈니스 로직 0, ADR-006)?
   - helmet CSP·CORS·`csrfOriginGuard`·세션/쿠키 코드가 한 글자도 안 바뀌었는가?
   - 새 타이머·네트워크 egress·DB 접근이 0인가(ADR-008)?
   - `web/**`·`src/**`가 무수정인가?
   - `spaDir` 미주입 경로에서 `fs` 호출이 0인가(비활성이면 아무 일도 하지 않는다)?
7. `phases/60-same-origin-serving/index.json`의 step0을 `completed` + `summary`로 갱신한다(추가한 export 시그니처, 마운트 위치, 폴백 규칙 3조건, 비활성 게이트 기준, 테스트 증가분, 변이 6종 결과, 케이스 22 실행/skip 여부를 명시).

## 금지사항

- **helmet CSP를 완화하지 마라**(`'unsafe-inline'`·`'unsafe-eval'`을 `script-src`에 추가, `default-src` 확장 등). 이유: 실측상 빌드 산출물은 인라인 스크립트가 0이고 자산이 전부 동일 출처 절대 경로라 현행 CSP로 통과한다. 완화가 필요해 보이면 그것은 빌드 설정이 바뀐 신호이므로 완화가 아니라 원인 조사가 답이다(케이스 22가 그 신호를 잡는다).
- **`createApp`의 `spaDir`에 기본값(`'web/dist'` 등)을 주지 마라.** 이유: 로컬 작업 트리에 빌드 산출물이 있으면 기존 1015건 테스트의 미정의 경로 동작이 "빌드했는가"에 따라 달라져 비결정적 회귀가 된다. 기본값은 `bootstrap()`에만 둔다.
- **정적/폴백을 요청 로거·`csrfOriginGuard`·`/uploads` static보다 앞에 등록하지 마라.** 이유: 액세스 로그가 누락되고 미들웨어 순서 계약(ADR-009: "요청 로거 뒤, 라우트 앞")이 흔들린다. 정확한 자리는 **모든 라우트 뒤, 전역 에러 핸들러 앞**이다.
- **미정의 `/api/*` 경로의 404를 JSON으로 바꾸지 마라.** 이유: `test/distribution-targets-api.test.js` 300~310행이 "핸들러 미등록 → Express 기본 404"를 계약으로 잠그고 있다.
- **폴백을 `app.get('*')` 같은 와일드카드 라우트로 구현하지 마라.** 이유: 메서드·접두사·Accept 세 조건이 라우터 패턴과 핸들러로 흩어져 감사 지점이 늘고, 향후 Express 5로 이관할 때 바뀐 path-to-regexp 문법에 그대로 걸린다(현재 의존성은 Express 4.21이라 당장 깨지지는 않는다). 조건은 순수 함수 하나에 모은다.
- **경로 목록(`ROUTES`)을 서버에 복제하지 마라.** 이유: `.do` 목록이 두 곳이 되면 SPA에 라우트를 추가할 때마다 서버도 고쳐야 하고, 빠뜨리면 새 페이지만 404가 된다. 폴백은 "API가 아닌 내비게이션"으로만 판정한다.
- **인증·세션·역할 게이트를 정적 서빙에 붙이지 마라.** 이유: 로그인 페이지 자체가 그 번들 안에 있어 게이트를 붙이면 로그인이 불가능해진다. SPA 번들은 비밀이 아니며, 데이터 접근은 전부 `/api` 세션 게이트가 지킨다(ADR-004).
- **`web/dist`를 커밋하지 마라**(`.gitignore` 대상). 테스트 픽스처는 `os.tmpdir()`에 만들고, 실제 dist는 조건부 skip 스모크(케이스 22)에서만 읽어라.
- **`web/**`(`vite.config.js`·`web/src/**` 포함)·`src/**`·`scripts/**`를 수정하지 마라.** 이유: 이 step은 transport 한 층만 만진다. dev 프록시를 지우면 개발 흐름(Vite HMR + SSE 쿠키)이 깨진다.
- **`docs/**`(`news.md`·`ADR.md`·`ARCHITECTURE.md` 포함)·`README.md`·`.env.example`·`.claude/skills/**`·`phases/49-mini-backlog-cleanup/step0.md`·`phases/50-hygiene-cleanup/**`를 수정하지 마라.** 이유: 문서 갱신(ADR-009 2문장 정정 포함)은 step2가 단독으로 소유한다 — 같은 문서를 두 step이 만지면 diff 판독과 원인 격리가 불가능해진다.
- **`git add -A`/`git add .` 금지**, 미커밋 사용자 파일의 `restore`/`checkout`/`stash`/`clean` 금지.
- 기존 테스트를 수정·삭제하지 마라. 기존 테스트가 red면 그것은 이 step의 회귀다.
