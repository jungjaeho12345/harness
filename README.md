# 기사 작성기 (Article Production System)

기자·데스크·관리자가 기사를 **작성 → 검수 → 송고**하는 사내 보도 제작 도구.
**제작(기사작성기)** + **수집(자동기사)** + **배부** 시스템을 구현한다(배부는 2026-07-26 착수 — ADR-008).

- 프론트엔드: Vite + React 19 SPA (`:5173`)
- 백엔드: 독립 Express REST/SSE 서버 (`127.0.0.1:3001`)
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
- `VITE_API_BASE` — 프론트가 호출할 API 베이스 URL
- `YOUTUBE_API_KEY` — 영상 검색(YouTube Data API v3)
- `GOOGLE_API_KEY` / `GOOGLE_CSE_ID` — 이미지 검색(Google Custom Search)
- (선택) `RCV_SPOOL_DIR` — 수집 FTP 스풀 디렉토리, `COLLECTION_TOKEN` — 수집 인제스트 토큰
- (선택) `DIST_SPOOL_DIR` — 배부 스풀 루트 디렉토리(미설정 시 배부 비활성 — ADR-008)

### 시점 배부 (엠바고)

엠바고 시각에 맞춘 배부는 앱 내 타이머가 아니라 **외부 운영 루틴이 주기 호출하는 pull 엔드포인트**로 실행한다(ADR-008 (3) — 앱에 타이머·네트워크 egress 없음).

- `POST /api/distribution/tick` — Z(관리자) 세션 전용. 요청 바디는 없다.
  호출 시점 기준으로 배부 시각이 도래한 EPS 기사를 배부하고, 배부가 전부 완결된 기사를 EPS→DPS로 전이한다.
  **순차 반복 호출은 멱등하다**(이미 배부된 종류는 이력 기준으로 다시 보내지 않는다). 같은 프로세스 안에서 겹친 호출은
  single-flight로 즉시 `{ ok: true, skipped: true }`를 반환한다 — **tick은 단일 인스턴스에서만 호출한다**(다중 인스턴스가
  동시에 tick을 치면 중복 반출을 막을 수 없다). `DIST_SPOOL_DIR` 미설정이면 503(`spool-disabled`).
  엠바고 시각 값은 명시적 오프셋이 있는 ISO-8601(`Z` 또는 `±hh:mm`)만 유효하며, 그 외 형식은 판정 불가(미도래)로 보류된다.

미디어 검색 키가 없으면 검색은 오류 대신 빈 결과를 반환한다.

## 테스트 / 검증

```bash
npm run lint       # ESLint
npm run build      # 프로덕션 빌드 (Vite)
npm test           # 백엔드 테스트 (node --test)
npm run test:web   # 프론트엔드 테스트 (Vitest)
```
