# Step 3: dist-pipeline

## 읽어야 할 파일

- `CLAUDE.md`, `docs/ADR.md`(ADR-010 — 빌드 도구는 런타임 의존성 축이 아니다 / 폴백은 명시 플래그로만), `docs/ARCHITECTURE.md`("배포 산출물" 절)
- `phases/62-client-exe/index.json` — decisions (5)(6)(7)(15), open_questions (a)
- `phases/62-client-exe/step1.md` + **step1 산출물**: `client/package.json`·`client/main.js`·`client/preload.cjs`·`client/menu.js`·`client/ipcGuard.js`·`client/diag.js`·`client/pages/**`·`client/lib/**`
- `phases/62-client-exe/step2.md` + **step2 산출물** `scripts/verify-client.mjs`(시나리오 A/B) — 이 step은 그 스크립트를 `--exe`로 **수정 없이** 재사용한다
- `scripts/dist-server.mjs` — 이 리포의 배포 폴더 조립 표준(경로 가드 · 알려진 산출물만 정리 · 화이트리스트 복사 · `packaging/<대상>/**` 통째 복사 · 요약 출력 · CLI 인자 파싱). **이 step은 그 형태를 그대로 따른다.**
- `scripts/sea-build.mjs` — CLI/모듈 겸용 구조와 실패 메시지 규율(어떤 커맨드가 무슨 코드로 실패했는지)
- `.gitignore` — `dist/`가 이미 무시된다(수정 금지)

## 배경 (실측 사실)

- `electron` devDependency는 설치 시 플랫폼 런타임을 `node_modules/electron/dist/`에 풀어 놓는다. 이 폴더는 **그 자체로 실행 가능한 Electron 런타임**이다(`electron.exe` + `resources/` + `locales/` + `*.pak`/`*.dll` + `version`).
- Electron 실행 파일은 부팅 시 `resources/app.asar` → 없으면 `resources/app/` 순으로 앱을 찾고, 둘 다 없으면 `resources/default_app.asar`(기본 안내 화면)를 띄운다. 즉 **런타임 폴더 복사 → `electron.exe` 이름 변경 → `resources/app/`에 셸 코드 배치 → `default_app.asar` 제거**면 포터블 클라이언트가 완성된다.
- 2026-08-13 실측(npm 레지스트리 조회): `electron@43.4.0`, `@electron/packager@20.3.0`(deps 18개 — macOS 서명/공증 포함), `electron-builder@26.15.3`(app-builder-lib·7zip 바이너리 등 대형 트리 + 자동 업데이트 내장).
- phase 61 선례: 서버 exe도 외부 패키저 없이 esbuild+postject로 **직접 조립**했다.

## 작업

### 1. `scripts/dist-client.mjs` (신규)

```js
export async function distClient({
  outDir = 'dist/기사작성기',
  exeName = '기사작성기.exe',
} = {}) // → { outDir, exeName, electronVersion, files, bytes, elapsedMs }
```

CLI: `node scripts/dist-client.mjs [--out <dir>] [--name <exe>]`. 마지막에 요약 1줄(+JSON)을 stdout에 출력한다.

절차(각 단계 실패 시 **무엇이 왜 실패했는지** stderr에 남겨라 — 조용한 실패 금지):

1. **경로 가드(삭제 로직보다 먼저)**: `outDir`를 절대화해 리포의 `dist/` 하위가 아니면 즉시 거부한다.
2. **Electron 런타임 해석**: `createRequire(import.meta.url).resolve('electron')` → 그 디렉토리의 `dist/`를 런타임 폴더로 잡는다. `electron.exe`가 없으면 **명확한 메시지로 실패**시켜라("electron 런타임이 없다 — `npm install`로 내려받아야 한다: <경로>"). 경로 하드코딩 금지. `electron/package.json`의 버전을 읽어 요약에 싣는다.
3. **정리**: `outDir`가 이미 있으면 **이 스크립트의 산출물인지 확인한 뒤에만** 비운다(판정: `<outDir>/resources/app/package.json` 또는 `<outDir>/<exeName>`·`<outDir>/electron.exe` 존재). 판정 실패 시 삭제하지 말고 실패시켜라.
   - 클라이언트 배포 폴더에는 **사용자 데이터가 없다**(설정은 %APPDATA% 아래 `기사작성기`) — 서버의 `data/` 보존 규칙에 해당하는 대상이 없다는 사실을 주석에 남겨라.
4. **런타임 복사**: `node_modules/electron/dist/**` → `outDir` 전체 복사(`locales/`·`*.pak`·`*.dll`·`version`·`LICENSE*` 포함. 임의로 파일을 빼지 마라 — 무엇이 필수인지 추측하면 다른 PC에서 기동 실패로 나타난다).
5. **실행 파일 이름 변경**: `<outDir>/electron.exe` → `<outDir>/<exeName>`(한글). 실패 시 ASCII 폴백(`article-client.exe`)으로 내려가고 그 사실을 반환값과 stderr에 남겨라(phase 61 step1의 한글 rename 규율과 동형).
6. **앱 코드 배치**: `<outDir>/resources/default_app.asar` 삭제 → `<outDir>/resources/app/` 생성 → **화이트리스트만** 복사한다:
   - `client/package.json` · `client/*.js`(main·menu·ipcGuard·diag) · `client/preload.cjs` · `client/lib/**` · `client/pages/**`
   - **CRITICAL**: 목록 밖의 무엇도 복사하지 마라. 특히 `server/`·`src/`·`test/`·`docs/`(`news.md` 포함)·`phases/`·`packaging/server/`·`node_modules/`·`web/`·`news.db`(-wal/-journal)·`.env`·`uploads/`는 **절대** 들어가면 안 된다(사내 스펙·서버 코드·운영 데이터 유출).
   - 복사 후 `resources/app/`의 **최상위 항목 집합**을 반환값에 담아라(AC가 집합 비교로 자동 판정한다).
7. **`packaging/client/**` 사본**: 폴더가 있으면 내용 전체를 `outDir` 루트로 복사한다(목록 하드코딩 금지 — step4가 추가할 `README-배포-클라이언트.md`가 자동 포함되게). 없으면 경고 1줄만 남기고 계속 진행한다(step3 시점에는 아직 없다).
8. **위생 게이트(필수)**: 조립 후 `outDir`를 재귀 스캔해 금지 패턴이 하나라도 있으면 **실패**시켜라 — `news.db`, `.env`, `*.db-wal`, `docs/`, `server/`, `src/`, `test/`, `phases/`, `node_modules/`, `default_app.asar`. 화이트리스트 복사의 이중 안전장치다.
9. **요약**: `{ outDir, exeName, electronVersion, appEntries, fileCount, bytes, elapsedMs }` 반환 + 사람이 읽을 1줄 출력.

**하지 않는 것(명시)**: `vite build`·`web/dist` 복사를 하지 않는다 — 클라이언트는 SPA를 **서버에서 받아 온다**(접속형). 서버 산출물(`dist/기사작성기-server/`)도 건드리지 않는다.

### 2. `package.json` — `scripts`에 한 줄

- `"dist:client": "node scripts/dist-client.mjs"` **한 줄만** 추가한다. `devDependencies`(electron)와 `client:dev`는 step1이 이미 넣었다 — 건드리지 마라.

### 3. 패키지 산출물 실기 검증

step2의 `scripts/verify-client.mjs`를 **수정 없이** `--exe`로 재사용한다. **시나리오 A와 B를 모두** 돌린다 — 시나리오 B(설정 화면 + `ipc{channel:'getState',trusted:true}`)가 **패키지에 `pages/`·`preload.cjs`가 빠졌는지를 자동으로 잡는 유일한 게이트**다(시나리오 A는 원격 페이지만 열어 로컬 자산 누락을 못 본다).

검증 스크립트가 부족해 통과시키지 못하겠으면 **무엇이 부족한지 기록하고 보고**하라(diag 이벤트 이름 변경 금지 — step1이 단일 출처).

### 4. 실측 기록 (요약에 남긴다)

- 배포 폴더 크기(바이트·MB)·파일 수, 조립 소요, zip 압축 시 대략 크기.
- exe 기동 → `did-finish-load` 소요(시나리오 A).
- **한글 폴더명/파일명**(`dist/기사작성기/기사작성기.exe`)이 복사·rename·실행에서 정상인지.
- `resources/app/`에 실제로 들어간 항목 목록(화이트리스트와 1:1 대조 결과).
- exe 파일 속성의 제품명/설명이 여전히 `Electron`인지 여부(리소스 메타 편집은 이 phase 밖 — 사실만 기록, open_questions (a)).
- 다른 폴더(예: `C:\Temp\기사작성기\`)로 폴더째 복사해 실행했을 때도 뜨는지(**폐기 가능한 사본에서만**).

### 5. 폴백 분기 (decisions (5) — 명시 기록 후에만)

직접 조립이 실패하는 경우(`default_app.asar` 제거 후 부팅 불가, rename한 exe가 런타임을 못 찾음, 파일 잠금으로 복사 실패 등)에 한해 `@electron/packager`를 **devDependency로 추가**해 같은 산출물(무설치 폴더)을 만드는 경로로 전환한다.

- 전환 조건: 실패를 **재현 커맨드와 함께 요약에 기록**한 뒤에만. 자동 폴백 금지.
- 전환해도 산출 형태는 동일해야 한다: `dist/기사작성기/기사작성기.exe` + `resources/**`, 서명·자동 업데이트·설치 관리자 없음.
- `electron-builder`는 선택하지 마라(만들지 않기로 한 기능 중심의 대형 트리). 필요하면 open_question으로 올려라.

## Acceptance Criteria

```bash
npm run lint                 # clean (scripts/**는 eslint ignore 대상)
npm test                     # 기준선 그대로, 실패 0
npm run test:web             # 2368/2368 무영향
npm run build                # clean (검증 스크립트가 web/dist를 쓴다)

npm run dist:client                                   # → dist/기사작성기/ 생성
node scripts/verify-client.mjs --exe "dist/기사작성기/기사작성기.exe" --scenario all   # A(원격) + B(설정 화면·IPC 왕복)

# 재실행 멱등
npm run dist:client && node scripts/verify-client.mjs --exe "dist/기사작성기/기사작성기.exe" --scenario all

# 위생 게이트(자동 판정)
node -e 'const fs=require("node:fs");const dir="dist/기사작성기/resources/app";const got=fs.readdirSync(dir).sort();const want=["diag.js","ipcGuard.js","lib","main.js","menu.js","package.json","pages","preload.cjs"].sort();const ok=got.length===want.length&&got.every((v,i)=>v===want[i]);if(!ok){console.error("MISMATCH got="+got.join(",")+" want="+want.join(","));process.exit(1);}console.log("APP-ENTRIES-OK");'
test ! -e "dist/기사작성기/resources/default_app.asar" && echo "NO-DEFAULT-APP-OK"
test ! -e "dist/기사작성기/news.db" && test ! -e "dist/기사작성기/.env" && echo "NO-DATA-OK"
! grep -rl "markupVersion\|COLLECTION_TOKEN\|DIST_SPOOL_DIR" "dist/기사작성기/resources/app" && echo "NO-SERVER-CODE-OK"

# 경로 가드 — 비-0 종료여야 한다.
node scripts/dist-client.mjs --out /tmp/anywhere;   echo "exit=$?  # 0이면 실패"
```

(집합 비교의 `want` 목록은 step1의 실제 산출 파일명에 맞춰 조정하라 — 파일이 늘거나 이름이 다르면 **목록을 실제에 맞추되, 목록 자체를 없애지 마라**. 이 비교가 "화이트리스트 밖 파일이 섞여 들어가는 것"과 "필요한 파일이 빠지는 것"을 동시에 잡는다.)

`npm run test:web` 비고정 실패 규약: 1건이 비고정으로 실패하면 **최대 2회 재실행 + 단독 실행**으로 판정한다(green이면 통과, 사실을 요약에 남긴다).

## 검증 절차

1. 위 AC를 전부 실행한다.
2. 배포 폴더를 **다른 경로로 복사해** 실행하고(포터블 확인), 최초 실행 시 설정 화면 → 주소 입력 → 접속 → 재실행 시 바로 접속되는 흐름을 실기로 확인한다. 이때도 `CLIENT_USER_DATA`를 임시 경로로 주어 실사용자 `%APPDATA%\기사작성기`를 건드리지 마라(부득이 남았다면 사실을 기록하고 **임의로 지우지 마라**).
3. 4절의 실측치를 요약에 남긴다.
4. `git status --porcelain` 증분이 `scripts/dist-client.mjs`·`package.json`(+폴백 시 `package-lock.json`) 뿐인지 확인한다(시작 시점 스냅샷 대비 증분. `dist/**`는 .gitignore로 잡히지 않아야 한다 — 잡히면 .gitignore를 고치지 말고 산출 경로를 `dist/` 아래로 맞춰라).
5. 아키텍처 체크리스트: `dependencies` 추가 0 / `client/**`·`web/**`·`src/**`·`server/**`·`test/**`·`scripts/verify-client.mjs` 무수정 / DB 무접촉 / 타이머·egress 0.
6. `phases/62-client-exe/index.json`의 step3을 갱신한다. **부분 산출물 규칙**: 중간 실패 시 만든 파일을 지우지 말고 어디까지 됐는지 error_message에 남겨라(후속 세션이 증분 대조로 잔여만 완결한다). **blocked 판정 기준**: 직접 조립과 `@electron/packager` 폴백이 **둘 다** 실패하거나, 패키징이 관리자 권한·코드 서명 인증서를 요구하는 경우.

## 금지사항

- 화이트리스트 밖의 리포 파일을 배포 폴더에 넣지 마라. 이유: `docs/news.md`(사내 스펙)·서버 코드·`news.db`·`.env`가 기자 PC 수십 대에 복사되면 회수가 불가능하다.
- `outDir`를 확인 없이 통삭제하지 마라. 이유: `--out` 오타 하나로 사용자 폴더가 날아간다.
- `vite build`·`web/dist` 복사·서버 exe 동봉을 넣지 마라. 이유: 접속형이다 — SPA를 동봉하면 서버 버전과 클라이언트 SPA 버전이 어긋나 진단 불가능한 불일치가 생긴다.
- 자동 업데이트·설치 관리자(NSIS/MSI)·코드 서명 단계를 추가하지 마라. 이유: 확정 산출물은 무설치 포터블 폴더이며 서명·업데이트는 별도 결정이다.
- `client/**`(step1)·`scripts/verify-client.mjs`(step2)를 수정하지 마라. 이유: 실패 원인이 조립 절차인지 셸/검증 결함인지 격리할 수 없게 된다. 결함은 고치지 말고 기록해 보고하라.
- 검증에서 실사용자 `%APPDATA%\기사작성기`나 리포 `news.db`에 바인딩하지 마라. 이유: 검증이 운영 상태를 오염시키면 복구 경로가 없다.
- `npm test` 글롭에 패키징/검증 스크립트를 걸지 마라. 이유: 수십 초짜리 GUI 프로세스가 단위 테스트 실패로 뭉개진다.
- 기존 테스트를 깨뜨리지 마라.
