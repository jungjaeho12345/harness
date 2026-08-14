# 기사 작성기 (Article Production System)

기자·데스크·관리자가 기사를 **작성 → 검수 → 송고**하는 사내 보도 제작 도구.
**제작(기사작성기)** + **수집(자동기사)** + **배부** 시스템을 구현한다(배부는 2026-07-26 착수 — ADR-008).

- 프론트엔드: Vite + React 19 SPA (`:5173`)
- 백엔드: 독립 Express REST/SSE 서버 (`127.0.0.1:3001`)
- 출처는 **개발 시 둘**(SPA `:5173` + API `:3001`, Vite 프록시로 연결) / **배포 시 하나**다(빌드 후 Express가 SPA와 `/api`를 같은 출처에서 서빙)
- DB: Node 내장 SQLite(`node:sqlite`) 단일 파일 `news.db`

설계 배경은 `docs/`(PRD·ARCHITECTURE·ADR·SCHEMA·news·rcv·UI_GUIDE) 참조.

## 요구사항

- Node.js **≥ 22.5** (내장 `node:sqlite` 사용. 개발은 Node 24 검증)
- `npm install`은 Electron 런타임(약 350MB, 클라이언트 EXE 빌드/실행용 devDependency)을 함께 내려받는다.
  서버 빌드 전용 머신 등에서 이를 건너뛰려면 `ELECTRON_SKIP_BINARY_DOWNLOAD=1`을 설정하고 설치한다
  (검증됨 — 패키지는 설치되고 런타임 바이너리만 생략된다. 그 머신에서는 `client:dev`·`dist:client`가 불가).

## 실행법

```bash
npm install        # 의존성 설치
npm run seed       # 샘플 사용자(R/D/Z) 시드 — news.db 생성 + 멱등 insert
npm run server     # API 서버 (127.0.0.1:3001)
npm run dev        # 프론트엔드 개발 서버 (Vite, :5173)
```

`npm run server`와 `npm run dev`는 별도 터미널에서 동시에 띄운다.
브라우저에서 `http://localhost:5173/login.do` 로 접속한다.

### 동일 출처 실행 (배포 / 단일 출처 확인용)

```bash
npm run build      # web/dist 생성 (Vite)
npm run server     # 같은 서버가 SPA + API 를 서빙 → http://127.0.0.1:3001/login.do
```

`web/dist`가 없으면 SPA 서빙은 **비활성**이고 API만 뜬다(개발 흐름 무영향).

## 배포 (Windows 서버 EXE)

```bash
npm run dist:server   # → dist/기사작성기-server/ 생성
```

- 산출물: `기사작성기-server.exe`(Node SEA 단일 실행 파일 — 서버 코드 + 의존성 + Node 런타임 내장) + `web/`(SPA) + `data/`(빈 골격) + `기사작성기-server.bat`.
- 배포 대상 머신에 **Node 설치가 필요 없고**, 데이터는 exe 옆 `data/` 기준(포터블 — 백업 = 폴더 복사).
- 운영 가이드(설치·환경변수·백업·서비스 등록·문제 해결)는 `packaging/server/README-배포.md`를 보라 — 배포 폴더에 자동 동봉된다. 설계 배경은 ADR-010.

### 샘플 계정 (개발/데모용)

`npm run seed`가 채우는 계정. **운영 비밀번호로 쓰지 말 것.**

| 아이디 | 비밀번호 | 권한 | 부서 |
|--------|----------|------|------|
| `reporter` | `` | R (기자) | 사회부 |
| `desk` | `` | D (데스크) | 편집부 |
| `admin` | `` | Z (관리자) | 운영부 |

시드는 **멱등**하다 — 이미 있는 계정은 건드리지 않으며(덮어쓰기/삭제 없음), 여러 번 실행해도 안전하다.

## 배포 (Windows 클라이언트 EXE)

```bash
npm run dist:client   # → dist/기사작성기/ 생성 (Electron 접속형 클라이언트, 무설치 폴더)
```

- 산출물: `기사작성기.exe` + Electron 런타임 + `resources/app/`(셸 코드) — 실측 약 347MB(압축 시 약 138MB).
- **접속형**이다: 셸은 서버 주소를 열기만 하고 SPA·API·세션·SSE는 전부 서버가 담당한다(클라이언트에 서버·DB 미내장 — 화면 변경은 서버만 갱신하면 반영된다).
- 최초 실행 시 서버 주소를 입력받아 `/api/health` 응답까지 확인한 뒤 `%APPDATA%\기사작성기\config.json`(사용자별)에 저장한다.
- 개발 실행: `npm run client:dev` (검증 시 `CLIENT_USER_DATA`를 임시 경로로 줄 것 — 실사용자 설정 보호).
- 자동 스모크: `node scripts/verify-client.mjs --dev --scenario all` (패키징 산출물은 `--exe <경로>`).
- **통합 스모크**: `npm run verify:integration` — 서버 exe + 클라이언트 exe를 함께 띄워 로그인→작성→SSE 반영→상세보기 팝업→송고 전 루프와 loopback/LAN 클립보드 표면을 자동 판정한다(먼저 `dist:server`·`dist:client` 실행 필요).
- 운영 가이드(기자·데스크용)는 `packaging/client/README-배포-클라이언트.md` — 배포 폴더에 자동 동봉된다. 서버+클라이언트 전체 설치 순서는 `packaging/README-배포-통합.md`. 설계 배경은 ADR-011.

## 환경변수

`.env.example`를 `.env`로 복사해 설정한다(시크릿은 서버 환경변수로만 — 클라이언트 노출 금지).

- `PORT` — API 서버 포트(기본 3001)
- (선택) `HOST` — listen 바인드 주소(기본 `127.0.0.1`). 다른 PC에서 접속하려면 `0.0.0.0` 등으로 설정한다. **loopback 밖으로 열면서 `COLLECTION_TOKEN`을 설정하지 않으면 수집 인제스트 HTTP 라우트(`POST /api/collection/receive`·`/pull`)가 503 `collection-disabled`로 비활성되고 부트 경고가 남는다**(FTP 스풀 수집은 영향 없음)
- (선택) `SPA_DIR` — SPA 정적 루트(기본: 서버 모듈 기준 `web/dist`, 패키지 배치(exe)는 exe 옆 `web`). `<루트>/index.html`이 없으면 서빙 비활성. 명시적으로 빈 값을 주면 강제 비활성
- (선택) `DATA_DIR` — 데이터 루트(news.db·uploads가 이 아래 생긴다). 기본: dev는 cwd, 패키지 배치(exe)는 exe 옆 `data`
- `VITE_API_BASE` — 프론트가 호출할 API 베이스 URL
- `YOUTUBE_API_KEY` — 영상 검색(YouTube Data API v3)
- `GOOGLE_API_KEY` / `GOOGLE_CSE_ID` — 이미지 검색(Google Custom Search)
- (선택) `RCV_SPOOL_DIR` — 수집 FTP 스풀 디렉토리, `COLLECTION_TOKEN` — 수집 인제스트 토큰(`HOST`로 LAN에 바인딩할 때는 사실상 필수 — 미설정 시 수집 HTTP 라우트가 503으로 비활성된다)
- (선택) `DIST_SPOOL_DIR` — 배부 스풀 루트 디렉토리(미설정 시 배부 비활성 — ADR-008)

미디어 검색 키가 없으면 검색은 오류 대신 빈 결과를 반환한다.

## 테스트 / 검증

```bash
npm run lint       # ESLint
npm run build      # 프로덕션 빌드 (Vite)
npm test           # 백엔드 테스트 (node --test)
npm run test:web   # 프론트엔드 테스트 (Vitest)
```

`npm run build` 후 `npm test`를 돌리면 실제 빌드 산출물 스모크 테스트(`test/spa-serving.test.js`)가 skip 없이 실행된다.
