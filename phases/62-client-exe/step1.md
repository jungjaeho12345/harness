# Step 1: shell-main

## 읽어야 할 파일

- `CLAUDE.md`, `docs/ARCHITECTURE.md`, `docs/ADR.md`(ADR-004·005·008·009·010), `docs/UI_GUIDE.md`(로컬 페이지 스타일 토큰)
- `phases/62-client-exe/index.json` — decisions 전체(특히 (2)(3)(9)(11)(12)(13)(14)(15)(16)), open_questions (a)~(e)
- `phases/62-client-exe/step0.md` + **step0이 만든 `client/lib/*.js` 4개 모듈과 `test/client-shell-core.test.js`** — 이 step은 그 정책 함수들을 **호출만** 한다(정책을 여기서 다시 구현하지 마라)
- `phases/62-client-exe/step2.md` — 이 step이 만드는 **diag 이벤트 이름·필드가 step2 검증 스크립트의 단언 대상**이다. 이름을 임의로 바꾸면 step2가 깨진다.
- `web/src/view/ListPage.jsx` 31~47행 · `web/src/view/WriterPage.jsx` 843~855행 — 반드시 살아야 하는 새 창 2종
- `docs/news.md` 164~185행 — 에디터 단축키 목록(아래 "액셀러레이터·Alt 충돌" 절의 근거)
- `eslint.config.js` — `client/**`는 lint 대상이고 `scripts/**`는 ignore 대상이라는 사실. 기본 `files: ['**/*.js']` 블록은 **`.cjs`를 잡지 않는다**(그래서 아래 2절의 블록이 필요하다).

## 배경 (실측 사실)

- 최신 Electron은 **43.4.0**(2026-08-13 `npm view electron version` 실측). 패키지 자체는 작고(1.1MB) 설치 시 **후크가 플랫폼 런타임 zip(수백 MB)을 내려받아 `node_modules/electron/dist/`에 푼다** — `npm install`이 느려지고 네트워크가 필요하다.
- Electron 공식 문서(v43.4.0) 확정 사실:
  - `about:blank` 자식 창의 `webPreferences`는 **부모에서 복사되며 override 불가**(`docs/api/window-open.md`). 부모가 안전하면 자식도 안전하고, 반대로 **preload가 붙은 창의 자식은 preload를 상속한다**(→ 로컬 창은 자식 창 생성을 전면 거부한다, step0 `decideWindowOpen`).
  - `setWindowOpenHandler`는 메인 프로세스에서 최종 결정권을 가진다. `outlivesOpener`(기본 false)로 부모 종료 시 자식 동반 종료 여부가 갈린다.
  - 메인 프로세스는 ESM을 지원한다(가장 가까운 `package.json`에 `"type":"module"` 또는 `.mjs`). **샌드박스 preload는 ESM을 쓸 수 없다**(`docs/tutorial/esm.md`) → preload는 **`.cjs` 확장자**로 두고 `require('electron')`만 쓴다.
- **단일 인스턴스 잠금은 `userData` 경로에 매인다**(Chromium ProcessSingleton). 그래서 `app.setPath('userData', …)`를 **잠금 요청보다 먼저** 해야 한다 — 순서가 뒤집히면 (a) 검증/개발 실행이 실사용자 `%APPDATA%` 프로필을 잡고 오염시키며, (b) 실사용자 클라이언트가 떠 있을 때 스모크의 두 번째 인스턴스가 "정상 종료"로 보여 **거짓 통과**가 난다.
- **커스텀 메뉴를 설치하면 기본 메뉴의 role 액셀러레이터가 사라진다** — 새로고침(F5/Ctrl+R)·확대/축소는 기본 메뉴가 제공하던 것이라 커스텀 메뉴에 항목이 없으면 **동작하지 않는다**. 반면 텍스트 편집 키(Ctrl+C/X/V/A 등)는 렌더러 편집기가 처리하므로 메뉴와 무관하게 동작한다. news.md 125행이 F5 세션 유지를 요구하므로 **새로고침 항목은 반드시 넣는다**(단 액셀러레이터 없이 — 아래).
- SPA 사실: API base는 상대 경로, 세션 인증 1차 수단은 **HttpOnly 쿠키**(SSE는 쿠키 전용), 편집 잠금 해제는 `pagehide`/`beforeunload`에서 **평범한 fetch**로 나간다(keepalive 아님 — 창 닫기 시 도달 보장 없음. step2 D-6 실측 대상).
- SPA 단축키(news.md 181·185행): `Ctrl+B`(기업코드변환) `Ctrl+X/C/V` `Alt+V`(원본 붙여넣기) `Alt+O`(약물) `Ctrl+F`(찾기/바꾸기) `Ctrl+A`(전체 선택) `Ctrl+D`(한 줄 삭제) `Alt+Y`((끝) 삽입) `Ctrl+Y`((계속) 삽입).

## 작업

### 1. devDependency + 스크립트 (`package.json`)

- `devDependencies`에 **`electron`을 정확 버전으로 고정**(예: `"electron": "43.4.0"` — esbuild·postject 선례와 동일한 정확 고정. 캐럿 금지: 메이저가 조용히 올라가면 패키징 산출물이 바뀐다).
- `scripts`에 **`"client:dev": "electron client"` 한 줄만** 추가한다(`dist:client`는 step3 소유 — 그 줄을 만들지 마라).
- **`dependencies`(런타임)에는 아무것도 추가하지 마라.**
- 설치 후 `node -e "console.log(require('electron'))"`로 런타임 경로가 잡혔는지 확인하고, `node_modules/electron/dist/electron.exe` 존재를 확인해 기록하라(step3이 이 경로를 쓴다).
- 설치가 네트워크 문제로 실패하면 **추측으로 미러를 설정하지 말고** 실패 커맨드와 함께 blocked로 보고하라.

### 2. `eslint.config.js` — 추가 블록 2개만 (기존 블록·ignores 수정 금지)

```js
{ files: ['client/pages/**/*.js'], languageOptions: { globals: { ...globals.browser } } },
{ files: ['client/**/*.cjs'], languageOptions: { ecmaVersion: 2023, sourceType: 'commonjs', globals: { ...globals.node } } },
```

첫 블록은 렌더러에서 도는 로컬 페이지 스크립트(`document`/`window` 사용), 둘째 블록은 `client/preload.cjs`(CJS·`require`)를 lint 커버리지에 넣기 위한 것이다. 파일 맨 뒤에 추가한다.

### 3. `client/package.json` (신규)

```json
{ "name": "article-client", "productName": "기사작성기", "version": "0.0.0",
  "private": true, "type": "module", "main": "main.js" }
```

- `productName`이 **`app.getName()` → `app.getPath('userData')` 폴더명**(%APPDATA% 아래 `기사작성기`)을 결정한다. 이 사실을 step 요약에 기록하라(JSON에는 주석을 못 쓴다).
- 이 파일 덕분에 `electron client`(dev)와 패키지 배치(`resources/app/`)가 **같은 엔트리**를 쓴다 — step3은 이 폴더를 화이트리스트로 복사만 한다.

### 4. 테스트 가능한 셸 보조 모듈 3개 (신규 — **`client/` 루트**, `client/lib/` 아님)

`client/lib/`는 step0의 순수성 게이트가 걸린 정책 전용 디렉토리다. 아래 3개는 셸 결선의 일부지만 **순수 함수로 뽑아 단위 테스트로 잠근다**(decisions (12)(15)).

```js
// client/menu.js
export function buildMenuTemplate({ dev = false } = {})   // → Electron Menu 템플릿 배열(평문 객체)

// client/ipcGuard.js
export function isTrustedSender({ senderUrl, senderContentsId, localContentsId })  // → boolean

// client/diag.js
export function redactDiagEvent(event, payload)   // → 직렬화 가능한 평문 객체(금지 필드 제거)
export function formatDiagLine(event, payload, now)  // → JSONL 한 줄 문자열
export function createDiag({ filePath, appendFileSync })  // filePath 없으면 완전 no-op 객체
```

- `buildMenuTemplate`:
  - 항목: `파일`(서버 주소 변경 / 다시 연결 / 종료), `보기`(**새로고침** / 확대 / 축소 / 원래 크기), `도움말`(정보).
  - **어떤 항목에도 `accelerator` 키를 넣지 마라. 편집 계열 `role`(undo·redo·cut·copy·paste·selectAll)도 넣지 마라.** 근거: 메뉴 액셀러레이터는 렌더러 keydown보다 먼저 처리되어 SPA 에디터 단축키(`Ctrl+B/D/F/Y/A`, `Alt+V/O/Y`)를 조용히 삼킨다. `role:'redo'`는 Windows에서 `Ctrl+Y`(= (계속)삽입), `role:'selectAll'`은 `Ctrl+A`와 정면 충돌한다.
  - 보기의 새로고침/확대/축소는 `role`(`reload`·`zoomIn`·`zoomOut`·`resetZoom`)을 쓰되 **`accelerator: undefined`가 아니라 키 자체를 두지 않는 방식**으로 만들고, role 기본 액셀러레이터가 살아 있는지 실측해 살아 있으면 `accelerator: ''`(또는 `registerAccelerator: false`)로 눌러라 — 실측 결과를 요약에 남긴다. 목표는 "메뉴 클릭으로는 되지만 키 조합은 SPA로 간다"이다.
  - 라벨에 **mnemonic(`&`)을 넣지 마라**(Alt 조합 충돌 표면 축소 — 아래 Alt 주의).
  - `dev: true`일 때만 `개발자도구` 항목을 추가한다.
- `isTrustedSender`: `senderUrl`이 `file://`로 시작하고 `senderContentsId === localContentsId`일 때만 `true`. 원격 URL·다른 창·`null`·`undefined`·`localContentsId` 미지정은 전부 `false`(fail-closed).
- `createDiag`: `filePath`가 없으면 모든 메서드가 no-op(파일을 만들지 않는다). `redactDiagEvent`는 **본문·세션ID·쿠키·비밀번호 계열 키를 제거**하고, URL 값은 **origin + pathname까지만** 남긴다(쿼리·해시 제거 — 기사아이디·토큰이 새는 표면 차단).

### 5. `client/main.js` (신규 — Electron 메인 프로세스, ESM)

step0 정책 모듈과 4절 보조 모듈을 import해 **결선만** 한다. **정책 판단·메뉴 구성·sender 검증을 여기서 인라인으로 재구현하지 마라**(테스트가 못 잡는다).

부팅 순서(**순서가 계약이다 — decisions (11)**):

1. `process.env.CLIENT_USER_DATA`가 있으면 **가장 먼저** `app.setPath('userData', …)`.
2. 그 다음 `app.requestSingleInstanceLock()` — 실패하면 즉시 `app.quit()`(창을 만들지 않는다).
3. `second-instance` 이벤트 → 기존 창을 `restore()` + **`show()`** + `focus()`. (창이 숨겨져 있거나 최소화된 상태에서 두 번째 실행이 아무 반응이 없으면 사용자는 앱이 죽은 줄 안다.)
4. `whenReady()` → 설정 로드(`readConfigFile(configPath(app.getPath('userData')), { readFile })`).
5. `serverUrl`이 유효하면 **앱 창**(원격), 없으면 **로컬 창(설정 모드)**.
6. `window-all-closed` → `app.quit()`.

> **CRITICAL**: 1과 2의 순서를 바꾸지 마라. 잠금 키는 `userData` 경로에서 파생되므로, 순서가 뒤집히면 검증 실행이 실사용자 프로필을 잡고(오염) 두 번째 인스턴스 판정이 거짓으로 통과한다.

창은 **정확히 두 종류**이며 서로 섞지 않는다:

- **앱 창(app)**: `buildWindowOptions('app', { bounds })`로 만들고 `loadURL(appUrl(origin))`. **preload 없음. 이 창은 절대 `loadFile`을 하지 않는다.**
- **로컬 창(local)**: `buildWindowOptions('local', { preloadPath })`로 만들고 `loadFile('pages/setup.html' | 'pages/error.html')`. **이 창은 절대 `loadURL(원격)`을 하지 않는다.**

> **CRITICAL(이 phase 최상위 불변식)**: preload가 붙은 webContents는 원격 URL을 절대 로드하지 않는다. 두 창을 하나로 합치거나 로컬 창에서 서버로 내비게이트하는 구조로 바꾸지 마라.

**창 kind 매핑(decisions (16))**: `WeakMap<WebContents, 'app'|'local'>`을 둔다.

- 창을 만들 때 즉시 등록한다.
- `did-create-window`에서 **자식 창은 부모의 kind를 상속**해 등록한다(`about:blank` 상세보기·인쇄 창이 여기 해당).
- **미등록 webContents의 기본값은 `'local'`(fail-closed)** — step0의 정책 함수가 local에 대해 새 창·내비게이션을 전량 차단하므로, 등록 누락이 "허용"으로 새지 않는다.

상태 전이(**좀비 창 금지 — decisions (12)**):

- 로드 실패/HTTP 오류 → 앱 창을 없애고 로컬 창(오류 모드)을 띄운다. **정상 경로는 `close()`다**(bounds 저장 close 훅·렌더러 언로드 기회 유지 — `destroy()`는 close 이벤트와 beforeunload/pagehide를 발생시키지 않아 그 둘을 전부 건너뛴다). 창이 응답하지 않을 때만 `destroy()` 폴백. **`hide()`로 숨기지 마라** — 숨은 창이 남으면 `window-all-closed`가 영원히 오지 않아 사용자가 오류 창을 닫아도 프로세스가 좀비로 남는다.
- [다시 연결]/[저장하고 시작] → **앱 창을 새로 생성**한다(재사용하지 않는다).
- 로컬 창이 닫혔는데 보이는 창이 0이면 앱을 종료한다(위 `window-all-closed` 기본 동작으로 충족되는지 확인하고, 안 되면 명시적으로 처리하라).
- **로컬 창은 항상 최대 1개다**: 이미 열려 있으면 새로 만들지 말고 그 창을 재사용해 모드(setup|error)만 갱신한다. 앱 창을 생성할 때는 열린 로컬 창을 닫는다. `localContentsId`는 로컬 창 생성 시 갱신하고 닫힐 때 비운다 — 로컬 창이 2개가 되면 `isTrustedSender`의 단일 id와 어긋나 먼저 뜬 창의 버튼이 조용히 무반응(forbidden)이 된다(이 phase가 금지한 "조용한 반쪽 상태").

가드/이벤트 결선:

- `app.on('web-contents-created', (_, contents) => …)`에서 전역으로:
  - `contents.setWindowOpenHandler(({ url }) => …)` → `decideWindowOpen({ url, serverOrigin, kind: kindOf(contents) })` 결과를 그대로 반환하되, `openExternal`이 있으면 `isExternallyOpenable(url)` 재확인 후 `shell.openExternal(url)`.
  - `contents.on('will-navigate', …)` → `decideNavigation({ url, serverOrigin, kind: kindOf(contents) })`가 `'allow'`가 아니면 `preventDefault()`, `'external'`이면 `shell.openExternal`.
  - `contents.on('will-attach-webview', (e) => e.preventDefault())`.
- 앱 창 webContents:
  - `did-fail-load` → `describeLoadFailure(...)`가 non-null이면 위 상태 전이(파괴 후 오류 창).
  - `did-navigate` → `describeHttpFailure({ httpResponseCode, url })`가 non-null이면 같은 처리(서버는 살아 있는데 SPA가 없는 배치 = 404 케이스).
  - `render-process-gone`·`unresponsive`는 진단 기록만 하고 창을 죽이지 마라.
  - `page-title-updated`는 **가로채지 마라**(news.md 60행: 창 제목 = 활성 편집 탭 기사아이디. 기본 동작이 그 스펙이다).
  - `ready-to-show`에서 `show()`(+ 저장된 `bounds.maximized`면 `maximize()`).
  - `close`에서 현재 `getBounds()`/`isMaximized()`를 `sanitizeBounds` 통과 후 설정에 저장한다(**타이머·resize 디바운스 금지** — close 1회만).
- `session.defaultSession.setPermissionRequestHandler` — **`clipboard-read`·`clipboard-sanitized-write`만 허용**하고 나머지(geolocation·media·notifications·midi·hid·serial 등)는 거부한다. 이유: WriterPage의 붙여넣기 경로가 `navigator.clipboard.read()`를 쓴다(막으면 기존 기능이 죽는다). 나머지는 이 앱이 쓰지 않는다.
- 메뉴: `Menu.setApplicationMenu(Menu.buildFromTemplate(buildMenuTemplate({ dev: process.env.CLIENT_DEV === '1' })))`, 창은 `autoHideMenuBar: true`.
  - **Alt 충돌 주의(step2 D-8 실측 대상)**: `autoHideMenuBar` 상태에서 Alt 단독 입력이 메뉴바를 띄우므로 SPA의 `Alt+V`/`Alt+O`/`Alt+Y`가 삼켜질 수 있다. 폴백 사다리(실측 후 필요한 만큼만): (1) 라벨 mnemonic(`&`) 미사용 확인 → (2) `autoHideMenuBar:false`(메뉴바 상시 표시)로 전환해 재실측 → (3) 그래도 삼켜지면 `Menu.setApplicationMenu(null)`로 메뉴를 없애고 셸 진입(주소 변경·재연결·새로고침)을 **오류 화면/설정 화면과 창 내 버튼**으로만 제공한 뒤, F5 새로고침이 불가해진다는 제약을 step4 문서에 남긴다.
- **서버 주소 프로브**: 로컬 창의 IPC 요청을 받아 메인에서 `net.fetch(healthUrl(origin), { signal: AbortSignal.timeout(5000) })` **1회**만 수행하고, 응답 상태와 **본문 JSON을 `interpretHealthResponse`에 넘겨 판정**한다(200이어도 `{ ok:true }`가 아니면 `not-article-server`로 거절 — decisions (14)). 재시도·백오프·주기 확인 금지(ADR-008).
- **저장은 프로브 성공 후에만** 한다(실패한 주소를 config에 쓰지 마라).

### 6. `client/preload.cjs` (신규 — 샌드박스 preload, CJS)

```js
// contextBridge.exposeInMainWorld('shellBridge', { … })
probeServer(input)   // → { ok, origin?, reason? }
saveServer(input)    // → { ok, origin?, reason? }   (정규화 → 프로브 성공 시에만 저장 → 앱 창 전환)
getState()           // → { mode:'setup'|'error', serverUrl, failure? }
retry()              // → void
quit()               // → void
```

- 노출 함수는 **이 5개뿐**이다. `ipcRenderer`·`require`·`process`·파일시스템 접근을 절대 노출하지 마라.
- `contextIsolation: true` + `sandbox: true` 유지. ESM 금지(샌드박스 preload는 ESM 미지원) → 확장자는 `.cjs`.
- **메인의 모든 `ipcMain.handle`은 `isTrustedSender({ senderUrl: event.senderFrame?.url, senderContentsId: event.sender.id, localContentsId })`로 검증**하고, false면 즉시 `{ ok:false, reason:'forbidden' }`을 돌려준다(처리 금지). 이유: 신뢰 경계는 셸 메인이다 — 창 구조가 바뀌어도 원격 페이지가 IPC를 잡을 수 없어야 한다.

### 7. `client/pages/` (신규 — 셸 로컬 페이지)

- `setup.html` + `setup.js` + `error.html` + `error.js` + 공용 `shell.css`.
- **CSP meta 필수**: `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:">`. 인라인 `<script>`·인라인 style 금지(그래서 별도 .js/.css이고, 그래야 eslint가 검사한다).
- 설정 화면: 안내 문구 + 주소 입력(placeholder `192.168.0.10:3001`) + [연결 확인] + [저장하고 시작] + 현재 저장된 주소 표시. 실패 사유는 한국어로(예: "서버에 연결할 수 없습니다 — 주소·포트·서버 실행 여부를 확인하세요", "기사작성기 서버가 아닙니다 — 주소를 확인하세요").
- 오류 화면: 실패 원인(`describeLoadFailure`/`describeHttpFailure` 결과) + [다시 연결] + [서버 주소 변경] + [종료].
- 스타일은 `docs/UI_GUIDE.md` 토큰(흰 배경 `#ffffff`, 블루 `#0a4da6`, 잉크 `#1a1a1a`, radius 2/4/6px)만 쓴다. **금지 목록(그라데이션 텍스트·backdrop-filter·글로우·보라 계열)을 지켜라.**
- 사용자 입력을 화면에 다시 그릴 때 `textContent`만 쓴다(`innerHTML` 금지).

### 8. 진단 이벤트 계약 (step2가 단언한다 — 이름·필드를 바꾸지 마라)

`CLIENT_DIAG_FILE`이 있을 때만 JSONL을 append한다(없으면 완전 no-op). 각 줄은 `{ ts, event, ...fields }`:

`app-ready` · `config-loaded{hasServerUrl}` · `setup-shown{reason}` · `app-window{url}` · `did-finish-load{url,title}` · `did-navigate{url,httpResponseCode}` · `load-failed{errorCode,url}` · `window-open{url,action}` · `navigation{url,decision}` · `probe{origin,ok,reason?}` · `config-saved{origin}` · `ipc{channel,trusted}` · `second-instance`

- `CLIENT_SELFTEST=1`이면 창을 `show:false`로 만든다(검증이 데스크톱을 점유하지 않게).
- URL 값은 `redactDiagEvent`를 거쳐 **origin + pathname**까지만 남는다. 기사 본문·세션ID·쿠키는 절대 기록하지 않는다.

### 9. 단위 테스트 (신규, 먼저 작성) — `test/client-shell-main.test.js`

- `buildMenuTemplate`: **템플릿 전체를 재귀 순회해 `accelerator` 키가 0개**(dev 모드 포함) · 편집 role(undo/redo/cut/copy/paste/selectAll)이 **0개** · `보기`에 새로고침 항목 존재 · 라벨에 `&` 없음 · `dev:false`면 개발자도구 항목 없음 / `dev:true`면 있음.
- `isTrustedSender`: `file://` + 같은 contents id → true / 원격 URL(`http://…`) → false / `file://`이지만 다른 contents id → false / `senderUrl` 없음 → false / `localContentsId` 없음 → false.
- diag: `createDiag({})`(파일 경로 없음)는 어떤 호출에도 파일 함수를 호출하지 않는다(스파이로 단언) · `redactDiagEvent`가 `body`·`sessionId`·`cookie`·`password` 키를 제거한다 · URL의 쿼리·해시가 잘린다 · `formatDiagLine`이 개행 1개로 끝나는 유효 JSON이다.

**변이 검증 3종**(각각 깨서 red 확인 후 즉시 원복): (1) 메뉴 항목 하나에 `accelerator:'CmdOrCtrl+Y'` 추가 → accelerator 0 단언 red. (2) `isTrustedSender`에서 contents id 비교 제거 → 다른 창 케이스 red. (3) `redactDiagEvent`에서 쿼리 제거 로직 삭제 → URL 절단 케이스 red.

### 10. 부팅 확인 2건 (이 step의 손 검증 최소분)

전체 실기 매트릭스(D-1~D-9)는 **step2 소유**다. 이 step에서는 아래 두 가지만 확인하고 기록한다:

- `npm run client:dev` → **설정 화면이 뜬다**(설정 없음 상태). 검증 시 반드시 `CLIENT_USER_DATA`를 임시 경로로 주어 실사용자 `%APPDATA%\기사작성기`를 만들지 마라.
- 잘못된 주소(`http://127.0.0.1:1`)를 넣으면 저장이 거절되고 사유가 표시된다.

## Acceptance Criteria

```bash
npm install                # electron 런타임 다운로드(수백 MB, 네트워크 필요)
npm run lint               # clean (client/**·preload.cjs·pages/** 포함)
npm test                   # step0 기준선 + client-shell-main 신규분, 실패 0
node --test "test/client-shell-main.test.js"   # 이 step 신규분 단독 green
npm run test:web           # 2368/2368 무영향
npm run build              # clean

# 자동 판정 게이트 (사람 눈 대조 금지)
test "$(grep -c 'webPreferences' client/main.js)" -eq 0 && echo "OPTIONS-SINGLE-SOURCE-OK"   # 창 옵션은 step0 buildWindowOptions만이 만든다
test "$(grep -c 'accelerator' client/menu.js)" -eq 0 && echo "NO-ACCEL-OK"
test "$(grep -c 'preload' client/main.js)" -le 2 && echo "PRELOAD-USE-MINIMAL-OK"            # 로컬 창 경로에서만 등장
! grep -rn "nodeIntegration: true\|contextIsolation: false\|webSecurity: false\|allowRunningInsecureContent\|sandbox: false" client && echo "SEC-OK"
test "$(grep -c "setPath('userData'" client/main.js)" -eq 1 && echo "USERDATA-SINGLE-CALL-OK"
node -e "const s=require('fs').readFileSync('client/main.js','utf8').split(/\r?\n/);const a=s.findIndex(l=>l.includes(\"setPath('userData'\"));const b=s.findIndex(l=>l.includes('requestSingleInstanceLock'));if(a<0||b<0||a>=b)process.exit(1);console.log('BOOT-ORDER-OK')"
```

`npm run test:web` 비고정 실패 규약: 1건이 비고정으로 실패하면 **최대 2회 재실행 + 단독 실행**으로 판정한다(green이면 통과, 사실을 요약에 남긴다 — web/** 무수정 전제).

## 검증 절차

1. 위 AC를 전부 실행한다.
2. 9절 변이 검증 3종을 수행하고 원복한다.
3. 10절 부팅 확인 2건을 수행한다(임시 `CLIENT_USER_DATA` 필수).
4. 실측 기록: Electron 버전·`process.versions`(Chromium/Node) · `npm install` 후 `node_modules` 증가량 · 메뉴 role의 기본 액셀러레이터가 살아 있었는지와 어떻게 눌렀는지 · 로컬 창/앱 창 전환 시 좀비 창 여부.
5. `git status --porcelain` 증분이 `package.json`·`package-lock.json`·`eslint.config.js`·`client/package.json`·`client/main.js`·`client/preload.cjs`·`client/menu.js`·`client/ipcGuard.js`·`client/diag.js`·`client/pages/**`·`test/client-shell-main.test.js` 뿐인지 확인한다(시작 시점 스냅샷 대비 증분).
6. 아키텍처 체크리스트: `dependencies` 추가 0 / `client/lib/**`(step0 소유)·`web/**`·`src/**`·`server/**` 무수정 / DB 무접촉 / 앱 내 타이머·주기 통신 0 / step0 정책 함수 재구현 0.
7. `phases/62-client-exe/index.json`의 step1을 갱신한다. **부분 산출물 규칙**: 중간 실패로 error 처리될 경우 **이미 만든 파일을 지우지 말고** 무엇이 어디까지 됐는지 summary/error_message에 남겨라 — 후속 세션은 `git status --porcelain` 증분과 이 계획서를 대조해 **잔여분만** 완결한다(phase 39·43 전례). **blocked 판정 기준**: electron 설치가 네트워크/권한으로 불가능한 경우.

## 금지사항

- `app.setPath('userData')`를 `requestSingleInstanceLock()` **뒤에** 호출하지 마라. 이유: 잠금 키가 userData 경로에서 파생되므로 실사용자 프로필을 잡아 오염시키고, 스모크가 거짓 통과한다.
- 오류 전환에서 앱 창을 `hide()`로 숨기지 마라. 이유: 숨은 창이 남아 `window-all-closed`가 오지 않고, 사용자가 오류 창을 닫아도 프로세스가 좀비로 남는다(작업 관리자로만 종료 가능).
- 원격(서버) 페이지를 여는 창에 `preload`를 붙이지 마라. 이유: 서버가 침해될 때 클라이언트 파일시스템까지 표면이 넓어진다 — 얇은 뷰어라는 전제가 깨진다.
- `nodeIntegration: true`·`contextIsolation: false`·`sandbox: false`·`webSecurity: false`·`allowRunningInsecureContent`를 쓰지 마라. 이유: 원격 페이지를 여는 셸에서는 곧바로 RCE 경로가 된다.
- `certificate-error`를 가로채 인증서 오류를 무시하지 마라. 이유: HTTPS 배치에서 중간자 공격을 앱이 승인하는 꼴이 된다.
- 메뉴에 `accelerator`나 편집 role을 넣지 마라. 이유: `Ctrl+Y`·`Ctrl+A`·`Ctrl+D` 등 SPA 에디터 단축키를 메뉴가 먼저 삼켜 기사 작성 기능이 조용히 죽는다.
- 원격 페이지에 `executeJavaScript`/`insertCSS`로 주입하지 마라. 이유: SPA 계약이 셸에 숨은 의존을 갖게 되고 브라우저 접속 시 동작이 달라진다.
- `web/**`·`src/**`·`server/**`·`client/lib/**`를 수정하지 마라. 이유: 계층·소유 경계이며, 정책 변경이 필요하면 step0의 계약을 고치는 것이 아니라 보고 대상이다.
- 자동 업데이트·크래시 리포터·텔레메트리·주기 재연결 타이머를 붙이지 마라. 이유: 확정 산출물은 무설치 포터블이고 ADR-008은 셸에도 적용된다.
- 진단 파일에 기사 본문·세션ID·쿠키·쿼리스트링을 남기지 마라. 이유: 셸이 새 유출 경로가 된다(ADR-007의 규율과 같은 축).
