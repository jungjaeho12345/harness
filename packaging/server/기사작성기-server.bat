@echo off
chcp 65001 > nul
rem ============================================================================
rem 기사작성기 서버 시작 스크립트 (SEA 단일 실행 파일 모드 — phase 61 step1 실측 확정)
rem
rem [필수 안내] 이 exe는 .env 파일을 읽지 않는다.
rem   `npm run server`의 --env-file-if-exists=.env는 dev 전용 Node CLI 플래그다.
rem   설정은 이 파일의 `set` 줄 또는 시스템/서비스 환경변수로만 한다.
rem   (배포 폴더에 .env를 만들어도 아무 효과가 없다.)
rem
rem [경고] NODE_ENV=production 을 설정하지 마라.
rem   세션 쿠키가 Secure+SameSite=None이 되어 평문 HTTP(LAN) 접속에서 브라우저가
rem   쿠키를 저장/전송하지 않는다 → 로그인 화면은 뜨는데 인증만 조용히 실패한다.
rem   (docs/ARCHITECTURE.md 보안 경계 "운영 환경변수 주의")
rem [경고] FORCE_HTTPS=true 도 같은 이유로 금지 — TLS 종단이 외부 프록시에 있을 때만 켠다.
rem [경고] 재빌드(npm run dist:server)는 배포 폴더의 이 파일 사본을 리포 원본으로 덮어쓴다 —
rem   사본에 편집한 set 설정은 유실된다. 지키려면 다른 이름으로 복사해 쓰거나 시스템 환경변수를 써라.
rem ============================================================================

rem cwd를 이 파일(=exe)의 폴더로 고정한다 — 경로 기본값의 이중 안전장치.
rem (exe 자체가 exe 위치 기준으로 data/·web/을 찾으므로 이 줄이 없어도 동작은 같다.)
cd /d "%~dp0"

rem --- 기본 설정 ---
set PORT=3001

rem --- 선택 설정 (필요 시 rem 을 지우고 값을 채워라) ---
rem DATA_DIR / SPA_DIR 는 기본값이 exe 옆 data\ / web\ 이라 보통 설정이 불필요하다.
rem set DATA_DIR=%~dp0data
rem set SPA_DIR=%~dp0web

rem LAN 개방 시: HOST=0.0.0.0 + COLLECTION_TOKEN 동반 필수
rem (COLLECTION_TOKEN 없이 loopback 밖으로 열면 수집 인제스트 HTTP 라우트가 503으로 비활성된다)
rem set HOST=0.0.0.0
rem set COLLECTION_TOKEN=change-me

rem 배부 활성화(미설정 = 배부 비활성): 스풀에 파일만 쓴다 — 발송은 외부 전송기 책임
rem set DIST_SPOOL_DIR=%~dp0data\dist-spool

rem FTP 수집 활성화(미설정 = FTP 수집 비활성): 외부 FTPd가 이 폴더에 파일을 떨어뜨린다
rem set RCV_SPOOL_DIR=%~dp0data\rcv-spool

rem 별도 출처 SPA 배포 시에만(동일 출처 배포는 빈 목록이 정상)
rem set ALLOWED_ORIGINS=

rem 미디어 검색 API 키(없으면 검색이 빈 결과)
rem set YOUTUBE_API_KEY=
rem set GOOGLE_API_KEY=
rem set GOOGLE_CSE_ID=

rem --- 서버 시작 ---
echo 기사작성기 서버를 시작합니다. 접속: http://127.0.0.1:%PORT%/login.do
"%~dp0기사작성기-server.exe"

rem 창이 즉시 닫혀 오류 메시지를 못 보는 사고 방지.
pause
