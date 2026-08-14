# Step 3: client-shell

## 읽어야 할 파일

- `CLAUDE.md` — TDD·아키텍처·커밋 규칙
- `docs/ADR.md` — **ADR-011**(Electron 접속형 셸 — 원격 페이지에 Node 권한 0, 정책은 순수 함수로 뽑아 Electron 없이 단위 테스트). 이 step은 ADR을 **수정하지 않는다**
- `phases/64-exe-backlog/index.json` — scope의 (B-1)(B-2), decisions **(12)(13)(16)(17)(18)**, open_questions (b)
- `client/main.js` — 전체. 특히 헤더 1~8행(정책은 client/lib가 단일 출처라는 계약), `whenReady` 블록 149~175행(현행 `setPermissionRequestHandler` 151~154행)
- `client/lib/secureOrigin.js` — 전체(순수 모듈 스타일). `isTrustedLocalOrigin` 28~37행
- `client/lib/clientConfig.js` — 전체. `readConfigFile` 85~94행, 실제 쓰이는 `readConfigFileSync` 96~107행
- `test/client-secure-origin.test.js`·`test/client-shell-core.test.js` — 순수 모듈 테스트 스타일과, 두 "미사용" export의 테스트 소비자가 실재한다는 근거
- `scripts/dist-client.mjs` 30~31행 — `resources/app` 화이트리스트에 `lib` **디렉토리**가 들어 있다(새 `client/lib/*.js`는 자동 포함된다 — 화이트리스트를 고칠 필요가 없다)

## 배경 (실코드 확인 결과)

- **(B-1)** `client/main.js` 151~154행은 `setPermissionRequestHandler`만 설치한다. Electron 보안 체크리스트는 **check** 핸들러도 함께 두기를 권고한다(권한 "요청"이 아니라 동기 "확인" 경로 — `navigator.permissions.query` 등이 탄다). 지금은 check 경로가 Electron 기본 동작에 맡겨져 있어 request 핸들러가 정의한 정책과 대칭이 아니다.
- 현행 허용 집합은 `clipboard-read`·`clipboard-sanitized-write` 2종이고, 이는 SPA의 붙여넣기·복사 경로가 실제로 쓰는 권한이다. **집합을 넓히지 않는다.**
- 술어가 인라인 조건식으로 main.js 안에 박혀 있어 테스트가 없다 — `client/main.js`는 Electron 의존이라 단위 테스트 대상이 아니고, 이 리포는 정책을 `client/lib/**` 순수 모듈로 뽑아 잠그는 규율을 갖고 있다(main.js 헤더 1~2행, ADR-011).
- **(B-2)** `clientConfig.readConfigFile`(async)과 `secureOrigin.isTrustedLocalOrigin`은 프로덕션 소비자가 0이다(부팅은 `readConfigFileSync`를 쓰고, 스위치 판정은 `decideSecureOriginSwitches` 내부의 `isLoopbackHostname`을 쓴다). 다만 **테스트 소비자는 실재**한다(`test/client-shell-core.test.js` 205~217행, `test/client-secure-origin.test.js` 115~124·248~250행). 제거 대상이 아니라 "의도된 계획 API"임을 주석으로 못 박아 다음 감사에서 같은 지적이 반복되지 않게 한다.

## 작업

### A. 테스트 먼저 (red)

`test/client-permission-policy.test.js`를 신설하고 아래 계약을 red로 작성한다.

### B. `client/lib/permissionPolicy.js` 신설 (순수 모듈 — Electron 비의존)

```js
export const ALLOWED_PERMISSIONS = Object.freeze(['clipboard-read', 'clipboard-sanitized-write']);
export function isAllowedPermission(permission) // 정확 일치만 true, 그 외 전부 false
```

- fail-closed: 비문자열(`null`/`undefined`/숫자/객체)·대소문자 변형·앞뒤 공백이 붙은 값은 전부 `false`.
- 헤더 주석에 (i) 이 2종만 허용하는 이유(SPA 붙여넣기·복사 경로), (ii) **집합을 넓히려면 근거와 함께 별도 결정이 필요하다**는 규율을 남긴다.
- Electron·전역·파일시스템 의존 0(`client/lib/**` 규율).

### C. `client/main.js` 결선 — request/check 대칭

`whenReady` 블록의 현행 `setPermissionRequestHandler` 자리에서:

1. `setPermissionRequestHandler`가 인라인 조건식 대신 `isAllowedPermission(permission)`을 쓰도록 바꾼다(동작 동일 — 판정 단일 출처화).
2. 바로 아래에 `setPermissionCheckHandler`를 추가한다. **동기 boolean 반환**이며 같은 술어를 쓴다(콜백 형태가 아니다 — request와 시그니처가 다르다).
3. 주석 1~2줄: 두 핸들러가 같은 정책을 공유하며 판정 단일 출처는 `client/lib/permissionPolicy.js`라는 사실.
4. main.js의 다른 어떤 부분도 건드리지 않는다(창 정책·IPC·secure-origin 스위치·메뉴·다이얼로그).

### D. 미사용 export 주석 (B-2)

- `client/lib/clientConfig.js`의 `readConfigFile` 위에 1줄: 프로덕션 소비자는 `readConfigFileSync`이며 이 async 버전은 **테스트/미래 소비자용으로 의도적으로 유지**한다.
- `client/lib/secureOrigin.js`의 `isTrustedLocalOrigin` 위에 1줄: 같은 취지(판정 본체는 `decideSecureOriginSwitches`가 쓰고, 이 export는 테스트/미래 소비자용).
- **함수 본문·시그니처·동작은 한 글자도 바꾸지 마라.** 제거도 금지다.

## Acceptance Criteria

```bash
# [1] data snapshot 저장(빌드/실행 전)
node -e "const fs=require('fs'),os=require('os'),p=require('path'),f=p.join(os.tmpdir(),'yh-datasnap.json'),st=fs.existsSync('news.db')&&fs.statSync('news.db'),cur=JSON.stringify([st&&st.size,st&&st.mtimeMs,fs.existsSync('uploads')?fs.readdirSync('uploads').length:null]);if(process.argv[1]=='save'){fs.writeFileSync(f,cur);console.log('SNAP-SAVED '+cur)}else{const b=fs.readFileSync(f,'utf8');console.log((b==cur?'DATA-UNCHANGED-OK ':'DATA-CHANGED-FAIL ')+b+' -> '+cur);process.exit(b==cur?0:1)}" save

node --test test/client-permission-policy.test.js
npm test
npm run lint

# [2] 셸 코드가 바뀌었으므로 배포 폴더를 다시 조립한다(검증은 배포 exe를 돈다)
npm run dist:client

# [3] 새 모듈이 배포물에 실렸는지 — resources/app/lib 목록에 permissionPolicy.js가 있어야 한다
node -e "const fs=require('fs'),p=require('path');const d=fs.readdirSync('dist').map(n=>p.join('dist',n)).find(n=>fs.existsSync(p.join(n,'resources','app','lib')));const l=fs.readdirSync(p.join(d,'resources','app','lib')).sort();console.log(d,JSON.stringify(l));process.exit(l.includes('permissionPolicy.js')?0:1)"

# [4] 실왕복 게이트 — 표시 모드 loopback. exit 0 + notes에 'ok 클립보드 왕복' 이 있어야 한다
#     (권한 핸들러가 클립보드를 조용히 막으면 여기서 red가 된다)
npm run verify:integration -- --scenario loopback --show

# [5] data snapshot 비교
node -e "const fs=require('fs'),os=require('os'),p=require('path'),f=p.join(os.tmpdir(),'yh-datasnap.json'),st=fs.existsSync('news.db')&&fs.statSync('news.db'),cur=JSON.stringify([st&&st.size,st&&st.mtimeMs,fs.existsSync('uploads')?fs.readdirSync('uploads').length:null]);if(process.argv[1]=='save'){fs.writeFileSync(f,cur);console.log('SNAP-SAVED '+cur)}else{const b=fs.readFileSync(f,'utf8');console.log((b==cur?'DATA-UNCHANGED-OK ':'DATA-CHANGED-FAIL ')+b+' -> '+cur);process.exit(b==cur?0:1)}" compare

# [6] diff scope
git status --porcelain
```

`[4]`는 창을 실제로 띄우고 **시스템 클립보드에 검증용 문자열을 쓴다**(phase 63과 동일한 알려진 부수효과 — 사용자 클립보드 내용이 대체된다).

## 검증 절차

1. AC를 전부 실행한다. `[4]`에서 `ok 클립보드 왕복(writeText→readText 일치)` 줄과 `isSecureContext === true`·`navigator.clipboard 표면` 단언이 모두 ok인지 확인한다.
2. `[4]`의 diag/notes에서 **다른 표면이 조용히 막혔는지** 훑는다(로그인·목록 SSE·상세보기 팝업·송고·행 소멸 단언이 전부 ok여야 한다). 이상 징후가 있으면 그 사실을 요약에 적고 `setPermissionCheckHandler` 도입 여부를 **되돌릴지** 판단한다(추측으로 허용 집합을 넓히지 마라 — open_questions (b)).
3. **변이 검증 3종**(각각 red 확인 후 원복): (a) `isAllowedPermission`이 항상 true → 단위 테스트 red, (b) 허용 집합에서 `clipboard-sanitized-write` 제거 → 단위 테스트 red(그리고 `[4]`의 왕복이 실패하는지도 1회 관찰하면 결선까지 실증된다), (c) 대소문자 무시 비교로 바꿈 → red.
4. 실측 기록: `npm run dist:client` 소요·파일 수·바이트, `[4]` 총 소요와 클립보드 왕복 결과, 그 밖에 막힌 표면이 있으면 그 사실.
5. `git status --porcelain` 증분이 소유 파일(`client/lib/permissionPolicy.js`·`client/main.js`·`client/lib/clientConfig.js`·`client/lib/secureOrigin.js`·`test/client-permission-policy.test.js`·`phases/64-exe-backlog/index.json`)뿐인지 확인한다.
6. 아키텍처 체크리스트: 원격 창에 preload·nodeIntegration 0(불변) · `client/preload.cjs`·`client/menu.js`·`client/ipcGuard.js`·`client/diag.js`·`client/pages/**` 무수정 · `client/package.json` 무수정(버전 포함) · `web/**`·`src/**`·`server/**`·`scripts/**`·`docs/**` 무수정 · dependencies·devDependencies 불변 · DB 무접촉(`[1]`/`[5]`).
7. `phases/64-exe-backlog/index.json`의 step3 status를 갱신한다.

## 금지사항

- 허용 권한 집합을 넓히지 마라(`media`·`notifications`·`geolocation`·`fullscreen`·`openExternal` 등). 이유: 현행 request 핸들러가 확정한 집합이 곧 제품의 권한 표면이고, 확대는 근거·실측이 필요한 별도 결정이다.
- `setPermissionCheckHandler`를 콜백 스타일로 쓰지 마라. 이유: 이 핸들러는 **동기 boolean 반환**이다 — 콜백을 부르면 반환값이 `undefined`가 되어 의도와 다른 판정이 된다.
- 권한 판정을 `client/main.js`에 인라인으로 남기지 마라. 이유: main.js 헤더 계약과 ADR-011이 "정책은 `client/lib` 순수 모듈 단일 출처"로 못 박았고, Electron 의존 파일은 단위 테스트로 잠글 수 없다.
- `readConfigFile`·`isTrustedLocalOrigin`을 제거하거나 시그니처를 바꾸지 마라. 이유: 테스트 소비자가 실재하고(계획된 API), 제거는 계약 축소다(decisions (13)).
- `client/main.js`의 secure-origin 스위치·창 정책·IPC 가드·부팅 순서(userData → 단일 인스턴스 잠금)를 건드리지 마라. 이유: phase 62·63이 실측으로 확정한 계약이며, 순서가 뒤집히면 실사용자 프로필 오염과 스모크 거짓 통과가 발생한다.
- `scripts/dist-client.mjs`의 화이트리스트를 고치지 마라. 이유: `lib` 디렉토리가 통째로 들어 있어 새 파일이 자동 포함된다(실코드 확인). 목록을 건드리면 배포물 위생 게이트의 집합 비교가 흔들린다.
- `--show` 검증을 건너뛰고 표면 존재(`typeof navigator.clipboard`)만으로 통과 판정하지 마라. 이유: 이 step의 위험은 정확히 "권한 핸들러가 실제 호출을 조용히 거부하는 것"이고, 표면 존재는 그것을 잡지 못한다.
