# Step 3: deploy-docs

## 읽어야 할 파일

먼저 아래 파일들을 읽고 프로젝트의 기획·아키텍처·설계 의도를 파악하라:

- `CLAUDE.md`
- `docs/ARCHITECTURE.md` — 전체. 특히 "개요" · "디렉토리 구조" · "SPA 동일 출처 서빙 (배포 배치)" · "보안 경계"(79·87~91행: NODE_ENV/FORCE_HTTPS 조합, 바인딩, 수집 fail-closed, LAN 노출 범위)
- `docs/ADR.md` — 전체. 특히 **철학 문단**(4행)과 ADR-002(node:sqlite)·ADR-007/008(앱 내 타이머·egress 금지)·ADR-009(동일 출처 배포 전제)
- `README.md` — "요구사항"·"실행법"·"환경변수" 절
- `.env.example`
- `phases/61-server-exe/index.json` — decisions 전체 + **step0~2의 summary(실측 수치·최종 mode·산출 구조)**. 문서에 적을 숫자·경로는 전부 여기서 가져오고, 추측하지 마라.
- `server/index.js` — `resolveRuntimePaths`(경로 기본값의 진실), `bootstrap()`, 수집 fail-closed 가드, `logHostDiagnostics`
- `scripts/dist-server.mjs`, `scripts/sea-build.mjs`, `packaging/server/기사작성기-server.bat`
- `docs/rcv.md`(수집), `docs/SCHEMA.md`(백업 대상 이해)

## 작업

이 step은 **문서만** 만진다(실행 코드 0줄). 새로 만드는 파일 1개 + 갱신 4개 + phase 마감이다.

### 1. `packaging/server/README-배포.md` (신규 — 운영 가이드)

배포 폴더 루트에 그대로 복사되는 파일이다(step2의 `dist-server.mjs`가 `packaging/server/**`를 통째로 복사하므로 스크립트 수정은 필요 없다). **운영자(비개발자)가 이 문서만 보고 설치·기동·백업할 수 있어야 한다.** 목차:

1. **구성** — 폴더 구조 트리(exe·web/·data/·bat)와 각 항목의 역할. "서버 머신에 Node 설치 불필요", "포터블 — 폴더를 통째로 복사하면 이동 완료".
2. **요구사항** — Windows x64. 내장 Node 버전(step1 실측값 — 빌드 머신의 `process.execPath`가 그대로 박힌다. Node를 올리려면 **재빌드**가 필요하다).
3. **시작 / 중지** — `기사작성기-server.bat` 더블클릭(권장) 또는 exe 직접 실행. 중지는 콘솔 창에서 `Ctrl+C` 또는 창 닫기. 접속 주소: `http://127.0.0.1:3001/login.do`(기본), LAN이면 `http://<서버IP>:<PORT>/login.do`.
4. **최초 설치: 사용자 계정 준비** — 배포 폴더의 `data/`는 비어 있고 **사용자가 0명이라 그대로는 로그인할 수 없다**. 절차: (a) 기존 운영 중인 `news.db`가 있으면 서버를 멈추고 `data/`에 복사한다(권장), (b) 신규 설치는 개발 머신에서 `npm run seed`로 만든 `news.db`를 복사하고 **샘플 계정 비밀번호를 즉시 변경**한다. exe에는 계정 생성 경로가 없다는 사실을 명시하라(이 제약은 의도된 범위 결정이다 — index.json open_questions (a)).
5. **환경변수** — 표로 정리. 각 항목: 이름 / 기본값 / 설명 / 주의.
   - **맨 앞에 필수 1줄**: **exe는 `.env` 파일을 읽지 않는다.** 설정은 `기사작성기-server.bat`의 `set` 또는 시스템/서비스 환경변수로만 한다(`npm run server`가 쓰는 `--env-file-if-exists=.env`는 dev 전용 Node CLI 플래그다). 이 사실을 모르면 운영자가 배포 폴더에 `.env`를 만들어 두고 "설정이 적용되지 않는다"로 헤맨다.
   - `PORT`(3001) · `HOST`(127.0.0.1 — **loopback 밖으로 열면 `COLLECTION_TOKEN` 미설정 시 수집 인제스트 HTTP 라우트가 503 `collection-disabled`로 비활성된다**. FTP 스풀 수집은 영향 없음) · `DATA_DIR`(기본 = **exe 옆 `data`**) · `SPA_DIR`(기본 = **exe 옆 `web`**, 빈 값이면 SPA 서빙 강제 비활성) · `COLLECTION_TOKEN` · `RCV_SPOOL_DIR`(미설정 = FTP 수집 비활성) · `DIST_SPOOL_DIR`(미설정 = **배부 비활성**) · `ALLOWED_ORIGINS`(동일 출처 배포에서는 **빈 목록이 정상**) · `YOUTUBE_API_KEY`/`GOOGLE_API_KEY`/`GOOGLE_CSE_ID`(없으면 검색이 빈 결과)
   - **설정하면 안 되는 것** 절을 따로 둔다: `NODE_ENV=production`(세션 쿠키가 `Secure`+`SameSite=None`이 되어 **평문 HTTP LAN 접속에서 로그인이 조용히 실패한다** — 로그인 화면은 뜨는데 인증만 안 되므로 원인 추적이 어렵다), `FORCE_HTTPS=true`(TLS 종단이 외부 프록시에 있을 때만).
6. **배부 운영(선택)** — `DIST_SPOOL_DIR`를 `data\dist-spool`로 설정하면 배부가 활성화된다. 앱은 스풀에 파일을 쓸 뿐 **네트워크로 보내지 않는다** — 외부 전송기가 별도로 필요하다(ADR-008). 엠바고 시점 배부는 **앱 내 타이머가 없고** 외부 cron이 `POST /api/distribution/tick`을 Z 세션으로 주기 호출해야 한다. Windows 작업 스케줄러 + PowerShell 예시를 싣되(로그인 → `sid` 획득 → tick 호출), 세션이 1시간 슬라이딩 만료라 **호출 때마다 로그인해야 한다**는 제약과 Z 계정 자격증명을 스크립트 파일에 평문으로 두지 말라는 경고를 함께 적어라.
7. **수집 운영(선택)** — `RCV_SPOOL_DIR` 감시 방식(외부 FTPd가 스풀에 파일을 떨어뜨린다), LAN 개방 시 `COLLECTION_TOKEN` 필수.
8. **백업 / 복구** — 백업 = **서버 중지 후 `data/` 폴더 복사**(`news.db` + `-wal`/`-journal` 동반 파일 + `uploads/`). 복구 = 그 폴더를 되돌려 놓기. **DB 파일을 지우지 마라**(행 삭제 금지 원칙 — 이 앱은 어떤 데이터도 삭제하지 않는다).
9. **업그레이드** — 새 배포 폴더를 풀고, 이전 폴더의 `data/`를 새 폴더로 옮긴 뒤(또는 `DATA_DIR`로 지정) 이전 폴더는 보존한다. 스키마 마이그레이션은 부팅 시 자동·멱등이며 기존 데이터를 보존한다.
10. **Windows 서비스로 등록(선택)** — NSSM 권장(`nssm install ...` 요지 + 환경변수 설정 위치). `sc.exe create`는 콘솔 앱을 서비스로 올리면 서비스 제어에 응답하지 않아 권장하지 않는다는 사실을 적어라. **자동 등록 스크립트는 동봉하지 않는다**(관리자 권한·환경 의존이라 조용히 실패하면 원인 추적이 어렵다).
11. **문제 해결** — SmartScreen/백신 경고(서명되지 않은 exe — 신뢰 절차 안내, 코드 서명은 범위 밖) · 포트 충돌(EADDRINUSE → `PORT` 변경) · 로그인이 안 됨(`NODE_ENV` 확인, 쿠키 차단) · 수집 503(`COLLECTION_TOKEN`) · 배부 파일이 안 생김(`DIST_SPOOL_DIR` 미설정) · SPA가 안 뜸(`web/` 폴더 존재·`SPA_DIR`) · 방화벽(LAN 개방 시 인바운드 허용 필요).
    - **설치 경로 주의(필수 1줄)**: `C:\Program Files` 같은 보호 경로에 폴더를 두지 마라 — exe 옆 `data/`에 `news.db`·업로드 파일을 써야 하는데 관리자 권한 없이는 쓰기가 막혀 **EPERM/EACCES로 기동이 실패**한다. `D:\기사작성기-server`처럼 쓰기 가능한 경로를 쓰거나, 부득이하면 `DATA_DIR`를 쓰기 가능한 폴더로 지정하라.
12. **로그** — 로그는 파일로 저장되지 않고 메모리 링 버퍼에만 있다(Z 관리자 화면에서 조회, 재시작 시 유실 — ADR-007). 콘솔 창 출력이 부팅 진단(바인드 주소·SPA 경로·경고)의 1차 정보다.

문서 톤: 명령형·짧은 문장. 경로는 실제 산출 구조와 **정확히** 일치해야 한다(step2 결과와 대조하라).

### 2. `docs/ARCHITECTURE.md` — "배포 산출물" 절 1개 추가

"SPA 동일 출처 서빙 (배포 배치)" 절 **뒤에** `### 배포 산출물 (Windows 서버 EXE)`를 추가한다. 담을 내용(불릿 5~7개, 장황하지 않게):

- 산출 구조와 `npm run dist:server` 파이프라인 요약(vite build → esbuild 단일 CJS 번들 → SEA blob → postject 주입 → 폴더 조립). step1이 폴백(`node-bundled`)으로 확정됐다면 그 형태를 사실대로 기술하라.
- **경로 해석 규칙**: 패키지 배치는 `<exe 디렉토리>/data`(news.db·uploads)와 `<exe 디렉토리>/web`(SPA)을 기본으로 쓰고 cwd에 의존하지 않는다. 비패키지(dev)는 종전대로 cwd 기준 `news.db`·`uploads`, 서버 모듈 기준 `web/dist`. 단일 출처는 `server/index.js`의 `resolveRuntimePaths()`이며 패키지 여부는 **엔트리(`server/main.js`)가 `bootstrap({ packaged: true })`로 명시 주입**한다(런타임 탐지 아님).
- **런타임 의존성은 0개 추가**(esbuild·postject는 devDependency = 빌드 전용). 배포물은 exe + 정적 파일뿐이고 서버 머신에 Node 설치가 필요 없다.
- exe에도 **앱 내 타이머·네트워크 egress는 없다**(ADR-008) — 시점 배부는 외부 cron의 tick pull, 발송은 외부 전송기.
- 백업 단위 = `data/` 폴더(DB 비파괴 원칙 유지).
- 평문 HTTP LAN 배치에서 `NODE_ENV=production` 금지(기존 79행 주의와 같은 축 — 여기서는 배포 산출물 맥락으로 한 줄만 참조).

"디렉토리 구조" 트리에 `server/main.js`(SEA/번들 엔트리) 한 줄과, 필요하면 `packaging/server/`·`scripts/dist-server.mjs`를 추가하라. **다른 절의 문장은 바꾸지 마라.**

### 3. `docs/ADR.md` — ADR-010 신설 + 철학 1문장

- **ADR-010**(제목 예: "서버 배포는 Node SEA 단일 실행 파일 — esbuild 번들은 빌드 전용 의존성"). 기존 ADR 형식 그대로 **결정 / 이유 / 트레이드오프** 3항목으로 쓴다.
  - 결정: 서버를 Node SEA로 단일 exe로 배포한다. 그 전제인 "단일 CJS 스크립트"를 만들기 위해 esbuild로 번들하고 postject로 blob을 주입한다. 두 도구는 **devDependencies**이며 런타임 의존성은 5개 그대로다(추가 0). 패키지 여부는 엔트리가 명시 주입하고, 데이터·SPA 경로는 exe 위치 기준으로 해석한다. 실패 시 폴백은 node.exe 동봉 폴더다.
  - 이유: 서버 머신에 Node 설치·버전 관리·`npm install`을 요구하지 않기 위함. 5개 의존성이 전부 순수 JS라 네이티브 모듈 재빌드 문제가 없고(실측), DB가 내장 `node:sqlite` 단일 파일이라 외부 서비스 의존이 없다(ADR-002). "외부 의존성 최소화"는 **런타임** 축의 원칙이며 빌드 도구는 배포물에 들어가지 않는다.
  - 트레이드오프: exe에 Node 런타임이 통째로 들어가 파일이 크다(step1 실측값을 적어라). 빌드 머신의 Node 버전이 배포물에 고정되어 보안 패치에 재빌드가 필요하다. SEA는 실험적 기능이라 Node 업그레이드 시 절차가 깨질 수 있다(그래서 폴백 경로를 남긴다). 스택 추적이 번들 좌표로 나온다. 서명되지 않은 exe는 SmartScreen 경고를 띄운다. 크로스 컴파일은 불가하다(빌드 머신 = 배포 대상 플랫폼).
  - **실측이 폴백으로 끝났다면** 결정문을 사실대로 쓰라("SEA 주입이 X 때문에 실패해 node.exe 동봉 폴더를 채택한다") — 계획 문구를 그대로 베끼지 마라.
- **철학 문단**(4행): "런타임 의존성은 Express와 보안 미들웨어뿐, DB·번들러·테스트는 내장/표준 도구 사용"이 이 phase로 오해를 부른다. **한 문장만** 보강해 "빌드 도구(프론트 vite, 서버 배포 esbuild/postject)는 devDependency이며 런타임 의존성 축과 구분한다"는 취지를 명시하라.
- **ADR-001~009의 본문은 한 글자도 바꾸지 마라.**

### 4. `README.md` · `.env.example`

- `README.md`: "배포 (Windows 서버 EXE)" 절 신설 — `npm run dist:server` 커맨드, 산출 경로, 산출물 구성 3줄, 운영 가이드는 `packaging/server/README-배포.md`(배포 폴더에 동봉됨)를 보라는 포인터. "환경변수" 절에 `DATA_DIR` 항목 추가(기본: dev는 cwd, 패키지 배치는 exe 옆 `data`). `SPA_DIR` 설명의 "기본: 서버 모듈 기준 `web/dist`"에 패키지 배치 기본값(exe 옆 `web`)을 한 구절 덧붙여라.
- `.env.example`: `DATA_DIR` 주석 예시 1항목 추가(값 미기입). 기존 항목은 그대로.

### 5. phase 마감

- `phases/61-server-exe/index.json`: step3을 `completed` + summary. 필요하면 `decisions`에 실측으로 확정된 사항(최종 mode·exe 크기·경고 처리)을 **추가**하라(기존 항목 삭제 금지).
- `phases/index.json`: `61-server-exe` 항목의 `status`를 `completed`로 바꾸고 `note`에 phase 요약(범위·4 step·실측 수치·제외 항목·잔여 백로그)을 남긴다. **다른 phase 항목은 건드리지 마라.**

## Acceptance Criteria

```bash
# 문서만 바뀌었으므로 전 스위트가 그대로여야 한다.
npm test && npm run lint && npm run build && npm run test:web

# 배포 파이프라인 재실행 — 새 README-배포.md가 산출 폴더에 자동 포함되는지 확인한다.
npm run dist:server
node -e "const fs=require('fs'),p=require('path'); const d='dist/기사작성기-server'; \
  for (const f of ['README-배포.md','기사작성기-server.bat','web/index.html','data/uploads']) \
    if(!fs.existsSync(p.join(d,f))) throw new Error('missing: '+f); \
  const t=fs.readFileSync(p.join(d,'README-배포.md'),'utf8'); \
  for (const k of ['NODE_ENV','.env','DATA_DIR','SPA_DIR','COLLECTION_TOKEN','DIST_SPOOL_DIR','백업']) \
    if(!t.includes(k)) throw new Error('README-배포.md missing topic: '+k); \
  console.log('docs-ok', t.length+' chars');"

# 실기 재확인(문서에 적은 기동 절차가 실제로 맞는지) — 포터블 모드는 실행 파일 옆에 data/를 만들므로
# 반드시 사본에서 돌린다(배포 폴더 원본 무오염 — step2와 같은 규율).
node -e "const fs=require('fs'); fs.rmSync('dist/portable-probe',{recursive:true,force:true}); \
  fs.cpSync('dist/기사작성기-server','dist/portable-probe',{recursive:true}); console.log('copy-ok');"
node scripts/verify-server-exe.mjs --exe "dist/portable-probe/기사작성기-server.exe" --spa "dist/portable-probe/web" --portable
node -e "const fs=require('fs'); if(fs.existsSync('dist/기사작성기-server/data/news.db')) throw new Error('배포 폴더가 오염됐다'); console.log('pristine-ok');"
```

폴백 모드(`node-bundled`)라면 위 두 verify 호출에 `--script "…/server-bundle.cjs"`를 함께 넘겨라.

## 검증 절차

1. 위 AC 커맨드를 실행한다(전체 스위트 2회 연속 동일 결과).
2. **문서-실코드 대조**(문서 phase의 핵심 — 하나씩 실제 코드/산출물로 확인하고 결과를 summary에 남겨라):
   - `DATA_DIR`·`SPA_DIR` 기본값 서술 ↔ `server/index.js`의 `resolveRuntimePaths()` 실제 분기
   - 수집 503 조건 서술 ↔ `logHostDiagnostics`/수집 라우트 가드
   - `DIST_SPOOL_DIR` 미설정 = 배부 비활성 서술 ↔ `bootstrap()`·컨트롤러 판정
   - tick이 외부 cron pull이라는 서술 ↔ `POST /api/distribution/tick` 라우트 주석(앱 내 타이머 없음)
   - 배포 폴더 트리 ↔ `dist/기사작성기-server/` 실제 구조
   - "exe는 `.env`를 읽지 않는다" 서술 ↔ `package.json`의 `server` 스크립트(`--env-file-if-exists`는 node CLI 플래그이며 exe 실행에는 개입할 수 없다) + `기사작성기-server.bat`의 `set` 방식
   - 내장 Node 버전·exe 크기 ↔ step1 summary 실측값
3. `git diff docs/ADR.md`로 **ADR-001~009 본문이 무수정**인지, 변경이 ADR-010 신설 + 철학 1문장뿐인지 눈으로 확인한다.
4. `git status --porcelain` 증분이 `packaging/server/README-배포.md`·`README.md`·`.env.example`·`docs/ARCHITECTURE.md`·`docs/ADR.md`·`phases/61-server-exe/index.json`·`phases/index.json` 뿐인지 확인한다.
5. `phases/61-server-exe/index.json`의 step3과 `phases/index.json`을 갱신한다(completed / error / blocked).

## 금지사항

- `docs/news.md`를 수정하지 마라. 이유: 사용자 소유 스펙 문서이며 이 phase의 무접촉 목록에 있다.
- ADR-001~009의 문장을 고치지 마라. 이유: 이 phase가 거짓으로 만든 문장은 없다(SPA 서빙 관련 정정은 phase 60에서 이미 끝났다) — 손대면 검토 범위가 폭발한다.
- 실측하지 않은 수치·절차를 문서에 쓰지 마라(exe 크기·부팅 시간·Node 버전·서비스 등록 커맨드 전부). 이유: 운영 문서의 거짓 수치는 장애 시 오판을 만든다. 확인할 수 없으면 그 항목을 빼거나 "환경에 따라 다름"으로 적어라.
- 문서에 자격증명·토큰·실제 IP·계정 비밀번호를 예시로라도 박지 마라(`change-me` 같은 placeholder만). 이유: 배포물에 동봉되는 문서다.
- 코드 파일(`server/**`·`src/**`·`web/**`·`scripts/**`·`test/**`·`package.json`)을 수정하지 마라. 이유: 이 step은 문서 전용이다 — 코드가 섞이면 "문서만 바뀌었다"는 무회귀 근거가 사라진다. 코드 수정이 필요해 보이면 그 사실을 summary/백로그에 적고 멈춰라.
- 초기 계정 생성 기능(exe 시드 서브커맨드·부트 자동 관리자 생성)을 문서로라도 "곧 제공"이라고 약속하지 마라. 이유: 사용자 확정이 필요한 인증 표면 변경이다(index.json open_questions (a)) — 현재 절차(기존 news.db 복사)만 사실대로 적어라.
- 기존 테스트를 깨뜨리지 마라.
