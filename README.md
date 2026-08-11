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

### 샘플 계정 (개발/데모용)

`npm run seed`가 채우는 계정. **운영 비밀번호로 쓰지 말 것.**

| 아이디 | 비밀번호 | 권한 | 부서 |
|--------|----------|------|------|
| `reporter` | `` | R (기자) | 사회부 |
| `desk` | `` | D (데스크) | 편집부 |
| `admin` | `` | Z (관리자) | 운영부 |

시드는 **멱등**하다 — 이미 있는 계정은 건드리지 않으며(덮어쓰기/삭제 없음), 여러 번 실행해도 안전하다.

## 환경변수

`.env.example`를 `.env`로 복사해 설정한다(시크릿은 서버 환경변수로만 — 클라이언트 노출 금지).

- `PORT` — API 서버 포트(기본 3001)
- (선택) `HOST` — listen 바인드 주소(기본 `127.0.0.1`). 다른 PC에서 접속하려면 `0.0.0.0` 등으로 설정한다. **loopback 밖으로 열면서 `COLLECTION_TOKEN`을 설정하지 않으면 수집 인제스트 HTTP 라우트(`POST /api/collection/receive`·`/pull`)가 503 `collection-disabled`로 비활성되고 부트 경고가 남는다**(FTP 스풀 수집은 영향 없음)
- (선택) `SPA_DIR` — SPA 정적 루트(기본: 서버 모듈 기준 `web/dist`). `<루트>/index.html`이 없으면 서빙 비활성. 명시적으로 빈 값을 주면 강제 비활성
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
