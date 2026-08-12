# Step 2: dist-pipeline

## 읽어야 할 파일

먼저 아래 파일들을 읽고 프로젝트의 아키텍처와 설계 의도를 파악하라:

- `CLAUDE.md`, `docs/ARCHITECTURE.md`("SPA 동일 출처 서빙 (배포 배치)" 절), `docs/ADR.md`(ADR-008 스풀·타이머 금지, ADR-009 동일 출처)
- `phases/61-server-exe/index.json` — decisions (4)(5)(10)(11) + `phases/61-server-exe/index.json`의 step1 summary(**실측된 mode·exe 이름·경고**를 여기서 확인하라)
- `scripts/sea-build.mjs` (step1 신규) — `buildServerExe()` 반환 계약 `{ mode, exe, files, bytes, nodeVersion, warnings }`
- `scripts/verify-server-exe.mjs` (step1 신규) — `--exe`·`--spa`·`--portable` 인자
- `server/main.js` (step1 신규), `server/index.js`의 `resolveRuntimePaths()`(step0) — 패키지 배치의 기본 경로가 `<exe 디렉토리>/data`·`<exe 디렉토리>/web`임을 확인하라
- `package.json` — scripts 절(여기에 `dist:server`를 추가한다)
- `.gitignore` — `dist/`가 이미 무시되는지 확인(무시된다면 **수정하지 마라**)
- `web/vite.config.js`, `web/index.html` — 빌드 산출물 구조 확인(수정 금지)

## 목표 산출물

```
dist/기사작성기-server/
├─ 기사작성기-server.exe     ← step1의 buildServerExe 산출(폴백 모드면 node.exe + server-bundle.cjs)
├─ web/                      ← vite build 산출물(web/dist/**를 그대로 복사) — exe가 SPA_DIR 기본값으로 서빙
├─ data/                     ← 빈 골격: data/uploads/ · data/rcv-spool/ · data/dist-spool/ (news.db는 첫 부팅에 생성)
├─ 기사작성기-server.bat     ← 환경변수 예시가 담긴 시작 스크립트
└─ (README-배포.md)          ← step3이 packaging/server/에 추가하면 자동으로 함께 복사된다
```

## 작업

### 1. `packaging/server/기사작성기-server.bat` (신규)

배포 폴더 루트에 그대로 복사되는 **템플릿 파일**이다(생성 코드가 아니라 실제 파일로 둔다 — 리뷰·수정이 쉽다).

내용 요건:

- `@echo off` / `chcp 65001 > nul`(한글 콘솔 출력) / `cd /d "%~dp0"`(cwd를 exe 폴더로 고정 — 경로 기본값의 이중 안전장치)
- `set PORT=3001` (기본값 명시)
- 주석 처리된 예시: `HOST`(LAN 개방 시 `0.0.0.0` + **`COLLECTION_TOKEN` 동반 필요**), `COLLECTION_TOKEN`, `DIST_SPOOL_DIR=%~dp0data\dist-spool`, `RCV_SPOOL_DIR=%~dp0data\rcv-spool`, `DATA_DIR`, `SPA_DIR`, `ALLOWED_ORIGINS`, `YOUTUBE_API_KEY`/`GOOGLE_API_KEY`/`GOOGLE_CSE_ID`
- `DATA_DIR`·`SPA_DIR`는 **기본값이 exe 옆**이라 설정이 불필요하다는 사실을 주석으로 명시
- **`.env` 미지원 안내(필수, 상단 주석)**: **exe는 `.env` 파일을 읽지 않는다** — `npm run server`의 `--env-file-if-exists=.env`는 dev 전용 Node CLI 플래그다. 설정은 이 bat의 `set` 또는 시스템/서비스 환경변수로만 한다. 이 한 줄이 없으면 운영자가 배포 폴더에 `.env`를 만들어 두고 "설정이 안 먹는다"로 헤맨다.
- **경고 주석(필수)**: `NODE_ENV=production`을 설정하지 마라 — 세션 쿠키가 `Secure`+`SameSite=None`이 되어 평문 HTTP(LAN) 접속에서 브라우저가 쿠키를 저장·전송하지 않아 **로그인이 조용히 실패한다**(docs/ARCHITECTURE.md 보안 경계 "운영 환경변수 주의"). `FORCE_HTTPS=true`도 같은 이유로 금지(TLS 종단이 외부 프록시에 있을 때만 켠다).
- 마지막에 exe 실행 + `pause`(창이 즉시 닫혀 오류 메시지를 못 보는 사고 방지)
- 폴백 모드(`node-bundled`)라면 exe 대신 `node.exe server-bundle.cjs`를 실행하는 형태여야 한다 — step1의 실측 mode에 맞춰 작성하라(둘 다 지원할 필요는 없다. **실제 산출된 mode 하나만** 정확히 반영하고, 그 사실을 파일 상단 주석에 적어라).

### 2. `scripts/dist-server.mjs` (신규)

```js
export async function distServer({
  outDir = 'dist/기사작성기-server',
  skipWeb = false,     // --skip-web: 직전 web/dist 재사용(반복 실행 시간 단축)
  fallback = false,    // step1 buildServerExe로 그대로 전달
} = {}) // → { outDir, mode, files, bytes }
```

CLI: `node scripts/dist-server.mjs [--out <dir>] [--skip-web] [--fallback]`. 절차:

1. **가드 + 선택적 정리**: `outDir`가 `dist/` 하위인지 먼저 확인하고 아니면 즉시 거부한다(임의 경로 삭제 방지).
   - 정리는 `rmSync(outDir, { recursive: true })` 같은 **통삭제가 아니라 알려진 산출물만** 지운다: 실행 파일(exe 또는 `node.exe`+`server-bundle.cjs`), `web/`, `packaging/server/`에서 온 파일들(.bat·README-배포.md 등). 이유: 이전 빌드 잔여 파일이 섞이면 배포물 구성이 보증되지 않으므로 산출물은 새로 만들어야 한다.
   - **`<outDir>/data/`는 삭제 대상에서 제외한다.** 안에 파일이 있으면 그대로 보존하고, 없으면 골격만 만든다. 이유: 운영자가 그 폴더에 `news.db`를 복사해 두고 재빌드를 돌리는 흐름이 실제로 발생한다 — 통삭제하면 운영 DB가 소실된다(DB 비파괴 원칙).
   - `data/`가 이미 비어 있지 않으면 그 사실을 stdout에 1줄 경고로 남겨라(배포물에 데이터가 섞여 나갈 수 있다는 신호).
2. **SPA 빌드**(`skipWeb`이 아니면): vite를 JS API로 호출한다(`import { build } from 'vite'` → `build({ root: 'web' })`). 셸/`npm.cmd` spawn은 플랫폼 의존이라 쓰지 마라. 산출물은 기존과 동일하게 `web/dist/`다.
3. **서버 실행 파일**: `buildServerExe({ outDir: 'dist/server-exe', fallback })`를 import해 호출하고 산출 파일을 `outDir` 루트로 복사한다. **빌드 로직을 여기서 다시 구현하지 마라**(step1 모듈 재사용).
4. **조립**:
   - `web/dist/**` → `<outDir>/web/**` (재귀 복사)
   - `<outDir>/data/`, `<outDir>/data/uploads/`, `<outDir>/data/rcv-spool/`, `<outDir>/data/dist-spool/` 생성(빈 폴더)
   - `packaging/server/**`의 **모든 파일**을 `<outDir>/` 루트로 그대로 복사(현재는 .bat, step3이 README-배포.md를 추가하면 자동 포함된다 — 파일 목록을 스크립트에 하드코딩하지 마라)
5. **요약 출력**: mode·파일 수·총 크기·`outDir` 절대 경로를 stdout에 출력하고 결과 객체를 반환한다.

**CRITICAL(배포물 위생)**: 산출 폴더에 다음을 절대 복사하지 마라 — `news.db`(및 `-wal`/`-journal`), `.env`, 리포 루트의 `uploads/`, `node_modules/`, `phases/`, `docs/`, `test/`, `src/`, `.git`. 이유: 운영 데이터·시크릿 유출이며, 배포물에 실 DB가 들어가면 운영자가 그것을 그대로 쓰다가 개발 데이터를 운영으로 승격시킨다. 특히 **시드된 `news.db`가 배포 폴더에 남는 경로를 전부 봉쇄하라**(샘플 계정 비밀번호가 배포물에 실린다) — 검증은 임시 `DATA_DIR` 또는 `dist/portable-probe/` 사본에서만 한다(아래 AC).

### 3. `package.json` scripts

```json
"dist:server": "node scripts/dist-server.mjs"
```

- 기존 스크립트(`dev`·`build`·`server`·`seed`·`test`·`test:web`·`lint`)는 **한 글자도 바꾸지 마라**.
- `dependencies`·`devDependencies`는 이 step에서 건드리지 마라(step1 소유).

## Acceptance Criteria

```bash
npm run dist:server

# 산출 구조 단언 — 하나라도 없으면 실패다.
node -e "const fs=require('fs'),p=require('path'); const d='dist/기사작성기-server'; \
  const must=['web/index.html','data','data/uploads','data/rcv-spool','data/dist-spool','기사작성기-server.bat']; \
  for (const f of must) if(!fs.existsSync(p.join(d,f))) throw new Error('missing: '+f); \
  const forbidden=['news.db','.env','node_modules','src','test','docs','phases','data/news.db']; \
  for (const f of forbidden) if(fs.existsSync(p.join(d,f))) throw new Error('forbidden artifact: '+f); \
  console.log('layout-ok', fs.readdirSync(d).join(' | '));"

# 실기 검증(A) — 배포 폴더의 exe가 그 폴더의 web/을 서빙하고 임시 DATA_DIR의 DB에 쓴다.
#   인증·기사 생성 프로브는 이 모드에서만 돈다(시드는 임시 디렉토리에만 만들어진다).
node scripts/verify-server-exe.mjs --exe "dist/기사작성기-server/기사작성기-server.exe" --spa "dist/기사작성기-server/web"

# 실기 검증(B) 포터블 — 배포 폴더 '사본'에서 돌린다(원본 무오염: portable 모드는 실행 파일 옆에 data/를 만든다).
#   프로브 집합은 health 200 + /login.do SPA 폴백 + <exeDir>/data/news.db 스키마 생성, 이 3개뿐이다.
node -e "const fs=require('fs'); fs.rmSync('dist/portable-probe',{recursive:true,force:true}); \
  fs.cpSync('dist/기사작성기-server','dist/portable-probe',{recursive:true}); console.log('copy-ok');"
node scripts/verify-server-exe.mjs --exe "dist/portable-probe/기사작성기-server.exe" --portable

# 원본 재확인 — 포터블 프로브가 배포 폴더를 건드리지 않았다(data/에 news.db가 생기지 않았다).
node -e "const fs=require('fs'); if(fs.existsSync('dist/기사작성기-server/data/news.db')) throw new Error('배포 폴더가 오염됐다'); console.log('pristine-ok');"

# 재실행 멱등
npm run dist:server && node -e "console.log('rebuild-ok')"

# 무회귀
npm test && npm run lint && npm run build && npm run test:web
```

폴백 모드(`node-bundled`)라면 `--exe "…/node.exe" --script "…/server-bundle.cjs"`로 호출하고 bat도 그 형태로 작성하되, **검증(A)의 전체 프로브와 검증(B)의 3개 프로브는 그대로 통과해야 한다**(모드가 달라도 계약은 같다).

## 검증 절차

1. 위 AC 커맨드를 전부 실행한다(전체 스위트는 2회 연속 동일 결과 확인).
2. `dist/기사작성기-server/` 산출물을 손으로 열어 확인한다:
   - `web/`에 `index.html`과 `assets/`가 있는가(vite 산출 구조 그대로)?
   - `data/`가 **비어 있는가**(하위 골격 폴더 3개 외에 `news.db`·업로드 파일이 없는가)? 포터블 검증은 사본(`dist/portable-probe/`)에서만 돌므로 원본은 깨끗해야 한다 — 원본에 `data/news.db`가 있으면 **검증 경로가 잘못된 것이니 스크립트를 고쳐라**(파일을 지워서 넘기지 마라).
   - `.bat`을 텍스트로 열어 `NODE_ENV=production` 금지 경고, `.env` 미지원 안내, 실행 라인이 있는가?
3. `git status --porcelain` 증분이 `scripts/dist-server.mjs`·`packaging/server/기사작성기-server.bat`·`package.json` 뿐인지 확인한다(`dist/**`는 잡히지 않아야 한다).
4. 아키텍처 체크리스트: `server/**`·`src/**`·`web/**`·`test/**` 무수정 / 런타임 의존성 추가 0 / DB 스키마·행 변경 0 / 앱 내 타이머·egress 0(ADR-008).
5. `phases/61-server-exe/index.json`의 step2를 갱신한다(completed + summary에 산출 크기·mode·소요 시간 / error / blocked).

## 금지사항

- `outDir` 가드 없이 삭제 로직을 쓰지 마라("dist/ 하위인가" 검사 필수). 이유: 인자 오타 하나로 리포나 운영 폴더가 지워진다.
- **`<outDir>/data/`를 삭제 대상에 포함하지 마라**(통삭제 `rmSync(outDir, {recursive:true})` 금지). 이유: 운영자가 그 폴더에 복사해 둔 `news.db`가 재빌드 한 번에 소실된다 — DB 비파괴 원칙 위반이며 복구 경로가 없다.
- 배포 폴더에 `news.db`·`.env`·리포 `uploads/`를 복사하지 마라. 검증용 시드 DB가 배포 폴더에 남게 하지도 마라. 이유: 운영 데이터·시크릿 유출이며, 시드 계정 비밀번호가 배포물에 실린다.
- 포터블 검증을 배포 폴더 **원본**에 대고 돌리지 마라. 이유: 그 모드는 실행 파일 옆에 `data/news.db`를 만들어 배포물을 오염시킨다 — 반드시 `dist/portable-probe/` 사본을 쓴다.
- `packaging/server/`에서 복사할 파일 목록을 스크립트에 하드코딩하지 마라. 이유: step3이 추가하는 `README-배포.md`가 자동으로 포함되어야 하며, 하드코딩하면 step3이 스크립트를 다시 고쳐야 한다(레이어 경계 침범).
- exe 빌드 절차(esbuild·SEA·postject)를 이 스크립트에 다시 구현하지 마라. 이유: step1 모듈이 단일 출처다 — 복제하면 두 곳이 어긋난다.
- `npm.cmd`·셸 파이프·`&&` 체인으로 vite/npm을 spawn하지 마라. 이유: Windows/POSIX 셸 차이로 빌드가 환경에 따라 조용히 실패한다(Node API 또는 `process.execPath` 직접 실행을 쓴다).
- `.gitignore`를 수정하지 마라(이미 `dist/`가 무시된다 — 실측으로 확인하고, 정말 필요하면 한 줄만 추가하고 근거를 summary에 남겨라). 이유: 무접촉 파일 최소화.
- 배포물에 자동 시작(레지스트리 Run·시작 프로그램 등록)이나 서비스 설치를 넣지 마라. 이유: 운영자 동의 없는 시스템 변경이며, 서비스 등록은 문서 안내(step3)로만 다룬다.
- 기존 npm 스크립트 문자열을 바꾸지 마라. 기존 테스트를 깨뜨리지 마라.
