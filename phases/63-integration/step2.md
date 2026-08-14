# Step 2: integration-smoke

## 읽어야 할 파일

- `CLAUDE.md` — DB 비파괴·아키텍처 규칙
- `phases/63-integration/index.json` — decisions **(10)(11)(12)(13)**, open_questions (d), forward_notes (e)(f)(g)
- `scripts/verify-server-exe.mjs` — 임시 `DATA_DIR` **시드 절차**(85~91행: `createSchema` + `seedUsers`), 자식 기동·health 폴링·확실한 종료(196~201행), 인자 가드 규율
- `scripts/verify-client.mjs` — 자식 env 정리(66~76행, **`ELECTRON_RUN_AS_NODE`·`NODE_OPTIONS` 제거가 필수**), diag JSONL 시퀀스 단언(96~118행), 실사용자 `%APPDATA%` 스냅샷(120~141행), 임시 userData 격리. **읽기만 한다 — 수정 금지, import 금지**(import 즉시 `main()`이 실행되는 CLI다)
- `client/diag.js` — 이벤트 계약(스칼라 필드만 기록)
- `client/lib/secureOrigin.js`·`client/main.js`(step0 산출물) — `secure-origin-switch` diag 이벤트가 언제 남고 언제 안 남는지
- `scripts/dist-client.mjs`·`scripts/dist-server.mjs` — 배포 폴더 레이아웃과 exe 이름(한글 실패 시 ASCII 폴백 `article-client.exe`·`article-server.exe`)
- `src/db/seed.js` — `SAMPLE_USERS`(reporter/reporter123=R, desk/desk123=D, admin/admin123=Z)
- `src/db/schema.js` — `createSchema`
- `web/src/view/ListPage.jsx` — 31~47행(상세보기 `window.open('', '_blank', 'width=720,height=800')` + `document.write`), 222~229행(`[data-testid="live-status"]`, 텍스트 '실시간'), 275~276행(행 `onClick` = 상세보기)
- `web/src/controller/useViewController.js` — 86행(기본 메뉴 state `useState('deskUnsent')`)·72행(그 메뉴의 필터 `{ status: ['RDS','DDH'] }`, 분기 라벨은 70행)
- `src/services/lifecycle.js` — 12~25행(D/Z: RDS→**DPS**, R: RDS→RDS)
- `server/index.js` — 851행(`POST /api/articles`)·872행(`POST /api/articles/:id/action`)·281~303행(CSRF Origin 게이트 — **동일 출처 요청은 통과**)

## 배경

phase 61은 서버 exe를, 62는 클라이언트 exe를 각각 따로 검증했다. 이 step은 **둘을 한 흐름으로 묶는 유일한 게이트**를 만든다: `npm run dist:server` + `npm run dist:client` 산출물을 그대로 써서, 서버 exe를 임시 DATA_DIR로 띄우고 **클라이언트 exe가 그 서버에 접속**해 실제 업무 루프를 도는지 자동 판정한다.

**측정 방식의 원칙(decisions (10))**: 로그인·기사 작성·송고는 렌더러 컨텍스트의 동일 출처 `fetch`로 수행하고(에디터 contenteditable·IME·탭 상태를 CDP로 모는 검증은 SPA 구현이 조금만 바뀌어도 부서진다), **화면 반영은 DOM으로 단언**한다. 즉 "서버 exe가 처리했다"와 "클라이언트 exe 화면에 반영됐다"를 각각 다른 수단으로 잡는다.

## 작업

### 1. `scripts/verify-integration.mjs` (신규)

```
node scripts/verify-integration.mjs [--scenario loopback|lan|all] [--server-exe <path>] [--client-exe <path>]
                                    [--cdp-port <n>] [--show] [--keep] [--timeout <ms>]
```

- **기본 경로 자동 해석**(중요 — AC 커맨드를 ASCII로 유지하기 위해서다): 서버 exe는 `dist/기사작성기-server/기사작성기-server.exe` → 없으면 `article-server.exe`, 클라이언트 exe는 `dist/기사작성기/기사작성기.exe` → 없으면 `article-client.exe`. 둘 중 하나라도 없으면 **"npm run dist:server && npm run dist:client 를 먼저 실행하라"**는 메시지로 exit 1.
- **인자 가드 필수**: 알 수 없는 인자·빈 값·범위 밖 `--scenario`·정수 아닌 `--timeout`/`--cdp-port` → 사용법 출력 후 exit 1. 이유: `scripts/**`는 eslint 밖이라 오타가 "검증 통과"로 둔갑한다(phase 61·62 선례).
- `--show`: `CLIENT_SELFTEST`를 주지 않아 셸이 창을 실제로 띄운다(사람이 보며 돌리는 모드 — 클립보드 왕복·포커스 확인용).
- **"기본은 비표시"의 정확한 범위**: `CLIENT_SELFTEST=1`이 억제하는 것은 **셸이 만드는 창**(앱 창·로컬 창)의 `show()`뿐이다. SPA가 `window.open`으로 여는 **상세보기/인쇄 자식 창은 Chromium이 만들고 `outlivesOpener`로 뜨므로 SELFTEST에서도 화면에 나타난다**(phase 62 D-1의 실측 경로와 동일). 따라서 이 검증은 실행 중 720×800 팝업이 잠깐 뜨는 것이 **정상**이며, 스크립트는 그 창을 단언 후 반드시 닫는다. 이 사실을 스크립트 머리말 주석과 출력 안내에 남겨라(운영자가 "검증이 데스크톱을 건드렸다"고 오해하지 않도록).

### 2. 시나리오 공통 절차

1. **임시 디렉토리**: `dataDir`(서버 DB)·`serverCwd`·`clientUserData`를 `os.tmpdir()` 아래에 만든다. 이 스크립트는 **자신이 만든 임시 경로 밖의 어떤 파일도 지우지 않는다.**
2. **시드**: `dataDir/news.db`에 `createSchema` + `seedUsers`(`verify-server-exe.mjs` 85~91행과 동형). 시드 DB는 임시 경로에만 존재한다.
3. **사전 스냅샷**(무변 단언의 기준점 — **before/after 비교의 before를 여기서 수집한다**): 리포 `news.db`(존재·크기·mtime)·`uploads/` 항목 수 · 실사용자 `%APPDATA%\기사작성기` · **`dist/` 아래 각 배포 폴더의 `data/` 디렉토리 목록**(`dist/*/data`를 순회해 폴더별 항목 이름 집합을 그대로 기록한다).
   - **절대 판정 금지**: "dist 아래 어디든 `news.db`가 있으면 실패"로 잠그지 마라. `dist/portable-probe/data/news.db`는 phase 61 포터블 검증이 **통과 조건으로 만들어 두는 정상 산출물**(계정 0명·시드 없음)이라 결정적으로 오탐한다. 판정은 **"검증 전에 없던 `data/news.db`가 검증 후 생겼다"** 일 때만 실패다(§4 무변 단언과 의미가 같다).
4. **서버 exe 기동**: `spawn(serverExe, [], { cwd: serverCwd, env })`, env = 상속 정리 후 `PORT=<랜덤 20000~50000>`·`HOST=<시나리오별 바인드 주소>`·`DATA_DIR=<임시>`. `SPA_DIR`은 **주지 않는다**(exe 옆 `web/`을 쓰는 배포 기본값 자체가 검증 대상이다). `NODE_ENV=production`을 주지 마라(쿠키 Secure가 켜져 평문 HTTP에서 세션이 죽는다 — `packaging/server/README-배포.md` 경고).
   - **바인드 주소**: loopback 시나리오는 `HOST=127.0.0.1`, **LAN 시나리오는 `HOST=0.0.0.0`** 이다(LAN IP 하나만 바인드하지 마라). 이유: `HOST=<lanIp>`로 묶으면 loopback 프로브가 **항상** ECONNREFUSED가 되어 §5의 3분법 판별식(loopback 성공 + LAN 실패 = 환경 차단)이 성립하지 않고, 방화벽 차단이 곧바로 "제품 실패"로 오진된다. `0.0.0.0`은 `server/index.js`의 `isLoopbackHost` 기준으로 **비-loopback**이므로(잠금: `test/host-binding.test.js` 127~128행) 수집 fail-closed 503 동작은 LAN 바인딩과 동일하게 유지된다.
   - 클라이언트에 주는 `serverUrl`은 바인드 주소가 아니라 **접속 origin**이다: loopback = `http://127.0.0.1:<port>`, LAN = `http://<lanIp>:<port>`.
5. **health 폴링**: `GET <origin>/api/health` 200 + 본문 `{ok:true}`까지 최대 30초. LAN 시나리오는 **loopback origin과 LAN origin 둘 다** 프로브해 §5의 3분법으로 갈라 판정한다(단순 실패로 뭉개지 마라).
6. **클라이언트 exe 기동**: `clientUserData/config.json`에 `{"schemaVersion":1,"serverUrl":"<origin>"}`를 미리 쓰고, env는 `verify-client.mjs`의 `cleanEnv()`와 **동형**으로 정리한 뒤(`ELECTRON_RUN_AS_NODE`·`NODE_OPTIONS` 제거는 필수 — 빠지면 electron이 플레인 Node로 뜬다) `CLIENT_USER_DATA`·`CLIENT_DIAG_FILE`·(기본) `CLIENT_SELFTEST=1`을 주고 인자로 `--remote-debugging-port=<cdpPort>`를 붙인다.
7. **diag 시퀀스 단언**: `app-ready` → `config-loaded{hasServerUrl:true}` → `app-window` → `did-navigate{httpResponseCode:200}` → `did-finish-load{title 비어 있지 않음}`.
   - **loopback 시나리오**: diag에 `secure-origin-switch`가 **없어야** 한다(음성 증거).
   - **lan 시나리오**: `secure-origin-switch{origin:<lan origin>}`가 **있어야** 한다.

### 3. CDP 루프(의존성 0 — Node 내장 전역 `WebSocket`)

`http://127.0.0.1:<cdpPort>/json/list`를 폴링해 url이 서버 origin으로 시작하는 page 타깃을 찾고, `webSocketDebuggerUrl`에 붙어 `Runtime.enable` 후 `Runtime.evaluate`(`awaitPromise:true`, `returnByValue:true`)로 아래를 순서대로 단언한다. 새 창(팝업) 탐지·정리는 `/json/list`·`/json/close/<targetId>` HTTP 엔드포인트로 한다(Target 도메인을 쓰지 않아도 된다).

1. **secure context / 클립보드 표면**: `window.isSecureContext === true`, `typeof navigator.clipboard === 'object'`, `typeof navigator.clipboard.readText === 'function'`, `typeof navigator.clipboard.read === 'function'`. **두 시나리오 모두**에서 참이어야 한다(LAN에서 이것이 거짓이면 step0의 스위치가 실효 없다는 뜻 = 실패).
2. **로그인**: `fetch('/api/login', { method:'POST', headers:{'content-type':'application/json'}, credentials:'same-origin', body: JSON.stringify({ userId:'desk', password:'desk123' }) })` → `ok:true`. (D 계정을 쓰는 이유: 송고가 RDS→**DPS**라는 관측 가능한 전이를 만든다.)
3. **목록 진입**: `location.replace('/list.do')` 후 로드 완료를 기다리고, `[data-testid="live-status"]`의 텍스트가 **'실시간'** 이 될 때까지 폴링(= HttpOnly 쿠키로 SSE가 붙었다는 증거).
4. **기사 작성**: `POST /api/articles`로 고유 제목(`통합검증-<타임스탬프>`)의 기사를 만든다 → `articleId` 확보.
5. **화면 반영(SSE)**: 목록 DOM에 그 제목을 가진 `tr`이 나타날 때까지 폴링(기본 메뉴 deskUnsent = RDS 포함). **재조회를 스크립트가 유발하지 마라**(새로고침·재조회 버튼 클릭 금지) — SSE 무효화 신호가 스스로 목록을 갱신하는지가 단언 대상이다.
6. **상세보기 팝업**: 그 `tr`을 `.click()` → `/json/list`에 새 타깃이 나타날 때까지 폴링 → 붙어서 (i) `document.body.innerText`에 제목 포함, (ii) **폭은 `window.outerWidth === 720` 엄격 일치, 높이는 `700 <= window.outerHeight <= 800` 허용 범위**로 단언 → `/json/close/<id>`로 닫는다. 높이를 엄격 일치로 잠그지 않는 이유: **작업영역 높이가 800 DIP 미만인 화면(작업표시줄 포함 1080p 미만·배율 125% 이상 등)에서는 Windows가 창 높이를 화면에 맞게 클램프**한다 — 셸이 요청한 800이 그대로 유지된다는 보장이 없다(폭은 클램프에 걸릴 여지가 사실상 없어 엄격 일치로 잠근다). **실측한 실제 값을 출력과 요약에 반드시 남겨라** — 범위를 벗어나면 실패이고, 범위 안이면 그 수치가 다음 phase의 기준선이 된다. 첫 창 diag에 `window-open{action:'allow'}`가 남았는지도 확인한다.
7. **송고**: `POST /api/articles/<id>/action` `{action:'send'}` → `ok:true` + 응답 상태가 `DPS`.
8. **화면 반영(SSE 2차)**: 목록에서 그 제목의 `tr`이 **사라질 때까지** 폴링(DPS는 deskUnsent 필터 밖).
9. **클립보드 왕복(best-effort)**: `navigator.clipboard.writeText('<nonce>')` → `readText()` 일치. **실패해도 실패로 판정하지 않는다** — 비표시 창은 포커스가 없어 거부될 수 있다(open_questions (d)). 결과를 `ok` / `미검증(사유 문자열)`로 출력에 남기고, `--show` 모드에서는 실패를 그대로 보고한다.

### 4. 종료·데이터 안전 단언

- 클라이언트 → 서버 순으로 kill → 200ms → 살아 있으면 SIGKILL(Windows 잔류 방지).
- **무변 단언 4종**(전부 §2.3의 before 스냅샷과 **비교** 판정이다 — 절대 조건이 아니다): 리포 `news.db`(크기·mtime) / `uploads/` 항목 수 / 실사용자 `%APPDATA%\기사작성기` / **`dist/*/data` 목록**. 특히 마지막 항목은 **before에 없던 `data/news.db`가 after에 생겼을 때만 실패**다 — 그건 `DATA_DIR` 주입이 실패해 배포물에 시드 계정 DB가 남았다는 뜻이라 자격증명 유출이며 **즉시 실패**다. 반대로 before에 이미 있던 `dist/portable-probe/data/news.db`(phase 61 포터블 검증의 정상 산출물)는 실패 사유가 아니다.
- `--keep`이 없으면 임시 디렉토리만 정리한다(Windows 파일 잠금으로 실패하면 경고만).
- 출력: 성공 시 시나리오별 확인 항목·소요·미검증 항목을 요약해 exit 0, 실패 시 실패 목록 + 자식 stdout/stderr + diag 내용을 stderr에 출력하고 exit 1.

### 5. 폴백 분기(불확실 지점 — 사실대로 처리하라)

**LAN 시나리오는 3분법으로 판정한다**(하나로 뭉뚱그리면 방화벽 때문에 제품이 고장난 것으로 오진한다). 스크립트가 서버 기동 직후 **loopback origin(`http://127.0.0.1:<port>`)과 LAN origin 둘 다에 health를 프로브**해서 갈라라.

| 상황 | 판정 | 종료 코드 | 처리 |
|---|---|---|---|
| non-internal IPv4가 0개 | **skip**(실패 아님) | 0 | 사유 출력 + 요약에 "LAN 미검증(인터페이스 없음)" 기록. 계획 단계 실측으로 이 머신에는 `이더넷=10.10.91.90`이 있다 |
| loopback health **실패**(= 서버 자체가 안 뜸) 또는 LAN에서 붙었는데 이후 단언이 깨짐 | **제품 실패** | 1 | 자식 로그·diag와 함께 실패 보고 |
| loopback health는 **성공**인데 같은 포트의 LAN origin만 도달 불가 | **환경 차단**(방화벽 인바운드) | **2** | 아래 안내 커맨드를 출력하고 종료. 제품 결함으로 단정하지 마라 |

환경 차단(exit 2)일 때 출력할 안내(ASCII 규칙 이름 사용 — 관리자 권한 필요):

```
netsh advfirewall firewall add rule name="yh-article-server-verify" dir=in action=allow program="<서버 exe 절대 경로>" enable=yes profile=private,domain
```

- 처리 규율: 방화벽을 허용한 뒤 **재실행해 exit 0을 받는 것이 목표**다. 환경상 허용이 불가능하면 요약에 "LAN 미검증(환경 차단 — 방화벽 인바운드)"로 남기고 step은 계속 진행한다(제품 실패로 계수하지 않는다). 임의로 loopback으로 갈아타 통과시키거나, `--scenario loopback`만 돌린 결과를 "all 통과"로 보고하지 마라.
- **비표시 창에서 DOM 반영이 안 잡힐 때(사전 승인된 재판정)**: 5·8단계(작성 후 행 등장 / 송고 후 행 소멸)가 타임아웃되면 **곧바로 제품 결함으로 단정하지 마라**. Chromium은 표시되지 않은 창의 렌더링·타이머를 스로틀할 수 있다. 정해진 절차는 다음과 같다 — (i) 같은 시나리오를 **`--show`로 1회 재실행**한다, (ii) `--show`에서 통과하면 **"비표시 모드 한계"로 판정**하고 요약에 두 결과를 모두(비표시=타임아웃 Nms / 표시=통과 Mms) 남긴 뒤, 기본 실행에서 그 단계를 `미검증(비표시 창 스로틀)`로 출력하도록 스크립트에 분기를 넣는다, (iii) `--show`에서도 실패하면 **제품 실패**다(exit 1, diag·자식 로그 첨부). 이 재판정은 이미 승인된 절차이므로 별도 문의 없이 수행하고, 결과만 보고하라. 폴링 한도를 무한정 늘리거나 단언을 약화시켜 통과시키는 것은 금지.
- **전역 `WebSocket` 부재**: 명확한 메시지와 함께 실패시킨다(기준선 Node 24에는 존재한다 — 부재는 환경 이상이다). 새 npm 의존성으로 우회하지 마라.
- **수집 라우트 503 경고**: LAN 바인딩 + `COLLECTION_TOKEN` 미설정의 정상 동작이다(phase 60 fail-closed). 실패로 취급하지 말고, 이 스크립트는 수집 라우트를 프로브하지 않는다.

### 6. npm 스크립트

`package.json`의 `scripts`에 `"verify:integration": "node scripts/verify-integration.mjs"` **한 줄만** 추가한다(다른 줄·기존 스크립트 문자열 무수정).

## Acceptance Criteria

```bash
# [1] data snapshot: run BEFORE the dist/verify commands below (size+mtime of news.db, uploads entry count)
node -e "const fs=require('fs'),os=require('os'),p=require('path'),f=p.join(os.tmpdir(),'yh-datasnap.json'),st=fs.existsSync('news.db')&&fs.statSync('news.db'),cur=JSON.stringify([st&&st.size,st&&st.mtimeMs,fs.existsSync('uploads')?fs.readdirSync('uploads').length:null]);if(process.argv[1]=='save'){fs.writeFileSync(f,cur);console.log('SNAP-SAVED '+cur)}else{const b=fs.readFileSync(f,'utf8');console.log((b==cur?'DATA-UNCHANGED-OK ':'DATA-CHANGED-FAIL ')+b+' -> '+cur);process.exit(b==cur?0:1)}" save

# [1b] dist data snapshot: same command as [6] with the last arg "save" (baseline for the before/after rule)
node -e "const fs=require('fs'),os=require('os'),p=require('path'),f=p.join(os.tmpdir(),'yh-distdata.json');const roots=fs.existsSync('dist')?fs.readdirSync('dist'):[];const cur={};for(const r of roots){const d='dist/'+r+'/data';if(fs.existsSync(d))cur[r]=fs.readdirSync(d).sort()}if(process.argv[1]=='save'){fs.writeFileSync(f,JSON.stringify(cur));console.log('DIST-DATA-SAVED '+JSON.stringify(cur))}else{const b=JSON.parse(fs.readFileSync(f,'utf8'));const bad=Object.keys(cur).filter(r=>cur[r].includes('news.db')&&!((b[r]||[]).includes('news.db')));console.log('DIST-DATA before='+JSON.stringify(b)+' after='+JSON.stringify(cur));console.log(bad.length?'DIST-DATA-NEW-DB-FAIL '+bad.join(','):'DIST-DATA-OK');process.exit(bad.length?1:0)}" save

npm run lint
npm test
npm run test:web
npm run build

# [2] build the artifacts under test
npm run dist:server
npm run dist:client

# [3] integration smoke: both scenarios, twice in a row, then loopback alone
node scripts/verify-integration.mjs --scenario all
node scripts/verify-integration.mjs --scenario all
node scripts/verify-integration.mjs --scenario loopback

# [4] npm entry point must work as well (this is how operators will run it)
npm run verify:integration

# [5] arg guards: all four must exit non-zero
node scripts/verify-integration.mjs --nope;               echo "exit=$? (must be non-zero)"
node scripts/verify-integration.mjs --scenario zzz;       echo "exit=$? (must be non-zero)"
node scripts/verify-integration.mjs --timeout abc;        echo "exit=$? (must be non-zero)"
node scripts/verify-integration.mjs --server-exe nope.exe; echo "exit=$? (must be non-zero)"

# [6] dist data folders: BEFORE/AFTER comparison, not an absolute rule.
#     Run with "save" BEFORE [2], then with "compare" after [3]/[4]. Fails only when a data/news.db that did
#     not exist before shows up after. (dist/portable-probe/data/news.db is a legitimate phase-61 artifact.)
node -e "const fs=require('fs'),os=require('os'),p=require('path'),f=p.join(os.tmpdir(),'yh-distdata.json');const roots=fs.existsSync('dist')?fs.readdirSync('dist'):[];const cur={};for(const r of roots){const d='dist/'+r+'/data';if(fs.existsSync(d))cur[r]=fs.readdirSync(d).sort()}if(process.argv[1]=='save'){fs.writeFileSync(f,JSON.stringify(cur));console.log('DIST-DATA-SAVED '+JSON.stringify(cur))}else{const b=JSON.parse(fs.readFileSync(f,'utf8'));const bad=Object.keys(cur).filter(r=>cur[r].includes('news.db')&&!((b[r]||[]).includes('news.db')));console.log('DIST-DATA before='+JSON.stringify(b)+' after='+JSON.stringify(cur));console.log(bad.length?'DIST-DATA-NEW-DB-FAIL '+bad.join(','):'DIST-DATA-OK');process.exit(bad.length?1:0)}" compare

# [7] data snapshot compare: SAME command as [1] with the last arg changed to "compare" (exit 1 = real data touched)
node -e "const fs=require('fs'),os=require('os'),p=require('path'),f=p.join(os.tmpdir(),'yh-datasnap.json'),st=fs.existsSync('news.db')&&fs.statSync('news.db'),cur=JSON.stringify([st&&st.size,st&&st.mtimeMs,fs.existsSync('uploads')?fs.readdirSync('uploads').length:null]);if(process.argv[1]=='save'){fs.writeFileSync(f,cur);console.log('SNAP-SAVED '+cur)}else{const b=fs.readFileSync(f,'utf8');console.log((b==cur?'DATA-UNCHANGED-OK ':'DATA-CHANGED-FAIL ')+b+' -> '+cur);process.exit(b==cur?0:1)}" compare

# [8] source diff scope (NOT a data gate: news.db/uploads are gitignored and never appear here)
git status --porcelain
```

주의: [1b]/[6]은 한글 폴더명을 커맨드에 직접 쓰지 않으려고 `dist/*/data`를 순회하며, **before에 없던 `data/news.db`가 after에 생겼을 때만** 실패한다(`dist/portable-probe/data/news.db`처럼 이전 phase가 남긴 정상 산출물을 오탐하지 않기 위해서다). `--scenario lan`이 exit 2(환경 차단)로 끝난 경우, [3]은 방화벽 허용 후 재실행해 exit 0을 받거나, 불가능하면 그 사실을 요약에 남기고 나머지 AC를 계속 진행한다.

**[1]/[7] 게이트의 의미**: `news.db`·`uploads/`는 `.gitignore` 대상이라 `git status`로는 어떤 변경도 드러나지 않는다(무효 게이트). 실 데이터 무접촉은 크기·mtime·항목 수 비교로만 증명된다.

## 검증 절차

1. 위 AC를 전부 실행한다. `--scenario all` 2회 연속 성공이 이 step의 핵심 게이트다.
2. **실패 주입 검증(검증자가 실제로 잡는지)** — 각각 확인 후 원복하고 결과를 요약에 남겨라:
   - 서버 exe를 띄우지 않은 상태(포트만 죽여) 실행 → 실패로 판정되는가.
   - 클라이언트 config의 serverUrl을 도달 불가 주소로 바꿔 실행 → 실패로 판정되는가.
   - loopback 시나리오에서 `secure-origin-switch` 부재 단언을 반대로 뒤집어 → 실패로 판정되는가(음성 증거가 살아 있는지).
3. 실측 기록: 시나리오별 소요(서버 부팅·클라이언트 첫 화면·전체) / LAN origin과 그때의 `isSecureContext`·`typeof navigator.clipboard` / 클립보드 왕복의 ok·미검증 여부 / 상세보기 팝업 실측 크기 / SSE 반영 지연(작성→행 등장, 송고→행 소멸).
4. `git status --porcelain` 증분이 `scripts/verify-integration.mjs`·`package.json` 뿐인지 확인한다(dist/**는 .gitignore 대상이라 증분에 잡히지 않아야 한다).
5. 아키텍처 체크리스트: `client/**`·`web/**`·`server/**`·`src/**`·`docs/**` 무수정 / `scripts/verify-client.mjs`·`verify-server-exe.mjs`·`dist-*.mjs` 무수정 / DB 스키마·행 변경 0 / 제품 코드에 타이머·egress 신설 0(폴링은 검증 하네스 안에만 있다).
6. `phases/63-integration/index.json`의 step2 status를 갱신한다. **blocked 판정 기준**: 셸·서버 결선 결함으로 스모크가 통과하지 못하는 경우(수정 소유는 step0 또는 phase 밖 — 여기서 고치지 말고 근거와 함께 보고).

## 금지사항

- `scripts/verify-client.mjs`를 import하지 마라(수정도 금지). 이유: 그 파일은 import 즉시 `main()`이 실행되는 CLI라 import하는 순간 예상치 못한 프로세스가 뜬다. 필요한 헬퍼(자식 kill·diag 시퀀스 대기·APPDATA 스냅샷)는 이 스크립트 안에 자체 구현하라.
- 검증을 위해 `client/**`·`web/**`·`server/**`를 고치지 마라. 이유: 검증 실패의 원인이 "제품 결함"인지 "검증 스크립트 결함"인지 격리할 수 없게 된다. 제품 결함은 고치지 말고 보고하라.
- 원격 페이지에 제품 코드로 스크립트를 주입하지 마라(`executeJavaScript`·`insertCSS`를 셸에 추가 금지). 이유: `web/**` 무수정 원칙이 사실상 깨진다. CDP `Runtime.evaluate`는 외부 테스트 하네스이므로 허용되지만, 그 코드가 `client/`로 들어가면 안 된다.
- `DATA_DIR` 없이 서버 exe를 띄우지 마라. 이유: 배포 폴더 옆 `data/news.db`가 생겨 **시드 계정이 담긴 DB가 배포물에 남는다**(자격증명 유출 — phase 61 portable-probe가 세운 규율).
- 리포 루트 `news.db`·`uploads/`·실사용자 `%APPDATA%\기사작성기`에 바인딩하지 마라. 이유: 실 데이터 오염·편집 잠금 잔류의 복구 경로가 없다(DB 비파괴).
- DB를 직접 열어 상태를 만들거나 고치지 마라(시드는 **임시** DB에만). 이유: 검증이 애플리케이션 계약이 아니라 DB 내부 상태에 의존하게 되면 통합 검증의 의미가 사라진다.
- `NODE_ENV=production`·`ALLOWED_ORIGINS`·`FORCE_HTTPS`를 주지 마라. 이유: 평문 HTTP 배치에서 쿠키 Secure·리다이렉트가 켜져 세션이 죽고, 실패 원인이 검증 구성으로 오도된다.
- 이 스크립트를 `test/**`에 넣거나 `npm test` 글롭에 걸리게 하지 마라. 이유: exe 두 개를 띄우는 검증은 수십 초이고, 실패가 단위 테스트 실패로 뭉개진다.
- 새 npm 의존성(puppeteer·playwright·ws 등)을 추가하지 마라. 이유: 의존성 최소화 원칙(ADR-010)이며, Node 24 내장 `fetch`·`WebSocket`으로 충분함이 확인됐다.
- 실패를 재시도로 덮지 마라(고정 폴링 한도는 허용, 무한 재시도·시나리오 자동 완화 금지). 이유: 간헐 실패를 숨기면 통합 게이트가 장식이 된다.
