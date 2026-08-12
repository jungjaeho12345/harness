# Step 0: shell-core

## 읽어야 할 파일

먼저 아래를 읽고 설계 의도를 파악하라(이 step은 **Electron을 설치하지도, import하지도 않는다**):

- `CLAUDE.md`, `docs/ARCHITECTURE.md`, `docs/ADR.md`(특히 철학 문단 · ADR-004 신뢰 경계 · ADR-008 타이머/egress 금지 · ADR-009 동일 출처 전제 · ADR-010 빌드 도구 축)
- `phases/62-client-exe/index.json` — 이 phase의 decisions (1)~(16)
- `docs/UI_GUIDE.md` — step1의 로컬 페이지(설정/오류)가 따를 색·밀도 토큰(이 step은 코드에 쓰지 않지만 정책 함수의 창 크기 기본값 감각을 맞춘다)
- `test/runtime-paths.test.js` — 순수 함수 + 주입 의존성 단위 테스트의 리포 표준 패턴(phase 61 step0 산출물). 이 step의 테스트는 이 형태를 따른다.
- `web/src/view/ListPage.jsx` 31~47행, `web/src/view/WriterPage.jsx` 843~855행 — 셸이 반드시 지켜야 할 `window.open` 사용 실체
- `web/src/model/httpModel.js` 81~118행 — SPA의 API base가 **빈 문자열(동일 출처 상대 경로)** 이라는 사실

## 배경 (실측 사실 — 추측하지 말고 이 위에서 시작하라)

2026-08-13 리포 실측:

- SPA는 `createHttpModel({ base = '' })` 로 **모든 REST/SSE를 상대 경로**로 호출한다. 즉 셸이 `http://<서버>/` 를 `loadURL` 하기만 하면 API·SSE·업로드가 전부 그 출처로 간다. 클라이언트에 API 주소를 따로 주입할 자리는 없다.
- SPA가 여는 새 창은 **딱 두 종류이고 둘 다 `window.open('', '_blank', 'width=720,height=800')` = `about:blank`** 다: 상세보기(`ListPage.openDetail`)와 인쇄/인쇄미리보기(`WriterPage.printCurrentTab`). 두 경우 모두 **부모가 `w.document.write(html)`로 자식 문서를 직접 쓴다**(인쇄는 그 뒤 `w.print()`).
- Electron 공식 문서(`docs/api/window-open.md`, v43.4.0) 확인 사항: **`about:blank`로 열리는 자식 창의 `webPreferences`는 부모에서 복사되며 override가 불가능하다**(Chromium이 browser-side navigation을 건너뛴다). 즉 자식 창에 preload를 주입할 수 없고, **부모의 설정이 그대로 상속된다**. 같은 문서에 `childWindow.document.write('<h1>Hello</h1>')` 예제가 그대로 실려 있다 — 이 패턴은 지원 대상이다.
  - 이 상속 규칙이 `decideWindowOpen`에 `kind`가 필요한 이유다: **preload가 붙은 로컬 창이 `about:blank` 자식을 열면 그 자식도 preload를 상속받는다** → 로컬 창은 자식 창 자체를 만들지 못하게 막아야 한다.
- 같은 문서: `setWindowOpenHandler`는 메인 프로세스에서 호출되어 **최종 결정권**을 가지며, `{ action:'allow', overrideBrowserWindowOptions }`로 창 옵션을(단 `about:blank`는 webPreferences 제외) 지정하고, `outlivesOpener`(기본 `false`)로 부모가 닫힐 때 자식이 함께 닫힐지 정한다.
- 서버는 `GET /api/health` → `{ ok: true }` 를 **인증 없이** 준다(`server/index.js` 604행). 주소 검증 프로브는 이것 하나로 충분하지만, **200이라는 사실만으로는 부족하다** — 임의의 웹 서버·프록시·캡티브 포털도 200을 준다. 그래서 본문이 `{ ok: true }` JSON인지까지 확인한다(decisions (14)).
- 서버 SPA 폴백 계약(ADR-009 "가정과 실패 모드"): `Accept`에 `text/html`이 있고 경로가 `/api`·`/uploads`가 아닌 GET만 `index.html`을 받는다. Chromium 내비게이션은 `text/html`을 보내므로 그대로 동작한다. SPA 라우팅은 `/` → `login.do`(로그인 상태면 `list.do`)다(`web/src/app/routing.js`).

이 step은 위 정책들을 **Electron 없이 단위 테스트로 잠그는 순수 모듈**만 만든다. Electron 결선은 step1 소유다.

## 작업

TDD로 진행한다 — 각 모듈마다 **테스트를 먼저 쓰고**, 그 다음 구현한다.

### 1. `client/lib/serverUrl.js` (신규)

```js
export function normalizeServerUrl(input)
// → { ok: true, origin: 'http://192.168.0.10:3001' }
// → { ok: false, reason: 'empty' | 'invalid' | 'unsupported-scheme' | 'credentials' | 'no-host' }
export function healthUrl(origin)   // `${origin}/api/health`
export function appUrl(origin)      // `${origin}/`
export function isSameOrigin(url, origin)
export function interpretHealthResponse({ status, body })
// → { ok: true } | { ok: false, reason: 'http-status' | 'not-article-server' | 'unreachable' }
```

정규화 규칙(테스트로 전부 잠근다):

- 앞뒤 공백 트림. 빈 문자열/비문자열 → `reason:'empty'`.
- **스킴이 없으면 `http://`를 보충**한다(`192.168.0.10:3001` → `http://192.168.0.10:3001`). 운영자가 IP만 칠 것이기 때문이다.
- 허용 스킴은 **`http:`·`https:` 뿐**이다. `file:`·`javascript:`·`data:`·`ws:`·`app:` 등은 `unsupported-scheme`으로 거부한다.
- `user:pass@host` 형태는 `credentials`로 거부한다(자격증명이 설정 파일에 남는 표면을 만들지 않는다).
- 호스트가 비면 `no-host`.
- **경로·쿼리·해시는 버리고 origin만 남긴다**(`http://h:3001/login.do?x=1` → `http://h:3001`). 근거: SPA는 서버 루트에서 서빙되고 라우팅은 SPA 책임이다(`/` → login.do). 후행 슬래시는 없다.
- 호스트 대소문자·기본 포트(80/443)·IPv6 대괄호는 `new URL()`의 `origin` 표현을 그대로 따른다(직접 문자열 조작 금지).

`interpretHealthResponse` 규칙(**decisions (14)** — 프로브 판정의 단일 출처):

- `status`가 200이 아니면 `{ ok:false, reason:'http-status' }`.
- 본문이 JSON 객체이고 `body.ok === true`일 때만 `{ ok:true }`. 그 외(HTML 로그인 포털·`{}`·`{ ok:false }`·JSON 아님·`null`)는 **`{ ok:false, reason:'not-article-server' }`**. 이유: 200만 보고 저장하면 사내 프록시·다른 웹 서버 주소가 "정상"으로 저장되고, 사용자는 그 뒤 흰 화면만 본다.
- 네트워크 자체가 실패한 경우(호출부가 status를 못 얻음)는 `{ ok:false, reason:'unreachable' }`로 표현할 수 있게 `status`가 `null`/`undefined`인 입력도 받는다. **이 함수는 네트워크를 호출하지 않는다**(호출은 step1 메인 프로세스 책임).

### 2. `client/lib/clientConfig.js` (신규)

```js
export const CONFIG_FILENAME = 'config.json';
export const CONFIG_SCHEMA_VERSION = 1;
export function configPath(userDataDir)          // path.join(userDataDir, CONFIG_FILENAME)
export function parseConfig(raw)                 // 문자열|null|깨진 JSON → 항상 유효 객체 (throw 금지)
export function serializeConfig(config)          // JSON 문자열(줄바꿈 포함)
export function sanitizeBounds(bounds, workAreas) // 화면 밖/비정상 → null
export async function readConfigFile(path, { readFile })                 // 파일 없음/깨짐 → 기본값
export async function writeConfigFile(path, config, { mkdir, writeFile, rename })  // 임시파일 → rename(원자적)
```

- 설정 shape은 **화이트리스트**다: `{ schemaVersion, serverUrl, bounds:{ width,height,x,y,maximized } }`. 알 수 없는 키는 읽을 때 **버린다**(파일이 신뢰 경계 밖이라는 전제).
- **CRITICAL(보안)**: 세션ID·비밀번호·쿠키·토큰을 설정에 담는 필드를 만들지 마라. `parseConfig`는 그런 키가 파일에 있어도 버린다(테스트로 잠근다).
- `parseConfig`는 어떤 입력에도 throw하지 않는다 — 깨진 JSON·배열·`null`·숫자 → 기본값(`serverUrl: null`). 이유: 설정 파일이 깨졌다고 앱이 못 뜨면 사용자는 복구 수단이 없다(주소 재입력 화면으로 갈 수 있어야 한다).
- `serverUrl`은 저장 전 `normalizeServerUrl`을 통과한 값만 유효로 취급한다(읽을 때도 재검증 — 손으로 편집된 파일 방어).
- `sanitizeBounds`: 폭/높이는 정수·최소값(예: 800×600) 이상만, x/y는 주어진 `workAreas`(화면 작업영역 사각형 배열) 중 하나와 **겹칠 때만** 유지한다. 겹치지 않으면(모니터를 뗀 경우) `null`을 돌려 호출부가 기본 배치를 쓰게 한다.
- `writeConfigFile`은 **같은 디렉토리의 임시 파일에 쓴 뒤 rename**한다(중간에 죽어도 반쪽 JSON이 남지 않는다). 디렉토리는 없으면 만든다.

### 3. `client/lib/windowPolicy.js` (신규)

```js
export const APP_WINDOW = 'app';
export const LOCAL_WINDOW = 'local';
export function buildWindowOptions(kind, { preloadPath, bounds, show } = {})
export function decideWindowOpen({ url, serverOrigin, kind })
export function decideNavigation({ url, serverOrigin, kind })
export function isExternallyOpenable(url)
```

- `buildWindowOptions('app', …)` → 원격(서버) 페이지를 여는 창 옵션. **`webPreferences`는 `contextIsolation:true` · `nodeIntegration:false` · `nodeIntegrationInWorker:false` · `nodeIntegrationInSubFrames:false` · `sandbox:true` · `webviewTag:false` · `spellcheck:false`**, 그리고 **`preload` 키 자체를 넣지 않는다**(값이 `undefined`인 키도 두지 마라 — "원격 창엔 preload가 없다"가 객체 수준에서 증명돼야 한다).
  - **`spellcheck:false`는 확정 결정이다(decisions (13))**. 근거: Chromium 맞춤법 검사는 사전 다운로드·서버측 제안 등 앱 밖 통신을 유발할 수 있어 ADR-008(앱 egress 0)·폐쇄망 배치와 맞지 않는다. SPA에는 자체 맞춤법 검사 메뉴가 이미 있다(phase 30). `spellcheck:false`면 SPA가 DOM에 거는 `spellcheck="true"`(news.md 174행)는 무효가 된다 — 그것이 의도된 동작이다.
- `buildWindowOptions('local', { preloadPath })` → 셸 자체 페이지(설정/오류)용. 위와 같은 보안값 + `preload: preloadPath`. `preloadPath`가 없으면 **throw**한다(로컬 창은 브리지가 없으면 아무것도 못 한다 — 조용한 반쪽 상태 금지).
- 공통: `autoHideMenuBar: true`, `backgroundColor: '#ffffff'`, `show` 기본 false(step1이 `ready-to-show`에서 띄운다 — 흰 깜빡임 방지). 기본 크기는 app=1440×900(최소 1024×720), local=560×420.
- `decideWindowOpen({ url, serverOrigin, kind })` 반환 계약:
  - **`kind === 'local'` → 무조건 `{ action:'deny' }`**(URL 종류 무관). 근거: `about:blank` 자식은 부모의 webPreferences를 상속하므로(위 배경) 로컬 창이 자식을 열면 **preload가 상속된 창**이 생긴다. 셸 로컬 페이지는 새 창을 열 이유가 없다.
  - `kind === 'app'`:
    - `url === 'about:blank'` → `{ action:'allow', overrideBrowserWindowOptions:{ width:720, height:800, autoHideMenuBar:true }, outlivesOpener:true }`. **`overrideBrowserWindowOptions.webPreferences`를 넣지 마라** — `about:blank`에서는 무시되며(위 배경), 넣으면 "적용된다"는 착각을 코드에 남긴다.
    - `serverOrigin`과 동일 출처인 `http(s)` URL → `{ action:'allow', overrideBrowserWindowOptions:{ autoHideMenuBar:true } }`.
    - 그 외 `http(s)` URL(유튜브·외부 링크 등) → `{ action:'deny', openExternal: url }`.
    - 그 외 스킴(`file:`·`javascript:`·`data:`·custom) → `{ action:'deny' }` (**`openExternal` 없음**).
  - `kind`가 없거나 알 수 없는 값 → **`{ action:'deny' }`**(fail-closed). `serverOrigin`이 없거나 URL 파싱 실패도 `{ action:'deny' }`.
- `decideNavigation({ url, serverOrigin, kind })` → `'allow' | 'block' | 'external'`.
  - `kind === 'local'` → **항상 `'block'`**(로컬 창은 최초 `loadFile` 외 어떤 내비게이션도 하지 않는다. preload가 붙은 webContents가 원격으로 이동하면 브리지가 원격 페이지에 노출된다 — 이 phase의 최상위 보안 불변식이다).
  - `kind === 'app'`: 동일 출처 → `'allow'`, 다른 `http(s)` → `'external'`, 그 외 스킴 → `'block'`.
  - `kind` 미지정/알 수 없는 값 → `'block'`(fail-closed — step1의 kind 미등록 webContents가 이 기본값을 탄다).
- `isExternallyOpenable(url)` → `http:`/`https:`만 `true`(외부 브라우저로 넘길 수 있는 URL 판정 — `shell.openExternal`에 임의 스킴을 넘기면 OS 핸들러가 실행된다).

### 4. `client/lib/loadFailure.js` (신규)

```js
export function describeLoadFailure({ errorCode, errorDescription, validatedUrl, isMainFrame })
// → null  (표시하지 않음)  |  { title, message, hint, canRetry: true }
export function describeHttpFailure({ httpResponseCode, url })
// → null (2xx/3xx) | { title, message, hint, canRetry: true }
```

- `isMainFrame`이 false면 `null`(서브리소스 실패로 오류 화면을 띄우면 정상 사용 중에 화면이 날아간다).
- `errorCode === -3`(`ERR_ABORTED`)이면 `null`(사용자 조작·리다이렉트로 흔히 발생하는 정상 취소다).
- 최소한 아래는 한국어 안내와 원인 힌트를 구분해 돌려준다: `-105 ERR_NAME_NOT_RESOLVED`(주소 오타/DNS), `-102 ERR_CONNECTION_REFUSED`(서버 미기동/포트), `-109 ERR_ADDRESS_UNREACHABLE`·`-118 ERR_CONNECTION_TIMED_OUT`(네트워크/방화벽), 그 외는 일반 문구 + `errorDescription` 병기.
- `describeHttpFailure`: 메인 프레임 응답이 4xx/5xx면 안내를 돌려준다. **404는 "서버는 응답하지만 SPA가 서빙되지 않는다(서버 배포 폴더의 `web/` 확인)"** 로 구체화한다 — 서버 exe만 있고 `web/`이 없으면 정확히 이 증상이 난다(ADR-009 폴백 계약).
- 문구에 스택·내부 경로·URL 전체 쿼리를 넣지 마라(사용자에게 의미 없고 오해를 부른다). URL은 origin까지만.

### 5. 테스트 (신규, 먼저 작성)

`test/client-shell-core.test.js` 1개 파일에 `describe` 4블록(모듈별)로 모은다. 리포 테스트는 전부 `test/` 평면 배치이므로 그 관례를 따른다.

최소 커버리지(케이스 수는 재량, 아래는 **반드시 포함**):

- serverUrl: 스킴 보충 · https 유지 · 경로/쿼리 제거 · 후행 슬래시 없음 · 대문자 호스트 · IPv6 · 기본 포트 · 빈 값 · `javascript:` 거부 · `file:` 거부 · `user:pass@` 거부 · 공백만 · `healthUrl`/`appUrl` 조립 · `isSameOrigin` 참/거짓/파싱 실패.
- **interpretHealthResponse: 200+`{ok:true}` 통과 · 200+`{}` 거절 · 200+`{ok:false}` 거절 · 200+HTML 문자열 거절 · 200+`null` 거절 · 401/404/500 거절(`http-status`) · status 없음 → `unreachable`.**
- clientConfig: 기본값 · 깨진 JSON · 배열/숫자/`null` 입력 · **비밀 키(`sessionId`·`password`·`cookie`)가 파일에 있어도 파싱 결과에 없다** · 유효하지 않은 `serverUrl` 문자열은 읽을 때 버려진다 · 왕복(serialize→parse) 동등성 · `configPath` 조립 · `readConfigFile`의 ENOENT 처리 · `writeConfigFile`이 **tmp에 먼저 쓰고 rename**한다(주입한 스파이로 호출 순서 단언) · `sanitizeBounds`(정상/최소치 미만/화면 밖/모니터 제거/비정수).
- windowPolicy: app 옵션에 **`preload` 키가 아예 없다** · **`spellcheck:false`** · local 옵션에 preload가 있다 · `preloadPath` 없이 local 요청 시 throw · 보안 플래그 6종 값 · **`kind:'local'`의 `decideWindowOpen`은 `about:blank`·동일 출처·외부 URL 전부 deny** · app의 `about:blank` 허용 + 720×800 + `outlivesOpener:true` + **`webPreferences` 키 부재** · app 동일 출처 허용 · app 외부 http → deny+openExternal · `javascript:`/`file:` → deny이고 `openExternal` 없음 · **kind 미지정 → deny** · `decideNavigation`의 local 전량 block · app의 allow/external/block 3분기 · **kind 미지정 → block**.
- loadFailure: 서브프레임 무시 · `-3` 무시 · 주요 errorCode 4종의 서로 다른 문구 · 알 수 없는 코드의 일반 문구 · `describeHttpFailure`의 404 특화 문구 · 200/302 → null.

## Acceptance Criteria

```bash
npm test                 # 1089 + 신규(전부 pass, 실패 0)
node --test "test/client-shell-core.test.js"   # 이 step 신규분 단독 green
npm run lint             # clean (client/** 는 eslint 커버리지 안이다 — eslint.config.js ignores에 없음)
npm run test:web         # 2368/2368 무영향 (web/** 무수정)
npm run build            # clean
```

순수성 게이트(주석은 판정에서 제외한다 — 단순 grep은 설명 주석에 오탐이 난다):

```bash
node -e 'const fs=require("node:fs");const dir="client/lib";const bad=[];for(const f of fs.readdirSync(dir)){const src=fs.readFileSync(dir+"/"+f,"utf8").replace(/\/\*[\s\S]*?\*\//g,"").replace(/(^|[^:])\/\/[^\n]*/g,"$1");for(const t of ["electron","process.","globalThis.","window.","require("]) if(src.includes(t)) bad.push(f+" -> "+t);}if(bad.length){console.error("IMPURE: "+bad.join(", "));process.exit(1);}console.log("PURE-OK");'
```

- 이 게이트가 `PURE-OK`를 출력하지 않으면 실패다. `node:path`·`node:url`의 **정적 import**는 허용한다(전역 상태가 아니다).
- **`client/lib/`에는 이 step의 순수 모듈 4개만 둔다.** 진단(diag)·메뉴·IPC 가드 등 셸 결선 보조 모듈은 step1이 `client/` 루트에 만든다 — 이 게이트를 통과하지 못하는 코드를 `client/lib/`에 넣지 마라(decisions (15)).

`npm run test:web` 비고정 실패 규약(전 step 공통): 1건이 비고정으로 실패하면 회귀로 단정하지 말고 **최대 2회 재실행 + 해당 파일 단독 실행**으로 판정한다. green이면 통과로 보고 그 사실을 요약에 남긴다(web/** 무수정이 전제 — 기지의 병렬 flake).

## 검증 절차

1. 위 AC 커맨드를 전부 실행하고 결과를 기록한다(backend 총계 = 1089 + 신규 건수).
2. **변이 검증 5종**(각각 소스를 일부러 깨서 red가 나는지 확인하고 **즉시 원복**):
   1. `normalizeServerUrl`의 스킴 허용 목록에 `file:`을 추가 → 거부 케이스 red.
   2. `buildWindowOptions('app')`에 `preload: preloadPath`를 추가 → "preload 키 부재" 케이스 red.
   3. `decideWindowOpen`에서 `kind==='local'` 가드를 제거 → 로컬 창 deny 케이스 red.
   4. `parseConfig`에서 화이트리스트를 없애고 입력을 그대로 반환 → 비밀 키 제거 케이스 red.
   5. `interpretHealthResponse`에서 본문 검사를 없애고 status만 보게 변경 → `not-article-server` 케이스 red.
3. `git status --porcelain` 증분이 `client/lib/*.js`(4개)·`test/client-shell-core.test.js` 뿐인지 확인한다(**시작 시점 스냅샷 대비 증분**으로만 판정 — 사용자 미커밋 파일은 건드리지 않는다).
4. 아키텍처 체크리스트: `package.json` 무수정 / `dependencies`·`devDependencies` 추가 0 / `web/**`·`src/**`·`server/**` 무수정 / DB 무접촉 / 타이머·네트워크 호출 0.
5. `phases/62-client-exe/index.json`의 step0을 갱신한다(completed + summary / error + error_message / blocked + blocked_reason).

## 금지사항

- `client/lib/**`에서 `electron`을 import하지 마라(동적 import 포함). 이유: 이 계층은 Electron 없이 `node --test`로 돌아야 하며, 그것이 이 phase의 유일한 자동 회귀 안전망이다(Electron 실기 검증은 느리고 GUI가 필요하다).
- `client/lib/`에 파일시스템·env를 직접 만지는 모듈(diag 등)을 추가하지 마라. 이유: 순수성 게이트가 무력해지고, 그 게이트가 이 phase에서 "정책이 테스트 가능하다"를 지키는 유일한 장치다.
- `package.json`을 수정하지 마라(`electron` devDependency는 step1 소유다). 이유: 파일 소유가 겹치면 실패 격리가 불가능하고, 이 step은 설치 없이도 완결돼야 한다.
- 정책 함수에서 `process.env`·전역 `fs`를 직접 읽지 마라. 이유: 순수 함수여야 두 배치(dev/패키지)를 테스트로 동시에 잠글 수 있다 — phase 61 `resolveRuntimePaths`의 선례다.
- `web/**`를 수정하지 마라. 이유: 클라이언트는 서버가 서빙하는 SPA를 **그대로** 쓴다. SPA를 셸에 맞춰 고치면 브라우저 접속 경로가 회귀한다.
- `normalizeServerUrl`에서 문자열 자르기·정규식으로 origin을 직접 조립하지 마라. 이유: 포트 생략·IPv6·유니코드 호스트에서 조용히 틀린 origin이 나오고, 그 값이 동일 출처 판정(= 새 창 허용 정책)의 입력이 된다.
- 자동 재시도·폴링·타이머(`setInterval`/`setTimeout` 기반 재프로브)를 이 계층에 넣지 마라. 이유: ADR-008(앱 내 타이머·egress 금지)은 셸에도 그대로 적용된다 — 프로브는 사용자 액션 시 1회뿐이다.
- 기존 테스트를 깨뜨리지 마라.
