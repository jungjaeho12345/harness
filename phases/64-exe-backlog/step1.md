# Step 1: build-scripts

## 읽어야 할 파일

- `CLAUDE.md` — TDD·아키텍처·커밋 규칙
- `docs/ADR.md` — **ADR-010**(서버 배포 = Node SEA 단일 exe, 빌드 도구는 런타임 의존성이 아니다). 이 step은 ADR을 **수정하지 않는다**
- `phases/64-exe-backlog/index.json` — scope의 (A-3)(A-4)(A-5)(A-6), decisions **(4)(5)(6)(7)(16)(17)(18)**
- `phases/61-server-exe/index.json` — 이 스크립트들이 왜 지금 모습인지(SEA 빌드·배포 조립 결정)
- `scripts/sea-build.mjs` — 전체. 특히 outDir 가드 75~80행, 폴백 분기 179~191행, `SCRIPT_PATH` 20행
- `scripts/dist-server.mjs` — 전체. 특히 `REPO_ROOT` 16행, outDir 가드 30~35행, exe 산출물 복사 69~75행, 요약 출력 89~101행
- `packaging/server/기사작성기-server.bat` — 전체(주석 헤더 3~16행)
- `test/sea-import-meta-lock.test.js` — 전체
- `server/index.js` 1250~1260행 — 유일한 `import.meta` 참조와 그 위 주석(주석에서 리터럴을 피하는 현행 관행의 실물 근거)
- **step0 산출물**: `scripts/lib/cliArgs.mjs`, `scripts/sea-build.mjs`·`scripts/dist-server.mjs`의 갱신된 `parseArgs` — 이 step은 그 함수 **밖**만 만진다

## 배경 (실코드 확인 결과)

- **(A-3)** `scripts/sea-build.mjs` 76행의 `const distRoot = nodePath.resolve('dist')`는 **cwd 기준**이다. 리포 루트가 아닌 곳에서 실행하면 `<cwd>/dist` 아래가 허용돼 예상 밖 경로에 산출물이 쓰인다. 같은 파일 20행에 `SCRIPT_PATH`가 이미 있고, `scripts/dist-server.mjs`는 16행에서 `REPO_ROOT`를 뽑아 31행에서 `nodePath.resolve(REPO_ROOT, 'dist')`로 쓴다 — 기준축이 두 스크립트에서 다르다.
- **(A-4)** `dist-server.mjs`는 `--fallback` 시 `node.exe` + `server-bundle.cjs`를 배포 폴더에 넣는다(sea-build 182~190행). 그런데 함께 복사되는 `packaging/server/기사작성기-server.bat` 51행은 `"%~dp0기사작성기-server.exe"`를 실행한다 — 폴백 배포 폴더에서는 **존재하지 않는 파일**이라 운영자가 bat을 눌러도 기동하지 않는다.
- **(A-5)** `dist-server.mjs` 84~87행이 `packaging/server/**`를 배포 폴더 루트로 매번 `cpSync`한다 → 재빌드하면 운영자가 편집한 배포 폴더 bat의 `set` 줄이 **말없이 원본으로 되돌아간다**.
- **(A-6)** `test/sea-import-meta-lock.test.js`는 `server/**`+`src/**`를 텍스트로 훑어 `import.meta` 출현을 센다(41~46행). 주석·문자열 안의 리터럴도 세므로, 누군가 설명 주석에 그 단어를 적으면 무관한 테스트가 red가 된다. 현행 코드는 이 사실을 알고 우회하고 있다(`server/index.js` 1258행: "이 본문에는 **모듈 메타** 참조가 한 글자도 없어야 한다").

## 작업

A → B → C → D 순서. 각각 독립이므로 하나가 막히면 그 항목만 멈추고 나머지를 진행한다(요약에 사실 기록).

### A. sea-build outDir 가드 기준축 통일 (A-3)

1. `scripts/sea-build.mjs`에서 `SCRIPT_PATH` 기반 `REPO_ROOT`를 만들고(dist-server 16행과 동형), 가드의 `distRoot`를 `nodePath.resolve(REPO_ROOT, 'dist')`로 바꾼다.
2. **허용 집합은 현행 그대로 둔다** — sea-build는 `dist` 자신도 허용(`absOut !== distRoot && !startsWith`)하고 dist-server는 하위만 허용한다. 이번 변경은 기준축 하나뿐이다.
3. `absOut = nodePath.resolve(outDir)`(cwd 기준 해석)는 **그대로 둔다** — dist-server와 같은 조합(cwd 기준 해석 + REPO_ROOT 기준 가드)이 되어 리포 밖·하위 디렉토리 실행이 fail-closed가 된다.

### B. `--fallback` 배포물 경고 (A-4)

1. **테스트 먼저** `test/dist-server-fallback.test.js`를 red로 만든다.
2. `scripts/dist-server.mjs`에 순수 함수를 export한다:
   ```js
   export function fallbackWarning(mode) // 'node-bundled' → 경고 문자열, 그 외('sea' 등) → null
   ```
   - 문자열에는 (i) 폴백 모드라는 사실, (ii) 동봉 `.bat`이 SEA exe를 실행하므로 이 폴더에서는 기동하지 않는다는 사실, (iii) 대신 `node.exe server-bundle.cjs`로 실행하라는 안내가 들어간다.
3. `distServer()`의 요약 출력 직전(exe 복사 후, `mode`가 확정된 지점)에서 `fallbackWarning(exeResult.mode)`가 문자열이면 `process.stdout.write`로 **1줄** 출력한다. 실패로 승격하지 마라(폴백은 명시 플래그로만 도달하는 의도된 경로다).
4. 기존 요약 키(`outDir`·`mode`·`files`·`bytes`·`nodeVersion`·`elapsedMs`)는 제거·개명하지 않는다.
5. 테스트는 `import { fallbackWarning } from '../scripts/dist-server.mjs'`로 잠근다 — 이 파일은 `invokedAsCli` 가드가 있어 import 부작용이 0이다(빌드가 돌지 않는다). 케이스: `'node-bundled'` → 문자열(안내 키워드 포함) / `'sea'` → null / 알 수 없는 값 → null.

### C. 시작 bat 주석 1줄 (A-5)

`packaging/server/기사작성기-server.bat` **상단 주석 블록 안에** `rem` 1~2줄을 추가한다: 재빌드(`npm run dist:server`)를 하면 이 파일의 배포 폴더 사본이 원본으로 **덮어써져 `set` 설정이 사라진다**는 사실과, 설정을 지키려면 이 파일을 다른 이름으로 복사해 쓰거나 시스템 환경변수를 쓰라는 안내. 실행 줄(`cd /d`, `set PORT`, exe 실행, `pause`)은 한 글자도 건드리지 않는다. `chcp 65001`이 있으므로 파일은 **UTF-8로 저장**한다(인코딩을 바꾸면 기존 한글 안내가 깨진다).

### D. import.meta 잠금 테스트의 엄격성 명시 (A-6)

`test/sea-import-meta-lock.test.js`의 **동작은 한 글자도 바꾸지 않는다**. 다음만 한다:

1. 헤더 주석에 "이 스캔은 텍스트 기반이라 **주석·문자열 안의 리터럴도 센다**. `server/**`·`src/**`의 설명 주석에서는 그 단어를 쓰지 말고 '모듈 메타'라고 써라(`server/index.js` 1258행이 그 관행이다)"를 1~2줄 추가한다.
2. 실패 메시지(`assert.equal(hits.length, 1, ...)`)에도 같은 힌트를 한 문장 덧붙인다 — red를 만난 사람이 파일을 열지 않고도 원인을 알 수 있어야 한다.
3. 주석 제외 파싱(`split('//')` 등)을 **넣지 마라**(decisions (7) 기각 사유).

## Acceptance Criteria

```bash
# [1] data snapshot: 아래 빌드/실행 전에 먼저 저장한다(news.db·uploads/는 .gitignore라 git으로는 증명 불가)
node -e "const fs=require('fs'),os=require('os'),p=require('path'),f=p.join(os.tmpdir(),'yh-datasnap.json'),st=fs.existsSync('news.db')&&fs.statSync('news.db'),cur=JSON.stringify([st&&st.size,st&&st.mtimeMs,fs.existsSync('uploads')?fs.readdirSync('uploads').length:null]);if(process.argv[1]=='save'){fs.writeFileSync(f,cur);console.log('SNAP-SAVED '+cur)}else{const b=fs.readFileSync(f,'utf8');console.log((b==cur?'DATA-UNCHANGED-OK ':'DATA-CHANGED-FAIL ')+b+' -> '+cur);process.exit(b==cur?0:1)}" save

node --test test/dist-server-fallback.test.js
node --test test/sea-import-meta-lock.test.js
npm test
npm run lint

# [2] outDir 가드 기준축 — scripts/를 cwd로 두고 기본 outDir로 호출하면 거부돼야 한다(현행은 통과 = 버그)
node -e "const {pathToFileURL}=require('node:url'),path=require('node:path');const mod=pathToFileURL(path.resolve('scripts/sea-build.mjs'));process.chdir('scripts');import(mod).then(m=>m.buildServerExe({outDir:'dist/server-exe'})).then(()=>{console.log('GUARD-MISSING-FAIL');process.exit(1)},e=>{const ok=String(e.message).includes('outDir');console.log((ok?'guard-ok: ':'WRONG-ERROR: ')+e.message);process.exit(ok?0:1)})"
node -e "console.log('scripts/dist exists =', require('fs').existsSync('scripts/dist'))"   # false 여야 한다(가드가 fs 작업 전에 돈다)
node -e "const {pathToFileURL}=require('node:url'),path=require('node:path');import(pathToFileURL(path.resolve('scripts/sea-build.mjs'))).then(m=>m.buildServerExe({outDir:'C:/tmp/outside'})).then(()=>{console.log('GUARD-MISSING-FAIL');process.exit(1)},e=>{const ok=String(e.message).includes('outDir');console.log((ok?'guard-ok: ':'WRONG-ERROR: ')+e.message);process.exit(ok?0:1)})"

# [3] 정상 경로 회귀 — 리포 루트에서의 빌드는 그대로 성공해야 한다(mode=sea, 폴백 경고 없음)
npm run dist:server

# [4] bat 사본 동일성 — 배포 폴더 사본이 원본과 바이트 동일(= 추가한 주석이 배포물까지 간다)
node -e "const fs=require('fs'),p=require('path');const pk=p.join('packaging','server');const bat=fs.readdirSync(pk).find(n=>n.endsWith('.bat'));const outs=fs.readdirSync('dist').map(d=>p.join('dist',d)).filter(d=>fs.existsSync(p.join(d,bat)));const src=fs.readFileSync(p.join(pk,bat));const same=outs.map(d=>fs.readFileSync(p.join(d,bat)).equals(src));console.log('bat copies='+outs.length+' identical='+JSON.stringify(same));process.exit(outs.length>0&&same.every(Boolean)?0:1)"

# [5] data snapshot compare (exit 1 = 실데이터를 건드렸다)
node -e "const fs=require('fs'),os=require('os'),p=require('path'),f=p.join(os.tmpdir(),'yh-datasnap.json'),st=fs.existsSync('news.db')&&fs.statSync('news.db'),cur=JSON.stringify([st&&st.size,st&&st.mtimeMs,fs.existsSync('uploads')?fs.readdirSync('uploads').length:null]);if(process.argv[1]=='save'){fs.writeFileSync(f,cur);console.log('SNAP-SAVED '+cur)}else{const b=fs.readFileSync(f,'utf8');console.log((b==cur?'DATA-UNCHANGED-OK ':'DATA-CHANGED-FAIL ')+b+' -> '+cur);process.exit(b==cur?0:1)}" compare

# [6] diff scope
git status --porcelain
```

## 검증 절차

1. AC를 전부 실행한다. `[3]`의 요약 줄에 `mode=sea`가 찍히고 **폴백 경고가 출력되지 않는지** 확인한다(정상 경로에서 경고가 뜨면 오탐이다).
2. `packaging/server/기사작성기-server.bat`을 Read로 열어 (i) 추가한 `rem` 줄이 한글로 정상 표시되는지(UTF-8 저장), (ii) 실행 줄이 그대로인지 눈으로 확인한다. 자동 게이트는 `[4]`의 사본 동일성이 맡는다.
3. **변이 검증 3종**(각각 red 확인 후 반드시 원복):
   - (a) `fallbackWarning`이 항상 null을 반환하게 → `test/dist-server-fallback.test.js` red.
   - (b) sea-build의 `distRoot`를 다시 `nodePath.resolve('dist')`로 → AC `[2]`의 첫 프로브가 `GUARD-MISSING-FAIL`.
   - (c) `src/db/schema.js` 헤더 주석에 `import.meta`라는 리터럴을 한 줄 넣어 → `test/sea-import-meta-lock.test.js` red(엄격성이 살아 있다는 실증). **반드시 원복**하고, 원복 후 green을 다시 확인한다.
4. 실측 기록: `npm run dist:server` 총 소요(ms)·`mode`·산출 파일 목록, exe 크기.
5. `git status --porcelain` 증분이 소유 파일(`scripts/sea-build.mjs`·`scripts/dist-server.mjs`·`packaging/server/기사작성기-server.bat`·`test/sea-import-meta-lock.test.js`·`test/dist-server-fallback.test.js`·`phases/64-exe-backlog/index.json`)뿐인지 확인한다. `dist/**`는 .gitignore 대상이라 나타나지 않는다.
6. 아키텍처 체크리스트: 런타임 dependencies 5개 불변 · devDependencies 불변 · `web/**`·`src/**`·`server/**`·`client/**`·`docs/**` 무수정 · `scripts/verify-*.mjs`·`scripts/dist-client.mjs` 무수정 · 두 스크립트의 `parseArgs`(step0 소유) 무수정 · DB 무접촉(`[1]`/`[5]` 스냅샷).
7. `phases/64-exe-backlog/index.json`의 step1 status를 갱신한다. 중간 실패 시 산출물을 지우지 말고 진행 지점을 error_message에 남겨라.

## 금지사항

- `scripts/sea-build.mjs`·`scripts/dist-server.mjs`의 `parseArgs`를 고치지 마라. 이유: step0 소유다 — 같은 파일이라도 함수 경계를 지켜야 두 step의 실패 원인이 분리된다.
- 폴백 경고를 예외(throw)로 승격하지 마라. 이유: `--fallback`은 SEA 실패 시 배포물을 건지려고 **명시 플래그로만** 들어가는 경로다. 여기서 죽이면 그 목적이 사라진다.
- 폴백 모드용 bat을 새로 만들거나 bat이 exe/번들을 자동 선택하도록 고치지 마라. 이유: 이월 항목은 "경고 1줄"이고, 시작 스크립트 분기는 배포 문서·검증 게이트까지 함께 바꿔야 하는 별도 결정이다.
- `test/sea-import-meta-lock.test.js`의 스캔 로직·단언을 바꾸지 마라(주석 제외 파싱 금지). 이유: 이 테스트는 SEA 빌드 게이트(`empty-import-meta` 정확히 1건)의 조기 경보이며, 파싱을 넣는 순간 그 파서가 새로운 오탐·누락원이 된다(decisions (7)).
- 변이 검증 (c)에서 넣은 주석 리터럴을 원복하지 않은 채 다음 단계로 가지 마라. 이유: SEA 빌드가 즉시 실패한다(빌드 게이트가 정확히 1건만 허용).
- `packaging/server/README-배포.md`·`packaging/README-배포-통합.md`를 고치지 마라. 이유: 같은 사실을 문서에 복제하면 드리프트원이 된다(decisions (6)). 사실은 그것이 물리는 bat 파일이 들고 있다.
- `dist/**`를 커밋하지 마라. 이유: `.gitignore`가 막고 있고 수백 MB 바이너리는 저장소를 파괴한다.
