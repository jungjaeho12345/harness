# 아키텍처

## 개요
기사 작성기는 **두 프로세스로 분리**된다.
Vite로 빌드하는 React SPA(클라이언트, `:5173`)와 독립 Express REST/SSE 서버(`127.0.0.1:3001`). 
양쪽 모두 MVC 계층으로 구성하고, 데이터는 Node 내장 SQLite 단일 파일(`news.db`)에 저장한다. 기술 선택의 배경은 `ADR.md` 참조한다.

## 디렉토리 구조
```
server/
  index.js              # 얇은 HTTP/SSE transport — 라우팅 + 인가 게이트만, 비즈니스 로직 없음
  ftpWatcher.js         # 수집(자동기사) FTP 스풀 디렉토리 watcher — 파일 이벤트 시 controllers.collection.receive 호출 (watch 주입형, 테스트는 실제 FS 미사용)
src/                    # 백엔드 도메인 (transport 비의존, 모두 주입 가능)
  db/                   # schema(멱등 마이그레이션), articleId 생성, softDelete
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
news.db                 # SQLite 단일 파일 (User / Article / Contents)
test/                   # 백엔드 테스트 (node --test)
```

## 패턴
- **백엔드 MVC + 계층 분리**: HTTP 라우트(`server/index.js`)는 shape 매핑과 인가 게이트만 담당하고, 로직은 `controllers → services → models → db`로 내려간다. 모든 의존성은 주입 가능해서 테스트는 in-memory db/session을 주입한다(프로덕션 `news.db`에 바인딩하지 않음).
- **프론트엔드 MVC**: `View`(순수 함수/컴포넌트) ← `Controller`(React 훅) ← `Model`(주입형 계약). Model은 `freeze`된 `MODEL_KEYS` 계약을 따르고, 실제 REST/SSE 배선은 `httpModel` 뒤에 격리한다. 테스트는 `fakeModel`을 주입한다.
- **얇은 transport**: 비즈니스 로직은 HTTP 밖에 둔다 — 라우트는 "세션 검증 → 인가 게이트 → 컨트롤러 위임 → 응답 매핑"만 한다.

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
```

## 상태 관리
- **서버 상태**: `news.db`(SQLite)가 단일 진실 공급원. 클라이언트는 캐시하지 않고 필요 시 재조회한다.
- **세션/인증**: 서버 in-process 세션 스토어(1시간 슬라이딩 만료). 클라이언트는 `sessionId`+`user`를 `sessionStorage`에 저장하고, 새로고침(F5) 시 `/api/session`으로 서버 확인 후 복원한다(복원 전까지 로그인 페이지로 보내지 않음).
- **클라이언트 로컬 상태**: React `useState`/커스텀 훅. 작성 탭 목록과 탭별 작성 내용은 `sessionStorage`에 보존되어 list.do ↔ writer.do 이동 후에도 유지된다.
- **실시간 동기화**: SSE 무효화 신호 기반 — 서버는 "바뀌었다"만 알리고 클라이언트가 재조회한다(권한별 데이터 노출 회피).

## 보안 경계
- 신뢰 경계는 **서버**. acting role은 검증된 `x-session-id` 세션에서만 도출하고 `req.body.role`은 신뢰하지 않는다.
- helmet(CSP), CORS allowlist(`localhost:5173`), 로그인 레이트리밋(15분/10회), bcrypt 해시, 전역 에러 핸들러(내부 스택 비노출).
- CSRF: 상태 변경 메서드(비 GET/HEAD/OPTIONS)의 Origin/Referer 검증 미들웨어 — 자기 출처·allowlist(`ALLOWED_ORIGINS`)·비프로덕션 loopback만 통과, 그 외 403(`forbidden-origin`). Origin·Referer 부재(서버-서버·cron)는 통과 (ADR-009).
- DB 비파괴 원칙: 스키마는 `CREATE TABLE IF NOT EXISTS` / additive `ALTER`만, 행 삭제 없음.
