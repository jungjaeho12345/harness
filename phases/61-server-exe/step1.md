# Step 1: sea-build

## 읽어야 할 파일

먼저 아래 파일들을 읽고 프로젝트의 아키텍처와 설계 의도를 파악하라:

- `CLAUDE.md`, `docs/ARCHITECTURE.md`, `docs/ADR.md` (특히 철학 문단의 "외부 의존성 최소화" — **런타임** 축의 원칙이다)
- `phases/61-server-exe/index.json` — 이 phase의 decisions (1)(2)(7)(8)(9)(10)(12)
- `server/index.js` — step0이 만든 `bootstrap({ env, packaged, execDir, moduleDir })`와 `resolveRuntimePaths()`. **이 step에서는 읽기만 하고 수정하지 않는다.**
- `test/runtime-paths.test.js` (step0 신규) — 패키지 배치의 경로 계약이 여기 잠겨 있다
- `test/same-origin-hardening.test.js` 135~204행 — 자식 프로세스로 서버를 실기 기동해 HTTP로 프로브하는 패턴(기동 폴링·env 정리·Windows 종료 처리). **`scripts/verify-server-exe.mjs`는 이 패턴을 그대로 따른다.**
- `scripts/seed.js`, `src/db/seed.js`, `src/db/schema.js` — 검증용 임시 DB를 시드하는 방법
- `package.json` — 현재 devDependencies·scripts

## 배경 (실측 사실 — 추측하지 말고 이 위에서 시작하라)

2026-08-12 로컬 실측:

- Node **v24.16.0** (`node:sea` 로드 확인, `node:sqlite`는 플래그 없이 동작 중 — exe도 플래그 없이 떠야 한다).
- `esbuild server/index.js --bundle --platform=node --format=cjs --target=node24` → **성공**. 1.4MB / 562ms. 번들에 남은 `require(...)`는 전부 Node 내장(`fs`·`http`·`crypto`·`zlib` 등)이고 **express 뷰 엔진 같은 비내장 동적 require는 0건**이다. plain node에서 `require(bundle)`이 성공하고 `createApp` 등 export가 그대로 보인다 → 런타임 의존성 5개(express·helmet·cors·express-rate-limit·bcryptjs) 번들은 이미 실증됐다.
- 경고는 `import.meta` 뿐이다. step0 이후 남는 것은 `server/index.js` 하단 argv 가드 1건이며, CJS에서 `import.meta`가 `{}`가 되어 **가드가 항상 false**다 → 번들된 서버는 자동으로 부팅하지 않는다. 그래서 SEA 엔트리가 `bootstrap()`을 명시 호출해야 한다.
- esbuild 0.25.12는 vite 경유 **전이** 설치본이다 → 이 step에서 **명시 devDependency로 고정**한다.

아직 실측되지 않은 것(이 step이 확정한다): SEA blob 생성 · postject 주입 · 주입된 exe에서 `node:sqlite`/bcryptjs 동작 · 한글 exe 파일명 · Windows 서명 처리.

## 작업

### 1. devDependencies 추가 (`package.json`)

- `esbuild` — 현재 전이 설치 버전(0.25.12)에 맞춰 캐럿 없이 또는 캐럿으로 고정(판단은 재량, 설치 후 `npm ls esbuild`로 중복 설치 여부 확인).
- `postject` — SEA blob 주입 도구.
- **`dependencies`에는 아무것도 추가하지 마라.** 배포 산출물은 번들이므로 런타임 의존성 추가는 0이다.
- `scripts`는 이 step에서 건드리지 마라(`dist:server`는 step2 소유).

### 2. SEA 엔트리 `server/main.js` (신규, 5줄 내외)

```js
// 번들/SEA 전용 엔트리 — 패키지 배치임을 명시 주입한다.
import { bootstrap } from './index.js';
bootstrap({ packaged: true });
```

- **CRITICAL**: `packaged: true`를 여기서만 넘긴다. `server/index.js`는 수정하지 마라(step0 소유).
- ESM이고 `npm run lint` 대상이다(`server/**`는 eslint 커버리지 안).
- 이 파일은 dev에서 쓰이지 않는다(`npm run server`는 계속 `server/index.js`) — 주석으로 그 사실을 남겨라.

### 3. `scripts/sea-build.mjs` (신규)

```js
export async function buildServerExe({
  entry = 'server/main.js',
  outDir = 'dist/server-exe',
  exeName = '기사작성기-server.exe',
  fallback = false,        // true여야만 폴백(node.exe 동봉)으로 내려간다
} = {}) // → { mode: 'sea' | 'node-bundled', exe: <절대경로>, files: [...], bytes, nodeVersion, warnings: [] }
```

CLI로도 실행 가능하게 한다: `node scripts/sea-build.mjs [--out <dir>] [--name <exe>] [--fallback]`. 마지막 줄에 결과 JSON 1줄을 stdout으로 출력하라(step2가 import로 재사용하지만, 사람이 눈으로 확인할 수 있어야 한다).

절차(각 단계 실패 시 **어떤 커맨드가 무슨 코드로 실패했는지** stderr에 남겨라 — 조용한 실패 금지):

1. 작업공간 `<outDir>/work/` 준비. `<outDir>`가 `dist/` 하위인지 확인하고 아니면 거부하라(임의 경로 삭제 사고 방지). 정리는 이 작업공간과 산출 파일 범위로만 한다.
2. **번들**: esbuild JS API(`import { build } from 'esbuild'`)로 `entry` → `<work>/server-bundle.cjs`.
   - `bundle: true, platform: 'node', format: 'cjs', target: 'node' + 현재 major, minify: false, sourcemap: false, logLevel: 'warning'`.
   - 외부 지정은 하지 마라(node 내장은 `platform: 'node'`가 자동 처리한다). 5개 dep은 전부 번들에 포함되어야 한다.
   - **경고 게이트**: 결과 warnings 중 `empty-import-meta` **정확히 1건**만 허용한다(step0이 `import.meta` 참조를 모듈 스코프 `const selfUrl = import.meta.url;` 한 곳으로 캡처했으므로 1건이 정상이다. 2건 이상이면 step0 계약이 깨진 것이니 **여기서 고치지 말고 실패시키고 보고하라** — server/index.js는 step0 소유다). 그 외 경고(특히 동적 `require`/`Dynamic require ... not supported` 계열)가 있으면 **빌드를 실패시켜라** — SEA에서 비내장 `require`는 런타임에 throw하므로 조용히 넘기면 배포 후에 터진다. 허용/차단 목록과 실제 경고를 반환값 `warnings`에 담아라.
3. **번들 스모크(로드 확인 전용)**: `server/main.js` 번들을 require하지 마라 — 그 엔트리는 `bootstrap()`을 호출하므로 **실제로 서버가 뜨고**, 포트 점유·EPERM·DB 파일 생성 같은 부수효과가 "번들 로드 실패"로 오진된다. 대신 **`server/index.js`를 같은 옵션으로 한 번 더 번들해 `<work>/loadcheck.cjs`를 만들고**(엔트리는 `export`만 있고 자동 실행되지 않는다 — 번들에서 argv 가드가 항상 false다) 자식 프로세스로 `node -e "const m=require('<work>/loadcheck.cjs'); if(typeof m.bootstrap!=='function') process.exit(3);"`를 돌려라. 확인 대상은 "5개 의존성이 포함된 번들이 로드된다"뿐이며, 종료 코드로 판정한다. 이 프로브는 DB·포트·파일을 건드리지 않는다(그래도 방어로 cwd를 임시 디렉토리로 준다).
4. **SEA blob**: `<work>/sea-config.json` 생성 후 `process.execPath --experimental-sea-config <work>/sea-config.json` 실행.
   ```json
   { "main": "<work>/server-bundle.cjs", "output": "<work>/sea-prep.blob",
     "disableExperimentalSEAWarning": true, "useSnapshot": false, "useCodeCache": false }
   ```
   - `useCodeCache`는 false로 시작하라(코드 캐시는 Node 버전·플랫폼 조합에서 실패 사례가 있다). 성공 후 여유가 있으면 true를 실측해 보고 이득이 없으면 false로 남겨라.
   - `disableExperimentalSEAWarning: true`가 없으면 운영자가 매 기동마다 실험 기능 경고를 본다.
5. **exe 골격**: `process.execPath`(빌드 머신 node.exe)를 `<work>/app-build.exe`로 복사한다. **경로는 ASCII 임시 이름**을 쓴다(index.json decisions (12)).
   - Windows 서명: `signtool remove /s <exe>`가 가능하면 시도하고, `signtool`이 없으면 **건너뛰고 진행**하라(실패로 취급하지 마라). 어느 쪽이었는지 결과에 기록하라.
6. **주입**: postject를 node_modules 경유로 실행한다(`npx postject` 금지 — 네트워크·버전 비고정).
   ```
   <node> <postject-cli> <work>/app-build.exe NODE_SEA_BLOB <work>/sea-prep.blob \
     --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2
   ```
   - CLI 경로는 `createRequire(import.meta.url).resolve('postject/dist/cli.js')` 또는 `node_modules/.bin/postject`로 해석하라(설치 후 실제 파일 배치를 확인하고 결정).
   - sentinel fuse 문자열은 Node 공식 SEA 문서의 상수다. 주입이 fuse 오류로 실패하면 **추측으로 문자열을 바꾸지 말고** 설치된 Node 버전의 공식 문서를 확인해 값을 맞춰라(context7 등).
7. **최종 rename**: `<work>/app-build.exe` → `<outDir>/<exeName>`(한글 이름). rename 실패 시 ASCII 이름(`article-server.exe`)으로 폴백하고 그 사실을 반환값과 stderr에 남겨라.
8. 반환: `{ mode: 'sea', exe, files, bytes, nodeVersion, warnings }`. exe 크기는 node.exe 크기(수십~100MB대)만큼 크다 — 정상이다.

**폴백(`fallback: true`일 때만, index.json decisions (10))**: 4~7단계 중 어느 단계든 실패하면 `mode: 'node-bundled'`로 산출한다 — `<outDir>/node.exe`(process.execPath 복사) + `<outDir>/server-bundle.cjs`. 실행은 `node.exe server-bundle.cjs`이며 Node 설치 불필요는 그대로 유지된다. 기본은 **fail-fast**다(플래그 없이 자동으로 폴백하지 마라 — SEA 실패가 조용히 묻힌다).

### 4. `scripts/verify-server-exe.mjs` (신규)

```
node scripts/verify-server-exe.mjs --exe <path> [--script <path>] [--spa <dir>] [--port <n>] [--portable]
```

- `--script <path>`: 폴백(`node-bundled`) 모드 전용. 지정하면 자식 프로세스를 `<exe> <script>`로 기동한다(미지정이면 `<exe>` 단독 = SEA 모드). 이 인자 덕분에 SEA 산출물과 폴백 산출물이 **같은 검증 스크립트**로 잠긴다.
- **인자 가드(필수)**: `--exe`가 없거나 그 경로가 존재하지 않으면 즉시 exit 1 + 사용법 출력. `--script`를 준 경우 그 파일 존재도 확인하라. 이유: `scripts/**`는 eslint 대상이 아니라 오타가 정적 검사에 안 걸린다 — 인자 오타가 "검증 통과"로 둔갑하면 안 된다.

동작:

1. 임시 디렉토리 2개를 만든다 — `dataDir`(검증용 DB 루트)와 `cwd`(자식 프로세스 작업 디렉토리, **반드시 리포 루트가 아닌 임시 경로**).
2. **기본(`--portable` 아님) 모드에서만** `dataDir/news.db`를 리포 코드로 시드한다(`createSchema` + `seedUsers` — `scripts/seed.js`와 동형). 이유: 배포 폴더의 data/는 비어 있어 로그인 검증을 할 수 없다. 시드는 검증 스크립트의 책임이며 exe와 무관하다.
   - **CRITICAL**: 시드된 DB는 임시 `dataDir`에만 존재해야 한다. `--portable` 모드에서는 **절대 시드하지 마라** — 그 모드의 DB는 exe 옆(배포 폴더)에 생기므로, 시드하면 샘플 계정 비밀번호가 담긴 news.db가 배포물에 남는다(자격증명 유출).
3. exe를 자식 프로세스로 기동한다. env: `PORT`(랜덤 20000~50000), `HOST=127.0.0.1`, `DATA_DIR=<dataDir>`, `SPA_DIR=<--spa 값>`(미지정이면 설정하지 않는다). **상속 env에서 `COLLECTION_TOKEN`·`RCV_SPOOL_DIR`·`DIST_SPOOL_DIR`·`NODE_ENV`·`FORCE_HTTPS`·`ALLOWED_ORIGINS`를 지워라**(우연한 값으로 결과가 흔들리지 않게 — T4 전례).
   - `--portable` 모드에서는 `DATA_DIR`를 **주지 않고** cwd도 임시 경로로 둔다 → "exe 옆 data/"가 실제로 쓰이는지 검증한다(step2에서 쓴다). 이 모드는 **exe 옆에 파일을 만든다** — 호출자는 반드시 폐기 가능한 사본을 가리켜야 한다는 사실을 사용법에 적어라.
4. `GET /api/health`가 200이 될 때까지 폴링(최대 30초, 100ms 간격). 자식이 죽으면 즉시 실패하고 stdout/stderr를 출력한다.
5. HTTP 프로브 — **모드에 따라 집합이 다르다**(전부 `127.0.0.1`):

   **(A) 기본 모드(`DATA_DIR` 주입 + 시드됨)** — 전체 프로브:
   - `POST /api/login`(시드 계정) → 200 + `set-cookie`에 `sid` — bcryptjs·세션 경로 검증.
   - `GET /api/session`(쿠키) → 200 + user — 세션 재검증 경로.
   - `POST /api/articles`(쿠키, 최소 본문) → ok — **node:sqlite 쓰기** 검증. 이어서 `GET /api/articles`로 그 기사가 보이는지 확인.
   - `--spa` 지정 시: `GET /login.do`(`Accept: text/html`) → 200 + index.html 내용 / `GET /assets/...`(실제 존재하는 파일 1개) → 200 / `GET /list.do`(`Accept: application/json`) → 404(폴백 계약 유지).
   - `/api/collection/receive`·`/pull`은 프로브하지 마라 — 이 검증은 수집 인제스트를 건드리지 않는다(HOST가 loopback이라 fail-closed 대상도 아니다).

   **(B) `--portable` 모드(시드 없음 = 사용자 0명)** — 프로브는 **아래 3개로 한정**한다:
   - `GET /api/health` → 200
   - `--spa` 지정 시 `GET /login.do`(`Accept: text/html`) → 200 + index.html 내용(경로 기본값이 exe 옆 `web`을 가리킨다는 증거)
   - 종료 후 `<exe 디렉토리>/data/news.db`가 생성됐고 `node:sqlite`로 열어 **스키마가 만들어졌는지**(예: `User`·`Article` 테이블 조회가 성공) 확인
   - **인증·기사 생성 프로브를 여기서 하지 마라.** 이유: 계정이 없으므로 로그인 실패가 정상 동작이고, 그걸 통과시키려고 시드하면 샘플 계정 DB가 배포 폴더에 남는다. 이 모드가 증명하려는 것은 오직 **"cwd·DATA_DIR 없이도 exe 옆 data/·web/을 기준으로 뜬다"** 하나다(쓰기 경로 검증은 (A)가 이미 한다).
6. 종료: 자식 kill → 200ms 대기 → 살아 있으면 SIGKILL(Windows 잔류 방지). 그 뒤 모드별 DB 확인((A) `dataDir/news.db`에 Article 행 1건 이상 / (B) `<exe 디렉토리>/data/news.db`에 스키마 존재)을 수행한다.
7. 성공 시 요약(모드·exe 크기·부팅 소요·프로브 결과)을 stdout에 출력하고 exit 0. 실패 시 원인 요약 + 자식 로그를 stderr에 출력하고 exit 1.

**CRITICAL(데이터 안전)**: 이 스크립트는 리포 루트의 `news.db`·`uploads/`에 절대 바인딩하지 않는다. `DATA_DIR`와 cwd를 항상 임시 경로로 주고, 검증이 만든 임시 디렉토리 밖의 어떤 파일도 삭제하지 마라.

## Acceptance Criteria

```bash
npm install                                  # devDependencies(esbuild·postject) 설치
npm run lint                                 # clean (server/main.js 포함 — scripts/**는 eslint ignore 대상)
npm test                                     # 1070 + step0 신규, 실패 0 (server/index.js 무수정이므로 그대로)
npm run test:web                             # 2368/2368 무영향
npm run build                                # clean

node scripts/sea-build.mjs --out dist/server-exe
node scripts/verify-server-exe.mjs --exe "dist/server-exe/기사작성기-server.exe"

# 재실행 멱등 — 같은 커맨드를 한 번 더 돌려도 성공해야 한다(작업공간 잔여물로 깨지지 않는다).
node scripts/sea-build.mjs --out dist/server-exe && node scripts/verify-server-exe.mjs --exe "dist/server-exe/기사작성기-server.exe"

# 인자 가드 — 둘 다 비-0 종료여야 한다(잘못된 호출이 '검증 통과'로 둔갑하면 안 된다).
node scripts/verify-server-exe.mjs;                                    echo "exit=$?  # 0이면 실패"
node scripts/verify-server-exe.mjs --exe dist/server-exe/nope.exe;     echo "exit=$?  # 0이면 실패"
```

SEA 경로가 실패하면 폴백을 실측하고 **그 사실을 summary에 남긴 뒤** 폴백 산출물로 AC를 만족시켜라:

```bash
node scripts/sea-build.mjs --out dist/server-exe --fallback
node scripts/verify-server-exe.mjs --exe "dist/server-exe/node.exe" --script "dist/server-exe/server-bundle.cjs"
```

## 검증 절차

1. 위 AC 커맨드를 실행한다.
2. **실측 기록**(step 요약에 반드시 남긴다 — step2·step3이 이 수치를 문서화한다): 최종 mode(`sea`/`node-bundled`) · exe 크기 · 빌드 소요 시간 · esbuild 경고 목록(`empty-import-meta` 건수 포함) · 부팅 소요 · 한글 파일명 정상 여부 · signtool 처리 여부 · postject CLI 해석 경로 · `node:sqlite` 쓰기 성공 여부.
   - 추가로 **"`scripts/**`는 eslint 커버리지 밖이다(eslint.config.js의 ignores 목록) — `npm run lint` clean은 신규 빌드 스크립트의 품질을 전혀 보증하지 않는다"** 는 사실을 summary에 명시하라. 그래서 이 step의 실질 안전망은 (a) AC의 실행 프로브와 (b) 스크립트 자체의 인자 가드 둘뿐이다. eslint 설정을 바꿔 `scripts/**`를 커버리지에 넣는 것은 이 phase 밖이다(전체 스크립트가 새로 린트 대상이 되어 무관한 수정이 번진다).
3. `git status --porcelain` 증분이 `package.json`·`package-lock.json`·`server/main.js`·`scripts/sea-build.mjs`·`scripts/verify-server-exe.mjs` 뿐인지 확인한다(`dist/**`는 .gitignore 대상이라 잡히지 않아야 한다 — 잡히면 .gitignore를 고치지 말고 산출 경로를 `dist/` 아래로 옮겨라).
4. 아키텍처 체크리스트: `dependencies` 추가 0 / `server/index.js`·`src/**`·`web/**`·`test/**` 무수정 / DB 스키마·행 변경 0 / 앱 내 타이머·egress 0.
5. `phases/61-server-exe/index.json`의 step1을 갱신한다(completed + summary / error + error_message / blocked + blocked_reason).
   - **blocked 판정 기준**: SEA와 폴백이 **둘 다** 실패하거나, 주입 도구가 관리자 권한·외부 인증서 등 사용자 개입을 요구하는 경우.

## 금지사항

- `server/index.js`를 수정하지 마라. 이유: step0의 소유 파일이며, 이 step에서 함께 고치면 "번들이 깨진 원인이 seam인지 빌드 설정인지"를 격리할 수 없다.
- `npx postject`처럼 네트워크에서 도구를 끌어오지 마라. 이유: 빌드 재현성이 사라지고 오프라인 빌드가 불가능해진다(devDependency로 고정한다).
- SEA 실패를 자동으로 폴백해서 넘기지 마라. 이유: 폴백은 "node.exe 동봉"이라 산출물 형태와 운영 문서가 달라지는 결정이다 — 명시 플래그와 기록 없이 조용히 바뀌면 step2·step3이 잘못된 전제 위에서 진행된다.
- 검증 스크립트를 `test/**`에 넣거나 `npm test` 글롭에 걸리게 하지 마라. 이유: SEA 빌드는 수십 초 이상이고 실패 원인이 테스트 실패로 뭉개진다(index.json decisions (8)).
- 검증에서 리포 루트의 `news.db`·`uploads/`를 쓰거나 지우지 마라. 이유: DB 비파괴 원칙 — 실 데이터가 검증으로 오염·삭제되면 복구 경로가 없다.
- exe 안에 `.env`·`news.db`·인증서·토큰을 넣지 마라. 이유: 배포물에 시크릿이 박히고 회전이 불가능해진다.
- 번들에 `--minify`나 난독화를 넣지 마라. 이유: 운영 장애 시 스택 추적이 불가능해지고, 크기 이득은 node.exe 대비 무의미하다.
- `dependencies`(런타임)에 무엇이든 추가하지 마라. 이유: ADR 철학의 최소 의존성 원칙이며, 이 phase의 명시 제약(런타임 의존성 추가 0)이다.
- 기존 테스트를 깨뜨리지 마라.
