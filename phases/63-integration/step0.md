# Step 0: secure-origin

## 읽어야 할 파일

- `CLAUDE.md` — 개발 프로세스(TDD)·DB 비파괴·아키텍처 규칙
- `docs/ADR.md` — **ADR-008**(앱 내 타이머·egress 0)·**ADR-011**(클라이언트 셸 결정·트레이드오프. 이 step은 ADR을 **수정하지 않는다** — 정정은 step3 소유)
- `phases/63-integration/index.json` — decisions (1)(2)(3)(4)(16), open_questions (d)
- `phases/62-client-exe/index.json` — open_questions **(b)**(secure context 3안과 실측 근거), decisions (2)(11)(14)
- `client/main.js` — 부팅 순서(52~60행: `setPath('userData')` → 단일 인스턴스 잠금 → `wireApp()`), `wireApp()`(62~158행), IPC `saveServer`(111~122행), `app.whenReady()` 블록(131~157행), 권한 핸들러(134~136행)
- `client/lib/clientConfig.js` — `parseConfig`·`readConfigFile`·`configPath` 계약(화이트리스트·throw 금지)
- `client/lib/serverUrl.js` — `normalizeServerUrl`(origin은 `new URL()`로만 만든다)
- `client/diag.js` — redact 계약. **스칼라(string·number·boolean·null)만 기록되고 배열·객체 필드는 버려진다**(36행)
- `test/client-shell-core.test.js` — 이 리포의 순수 모듈 테스트 스타일(node:test, describe 블록)
- `test/client-shell-main.test.js` — phase 62 step1이 만든 **보조 순수 모듈(menu·ipcGuard·diag) 단위 테스트 21케이스**다(Electron 비의존). `client/main.js` 소스 문자열을 잠그는 게이트는 **존재하지 않는다** — main.js 결선의 안전망은 이 파일이 아니라 `scripts/verify-client.mjs`의 실기 스모크다
- `scripts/verify-client.mjs` — **읽기만 한다. 수정 금지**(phase 62 게이트 동결). 시나리오 A/B가 이 step의 회귀 감시자다

## 배경

phase 62 D-4 실측: `http://127.0.0.1:<port>`에서는 `isSecureContext === true`이고 클립보드가 완전히 동작했지만, `http://10.10.91.90:<port>`(LAN)에서는 `isSecureContext === false`이고 **`navigator.clipboard`가 `undefined`** 였다. SPA는 목록 우클릭 본문복사/제목만복사(`web/src/view/ListPage.jsx` 50행)와 에디터 붙여넣기 경로에서 이 API를 쓴다. 사용자 확정(2026-08-13)에 따라 **설정된 서버 출처가 http이고 loopback이 아닐 때, 그 출처 하나만** secure context로 취급하는 Chromium 스위치를 부팅 시 적용한다.

두 가지 물리적 제약이 설계를 결정한다.

1. `app.commandLine.appendSwitch`는 **app ready 전에** 불러야 Chromium에 반영된다. 그런데 스위치 값(= 서버 origin)은 설정 파일에 있고, 현재 설정은 `app.whenReady()` 안에서 비동기로 읽힌다 → **ready 전 동기 읽기**가 필요하다.
2. 스위치는 프로세스 수명 동안 1회뿐이다 → **주소를 바꾸면 재시작이 필요**하다(자동 재시작은 채택하지 않는다).

## 작업

아래 1 → 2 → 3 → 4 순서를 지켜라. 테스트가 먼저다.

### 1. 테스트 먼저 — `test/client-secure-origin.test.js` (신규)

`node --test`로 red를 확인한 뒤 구현으로 넘어간다. 최소 케이스 집합:

- `decideSecureOriginSwitches` 적용 **안 함**: `null`·비문자열·빈 문자열(`reason:'no-origin'`) / 파싱 불가 문자열(`'invalid'`) / `https://news.example.com`(이미 secure) / `http://localhost:3001` · `http://127.0.0.1:3001` · `http://127.5.5.5:3001` · `http://[::1]:3001` · `http://app.localhost:3001`(loopback 계열) / `file:`·`ftp:` 등 http(s) 밖 스킴
- `decideSecureOriginSwitches` 적용 **함**: `http://10.10.91.90:3001` · `http://192.168.0.10` (기본 포트 생략) · `http://news-server:3001`(호스트명) · `http://NEWS-Server:3001`(대문자 → 소문자 정규화) — 각각 반환된 스위치 목록이 **정확히** `unsafely-treat-insecure-origin-as-secure=<정규화 origin>` + `enable-features=<병합된 값>` 두 개이고, 첫 스위치 값이 **`new URL(입력).origin`과 문자열 동일**한지 단언
- `mergeFeatureValue`: 빈 기존 값 → 기능 하나만 / 기존 `'FooFeature'` → `'FooFeature,OverrideSecurityRestrictionsOnInsecureOrigin'` / 기존에 이미 그 기능이 있으면 **중복 추가 없음** / 앞뒤 공백·빈 토큰 정리
- **fail-closed**: origin 문자열에 콤마·공백·`*`가 섞여 들어오면(손으로 편집된 config 방어) 적용하지 않는다(`reason:'unsafe-value'`)
- `127.0.0.1.evil.com` 같은 접두 위장 호스트는 loopback이 **아니다**(= 스위치 적용 대상). 판정이 `startsWith('127.')`가 아니라 점4자리 IP 형태여야 한다는 잠금(server/index.js `isLoopbackHost`의 규율과 동형)
- `requiresRestartForOrigin(appliedOrigin, nextOrigin)`: (미적용 → LAN) true / (LAN A → LAN B) true / (LAN A → 같은 LAN A) false / (LAN A → loopback) false(새 출처가 스위치를 요구하지 않으므로 재시작 불필요) / (미적용 → loopback) false
- `readConfigFileSync`: 정상 파일 → `parseConfig`와 동일 결과 / 파일 없음(throw) → 기본값 / 깨진 JSON → 기본값 / **어떤 입력에도 throw하지 않음**

### 2. `client/lib/secureOrigin.js` (신규 — Electron·fs·전역 비의존 순수 모듈)

```js
export const SECURE_ORIGIN_SWITCH = 'unsafely-treat-insecure-origin-as-secure';
export const FEATURE_SWITCH = 'enable-features';
export const SECURE_ORIGIN_FEATURE = 'OverrideSecurityRestrictionsOnInsecureOrigin';

export function isTrustedLocalOrigin(origin) // → boolean
export function decideSecureOriginSwitches(origin, { existingFeatures = '' } = {})
//   → { apply: false, reason: 'no-origin'|'invalid'|'unsupported-scheme'|'already-secure'|'loopback'|'unsafe-value' }
//   → { apply: true, origin, switches: [{ name, value }, { name, value }] }
export function mergeFeatureValue(existingFeatures, feature) // → 콤마 병합·중복 제거된 enable-features 값
export function requiresRestartForOrigin(appliedOrigin, nextOrigin) // → boolean
```

- origin 해석은 **`new URL()`만** 쓴다(문자열 자르기·정규식 조립 금지 — serverUrl.js 머리말과 같은 이유).
- **스위치 값은 `new URL(input).origin`이 만든 정규화 origin이다**(입력 문자열 그대로가 아니다). 즉 호스트 소문자화·기본 포트 생략·경로/쿼리 제거가 적용된 값 하나이고, 반환 객체의 `origin` 필드와 첫 스위치의 `value`는 **같은 문자열**이어야 한다. 근거: Chromium은 이 스위치 값을 origin 문자열로 정확히 비교하므로, 정규화되지 않은 값을 넣으면 조용히 매칭되지 않는다.
- loopback 판정: `localhost`, `*.localhost`, 점4자리 `127.x.x.x`, `[::1]`. 그 외는 전부 비-loopback이다.
- 스위치 값은 **출처 하나**다. 목록·와일드카드·서브도메인 확장을 만들지 마라.
- **`enable-features`는 덮어쓰지 않고 병합한다.** 다른 코드·Chromium 기본값이 이미 이 스위치를 갖고 있으면 `appendSwitch`로 덮어쓸 때 기존 기능 플래그가 사라진다. 그래서 결선부가 `app.commandLine.getSwitchValue('enable-features')`를 읽어 `existingFeatures`로 넘기고, **병합 판정(콤마 결합·중복 제거·빈 값 처리)은 순수 모듈이 한다**(`mergeFeatureValue`). main.js는 결과 문자열을 그대로 append만 한다.
- `requiresRestartForOrigin`은 `decideSecureOriginSwitches(nextOrigin).apply === true && next.origin !== appliedOrigin`일 때만 true다.

### 3. `client/lib/clientConfig.js` — `readConfigFileSync` 추가(추가만)

```js
export function readConfigFileSync(filePath, { readFileSync }) // → parseConfig 결과(실패는 기본값, throw 금지)
```

기존 `parseConfig`를 그대로 재사용한다. `parseConfig`·`serializeConfig`·`readConfigFile`·`writeConfigFile`·`sanitizeBounds`의 시그니처와 동작은 **한 글자도 바꾸지 마라**(phase 62 테스트 60케이스가 잠그고 있다).

### 4. `client/main.js` 결선 (정책 재구현 금지 — 위 모듈을 호출만 한다)

- `wireApp()` 최상단, `configFile = configPath(...)` 직후(즉 **ready 전**):
  1. `bootConfig = readConfigFileSync(configFile, { readFileSync: (f, enc) => fs.readFileSync(f, enc) })`
  2. `const decision = decideSecureOriginSwitches(bootConfig.serverUrl, { existingFeatures: app.commandLine.getSwitchValue('enable-features') })`
  3. `decision.apply`면 각 스위치를 `app.commandLine.appendSwitch(name, value)`로 붙이고(값은 모듈이 준 문자열 그대로 — 여기서 콤마 조립·중복 제거를 하지 마라), 적용한 origin을 모듈 변수(`appliedSecureOrigin`)에 보관한다.
  4. `diag.log('secure-origin-switch', { origin: decision.origin, count: decision.switches.length })` — **스칼라만**(배열·객체를 넣으면 redact가 버린다). 미적용일 때는 이 이벤트를 남기지 마라(음성 증거가 검증의 단언 대상이다).
- `app.whenReady()` 블록: `await readConfigFile(...)` 대신 **`bootConfig`를 그대로 쓴다**(같은 부팅에서 두 번 읽지 않는다 — decisions (3)). `readConfigFile` import가 미사용이 되면 import에서 제거하라(lint). 모듈 export 자체는 유지한다.
- `saveServer` 성공 경로(`persistConfig()` 이후, `createAppWindow` 호출과 함께):
  - `requiresRestartForOrigin(appliedSecureOrigin, norm.origin)`이 true면 `diag.log('restart-required', { origin: norm.origin })` + 재시작 안내 다이얼로그를 **1회** 띄운다.
  - **가장 흔한 경로는 '주소 변경'이 아니라 '최초 설정'이다**: 설정이 없던 첫 실행은 부팅 시 적용한 스위치가 없으므로(`appliedSecureOrigin === null`) LAN 주소를 처음 저장하는 순간 이 조건이 참이 된다. 즉 **신규 배포 PC 전원이 첫 설정 직후 재시작 1회를 겪는다**. 문구는 그 상황에서도 자연스러워야 한다(예: "서버 주소를 저장했습니다. 복사·붙여넣기 기능을 사용하려면 프로그램을 한 번 껐다 켜 주세요."). "주소를 바꿨으니"라는 식의 변경 전제 문구를 쓰지 마라.
  - 다이얼로그로 **IPC 응답을 막지 마라**(`await dialog.showMessageBox(...)`를 handler 반환 앞에 두면 설정 화면이 멈춘 것처럼 보인다). `SELFTEST`(`CLIENT_SELFTEST==='1'`)에서는 다이얼로그를 띄우지 말고 diag만 남긴다(자동 검증이 대화상자에 걸려 멈춘다).
- **정책 상수·판정식을 main.js에 인라인하지 마라**(스위치 이름 문자열도 모듈 상수를 import해서 쓴다).

### 5. 실측 — LAN 출처에서 실제로 풀리는지 확인(이 step의 핵심 산출 사실)

임시 DATA_DIR로 시드 서버를 `HOST=<LAN IPv4>`로 띄우고(패턴: `scripts/verify-client.mjs` 159~182행), 임시 `CLIENT_USER_DATA`에 `config.json`(`{"schemaVersion":1,"serverUrl":"http://<lanIp>:<port>"}`)을 심은 뒤, `--remote-debugging-port=<n>`을 붙여 `electron client`를 기동하고 CDP `Runtime.evaluate`로 다음을 읽어라(스크래치패드 스크립트로 — 리포에 커밋하지 않는다. 자동화 정식 편입은 step2 소유).

- `window.isSecureContext` / `typeof navigator.clipboard` / `typeof navigator.clipboard?.readText` / `typeof navigator.clipboard?.read`
- 같은 방식으로 **loopback 출처**(`http://127.0.0.1:<port>`)도 측정해 회귀가 없는지 본다(diag에 `secure-origin-switch`가 **없어야** 한다).

**폴백 사다리**(위에서부터 시도하고, 성공한 단에서 멈춘다. 각 단은 순수 모듈 + 테스트를 함께 갱신한다):

1. 스위치 2개(위 설계) → `isSecureContext === true` + `navigator.clipboard` 존재면 **완료**.
2. 안 되면 `disable-site-isolation-trials` 스위치를 목록에 추가(값 없음)하고 재측정.
3. `isSecureContext`는 true인데 `clipboard.read()`가 권한 오류면, `session.defaultSession.setPermissionCheckHandler`를 기존 request 핸들러와 **대칭**으로 추가한다(`clipboard-read`·`clipboard-sanitized-write`만 true, 나머지 false — phase 62 백로그 항목). 대칭이 아닌 확장(다른 권한 허용)은 금지.
4. 전부 실패하면 **코드를 되돌리지 말고** 측정값(스위치 적용 여부·`isSecureContext`·`navigator.clipboard` 타입·Electron/Chromium 버전)을 요약에 남기고 `blocked`로 보고한다. 임의의 추가 완화(webSecurity:false 등)로 통과시키지 마라.

## Acceptance Criteria

```bash
# [1] data snapshot: run BEFORE any electron/server run below (saves size+mtime of news.db and uploads count)
node -e "const fs=require('fs'),os=require('os'),p=require('path'),f=p.join(os.tmpdir(),'yh-datasnap.json'),st=fs.existsSync('news.db')&&fs.statSync('news.db'),cur=JSON.stringify([st&&st.size,st&&st.mtimeMs,fs.existsSync('uploads')?fs.readdirSync('uploads').length:null]);if(process.argv[1]=='save'){fs.writeFileSync(f,cur);console.log('SNAP-SAVED '+cur)}else{const b=fs.readFileSync(f,'utf8');console.log((b==cur?'DATA-UNCHANGED-OK ':'DATA-CHANGED-FAIL ')+b+' -> '+cur);process.exit(b==cur?0:1)}" save

node --test test/client-secure-origin.test.js
npm test
npm run lint
npm run test:web
npm run build

# [2] purity gate: no electron/fs/require in the pure module (prints PURE-OK on success, exit 1 on failure)
! grep -q -E "electron|node:fs|require\(" client/lib/secureOrigin.js && echo "PURE-OK"

# [3] wiring gate: switch name strings must NOT be hardcoded in main.js (prints NO-INLINE-OK)
! grep -q -E "unsafely-treat-insecure-origin-as-secure|OverrideSecurityRestrictionsOnInsecureOrigin" client/main.js && echo "NO-INLINE-OK"

# [4] informational: line positions to eyeball that appendSwitch sits OUTSIDE the whenReady block
grep -n "appendSwitch\|whenReady\|readConfigFileSync\|getSwitchValue" client/main.js

# [5] regression: phase 62 smoke (config present / absent / unreachable), twice in a row
node scripts/verify-client.mjs --dev --scenario all
node scripts/verify-client.mjs --dev --scenario all

# [6] data snapshot compare: SAME command as [1] with the last arg changed to "compare" (exit 1 = real data touched)
node -e "const fs=require('fs'),os=require('os'),p=require('path'),f=p.join(os.tmpdir(),'yh-datasnap.json'),st=fs.existsSync('news.db')&&fs.statSync('news.db'),cur=JSON.stringify([st&&st.size,st&&st.mtimeMs,fs.existsSync('uploads')?fs.readdirSync('uploads').length:null]);if(process.argv[1]=='save'){fs.writeFileSync(f,cur);console.log('SNAP-SAVED '+cur)}else{const b=fs.readFileSync(f,'utf8');console.log((b==cur?'DATA-UNCHANGED-OK ':'DATA-CHANGED-FAIL ')+b+' -> '+cur);process.exit(b==cur?0:1)}" compare

# [7] source diff scope (NOT a data gate: news.db/uploads are gitignored and can never show up here)
git status --porcelain
```

**[1]/[6] 게이트의 의미**: `news.db`·`uploads/`는 `.gitignore` 대상이라 `git status`로는 **어떤 변경도 드러나지 않는다**(무효 게이트). 실 데이터 무접촉은 크기·mtime·항목 수 스냅샷 비교로만 증명된다. [6]이 `DATA-CHANGED-FAIL`이면 즉시 실패로 판정하고, 무엇이 리포 DB에 붙었는지 찾을 때까지 진행하지 마라.

`npm run test:web` 비고정 실패 규약: 1건이 비고정으로 실패하면 최대 2회 재실행 + 단독 실행으로 판정한다(green이면 통과, 사실을 요약에 남긴다).

## 검증 절차

1. 위 AC를 전부 실행한다. `npm test`는 기준선 1180 + 신규 케이스 수와 일치해야 한다.
2. **변이 검증 4종**(각각 red 확인 후 원복, 요약에 red 건수 기록):
   - loopback 판정을 항상 false로 → red(loopback 케이스 다수)
   - 스위치 값을 `origin` 대신 `'*'`로 → red
   - `unsafe-value` fail-closed 가드 제거 → red
   - `readConfigFileSync`가 예외를 그대로 던지게 → red
3. **5절 실측**을 수행하고 결과를 "정상 / 폴백 N단에서 해결(무엇을 추가했는지) / 실패(측정값)" 중 하나로 요약에 남긴다. LAN·loopback 두 출처의 `isSecureContext`·`navigator.clipboard` 타입을 **수치·문자열 그대로** 기록하라(step3의 ADR-011 정정과 체크리스트가 이 값을 인용한다).
4. `git status --porcelain` 증분이 `client/lib/secureOrigin.js`·`client/lib/clientConfig.js`·`client/main.js`·`test/client-secure-origin.test.js` 뿐인지 확인한다(시작 시점 스냅샷 대비 증분 — 절대 목록 비교 금지).
5. 아키텍처 체크리스트: `package.json` 무수정 / `web/**`·`server/**`·`src/**`·`docs/**` 무수정 / DB 스키마·행 변경 0 / 앱 내 타이머·주기 통신·egress 신설 0(스위치는 부팅 1회 정적 설정) / 원격 창의 preload·nodeIntegration 계약 불변.
6. `phases/63-integration/index.json`의 step0 status를 갱신한다. 중간 실패 시 만든 파일을 지우지 말고 어디까지 됐는지 error_message에 남겨라(후속 세션이 증분 대조로 잔여만 완결한다).

## 금지사항

- `app.commandLine.appendSwitch`를 `app.whenReady()` 안이나 그 이후에 부르지 마라. 이유: ready 이후의 append는 Chromium에 반영되지 않아 **조용히 무효**가 되고, 테스트로는 잡히지 않는 채 LAN 배포에서만 실패한다.
- 스위치 값에 콤마 목록·와일드카드·복수 출처·서브도메인 패턴을 넣지 마라. 이유: 사용자 확정 범위는 "설정된 그 출처 하나"이며, 목록을 허용하면 손으로 편집된 config 한 줄이 임의 사이트에 secure context를 부여한다.
- `webSecurity:false`·`allow-running-insecure-content`·`certificate-error` 우회·`--ignore-certificate-errors`를 쓰지 마라. 이유: 이 phase가 채택한 것은 출처 1개 한정 완화지 전역 완화가 아니다(ADR-011 보안 모델 붕괴).
- `app.relaunch()`/자동 재시작을 넣지 마라. 이유: 포터블 폴더 + 단일 인스턴스 잠금 재획득 조합에서 예측 못한 재기동 루프 위험이 있고, 사용자 확정은 "재시작 필요를 문서화 + 가능하면 안내"까지다.
- `client/lib/secureOrigin.js`의 판정을 `client/main.js`에서 다시 구현하지 마라(스위치 이름 문자열 포함). 이유: 판정이 두 곳으로 갈라지면 단위 테스트가 잠근 규칙이 실행 경로에서 무력화된다.
- `scripts/verify-client.mjs`를 수정하지 마라. 이유: phase 62가 확정한 회귀 게이트다 — 검증자를 고쳐 통과시키면 회귀 감시가 사라진다.
- `web/**`·`server/**`·`src/**`·`docs/**`·`package.json`·`client/package.json`을 수정하지 마라. 이유: 각각 다른 소유자(무수정 원칙 / step1 / step3)이며, 이 step의 실패 원인을 격리할 수 없게 된다.
- 실사용자 `%APPDATA%\기사작성기`를 쓰거나 지우지 마라. 이유: 사용자의 실제 서버 설정이 날아가고, 실측이 실환경 상태에 오염된다. 실측은 반드시 임시 `CLIENT_USER_DATA`로 한다.
- 리포 루트 `news.db`·`uploads/`에 바인딩하지 마라. 이유: 실 데이터 오염·편집 잠금 잔류의 복구 경로가 없다(DB 비파괴).
- 실측 스크립트를 리포에 커밋하지 마라(스크래치패드에서만). 이유: 검증 스크립트의 정식 위치·계약은 step2 소유이며, 중복 검증자가 생기면 어느 쪽이 진실인지 사라진다.
