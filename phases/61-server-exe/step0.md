# Step 0: boot-paths

## 읽어야 할 파일

먼저 아래 파일들을 읽고 프로젝트의 아키텍처와 설계 의도를 파악하라:

- `CLAUDE.md` (프로젝트 규칙 — DB 비파괴, TDD)
- `docs/ARCHITECTURE.md` (특히 "SPA 동일 출처 서빙 (배포 배치)" 절, "보안 경계" 절)
- `docs/ADR.md` (ADR-002 node:sqlite, ADR-006 얇은 transport, ADR-009 동일 출처 배포 전제)
- `server/index.js` — **이 step의 유일한 프로덕션 수정 대상**. 특히:
  - 190~213행: `resolveSpaRoot(spaDir)` · `resolveSpaDir(env, baseDir)`
  - 415~425행: `createApp({ ..., uploadDir = 'uploads', spaDir, ... })` 시그니처
  - 512~514행 / 963~995행: `uploadDir`의 두 소비처(`express.static('/uploads')`, 업로드 저장)
  - 1204~1281행: `bootstrap()` 전체와 하단의 자동 실행 가드
- `test/spa-serving.test.js` — 300~325행(F23~F25: `resolveSpaRoot`/`resolveSpaDir` 순수 헬퍼 테스트). **F24가 이 step에서 갱신 대상이다.**
- `test/host-binding.test.js` — 부트 헬퍼를 순수 함수로 잠그는 방식의 선례(파일 상단 주석 포함)
- `test/same-origin-hardening.test.js` — 135~204행 T4(자식 프로세스로 `server/index.js`를 실기 기동해 bootstrap 결선을 잠그는 E2E). **이 테스트가 계속 green이어야 한다** — 임시 cwd에 `news.db`가 생기는지 단언한다.

행 번호는 2026-08-12 시점(feat-0-mvp tip db04f00) 기준이다. 어긋나면 내용으로 찾아라.

## 배경 (이 step이 존재하는 이유 — 실측 근거)

phase 61은 서버를 **Node SEA 단일 실행 파일**로 패키징한다. SEA는 단일 CJS 스크립트를 요구하므로 esbuild로 ESM 다중 파일을 CJS 한 덩이로 번들해야 한다. 2026-08-12 실측(`esbuild server/index.js --bundle --platform=node --format=cjs --target=node24`):

- 번들은 성공한다(1.4MB, 562ms). 남은 `require(...)`는 **전부 Node 내장**이고 express 뷰 엔진 같은 비내장 동적 require는 0건이다. 5개 런타임 의존성(express·helmet·cors·express-rate-limit·bcryptjs)은 전부 번들에 들어간다.
- 경고는 **정확히 2건이고 둘 다 `import.meta`** 다:
  - `server/index.js:206` — `resolveSpaDir(env = process.env, baseDir = nodePath.dirname(fileURLToPath(import.meta.url)))`
  - `server/index.js:1279` — `if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)`
- CJS 출력에서 `import.meta`는 **빈 객체**가 된다. 따라서:
  - (a) `resolveSpaDir()`를 baseDir 없이 호출하면 `fileURLToPath(undefined)` → **TypeError로 부팅이 죽는다**. 기본 파라미터는 인자 미전달 시 항상 평가되므로 lazy도 아니다.
  - (b) 하단 자동 실행 가드는 `undefined === 'file:///...'` → **항상 false** → 번들된 서버는 아무것도 하지 않고 조용히 종료한다.

추가로, EXE 배치에서는 데이터 경로가 **cwd가 아니라 exe 옆**이어야 한다(포터블 — 백업 = 폴더 복사). 현재는 `new DatabaseSync('news.db')`(cwd 상대)와 `uploadDir = 'uploads'`(cwd 상대)라, 바로가기·작업 스케줄러·다른 드라이브에서 실행하면 데이터가 엉뚱한 곳에 생긴다.

이 step은 그 3가지를 **동작 변경 없이** 닫는다. 실제 exe 빌드는 step1이 한다.

## 작업

**TDD**: 아래 각 항목마다 실패하는 테스트를 먼저 쓰고, 통과하는 최소 구현을 붙여라.

### 1. `resolveSpaDir`에서 `import.meta.url` 제거 (시그니처 변경)

```js
// 변경 후 계약
export function resolveSpaDir(env = process.env, defaultDir)
```

- `env.SPA_DIR`가 정의돼 있으면 현행 그대로: 트림 후 비어 있으면 `undefined`(off 스위치), 값이 있으면 `nodePath.resolve(값)`.
- `env.SPA_DIR`가 미정의면 **인자로 받은 `defaultDir`를 그대로 돌려준다**. `defaultDir`가 없으면 `undefined`(= SPA 서빙 비활성).
- 함수 본문·기본 파라미터 어디에도 `import.meta.url`·`fileURLToPath`·`__dirname`이 남으면 안 된다. 두 번째 인자의 의미가 "서버 모듈 디렉토리(baseDir)"에서 "기본 SPA 디렉토리(defaultDir, 이미 해석된 절대 경로)"로 바뀐다 — `'..','web','dist'` 조합은 이 함수에서 사라지고 호출부(아래 2번)로 올라간다.
- 주석에 "기본 경로 계산은 호출부(resolveRuntimePaths)의 책임이다. 이 함수는 env 오버라이드만 해석한다"를 남겨라.

`test/spa-serving.test.js`의 F24 두 줄(`resolveSpaDir({}, base)` 기대값)을 새 계약으로 갱신하라. F25(빈 값 off 스위치)는 그대로 통과해야 한다. **그 외 테스트 파일·케이스는 손대지 마라.**

### 2. 런타임 경로 단일 출처 — 신규 순수 export

```js
// server/index.js — resolveSpaDir 바로 아래, 부트 헬퍼 그룹에 둔다.
export function resolveRuntimePaths({
  env = process.env,
  packaged = false,
  execDir,          // 패키지 배치의 기준 = nodePath.dirname(process.execPath)
  moduleDir,        // 비패키지 배치의 기준 = 서버 모듈 디렉토리
  cwd = process.cwd(),
} = {}) // → { dataDir, dbFile, uploadDir, spaDir }
```

규칙(전부 순수 — 파일시스템을 읽지 않는다, throw 하지 않는다):

- `dataDir`: `env.DATA_DIR`가 트림 후 비어 있지 않으면 `nodePath.resolve(그 값)`. 아니면 `packaged ? nodePath.join(execDir, 'data') : cwd`.
  - **`packaged: true`인데 `execDir`가 없으면(미주입·빈 문자열) `cwd`로 폴백**하고 throw 하지 마라. 이유: `nodePath.join(undefined, 'data')`는 TypeError이고, 경로 계산이 부팅을 죽이는 것보다 "cwd 기준으로라도 뜬다"가 낫다(운영자는 콘솔 로그의 실제 경로로 오구성을 알아챌 수 있다). 같은 이유로 `spaDir`의 패키지 기본값도 `execDir`가 없으면 계산하지 말고 `undefined`(SPA 비활성)로 둔다.
- `dbFile`: `nodePath.join(dataDir, 'news.db')`.
- `uploadDir`: `nodePath.join(dataDir, 'uploads')`.
- `spaDir`: `resolveSpaDir(env, packaged ? nodePath.join(execDir, 'web') : nodePath.join(moduleDir, '..', 'web', 'dist'))`.
- **CRITICAL(무회귀)**: `packaged: false` 기본 경로는 오늘과 **같은 파일**을 가리켜야 한다 — `<cwd>/news.db`, `<cwd>/uploads`, `<서버 모듈 디렉토리>/../web/dist`. 이 3개가 어긋나면 기존 1070건과 T4 E2E가 깨진다.
- **CRITICAL(SEA 안전)**: `packaged: true`이면 `moduleDir`가 `undefined`여도 **throw 없이** 동작해야 한다. `nodePath.join(undefined, ...)`은 TypeError를 던지므로 분기 안에서만 평가하라(삼항 안이라도 두 가지가 모두 평가되지 않게 — `join`은 호출 시점에 평가된다는 점에 주의).
- `packaged: false`인데 `moduleDir`가 없으면 `spaDir` 기본값을 계산하지 말고 `resolveSpaDir(env, undefined)`로 넘겨라(= SPA_DIR 미설정 시 비활성). throw 금지.
- 반환 객체는 4키 고정이다. 스풀 경로(`DIST_SPOOL_DIR`·`RCV_SPOOL_DIR`)는 **넣지 마라**(아래 금지사항 참조).

### 3. `bootstrap()` — export + 명시 주입 + 중복 기동 방지

```js
export function bootstrap({
  env = process.env,
  packaged = false,
  execDir = nodePath.dirname(process.execPath),
  moduleDir,        // 미주입 + !packaged 이면 본문 안에서 조건부로 계산한다
} = {})
```

- **CRITICAL(`import.meta` 참조는 모듈 스코프 1곳으로 캡처한다)**: 파일 상단(다른 import 아래)에 `const selfUrl = import.meta.url;`를 **한 번만** 두고, 이후 코드는 `import.meta`를 직접 참조하지 않는다. `bootstrap()` 본문에는 `import.meta`가 **한 글자도 남으면 안 된다** — `moduleDir`는 호출부(하단 argv 가드)가 `nodePath.dirname(fileURLToPath(selfUrl))`로 계산해 명시 주입한다.
  - 이유 (1): 기본 파라미터든 본문 조건이든 `import.meta` **참조 지점 수만큼** esbuild가 `empty-import-meta` 경고를 낸다. step1의 번들 게이트는 "이 경고 정확히 1건만 허용"이라 참조 지점이 늘면 빌드가 실패하고, 줄이려고 게이트를 느슨하게 하면 진짜 위험한 경고를 놓친다.
  - 이유 (2): CJS 번들에서 `import.meta`는 `{}`라 `selfUrl`은 `undefined`가 된다. `bootstrap` 본문이 이를 참조하지 않으면 `fileURLToPath(undefined)` TypeError 경로 자체가 exe에 존재하지 않는다(위 실측 (a)).
  - `bootstrap()`은 `moduleDir`를 **받기만 한다**: 미주입이고 `packaged`가 false이면 `resolveRuntimePaths`가 `spaDir === undefined`(SPA 비활성)로 수렴한다 — 그 경우에도 throw는 없어야 한다.
- `resolveRuntimePaths({ env, packaged, execDir, moduleDir })`를 1회 호출해 4개 경로를 얻고 결선하라:
  - `new DatabaseSync(paths.dbFile)` (현행 `'news.db'` 리터럴 대체)
  - `createApp({ ..., uploadDir: paths.uploadDir, spaDir: paths.spaDir })` (현행 `spaDir = resolveSpaDir()` 라인 대체, `uploadDir`는 신규 전달)
  - `resolveSpaRoot(paths.spaDir)` 로그 분기는 현행 그대로(활성일 때만 INFO 1줄).
- DB를 열기 **전에** `fs.mkdirSync(dataDir, { recursive: true })`를 1회 호출하라. 이유: 배포 폴더에서 data/가 없으면 `DatabaseSync`가 파일을 만들지 못하고 부팅이 실패한다. `recursive: true`는 이미 존재하면 no-op이므로 기존 동작(cwd에 이미 존재)에는 영향이 없다. **디렉토리를 지우거나 비우는 코드는 절대 넣지 마라.**
- 모듈 스코프 플래그로 **중복 기동을 막아라**(이미 부팅했으면 즉시 return). 이유: 번들 배치에서 엔트리의 명시 호출과 하단 argv 가드가 동시에 참이 되면 `app.listen`이 두 번 불려 EADDRINUSE로 죽는다. 실측상 번들에서 가드는 false지만, 방어는 비용이 0이다.
- `logService`·`logOriginDiagnostics`·`logHostDiagnostics`·`resolveHost`·`app.listen(port, host)`·FTP watcher·`DIST_SPOOL_DIR` 로그 등 **나머지 bootstrap 본문은 순서·내용 그대로 유지**하라.
- 하단 자동 실행 가드는 **유지하되 `selfUrl`을 쓰도록 바꾸고, 여기서 `moduleDir`를 명시 주입한다**:

```js
// 형태만 제시 — 구현은 재량. 가드 자체를 삭제하지 마라.
if (process.argv[1] && selfUrl === pathToFileURL(process.argv[1]).href) {
  bootstrap({ moduleDir: nodePath.dirname(fileURLToPath(selfUrl)) });
}
```

  - **가드를 삭제하지 마라.** 이유: `npm run server`(dev)의 유일한 진입점이고, `test/same-origin-hardening.test.js` T4가 자식 프로세스로 `server/index.js`를 실기 기동해 이 경로를 잠근다 — 지우면 dev 서버와 T4가 동시에 죽는다.
  - 번들 배치에서는 `selfUrl`이 `undefined`라 조건이 false가 되고(throw 없음), `fileURLToPath`는 **평가되지 않는다**(조건 안에 있으므로).
  - 여기에 `packaged: true`를 넘기지 마라. 이유: dev 실행은 비패키지 배치이며, 패키지 주입은 `server/main.js`(step1)만 한다.

### 4. 테스트 (신규 파일 1개)

`test/runtime-paths.test.js`를 새로 만든다(기존 테스트 파일 무수정 — 예외는 위 F24 2줄뿐). 최소 커버리지:

- 비패키지 기본: `dataDir === cwd`, `dbFile === join(cwd,'news.db')`, `uploadDir === join(cwd,'uploads')`, `spaDir === join(moduleDir,'..','web','dist')`.
- 패키지 기본: `dataDir === join(execDir,'data')`, `dbFile/uploadDir`가 그 아래, `spaDir === join(execDir,'web')`.
- **패키지 + `moduleDir` 미주입이어도 throw 없이 위 값이 나온다**(이 step의 핵심 회귀 — SEA에서 모듈 위치가 없다는 사실의 모사).
- `DATA_DIR` 오버라이드가 두 배치 모두에서 이기고, 상대 경로는 절대화되며, 공백만 있는 값은 무시된다(기본값 수렴 — `resolveHost`의 빈 값 정책과 동형).
- `SPA_DIR` 오버라이드가 두 배치 모두에서 이기고, `SPA_DIR=''`/`'   '`는 `spaDir === undefined`(off 스위치)다.
- 비패키지 + `moduleDir` 미주입이면 `spaDir === undefined`이고 throw가 없다.
- **패키지 + `execDir` 미주입(또는 빈 문자열)이면 `dataDir === cwd`로 폴백**하고 `spaDir === undefined`이며 throw가 없다(경로 계산이 부팅을 죽이지 않는다는 계약).
- `resolveSpaDir(env, defaultDir)` 신계약 단독 케이스(defaultDir 반환 / SPA_DIR 우선 / off 스위치).

**변이 검증**(구현 후 손으로 뒤집어 보고 red를 확인한 뒤 되돌려라 — 결과를 summary에 적어라):
1. `packaged` 분기를 무시하고 항상 cwd 기준 → 패키지 케이스 red.
2. `DATA_DIR` 트림/빈 값 처리 제거 → 공백 케이스 red.
3. `spaDir` 기본 계산을 `join(execDir,'web','dist')`로 변경 → 패키지 케이스 red.
4. `moduleDir`/`execDir` 미주입 폴백 제거 → 패키지+미주입 케이스 red(TypeError).
5. `bootstrap` 본문에 `import.meta.url`을 되살림 → 단위 테스트는 green이지만 **아래 AC의 번들 프로브 경고가 1건 → 2건**이 된다(이 변이는 테스트가 아니라 프로브가 잡는다는 사실을 확인하고 되돌려라).

## Acceptance Criteria

```bash
npm test                 # 백엔드 — 기준선 1070 + 신규 케이스, 실패 0
npm run lint             # clean
npm run build            # clean (web 무영향 확인)
npm run test:web         # 2368/2368 (백엔드 전용 변경이므로 그대로여야 한다)

# 번들 생존 프로브 — 이 step의 목적이 실제로 달성됐는지 실측한다.
mkdir -p dist/step0-probe
./node_modules/.bin/esbuild server/index.js --bundle --platform=node --format=cjs --target=node24 \
  --outfile=dist/step0-probe/bundle.cjs 2>dist/step0-probe/warnings.txt; cat dist/step0-probe/warnings.txt

node -e "const m=require('./dist/step0-probe/bundle.cjs'); \
  for (const k of ['bootstrap','resolveRuntimePaths','resolveSpaDir','createApp']) if (typeof m[k] !== 'function') throw new Error('missing export: '+k); \
  const p = m.resolveRuntimePaths({ env:{}, packaged:true, execDir:'C:/app' }); \
  if (!p.dbFile.includes('data')) throw new Error('packaged dbFile wrong: '+p.dbFile); \
  console.log('bundle-ok', p.dbFile, p.spaDir);"
```

기대(**하드 게이트**): `warnings.txt`의 `empty-import-meta` 경고가 **2건 → 정확히 1건**이 된다. 남는 1건은 모듈 스코프의 `const selfUrl = import.meta.url;` **한 곳뿐**이며(의도된 잔존 — 런타임에 `undefined`가 되어 argv 가드가 false로 평가된다), `resolveSpaDir`·`resolveRuntimePaths`·`bootstrap` 본문에서는 사라진다. step1의 번들 게이트가 "이 경고 1건만 허용"으로 잠그므로 **1건보다 많으면 이 step은 미완이다.** 이어서 번들을 require한 뒤 `packaged:true` 경로 계산이 **모듈 위치 없이** 동작해야 한다.

`node_modules/.bin/esbuild`는 vite 경유 전이 설치본이다(2026-08-12 확인). 없으면 이 프로브만 step1로 이월하고 그 사실을 summary에 적어라 — **직접 `npm install`로 esbuild를 추가하지 마라**(devDependency 추가는 step1의 소유다).

## 검증 절차

1. 위 AC 커맨드를 전부 실행한다(전체 스위트는 2회 연속 동일 결과를 확인한다 — 이 리포는 병렬 부하에서 드물게 비고정 실패가 있다).
2. `git status --porcelain`을 step 시작 시점 스냅샷과 비교해 **증분이 아래 3파일뿐**임을 확인한다: `server/index.js`, `test/runtime-paths.test.js`(신규), `test/spa-serving.test.js`(F24 2줄).
3. `git diff server/index.js`를 눈으로 훑어 확인한다:
   - `bootstrap()` 본문에서 로그·watcher·진단 호출 순서가 그대로인가?
   - `import.meta`가 **모듈 스코프 `const selfUrl = import.meta.url;` 한 곳에만** 남았는가?(`grep -n "import\.meta" server/index.js` 결과가 1줄이어야 한다)
   - `resolveRuntimePaths`가 파일시스템을 읽지 않는가(순수)?
4. 아키텍처 체크리스트: ADR-006 계층 방향(transport는 controllers만 호출) 불변 / DB 스키마·행 변경 0 / 앱 내 타이머·egress 신설 0(ADR-008) / 응답 계약 불변.
5. `phases/61-server-exe/index.json`의 step0을 갱신한다(성공 → `completed` + summary에 신계약 시그니처·변이 결과·번들 프로브 경고 수를 남긴다 / 3회 수정 후에도 실패 → `error` + `error_message` / 사용자 개입 필요 → `blocked` + `blocked_reason`).

## 금지사항

- `resolveSpaDir`의 기본 파라미터에 `import.meta.url`을 되살리지 마라. 이유: CJS 번들에서 `{}`가 되어 `fileURLToPath(undefined)` TypeError로 exe가 부팅 즉시 죽는다(실측 확인됨).
- `node:sea`를 import하거나 런타임으로 패키지 여부를 탐지하지 마라. 이유: 판정은 엔트리가 `packaged: true`로 명시 주입한다(index.json decisions (3)) — 탐지는 번들러·Node 버전에 따라 조용히 뒤집히고 순수 함수 테스트로 잠글 수 없다.
- `DIST_SPOOL_DIR`·`RCV_SPOOL_DIR`에 기본값을 주거나 `resolveRuntimePaths` 반환에 포함하지 마라. 이유: '미설정 = 배부/FTP 수집 비활성'이 ADR-008의 관측 가능한 계약이다 — 기본값을 주면 exe를 켜는 순간 스풀 쓰기가 조용히 활성화된다.
- `createApp`의 `uploadDir` 기본값(`'uploads'`)이나 `spaDir` 기본값(없음=비활성)을 바꾸지 마라. 이유: phase 60 decisions (1) — createApp에 경로 기본값이 생기면 로컬 빌드 산출물 유무에 따라 기존 테스트의 404 동작이 흔들린다.
- `bootstrap()` 안에 새 기능(스케줄러·워커·정리 작업·자동 시드·마이그레이션·자동 백업)을 추가하지 마라. 이유: 이 step은 경로 seam만 정리한다. 타이머·egress는 ADR-008 위반이고, 자동 시드는 인증 표면 변경이라 사용자 확정 대상이다(index.json open_questions (a)).
- 파일·디렉토리를 삭제하거나 비우는 코드를 넣지 마라(`rm`·`rmSync`·`unlink`·`emptyDir` 전부). 이유: DB 비파괴 원칙이며, dataDir는 운영 데이터의 루트다.
- `package.json`·`scripts/**`·`docs/**`·`README.md`·`.env.example`을 수정하지 마라. 이유: devDependency는 step1, 문서·env 예시는 step3의 소유다 — 같은 파일을 두 step이 만지면 충돌한다.
- `test/spa-serving.test.js`의 F24 2줄 외 다른 테스트를 수정·삭제하지 마라. 기존 테스트를 깨뜨리지 마라.
