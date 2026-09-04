# 아키텍처

## 개요
기사 작성기는 **두 프로세스로 분리**된다.
Vite로 빌드하는 React SPA(클라이언트, `:5173`)와 독립 Express REST/SSE 서버(`127.0.0.1:3001`). 
이 두 프로세스 구성은 개발 시의 사실이고, 배포 시에는 Express가 `vite build` 산출물(`web/dist`)을 같은 출처에서 직접 서빙해 **한 출처로 수렴**한다(설계 자체는 그대로 유지된다 — 아래 "SPA 동일 출처 서빙" 참조).
양쪽 모두 MVC 계층으로 구성하고, 데이터는 Node 내장 SQLite 단일 파일(`news.db`)에 저장한다. 기술 선택의 배경은 `ADR.md` 참조한다.

## 디렉토리 구조
```
server/
  index.js              # 얇은 HTTP/SSE transport — 라우팅 + 인가 게이트만, 비즈니스 로직 없음
  main.js               # SEA/번들 전용 엔트리 — bootstrap({ packaged: true }) 명시 주입 (dev 미사용)
  ftpWatcher.js         # 수집(자동기사) FTP 스풀 디렉토리 watcher — 파일 이벤트 시 controllers.collection.receive 호출 (watch 주입형, 테스트는 실제 FS 미사용)
src/                    # 백엔드 도메인 (transport 비의존, 모두 주입 가능)
  db/                   # schema(멱등 마이그레이션), articleId 생성, softDelete, connection(부트 PRAGMA), instanceLock(단일 인스턴스 잠금 — ADR-012)
  models/               # 데이터 접근 (articleModel · userModel · receiverConfigModel · distributionTargetModel) — 직접 SQL
  services/             # 비즈니스 로직 (article · lifecycle · embargoPolicy · authorization · session · user · mediaSearch · collection · receiverConfig · distributionTarget · distribution · distributionTick · spoolWriter)
  parsers/              # 수집(자동기사) FTP 파일 / API 응답 파서
  controllers/          # 서비스 오케스트레이션 (createControllers)
web/                    # 프론트엔드 (Vite root)
  index.html
  src/
    main.jsx            # 엔트리 — createHttpModel() 주입
    model/              # 주입형 Model 계약(contract.js) + httpModel(REST/SSE 배선) + 에디터/기사구조 로직
    controller/         # React 훅 컨트롤러 (useLogin · useWrite · useView · useSearch · useRcvMgmt · useUserMgmt)
    view/               # 순수 뷰 로직 + 컴포넌트 (에디터 · 컨텍스트 메뉴 · 임베드 · 컬럼 설정 …)
    app/                # App · 라우팅(.do SPA) · context
    styles/             # yonhap.css 디자인 시스템
client/                 # Electron 접속형 클라이언트 셸 (phase 62 — 서버 origin을 loadURL하는 얇은 뷰어)
  main.js               # 메인 프로세스 — 결선만 (부팅 순서 · 창 2종 · 가드 이벤트 · IPC · 메뉴)
  preload.cjs           # 셸 로컬 창 전용 브리지 5함수 (샌드박스 preload는 CJS 강제)
  menu.js / ipcGuard.js / diag.js   # 순수 보조 모듈 (메뉴 템플릿 · sender 검증 · 진단 JSONL)
  lib/                  # Electron 비의존 순수 정책 (serverUrl · clientConfig · windowPolicy · loadFailure · permissionPolicy)
  pages/                # 셸 로컬 페이지 (setup/error — CSP meta · 인라인 스크립트 없음)
server-spring/          # Spring Boot 포팅 서버 (C++/Spring 포팅 P1 — Node 서버와 공존, 같은 계약을 구현한다 · ADR-013)
  src/main/java/harness/news/
    config/ db/ model/ service/ web/ controller/   # 계층은 Node와 동형: controller → service → repository(직접 SQL) → db
                                                   # web/ = 자체 서블릿 필터 체인(CORS·요청로그·CSRF·레이트리밋·경로 정책)과 와이어 포맷 정규화
  README.md             # 빌드·실행·계약 검증 커맨드 · 설정 키↔환경변수 표 · 구현/미구현 라우트
tools/news-migrator/    # news.db(SQLite) → MySQL 8.0 이관 도구 (포팅 P2 · ADR-016 — 독립 Maven 프로젝트)
  src/main/java/harness/newsmigrator/    # CLI(migrate·verify·export·ephemeral-*) · 행 복사 · 전 컬럼 대조 · 역방향 export
  src/main/resources/db/migration/       # V1__baseline.sql = MySQL 측 스키마 정본 (SQLite 측 정본은 src/db/schema.js)
  README.md             # CLI 계약 · 환경변수 키 집합 · 종료코드 · 비파괴 규율 3군 · 검증된 것/안 된 것
news.db                 # SQLite 단일 파일 (User / Article / Contents)
test/                   # 백엔드 테스트 (node --test)
scripts/                # 실행 러너 (seed) + 배포 빌드/검증 (sea-build · dist-server · verify-server-exe · dist-client · verify-client · verify-integration · make-icon)
packaging/server/       # 서버 배포 폴더에 그대로 복사되는 템플릿 (기사작성기-server.bat · README-배포.md)
packaging/client/       # 클라이언트 배포 폴더에 그대로 복사되는 템플릿 (README-배포-클라이언트.md)
```

## 패턴
- **백엔드 MVC + 계층 분리**: HTTP 라우트(`server/index.js`)는 shape 매핑과 인가 게이트만 담당하고, 로직은 `controllers → services → models → db`로 내려간다. 모든 의존성은 주입 가능해서 테스트는 in-memory db/session을 주입한다(프로덕션 `news.db`에 바인딩하지 않음).
- **프론트엔드 MVC**: `View`(순수 함수/컴포넌트) ← `Controller`(React 훅) ← `Model`(주입형 계약). Model은 `freeze`된 `MODEL_KEYS` 계약을 따르고, 실제 REST/SSE 배선은 `httpModel` 뒤에 격리한다. 테스트는 `fakeModel`을 주입한다.
- **얇은 transport**: 비즈니스 로직은 HTTP 밖에 둔다 — 라우트는 "세션 검증 → 인가 게이트 → 컨트롤러 위임 → 응답 매핑"만 한다.
- **두 서버, 한 계약**: Node 서버(`server/**`·`src/**`)와 Spring 서버(`server-spring/**`)가 **같은 REST 계약**(`docs/api-contract/**`)을 구현하고, 두 구현이 같은지는 사람이 아니라 계약 스위트가 판정한다 — `node scripts/spring-contract.mjs --parity`가 프로파일마다 두 서버의 리포트를 뽑아 `scripts/contract-diff.mjs`로 기계 비교한다(상태코드 정수·헤더 문자열 정확 비교). 어긋나면 **Spring을 고친다**(계약·Node는 무수정 — ADR-013).

## 데이터 흐름
```
[쓰기]   사용자 입력 → View → Controller(훅) → Model(httpModel) → fetch(x-session-id)
         → Express 라우트 → 세션 인가 게이트 → controllers → services(lifecycle/authorization)
         → models → SQLite(news.db, 트랜잭션)

[실시간] 기사 생성/수정/상태전이/잠금변경 → 서버 in-process EventEmitter
         → SSE(/api/stream) → httpModel.subscribe → Controller가 "무효화 신호" 수신
         → 자기 필터로 재조회 → View 갱신   (행 데이터를 push받지 않음)

[배부]   송고 성공(articleService.applyAction) → 엠바고 판정(embargoPolicy)으로 배부 종류 결정
         (엠바고 없음 → 즉시 언론사+비언론사 → DPS / 2차 엠바고만 → 언론사 즉시 배부 → EPS
          / 1차·1+2차 → DES로 배부 대기, 시점 배부는 tick — 엠바고 생애주기 RDS→DES→EPS→DPS)
         → distributionService → 활성 DistributionTarget별 spoolWriter
         → DIST_SPOOL_DIR/<spoolDir>/<articleId>_<시각>.json (임시 파일 → rename)
         → Contents.distributedAt 갱신 + ArticleHistory(eventType='distribute', action=kind)
         → 외부 전송기가 스풀을 읽어 발송   (앱은 네트워크 egress·타이머 없음 — ADR-008)

[tick]   외부 운영 cron → POST /api/distribution/tick(Z 세션 — 앱 내 타이머 없음, ADR-008 (3))
         → distributionTickService(도래+미배부 스캔 — embargoPolicy.dueKinds, 이력 기준 멱등)
         → distributionService → spoolWriter(위 [배부]와 동일 경로)
         → articleService.syncEmbargoStatus(DES→EPS→DPS 승격) → 배부 발생 시에만 SSE 'status' 무효화

[실패복구] 수신처 단위 배부 실패 이력 → Z가 실패 목록 조회 → 명시적 재전송(스풀 재기록) — 자동 재시도·타이머 없음(ADR-008)
         목록의 failedAt = 그 그룹의 최신 미해소 실패 행의 시각. 단 tick/송고의 자동 배부 기록 경로는 같은
         사이클·같은 사유의 반복 실패를 중복 억제해 새 행을 남기지 않으므로 그 구간에서는 첫 실패 시각으로
         고정된다(사유 변경·해소 후 재실패·재송고로 새 사이클이 열리면 새 행 → 갱신). Z의 재전송이 다시
         실패하는 경우는 억제 없이 항상 새 행이 생겨 failedAt이 갱신된다
```

### 저장소 병존 — Node=SQLite / Spring=MySQL (포팅 P2 이후의 정상 상태)
- 위 흐름의 `SQLite(news.db)`는 **Node 서버의 저장소**다. Spring 포팅 서버는 `DB_KIND=mysql`이면 같은 REST 계약을
  **MySQL 8.0** 위에서 구현하고(`server-spring`은 여전히 DDL 0 — 부팅 시 존재만 읽기 검증), `DB_KIND=sqlite`(기본값)이면
  종전대로 같은 파일을 연다. **Node 서버(`server/**`·`src/**`)는 무수정 SQLite 정본으로 남는다 — 그것이 롤백 레버다**(ADR-016 ②).
- 대가로 새 위험이 생긴다: **두 저장소가 서로 다른 데이터를 갖는다.** 어느 쪽이 쓰기 정본인지는 기계가 아니라
  **사람의 절차**가 지킨다 — 컷오버·롤백 런북은 `docs/ops-mysql.md` §11(절차)·§9(되돌리기)가 소유한다.
- 이관·대조·역방향 export는 `tools/news-migrator/`가 담당한다(소스 `news.db`는 **읽기 전용**이고 실행 후 **바이트 무변**이다).
  계약 하네스는 `node scripts/spring-contract.mjs --db mysql --parity`로 **Spring(MySQL) vs Node(SQLite)** 를 그대로 비교한다.

### SPA 동일 출처 서빙 (배포 배치)
- 활성 조건: `SPA_DIR`(기본 서버 모듈 기준 `web/dist`)에 `index.html`이 존재할 때만 — 부재 시 비활성(현행 dev 동작 그대로, `npm run dev`는 계속 Vite `:5173`).
- 정적 마운트는 `/uploads`와 SPA 루트 **둘**이다(정적 자산 서빙에는 Accept 조건이 없다). SPA 폴백은 **매칭 파일이 없는** `GET`/`HEAD` 요청 중 경로가 `/api`·`/uploads`가 아니고(대소문자 무관) `Accept`에 `text/html`이 있는 것만 `index.html`을 받는다 — 그 외는 기존 404 그대로.
- 등록 위치는 모든 `/api` 라우트 뒤·전역 에러 핸들러 앞이라 정적/폴백이 API를 가리지 않음이 구조적으로 보장된다.
- "정의되지 않은 경로 → 로그인 페이지"(news.md)는 **SPA의 책임**이며 서버는 문서를 주기만 한다.
- 트레이드오프: 정적 자산 요청도 액세스 로그에 남는다(Z 전용 링 버퍼 소음 — SPA 1회 로드당 3줄 내외로 수용).

### 배포 산출물 (Windows 서버 EXE)
- `npm run dist:server` 한 번으로 `dist/기사작성기-server/`를 만든다 — 파이프라인: vite build → esbuild 단일 CJS 번들 → Node SEA blob → postject 주입 → 폴더 조립(`기사작성기-server.exe` + `web/` + `data/` 빈 골격 + `packaging/server/**` 사본). 2026-08-12 실측: SEA 성공(mode=sea), exe 89.5MB(Node v24.16.0 내장), 부팅 ~1초.
- **경로 해석 규칙**: 패키지 배치는 `<exe 디렉토리>/data`(news.db·uploads)와 `<exe 디렉토리>/web`(SPA)을 기본으로 쓰고 **cwd에 의존하지 않는다**. 비패키지(dev)는 종전대로 cwd 기준 `news.db`·`uploads`, 서버 모듈 기준 `web/dist`. 단일 출처는 `server/index.js`의 `resolveRuntimePaths()`(오버라이드: `DATA_DIR`·`SPA_DIR`)이며, 패키지 여부는 **엔트리(`server/main.js`)가 `bootstrap({ packaged: true })`로 명시 주입**한다(런타임 탐지 아님).
- **런타임 의존성 추가 0** — esbuild·postject는 devDependency(빌드 전용, ADR-010)다. 배포물은 exe + 정적 파일뿐이고 서버 머신에 Node 설치가 필요 없다.
- exe에도 **앱 내 타이머·네트워크 egress는 없다**(ADR-008) — 시점 배부는 외부 cron의 tick pull, 발송은 외부 전송기 책임 그대로다.
- 백업 단위 = `data/` 폴더(DB 비파괴 원칙 유지 — 재빌드·업그레이드는 `data/`를 지우지 않는다).
- 평문 HTTP LAN 배치에서 `NODE_ENV=production` 금지 — 아래 "보안 경계"의 "운영 환경변수 주의"와 같은 축이다(배포 폴더의 bat·README-배포.md가 같은 경고를 싣는다).
- **데이터 폴더당 인스턴스 1개**(ADR-012): 같은 `DATA_DIR`로 두 번째 서버를 부팅하면 콘솔 메시지(stderr — 원인·데이터 폴더·해결) 후 `exit 1`이다(dev·exe 공통). 잔류 락은 없다(OS가 프로세스 종료 시 해제 — 강제 종료·정전 뒤에도 그냥 다시 켜면 된다). 잠금 파일(`<DATA_DIR>/instance-lock.db`, 0바이트)을 열 수 없는 드문 경우에는 경고 후 잠금 없이 계속 부팅한다(부팅을 막지 않는다 — fail-open). 타이머·하트비트 없음(ADR-008).
- 빌드 부작용 1가지: 배포 폴더에서 exe를 직접 띄운 적이 있으면 `<outDir>/data/`에 `instance-lock.db`가 남아, 이후 `npm run dist:server`가 "data/가 비어 있지 않다"는 **경고**를 출력한다(빌드는 계속되고 `data/`는 보존된다 — DB 비파괴 계약 그대로). 이는 정상이며 실패가 아니다.

### 배포 산출물 (Windows 클라이언트 EXE)
- `npm run dist:client` 한 번으로 `dist/기사작성기/`를 만든다 — 파이프라인: Electron 런타임 폴더 복사 → `electron.exe`를 `기사작성기.exe`로 rename → `resources/default_app.asar` 제거 → `resources/app/`에 셸 코드 화이트리스트 배치(+ `packaging/client/**` 사본, 조립 후 금지 패턴 재귀 스캔 게이트). 2026-08-13 실측: 89파일 347.4MB, 조립 ~0.3초, exe 기동→화면 로드 ~0.9초, electron 43.4.0(devDependency 정확 고정 — 런타임 의존성 추가 0, ADR-010과 같은 축).
- **접속형**: 셸은 `loadURL(<서버 origin>/)`만 한다. SPA·API·세션·SSE는 전부 서버(위 "SPA 동일 출처 서빙") 책임이고, 클라이언트에는 DB·백엔드·수집·배부 코드가 **0**이다(SPA의 API base가 빈 문자열 = 상대 경로라 서버 출처만 열면 전부 따라온다). 화면 변경은 서버만 재배포하면 전파된다.
- **창 2종 분리(신뢰 경계)**: 원격 앱 창은 preload 없음(`contextIsolation`·`sandbox`·`nodeIntegration:false` — 서버 침해가 클라이언트 PC 침해로 번지지 않게), 셸 로컬 창(설정/오류)만 최소 preload(브리지 5함수)를 갖고 **절대 원격으로 내비게이트하지 않는다**. 미등록 webContents는 가장 제한적인 로컬 취급이다(fail-closed — 등록 누락이 "허용"으로 새지 않는다).
- **window.open 정책**: `about:blank`(SPA 상세보기·인쇄 창 — 720×800)와 동일 출처만 허용, 외부 http(s)는 기본 브라우저로 위임, 로컬 창의 새 창은 전면 거부(`about:blank` 자식이 부모 webPreferences를 상속하기 때문). 판정은 `client/lib/windowPolicy.js` 순수 함수 단일 출처다.
- **부팅 순서 계약**: `userData` 지정(`CLIENT_USER_DATA`) → 단일 인스턴스 잠금 요청 순서 고정 — 잠금 키가 userData 경로에서 파생되므로 뒤집으면 실사용자 프로필 오염과 검증 거짓 통과가 난다.
- 설정(서버 주소·창 크기)은 `%APPDATA%\기사작성기\config.json`(화이트리스트 파싱, 사용자별). **세션·자격증명은 저장하지 않는다.**
- 셸에도 **앱 내 타이머·주기 통신이 없다**(ADR-008) — 서버 주소 프로브는 사용자 액션당 1회이고 `/api/health`의 `{ ok:true }` 본문까지 확인한 뒤에만 저장한다(200만으로는 임의 웹서버가 "정상"으로 저장된다).
- **secure-origin 스위치(phase 63)**: 저장된 서버 출처가 `http:` + 비-loopback일 때 **그 출처 하나만** secure context로 취급하는 Chromium 스위치를 app ready 전 1회 적용해 LAN 평문 HTTP에서도 `navigator.clipboard`가 산다(판정 단일 출처 `client/lib/secureOrigin.js` 순수 모듈 — main.js는 append와 diag만). 주소 변경·최초 설정 후에는 재시작 1회가 필요하고(안내 다이얼로그), HTTPS 도입 시 조건상 자동 비적용된다.
- **브랜딩(phase 63)**: 빌드가 클라이언트 exe에 아이콘(`packaging/icon/app.ico` — 순수 Node 생성기 `scripts/make-icon.mjs`, `--check`가 sha256으로 커밋본 일치를 잠근다)과 버전(1.0.0 → PE 1.0.0.0)·제품명 리소스를 `resedit`(devDependency — 네이티브 0)으로 적용하고 read-back으로 fail-fast한다. 서버 SEA exe에도 postject 주입 **전** 동일 적용(verify-server-exe full·portable 게이트 통과로 채택).
- **통합 검증 진입점(phase 63)**: `npm run verify:integration`(`scripts/verify-integration.mjs`) — 서버 exe(임시 DATA_DIR 시드)와 클라이언트 exe(임시 userData)를 함께 기동해 CDP(의존성 0 — Node 내장 `WebSocket`)로 전 루프(로그인→기사 작성→목록 SSE 반영→상세보기 팝업 720×800→송고→목록 이탈)와 loopback/LAN 두 시나리오의 secure context·클립보드 표면을 자동 판정한다. LAN은 3분법(인터페이스 없음=skip 0 / 제품 실패=1 / 방화벽 인바운드 차단=2 + netsh 안내)이고, 종료 후 리포 DB·실사용자 %APPDATA%·dist data의 무변을 before/after 스냅샷으로 단언한다(실 데이터 무접촉).

## 상태 관리
- **서버 상태**: `news.db`(SQLite)가 단일 진실 공급원. 클라이언트는 캐시하지 않고 필요 시 재조회한다.
- **세션/인증**: 서버 in-process 세션 스토어(1시간 슬라이딩 만료). 클라이언트는 `sessionId`+`user`를 `sessionStorage`에 저장하고, 새로고침(F5) 시 `/api/session`으로 서버 확인 후 복원한다(복원 전까지 로그인 페이지로 보내지 않음).
- **클라이언트 로컬 상태**: React `useState`/커스텀 훅. 작성 탭 목록과 탭별 작성 내용은 `sessionStorage`에 보존되어 list.do ↔ writer.do 이동 후에도 유지된다.
- **실시간 동기화**: SSE 무효화 신호 기반 — 서버는 "바뀌었다"만 알리고 클라이언트가 재조회한다(권한별 데이터 노출 회피).

## 보안 경계
- 신뢰 경계는 **서버**. acting role은 검증된 `x-session-id` 세션에서만 도출하고 `req.body.role`은 신뢰하지 않는다. 신원(role/active)은 세션 스냅샷이 아니라 **매 요청 User 행 재조회로 재도출**한다(비활성/강등 즉시 반영, ADR-004).
- helmet(CSP), CORS allowlist, 로그인 레이트리밋(15분/10회), bcrypt 해시, 전역 에러 핸들러(내부 스택 비노출). allowlist는 비프로덕션 기본값이 `http://localhost:5173`·`http://127.0.0.1:5173`이고, **프로덕션은 `ALLOWED_ORIGINS`에 등록한 출처만**이다(미설정 시 자기 출처 외 쓰기 403 — `server/index.js`의 `allowedOrigins`). 프로덕션 부팅 시 목록이 비면 경고 로그를 남긴다(`logOriginDiagnostics` — 조용한 전면 403의 원인 추적용, 부팅은 막지 않는다).
- CSRF: 상태 변경 메서드(비 GET/HEAD/OPTIONS)의 Origin/Referer 검증 미들웨어 — 자기 출처·allowlist(`ALLOWED_ORIGINS`)·비프로덕션 loopback만 통과, 그 외 403(`forbidden-origin`). Origin·Referer 부재(서버-서버·cron)는 통과 (ADR-009). CORS와 같은 목록을 공유하므로 프로덕션에서 loopback은 허용되지 않는다.
- 응답 투영: Contents 행의 `lockerSessionId`·`lockerClientId`는 어떤 응답에도 싣지 않는다. 제거 지점은 `src/services/contentsProjection.js`의 `toPublicContents` **단일 지점**이며, 새 읽기 경로는 모델 행을 그대로 내보내지 말고 이 함수를 통과시킨다.
- SSE 재검증: `/api/stream`·`/api/logs/stream`은 접속 시점 인증뿐 아니라 **push 직전에 비연장 재검증**(`controllers.auth.peek` — touch 금지)을 하고, 실패하면 그 신호를 쓰지 않고 종료 이벤트 1회 후 연결을 닫는다(로그 스트림은 `role==='Z'`까지 재확인). 주기 재검증 타이머는 두지 않는다(ADR-008).
- 바인딩: listen 주소는 기본 `127.0.0.1`이고 `HOST` env로만 넓힌다(빈 값·공백은 기본값으로 수렴). loopback 판정은 `localhost`·`::1`·`[::1]`·`127.0.0.0/8`(`server/index.js`의 `isLoopbackHost` 단일 함수 — CSRF 가드의 origin 판정과는 별개다).
- 수집 fail-closed: loopback 밖 바인딩 + `COLLECTION_TOKEN` 미설정이면 `POST /api/collection/receive`·`/pull`이 **503 `collection-disabled`**로 비활성된다(부팅·다른 기능·FTP 스풀 인제스트는 정상, 부트 경고 `logHostDiagnostics` 동반). 이 두 라우트는 세션 게이트가 없어 방어가 "loopback 바인딩 + 선택적 토큰" 둘뿐이라, 바인딩을 여는 순간 방어가 0이 되기 때문이다.
- 동일 출처 서빙(Express가 SPA를 직접 서빙)에서는 `csrfOriginGuard`의 **자기 출처 판정**만으로 쓰기가 통과하므로 `ALLOWED_ORIGINS`는 빈 목록이 정상 구성이다(별도 출처 SPA·호스트 재작성 프록시에서는 여전히 명시 설정이 필요하다).
- 운영 환경변수 주의: `NODE_ENV=production`은 세션 쿠키를 `Secure`+`SameSite=None`으로 만든다 — `FORCE_HTTPS=false`로 평문 HTTP 운영하면 브라우저가 그 쿠키를 저장·전송하지 않아 로그인이 조용히 실패한다(HTTPS 종단은 외부 프록시 책임. 두 스위치는 서로 다른 축이다). 평문 HTTP로 LAN에 여는 구성(`HOST` 설정)에서도 같은 이유로 `NODE_ENV=production`을 켜면 로그인이 조용히 실패한다 — TLS 종단 없이 켜지 마라.
- LAN 개방의 노출 범위: `HOST`로 여는 순간 `/uploads` 정적 파일과 로그인 페이지·로그인 API도 같은 네트워크에서 도달 가능해진다. 업로드 파일명은 서버 발급 랜덤 hex라 열거는 어렵지만 URL을 아는 사람은 **인증 없이** 받을 수 있고(의도된 기존 계약), 로그인은 레이트리밋(15분/10회)에만 의존한다.
- DB 비파괴 원칙: 스키마는 `CREATE TABLE IF NOT EXISTS` / additive `ALTER`만, 행 삭제 없음.
